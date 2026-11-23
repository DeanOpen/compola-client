//! Locates the official Zalo PC code the host runs (port of `OfficialZaloInstall` / `ZaloRuntime`).
//! The installer (download from VNG + signature check) lives in `installer.rs`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::asar::{AsarArchive, client_version_from_main_js};
use crate::net::fp;

pub struct RuntimeInfo {
    pub app_dir: PathBuf,
    pub version: String,
    pub client_version: String,
    pub asar: Arc<AsarArchive>,
}

pub fn root() -> PathBuf {
    crate::platform::app_support().join("ZaloRuntime")
}

pub fn current() -> PathBuf {
    root().join("current")
}

pub fn is_complete(dir: &Path) -> bool {
    dir.join("Contents/Info.plist").exists() && dir.join("Contents/Resources/app.asar").exists()
}

pub fn version_of(dir: &Path) -> Option<String> {
    let v = plist::Value::from_file(dir.join("Contents/Info.plist")).ok()?;
    v.as_dictionary()?.get("CFBundleShortVersionString")?.as_string().map(str::to_owned)
}

/// The runtime folder to use: `COMPOLA_ZALO_APP` (development: any Zalo.app or runtime folder), else ours.
pub fn candidate() -> PathBuf {
    std::env::var_os("COMPOLA_ZALO_APP").map(PathBuf::from).unwrap_or_else(current)
}

pub fn locate(dir: &Path) -> anyhow::Result<RuntimeInfo> {
    anyhow::ensure!(is_complete(dir), "no Zalo runtime at {}", dir.display());
    let asar = AsarArchive::open(&dir.join("Contents/Resources/app.asar"))?;
    let client_version = asar
        .read("main-dist/main.js")
        .and_then(|d| client_version_from_main_js(&d))
        .unwrap_or_else(|| fp::DEFAULT_CLIENT_VERSION.into());
    Ok(RuntimeInfo {
        app_dir: dir.to_owned(),
        version: version_of(dir).unwrap_or_else(|| "?".into()),
        client_version,
        asar: Arc::new(asar),
    })
}
