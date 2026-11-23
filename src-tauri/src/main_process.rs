//! Rust stand-in for the Electron **main process** of Zalo PC (port of `ZaloMainProcess.swift`).
//!
//! The official preload maps each bridge member to an IPC channel (`bridge-table.json`); this answers those channels
//! with the semantics of `main-dist/main.js` (`reanalysis/bridge-spec.md` §2), pushes the main → renderer events, and
//! drives page navigation (login ⇄ main window).

use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use rand::RngCore;
use serde_json::{Map, Value, json};
use sha2::Sha256;
use tauri::{AppHandle, Manager};

use crate::asar::AsarArchive;
use crate::bridge::Registry;
use crate::host::{Host, HostKind, HostObserver, Page};
use crate::net::cookies::{CookieJar, SESSION_COOKIE_DOMAINS};
use crate::platform::Platform;
use crate::sqlite_host::SqliteHost;
use crate::values::{ArgsExt, b64, bytes, undef, unb64};

pub const MAIN_LABEL: &str = "zalo-host";
pub const WORKER_LABEL: &str = "zalo-worker";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageBackend {
    /// The official "migration disabled" branch: IndexedDB in WebKit.
    IndexedDb,
    /// Native SQLite through `sqlite-host.js` + [`SqliteHost`], as Zalo PC 26.10 runs after its migration.
    Sqlite,
}

impl StorageBackend {
    fn as_str(self) -> &'static str {
        match self {
            StorageBackend::IndexedDb => "idb",
            StorageBackend::Sqlite => "sqlite",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s {
            "idb" => Some(Self::IndexedDb),
            "sqlite" => Some(Self::Sqlite),
            _ => None,
        }
    }
}

pub enum MainEvent {
    LoginSucceeded,
    LoggedOut,
    Badge(i64),
}

#[derive(Default)]
struct State {
    announced_session: Option<Value>,
    session: Option<Value>,
    viewer_key: Option<Value>,
    push_login_success_after_load: bool,
    /// Windows that announced `db-client-connected` (they receive `db-authenticated` broadcasts).
    db_clients: Vec<Weak<Host>>,
    /// Windows that announced `script-connected`.
    scripts: Vec<Weak<Host>>,
    pending_close_dbs: Vec<tokio::sync::oneshot::Sender<()>>,
}

pub struct MainProcess {
    pub app: AppHandle,
    pub platform: Arc<Platform>,
    pub asar: Arc<AsarArchive>,
    pub storage: StorageBackend,
    pub sqlite: Option<Arc<SqliteHost>>,
    pub registry: OnceLock<Arc<Registry>>,
    pub observer: OnceLock<Arc<dyn HostObserver>>,
    pub on_event: OnceLock<Box<dyn Fn(MainEvent) + Send + Sync>>,
    host: Mutex<Option<Arc<Host>>>,
    worker: Mutex<Option<Arc<Host>>>,
    state: Mutex<State>,
}

const STORAGE_STORE: &str = "compola-storage";

impl MainProcess {
    pub fn new(app: AppHandle, platform: Arc<Platform>, asar: Arc<AsarArchive>) -> Arc<Self> {
        let storage = choose_storage(&platform);
        let sqlite = (storage == StorageBackend::Sqlite).then(|| SqliteHost::new(platform.user_data.join("sqlite/_production")));
        log::info!("storage backend: {}", storage.as_str());
        Arc::new(Self {
            app,
            platform,
            asar,
            storage,
            sqlite,
            registry: OnceLock::new(),
            observer: OnceLock::new(),
            on_event: OnceLock::new(),
            host: Mutex::new(None),
            worker: Mutex::new(None),
            state: Mutex::new(State::default()),
        })
    }

    fn jar(&self) -> Arc<CookieJar> {
        self.app.state::<Arc<CookieJar>>().inner().clone()
    }

    fn emit(&self, e: MainEvent) {
        if let Some(f) = self.on_event.get() {
            f(e);
        }
    }

    pub fn host(&self) -> Option<Arc<Host>> {
        self.host.lock().clone()
    }

    pub fn worker(&self) -> Option<Arc<Host>> {
        self.worker.lock().clone()
    }

    pub fn has_session(&self) -> bool {
        self.jar().has_session()
    }

    fn new_host(&self, label: &str, kind: HostKind) -> anyhow::Result<Arc<Host>> {
        Host::create(
            &self.app,
            label,
            kind,
            self.registry.get().expect("registry").clone(),
            self.asar.clone(),
            self.platform.user_agent(),
            self.observer.get().expect("observer").clone(),
        )
    }

    /// Query string main appends to pages (`j6F3.qt`, spec §2.4).
    pub fn page_query(&self, already_login: bool) -> Vec<(String, String)> {
        let mut q = vec![
            ("type".into(), self.platform.client_type.clone()),
            ("client_version".into(), self.platform.client_version.clone()),
            ("app_version".into(), self.platform.app_version.clone()),
            ("about_version".into(), String::new()),
            ("new_install".into(), "0".into()),
            ("fail_sqlite3".into(), "true".into()),
            ("mode_lang".into(), String::new()),
        ];
        if already_login {
            q.push(("already_login".into(), "y".into()));
        }
        q
    }

    pub fn start(self: &Arc<Self>) -> anyhow::Result<()> {
        let host = self.new_host(MAIN_LABEL, HostKind::Main)?;
        *self.host.lock() = Some(host.clone());
        self.normalize_database_adapter_state();
        let session = self.has_session();
        if session {
            self.start_shared_worker();
        }
        host.load(if session { Page::Main } else { Page::Login }, &self.page_query(false));
        Ok(())
    }

    /// Electron main creates the hidden shared-worker window together with the main window.
    pub fn start_shared_worker(self: &Arc<Self>) {
        self.stop_shared_worker();
        if std::env::var_os("COMPOLA_NO_SHARED_WORKER").is_some() {
            return;
        }
        match self.new_host(WORKER_LABEL, HostKind::Worker) {
            Ok(worker) => {
                crate::shared_worker::router(&self.app).register_worker(&worker);
                *self.worker.lock() = Some(worker.clone());
                worker.load(Page::SharedWorker, &self.page_query(true));
            }
            Err(e) => log::error!("shared worker window: {e}"),
        }
    }

    pub fn stop_shared_worker(&self) {
        let Some(worker) = self.worker.lock().take() else { return };
        {
            let mut st = self.state.lock();
            st.db_clients.retain(|w| w.upgrade().is_some_and(|h| !Arc::ptr_eq(&h, &worker)));
            st.scripts.retain(|w| w.upgrade().is_some_and(|h| !Arc::ptr_eq(&h, &worker)));
        }
        crate::shared_worker::router(&self.app).reset_worker(&worker);
        worker.destroy();
    }

    /// IndexedDB backend: keep every account on IndexedDB (`database-config` → `*adp-st`: IDB = 0, SQLite = 1) and
    /// drop `upgradeRequired`, which would force a migration.
    pub fn normalize_database_adapter_state(&self) {
        if self.storage != StorageBackend::IndexedDb {
            return;
        }
        let mut store = self.platform.read_store("database-config");
        let mut changed = false;
        let keys: Vec<String> = store.keys().cloned().collect();
        for key in keys {
            if key.ends_with("adp-st") {
                if let Some(Ok(mut states)) = store.get(&key).and_then(Value::as_str).map(serde_json::from_str::<Map<String, Value>>) {
                    if states.values().any(|v| v.as_i64() != Some(0)) {
                        for v in states.values_mut() {
                            *v = json!(0);
                        }
                        store.insert(key, json!(serde_json::to_string(&states).unwrap_or_default()));
                        changed = true;
                    }
                }
            } else if key.to_ascii_lowercase().contains("upgraderequired") {
                store.remove(&key);
                changed = true;
            }
        }
        if changed {
            log::info!("database-config: reset adapter state to IndexedDB");
            let _ = self.platform.write_store("database-config", &store);
        }
    }

    /// Records `backend` for the next launch (the account's data is not migrated: the caller logs out).
    pub fn switch_storage(&self, backend: StorageBackend) {
        let mut m = Map::new();
        m.insert("backend".into(), json!(backend.as_str()));
        m.insert("chosenAt".into(), json!(crate::values::now_ms()));
        let _ = self.platform.write_store(STORAGE_STORE, &m);
        let mut store = self.platform.read_store("database-config");
        store.retain(|k, _| !(k.ends_with("adp-st") || k.to_ascii_lowercase().contains("upgraderequired")));
        let _ = self.platform.write_store("database-config", &store);
    }

    // ---- navigation callbacks ----

    pub fn page_did_start_loading(&self, host: &Arc<Host>) {
        if host.kind == HostKind::Main {
            host.send("unload-zlog", vec![]);
        }
    }

    pub fn page_did_finish_loading(&self, host: &Arc<Host>, page: Page) {
        match host.kind {
            HostKind::Main => {
                host.send("visibility-change", vec![json!("show")]);
                host.send("visibility-change", vec![json!("focus"), json!("1")]);
                let push = {
                    let mut st = self.state.lock();
                    std::mem::take(&mut st.push_login_success_after_load)
                };
                if page == Page::Main && push {
                    host.send("login-success", vec![]);
                }
            }
            HostKind::Worker => {
                crate::shared_worker::router(&self.app).worker_did_finish_load();
                if let Some(key) = self.state.lock().viewer_key.clone() {
                    host.send("receive-viewerkey", vec![key]);
                }
            }
        }
    }

    fn login_succeeded(self: &Arc<Self>) {
        log::info!("login-success → loading main page");
        self.state.lock().push_login_success_after_load = true;
        self.start_shared_worker();
        if let Some(h) = self.host() {
            h.load(Page::Main, &self.page_query(true));
        }
        self.emit(MainEvent::LoginSucceeded);
    }

    /// Drops everything tied to the signed-in account.
    pub fn reset_account_state(&self) {
        {
            let mut st = self.state.lock();
            st.session = None;
            st.announced_session = None;
            st.viewer_key = None;
        }
        self.stop_shared_worker();
        crate::shared_worker::router(&self.app).reset_session();
        crate::downloads::reset(&self.app);
        crate::calls::reset(&self.app);
        if let Some(sqlite) = &self.sqlite {
            sqlite.close_all();
        }
    }

    pub fn back_to_login(self: &Arc<Self>) {
        self.reset_account_state();
        if let Some(h) = self.host() {
            h.load(Page::Login, &self.page_query(false));
        }
        self.emit(MainEvent::LoggedOut);
    }

    /// Logout from the UI: clears the session cookies, then the login page.
    pub fn logout(self: &Arc<Self>) {
        self.jar().clear_zalo();
        self.back_to_login();
    }

    fn finish_close_dbs(&self) {
        for tx in self.state.lock().pending_close_dbs.drain(..) {
            let _ = tx.send(());
        }
    }

    // ---- IPC handlers ----

    pub fn install(self: &Arc<Self>, reg: &mut Registry) {
        let table: Value = serde_json::from_str(include_str!("../resources/bridge-table.json")).unwrap_or(Value::Null);
        match table.get("table").and_then(Value::as_object) {
            Some(t) => reg.load_ipc_table(t),
            None => log::error!("bridge-table.json missing — bridge will not match the official preload"),
        }

        let p = self.platform.clone();
        let weak = Arc::downgrade(self);
        let me = move || weak.upgrade();

        // App / paths (spec §2.3)
        {
            let p1 = p.clone();
            reg.handle("_electron_get-path", move |_, a| {
                let r = json!(p1.path(a.str_at(0).unwrap_or("userData")));
                async move { Ok(r) }
            });
            let p2 = p.clone();
            reg.handle_sync("_electron_get-path-sync", move |_, a| Ok(json!(p2.path(a.str_at(0).unwrap_or("userData")))));
            let v = p.app_version.clone();
            reg.handle("_electron_get-app-version", move |_, _| {
                let v = v.clone();
                async move { Ok(json!(v)) }
            });
            let ud = p.user_data.to_string_lossy().into_owned();
            let ud2 = ud.clone();
            reg.handle("_electron_get-app-path", move |_, _| {
                let ud = ud.clone();
                async move { Ok(json!(ud)) }
            });
            reg.handle_sync("_electron_get-app-path-sync", move |_, _| Ok(json!(ud2)));
            let p3 = p.clone();
            reg.handle_sync("electron-store-get-data", move |_, _| {
                Ok(json!({ "defaultCwd": p3.user_data.to_string_lossy(), "appVersion": p3.app_version }))
            });
            reg.handle("get-child-url", |_, _| async { Ok(json!("zalo-app://local/child.html")) });
            reg.handle("get-photo-viewer-url", |_, _| async { Ok(json!("zalo-app://local/popup-viewer.html")) });
            reg.handle("get-resource-dir", |_, _| async { Ok(json!("zalo-app://local/")) });
        }

        // Storage selection (spec §2.2, §4).
        let sqlite_backend = self.storage == StorageBackend::Sqlite;
        reg.handle("sqlite-available", move |_, _| async move { Ok(json!(sqlite_backend)) });
        reg.handle("fail-load-sqlite3", |_, _| async { Ok(json!(true)) });
        reg.handle("is-migrate-full-done", move |_, _| async move { Ok(json!(sqlite_backend)) });
        reg.handle("get-migrate-local-info", |_, _| async { Ok(json!({ "disable_migrate": true })) });
        reg.handle("migratedb:check_need_wait_bu", |_, _| async { Ok(json!(false)) });
        reg.handle("z-db-corruption-detector", |_, _| async { Ok(json!(0)) });
        reg.handle("get-name-of-target-script-for-dal-channel-from-host", move |_, _| async move {
            Ok(json!(if sqlite_backend { "utility-process-sqlite" } else { "preload-sqlite" }))
        });
        {
            let me = me.clone();
            reg.handle("migratedb:signal_restart", move |_, _| {
                let m = me();
                async move {
                    if let Some(m) = m {
                        log::info!("renderer requested restart for DB migration — reloading on {}", m.storage.as_str());
                        m.normalize_database_adapter_state();
                        let session = m.has_session();
                        if session { m.start_shared_worker() } else { m.stop_shared_worker() }
                        if let Some(h) = m.host() {
                            h.load(if session { Page::Main } else { Page::Login }, &m.page_query(false));
                        }
                    }
                    Ok(undef())
                }
            });
        }

        // Cookies (spec §2.1)
        {
            let me1 = me.clone();
            reg.handle("_electron_set-app-cookie", move |_, a| {
                if let (Some(m), Some(value)) = (me1(), a.string_at(0)) {
                    let jar = m.jar();
                    // Replace any previous session cookie so exactly one per domain is sent.
                    jar.remove_named("zpw_sek");
                    for d in SESSION_COOKIE_DOMAINS {
                        jar.set("zpw_sek", &value, d, 7, true);
                    }
                }
                async { Ok(undef()) }
            });
            let me2 = me.clone();
            reg.handle("_electron_set-cookie", move |_, a| {
                if let (Some(m), Some(name), Some(value)) = (me2(), a.string_at(0), a.string_at(1)) {
                    let domain = a
                        .string_at(3)
                        .or_else(|| a.str_at(2).and_then(|u| url::Url::parse(u).ok()).and_then(|u| u.host_str().map(str::to_owned)))
                        .unwrap_or_else(|| "zalo.me".into());
                    m.jar().set(&name, &value, &domain, 365, false);
                }
                async { Ok(undef()) }
            });
            let me3 = me.clone();
            reg.handle("_electron_clear-cookie", move |_, _| {
                if let Some(m) = me3() {
                    m.jar().clear_zalo();
                }
                async { Ok(undef()) }
            });
        }

        // Login / session hand-off
        {
            let me1 = me.clone();
            reg.handle("login-success", move |_, _| {
                if let Some(m) = me1() {
                    m.login_succeeded();
                }
                async { Ok(undef()) }
            });
            let me2 = me.clone();
            reg.handle("login", move |_, _| {
                if let Some(m) = me2() {
                    m.back_to_login();
                }
                async { Ok(undef()) }
            });
        }
        // ScriptCoordinator: every window announces itself; a session set by one window is broadcast to the others.
        {
            let me1 = me.clone();
            reg.handle("script-connected", move |host, _| {
                if let Some(m) = me1() {
                    let announced = {
                        let mut st = m.state.lock();
                        st.scripts.retain(|w| w.upgrade().is_some());
                        if !st.scripts.iter().any(|w| w.upgrade().is_some_and(|h| Arc::ptr_eq(&h, &host))) {
                            st.scripts.push(Arc::downgrade(&host));
                        }
                        st.announced_session.clone()
                    };
                    if let Some(s) = announced {
                        host.send("new-session", vec![s]);
                    }
                }
                async { Ok(undef()) }
            });
            let me2 = me.clone();
            reg.handle("new-session", move |host, a| {
                if let Some(m) = me2() {
                    let payload = a.first().cloned();
                    let targets = {
                        let mut st = m.state.lock();
                        st.session = payload.clone();
                        let empty = payload.as_ref().is_none_or(|p| p.is_null() || crate::values::is_undefined(p) || p.as_object().is_some_and(Map::is_empty));
                        if empty {
                            st.announced_session = None;
                            vec![]
                        } else {
                            st.announced_session = payload.clone();
                            st.scripts.iter().filter_map(Weak::upgrade).filter(|h| !Arc::ptr_eq(h, &host)).collect::<Vec<_>>()
                        }
                    };
                    if let Some(p) = payload {
                        for t in targets {
                            t.send("new-session", vec![p.clone()]);
                        }
                    }
                }
                async { Ok(undef()) }
            });
        }
        // MainDatabaseManager: authenticate → broadcast to every connected DB client window.
        {
            let me1 = me.clone();
            reg.handle("db-authenticated", move |host, a| {
                if let (Some(m), Some(session)) = (me1(), a.first().cloned()) {
                    let mut targets = {
                        let mut st = m.state.lock();
                        st.session = Some(session.clone());
                        st.db_clients.iter().filter_map(Weak::upgrade).collect::<Vec<_>>()
                    };
                    if !targets.iter().any(|h| Arc::ptr_eq(h, &host)) {
                        targets.push(host.clone());
                    }
                    for t in targets {
                        t.send("db-authenticated", vec![session.clone()]);
                    }
                }
                async { Ok(undef()) }
            });
            let me2 = me.clone();
            reg.handle("db-client-connected", move |host, _| {
                if let Some(m) = me2() {
                    let session = {
                        let mut st = m.state.lock();
                        st.db_clients.retain(|w| w.upgrade().is_some());
                        if !st.db_clients.iter().any(|w| w.upgrade().is_some_and(|h| Arc::ptr_eq(&h, &host))) {
                            st.db_clients.push(Arc::downgrade(&host));
                        }
                        st.session.clone()
                    };
                    if let Some(s) = session {
                        host.send("db-authenticated", vec![s]);
                    }
                }
                async { Ok(undef()) }
            });
        }
        crate::shared_worker::install(&self.app, reg);
        crate::downloads::install(&self.app, reg, &self.platform);
        // main `receiveViewerKeyListener`: relayed to the shared-worker window, whose SecureLocalStorage needs it.
        {
            let me1 = me.clone();
            reg.handle("receive-viewerkey", move |_, a| {
                if let (Some(m), Some(key)) = (me1(), a.first().cloned()) {
                    m.state.lock().viewer_key = Some(key.clone());
                    if let Some(w) = m.worker() {
                        w.send("receive-viewerkey", vec![key]);
                    }
                }
                async { Ok(undef()) }
            });
        }
        {
            let me1 = me.clone();
            reg.handle("db-start-close-dbs", move |host, a| {
                let m = me1();
                async move {
                    host.send("db-start-close-dbs", a);
                    let (Some(m), true) = (m, host.is_subscribed("db-start-close-dbs")) else { return Ok(undef()) };
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    m.state.lock().pending_close_dbs.push(tx);
                    let _ = tokio::time::timeout(Duration::from_secs(5), rx).await;
                    Ok(undef())
                }
            });
            let me2 = me.clone();
            reg.handle("db-finish-close-dbs", move |_, _| {
                if let Some(m) = me2() {
                    m.finish_close_dbs();
                }
                async { Ok(undef()) }
            });
        }

        // Secure storage used by the trusted-device protocol
        {
            let p1 = p.clone();
            reg.handle("zsafestorage-execute", move |_, a| {
                let r = safe_storage_execute(&p1, a.str_at(0).unwrap_or(""), &a[a.len().min(1)..]);
                async move { r }
            });
            reg.handle("zproto-encrypt-with-keychain", |_, a| {
                let items: Vec<Vec<u8>> = a.get(1).and_then(Value::as_array).map(|v| v.iter().filter_map(crate::values::js_bytes).collect()).unwrap_or_default();
                let id = a.string_at(0).unwrap_or_default();
                async move { keychain_cipher::encrypt(&id, &items).map(|v| json!(v.iter().map(|d| bytes(d)).collect::<Vec<_>>())) }
            });
            reg.handle("zproto-decrypt-with-keychain", |_, a| {
                let items: Vec<Vec<u8>> = a.get(1).and_then(Value::as_array).map(|v| v.iter().filter_map(crate::values::js_bytes).collect()).unwrap_or_default();
                let id = a.string_at(0).unwrap_or_default();
                async move { keychain_cipher::decrypt(&id, &items).map(|v| json!(v.iter().map(|d| bytes(d)).collect::<Vec<_>>())) }
            });
        }

        // Native helpers without a native module here: report "not supported" so the renderer falls back.
        for ch in ["exec", "exec_raw"] {
            reg.handle(ch, |_, _| async { Ok(json!({ "error": { "name": "NotSupported", "message": "Not supported", "code": "ENOTSUP" } })) });
        }
        reg.handle("get-cpu-infos", |_, _| async {
            Ok(json!([{ "pid": std::process::id(), "type": "Browser", "cpu": { "percentCPUUsage": 0, "idleWakeupsPerSecond": 0 }, "memory": { "workingSetSize": 0, "peakWorkingSetSize": 0 } }]))
        });
        {
            let me1 = me.clone();
            reg.handle("badge-count", move |_, a| {
                if let Some(m) = me1() {
                    m.emit(MainEvent::Badge(a.i64_at(0).unwrap_or(0)));
                }
                async { Ok(undef()) }
            });
        }
        crate::notifications::install(&self.app, reg);
        {
            let app = self.app.clone();
            reg.handle("__shell__", move |_, a| {
                let path = a.string_at(1).unwrap_or_default();
                let op = a.string_at(0).unwrap_or_default();
                let app = app.clone();
                async move {
                    use tauri_plugin_opener::OpenerExt;
                    if op == "showItemInFolder" {
                        let _ = app.opener().reveal_item_in_dir(&path);
                    } else {
                        return Ok(json!(app.opener().open_path(&path, None::<&str>).is_ok()));
                    }
                    Ok(json!(true))
                }
            });
        }
        reg.handle("__child_process__", |_, _| async { Err("EPERM: child_process is not available".to_owned()) });

        // Voice / video calls (`$zcall`): relayed to the native helper (calls.rs).
        crate::calls::install(&self.app, reg);
        reg.handle("request-compressed-log-file", |_, _| async {
            Ok(json!({ "status": 2, "data": { "message": "Not supported", "errorData": null } }))
        });

        if let Some(sqlite) = &self.sqlite {
            sqlite.install(reg);
            reg.value("$znode.sqliteHostEnabled", json!(true));
        }
    }
}

fn choose_storage(platform: &Platform) -> StorageBackend {
    if let Some(forced) = std::env::var("COMPOLA_STORAGE").ok().as_deref().and_then(StorageBackend::parse) {
        return forced;
    }
    let store = platform.read_store(STORAGE_STORE);
    if let Some(saved) = store.get("backend").and_then(Value::as_str).and_then(StorageBackend::parse) {
        return saved;
    }
    // An install that already ran the official client holds its data in IndexedDB; keep it readable.
    let chosen = if platform.store_path("database-config").exists() { StorageBackend::IndexedDb } else { StorageBackend::Sqlite };
    let mut m = Map::new();
    m.insert("backend".into(), json!(chosen.as_str()));
    m.insert("chosenAt".into(), json!(crate::values::now_ms()));
    let _ = platform.write_store(STORAGE_STORE, &m);
    chosen
}

// ---- zsafe-storage (main `tGN0`, spec §2.1) ----

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

pub fn aes_cbc(input: &[u8], key: &[u8], iv: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    if encrypt {
        let c = Aes256CbcEnc::new_from_slices(key, iv).map_err(|e| e.to_string())?;
        Ok(c.encrypt_padded_vec_mut::<Pkcs7>(input))
    } else {
        let c = Aes256CbcDec::new_from_slices(key, iv).map_err(|e| e.to_string())?;
        c.decrypt_padded_vec_mut::<Pkcs7>(input).map_err(|_| "bad decrypt".to_owned())
    }
}

const SAFE_KEY: &[u8] = b"d9c07b9de9915af401607d3f360211ac";
const SAFE_IV: [u8; 16] = [155, 72, 37, 195, 9, 217, 80, 42, 145, 102, 171, 75, 214, 176, 134, 18];

/// String vault backed by electron-store `zsafe-storage`: values at `zsskd.<key>`, AES-256-CBC with main's fixed
/// key/IV (cipher version `zsskv = "2"`).
fn safe_storage_execute(p: &Platform, method: &str, args: &[Value]) -> Result<Value, String> {
    let enc = |plain: &str| aes_cbc(plain.as_bytes(), SAFE_KEY, &SAFE_IV, true).map(|d| b64(&d));
    let dec = |sealed: &str| aes_cbc(&unb64(sealed), SAFE_KEY, &SAFE_IV, false).map(|d| String::from_utf8_lossy(&d).into_owned());
    match method {
        "encryptString" => enc(args.str_at(0).unwrap_or("")).map(Value::String),
        "decryptString" => dec(args.str_at(0).unwrap_or("")).map(Value::String),
        "get" => {
            let Some(key) = args.str_at(0).filter(|k| !k.contains('.')) else { return Ok(undef()) };
            let store = p.read_store("zsafe-storage");
            let sealed = store.get("zsskd").and_then(|v| v.get(key)).and_then(Value::as_str);
            Ok(sealed.and_then(|s| dec(s).ok()).map(Value::String).unwrap_or_else(undef))
        }
        "set" => {
            let Some(key) = args.str_at(0).filter(|k| !k.contains('.')) else { return Ok(undef()) };
            let mut store = p.read_store("zsafe-storage");
            let mut values = store.get("zsskd").and_then(Value::as_object).cloned().unwrap_or_default();
            match args.str_at(1) {
                Some(v) => {
                    values.insert(key.to_owned(), Value::String(enc(v)?));
                }
                None => {
                    values.remove(key);
                }
            }
            store.insert("zsskd".into(), Value::Object(values));
            store.insert("zsskv".into(), json!("2"));
            p.write_store("zsafe-storage", &store).map_err(|e| e.to_string())?;
            Ok(undef())
        }
        other => Err(format!("zsafestorage: unknown method {other}")),
    }
}

/// zprotocol keychain cipher (main SecureCipher, spec §2.1). Per identifier a 32-byte root key is kept in the
/// macOS Keychain; each item is `[0x49][iv16][salt16][ct][hmac32]` with HKDF-SHA256(root, salt, "ZprotocolSecureKDF").
pub mod keychain_cipher {
    use super::*;

    const SERVICE: &str = "app.compola.tauri.secure";
    const INFO: &[u8] = b"ZprotocolSecureKDF";
    const TYPE_RAW: u8 = 0x49;

    fn random(n: usize) -> Vec<u8> {
        let mut v = vec![0u8; n];
        rand::rngs::OsRng.fill_bytes(&mut v);
        v
    }

    fn derive(root: &[u8], salt: &[u8]) -> ([u8; 32], [u8; 32]) {
        let hk = hkdf::Hkdf::<Sha256>::new(Some(salt), root);
        let mut okm = [0u8; 64];
        hk.expand(INFO, &mut okm).expect("hkdf length");
        let mut enc = [0u8; 32];
        let mut mac = [0u8; 32];
        enc.copy_from_slice(&okm[..32]);
        mac.copy_from_slice(&okm[32..]);
        (enc, mac)
    }

    fn root_key(identifier: &str, create: bool) -> Result<Vec<u8>, String> {
        let account = format!("zprotocol.{}", identifier.to_lowercase());
        let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
        match entry.get_secret() {
            Ok(key) => Ok(key),
            // A key that exists but cannot be read now must never be shadowed by a fresh one.
            Err(keyring::Error::NoEntry) => {
                if !create {
                    return Err(format!("No secret for {identifier}"));
                }
                let key = random(32);
                entry.set_secret(&key).map_err(|e| format!("Keychain write failed ({e})"))?;
                Ok(key)
            }
            Err(e) => Err(format!("Keychain read failed ({e})")),
        }
    }

    pub fn encrypt(identifier: &str, items: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, String> {
        let root = root_key(identifier, true)?;
        items
            .iter()
            .map(|plain| {
                let (salt, iv) = (random(16), random(16));
                let (enc, mac) = derive(&root, &salt);
                let ct = aes_cbc(plain, &enc, &iv, true)?;
                let mut h = <Hmac<Sha256> as Mac>::new_from_slice(&mac).unwrap();
                h.update(&ct);
                h.update(&iv);
                h.update(&salt);
                let tag = h.finalize().into_bytes();
                let mut out = vec![TYPE_RAW];
                out.extend_from_slice(&iv);
                out.extend_from_slice(&salt);
                out.extend_from_slice(&ct);
                out.extend_from_slice(&tag);
                Ok(out)
            })
            .collect()
    }

    pub fn decrypt(identifier: &str, items: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, String> {
        let root = root_key(identifier, false)?;
        items
            .iter()
            .map(|sealed| {
                if sealed.len() < 65 {
                    return Err("Invalid encrypted data length".to_owned());
                }
                let iv = &sealed[1..17];
                let salt = &sealed[17..33];
                let ct = &sealed[33..sealed.len() - 32];
                let tag = &sealed[sealed.len() - 32..];
                let (enc, mac) = derive(&root, salt);
                let mut h = <Hmac<Sha256> as Mac>::new_from_slice(&mac).unwrap();
                h.update(ct);
                h.update(iv);
                h.update(salt);
                h.verify_slice(tag).map_err(|_| "Invalid MAC".to_owned())?;
                aes_cbc(ct, &enc, iv, false)
            })
            .collect()
    }
}
