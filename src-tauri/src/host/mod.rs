//! Runs the official Zalo renderer (`pc-dist` inside `app.asar`) headless in a hidden Tauri webview — port of
//! `OfficialClientHost.swift`. Rust supplies what Electron's preload/main process supplied (the `$z*` bridge,
//! networking, storage); the UI window is driven from the renderer's state, the renderer's own DOM is never shown
//! (a debug toggle can display it).
//!
//! Transport between the page and Rust (all same-origin on the `zalo-app://local` scheme, so the page's CSP
//! `connect-src 'self'` allows it):
//! - `POST /__compola/msg/<handler>` — what `window.webkit.messageHandlers.<handler>.postMessage` did in the Swift app
//!   (the host scripts are rewritten to call `window.__compolaMH.<handler>.postMessage`, see `webkit-shim.js`);
//!   answered `{value}` / `{error}`.
//! - `POST /__compola/bridge-sync` — blocking XHR for synchronous preload members.
//! - `POST /__compola/reply` — results of scripts Rust evaluated with [`Host::call_js`].

pub mod patches;
pub mod protocol;
pub mod scripts;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::asar::AsarArchive;
use crate::bridge::Registry;
use crate::net::NetworkProxy;
use crate::values::{Args, js_literal, undef};

pub const SCHEME: &str = "zalo-app";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Page {
    Login,
    Main,
    /// Electron's hidden `dbTask` window: runs the background task handlers (cloud scan, offline sync…).
    SharedWorker,
}

impl Page {
    pub fn file(self) -> &'static str {
        match self {
            Page::Login => "login.html",
            Page::Main => "index.html",
            Page::SharedWorker => "shared-worker.html",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostKind {
    /// The window the UI is driven from (login.html ⇄ index.html).
    Main,
    /// The hidden shared-worker window.
    Worker,
}

/// Callbacks a host reports to the engine.
pub trait HostObserver: Send + Sync {
    fn console(&self, _host: &Host, _line: &str) {}
    fn state(&self, _host: &Host, _state: Value) {}
    fn page_loaded(&self, _host: &Arc<Host>, _page: Page) {}
    fn page_started(&self, _host: &Arc<Host>) {}
    fn bridge_trace(&self, _host: &Host, _key: &str, _args: &Args) {}
    fn handler_error(&self, _host: &Host, _key: &str, _error: &str) {}
    fn channel_activity(&self, _host: &Arc<Host>, _channel: &str) {}
}

#[derive(Default)]
struct HostState {
    page: Option<Page>,
    /// Path-keyed member events the page listens to.
    subscriptions: HashSet<String>,
    subscribed_channels: HashSet<String>,
    provided_channels: HashSet<String>,
    unhandled_channels: HashMap<String, u32>,
    pending: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
}

pub struct Host {
    pub label: String,
    pub kind: HostKind,
    pub app: AppHandle,
    pub registry: Arc<Registry>,
    pub net: Arc<NetworkProxy>,
    pub asar: Arc<AsarArchive>,
    pub user_agent: String,
    observer: Arc<dyn HostObserver>,
    state: Mutex<HostState>,
    next_call: AtomicU64,
}

impl Host {
    /// Creates the hidden webview (not yet navigated). Call [`Host::load`] next.
    pub fn create(
        app: &AppHandle,
        label: &str,
        kind: HostKind,
        registry: Arc<Registry>,
        asar: Arc<AsarArchive>,
        user_agent: String,
        observer: Arc<dyn HostObserver>,
    ) -> anyhow::Result<Arc<Host>> {
        let net = NetworkProxy::new(app.clone(), label.to_owned(), user_agent.clone());
        let host = Arc::new(Host {
            label: label.to_owned(),
            kind,
            app: app.clone(),
            registry: registry.clone(),
            net,
            asar,
            user_agent: user_agent.clone(),
            observer,
            state: Mutex::new(HostState::default()),
            next_call: AtomicU64::new(1),
        });
        app.state::<Hosts>().insert(host.clone());

        let init = scripts::compose(&registry);
        let blank = url::Url::parse(&format!("{SCHEME}://local/__compola/blank.html")).unwrap();
        let nav_app = app.clone();
        let load_host = Arc::downgrade(&host);
        let debug = std::env::var_os("COMPOLA_SHOW_RENDERER").is_some();
        let window = WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(blank))
            .title(if kind == HostKind::Main { "Zalo renderer (debug)" } else { "Zalo shared worker (debug)" })
            .inner_size(1100.0, 720.0)
            .visible(debug)
            .user_agent(&user_agent)
            .initialization_script_for_all_frames(init)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .devtools(true)
            .disable_drag_drop_handler()
            // Only the renderer's own pages load here; links open in the browser.
            .on_navigation(move |url| {
                match url.scheme() {
                    SCHEME | "about" | "blob" | "data" => true,
                    "http" | "https" => {
                        let _ = tauri_plugin_opener::OpenerExt::opener(&nav_app).open_url(url.as_str(), None::<&str>);
                        false
                    }
                    _ => false,
                }
            })
            .on_page_load(move |_window, payload| {
                let Some(host) = load_host.upgrade() else { return };
                match payload.event() {
                    tauri::webview::PageLoadEvent::Started => host.observer.page_started(&host),
                    tauri::webview::PageLoadEvent::Finished => {
                        if payload.url().path().ends_with("/__compola/blank.html") {
                            return;
                        }
                        if let Some(page) = host.page() {
                            host.observer.page_loaded(&host, page);
                        }
                    }
                }
            })
            .build()?;
        // Keep a hidden window from closing the app / being closed by the user while debugging.
        let hide = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = hide.hide();
            }
        });
        Ok(host)
    }

    pub fn window(&self) -> Option<WebviewWindow> {
        self.app.get_webview_window(&self.label)
    }

    pub fn page(&self) -> Option<Page> {
        self.state.lock().page
    }

    pub fn load(&self, page: Page, query: &[(String, String)]) {
        let mut sorted = query.to_vec();
        sorted.sort();
        let mut url = url::Url::parse(&format!("{SCHEME}://local/{}", page.file())).unwrap();
        url.query_pairs_mut().extend_pairs(sorted.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        {
            let mut st = self.state.lock();
            st.page = Some(page);
            // A new document re-subscribes.
            st.subscriptions.clear();
            st.subscribed_channels.clear();
            st.provided_channels.clear();
        }
        log::info!("[{}] loading {}", self.label, page.file());
        if let Some(w) = self.window() {
            let _ = w.navigate(url);
        }
    }

    pub fn show_debug(&self) {
        if let Some(w) = self.window() {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    pub fn destroy(&self) {
        self.net.close_all();
        self.app.state::<Hosts>().remove(&self.label);
        let mut st = self.state.lock();
        for (_, tx) in st.pending.drain() {
            let _ = tx.send(Err("renderer closed".into()));
        }
        drop(st);
        if let Some(w) = self.window() {
            let _ = w.destroy();
        }
    }

    // ---- Rust → JS ----

    /// Fire-and-forget evaluation in the page.
    pub fn eval(&self, js: &str) {
        if let Some(w) = self.window() {
            let _ = w.eval(js);
        }
    }

    /// Runs `body` as the body of an async function in the page and returns its JSON-serialisable result
    /// (`callAsyncJavaScript` in the Swift app). `undefined` comes back as `Value::Null`.
    pub async fn call_js(&self, body: &str) -> Result<Value, String> {
        let id = self.next_call.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.state.lock().pending.insert(id, tx);
        let script = format!(
            "(async () => {{ const __id = {id}; let __out; try {{ const __v = await (async () => {{ {body}\n }})(); __out = {{ value: __v === undefined ? null : __v }}; }} catch (e) {{ __out = {{ error: String(e && e.message || e) }}; }} try {{ window.__compolaReply(__id, __out); }} catch (e) {{ window.__compolaReply(__id, {{ error: 'unserialisable result: ' + e }}); }} }})();"
        );
        self.eval(&script);
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("renderer closed".into()),
            Err(_) => {
                self.state.lock().pending.remove(&id);
                Err("timeout".into())
            }
        }
    }

    pub(crate) fn resolve_reply(&self, body: &[u8]) {
        let Ok(v) = serde_json::from_slice::<Value>(body) else { return };
        let Some(id) = v.get("id").and_then(Value::as_u64) else { return };
        let Some(tx) = self.state.lock().pending.remove(&id) else { return };
        let out = v.get("out").cloned().unwrap_or(Value::Null);
        let result = match out.get("error") {
            Some(e) if !e.is_null() => Err(e.as_str().map(str::to_owned).unwrap_or_else(|| e.to_string())),
            _ => Ok(out.get("value").cloned().unwrap_or(Value::Null)),
        };
        let _ = tx.send(result);
    }

    /// `webContents.send(channel, ...args)`. Returns whether the page listens on the channel.
    pub fn send(&self, channel: &str, args: Vec<Value>) -> bool {
        self.eval(&format!(
            "window.__zaloBridge && window.__zaloBridge.ipcEmit({}, {});",
            js_literal(&json!(channel)),
            js_literal(&Value::Array(args))
        ));
        self.state.lock().subscribed_channels.contains(channel)
    }

    pub fn is_subscribed(&self, channel: &str) -> bool {
        self.state.lock().subscribed_channels.contains(channel)
    }

    /// Zalo's `webContents.invoke(channel, ...args)` — main asks a renderer PROVIDE handler.
    pub async fn invoke_renderer(&self, channel: &str, args: Vec<Value>) -> Result<Value, String> {
        self.call_js(&format!(
            "return await window.__zaloBridge.ipcInvokeRenderer({}, {});",
            js_literal(&json!(channel)),
            js_literal(&Value::Array(args))
        ))
        .await
    }

    /// Events for path-keyed members.
    pub fn emit(&self, path: &str, args: Vec<Value>, with_event: bool) -> bool {
        if !self.state.lock().subscriptions.contains(path) {
            return false;
        }
        let f = if with_event { "emit" } else { "emitRaw" };
        self.eval(&format!(
            "window.__zaloBridge && window.__zaloBridge.{f}({}, {});",
            js_literal(&json!(path)),
            js_literal(&Value::Array(args))
        ));
        true
    }

    // ---- JS → Rust ----

    /// `/__compola/msg/<handler>`: returns the reply JSON (`{value}` / `{error}`).
    pub(crate) async fn handle_message(self: Arc<Self>, handler: &str, body: Value) -> Value {
        match handler {
            "zlog" => {
                let line = match &body {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                self.observer.console(&self, &line);
                json!({ "value": null })
            }
            "zstate" => {
                self.observer.state(&self, body);
                json!({ "value": null })
            }
            "znet" => self.net.clone().handle(self.clone(), body).await,
            "zbridge" => match self.clone().bridge_message(body).await {
                Ok(v) => json!({ "value": v }),
                Err(e) => json!({ "error": e }),
            },
            other => {
                log::warn!("[{}] message to unknown handler {other}", self.label);
                json!({ "error": format!("unknown handler {other}") })
            }
        }
    }

    async fn bridge_message(self: Arc<Self>, body: Value) -> Result<Value, String> {
        let kind = body.get("kind").and_then(Value::as_str).ok_or("bad bridge message")?.to_owned();
        let args: Args = body.get("args").and_then(Value::as_array).cloned().unwrap_or_default();

        if let Some(channel) = body.get("channel").and_then(Value::as_str) {
            match kind.as_str() {
                "subscribe" => {
                    self.state.lock().subscribed_channels.insert(channel.to_owned());
                    self.observer.channel_activity(&self, channel);
                    return Ok(Value::Null);
                }
                "provide" => {
                    self.state.lock().provided_channels.insert(channel.to_owned());
                    self.observer.channel_activity(&self, channel);
                    return Ok(Value::Null);
                }
                _ => {}
            }
            let key = format!("ipc:{channel}");
            self.observer.bridge_trace(&self, &key, &args);
            if let Some(h) = self.registry.channel_handler(channel) {
                return h(self.clone(), args).await.inspect_err(|e| self.observer.handler_error(&self, &key, e));
            }
            if let Some(h) = self.registry.channel_sync_handler(channel) {
                return h(&self, args).inspect_err(|e| self.observer.handler_error(&self, &key, e));
            }
            *self.state.lock().unhandled_channels.entry(channel.to_owned()).or_default() += 1;
            log::debug!("[{}] unhandled ipc {kind} {channel}", self.label);
            return Ok(undef());
        }

        let path = body.get("path").and_then(Value::as_str).ok_or("bad bridge message")?.to_owned();
        if kind == "subscribe" {
            self.state.lock().subscriptions.insert(path);
            return Ok(Value::Null);
        }
        self.observer.bridge_trace(&self, &path, &args);
        if let Some(h) = self.registry.async_handler(&path) {
            return h(self.clone(), args).await;
        }
        if let Some(h) = self.registry.sync_handler(&path) {
            return h(&self, args);
        }
        log::debug!("[{}] unhandled async bridge call {path}", self.label);
        Ok(undef())
    }

    /// Synchronous calls arrive as a blocking XHR to `/__compola/bridge-sync`.
    pub(crate) fn handle_sync_request(self: &Arc<Self>, body: &[u8]) -> Value {
        let Ok(json) = serde_json::from_slice::<Value>(body) else {
            return json!({ "error": "bad sync request" });
        };
        let args: Args = json.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
        let (key, handler) = if let Some(channel) = json.get("channel").and_then(Value::as_str) {
            let h = self.registry.channel_sync_handler(channel);
            if h.is_none() {
                *self.state.lock().unhandled_channels.entry(channel.to_owned()).or_default() += 1;
            }
            (format!("ipc:{channel}"), h)
        } else {
            let key = json.get("path").and_then(Value::as_str).unwrap_or("?").to_owned();
            let h = self.registry.sync_handler(&key);
            (key, h)
        };
        self.observer.bridge_trace(self, &key, &args);
        match handler {
            Some(h) => match h(self, args) {
                Ok(v) => json!({ "value": v }),
                Err(e) => {
                    self.observer.handler_error(self, &key, &e);
                    json!({ "error": e })
                }
            },
            None => {
                log::debug!("[{}] unhandled sync bridge call {key}", self.label);
                json!({ "value": undef() })
            }
        }
    }

    pub fn unhandled_channels(&self) -> HashMap<String, u32> {
        self.state.lock().unhandled_channels.clone()
    }
}

/// All live hosts by webview label (the protocol handler routes requests with it).
#[derive(Default)]
pub struct Hosts(Mutex<HashMap<String, Arc<Host>>>);

impl Hosts {
    pub fn insert(&self, host: Arc<Host>) {
        self.0.lock().insert(host.label.clone(), host);
    }
    pub fn remove(&self, label: &str) {
        self.0.lock().remove(label);
    }
    pub fn get(&self, label: &str) -> Option<Arc<Host>> {
        self.0.lock().get(label).cloned()
    }
}

/// Emits to the UI window (and to the UI windows of Compola apps joined to this one, see `crate::remote`).
pub fn emit_ui<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    crate::remote::forward_event(app, event, &payload);
    let _ = app.emit_to("main", event, payload);
}
