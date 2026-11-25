//! One add-on = one QuickJS runtime on its own OS thread. The thread owns the runtime; everything reaches it through a
//! [`Mailbox`] (control messages are never dropped; events are bounded and the oldest is dropped when an add-on falls
//! behind). Everything the add-on asks for goes out through a [`Bridge`] and comes back as a `reply`.
//!
//! Isolation: QuickJS has no I/O of its own; the only ways out are the natives registered here (`__n_*`), which the
//! host checks against the manifest's permissions. Each turn (one delivery plus the promise jobs it causes) has a CPU
//! budget (`limits.timeoutMs`): the interrupt handler stops a runaway loop with an uncatchable exception and the
//! runtime is torn down ([`Exit::Crashed`]) for the supervisor to restart. Memory is capped with QuickJS's allocator
//! limit (`limits.memoryMb`).

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use rquickjs::{Context, Ctx, Function, Runtime, Value as JsValue};
use serde_json::{Value, json};

const PRELUDE: &str = include_str!("prelude.js");
/// Calls an add-on may have waiting for the host at once.
const MAX_IN_FLIGHT: usize = 256;
const MAX_TIMERS: usize = 10_000;
const MIN_INTERVAL_MS: u64 = 50;
const MAX_ASSET_BYTES: u64 = 5 * 1024 * 1024;
/// How long `unload` may run when an add-on is stopped.
const UNLOAD_BUDGET_MS: u64 = 1000;

/// What the host delivers to an add-on.
#[derive(Debug)]
pub enum Inbound {
    Reply { id: u64, ok: bool, value: Value },
    Settings(Value),
    Event { name: String, data: Value },
    ToolCall { request_id: String, tool: String, args: Value },
    /// A view called its add-on (`compola.call(name, data)` in the view).
    ViewCall { request_id: String, name: String, data: Value, context: Value },
}

#[derive(Default)]
struct State {
    control: VecDeque<Inbound>,
    events: VecDeque<Inbound>,
    stopped: bool,
}

/// The add-on thread's inbox.
pub struct Mailbox {
    state: Mutex<State>,
    cv: Condvar,
    capacity: usize,
    pub dropped: AtomicU64,
}

impl Mailbox {
    pub fn new(capacity: usize) -> Arc<Self> {
        Arc::new(Self { state: Mutex::default(), cv: Condvar::new(), capacity: capacity.max(1), dropped: AtomicU64::new(0) })
    }

    /// Replies, settings and tool calls: always delivered (while running).
    pub fn control(&self, msg: Inbound) {
        let mut s = self.state.lock();
        if !s.stopped {
            s.control.push_back(msg);
            self.cv.notify_one();
        }
    }

    /// An event; when the queue is full the oldest event is dropped (counted in `dropped`). False when stopped.
    pub fn event(&self, msg: Inbound) -> bool {
        let mut s = self.state.lock();
        if s.stopped {
            return false;
        }
        if s.events.len() >= self.capacity {
            s.events.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        s.events.push_back(msg);
        self.cv.notify_one();
        true
    }

    pub fn stop(&self) {
        let mut s = self.state.lock();
        s.stopped = true;
        self.cv.notify_one();
    }

    pub fn backlog(&self) -> usize {
        self.state.lock().events.len()
    }

    /// Waits until something arrives or `timeout` passes; control first, then at most a few events (so replies are never
    /// stuck behind a burst). None = stop.
    fn take(&self, timeout: Option<Duration>) -> Option<Vec<Inbound>> {
        let mut s = self.state.lock();
        if s.control.is_empty() && s.events.is_empty() && !s.stopped {
            match timeout {
                Some(t) => {
                    self.cv.wait_for(&mut s, t);
                }
                None => self.cv.wait(&mut s),
            }
        }
        if s.stopped {
            return None;
        }
        let mut out: Vec<Inbound> = s.control.drain(..).collect();
        for _ in 0..16 {
            match s.events.pop_front() {
                Some(e) => out.push(e),
                None => break,
            }
        }
        Some(out)
    }
}

/// What an add-on sends out.
pub trait Bridge: Send + Sync + 'static {
    /// An async API call; answer with `Inbound::Reply { id, … }`.
    fn call(&self, addon: &str, id: u64, method: String, args: Value);
    fn log(&self, addon: &str, level: &str, text: String);
    fn subscribe(&self, addon: &str, events: Vec<String>);
    fn tools(&self, addon: &str, tools: Vec<Value>);
    fn tool_result(&self, request_id: String, ok: bool, result: Value);
    fn view_result(&self, request_id: String, ok: bool, result: Value);
}

/// Live counters, read by the host for Settings.
#[derive(Default)]
pub struct Stats {
    pub turns: AtomicU64,
    pub events: AtomicU64,
    pub calls: AtomicU64,
    pub errors: AtomicU64,
    pub busy_us: AtomicU64,
    pub memory: AtomicU64,
    pub in_flight: AtomicU64,
}

pub struct Spec {
    pub id: String,
    pub source: String,
    pub main: String,
    pub folder: PathBuf,
    pub manifest: Value,
    pub settings: Value,
    pub storage: Value,
    pub memory_bytes: usize,
    pub timeout_ms: u64,
}

#[derive(Debug, PartialEq)]
pub enum Exit {
    Stopped,
    Crashed(String),
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn exception_text(ctx: &Ctx<'_>) -> String {
    let v = ctx.catch();
    if let Some(ex) = v.as_exception() {
        let msg = ex.message().unwrap_or_default();
        return ex.stack().filter(|s| !s.is_empty()).map(|s| format!("{msg}\n{s}")).unwrap_or(msg);
    }
    if let Some(s) = v.as_string().and_then(|s| s.to_string().ok()) {
        return s;
    }
    format!("{v:?}")
}

fn reason_text(v: &JsValue<'_>) -> String {
    if let Some(ex) = v.as_exception() {
        let msg = ex.message().unwrap_or_default();
        return ex.stack().filter(|s| !s.is_empty()).map(|s| format!("{msg}\n{s}")).unwrap_or(msg);
    }
    v.as_string().and_then(|s| s.to_string().ok()).unwrap_or_else(|| format!("{v:?}"))
}

/// Runs the add-on until it is stopped or crashes. Blocking: call on the add-on's own thread.
pub fn run(spec: Spec, mailbox: Arc<Mailbox>, bridge: Arc<dyn Bridge>, stats: Arc<Stats>) -> Exit {
    let id = spec.id.clone();
    let rt = match Runtime::new() {
        Ok(rt) => rt,
        Err(e) => return Exit::Crashed(format!("không tạo được runtime: {e}")),
    };
    rt.set_memory_limit(spec.memory_bytes);
    rt.set_max_stack_size(1024 * 1024);
    rt.set_gc_threshold((spec.memory_bytes / 4).max(1024 * 1024));

    // CPU budget per turn: the deadline is set before each entry into JS.
    let deadline = Arc::new(AtomicI64::new(i64::MAX));
    let interrupted = Rc::new(Cell::new(false));
    {
        let (deadline, interrupted) = (deadline.clone(), interrupted.clone());
        rt.set_interrupt_handler(Some(Box::new(move || {
            if now_ms() > deadline.load(Ordering::Relaxed) {
                interrupted.set(true);
                true
            } else {
                false
            }
        })));
    }
    {
        let (bridge, id, stats) = (bridge.clone(), id.clone(), stats.clone());
        rt.set_host_promise_rejection_tracker(Some(Box::new(move |_ctx, _promise, reason, handled| {
            if !handled {
                stats.errors.fetch_add(1, Ordering::Relaxed);
                bridge.log(&id, "error", format!("promise bị từ chối mà không được xử lý: {}", reason_text(&reason)));
            }
        })));
    }
    let ctx = match Context::full(&rt) {
        Ok(c) => c,
        Err(e) => return Exit::Crashed(format!("không tạo được context: {e}")),
    };

    // Timers: id → (due, interval for setInterval).
    let timers: Rc<RefCell<BTreeMap<u64, (Instant, Option<Duration>)>>> = Rc::default();
    let in_flight = Rc::new(Cell::new(0usize));

    let setup = ctx.with(|ctx| -> Result<(), String> {
        let globals = ctx.globals();
        let js = |e: rquickjs::Error| e.to_string();
        {
            let (bridge, id) = (bridge.clone(), id.clone());
            let f = Function::new(ctx.clone(), move |kind: String, payload: String| {
                let data: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
                match kind.as_str() {
                    "log" => {
                        let level = data.get("level").and_then(Value::as_str).unwrap_or("info").to_owned();
                        let text = data.get("text").and_then(Value::as_str).unwrap_or_default().chars().take(4000).collect();
                        bridge.log(&id, &level, text);
                    }
                    "subscribe" => {
                        let names = data.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
                        bridge.subscribe(&id, names);
                    }
                    "tools" => bridge.tools(&id, data.as_array().cloned().unwrap_or_default()),
                    "viewResult" => bridge.view_result(
                        data.get("requestId").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        data.get("ok").and_then(Value::as_bool).unwrap_or(false),
                        data.get("result").cloned().unwrap_or(Value::Null),
                    ),
                    "toolResult" => bridge.tool_result(
                        data.get("requestId").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        data.get("ok").and_then(Value::as_bool).unwrap_or(false),
                        data.get("result").cloned().unwrap_or(Value::Null),
                    ),
                    _ => {}
                }
            })
            .map_err(js)?;
            globals.set("__n_post", f).map_err(js)?;
        }
        {
            let (bridge, id, stats, in_flight) = (bridge.clone(), id.clone(), stats.clone(), in_flight.clone());
            let f = Function::new(ctx.clone(), move |call: f64, method: String, args: String| -> bool {
                if in_flight.get() >= MAX_IN_FLIGHT {
                    return false;
                }
                in_flight.set(in_flight.get() + 1);
                stats.in_flight.store(in_flight.get() as u64, Ordering::Relaxed);
                stats.calls.fetch_add(1, Ordering::Relaxed);
                let args: Value = serde_json::from_str(&args).unwrap_or(Value::Array(Vec::new()));
                bridge.call(&id, call as u64, method, args);
                true
            })
            .map_err(js)?;
            globals.set("__n_call", f).map_err(js)?;
        }
        {
            let timers = timers.clone();
            let f = Function::new(ctx.clone(), move |timer: f64, ms: f64, repeat: bool| -> rquickjs::Result<()> {
                let mut t = timers.borrow_mut();
                if t.len() >= MAX_TIMERS {
                    return Ok(());
                }
                let ms = if ms.is_finite() { ms.max(0.0) as u64 } else { 0 };
                let interval = repeat.then(|| Duration::from_millis(ms.max(MIN_INTERVAL_MS)));
                let first = interval.unwrap_or(Duration::from_millis(ms));
                t.insert(timer as u64, (Instant::now() + first, interval));
                Ok(())
            })
            .map_err(js)?;
            globals.set("__n_timer", f).map_err(js)?;
        }
        {
            let timers = timers.clone();
            let f = Function::new(ctx.clone(), move |timer: f64| {
                timers.borrow_mut().remove(&(timer as u64));
            })
            .map_err(js)?;
            globals.set("__n_clear", f).map_err(js)?;
        }
        {
            let folder = spec.folder.clone();
            let f = Function::new(ctx.clone(), move |path: String| -> Option<String> {
                if path.split('/').any(|p| p == ".." || p.starts_with('.')) || path.starts_with('/') {
                    return None;
                }
                let p = folder.join(&path);
                let meta = std::fs::symlink_metadata(&p).ok()?;
                if !meta.is_file() || meta.len() > MAX_ASSET_BYTES {
                    return None;
                }
                std::fs::read_to_string(p).ok()
            })
            .map_err(js)?;
            globals.set("__n_read", f).map_err(js)?;
        }
        ctx.eval::<(), _>(PRELUDE).map_err(|_| format!("prelude: {}", exception_text(&ctx)))?;
        let init = json!({ "t": "init", "manifest": spec.manifest, "settings": spec.settings, "storage": spec.storage });
        let input: Function = globals.get("__in").map_err(js)?;
        input.call::<_, ()>((init.to_string(),)).map_err(|_| exception_text(&ctx))?;
        Ok(())
    });
    if let Err(e) = setup {
        return Exit::Crashed(e);
    }

    let budget = Duration::from_millis(spec.timeout_ms);
    // One turn: run `f` in JS, then the promise jobs it queued, inside the CPU budget.
    let turn = |what: &str, f: &dyn Fn(&Ctx<'_>) -> rquickjs::Result<()>, limit: Duration| -> Result<(), String> {
        let started = Instant::now();
        deadline.store(now_ms() + limit.as_millis() as i64, Ordering::Relaxed);
        let result = ctx.with(|ctx| match f(&ctx) {
            Ok(()) => Ok(()),
            Err(rquickjs::Error::Exception) => Err(exception_text(&ctx)),
            Err(e) => Err(e.to_string()),
        });
        let mut outcome = result;
        if outcome.is_ok() || !interrupted.get() {
            loop {
                match rt.execute_pending_job() {
                    Ok(true) => continue,
                    Ok(false) => break,
                    Err(job) => {
                        let text = job.0.with(|ctx| exception_text(&ctx));
                        if interrupted.get() {
                            outcome = Err(text);
                            break;
                        }
                        stats.errors.fetch_add(1, Ordering::Relaxed);
                        bridge.log(&id, "error", format!("lỗi: {text}"));
                    }
                }
            }
        }
        deadline.store(i64::MAX, Ordering::Relaxed);
        stats.turns.fetch_add(1, Ordering::Relaxed);
        stats.busy_us.fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        if interrupted.get() {
            return Err(format!("{what}: chạy quá {} ms mà không dừng (vòng lặp vô hạn?)", limit.as_millis()));
        }
        if let Err(e) = outcome {
            stats.errors.fetch_add(1, Ordering::Relaxed);
            bridge.log(&id, "error", format!("{what}: {e}"));
        }
        Ok(())
    };
    let deliver = |msg: Value| -> Box<dyn Fn(&Ctx<'_>) -> rquickjs::Result<()>> {
        let text = msg.to_string();
        Box::new(move |ctx: &Ctx<'_>| {
            let input: Function = ctx.globals().get("__in")?;
            input.call::<_, ()>((text.clone(),))
        })
    };

    // The add-on's own code: inside a function, so its top-level declarations stay its own.
    let main = format!("(function __addonMain() {{\n{}\n}})();\n//# sourceURL={}", spec.source, spec.main);
    if let Err(e) = turn("khởi động", &|ctx: &Ctx<'_>| ctx.eval::<(), _>(main.as_bytes()), budget) {
        return Exit::Crashed(e);
    }
    if let Err(e) = turn("ready", &*deliver(json!({ "t": "event", "name": "ready", "data": null })), budget) {
        return Exit::Crashed(e);
    }

    let memory_limit = spec.memory_bytes as i64;
    loop {
        let next_timer = timers.borrow().values().map(|t| t.0).min();
        let wait = next_timer.map(|due| due.saturating_duration_since(Instant::now()));
        let Some(batch) = mailbox.take(wait) else {
            let _ = turn("unload", &*deliver(json!({ "t": "event", "name": "unload", "data": null })), Duration::from_millis(UNLOAD_BUDGET_MS));
            return Exit::Stopped;
        };
        for msg in batch {
            let (what, payload) = match msg {
                Inbound::Reply { id: call, ok, value } => {
                    in_flight.set(in_flight.get().saturating_sub(1));
                    stats.in_flight.store(in_flight.get() as u64, Ordering::Relaxed);
                    let payload = if ok {
                        json!({ "t": "reply", "id": call, "ok": true, "value": value })
                    } else {
                        json!({ "t": "reply", "id": call, "ok": false, "error": value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()) })
                    };
                    ("reply", payload)
                }
                Inbound::Settings(settings) => ("settings", json!({ "t": "settings", "settings": settings })),
                Inbound::Event { name, data } => {
                    stats.events.fetch_add(1, Ordering::Relaxed);
                    ("event", json!({ "t": "event", "name": name, "data": data }))
                }
                Inbound::ToolCall { request_id, tool, args } => ("tool", json!({ "t": "toolCall", "requestId": request_id, "tool": tool, "args": args })),
                Inbound::ViewCall { request_id, name, data, context } => {
                    ("view", json!({ "t": "viewCall", "requestId": request_id, "name": name, "data": data, "context": context }))
                }
            };
            if let Err(e) = turn(what, &*deliver(payload), budget) {
                return Exit::Crashed(e);
            }
        }
        // Due timers (an interval is rescheduled before it runs, so clearInterval inside it wins).
        let now = Instant::now();
        let due: Vec<u64> = timers.borrow().iter().filter(|(_, t)| t.0 <= now).map(|(id, _)| *id).collect();
        for timer in due {
            {
                let mut t = timers.borrow_mut();
                match t.get(&timer).and_then(|x| x.1) {
                    Some(interval) => {
                        t.insert(timer, (now + interval, Some(interval)));
                    }
                    None => {
                        t.remove(&timer);
                    }
                }
            }
            if let Err(e) = turn("timer", &*deliver(json!({ "t": "timer", "id": timer })), budget) {
                return Exit::Crashed(e);
            }
        }
        let used = rt.memory_usage().malloc_size;
        stats.memory.store(used.max(0) as u64, Ordering::Relaxed);
        if used > memory_limit * 9 / 10 {
            rt.run_gc();
            let used = rt.memory_usage().malloc_size;
            if used > memory_limit * 9 / 10 {
                return Exit::Crashed(format!("dùng quá nhiều bộ nhớ ({} MB / {} MB)", used / 1024 / 1024, memory_limit / 1024 / 1024));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// Answers `echo` with its args and `fail` with an error; records logs.
    struct TestBridge {
        mailbox: Mutex<Option<Arc<Mailbox>>>,
        logs: mpsc::Sender<String>,
        subs: Mutex<Vec<String>>,
    }

    impl Bridge for TestBridge {
        fn call(&self, _addon: &str, id: u64, method: String, args: Value) {
            let mb = self.mailbox.lock().clone().unwrap();
            let (ok, value) = match method.as_str() {
                "echo" => (true, args),
                "fail" => (false, json!("nope")),
                // A permission the test add-on lacks, as the host would answer.
                "sendText" => (false, json!("add-on chưa khai báo quyền \"messages:send\"")),
                "activeConversations" => (true, json!([{ "id": "u1", "name": "An", "count": 4, "lastDate": 1 }])),
                _ => (true, Value::Null),
            };
            std::thread::spawn(move || mb.control(Inbound::Reply { id, ok, value }));
        }
        fn log(&self, _addon: &str, level: &str, text: String) {
            let _ = self.logs.send(format!("{level}: {text}"));
        }
        fn subscribe(&self, _addon: &str, events: Vec<String>) {
            *self.subs.lock() = events;
        }
        fn tools(&self, _addon: &str, _tools: Vec<Value>) {}
        fn tool_result(&self, request_id: String, ok: bool, result: Value) {
            let _ = self.logs.send(format!("tool {request_id} {ok} {result}"));
        }
        fn view_result(&self, request_id: String, ok: bool, result: Value) {
            let _ = self.logs.send(format!("view {request_id} {ok} {result}"));
        }
    }

    fn spec(source: &str, timeout_ms: u64, memory_mb: usize) -> Spec {
        Spec {
            id: "t".into(),
            source: source.into(),
            main: "main.js".into(),
            folder: std::env::temp_dir(),
            manifest: json!({ "id": "t", "name": "T", "permissions": ["messages:read"] }),
            settings: json!({ "greeting": "chào" }),
            storage: json!({ "n": 1 }),
            memory_bytes: memory_mb * 1024 * 1024,
            timeout_ms,
        }
    }

    fn start(source: &str, timeout_ms: u64, memory_mb: usize) -> (Arc<Mailbox>, mpsc::Receiver<String>, std::thread::JoinHandle<Exit>, Arc<TestBridge>) {
        let (tx, rx) = mpsc::channel();
        let mailbox = Mailbox::new(4);
        let bridge = Arc::new(TestBridge { mailbox: Mutex::new(Some(mailbox.clone())), logs: tx, subs: Mutex::default() });
        let (mb, br) = (mailbox.clone(), bridge.clone());
        let s = spec(source, timeout_ms, memory_mb);
        let handle = std::thread::spawn(move || run(s, mb, br, Arc::default()));
        (mailbox, rx, handle, bridge)
    }

    fn wait_for(rx: &mpsc::Receiver<String>, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) {
                if line.contains(needle) {
                    return line;
                }
            }
        }
        panic!("no log containing {needle:?}");
    }

    /// Answers every API with plausible data, like a busy shop account.
    struct SmokeBridge {
        mailbox: Arc<Mailbox>,
        logs: mpsc::Sender<String>,
    }

    impl Bridge for SmokeBridge {
        fn call(&self, _addon: &str, id: u64, method: String, args: Value) {
            let now = chrono::Utc::now().timestamp_millis();
            let msgs = json!([
                { "id": "m1", "conversationId": "u1", "conversationName": "Chị An", "senderName": "Chị An", "fromMe": false,
                  "text": "Shop ơi cho mình 2 áo thun size M màu trắng, giao 12 Lê Lợi Q1, sđt 0901234567", "date": now - 600_000 },
                { "id": "m2", "conversationId": "u1", "conversationName": "Chị An", "senderName": "Shop", "fromMe": true,
                  "text": "Dạ shop gửi chị 2 áo 350k ạ", "date": now - 300_000 },
                { "id": "m3", "conversationId": "u1", "conversationName": "Chị An", "senderName": "Chị An", "fromMe": false,
                  "text": "Sao lâu vậy shop, mình đợi mãi", "date": now - 60_000 },
            ]);
            let value = match method.as_str() {
                "conversations" => json!([{ "id": "u1", "name": "Chị An", "isGroup": false, "unread": 1, "account": "acc" },
                                          { "id": "g1", "name": "Nhóm sỉ", "isGroup": true, "unread": 0, "account": "acc" }]),
                "messages" | "history" => msgs,
                "activeConversations" => json!([{ "id": "u1", "name": "Chị An", "isGroup": false, "count": 3, "lastDate": now, "account": "acc" }]),
                "search" => json!([]),
                "accounts" => json!([{ "id": "acc", "name": "Shop", "phone": "0900000000" }]),
                "aiAvailable" => json!(true),
                "aiComplete" => json!({ "text": "{}", "json": {}, "model": "test", "usage": { "inputTokens": 1, "outputTokens": 1 } }),
                "notesList" => json!([]),
                "notesAdd" | "suggest" => json!("n1"),
                "fetch" => json!({ "status": 200, "statusText": "OK", "url": args[0], "headers": {}, "body": "{}" }),
                "schedulesList" | "mcpServers" | "mcpTools" => json!([]),
                "scheduleSave" => json!({ "id": "j1" }),
                _ => Value::Null,
            };
            let mb = self.mailbox.clone();
            std::thread::spawn(move || mb.control(Inbound::Reply { id, ok: true, value }));
        }
        fn log(&self, addon: &str, level: &str, text: String) {
            let _ = self.logs.send(format!("{addon} {level}: {text}"));
        }
        fn subscribe(&self, _addon: &str, _events: Vec<String>) {}
        fn tools(&self, _addon: &str, _tools: Vec<Value>) {}
        fn tool_result(&self, _request_id: String, _ok: bool, _result: Value) {}
        fn view_result(&self, request_id: String, ok: bool, result: Value) {
            if !ok {
                let _ = self.logs.send(format!("view-call {request_id} error: {result}"));
            }
        }
    }

    /// Every built-in add-on starts, handles messages, its actions and a schedule tick without an error.
    #[test]
    fn builtins_run_without_errors() {
        let only = std::env::var("COMPOLA_SMOKE").unwrap_or_default();
        for &id in super::super::BUILTINS.iter().filter(|id| only.is_empty() || only.split(',').any(|o| o == **id)) {
            let files = super::super::builtin_files(id);
            if files.is_empty() {
                panic!("{id}: not bundled");
            }
            let folder = std::env::temp_dir().join(format!("compola-smoke-{id}-{}", uuid::Uuid::new_v4()));
            for (rel, bytes) in &files {
                let p = folder.join(rel);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(p, bytes).unwrap();
            }
            let manifest: super::super::Manifest = serde_json::from_slice(&std::fs::read(folder.join("manifest.json")).unwrap()).unwrap();
            let settings = Value::Object(super::super::host::settings_with_defaults(&manifest, &Default::default()));
            let (tx, rx) = mpsc::channel();
            let mailbox = Mailbox::new(64);
            let bridge = Arc::new(SmokeBridge { mailbox: mailbox.clone(), logs: tx });
            let spec = Spec {
                id: id.into(),
                source: String::from_utf8(std::fs::read(folder.join(&manifest.main)).unwrap()).unwrap(),
                main: manifest.main.clone(),
                folder: folder.clone(),
                manifest: serde_json::to_value(&manifest).unwrap(),
                settings,
                storage: json!({}),
                memory_bytes: manifest.memory_bytes(),
                timeout_ms: manifest.timeout_ms(),
            };
            let mb = mailbox.clone();
            let handle = std::thread::spawn(move || run(spec, mb, bridge, Arc::default()));
            std::thread::sleep(Duration::from_millis(300));
            let now = chrono::Utc::now().timestamp_millis();
            let incoming = json!({ "account": "acc", "id": "m9", "conversationId": "u1", "conversationName": "Chị An", "isGroup": false,
                                   "senderName": "Chị An", "fromMe": false, "sentBy": null, "text": "Hàng giao chậm quá, tôi muốn huỷ đơn!", "date": now });
            mailbox.event(Inbound::Event { name: "message".into(), data: incoming });
            let mine = json!({ "account": "acc", "id": "m10", "conversationId": "u1", "conversationName": "Chị An", "isGroup": false,
                               "senderName": "Shop", "fromMe": true, "sentBy": null, "text": "Dạ shop xin lỗi chị ạ", "date": now + 1 });
            mailbox.event(Inbound::Event { name: "message".into(), data: mine });
            for a in &manifest.contributes.actions {
                if let Some(aid) = a.get("id").and_then(Value::as_str) {
                    let data = json!({ "actionId": aid, "account": "acc", "conversationId": "u1", "text": "", "payload": null,
                                       "user": { "kind": "local", "id": "me", "name": "Tôi" } });
                    mailbox.event(Inbound::Event { name: "action".into(), data });
                }
            }
            mailbox.event(Inbound::Event { name: "schedule".into(), data: json!({}) });
            std::thread::sleep(Duration::from_millis(1500));
            mailbox.stop();
            let exit = handle.join().unwrap();
            let errors: Vec<String> = rx.try_iter().filter(|l| l.contains("error:")).collect();
            let _ = std::fs::remove_dir_all(&folder);
            assert!(errors.is_empty(), "{id}: {errors:#?}");
            assert_eq!(exit, Exit::Stopped, "{id}");
        }
    }

    #[test]
    fn events_rpc_timers_and_storage() {
        let (mb, rx, handle, bridge) = start(
            r#"
            compola.on('ready', async () => {
              compola.log('ready', compola.settings.greeting, compola.storage.get('n'));
              const v = await new Promise((r) => setTimeout(() => r(42), 20));
              const echo = await compola.mcp.call('s', 'tool', { a: v }).catch((e) => 'x');
              compola.log('timer', v);
              try { await compola.sendText('c', 'hi'); } catch (e) { compola.log('denied', e.message); }
            });
            compola.on('message', (m) => compola.log('msg', m.text));
            let ticks = 0;
            const iv = setInterval(() => { if (++ticks === 3) { clearInterval(iv); compola.log('ticks', ticks); } }, 10);
            compola.views.handle('sum', async (data, ctx) => (ctx.viewId === 'v' ? data[0] + data[1] : -1));
            "#,
            2000,
            32,
        );
        wait_for(&rx, "ready chào 1");
        wait_for(&rx, "timer 42");
        wait_for(&rx, "denied add-on chưa khai báo quyền");
        wait_for(&rx, "ticks 3");
        mb.control(Inbound::ViewCall { request_id: "r1".into(), name: "sum".into(), data: json!([2, 3]), context: json!({ "viewId": "v" }) });
        wait_for(&rx, "view r1 true 5");
        mb.control(Inbound::ViewCall { request_id: "r2".into(), name: "nope".into(), data: json!(null), context: json!({}) });
        wait_for(&rx, "view r2 false");
        assert!(bridge.subs.lock().contains(&"message".to_owned()));
        mb.event(Inbound::Event { name: "message".into(), data: json!({ "text": "xin chào" }) });
        wait_for(&rx, "msg xin chào");
        mb.stop();
        assert_eq!(handle.join().unwrap(), Exit::Stopped);
    }

    #[test]
    fn runaway_loop_is_interrupted() {
        let (mb, _rx, handle, _) = start("compola.on('message', () => { while (true) {} });", 200, 32);
        std::thread::sleep(Duration::from_millis(50));
        mb.event(Inbound::Event { name: "message".into(), data: json!({}) });
        match handle.join().unwrap() {
            Exit::Crashed(reason) => assert!(reason.contains("200 ms"), "{reason}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn runaway_loop_at_top_level() {
        let (_mb, _rx, handle, _) = start("for (;;) {}", 200, 32);
        assert!(matches!(handle.join().unwrap(), Exit::Crashed(_)));
    }

    #[test]
    fn memory_hog_is_stopped_and_errors_do_not_crash() {
        let (mb, rx, handle, _) = start(
            r#"
            compola.on('message', (m) => {
              if (m.kind === 'throw') throw new Error('boom');
              if (m.kind === 'reject') { Promise.reject(new Error('lost')); return; }
              const a = []; for (;;) a.push('x'.repeat(1 << 16));
            });
            "#,
            5000,
            16,
        );
        std::thread::sleep(Duration::from_millis(50));
        mb.event(Inbound::Event { name: "message".into(), data: json!({ "kind": "throw" }) });
        wait_for(&rx, "boom");
        mb.event(Inbound::Event { name: "message".into(), data: json!({ "kind": "reject" }) });
        wait_for(&rx, "lost");
        mb.event(Inbound::Event { name: "message".into(), data: json!({ "kind": "hog" }) });
        // QuickJS throws "out of memory" inside the handler; the add-on survives it or is torn down — never the app.
        let line = wait_for(&rx, "memory");
        assert!(line.contains("out of memory") || line.contains("bộ nhớ"), "{line}");
        mb.stop();
        let _ = handle.join().unwrap();
    }

    #[test]
    fn mailbox_drops_oldest_events() {
        let mb = Mailbox::new(2);
        for i in 0..5 {
            mb.event(Inbound::Event { name: "e".into(), data: json!(i) });
        }
        assert_eq!(mb.dropped.load(Ordering::Relaxed), 3);
        mb.control(Inbound::Settings(json!({})));
        let got = mb.take(Some(Duration::ZERO)).unwrap();
        assert!(matches!(got[0], Inbound::Settings(_)));
        assert!(matches!(&got[1], Inbound::Event { data, .. } if *data == json!(3)));
        mb.stop();
        assert!(mb.take(None).is_none());
        assert!(!mb.event(Inbound::Event { name: "e".into(), data: json!(9) }));
    }

    /// The example package (examples/addons/crm-demo): validates, its backend answers its views, its views build.
    #[test]
    fn example_crm_package_end_to_end() {
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/addons/crm-demo");
        let pkg = super::super::load(&folder).expect("example package loads");
        assert_eq!(pkg.manifest.contributes.views.len(), 3);
        for v in super::super::views::declared(&pkg.manifest.contributes.views) {
            let doc = super::super::views::document(&folder, &v, &[]).unwrap();
            assert!(doc.contains("window.compola") && !doc.contains("src=\"card.js\"") && !doc.contains("href=\"shared.css\""), "{}", v["id"]);
        }
        let (tx, rx) = mpsc::channel();
        let mb = Mailbox::new(16);
        let bridge = Arc::new(TestBridge { mailbox: Mutex::new(Some(mb.clone())), logs: tx, subs: Mutex::default() });
        let source = std::fs::read_to_string(folder.join("main.js")).unwrap();
        let mut s = spec(&source, 2000, 32);
        s.folder = folder.clone();
        s.manifest = serde_json::to_value(&pkg.manifest).unwrap();
        s.settings = json!({ "stages": "Mới, Đang tư vấn, Đã chốt" });
        s.storage = json!({});
        let (m2, b2) = (mb.clone(), bridge.clone());
        let handle = std::thread::spawn(move || run(s, m2, b2, Arc::default()));
        let ctx = json!({ "viewId": "card", "account": "default", "conversationId": "u1", "user": { "name": "Lan" } });
        let call = |id: &str, name: &str, data: Value| mb.control(Inbound::ViewCall { request_id: id.into(), name: name.into(), data, context: ctx.clone() });
        call("c1", "customer", json!(null));
        assert!(wait_for(&rx, "view c1").contains(r#""stage":"Mới""#));
        call("c2", "addOrder", json!({ "product": "Áo", "quantity": 2, "price": 150000, "name": "An" }));
        assert!(wait_for(&rx, "view c2").contains(r#""product":"Áo""#));
        call("c3", "customer", json!(null));
        let line = wait_for(&rx, "view c3");
        assert!(line.contains(r#""stage":"Đã chốt""#) && line.contains(r#""quantity":2"#), "{line}");
        call("c4", "dashboard", json!(null));
        let line = wait_for(&rx, "view c4");
        assert!(line.contains(r#""revenue":300000"#) && line.contains(r#""name":"An""#), "{line}");
        call("c5", "addOrder", json!({ "product": "", "quantity": 0 }));
        assert!(wait_for(&rx, "view c5").contains("view c5 false"));
        mb.stop();
        assert_eq!(handle.join().unwrap(), Exit::Stopped);
    }

    #[test]
    fn require_and_assets_stay_inside_the_package() {
        let dir = std::env::temp_dir().join(format!("compola-rt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(dir.join("lib/util.js"), "module.exports = { twice: (x) => x * 2, data: require('./data.json') };").unwrap();
        std::fs::write(dir.join("lib/data.json"), r#"{"k": 7}"#).unwrap();
        std::fs::write(dir.join("prompt.md"), "Bạn là trợ lý").unwrap();
        let (tx, rx) = mpsc::channel();
        let mb = Mailbox::new(8);
        let bridge = Arc::new(TestBridge { mailbox: Mutex::new(Some(mb.clone())), logs: tx, subs: Mutex::default() });
        let mut s = spec(
            r#"
            const u = require('./lib/util');
            compola.log('req', u.twice(21), u.data.k, compola.assets.read('prompt.md'));
            try { require('../../etc/passwd'); } catch (e) { compola.log('blocked', e.message); }
            try { compola.assets.read('../x'); } catch (e) { compola.log('blocked2'); }
            compola.log('fetch', typeof fetch);
            "#,
            2000,
            32,
        );
        s.folder = dir.clone();
        let (m2, b2) = (mb.clone(), bridge.clone());
        let handle = std::thread::spawn(move || run(s, m2, b2, Arc::default()));
        wait_for(&rx, "req 42 7 Bạn là trợ lý");
        wait_for(&rx, "blocked require");
        wait_for(&rx, "blocked2");
        wait_for(&rx, "fetch undefined");
        mb.stop();
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
