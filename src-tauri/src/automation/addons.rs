//! Add-ons on disk: `~/Library/Application Support/Compola/addons/<id>/manifest.json` + its `main` script. The UI runs
//! enabled add-ons in Web Workers (`src/engine/addons.ts`); this module only lists, installs and removes them.
//!
//! ```json
//! { "id": "auto-reply", "name": "…", "version": "1.0.0", "description": "…", "main": "main.js",
//!   "permissions": ["messages:read", "messages:send", "schedules", "mcp", "network", "notifications"],
//!   "settings": [{ "key": "message", "label": "…", "type": "text|textarea|number|boolean|conversation", "default": … }] }
//! ```

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PERMISSIONS: [&str; 6] = ["messages:read", "messages:send", "schedules", "mcp", "network", "notifications"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub settings: Vec<Value>,
}

fn default_main() -> String {
    "main.js".into()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Addon {
    pub manifest: Manifest,
    pub source: String,
    pub path: String,
    pub builtin: bool,
}

pub fn dir() -> PathBuf {
    crate::platform::app_support().join("addons")
}

struct Builtin {
    id: &'static str,
    manifest: &'static str,
    main: &'static str,
}

const BUILTINS: &[Builtin] = &[
    Builtin { id: "auto-reply", manifest: include_str!("../../addons/auto-reply/manifest.json"), main: include_str!("../../addons/auto-reply/main.js") },
    Builtin { id: "keyword-alert", manifest: include_str!("../../addons/keyword-alert/manifest.json"), main: include_str!("../../addons/keyword-alert/main.js") },
    Builtin { id: "daily-digest", manifest: include_str!("../../addons/daily-digest/manifest.json"), main: include_str!("../../addons/daily-digest/main.js") },
];

pub fn is_builtin(id: &str) -> bool {
    BUILTINS.iter().any(|b| b.id == id)
}

/// Copies built-in add-ons that were never installed (a removed one stays removed); returns the ids copied.
pub fn seed(already: &[String]) -> Vec<String> {
    let mut copied = Vec::new();
    for b in BUILTINS {
        if already.iter().any(|a| a == b.id) {
            continue;
        }
        let target = dir().join(b.id);
        if std::fs::create_dir_all(&target).is_ok()
            && std::fs::write(target.join("manifest.json"), b.manifest).is_ok()
            && std::fs::write(target.join("main.js"), b.main).is_ok()
        {
            copied.push(b.id.to_owned());
        }
    }
    copied
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') && !id.starts_with('.')
}

fn read_addon(folder: &Path) -> Result<Addon, String> {
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(folder.join("manifest.json")).map_err(|e| format!("manifest.json: {e}"))?)
        .map_err(|e| format!("manifest.json không hợp lệ: {e}"))?;
    if !valid_id(&manifest.id) {
        return Err(format!("id không hợp lệ: \"{}\"", manifest.id));
    }
    let main = folder.join(&manifest.main);
    if !main.starts_with(folder) || manifest.main.contains("..") {
        return Err("main phải nằm trong thư mục add-on".into());
    }
    let source = std::fs::read_to_string(&main).map_err(|e| format!("{}: {e}", manifest.main))?;
    Ok(Addon { builtin: is_builtin(&manifest.id), manifest, source, path: folder.to_string_lossy().into_owned() })
}

pub fn list() -> Vec<Addon> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir()) else { return out };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        match read_addon(&p) {
            Ok(a) => out.push(a),
            Err(err) => log::warn!("add-on {} skipped: {err}", p.display()),
        }
    }
    out.sort_by(|a, b| a.manifest.name.to_lowercase().cmp(&b.manifest.name.to_lowercase()));
    out
}

pub fn get(id: &str) -> Option<Addon> {
    if !valid_id(id) {
        return None;
    }
    read_addon(&dir().join(id)).ok()
}

/// Installs from a folder holding `manifest.json`, or from a single `.js` file (its manifest is the JSON object in a
/// leading `/* @compola-addon { … } */` comment, or a default one named after the file). Replaces an add-on with the
/// same id. Returns the id.
pub fn install(from: &Path) -> Result<String, String> {
    let (manifest, files): (Manifest, Vec<(String, Vec<u8>)>) = if from.is_dir() {
        let addon = read_addon(from)?;
        let mut files = Vec::new();
        copy_tree(from, from, &mut files)?;
        (addon.manifest, files)
    } else {
        let source = std::fs::read_to_string(from).map_err(|e| e.to_string())?;
        let stem = from.file_stem().and_then(|s| s.to_str()).unwrap_or("addon");
        let mut manifest = embedded_manifest(&source).unwrap_or(Manifest {
            id: String::new(),
            name: stem.to_owned(),
            version: "1.0.0".into(),
            description: String::new(),
            author: String::new(),
            main: "main.js".into(),
            permissions: vec!["messages:read".into()],
            settings: Vec::new(),
        });
        if manifest.id.is_empty() {
            manifest.id = stem.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' }).collect();
        }
        manifest.main = "main.js".into();
        let json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        (manifest, vec![("manifest.json".into(), json), ("main.js".into(), source.into_bytes())])
    };
    if !valid_id(&manifest.id) {
        return Err(format!("id không hợp lệ: \"{}\"", manifest.id));
    }
    for p in &manifest.permissions {
        if !PERMISSIONS.contains(&p.as_str()) {
            return Err(format!("quyền không xác định: {p}"));
        }
    }
    let target = dir().join(&manifest.id);
    let staging = dir().join(format!(".install-{}", manifest.id));
    let _ = std::fs::remove_dir_all(&staging);
    for (rel, bytes) in &files {
        let p = staging.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|e| e.to_string())?;
    Ok(manifest.id)
}

fn copy_tree(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') || name == "node_modules" {
            continue;
        }
        if p.is_dir() {
            copy_tree(root, &p, out)?;
        } else if p.is_file() {
            if out.len() > 500 {
                return Err("add-on có quá nhiều tệp".into());
            }
            let rel = p.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
            out.push((rel, std::fs::read(&p).map_err(|e| e.to_string())?));
        }
    }
    Ok(())
}

fn embedded_manifest(source: &str) -> Option<Manifest> {
    let start = source.find("@compola-addon")? + "@compola-addon".len();
    let rest = &source[start..];
    let end = rest.find("*/")?;
    serde_json::from_str(rest[..end].trim()).ok()
}

pub fn remove(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("id không hợp lệ".into());
    }
    std::fs::remove_dir_all(dir().join(id)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_manifests_parse() {
        for b in BUILTINS {
            let m: Manifest = serde_json::from_str(b.manifest).unwrap();
            assert_eq!(m.id, b.id);
            assert!(m.permissions.iter().all(|p| PERMISSIONS.contains(&p.as_str())), "{}", b.id);
        }
    }

    #[test]
    fn single_file_manifest_comment() {
        let m = embedded_manifest("/* @compola-addon {\"id\":\"x\",\"name\":\"X\",\"permissions\":[\"mcp\"]} */\ncompola.log('hi')").unwrap();
        assert_eq!(m.id, "x");
        assert_eq!(m.permissions, vec!["mcp"]);
        assert!(!valid_id("../x") && !valid_id("") && valid_id("my-addon_1.2"));
    }
}
