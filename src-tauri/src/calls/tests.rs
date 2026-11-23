//! zcall-v2 end to end against a fake native helper speaking the protocol over real UNIX sockets
//! (port of `CallTransportTests.swift`: `CallBridgeEndToEnd`, `CallBridgeSafety`).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::transport::{self, tests::READY_PLAIN};
use super::*;

/// A one-shot gate (`DispatchSemaphore(value: 0)`).
#[derive(Default)]
struct Gate(std::sync::Mutex<bool>, Condvar);

impl Gate {
    fn wait(&self) {
        let mut open = self.0.lock().unwrap();
        while !*open {
            open = self.1.wait(open).unwrap();
        }
    }
    fn signal(&self) {
        *self.0.lock().unwrap() = true;
        self.1.notify_all();
    }
}

/// Plays `ZaloCall`: connects to both sockets, announces `native-ready`, acknowledges every chunk it reads on the send
/// socket, reassembles chunked messages and records them.
struct FakeNative {
    received: Mutex<Vec<String>>,
    send: Mutex<Option<UnixStream>>,
    recv: Mutex<Option<UnixStream>>,
    hold_recv: AtomicBool,
    ack_every_chunk: bool,
    recv_gate: Option<Arc<Gate>>,
}

impl FakeNative {
    fn received(&self) -> Vec<String> {
        self.received.lock().clone()
    }
    fn is_connected(&self) -> bool {
        self.send.lock().is_some() && self.recv.lock().is_some()
    }

    /// argv[1] = recv path (helper writes to it), argv[2] = send path (helper reads from it).
    fn run(self: &Arc<Self>, recv_path: String, send_path: String, announce_ready: bool) {
        let me = self.clone();
        std::thread::spawn(move || {
            let send = UnixStream::connect(&send_path);
            if let Some(g) = &me.recv_gate {
                g.wait();
            }
            let recv = UnixStream::connect(&recv_path);
            let (Ok(mut send), Ok(recv)) = (send, recv) else { return };
            *me.send.lock() = send.try_clone().ok();
            *me.recv.lock() = recv.try_clone().ok();
            if announce_ready {
                me.send_message(READY_PLAIN);
            }
            let mut pending: Vec<u8> = Vec::new();
            let mut parts: HashMap<i64, HashMap<usize, String>> = HashMap::new();
            let mut buf = vec![0u8; 65_536];
            loop {
                let n = match send.read(&mut buf) {
                    Ok(n) if n > 0 => n,
                    _ => break,
                };
                pending.extend_from_slice(&buf[..n]);
                while let Some(end) = pending.iter().position(|b| *b == b'$') {
                    let frame: Vec<u8> = pending.drain(..=end).take(end).collect();
                    if me.ack_every_chunk {
                        let _ = send.write_all(&[0x06]);
                    }
                    let frame = String::from_utf8_lossy(&frame).into_owned();
                    if let Some(plain) = reassemble(&frame, &mut parts).and_then(|hex| transport::decrypt(&hex, &transport::default_key())) {
                        me.received.lock().push(plain);
                    }
                }
            }
            let _ = send.shutdown(Shutdown::Both);
            if !me.hold_recv.load(Ordering::SeqCst) {
                if let Some(r) = me.recv.lock().as_ref() {
                    let _ = r.shutdown(Shutdown::Both);
                }
            }
        });
    }

    /// helper → main: `hex(AES(json)) + "$"` on the recv socket.
    fn send_message(&self, json: &str) {
        let hex = transport::encrypt(json, &transport::default_key()).unwrap();
        if let Some(r) = self.recv.lock().as_mut() {
            let _ = r.write_all(format!("{hex}$").as_bytes());
        }
    }

    fn disconnect(&self, keep_recv: bool) {
        self.hold_recv.store(keep_recv, Ordering::SeqCst);
        if let Some(s) = self.send.lock().take() {
            let _ = s.shutdown(Shutdown::Both);
        }
        if !keep_recv {
            if let Some(r) = self.recv.lock().take() {
                let _ = r.shutdown(Shutdown::Both);
            }
        }
    }

    /// Late EOF of the recv connection (after `disconnect(keep_recv: true)`).
    fn close_recv(&self) {
        if let Some(r) = self.recv.lock().take() {
            let _ = r.shutdown(Shutdown::Both);
        }
    }
}

/// `payload` or `payload#seq#count#index#`.
fn reassemble(frame: &str, parts: &mut HashMap<i64, HashMap<usize, String>>) -> Option<String> {
    if !frame.contains('#') {
        return Some(frame.to_owned());
    }
    let fields: Vec<&str> = frame.split('#').collect();
    if fields.len() != 4 && fields.len() != 5 {
        return None;
    }
    let (seq, count, index) = (fields[1].parse::<i64>().ok()?, fields[2].parse::<usize>().ok()?, fields[3].parse::<usize>().ok()?);
    let entry = parts.entry(seq).or_default();
    entry.insert(index, fields[0].to_owned());
    if entry.len() != count {
        return None;
    }
    let joined = (0..count).filter_map(|i| entry.get(&i).cloned()).collect::<String>();
    parts.remove(&seq);
    Some(joined)
}

struct FakeProcess {
    running: AtomicBool,
    interrupted: AtomicUsize,
    terminated: AtomicUsize,
    native: Arc<FakeNative>,
    on_exit: Mutex<Option<ExitFn>>,
    /// Exit closes only the send socket; the test closes recv later with `native.close_recv()`.
    keep_recv_on_exit: bool,
}

impl FakeProcess {
    fn exit(&self, status: i32) {
        if !self.running.swap(false, Ordering::SeqCst) {
            return;
        }
        self.native.disconnect(self.keep_recv_on_exit);
        if let Some(f) = self.on_exit.lock().take() {
            std::thread::spawn(move || f(status));
        }
    }
}

impl CallProcess for FakeProcess {
    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
    fn interrupt(&self) {
        self.interrupted.fetch_add(1, Ordering::SeqCst);
        self.exit(2);
    }
    fn terminate(&self) {
        self.terminated.fetch_add(1, Ordering::SeqCst);
        self.exit(15);
    }
    fn force_kill(&self) {
        self.exit(9);
    }
    fn pid(&self) -> Option<i32> {
        self.is_running().then_some(4242)
    }
}

#[derive(Default)]
struct Shared {
    emitted: Mutex<Vec<(String, Vec<Value>)>>,
    events: Mutex<Vec<CallEvent>>,
    processes: Mutex<Vec<Arc<FakeProcess>>>,
    natives: Mutex<Vec<Arc<FakeNative>>>,
    logs: Mutex<Vec<String>>,
    silent: AtomicBool,
    no_ack: AtomicBool,
    keep_recv_on_exit: AtomicBool,
    /// Spawn index → gate holding that helper's recv connection back.
    recv_gates: Mutex<HashMap<usize, Arc<Gate>>>,
    verify_error: Mutex<Option<String>>,
    reaped: AtomicUsize,
}

struct Harness {
    s: Arc<Shared>,
    bridge: Arc<CallBridge>,
    base: PathBuf,
}

impl Harness {
    fn new() -> Self {
        Self::with(true)
    }

    fn with(executable_exists: bool) -> Self {
        // Short path: sockaddr_un holds 103 bytes.
        let base = PathBuf::from(format!("/tmp/szt-{}", rand::random::<u32>() % 1_000_000));
        std::fs::create_dir_all(&base).unwrap();
        let s = Arc::new(Shared::default());
        let (s1, s2, s3, s4, s5, s6) = (s.clone(), s.clone(), s.clone(), s.clone(), s.clone(), s.clone());
        let bridge = CallBridge::new(Config {
            executable: Some(PathBuf::from(if executable_exists { "/bin/echo" } else { "/nonexistent/ZaloCall" })),
            socket_base: base.clone(),
            key: transport::default_key(),
            spawn: Box::new(move |recv, send, on_exit| {
                let index = s1.natives.lock().len();
                let native = Arc::new(FakeNative {
                    received: Mutex::new(Vec::new()),
                    send: Mutex::new(None),
                    recv: Mutex::new(None),
                    hold_recv: AtomicBool::new(false),
                    ack_every_chunk: !s1.no_ack.load(Ordering::SeqCst),
                    recv_gate: s1.recv_gates.lock().get(&index).cloned(),
                });
                s1.natives.lock().push(native.clone());
                native.run(recv.to_owned(), send.to_owned(), !s1.silent.load(Ordering::SeqCst));
                let process = Arc::new(FakeProcess {
                    running: AtomicBool::new(true),
                    interrupted: AtomicUsize::new(0),
                    terminated: AtomicUsize::new(0),
                    native,
                    on_exit: Mutex::new(Some(on_exit)),
                    keep_recv_on_exit: s1.keep_recv_on_exit.load(Ordering::SeqCst),
                });
                s1.processes.lock().push(process.clone());
                Ok(process as Arc<dyn CallProcess>)
            }),
            verify: Box::new(move |_| s2.verify_error.lock().clone().map_or(Ok(()), Err)),
            reap_orphans: Box::new(move || {
                s3.reaped.fetch_add(1, Ordering::SeqCst);
            }),
            emit: Box::new(move |channel, args| s4.emitted.lock().push((channel.to_owned(), args))),
            log: Box::new(move |line| s5.logs.lock().push(line.to_owned())),
            on_event: Box::new(move |e| s6.events.lock().push(e)),
        });
        Self { s, bridge, base }
    }

    fn native(&self, i: usize) -> Arc<FakeNative> {
        self.s.natives.lock()[i].clone()
    }
    fn process_count(&self) -> usize {
        self.s.processes.lock().len()
    }
    fn has_event(&self, e: &CallEvent) -> bool {
        self.s.events.lock().contains(e)
    }
    fn recv_ends(&self) -> usize {
        self.s.logs.lock().iter().filter(|l| *l == "call: recv end").count()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.bridge.shutdown();
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn wait(mut condition: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}

#[test]
fn ipc_arguments_decode() {
    assert_eq!(CallBridge::decode(&[json!("{\"a\":1}"), json!(true)]), Some(("{\"a\":1}".into(), true)));
    assert_eq!(CallBridge::decode(&[json!("{\"a\":1}")]).map(|d| d.1), Some(false));
    // Structured object (table-driven preload member): `_optional` truthy is stripped, falsy stays.
    let b = CallBridge::decode(&[json!({ "type": "update", "_optional": true })]).unwrap();
    assert!(b.1 && !b.0.contains("_optional"));
    let c = CallBridge::decode(&[json!({ "type": "update", "_optional": false })]).unwrap();
    assert!(!c.1 && c.0.contains("_optional"));
    assert_eq!(CallBridge::decode(&[]), None);
}

#[test]
fn starts_helper_queues_until_ready_then_sends_init_first() {
    let h = Harness::new();
    h.bridge.set_init(Some(r#"{"type":"update","command":"init","data":{"local":{"id":"1"}}}"#.into()));
    // `_optional` messages never start the helper; they wait for it.
    h.bridge.send_to_native(r#"{"type":"control","data":{"act":"x"}}"#.into(), true);
    assert_eq!(h.process_count(), 0);
    // A non-optional message starts it (and goes out after init and the queued control message).
    let big = format!(r#"{{"type":"request","command":"makeCall","data":{{"blob":"{}"}}}}"#, "ê".repeat(6000));
    h.bridge.send_to_native(big.clone(), false);
    assert_eq!(h.process_count(), 1);

    let native = h.native(0);
    assert!(wait(|| native.received().len() >= 3));
    let received = native.received();
    assert_eq!(received.len(), 3);
    assert!(received[0].contains("\"command\":\"init\""));
    assert!(received[1].contains("\"act\":\"x\""));
    assert_eq!(received[2], big); // multi-chunk message arrives intact
    assert!(h.has_event(&CallEvent::HelperStarted { pid: Some(4242) }));
    assert!(h.has_event(&CallEvent::Ready));
    // Starting again while running does not spawn a second helper.
    h.bridge.send_to_native(r#"{"type":"request","command":"endCall","data":null}"#.into(), false);
    assert_eq!(h.process_count(), 1);
    assert!(wait(|| native.received().len() >= 4));
    assert!(native.received().last().unwrap().contains("endCall"));
}

#[test]
fn messages_flow_to_the_renderer() {
    let h = Harness::new();
    h.bridge.send_to_native("{}".into(), false);
    let native = h.native(0);
    assert!(wait(|| h.has_event(&CallEvent::Ready)));

    native.send_message(r#"{"type":"update","command":"callState","data":{"state":"incall"}}"#);
    native.send_message(r#"{"type":"sendSignal","command":401,"data":{"calleeId":"9","callId":"c"}}"#);
    native.send_message(r#"{"type":"request","command":"serverTime","data":null}"#);
    native.send_message(r#"{"type":"request","command":"popup","data":{"header":"H","content":"C"}}"#);
    native.send_message(r#"{"type":"response","command":"listDevice","data":{"autoAudioInput":true}}"#);
    assert!(wait(|| h.s.emitted.lock().len() >= 5));
    let emitted = h.s.emitted.lock().clone();
    let channels: Vec<&str> = emitted.iter().map(|(c, _)| c.as_str()).collect();
    assert_eq!(channels, ["call-update", "call-send-signal", "call-request", "call-request", "call-response-listDevice"]);
    assert_eq!(emitted[0].1[0], "callState");
    assert_eq!(emitted[0].1[1]["state"], "incall");
    assert_eq!(emitted[1].1[0], json!(401)); // numeric command kept numeric
    assert_eq!(emitted[4].1, vec![json!({ "autoAudioInput": true })]);
    assert!(h.has_event(&CallEvent::CallState { state: "incall".into() }));
    assert!(h.has_event(&CallEvent::Popup { header: "H".into(), content: "C".into() }));
}

#[test]
fn native_exit_reports_free_and_kill_me_restarts() {
    let h = Harness::new();
    h.bridge.set_init(Some(r#"{"type":"update","command":"init","data":{}}"#.into()));
    h.bridge.send_to_native("{}".into(), false);
    let first = h.native(0);
    assert!(wait(|| h.has_event(&CallEvent::Ready)));

    first.send_message(r#"{"type":"request","command":"killMe","data":null}"#);
    assert!(wait(|| h.process_count() == 2));
    assert_eq!(h.s.processes.lock()[0].interrupted.load(Ordering::SeqCst), 1);
    // The renderer is told the call state is free when the helper goes away.
    assert!(h.s.emitted.lock().iter().any(|(c, a)| c == "call-update" && a.first() == Some(&json!("callState"))));
    // The new helper gets the stored init data on its own native-ready.
    let second = h.native(1);
    assert!(wait(|| second.received().iter().any(|m| m.contains("\"command\":\"init\""))));
}

/// Restart ordering seen under load: the new helper's send socket connects *before* the old helper's recv EOF is
/// delivered (and before the new recv connects). The stale EOF must not reset the new connection.
#[test]
fn stale_recv_end_does_not_reset_the_restarted_helper() {
    let h = Harness::new();
    h.s.keep_recv_on_exit.store(true, Ordering::SeqCst);
    let gate = Arc::new(Gate::default());
    h.s.recv_gates.lock().insert(1, gate.clone());
    h.bridge.set_init(Some(r#"{"type":"update","command":"init","data":{}}"#.into()));
    h.bridge.send_to_native("{}".into(), false);
    let first = h.native(0);
    assert!(wait(|| h.has_event(&CallEvent::Ready)));

    first.send_message(r#"{"type":"request","command":"killMe","data":null}"#);
    assert!(wait(|| h.process_count() == 2));
    // New helper is on the send socket, its recv is held back; the old recv is still open.
    assert!(wait(|| h.bridge.has_send_connection()));
    let ends = h.recv_ends();
    first.close_recv();
    assert!(wait(|| h.recv_ends() > ends));
    assert!(h.bridge.has_send_connection());

    gate.signal();
    let second = h.native(1);
    assert!(wait(|| second.received().iter().any(|m| m.contains("\"command\":\"init\""))));
}

#[test]
fn missing_helper_fails_gracefully() {
    let h = Harness::with(false);
    h.bridge.send_to_native("{}".into(), false);
    h.bridge.send_to_native("{}".into(), false);
    assert_eq!(h.process_count(), 0);
    // Reported once, with a user-readable reason.
    let problems: Vec<String> = h
        .s
        .events
        .lock()
        .iter()
        .filter_map(|e| if let CallEvent::HelperUnavailable { reason } = e { Some(reason.clone()) } else { None })
        .collect();
    assert_eq!(problems.len(), 1);
    assert!(problems[0].contains("Zalo"));
    assert!(!h.bridge.started());
}

#[test]
fn reset_kills_helper_and_forgets_queued_messages() {
    let h = Harness::new();
    h.s.silent.store(true, Ordering::SeqCst); // helper connects but never says native-ready
    h.bridge.send_to_native(r#"{"n":1}"#.into(), false);
    let native = h.native(0);
    assert!(wait(|| native.is_connected()));
    h.bridge.reset();
    assert!(wait(|| h.s.processes.lock()[0].terminated.load(Ordering::SeqCst) == 1));
    assert!(native.received().is_empty()); // nothing leaked before ready
}

#[test]
fn sockets_are_removed_on_shutdown() {
    let h = Harness::new();
    h.bridge.send_to_native("{}".into(), false);
    let recv = h.bridge.recv_path();
    let meta = std::fs::metadata(&recv).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    let dir = Path::new(&recv).parent().unwrap().to_owned();
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    h.bridge.shutdown();
    assert!(!Path::new(&recv).exists());
    assert!(!dir.exists());
}

#[test]
fn unsigned_helper_is_never_spawned() {
    let h = Harness::new();
    *h.s.verify_error.lock() = Some("chữ ký sai".into());
    h.bridge.send_to_native("{}".into(), false);
    assert!(h.process_count() == 0 && !h.bridge.started());
    assert!(h.has_event(&CallEvent::HelperUnavailable { reason: "chữ ký sai".into() }));
    // Checked again before every spawn: fixed signature -> starts.
    *h.s.verify_error.lock() = None;
    h.bridge.send_to_native("{}".into(), false);
    assert_eq!(h.process_count(), 1);
}

#[test]
fn orphans_are_reaped_once_per_run() {
    let h = Harness::new();
    h.bridge.send_to_native("{}".into(), false);
    h.bridge.reset();
    h.bridge.send_to_native("{}".into(), false);
    assert_eq!(h.s.reaped.load(Ordering::SeqCst), 1);
}

#[test]
fn socket_directory_is_fresh_and_private() {
    let h = Harness::new();
    // A hostile pre-existing directory with a predictable name is not reused.
    let predictable = format!("/tmp/szc-{}", std::process::id());
    let _ = std::fs::create_dir_all(&predictable);
    let _ = std::fs::set_permissions(&predictable, std::fs::Permissions::from_mode(0o777));
    h.bridge.send_to_native("{}".into(), false);
    let recv = h.bridge.recv_path();
    let dir = Path::new(&recv).parent().unwrap();
    assert_ne!(dir, Path::new(&predictable));
    let meta = std::fs::metadata(dir).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o700);
    assert_eq!(meta.uid(), unsafe { libc::getuid() });
    let _ = std::fs::remove_dir_all(&predictable);
}

#[test]
fn stalled_helper_never_gets_a_second_chunk_in_flight() {
    let h = Harness::new();
    h.s.no_ack.store(true, Ordering::SeqCst); // never acknowledges
    h.bridge.send_to_native("{}".into(), false);
    let native = h.native(0);
    assert!(wait(|| h.has_event(&CallEvent::Ready)));
    let big = format!(r#"{{"blob":"{}"}}"#, "a".repeat(9000));
    h.bridge.send_to_native(big, false);
    std::thread::sleep(Duration::from_millis(600));
    // Only the first chunk ("{}") is on the wire; without an ack nothing else is written.
    assert_eq!(native.received(), vec!["{}".to_owned()]);
}

#[test]
fn after_connect_messages_go_immediately() {
    let h = Harness::new();
    h.s.silent.store(true, Ordering::SeqCst); // connected, but never says native-ready
    h.bridge.send_to_native(r#"{"n":1}"#.into(), false);
    let native = h.native(0);
    assert!(wait(|| native.is_connected() && h.bridge.has_send_connection()));
    std::thread::sleep(Duration::from_millis(100));
    h.bridge.send_to_native(r#"{"n":2}"#.into(), false);
    // Official: once the send socket is connected, messages are written at once (only earlier ones wait).
    assert!(wait(|| native.received().contains(&r#"{"n":2}"#.to_owned())));
    assert!(!native.received().contains(&r#"{"n":1}"#.to_owned())); // queued before the connection: waits for native-ready
    assert!(!h.bridge.native_ready());
}

#[test]
fn reset_allows_a_fresh_start_right_away() {
    let h = Harness::new();
    h.bridge.send_to_native("{}".into(), false);
    assert!(wait(|| h.has_event(&CallEvent::Ready)));
    h.bridge.reset();
    assert!(!h.bridge.started());
    h.bridge.send_to_native("{}".into(), false);
    assert_eq!(h.process_count(), 2);
}
