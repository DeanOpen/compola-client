//! Host-side state the bridge exposes to the renderer: data directories, electron-store files, client constants
//! (port of `ZaloPlatform.swift`). Compola keeps its own data directory — it never touches the official app's.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

pub struct Platform {
    pub app_version: String,
    pub client_type: String,
    pub client_version: String,
    pub user_data: PathBuf,
}

/// `~/Library/Application Support/Compola`, or `COMPOLA_DATA_DIR` (a second instance on the same Mac, e.g. a Compola
/// Server host and a joined app side by side while developing).
pub fn app_support() -> PathBuf {
    if let Some(dir) = std::env::var_os("COMPOLA_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("Compola")
}

/// Headless server mode (`COMPOLA_HEADLESS=1`, the Linux server container): no window is shown, Compola Server is
/// always on and listens on every interface (`COMPOLA_PORT`), and `COMPOLA_ADMIN=user:password` creates the first admin.
pub fn headless() -> bool {
    std::env::var("COMPOLA_HEADLESS").is_ok_and(|v| !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"))
}

impl Platform {
    /// The platform of one account (its Electron `userData`: `ZaloData/` for `default`, `Accounts/<id>/ZaloData/`).
    pub fn new(app_version: String, client_version: String, user_data: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&user_data);
        Self { app_version, client_type: crate::net::fp::CLIENT_TYPE.into(), client_version, user_data }
    }

    pub fn user_agent(&self) -> String {
        crate::net::fp::user_agent(&self.client_version)
    }

    pub fn temp_dir(&self) -> PathBuf {
        std::env::temp_dir().join("Compola")
    }

    /// Electron `app.getPath(name)`.
    pub fn path(&self, name: &str) -> String {
        let p = match name {
            "userData" | "appData" => self.user_data.clone(),
            "temp" => self.temp_dir(),
            "home" => dirs::home_dir().unwrap_or_default(),
            "downloads" => dirs::download_dir().unwrap_or_default(),
            "documents" => dirs::document_dir().unwrap_or_default(),
            "desktop" => dirs::desktop_dir().unwrap_or_default(),
            "pictures" => dirs::picture_dir().unwrap_or_default(),
            "logs" => self.user_data.join("logs"),
            other => {
                log::debug!("getPath({other}) → userData");
                self.user_data.clone()
            }
        };
        p.to_string_lossy().into_owned()
    }

    // ---- electron-store files (<userData>/<name>.json) ----

    pub fn store_path(&self, name: &str) -> PathBuf {
        let safe = name.replace('/', "_").replace("..", "_");
        self.user_data.join(format!("{safe}.json"))
    }

    pub fn read_store(&self, name: &str) -> Map<String, Value> {
        std::fs::read(self.store_path(name))
            .ok()
            .and_then(|d| serde_json::from_slice::<Value>(&d).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    pub fn write_store(&self, name: &str, object: &Map<String, Value>) -> std::io::Result<()> {
        let path = self.store_path(name);
        let data = serde_json::to_vec_pretty(object)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, data)?;
        std::fs::rename(tmp, path)
    }

    /// The renderer may only write inside our data/temp directories and the user's Downloads. A missing Downloads
    /// folder (Linux without XDG user dirs) is no root at all: an empty path would be a prefix of everything.
    pub fn is_writable(&self, path: &str) -> bool {
        let resolved = canonical(Path::new(path));
        [Some(self.user_data.clone()), Some(self.temp_dir()), dirs::download_dir()]
            .into_iter()
            .flatten()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| canonical(&p))
            .any(|root| resolved == root || resolved.starts_with(&root))
    }
}

/// Resolves symlinks of the longest existing ancestor (components that do not exist yet cannot be links).
fn canonical(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(|s| s.to_owned()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut out = std::fs::canonicalize(&existing).unwrap_or(existing);
    for part in rest.into_iter().rev() {
        if part == ".." {
            out.pop();
        } else if part != "." {
            out.push(part);
        }
    }
    out
}
