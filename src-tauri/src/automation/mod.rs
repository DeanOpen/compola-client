//! Automation: an MCP server (Compola's Zalo tools for AI clients), an MCP client (external servers' tools for
//! schedules and add-ons), a cron scheduler and the add-on store. The UI talks to it through the `automation_*`
//! commands below and the `compola://automation` event:
//!
//! - `{kind:'message', message}` — a new message in any conversation (from the conversation previews)
//! - `{kind:'schedule', addonId, jobId, payload}` — an add-on's schedule fired
//! - `{kind:'toolCall', requestId, addonId, tool, arguments}` — an MCP client called an add-on's tool; answer with
//!   `automation_addon_tool_reply`
//! - `{kind:'changed'}` — config, jobs, runs or server status changed: refetch `automation_state`

pub mod addons;
pub mod config;
pub mod cron;
pub mod mcp_client;
pub mod mcp_server;
mod mirror;
pub mod search;
mod tools;

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use chrono::{Datelike, Local, TimeZone};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{Mutex as AsyncMutex, Notify, oneshot};

use crate::engine::{Engine, Phase};
use crate::host::emit_ui;
use config::{Action, AddonState, Config, Job, McpClientConfig, McpServerConfig, Schedule};

pub const EVENT: &str = "compola://automation";
const RUN_LOG_CAP: usize = 200;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLog {
    pub job_id: String,
    pub job_name: String,
    pub at: i64,
    pub ok: bool,
    pub status: String,
    /// `schedule`, `manual`.
    pub trigger: String,
}

pub struct Automation {
    app: AppHandle,
    config: Mutex<Config>,
    mirror: Mutex<mirror::Mirror>,
    pool: mcp_client::Pool,
    server: AsyncMutex<Option<mcp_server::ServerHandle>>,
    server_error: Mutex<Option<String>>,
    next_due: Mutex<HashMap<String, i64>>,
    /// Jobs executing right now (never queued again until they finish).
    inflight: Mutex<std::collections::HashSet<String>>,
    runs: Mutex<VecDeque<RunLog>>,
    /// Tools the running add-ons registered (`compola.tools.register`), by add-on id.
    addon_tools: Mutex<HashMap<String, Vec<Value>>>,
    addon_calls: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    wake: Notify,
    /// The message search index (None when it could not be opened) and its ordered writer thread.
    index: Option<Arc<search::Index>>,
    index_tx: Option<std::sync::mpsc::Sender<IndexJob>>,
    http: reqwest::Client,
    /// Last embeddings failure, shown in Settings; cleared on success.
    embed_error: Mutex<Option<String>>,
}

enum IndexJob {
    Upsert(Vec<mirror::Message>),
    Clear,
}

impl Automation {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let mut config = config::load();
        let seeded = addons::seed(&config.seeded_addons);
        if !seeded.is_empty() {
            for id in &seeded {
                config.addons.entry(id.clone()).or_default();
            }
            config.seeded_addons.extend(seeded);
        }
        if config.mcp_server.token.is_empty() {
            config.mcp_server.token = config::new_token();
        }
        if let Err(e) = config::save(&config) {
            log::warn!("automation: cannot save config: {e}");
        }
        let index = match search::Index::open(&search::Index::path()) {
            Ok(ix) => Some(Arc::new(ix)),
            Err(e) => {
                log::warn!("search index unavailable: {e}");
                None
            }
        };
        // One writer thread keeps index updates in order and off the renderer's callback thread.
        let index_tx = index.clone().map(|ix| {
            let (tx, rx) = std::sync::mpsc::channel::<IndexJob>();
            std::thread::Builder::new()
                .name("compola-search-index".into())
                .spawn(move || {
                    while let Ok(job) = rx.recv() {
                        let result = match job {
                            IndexJob::Upsert(batch) => ix.upsert(&batch).map(|_| ()),
                            IndexJob::Clear => ix.clear(),
                        };
                        if let Err(e) = result {
                            log::warn!("search index: {e}");
                        }
                    }
                })
                .ok()
                .map(|_| tx)
        });
        Arc::new(Self {
            app,
            config: Mutex::new(config),
            mirror: Mutex::default(),
            pool: mcp_client::Pool::default(),
            server: AsyncMutex::new(None),
            server_error: Mutex::new(None),
            next_due: Mutex::default(),
            inflight: Mutex::default(),
            runs: Mutex::default(),
            addon_tools: Mutex::default(),
            addon_calls: Mutex::default(),
            wake: Notify::new(),
            index,
            index_tx: index_tx.flatten(),
            http: reqwest::Client::builder().timeout(Duration::from_secs(120)).build().unwrap_or_default(),
            embed_error: Mutex::new(None),
        })
    }

    pub fn start(self: &Arc<Self>) {
        self.recompute_due();
        // Background embeddings for semantic search.
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                let Some(this) = weak.upgrade() else { break };
                let cfg = this.config.lock().search.clone();
                let pause = match (&this.index, cfg.enabled && cfg.semantic) {
                    (Some(ix), true) => match search::embed_pending(ix, &this.http, &cfg, 32).await {
                        Ok(0) => {
                            *this.embed_error.lock() = None;
                            10
                        }
                        Ok(_) => {
                            *this.embed_error.lock() = None;
                            1
                        }
                        Err(e) => {
                            log::info!("search embeddings: {e}");
                            *this.embed_error.lock() = Some(e);
                            60
                        }
                    },
                    _ => 15,
                };
                drop(this);
                tokio::time::sleep(Duration::from_secs(pause)).await;
            }
        });
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            this.apply_server().await;
        });
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                let Some(this) = weak.upgrade() else { break };
                let now = Local::now().timestamp_millis();
                let soonest = this.next_due.lock().values().copied().min();
                let wait = soonest.map(|t| (t - now).clamp(0, 30_000)).unwrap_or(30_000) as u64;
                let woke = {
                    let notified = this.wake.notified();
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(wait)) => false,
                        _ = notified => true,
                    }
                };
                if !woke {
                    this.run_due().await;
                }
                drop(this);
            }
        });
    }

    fn changed(&self) {
        emit_ui(&self.app, EVENT, json!({ "kind": "changed" }));
    }

    fn update_config<R>(&self, f: impl FnOnce(&mut Config) -> R) -> Result<R, String> {
        let mut cfg = self.config.lock();
        let r = f(&mut cfg);
        config::save(&cfg)?;
        Ok(r)
    }

    pub fn server_token(&self) -> String {
        let c = self.config.lock();
        if c.mcp_server.enabled { c.mcp_server.token.clone() } else { String::new() }
    }

    fn server_config(&self) -> McpServerConfig {
        self.config.lock().mcp_server.clone()
    }

    /// Starts, restarts or stops the MCP server to match the config.
    async fn apply_server(self: &Arc<Self>) {
        let cfg = self.server_config();
        let mut slot = self.server.lock().await;
        let wanted = cfg.enabled.then_some(cfg.port);
        if slot.as_ref().map(|h| h.port) == wanted && (wanted.is_none() || slot.is_some()) {
            return;
        }
        *slot = None;
        *self.server_error.lock() = None;
        if let Some(port) = wanted {
            match mcp_server::start(Arc::downgrade(self), port).await {
                Ok(h) => *slot = Some(h),
                Err(e) => {
                    log::warn!("mcp server: {e}");
                    *self.server_error.lock() = Some(e);
                }
            }
        }
        drop(slot);
        self.changed();
    }

    // ---- engine hooks ----

    /// Every `zstate` the main page posts (engine.rs `HostObserver::state`).
    pub fn observe_state(&self, state: &Value) {
        let (new, indexable) = {
            let mut m = self.mirror.lock();
            let new = m.apply(state);
            (new, m.take_indexable())
        };
        if !indexable.is_empty() && self.config.lock().search.enabled {
            if let Some(tx) = &self.index_tx {
                let _ = tx.send(IndexJob::Upsert(indexable));
            }
        }
        for message in new {
            emit_ui(&self.app, EVENT, json!({ "kind": "message", "message": message }));
        }
    }

    /// The main page reloaded or the account signed out: what was mirrored belongs to the old page.
    pub fn reset_mirror(&self) {
        self.mirror.lock().clear();
    }

    /// The account signed out: its messages must not stay searchable for the next account.
    pub fn clear_search(&self) {
        if let Some(tx) = &self.index_tx {
            let _ = tx.send(IndexJob::Clear);
        }
    }

    /// Hybrid search (keyword + semantic when configured and embeddings exist). Returns hits and the mode used.
    pub async fn search_messages(&self, query: &str, conversation: Option<String>, limit: usize, context: usize) -> Result<Value, String> {
        let index = self.index.clone().ok_or("chỉ mục tìm kiếm không mở được")?;
        if query.trim().is_empty() {
            return Err("nhập nội dung cần tìm".into());
        }
        let cfg = self.config.lock().search.clone();
        let mut semantic_error = None;
        let mut query_vector = None;
        if cfg.enabled && cfg.semantic {
            match tokio::time::timeout(Duration::from_secs(15), search::embed(&self.http, &cfg, &[query.to_owned()])).await {
                Ok(Ok(mut v)) => query_vector = v.pop(),
                Ok(Err(e)) => semantic_error = Some(e),
                Err(_) => semantic_error = Some("hết thời gian chờ embeddings".into()),
            }
        }
        let mode = if query_vector.is_some() { "hybrid" } else { "keyword" };
        let query = query.to_owned();
        let model = cfg.model.clone();
        let hits = tauri::async_runtime::spawn_blocking(move || {
            search::search(&index, &query, query_vector.map(|v| (model.as_str(), v)), conversation.as_deref(), limit, context)
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(json!({ "mode": mode, "hits": hits, "semanticError": semantic_error }))
    }

    fn engine(&self) -> Option<Arc<Engine>> {
        self.app.try_state::<Arc<Engine>>().map(|s| s.inner().clone())
    }

    fn ready(&self) -> Result<Arc<Engine>, String> {
        let engine = self.engine().ok_or("engine chưa khởi động")?;
        if engine.phase() != Phase::Ready {
            return Err("Compola chưa đăng nhập Zalo".into());
        }
        Ok(engine)
    }

    pub async fn send_text(&self, conversation_id: &str, text: &str) -> Result<(), String> {
        let text = expand_template(text);
        if text.trim().is_empty() {
            return Err("tin nhắn trống".into());
        }
        if conversation_id.trim().is_empty() {
            return Err("thiếu conversationId".into());
        }
        let engine = self.ready()?;
        let answer = engine.call_adapter("__zaloChat", "sendText", vec![json!(conversation_id), json!(text.trim()), Value::Null, json!([])]).await?;
        match answer.as_str() {
            Some("sent") => Ok(()),
            Some("not-open") => Err("không gửi được: không tìm thấy hội thoại".into()),
            Some("not-ready") => Err("không gửi được: Zalo chưa sẵn sàng".into()),
            other => Err(format!("không gửi được ({})", other.unwrap_or("lỗi"))),
        }
    }

    // ---- scheduler ----

    fn due_time(job: &Job, now: chrono::DateTime<Local>) -> Option<i64> {
        if !job.enabled {
            return None;
        }
        match &job.schedule {
            Schedule::Cron { expr } => cron::Cron::parse(expr).ok()?.next_after(now).map(|t| t.timestamp_millis()),
            Schedule::Once { at } => job.last_run.is_none().then_some(*at),
        }
    }

    fn recompute_due(&self) {
        let now = Local::now();
        let jobs = self.config.lock().jobs.clone();
        let inflight = self.inflight.lock().clone();
        let mut due = self.next_due.lock();
        due.clear();
        for j in jobs.iter().filter(|j| !inflight.contains(&j.id)) {
            if let Some(t) = Self::due_time(j, now) {
                due.insert(j.id.clone(), t);
            }
        }
        drop(due);
        self.wake.notify_one();
    }

    async fn run_due(self: &Arc<Self>) {
        let now = Local::now().timestamp_millis();
        let due: Vec<String> = self.next_due.lock().iter().filter(|(_, t)| **t <= now).map(|(id, _)| id.clone()).collect();
        if due.is_empty() {
            return;
        }
        for id in &due {
            self.next_due.lock().remove(id);
        }
        for id in due {
            let job = self.config.lock().jobs.iter().find(|j| j.id == id).cloned();
            if let Some(job) = job {
                self.inflight.lock().insert(job.id.clone());
                let this = self.clone();
                tauri::async_runtime::spawn(async move {
                    this.execute(job, "schedule").await;
                });
            }
        }
        self.recompute_due_keeping_inflight();
    }

    /// Like `recompute_due`, but a cron job's next time is computed from now (so it does not fire twice this minute).
    fn recompute_due_keeping_inflight(&self) {
        let now = Local::now();
        let jobs = self.config.lock().jobs.clone();
        let mut due = self.next_due.lock();
        let inflight = self.inflight.lock().clone();
        for j in &jobs {
            if due.contains_key(&j.id) || inflight.contains(&j.id) {
                continue;
            }
            if let Some(t) = Self::due_time(j, now) {
                // A one-shot job is removed from the queue when it runs; do not re-add it before its last_run lands.
                if matches!(j.schedule, Schedule::Once { .. }) && t <= now.timestamp_millis() {
                    continue;
                }
                due.insert(j.id.clone(), t);
            }
        }
    }

    async fn execute(self: &Arc<Self>, job: Job, trigger: &str) -> RunLog {
        // `run_due` marked a scheduled job in flight before spawning this.
        let scheduled = trigger == "schedule";
        let result: Result<String, String> = match &job.action {
            Action::SendText { conversation_id, text, .. } => self.send_text(conversation_id, text).await.map(|_| "Đã gửi".to_owned()),
            Action::McpTool { server_id, tool, arguments } => match self.client_config(server_id) {
                Some(cfg) => match self.pool.get(&cfg).await {
                    Ok(c) => c.call_tool(tool, arguments.clone()).await.and_then(|r| {
                        let text = mcp_client::result_text(&r);
                        if r.get("isError").and_then(Value::as_bool) == Some(true) { Err(text) } else { Ok(text) }
                    }),
                    Err(e) => Err(e),
                },
                None => Err("máy chủ MCP đã bị xoá".into()),
            },
            Action::Addon { addon_id, payload } => {
                let enabled = self.config.lock().addons.get(addon_id).is_some_and(|a| a.enabled);
                if enabled {
                    emit_ui(&self.app, EVENT, json!({ "kind": "schedule", "addonId": addon_id, "jobId": job.id, "payload": payload }));
                    Ok("Đã chuyển cho add-on".into())
                } else {
                    Err("add-on đang tắt".into())
                }
            }
        };
        let (ok, status) = match result {
            Ok(s) => (true, s),
            Err(e) => (false, e),
        };
        let status: String = status.chars().take(500).collect();
        let at = Local::now().timestamp_millis();
        log::info!("automation: job \"{}\" ({trigger}) → {}", job.name, if ok { "ok" } else { "failed" });
        let _ = self.update_config(|c| {
            if let Some(j) = c.jobs.iter_mut().find(|j| j.id == job.id) {
                j.last_run = Some(at);
                j.last_ok = Some(ok);
                j.last_status = Some(status.clone());
                if matches!(j.schedule, Schedule::Once { .. }) && trigger == "schedule" {
                    j.enabled = false;
                }
            }
        });
        let run = RunLog { job_id: job.id.clone(), job_name: job.name.clone(), at, ok, status, trigger: trigger.into() };
        {
            let mut runs = self.runs.lock();
            runs.push_front(run.clone());
            runs.truncate(RUN_LOG_CAP);
        }
        if scheduled {
            self.inflight.lock().remove(&job.id);
            if matches!(job.schedule, Schedule::Cron { .. }) {
                self.recompute_due_keeping_inflight();
            }
        }
        self.changed();
        run
    }

    fn client_config(&self, id: &str) -> Option<McpClientConfig> {
        self.config.lock().mcp_clients.iter().find(|c| c.id == id && c.enabled).cloned()
    }

    /// Validates and stores a job (new when its id is empty or unknown).
    pub fn save_job(&self, mut job: Job) -> Result<Job, String> {
        job.name = job.name.trim().to_owned();
        if job.name.is_empty() {
            job.name = match &job.action {
                Action::SendText { conversation_name, .. } if !conversation_name.is_empty() => format!("Gửi tới {conversation_name}"),
                Action::SendText { .. } => "Gửi tin nhắn".into(),
                Action::McpTool { tool, .. } => format!("MCP: {tool}"),
                Action::Addon { addon_id, .. } => format!("Add-on: {addon_id}"),
            };
        }
        match &job.schedule {
            Schedule::Cron { expr } => {
                cron::Cron::parse(expr)?;
            }
            Schedule::Once { at } => {
                if Local.timestamp_millis_opt(*at).single().is_none() {
                    return Err("thời điểm không hợp lệ".into());
                }
            }
        }
        match &job.action {
            Action::SendText { conversation_id, text, .. } => {
                if conversation_id.trim().is_empty() {
                    return Err("chưa chọn hội thoại".into());
                }
                if text.trim().is_empty() {
                    return Err("chưa nhập nội dung tin nhắn".into());
                }
            }
            Action::McpTool { server_id, tool, .. } => {
                if self.client_config(server_id).is_none() {
                    return Err("máy chủ MCP không tồn tại hoặc đang tắt".into());
                }
                if tool.trim().is_empty() {
                    return Err("chưa chọn công cụ MCP".into());
                }
            }
            Action::Addon { addon_id, .. } => {
                if addons::get(addon_id).is_none() {
                    return Err("add-on không tồn tại".into());
                }
            }
        }
        let saved = self.update_config(|c| {
            match c.jobs.iter_mut().find(|j| !job.id.is_empty() && j.id == job.id) {
                Some(slot) => {
                    // A changed schedule may run again.
                    if slot.schedule != job.schedule {
                        job.last_run = None;
                    } else {
                        job.last_run = slot.last_run;
                    }
                    job.last_ok = slot.last_ok;
                    job.last_status = slot.last_status.clone();
                    if job.created_by.is_empty() {
                        job.created_by = slot.created_by.clone();
                    }
                    *slot = job.clone();
                }
                None => {
                    job.id = config::new_id("job");
                    job.last_run = None;
                    job.last_ok = None;
                    job.last_status = None;
                    if job.created_by.is_empty() {
                        job.created_by = "ui".into();
                    }
                    c.jobs.push(job.clone());
                }
            }
            job.clone()
        })?;
        self.recompute_due();
        self.changed();
        Ok(saved)
    }

    pub fn delete_job(&self, id: &str) -> Result<bool, String> {
        let removed = self.update_config(|c| {
            let before = c.jobs.len();
            c.jobs.retain(|j| j.id != id);
            before != c.jobs.len()
        })?;
        self.recompute_due();
        self.changed();
        Ok(removed)
    }

    pub async fn run_job_now(self: &Arc<Self>, id: &str) -> Result<RunLog, String> {
        let job = self.config.lock().jobs.iter().find(|j| j.id == id).cloned().ok_or("không tìm thấy lịch")?;
        Ok(self.execute(job, "manual").await)
    }

    // ---- add-on tools ----

    async fn call_addon_tool(&self, addon_id: &str, tool: &str, arguments: Value) -> Result<Value, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.addon_calls.lock().insert(request_id.clone(), tx);
        emit_ui(&self.app, EVENT, json!({ "kind": "toolCall", "requestId": request_id, "addonId": addon_id, "tool": tool, "arguments": arguments }));
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(r)) => r,
            _ => {
                self.addon_calls.lock().remove(&request_id);
                Err("add-on không trả lời".into())
            }
        }
    }
}

/// `{{date}}` dd/mm/yyyy, `{{time}}` HH:MM, `{{weekday}}`, `{{datetime}}`.
pub fn expand_template(text: &str) -> String {
    if !text.contains("{{") {
        return text.to_owned();
    }
    let now = Local::now();
    let weekday = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"][now.weekday().num_days_from_sunday() as usize];
    text.replace("{{date}}", &now.format("%d/%m/%Y").to_string())
        .replace("{{time}}", &now.format("%H:%M").to_string())
        .replace("{{datetime}}", &now.format("%H:%M %d/%m/%Y").to_string())
        .replace("{{weekday}}", weekday)
}

// ---- commands ----

type AutomationState<'a> = State<'a, Arc<Automation>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonView {
    #[serde(flatten)]
    pub addon: addons::Addon,
    pub enabled: bool,
    pub settings: serde_json::Map<String, Value>,
    pub storage: serde_json::Map<String, Value>,
    pub tools: Vec<Value>,
}

#[tauri::command]
pub async fn automation_state(automation: AutomationState<'_>) -> Result<Value, String> {
    let a = automation.inner().clone();
    let cfg = a.config.lock().clone();
    let running = a.server.lock().await.as_ref().map(|h| h.port);
    let connected = a.pool.connected().await;
    let addon_tools = a.addon_tools.lock().clone();
    let addons: Vec<AddonView> = addons::list()
        .into_iter()
        .map(|addon| {
            let st = cfg.addons.get(&addon.manifest.id).cloned().unwrap_or_default();
            let tools = addon_tools.get(&addon.manifest.id).cloned().unwrap_or_default();
            AddonView { addon, enabled: st.enabled, settings: st.settings, storage: st.storage, tools }
        })
        .collect();
    let runs: Vec<RunLog> = a.runs.lock().iter().cloned().collect();
    let next_due = a.next_due.lock().clone();
    Ok(json!({
        "server": {
            "config": cfg.mcp_server,
            "running": running.is_some(),
            "url": running.map(|p| format!("http://127.0.0.1:{p}/mcp")),
            "error": a.server_error.lock().clone(),
        },
        "clients": cfg.mcp_clients,
        "connected": connected,
        "jobs": cfg.jobs,
        "nextDue": next_due,
        "runs": runs,
        "addons": addons,
        "addonDir": addons::dir().to_string_lossy(),
        "permissions": addons::PERMISSIONS,
    }))
}

#[tauri::command]
pub async fn automation_set_server(automation: AutomationState<'_>, server: McpServerConfig) -> Result<(), String> {
    let a = automation.inner().clone();
    if server.port < 1024 {
        return Err("cổng phải từ 1024 trở lên".into());
    }
    a.update_config(|c| {
        let token = c.mcp_server.token.clone();
        c.mcp_server = server;
        if c.mcp_server.token.len() < 16 {
            c.mcp_server.token = token;
        }
    })?;
    a.apply_server().await;
    Ok(())
}

#[tauri::command]
pub fn automation_regenerate_token(automation: AutomationState<'_>) -> Result<String, String> {
    let token = config::new_token();
    automation.update_config(|c| c.mcp_server.token = token.clone())?;
    automation.changed();
    Ok(token)
}

#[tauri::command]
pub async fn automation_save_client(automation: AutomationState<'_>, mut client: McpClientConfig) -> Result<McpClientConfig, String> {
    let a = automation.inner().clone();
    client.name = client.name.trim().to_owned();
    if client.name.is_empty() {
        return Err("chưa đặt tên".into());
    }
    if client.id.is_empty() {
        client.id = config::new_id("mcp");
    }
    let saved = client.clone();
    a.update_config(|c| match c.mcp_clients.iter_mut().find(|x| x.id == saved.id) {
        Some(slot) => *slot = saved.clone(),
        None => c.mcp_clients.push(saved.clone()),
    })?;
    a.pool.drop_client(&client.id).await;
    a.changed();
    Ok(client)
}

#[tauri::command]
pub async fn automation_delete_client(automation: AutomationState<'_>, id: String) -> Result<(), String> {
    let a = automation.inner().clone();
    a.update_config(|c| c.mcp_clients.retain(|x| x.id != id))?;
    a.pool.drop_client(&id).await;
    a.changed();
    Ok(())
}

/// Connects (if needed) and lists the server's tools.
#[tauri::command]
pub async fn automation_client_tools(automation: AutomationState<'_>, id: String) -> Result<Value, String> {
    let a = automation.inner().clone();
    let cfg = a.config.lock().mcp_clients.iter().find(|c| c.id == id).cloned().ok_or("không tìm thấy máy chủ")?;
    let client = a.pool.get(&cfg).await?;
    let tools = client.list_tools().await?;
    let info = client.server_info.lock().clone();
    a.changed();
    Ok(json!({ "tools": tools, "serverInfo": info }))
}

#[tauri::command]
pub async fn automation_client_call(automation: AutomationState<'_>, id: String, tool: String, arguments: Value) -> Result<Value, String> {
    let a = automation.inner().clone();
    let cfg = a.client_config(&id).ok_or("máy chủ không tồn tại hoặc đang tắt")?;
    a.pool.get(&cfg).await?.call_tool(&tool, arguments).await
}

#[tauri::command]
pub fn automation_save_job(automation: AutomationState<'_>, job: Job) -> Result<Job, String> {
    automation.save_job(job)
}

#[tauri::command]
pub fn automation_delete_job(automation: AutomationState<'_>, id: String) -> Result<bool, String> {
    automation.delete_job(&id)
}

#[tauri::command]
pub async fn automation_run_job(automation: AutomationState<'_>, id: String) -> Result<RunLog, String> {
    let a = automation.inner().clone();
    a.run_job_now(&id).await
}

/// The next fire times (Unix ms) of a cron expression, or why it is invalid.
#[tauri::command]
pub fn automation_cron_preview(expr: String, count: Option<usize>) -> Result<Vec<i64>, String> {
    Ok(cron::upcoming(&expr, count.unwrap_or(5).clamp(1, 20))?.into_iter().map(|t| t.timestamp_millis()).collect())
}

/// Installs an add-on from `path` (a folder with manifest.json or a .js file), or from what the user picks.
#[tauri::command]
pub async fn automation_addon_install(app: AppHandle, automation: AutomationState<'_>, path: Option<String>, folder: Option<bool>) -> Result<Option<String>, String> {
    let path = match path {
        Some(p) => p,
        None => {
            use tauri_plugin_dialog::DialogExt;
            let (tx, rx) = oneshot::channel();
            let dialog = app.dialog().file().set_title("Chọn add-on");
            if folder.unwrap_or(false) {
                dialog.pick_folder(move |p| {
                    let _ = tx.send(p);
                });
            } else {
                dialog.add_filter("Add-on (JavaScript)", &["js", "mjs"]).pick_file(move |p| {
                    let _ = tx.send(p);
                });
            }
            match rx.await.ok().flatten().and_then(|p| p.into_path().ok()) {
                Some(p) => p.to_string_lossy().into_owned(),
                None => return Ok(None),
            }
        }
    };
    let id = addons::install(std::path::Path::new(&path))?;
    automation.update_config(|c| {
        c.addons.entry(id.clone()).or_default();
    })?;
    automation.changed();
    Ok(Some(id))
}

#[tauri::command]
pub fn automation_addon_set_enabled(automation: AutomationState<'_>, id: String, enabled: bool) -> Result<(), String> {
    automation.update_config(|c| c.addons.entry(id.clone()).or_default().enabled = enabled)?;
    if !enabled {
        automation.addon_tools.lock().remove(&id);
    }
    automation.changed();
    Ok(())
}

#[tauri::command]
pub fn automation_addon_set_settings(automation: AutomationState<'_>, id: String, settings: serde_json::Map<String, Value>) -> Result<(), String> {
    automation.update_config(|c| c.addons.entry(id).or_default().settings = settings)?;
    automation.changed();
    Ok(())
}

#[tauri::command]
pub fn automation_addon_storage_set(automation: AutomationState<'_>, id: String, key: String, value: Value) -> Result<(), String> {
    automation.update_config(|c| {
        let st: &mut AddonState = c.addons.entry(id).or_default();
        if value.is_null() {
            st.storage.remove(&key);
        } else {
            st.storage.insert(key, value);
        }
    })
}

#[tauri::command]
pub fn automation_addon_remove(automation: AutomationState<'_>, id: String) -> Result<(), String> {
    addons::remove(&id)?;
    automation.update_config(|c| {
        c.addons.remove(&id);
        c.jobs.retain(|j| !matches!(&j.action, Action::Addon { addon_id, .. } if *addon_id == id));
    })?;
    automation.addon_tools.lock().remove(&id);
    automation.recompute_due();
    automation.changed();
    Ok(())
}

/// The tools a running add-on offers to MCP clients (replaces its earlier list).
#[tauri::command]
pub fn automation_addon_register_tools(automation: AutomationState<'_>, id: String, tools: Vec<Value>) {
    let tools: Vec<Value> = tools.into_iter().filter(|t| t.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty())).collect();
    let mut map = automation.addon_tools.lock();
    if tools.is_empty() {
        map.remove(&id);
    } else {
        map.insert(id, tools);
    }
}

#[tauri::command]
pub fn automation_addon_tool_reply(automation: AutomationState<'_>, request_id: String, ok: bool, result: Value) {
    if let Some(tx) = automation.addon_calls.lock().remove(&request_id) {
        let _ = tx.send(if ok { Ok(result) } else { Err(result.as_str().map(str::to_owned).unwrap_or_else(|| result.to_string())) });
    }
}

#[tauri::command]
pub fn automation_conversations(automation: AutomationState<'_>, query: Option<String>, limit: Option<usize>) -> Vec<mirror::Conversation> {
    automation.find_conversations(query.as_deref(), limit.unwrap_or(50), false)
}

#[tauri::command]
pub fn automation_messages(automation: AutomationState<'_>, conversation_id: Option<String>, limit: Option<usize>) -> Vec<mirror::Message> {
    automation.mirror.lock().messages(conversation_id.as_deref(), limit.unwrap_or(50).min(500))
}

#[tauri::command]
pub async fn automation_send_text(automation: AutomationState<'_>, conversation_id: String, text: String) -> Result<(), String> {
    let a = automation.inner().clone();
    a.send_text(&conversation_id, &text).await
}

// ---- search commands ----

#[tauri::command]
pub async fn automation_search(
    automation: AutomationState<'_>,
    query: String,
    conversation_id: Option<String>,
    limit: Option<usize>,
    context: Option<usize>,
) -> Result<Value, String> {
    let a = automation.inner().clone();
    a.search_messages(&query, conversation_id.filter(|c| !c.is_empty()), limit.unwrap_or(30).clamp(1, 200), context.unwrap_or(0).min(10)).await
}

#[tauri::command]
pub fn automation_search_status(automation: AutomationState<'_>) -> Value {
    let cfg = automation.config.lock().search.clone();
    let stats = automation.index.as_ref().map(|ix| ix.stats());
    json!({ "config": cfg, "stats": stats, "embedError": automation.embed_error.lock().clone(), "path": search::Index::path() })
}

#[tauri::command]
pub fn automation_search_set_config(automation: AutomationState<'_>, config: config::SearchConfig) -> Result<(), String> {
    let was_enabled = automation.config.lock().search.enabled;
    automation.update_config(|c| c.search = config.clone())?;
    *automation.embed_error.lock() = None;
    if was_enabled && !config.enabled {
        automation.clear_search();
    }
    automation.changed();
    Ok(())
}

#[tauri::command]
pub fn automation_search_clear(automation: AutomationState<'_>) {
    automation.clear_search();
    automation.changed();
}

/// Embeds a sample text with `config` → the vector size, so the settings can verify a provider before saving.
#[tauri::command]
pub async fn automation_search_test(automation: AutomationState<'_>, config: config::SearchConfig) -> Result<usize, String> {
    let a = automation.inner().clone();
    let v = search::embed(&a.http, &config, &["Xin chào, hẹn gặp lúc 3 giờ chiều".to_owned()]).await?;
    Ok(v.first().map(Vec::len).unwrap_or(0))
}
