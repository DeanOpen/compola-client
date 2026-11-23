//! The `compola-media` URI scheme (asynchronous): `compola-media://load?url=<encoded>&flavour=image|cors[&retry=1]`.
//! See the module docs of `media` and `docs/media.md`.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{UriSchemeContext, UriSchemeResponder, Wry};

use super::headers::Flavour;
use super::loader::Media;
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

/// Parses the request URI. `Err((status, reason))` for a request that must not be served.
pub fn parse_request(uri: &http::Uri) -> Result<MediaRequest, (u16, &'static str)> {
    let query = uri.query().ok_or((400, "missing query"))?;
    let mut url = None;
    let mut flavour = Flavour::Image;
    let mut retry = false;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "url" => url = Some(value.into_owned()),
            "flavour" | "flavor" => flavour = Flavour::parse(&value).ok_or((400, "bad flavour"))?,
            "retry" => retry = value == "1" || value == "true",
            _ => {}
        }
    }
    let raw = url.ok_or((400, "missing url"))?;
    let parsed = url::Url::parse(&raw).map_err(|_| (400, "bad url"))?;
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
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, X-Compola-Error")
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
    let loader = MediaLoader::shared(ctx.app_handle());
    tauri::async_runtime::spawn(async move {
        let response = serve(&loader, parsed, range, head).await;
        responder.respond(response);
    });
}

async fn serve(loader: &Arc<MediaLoader>, request: MediaRequest, range: Option<String>, head: bool) -> http::Response<Vec<u8>> {
    match request.flavour {
        Flavour::Image => match loader.data(&request.url, request.retry).await {
            Ok(media) => tokio::task::spawn_blocking(move || from_memory(&media, range.as_deref(), head))
                .await
                .unwrap_or_else(|e| failure(&MediaError::Io(e.to_string()))),
            Err(e) => failure(&e),
        },
        Flavour::Cors => match loader.local_file(&request.url).await {
            Ok(path) => tokio::task::spawn_blocking(move || from_file(&path, range.as_deref(), head))
                .await
                .unwrap_or_else(|e| failure(&MediaError::Io(e.to_string()))),
            Err(e) => failure(&e),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(s: &str) -> http::Uri {
        s.parse().unwrap()
    }

    #[test]
    fn parses_the_scheme_url() {
        let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        let original = "https://s120-ava-talk.zadn.vn/a/b.jpg?x=1&y=2";
        let r = parse_request(&uri(&format!("compola-media://load?url={}&flavour=cors&retry=1", enc(original)))).unwrap();
        assert_eq!(r, MediaRequest { url: url::Url::parse(original).unwrap(), flavour: Flavour::Cors, retry: true });
        // Windows form, default flavour, http upgraded.
        let r = parse_request(&uri(&format!("http://compola-media.localhost/load?url={}", enc("http://res-zalo.zadn.vn/x.json")))).unwrap();
        assert_eq!((r.url.as_str(), r.flavour, r.retry), ("https://res-zalo.zadn.vn/x.json", Flavour::Image, false));
        // encodeURIComponent output (%2F, %3A, %3F, %26, %3D).
        let r = parse_request(&uri("compola-media://load?url=https%3A%2F%2Ff6-zpc.zdn.vn%2Fa.jpg%3Fk%3Dv%26z%3D1&flavour=image")).unwrap();
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
