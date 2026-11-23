//! On-disk media caches under `app_support()/MediaCache` (Swift: `Caches/Compola/media` URLCache + `Caches/Compola/files`).
//!
//! * `media/<fnv64(url)>` — image-flavour bodies with their Content-Type (a one-line header before the bytes),
//!   400 MB, least recently used evicted first.
//! * `files/<fnv64(url)>.<ext>` — cors-flavour downloads (video, voice, documents), 2 GB LRU, written as
//!   `.<uuid>.part` and renamed into place only when complete; stale `.part` files (> 10 min) are removed.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const MEDIA_CACHE_LIMIT: u64 = 400 << 20;
pub const FILES_CACHE_LIMIT: u64 = 2 << 30;
/// `.part` files untouched for this long are leftovers from a crash / force-quit.
pub const STALE_PART_AGE: Duration = Duration::from_secs(600);
/// Magic of a `media/` entry: `OLZM1\n<content-type>\n<body>`.
const MEDIA_MAGIC: &[u8] = b"OLZM1\n";
const CONTENT_TYPE_XATTR: &str = "org.compola.content-type";

/// FNV-1a 64-bit, lower-case hex without padding (Swift `MediaLoader.stableHash`, stable across launches).
pub fn stable_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() {
        hash = (hash ^ byte as u64).wrapping_mul(0x100000001b3);
    }
    format!("{hash:x}")
}

/// Key of a normalized URL in both caches (and the failure backoff).
pub fn cache_key(url: &url::Url) -> String {
    stable_hash(url.as_str())
}

/// Swift `localFile` naming: `<hash>.<ext>` with the URL path's extension (alphanumerics only, at most 8).
pub fn file_name(url: &url::Url) -> String {
    let last = url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("");
    let ext: String = match last.rfind('.') {
        Some(i) if i + 1 < last.len() => last[i + 1..].chars().filter(|c| c.is_alphanumeric()).take(8).collect(),
        _ => String::new(),
    };
    let hash = cache_key(url);
    if ext.is_empty() { hash } else { format!("{hash}.{ext}") }
}

/// A Content-Type safe to store and hand back (printable ASCII, bounded), else None.
pub fn clean_content_type(value: Option<&str>) -> Option<String> {
    let v = value?.trim();
    (!v.is_empty() && v.len() <= 200 && v.bytes().all(|b| (0x20..0x7f).contains(&b))).then(|| v.to_owned())
}

pub struct DiskCache {
    pub media_dir: PathBuf,
    pub files_dir: PathBuf,
    pub media_limit: u64,
    pub files_limit: u64,
}

impl DiskCache {
    pub fn new(root: &Path) -> Self {
        Self { media_dir: root.join("media"), files_dir: root.join("files"), media_limit: MEDIA_CACHE_LIMIT, files_limit: FILES_CACHE_LIMIT }
    }

    fn media_path(&self, url: &url::Url) -> PathBuf {
        self.media_dir.join(cache_key(url))
    }

    pub fn file_path(&self, url: &url::Url) -> PathBuf {
        self.files_dir.join(file_name(url))
    }

    /// Cached (content type, body) of an image-flavour load; marks the entry used.
    pub fn read_media(&self, url: &url::Url) -> Option<(String, Vec<u8>)> {
        let path = self.media_path(url);
        let data = std::fs::read(&path).ok()?;
        let parsed = decode_media_entry(&data);
        if parsed.is_none() {
            let _ = std::fs::remove_file(&path);
        }
        let (content_type, start) = parsed?;
        touch(&path);
        Some((content_type, data[start..].to_vec()))
    }

    /// Stores a complete body (atomically: written beside, then renamed).
    pub fn write_media(&self, url: &url::Url, content_type: &str, body: &[u8]) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.media_dir)?;
        let content_type = clean_content_type(Some(content_type)).unwrap_or_else(|| "application/octet-stream".into());
        let mut data = Vec::with_capacity(MEDIA_MAGIC.len() + content_type.len() + 1 + body.len());
        data.extend_from_slice(MEDIA_MAGIC);
        data.extend_from_slice(content_type.as_bytes());
        data.push(b'\n');
        data.extend_from_slice(body);
        let temp = super::http::part_file(&self.media_dir);
        let result = std::fs::write(&temp, &data).and_then(|_| std::fs::rename(&temp, self.media_path(url)));
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    }

    pub fn trim_all(&self, keep: Option<&Path>) {
        trim_files(&self.media_dir, self.media_limit, keep, STALE_PART_AGE, SystemTime::now());
        trim_files(&self.files_dir, self.files_limit, keep, STALE_PART_AGE, SystemTime::now());
    }
}

/// (content type, body offset) of a `media/` entry.
fn decode_media_entry(data: &[u8]) -> Option<(String, usize)> {
    let rest = data.strip_prefix(MEDIA_MAGIC)?;
    let newline = rest.iter().take(256).position(|b| *b == b'\n')?;
    let content_type = std::str::from_utf8(&rest[..newline]).ok()?.to_owned();
    Some((content_type, MEDIA_MAGIC.len() + newline + 1))
}

/// Marks a cache entry as just used (LRU by modification time, like Swift's `localFile`).
pub fn touch(path: &Path) {
    if let Ok(file) = std::fs::File::options().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// Swift `trimFiles(in:limit:keeping:partAge:now:)`: deletes `.part` files older than `part_age` (never one an
/// active download is still writing) and evicts least-recently-used completed files (by the later of modification
/// and access time) until the total is within `limit`. `keep` is never evicted; other dot-files are ignored.
pub fn trim_files(directory: &Path, limit: u64, keep: Option<&Path>, part_age: Duration, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(directory) else { return };
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let path = entry.path();
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            if name.ends_with(".part") && now.duration_since(modified).is_ok_and(|age| age > part_age) {
                let _ = std::fs::remove_file(&path);
            }
            continue;
        }
        let used = modified.max(meta.accessed().unwrap_or(SystemTime::UNIX_EPOCH));
        files.push((path, meta.len(), used));
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= limit {
        return;
    }
    files.sort_by_key(|f| f.2);
    for (path, size, _) in files {
        if total <= limit {
            break;
        }
        if keep.is_some_and(|k| k == path) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

// ---- extended attributes (macOS) ----

#[cfg(target_os = "macos")]
fn set_xattr(path: &Path, name: &str, value: &[u8]) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let (Ok(p), Ok(n)) = (std::ffi::CString::new(path.as_os_str().as_bytes()), std::ffi::CString::new(name)) else { return false };
    unsafe { libc::setxattr(p.as_ptr(), n.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) == 0 }
}

#[cfg(target_os = "macos")]
fn get_xattr(path: &Path, name: &str) -> Option<Vec<u8>> {
    use std::os::unix::ffi::OsStrExt;
    let p = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let n = std::ffi::CString::new(name).ok()?;
    let mut buf = vec![0u8; 512];
    let len = unsafe { libc::getxattr(p.as_ptr(), n.as_ptr(), buf.as_mut_ptr().cast(), buf.len(), 0, 0) };
    (len >= 0).then(|| {
        buf.truncate(len as usize);
        buf
    })
}

#[cfg(not(target_os = "macos"))]
fn set_xattr(_: &Path, _: &str, _: &[u8]) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
fn get_xattr(_: &Path, _: &str) -> Option<Vec<u8>> {
    None
}

/// Swift `applyQuarantine(to:origin:)`: `com.apple.quarantine` so Gatekeeper vets the file when it is opened.
pub fn apply_quarantine(path: &Path, _origin: &url::Url) -> bool {
    let secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    set_xattr(path, "com.apple.quarantine", format!("0081;{secs:08x};Compola;").as_bytes())
}

#[cfg(test)]
pub fn has_quarantine(path: &Path) -> bool {
    get_xattr(path, "com.apple.quarantine").is_some_and(|v| v.windows(4).any(|w| w == b"Compola"))
}

/// Remembers the server's Content-Type on a downloaded file (survives the rename into place).
pub fn set_file_content_type(path: &Path, content_type: Option<&str>) {
    if let Some(ct) = clean_content_type(content_type) {
        set_xattr(path, CONTENT_TYPE_XATTR, ct.as_bytes());
    }
}

/// Content-Type to serve a cached file with: the stored server value unless it is generic, then the bytes'
/// signature, then the extension.
pub fn file_content_type(path: &Path) -> String {
    let stored = get_xattr(path, CONTENT_TYPE_XATTR).and_then(|v| String::from_utf8(v).ok()).and_then(|v| clean_content_type(Some(&v)));
    if let Some(ct) = &stored {
        if !is_generic(ct) {
            return ct.clone();
        }
    }
    let mut head = [0u8; 64];
    let n = std::fs::File::open(path).and_then(|mut f| std::io::Read::read(&mut f, &mut head)).unwrap_or(0);
    if let Some(ct) = sniff(&head[..n]) {
        return ct.to_owned();
    }
    if let Some(guess) = mime_guess::from_path(path).first() {
        return guess.essence_str().to_owned();
    }
    stored.unwrap_or_else(|| "application/octet-stream".into())
}

fn is_generic(content_type: &str) -> bool {
    let essence = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    matches!(essence.as_str(), "application/octet-stream" | "binary/octet-stream" | "application/binary" | "application/unknown")
}

/// Content-Type of a body served from memory: the server value unless generic, then the signature.
pub fn body_content_type(stored: &str, body: &[u8]) -> String {
    if !is_generic(stored) && clean_content_type(Some(stored)).is_some() {
        return stored.to_owned();
    }
    sniff(body).map(str::to_owned).unwrap_or_else(|| stored.to_owned())
}

/// Media type from a body's leading bytes (the formats Zalo serves).
pub fn sniff(head: &[u8]) -> Option<&'static str> {
    let starts = |sig: &[u8]| head.starts_with(sig);
    if starts(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if starts(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if starts(b"GIF87a") || starts(b"GIF89a") {
        return Some("image/gif");
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" {
        match &head[8..12] {
            b"WEBP" => return Some("image/webp"),
            b"WAVE" => return Some("audio/wav"),
            _ => {}
        }
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        let brand = &head[8..12];
        return Some(match brand {
            b"M4A " | b"M4B " => "audio/mp4",
            b"heic" | b"heix" | b"mif1" | b"msf1" => "image/heic",
            b"avif" => "image/avif",
            b"qt  " => "video/quicktime",
            _ => "video/mp4",
        });
    }
    if starts(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some("video/webm");
    }
    if starts(b"OggS") {
        return Some("audio/ogg");
    }
    if starts(b"#!AMR") {
        return Some("audio/amr");
    }
    if starts(b"ID3") || (head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE6) == 0xE2) {
        return Some("audio/mpeg");
    }
    if head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xF6) == 0xF0 {
        return Some("audio/aac");
    }
    if starts(b"%PDF-") {
        return Some("application/pdf");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::FileTimes;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("compola-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Writes `size` bytes with access and modification time `age` seconds ago.
    fn make(dir: &Path, name: &str, size: usize, age: u64) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, vec![0u8; size]).unwrap();
        let t = SystemTime::now() - Duration::from_secs(age);
        std::fs::File::options().write(true).open(&path).unwrap().set_times(FileTimes::new().set_accessed(t).set_modified(t)).unwrap();
        path
    }

    #[test]
    fn stable_hash_is_fnv1a() {
        assert_eq!(stable_hash(""), "cbf29ce484222325");
        assert_eq!(stable_hash("a"), "af63dc4c8601ec8c");
        assert_eq!(stable_hash("a"), stable_hash("a"));
        assert_ne!(stable_hash("a"), stable_hash("b"));
    }

    #[test]
    fn file_names_keep_a_short_clean_extension() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        let video = u("https://video-sgp1-1.z-cdn.me/a/b/clip.mp4?x=1");
        assert_eq!(file_name(&video), format!("{}.mp4", cache_key(&video)));
        assert!(!file_name(&u("https://f6-zpc.zdn.vn/a/noext")).contains('.'));
        assert!(file_name(&u("https://f6-zpc.zdn.vn/a/x.verylongextension")).ends_with(".verylong"));
        assert!(file_name(&u("https://f6-zpc.zdn.vn/a/x.m%2F4a")).ends_with(".m2F4a"));
        assert!(!file_name(&u("https://f6-zpc.zdn.vn/")).contains('.'));
        // Different query → different entry.
        assert_ne!(cache_key(&u("https://a.zdn.vn/x.jpg?v=1")), cache_key(&u("https://a.zdn.vn/x.jpg?v=2")));
    }

    #[test]
    fn media_entries_round_trip() {
        let dir = temp_dir();
        let cache = DiskCache::new(&dir);
        let url = url::Url::parse("https://s120-ava-talk.zadn.vn/a.jpg").unwrap();
        assert!(cache.read_media(&url).is_none());
        cache.write_media(&url, "image/jpeg", b"\xff\xd8\xffbody").unwrap();
        assert_eq!(cache.read_media(&url), Some(("image/jpeg".into(), b"\xff\xd8\xffbody".to_vec())));
        cache.write_media(&url, "bad\nvalue", b"x").unwrap();
        assert_eq!(cache.read_media(&url).unwrap().0, "application/octet-stream");
        // A corrupt entry is dropped.
        std::fs::write(cache.media_dir.join(cache_key(&url)), b"garbage").unwrap();
        assert!(cache.read_media(&url).is_none());
        assert!(!cache.media_dir.join(cache_key(&url)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removes_stale_parts_keeps_fresh_ones() {
        let dir = temp_dir();
        let stale = make(&dir, ".a.part", 10, 3600);
        let fresh = make(&dir, ".b.part", 10, 5);
        let done = make(&dir, "c.pdf", 10, 3600);
        trim_files(&dir, 1_000_000, None, STALE_PART_AGE, SystemTime::now());
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(done.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn evicts_least_recently_used_first_and_spares_kept() {
        let dir = temp_dir();
        let oldest = make(&dir, "old.bin", 100, 3000);
        let middle = make(&dir, "mid.bin", 100, 2000);
        let newest = make(&dir, "new.bin", 100, 1000);
        let part = make(&dir, ".x.part", 100, 1); // not counted, never evicted by size
        trim_files(&dir, 250, Some(&oldest), STALE_PART_AGE, SystemTime::now()); // 300 > 250: oldest kept, so mid goes
        assert!(oldest.exists());
        assert!(!middle.exists());
        assert!(newest.exists());
        assert!(part.exists());
        trim_files(&dir, 150, None, STALE_PART_AGE, SystemTime::now()); // 200 > 150: now oldest is evicted
        assert!(!oldest.exists());
        assert!(newest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn touch_moves_an_entry_to_most_recently_used() {
        let dir = temp_dir();
        let a = make(&dir, "a.bin", 100, 3000);
        let b = make(&dir, "b.bin", 100, 2000);
        touch(&a);
        trim_files(&dir, 150, None, STALE_PART_AGE, SystemTime::now());
        assert!(a.exists());
        assert!(!b.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn quarantine_and_content_type_attributes() {
        let dir = temp_dir();
        let file = make(&dir, "q.bin", 4, 0);
        assert!(apply_quarantine(&file, &url::Url::parse("https://res-zalo.zadn.vn/x.bin").unwrap()));
        assert!(has_quarantine(&file));
        assert_eq!(file_content_type(&file), "application/octet-stream");
        set_file_content_type(&file, Some("audio/aac"));
        let renamed = dir.join("moved");
        std::fs::rename(&file, &renamed).unwrap();
        assert_eq!(file_content_type(&renamed), "audio/aac");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_types_from_signature_and_extension() {
        let dir = temp_dir();
        let mp4 = dir.join("a_t.jpg");
        let mut bytes = vec![0, 0, 0, 0x1c];
        bytes.extend_from_slice(b"ftypmp42");
        bytes.extend_from_slice(&[0, 0, 0, 1]);
        std::fs::write(&mp4, &bytes).unwrap();
        assert_eq!(file_content_type(&mp4), "video/mp4"); // a video saved under a thumbnail name
        set_file_content_type(&mp4, Some("application/octet-stream")); // generic server value: still sniffed
        assert_eq!(file_content_type(&mp4), "video/mp4");
        let pdf = dir.join("doc.pdf");
        std::fs::write(&pdf, b"not really").unwrap();
        assert_eq!(file_content_type(&pdf), "application/pdf");
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"GIF89a"), Some("image/gif"));
        assert_eq!(sniff(&[0xFF, 0xD8]), None);
        assert_eq!(body_content_type("application/octet-stream", b"GIF89a.."), "image/gif");
        assert_eq!(body_content_type("image/png", b"GIF89a.."), "image/png");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
