//! The `compola-media` URI scheme (asynchronous). See the module docs of `media` and `docs/media.md`:
//! * `compola-media://load?url=<encoded>&flavour=image|cors[&retry=1]` — Zalo CDN media;
//! * `compola-media://load?file=<encoded absolute path>&flavour=image|video` — local files (`resolveMedia` results)
//!   under `ZaloData` / `MediaCache` only;
//! * `compola-media://load?asset=pc-dist/<path>` — a file of the official renderer's `app.asar` (reaction icons,
//!   emoji / sticker sprites).

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, UriSchemeContext, UriSchemeResponder, Wry};

use super::headers::Flavour;
use super::active::ActiveDownload;
use super::loader::{FileStart, Media};
use super::{MediaError, MediaLoader, NetFailure, diagnostics, is_allowed_host, normalized};

pub const SCHEME: &str = "compola-media";
/// An open-ended range (`bytes=N-`) is answered with at most this much; players ask again for the rest.
pub const MAX_OPEN_RANGE: u64 = 8 << 20;

/// A parsed `compola-media` request.
#[derive(Debug, PartialEq, Eq)]
pub struct MediaRequest {
    pub url: url::Url,
    pub flavour: Flavour,
    pub retry: bool,
}

/// How a local file is meant to be shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalFlavour {
    Image,
    Video,
}

/// Any `compola-media` request.
#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Remote(MediaRequest),
    /// A canonical path inside the allowed local roots.
    Local(PathBuf, LocalFlavour),
    /// An `app.asar` path starting with `pc-dist/`.
    Asset(String),
}

/// Long-lived cache for `app.asar` assets (they change only with a runtime upgrade).
pub const ASSET_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
/// Local files can be replaced at the same path (a re-downloaded corrupt file): always revalidate.
pub const LOCAL_CACHE_CONTROL: &str = "no-cache";

/// `pc-dist/<path>`: no absolute path, no `.`/`..`/empty segment, no backslash or control character.
pub fn valid_asset_path(path: &str) -> bool {
    path.strip_prefix("pc-dist/").is_some_and(|rest| {
        !rest.is_empty()
            && !path.chars().any(|c| c == '\\' || c.is_control())
            && rest.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
    })
}

/// Swift `isAllowedLocalFile` for a `file=` path: absolute, and its symlink-resolved location inside `roots`.
/// A missing file inside the roots is 404; anything else outside is 403.
pub fn check_local_path(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, (u16, &'static str)> {
    let path = std::path::Path::new(raw);
    if !path.is_absolute() {
        return Err((400, "path must be absolute"));
    }
    match std::fs::canonicalize(path) {
        Ok(resolved) => {
            if super::is_local_file_under(&resolved, roots) && resolved.is_file() {
                Ok(resolved)
            } else {
                Err((403, "path not allowed"))
            }
        }
        Err(_) => {
            let parent_inside = path.parent().and_then(|p| std::fs::canonicalize(p).ok()).is_some_and(|parent| {
                roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|root| parent.starts_with(&root))
            });
            Err(if parent_inside && !raw.split('/').any(|s| s == "..") { (404, "no such file") } else { (403, "path not allowed") })
        }
    }
}

/// Parses the request URI. `Err((status, reason))` for a request that must not be served.
pub fn parse_request(uri: &http::Uri) -> Result<Request, (u16, &'static str)> {
    parse_request_with_roots(uri, &super::allowed_local_roots())
}

pub fn parse_request_with_roots(uri: &http::Uri, roots: &[PathBuf]) -> Result<Request, (u16, &'static str)> {
    let query = uri.query().ok_or((400, "missing query"))?;
    let mut url = None;
    let mut file = None;
    let mut asset = None;
    let mut flavour_text = None;
    let mut retry = false;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "url" => url = Some(value.into_owned()),
            "file" => file = Some(value.into_owned()),
            "asset" => asset = Some(value.into_owned()),
            "flavour" | "flavor" => flavour_text = Some(value.into_owned()),
            "retry" => retry = value == "1" || value == "true",
            _ => {}
        }
    }
    match (url, file, asset) {
        (Some(raw), None, None) => {
            let flavour = Flavour::parse(flavour_text.as_deref().unwrap_or("")).ok_or((400, "bad flavour"))?;
            parse_remote(&raw, flavour, retry).map(Request::Remote)
        }
        (None, Some(raw), None) => {
            let flavour = match flavour_text.as_deref().unwrap_or("image") {
                "image" | "" => LocalFlavour::Image,
                "video" => LocalFlavour::Video,
                _ => return Err((400, "bad flavour")),
            };
            Ok(Request::Local(check_local_path(&raw, roots)?, flavour))
        }
        (None, None, Some(path)) => {
            if !valid_asset_path(&path) {
                return Err((403, "asset path not allowed"));
            }
            Ok(Request::Asset(path))
        }
        (None, None, None) => Err((400, "missing url, file or asset")),
        _ => Err((400, "only one of url, file, asset")),
    }
}

fn parse_remote(raw: &str, flavour: Flavour, retry: bool) -> Result<MediaRequest, (u16, &'static str)> {
    let parsed = url::Url::parse(raw).map_err(|_| (400, "bad url"))?;
    let url = match parsed.scheme() {
        "file" => {
            if super::is_allowed_local_file(&parsed).is_none() {
                return Err((403, "path not allowed"));
            }
            parsed
        }
        _ => {
            let url = normalized(&parsed).ok_or((400, "unsupported url"))?;
            if !url.host_str().is_some_and(is_allowed_host) {
                return Err((403, "host not allowed"));
            }
            url
        }
    };
    Ok(MediaRequest { url, flavour, retry })
}

/// What a `Range` header asks of a body of `total` bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum RangeOutcome {
    /// No (usable) range: the whole body, 200.
    Full,
    /// Inclusive byte range, 206.
    Partial(u64, u64),
    /// 416.
    Unsatisfiable,
}

/// Single `bytes=` ranges (`a-b`, `a-`, `-n`); multi-range and malformed headers are served in full.
pub fn parse_range(header: Option<&str>, total: u64) -> RangeOutcome {
    let Some(spec) = header.map(str::trim).and_then(|h| h.strip_prefix("bytes=")) else { return RangeOutcome::Full };
    if spec.contains(',') {
        return RangeOutcome::Full;
    }
    let Some((start, end)) = spec.trim().split_once('-') else { return RangeOutcome::Full };
    let (start, end) = (start.trim(), end.trim());
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if start.is_empty() {
        // Suffix: the last n bytes.
        if !digits(end) {
            return RangeOutcome::Full;
        }
        let n: u64 = end.parse().unwrap_or(u64::MAX);
        if n == 0 || total == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        return RangeOutcome::Partial(total.saturating_sub(n), total - 1);
    }
    if !digits(start) || (!end.is_empty() && !digits(end)) {
        return RangeOutcome::Full;
    }
    let Ok(first) = start.parse::<u64>() else { return RangeOutcome::Unsatisfiable };
    if first >= total {
        return RangeOutcome::Unsatisfiable;
    }
    let last = if end.is_empty() {
        (first + MAX_OPEN_RANGE - 1).min(total - 1)
    } else {
        match end.parse::<u64>() {
            Ok(e) if e >= first => e.min(total - 1),
            Ok(_) => return RangeOutcome::Full, // invalid (last < first): ignore the header
            Err(_) => total - 1,
        }
    };
    RangeOutcome::Partial(first, last)
}

/// HTTP status for a failed load.
pub fn error_status(error: &MediaError) -> u16 {
    match error {
        MediaError::Http(code) if (400..600).contains(code) => *code,
        MediaError::Forbidden => 403,
        MediaError::BadUrl => 400,
        MediaError::HostNotFound => 404,
        MediaError::TooLarge => 413,
        MediaError::TimedOut | MediaError::Net(NetFailure::Timeout, _) => 504,
        MediaError::Cancelled => 503,
        _ => 502,
    }
}

fn base(status: u16) -> http::response::Builder {
    http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, X-Compola-Error, X-Compola-Media-Kind")
}

fn plain(status: u16, reason: &str, class: Option<&str>) -> http::Response<Vec<u8>> {
    let mut builder = base(status).header("Content-Type", "text/plain; charset=utf-8").header("Cache-Control", "no-store");
    if let Some(class) = class {
        builder = builder.header("X-Compola-Error", class);
    }
    builder.body(reason.as_bytes().to_vec()).unwrap_or_default()
}

fn failure(error: &MediaError) -> http::Response<Vec<u8>> {
    let class = diagnostics::classify(error).unwrap_or_else(|| "cancelled".into());
    plain(error_status(error), &error.to_string(), Some(&class))
}

/// The response for a body of `total` bytes; `read(start, end)` yields the inclusive slice.
fn ranged(
    content_type: &str,
    total: u64,
    range: Option<&str>,
    head: bool,
    read: impl FnOnce(u64, u64) -> std::io::Result<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let (status, start, end) = match parse_range(range, total) {
        RangeOutcome::Full => (200, 0, total.saturating_sub(1)),
        RangeOutcome::Partial(s, e) => (206, s, e),
        RangeOutcome::Unsatisfiable => {
            return base(416).header("Content-Range", format!("bytes */{total}")).header("Cache-Control", "no-store").body(Vec::new()).unwrap_or_default();
        }
    };
    let length = if total == 0 { 0 } else { end - start + 1 };
    let body = if head || length == 0 {
        Vec::new()
    } else {
        match read(start, end) {
            Ok(b) => b,
            Err(e) => return failure(&MediaError::Io(e.to_string())),
        }
    };
    let mut builder = base(status)
        .header("Content-Type", content_type)
        .header("Content-Length", length.to_string())
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "private, max-age=86400");
    if status == 206 {
        builder = builder.header("Content-Range", format!("bytes {start}-{end}/{total}"));
    }
    builder.body(body).unwrap_or_default()
}

fn from_memory(media: &Media, range: Option<&str>, head: bool) -> http::Response<Vec<u8>> {
    let total = media.bytes.len() as u64;
    ranged(&media.content_type, total, range, head, |s, e| Ok(media.bytes[s as usize..=e as usize].to_vec()))
}

fn from_file(path: &PathBuf, range: Option<&str>, head: bool) -> http::Response<Vec<u8>> {
    let total = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) => return failure(&MediaError::Io(e.to_string())),
    };
    let content_type = super::cache::file_content_type(path);
    ranged(&content_type, total, range, head, |s, e| {
        let mut file = std::fs::File::open(path)?;
        file.seek(SeekFrom::Start(s))?;
        let mut body = vec![0u8; (e - s + 1) as usize];
        file.read_exact(&mut body)?;
        Ok(body)
    })
}

pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: http::Request<Vec<u8>>, responder: UriSchemeResponder) {
    let method = request.method().clone();
    if method == http::Method::OPTIONS {
        let response = base(204)
            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            .header("Access-Control-Allow-Headers", "Range")
            .body(Vec::new())
            .unwrap_or_default();
        return responder.respond(response);
    }
    if method != http::Method::GET && method != http::Method::HEAD {
        return responder.respond(plain(405, "method not allowed", None));
    }
    let parsed = match parse_request(request.uri()) {
        Ok(r) => r,
        Err((status, reason)) => return responder.respond(plain(status, reason, None)),
    };
    let head = method == http::Method::HEAD;
    let range = request.headers().get(http::header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let response = match parsed {
            Request::Remote(request) => serve(&MediaLoader::shared(&app), request, range, head).await,
            Request::Local(path, flavour) => tokio::task::spawn_blocking(move || serve_local(&path, flavour, range.as_deref(), head))
                .await
                .unwrap_or_else(|e| failure(&MediaError::Io(e.to_string()))),
            Request::Asset(path) => {
                let asar = app.try_state::<Arc<crate::engine::Engine>>().and_then(|e| e.main_process()).map(|m| m.asar.clone());
                match asar {
                    Some(asar) => tokio::task::spawn_blocking(move || serve_asset(asar.read(&path), &path, range.as_deref(), head))
                        .await
                        .unwrap_or_else(|e| failure(&MediaError::Io(e.to_string()))),
                    None => plain(503, "runtime not loaded", None),
                }
            }
        };
        responder.respond(response);
    });
}

/// Replaces the Cache-Control of a successful response.
fn with_cache_control(mut response: http::Response<Vec<u8>>, value: &'static str) -> http::Response<Vec<u8>> {
    if response.status().is_success() {
        response.headers_mut().insert(http::header::CACHE_CONTROL, http::HeaderValue::from_static(value));
    }
    response
}

/// ISO-BMFF video by its `ftyp` brand (Swift `VideoPoster.mimeType`).
pub fn video_mime(head: &[u8]) -> Option<&'static str> {
    if head.len() < 12 || &head[4..8] != b"ftyp" {
        return None;
    }
    let brand = &head[8..12];
    Some(if brand == b"qt  " {
        "video/quicktime"
    } else if brand.starts_with(b"3g") {
        "video/3gpp"
    } else if matches!(brand, b"M4A " | b"M4B " | b"heic" | b"heix" | b"mif1" | b"msf1" | b"avif") {
        return None;
    } else {
        "video/mp4"
    })
}

/// A local `resolveMedia` file. The official Zalo Cloud fallback for a dead video thumbnail saves the *video* at
/// the thumbnail path (`…_t.jpg`): it is served as video either way, and an image-flavour request is told so with
/// `X-Compola-Media-Kind: video` (Swift made a poster frame; the UI can show a `<video>` instead).
fn serve_local(path: &PathBuf, flavour: LocalFlavour, range: Option<&str>, head: bool) -> http::Response<Vec<u8>> {
    let mut start = [0u8; 12];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut start)).unwrap_or(0);
    let video = video_mime(&start[..n]);
    let mut response = with_cache_control(from_file(path, range, head), LOCAL_CACHE_CONTROL);
    if let Some(mime) = video {
        if response.status().is_success() {
            response.headers_mut().insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static(mime));
            if flavour == LocalFlavour::Image {
                response.headers_mut().insert("X-Compola-Media-Kind", http::HeaderValue::from_static("video"));
            }
        }
    }
    response
}

fn serve_asset(data: Option<Vec<u8>>, path: &str, range: Option<&str>, head: bool) -> http::Response<Vec<u8>> {
    let Some(bytes) = data else { return plain(404, "no such asset", None) };
    let media = Media { content_type: crate::host::protocol::mime_for(path), bytes };
    with_cache_control(from_memory(&media, range, head), ASSET_CACHE_CONTROL)
}

async fn serve(loader: &Arc<MediaLoader>, request: MediaRequest, range: Option<String>, head: bool) -> http::Response<Vec<u8>> {
    match request.flavour {
        Flavour::Image => match loader.data(&request.url, request.retry).await {
            Ok(media) => tokio::task::spawn_blocking(move || from_memory(&media, range.as_deref(), head))
                .await
                .unwrap_or_else(|e| failure(&MediaError::Io(e.to_string()))),
            Err(e) => failure(&e),
        },
        Flavour::Cors => match loader.start_file(&request.url) {
            Ok(FileStart::Ready(path)) => file_response(path, range, head).await,
            Ok(FileStart::Active(download)) => serve_in_flight(download, range, head).await,
            Err(e) => failure(&e),
        },
    }
}

async fn file_response(path: PathBuf, range: Option<String>, head: bool) -> http::Response<Vec<u8>> {
    tokio::task::spawn_blocking(move || from_file(&path, range.as_deref(), head))
        .await
        .unwrap_or_else(|e| failure(&MediaError::Io(e.to_string())))
}

async fn when_finished(download: &ActiveDownload, range: Option<String>, head: bool) -> http::Response<Vec<u8>> {
    match download.finished().await {
        Ok(path) => file_response(path, range, head).await,
        Err(e) => failure(&e),
    }
}

/// `bytes=N-` (single, open-ended).
fn is_open_ended(range: Option<&str>) -> bool {
    range
        .map(str::trim)
        .and_then(|r| r.strip_prefix("bytes="))
        .map(str::trim)
        .is_some_and(|spec| !spec.contains(',') && !spec.starts_with('-') && spec.ends_with('-'))
}

/// Serves a `Range` request from a download that is still running, as soon as the bytes are on disk: an
/// open-ended range gets what has arrived (up to `MAX_OPEN_RANGE`), an explicit one waits for its last byte. A
/// request without a range, or a body of unknown length, waits for the whole file.
async fn serve_in_flight(download: Arc<ActiveDownload>, range: Option<String>, head: bool) -> http::Response<Vec<u8>> {
    if range.is_none() {
        return when_finished(&download, range, head).await;
    }
    let first = download.wait(|s| s.part.is_some() && s.total.is_some()).await;
    let Some(total) = first.total.filter(|_| first.finished.is_none()) else {
        return when_finished(&download, range, head).await;
    };
    let (start, end) = match parse_range(range.as_deref(), total) {
        RangeOutcome::Partial(s, e) => (s, e),
        RangeOutcome::Unsatisfiable => return ranged("application/octet-stream", total, range.as_deref(), head, |_, _| Ok(Vec::new())),
        RangeOutcome::Full => return when_finished(&download, range, head).await,
    };
    let open = is_open_ended(range.as_deref());
    let need = if open { start + 1 } else { end + 1 };
    let now = download.wait(|s| s.total == Some(total) && s.received >= need).await;
    let Some(part) = now.part.clone().filter(|_| now.finished.is_none() && now.total == Some(total) && now.received >= need) else {
        return when_finished(&download, range, head).await;
    };
    let end = if open { end.min(now.received - 1) } else { end };
    let slice = format!("bytes={start}-{end}");
    let served = tokio::task::spawn_blocking(move || {
        let content_type = super::cache::file_content_type(&part);
        let mut file = std::fs::File::open(&part).ok()?;
        let mut body = vec![0u8; (end - start + 1) as usize];
        if !head {
            file.seek(SeekFrom::Start(start)).ok()?;
            file.read_exact(&mut body).ok()?;
        }
        Some(ranged(&content_type, total, Some(&slice), head, |_, _| Ok(body)))
    })
    .await
    .ok()
    .flatten();
    match served {
        Some(response) => response,
        // The part file was just renamed into place (or replaced by a new attempt): serve from the result.
        None => when_finished(&download, range, head).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn uri(s: &str) -> http::Uri {
        s.parse().unwrap()
    }

    fn remote(r: Request) -> MediaRequest {
        match r {
            Request::Remote(m) => m,
            other => panic!("{other:?}"),
        }
    }

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("compola-local-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("ZaloData/ZaloDownloads")).unwrap();
        dir
    }

    fn enc(s: &str) -> String {
        url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
    }

    #[test]
    fn local_files_only_under_the_roots() {
        let root = temp_root();
        let roots = vec![root.join("ZaloData")];
        let photo = root.join("ZaloData/ZaloDownloads/a.jpg");
        std::fs::write(&photo, b"\xff\xd8\xff").unwrap();
        let ok = parse_request_with_roots(&uri(&format!("compola-media://load?file={}&flavour=video", enc(photo.to_str().unwrap()))), &roots).unwrap();
        assert_eq!(ok, Request::Local(std::fs::canonicalize(&photo).unwrap(), LocalFlavour::Video));
        let default = parse_request_with_roots(&uri(&format!("compola-media://load?file={}", enc(photo.to_str().unwrap()))), &roots).unwrap();
        assert!(matches!(default, Request::Local(_, LocalFlavour::Image)));
        let status = |path: &str| parse_request_with_roots(&uri(&format!("compola-media://load?file={}", enc(path))), &roots).unwrap_err().0;
        assert_eq!(status("/etc/hosts"), 403);
        assert_eq!(status("relative/a.jpg"), 400);
        assert_eq!(status(&format!("{}/ZaloData/ZaloDownloads/../../../../../../etc/hosts", root.display())), 403);
        assert_eq!(status(&format!("{}/ZaloData/ZaloDownloads/missing.jpg", root.display())), 404);
        assert_eq!(status(&format!("{}/ZaloData/ZaloDownloads", root.display())), 403); // a directory
        assert_eq!(status("/nonexistent-compola/x.jpg"), 403);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", root.join("ZaloData/escape")).unwrap();
            assert_eq!(status(&format!("{}/ZaloData/escape", root.display())), 403);
        }
        let bad_flavour = parse_request_with_roots(&uri(&format!("compola-media://load?file={}&flavour=cors", enc(photo.to_str().unwrap()))), &roots);
        assert_eq!(bad_flavour.unwrap_err().0, 400);
        let both = parse_request_with_roots(&uri(&format!("compola-media://load?file={}&asset=pc-dist/a.png", enc(photo.to_str().unwrap()))), &roots);
        assert_eq!(both.unwrap_err().0, 400);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn asset_paths() {
        assert!(valid_asset_path("pc-dist/assets/reaction/heart.png"));
        assert!(valid_asset_path("pc-dist/emoji@2x.png"));
        for bad in ["pc-dist/", "pc-dist//a.png", "pc-dist/../app/main.js", "pc-dist/a/./b.png", "/pc-dist/a.png", "main-dist/main.js",
                    "pc-dist\\..\\x", "pc-dist/a\u{0}.png", "pc-distx/a.png"] {
            assert!(!valid_asset_path(bad), "{bad}");
        }
        assert_eq!(parse_request(&uri("compola-media://load?asset=pc-dist%2Fassets%2Fr.png")).unwrap(), Request::Asset("pc-dist/assets/r.png".into()));
        assert_eq!(parse_request(&uri("compola-media://load?asset=main-dist%2Fmain.js")).unwrap_err().0, 403);
        assert_eq!(parse_request(&uri("compola-media://load?asset=pc-dist%2F..%2Fpackage.json")).unwrap_err().0, 403);
    }

    #[test]
    fn assets_are_served_with_long_caching() {
        let r = serve_asset(Some(b"\x89PNG....".to_vec()), "pc-dist/r/heart.png", None, false);
        assert_eq!(r.status().as_u16(), 200);
        assert_eq!(r.headers()["content-type"], "image/png");
        assert_eq!(r.headers()["cache-control"], ASSET_CACHE_CONTROL);
        let part = serve_asset(Some(vec![1, 2, 3, 4]), "pc-dist/sprite.webp", Some("bytes=1-2"), false);
        assert_eq!((part.status().as_u16(), part.body().as_slice()), (206, &[2u8, 3][..]));
        assert_eq!(serve_asset(None, "pc-dist/missing.png", None, false).status().as_u16(), 404);
    }

    #[test]
    fn local_videos_saved_as_thumbnails_are_served_as_video() {
        let root = temp_root();
        let mp4 = root.join("ZaloData/ZaloDownloads/a_t.jpg");
        let mut bytes = vec![0, 0, 0, 0x1c];
        bytes.extend_from_slice(b"ftypmp42");
        bytes.resize(64, 0);
        std::fs::write(&mp4, &bytes).unwrap();
        let r = serve_local(&mp4, LocalFlavour::Image, None, false);
        assert_eq!(r.headers()["content-type"], "video/mp4");
        assert_eq!(r.headers()["x-compola-media-kind"], "video");
        assert_eq!(r.headers()["cache-control"], LOCAL_CACHE_CONTROL);
        let r = serve_local(&mp4, LocalFlavour::Video, Some("bytes=60-"), false);
        assert_eq!((r.status().as_u16(), r.headers()["content-range"].to_str().unwrap()), (206, "bytes 60-63/64"));
        assert!(r.headers().get("x-compola-media-kind").is_none());
        let jpeg = root.join("ZaloData/ZaloDownloads/b.jpg");
        std::fs::write(&jpeg, [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F', 0, 1]).unwrap();
        let r = serve_local(&jpeg, LocalFlavour::Image, None, false);
        assert_eq!(r.headers()["content-type"], "image/jpeg");
        assert!(r.headers().get("x-compola-media-kind").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn video_brands() {
        let head = |brand: &[u8]| {
            let mut h = vec![0, 0, 0, 0x18];
            h.extend_from_slice(b"ftyp");
            h.extend_from_slice(brand);
            h
        };
        assert_eq!(video_mime(&head(b"isom")), Some("video/mp4"));
        assert_eq!(video_mime(&head(b"qt  ")), Some("video/quicktime"));
        assert_eq!(video_mime(&head(b"3gp4")), Some("video/3gpp"));
        assert_eq!(video_mime(&head(b"M4A ")), None);
        assert_eq!(video_mime(&head(b"heic")), None);
        assert_eq!(video_mime(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn parses_the_scheme_url() {
        let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        let original = "https://s120-ava-talk.zadn.vn/a/b.jpg?x=1&y=2";
        let r = parse_request(&uri(&format!("compola-media://load?url={}&flavour=cors&retry=1", enc(original)))).map(remote).unwrap();
        assert_eq!(r, MediaRequest { url: url::Url::parse(original).unwrap(), flavour: Flavour::Cors, retry: true });
        // Windows form, default flavour, http upgraded.
        let r = parse_request(&uri(&format!("http://compola-media.localhost/load?url={}", enc("http://res-zalo.zadn.vn/x.json")))).map(remote).unwrap();
        assert_eq!((r.url.as_str(), r.flavour, r.retry), ("https://res-zalo.zadn.vn/x.json", Flavour::Image, false));
        // encodeURIComponent output (%2F, %3A, %3F, %26, %3D).
        let r = parse_request(&uri("compola-media://load?url=https%3A%2F%2Ff6-zpc.zdn.vn%2Fa.jpg%3Fk%3Dv%26z%3D1&flavour=image")).map(remote).unwrap();
        assert_eq!(r.url.as_str(), "https://f6-zpc.zdn.vn/a.jpg?k=v&z=1");
    }

    #[test]
    fn rejects_bad_and_foreign_requests() {
        assert_eq!(parse_request(&uri("compola-media://load")).unwrap_err().0, 400);
        assert_eq!(parse_request(&uri("compola-media://load?flavour=image")).unwrap_err().0, 400);
        assert_eq!(parse_request(&uri("compola-media://load?url=https%3A%2F%2Fa.zdn.vn%2Fx&flavour=video")).unwrap_err().0, 400);
        assert_eq!(parse_request(&uri("compola-media://load?url=ftp%3A%2F%2Fa.zdn.vn%2Fx")).unwrap_err().0, 400);
        assert_eq!(parse_request(&uri("compola-media://load?url=https%3A%2F%2Fevil.example%2Fx.jpg")).unwrap_err().0, 403);
        assert_eq!(parse_request(&uri("compola-media://load?url=https%3A%2F%2Fzadn.vn.evil.com%2Fx.jpg")).unwrap_err().0, 403);
        assert_eq!(parse_request(&uri("compola-media://load?url=file%3A%2F%2F%2Fetc%2Fhosts")).unwrap_err().0, 403);
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), RangeOutcome::Full);
        assert_eq!(parse_range(Some("bytes=0-9"), 100), RangeOutcome::Partial(0, 9));
        assert_eq!(parse_range(Some("bytes=90-200"), 100), RangeOutcome::Partial(90, 99));
        assert_eq!(parse_range(Some("bytes=10-"), 100), RangeOutcome::Partial(10, 99));
        assert_eq!(parse_range(Some("bytes=0-"), 100 << 20), RangeOutcome::Partial(0, MAX_OPEN_RANGE - 1)); // capped
        assert_eq!(parse_range(Some("bytes=-10"), 100), RangeOutcome::Partial(90, 99));
        assert_eq!(parse_range(Some("bytes=-500"), 100), RangeOutcome::Partial(0, 99));
        assert_eq!(parse_range(Some("bytes=0-1"), 100), RangeOutcome::Partial(0, 1)); // WebKit's probe
        assert_eq!(parse_range(Some("bytes=100-"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-0"), 0), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5-2"), 100), RangeOutcome::Full);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), RangeOutcome::Full);
        assert_eq!(parse_range(Some("items=0-1"), 100), RangeOutcome::Full);
        assert_eq!(parse_range(Some("bytes=a-b"), 100), RangeOutcome::Full);
        assert_eq!(parse_range(Some("bytes=+1-2"), 100), RangeOutcome::Full);
    }

    #[test]
    fn responses_carry_type_length_and_ranges() {
        let media = Media { content_type: "video/mp4".into(), bytes: (0u8..100).collect() };
        let full = from_memory(&media, None, false);
        assert_eq!(full.status(), 200);
        assert_eq!(full.headers()["content-type"], "video/mp4");
        assert_eq!(full.headers()["content-length"], "100");
        assert_eq!(full.headers()["accept-ranges"], "bytes");
        assert_eq!(full.body().len(), 100);
        let part = from_memory(&media, Some("bytes=10-19"), false);
        assert_eq!(part.status(), 206);
        assert_eq!(part.headers()["content-range"], "bytes 10-19/100");
        assert_eq!(part.body(), &(10u8..20).collect::<Vec<_>>());
        let head = from_memory(&media, Some("bytes=10-19"), true);
        assert_eq!((head.status().as_u16(), head.headers()["content-length"].to_str().unwrap(), head.body().len()), (206, "10", 0));
        assert_eq!(from_memory(&media, Some("bytes=500-"), false).status(), 416);
        let empty = from_memory(&Media { content_type: "image/png".into(), bytes: vec![] }, None, false);
        assert_eq!((empty.status().as_u16(), empty.headers()["content-length"].to_str().unwrap()), (200, "0"));
    }

    #[test]
    fn file_ranges_read_from_disk() {
        let dir = std::env::temp_dir().join(format!("compola-proto-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip.mp4");
        let mut bytes = vec![0, 0, 0, 0x18];
        bytes.extend_from_slice(b"ftypisom");
        bytes.resize(1000, 7);
        std::fs::write(&path, &bytes).unwrap();
        let r = from_file(&path, Some("bytes=990-"), false);
        assert_eq!(r.status(), 206);
        assert_eq!(r.headers()["content-type"], "video/mp4");
        assert_eq!(r.headers()["content-range"], "bytes 990-999/1000");
        assert_eq!(r.body(), &bytes[990..]);
        assert_eq!(from_file(&dir.join("missing"), None, false).status(), 502);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ranges_are_served_while_the_download_runs() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("compola-inflight-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join(".a.part");
        let content: Vec<u8> = (0..100u8).collect();
        let mut file = std::fs::File::create(&part).unwrap();
        let download = Arc::new(ActiveDownload::default());
        download.begin(part.clone(), Some(100), Some("video/mp4".into()));
        super::super::cache::set_file_content_type(&part, Some("video/mp4"));
        file.write_all(&content[..20]).unwrap();
        download.progress(20);

        // Open-ended: answered at once with what has arrived.
        let r = serve_in_flight(download.clone(), Some("bytes=0-".into()), false).await;
        assert_eq!(r.status().as_u16(), 206);
        assert_eq!(r.headers()["content-range"], "bytes 0-19/100");
        assert_eq!(r.body(), &content[..20]);

        // Explicit range beyond what arrived, and a plain GET: both wait.
        let explicit = tokio::spawn(serve_in_flight(download.clone(), Some("bytes=50-59".into()), false));
        let open_later = tokio::spawn(serve_in_flight(download.clone(), Some("bytes=70-".into()), false));
        let whole = tokio::spawn(serve_in_flight(download.clone(), None, false));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!explicit.is_finished() && !open_later.is_finished() && !whole.is_finished());
        file.write_all(&content[20..80]).unwrap();
        download.progress(80);
        let r = explicit.await.unwrap();
        assert_eq!((r.status().as_u16(), r.body().as_slice()), (206, &content[50..60]));
        let r = open_later.await.unwrap();
        assert_eq!(r.headers()["content-range"], "bytes 70-79/100");
        assert!(!whole.is_finished());

        // Past the end: 416 without waiting.
        assert_eq!(serve_in_flight(download.clone(), Some("bytes=100-".into()), false).await.status().as_u16(), 416);

        // Completion: the part is published, waiting readers get the file.
        file.write_all(&content[80..]).unwrap();
        drop(file);
        let final_path = dir.join("a.mp4");
        std::fs::rename(&part, &final_path).unwrap();
        download.finish(Ok(final_path));
        let r = whole.await.unwrap();
        assert_eq!((r.status().as_u16(), r.body().as_slice()), (200, content.as_slice()));
        assert_eq!(r.headers()["content-type"], "video/mp4");
        // After the rename a late range reader is served from the file.
        let r = serve_in_flight(download.clone(), Some("bytes=90-".into()), false).await;
        assert_eq!(r.body(), &content[90..]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn failed_downloads_and_unknown_lengths() {
        let download = Arc::new(ActiveDownload::default());
        download.begin(PathBuf::from("/nonexistent/.x.part"), None, None); // no Content-Length
        let waiting = tokio::spawn(serve_in_flight(download.clone(), Some("bytes=0-".into()), false));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiting.is_finished());
        download.finish(Err(MediaError::Http(404)));
        assert_eq!(waiting.await.unwrap().status().as_u16(), 404);
    }

    #[test]
    fn open_ended_ranges() {
        assert!(is_open_ended(Some("bytes=0-")));
        assert!(is_open_ended(Some(" bytes=100- ")));
        assert!(!is_open_ended(Some("bytes=0-10")));
        assert!(!is_open_ended(Some("bytes=-10")));
        assert!(!is_open_ended(Some("bytes=0-,5-")));
        assert!(!is_open_ended(None));
    }

    #[test]
    fn error_statuses() {
        assert_eq!(error_status(&MediaError::Http(404)), 404);
        assert_eq!(error_status(&MediaError::Http(302)), 502);
        assert_eq!(error_status(&MediaError::HostNotFound), 404);
        assert_eq!(error_status(&MediaError::TooLarge), 413);
        assert_eq!(error_status(&MediaError::TimedOut), 504);
        assert_eq!(error_status(&MediaError::Net(NetFailure::Timeout, String::new())), 504);
        assert_eq!(error_status(&MediaError::Net(NetFailure::Dns, String::new())), 502);
        assert_eq!(error_status(&MediaError::Forbidden), 403);
        let r = failure(&MediaError::Http(404));
        assert_eq!((r.status().as_u16(), r.headers()["x-compola-error"].to_str().unwrap()), (404, "http-404"));
    }
}
