//! Main's download manager (`new-download-channel`) — port of `DownloadManager.swift`.
//!
//! The official renderer's `CloudService.downloadWithMultiSrc(...)` (photo loader, video, voice, file downloads, the
//! Zalo Cloud fallback) all end in `$zdownload.sendDownloadRequest({channel, data})` and wait for
//! `{channel: "new-download-file-resp", data}` pushed back on the same channel. Without a main-side answer every
//! official download hangs.
//!
//! Wire contract (`main-dist`: `onDone`, `DownloadErrors`):
//! - request  `new-download-file`        data = {key, downloadFrom, type, data{url, fileName, …}, options{saveDir, srcAction, maxTTFB, headers}, extraHeader, secure}
//! - request  `new-download-file-abort`  data = {key, downloadFrom}; config / quota / ping / scan / priority are acknowledged.
//! - response `new-download-file-resp`   data = {downloadError|null, savePath, downloadFrom, key, type, isCached}
//! - errors   {name, code, normalize: true}; HTTP status s → `DOWNLOAD_SERVICE_NET_s` / 75000 + s, Chromium net errors →
//!   `ERR_*` / 30000 + n.
//!
//! Bytes travel through the proxy's transport ([`crate::net::fetch`]: cookie jar, client headers, fingerprint helper),
//! are streamed to a private temp file, decrypted when `secure` asks (see [`SecureStream`]), quarantined and moved
//! into place atomically.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use aes::Aes256;
use aes::cipher::{BlockEncrypt, KeyInit, KeyIvInit, StreamCipher};
use ghash::GHash;
use ghash::universal_hash::UniversalHash;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::bridge::Registry;
use crate::host::Host;
use crate::platform::Platform;
use crate::values::{ArgsExt, undef};

pub const CHANNEL: &str = "new-download-channel";
const REQUEST_DOWNLOAD: &str = "new-download-file";
const REQUEST_ABORT: &str = "new-download-file-abort";
const RESPONSE_CHANNEL: &str = "new-download-file-resp";

/// In-memory-sized bodies (photos) are capped; anything else may be up to `MAX_FILE_BYTES`.
const PHOTO_BYTE_CAP: u64 = 64 << 20;
const MAX_FILE_BYTES: u64 = 2 << 30;
const NOT_FOUND_CAPACITY: usize = 500;
const NOT_FOUND_TTL: Duration = Duration::from_secs(600);
/// Photos: total deadline (MediaLoader.imageDeadline); files: no total deadline, only an idle timeout.
const IMAGE_DEADLINE: Duration = Duration::from_secs(25);
const FILE_HEAD_TIMEOUT: Duration = Duration::from_secs(120);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;

/// Headers that only ever go to Zalo's own hosts over https, and never follow a cross-host redirect.
const SENSITIVE_HEADERS: &[&str] = &["cloud-viewer-key", "cookie", "authorization", "proxy-authorization"];
/// Connection-level headers a caller must not set.
const FORBIDDEN_HEADERS: &[&str] = &[
    "connection", "keep-alive", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
    "expect", "accept-encoding",
];
const ZALO_HOST_SUFFIXES: &[&str] = &["zadn.vn", "zdn.vn", "zalo.me", "zaloapp.com", "zingcdn.me", "zalo.vn", "zing.vn"];

pub fn is_zalo_cdn(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ZALO_HOST_SUFFIXES.iter().any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors as main reports them
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub name: String,
    pub code: i64,
    pub message: String,
}

impl Failure {
    fn new(name: &str, code: i64) -> Self {
        Self { name: name.into(), code, message: String::new() }
    }
    pub fn json(&self) -> Value {
        let mut out = json!({ "name": self.name, "code": self.code, "normalize": true });
        if !self.message.is_empty() {
            out["message"] = json!(self.message);
        }
        out
    }
    pub fn aborted() -> Self {
        Self::new("GENERAL_MAIN_CONTROLLER_OBJ_DOWNLOAD_ABORT", 1009)
    }
    pub fn invalid_url() -> Self {
        Self::new("GENERAL_UI_OBJ_DOWNLOAD_INVALID_URL", 9)
    }
    pub fn save_dir_invalid() -> Self {
        Self::new("GENERAL_MAIN_CONTROLLER_OBJ_DOWNLOAD_SAVE_DIR_INVALID", 1012)
    }
    pub fn empty_body() -> Self {
        Self::new("DOWNLOAD_SERVICE_SINGLE_INVALID_CONTENT_LENGTH", 75000 + 5002)
    }
    pub fn ttfb_timeout() -> Self {
        Self::new("DOWNLOAD_SERVICE_SINGLE_MAX_TTFB_TIMEOUT", 75000 + 5027)
    }
    /// Main aborts with `new Error("File secure decrypt failed")`; `normalizeError` reports plain `Error`s as
    /// `INS_OF_ERROR_ERR` (14998) with the message.
    pub fn decrypt_failed() -> Self {
        Self { name: "INS_OF_ERROR_ERR".into(), code: 14998, message: "File secure decrypt failed".into() }
    }
    pub fn too_large() -> Self {
        Self::new("DOWNLOAD_SERVICE_SINGLE_FILE_SIZE_LIMIT_EXCEED", 75000 + 5026)
    }
    /// Fallback for anything unrecognised.
    pub fn unknown() -> Self {
        Self::new("DOWNLOAD_SERVICE_SINGLE_DOWNLOAD_ON_EMPTY_ERR", 75000 + 5025)
    }
    pub fn http(status: u16) -> Self {
        Self::new(&format!("DOWNLOAD_SERVICE_NET_{status}"), 75000 + status as i64)
    }
    pub fn net(name: &str, number: i64) -> Self {
        Self::new(name, 30000 + number)
    }

    fn from_fetch(e: &crate::net::FetchError) -> Self {
        use crate::net::FetchError as E;
        match e {
            E::Timeout => Self::net("ERR_CONNECTION_TIMED_OUT", 47),
            E::NameNotResolved => Self::net("ERR_NAME_NOT_RESOLVED", 34),
            E::Connect => Self::net("ERR_CONNECTION_FAILED", 33),
            E::Tls => Self::net("ERR_SSL_PROTOCOL_ERROR", 36),
            E::TooLarge => Self::too_large(),
            E::Other(detail) => {
                log::debug!("download transport error: {detail}");
                Self::net("ERR_CONNECTION_FAILED", 33)
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Outcome {
    pub save_path: Option<String>,
    pub failure: Option<Failure>,
    pub cached: bool,
}

impl Outcome {
    fn failed(f: Failure) -> Self {
        Self { failure: Some(f), ..Default::default() }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------------------------------------------------

/// Everything a transfer needs.
struct Job {
    url: url::Url,
    destination: PathBuf,
    kind: String,
    headers: Vec<(String, String)>,
    secure: Parsed,
    /// Time to first byte (0 = none).
    ttfb: Duration,
    temp_dir: PathBuf,
    user_agent: String,
}

impl Job {
    fn is_photo(&self) -> bool {
        self.kind.starts_with("Photo")
    }
}

pub struct DownloadManager {
    app: AppHandle,
    platform: Arc<Platform>,
    temp_dir: PathBuf,
    /// `downloadFrom|key` → token → cancel switch.
    tasks: Mutex<HashMap<String, HashMap<u64, watch::Sender<bool>>>>,
    /// URL → until: official "resp cache" for 404s, skipped for Manual downloads.
    not_found: Mutex<HashMap<String, Instant>>,
    next_token: AtomicU64,
}

/// The current manager (replaced when the engine boots another runtime).
#[derive(Default)]
struct Slot(Mutex<Option<Arc<DownloadManager>>>);

pub fn install(app: &AppHandle, reg: &mut Registry, platform: &Arc<Platform>) {
    let temp_dir = dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("CompolaTauri/download-tmp");
    let manager = Arc::new(DownloadManager {
        app: app.clone(),
        platform: platform.clone(),
        temp_dir: temp_dir.clone(),
        tasks: Mutex::new(HashMap::new()),
        not_found: Mutex::new(HashMap::new()),
        next_token: AtomicU64::new(1),
    });
    if app.try_state::<Slot>().is_none() {
        app.manage(Slot::default());
    }
    if let Some(old) = app.state::<Slot>().0.lock().replace(manager.clone()) {
        old.reset();
    }
    tauri::async_runtime::spawn_blocking(move || remove_stale_temps(&temp_dir, SystemTime::now()));

    reg.handle(CHANNEL, move |host, args| {
        if let Some(request) = args.obj_at(0) {
            if let Some(channel) = request.get("channel").and_then(Value::as_str) {
                let data = request.get("data").and_then(Value::as_object).cloned().unwrap_or_default();
                manager.handle(channel, data, &host);
            }
        }
        async { Ok(undef()) }
    });
}

/// Logout / account switch: nothing may keep writing, and a new account must not inherit verdicts.
/// (To be called from `MainProcess::reset_account_state`.)
#[allow(dead_code)]
pub fn reset(app: &AppHandle) {
    if let Some(slot) = app.try_state::<Slot>() {
        if let Some(m) = slot.0.lock().as_ref() {
            m.reset();
        }
    }
}

fn key_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

impl DownloadManager {
    fn handle(self: &Arc<Self>, channel: &str, data: Map<String, Value>, host: &Arc<Host>) {
        match channel {
            REQUEST_DOWNLOAD => self.start(data, host),
            REQUEST_ABORT => {
                let Some(key) = data.get("key").map(key_string) else { return };
                let from = data.get("downloadFrom").and_then(Value::as_str).unwrap_or("");
                if let Some(entries) = self.tasks.lock().get(&format!("{from}|{key}")) {
                    for tx in entries.values() {
                        let _ = tx.send(true);
                    }
                }
            }
            // concurrency / quota / resp-cache config, ping, scan, priority: nothing to schedule here
            _ => {}
        }
    }

    pub fn reset(&self) {
        for entries in self.tasks.lock().drain().map(|(_, v)| v) {
            for tx in entries.values() {
                let _ = tx.send(true);
            }
        }
        self.not_found.lock().clear();
    }

    /// Like the official `add`, a repeated key is not cancelled: each request runs (writes go through temp files and
    /// an atomic rename) and answers on its own.
    fn start(self: &Arc<Self>, request: Map<String, Value>, host: &Arc<Host>) {
        let Some(raw_key) = request.get("key").cloned() else { return };
        let key = key_string(&raw_key);
        let from = request.get("downloadFrom").and_then(Value::as_str).unwrap_or("").to_owned();
        let kind = request.get("type").and_then(Value::as_str).unwrap_or("").to_owned();
        let id = format!("{from}|{key}");
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = watch::channel(false);
        self.tasks.lock().entry(id.clone()).or_default().insert(token, tx);
        let this = self.clone();
        let weak_host = Arc::downgrade(host);
        tauri::async_runtime::spawn(async move {
            let cancelled = Arc::new(AtomicBool::new(false));
            let flag = cancelled.clone();
            let outcome = tokio::select! {
                o = this.perform(&request, flag) => o,
                _ = rx.wait_for(|c| *c) => {
                    cancelled.store(true, Ordering::SeqCst);
                    Outcome::failed(Failure::aborted())
                }
            };
            {
                let mut tasks = this.tasks.lock();
                if let Some(entries) = tasks.get_mut(&id) {
                    entries.remove(&token);
                    if entries.is_empty() {
                        tasks.remove(&id);
                    }
                }
            }
            let Some(host) = weak_host.upgrade() else { return };
            host.send(
                CHANNEL,
                vec![json!({
                    "channel": RESPONSE_CHANNEL,
                    "data": {
                        "downloadError": outcome.failure.as_ref().map(Failure::json).unwrap_or(Value::Null),
                        "savePath": outcome.save_path,
                        "downloadFrom": from,
                        "key": raw_key,
                        "type": kind,
                        "isCached": outcome.cached,
                    },
                })],
            );
        });
    }

    async fn perform(&self, request: &Map<String, Value>, cancelled: Arc<AtomicBool>) -> Outcome {
        let empty = Map::new();
        let data = request.get("data").and_then(Value::as_object).unwrap_or(&empty);
        let options = request.get("options").and_then(Value::as_object).unwrap_or(&empty);
        let kind = request.get("type").and_then(Value::as_str).unwrap_or("").to_owned();
        let Some(url_string) = data.get("url").and_then(Value::as_str) else { return Outcome::failed(Failure::invalid_url()) };
        let url = match url::Url::parse(url_string) {
            Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty()) => u,
            _ => return Outcome::failed(Failure::invalid_url()),
        };
        let Some(destination) = destination(
            options.get("saveDir").and_then(Value::as_str),
            data.get("fileName").and_then(Value::as_str),
        ) else {
            return Outcome::failed(Failure::save_dir_invalid());
        };
        let parent = destination.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        if !self.platform.is_writable(&parent) {
            return Outcome::failed(Failure::save_dir_invalid());
        }
        let manual = options.get("srcAction").and_then(Value::as_str) == Some("Manual");
        let headers = request_headers(request);
        let secure = SecureStream::parse(request.get("secure"));
        let secure_label = match secure {
            Parsed::None => "no",
            Parsed::Stream(_) => "yes",
            Parsed::Invalid => "invalid",
        };
        let mut names: Vec<&str> = headers.iter().map(|(k, _)| k.as_str()).collect();
        names.sort();
        log::info!(
            "download type={kind} host={} src={} headers={} secure={secure_label}",
            url.host_str().unwrap_or("-"),
            options.get("srcAction").and_then(Value::as_str).unwrap_or("-"),
            names.join(",")
        );

        if is_usable_file(&destination) {
            return Outcome { save_path: Some(destination.to_string_lossy().into_owned()), failure: None, cached: true };
        }
        // ciphertext must never be saved as the media
        if matches!(secure, Parsed::Invalid) {
            return Outcome::failed(Failure::decrypt_failed());
        }
        if !manual {
            let mut nf = self.not_found.lock();
            if let Some(until) = nf.get(url_string) {
                if *until > Instant::now() {
                    return Outcome::failed(Failure::http(404));
                }
                nf.remove(url_string);
            }
        }
        let ttfb = options.get("maxTTFB").and_then(Value::as_f64).filter(|t| *t > 0.0).unwrap_or(0.0);
        let job = Job {
            url,
            destination,
            kind,
            headers,
            secure,
            ttfb: Duration::from_secs_f64(ttfb / 1000.0),
            temp_dir: self.temp_dir.clone(),
            user_agent: self.platform.user_agent(),
        };
        let outcome = execute(&self.app, job, cancelled).await;
        if outcome.failure.as_ref().is_some_and(|f| f.code == 75404) {
            self.remember_not_found(url_string);
        }
        outcome
    }

    fn remember_not_found(&self, url: &str) {
        let now = Instant::now();
        let mut nf = self.not_found.lock();
        if nf.len() >= NOT_FOUND_CAPACITY {
            nf.retain(|_, until| *until > now);
            if nf.len() >= NOT_FOUND_CAPACITY {
                let mut by_age: Vec<(String, Instant)> = nf.iter().map(|(k, v)| (k.clone(), *v)).collect();
                by_age.sort_by_key(|(_, v)| *v);
                for (k, _) in by_age.into_iter().take(NOT_FOUND_CAPACITY / 4) {
                    nf.remove(&k);
                }
            }
        }
        nf.insert(url.to_owned(), now + NOT_FOUND_TTL);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------------------------------------------------

/// A temporary file removed when dropped (unless [`TempFile::keep`] took it).
struct TempFile(Option<PathBuf>);

impl TempFile {
    fn new(dir: &Path) -> Self {
        Self(Some(dir.join(format!("{}.part", uuid::Uuid::new_v4()))))
    }
    fn path(&self) -> &Path {
        self.0.as_deref().expect("temp path")
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// fetch → decrypt → quarantine → atomic move. Temporary files live in `job.temp_dir`, never in the save folder.
async fn execute(app: &AppHandle, job: Job, cancelled: Arc<AtomicBool>) -> Outcome {
    if let Err(e) = std::fs::create_dir_all(&job.temp_dir) {
        log::warn!("download temp dir: {e}");
        return Outcome::failed(Failure::unknown());
    }
    let raw = TempFile::new(&job.temp_dir);
    let fetched = if job.is_photo() {
        let deadline = IMAGE_DEADLINE.max(job.ttfb);
        match tokio::time::timeout(deadline, fetch_to_file(app, &job, raw.path())).await {
            Ok(r) => r,
            Err(_) => Err(Failure::ttfb_timeout()),
        }
    } else {
        fetch_to_file(app, &job, raw.path()).await
    };
    if let Err(f) = fetched {
        log::info!("download type={} failed: {} ({})", job.kind, f.name, job.url.host_str().unwrap_or("-"));
        return Outcome::failed(f);
    }
    if cancelled.load(Ordering::SeqCst) {
        return Outcome::failed(Failure::aborted());
    }
    tauri::async_runtime::spawn_blocking(move || finalize(&job, raw, &cancelled))
        .await
        .unwrap_or_else(|_| Outcome::failed(Failure::unknown()))
}

/// Headers sent to `url`: sensitive ones only to Zalo's hosts over https; invalid / connection-level names dropped.
pub fn sanitized_headers(headers: &[(String, String)], url: &url::Url) -> Vec<(String, String)> {
    const TOKEN: &str = "!#$%&'*+-.^_`|~";
    let to_zalo = url.scheme() == "https" && is_zalo_cdn(url.host_str().unwrap_or(""));
    headers
        .iter()
        .filter(|(name, value)| {
            let lower = name.to_ascii_lowercase();
            !name.is_empty()
                && name.chars().all(|c| c.is_ascii_alphanumeric() || TOKEN.contains(c))
                && !FORBIDDEN_HEADERS.contains(&lower.as_str())
                && value.chars().all(|c| (c as u32 >= 0x20 && c as u32 != 0x7f) || c == '\t')
                && (to_zalo || !SENSITIVE_HEADERS.contains(&lower.as_str()))
        })
        .cloned()
        .collect()
}

/// Streams the body (following redirects by hand: sensitive headers do not leave the host they were meant for).
async fn fetch_to_file(app: &AppHandle, job: &Job, file: &Path) -> Result<(), Failure> {
    let max_bytes = if job.is_photo() { PHOTO_BYTE_CAP } else { MAX_FILE_BYTES };
    let head_timeout = if !job.ttfb.is_zero() {
        job.ttfb
    } else if job.is_photo() {
        IMAGE_DEADLINE
    } else {
        FILE_HEAD_TIMEOUT
    };
    let origin_host = job.url.host_str().unwrap_or("").to_ascii_lowercase();
    let mut url = job.url.clone();
    let mut headers = job.headers.clone();
    let mut hops = 0;
    let mut response = loop {
        let sanitized = sanitized_headers(&headers, &url);
        let r = match crate::net::fetch(app, &url, sanitized, &job.user_agent, head_timeout).await {
            Ok(r) => r,
            Err(crate::net::FetchError::Timeout) if !job.ttfb.is_zero() => return Err(Failure::ttfb_timeout()),
            Err(e) => return Err(Failure::from_fetch(&e)),
        };
        if (300..400).contains(&r.status) && r.status != 304 {
            let Some(next) = r.header("location").and_then(|l| url.join(l).ok()) else { return Err(Failure::http(r.status)) };
            hops += 1;
            if hops > MAX_REDIRECTS || !matches!(next.scheme(), "http" | "https") {
                return Err(Failure::net("ERR_TOO_MANY_REDIRECTS", 310));
            }
            if next.host_str().unwrap_or("").to_ascii_lowercase() != origin_host {
                headers.retain(|(k, _)| !SENSITIVE_HEADERS.contains(&k.to_ascii_lowercase().as_str()));
            }
            url = next;
            continue;
        }
        if !(200..300).contains(&r.status) {
            return Err(Failure::http(r.status));
        }
        break r;
    };
    if response.header("content-length").and_then(|v| v.trim().parse::<u64>().ok()).is_some_and(|n| n > max_bytes) {
        return Err(Failure::too_large());
    }
    let mut out = File::create(file).map_err(|_| Failure::unknown())?;
    let mut written: u64 = 0;
    loop {
        let chunk = match tokio::time::timeout(IDLE_TIMEOUT, response.chunk()).await {
            Err(_) => return Err(Failure::ttfb_timeout()),
            Ok(Err(e)) => return Err(Failure::from_fetch(&e)),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(c))) => c,
        };
        written += chunk.len() as u64;
        if written > max_bytes {
            return Err(Failure::too_large());
        }
        out.write_all(&chunk).map_err(|_| Failure::unknown())?;
    }
    out.sync_all().map_err(|_| Failure::unknown())?;
    if written == 0 {
        return Err(Failure::empty_body());
    }
    Ok(())
}

/// Decrypts (when `secure` asks), quarantines and publishes at `job.destination` atomically. Nothing is visible at
/// the destination until everything succeeded; temporaries are always removed.
fn finalize(job: &Job, raw: TempFile, cancelled: &AtomicBool) -> Outcome {
    let run = || -> std::io::Result<Outcome> {
        if let Some(parent) = job.destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let staged = TempFile::new(&job.temp_dir);
        match &job.secure {
            Parsed::Invalid => return Ok(Outcome::failed(Failure::decrypt_failed())),
            Parsed::Stream(stream) => {
                if stream.decrypt_file(raw.path(), staged.path()).is_err() {
                    return Ok(Outcome::failed(Failure::decrypt_failed()));
                }
            }
            Parsed::None => std::fs::rename(raw.path(), staged.path())?,
        }
        if cancelled.load(Ordering::SeqCst) {
            return Ok(Outcome::failed(Failure::aborted()));
        }
        if std::fs::metadata(staged.path()).map(|m| m.len()).unwrap_or(0) == 0 {
            return Ok(Outcome::failed(Failure::empty_body()));
        }
        apply_quarantine(staged.path());
        std::fs::rename(staged.path(), &job.destination)?; // atomic replace on the same volume
        Ok(Outcome { save_path: Some(job.destination.to_string_lossy().into_owned()), failure: None, cached: false })
    };
    match run() {
        Ok(o) => o,
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            // Save folder on another volume than the temp dir: stage next to the destination instead.
            commit_across_volumes(job, raw, cancelled)
        }
        Err(e) => {
            log::warn!("download finalize: {e}");
            Outcome::failed(Failure::unknown())
        }
    }
}

fn commit_across_volumes(job: &Job, raw: TempFile, cancelled: &AtomicBool) -> Outcome {
    let Some(parent) = job.destination.parent() else { return Outcome::failed(Failure::save_dir_invalid()) };
    let staged = TempFile(Some(parent.join(format!(".{}.compola-part", uuid::Uuid::new_v4()))));
    let result = match &job.secure {
        Parsed::Stream(s) => s.decrypt_file(raw.path(), staged.path()).map_err(|_| None),
        Parsed::Invalid => Err(None),
        Parsed::None => std::fs::copy(raw.path(), staged.path()).map(|_| ()).map_err(Some),
    };
    match result {
        Err(None) => return Outcome::failed(Failure::decrypt_failed()),
        Err(Some(_)) => return Outcome::failed(Failure::unknown()),
        Ok(()) => {}
    }
    if cancelled.load(Ordering::SeqCst) {
        return Outcome::failed(Failure::aborted());
    }
    apply_quarantine(staged.path());
    match std::fs::rename(staged.path(), &job.destination) {
        Ok(()) => Outcome { save_path: Some(job.destination.to_string_lossy().into_owned()), failure: None, cached: false },
        Err(_) => Outcome::failed(Failure::unknown()),
    }
}

/// `com.apple.quarantine` like a browser download (Gatekeeper asks before opening it).
fn apply_quarantine(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let value = format!("0081;{secs:08x};Compola;{}", uuid::Uuid::new_v4().to_string().to_uppercase());
        let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return };
        let name = c"com.apple.quarantine";
        unsafe {
            libc::setxattr(c_path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = path;
}

/// Leftovers of a crash / force-quit (`*.part` older than ten minutes).
pub fn remove_stale_temps(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        if now.duration_since(modified).unwrap_or_default() > Duration::from_secs(600) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// A previously completed download: a regular, non-empty file (writes are atomic, so never a partial).
pub fn is_usable_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)
}

/// Headers the renderer asks main to send: `options.headers` [{name, value}] (e.g. Zalo Cloud's `cloud-viewer-key`)
/// and the `extraHeader` object. Names only are ever logged.
pub fn request_headers(request: &Map<String, Value>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut put = |name: &str, value: &str| {
        if name.is_empty() {
            return;
        }
        out.retain(|(k, _)| k != name);
        out.push((name.to_owned(), value.to_owned()));
    };
    let options = request.get("options").and_then(Value::as_object);
    for entry in options.and_then(|o| o.get("headers")).and_then(Value::as_array).into_iter().flatten() {
        if let (Some(name), Some(value)) = (entry.get("name").and_then(Value::as_str), entry.get("value").and_then(Value::as_str)) {
            put(name, value);
        }
    }
    for (name, value) in request.get("extraHeader").and_then(Value::as_object).into_iter().flatten() {
        if let Some(value) = value.as_str() {
            put(name, value);
        }
    }
    out
}

/// `saveDir/fileName`, with the name reduced to a single path component.
pub fn destination(save_dir: Option<&str>, file_name: Option<&str>) -> Option<PathBuf> {
    let save_dir = save_dir.filter(|d| d.starts_with('/'))?;
    let mut name = file_name.unwrap_or("").rsplit('/').find(|s| !s.is_empty()).unwrap_or("").replace('\0', "");
    if name.is_empty() || name == "." || name == ".." {
        name = "no_name".into();
    }
    Some(Path::new(save_dir).join(name))
}

// ---------------------------------------------------------------------------------------------------------------------
// Stream decryption (main-dist `getTransformer`)
// ---------------------------------------------------------------------------------------------------------------------

/// `secure = {type: "e2ee" | "pcloud", cryptography: {alg, key, iv, tag?, type: "block" | "linear", blockSize}}`.
/// - `aes-256-ctr` + block: every `blockSize` bytes are decrypted with a fresh cipher (same key / iv); a trailing
///   partial block passes through unchanged (`skipOverflow`).
/// - `aes-256-ctr` + linear: one cipher over the whole stream.
/// - `aes-256-gcm` + linear: whole stream, authenticated with `tag` (16 bytes); the output only counts once the tag
///   verifies.
///
/// Any other algorithm name (including WebCrypto spellings, which Node's `createDecipheriv` rejects) or malformed
/// key / iv makes the official transformer throw — [`Parsed::Invalid`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecureStream {
    pub gcm: bool,
    pub key: Vec<u8>,
    pub iv: Vec<u8>,
    pub tag: Option<Vec<u8>>,
    pub block: bool,
    pub block_size: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Parsed {
    /// No transformer requested: bytes are saved as received.
    None,
    Stream(SecureStream),
    /// A decryptable `type` with unusable cryptography: the download must fail, not save ciphertext.
    Invalid,
}

#[derive(Debug)]
pub struct DecryptError;

type Ctr128 = ctr::Ctr128BE<Aes256>;
type Ctr32 = ctr::Ctr32BE<Aes256>;

fn secure_bytes(value: Option<&Value>) -> Option<Vec<u8>> {
    use base64::Engine as _;
    match value? {
        Value::String(s) => base64::engine::general_purpose::STANDARD.decode(s.trim()).ok(),
        Value::Array(a) => Some(a.iter().map(|v| v.as_i64().unwrap_or(0) as u8).collect()),
        Value::Object(m) => {
            if let Some(b) = m.get("__bytes").and_then(Value::as_str) {
                base64::engine::general_purpose::STANDARD.decode(b.trim()).ok()
            } else if m.get("type").and_then(Value::as_str) == Some("Buffer") {
                secure_bytes(m.get("data"))
            } else {
                None
            }
        }
        _ => None,
    }
}

impl SecureStream {
    pub fn parse(value: Option<&Value>) -> Parsed {
        let Some(dict) = value.and_then(Value::as_object) else { return Parsed::None };
        if !matches!(dict.get("type").and_then(Value::as_str), Some("e2ee" | "pcloud")) {
            return Parsed::None;
        }
        let Some(crypto) = dict.get("cryptography").and_then(Value::as_object) else { return Parsed::Invalid };
        let gcm = match crypto.get("alg").and_then(Value::as_str) {
            Some("aes-256-ctr") => false,
            Some("aes-256-gcm") => true,
            _ => return Parsed::Invalid,
        };
        let (Some(key), Some(iv)) = (secure_bytes(crypto.get("key")), secure_bytes(crypto.get("iv"))) else { return Parsed::Invalid };
        if key.len() != 32 || iv.is_empty() {
            return Parsed::Invalid;
        }
        let tag = secure_bytes(crypto.get("tag"));
        if gcm && tag.as_ref().map(Vec::len) != Some(16) {
            return Parsed::Invalid;
        }
        if !gcm && iv.len() != 16 {
            return Parsed::Invalid;
        }
        let block = crypto.get("type").and_then(Value::as_str) == Some("block");
        if gcm && block {
            return Parsed::Invalid;
        }
        let block_size = crypto.get("blockSize").and_then(Value::as_f64).map(|n| n as i64).unwrap_or(4096).max(16) as usize;
        Parsed::Stream(SecureStream { gcm, key, iv, tag, block, block_size })
    }

    fn ctr(&self) -> Result<Ctr128, DecryptError> {
        Ctr128::new_from_slices(&self.key, &self.iv).map_err(|_| DecryptError)
    }

    /// Whole-buffer decryption.
    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>, DecryptError> {
        let mut out = data.to_vec();
        if self.gcm {
            let tag = self.tag.as_deref().ok_or(DecryptError)?;
            let mut gcm = GcmStream::new(&self.key, &self.iv, &[])?;
            gcm.update(&mut out);
            return if gcm.verify(tag) { Ok(out) } else { Err(DecryptError) };
        }
        if !self.block {
            self.ctr()?.apply_keystream(&mut out);
            return Ok(out);
        }
        let whole = out.len() - out.len() % self.block_size;
        for chunk in out[..whole].chunks_mut(self.block_size) {
            self.ctr()?.apply_keystream(chunk);
        }
        Ok(out) // overflow passes through
    }

    /// Streams `source` → `destination` (created here, removed on any failure) in constant memory. For GCM the tag is
    /// verified before returning, so a caller that publishes `destination` only on success never publishes
    /// unauthenticated plaintext.
    pub fn decrypt_file(&self, source: &Path, destination: &Path) -> Result<(), DecryptError> {
        let result = self.decrypt_file_inner(source, destination);
        if result.is_err() {
            let _ = std::fs::remove_file(destination);
        }
        result
    }

    fn decrypt_file_inner(&self, source: &Path, destination: &Path) -> Result<(), DecryptError> {
        let mut input = File::open(source).map_err(|_| DecryptError)?;
        let mut output = File::create(destination).map_err(|_| DecryptError)?;
        // Block mode: chunk = whole multiple of the block size so every block restarts the cipher.
        let chunk_size = if self.block && !self.gcm { self.block_size * (1usize << 20).div_ceil(self.block_size).max(1) } else { 1 << 20 };
        let mut buf = vec![0u8; chunk_size];
        let mut linear = if !self.gcm && !self.block { Some(self.ctr()?) } else { None };
        let mut gcm = if self.gcm { Some(GcmStream::new(&self.key, &self.iv, &[])?) } else { None };
        loop {
            let n = read_full(&mut input, &mut buf).map_err(|_| DecryptError)?;
            if n == 0 {
                break;
            }
            let part = &mut buf[..n];
            if let Some(c) = linear.as_mut() {
                c.apply_keystream(part);
                output.write_all(part).map_err(|_| DecryptError)?;
            } else if let Some(g) = gcm.as_mut() {
                g.update(part);
                output.write_all(part).map_err(|_| DecryptError)?;
            } else {
                let plain = self.decrypt(part)?;
                output.write_all(&plain).map_err(|_| DecryptError)?;
            }
        }
        if let Some(g) = gcm {
            if !g.verify(self.tag.as_deref().ok_or(DecryptError)?) {
                return Err(DecryptError);
            }
        }
        output.sync_all().map_err(|_| DecryptError)
    }
}

/// Fills `buf` unless EOF comes first (so block-mode chunks stay aligned to the block size).
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Streaming AES-256-GCM decryption (NIST SP 800-38D): CTR from `inc32(J0)` plus GHASH over the ciphertext. Any IV
/// length works (non-96-bit IVs derive J0 with GHASH), so nothing has to be held in memory.
struct GcmStream {
    ctr: Ctr32,
    ghash: GHash,
    tag_mask: [u8; 16],
    aad_len: u64,
    len: u64,
    pending: Vec<u8>,
}

impl GcmStream {
    fn new(key: &[u8], iv: &[u8], aad: &[u8]) -> Result<Self, DecryptError> {
        let aes = Aes256::new_from_slice(key).map_err(|_| DecryptError)?;
        let mut h = aes::Block::default();
        aes.encrypt_block(&mut h);
        let j0: [u8; 16] = if iv.len() == 12 {
            let mut j = [0u8; 16];
            j[..12].copy_from_slice(iv);
            j[15] = 1;
            j
        } else if iv.is_empty() {
            return Err(DecryptError);
        } else {
            let mut g = GHash::new(&h);
            g.update_padded(iv);
            let mut lengths = [0u8; 16];
            lengths[8..].copy_from_slice(&((iv.len() as u64) * 8).to_be_bytes());
            g.update(&[lengths.into()]);
            g.finalize().into()
        };
        let mut mask = aes::Block::from(j0);
        aes.encrypt_block(&mut mask);
        let mut counter = j0;
        let c = u32::from_be_bytes(counter[12..].try_into().unwrap()).wrapping_add(1);
        counter[12..].copy_from_slice(&c.to_be_bytes());
        let mut ghash = GHash::new(&h);
        ghash.update_padded(aad);
        Ok(Self {
            ctr: Ctr32::new(key.into(), &counter.into()),
            ghash,
            tag_mask: mask.into(),
            aad_len: aad.len() as u64,
            len: 0,
            pending: Vec::new(),
        })
    }

    /// Decrypts `data` in place (it is ciphertext on entry).
    fn update(&mut self, data: &mut [u8]) {
        self.len += data.len() as u64;
        self.pending.extend_from_slice(data);
        let whole = self.pending.len() - self.pending.len() % 16;
        if whole > 0 {
            let blocks: Vec<ghash::Block> = self.pending[..whole].chunks_exact(16).map(|c| ghash::Block::clone_from_slice(c)).collect();
            self.ghash.update(&blocks);
            self.pending.drain(..whole);
        }
        self.ctr.apply_keystream(data);
    }

    fn verify(mut self, tag: &[u8]) -> bool {
        if tag.len() != 16 {
            return false;
        }
        if !self.pending.is_empty() {
            self.ghash.update_padded(&self.pending);
        }
        let mut lengths = [0u8; 16];
        lengths[..8].copy_from_slice(&(self.aad_len * 8).to_be_bytes());
        lengths[8..].copy_from_slice(&(self.len * 8).to_be_bytes());
        self.ghash.update(&[lengths.into()]);
        let digest = self.ghash.finalize();
        let mut diff = 0u8;
        for i in 0..16 {
            diff |= digest[i] ^ self.tag_mask[i] ^ tag[i];
        }
        diff == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    const GCM_KEY: &str = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308";
    const GCM_PLAIN: &str = "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255";

    #[test]
    fn gcm_matches_nist_vector_96_bit_iv() {
        // SP 800-38D test case 15.
        let c = hex("522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad");
        let s = SecureStream { gcm: true, key: hex(GCM_KEY), iv: hex("cafebabefacedbaddecaf888"), tag: Some(hex("b094dac5d93471bdec1a502270e3cc6c")), block: false, block_size: 4096 };
        assert_eq!(s.decrypt(&c).unwrap(), hex(GCM_PLAIN));
        let mut bad = s.clone();
        bad.tag = Some(hex("b094dac5d93471bdec1a502270e3cc6d"));
        assert!(bad.decrypt(&c).is_err());
        let mut tampered = c.clone();
        tampered[3] ^= 1;
        assert!(s.decrypt(&tampered).is_err());
    }

    #[test]
    fn gcm_matches_nist_vector_long_iv_with_aad() {
        // SP 800-38D test case 18 (60-byte IV, AAD): exercises the GHASH-derived J0.
        let iv = hex("9313225df88406e555909c5aff5269aa6a7a9538534f7da1e4c303d2a318a728c3c0c95156809539fcf0e2429a6b525416aedbf5a0de6a57a637b39b");
        let aad = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
        let mut data = hex("5a8def2f0c9e53f1f75d7853659e2a20eeb2b22aafde6419a058ab4f6f746bf40fc0c3b780f244452da3ebf1c5d82cdea2418997200ef82e44ae7e3f");
        let mut g = GcmStream::new(&hex(GCM_KEY), &iv, &aad).unwrap();
        // Uneven pieces: streaming must not depend on chunk boundaries.
        let (a, b) = data.split_at_mut(7);
        g.update(a);
        g.update(b);
        assert!(g.verify(&hex("a44a8266ee1c8eb0c8b5d4cf5ae9f19a")));
        assert_eq!(data, hex(&GCM_PLAIN[..120]));
    }

    #[test]
    fn ctr_linear_and_block_modes() {
        // SP 800-38A F.5.6 (CTR-AES256.Decrypt), first two blocks.
        let key = hex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4");
        let iv = hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
        let c = hex("601ec313775789a5b7a7f504bbf3d228f443e3ca4d62b59aca84e990cacaf5c5");
        let p = hex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51");
        let linear = SecureStream { gcm: false, key: key.clone(), iv: iv.clone(), tag: None, block: false, block_size: 4096 };
        assert_eq!(linear.decrypt(&c).unwrap(), p);
        // Block mode, 16-byte blocks: each block restarts the cipher; the 5-byte overflow passes through.
        let block = SecureStream { gcm: false, key, iv, tag: None, block: true, block_size: 16 };
        let mut wire = c[..16].to_vec();
        wire.extend_from_slice(&c[..16]);
        wire.extend_from_slice(b"tail!");
        let mut expected = p[..16].to_vec();
        expected.extend_from_slice(&p[..16]);
        expected.extend_from_slice(b"tail!");
        assert_eq!(block.decrypt(&wire).unwrap(), expected);
    }

    #[test]
    fn decrypt_file_streams_and_removes_output_on_failure() {
        let dir = std::env::temp_dir().join(format!("compola-dl-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in");
        let dst = dir.join("out");
        // Block mode across a file larger than one read chunk.
        let s = SecureStream { gcm: false, key: vec![7; 32], iv: vec![9; 16], tag: None, block: true, block_size: 4096 };
        let plain: Vec<u8> = (0..(3 << 20) + 123).map(|i| (i % 251) as u8).collect();
        // CTR is symmetric: "decrypting" the plaintext yields the ciphertext.
        let cipher = s.decrypt(&plain).unwrap();
        std::fs::write(&src, &cipher).unwrap();
        s.decrypt_file(&src, &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), plain);
        // GCM with a wrong tag: no output left behind.
        let g = SecureStream { gcm: true, key: vec![1; 32], iv: vec![2; 12], tag: Some(vec![0; 16]), block: false, block_size: 4096 };
        assert!(g.decrypt_file(&src, &dst).is_err());
        assert!(!dst.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn secure_parsing() {
        use base64::Engine as _;
        let b = |n: usize| base64::engine::general_purpose::STANDARD.encode(vec![1u8; n]);
        assert_eq!(SecureStream::parse(None), Parsed::None);
        assert_eq!(SecureStream::parse(Some(&json!({ "type": "other" }))), Parsed::None);
        assert_eq!(SecureStream::parse(Some(&json!({ "type": "e2ee" }))), Parsed::Invalid);
        let ok = SecureStream::parse(Some(&json!({ "type": "pcloud", "cryptography": { "alg": "aes-256-ctr", "key": b(32), "iv": b(16), "type": "block", "blockSize": 8 } })));
        match ok {
            Parsed::Stream(s) => assert!(s.block && s.block_size == 16 && !s.gcm),
            other => panic!("{other:?}"),
        }
        // WebCrypto spelling, short key, GCM without tag, GCM in block mode, CTR with a short IV: all invalid.
        for crypto in [
            json!({ "alg": "AES-GCM", "key": b(32), "iv": b(12), "tag": b(16) }),
            json!({ "alg": "aes-256-ctr", "key": b(16), "iv": b(16) }),
            json!({ "alg": "aes-256-gcm", "key": b(32), "iv": b(12) }),
            json!({ "alg": "aes-256-gcm", "key": b(32), "iv": b(12), "tag": b(16), "type": "block" }),
            json!({ "alg": "aes-256-ctr", "key": b(32), "iv": b(12) }),
        ] {
            assert_eq!(SecureStream::parse(Some(&json!({ "type": "e2ee", "cryptography": crypto }))), Parsed::Invalid);
        }
        // Byte arrays and `{__bytes}` (a Uint8Array crossing the bridge) are accepted too.
        let arr: Vec<u8> = vec![3; 32];
        let parsed = SecureStream::parse(Some(&json!({ "type": "e2ee", "cryptography": { "alg": "aes-256-gcm", "key": arr, "iv": crate::values::bytes(&[4; 12]), "tag": b(16) } })));
        assert!(matches!(parsed, Parsed::Stream(s) if s.gcm && s.key == vec![3; 32] && s.iv == vec![4; 12]));
    }

    #[test]
    fn destination_is_one_component() {
        assert_eq!(destination(Some("/a/b"), Some("x.jpg")), Some(PathBuf::from("/a/b/x.jpg")));
        assert_eq!(destination(Some("/a/b"), Some("../../etc/passwd")), Some(PathBuf::from("/a/b/passwd")));
        assert_eq!(destination(Some("/a/b"), Some("..")), Some(PathBuf::from("/a/b/no_name")));
        assert_eq!(destination(Some("/a/b"), None), Some(PathBuf::from("/a/b/no_name")));
        assert_eq!(destination(Some("relative"), Some("x")), None);
        assert_eq!(destination(None, Some("x")), None);
    }

    #[test]
    fn headers_from_options_and_extra_header() {
        let request = json!({
            "options": { "headers": [{ "name": "cloud-viewer-key", "value": "k" }, { "name": "", "value": "x" }, { "name": "X-A" }] },
            "extraHeader": { "X-B": "b", "X-C": 1 },
        });
        let h = request_headers(request.as_object().unwrap());
        assert_eq!(h, vec![("cloud-viewer-key".to_owned(), "k".to_owned()), ("X-B".to_owned(), "b".to_owned())]);
        let zalo = url::Url::parse("https://cloud-f.zdn.vn/a").unwrap();
        let other = url::Url::parse("https://example.com/a").unwrap();
        let plain_http = url::Url::parse("http://cloud-f.zdn.vn/a").unwrap();
        let mut with_bad = h.clone();
        with_bad.push(("Host".into(), "evil".into()));
        with_bad.push(("Bad Name".into(), "x".into()));
        with_bad.push(("X-Ctl".into(), "a\nb".into()));
        assert_eq!(sanitized_headers(&with_bad, &zalo), h);
        assert_eq!(sanitized_headers(&with_bad, &other), vec![("X-B".to_owned(), "b".to_owned())]);
        assert_eq!(sanitized_headers(&with_bad, &plain_http), vec![("X-B".to_owned(), "b".to_owned())]);
    }

    #[test]
    fn failure_codes() {
        assert_eq!(Failure::http(404).json(), json!({ "name": "DOWNLOAD_SERVICE_NET_404", "code": 75404, "normalize": true }));
        assert_eq!(Failure::net("ERR_NAME_NOT_RESOLVED", 34).code, 30034);
        assert_eq!(Failure::decrypt_failed().json()["message"], "File secure decrypt failed");
        assert_eq!(Failure::aborted().code, 1009);
    }

    #[test]
    fn usable_files_and_stale_temps() {
        let dir = std::env::temp_dir().join(format!("compola-dl-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let empty = dir.join("empty");
        let full = dir.join("full.part");
        std::fs::write(&empty, b"").unwrap();
        std::fs::write(&full, b"x").unwrap();
        assert!(!is_usable_file(&empty));
        assert!(is_usable_file(&full));
        assert!(!is_usable_file(&dir));
        remove_stale_temps(&dir, SystemTime::now());
        assert!(full.exists());
        remove_stale_temps(&dir, SystemTime::now() + Duration::from_secs(601));
        assert!(!full.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
