//! The add-on supervisor and API host.
//!
//! - Lifecycle: [`AddonHost::sync`] starts, restarts (new code or permissions) and stops runtimes to match the enabled
//!   add-ons. A crashed runtime restarts with exponential backoff (1 s … 60 s); 5 crashes within 10 minutes stop it as
//!   `faulted` until someone restarts it.
//! - API: every `compola.*` call arrives at [`AddonHost::api`], is checked against the manifest's permissions and the
//!   user's limits (`AddonLimits`), and runs on the async runtime; the answer goes back to the add-on's mailbox.
//! - Events: new messages, schedules, actions and suggestion outcomes go only to add-ons that subscribed
//!   (`compola.on`) and may receive them.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::AppHandle;

use super::runtime::{self, Bridge, Exit, Inbound, Mailbox, Stats};
use super::workspace::{Author, NoteInput, Workspace, sanitize_action};
use super::{Addon, Manifest};
use crate::automation::config::{AddonLimits, Schedule};
use crate::automation::{Automation, ai, config};
use crate::host::emit_ui;

pub const EVENT: &str = "compola://addons";
const EVENT_QUEUE: usize = 1000;
const LOG_LINES: usize = 300;
const LOG_FILE_BYTES: u64 = 1024 * 1024;
const MAX_STORAGE_BYTES: usize = 5 * 1024 * 1024;
const CRASH_WINDOW_MS: i64 = 10 * 60 * 1000;
const CRASH_LIMIT: usize = 5;
/// Messages every add-on together may send per minute (on top of each add-on's own limit).
const GLOBAL_SENDS_PER_MINUTE: usize = 60;
/// A fromMe message matching an add-on's send within this window is tagged `sentBy`.
const SENT_BY_WINDOW_MS: i64 = 120_000;
const MAX_FETCH_BYTES: usize = 10 * 1024 * 1024;
const AI_CONCURRENCY: usize = 4;

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Status {
    Stopped,
    Running { since: i64 },
    Restarting { at: i64, attempt: u32, reason: String },
    Faulted { reason: String },
}

#[derive(Clone, Debug, Serialize)]
pub struct LogLine {
    pub at: i64,
    pub level: String,
    pub text: String,
}

struct Running {
    generation: u64,
    mailbox: Arc<Mailbox>,
    stats: Arc<Stats>,
    digest: String,
    permissions: Vec<String>,
    settings_key: String,
    manifest: Manifest,
}

#[derive(Default)]
struct Window(VecDeque<i64>);

impl Window {
    /// Records one use if fewer than `max` happened in the last `span_ms`.
    fn allow(&mut self, span_ms: i64, max: usize) -> bool {
        let t = now();
        while self.0.front().is_some_and(|x| *x <= t - span_ms) {
            self.0.pop_front();
        }
        if self.0.len() >= max {
            return false;
        }
        self.0.push_back(t);
        true
    }
}

#[derive(Default)]
struct Limiter {
    windows: HashMap<String, Window>,
}

impl Limiter {
    fn allow(&mut self, key: String, span_ms: i64, max: u32) -> bool {
        if max == 0 {
            return false;
        }
        self.windows.entry(key).or_default().allow(span_ms, max as usize)
    }

    fn forget(&mut self, addon: &str) {
        let prefix = format!("{addon}|");
        self.windows.retain(|k, _| !k.starts_with(&prefix));
    }
}

/// One add-on's storage, flushed to `addons-data/<id>/storage.json` (atomically, debounced).
struct StorageFile {
    data: Map<String, Value>,
    dirty: bool,
}

pub struct AddonHost {
    app: AppHandle,
    automation: OnceLock<Weak<Automation>>,
    pub workspace: Workspace,
    running: Mutex<HashMap<String, Running>>,
    status: Mutex<HashMap<String, Status>>,
    crashes: Mutex<HashMap<String, VecDeque<i64>>>,
    generation: std::sync::atomic::AtomicU64,
    logs: Mutex<HashMap<String, VecDeque<LogLine>>>,
    subscriptions: Mutex<HashMap<String, HashSet<String>>>,
    limiter: Mutex<Limiter>,
    storage: Mutex<HashMap<String, StorageFile>>,
    /// (addon, account, conversation, text, at) of what add-ons sent, to tag the echo.
    recent_sends: Mutex<VecDeque<(String, String, String, String, i64)>>,
    /// (addon, tokens in, tokens out, requests) since launch.
    ai_usage: Mutex<HashMap<String, (u64, u64, u64)>>,
    ai_slots: tokio::sync::Semaphore,
    http: reqwest::Client,
    /// Views waiting for their add-on's answer (`compola.call`).
    view_calls: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
}

/// The runtime's view of the host for one generation of one add-on.
struct HostBridge {
    host: Weak<AddonHost>,
    mailbox: Arc<Mailbox>,
}

impl Bridge for HostBridge {
    fn call(&self, addon: &str, id: u64, method: String, args: Value) {
        let Some(host) = self.host.upgrade() else { return };
        let (mailbox, addon) = (self.mailbox.clone(), addon.to_owned());
        tauri::async_runtime::spawn(async move {
            let result = host.api(&addon, &method, args).await;
            let (ok, value) = match result {
                Ok(v) => (true, v),
                Err(e) => (false, Value::String(e)),
            };
            mailbox.control(Inbound::Reply { id, ok, value });
        });
    }

    fn log(&self, addon: &str, level: &str, text: String) {
        if let Some(host) = self.host.upgrade() {
            host.log(addon, level, text);
        }
    }

    fn subscribe(&self, addon: &str, events: Vec<String>) {
        if let Some(host) = self.host.upgrade() {
            host.subscriptions.lock().insert(addon.to_owned(), events.into_iter().collect());
        }
    }

    fn tools(&self, addon: &str, tools: Vec<Value>) {
        if let Some(a) = self.host.upgrade().and_then(|h| h.automation()) {
            a.set_addon_tools(addon, tools);
        }
    }

    fn tool_result(&self, request_id: String, ok: bool, result: Value) {
        if let Some(a) = self.host.upgrade().and_then(|h| h.automation()) {
            a.addon_tool_reply(&request_id, ok, result);
        }
    }

    fn view_result(&self, request_id: String, ok: bool, result: Value) {
        let Some(host) = self.host.upgrade() else { return };
        if let Some(tx) = host.view_calls.lock().remove(&request_id) {
            let _ = tx.send(if ok { Ok(result) } else { Err(result.as_str().map(str::to_owned).unwrap_or_else(|| result.to_string())) });
        }
    }
}

fn arg<'a>(args: &'a Value, i: usize) -> &'a Value {
    args.get(i).unwrap_or(&Value::Null)
}

fn arg_str(args: &Value, i: usize) -> String {
    match arg(args, i) {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => v.to_string(),
    }
}

fn opt_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

impl AddonHost {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let host = Arc::new(Self {
            workspace: Workspace::open(&crate::platform::app_support().join("addons.db")),
            app,
            automation: OnceLock::new(),
            running: Mutex::default(),
            status: Mutex::default(),
            crashes: Mutex::default(),
            generation: Default::default(),
            logs: Mutex::default(),
            subscriptions: Mutex::default(),
            limiter: Mutex::default(),
            storage: Mutex::default(),
            recent_sends: Mutex::default(),
            ai_usage: Mutex::default(),
            ai_slots: tokio::sync::Semaphore::new(AI_CONCURRENCY),
            view_calls: Mutex::default(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::limited(5))
                .user_agent("Compola-Addon/1")
                .build()
                .unwrap_or_default(),
        });
        // Storage flusher.
        let weak = Arc::downgrade(&host);
        std::thread::Builder::new()
            .name("compola-addon-storage".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(500));
                    let Some(host) = weak.upgrade() else { break };
                    host.flush_storage();
                }
            })
            .ok();
        host
    }

    pub fn attach(&self, automation: &Arc<Automation>) {
        let _ = self.automation.set(Arc::downgrade(automation));
    }

    fn automation(&self) -> Option<Arc<Automation>> {
        self.automation.get().and_then(Weak::upgrade)
    }

    fn changed(&self, addon: &str) {
        emit_ui(&self.app, EVENT, json!({ "kind": "status", "addonId": addon }));
    }

    // ---- logs ----

    pub fn log(&self, addon: &str, level: &str, text: String) {
        let line = LogLine { at: now(), level: level.to_owned(), text };
        if cfg!(debug_assertions) {
            log::debug!("[addon {addon}] {}", line.text);
        }
        // A file per add-on (rotated at 1 MB) so a headless server keeps them.
        let dir = super::data_dir(addon);
        let path = dir.join("log.txt");
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_FILE_BYTES) {
            let _ = std::fs::rename(&path, dir.join("log.1.txt"));
        }
        if std::fs::create_dir_all(&dir).is_ok() {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
                let _ = writeln!(f, "{stamp} [{}] {}", line.level, line.text.replace('\n', "\n    "));
            }
        }
        let mut logs = self.logs.lock();
        let list = logs.entry(addon.to_owned()).or_default();
        list.push_back(line);
        while list.len() > LOG_LINES {
            list.pop_front();
        }
    }

    pub fn logs(&self, addon: &str) -> Vec<LogLine> {
        self.logs.lock().get(addon).map(|l| l.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn clear_logs(&self, addon: &str) {
        self.logs.lock().remove(addon);
        let _ = std::fs::remove_file(super::data_dir(addon).join("log.txt"));
        let _ = std::fs::remove_file(super::data_dir(addon).join("log.1.txt"));
    }

    // ---- storage ----

    fn storage_path(addon: &str) -> std::path::PathBuf {
        super::data_dir(addon).join("storage.json")
    }

    /// The add-on's storage (loaded on first use; migrated from automation.json's old `storage`).
    fn storage_of(&self, addon: &str, legacy: &Map<String, Value>) -> Map<String, Value> {
        let mut all = self.storage.lock();
        if let Some(s) = all.get(addon) {
            return s.data.clone();
        }
        let data = std::fs::read(Self::storage_path(addon))
            .ok()
            .and_then(|b| serde_json::from_slice::<Map<String, Value>>(&b).ok())
            .unwrap_or_else(|| legacy.clone());
        let dirty = !legacy.is_empty() && !Self::storage_path(addon).exists();
        all.insert(addon.to_owned(), StorageFile { data: data.clone(), dirty });
        data
    }

    fn storage_set(&self, addon: &str, key: &str, value: Value) -> Result<(), String> {
        let mut all = self.storage.lock();
        let s = all.entry(addon.to_owned()).or_insert_with(|| StorageFile { data: Map::new(), dirty: false });
        let previous = if value.is_null() { s.data.remove(key) } else { s.data.insert(key.to_owned(), value) };
        let size = serde_json::to_vec(&s.data).map(|v| v.len()).unwrap_or(0);
        if size > MAX_STORAGE_BYTES {
            match previous {
                Some(p) => s.data.insert(key.to_owned(), p),
                None => s.data.remove(key),
            };
            return Err(format!("storage vượt quá {} MB", MAX_STORAGE_BYTES / 1024 / 1024));
        }
        s.dirty = true;
        Ok(())
    }

    fn flush_storage(&self) {
        let dirty: Vec<(String, Vec<u8>)> = {
            let mut all = self.storage.lock();
            all.iter_mut()
                .filter(|(_, s)| s.dirty)
                .map(|(id, s)| {
                    s.dirty = false;
                    (id.clone(), serde_json::to_vec(&s.data).unwrap_or_default())
                })
                .collect()
        };
        for (id, bytes) in dirty {
            let path = Self::storage_path(&id);
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
                log::warn!("add-on {id}: storage not saved");
                if let Some(s) = self.storage.lock().get_mut(&id) {
                    s.dirty = true;
                }
            }
        }
    }

    pub fn shutdown(&self) {
        for r in self.running.lock().values() {
            r.mailbox.stop();
        }
        self.flush_storage();
    }

    // ---- lifecycle ----

    pub fn status(&self, addon: &str) -> Status {
        self.status.lock().get(addon).cloned().unwrap_or(Status::Stopped)
    }

    /// Live numbers for Settings.
    pub fn stats(&self, addon: &str) -> Value {
        let running = self.running.lock();
        let (u_in, u_out, u_n) = self.ai_usage.lock().get(addon).copied().unwrap_or_default();
        let Some(r) = running.get(addon) else { return json!({ "aiRequests": u_n, "aiInputTokens": u_in, "aiOutputTokens": u_out }) };
        let s = &r.stats;
        json!({
            "events": s.events.load(Ordering::Relaxed),
            "calls": s.calls.load(Ordering::Relaxed),
            "errors": s.errors.load(Ordering::Relaxed),
            "busyMs": s.busy_us.load(Ordering::Relaxed) / 1000,
            "memory": s.memory.load(Ordering::Relaxed),
            "inFlight": s.in_flight.load(Ordering::Relaxed),
            "dropped": r.mailbox.dropped.load(Ordering::Relaxed),
            "backlog": r.mailbox.backlog(),
            "aiRequests": u_n, "aiInputTokens": u_in, "aiOutputTokens": u_out,
            "subscriptions": self.subscriptions.lock().get(addon).map(|s| s.iter().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        })
    }

    /// Starts, restarts or stops runtimes to match the enabled add-ons (call after any add-on change).
    pub fn sync(self: &Arc<Self>) {
        let Some(automation) = self.automation() else { return };
        let states = automation.addon_states();
        let installed: HashMap<String, Addon> = super::list().into_iter().map(|a| (a.manifest.id.clone(), a)).collect();
        let wanted: Vec<&Addon> = installed.values().filter(|a| states.get(&a.manifest.id).is_some_and(|s| s.enabled)).collect();
        let wanted_ids: HashSet<&str> = wanted.iter().map(|a| a.manifest.id.as_str()).collect();
        let to_stop: Vec<String> = self.running.lock().keys().filter(|id| !wanted_ids.contains(id.as_str())).cloned().collect();
        for id in to_stop {
            self.stop(&id, Status::Stopped);
        }
        // Statuses of add-ons that are off or gone.
        self.status.lock().retain(|id, _| wanted_ids.contains(id.as_str()));
        for addon in wanted {
            let id = addon.manifest.id.clone();
            let settings = Value::Object(settings_with_defaults(&addon.manifest, &states.get(&id).map(|s| s.settings.clone()).unwrap_or_default()));
            let settings_key = settings.to_string();
            let mut permissions = addon.manifest.permissions.clone();
            permissions.sort();
            let restart = {
                let running = self.running.lock();
                match running.get(&id) {
                    Some(r) => {
                        if r.digest != addon.digest || r.permissions != permissions {
                            true
                        } else {
                            if r.settings_key != settings_key {
                                r.mailbox.control(Inbound::Settings(settings.clone()));
                            }
                            false
                        }
                    }
                    None => !matches!(self.status(&id), Status::Faulted { .. } | Status::Restarting { .. }),
                }
            };
            if let Some(r) = self.running.lock().get_mut(&id) {
                r.settings_key = settings_key.clone();
            }
            if restart {
                self.stop(&id, Status::Stopped);
                let legacy = states.get(&id).map(|s| s.storage.clone()).unwrap_or_default();
                self.start(addon.clone(), settings, &legacy);
            }
        }
    }

    /// Clears a faulted / backing-off state and starts the add-on again.
    pub fn restart(self: &Arc<Self>, addon: &str) {
        self.crashes.lock().remove(addon);
        self.stop(addon, Status::Stopped);
        self.status.lock().remove(addon);
        self.sync();
    }

    fn stop(&self, addon: &str, status: Status) {
        let removed = self.running.lock().remove(addon);
        if let Some(r) = removed {
            r.mailbox.stop();
            self.log(addon, "info", "đã dừng".into());
        }
        self.subscriptions.lock().remove(addon);
        self.workspace.forget_addon(addon);
        if let Some(a) = self.automation() {
            a.set_addon_tools(addon, Vec::new());
        }
        self.status.lock().insert(addon.to_owned(), status);
        self.changed(addon);
    }

    fn start(self: &Arc<Self>, addon: Addon, settings: Value, legacy_storage: &Map<String, Value>) {
        let id = addon.manifest.id.clone();
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let mailbox = Mailbox::new(EVENT_QUEUE);
        let stats = Arc::new(Stats::default());
        let storage = self.storage_of(&id, legacy_storage);
        let mut permissions = addon.manifest.permissions.clone();
        permissions.sort();
        let spec = runtime::Spec {
            id: id.clone(),
            source: addon.source.clone(),
            main: addon.manifest.main.clone(),
            folder: std::path::PathBuf::from(&addon.path),
            manifest: serde_json::to_value(&addon.manifest).unwrap_or(Value::Null),
            settings: settings.clone(),
            storage: Value::Object(storage),
            memory_bytes: addon.manifest.memory_bytes(),
            timeout_ms: addon.manifest.timeout_ms(),
        };
        // Static contributions are known before the script runs.
        self.workspace.set_quick_replies(&id, &addon.manifest.contributes.quick_replies);
        self.running.lock().insert(
            id.clone(),
            Running {
                generation,
                mailbox: mailbox.clone(),
                stats: stats.clone(),
                digest: addon.digest.clone(),
                permissions,
                settings_key: settings.to_string(),
                manifest: addon.manifest.clone(),
            },
        );
        self.status.lock().insert(id.clone(), Status::Running { since: now() });
        self.log(&id, "info", format!("khởi động v{}", addon.manifest.version));
        let bridge: Arc<dyn Bridge> = Arc::new(HostBridge { host: Arc::downgrade(self), mailbox: mailbox.clone() });
        let weak = Arc::downgrade(self);
        let thread_id = id.clone();
        let spawned = std::thread::Builder::new().name(format!("addon-{id}")).stack_size(8 * 1024 * 1024).spawn(move || {
            let exit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runtime::run(spec, mailbox, bridge, stats)))
                .unwrap_or_else(|_| Exit::Crashed("runtime bị lỗi nội bộ (panic)".into()));
            if let Some(host) = weak.upgrade() {
                host.exited(&thread_id, generation, exit);
            }
        });
        if let Err(e) = spawned {
            self.exited(&id, generation, Exit::Crashed(format!("không tạo được luồng: {e}")));
        }
        self.changed(&id);
    }

    fn exited(self: &Arc<Self>, addon: &str, generation: u64, exit: Exit) {
        let current = self.running.lock().get(addon).is_some_and(|r| r.generation == generation);
        let Exit::Crashed(reason) = exit else { return };
        if !current {
            return;
        }
        self.log(addon, "error", format!("add-on dừng do lỗi: {reason}"));
        let attempts = {
            let mut crashes = self.crashes.lock();
            let list = crashes.entry(addon.to_owned()).or_default();
            list.push_back(now());
            while list.front().is_some_and(|t| *t < now() - CRASH_WINDOW_MS) {
                list.pop_front();
            }
            list.len()
        };
        if attempts >= CRASH_LIMIT {
            let reason = format!("lỗi {attempts} lần trong 10 phút — đã tạm dừng. Lỗi cuối: {reason}");
            self.log(addon, "error", reason.clone());
            self.stop(addon, Status::Faulted { reason });
            return;
        }
        let delay = Duration::from_secs((1u64 << (attempts as u32 - 1).min(6)).min(60));
        self.stop(addon, Status::Restarting { at: now() + delay.as_millis() as i64, attempt: attempts as u32, reason });
        let weak = Arc::downgrade(self);
        let id = addon.to_owned();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let Some(host) = weak.upgrade() else { return };
            if matches!(host.status(&id), Status::Restarting { .. }) {
                host.status.lock().remove(&id);
                host.sync();
            }
        });
    }

    fn manifest(&self, addon: &str) -> Result<Manifest, String> {
        self.running.lock().get(addon).map(|r| r.manifest.clone()).ok_or_else(|| "add-on không chạy".to_owned())
    }

    /// The HTML views of running add-ons (`views.rs`), each with `addonId` / `addonName`.
    pub fn views(&self) -> Vec<Value> {
        let running = self.running.lock();
        let mut out: Vec<Value> = running
            .iter()
            .flat_map(|(id, r)| {
                super::views::declared(&r.manifest.contributes.views).into_iter().map(move |mut v| {
                    v["addonId"] = json!(id);
                    v["addonName"] = json!(r.manifest.name);
                    v
                })
            })
            .collect();
        out.sort_by(|a, b| a["addonName"].as_str().cmp(&b["addonName"].as_str()).then(a["title"].as_str().cmp(&b["title"].as_str())));
        out
    }

    /// The document of a running add-on's view (`<iframe srcdoc>`).
    pub fn view_document(&self, addon: &str, view: &str) -> Result<String, String> {
        let (manifest, folder) = {
            let running = self.running.lock();
            let r = running.get(addon).ok_or("add-on không chạy")?;
            (r.manifest.clone(), super::dir().join(addon))
        };
        let v = super::views::declared(&manifest.contributes.views).into_iter().find(|v| v["id"] == view).ok_or("add-on không có giao diện này")?;
        super::views::document(&folder, &v, manifest.has("network"))
    }

    /// A view's `compola.call(name, data)`: delivered to the add-on, answered by its `compola.views.handle`.
    pub async fn view_call(&self, addon: &str, name: &str, data: Value, context: Value) -> Result<Value, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.view_calls.lock().insert(request_id.clone(), tx);
        let delivered = match self.running.lock().get(addon) {
            Some(r) => {
                r.mailbox.control(Inbound::ViewCall { request_id: request_id.clone(), name: name.to_owned(), data, context });
                true
            }
            None => false,
        };
        if !delivered {
            self.view_calls.lock().remove(&request_id);
            return Err("add-on không chạy".into());
        }
        match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(r)) => r,
            _ => {
                self.view_calls.lock().remove(&request_id);
                Err("add-on không trả lời".into())
            }
        }
    }

    /// The actions people can run from the app (manifest + runtime), per running add-on.
    pub fn actions(&self) -> Vec<Value> {
        let running = self.running.lock();
        let mut out = Vec::new();
        for (id, r) in running.iter() {
            let mut seen = HashSet::new();
            let views: HashSet<String> = super::views::declared(&r.manifest.contributes.views).iter().filter_map(|v| v["id"].as_str().map(str::to_owned)).collect();
            let with_view = |src: &Value, mut a: Value| {
                // `"view": "<id>"` opens that view instead of sending an `action` event.
                if let Some(view) = src.get("view").and_then(Value::as_str).filter(|v| views.contains(*v)) {
                    a["view"] = json!(view);
                }
                a
            };
            let declared = r.manifest.contributes.actions.iter().filter_map(|src| sanitize_action(src).map(|a| with_view(src, a)));
            for a in declared.chain(self.workspace.runtime_actions(id)) {
                let aid = a["id"].as_str().unwrap_or_default().to_owned();
                if seen.insert(aid) {
                    let mut a = a;
                    a["addonId"] = json!(id);
                    a["addonName"] = json!(r.manifest.name);
                    out.push(a);
                }
            }
        }
        out
    }

    // ---- events ----

    /// Delivers an event to running add-ons that subscribed and hold `permission` (None: any). `only`: one add-on.
    pub fn dispatch(&self, name: &str, data: &Value, permission: Option<&str>, only: Option<&str>) -> usize {
        let subs = self.subscriptions.lock();
        let running = self.running.lock();
        let mut n = 0;
        for (id, r) in running.iter() {
            if only.is_some_and(|o| o != id) {
                continue;
            }
            if permission.is_some_and(|p| !r.manifest.has(p)) {
                continue;
            }
            if !subs.get(id).is_some_and(|s| s.contains(name)) {
                continue;
            }
            if r.mailbox.event(Inbound::Event { name: name.to_owned(), data: data.clone() }) {
                n += 1;
            }
        }
        n
    }

    /// A new message seen by an account (automation's mirror).
    pub fn message(&self, account: &str, message: &Value) {
        let mut data = message.clone();
        data["account"] = json!(account);
        let from_me = message.get("fromMe").and_then(Value::as_bool).unwrap_or(false);
        let mut sent_by = Value::Null;
        if from_me {
            let conv = message.get("conversationId").and_then(Value::as_str).unwrap_or_default();
            let text = message.get("text").and_then(Value::as_str).unwrap_or_default().trim().to_owned();
            let t = now();
            let mut recent = self.recent_sends.lock();
            recent.retain(|r| r.4 > t - SENT_BY_WINDOW_MS);
            if let Some(i) = recent.iter().position(|r| r.1 == account && r.2 == conv && (r.3 == text || r.3.starts_with(&text) || text.starts_with(&r.3))) {
                sent_by = json!(format!("addon:{}", recent[i].0));
                recent.remove(i);
            }
        }
        data["sentBy"] = sent_by;
        self.dispatch("message", &data, Some("messages:read"), None);
    }

    /// One of the add-on's schedules fired (delivered whether or not it subscribed: it asked for it).
    pub fn schedule(&self, addon: &str, payload: &Value) -> bool {
        self.running.lock().get(addon).is_some_and(|r| r.mailbox.event(Inbound::Event { name: "schedule".into(), data: payload.clone() }))
    }

    pub fn tool_call(&self, addon: &str, request_id: &str, tool: &str, args: Value) -> bool {
        match self.running.lock().get(addon) {
            Some(r) => {
                r.mailbox.control(Inbound::ToolCall { request_id: request_id.to_owned(), tool: tool.to_owned(), args });
                true
            }
            None => false,
        }
    }

    /// A person ran an add-on action (`{actionId, account, conversationId?, messageId?, text?, payload?, user}`).
    pub fn run_action(&self, addon: &str, data: Value) -> Result<(), String> {
        let running = self.running.lock();
        let r = running.get(addon).ok_or("add-on không chạy")?;
        if !r.mailbox.event(Inbound::Event { name: "action".into(), data }) {
            return Err("add-on không chạy".into());
        }
        Ok(())
    }

    // ---- helpers for the API ----

    fn need(manifest: &Manifest, permission: &str) -> Result<(), String> {
        if manifest.has(permission) { Ok(()) } else { Err(format!("add-on chưa khai báo quyền \"{permission}\"")) }
    }

    fn limits(&self, addon: &str) -> AddonLimits {
        self.automation().and_then(|a| a.addon_states().get(addon).map(|s| s.limits.clone())).unwrap_or_default()
    }

    /// The account an add-on call is about: `opts.account`, else the account that knows the conversation, else the active one.
    fn account_for(&self, automation: &Automation, opts: &Value, conversation: Option<&str>) -> Result<String, String> {
        if let Some(a) = opt_str(opts, "account") {
            return automation.resolve_account(Some(a));
        }
        if let Some(conv) = conversation.filter(|c| !c.is_empty()) {
            if let Some(a) = automation.account_of_conversation(conv) {
                return Ok(a);
            }
        }
        automation.resolve_account(None)
    }

    fn emit_workspace(&self, kind: &str, account: &str, conversation: Option<&str>) {
        emit_ui(&self.app, EVENT, json!({ "kind": kind, "account": account, "conversationId": conversation }));
    }

    // ---- the API ----

    pub async fn api(self: &Arc<Self>, addon: &str, method: &str, args: Value) -> Result<Value, String> {
        let manifest = self.manifest(addon)?;
        let automation = self.automation().ok_or("Compola đang tắt")?;
        let name = manifest.name.clone();
        match method {
            // messages
            "sendText" => {
                Self::need(&manifest, "messages:send")?;
                let (conv, text, opts) = (arg_str(&args, 0), arg_str(&args, 1), arg(&args, 2).clone());
                if text.trim().is_empty() {
                    return Err("tin nhắn trống".into());
                }
                let account = self.account_for(&automation, &opts, Some(&conv))?;
                let limits = self.limits(addon);
                {
                    let mut l = self.limiter.lock();
                    if !l.allow(format!("{addon}|send"), 60_000, limits.send_per_minute) {
                        return Err(format!("vượt giới hạn {} tin/phút của add-on", limits.send_per_minute));
                    }
                    if !l.allow(format!("{addon}|send|{account}|{conv}"), 3_600_000, limits.send_per_conversation_hour) {
                        return Err(format!("vượt giới hạn {} tin/giờ cho một hội thoại", limits.send_per_conversation_hour));
                    }
                    if !l.allow("*|send".into(), 60_000, GLOBAL_SENDS_PER_MINUTE as u32) {
                        return Err("các add-on đang gửi quá nhiều tin, thử lại sau".into());
                    }
                }
                let expanded = crate::automation::expand_template(&text);
                self.recent_sends.lock().push_back((addon.to_owned(), account.clone(), conv.clone(), expanded.trim().to_owned(), now()));
                automation.send_text(Some(&account), &conv, &text).await?;
                Ok(Value::Null)
            }
            "conversations" => {
                Self::need(&manifest, "messages:read")?;
                let opts = arg(&args, 0);
                let account = self.account_for(&automation, opts, None)?;
                let limit = opts.get("limit").and_then(Value::as_u64).unwrap_or(50).clamp(1, 1000) as usize;
                let unread = opts.get("unread").and_then(Value::as_bool).unwrap_or(false);
                let list = automation.find_conversations(Some(&account), opt_str(opts, "query"), limit, unread)?;
                serde_json::to_value(list).map_err(|e| e.to_string())
            }
            "messages" => {
                Self::need(&manifest, "messages:read")?;
                let conv = arg(&args, 0).as_str().filter(|s| !s.is_empty()).map(str::to_owned);
                let limit = arg(&args, 1).as_u64().unwrap_or(50) as usize;
                let account = self.account_for(&automation, arg(&args, 2), conv.as_deref())?;
                let mut list = serde_json::to_value(automation.recent_messages(Some(&account), conv.as_deref(), limit)?).map_err(|e| e.to_string())?;
                if let Some(items) = list.as_array_mut() {
                    for m in items {
                        m["account"] = json!(account);
                    }
                }
                Ok(list)
            }
            "history" => {
                Self::need(&manifest, "messages:read")?;
                let (conv, opts) = (arg_str(&args, 0), arg(&args, 1));
                let account = self.account_for(&automation, opts, Some(&conv))?;
                let since = opts.get("since").and_then(Value::as_i64).unwrap_or(0);
                let until = opts.get("until").and_then(Value::as_i64).unwrap_or(i64::MAX);
                let limit = opts.get("limit").and_then(Value::as_u64).unwrap_or(200).clamp(1, 2000) as usize;
                let list = automation.history(&account, &conv, since, until, limit).await?;
                serde_json::to_value(list).map_err(|e| e.to_string())
            }
            "activeConversations" => {
                Self::need(&manifest, "messages:read")?;
                let opts = arg(&args, 0);
                let account = self.account_for(&automation, opts, None)?;
                let since = opts.get("since").and_then(Value::as_i64).unwrap_or(now() - 86_400_000);
                let limit = opts.get("limit").and_then(Value::as_u64).unwrap_or(200).clamp(1, 2000) as usize;
                automation.active_conversations(&account, since, limit).await
            }
            "search" => {
                Self::need(&manifest, "messages:read")?;
                let (query, opts) = (arg_str(&args, 0), arg(&args, 1));
                let account = self.account_for(&automation, opts, opt_str(opts, "conversationId"))?;
                let limit = opts.get("limit").and_then(Value::as_u64).unwrap_or(10).clamp(1, 200) as usize;
                let context = opts.get("context").and_then(Value::as_u64).unwrap_or(2).min(10) as usize;
                automation.search_messages(Some(&account), &query, opt_str(opts, "conversationId").map(str::to_owned), limit, context).await
            }
            "accounts" => {
                Self::need(&manifest, "messages:read")?;
                Ok(automation.account_list())
            }
            "notify" => {
                Self::need(&manifest, "notifications")?;
                use tauri_plugin_notification::NotificationExt;
                let title = format!("{} · {}", name, arg_str(&args, 0));
                self.app.notification().builder().title(title).body(arg_str(&args, 1)).show().map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }

            // notes
            "notesList" => {
                Self::need(&manifest, "notes")?;
                let (conv, opts) = (arg_str(&args, 0), arg(&args, 1));
                let account = self.account_for(&automation, opts, Some(&conv))?;
                let limit = opts.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
                serde_json::to_value(self.workspace.notes(&account, &conv, limit)?).map_err(|e| e.to_string())
            }
            "notesAdd" => {
                Self::need(&manifest, "notes")?;
                let (conv, text, opts) = (arg_str(&args, 0), arg_str(&args, 1), arg(&args, 2));
                let account = self.account_for(&automation, opts, Some(&conv))?;
                let input = NoteInput {
                    message_id: opt_str(opts, "messageId").map(str::to_owned),
                    pinned: opts.get("pinned").and_then(Value::as_bool).unwrap_or(false),
                    tags: opts.get("tags").and_then(Value::as_array).map(|t| t.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default(),
                    key: opt_str(opts, "key").map(str::to_owned),
                };
                let note = self.workspace.add_note(&account, &conv, &text, &Author { kind: "addon", id: addon.to_owned(), name: name.clone() }, input)?;
                self.emit_workspace("notes", &account, Some(&conv));
                serde_json::to_value(note).map_err(|e| e.to_string())
            }
            "notesUpdate" | "notesRemove" => {
                Self::need(&manifest, "notes")?;
                let id = arg_str(&args, 0);
                let note = self.workspace.note(&id)?.ok_or("không tìm thấy ghi chú")?;
                // An add-on edits only its own notes; people's notes are theirs.
                if note.author_kind != "addon" || note.author_id != addon {
                    return Err("add-on chỉ sửa được ghi chú do chính nó tạo".into());
                }
                let out = if method == "notesUpdate" {
                    serde_json::to_value(self.workspace.update_note(&id, arg(&args, 1))?).map_err(|e| e.to_string())?
                } else {
                    self.workspace.remove_note(&id)?;
                    Value::Null
                };
                self.emit_workspace("notes", &note.account, Some(&note.conversation_id));
                Ok(out)
            }

            // ui
            "suggest" => {
                Self::need(&manifest, "ui")?;
                let (conv, text, opts) = (arg_str(&args, 0), arg_str(&args, 1), arg(&args, 2));
                let account = self.account_for(&automation, opts, Some(&conv))?;
                let s = self.workspace.suggest(addon, &name, &account, &conv, &text, opts)?;
                self.emit_workspace("suggestions", &account, Some(&conv));
                Ok(json!(s.id))
            }
            "clearSuggestions" => {
                Self::need(&manifest, "ui")?;
                let conv = arg_str(&args, 0);
                let account = self.account_for(&automation, arg(&args, 1), Some(&conv))?;
                let n = self.workspace.clear_suggestions(Some(addon), &account, &conv);
                if n > 0 {
                    self.emit_workspace("suggestions", &account, Some(&conv));
                }
                Ok(json!(n))
            }
            "panel" => {
                Self::need(&manifest, "ui")?;
                let conv = arg(&args, 0).as_str().map(str::to_owned);
                let panel = arg(&args, 1);
                let account = self.account_for(&automation, panel, conv.as_deref())?;
                self.workspace.set_panel(addon, &name, &account, conv.as_deref(), panel)?;
                self.emit_workspace("panels", &account, conv.as_deref());
                Ok(Value::Null)
            }
            "toast" => {
                Self::need(&manifest, "ui")?;
                let opts = arg(&args, 1);
                let text = super::workspace::clean_text(&arg_str(&args, 0), 500);
                emit_ui(
                    &self.app,
                    EVENT,
                    json!({ "kind": "toast", "addonId": addon, "addonName": name, "text": text,
                            "conversationId": opt_str(opts, "conversationId"), "account": opt_str(opts, "account"),
                            "level": opt_str(opts, "level").unwrap_or("info") }),
                );
                Ok(Value::Null)
            }
            "viewPost" => {
                Self::need(&manifest, "ui")?;
                let opts = arg(&args, 2);
                let data = arg(&args, 1).clone();
                if data.to_string().len() > 1024 * 1024 {
                    return Err("dữ liệu gửi view quá lớn (tối đa 1 MB)".into());
                }
                emit_ui(
                    &self.app,
                    EVENT,
                    json!({ "kind": "viewMessage", "addonId": addon, "viewId": opt_str(opts, "viewId"), "name": arg_str(&args, 0), "data": data,
                            "conversationId": opt_str(opts, "conversationId"), "account": opt_str(opts, "account") }),
                );
                Ok(Value::Null)
            }
            "openView" => {
                Self::need(&manifest, "ui")?;
                let (view, opts) = (arg_str(&args, 0), arg(&args, 1));
                if !super::views::declared(&manifest.contributes.views).iter().any(|v| v["id"] == view.as_str()) {
                    return Err(format!("add-on không có view \"{view}\""));
                }
                emit_ui(
                    &self.app,
                    EVENT,
                    json!({ "kind": "openView", "addonId": addon, "viewId": view, "conversationId": opt_str(opts, "conversationId"),
                            "account": opt_str(opts, "account"), "params": opts.get("params").cloned().unwrap_or(Value::Null) }),
                );
                Ok(Value::Null)
            }
            "quickRepliesSet" => {
                Self::need(&manifest, "ui")?;
                let mut list = manifest.contributes.quick_replies.clone();
                list.extend(arg(&args, 0).as_array().cloned().unwrap_or_default());
                let n = self.workspace.set_quick_replies(addon, &list);
                emit_ui(&self.app, EVENT, json!({ "kind": "quickReplies" }));
                Ok(json!(n))
            }
            "actionsSet" => {
                Self::need(&manifest, "ui")?;
                self.workspace.set_actions(addon, arg(&args, 0).as_array().map(Vec::as_slice).unwrap_or_default());
                emit_ui(&self.app, EVENT, json!({ "kind": "actions" }));
                Ok(Value::Null)
            }

            // ai
            "aiAvailable" => {
                Self::need(&manifest, "ai")?;
                let cfg = automation.ai_config();
                Ok(json!(cfg.enabled && !cfg.model.is_empty() && (cfg.provider == "openai" || !cfg.api_key.is_empty())))
            }
            "aiComplete" => {
                Self::need(&manifest, "ai")?;
                let cfg = automation.ai_config();
                let req = ai::Request::from_value(arg(&args, 0), &cfg)?;
                let limits = self.limits(addon);
                if !self.limiter.lock().allow(format!("{addon}|ai"), 3_600_000, limits.ai_per_hour) {
                    return Err(format!("vượt giới hạn {} yêu cầu AI/giờ của add-on", limits.ai_per_hour));
                }
                let _slot = self.ai_slots.acquire().await.map_err(|e| e.to_string())?;
                let out = ai::complete(&self.http, &cfg, req).await?;
                {
                    let mut usage = self.ai_usage.lock();
                    let u = usage.entry(addon.to_owned()).or_default();
                    u.0 += out.usage.input_tokens;
                    u.1 += out.usage.output_tokens;
                    u.2 += 1;
                }
                serde_json::to_value(out).map_err(|e| e.to_string())
            }

            // network
            "fetch" => {
                Self::need(&manifest, "network")?;
                let limits = self.limits(addon);
                if !self.limiter.lock().allow(format!("{addon}|fetch"), 60_000, limits.fetch_per_minute) {
                    return Err(format!("vượt giới hạn {} yêu cầu mạng/phút", limits.fetch_per_minute));
                }
                self.fetch(&manifest, &arg_str(&args, 0), arg(&args, 1)).await
            }

            // storage
            "storageSet" => {
                self.storage_set(addon, &arg_str(&args, 0), arg(&args, 1).clone())?;
                Ok(Value::Null)
            }

            // schedules
            "schedulesList" => {
                Self::need(&manifest, "schedules")?;
                serde_json::to_value(automation.addon_jobs(addon)).map_err(|e| e.to_string())
            }
            "scheduleSave" => {
                Self::need(&manifest, "schedules")?;
                let spec = arg(&args, 0);
                let id = opt_str(spec, "id").unwrap_or_default().to_owned();
                if !id.is_empty() && !automation.addon_jobs(addon).iter().any(|j| j.id == id) {
                    return Err("không phải lịch của add-on này".into());
                }
                let schedule = if let Some(expr) = opt_str(spec, "cron") {
                    Schedule::Cron { expr: expr.to_owned() }
                } else {
                    let at = match spec.get("at") {
                        Some(Value::Number(n)) => n.as_i64(),
                        Some(Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()),
                        _ => None,
                    };
                    Schedule::Once { at: at.ok_or("cần `cron` hoặc `at`")? }
                };
                if automation.addon_jobs(addon).len() >= 100 && id.is_empty() {
                    return Err("add-on đã có 100 lịch".into());
                }
                let job = config::Job {
                    id,
                    name: opt_str(spec, "name").unwrap_or_default().to_owned(),
                    enabled: spec.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                    schedule,
                    action: config::Action::Addon { addon_id: addon.to_owned(), payload: spec.get("payload").cloned().unwrap_or(Value::Null) },
                    created_by: format!("addon:{addon}"),
                    last_run: None,
                    last_status: None,
                    last_ok: None,
                };
                serde_json::to_value(automation.save_job(job)?).map_err(|e| e.to_string())
            }
            "scheduleRemove" | "scheduleRun" => {
                Self::need(&manifest, "schedules")?;
                let id = arg_str(&args, 0);
                if !automation.addon_jobs(addon).iter().any(|j| j.id == id) {
                    return Err("không phải lịch của add-on này".into());
                }
                if method == "scheduleRemove" {
                    Ok(json!(automation.delete_job(&id)?))
                } else {
                    serde_json::to_value(automation.run_job_now(&id).await?).map_err(|e| e.to_string())
                }
            }

            // mcp
            "mcpServers" => {
                Self::need(&manifest, "mcp")?;
                Ok(automation.mcp_servers())
            }
            "mcpTools" => {
                Self::need(&manifest, "mcp")?;
                automation.mcp_tools(&arg_str(&args, 0)).await
            }
            "mcpCall" => {
                Self::need(&manifest, "mcp")?;
                automation.mcp_call(&arg_str(&args, 0), &arg_str(&args, 1), arg(&args, 2).clone()).await
            }
            _ => Err(format!("API không tồn tại: {method}")),
        }
    }

    /// `fetch` for add-ons: http(s) only, the manifest's hosts, no private / loopback addresses, bounded answers.
    async fn fetch(&self, manifest: &Manifest, url: &str, init: &Value) -> Result<Value, String> {
        let parsed = url::Url::parse(url).map_err(|_| format!("URL không hợp lệ: {url}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("chỉ hỗ trợ http và https".into());
        }
        let host = parsed.host_str().ok_or("URL không có host")?.to_ascii_lowercase();
        if !host_allowed(&manifest.hosts, &host) {
            return Err(format!("host \"{host}\" không có trong \"hosts\" của manifest"));
        }
        let port = parsed.port_or_known_default().unwrap_or(443);
        let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|e| format!("không phân giải được {host}: {e}"))?.collect();
        if addrs.is_empty() || addrs.iter().any(|a| private_ip(&a.ip())) {
            return Err(format!("không được truy cập địa chỉ nội bộ ({host})"));
        }
        let method = reqwest::Method::from_bytes(opt_str(init, "method").unwrap_or("GET").to_ascii_uppercase().as_bytes()).map_err(|_| "method không hợp lệ")?;
        let timeout = init.get("timeoutMs").and_then(Value::as_u64).unwrap_or(30_000).clamp(1000, 120_000);
        let mut req = self.http.request(method, parsed.clone()).timeout(Duration::from_millis(timeout));
        if let Some(headers) = init.get("headers").and_then(Value::as_object) {
            for (k, v) in headers {
                if let Some(v) = v.as_str() {
                    req = req.header(k.as_str(), v);
                }
            }
        }
        if let Some(body) = init.get("body").and_then(Value::as_str) {
            req = req.body(body.to_owned());
        }
        let mut resp = req.send().await.map_err(|e| format!("yêu cầu thất bại: {e}"))?;
        let status = resp.status();
        let final_url = resp.url().to_string();
        let headers: Map<String, Value> = resp.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_ascii_lowercase(), json!(v)))).collect();
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            if body.len() + chunk.len() > MAX_FETCH_BYTES {
                return Err(format!("phản hồi quá lớn (tối đa {} MB)", MAX_FETCH_BYTES / 1024 / 1024));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(json!({
            "status": status.as_u16(), "statusText": status.canonical_reason().unwrap_or_default(), "url": final_url,
            "headers": headers, "body": String::from_utf8_lossy(&body),
        }))
    }

    // ---- what people do (commands) ----

    pub fn user_add_note(&self, account: &str, conversation: &str, text: &str, author: Author, message_id: Option<String>) -> Result<Value, String> {
        let note = self.workspace.add_note(account, conversation, text, &author, NoteInput { message_id, ..Default::default() })?;
        self.emit_workspace("notes", account, Some(conversation));
        let data = serde_json::to_value(&note).map_err(|e| e.to_string())?;
        self.dispatch("note", &data, Some("notes"), None);
        Ok(data)
    }

    /// A person edits or deletes a note (any note of a conversation they can see).
    pub fn user_change_note(&self, conversation: &str, id: &str, patch: Option<&Value>) -> Result<Value, String> {
        let note = self.workspace.note(id)?.ok_or("không tìm thấy ghi chú")?;
        if note.conversation_id != conversation {
            return Err("ghi chú không thuộc hội thoại này".into());
        }
        let out = match patch {
            Some(p) => serde_json::to_value(self.workspace.update_note(id, p)?).map_err(|e| e.to_string())?,
            None => {
                self.workspace.remove_note(id)?;
                Value::Null
            }
        };
        self.emit_workspace("notes", &note.account, Some(conversation));
        Ok(out)
    }

    /// `used` (put in the composer), `sent` (sent as is) or `dismissed`; the add-on hears about it (`suggestion`).
    pub async fn resolve_suggestion(&self, conversation: &str, id: &str, outcome: &str, user: &str) -> Result<(), String> {
        let s = self.workspace.take_suggestion(id).ok_or("gợi ý đã hết hạn")?;
        if s.conversation_id != conversation {
            return Err("gợi ý không thuộc hội thoại này".into());
        }
        if outcome == "sent" {
            let automation = self.automation().ok_or("Compola đang tắt")?;
            if let Err(e) = automation.send_text(Some(&s.account), &s.conversation_id, &s.text).await {
                // Put it back so the person can retry.
                let _ = self.workspace.suggest(&s.addon_id, &s.addon_name, &s.account, &s.conversation_id, &s.text, &json!({ "title": s.title }));
                self.emit_workspace("suggestions", &s.account, Some(conversation));
                return Err(e);
            }
        }
        self.emit_workspace("suggestions", &s.account, Some(conversation));
        let data = json!({ "id": s.id, "outcome": outcome, "account": s.account, "conversationId": s.conversation_id, "text": s.text, "user": user });
        self.dispatch("suggestion", &data, None, Some(&s.addon_id));
        Ok(())
    }

    pub fn workspace_json(&self, account: &str, conversation: &str) -> Result<Value, String> {
        Ok(json!({
            "notes": self.workspace.notes(account, conversation, 200)?,
            "suggestions": self.workspace.suggestions(account, conversation),
            "panels": self.workspace.panels(account, conversation),
            "actions": self.actions(),
            "views": self.views(),
        }))
    }

    pub fn quick_replies_json(&self) -> Value {
        let running: HashSet<String> = self.running.lock().keys().cloned().collect();
        json!(self.workspace.quick_replies(&|id| running.contains(id)))
    }

    pub fn forget(&self, addon: &str) {
        self.limiter.lock().forget(addon);
        self.storage.lock().remove(addon);
        self.logs.lock().remove(addon);
        self.crashes.lock().remove(addon);
        self.status.lock().remove(addon);
        self.ai_usage.lock().remove(addon);
    }
}

/// The manifest's setting defaults overlaid with the user's values.
pub fn settings_with_defaults(manifest: &Manifest, saved: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for s in &manifest.settings {
        let Some(key) = s.get("key").and_then(Value::as_str) else { continue };
        let default = s.get("default").cloned().unwrap_or_else(|| match s.get("type").and_then(Value::as_str) {
            Some("boolean") => json!(false),
            Some("conversations") => json!([]),
            _ => json!(""),
        });
        out.insert(key.to_owned(), default);
    }
    for (k, v) in saved {
        out.insert(k.clone(), v.clone());
    }
    out
}

fn host_allowed(patterns: &[String], host: &str) -> bool {
    if patterns.is_empty() {
        return true;
    }
    patterns.iter().any(|p| match p.strip_prefix("*.") {
        Some(base) => host == base || host.ends_with(&format!(".{base}")),
        None => host == p,
    })
}

fn private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80 || v6.to_ipv4_mapped().is_some_and(|v4| private_ip(&std::net::IpAddr::V4(v4)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_private_addresses() {
        assert!(host_allowed(&[], "anything.com"));
        let p = vec!["api.x.com".to_owned(), "*.y.org".to_owned()];
        assert!(host_allowed(&p, "api.x.com") && host_allowed(&p, "a.b.y.org") && host_allowed(&p, "y.org"));
        assert!(!host_allowed(&p, "x.com") && !host_allowed(&p, "evily.org"));
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"] {
            assert!(private_ip(&ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700::1111"] {
            assert!(!private_ip(&ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn sliding_windows() {
        let mut l = Limiter::default();
        assert!(l.allow("a|send".into(), 60_000, 2));
        assert!(l.allow("a|send".into(), 60_000, 2));
        assert!(!l.allow("a|send".into(), 60_000, 2));
        assert!(l.allow("b|send".into(), 60_000, 2));
        assert!(!l.allow("c|send".into(), 60_000, 0));
        l.forget("a");
        assert!(l.allow("a|send".into(), 60_000, 2));
    }

    #[test]
    fn defaults_overlay() {
        let m: Manifest = serde_json::from_value(json!({ "id": "x", "name": "X", "settings": [
            { "key": "a", "type": "text", "default": "hi" }, { "key": "b", "type": "boolean" }, { "key": "c", "type": "conversations" }
        ]}))
        .unwrap();
        let mut saved = Map::new();
        saved.insert("a".into(), json!("yo"));
        let s = settings_with_defaults(&m, &saved);
        assert_eq!(Value::Object(s), json!({ "a": "yo", "b": false, "c": [] }));
    }
}
