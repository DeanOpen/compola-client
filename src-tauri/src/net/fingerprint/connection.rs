//! One Compola↔helper connection (port of `FingerprintProxyConnection.swift`): a unix socket with a blocking
//! reader thread and a writer thread, so it works from any tokio runtime (or none). Request, stream and
//! websocket-open answers are matched to their callers by id; websocket events go to the session's channel
//! in the order the helper sent them.
//!
//! Framing is `fingerprint-helper/protocol.go`: LF-terminated command lines; `CHUNK`/`WSMSG` lines are followed
//! by exactly `<len>` payload bytes and then the next line.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(not(unix))]
use unsupported::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc as std_mpsc};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use super::{Error, HelperStream, Request, ResponseHead, StreamItem, StreamStart, WsEvent};
use crate::net::HttpResponse;

/// Longest control line accepted from the helper. A complete `RES` carries up to 64 MiB of body (the helper's
/// `maxBufferedBody`) as base64, plus headers.
pub(super) const MAX_LINE: usize = 100 << 20;
/// Largest `CHUNK` payload accepted (the helper sends ≤ 64 KiB).
pub(super) const MAX_CHUNK: usize = 16 << 20;
/// Largest websocket message delivered (URLSession's `maximumMessageSize` in the Swift app). Larger messages
/// are skipped and the session is failed with close code 1009.
pub(super) const MAX_WS_MESSAGE: usize = 64 << 20;

// ---- Frame parsing (pure, unit-tested) ----

/// One complete frame from the helper.
#[derive(Debug, PartialEq)]
pub(super) enum Frame {
    /// A command line without a binary payload: `<command> <id> <rest…>`.
    Line { command: String, id: String, rest: String },
    /// A `CHUNK` frame's payload.
    Chunk { id: String, data: Vec<u8> },
    /// A `WSMSG` frame's payload.
    WsMessage { id: String, text: bool, data: Vec<u8> },
    /// A `WSMSG` over `MAX_WS_MESSAGE` (its payload was skipped).
    WsOversized { id: String },
}

enum BinaryKind {
    Chunk,
    Ws { text: bool },
}

struct PendingBinary {
    kind: BinaryKind,
    id: String,
    remaining: usize,
    data: Vec<u8>,
    skip: bool,
}

/// Incremental parser for the helper → client byte stream.
#[derive(Default)]
pub(super) struct FrameParser {
    buffer: Vec<u8>,
    /// Start of the unparsed bytes in `buffer`.
    position: usize,
    /// Bytes after `position` already searched for a newline (a 80 MiB `RES` line arrives in many reads).
    scanned: usize,
    binary: Option<PendingBinary>,
}

impl FrameParser {
    /// Feeds received bytes; complete frames are appended to `out`. An error is a protocol violation (the
    /// connection must be dropped).
    pub fn feed(&mut self, data: &[u8], out: &mut Vec<Frame>) -> Result<(), String> {
        self.buffer.extend_from_slice(data);
        loop {
            if let Some(pending) = &mut self.binary {
                let available = self.buffer.len() - self.position;
                let take = pending.remaining.min(available);
                if !pending.skip {
                    pending.data.extend_from_slice(&self.buffer[self.position..self.position + take]);
                }
                self.position += take;
                pending.remaining -= take;
                if pending.remaining > 0 {
                    break;
                }
                let done = self.binary.take().expect("pending binary");
                out.push(match (done.kind, done.skip) {
                    (BinaryKind::Chunk, _) => Frame::Chunk { id: done.id, data: done.data },
                    (BinaryKind::Ws { .. }, true) => Frame::WsOversized { id: done.id },
                    (BinaryKind::Ws { text }, false) => Frame::WsMessage { id: done.id, text, data: done.data },
                });
                continue;
            }
            let unparsed = &self.buffer[self.position..];
            let Some(offset) = unparsed[self.scanned..].iter().position(|b| *b == b'\n') else {
                self.scanned = unparsed.len();
                if self.scanned > MAX_LINE {
                    return Err("line too long".into());
                }
                break;
            };
            let end = self.position + self.scanned + offset;
            let line = String::from_utf8_lossy(&self.buffer[self.position..end]).into_owned();
            self.position = end + 1;
            self.scanned = 0;
            self.line(line, out)?;
        }
        if self.position == self.buffer.len() {
            self.buffer.clear();
            self.position = 0;
        } else if self.position > (1 << 20) {
            self.buffer.drain(..self.position);
            self.position = 0;
        }
        Ok(())
    }

    /// Only the first two fields split on spaces — JSON payloads contain spaces themselves.
    fn line(&mut self, line: String, out: &mut Vec<Frame>) -> Result<(), String> {
        let mut parts = line.splitn(3, ' ');
        let command = parts.next().unwrap_or("").to_owned();
        let id = parts.next().unwrap_or("").to_owned();
        let rest = parts.next().unwrap_or("").to_owned();
        match command.as_str() {
            "CHUNK" => {
                let length = parse_length(&rest).ok_or_else(|| format!("bad CHUNK length {rest:?}"))?;
                if length > MAX_CHUNK {
                    return Err(format!("CHUNK of {length} bytes"));
                }
                self.expect_binary(BinaryKind::Chunk, id, length, false, out);
            }
            "WSMSG" => {
                // rest = "text|binary <len>"
                let (kind, length) = rest.split_once(' ').ok_or_else(|| format!("bad WSMSG {rest:?}"))?;
                let length = parse_length(length).ok_or_else(|| format!("bad WSMSG length {length:?}"))?;
                let skip = length > MAX_WS_MESSAGE;
                self.expect_binary(BinaryKind::Ws { text: kind == "text" }, id, length, skip, out);
            }
            _ => out.push(Frame::Line { command, id, rest }),
        }
        Ok(())
    }

    fn expect_binary(&mut self, kind: BinaryKind, id: String, length: usize, skip: bool, out: &mut Vec<Frame>) {
        if length == 0 {
            out.push(match kind {
                BinaryKind::Chunk => Frame::Chunk { id, data: Vec::new() },
                BinaryKind::Ws { text } => Frame::WsMessage { id, text, data: Vec::new() },
            });
        } else {
            let data = if skip { Vec::new() } else { Vec::with_capacity(length.min(1 << 20)) };
            self.binary = Some(PendingBinary { kind, id, remaining: length, data, skip });
        }
    }
}

/// Digits only, bounded (cannot overflow).
fn parse_length(text: &str) -> Option<usize> {
    if text.is_empty() || text.len() > 12 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

// ---- Wire JSON ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRequest<'a> {
    method: &'a str,
    url: &'a str,
    headers: Vec<[&'a str; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_b64: Option<String>,
    timeout_ms: u64,
    stream: bool,
    follow: bool,
    max_bytes: i64,
    idle_ms: u64,
    first_byte_ms: u64,
}

/// `RES`/`RESHEAD`/`ERR` JSON (Go marshals nil slices as `null`, hence the options).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WireResponse {
    status: Option<i64>,
    status_text: Option<String>,
    headers: Option<Vec<Vec<String>>>,
    url: Option<String>,
    body_b64: Option<String>,
    error: Option<String>,
}

/// `WSOPENED`/`WSERR`/`WSCLOSED` JSON.
#[derive(Deserialize, Default)]
struct WireEvent {
    protocol: Option<String>,
    error: Option<String>,
    reason: Option<String>,
    status: Option<i64>,
}

pub(super) fn encode_request(request: &Request) -> String {
    let wire = WireRequest {
        method: &request.method,
        url: &request.url,
        headers: request.headers.iter().map(|(k, v)| [k.as_str(), v.as_str()]).collect(),
        body_b64: (!request.body.is_empty()).then(|| B64.encode(&request.body)),
        timeout_ms: request.timeout_ms,
        stream: request.stream,
        follow: request.follow,
        max_bytes: request.max_bytes,
        idle_ms: request.idle_ms,
        first_byte_ms: request.first_byte_ms,
    };
    serde_json::to_string(&wire).unwrap_or_else(|_| "{}".into())
}

fn make_head(wire: &WireResponse) -> ResponseHead {
    let status = wire.status.unwrap_or(0).clamp(0, u16::MAX as i64) as u16;
    // Go's `Response.Status` is "200 OK"; the page wants the reason phrase only (Chromium reports none for h2,
    // the canonical one is the closest stand-in when the helper's is empty).
    let text = wire.status_text.as_deref().unwrap_or("");
    let text = text.strip_prefix(&format!("{status} ")).unwrap_or(if text == status.to_string() { "" } else { text });
    let status_text = if text.is_empty() {
        http::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("").to_owned()
    } else {
        text.to_owned()
    };
    ResponseHead {
        status,
        status_text,
        headers: wire
            .headers
            .iter()
            .flatten()
            .filter_map(|pair| match pair.as_slice() {
                [name, value] => Some((name.clone(), value.clone())),
                _ => None,
            })
            .collect(),
        url: wire.url.clone().unwrap_or_default(),
    }
}

fn make_response(wire: WireResponse) -> Result<HttpResponse, Error> {
    let head = make_head(&wire);
    let body = match wire.body_b64.as_deref() {
        None | Some("") => Vec::new(),
        Some(text) => B64.decode(text).map_err(|e| Error::Failed(format!("helper sent a bad body: {e}")))?,
    };
    Ok(HttpResponse { status: head.status, status_text: head.status_text, headers: head.headers, url: head.url, body })
}

/// A `RES` frame's JSON → the response.
pub(super) fn decode_response(json: &str) -> Result<HttpResponse, Error> {
    decode::<WireResponse>(json).ok_or_else(|| Error::Failed("undecodable RES frame".into())).and_then(make_response)
}

/// An `ERR` message → the caller's error: an oversized body is `TooLarge`, anything else an upstream failure.
pub(super) fn upstream_error(message: &str) -> Error {
    if message.contains("body too large") { Error::TooLarge } else { Error::Failed(message.to_owned()) }
}

fn decode<T: for<'de> Deserialize<'de>>(json: &str) -> Option<T> {
    serde_json::from_str(json).ok()
}

// ---- The connection ----

#[derive(Default)]
struct Pending {
    responses: HashMap<String, oneshot::Sender<Result<HttpResponse, Error>>>,
    stream_heads: HashMap<String, oneshot::Sender<Result<StreamStart, Error>>>,
    streams: HashMap<String, mpsc::UnboundedSender<StreamItem>>,
    opens: HashMap<String, oneshot::Sender<Result<String, Error>>>,
    sockets: HashMap<String, mpsc::UnboundedSender<WsEvent>>,
    hello: Option<std_mpsc::Sender<Result<String, Error>>>,
}

pub(super) struct Connection {
    out: Mutex<Option<std_mpsc::Sender<Vec<u8>>>>,
    socket: UnixStream,
    closed: AtomicBool,
    pending: Mutex<Pending>,
}

/// Called (on the reader thread) once the connection is gone, after every pending caller was failed.
pub(super) type OnClosed = Box<dyn FnOnce(&Arc<Connection>) + Send>;

impl Connection {
    pub fn connect(path: &Path, on_closed: OnClosed) -> std::io::Result<Arc<Self>> {
        let socket = UnixStream::connect(path)?;
        let mut reader = socket.try_clone()?;
        let mut writer = socket.try_clone()?;
        let (tx, rx) = std_mpsc::channel::<Vec<u8>>();
        let connection =
            Arc::new(Self { out: Mutex::new(Some(tx)), socket, closed: AtomicBool::new(false), pending: Mutex::default() });

        // Writer: frames go out whole and in order; a failed write closes the socket, which the reader turns
        // into "connection lost" for everyone.
        std::thread::Builder::new().name("compola.fp-writer".into()).spawn(move || {
            for frame in rx {
                if writer.write_all(&frame).is_err() {
                    let _ = writer.shutdown(Shutdown::Both);
                    break;
                }
            }
        })?;

        let this = connection.clone();
        std::thread::Builder::new().name("compola.fp-reader".into()).spawn(move || {
            let mut parser = FrameParser::default();
            let mut chunk = vec![0u8; 256 << 10];
            let mut frames = Vec::new();
            loop {
                let received = match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                if let Err(e) = parser.feed(&chunk[..received], &mut frames) {
                    log::error!("fingerprint helper protocol error: {e}");
                    break;
                }
                let mut keep_going = true;
                for frame in frames.drain(..) {
                    keep_going &= this.dispatch(frame);
                }
                if !keep_going || this.is_closed() {
                    break;
                }
            }
            this.close();
            this.fail_all();
            on_closed(&this);
        })?;
        Ok(connection)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            // Lets the writer drain what is queued, then end; the reader wakes with EOF.
            self.out.lock().take();
            let _ = self.socket.shutdown(Shutdown::Read);
        }
    }

    /// Queues a frame for the writer. `Unavailable` once the connection is closed.
    fn send(&self, line: String, payload: &[u8]) -> Result<(), Error> {
        let mut frame = line.into_bytes();
        frame.extend_from_slice(payload);
        match self.out.lock().as_ref() {
            Some(tx) if !self.is_closed() => tx.send(frame).map_err(|_| Error::Unavailable),
            _ => Err(Error::Unavailable),
        }
    }

    // ---- Dispatch (reader thread) ----

    /// One complete frame; false when the helper said goodbye.
    fn dispatch(&self, frame: Frame) -> bool {
        match frame {
            Frame::Line { command, id, rest } => return self.dispatch_line(&command, id, &rest),
            Frame::Chunk { id, data } => {
                if let Some(tx) = self.pending.lock().streams.get(&id) {
                    let _ = tx.send(StreamItem::Chunk(data));
                }
            }
            Frame::WsMessage { id, text, data } => {
                let event = if text {
                    WsEvent::Text(String::from_utf8(data).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
                } else {
                    WsEvent::Binary(data)
                };
                if let Some(tx) = self.pending.lock().sockets.get(&id) {
                    let _ = tx.send(event);
                }
            }
            Frame::WsOversized { id } => {
                log::warn!("fingerprint helper: websocket {id} message over {MAX_WS_MESSAGE} bytes — closing it");
                if let Some(tx) = self.pending.lock().sockets.remove(&id) {
                    let _ = tx.send(WsEvent::Error("message too large".into()));
                }
                let _ = self.send(format!("WSCLOSE {id} 1009\n"), &[]);
            }
        }
        true
    }

    fn dispatch_line(&self, command: &str, id: String, rest: &str) -> bool {
        match command {
            "OK" => {
                // "OK <version> <profile>"
                if let Some(tx) = self.pending.lock().hello.take() {
                    let _ = tx.send(Ok(format!("v{id} {rest}")));
                }
            }
            "BYE" => return false,
            "RES" => {
                let result = decode_response(rest);
                let mut pending = self.pending.lock();
                if let Some(tx) = pending.responses.remove(&id) {
                    let _ = tx.send(result);
                } else if let Some(tx) = pending.stream_heads.remove(&id) {
                    let _ = tx.send(result.map(StreamStart::Complete));
                }
            }
            "RESHEAD" => {
                let mut pending = self.pending.lock();
                let Some(tx) = pending.stream_heads.remove(&id) else { return true };
                match decode::<WireResponse>(rest) {
                    Some(wire) => {
                        let (body_tx, body_rx) = mpsc::unbounded_channel();
                        pending.streams.insert(id.clone(), body_tx);
                        drop(pending);
                        let _ = tx.send(Ok(StreamStart::Head(make_head(&wire), HelperStream::new(id, body_rx))));
                    }
                    None => {
                        let _ = tx.send(Err(Error::Failed("undecodable RESHEAD frame".into())));
                    }
                }
            }
            "END" => {
                if let Some(tx) = self.pending.lock().streams.remove(&id) {
                    let _ = tx.send(StreamItem::End);
                }
            }
            "ERR" => {
                let message = decode::<WireResponse>(rest)
                    .map(|w| w.error.unwrap_or_else(|| "unknown error".into()))
                    .unwrap_or_else(|| "undecodable ERR frame".into());
                let error = upstream_error(&message);
                let mut pending = self.pending.lock();
                if let Some(tx) = pending.responses.remove(&id) {
                    let _ = tx.send(Err(error));
                } else if let Some(tx) = pending.stream_heads.remove(&id) {
                    let _ = tx.send(Err(error));
                } else if let Some(tx) = pending.streams.remove(&id) {
                    let _ = tx.send(StreamItem::Failed(error));
                }
            }
            "WSOPENED" => {
                let protocol = decode::<WireEvent>(rest).and_then(|w| w.protocol).unwrap_or_default();
                if let Some(tx) = self.pending.lock().opens.remove(&id) {
                    let _ = tx.send(Ok(protocol));
                }
            }
            "WSERR" => {
                let wire = decode::<WireEvent>(rest).unwrap_or_default();
                let mut message = wire.error.unwrap_or_else(|| "websocket open failed".into());
                if let Some(status) = wire.status.filter(|s| *s > 0) {
                    message = format!("{message} (HTTP {status})");
                }
                let mut pending = self.pending.lock();
                pending.sockets.remove(&id);
                if let Some(tx) = pending.opens.remove(&id) {
                    let _ = tx.send(Err(Error::Failed(message)));
                }
            }
            "WSCLOSED" => {
                // rest = "<code> {json}"
                let (code, json) = rest.split_once(' ').unwrap_or((rest, "{}"));
                let reason = decode::<WireEvent>(json).and_then(|w| w.reason).unwrap_or_default();
                let code = code.parse().unwrap_or(1006);
                if let Some(tx) = self.pending.lock().sockets.remove(&id) {
                    let _ = tx.send(WsEvent::Closed { code, reason });
                }
            }
            _ => {}
        }
        true
    }

    /// Everyone still waiting learns the helper is gone (`Unavailable`: callers may fall back).
    fn fail_all(&self) {
        let pending = std::mem::take(&mut *self.pending.lock());
        for (_, tx) in pending.responses {
            let _ = tx.send(Err(Error::Unavailable));
        }
        for (_, tx) in pending.stream_heads {
            let _ = tx.send(Err(Error::Unavailable));
        }
        for (_, tx) in pending.opens {
            let _ = tx.send(Err(Error::Unavailable));
        }
        for (_, tx) in pending.streams {
            let _ = tx.send(StreamItem::Failed(Error::Unavailable));
        }
        for (_, tx) in pending.sockets {
            let _ = tx.send(WsEvent::Error("helper exited".into()));
        }
        if let Some(tx) = pending.hello {
            let _ = tx.send(Err(Error::Unavailable));
        }
    }

    // ---- Requests ----

    /// `HELLO` → the helper's version and profile (blocking; used by the start thread).
    pub fn hello(&self, timeout: Duration) -> Result<String, Error> {
        let (tx, rx) = std_mpsc::channel();
        self.pending.lock().hello = Some(tx);
        self.send("HELLO\n".into(), &[])?;
        rx.recv_timeout(timeout).map_err(|_| Error::Unavailable)?
    }

    pub async fn perform(self: &Arc<Self>, id: String, request: &Request) -> Result<HttpResponse, Error> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().responses.insert(id.clone(), tx);
        let mut guard = CancelOnDrop { connection: self, id: &id, armed: true };
        self.send(format!("REQ {id} {}\n", encode_request(request)), &[])?;
        let result = rx.await.unwrap_or(Err(Error::Unavailable));
        guard.armed = false;
        result
    }

    #[allow(dead_code)]
    pub async fn stream(self: &Arc<Self>, id: String, request: &Request) -> Result<StreamStart, Error> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().stream_heads.insert(id.clone(), tx);
        let mut guard = CancelOnDrop { connection: self, id: &id, armed: true };
        self.send(format!("REQ {id} {}\n", encode_request(request)), &[])?;
        let result = rx.await.unwrap_or(Err(Error::Unavailable));
        guard.armed = false;
        result.map(|start| match start {
            StreamStart::Head(head, stream) => StreamStart::Head(head, stream.attach(self.clone())),
            complete => complete,
        })
    }

    /// `WSOPEN`: the negotiated subprotocol and the session's event channel (registered before the open is
    /// sent, so messages right after `WSOPENED` are not lost).
    pub async fn ws_open(
        self: &Arc<Self>,
        session: String,
        url: &str,
        headers: &[(String, String)],
        protocols: &[String],
    ) -> Result<(String, mpsc::UnboundedReceiver<WsEvent>), Error> {
        let wire = serde_json::json!({
            "url": url,
            "headers": headers.iter().map(|(k, v)| [k, v]).collect::<Vec<_>>(),
            "protocols": protocols,
        });
        let (open_tx, open_rx) = oneshot::channel();
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        {
            let mut pending = self.pending.lock();
            pending.opens.insert(session.clone(), open_tx);
            pending.sockets.insert(session.clone(), events_tx);
        }
        let mut guard = CancelOnDrop { connection: self, id: &session, armed: true };
        self.send(format!("WSOPEN {session} {wire}\n"), &[])?;
        let result = open_rx.await.unwrap_or(Err(Error::Unavailable));
        guard.armed = false;
        if result.is_err() {
            self.pending.lock().sockets.remove(&session);
        }
        result.map(|protocol| (protocol, events_rx))
    }

    pub fn ws_send(&self, session: &str, text: bool, payload: &[u8]) {
        let kind = if text { "text" } else { "binary" };
        let _ = self.send(format!("WSSEND {session} {kind} {}\n", payload.len()), payload);
    }

    /// Drops the session's handler first, so the helper's `WSCLOSED` echo is not delivered.
    pub fn ws_close(&self, session: &str, code: u16) {
        self.pending.lock().sockets.remove(session);
        let _ = self.send(format!("WSCLOSE {session} {code}\n"), &[]);
    }

    /// Abandons whatever is pending under `id` and tells the helper to stop it.
    pub fn cancel(&self, id: &str) {
        {
            let mut pending = self.pending.lock();
            pending.responses.remove(id);
            pending.stream_heads.remove(id);
            pending.opens.remove(id);
            pending.streams.remove(id);
            pending.sockets.remove(id);
        }
        let _ = self.send(format!("CANCEL {id}\n"), &[]);
    }

    pub fn shutdown(&self) {
        let _ = self.send("SHUTDOWN\n".into(), &[]);
        self.close();
    }
}

/// Cancels the request when the awaiting future is dropped before its answer arrived.
struct CancelOnDrop<'a> {
    connection: &'a Connection,
    id: &'a str,
    armed: bool,
}

impl Drop for CancelOnDrop<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.connection.cancel(self.id);
        }
    }
}

/// Never connected off Unix (`helper_path` is `None` there); it only keeps [`Connection`] one type.
#[cfg(not(unix))]
mod unsupported {
    use std::io::{Error, ErrorKind, Read, Result, Write};
    use std::net::Shutdown;
    use std::path::Path;

    pub struct UnixStream;

    fn unsupported<T>() -> Result<T> {
        Err(Error::new(ErrorKind::Unsupported, "UNIX sockets are not available on this platform"))
    }

    impl UnixStream {
        pub fn connect(_path: &Path) -> Result<Self> {
            unsupported()
        }
        pub fn try_clone(&self) -> Result<Self> {
            unsupported()
        }
        pub fn shutdown(&self, _how: Shutdown) -> Result<()> {
            Ok(())
        }
    }

    impl Read for UnixStream {
        fn read(&mut self, _buf: &mut [u8]) -> Result<usize> {
            unsupported()
        }
    }

    impl Write for UnixStream {
        fn write(&mut self, _buf: &[u8]) -> Result<usize> {
            unsupported()
        }
        fn flush(&mut self) -> Result<()> {
            Ok(())
        }
    }
}
