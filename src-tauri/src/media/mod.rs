//! Zalo CDN media for the UI window — port of `MediaLoader.swift`, `DoHResolver.swift`, `PinnedHTTPSClient.swift`
//! and `MediaDiagnostics.swift`.
//!
//! # URL scheme (the frontend uses exactly this; see `docs/media.md`)
//!
//! ```text
//! compola-media://load?url=<percent-encoded original URL>&flavour=image|cors[&retry=1]
//! ```
//! (On Windows/Android WebView2 the same scheme is reached as `http://compola-media.localhost/load?url=…`.)
//!
//! * `url` — the original `https://…` (or `http://`, upgraded to https) Zalo CDN URL, encoded with
//!   `encodeURIComponent`. `file://` URLs under Compola's own data / cache directories are served too.
//! * `flavour=image` (default) — an `<img>`-style load (`sec-fetch-dest: image`, `no-cors`, image `Accept`):
//!   avatars, photos, stickers. Whole body in memory, 25 s deadline, cached in `MediaCache/media` (400 MB, LRU).
//! * `flavour=cors` — a `fetch()`-style load (`sec-fetch-mode: cors`, `Accept: */*`): video, voice, files.
//!   Streamed to `MediaCache/files/<hash>.<ext>` (2 GB, LRU; 30 s stall timeout, no total deadline), then
//!   served from disk — `Range` requests are answered from the `.part` file while the download still runs
//!   (`active.rs`). Use this for `<video>`/`<audio>`.
//! * `retry=1` — drop the short (20 s) failure backoff for this URL (an explicit "retry" click).
//!
//! Responses carry the upstream `Content-Type`, `Accept-Ranges: bytes`, and honour `Range` (206 / 416).
//! Only Zalo hosts are served (`is_allowed_host`); anything else is `403`. Failures: the upstream HTTP status
//! when the CDN answered (e.g. `404`), else `404` (host gone), `413` (too large), `502` (network / DNS / TLS),
//! `504` (timeout), with `X-Compola-Error: <class>` (`http-404`, `dns`, `timeout`, `offline`, `tls`, `size`, …).
//!
//! Transport, like `NetworkProxy::request`: the fingerprint helper first (`net::perform_via_helper`, with the
//! client cookie jar), else reqwest with the same cookies and headers. For Zalo CDN hosts a failing system
//! resolver is bypassed with DNS-over-HTTPS + a client pinned to the resolved addresses (SNI and certificate
//! checks stay on the original hostname).

pub mod active;
pub mod cache;
pub mod diagnostics;
pub mod doh;
pub mod flights;
pub mod headers;
pub mod http;
pub mod loader;
pub mod open;
pub mod pinned;
pub mod policy;
pub mod protocol;

use std::fmt;
use std::path::{Path, PathBuf};

pub use loader::MediaLoader;

/// Hosts for which the DoH fallback is allowed (so arbitrary hosts embedded in message content cannot bypass the
/// user's own DNS / hosts-file blocking). Swift `MediaLoader.dohHostSuffixes`.
pub const DOH_HOST_SUFFIXES: &[&str] = &["zadn.vn", "zdn.vn", "zalo.me", "zaloapp.com", "zingcdn.me", "zalo.vn", "zing.vn"];

/// Hosts the `compola-media` scheme serves: the DoH list plus Zalo's video CDN.
pub const SERVED_HOST_SUFFIXES: &[&str] = &["z-cdn.me"];

fn matches_suffix(host: &str, suffixes: &[&str]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    suffixes.iter().any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

/// Swift `MediaLoader.isZaloCDN`: may this host use the DoH fallback (and receive sensitive headers)?
pub fn is_zalo_cdn(host: &str) -> bool {
    matches_suffix(host, DOH_HOST_SUFFIXES)
}

/// May the UI load media from this host through `compola-media`?
pub fn is_allowed_host(host: &str) -> bool {
    is_zalo_cdn(host) || matches_suffix(host, SERVED_HOST_SUFFIXES)
}

/// Swift `MediaLoader.normalized`: http(s) with a host; http is upgraded (Zalo's CDN serves https).
pub fn normalized(url: &url::Url) -> Option<url::Url> {
    let scheme = url.scheme();
    if (scheme != "https" && scheme != "http") || url.host_str().is_none_or(str::is_empty) {
        return None;
    }
    let mut url = url.clone();
    if scheme == "http" {
        url.set_scheme("https").ok()?;
    }
    Some(url)
}

// ---- errors ----

/// DoH resolver failures (Swift `DoHResolver.ResolveError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolveError {
    /// Authoritative NXDOMAIN.
    NotFound(String),
    AllEndpointsFailed(String),
}

/// Class of a transport failure (what URLError codes told the Swift code).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetFailure {
    Dns,
    Timeout,
    Offline,
    Tls,
    Other,
}

impl NetFailure {
    /// Swift `MediaLoader.isDNSFailure`: failures that may be a broken system resolver (macOS reports some DNS
    /// failures as "offline", and a stalled resolver as a timeout).
    pub fn is_dns_failure(self) -> bool {
        matches!(self, Self::Dns | Self::Offline | Self::Timeout)
    }
}

/// Swift `MediaLoader.LoadError` plus the transport / resolver errors it caught.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaError {
    BadUrl,
    /// Host or local path outside the allow-list.
    Forbidden,
    Http(u16),
    TimedOut,
    TooLarge,
    /// The CDN host does not exist (authoritative NXDOMAIN): nothing to retry.
    HostNotFound,
    Net(NetFailure, String),
    Doh(ResolveError),
    Io(String),
    Cancelled,
}

impl MediaError {
    /// Swift's `catch let loadError as LoadError`: a verdict about the resource itself (the server was reached or
    /// the request is invalid), never a reason to try the other DNS path.
    pub fn is_load_error(&self) -> bool {
        matches!(self, Self::BadUrl | Self::Forbidden | Self::Http(_) | Self::TimedOut | Self::TooLarge | Self::HostNotFound)
    }
}

impl fmt::Display for MediaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadUrl => write!(f, "Unsupported media URL"),
            Self::Forbidden => write!(f, "Media host not allowed"),
            Self::Http(code) => write!(f, "Media request failed with HTTP {code}"),
            Self::TimedOut => write!(f, "Media download timed out"),
            Self::TooLarge => write!(f, "Media file is too large"),
            Self::HostNotFound => write!(f, "Media host no longer exists"),
            Self::Net(kind, msg) => write!(f, "Media network error ({kind:?}): {msg}"),
            Self::Doh(ResolveError::NotFound(h)) => write!(f, "DoH: no A record for {h}"),
            Self::Doh(ResolveError::AllEndpointsFailed(h)) => write!(f, "DoH: all resolvers failed for {h}"),
            Self::Io(msg) => write!(f, "Media file error: {msg}"),
            Self::Cancelled => write!(f, "Cancelled"),
        }
    }
}

impl From<std::io::Error> for MediaError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

// ---- local files ----

/// Roots `file://` media may be read from (Swift `allowedLocalRoots`): the Zalo data directory (the official
/// client's `ZaloDownloads`) and the media caches.
pub fn allowed_local_roots() -> Vec<PathBuf> {
    let base = crate::platform::app_support();
    vec![base.join("ZaloData"), base.join("MediaCache")]
}

/// Swift `isLocalFile(_:under:)`: the symlink-resolved path lies strictly inside one of `roots`.
pub fn is_local_file_under(path: &Path, roots: &[PathBuf]) -> bool {
    let Ok(resolved) = std::fs::canonicalize(path) else { return false };
    roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|root| resolved != root && resolved.starts_with(&root))
}

pub fn is_allowed_local_file(url: &url::Url) -> Option<PathBuf> {
    if url.scheme() != "file" {
        return None;
    }
    let path = url.to_file_path().ok()?;
    is_local_file_under(&path, &allowed_local_roots()).then_some(path)
}

// ---- Tauri command ----

/// Saves a media URL to a path the user chose (the Swift views' "Lưu về máy…"): from the image cache when the photo
/// is already there, else through the file download path. Written atomically and quarantined like a download.
#[tauri::command]
pub async fn media_save(app: tauri::AppHandle, url: String, dest_path: String) -> Result<String, String> {
    let parsed = url::Url::parse(&url).map_err(|_| MediaError::BadUrl.to_string())?;
    let dest = PathBuf::from(&dest_path);
    if !dest.is_absolute() || dest.file_name().is_none() || !dest.parent().is_some_and(Path::is_dir) {
        return Err("invalid destination".into());
    }
    let loader = MediaLoader::shared(&app);
    let origin = parsed.clone();
    let source = if parsed.scheme() == "file" {
        Source::File(is_allowed_local_file(&parsed).ok_or_else(|| MediaError::Forbidden.to_string())?)
    } else {
        let url = normalized(&parsed).ok_or_else(|| MediaError::BadUrl.to_string())?;
        if !url.host_str().is_some_and(is_allowed_host) {
            return Err(MediaError::Forbidden.to_string());
        }
        match loader.cache.read_media(&url) {
            Some((_, bytes)) => Source::Bytes(bytes),
            None => Source::File(loader.local_file(&url).await.map_err(|e| e.to_string())?),
        }
    };
    tokio::task::spawn_blocking(move || save_atomically(source, &dest, &origin))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(dest_path)
}

/// What `media_open_file` did.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOutcome {
    pub path: String,
    /// True: the file could run code, so it was revealed in Finder instead of opened (the UI says so — Swift:
    /// "Đã mở trong Finder vì tệp có thể chạy mã").
    pub revealed: bool,
}

/// A file attachment's URL as the file to open: Zalo CDN URLs download through the client stack into the file
/// cache (the `cors` flavour); `file://` URLs must be inside our own roots.
async fn openable_file(app: &tauri::AppHandle, url: &str) -> Result<PathBuf, MediaError> {
    let parsed = url::Url::parse(url).map_err(|_| MediaError::BadUrl)?;
    if parsed.scheme() == "file" {
        return is_allowed_local_file(&parsed).ok_or(MediaError::Forbidden);
    }
    let url = normalized(&parsed).ok_or(MediaError::BadUrl)?;
    if !url.host_str().is_some_and(is_allowed_host) {
        return Err(MediaError::Forbidden);
    }
    MediaLoader::shared(app).local_file(&url).await
}

/// Swift `FileCard.open`: download, then open with the default app — or, when the file could run code (by its
/// extension, the sender's file name, or its first bytes), reveal it in Finder instead.
#[tauri::command]
pub async fn media_open_file(app: tauri::AppHandle, url: String, name: Option<String>) -> Result<OpenOutcome, String> {
    let file = openable_file(&app, &url).await.map_err(|e| e.to_string())?;
    let name = name.unwrap_or_default();
    let check = file.clone();
    let revealed = tokio::task::spawn_blocking(move || open::may_execute(&check, &name)).await.map_err(|e| e.to_string())?;
    if revealed {
        tauri_plugin_opener::reveal_item_in_dir(&file).map_err(|e| e.to_string())?;
    } else {
        tauri_plugin_opener::open_path(&file, None::<&str>).map_err(|e| e.to_string())?;
    }
    Ok(OpenOutcome { path: file.to_string_lossy().into_owned(), revealed })
}

enum Source {
    File(PathBuf),
    Bytes(Vec<u8>),
}

fn save_atomically(source: Source, dest: &Path, origin: &url::Url) -> std::io::Result<()> {
    let dir = dest.parent().unwrap_or(Path::new("/"));
    let temp = dir.join(format!(".{}.compola-part", uuid::Uuid::new_v4()));
    let result = (|| {
        match &source {
            Source::File(path) => {
                std::fs::copy(path, &temp)?;
            }
            Source::Bytes(bytes) => std::fs::write(&temp, bytes)?,
        }
        cache::apply_quarantine(&temp, origin);
        std::fs::rename(&temp, dest)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doh_only_for_zalo_cdn_hosts() {
        for host in ["s160-26-ava-talk.zadn.vn", "res-zalo.zadn.vn", "stc-zaloprofile.zdn.vn", "chat.zalo.me", "tt-convers-wpa.api.zaloapp.com", "ZADN.VN"] {
            assert!(is_zalo_cdn(host), "{host}");
        }
        for host in ["evil.com", "zadn.vn.evil.com", "notzadn.vn", "example.org", "localhost", "192.168.1.1", ""] {
            assert!(!is_zalo_cdn(host), "{host}");
        }
    }

    #[test]
    fn served_hosts_extend_the_doh_list_only_with_zalo_domains() {
        assert!(is_allowed_host("video-sgp1-1.z-cdn.me"));
        assert!(!is_zalo_cdn("video-sgp1-1.z-cdn.me"));
        assert!(is_allowed_host("f21-zpc.zdn.vn"));
        assert!(!is_allowed_host("z-cdn.me.evil.com"));
        assert!(!is_allowed_host("www.apple.com"));
    }

    #[test]
    fn normalization_upgrades_http_and_rejects_other_schemes() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert_eq!(normalized(&u("http://res-zalo.zadn.vn/a.jpg")).unwrap().as_str(), "https://res-zalo.zadn.vn/a.jpg");
        assert_eq!(normalized(&u("https://res-zalo.zadn.vn/a.jpg?x=1")).unwrap().as_str(), "https://res-zalo.zadn.vn/a.jpg?x=1");
        assert!(normalized(&u("ftp://x/y.jpg")).is_none());
        assert!(normalized(&u("file:///etc/hosts")).is_none());
        assert!(normalized(&u("data:text/plain,hi")).is_none());
    }

    #[test]
    fn only_our_directories_are_readable() {
        let dir = std::env::temp_dir().join(format!("compola-local-{}", uuid::Uuid::new_v4()));
        let inside = dir.join("ZaloDownloads/x.jpg");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::write(&inside, b"x").unwrap();
        let roots = vec![dir.clone()];
        assert!(is_local_file_under(&inside, &roots));
        assert!(!is_local_file_under(Path::new("/etc/hosts"), &roots));
        assert!(!is_local_file_under(&inside.join("../../../../../../../../etc/hosts"), &roots));
        assert!(!is_local_file_under(&dir, &roots)); // the root itself is not a file inside it
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", dir.join("escape")).unwrap();
            assert!(!is_local_file_under(&dir.join("escape"), &roots));
        }
        assert!(is_allowed_local_file(&url::Url::parse("https://example.com/a.jpg").unwrap()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dns_failure_classification() {
        assert!(NetFailure::Dns.is_dns_failure());
        assert!(NetFailure::Offline.is_dns_failure()); // macOS reports some DNS failures this way
        assert!(NetFailure::Timeout.is_dns_failure());
        assert!(!NetFailure::Tls.is_dns_failure());
        assert!(!NetFailure::Other.is_dns_failure());
    }

    #[test]
    fn save_is_atomic_and_leaves_nothing_behind() {
        let dir = std::env::temp_dir().join(format!("compola-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("a.jpg");
        let origin = url::Url::parse("https://f6-zpc.zdn.vn/a.jpg").unwrap();
        save_atomically(Source::Bytes(b"one".to_vec()), &dest, &origin).unwrap();
        save_atomically(Source::Bytes(b"two".to_vec()), &dest, &origin).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"two");
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("a.jpg")]);
        assert!(save_atomically(Source::File(dir.join("missing")), &dest, &origin).is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
