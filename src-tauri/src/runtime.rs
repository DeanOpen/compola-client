//! Locates the official Zalo PC code the host runs (port of `OfficialZaloInstall` / `ZaloRuntime`).
//! The installer (download from VNG + signature check) lives in `installer.rs`.
//!
//! Compola does not ship VNG's code: on first launch the installer fetches the official Zalo PC installer from VNG (or
//! copies an installed Zalo.app of the pinned version), checks VNG's code signature and keeps the parts Compola uses:
//!
//!   ZaloRuntime/current/Contents/Info.plist                    version
//!   ZaloRuntime/current/Contents/Resources/app.asar            the renderer (`pc-dist`)
//!   ZaloRuntime/current/Contents/Resources/app.asar.unpacked   when the app has one
//!   ZaloRuntime/current/Contents/ZaloHelper.app                ZaloCall (calls) and ZaloCap (screenshots), signed by VNG
//!
//! The folder keeps Zalo.app's `Contents/…` layout, so paths resolve as they did inside Zalo.app, but is not named
//! `.app`: LaunchServices must not register a partial Zalo (it declares `zalo://`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::asar::{AsarArchive, client_version_from_main_js};
use crate::net::fp;

#[derive(Clone)]
pub struct RuntimeInfo {
    pub app_dir: PathBuf,
    pub version: String,
    pub client_version: String,
    pub asar: Arc<AsarArchive>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub url: String,
    /// SHA-256 (hex) of the DMG when the release is pinned.
    pub sha256: Option<String>,
}

/// The Zalo PC release this Compola build is tested with. Bumping it (version, DMG URL, DMG checksum) is how Compola moves
/// to a newer Zalo: an older runtime is upgraded in the background and swapped in at the next launch.
pub const PINNED_VERSION: &str = "26.10.20";
pub const PINNED_URL: &str = "https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-26.10.20.dmg";
pub const PINNED_SHA256: &str = "a45d30b7f7b060f76b87722ef419b8f41d23a2913cdef084dcb0955dde8d85a0";

pub fn pinned() -> Release {
    Release { version: PINNED_VERSION.into(), url: PINNED_URL.into(), sha256: Some(PINNED_SHA256.into()) }
}

/// The download button of zalo.me/pc: redirects a Mac browser to the current DMG. Used when the pinned one is gone.
pub const LATEST_LINK: &str = "https://zalo.me/download/zalo-pc";

/// What is copied out of Zalo.app (`OPTIONAL_PARTS` only when present).
pub const PARTS: [&str; 3] = ["Contents/Info.plist", "Contents/Resources/app.asar", "Contents/ZaloHelper.app"];
/// Nothing optional: `app.asar.unpacked` holds only Electron's native `.node` modules (~125 MB), which this host
/// never loads (Rust plays the main process), so it is not copied — as in the Swift app.
pub const OPTIONAL_PARTS: [&str; 0] = [];

pub fn root() -> PathBuf {
    crate::platform::app_support().join("ZaloRuntime")
}

/// The runtime in use.
pub fn current() -> PathBuf {
    root().join("current")
}

/// A verified upgrade, swapped in by `installer::prepare_for_launch`.
pub fn pending() -> PathBuf {
    root().join("pending")
}

/// Downloads, mounts and half-copied folders; emptied at every launch.
pub fn work() -> PathBuf {
    root().join("work")
}

/// `…/Contents/ZaloHelper.app/Contents/MacOS/<name>` (`ZaloCall`, `ZaloCap`).
pub fn helper(name: &str, runtime: &Path) -> PathBuf {
    runtime.join("Contents/ZaloHelper.app/Contents/MacOS").join(name)
}

pub fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

pub fn is_complete(dir: &Path) -> bool {
    dir.join("Contents/Info.plist").is_file()
        && dir.join("Contents/Resources/app.asar").is_file()
        && is_executable_file(&helper("ZaloCall", dir))
}

/// `26.10.20` is newer than `26.9.10`: compared component-wise as numbers (missing or non-numeric components are 0).
pub fn is_newer(version: &str, other: &str) -> bool {
    let parse = |v: &str| v.split('.').map(|c| c.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parse(version), parse(other));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// `ZaloSetup-universal-26.10.20.dmg` → `26.10.20`.
pub fn version_from_installer_name(name: &str) -> Option<String> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^ZaloSetup-[A-Za-z0-9]+-(\d+(?:\.\d+)+)\.dmg$").unwrap());
    RE.captures(name).map(|c| c[1].to_owned())
}

/// `CFBundleShortVersionString` of a Zalo.app or runtime folder.
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
