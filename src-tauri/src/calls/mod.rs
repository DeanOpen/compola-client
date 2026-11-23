//! Voice / video calls: main's "zcall-v2" module — port of `CallBridge.swift`.
//!
//! Hosts the two UNIX-socket servers the native helper (`ZaloCall`, a Qt app shipped in Zalo.app's
//! `ZaloHelper.app`) connects to, starts and restarts it, and relays between it and the renderer:
//!
//! ```text
//!   renderer ──call-send-to-native / call-init──▶ here ──encrypt, chunk──▶ send socket ──▶ ZaloCall
//!   renderer ◀──call-update / call-send-signal / call-request / call-response-<cmd>── recv socket ◀── ZaloCall
//! ```
//!
//! Frames in both directions are `hex(AES-128-CBC(json))` terminated by `$` (see [`transport`]). Payloads carry
//! tokens and ids: only command names are ever logged. Helper lifecycle events go to the UI window as
//! `compola://call-event` ([`CallEvent`]).

pub mod helper;
pub mod socket;
pub mod transport;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::bridge::Registry;
use crate::host::{Hosts, emit_ui};
use crate::values::{ArgsExt, undef};
use socket::{ServerEvent, UnixSocketServer};
use transport::{Chunker, FrameDecoder};

/// A running (or fake, in tests) native call helper.
pub trait CallProcess: Send + Sync {
    fn is_running(&self) -> bool;
    /// `SIGINT` — what main sends on `killMe`.
    fn interrupt(&self);
    /// `SIGTERM` — `child.kill()`.
    fn terminate(&self);
    fn force_kill(&self);
    fn pid(&self) -> Option<i32>;
}

pub type ExitFn = Box<dyn FnOnce(i32) + Send>;
pub type Spawn = Box<dyn Fn(&str, &str, ExitFn) -> Result<Arc<dyn CallProcess>, String> + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CallEvent {
    /// Zalo.app / the helper is missing or could not start.
    HelperUnavailable { reason: String },
    HelperStarted { pid: Option<i32> },
    /// The helper connected and announced `native-ready`.
    Ready,
    Exited { status: i32 },
    /// Native `update`/`callState` (`free`, `incall`, …).
    CallState { state: String },
    /// Native `request`/`popup` — the official renderer shows it as a confirm dialog (invisible here).
    Popup { header: String, content: String },
}

/// Where Zalo.app keeps the helper (`dirname(exe)/../ZaloHelper.app/Contents/MacOS/ZaloCall`), in our runtime copy.
pub fn helper_executable(runtime: &Path) -> PathBuf {
    runtime.join("Contents/ZaloHelper.app/Contents/MacOS/ZaloCall")
}

pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Everything the bridge talks to (injected in tests).
pub struct Config {
    pub executable: Option<PathBuf>,
    pub socket_base: PathBuf,
    pub key: Vec<u8>,
    pub spawn: Spawn,
    pub verify: Box<dyn Fn(&Path) -> Result<(), String> + Send + Sync>,
    pub reap_orphans: Box<dyn Fn() + Send + Sync>,
    pub emit: Box<dyn Fn(&str, Vec<Value>) + Send + Sync>,
    pub log: Box<dyn Fn(&str) + Send + Sync>,
    pub on_event: Box<dyn Fn(CallEvent) + Send + Sync>,
}

const MAX_PENDING: usize = 500;

// State names follow main's module: U, F, L, M, D, P, x.
#[derive(Default)]
struct State {
    reaped_orphans: bool,
    recv_server: Option<Arc<UnixSocketServer>>,
    send_server: Option<Arc<UnixSocketServer>>,
    socket_dir: Option<PathBuf>,
    recv_path: String,
    send_path: String,
    process: Option<Arc<dyn CallProcess>>,
    process_token: u64,
    /// `L`: the helper has been started and has not exited.
    started: bool,
    /// `M`: restart after the next exit (set by `killMe`).
    restart_after_exit: bool,
    shut_down: bool,
    last_unavailable: Option<String>,
    /// `D`: the last `call-init` payload (JSON text), sent on every `native-ready`.
    init_json: Option<String>,
    /// `P`: messages (JSON text) waiting for a ready helper.
    pending: VecDeque<String>,
    /// `U`: connection id of the helper on the send socket.
    send_connection: Option<u64>,
    native_ready: bool,
    flushed_for_ready: bool,
    chunker: Chunker,
    /// `x`: encrypted chunks waiting for the helper's acknowledgement.
    chunk_queue: VecDeque<String>,
    /// `F`: a chunk is on the wire; the helper acknowledges by writing anything back.
    awaiting_ack: bool,
    decoders: HashMap<u64, FrameDecoder>,
    /// Bumped whenever a helper is started or dropped. Socket connections are tagged with the generation current when
    /// they connected: the late EOF of a previous helper's sockets must not reset the next helper's state.
    generation: u64,
    recv_generations: HashMap<u64, u64>,
    send_generations: HashMap<u64, u64>,
    dropped_frames: usize,
}

pub struct CallBridge {
    cfg: Config,
    state: Mutex<State>,
    me: Weak<CallBridge>,
}

fn same_process(a: &Arc<dyn CallProcess>, b: &Arc<dyn CallProcess>) -> bool {
    std::ptr::eq(Arc::as_ptr(a) as *const (), Arc::as_ptr(b) as *const ())
}

#[allow(dead_code)] // state accessors: tests and the UI side (helper window)
impl CallBridge {
    pub fn new(cfg: Config) -> Arc<Self> {
        Arc::new_cyclic(|me| CallBridge { cfg, state: Mutex::new(State::default()), me: me.clone() })
    }

    fn log(&self, line: &str) {
        (self.cfg.log)(line);
    }

    pub fn started(&self) -> bool {
        self.state.lock().started
    }
    pub fn native_ready(&self) -> bool {
        self.state.lock().native_ready
    }
    pub fn has_send_connection(&self) -> bool {
        self.state.lock().send_connection.is_some()
    }
    pub fn recv_path(&self) -> String {
        self.state.lock().recv_path.clone()
    }
    /// pid of the running helper (for bringing its window forward).
    pub fn helper_pid(&self) -> Option<i32> {
        self.state.lock().process.as_ref().and_then(|p| p.pid())
    }

    // ---- Renderer → main (`ipcMain.on`) ----

    /// `call-send-to-native`: `_optional` messages are queued without starting the helper; others start it. `json` is
    /// the message exactly as main would `JSON.stringify` it.
    pub fn send_to_native(&self, json: String, optional: bool) {
        let mut st = self.state.lock();
        if st.shut_down {
            return;
        }
        if !optional {
            self.start_native(&mut st);
        }
        self.deliver(&mut st, json);
    }

    /// `call-init`: remembered and sent to the helper on every `native-ready`.
    pub fn set_init(&self, json: Option<String>) {
        self.state.lock().init_json = json;
    }

    /// IPC arguments of `call-send-to-native` / `call-init`: `[json, optional]` from the preload shim
    /// (`host-scripts/call-adapter.js`), or the message object itself when the table-driven preload member ran.
    pub fn decode(args: &[Value]) -> Option<(String, bool)> {
        if let Some(json) = args.str_at(0) {
            return Some((json.to_owned(), args.bool_at(1).unwrap_or(false)));
        }
        let mut object = args.obj_at(0)?.clone();
        // main: `t._optional ? delete t._optional : K()`
        let optional = match object.get("_optional") {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
            _ => false,
        };
        if optional {
            object.remove("_optional");
        }
        serde_json::to_string(&Value::Object(object)).ok().map(|j| (j, optional))
    }

    /// Account change: stop the helper and forget everything addressed to the previous account.
    pub fn reset(&self) {
        let mut st = self.state.lock();
        st.restart_after_exit = false;
        st.init_json = None;
        st.pending.clear();
        st.generation += 1;
        if let Some(old) = st.process.take() {
            // Invalidate the pending exit callback: a new login may start a fresh helper right away.
            st.process_token += 1;
            st.started = false;
            old.terminate();
            if let Some(s) = &st.recv_server {
                s.disconnect_all();
            }
            if let Some(s) = &st.send_server {
                s.disconnect_all();
            }
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if old.is_running() {
                    old.force_kill();
                }
            });
        }
        Self::reset_connection_state(&mut st);
    }

    /// App quit (`stop()` in main): kill the helper, close the servers, remove the socket directory.
    pub fn shutdown(&self) {
        let mut st = self.state.lock();
        st.shut_down = true;
        st.restart_after_exit = false;
        if let Some(p) = st.process.take() {
            if p.is_running() {
                // SIGTERM, up to ~1 s of grace, then SIGKILL.
                p.terminate();
                for _ in 0..20 {
                    if !p.is_running() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                if p.is_running() {
                    p.force_kill();
                }
            }
        }
        if let Some(s) = st.recv_server.take() {
            s.stop();
        }
        if let Some(s) = st.send_server.take() {
            s.stop();
        }
        if let Some(dir) = st.socket_dir.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // ---- Helper process (`K()`) ----

    fn start_native(&self, st: &mut State) {
        if st.shut_down {
            return;
        }
        if st.started {
            self.log("call: native already started");
            return;
        }
        let Some(executable) = self.cfg.executable.clone().filter(|e| is_executable(e)) else {
            self.fail(
                st,
                "Không tìm thấy trình gọi của Zalo (ZaloHelper.app/Contents/MacOS/ZaloCall). Hãy mở lại ứng dụng để cài lại.".into(),
            );
            return;
        };
        // A ZaloCall left behind by a crashed Compola (its argv points into our dead socket directory).
        if !st.reaped_orphans {
            st.reaped_orphans = true;
            (self.cfg.reap_orphans)();
        }
        // Only ever run a helper that is validly signed by Zalo's publisher.
        if let Err(reason) = (self.cfg.verify)(&executable) {
            self.fail(st, reason);
            return;
        }
        st.started = true;
        st.generation += 1;
        let spawned = self.prepare_sockets(st).and_then(|_| {
            st.process_token += 1;
            let token = st.process_token;
            let me = self.me.clone();
            let on_exit: ExitFn = Box::new(move |status| {
                if let Some(bridge) = me.upgrade() {
                    bridge.process_exited(token, status);
                }
            });
            (self.cfg.spawn)(&st.recv_path, &st.send_path, on_exit)
        });
        match spawned {
            Ok(process) => {
                let pid = process.pid();
                st.process = Some(process);
                st.last_unavailable = None;
                self.log("call: native started");
                (self.cfg.on_event)(CallEvent::HelperStarted { pid });
            }
            Err(e) => {
                st.started = false;
                self.fail(st, format!("Không khởi động được trình gọi: {e}"));
            }
        }
    }

    fn fail(&self, st: &mut State, reason: String) {
        self.log("call: helper unavailable");
        if st.last_unavailable.as_deref() == Some(reason.as_str()) {
            return;
        }
        st.last_unavailable = Some(reason.clone());
        (self.cfg.on_event)(CallEvent::HelperUnavailable { reason });
    }

    fn process_exited(&self, token: u64, status: i32) {
        let mut st = self.state.lock();
        if st.process_token != token {
            return;
        }
        self.log(&format!("call: native exit {status}"));
        st.process = None;
        st.started = false;
        Self::reset_connection_state(&mut st);
        (self.cfg.emit)("call-update", vec![json!("callState"), json!({ "state": "free" })]);
        (self.cfg.on_event)(CallEvent::Exited { status });
        if st.restart_after_exit {
            st.restart_after_exit = false;
            self.log("call: native restart");
            self.start_native(&mut st);
        }
    }

    // ---- Sockets ----

    fn prepare_sockets(&self, st: &mut State) -> Result<(), String> {
        if st.recv_server.is_some() && st.send_server.is_some() {
            return Ok(());
        }
        let dir = helper::make_socket_directory(&self.cfg.socket_base)?;
        st.recv_path = dir.join("recv").to_string_lossy().into_owned();
        st.send_path = dir.join("send").to_string_lossy().into_owned();
        st.socket_dir = Some(dir);
        let me = self.me.clone();
        let recv = Arc::new(UnixSocketServer::new(
            &st.recv_path,
            Arc::new(move |e| {
                if let Some(b) = me.upgrade() {
                    b.recv_event(e);
                }
            }),
        ));
        let me = self.me.clone();
        let send = Arc::new(UnixSocketServer::new(
            &st.send_path,
            Arc::new(move |e| {
                if let Some(b) = me.upgrade() {
                    b.send_event(e);
                }
            }),
        ));
        recv.start()?;
        if let Err(e) = send.start() {
            recv.stop();
            return Err(e);
        }
        st.recv_server = Some(recv);
        st.send_server = Some(send);
        Ok(())
    }

    fn recv_event(&self, event: ServerEvent) {
        let mut st = self.state.lock();
        match event {
            ServerEvent::Connect(id) => {
                st.decoders.insert(id, FrameDecoder::default());
                let generation = st.generation;
                st.recv_generations.insert(id, generation);
                self.log("call: recv connection");
            }
            ServerEvent::Data(id, data) => {
                // Late bytes of a previous helper's connection are stale.
                if st.recv_generations.get(&id) == Some(&st.generation) {
                    self.received(&mut st, &data, id);
                }
            }
            ServerEvent::End(id) => {
                st.decoders.remove(&id);
                let ended = st.recv_generations.remove(&id);
                self.log("call: recv end");
                // A connection of a previous helper going away says nothing about the current one.
                if ended != Some(st.generation) {
                    return;
                }
                // Another connection of this helper may remain: only the last one going away resets.
                let generation = st.generation;
                if !st.recv_generations.values().any(|g| *g == generation) {
                    Self::reset_connection_state(&mut st);
                }
                (self.cfg.emit)("call-update", vec![json!("callState"), json!({ "state": "free" })]);
            }
        }
    }

    fn send_event(&self, event: ServerEvent) {
        let mut st = self.state.lock();
        match event {
            ServerEvent::Connect(id) => {
                self.log("call: send connection");
                let generation = st.generation;
                st.send_generations.insert(id, generation);
                st.send_connection = Some(id);
                // A new connection starts clean: nothing half-sent to a previous helper.
                st.awaiting_ack = false;
                st.chunk_queue.clear();
                self.flush_if_ready(&mut st);
            }
            ServerEvent::Data(id, _) => {
                // Only the helper currently on the send socket acknowledges chunks.
                if st.send_connection == Some(id) {
                    st.awaiting_ack = false;
                    Self::pump(&mut st);
                }
            }
            ServerEvent::End(id) => {
                let ended = st.send_generations.remove(&id);
                if st.send_connection != Some(id) || ended != Some(st.generation) {
                    return;
                }
                self.log("call: send end");
                Self::reset_connection_state(&mut st);
                (self.cfg.emit)("call-update", vec![json!("callState"), json!({ "state": "free" })]);
            }
        }
    }

    // ---- main → helper ----

    /// Official `O`: before the helper connects to the send socket messages wait (and go out on `native-ready`, after
    /// the init data); once connected they are sent immediately.
    fn deliver(&self, st: &mut State, json: String) {
        if st.send_connection.is_some() {
            self.transmit(st, &json);
        } else {
            st.pending.push_back(json);
            while st.pending.len() > MAX_PENDING {
                st.pending.pop_front();
            }
        }
    }

    /// `G(e, t)`: encrypt, split, queue, send one chunk.
    fn transmit(&self, st: &mut State, json: &str) {
        let Some(hex) = transport::encrypt(json, &self.cfg.key) else {
            self.log("call: encrypt failed");
            return;
        };
        let chunks = st.chunker.chunks(&hex);
        st.chunk_queue.extend(chunks);
        Self::pump(st);
    }

    /// `W(e)`: one chunk at a time; the next goes out when the helper writes something back.
    fn pump(st: &mut State) {
        let (Some(id), Some(server)) = (st.send_connection, st.send_server.clone()) else { return };
        if st.awaiting_ack {
            return;
        }
        let Some(chunk) = st.chunk_queue.pop_front() else { return };
        st.awaiting_ack = true;
        server.write(chunk.into_bytes(), id);
    }

    /// `native-ready`: send the init data first, then everything that was waiting.
    fn flush_if_ready(&self, st: &mut State) {
        if !st.native_ready || st.send_connection.is_none() || st.flushed_for_ready {
            return;
        }
        st.flushed_for_ready = true;
        if let Some(init) = st.init_json.clone() {
            self.log("call: sending init data");
            self.transmit(st, &init);
        }
        let queued: Vec<String> = st.pending.drain(..).collect();
        for json in queued {
            self.transmit(st, &json);
        }
    }

    /// `H()`: the connection (and anything half-sent) is gone; queued messages stay for the next helper.
    fn reset_connection_state(st: &mut State) {
        st.send_connection = None;
        st.native_ready = false;
        st.flushed_for_ready = false;
        st.awaiting_ack = false;
        st.chunk_queue.clear();
    }

    // ---- helper → main (`Y` / `z`) ----

    fn received(&self, st: &mut State, data: &[u8], id: u64) {
        let mut dropped = 0;
        let messages = st.decoders.entry(id).or_default().feed(data, &self.cfg.key, &mut dropped);
        if dropped > 0 {
            st.dropped_frames += dropped;
            self.log(&format!("call: cannot parse payload ×{dropped}"));
        }
        for m in messages {
            self.route(st, m);
        }
    }

    fn route(&self, st: &mut State, message: serde_json::Map<String, Value>) {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        // `command` is a string for most messages but a number for `sendSignal` (401, 402, …): passed on as is.
        let raw_command = message.get("command").cloned();
        let command = raw_command.as_ref().and_then(Value::as_str);
        let data = message.get("data").cloned().unwrap_or_else(undef);
        let name = raw_command.clone().unwrap_or_else(undef);
        let command_text = match &raw_command {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => String::new(),
        };
        self.log(&format!("call: native → {kind}/{}", if raw_command.is_some() { command_text.as_str() } else { "-" }));
        match kind {
            "update" => {
                if command == Some("native-ready") {
                    st.native_ready = true;
                    st.flushed_for_ready = false;
                    (self.cfg.on_event)(CallEvent::Ready);
                    self.flush_if_ready(st);
                } else {
                    (self.cfg.emit)("call-update", vec![name, data]);
                    if command == Some("callState") {
                        if let Some(state) = message.get("data").and_then(|d| d.get("state")).and_then(Value::as_str) {
                            (self.cfg.on_event)(CallEvent::CallState { state: state.to_owned() });
                        }
                    }
                }
            }
            "sendSignal" => (self.cfg.emit)("call-send-signal", vec![name, data]),
            "request" => {
                if command == Some("killMe") {
                    let Some(process) = st.process.clone() else { return };
                    st.restart_after_exit = true;
                    process.interrupt();
                    self.log("call: kill native");
                    self.escalate(process);
                } else {
                    (self.cfg.emit)("call-request", vec![name, data]);
                    if command == Some("popup") {
                        if let Some(body) = message.get("data").and_then(Value::as_object) {
                            let s = |k: &str| body.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
                            (self.cfg.on_event)(CallEvent::Popup { header: s("header"), content: s("content") });
                        }
                    }
                }
            }
            "response" => {
                let suffix = if raw_command.is_some() { command_text } else { "undefined".into() };
                (self.cfg.emit)(&format!("call-response-{suffix}"), vec![data]);
            }
            _ => {}
        }
    }

    /// SIGINT is a polite request; make sure the helper really goes (and restarts).
    fn escalate(&self, target: Arc<dyn CallProcess>) {
        let me = self.me.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let current = me.upgrade().is_some_and(|b| b.state.lock().process.as_ref().is_some_and(|p| same_process(p, &target)));
            if !current || !target.is_running() {
                return;
            }
            target.terminate();
            tokio::time::sleep(Duration::from_secs(2)).await;
            if target.is_running() {
                target.force_kill();
            }
        });
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------------------

/// The bridge, created on first use.
#[derive(Default)]
struct Slot(Mutex<Option<Arc<CallBridge>>>);

fn production(app: &AppHandle) -> Arc<CallBridge> {
    let executable = helper_executable(&crate::runtime::candidate());
    let reap_target = executable.clone();
    let emit_app = app.clone();
    let event_app = app.clone();
    CallBridge::new(Config {
        executable: Some(executable),
        socket_base: std::env::temp_dir(),
        key: transport::default_key(),
        spawn: Box::new(|recv, send, on_exit| {
            let exe = helper_executable(&crate::runtime::candidate());
            helper::SystemCallProcess::launch(&exe, &[recv, send], on_exit)
        }),
        verify: Box::new(|exe| helper::verify_signature(exe, helper::REQUIREMENT)),
        reap_orphans: Box::new(move || {
            helper::reap_orphans(&reap_target);
        }),
        emit: Box::new(move |channel, args| {
            if let Some(host) = emit_app.state::<Hosts>().get(crate::main_process::MAIN_LABEL) {
                host.send(channel, args);
            }
        }),
        log: Box::new(|line| log::info!("{line}")),
        on_event: Box::new(move |e| emit_ui(&event_app, "compola://call-event", e)),
    })
}

fn bridge(app: &AppHandle) -> Arc<CallBridge> {
    if app.try_state::<Slot>().is_none() {
        app.manage(Slot::default());
    }
    app.state::<Slot>().0.lock().get_or_insert_with(|| production(app)).clone()
}

pub fn install(app: &AppHandle, reg: &mut Registry) {
    if app.try_state::<Slot>().is_none() {
        app.manage(Slot::default());
    }
    let a = app.clone();
    reg.handle("call-send-to-native", move |_, args| {
        if let Some((json, optional)) = CallBridge::decode(&args) {
            bridge(&a).send_to_native(json, optional);
        }
        async { Ok(undef()) }
    });
    let a = app.clone();
    reg.handle("call-init", move |_, args| {
        bridge(&a).set_init(CallBridge::decode(&args).map(|(json, _)| json));
        async { Ok(undef()) }
    });
}

/// What the call UI needs to know about the native helper right now (its events sent before the UI subscribed are lost).
#[tauri::command]
pub fn calls_status(app: AppHandle) -> serde_json::Value {
    let installed = is_executable(&helper_executable(&crate::runtime::candidate()));
    let current = app.try_state::<Slot>().and_then(|s| s.0.lock().clone());
    let (running, pid, ready) = current.map(|b| (b.started(), b.helper_pid(), b.native_ready())).unwrap_or((false, None, false));
    serde_json::json!({
        "helperInstalled": installed,
        "running": running,
        "pid": pid,
        "problem": (!installed).then_some("Không tìm thấy ZaloCall trong bộ cài Zalo. Hãy mở lại Compola để cài lại."),
        "nativeState": if ready { Some("ready") } else if running { Some("starting") } else { None },
    })
}

/// "Mở cửa sổ cuộc gọi": brings the running ZaloCall helper to the front.
#[tauri::command]
pub fn call_show_window(app: AppHandle) -> Result<(), String> {
    let pid = app.try_state::<Slot>().and_then(|s| s.0.lock().as_ref().and_then(|b| b.helper_pid())).ok_or("Không có cuộc gọi nào đang diễn ra.")?;
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid).ok_or("Cửa sổ cuộc gọi đã đóng.")?;
        app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
    }
    Ok(())
}

/// Logout / account switch (to be called from `MainProcess::reset_account_state`).
#[allow(dead_code)]
pub fn reset(app: &AppHandle) {
    if let Some(slot) = app.try_state::<Slot>() {
        if let Some(b) = slot.0.lock().as_ref() {
            b.reset();
        }
    }
}

/// App exit: the helper does not outlive the app.
pub fn shutdown(app: &AppHandle) {
    if let Some(slot) = app.try_state::<Slot>() {
        if let Some(b) = slot.0.lock().take() {
            b.shutdown();
        }
    }
}

#[cfg(test)]
mod tests;
