//! Performs Compola's network requests through `compola-fingerprint-helper` (Go, `fingerprint-helper/`), so that the
//! TLS and HTTP/2 fingerprints of every connection are Chromium 108's — the official Zalo PC client's (Electron
//! 22.3.9) — instead of rustls'. Port of `FingerprintProxy.swift`; see `reanalysis/wire-fingerprint.md` in the
//! Swift repo.
//!
//! The helper is a child process speaking the protocol documented in `fingerprint-helper/protocol.go` over a
//! unix socket in `platform::app_support()`. Callers fall back to reqwest / tokio-tungstenite only on
//! [`Error::Unavailable`]; an upstream failure ([`Error::Failed`], [`Error::TooLarge`]) is a real result and is
//! reported, never retried on the other stack — a retry that switched fingerprint is exactly what this exists
//! to avoid.
//!
//! `COMPOLA_NO_FINGERPRINT_HELPER=1` disables the helper.

mod connection;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::{mpsc, watch};

use super::HttpResponse;
use connection::Connection;

/// Sidecar name (Tauri strips the `-<target-triple>` suffix when it places the binary next to the executable).
const HELPER_NAME: &str = "compola-fingerprint-helper";
const DISABLE_ENV: &str = "COMPOLA_NO_FINGERPRINT_HELPER";

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// The helper is not running (and could not be started), or the connection to it dropped: the caller may
    /// fall back for this request.
    Unavailable,
    /// An upstream failure (timeout, TLS, HTTP, websocket upgrade refused): a real answer, never retried on
    /// another stack.
    Failed(String),
    /// The body exceeded the limit (`Request::max_bytes`, or the helper's 64 MiB for buffered responses).
    TooLarge,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unavailable => f.write_str("fingerprint helper unavailable"),
            Error::Failed(message) => f.write_str(message),
            Error::TooLarge => f.write_str("body too large"),
        }
    }
}

/// One request for the helper (`REQ` JSON).
#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub url: String,
    /// Sent in this order (fhttp pins the wire order to it; Chromium sends page-set headers before its own).
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// 0: none (the helper's client allows 600 s).
    pub timeout_ms: u64,
    pub stream: bool,
    /// Follow redirects in the helper (false: a 3xx comes back as the response).
    pub follow: bool,
    /// 0: the helper's default (64 MiB for a buffered response, unlimited for a stream).
    pub max_bytes: i64,
    /// Streams: cancel when nothing arrives for this long.
    pub idle_ms: u64,
    /// Streams: a shorter idle window until the first body byte (0: `idle_ms`).
    pub first_byte_ms: u64,
}

impl Request {
    pub fn new(method: &str, url: &str) -> Self {
        Self {
            method: method.to_owned(),
            url: url.to_owned(),
            headers: Vec::new(),
            body: Vec::new(),
            timeout_ms: 0,
            stream: false,
            follow: true,
            max_bytes: 0,
            idle_ms: 30_000,
            first_byte_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResponseHead {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub url: String,
}

/// What [`FingerprintProxy::stream`] returns: the head and the body stream, or a complete response when the
/// helper did not stream (its answer to a 3xx, so the caller can re-issue the hop with its own headers).
#[allow(dead_code)] // the streaming API is for the media loader / downloads port (MediaLoader.swift)
pub enum StreamStart {
    Head(ResponseHead, HelperStream),
    Complete(HttpResponse),
}

#[allow(dead_code)] // the streaming API is for the media loader / downloads port (MediaLoader.swift)
pub(crate) enum StreamItem {
    Chunk(Vec<u8>),
    End,
    Failed(Error),
}

/// A streamed response body. Dropping it before the end cancels the upstream transfer.
#[allow(dead_code)] // the streaming API is for the media loader / downloads port (MediaLoader.swift)
pub struct HelperStream {
    id: String,
    connection: Option<Arc<Connection>>,
    items: mpsc::UnboundedReceiver<StreamItem>,
    done: bool,
}

#[allow(dead_code)] // the streaming API is for the media loader / downloads port (MediaLoader.swift)
impl HelperStream {
    fn new(id: String, items: mpsc::UnboundedReceiver<StreamItem>) -> Self {
        Self { id, connection: None, items, done: false }
    }

    fn attach(mut self, connection: Arc<Connection>) -> Self {
        self.connection = Some(connection);
        self
    }

    /// The next body chunk; `Ok(None)` at the end.
    pub async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, Error> {
        if self.done {
            return Ok(None);
        }
        let item = self.items.recv().await;
        match item {
            Some(StreamItem::Chunk(data)) => Ok(Some(data)),
            Some(StreamItem::End) => {
                self.done = true;
                Ok(None)
            }
            Some(StreamItem::Failed(error)) => {
                self.done = true;
                Err(error)
            }
            None => {
                self.done = true;
                Err(Error::Unavailable)
            }
        }
    }
}

impl Drop for HelperStream {
    fn drop(&mut self) {
        if !self.done {
            if let Some(connection) = &self.connection {
                connection.cancel(&self.id);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum WsEvent {
    Text(String),
    Binary(Vec<u8>),
    /// The server (or the helper's read pump) closed the session.
    Closed { code: u16, reason: String },
    /// The helper went away (or the message was too large): the session is gone.
    Error(String),
}

/// A websocket opened through the helper (session `w<n>`). Dropping it unclosed closes it with 1001.
pub struct HelperSocket {
    connection: Arc<Connection>,
    session: String,
    /// The subprotocol the server selected ("" for none).
    pub protocol: String,
    events: mpsc::UnboundedReceiver<WsEvent>,
    finished: bool,
}

impl HelperSocket {
    /// The next event; `Closed`/`Error` (or `None`) end the session.
    pub async fn next_event(&mut self) -> Option<WsEvent> {
        if self.finished {
            return None;
        }
        let event = self.events.recv().await;
        if !matches!(event, Some(WsEvent::Text(_) | WsEvent::Binary(_))) {
            self.finished = true;
        }
        event
    }

    pub fn send_text(&self, text: &str) {
        self.connection.ws_send(&self.session, true, text.as_bytes());
    }

    pub fn send_binary(&self, data: &[u8]) {
        self.connection.ws_send(&self.session, false, data);
    }

    /// Closes with `code`; no further events are delivered (the helper's `WSCLOSED` echo is dropped).
    pub fn close(mut self, code: u16) {
        self.finished = true;
        self.connection.ws_close(&self.session, code);
    }
}

impl Drop for HelperSocket {
    fn drop(&mut self) {
        if !self.finished {
            self.connection.ws_close(&self.session, 1001);
        }
    }
}

enum State {
    Idle,
    /// The start thread publishes `Some(result)` when done.
    Starting(watch::Receiver<Option<Option<Arc<Connection>>>>),
    Ready(Arc<Connection>),
    Failed { retry_at: Instant },
    /// Disabled, not bundled, or shut down: never (re)started.
    Off,
}

struct Inner {
    state: State,
    child: Option<Child>,
    restart_attempts: u32,
}

pub struct FingerprintProxy {
    inner: Mutex<Inner>,
}

static SHARED: LazyLock<FingerprintProxy> =
    LazyLock::new(|| FingerprintProxy { inner: Mutex::new(Inner { state: State::Idle, child: None, restart_attempts: 0 }) });

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id(prefix: &str) -> String {
    format!("{prefix}{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

/// Why a start failed: `permanent` failures switch the helper off for this run.
struct StartError {
    message: String,
    permanent: bool,
}

impl StartError {
    fn transient(message: impl Into<String>) -> Self {
        Self { message: message.into(), permanent: false }
    }
    fn permanent(message: impl Into<String>) -> Self {
        Self { message: message.into(), permanent: true }
    }
}

impl FingerprintProxy {
    pub fn shared() -> &'static FingerprintProxy {
        &SHARED
    }

    // ---- Lifecycle ----

    /// Starts the helper now if it is not running, so the renderer's first requests do not wait for it.
    pub fn warm_up(&'static self, _app: &tauri::AppHandle) {
        let mut inner = self.inner.lock();
        if self.should_start(&inner) {
            let _ = self.begin_start(&mut inner);
        }
    }

    /// The helper when it is up, starting it if needed and waiting at most `wait` (a start that takes longer
    /// keeps going in the background).
    pub async fn ready(&'static self, wait: Duration) -> Option<&'static FingerprintProxy> {
        match tokio::time::timeout(wait, self.connection()).await {
            Ok(Some(_)) => Some(self),
            _ => None,
        }
    }

    /// Ready right now (starts nothing).
    #[allow(dead_code)] // the streaming API is for the media loader / downloads port (MediaLoader.swift)
    pub fn is_ready(&self) -> bool {
        matches!(self.inner.lock().state, State::Ready(_))
    }

    fn should_start(&self, inner: &Inner) -> bool {
        match inner.state {
            State::Idle => true,
            State::Failed { retry_at } => Instant::now() >= retry_at,
            _ => false,
        }
    }

    async fn connection(&'static self) -> Option<Arc<Connection>> {
        let mut starting = {
            let mut inner = self.inner.lock();
            match &inner.state {
                State::Ready(connection) => return Some(connection.clone()),
                State::Off => return None,
                State::Starting(receiver) => receiver.clone(),
                State::Failed { .. } if !self.should_start(&inner) => return None,
                State::Idle | State::Failed { .. } => self.begin_start(&mut inner),
            }
        };
        let result = starting.wait_for(Option::is_some).await.ok()?.clone();
        result.flatten()
    }

    /// Spawns the start thread (blocking work: process spawn, socket wait, HELLO).
    fn begin_start(&'static self, inner: &mut Inner) -> watch::Receiver<Option<Option<Arc<Connection>>>> {
        let (tx, rx) = watch::channel(None);
        inner.state = State::Starting(rx.clone());
        let spawned = std::thread::Builder::new().name("compola.fp-start".into()).spawn(move || {
            let result = self.start();
            let mut inner = self.inner.lock();
            let connection = match result {
                Ok((connection, mut child)) => {
                    if matches!(inner.state, State::Starting(_)) {
                        inner.state = State::Ready(connection.clone());
                        inner.child = Some(child);
                        inner.restart_attempts = 0;
                        Some(connection)
                    } else {
                        // Shut down while starting.
                        connection.shutdown();
                        terminate(&mut child);
                        None
                    }
                }
                Err(e) => {
                    if matches!(inner.state, State::Starting(_)) {
                        if e.permanent {
                            log::info!("fingerprint helper off: {} — requests use reqwest", e.message);
                            inner.state = State::Off;
                        } else {
                            log::error!("fingerprint helper start failed: {}", e.message);
                            let delay = retry_delay(inner.restart_attempts);
                            inner.restart_attempts += 1;
                            inner.state = State::Failed { retry_at: Instant::now() + delay };
                        }
                    }
                    None
                }
            };
            drop(inner);
            let _ = tx.send(Some(connection));
        });
        if spawned.is_err() {
            inner.state = State::Failed { retry_at: Instant::now() + retry_delay(inner.restart_attempts) };
        }
        rx
    }

    fn start(&'static self) -> Result<(Arc<Connection>, Child), StartError> {
        if std::env::var(DISABLE_ENV).is_ok_and(|v| !v.is_empty() && v != "0") {
            return Err(StartError::permanent(format!("disabled by {DISABLE_ENV}")));
        }
        let helper = helper_path().ok_or_else(|| StartError::permanent("helper not bundled"))?;
        let directory = crate::platform::app_support();
        std::fs::create_dir_all(&directory).map_err(|e| StartError::transient(format!("{}: {e}", directory.display())))?;
        sweep_stale_sockets(&directory);
        let socket = directory.join(format!("fp-helper-{}-{:08x}.sock", std::process::id(), rand::random::<u32>()));

        // stdout must never be ours: a `cargo test` pipe would wait for the helper forever.
        let mut child = Command::new(&helper)
            .arg("-socket")
            .arg(&socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| StartError::transient(format!("spawn {}: {e}", helper.display())))?;
        let stderr_tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            let _ = std::thread::Builder::new().name("compola.fp-stderr".into()).spawn(move || {
                for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                    log::debug!("fingerprint helper: {line}");
                    let mut tail = tail.lock();
                    tail.push_back(line);
                    if tail.len() > 6 {
                        tail.pop_front();
                    }
                }
            });
        }

        let fail = |child: &mut Child, message: String| {
            terminate(child);
            let tail: Vec<String> = stderr_tail.lock().iter().cloned().collect();
            StartError::transient(if tail.is_empty() { message } else { format!("{message} — {}", tail.join(" | ")) })
        };
        for _ in 0..50 {
            if socket.exists() {
                break;
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(fail(&mut child, format!("helper exited before listening ({status})")));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !socket.exists() {
            return Err(fail(&mut child, "helper socket never appeared".into()));
        }

        let tail = stderr_tail.clone();
        let on_closed: connection::OnClosed = Box::new(move |connection| self.helper_died(connection, &tail));
        let connection = match Connection::connect(&socket, on_closed) {
            Ok(connection) => connection,
            Err(e) => return Err(fail(&mut child, format!("connect: {e}"))),
        };
        match connection.hello(Duration::from_secs(5)) {
            Ok(profile) => {
                log::info!("fingerprint helper ready ({profile})");
                Ok((connection, child))
            }
            Err(_) => {
                connection.close();
                Err(fail(&mut child, "handshake failed".into()))
            }
        }
    }

    /// The connection dropped (reader thread). Pending callers were already failed with `Unavailable`.
    fn helper_died(&self, connection: &Arc<Connection>, stderr_tail: &Mutex<VecDeque<String>>) {
        let mut inner = self.inner.lock();
        if !matches!(&inner.state, State::Ready(c) if Arc::ptr_eq(c, connection)) {
            return; // shut down, or failed during start (reported there)
        }
        let status = inner.child.take().map(|mut child| {
            for _ in 0..10 {
                if let Ok(Some(status)) = child.try_wait() {
                    return status.to_string();
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            terminate(&mut child);
            "connection closed, terminated".to_owned()
        });
        let tail: Vec<String> = stderr_tail.lock().iter().cloned().collect();
        log::error!("fingerprint helper exited ({}) {}", status.as_deref().unwrap_or("?"), tail.join(" | "));
        let delay = retry_delay(inner.restart_attempts);
        inner.restart_attempts += 1;
        inner.state = State::Failed { retry_at: Instant::now() + delay };
    }

    /// Stops the helper for good (app exit).
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock();
        if let State::Ready(connection) = std::mem::replace(&mut inner.state, State::Off) {
            connection.shutdown();
        }
        if let Some(mut child) = inner.child.take() {
            terminate(&mut child);
        }
    }

    // ---- Requests ----

    /// A complete (buffered) request: `Unavailable` when the helper cannot serve it (fall back), `Failed` /
    /// `TooLarge` when the upstream failed (do not). `timeout` is passed on when it is under the helper's 600 s.
    pub async fn perform(
        &'static self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
        timeout: Option<Duration>,
    ) -> Result<HttpResponse, Error> {
        let mut request = Request::new(method, url);
        request.headers = headers.to_vec();
        request.body = body.to_vec();
        if let Some(timeout) = timeout.filter(|t| !t.is_zero() && *t < Duration::from_secs(600)) {
            request.timeout_ms = timeout.as_millis() as u64;
        }
        self.perform_request(&request).await
    }

    pub async fn perform_request(&'static self, request: &Request) -> Result<HttpResponse, Error> {
        let connection = self.connection().await.ok_or(Error::Unavailable)?;
        let mut request = request.clone();
        request.stream = false;
        connection.perform(next_id("r"), &request).await
    }

    /// A streaming request (for media/downloads): the head and body stream, or a complete response for a 3xx
    /// the helper did not follow. Dropping the stream cancels the transfer.
    #[allow(dead_code)] // the streaming API is for the media loader / downloads port (MediaLoader.swift)
    pub async fn stream(&'static self, request: &Request) -> Result<StreamStart, Error> {
        let connection = self.connection().await.ok_or(Error::Unavailable)?;
        let mut request = request.clone();
        request.stream = true;
        connection.stream(next_id("r"), &request).await
    }

    /// Opens a websocket with Chromium's ClientHello. `Failed` is the upstream's refusal (a real result);
    /// `Unavailable` means the caller should open it another way.
    pub async fn ws_open(
        &'static self,
        url: &str,
        headers: &[(String, String)],
        protocols: &[String],
    ) -> Result<HelperSocket, Error> {
        let connection = self.connection().await.ok_or(Error::Unavailable)?;
        let session = next_id("w");
        let (protocol, events) = connection.ws_open(session.clone(), url, headers, protocols).await?;
        Ok(HelperSocket { connection, session, protocol, events, finished: false })
    }
}

fn retry_delay(attempts: u32) -> Duration {
    Duration::from_secs((1u64 << attempts.min(6)).min(60))
}

/// SIGTERM (the helper removes its socket and exits), then reap it if it is already gone.
fn terminate(child: &mut Child) {
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let _ = child.try_wait();
}

/// Next to the app executable (bundles: `Contents/MacOS/`; `cargo run`/`tauri dev`: tauri-build copies the
/// sidecar into `target/<profile>/`), else the build script's output in `src-tauri/binaries/` (tests).
fn helper_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(directory) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        candidates.push(directory.join(HELPER_NAME));
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("{HELPER_NAME}-{}", env!("TAURI_ENV_TARGET_TRIPLE"))),
    );
    candidates.into_iter().find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Sockets of helpers whose owning process is gone (`fp-helper-<pid>-<random>.sock`).
fn sweep_stale_sockets(directory: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix("fp-helper-").filter(|_| name.ends_with(".sock")) else { continue };
        let pid: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let Ok(pid) = pid.parse::<libc::pid_t>() else { continue };
        if pid > 0 && pid_is_gone(pid) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn pid_is_gone(pid: libc::pid_t) -> bool {
    unsafe { libc::kill(pid, 0) != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) }
}
