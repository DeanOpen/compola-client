//! Several Zalo accounts in one Compola — the account registry, ids and per-account paths (docs/multi-account.md
//! §1, §2, §9). Pure file logic: everything takes the data root, so tests never touch the user's
//! `~/Library/Application Support/Compola`.
//!
//! ```text
//! accounts.json                  {version, active, maxAccounts, accounts: [{id, uid, name, label, avatar, order, enabled, addedAt}]}
//! ZaloData/  cookies.json        the `default` account (the layout from before multi-account: nothing moves)
//! Accounts/<id>/ZaloData/        each account added later
//! Accounts/<id>/cookies.json
//! ```

// Parts of the API are wired in later milestones (accounts manager, commands).
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::engine::{Engine, Phase};
use crate::runtime::RuntimeInfo;

use crate::net::cookies::CookieJar;
use crate::shared_worker::SharedWorkerRouter;

pub const DEFAULT_ID: &str = "default";
pub const DEFAULT_MAX_ACCOUNTS: usize = 5;
pub const REGISTRY_FILE: &str = "accounts.json";
pub const ACCOUNTS_DIR: &str = "Accounts";
const VERSION: u32 = 1;

/// `default` or `a` + 8 lowercase hex: ids end up in paths, webview labels and origins.
pub fn valid_id(id: &str) -> bool {
    id == DEFAULT_ID
        || (id.len() == 9 && id.starts_with('a') && id[1..].chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)))
}

fn new_id(taken: &[&str]) -> String {
    loop {
        let id = format!("a{:08x}", rand::random::<u32>());
        if !taken.contains(&id.as_str()) {
            return id;
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------------

/// Where an account lives on disk and in WebKit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountPaths {
    pub id: String,
    /// `<root>` for `default`, `<root>/Accounts/<id>` otherwise.
    pub data_root: PathBuf,
}

impl AccountPaths {
    pub fn new(root: &Path, id: &str) -> Self {
        let data_root = if id == DEFAULT_ID { root.to_path_buf() } else { root.join(ACCOUNTS_DIR).join(id) };
        Self { id: id.to_owned(), data_root }
    }

    pub fn is_default(&self) -> bool {
        self.id == DEFAULT_ID
    }

    /// Electron `userData` (the SQLite host root and electron-store files live below it).
    pub fn user_data(&self) -> PathBuf {
        self.data_root.join("ZaloData")
    }

    pub fn cookies(&self) -> PathBuf {
        self.data_root.join("cookies.json")
    }

    /// Host of the account's `zalo-app://` origin: WebKit partitions localStorage / IndexedDB / service workers by it.
    pub fn origin_host(&self) -> &str {
        if self.is_default() { "local" } else { &self.id }
    }

    /// Webview label of one of the account's hidden windows (`zalo-host` → `zalo-host-<id>`).
    pub fn label(&self, base: &str) -> String {
        if self.is_default() { base.to_owned() } else { format!("{base}-{}", self.id) }
    }
}

/// The account a webview label belongs to (`zalo-host-a1b2c3d4e` → `a1b2c3d4e`, `zalo-host` → `default`).
pub fn account_of_label(label: &str, base: &str) -> Option<String> {
    if label == base {
        return Some(DEFAULT_ID.to_owned());
    }
    let id = label.strip_prefix(base)?.strip_prefix('-')?;
    (valid_id(id) && id != DEFAULT_ID).then(|| id.to_owned())
}

/// The account an origin host names (`local` → `default`).
pub fn account_of_origin_host(host: &str) -> Option<String> {
    if host == "local" {
        return Some(DEFAULT_ID.to_owned());
    }
    (valid_id(host) && host != DEFAULT_ID).then(|| host.to_owned())
}

// ---------------------------------------------------------------------------------------------------------------------
// Runtime context of an account
// ---------------------------------------------------------------------------------------------------------------------

/// What every part of one account shares at runtime: its paths, its cookie jar (the only one its requests use) and
/// its shared-worker router.
pub struct Account {
    pub paths: AccountPaths,
    pub jar: Arc<CookieJar>,
    pub workers: Arc<SharedWorkerRouter>,
}

impl Account {
    pub fn open(root: &Path, id: &str) -> Arc<Self> {
        let paths = AccountPaths::new(root, id);
        let _ = std::fs::create_dir_all(&paths.data_root);
        Arc::new(Self { jar: Arc::new(CookieJar::load(paths.cookies())), workers: Arc::new(SharedWorkerRouter::default()), paths })
    }

    pub fn id(&self) -> &str {
        &self.paths.id
    }

    /// `zalo-app://<host>` (no trailing slash).
    pub fn origin(&self) -> String {
        format!("{}://{}", crate::host::SCHEME, self.paths.origin_host())
    }
}

/// The registry plus the accounts opened so far and their engines (managed app state).
pub struct Accounts {
    root: PathBuf,
    registry: Mutex<Registry>,
    open: Mutex<HashMap<String, Arc<Account>>>,
    engines: Mutex<HashMap<String, Arc<Engine>>>,
    /// The official runtime, once located / installed (shared by every account).
    runtime: Mutex<Option<RuntimeInfo>>,
    app: Mutex<Option<AppHandle>>,
}

impl Accounts {
    /// Loads (and migrates) `<root>/accounts.json`.
    pub fn load(root: &Path) -> Arc<Self> {
        Arc::new(Self {
            root: root.to_path_buf(),
            registry: Mutex::new(Registry::load(root)),
            open: Mutex::new(HashMap::new()),
            engines: Mutex::new(HashMap::new()),
            runtime: Mutex::new(None),
            app: Mutex::new(None),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A copy of the registry.
    pub fn registry(&self) -> Registry {
        self.registry.lock().clone()
    }

    /// Changes the registry and saves it.
    pub fn update<T>(&self, f: impl FnOnce(&mut Registry) -> Result<T, String>) -> Result<T, String> {
        let mut r = self.registry.lock();
        let out = f(&mut r)?;
        r.save(&self.root).map_err(|e| format!("Không lưu được danh sách tài khoản: {e}"))?;
        Ok(out)
    }

    pub fn active_id(&self) -> String {
        self.registry.lock().active.clone()
    }

    /// A registered account's context, opened (cookie jar loaded) on first use; `None` = active.
    pub fn get(&self, id: Option<&str>) -> Result<Arc<Account>, String> {
        let id = self.registry.lock().resolve(id)?;
        let mut open = self.open.lock();
        Ok(open.entry(id.clone()).or_insert_with(|| Account::open(&self.root, &id)).clone())
    }

    /// Forgets an opened account (after removal).
    pub fn close(&self, id: &str) {
        self.open.lock().remove(id);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Engines (docs/multi-account.md §3)
// ---------------------------------------------------------------------------------------------------------------------

/// Delay between two accounts' boots, so their WebContent processes do not all start at once.
const BOOT_STAGGER: std::time::Duration = std::time::Duration::from_secs(2);

/// Events that reach the UI window whatever account they concern.
const ALWAYS_TO_UI: &[&str] = &["compola://badge", "compola://accounts", "compola://notification-click", "compola://notification-reply", "compola://call-event"];

/// `ui_set_event_scope("all")`: the UI gets every account's events, not only the active one's.
static EVENT_SCOPE_ALL: AtomicBool = AtomicBool::new(false);

/// One row of the switcher.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub uid: Option<String>,
    pub name: Option<String>,
    pub label: Option<String>,
    pub avatar: Option<String>,
    pub order: u32,
    pub enabled: bool,
    pub active: bool,
    /// `disabled` | `starting` | `preparing` | `login` | `signingIn` | `ready`
    pub phase: &'static str,
    pub badge: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountList {
    pub active: String,
    pub max_accounts: usize,
    pub accounts: Vec<AccountSummary>,
}

fn phase_name(phase: &Phase) -> &'static str {
    match phase {
        Phase::Starting => "starting",
        Phase::Preparing { .. } => "preparing",
        Phase::Login { .. } => "login",
        Phase::SigningIn => "signingIn",
        Phase::Ready => "ready",
    }
}

/// An account-scoped payload: object payloads gain `account`; the others are wrapped (`badge` → `{account, count}`,
/// `log` → `{account, line}`, `page` → `{account, page}`, anything else → `{account, value}`).
pub fn tag_payload(event: &str, account: &str, payload: Value) -> Value {
    match payload {
        Value::Object(mut m) => {
            m.insert("account".into(), Value::String(account.to_owned()));
            Value::Object(m)
        }
        other => {
            let key = match event {
                "compola://badge" => "count",
                "compola://log" => "line",
                "compola://page" => "page",
                _ => "value",
            };
            json!({ "account": account, key: other })
        }
    }
}

impl Accounts {
    fn app(&self) -> Option<AppHandle> {
        self.app.lock().clone()
    }

    /// Emits an account's event: tagged with `account` to the UI window (the active account's, every account's with
    /// scope `all`, and the always-delivered kinds). Compola Server still sees the `default` account only, with the
    /// payloads it knows (until its account dimension lands, docs/multi-account.md §7).
    pub fn emit(&self, account: &str, event: &str, payload: Value) {
        let Some(app) = self.app() else { return };
        if account == DEFAULT_ID {
            crate::remote::forward_event(&app, event, &payload);
        }
        let to_ui = ALWAYS_TO_UI.contains(&event) || EVENT_SCOPE_ALL.load(Ordering::Relaxed) || account == self.active_id();
        if to_ui {
            use tauri::Emitter;
            let _ = app.emit_to("main", event, tag_payload(event, account, payload));
        }
    }

    pub fn engine(&self, id: Option<&str>) -> Result<Arc<Engine>, String> {
        let id = self.registry.lock().resolve(id)?;
        self.engines.lock().get(&id).cloned().ok_or_else(|| "Tài khoản này đang tắt".to_owned())
    }

    pub fn engines(&self) -> Vec<Arc<Engine>> {
        let order = self.registry.lock().ids();
        let engines = self.engines.lock();
        order.iter().filter_map(|id| engines.get(id).cloned()).collect()
    }

    /// Creates the engines of the enabled accounts and starts them: the first one locates or installs the runtime,
    /// the others boot on it, one after another.
    /// `run: false` (a joined app): the engines exist, so commands answer, but nothing starts.
    pub fn start(self: &Arc<Self>, app: &AppHandle, run: bool) {
        *self.app.lock() = Some(app.clone());
        let enabled: Vec<String> = self.registry.lock().accounts.iter().filter(|r| r.enabled).map(|r| r.id.clone()).collect();
        let mut first = run;
        for id in enabled {
            let Some(engine) = self.create_engine(&id) else { continue };
            if first {
                first = false;
                engine.start();
            }
        }
        self.changed();
    }

    fn create_engine(&self, id: &str) -> Option<Arc<Engine>> {
        let app = self.app()?;
        let account = self.get(Some(id)).ok()?;
        let engine = Engine::new(app, account);
        self.engines.lock().insert(id.to_owned(), engine.clone());
        Some(engine)
    }

    /// The runtime is ready (the first engine booted on it): every other engine boots on it, staggered.
    pub fn runtime_ready(self: &Arc<Self>, info: &RuntimeInfo) {
        let first = self.runtime.lock().replace(info.clone()).is_none();
        if first {
            self.boot_waiting();
        }
    }

    fn boot_waiting(self: &Arc<Self>) {
        let Some(info) = self.runtime.lock().clone() else { return };
        let waiting: Vec<Arc<Engine>> = self.engines().into_iter().filter(|e| !e.is_booted()).collect();
        tauri::async_runtime::spawn(async move {
            for engine in waiting {
                tokio::time::sleep(BOOT_STAGGER).await;
                engine.boot_with(info.clone());
            }
        });
    }

    /// Retries a failed runtime setup (on whichever engine shows it).
    pub fn retry_runtime_setup(&self) {
        for e in self.engines() {
            e.retry_runtime_setup();
        }
    }

    pub fn list(&self) -> AccountList {
        let r = self.registry.lock().clone();
        let engines = self.engines.lock().clone();
        AccountList {
            active: r.active.clone(),
            max_accounts: r.max_accounts,
            accounts: r
                .accounts
                .iter()
                .map(|rec| {
                    let engine = engines.get(&rec.id);
                    AccountSummary {
                        id: rec.id.clone(),
                        uid: rec.uid.clone(),
                        name: rec.name.clone(),
                        label: rec.label.clone(),
                        avatar: rec.avatar.clone(),
                        order: rec.order,
                        enabled: rec.enabled,
                        active: rec.id == r.active,
                        phase: match engine {
                            Some(e) => phase_name(&e.phase()),
                            None => "disabled",
                        },
                        badge: engine.map(|e| e.badge()).unwrap_or(0),
                    }
                })
                .collect(),
        }
    }

    /// Something the switcher shows changed: `compola://accounts {kind: changed, list}` and the dock badge (the sum).
    pub fn changed(&self) {
        let list = self.list();
        let total: i64 = list.accounts.iter().map(|a| a.badge.max(0)).sum();
        let Some(app) = self.app() else { return };
        if let Some(w) = app.get_webview_window("main") {
            let label = (total > 0).then(|| if total > 5 { "5+".to_owned() } else { total.to_string() });
            let _ = w.set_badge_label(label);
        }
        use tauri::Emitter;
        let _ = app.emit_to("main", "compola://accounts", json!({ "kind": "changed", "list": list }));
    }

    fn emit_accounts(&self, payload: Value) {
        if let Some(app) = self.app() {
            use tauri::Emitter;
            let _ = app.emit_to("main", "compola://accounts", payload);
        }
    }

    /// The renderer of `id` reported its signed-in user. A Zalo account already signed in on another account entry is
    /// never kept twice: this entry is removed and the existing one shown.
    pub fn observe_user(self: &Arc<Self>, id: &str, user: &Value) {
        let Some(uid) = user.get("userId").and_then(Value::as_str).filter(|u| !u.is_empty()) else { return };
        let name = user.get("displayName").and_then(Value::as_str).filter(|n| !n.is_empty()).or_else(|| user.get("zaloName").and_then(Value::as_str));
        let avatar = user.get("avatar").and_then(Value::as_str);
        let before = self.registry.lock().get(id).cloned();
        match self.update(|r| r.record_profile(id, uid, name, avatar)) {
            Ok(Some(existing)) => {
                log::warn!("accounts: {id} signed in to a Zalo account already registered as {existing}: removed");
                let this = self.clone();
                let id = id.to_owned();
                tauri::async_runtime::spawn(async move {
                    let _ = this.set_active(&existing);
                    let _ = this.remove(&id);
                    this.emit_accounts(json!({ "kind": "duplicate", "account": existing }));
                });
            }
            Ok(None) => {
                if self.registry.lock().get(id).cloned() != before {
                    self.changed();
                }
            }
            Err(e) => log::warn!("accounts: profile of {id} not recorded: {e}"),
        }
    }

    /// Adds an account and boots it on the QR page.
    pub fn add(self: &Arc<Self>, activate: bool) -> Result<String, String> {
        let id = self.update(|r| r.add())?;
        let engine = self.create_engine(&id).ok_or("Không tạo được tài khoản")?;
        // Bound first: a lock in the match scrutinee would be held while `boot_with` → `runtime_ready` locks it again.
        let runtime = self.runtime.lock().clone();
        match runtime {
            Some(info) => engine.boot_with(info),
            None => {
                // No runtime yet (first start still installing, or every account was disabled): this one sets it up.
                if self.engines().iter().all(|e| !e.is_booted()) {
                    engine.start();
                }
            }
        }
        if activate {
            self.set_active(&id)?;
        }
        self.changed();
        Ok(id)
    }

    /// Signs the account out and forgets it (`default`: signed out only, it stays registered).
    pub fn remove(self: &Arc<Self>, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("Tài khoản không tồn tại".into());
        }
        let was_active = self.active_id() == id;
        let removed = self.update(|r| r.remove(id))?;
        match removed {
            Removed::SignedOutOnly => {
                let engine = self.engines.lock().get(id).cloned();
                if let Some(e) = engine {
                    e.log_out();
                }
            }
            Removed::Deleted { new_active } => {
                // Locks are never held across engine calls (they emit, and emitting reads the engines).
                let engine = self.engines.lock().remove(id);
                if let Some(e) = engine {
                    e.log_out();
                    e.shutdown();
                }
                let account = self.open.lock().remove(id);
                if let Some(account) = account {
                    account.jar.clear_zalo();
                }
                let dir = AccountPaths::new(&self.root, id).data_root;
                tauri::async_runtime::spawn_blocking(move || {
                    // The renderers need a moment to let go of their files.
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let _ = std::fs::remove_dir_all(dir);
                });
                if was_active {
                    self.emit_accounts(json!({ "kind": "active", "account": new_active }));
                }
            }
        }
        self.changed();
        Ok(())
    }

    pub fn set_active(&self, id: &str) -> Result<(), String> {
        if self.active_id() == id {
            return Ok(());
        }
        self.update(|r| r.set_active(id))?;
        self.emit_accounts(json!({ "kind": "active", "account": id }));
        self.changed();
        Ok(())
    }

    pub fn reorder(&self, ids: &[String]) -> Result<(), String> {
        self.update(|r| r.reorder(ids))?;
        self.changed();
        Ok(())
    }

    pub fn rename(&self, id: &str, name: Option<String>) -> Result<(), String> {
        self.update(|r| r.rename(id, name))?;
        self.changed();
        Ok(())
    }

    /// A disabled account keeps its data and session but runs no renderer (no messages, no notifications).
    pub fn set_enabled(self: &Arc<Self>, id: &str, enabled: bool) -> Result<(), String> {
        self.update(|r| r.set_enabled(id, enabled))?;
        let running = self.engines.lock().get(id).cloned();
        match (enabled, running) {
            (false, Some(engine)) => {
                self.engines.lock().remove(id);
                engine.shutdown();
            }
            (true, None) => {
                if let Some(engine) = self.create_engine(id) {
                    let runtime = self.runtime.lock().clone();
                    match runtime {
                        Some(info) => engine.boot_with(info),
                        None => engine.start(),
                    }
                }
            }
            _ => {}
        }
        self.changed();
        Ok(())
    }

    /// App exit.
    pub fn shutdown_all(&self) {
        for e in self.engines() {
            e.shutdown();
        }
    }
}

/// The managed [`Accounts`].
pub fn accounts(app: &AppHandle) -> Arc<Accounts> {
    app.state::<Arc<Accounts>>().inner().clone()
}

/// An account's engine (`None` = the active account).
pub fn engine(app: &AppHandle, id: Option<&str>) -> Result<Arc<Engine>, String> {
    app.try_state::<Arc<Accounts>>().ok_or("not ready")?.engine(id)
}

/// The engine running the host labelled `label`.
pub fn engine_of_host(app: &AppHandle, host: &crate::host::Host) -> Option<Arc<Engine>> {
    app.try_state::<Arc<Accounts>>()?.engine(Some(host.account.id())).ok()
}

/// An account's context (`None` = active).
pub fn get(app: &AppHandle, id: Option<&str>) -> Result<Arc<Account>, String> {
    accounts(app).get(id)
}

/// The cookie jar of an account (`None` = active).
pub fn jar(app: &AppHandle, id: Option<&str>) -> Option<Arc<CookieJar>> {
    app.try_state::<Arc<Accounts>>()?.get(id).ok().map(|a| a.jar.clone())
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    /// Zalo user id, known once signed in.
    #[serde(default)]
    pub uid: Option<String>,
    /// Zalo display name (from the renderer's signed-in user).
    #[serde(default)]
    pub name: Option<String>,
    /// A local name an admin gave the account (shown instead of `name`).
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub order: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub added_at: u64,
}

fn yes() -> bool {
    true
}

impl Record {
    fn new(id: &str, order: u32, added_at: u64) -> Self {
        Self { id: id.to_owned(), uid: None, name: None, label: None, avatar: None, order, enabled: true, added_at }
    }

    /// What the switcher and notifications call the account.
    pub fn display_name(&self) -> Option<&str> {
        self.label.as_deref().or(self.name.as_deref()).filter(|s| !s.is_empty())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    #[serde(default)]
    pub version: u32,
    #[serde(default = "default_id")]
    pub active: String,
    #[serde(default = "default_max")]
    pub max_accounts: usize,
    #[serde(default)]
    pub accounts: Vec<Record>,
}

fn default_id() -> String {
    DEFAULT_ID.to_owned()
}
fn default_max() -> usize {
    DEFAULT_MAX_ACCOUNTS
}

/// What `remove` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Removed {
    /// The row is gone; delete `Accounts/<id>/`.
    Deleted { new_active: String },
    /// `default` stays registered: only its session goes (sign out).
    SignedOutOnly,
}

impl Default for Registry {
    fn default() -> Self {
        Self { version: VERSION, active: default_id(), max_accounts: DEFAULT_MAX_ACCOUNTS, accounts: vec![Record::new(DEFAULT_ID, 0, 0)] }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Registry {
    pub fn path(root: &Path) -> PathBuf {
        root.join(REGISTRY_FILE)
    }

    /// Reads `<root>/accounts.json`. An install from before multi-account (no file) becomes the single `default` account
    /// with its paths unchanged; the file is written then. An unreadable file is kept as `accounts.json.bad` and the
    /// registry is rebuilt from what is on disk. Valid `Accounts/<id>/` folders without a row are adopted.
    pub fn load(root: &Path) -> Self {
        let path = Self::path(root);
        let mut registry = match std::fs::read(&path) {
            Ok(data) => match serde_json::from_slice::<Registry>(&data) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("accounts.json unreadable ({e}): rebuilt from disk");
                    let _ = std::fs::rename(&path, root.join(format!("{REGISTRY_FILE}.bad")));
                    Registry::default()
                }
            },
            Err(_) => Registry::default(),
        };
        let before = registry.clone();
        registry.normalize(root);
        if registry != before || !path.exists() {
            if let Err(e) = registry.save(root) {
                log::warn!("accounts.json not written: {e}");
            }
        }
        registry
    }

    /// Invariants: valid unique ids, `default` present, orphaned account folders adopted, dense order, a registered
    /// active account, a sane cap.
    fn normalize(&mut self, root: &Path) {
        self.version = VERSION;
        let mut seen = std::collections::HashSet::new();
        self.accounts.retain(|r| valid_id(&r.id) && seen.insert(r.id.clone()));
        if !self.accounts.iter().any(|r| r.id == DEFAULT_ID) {
            self.accounts.insert(0, Record::new(DEFAULT_ID, 0, 0));
        }
        if let Ok(entries) = std::fs::read_dir(root.join(ACCOUNTS_DIR)) {
            let mut orphans: Vec<String> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .filter(|id| valid_id(id) && id != DEFAULT_ID && !self.accounts.iter().any(|r| &r.id == id))
                .collect();
            orphans.sort();
            for id in orphans {
                let order = self.accounts.len() as u32;
                self.accounts.push(Record::new(&id, order, now_ms()));
            }
        }
        self.accounts.sort_by_key(|r| r.order);
        for (i, r) in self.accounts.iter_mut().enumerate() {
            r.order = i as u32;
        }
        if !self.accounts.iter().any(|r| r.id == self.active) {
            self.active = self.accounts[0].id.clone();
        }
        if self.max_accounts == 0 {
            self.max_accounts = DEFAULT_MAX_ACCOUNTS;
        }
    }

    /// Atomic write (tmp + rename).
    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(root)?;
        let path = Self::path(root);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }

    pub fn get(&self, id: &str) -> Option<&Record> {
        self.accounts.iter().find(|r| r.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Result<&mut Record, String> {
        self.accounts.iter_mut().find(|r| r.id == id).ok_or_else(|| "Tài khoản không tồn tại".to_owned())
    }

    pub fn ids(&self) -> Vec<String> {
        self.accounts.iter().map(|r| r.id.clone()).collect()
    }

    /// Resolves an optional account argument: `None` → the active account; an unknown or invalid id is an error.
    pub fn resolve(&self, account: Option<&str>) -> Result<String, String> {
        match account {
            None => Ok(self.active.clone()),
            Some(id) if valid_id(id) && self.get(id).is_some() => Ok(id.to_owned()),
            Some(_) => Err("Tài khoản không tồn tại".into()),
        }
    }

    /// A new account at the end of the list (not yet active).
    pub fn add(&mut self) -> Result<String, String> {
        if self.accounts.len() >= self.max_accounts {
            return Err(format!("Đã đạt số tài khoản tối đa ({})", self.max_accounts));
        }
        let taken: Vec<&str> = self.accounts.iter().map(|r| r.id.as_str()).collect();
        let id = new_id(&taken);
        let order = self.accounts.len() as u32;
        self.accounts.push(Record::new(&id, order, now_ms()));
        Ok(id)
    }

    pub fn remove(&mut self, id: &str) -> Result<Removed, String> {
        self.get_mut(id)?;
        if id == DEFAULT_ID {
            let r = self.get_mut(id)?;
            r.uid = None;
            r.name = None;
            r.avatar = None;
            return Ok(Removed::SignedOutOnly);
        }
        self.accounts.retain(|r| r.id != id);
        for (i, r) in self.accounts.iter_mut().enumerate() {
            r.order = i as u32;
        }
        if self.active == id {
            self.active = self.accounts[0].id.clone();
        }
        Ok(Removed::Deleted { new_active: self.active.clone() })
    }

    pub fn set_active(&mut self, id: &str) -> Result<(), String> {
        self.get_mut(id)?;
        self.active = id.to_owned();
        Ok(())
    }

    /// `ids` must be exactly the registered ids, in the new order.
    pub fn reorder(&mut self, ids: &[String]) -> Result<(), String> {
        let mut current = self.ids();
        let mut wanted = ids.to_vec();
        current.sort();
        wanted.sort();
        if current != wanted {
            return Err("Danh sách tài khoản không khớp".into());
        }
        for r in &mut self.accounts {
            r.order = ids.iter().position(|i| i == &r.id).unwrap_or(0) as u32;
        }
        self.accounts.sort_by_key(|r| r.order);
        Ok(())
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), String> {
        self.get_mut(id)?.enabled = enabled;
        Ok(())
    }

    pub fn rename(&mut self, id: &str, label: Option<String>) -> Result<(), String> {
        self.get_mut(id)?.label = label.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
        Ok(())
    }

    /// The renderer reported its signed-in user. Returns the *other* account already signed in with this uid (the
    /// caller then removes `id`: one Zalo account is never signed in twice); `Ok(None)` when recorded.
    pub fn record_profile(&mut self, id: &str, uid: &str, name: Option<&str>, avatar: Option<&str>) -> Result<Option<String>, String> {
        if let Some(other) = self.accounts.iter().find(|r| r.id != id && r.uid.as_deref() == Some(uid)) {
            return Ok(Some(other.id.clone()));
        }
        let r = self.get_mut(id)?;
        r.uid = Some(uid.to_owned());
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            r.name = Some(n.to_owned());
        }
        if let Some(a) = avatar.filter(|a| !a.is_empty()) {
            r.avatar = Some(a.to_owned());
        }
        Ok(None)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands (docs/multi-account.md §6)
// ---------------------------------------------------------------------------------------------------------------------

type AccountsState<'a> = tauri::State<'a, Arc<Accounts>>;

#[tauri::command]
pub fn accounts_list(accounts: AccountsState<'_>) -> AccountList {
    accounts.list()
}

#[tauri::command]
pub fn account_add(accounts: AccountsState<'_>, activate: Option<bool>) -> Result<Value, String> {
    let id = accounts.inner().add(activate.unwrap_or(true))?;
    Ok(json!({ "id": id }))
}

#[tauri::command]
pub fn account_remove(accounts: AccountsState<'_>, account: String) -> Result<(), String> {
    accounts.inner().remove(&account)
}

#[tauri::command]
pub fn account_set_active(accounts: AccountsState<'_>, account: String) -> Result<(), String> {
    accounts.set_active(&account)
}

#[tauri::command]
pub fn account_reorder(accounts: AccountsState<'_>, ids: Vec<String>) -> Result<(), String> {
    accounts.reorder(&ids)
}

#[tauri::command]
pub fn account_set_enabled(accounts: AccountsState<'_>, account: String, enabled: bool) -> Result<(), String> {
    accounts.inner().set_enabled(&account, enabled)
}

#[tauri::command]
pub fn account_rename(accounts: AccountsState<'_>, account: String, name: Option<String>) -> Result<(), String> {
    accounts.rename(&account, name)
}

/// `"all"`: the UI window receives every account's events; `"active"` (default): only the active account's.
#[tauri::command]
pub fn ui_set_event_scope(scope: String) -> Result<(), String> {
    match scope.as_str() {
        "all" => EVENT_SCOPE_ALL.store(true, Ordering::Relaxed),
        "active" => EVENT_SCOPE_ALL.store(false, Ordering::Relaxed),
        _ => return Err("scope: all | active".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("compola-accounts-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn ids_are_validated() {
        assert!(valid_id("default"));
        assert!(valid_id("a1b2c3d4e"));
        for bad in ["", "a1b2c3d4", "a1b2c3d4e5", "b1b2c3d4e", "a1B2c3d4e", "a1b2c3g4e", "../a1b2c3", "local", "a1b2/3d4e"] {
            assert!(!valid_id(bad), "{bad}");
        }
        let id = new_id(&[]);
        assert!(valid_id(id.as_str()) && id != DEFAULT_ID);
    }

    #[test]
    fn default_account_keeps_the_pre_multi_account_layout() {
        let root = Path::new("/data/Compola");
        let d = AccountPaths::new(root, DEFAULT_ID);
        assert_eq!(d.user_data(), root.join("ZaloData"));
        assert_eq!(d.cookies(), root.join("cookies.json"));
        assert_eq!(d.origin_host(), "local");
        assert_eq!(d.label("zalo-host"), "zalo-host");
        let a = AccountPaths::new(root, "a1b2c3d4e");
        assert_eq!(a.user_data(), root.join("Accounts/a1b2c3d4e/ZaloData"));
        assert_eq!(a.cookies(), root.join("Accounts/a1b2c3d4e/cookies.json"));
        assert_eq!(a.origin_host(), "a1b2c3d4e");
        assert_eq!(a.label("zalo-worker"), "zalo-worker-a1b2c3d4e");
        assert_eq!(account_of_label("zalo-worker-a1b2c3d4e", "zalo-worker").as_deref(), Some("a1b2c3d4e"));
        assert_eq!(account_of_label("zalo-host", "zalo-host").as_deref(), Some("default"));
        assert_eq!(account_of_label("zalo-host-default", "zalo-host"), None);
        assert_eq!(account_of_label("main", "zalo-host"), None);
        assert_eq!(account_of_origin_host("local").as_deref(), Some("default"));
        assert_eq!(account_of_origin_host("a1b2c3d4e").as_deref(), Some("a1b2c3d4e"));
        assert_eq!(account_of_origin_host("evil"), None);
    }

    #[test]
    fn migration_of_an_existing_install_moves_nothing() {
        let root = temp_root();
        // A signed-in install from before multi-account.
        std::fs::create_dir_all(root.join("ZaloData/sqlite")).unwrap();
        std::fs::write(root.join("cookies.json"), b"[cookies]").unwrap();
        std::fs::write(root.join("ZaloData/sqlite/x.db"), b"db").unwrap();
        let r = Registry::load(&root);
        assert_eq!(r.active, DEFAULT_ID);
        assert_eq!(r.max_accounts, 5);
        assert_eq!(r.ids(), vec!["default"]);
        assert!(r.accounts[0].enabled);
        // Written, and nothing moved.
        assert!(root.join("accounts.json").exists());
        assert_eq!(std::fs::read(root.join("cookies.json")).unwrap(), b"[cookies]");
        assert_eq!(std::fs::read(root.join("ZaloData/sqlite/x.db")).unwrap(), b"db");
        assert!(!root.join("Accounts").exists());
        // Loading again is stable.
        assert_eq!(Registry::load(&root), r);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn registry_round_trip_and_operations() {
        let root = temp_root();
        let mut r = Registry::load(&root);
        let a = r.add().unwrap();
        let b = r.add().unwrap();
        assert_ne!(a, b);
        r.set_active(&b).unwrap();
        r.rename(&a, Some("  Sales 2 ".into())).unwrap();
        assert_eq!(r.record_profile(&a, "111", Some("Nguyễn A"), Some("https://ava")).unwrap(), None);
        r.reorder(&[b.clone(), DEFAULT_ID.into(), a.clone()]).unwrap();
        assert!(r.reorder(&[b.clone()]).is_err());
        r.set_enabled(&a, false).unwrap();
        r.save(&root).unwrap();

        let loaded = Registry::load(&root);
        assert_eq!(loaded, r);
        assert_eq!(loaded.ids(), vec![b.clone(), DEFAULT_ID.into(), a.clone()]);
        assert_eq!(loaded.active, b);
        let ra = loaded.get(&a).unwrap();
        assert_eq!(ra.display_name(), Some("Sales 2"));
        assert_eq!(ra.uid.as_deref(), Some("111"));
        assert!(!ra.enabled);
        assert_eq!(loaded.resolve(None).unwrap(), b);
        assert_eq!(loaded.resolve(Some(&a)).unwrap(), a);
        assert!(loaded.resolve(Some("a00000000")).is_err());
        assert!(loaded.resolve(Some("../x")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cap_duplicates_and_removal() {
        let mut r = Registry::default();
        for _ in 1..DEFAULT_MAX_ACCOUNTS {
            r.add().unwrap();
        }
        assert!(r.add().unwrap_err().contains("(5)"));
        let ids = r.ids();
        let (x, y) = (ids[1].clone(), ids[2].clone());
        // The same Zalo account cannot be signed in twice.
        assert_eq!(r.record_profile(&x, "42", Some("A"), None).unwrap(), None);
        assert_eq!(r.record_profile(&y, "42", Some("A"), None).unwrap(), Some(x.clone()));
        assert_eq!(r.get(&y).unwrap().uid, None);
        // Removing the active account activates the first remaining one; `default` only loses its session.
        r.set_active(&y).unwrap();
        assert_eq!(r.remove(&y).unwrap(), Removed::Deleted { new_active: DEFAULT_ID.into() });
        assert!(r.get(&y).is_none());
        assert_eq!(r.accounts.iter().map(|a| a.order).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        r.record_profile(DEFAULT_ID, "7", Some("Me"), None).unwrap();
        assert_eq!(r.remove(DEFAULT_ID).unwrap(), Removed::SignedOutOnly);
        assert!(r.get(DEFAULT_ID).is_some_and(|d| d.uid.is_none()));
        assert!(r.remove("a00000000").is_err());
        assert!(r.add().is_ok()); // a slot is free again
    }

    #[test]
    fn cookie_jars_are_isolated_per_account() {
        let root = temp_root();
        let accounts = Accounts::load(&root);
        let b = accounts.update(|r| r.add()).unwrap();
        let (d, other) = (accounts.get(Some(DEFAULT_ID)).unwrap(), accounts.get(Some(&b)).unwrap());
        // Same account → same context (one jar per account, never two writers of one file).
        assert!(Arc::ptr_eq(&d, &accounts.get(None).unwrap()));
        let url = url::Url::parse("https://chat.zalo.me/").unwrap();
        d.jar.set("zpw_sek", "default-session", ".zalo.me", 365, false);
        assert!(d.jar.header_for(&url).is_some_and(|h| h.contains("default-session")));
        assert!(other.jar.header_for(&url).is_none());
        d.jar.set("zpw_sek", "default-session", ".zaloapp.com", 365, false);
        assert!(d.jar.has_session() && !other.jar.has_session());
        other.jar.set("zpw_sek", "second-session", ".zalo.me", 365, false);
        assert!(!d.jar.header_for(&url).unwrap().contains("second-session"));
        // Persisted to each account's own file: the default keeps the pre-multi-account path.
        assert_eq!(d.paths.cookies(), root.join("cookies.json"));
        assert_eq!(other.paths.cookies(), root.join("Accounts").join(&b).join("cookies.json"));
        let reloaded = Account::open(&root, &b);
        assert!(reloaded.jar.header_for(&url).is_some_and(|h| h.contains("second-session") && !h.contains("default-session")));
        assert!(Account::open(&root, DEFAULT_ID).jar.header_for(&url).is_some_and(|h| !h.contains("second-session")));
        assert!(accounts.get(Some("a00000000")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn event_payloads_carry_the_account() {
        assert_eq!(tag_payload("compola://state", "a1b2c3d4e", json!({ "kind": "x" })), json!({ "kind": "x", "account": "a1b2c3d4e" }));
        assert_eq!(tag_payload("compola://badge", "default", json!(3)), json!({ "account": "default", "count": 3 }));
        assert_eq!(tag_payload("compola://log", "default", json!("l")), json!({ "account": "default", "line": "l" }));
        assert_eq!(tag_payload("compola://page", "default", json!("main")), json!({ "account": "default", "page": "main" }));
        assert_eq!(tag_payload("compola://other", "default", json!(1)), json!({ "account": "default", "value": 1 }));
    }

    #[test]
    fn broken_file_and_orphaned_folders_are_recovered() {
        let root = temp_root();
        std::fs::write(root.join("accounts.json"), b"{not json").unwrap();
        std::fs::create_dir_all(root.join("Accounts/a0000000a/ZaloData")).unwrap();
        std::fs::create_dir_all(root.join("Accounts/not-an-id")).unwrap();
        let r = Registry::load(&root);
        assert!(root.join("accounts.json.bad").exists());
        assert_eq!(r.ids(), vec!["default", "a0000000a"]);
        assert_eq!(r.active, DEFAULT_ID);
        // Rows with invalid or duplicate ids and a missing default are repaired.
        let raw = r#"{"version":1,"active":"a0000000b","accounts":[{"id":"a0000000b"},{"id":"a0000000b"},{"id":"../x"}]}"#;
        std::fs::write(root.join("accounts.json"), raw).unwrap();
        let r = Registry::load(&root);
        assert_eq!(r.ids(), vec!["default", "a0000000b", "a0000000a"]);
        assert_eq!(r.active, "a0000000b");
        let _ = std::fs::remove_dir_all(&root);
    }
}
