//! Read-only access to an Electron `app.asar` archive (port of `AsarArchive.swift`).
//!
//! Format: `[u32 4][u32 headerPickleSize]` then a pickle `[u32 payload][u32 jsonLen][json]`; file offsets in the
//! JSON header are relative to `8 + headerPickleSize`. Entries flagged `unpacked` live in `app.asar.unpacked/`.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};

use memmap2::Mmap;
use serde_json::Value;

#[derive(Clone, Copy, Debug)]
struct Entry {
    offset: usize,
    size: usize,
    unpacked: bool,
}

pub struct AsarArchive {
    pub path: PathBuf,
    map: Mmap,
    base: usize,
    entries: HashMap<String, Entry>,
}

impl AsarArchive {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let file = File::open(path).map_err(|e| anyhow::anyhow!("cannot read {}: {e}", path.display()))?;
        // SAFETY: the runtime folder is ours and not modified while running.
        let map = unsafe { Mmap::map(&file)? };
        anyhow::ensure!(map.len() > 16, "app.asar is not valid");
        let u32_at = |o: usize| u32::from_le_bytes(map[o..o + 4].try_into().unwrap()) as usize;
        let header_pickle_size = u32_at(4);
        let json_len = u32_at(12);
        anyhow::ensure!(16 + json_len <= map.len(), "app.asar is not valid");
        let json: Value = serde_json::from_slice(&map[16..16 + json_len])?;
        let mut entries = HashMap::new();
        index(&json, "", &mut entries);
        Ok(Self { path: path.to_owned(), base: 8 + header_pickle_size, map, entries })
    }

    pub fn contains(&self, path: &str) -> bool {
        self.entries.contains_key(normalize(path))
    }

    /// Bytes of a file inside the archive, e.g. `pc-dist/login.html`.
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        let key = normalize(path);
        let entry = *self.entries.get(key)?;
        if entry.unpacked {
            let p = self.path.with_file_name("app.asar.unpacked").join(key);
            return std::fs::read(p).ok();
        }
        let start = self.base + entry.offset;
        self.map.get(start..start + entry.size).map(<[u8]>::to_vec)
    }

    pub fn paths_with_prefix(&self, prefix: &str) -> Vec<String> {
        let mut v: Vec<_> = self.entries.keys().filter(|k| k.starts_with(prefix)).cloned().collect();
        v.sort();
        v
    }
}

fn normalize(path: &str) -> &str {
    path.trim_start_matches('/')
}

fn index(node: &Value, prefix: &str, out: &mut HashMap<String, Entry>) {
    let Some(files) = node.get("files").and_then(Value::as_object) else { return };
    for (name, child) in files {
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if child.get("files").is_some() {
            index(child, &path, out);
        } else if let Some(size) = child.get("size").and_then(Value::as_u64) {
            let offset = child.get("offset").and_then(Value::as_str).and_then(|s| s.parse().ok()).unwrap_or(0);
            let unpacked = child.get("unpacked").and_then(Value::as_bool).unwrap_or(false);
            out.insert(path, Entry { offset, size: size as usize, unpacked });
        }
    }
}

/// `getClientVersion:function(){return 694}` in the main bundle — the number official main puts in the
/// User-Agent and the page query.
pub fn client_version_from_main_js(data: &[u8]) -> Option<String> {
    let source = std::str::from_utf8(data).ok()?;
    let re = regex::Regex::new(r"getClientVersion:function\(\)\{return (\d+)\}").ok()?;
    re.captures(source).map(|c| c[1].to_owned())
}
