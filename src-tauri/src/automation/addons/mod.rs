//! Add-ons: packages on disk (`<data>/addons/<id>/manifest.json` + its scripts), installed from a `.zip`, a folder or a
//! single `.js` file. Each enabled add-on runs in its own sandboxed QuickJS runtime on its own thread ([`runtime`]),
//! supervised by [`host::AddonHost`] (restart with backoff, crash-loop stop, rate limits, permission checks). What
//! add-ons write for people (notes on a conversation, reply suggestions, panels, quick replies) is in [`workspace`].
//! Docs: `docs/addons.md`.
//!
//! ```json
//! { "id": "auto-reply", "name": "…", "version": "1.0.0", "description": "…", "main": "main.js",
//!   "permissions": ["messages:read", "messages:send", "notes", "ui", "ai", "schedules", "mcp", "network", "notifications"],
//!   "hosts": ["api.example.com", "*.example.org"],
//!   "settings": [{ "key": "message", "label": "…", "type": "text|textarea|number|boolean|select|secret|conversation|conversations|cron|time", "default": … }],
//!   "contributes": { "actions": [{ "id": "summarize", "title": "Tóm tắt", "context": "conversation" }],
//!                    "quickReplies": [{ "shortcut": "chao", "title": "Chào", "text": "Xin chào {{name}}" }] },
//!   "limits": { "memoryMb": 64, "timeoutMs": 5000 } }
//! ```

pub mod commands;
pub mod host;
pub mod runtime;
pub mod views;
pub mod workspace;

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Every permission an add-on can declare (`messages:read` … `notifications`).
pub const PERMISSIONS: [&str; 9] = ["messages:read", "messages:send", "notes", "ui", "ai", "schedules", "mcp", "network", "notifications"];

/// Package bounds (zip bombs, runaway folders).
const MAX_FILES: usize = 2000;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
/// Runtime bounds a manifest may ask for (the host clamps).
pub const MAX_MEMORY_MB: u32 = 256;
pub const DEFAULT_MEMORY_MB: u32 = 64;
pub const MAX_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_TIMEOUT_MS: u64 = 5_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub memory_mb: Option<u32>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Contributes {
    /// `{id, title, context: conversation|message|composer, icon?, description?}`
    pub actions: Vec<Value>,
    /// `{shortcut, title?, text}` — static quick replies (dynamic ones: `compola.quickReplies.set`).
    pub quick_replies: Vec<Value>,
    /// HTML views: `{id, title, location: tab|inspector|composer|settings|modal, entry, icon?, height?, width?}` (`views.rs`).
    pub views: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub homepage: String,
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Hosts `network` may reach (`api.x.com`, `*.x.com`), plus the hosts of `url` settings the user fills in.
    /// Nothing else: there is no "any host".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub settings: Vec<Value>,
    #[serde(default)]
    pub contributes: Contributes,
    #[serde(default)]
    pub limits: Limits,
}

fn default_main() -> String {
    "main.js".into()
}

impl Manifest {
    pub fn has(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }

    pub fn memory_bytes(&self) -> usize {
        self.limits.memory_mb.unwrap_or(DEFAULT_MEMORY_MB).clamp(8, MAX_MEMORY_MB) as usize * 1024 * 1024
    }

    pub fn timeout_ms(&self) -> u64 {
        self.limits.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(100, MAX_TIMEOUT_MS)
    }

    /// Checks everything the host relies on; returns the warnings shown before install.
    pub fn validate(&self) -> Result<Vec<String>, String> {
        if !valid_id(&self.id) {
            return Err(format!("id không hợp lệ: \"{}\" (chữ, số, - _ . ; tối đa 64 ký tự)", self.id));
        }
        if self.name.trim().is_empty() {
            return Err("manifest thiếu \"name\"".into());
        }
        if self.main.contains("..") || self.main.starts_with('/') || self.main.starts_with('\\') {
            return Err("\"main\" phải nằm trong thư mục add-on".into());
        }
        for p in &self.permissions {
            if !PERMISSIONS.contains(&p.as_str()) {
                return Err(format!("quyền không xác định: {p}"));
            }
        }
        for h in &self.hosts {
            if !valid_host_pattern(h) {
                return Err(format!("host không hợp lệ: {h}"));
            }
        }
        let mut keys = std::collections::HashSet::new();
        for s in &self.settings {
            let key = s.get("key").and_then(Value::as_str).unwrap_or_default();
            if key.is_empty() || !keys.insert(key.to_owned()) {
                return Err(format!("settings: thiếu hoặc trùng \"key\" ({key})"));
            }
        }
        let mut ids = std::collections::HashSet::new();
        for a in &self.contributes.actions {
            let id = a.get("id").and_then(Value::as_str).unwrap_or_default();
            if id.is_empty() || !ids.insert(id.to_owned()) {
                return Err(format!("contributes.actions: thiếu hoặc trùng \"id\" ({id})"));
            }
        }
        if !self.contributes.views.is_empty() && !self.has("ui") {
            return Err("add-on có giao diện (contributes.views) phải khai báo quyền \"ui\"".into());
        }
        let mut warnings = Vec::new();
        if !self.contributes.views.is_empty() {
            warnings.push(format!("Add-on thêm {} giao diện HTML vào ứng dụng (chạy trong khung cách ly).", self.contributes.views.len()));
        }
        let url_settings = self.settings.iter().filter(|s| s.get("type").and_then(Value::as_str) == Some("url")).count();
        // A `url` setting widens what `fetch` may reach, so only a person may fill it in: no default value.
        if let Some(s) = self.settings.iter().find(|s| {
            s.get("type").and_then(Value::as_str) == Some("url") && s.get("default").and_then(Value::as_str).is_some_and(|d| !d.trim().is_empty())
        }) {
            return Err(format!("settings: \"{}\" kiểu url không được có giá trị mặc định", s.get("key").and_then(Value::as_str).unwrap_or_default()));
        }
        if self.has("network") && self.hosts.is_empty() && url_settings == 0 {
            return Err("quyền \"network\" cần danh sách \"hosts\" (hoặc một tuỳ chỉnh kiểu \"url\" để người dùng tự nhập địa chỉ)".into());
        }
        if self.has("network") {
            let mut to: Vec<String> = self.hosts.clone();
            if url_settings > 0 {
                to.push("địa chỉ bạn nhập trong tuỳ chỉnh".into());
            }
            warnings.push(format!("Add-on gửi được dữ liệu tới: {}.", to.join(", ")));
        }
        if self.has("messages:send") {
            warnings.push(
                "Add-on có thể tự gửi tin Zalo, nhưng chỉ vào hội thoại vừa nhắn đến, hội thoại bạn chọn trong tuỳ chỉnh, hoặc nơi bạn vừa dùng add-on.".into(),
            );
        }
        if self.has("mcp") {
            warnings.push("Add-on dùng được các máy chủ MCP bạn đã cấu hình (chúng có thể gửi dữ liệu ra ngoài).".into());
        }
        if self.version.trim().is_empty() {
            warnings.push("Manifest không có \"version\".".into());
        }
        Ok(warnings)
    }
}

fn valid_host_pattern(h: &str) -> bool {
    let h = h.strip_prefix("*.").unwrap_or(h);
    !h.is_empty() && h.len() <= 253 && h.contains('.') && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Addon {
    pub manifest: Manifest,
    /// The main script (what the runtime evaluates).
    #[serde(skip)]
    pub source: String,
    /// SHA-256 of every file: a new value restarts the runtime.
    pub digest: String,
    pub path: String,
    pub builtin: bool,
    /// A previous version kept by the last update (`rollback`).
    pub has_backup: bool,
}

pub fn dir() -> PathBuf {
    crate::platform::app_support().join("addons")
}

/// Per add-on data (storage, logs): never inside the package folder, so an update keeps it.
pub fn data_dir(id: &str) -> PathBuf {
    crate::platform::app_support().join("addons-data").join(id)
}

fn backup_dir(id: &str) -> PathBuf {
    dir().join(".previous").join(id)
}

/// Built-in add-ons: every file of `src-tauri/addons/<id>/` (manifest, main.js, lib/, ui/ …), compiled in.
static BUILTIN_DIR: include_dir::Dir<'static> = include_dir::include_dir!("$CARGO_MANIFEST_DIR/addons");

/// Bundled with the app, installed disabled on first launch and updated with the app.
const BUILTINS: &[&str] = &[
    "auto-reply",
    "keyword-alert",
    "daily-digest",
    "ai-reply",
    "daily-summary",
    "quick-replies",
    "reply-radar",
    "insights",
    "order-book",
    "translator",
    "mood-meter",
    "webhook",
];

/// The files of a built-in add-on, paths relative to its folder.
pub(crate) fn builtin_files(id: &str) -> Vec<(String, Vec<u8>)> {
    fn walk(d: &include_dir::Dir<'static>, root: &std::path::Path, out: &mut Vec<(String, Vec<u8>)>) {
        for f in d.files() {
            if let Ok(rel) = f.path().strip_prefix(root) {
                out.push((rel.to_string_lossy().replace('\\', "/"), f.contents().to_vec()));
            }
        }
        for sub in d.dirs() {
            walk(sub, root, out);
        }
    }
    let mut out = Vec::new();
    if let Some(d) = BUILTIN_DIR.get_dir(id) {
        walk(d, d.path(), &mut out);
    }
    out.sort();
    out
}

fn builtin_manifest(id: &str) -> Option<String> {
    BUILTIN_DIR.get_file(format!("{id}/manifest.json")).and_then(|f| f.contents_utf8()).map(str::to_owned)
}

pub fn is_builtin(id: &str) -> bool {
    BUILTINS.contains(&id)
}

/// Copies built-in add-ons that were never installed (a removed one stays removed) and updates installed built-ins to a
/// newer bundled version. Returns the ids copied for the first time.
pub fn seed(already: &[String]) -> Vec<String> {
    let mut copied = Vec::new();
    for &id in BUILTINS {
        let Some(Ok(bundled)) = builtin_manifest(id).map(|m| serde_json::from_str::<Manifest>(&m)) else { continue };
        let target = dir().join(id);
        let installed = read_manifest(&target).ok();
        let first = !already.iter().any(|a| a == id);
        let upgrade = installed.as_ref().is_some_and(|m| m.author == bundled.author && newer(&bundled.version, &m.version));
        if !(first && installed.is_none()) && !upgrade {
            continue;
        }
        let files = builtin_files(id);
        match write_package(id, &files, upgrade) {
            Ok(()) if first => copied.push(id.to_owned()),
            Ok(()) => log::info!("add-on {id} updated to the bundled {}", bundled.version),
            Err(e) => log::warn!("add-on {id}: cannot install the bundled copy: {e}"),
        }
    }
    copied
}

/// `a` > `b`, comparing dot-separated numbers (`1.10.0` > `1.9.2`); non-numeric parts compare as text.
pub fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| v.trim().trim_start_matches('v').split(['.', '-', '+']).map(str::to_owned).collect::<Vec<_>>();
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).map(String::as_str).unwrap_or("0"), pb.get(i).map(String::as_str).unwrap_or("0"));
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            _ => x.cmp(y),
        };
        if ord != std::cmp::Ordering::Equal {
            return ord == std::cmp::Ordering::Greater;
        }
    }
    false
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') && !id.starts_with('.')
}

fn read_manifest(folder: &Path) -> Result<Manifest, String> {
    let bytes = std::fs::read(folder.join("manifest.json")).map_err(|e| format!("manifest.json: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("manifest.json không hợp lệ: {e}"))
}

fn digest_of(files: &[(String, Vec<u8>)]) -> String {
    use sha2::{Digest, Sha256};
    let mut sorted: Vec<&(String, Vec<u8>)> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut h = Sha256::new();
    for (name, bytes) in sorted {
        h.update(name.as_bytes());
        h.update([0]);
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(bytes);
    }
    hex::encode(&h.finalize()[..12])
}

fn read_addon(folder: &Path) -> Result<Addon, String> {
    let manifest = read_manifest(folder)?;
    manifest.validate()?;
    let main = folder.join(&manifest.main);
    let source = std::fs::read_to_string(&main).map_err(|e| format!("{}: {e}", manifest.main))?;
    let mut files = Vec::new();
    collect_folder(folder, folder, &mut files, &mut 0)?;
    views::validate(&manifest.contributes.views, &|p| files.iter().any(|f| f.0 == p))?;
    Ok(Addon {
        builtin: is_builtin(&manifest.id),
        has_backup: backup_dir(&manifest.id).join("manifest.json").exists(),
        digest: digest_of(&files),
        manifest,
        source,
        path: folder.to_string_lossy().into_owned(),
    })
}

pub fn list() -> Vec<Addon> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir()) else { return out };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() || e.file_name().to_string_lossy().starts_with('.') {
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

/// A package read into memory and checked, not yet installed.
pub struct Package {
    pub manifest: Manifest,
    pub files: Vec<(String, Vec<u8>)>,
    pub warnings: Vec<String>,
}

/// What the install dialog shows before the user agrees.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub manifest: Manifest,
    pub warnings: Vec<String>,
    pub files: usize,
    pub bytes: u64,
    /// The version installed now (an update), if any.
    pub installed_version: Option<String>,
    /// Permissions the installed version did not have.
    pub new_permissions: Vec<String>,
    /// Hosts the installed version could not reach.
    pub new_hosts: Vec<String>,
    pub downgrade: bool,
    pub replaces_builtin: bool,
}

pub fn inspect(from: &Path) -> Result<Preview, String> {
    let pkg = load(from)?;
    let installed = get(&pkg.manifest.id);
    let new_permissions = match &installed {
        Some(a) => pkg.manifest.permissions.iter().filter(|p| !a.manifest.has(p)).cloned().collect(),
        None => Vec::new(),
    };
    let new_hosts = match &installed {
        Some(a) if pkg.manifest.has("network") => pkg.manifest.hosts.iter().filter(|h| !(a.manifest.has("network") && a.manifest.hosts.contains(h))).cloned().collect(),
        _ => Vec::new(),
    };
    Ok(Preview {
        downgrade: installed.as_ref().is_some_and(|a| newer(&a.manifest.version, &pkg.manifest.version)),
        installed_version: installed.as_ref().map(|a| a.manifest.version.clone()),
        replaces_builtin: is_builtin(&pkg.manifest.id),
        bytes: pkg.files.iter().map(|f| f.1.len() as u64).sum(),
        files: pkg.files.len(),
        new_permissions,
        new_hosts,
        warnings: pkg.warnings,
        manifest: pkg.manifest,
    })
}

/// Reads a `.zip`, a folder holding `manifest.json`, or a single `.js` file (manifest in a leading
/// `/* @compola-addon { … } */` comment, or a default one named after the file).
pub fn load(from: &Path) -> Result<Package, String> {
    let ext = from.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let files = if from.is_dir() {
        let mut files = Vec::new();
        collect_folder(from, from, &mut files, &mut 0)?;
        files
    } else if ext == "zip" || ext == "compola-addon" {
        unzip(from)?
    } else if ext == "js" || ext == "mjs" {
        let source = std::fs::read_to_string(from).map_err(|e| e.to_string())?;
        let stem = from.file_stem().and_then(|s| s.to_str()).unwrap_or("addon");
        let mut manifest = embedded_manifest(&source).unwrap_or_else(|| Manifest {
            id: String::new(),
            name: stem.to_owned(),
            version: "1.0.0".into(),
            description: String::new(),
            author: String::new(),
            homepage: String::new(),
            main: "main.js".into(),
            permissions: vec!["messages:read".into()],
            hosts: Vec::new(),
            settings: Vec::new(),
            contributes: Contributes::default(),
            limits: Limits::default(),
        });
        if manifest.id.is_empty() {
            manifest.id = stem.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' }).collect();
        }
        manifest.main = "main.js".into();
        let json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        vec![("manifest.json".into(), json), ("main.js".into(), source.into_bytes())]
    } else {
        return Err("chọn tệp .zip, .js hoặc một thư mục có manifest.json".into());
    };
    let manifest_bytes = files.iter().find(|f| f.0 == "manifest.json").map(|f| &f.1).ok_or("gói không có manifest.json")?;
    let manifest: Manifest = serde_json::from_slice(manifest_bytes).map_err(|e| format!("manifest.json không hợp lệ: {e}"))?;
    let warnings = manifest.validate()?;
    let main = files.iter().find(|f| f.0 == manifest.main).ok_or_else(|| format!("gói không có tệp chính \"{}\"", manifest.main))?;
    std::str::from_utf8(&main.1).map_err(|_| format!("{} không phải văn bản UTF-8", manifest.main))?;
    views::validate(&manifest.contributes.views, &|p| files.iter().any(|f| f.0 == p))?;
    Ok(Package { manifest, files, warnings })
}

/// Installs a package (replacing the same id; the replaced version is kept for `rollback`). Returns the id.
pub fn install(from: &Path) -> Result<String, String> {
    let pkg = load(from)?;
    write_package(&pkg.manifest.id, &pkg.files, true)?;
    Ok(pkg.manifest.id)
}

/// Writes files to a staging folder, then swaps it in (an interrupted install never leaves a half package).
fn write_package(id: &str, files: &[(String, Vec<u8>)], keep_backup: bool) -> Result<(), String> {
    let target = dir().join(id);
    let staging = dir().join(format!(".install-{id}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    let written = (|| -> Result<(), String> {
        for (rel, bytes) in files {
            let p = staging.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    if target.exists() {
        if keep_backup {
            let backup = backup_dir(id);
            let _ = std::fs::remove_dir_all(&backup);
            if let Some(parent) = backup.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::rename(&target, &backup).is_err() {
                let _ = std::fs::remove_dir_all(&target);
            }
        } else {
            let _ = std::fs::remove_dir_all(&target);
        }
    }
    std::fs::rename(&staging, &target).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        e.to_string()
    })
}

/// Puts back the version the last update replaced (the current one becomes the backup).
pub fn rollback(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("id không hợp lệ".into());
    }
    let (current, backup) = (dir().join(id), backup_dir(id));
    read_addon(&backup).map_err(|_| "không có phiên bản trước để khôi phục".to_owned())?;
    let swap = dir().join(format!(".swap-{id}"));
    let _ = std::fs::remove_dir_all(&swap);
    std::fs::rename(&current, &swap).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&backup, &current) {
        let _ = std::fs::rename(&swap, &current);
        return Err(e.to_string());
    }
    std::fs::rename(&swap, &backup).map_err(|e| e.to_string())
}

fn skip_name(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name == "__MACOSX" || name == "Thumbs.db"
}

fn collect_folder(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>, total: &mut u64) -> Result<(), String> {
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if skip_name(&name) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(e.path()) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let p = e.path();
        if meta.is_dir() {
            collect_folder(root, &p, out, total)?;
        } else if meta.is_file() {
            if out.len() >= MAX_FILES {
                return Err(format!("add-on có quá nhiều tệp (tối đa {MAX_FILES})"));
            }
            if meta.len() > MAX_FILE_BYTES {
                return Err(format!("{name} quá lớn (tối đa {} MB một tệp)", MAX_FILE_BYTES / 1024 / 1024));
            }
            *total += meta.len();
            if *total > MAX_TOTAL_BYTES {
                return Err(format!("add-on quá lớn (tối đa {} MB)", MAX_TOTAL_BYTES / 1024 / 1024));
            }
            let rel = p.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            out.push((rel, std::fs::read(&p).map_err(|e| e.to_string())?));
        }
    }
    Ok(())
}

/// Reads a zip into memory with bounds on entries and real (decompressed) sizes; rejects absolute and `..` paths.
/// A package whose files all sit under one top-level folder (`my-addon/manifest.json`, what zipping a folder gives) is
/// read from inside that folder.
fn unzip(path: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("tệp zip không đọc được: {e}"))?;
    if zip.len() > MAX_FILES * 2 {
        return Err(format!("gói có quá nhiều tệp (tối đa {MAX_FILES})"));
    }
    let mut out: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("tệp zip hỏng: {e}"))?;
        if entry.is_dir() || entry.is_symlink() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else {
            return Err(format!("đường dẫn không an toàn trong gói: {}", entry.name()));
        };
        let rel = name.to_string_lossy().replace('\\', "/");
        if rel.split('/').any(skip_name) {
            continue;
        }
        if out.len() >= MAX_FILES {
            return Err(format!("gói có quá nhiều tệp (tối đa {MAX_FILES})"));
        }
        // Never trust the declared size: read at most the limit + 1 byte.
        let mut bytes = Vec::new();
        (&mut entry).take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| format!("{rel}: {e}"))?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(format!("{rel} quá lớn (tối đa {} MB một tệp)", MAX_FILE_BYTES / 1024 / 1024));
        }
        total += bytes.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(format!("gói quá lớn khi giải nén (tối đa {} MB)", MAX_TOTAL_BYTES / 1024 / 1024));
        }
        out.push((rel, bytes));
    }
    if !out.iter().any(|f| f.0 == "manifest.json") {
        let tops: std::collections::HashSet<&str> = out.iter().map(|f| f.0.split('/').next().unwrap_or_default()).collect();
        if tops.len() == 1 {
            let prefix = format!("{}/", tops.into_iter().next().unwrap_or_default());
            if out.iter().all(|f| f.0.starts_with(&prefix)) {
                for f in &mut out {
                    f.0 = f.0[prefix.len()..].to_owned();
                }
            }
        }
    }
    Ok(out)
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
    let _ = std::fs::remove_dir_all(backup_dir(id));
    let _ = std::fs::remove_dir_all(data_dir(id));
    match std::fs::remove_dir_all(dir().join(id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn builtin_manifests_parse_and_validate() {
        let only = std::env::var("COMPOLA_SMOKE").unwrap_or_default();
        for &id in BUILTINS.iter().filter(|id| only.is_empty() || only.split(',').any(|o| o == **id)) {
            let m: Manifest = serde_json::from_str(&builtin_manifest(id).unwrap_or_else(|| panic!("{id}: no manifest.json"))).unwrap();
            assert_eq!(m.id, id);
            m.validate().unwrap_or_else(|e| panic!("{id}: {e}"));
            // Every declared view's entry and its relative files are in the bundle.
            let files: Vec<String> = builtin_files(id).into_iter().map(|f| f.0).collect();
            assert!(files.contains(&m.main), "{id}: {} missing", m.main);
            for v in views::declared(&m.contributes.views) {
                let entry = v["entry"].as_str().unwrap();
                assert!(files.iter().any(|f| f == entry), "{id}: view entry {entry} missing");
            }
        }
    }

    #[test]
    fn network_needs_explicit_hosts() {
        let m = |v: Value| serde_json::from_value::<Manifest>(v).unwrap().validate();
        assert!(m(json!({ "id": "a", "name": "A", "permissions": ["network"] })).is_err(), "no \"any host\"");
        assert!(m(json!({ "id": "a", "name": "A", "permissions": ["network"], "hosts": ["*"] })).is_err());
        assert!(m(json!({ "id": "a", "name": "A", "permissions": ["network"], "hosts": ["*.com"] })).is_err());
        assert!(m(json!({ "id": "a", "name": "A", "permissions": ["network"], "hosts": ["api.x.com"] })).is_ok());
        assert!(m(json!({ "id": "a", "name": "A", "permissions": ["network"], "settings": [{ "key": "hook", "type": "url" }] })).is_ok());
        assert!(
            m(json!({ "id": "a", "name": "A", "permissions": ["network"], "settings": [{ "key": "hook", "type": "url", "default": "http://10.0.0.1" }] })).is_err(),
            "an add-on cannot pre-fill the address it may reach"
        );
    }

    #[test]
    fn single_file_manifest_comment() {
        let m = embedded_manifest("/* @compola-addon {\"id\":\"x\",\"name\":\"X\",\"permissions\":[\"mcp\"]} */\ncompola.log('hi')").unwrap();
        assert_eq!(m.id, "x");
        assert_eq!(m.permissions, vec!["mcp"]);
        assert!(!valid_id("../x") && !valid_id("") && valid_id("my-addon_1.2"));
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(newer("1.10.0", "1.9.2"));
        assert!(newer("2", "1.9"));
        assert!(!newer("1.0.0", "1.0"));
        assert!(!newer("1.0.0", "1.0.1"));
        assert!(newer("v1.2.1", "1.2.0"));
    }

    #[test]
    fn manifest_rejects_bad_fields() {
        let base = || serde_json::from_value::<Manifest>(serde_json::json!({ "id": "a", "name": "A" })).unwrap();
        let mut m = base();
        m.permissions = vec!["root".into()];
        assert!(m.validate().is_err());
        let mut m = base();
        m.main = "../x.js".into();
        assert!(m.validate().is_err());
        let mut m = base();
        m.hosts = vec!["http://x".into()];
        assert!(m.validate().is_err());
        let mut m = base();
        m.hosts = vec!["*.example.com".into()];
        m.permissions = vec!["network".into()];
        assert!(m.validate().is_ok());
        assert_eq!(base().memory_bytes(), 64 * 1024 * 1024);
    }

    fn zip_with(dir: &Path, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join(name);
        let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (n, bytes) in entries {
            w.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap();
        path
    }

    #[test]
    fn zip_packages() {
        let tmp = std::env::temp_dir().join(format!("compola-addon-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let manifest = br#"{"id":"z","name":"Z","version":"1.0.0","permissions":["notes"]}"#;
        // Files at the root.
        let p = zip_with(&tmp, "a.zip", &[("manifest.json", manifest), ("main.js", b"compola.log(1)"), ("__MACOSX/._main.js", b"x")]);
        let pkg = load(&p).unwrap();
        assert_eq!(pkg.manifest.id, "z");
        assert_eq!(pkg.files.len(), 2);
        // Zipped folder: everything under `z/`.
        let p = zip_with(&tmp, "b.zip", &[("z/manifest.json", manifest), ("z/main.js", b"1"), ("z/lib/util.js", b"2")]);
        let pkg = load(&p).unwrap();
        assert!(pkg.files.iter().any(|f| f.0 == "lib/util.js"));
        // Traversal.
        let p = zip_with(&tmp, "c.zip", &[("manifest.json", manifest), ("main.js", b"1"), ("../evil.js", b"x")]);
        assert!(load(&p).err().unwrap().contains("không an toàn"));
        // Missing main.
        let p = zip_with(&tmp, "d.zip", &[("manifest.json", manifest)]);
        assert!(load(&p).is_err());
        // Not a zip.
        std::fs::write(tmp.join("e.zip"), b"hello").unwrap();
        assert!(load(&tmp.join("e.zip")).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn zip_bomb_is_refused() {
        let tmp = std::env::temp_dir().join(format!("compola-addon-bomb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let big = vec![0u8; (MAX_FILE_BYTES + 10) as usize];
        let p = zip_with(&tmp, "bomb.zip", &[("manifest.json", br#"{"id":"b","name":"B"}"#), ("main.js", &big)]);
        assert!(std::fs::metadata(&p).unwrap().len() < 1024 * 1024, "compressed small");
        assert!(load(&p).err().unwrap().contains("quá lớn"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
