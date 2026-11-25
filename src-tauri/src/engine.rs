//! The object the UI binds to (port of the core of `ZaloEngine.swift`). It boots the official Zalo client runtime
//! (host + main process) and turns its state into UI events. All protocol work happens in the official code.
//!
//! UI contract (Tauri events emitted to the `main` window):
//! - `compola://phase`  — [`Phase`] whenever it changes
//! - `compola://state`  — every `zstate` snapshot the host scripts post from the main page (`{page:'main', …}`); the
//!   frontend view-models interpret them (Swift: `ZaloEngine+<Feature>.swift`)
//! - `compola://log`    — renderer console / diagnostics lines
//! - `compola://badge`  — unread badge count
//!
//! Commands: see the `#[tauri::command]` functions below.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::host::{Host, HostKind, HostObserver, Page};
use crate::main_process::{MainEvent, MainProcess};
use crate::platform::Platform;
use crate::values::{Args, js_literal};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoginStep {
    Generating,
    WaitingScan,
    /// Phone scanned; waiting for "Đăng nhập" on the phone.
    WaitingConfirm { name: String, avatar: Option<String> },
    Expired,
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginState {
    pub step: LoginStep,
    /// `data:image/png;base64,…`
    pub qr: Option<String>,
    /// The server asked for a second scan (multi-layer QR for device linking).
    pub is_second_qr: bool,
}

impl Default for LoginState {
    fn default() -> Self {
        Self { step: LoginStep::Generating, qr: None, is_second_qr: false }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetup {
    /// looking | downloading | verifying | installing
    pub step: String,
    pub received: Option<u64>,
    pub total: Option<u64>,
    pub failure: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Phase {
    Starting,
    Preparing { setup: RuntimeSetup },
    Login { login: LoginState, notice: Option<String> },
    SigningIn,
    Ready,
}

#[derive(Default)]
struct Inner {
    phase: Option<Phase>,
    sign_out_notice: Option<String>,
    login_timeout: Option<tauri::async_runtime::JoinHandle<()>>,
    runtime_version: Option<String>,
    recent_log: std::collections::VecDeque<String>,
    /// Every `zstate` the main page posted since it loaded, so a reloaded UI can catch up (`engine_replay`): the host
    /// scripts post changes, not full state.
    replay: std::collections::VecDeque<Value>,
    /// Recent renderer crashes of this account (`renderer_terminated`), for the restart backoff.
    crashes: std::collections::VecDeque<std::time::Instant>,
    /// What the main page had posted when the app last ran (`startup-cache.json`): served by `engine_replay`, tagged
    /// `cached`, until the page posts its own conversation list, so a relaunch shows the window at once instead of
    /// waiting for the official client to boot (10–50 s).
    startup_cache: Option<Vec<Value>>,
    /// The page posted a full conversation list since it loaded: the replay is complete enough to be cached.
    live_list: bool,
    /// The replay changed since the cache was last written.
    cache_dirty: bool,
    cache_saver: bool,
    /// When the hosts were started (`boot`), for the startup timing lines in the log.
    booted_at: Option<std::time::Instant>,
}

/// Restart delay after the n-th renderer crash within `CRASH_WINDOW` (1st: 1 s, then doubling, at most 60 s).
pub fn crash_restart_delay(recent_crashes: usize) -> Duration {
    Duration::from_secs((1u64 << recent_crashes.saturating_sub(1).min(6)).min(60))
}
const CRASH_WINDOW: Duration = Duration::from_secs(600);

/// Bound of the replay log (events); the oldest non-conversation events go first.
const REPLAY_CAP: usize = 4000;

/// The startup cache (see `Inner::startup_cache`), in the account's data root.
const STARTUP_CACHE_FILE: &str = "startup-cache.json";
const STARTUP_CACHE_VERSION: u64 = 1;
/// Conversations whose messages are cached (the most recently posted ones).
const STARTUP_CACHE_CHATS: usize = 12;
/// How often a changed replay is written to the cache (also on app exit).
const STARTUP_CACHE_INTERVAL: Duration = Duration::from_secs(30);
/// Replay slices that describe the moment, not the account: never cached.
const TRANSIENT_KEYS: [&str; 8] = ["notification", "call", "transfer", "transferAvailable", "compose", "poll", "zcloud", "pins"];

/// A full conversation list (`reset`, which the adapter implies when nothing was `removed`), not a chat event.
fn is_full_list(state: &Value) -> bool {
    state.get("conversations").is_some()
        && state.get("chat").is_none()
        && state.get("reset").and_then(Value::as_bool).unwrap_or(state.get("removed").is_none())
}

/// The replay events worth showing at the next launch: account state (list, labels, hidden chats, contacts, profile)
/// and the messages of the most recently posted conversations.
fn cacheable_events(replay: &std::collections::VecDeque<Value>) -> Vec<Value> {
    let chat_id = |e: &Value| e.get("chat").and_then(|c| c.get("convId")).and_then(Value::as_str).map(str::to_owned);
    let mut recent_chats: Vec<String> = Vec::new();
    for id in replay.iter().rev().filter_map(chat_id) {
        if recent_chats.len() >= STARTUP_CACHE_CHATS {
            break;
        }
        if !recent_chats.contains(&id) {
            recent_chats.push(id);
        }
    }
    replay
        .iter()
        .filter(|e| !TRANSIENT_KEYS.iter().any(|k| e.get(*k).is_some()) || is_notification_settings(e))
        .filter(|e| e.get("typing").is_none() || e.get("chat").is_some())
        .filter(|e| chat_id(e).is_none_or(|id| recent_chats.contains(&id)))
        .cloned()
        .collect()
}

/// The notification settings (muted conversations): account state, unlike the other `notification` events.
fn is_notification_settings(state: &Value) -> bool {
    state.get("notification").and_then(|n| n.get("kind")).and_then(Value::as_str) == Some("settings")
}

fn read_startup_cache(path: &std::path::Path) -> Option<Vec<Value>> {
    let doc: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if doc.get("version").and_then(Value::as_u64) != Some(STARTUP_CACHE_VERSION) {
        return None;
    }
    let events = doc.get("events")?.as_array()?.clone();
    events.iter().any(is_full_list).then_some(events)
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

pub struct Engine {
    app: AppHandle,
    /// The Zalo account this engine runs.
    pub account: Arc<crate::account::Account>,
    me: std::sync::Weak<Engine>,
    /// The account's unread badge (what the official client puts on the dock icon).
    badge: std::sync::atomic::AtomicI64,
    /// `boot` ran (the hosts exist).
    booted: std::sync::atomic::AtomicBool,
    inner: Mutex<Inner>,
    main: Mutex<Option<Arc<MainProcess>>>,
}

/// `qr-id` poll result meaning "scanned once; show the second (device-linking) QR".
const SECOND_QR_REQUIRED_CODE: i64 = -20;

impl Engine {
    pub fn new(app: AppHandle, account: Arc<crate::account::Account>) -> Arc<Self> {
        let started = std::time::Instant::now();
        let startup_cache = read_startup_cache(&account.paths.data_root.join(STARTUP_CACHE_FILE));
        if let Some(events) = &startup_cache {
            log::info!("[{}] startup cache: {} events loaded in {} ms", account.id(), events.len(), started.elapsed().as_millis());
        }
        Arc::new_cyclic(|me| Self {
            app,
            account,
            me: me.clone(),
            badge: Default::default(),
            booted: Default::default(),
            inner: Mutex::new(Inner { phase: Some(Phase::Starting), startup_cache, ..Default::default() }),
            main: Mutex::new(None),
        })
    }

    fn startup_cache_path(&self) -> std::path::PathBuf {
        self.account.paths.data_root.join(STARTUP_CACHE_FILE)
    }

    /// Writes what the main page posted to the startup cache, when it changed and holds a full conversation list.
    pub fn save_startup_cache(&self) {
        let events = {
            let mut st = self.inner.lock();
            if !st.cache_dirty || !st.live_list || !matches!(st.phase, Some(Phase::Ready)) {
                return;
            }
            st.cache_dirty = false;
            cacheable_events(&st.replay)
        };
        let saved_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let doc = json!({ "version": STARTUP_CACHE_VERSION, "savedAt": saved_at, "events": events });
        match serde_json::to_vec(&doc).map_err(std::io::Error::other).and_then(|b| write_private(&self.startup_cache_path(), &b)) {
            Ok(()) => log::debug!("[{}] startup cache saved ({} events)", self.id(), events.len()),
            Err(e) => log::warn!("[{}] startup cache not saved: {e}", self.id()),
        }
    }

    /// Signed out: nothing of the account may show at the next launch.
    fn drop_startup_cache(&self) {
        {
            let mut st = self.inner.lock();
            st.startup_cache = None;
            st.cache_dirty = false;
            st.live_list = false;
        }
        let _ = std::fs::remove_file(self.startup_cache_path());
    }

    /// Saves the cache every `STARTUP_CACHE_INTERVAL` while the engine lives (once per engine).
    fn start_cache_saver(self: &Arc<Self>) {
        {
            let mut st = self.inner.lock();
            if st.cache_saver {
                return;
            }
            st.cache_saver = true;
        }
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(STARTUP_CACHE_INTERVAL).await;
                let Some(engine) = weak.upgrade() else { return };
                tauri::async_runtime::spawn_blocking(move || engine.save_startup_cache());
            }
        });
    }

    fn since_boot(&self) -> u128 {
        self.inner.lock().booted_at.map(|t| t.elapsed().as_millis()).unwrap_or(0)
    }

    pub fn id(&self) -> &str {
        self.account.id()
    }

    pub fn badge(&self) -> i64 {
        self.badge.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn is_booted(&self) -> bool {
        self.booted.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn accounts(&self) -> Option<Arc<crate::account::Accounts>> {
        self.app.try_state::<Arc<crate::account::Accounts>>().map(|a| a.inner().clone())
    }

    /// An event of this account (tagged with `account`; see `Accounts::emit`).
    fn emit(&self, event: &str, payload: Value) {
        if let Some(a) = self.accounts() {
            a.emit(self.id(), event, payload);
        }
    }

    /// Boots on a runtime another account already located / installed (no-op once booted).
    pub fn boot_with(self: &Arc<Self>, info: crate::runtime::RuntimeInfo) {
        if !self.is_booted() {
            self.boot(info);
        }
    }

    /// A WebContent process of this account died (WebKit crash, jetsam, killed): only this account's renderer is
    /// reloaded — the other accounts run in their own processes and are unaffected. Repeated crashes back off.
    pub fn renderer_terminated(self: &Arc<Self>, host: &Arc<Host>) {
        let delay = {
            let mut st = self.inner.lock();
            let now = std::time::Instant::now();
            st.crashes.retain(|t| now.duration_since(*t) < CRASH_WINDOW);
            st.crashes.push_back(now);
            crash_restart_delay(st.crashes.len())
        };
        log::warn!("[{}] renderer process terminated — reloading in {}s", host.label, delay.as_secs());
        self.log_line(&format!("[compola] renderer process terminated ({}) — reloading", host.label));
        let weak = Arc::downgrade(self);
        let label = host.label.clone();
        let kind = host.kind;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let Some(engine) = weak.upgrade() else { return };
            let Some(main) = engine.main_process() else { return };
            match kind {
                HostKind::Main => {
                    // Only when the host is still the one that crashed (not replaced by a shutdown / re-boot meanwhile).
                    let Some(host) = main.host().filter(|h| h.label == label) else { return };
                    let page = if main.has_session() { Page::Main } else { Page::Login };
                    host.load(page, &main.page_query(false));
                }
                HostKind::Worker => {
                    if main.has_session() && main.worker().is_some_and(|w| w.label == label) {
                        main.start_shared_worker();
                    }
                }
            }
        });
    }

    /// Stops the account's renderers (account removed or disabled, app exit).
    pub fn shutdown(&self) {
        if let Some(t) = self.inner.lock().login_timeout.take() {
            t.abort();
        }
        let main = self.main.lock().take();
        if let Some(main) = main {
            main.stop_shared_worker();
            if let Some(h) = main.host() {
                h.destroy();
            }
            if let Some(sqlite) = &main.sqlite {
                sqlite.close_all();
            }
        }
        self.booted.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn main_process(&self) -> Option<Arc<MainProcess>> {
        self.main.lock().clone()
    }

    pub fn phase(&self) -> Phase {
        self.inner.lock().phase.clone().unwrap_or(Phase::Starting)
    }

    fn set_phase(&self, phase: Phase) {
        {
            let mut st = self.inner.lock();
            if st.phase.as_ref() == Some(&phase) {
                return;
            }
            st.phase = Some(phase.clone());
        }
        if matches!(phase, Phase::Login { .. }) {
            self.drop_startup_cache();
        }
        self.emit("compola://phase", serde_json::to_value(&phase).unwrap_or(Value::Null));
        if let Some(a) = self.accounts() {
            a.changed();
        }
    }

    fn log_line(&self, line: &str) {
        {
            let mut st = self.inner.lock();
            st.recent_log.push_back(line.chars().take(600).collect());
            while st.recent_log.len() > 400 {
                st.recent_log.pop_front();
            }
        }
        self.emit("compola://log", Value::String(line.to_owned()));
    }

    // ---- lifecycle ----

    pub fn start(self: &Arc<Self>) {
        crate::installer::prepare_for_launch();
        let dir = crate::runtime::candidate();
        match crate::runtime::locate(&dir) {
            Ok(info) => {
                let installed = info.version.clone();
                self.boot(info);
                crate::installer::upgrade_if_outdated(&installed);
            }
            Err(e) => {
                log::info!("runtime not ready ({e}) — installing");
                self.install_runtime();
            }
        }
    }

    fn install_runtime(self: &Arc<Self>) {
        self.set_phase(Phase::Preparing { setup: RuntimeSetup { step: "looking".into(), received: None, total: None, failure: None } });
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let progress_engine = this.clone();
            let progress = move |step: crate::installer::Step| {
                let (name, received, total) = match step {
                    crate::installer::Step::Looking => ("looking", None, None),
                    crate::installer::Step::Downloading { received, total } => ("downloading", Some(received), total),
                    crate::installer::Step::Verifying => ("verifying", None, None),
                    crate::installer::Step::Installing => ("installing", None, None),
                };
                if let Phase::Preparing { setup } = progress_engine.phase() {
                    if setup.failure.is_none() {
                        progress_engine.set_phase(Phase::Preparing {
                            setup: RuntimeSetup { step: name.into(), received, total, failure: None },
                        });
                    }
                }
            };
            let result = crate::installer::install_into(&crate::runtime::current(), true, Box::new(progress)).await;
            match result.and_then(|_| crate::runtime::locate(&crate::runtime::current())) {
                Ok(info) => this.boot(info),
                Err(e) => {
                    log::error!("runtime: install failed — {e}");
                    if let Phase::Preparing { mut setup } = this.phase() {
                        setup.failure = Some(e.to_string());
                        this.set_phase(Phase::Preparing { setup });
                    }
                }
            }
        });
    }

    pub fn retry_runtime_setup(self: &Arc<Self>) {
        if let Phase::Preparing { setup } = self.phase() {
            if setup.failure.is_some() {
                self.install_runtime();
            }
        }
    }

    fn boot(self: &Arc<Self>, info: crate::runtime::RuntimeInfo) {
        self.booted.store(true, std::sync::atomic::Ordering::SeqCst);
        self.inner.lock().booted_at = Some(std::time::Instant::now());
        self.start_cache_saver();
        if let Some(a) = self.accounts() {
            a.runtime_ready(&info);
        }
        crate::net::fingerprint::FingerprintProxy::shared().warm_up(&self.app);
        self.inner.lock().runtime_version = Some(info.version.clone());
        let platform = Arc::new(Platform::new(info.version.clone(), info.client_version.clone(), self.account.paths.user_data()));
        let main = MainProcess::new(self.app.clone(), self.account.clone(), platform.clone(), info.asar.clone());
        let _ = main.observer.set(self.clone() as Arc<dyn HostObserver>);
        let weak = Arc::downgrade(self);
        let _ = main.on_event.set(Box::new(move |e| {
            if let Some(engine) = weak.upgrade() {
                engine.handle_main_event(e);
            }
        }));
        let mut registry = crate::bridge::Registry::new();
        crate::bridge::implementation::install(&mut registry, &platform);
        main.install(&mut registry);
        let _ = main.registry.set(Arc::new(registry));
        *self.main.lock() = Some(main.clone());

        log::info!("engine start — Zalo {} (client {}), session cookie: {}", info.version, info.client_version, main.has_session());
        self.set_phase(if main.has_session() { Phase::SigningIn } else { Phase::Login { login: LoginState::default(), notice: None } });
        if let Err(e) = main.start() {
            log::error!("host start failed: {e}");
        }
    }

    fn handle_main_event(&self, e: MainEvent) {
        match e {
            MainEvent::LoginSucceeded => {
                if let Some(t) = self.inner.lock().login_timeout.take() {
                    t.abort();
                }
                self.inner.lock().sign_out_notice = None;
                self.set_phase(Phase::SigningIn);
            }
            MainEvent::LoggedOut => {
                if let Some(a) = self.automation() {
                    a.clear_search(self.id());
                }
                let notice = self.inner.lock().sign_out_notice.clone();
                self.set_phase(Phase::Login { login: LoginState::default(), notice });
            }
            MainEvent::Badge(n) => {
                self.badge.store(n, std::sync::atomic::Ordering::Relaxed);
                self.emit("compola://badge", json!(n));
                // The dock badge is the sum over accounts.
                if let Some(a) = self.accounts() {
                    a.changed();
                }
            }
        }
    }

    /// Fresh QR (the official page regenerates on load).
    pub fn refresh_qr(&self) {
        let Some(main) = self.main_process() else { return };
        let notice = self.inner.lock().sign_out_notice.clone();
        self.set_phase(Phase::Login { login: LoginState::default(), notice });
        if let Some(h) = main.host() {
            h.load(Page::Login, &main.page_query(false));
        }
    }

    pub fn log_out(&self) {
        let Some(main) = self.main_process() else { return };
        main.jar_clear();
        main.reset_account_state();
        if let Some(a) = self.automation() {
            a.clear_search(self.id());
        }
        self.refresh_qr();
    }

    // ---- login state ----

    fn handle_login_state(self: &Arc<Self>, state: &Value) {
        let Phase::Login { mut login, notice } = self.phase() else { return };
        // The official page gave up on this QR: a scan would do nothing.
        if state.get("invalid").and_then(Value::as_bool) == Some(true) && login.step == LoginStep::WaitingScan {
            if let Some(t) = self.inner.lock().login_timeout.take() {
                t.abort();
            }
            login.step = LoginStep::Expired;
            self.set_phase(Phase::Login { login, notice });
            return;
        }
        if let Some(qr) = state.get("qr").and_then(Value::as_str).filter(|q| q.starts_with("data:")) {
            log::info!("login: QR received ({} bytes, event {:?})", qr.len(), state.get("event").and_then(Value::as_str));
            // Development hook (Swift: COMPOLA_QR_OUT): write the QR PNG to a file to scan it without the UI.
            if let Ok(path) = std::env::var("COMPOLA_QR_OUT") {
                if let Some(b64) = qr.split_once("base64,").map(|(_, d)| d) {
                    let _ = std::fs::write(&path, crate::values::unb64(b64));
                }
            }
            login.qr = Some(qr.to_owned());
            match state.get("event").and_then(Value::as_str) {
                Some("qr") => {
                    login.step = LoginStep::WaitingScan;
                    login.is_second_qr = false;
                }
                Some("qr2") => {
                    login.step = LoginStep::WaitingScan;
                    login.is_second_qr = true;
                }
                _ => {}
            }
            self.set_phase(Phase::Login { login, notice });
            self.schedule_expiry();
        }
    }

    /// Fallback only: the page's own expiry normally arrives first.
    fn schedule_expiry(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(100)).await;
            let Some(this) = weak.upgrade() else { return };
            if let Phase::Login { mut login, notice } = this.phase() {
                if login.step == LoginStep::WaitingScan {
                    login.step = LoginStep::Expired;
                    this.set_phase(Phase::Login { login, notice });
                }
            }
        });
        if let Some(old) = self.inner.lock().login_timeout.replace(task) {
            old.abort();
        }
    }

    /// Responses of interest passing through the proxy: QR login long-polls and the kick-out notice.
    pub fn observe_response(&self, url: &url::Url, status: u16, body: &[u8]) {
        if url.path().ends_with("/api/session/kickout-info") {
            log::info!("session kicked by server");
            self.inner.lock().sign_out_notice = Some("Tài khoản của bạn vừa đăng nhập trên một Zalo PC khác, nên phiên này đã bị đăng xuất. Zalo chỉ cho phép một phiên máy tính cho mỗi tài khoản.".into());
            return;
        }
        if !url.host_str().is_some_and(|h| h.starts_with("qr-id.")) || status != 200 {
            return;
        }
        let Phase::Login { mut login, notice } = self.phase() else { return };
        let Ok(json) = serde_json::from_slice::<Value>(body) else { return };
        let data = json.get("data").cloned().unwrap_or_else(|| json.clone());
        let code = json.get("error_code").and_then(Value::as_i64).unwrap_or(0);
        if code == SECOND_QR_REQUIRED_CODE {
            return;
        }
        if let Some(name) = data.get("display_name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            login.step = LoginStep::WaitingConfirm { name: name.to_owned(), avatar: data.get("avatar").and_then(Value::as_str).map(str::to_owned) };
            self.set_phase(Phase::Login { login, notice });
        } else if code != 0 {
            if let Some(msg) = json.get("error_message").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                login.step = LoginStep::Failed { message: msg.to_owned() };
                self.set_phase(Phase::Login { login, notice });
            }
        }
    }
}

impl Engine {
    fn record_replay(&self, state: &Value) {
        let mut st = self.inner.lock();
        // A full conversation list replaces every earlier conversation snapshot.
        if is_full_list(state) {
            st.replay.retain(|e| e.get("conversations").is_none() || e.get("chat").is_some());
            if !st.live_list {
                // The page's own list replaces the cached one (the UI drops its `cached` state on this event).
                st.live_list = true;
                st.startup_cache = None;
                let rows = state.get("conversations").and_then(Value::as_array).map_or(0, Vec::len);
                let ms = st.booted_at.map(|t| t.elapsed().as_millis()).unwrap_or(0);
                log::info!("[{}] startup: conversation list ({rows} rows) after {ms} ms", self.id());
            }
        }
        st.cache_dirty = true;
        st.replay.push_back(state.clone());
        while st.replay.len() > REPLAY_CAP {
            match st.replay.iter().position(|e| e.get("conversations").is_none()) {
                Some(i) => {
                    st.replay.remove(i);
                }
                None => {
                    st.replay.pop_front();
                }
            }
        }
    }

    fn clear_replay(&self) {
        let mut st = self.inner.lock();
        st.replay.clear();
        st.live_list = false;
    }
}

impl Engine {
    /// `window[target][method](...args)` in the main renderer page (see `engine_call`).
    pub async fn call_adapter(&self, target: &str, method: &str, args: Vec<Value>) -> Result<Value, String> {
        if !target.starts_with("__zalo") && !target.starts_with("__swz") {
            return Err("unknown target".into());
        }
        let host = main_host(self)?;
        host.call_js(&format!(
            "const t = window[{}]; if (!t || typeof t[{m}] !== 'function') throw new Error('no ' + {} + '.' + {m}); return await t[{m}](...{});",
            js_literal(&json!(target)),
            js_literal(&json!(target)),
            js_literal(&Value::Array(args)),
            m = js_literal(&json!(method)),
        ))
        .await
    }

    /// `call_adapter` whose adapter clicks a hidden `<input type=file>`: the input receives the files at `paths` (see
    /// `engine_call_with_files`). Null when there is nothing to send.
    pub async fn call_adapter_with_files(&self, target: &str, method: &str, args: Vec<Value>, paths: Vec<String>) -> Result<Value, String> {
        if !target.starts_with("__zalo") {
            return Err("unknown target".into());
        }
        if paths.is_empty() {
            return Ok(Value::Null);
        }
        main_host(self)?
            .call_js(&format!(
                "window.__compolaPendingFiles = await window.__compolaLoadFiles({}); const t = window[{}]; return await t[{}](...{});",
                js_literal(&json!(paths)),
                js_literal(&json!(target)),
                js_literal(&json!(method)),
                js_literal(&Value::Array(args)),
            ))
            .await
    }

    /// Runtime version, storage backend and the recent renderer log (`engine_info`).
    pub fn info(&self) -> Value {
        let st = self.inner.lock();
        let storage = self.main_process().map(|m| if m.storage == crate::main_process::StorageBackend::Sqlite { "sqlite" } else { "idb" });
        json!({ "runtimeVersion": st.runtime_version, "storage": storage, "recentLog": st.recent_log })
    }

    /// Everything the main page posted since it loaded (`engine_replay`), preceded by the startup cache (each event
    /// tagged `cached: true`) until the page posted its own conversation list.
    pub fn replay(&self) -> Vec<Value> {
        let st = self.inner.lock();
        let cached = st.startup_cache.as_deref().filter(|_| !st.live_list).unwrap_or_default();
        let tagged = cached.iter().map(|e| {
            let mut e = e.clone();
            if let Some(o) = e.as_object_mut() {
                o.insert("cached".into(), Value::Bool(true));
            }
            e
        });
        tagged.chain(st.replay.iter().cloned()).collect()
    }

    fn automation(&self) -> Option<Arc<crate::automation::Automation>> {
        self.app.try_state::<Arc<crate::automation::Automation>>().map(|s| s.inner().clone())
    }
}

impl MainProcess {
    fn jar_clear(&self) {
        self.account.jar.clear_zalo();
    }
}

impl HostObserver for Engine {
    fn console(&self, host: &Host, line: &str) {
        // Every account's pages log into one file: lines of an added account carry its id.
        let account = if host.account.paths.is_default() { String::new() } else { format!("<{}> ", host.account.id()) };
        let prefix = if host.kind == HostKind::Worker { "sw-console " } else { "" };
        let official = line.starts_with("[log]") || line.starts_with("[info]");
        if !official || line.contains("[adapter]") || line.contains("[chat]") || line.contains("[transfer]") {
            log::info!("{account}{prefix}{}", line.chars().take(300).collect::<String>());
        }
        if host.kind == HostKind::Main {
            self.log_line(line);
        }
    }

    fn state(&self, host: &Host, state: Value) {
        if host.kind != HostKind::Main {
            return;
        }
        let page = state.get("page").and_then(Value::as_str).unwrap_or("-").to_owned();
        if page == "login" {
            if let Some(engine) = self.me.upgrade() {
                engine.handle_login_state(&state);
            }
            return;
        }
        if let (Some(user), Some(a)) = (state.get("user"), self.accounts()) {
            a.observe_user(self.id(), user);
        }
        // Engine-side handling the UI doesn't need to see: the renderer's own notification sound rules.
        if let Some(n) = state.get("notification").filter(|n| n.get("kind").and_then(Value::as_str) == Some("sound")) {
            if let Some(url) = n.get("url").and_then(Value::as_str) {
                crate::notifications::play_notification_sound(&self.app, url);
            }
            return;
        }
        self.record_replay(&state);
        if let Some(a) = self.automation() {
            a.observe_state(self.id(), &state);
        }
        self.emit("compola://state", state);
    }

    fn page_started(&self, host: &Arc<Host>) {
        if host.kind == HostKind::Main {
            self.clear_replay();
            if let Some(a) = self.automation() {
                a.reset_mirror(self.id());
            }
        }
        if let Some(m) = self.main_process() {
            m.page_did_start_loading(host);
        }
    }

    fn page_loaded(&self, host: &Arc<Host>, page: Page) {
        log::info!("[{}] page loaded {:?}", host.label, page);
        if let Some(m) = self.main_process() {
            m.page_did_finish_loading(host, page);
        }
        if host.kind == HostKind::Main && page == Page::Main && self.phase() == Phase::SigningIn {
            log::info!("[{}] startup: main page loaded after {} ms", self.id(), self.since_boot());
            self.set_phase(Phase::Ready);
        }
        if host.kind == HostKind::Main {
            self.emit("compola://page", serde_json::to_value(page).unwrap_or(Value::Null));
        }
    }

    fn bridge_trace(&self, host: &Host, key: &str, args: &Args) {
        if key.contains("ZLog") || key.starts_with("$zelectron.store") || key.starts_with("$znode.sqliteHost") {
            return;
        }
        if log::log_enabled!(log::Level::Debug) {
            log::debug!("[{}] bridge {key} {}", host.label, shape(args));
        }
    }

    fn handler_error(&self, host: &Host, key: &str, error: &str) {
        log::warn!("[{}] bridge-error {key}: {error}", host.label);
    }
}

/// Argument shapes only (never contents) for diagnostics.
fn shape(args: &Args) -> String {
    let parts: Vec<&str> = args
        .iter()
        .map(|a| match a {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Number(_) => "num",
            Value::String(_) => "str",
            Value::Array(_) => "arr",
            Value::Object(o) if o.contains_key("__bytes") => "bytes",
            Value::Object(_) => "obj",
        })
        .collect();
    format!("({})", parts.join(","))
}

// ---- commands ----

/// The engine of an optional `account` argument (missing = the active account).
fn engine_for(app: &AppHandle, account: Option<String>) -> Result<Arc<Engine>, String> {
    crate::account::engine(app, account.as_deref())
}

fn main_host(engine: &Engine) -> Result<Arc<Host>, String> {
    engine.main_process().and_then(|m| m.host()).ok_or_else(|| "engine not running".to_owned())
}

#[tauri::command]
pub fn engine_phase(app: AppHandle, account: Option<String>) -> Result<Value, String> {
    let engine = engine_for(&app, account)?;
    Ok(crate::account::tag_payload("compola://phase", engine.id(), serde_json::to_value(engine.phase()).unwrap_or(Value::Null)))
}

#[tauri::command]
pub fn engine_info(app: AppHandle, account: Option<String>) -> Result<Value, String> {
    Ok(engine_for(&app, account)?.info())
}

/// Calls `window[target][method](...args)` in the main renderer page (the host-script adapters:
/// `__zaloChat`, `__zaloCompose`, `__zaloPoll`, …) and returns its JSON result.
#[tauri::command]
pub async fn engine_call(app: AppHandle, account: Option<String>, target: String, method: String, args: Vec<Value>) -> Result<Value, String> {
    let engine = engine_for(&app, account.clone())?;
    let result = engine.call_adapter(&target, &method, args.clone()).await;
    crate::remote::record_local_call(&app, account.as_deref(), "engine_call", &target, &method, &args, result.is_ok());
    result
}

/// Development aid: evaluates an async function body in the main renderer page.
#[tauri::command]
pub async fn engine_eval(app: AppHandle, account: Option<String>, script: String) -> Result<Value, String> {
    let engine = engine_for(&app, account)?;
    if !cfg!(debug_assertions) {
        return Err("disabled in release builds".into());
    }
    main_host(&engine)?.call_js(&script).await
}

#[tauri::command]
pub fn engine_refresh_qr(app: AppHandle, account: Option<String>) -> Result<(), String> {
    engine_for(&app, account)?.refresh_qr();
    Ok(())
}

#[tauri::command]
pub fn engine_logout(app: AppHandle, account: Option<String>) -> Result<(), String> {
    engine_for(&app, account)?.log_out();
    Ok(())
}

#[tauri::command]
pub fn engine_retry_runtime(app: AppHandle) {
    crate::account::accounts(&app).retry_runtime_setup();
}

#[tauri::command]
pub fn engine_show_renderer(app: AppHandle, account: Option<String>) -> Result<(), String> {
    main_host(&*engine_for(&app, account)?)?.show_debug();
    Ok(())
}

#[tauri::command]
pub fn engine_switch_to_sqlite(app: AppHandle, account: Option<String>) -> Result<(), String> {
    let engine = engine_for(&app, account)?;
    if let Some(m) = engine.main_process() {
        m.switch_storage(crate::main_process::StorageBackend::Sqlite);
    }
    engine.log_out();
    Ok(())
}

/// The UI reports the conversation on screen (notification suppression backstop).
#[tauri::command]
pub fn ui_set_open_conversation(app: AppHandle, account: Option<String>, id: Option<String>) -> Result<(), String> {
    let account = crate::account::accounts(&app).registry().resolve(account.as_deref())?;
    crate::notifications::set_open_conversation(&app, &account, id);
    Ok(())
}

/// The UI's "show message preview in notifications" setting.
#[tauri::command]
pub fn ui_set_shows_preview(app: AppHandle, shows: bool) {
    crate::notifications::set_shows_preview(&app, shows);
}

/// `engine_call` whose adapter clicks a hidden `<input type=file>` (composer "Ảnh hoặc Video" / "Tệp"): the input receives
/// `files`, or — when `files` is null — what the user picks in the native open panel (`pick`: `media` = images + movies,
/// `files` = anything). Swift: `OfficialClientHost.evaluate(_:providingFiles:)`. Returns null when the user cancelled.
#[tauri::command]
pub async fn engine_call_with_files(
    app: AppHandle,
    account: Option<String>,
    target: String,
    method: String,
    args: Vec<Value>,
    files: Option<Vec<String>>,
    pick: Option<String>,
) -> Result<Value, String> {
    let engine = engine_for(&app, account.clone())?;
    let paths = match files {
        Some(f) => f,
        None => match pick_files(&app, pick.as_deref()).await {
            Some(paths) => paths,
            None => return Ok(Value::Null),
        },
    };
    let result = engine.call_adapter_with_files(&target, &method, args.clone(), paths).await;
    crate::remote::record_local_call(&app, account.as_deref(), "engine_call_with_files", &target, &method, &args, result.is_ok());
    result
}

/// The native open panel of the file buttons (`pick`: `media` = images + movies, anything else = any file); None when
/// the user cancelled.
pub(crate) async fn pick_files(app: &AppHandle, pick: Option<&str>) -> Option<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file();
    if pick == Some("media") {
        dialog = dialog.add_filter("Ảnh hoặc Video", &["jpg", "jpeg", "png", "gif", "webp", "heic", "mp4", "mov", "m4v", "webm"]);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_files(move |picked| {
        let _ = tx.send(picked);
    });
    let list = rx.await.ok().flatten()?;
    Some(list.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect())
}

/// Widens (or narrows back) the main window when the inspector opens, so the chat keeps its width (Swift InspectorRoom).
#[tauri::command]
pub fn ui_widen_window(app: AppHandle, delta: f64) -> Result<f64, String> {
    /// How far widening moved the window left to keep it on screen; given back when it narrows again.
    static SHIFTED: std::sync::Mutex<f64> = std::sync::Mutex::new(0.0);
    let w = app.get_webview_window("main").ok_or("no window")?;
    if w.is_maximized().unwrap_or(false) || w.is_fullscreen().unwrap_or(false) {
        return Ok(0.0);
    }
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let inner = w.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let outer = w.outer_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let pos = w.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let frame = (outer.width - inner.width).max(0.0);
    // The usable part of the screen the window is on (without the Dock / taskbar).
    let area = w.current_monitor().ok().flatten().map(|m| {
        let s = m.scale_factor();
        let a = m.work_area();
        (a.position.to_logical::<f64>(s), a.size.to_logical::<f64>(s))
    });
    let max_width = area.map(|(_, size)| size.width - frame).unwrap_or(f64::MAX).max(960.0);
    let width = (inner.width + delta).clamp(960.0, max_width);
    let applied = width - inner.width;
    w.set_size(tauri::LogicalSize::new(width, inner.height)).map_err(|e| e.to_string())?;

    if let Some((origin, size)) = area {
        let mut shifted = SHIFTED.lock().map_err(|e| e.to_string())?;
        let right = origin.x + size.width;
        let x = if applied > 0.0 {
            // Past the screen's right edge: slide left so the whole window (and its new panel) stays visible.
            let over = pos.x + width + frame - right;
            if over > 0.0 {
                let nx = (pos.x - over).max(origin.x);
                *shifted += pos.x - nx;
                Some(nx)
            } else {
                None
            }
        } else if *shifted > 0.0 {
            // Narrowed again: back where it was, as far as the screen allows.
            let nx = (pos.x + *shifted).min(right - width - frame).max(origin.x);
            *shifted = 0.0;
            Some(nx)
        } else {
            None
        };
        if let Some(x) = x {
            w.set_position(tauri::LogicalPosition::new(x, pos.y)).map_err(|e| e.to_string())?;
        }
    }
    Ok(applied)
}

/// ⌘V in the composer: what the clipboard holds as files to send — files copied in Finder (their paths), or an image
/// (screenshot, copied picture) written to a temporary PNG. Empty when the clipboard holds neither (plain text paste).
#[tauri::command]
pub fn clipboard_paste_files() -> Result<Vec<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    if let Ok(files) = clipboard.get().file_list() {
        let paths: Vec<String> = files.into_iter().filter(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned()).collect();
        if !paths.is_empty() {
            return Ok(paths);
        }
    }
    let Ok(image) = clipboard.get_image() else { return Ok(Vec::new()) };
    let dir = crate::platform::app_support().join("paste");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Old pastes are only needed until the upload read them.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|d| d.as_secs() > 3600)) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let name = format!("Ảnh chụp {}.png", chrono::Local::now().format("%Y-%m-%d lúc %H.%M.%S"));
    let path = dir.join(name);
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), image.width as u32, image.height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&image.bytes).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(vec![path.to_string_lossy().into_owned()])
}

/// Everything the main page posted since it loaded (compacted), for a UI that (re)loaded after it: dispatch in order.
#[tauri::command]
pub fn engine_replay(app: AppHandle, account: Option<String>) -> Result<Vec<Value>, String> {
    let engine = engine_for(&app, account)?;
    Ok(engine.replay().into_iter().map(|v| crate::account::tag_payload("compola://state", engine.id(), v)).collect())
}
