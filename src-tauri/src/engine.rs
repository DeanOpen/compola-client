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
use tauri::{AppHandle, Manager, State};

use crate::host::{Host, HostKind, HostObserver, Page, emit_ui};
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
}

pub struct Engine {
    app: AppHandle,
    inner: Mutex<Inner>,
    main: Mutex<Option<Arc<MainProcess>>>,
}

/// `qr-id` poll result meaning "scanned once; show the second (device-linking) QR".
const SECOND_QR_REQUIRED_CODE: i64 = -20;

impl Engine {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self { app, inner: Mutex::new(Inner { phase: Some(Phase::Starting), ..Default::default() }), main: Mutex::new(None) })
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
        emit_ui(&self.app, "compola://phase", phase);
    }

    fn log_line(&self, line: &str) {
        {
            let mut st = self.inner.lock();
            st.recent_log.push_back(line.chars().take(600).collect());
            while st.recent_log.len() > 400 {
                st.recent_log.pop_front();
            }
        }
        emit_ui(&self.app, "compola://log", line.to_owned());
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
        crate::net::fingerprint::FingerprintProxy::shared().warm_up(&self.app);
        self.inner.lock().runtime_version = Some(info.version.clone());
        let platform = Arc::new(Platform::new(info.version.clone(), info.client_version.clone()));
        let main = MainProcess::new(self.app.clone(), platform.clone(), info.asar.clone());
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
                let notice = self.inner.lock().sign_out_notice.clone();
                self.set_phase(Phase::Login { login: LoginState::default(), notice });
            }
            MainEvent::Badge(n) => {
                // Dock badge like the official client: nothing at 0, "5+" above five.
                if let Some(w) = self.app.get_webview_window("main") {
                    let label = (n > 0).then(|| if n > 5 { "5+".to_owned() } else { n.to_string() });
                    let _ = w.set_badge_label(label);
                }
                emit_ui(&self.app, "compola://badge", n);
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

impl MainProcess {
    fn jar_clear(&self) {
        self.app.state::<Arc<crate::net::cookies::CookieJar>>().clear_zalo();
    }
}

impl HostObserver for Engine {
    fn console(&self, host: &Host, line: &str) {
        let prefix = if host.kind == HostKind::Worker { "sw-console " } else { "" };
        let official = line.starts_with("[log]") || line.starts_with("[info]");
        if !official || line.contains("[adapter]") || line.contains("[chat]") || line.contains("[transfer]") {
            log::info!("{prefix}{}", line.chars().take(300).collect::<String>());
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
            // Needs Arc<Self>: go through the managed state.
            if let Some(engine) = self.app.try_state::<Arc<Engine>>() {
                engine.handle_login_state(&state);
            }
            return;
        }
        emit_ui(&self.app, "compola://state", state);
    }

    fn page_started(&self, host: &Arc<Host>) {
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
            self.set_phase(Phase::Ready);
        }
        if host.kind == HostKind::Main {
            emit_ui(&self.app, "compola://page", page);
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

type EngineState<'a> = State<'a, Arc<Engine>>;

fn main_host(engine: &Engine) -> Result<Arc<Host>, String> {
    engine.main_process().and_then(|m| m.host()).ok_or_else(|| "engine not running".to_owned())
}

#[tauri::command]
pub fn engine_phase(engine: EngineState<'_>) -> Phase {
    engine.phase()
}

#[tauri::command]
pub fn engine_info(engine: EngineState<'_>) -> Value {
    let st = engine.inner.lock();
    let storage = engine.main_process().map(|m| if m.storage == crate::main_process::StorageBackend::Sqlite { "sqlite" } else { "idb" });
    json!({ "runtimeVersion": st.runtime_version, "storage": storage, "recentLog": st.recent_log })
}

/// Calls `window[target][method](...args)` in the main renderer page (the host-script adapters:
/// `__zaloChat`, `__zaloCompose`, `__zaloPoll`, …) and returns its JSON result.
#[tauri::command]
pub async fn engine_call(engine: EngineState<'_>, target: String, method: String, args: Vec<Value>) -> Result<Value, String> {
    if !target.starts_with("__zalo") && !target.starts_with("__swz") {
        return Err("unknown target".into());
    }
    let host = main_host(&engine)?;
    host.call_js(&format!(
        "const t = window[{}]; if (!t || typeof t[{m}] !== 'function') throw new Error('no ' + {} + '.' + {m}); return await t[{m}](...{});",
        js_literal(&json!(target)),
        js_literal(&json!(target)),
        js_literal(&Value::Array(args)),
        m = js_literal(&json!(method)),
    ))
    .await
}

/// Development aid: evaluates an async function body in the main renderer page.
#[tauri::command]
pub async fn engine_eval(engine: EngineState<'_>, script: String) -> Result<Value, String> {
    if !cfg!(debug_assertions) {
        return Err("disabled in release builds".into());
    }
    main_host(&engine)?.call_js(&script).await
}

#[tauri::command]
pub fn engine_refresh_qr(engine: EngineState<'_>) {
    engine.refresh_qr();
}

#[tauri::command]
pub fn engine_logout(engine: EngineState<'_>) {
    engine.log_out();
}

#[tauri::command]
pub fn engine_retry_runtime(engine: EngineState<'_>) {
    engine.inner().retry_runtime_setup();
}

#[tauri::command]
pub fn engine_show_renderer(engine: EngineState<'_>) -> Result<(), String> {
    main_host(&engine)?.show_debug();
    Ok(())
}

#[tauri::command]
pub fn engine_switch_to_sqlite(engine: EngineState<'_>) {
    if let Some(m) = engine.main_process() {
        m.switch_storage(crate::main_process::StorageBackend::Sqlite);
    }
    engine.log_out();
}
