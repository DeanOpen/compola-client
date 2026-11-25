//! Tauri commands for add-ons: management (Settings › Add-on) and the conversation workspace (notes, suggestions,
//! panels, actions, quick replies). The workspace commands are also served to Compola Server's joined users through
//! [`remote`] with their access already checked (`remote::policy`); management is admin-only there.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

use super::host::LogLine;
use super::workspace::Author;
use crate::automation::Automation;
use crate::automation::config::{AddonLimits, AiConfig};

type AutomationState<'a> = State<'a, Arc<Automation>>;

/// The AI config as the UI sees it: never the key itself.
pub fn ai_view(cfg: &AiConfig) -> Value {
    let mut v = serde_json::to_value(cfg).unwrap_or(Value::Null);
    v["apiKey"] = json!("");
    v["hasKey"] = json!(!cfg.api_key.is_empty());
    v
}

fn after_change(a: &Arc<Automation>) {
    a.addons.sync();
    a.recompute_due();
    a.changed();
}

/// Lets the user pick a package: `zip` (also `.compola-addon`), `js` or `folder`. None when cancelled.
#[tauri::command]
pub async fn addons_pick(app: AppHandle, kind: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = oneshot::channel();
    let dialog = app.dialog().file().set_title("Chọn add-on");
    match kind.as_str() {
        "folder" => dialog.pick_folder(move |p| {
            let _ = tx.send(p);
        }),
        "js" => dialog.add_filter("Add-on (JavaScript)", &["js", "mjs"]).pick_file(move |p| {
            let _ = tx.send(p);
        }),
        _ => dialog.add_filter("Gói add-on", &["zip", "compola-addon"]).pick_file(move |p| {
            let _ = tx.send(p);
        }),
    }
    Ok(rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

/// Reads a package without installing it (the consent dialog).
#[tauri::command]
pub async fn addons_inspect(path: String) -> Result<super::Preview, String> {
    tauri::async_runtime::spawn_blocking(move || super::inspect(std::path::Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// Installs or updates a package. A new add-on starts disabled; an update keeps its enabled state and restarts.
#[tauri::command]
pub async fn addons_install(automation: AutomationState<'_>, path: String) -> Result<String, String> {
    let a = automation.inner().clone();
    let id = tauri::async_runtime::spawn_blocking(move || super::install(std::path::Path::new(&path))).await.map_err(|e| e.to_string())??;
    a.update_config(|c| {
        c.addons.entry(id.clone()).or_default();
    })?;
    a.addons.log(&id, "info", "đã cài đặt / cập nhật".into());
    after_change(&a);
    Ok(id)
}

#[tauri::command]
pub fn addons_set_enabled(automation: AutomationState<'_>, id: String, enabled: bool) -> Result<(), String> {
    let a = automation.inner().clone();
    if enabled && super::get(&id).is_none() {
        return Err("add-on không tồn tại hoặc bị lỗi (xem nhật ký)".into());
    }
    a.update_config(|c| c.addons.entry(id.clone()).or_default().enabled = enabled)?;
    if enabled {
        // Turning it on again clears a faulted state.
        a.addons.restart(&id);
    }
    after_change(&a);
    Ok(())
}

#[tauri::command]
pub fn addons_set_settings(automation: AutomationState<'_>, id: String, settings: serde_json::Map<String, Value>) -> Result<(), String> {
    let a = automation.inner().clone();
    a.update_config(|c| c.addons.entry(id).or_default().settings = settings)?;
    after_change(&a);
    Ok(())
}

#[tauri::command]
pub fn addons_set_limits(automation: AutomationState<'_>, id: String, limits: AddonLimits) -> Result<(), String> {
    let a = automation.inner().clone();
    let clamp = |v: u32, max: u32| v.min(max);
    let limits = AddonLimits {
        send_per_minute: clamp(limits.send_per_minute, 60),
        send_per_conversation_hour: clamp(limits.send_per_conversation_hour, 600),
        ai_per_hour: clamp(limits.ai_per_hour, 10_000),
        fetch_per_minute: clamp(limits.fetch_per_minute, 1_000),
    };
    a.update_config(|c| c.addons.entry(id).or_default().limits = limits)?;
    a.changed();
    Ok(())
}

#[tauri::command]
pub fn addons_remove(automation: AutomationState<'_>, id: String) -> Result<(), String> {
    let a = automation.inner().clone();
    a.update_config(|c| {
        if let Some(st) = c.addons.get_mut(&id) {
            st.enabled = false;
        }
    })?;
    a.addons.sync();
    super::remove(&id)?;
    a.update_config(|c| {
        c.addons.remove(&id);
        c.jobs.retain(|j| !matches!(&j.action, crate::automation::config::Action::Addon { addon_id, .. } if *addon_id == id));
    })?;
    a.set_addon_tools(&id, Vec::new());
    a.addons.forget(&id);
    after_change(&a);
    Ok(())
}

#[tauri::command]
pub fn addons_restart(automation: AutomationState<'_>, id: String) {
    let a = automation.inner().clone();
    a.addons.restart(&id);
    a.changed();
}

#[tauri::command]
pub fn addons_rollback(automation: AutomationState<'_>, id: String) -> Result<(), String> {
    let a = automation.inner().clone();
    super::rollback(&id)?;
    a.addons.log(&id, "info", "đã khôi phục phiên bản trước".into());
    after_change(&a);
    Ok(())
}

#[tauri::command]
pub fn addons_logs(automation: AutomationState<'_>, id: String) -> Vec<LogLine> {
    automation.addons.logs(&id)
}

#[tauri::command]
pub fn addons_clear_logs(automation: AutomationState<'_>, id: String) {
    automation.addons.clear_logs(&id);
}

/// Saves the AI provider; an empty `apiKey` keeps the stored one.
#[tauri::command]
pub fn addons_ai_set(automation: AutomationState<'_>, config: AiConfig) -> Result<Value, String> {
    let a = automation.inner().clone();
    let mut config = config;
    if !matches!(config.provider.as_str(), "anthropic" | "openai") {
        return Err("provider phải là anthropic hoặc openai".into());
    }
    config.max_tokens = config.max_tokens.clamp(256, 128_000);
    let saved = a.update_config(|c| {
        // Keep the stored key only for the same service: another server must never receive it.
        if config.api_key.trim().is_empty() && same_service(&c.ai, &config) {
            config.api_key = c.ai.api_key.clone();
        }
        config.api_key = config.api_key.trim().to_owned();
        c.ai = config.clone();
        c.ai.clone()
    })?;
    a.changed();
    Ok(ai_view(&saved))
}

/// Same protocol and server: a stored API key may be reused.
fn same_service(a: &AiConfig, b: &AiConfig) -> bool {
    a.provider == b.provider && crate::automation::ai::base(a) == crate::automation::ai::base(b)
}

/// The models of the provider being edited (`config` not saved yet); an empty `apiKey` uses the stored key when it is the
/// same service.
#[tauri::command]
pub async fn addons_ai_models(automation: AutomationState<'_>, config: AiConfig) -> Result<Vec<String>, String> {
    let a = automation.inner().clone();
    let mut cfg = config;
    if !matches!(cfg.provider.as_str(), "anthropic" | "openai") {
        return Err("provider phải là anthropic hoặc openai".into());
    }
    let stored = a.ai_config();
    if cfg.api_key.trim().is_empty() && same_service(&stored, &cfg) {
        cfg.api_key = stored.api_key;
    }
    crate::automation::ai::models(&a.http, &cfg).await
}

/// Sends one short request with the saved provider; returns the model's answer.
#[tauri::command]
pub async fn addons_ai_test(automation: AutomationState<'_>) -> Result<Value, String> {
    let a = automation.inner().clone();
    let mut cfg = a.ai_config();
    cfg.enabled = true;
    let req = crate::automation::ai::Request::from_value(&json!({ "prompt": "Trả lời đúng một từ: OK", "maxTokens": 64, "effort": "low" }), &cfg)?;
    let out = crate::automation::ai::complete(&a.http, &cfg, req).await?;
    Ok(json!({ "text": out.text, "model": out.model }))
}

// ---- workspace (local UI and joined users) ----

fn local_author(a: &Automation, account: &str) -> Author {
    let reg = crate::account::accounts(&a.app).registry();
    let name = reg.accounts.iter().find(|r| r.id == account).and_then(|r| r.name.clone()).unwrap_or_else(|| "Tôi".into());
    Author { kind: "user", id: "local".into(), name }
}

fn s(args: &Value, k: &str) -> String {
    args.get(k).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// One workspace command for an account, by a person (`author`). Shared by the Tauri commands and Compola Server.
pub async fn workspace(a: &Arc<Automation>, account: &str, cmd: &str, args: &Value, author: Author) -> Result<Value, String> {
    let host = &a.addons;
    let conv = s(args, "conversationId");
    match cmd {
        "addons_workspace" => host.workspace_json(account, &conv),
        "addons_quick_replies" => Ok(host.quick_replies_json()),
        "addons_note_add" => host.user_add_note(account, &conv, &s(args, "text"), author, args.get("messageId").and_then(Value::as_str).map(str::to_owned)),
        "addons_note_update" => host.user_change_note(&conv, &s(args, "id"), Some(args.get("patch").unwrap_or(&Value::Null))),
        "addons_note_delete" => host.user_change_note(&conv, &s(args, "id"), None),
        "addons_suggestion_resolve" => {
            let outcome = s(args, "outcome");
            if !matches!(outcome.as_str(), "used" | "sent" | "dismissed") {
                return Err("outcome phải là used, sent hoặc dismissed".into());
            }
            host.resolve_suggestion(&conv, &s(args, "id"), &outcome, &author.name).await.map(|_| Value::Null)
        }
        "addons_action_run" => {
            let addon = s(args, "addonId");
            let data = json!({
                "actionId": s(args, "actionId"), "account": account,
                "conversationId": args.get("conversationId").cloned().unwrap_or(Value::Null),
                "messageId": args.get("messageId").cloned().unwrap_or(Value::Null),
                "text": args.get("text").cloned().unwrap_or(Value::Null),
                "payload": args.get("payload").cloned().unwrap_or(Value::Null),
                "user": { "kind": author.kind, "id": author.id, "name": author.name },
            });
            host.run_action(&addon, data).map(|_| Value::Null)
        }
        "addons_note_counts" => serde_json::to_value(host.workspace.note_counts(account)?).map_err(|e| e.to_string()),
        "addons_views" => Ok(json!(host.views())),
        "addons_view_document" => host.view_document(&s(args, "addonId"), &s(args, "viewId")).map(Value::String),
        "addons_view_call" => {
            // What the add-on learns about who is asking: never more than the view's own context.
            let context = json!({
                "viewId": s(args, "viewId"), "account": account,
                "conversationId": args.get("conversationId").cloned().unwrap_or(Value::Null),
                "params": args.get("params").cloned().unwrap_or(Value::Null),
                "user": { "kind": author.kind, "id": author.id, "name": author.name },
            });
            let data = args.get("data").cloned().unwrap_or(Value::Null);
            if data.to_string().len() > 1024 * 1024 {
                return Err("dữ liệu quá lớn (tối đa 1 MB)".into());
            }
            host.view_call(&s(args, "addonId"), &s(args, "name"), data, context).await
        }
        _ => Err(format!("lệnh không hỗ trợ: {cmd}")),
    }
}

/// Every workspace command name (Compola Server forwards these).
pub const WORKSPACE_COMMANDS: &[&str] = &[
    "addons_workspace",
    "addons_quick_replies",
    "addons_note_add",
    "addons_note_update",
    "addons_note_delete",
    "addons_suggestion_resolve",
    "addons_action_run",
    "addons_note_counts",
    "addons_views",
    "addons_view_document",
    "addons_view_call",
];

async fn local(a: &Arc<Automation>, account: Option<String>, cmd: &str, args: Value) -> Result<Value, String> {
    let account = a.resolve_account(account.as_deref())?;
    let author = local_author(a, &account);
    workspace(a, &account, cmd, &args, author).await
}

#[tauri::command]
pub async fn addons_workspace(automation: AutomationState<'_>, account: Option<String>, conversation_id: String) -> Result<Value, String> {
    local(automation.inner(), account, "addons_workspace", json!({ "conversationId": conversation_id })).await
}

#[tauri::command]
pub async fn addons_quick_replies(automation: AutomationState<'_>, account: Option<String>) -> Result<Value, String> {
    local(automation.inner(), account, "addons_quick_replies", json!({})).await
}

#[tauri::command]
pub async fn addons_views(automation: AutomationState<'_>, account: Option<String>) -> Result<Value, String> {
    local(automation.inner(), account, "addons_views", json!({})).await
}

#[tauri::command]
pub async fn addons_view_document(automation: AutomationState<'_>, account: Option<String>, addon_id: String, view_id: String) -> Result<Value, String> {
    local(automation.inner(), account, "addons_view_document", json!({ "addonId": addon_id, "viewId": view_id })).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn addons_view_call(
    automation: AutomationState<'_>,
    account: Option<String>,
    addon_id: String,
    view_id: String,
    name: String,
    data: Value,
    conversation_id: Option<String>,
    params: Option<Value>,
) -> Result<Value, String> {
    let args = json!({ "addonId": addon_id, "viewId": view_id, "name": name, "data": data, "conversationId": conversation_id, "params": params });
    local(automation.inner(), account, "addons_view_call", args).await
}

#[tauri::command]
pub async fn addons_note_counts(automation: AutomationState<'_>, account: Option<String>) -> Result<Value, String> {
    local(automation.inner(), account, "addons_note_counts", json!({})).await
}

#[tauri::command]
pub async fn addons_note_add(automation: AutomationState<'_>, account: Option<String>, conversation_id: String, text: String, message_id: Option<String>) -> Result<Value, String> {
    local(automation.inner(), account, "addons_note_add", json!({ "conversationId": conversation_id, "text": text, "messageId": message_id })).await
}

#[tauri::command]
pub async fn addons_note_update(automation: AutomationState<'_>, account: Option<String>, conversation_id: String, id: String, patch: Value) -> Result<Value, String> {
    local(automation.inner(), account, "addons_note_update", json!({ "conversationId": conversation_id, "id": id, "patch": patch })).await
}

#[tauri::command]
pub async fn addons_note_delete(automation: AutomationState<'_>, account: Option<String>, conversation_id: String, id: String) -> Result<Value, String> {
    local(automation.inner(), account, "addons_note_delete", json!({ "conversationId": conversation_id, "id": id })).await
}

#[tauri::command]
pub async fn addons_suggestion_resolve(automation: AutomationState<'_>, account: Option<String>, conversation_id: String, id: String, outcome: String) -> Result<Value, String> {
    local(automation.inner(), account, "addons_suggestion_resolve", json!({ "conversationId": conversation_id, "id": id, "outcome": outcome })).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn addons_action_run(
    automation: AutomationState<'_>,
    account: Option<String>,
    addon_id: String,
    action_id: String,
    conversation_id: Option<String>,
    message_id: Option<String>,
    text: Option<String>,
    payload: Option<Value>,
) -> Result<Value, String> {
    let args = json!({ "addonId": addon_id, "actionId": action_id, "conversationId": conversation_id, "messageId": message_id, "text": text, "payload": payload });
    local(automation.inner(), account, "addons_action_run", args).await
}
