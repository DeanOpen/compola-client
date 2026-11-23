//! The tools Compola's MCP server offers: the Zalo account (conversations, messages, sending), schedules, the tools
//! of external MCP servers (optional) and the tools enabled add-ons register.

use std::sync::Arc;

use chrono::{Local, TimeZone};
use serde_json::{Value, json};

use super::config::{Action, Job, Schedule};
use super::mcp_server::ToolError;
use super::{Automation, cron, mcp_client, mirror};

/// Lowercase without Vietnamese diacritics, so "tran" finds "Trần".
pub fn fold(s: &str) -> String {
    const FROM: &str = "àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ";
    const TO: &str = "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd";
    s.to_lowercase()
        .chars()
        .map(|c| match FROM.chars().position(|f| f == c) {
            Some(i) => TO.chars().nth(i).unwrap_or(c),
            None => c,
        })
        .collect()
}

fn arg_str(args: &Value, key: &str) -> String {
    match args.get(key) {
        Some(Value::String(s)) => s.trim().to_owned(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn arg_usize(args: &Value, key: &str, default: usize, max: usize) -> usize {
    args.get(key).and_then(Value::as_u64).map(|n| n as usize).unwrap_or(default).clamp(1, max)
}

/// `at` as Unix ms: a number (ms, or seconds when small) or an ISO 8601 / `YYYY-MM-DD HH:MM` local time.
fn parse_at(v: &Value) -> Result<i64, String> {
    if let Some(n) = v.as_f64() {
        return Ok(if n > 1e12 { n as i64 } else { (n * 1000.0) as i64 });
    }
    let s = v.as_str().ok_or("thiếu `at`")?.trim();
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(t.timestamp_millis());
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(n) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            if let Some(t) = Local.from_local_datetime(&n).earliest() {
                return Ok(t.timestamp_millis());
            }
        }
    }
    Err(format!("không hiểu thời điểm \"{s}\" (dùng ISO 8601, ví dụ 2026-12-01T09:00:00+07:00)"))
}

fn addon_tool_name(addon_id: &str, tool: &str) -> String {
    let id: String = addon_id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    format!("addon_{id}__{tool}")
}

fn job_view(job: &Job, next: Option<i64>) -> Value {
    let mut v = serde_json::to_value(job).unwrap_or(Value::Null);
    v["nextRun"] = next.map(|t| json!(Local.timestamp_millis_opt(t).single().map(|d| d.to_rfc3339()))).unwrap_or(Value::Null);
    v
}

impl Automation {
    pub fn find_conversations(&self, account: Option<&str>, query: Option<&str>, limit: usize, unread_only: bool) -> Result<Vec<mirror::Conversation>, String> {
        let q = query.map(fold).filter(|q| !q.trim().is_empty());
        Ok(self
            .data(account)?
            .mirror
            .lock()
            .conversations()
            .into_iter()
            .filter(|c| !unread_only || c.unread > 0)
            .filter(|c| q.as_ref().is_none_or(|q| fold(&c.name).contains(q.trim()) || c.id == q.trim()))
            .take(limit)
            .collect())
    }

    pub async fn mcp_tool_list(&self) -> Vec<Value> {
        let cfg = self.config.lock().mcp_server.clone();
        let mut tools = vec![
            json!({
                "name": "status",
                "title": "Trạng thái Compola",
                "description": "Whether Compola is signed in to Zalo, and how many conversations it knows.",
                "inputSchema": { "type": "object", "properties": {
                    "account": { "type": "string", "description": "Compola account id (from status.accounts); default: the account Compola shows" },} },
                "annotations": { "readOnlyHint": true },
            }),
            json!({
                "name": "list_conversations",
                "title": "Danh sách hội thoại",
                "description": "Zalo conversations (pinned first, then most recent), with unread count and the latest message. Use `query` to find one by name (accent-insensitive).",
                "inputSchema": { "type": "object", "properties": {
                    "account": { "type": "string", "description": "Compola account id (from status.accounts); default: the account Compola shows" },
                    "query": { "type": "string", "description": "Part of the conversation or contact name" },
                    "unreadOnly": { "type": "boolean" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 30 },
                } },
                "annotations": { "readOnlyHint": true },
            }),
            json!({
                "name": "get_messages",
                "title": "Tin nhắn",
                "description": "Recent messages, oldest first. With conversationId: the full loaded history if that chat was opened in Compola, otherwise the messages seen since Compola started (at least the latest one). Without it: the latest messages across all conversations since Compola started.",
                "inputSchema": { "type": "object", "properties": {
                    "account": { "type": "string", "description": "Compola account id (from status.accounts); default: the account Compola shows" },
                    "conversationId": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50 },
                } },
                "annotations": { "readOnlyHint": true },
            }),
            json!({
                "name": "search_messages",
                "title": "Tìm tin nhắn",
                "description": "Searches the Zalo messages Compola has indexed (accent-insensitive keywords, plus meaning-based matches when semantic search is set up). Returns the best matches, each with the messages around it as context — use it to answer questions about past conversations (RAG). Narrow with conversationId from list_conversations.",
                "inputSchema": { "type": "object", "properties": {
                    "account": { "type": "string", "description": "Compola account id (from status.accounts); default: the account Compola shows" },
                    "query": { "type": "string", "description": "Words or a question, e.g. \"họp thứ 6 mấy giờ\"" },
                    "conversationId": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
                    "context": { "type": "integer", "minimum": 0, "maximum": 10, "default": 3, "description": "Messages before and after each match" },
                }, "required": ["query"] },
                "annotations": { "readOnlyHint": true },
            }),
            json!({
                "name": "list_schedules",
                "title": "Danh sách lịch",
                "description": "Scheduled jobs (cron or one-time): scheduled messages, MCP tool runs and add-on schedules, with their next and last run.",
                "inputSchema": { "type": "object", "properties": {} },
                "annotations": { "readOnlyHint": true },
            }),
            json!({
                "name": "preview_cron",
                "title": "Thử biểu thức cron",
                "description": "Validates a 5-field cron expression (minute hour day month weekday, local time) and returns its next run times.",
                "inputSchema": { "type": "object", "properties": { "expr": { "type": "string" }, "count": { "type": "integer", "default": 5 } }, "required": ["expr"] },
                "annotations": { "readOnlyHint": true },
            }),
        ];
        if cfg.allow_send {
            tools.push(json!({
                "name": "send_message",
                "title": "Gửi tin nhắn",
                "description": "Sends a text message to a Zalo conversation as the signed-in user. Get conversationId from list_conversations. Placeholders {{date}} {{time}} {{weekday}} are filled in.",
                "inputSchema": { "type": "object", "properties": {
                    "account": { "type": "string", "description": "Compola account id (from status.accounts); default: the account Compola shows" },
                    "conversationId": { "type": "string" },
                    "text": { "type": "string" },
                }, "required": ["conversationId", "text"] },
                "annotations": { "destructiveHint": false, "openWorldHint": true },
            }));
        }
        if cfg.allow_schedules {
            tools.push(json!({
                "name": "create_schedule",
                "title": "Tạo lịch gửi tin",
                "description": "Schedules a message: recurring with `cron` (5 fields, local time, e.g. \"0 8 * * mon-fri\") or once with `at` (ISO 8601). Needs message sending to be allowed in Compola.",
                "inputSchema": { "type": "object", "properties": {
                    "account": { "type": "string", "description": "Compola account id (from status.accounts); default: the account Compola shows" },
                    "conversationId": { "type": "string" },
                    "text": { "type": "string" },
                    "cron": { "type": "string" },
                    "at": { "type": "string", "description": "ISO 8601 time for a one-time message" },
                    "name": { "type": "string" },
                }, "required": ["conversationId", "text"] },
            }));
            tools.push(json!({
                "name": "update_schedule",
                "title": "Sửa lịch",
                "description": "Enables/disables a schedule or changes its cron, time, text or name.",
                "inputSchema": { "type": "object", "properties": {
                    "id": { "type": "string" }, "enabled": { "type": "boolean" }, "cron": { "type": "string" }, "at": { "type": "string" },
                    "text": { "type": "string" }, "name": { "type": "string" },
                }, "required": ["id"] },
            }));
            tools.push(json!({
                "name": "delete_schedule",
                "title": "Xoá lịch",
                "description": "Deletes a schedule by id.",
                "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
                "annotations": { "destructiveHint": true },
            }));
            tools.push(json!({
                "name": "run_schedule",
                "title": "Chạy lịch ngay",
                "description": "Runs a schedule's action now, once.",
                "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
            }));
        }
        if cfg.expose_external {
            tools.push(json!({
                "name": "list_external_tools",
                "title": "Công cụ MCP ngoài",
                "description": "Tools of the external MCP servers configured in Compola.",
                "inputSchema": { "type": "object", "properties": { "serverId": { "type": "string", "description": "Omit to list every server" } } },
                "annotations": { "readOnlyHint": true },
            }));
            tools.push(json!({
                "name": "call_external_tool",
                "title": "Gọi công cụ MCP ngoài",
                "description": "Calls a tool of an external MCP server configured in Compola.",
                "inputSchema": { "type": "object", "properties": {
                    "serverId": { "type": "string" }, "tool": { "type": "string" }, "arguments": { "type": "object" },
                }, "required": ["serverId", "tool"] },
            }));
        }
        let enabled: Vec<String> = self.config.lock().addons.iter().filter(|(_, s)| s.enabled).map(|(k, _)| k.clone()).collect();
        for (addon, list) in self.addon_tools.lock().iter() {
            if !enabled.contains(addon) {
                continue;
            }
            for t in list {
                let name = t.get("name").and_then(Value::as_str).unwrap_or_default();
                tools.push(json!({
                    "name": addon_tool_name(addon, name),
                    "title": t.get("title").cloned().unwrap_or(json!(name)),
                    "description": format!("[add-on {addon}] {}", t.get("description").and_then(Value::as_str).unwrap_or("")),
                    "inputSchema": t.get("inputSchema").cloned().filter(Value::is_object).unwrap_or(json!({ "type": "object", "properties": {} })),
                }));
            }
        }
        tools
    }

    pub async fn mcp_call_tool(self: &Arc<Self>, name: &str, args: Value) -> Result<Value, ToolError> {
        let cfg = self.config.lock().mcp_server.clone();
        let fail = |e: String| ToolError::Failed(e);
        match name {
            "status" => {
                let account = Some(arg_str(&args, "account")).filter(|a| !a.is_empty());
                let phase = self.engine(account.as_deref()).map(|e| e.phase());
                let signed_in = matches!(phase, Some(crate::engine::Phase::Ready));
                let count = self.data(account.as_deref()).map_err(fail)?.mirror.lock().conversations().len();
                let accounts = crate::account::accounts(&self.app).list();
                Ok(json!({ "signedIn": signed_in, "phase": phase, "conversations": count, "allowSend": cfg.allow_send, "allowSchedules": cfg.allow_schedules, "accounts": accounts }))
            }
            "list_conversations" => {
                let account = Some(arg_str(&args, "account")).filter(|a| !a.is_empty());
                let list = self
                    .find_conversations(
                        account.as_deref(),
                        Some(arg_str(&args, "query").as_str()).filter(|q| !q.is_empty()),
                        arg_usize(&args, "limit", 30, 200),
                        args.get("unreadOnly").and_then(Value::as_bool).unwrap_or(false),
                    )
                    .map_err(fail)?;
                Ok(json!({ "conversations": list }))
            }
            "get_messages" => {
                let id = arg_str(&args, "conversationId");
                let limit = arg_usize(&args, "limit", 50, 500);
                let account = Some(arg_str(&args, "account")).filter(|a| !a.is_empty());
                let msgs = self.recent_messages(account.as_deref(), Some(id.as_str()).filter(|s| !s.is_empty()), limit).map_err(fail)?;
                Ok(json!({ "messages": msgs }))
            }
            "search_messages" => {
                let conversation = Some(arg_str(&args, "conversationId")).filter(|c| !c.is_empty());
                let context = args.get("context").and_then(Value::as_u64).unwrap_or(3).min(10) as usize;
                let account = Some(arg_str(&args, "account")).filter(|a| !a.is_empty());
                self.search_messages(account.as_deref(), &arg_str(&args, "query"), conversation, arg_usize(&args, "limit", 10, 50), context).await.map_err(fail)
            }
            "list_schedules" => {
                let due = self.next_due.lock().clone();
                let jobs: Vec<Value> = self.config.lock().jobs.iter().map(|j| job_view(j, due.get(&j.id).copied())).collect();
                Ok(json!({ "schedules": jobs }))
            }
            "preview_cron" => {
                let times = cron::upcoming(&arg_str(&args, "expr"), arg_usize(&args, "count", 5, 20)).map_err(fail)?;
                Ok(json!({ "next": times.iter().map(|t| t.to_rfc3339()).collect::<Vec<_>>() }))
            }
            "send_message" if cfg.allow_send => {
                let id = arg_str(&args, "conversationId");
                let text = args.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
                let account = Some(arg_str(&args, "account")).filter(|a| !a.is_empty());
                self.send_text(account.as_deref(), &id, &text).await.map_err(fail)?;
                Ok(json!({ "sent": true, "conversationId": id }))
            }
            "create_schedule" if cfg.allow_schedules => {
                if !cfg.allow_send {
                    return Err(fail("Compola chưa cho phép MCP gửi tin nhắn (Cài đặt › MCP)".into()));
                }
                let conversation_id = arg_str(&args, "conversationId");
                // The job keeps the account explicitly: the active one may change before it runs.
                let account = self.resolve(Some(arg_str(&args, "account")).filter(|a| !a.is_empty()).as_deref()).map_err(fail)?;
                let conversation_name = self.data(Some(&account)).map_err(fail)?.mirror.lock().conversation(&conversation_id).map(|c| c.name).unwrap_or_default();
                let schedule = match (args.get("cron").and_then(Value::as_str), args.get("at")) {
                    (Some(expr), _) => Schedule::Cron { expr: expr.trim().to_owned() },
                    (None, Some(at)) => Schedule::Once { at: parse_at(at).map_err(fail)? },
                    (None, None) => return Err(fail("cần `cron` hoặc `at`".into())),
                };
                let job = Job {
                    id: String::new(),
                    name: arg_str(&args, "name"),
                    enabled: true,
                    schedule,
                    action: Action::SendText {
                        conversation_id,
                        conversation_name,
                        text: args.get("text").and_then(Value::as_str).unwrap_or("").to_owned(),
                        account: Some(account),
                    },
                    created_by: "mcp".into(),
                    last_run: None,
                    last_status: None,
                    last_ok: None,
                };
                let saved = self.save_job(job).map_err(fail)?;
                let next = self.next_due.lock().get(&saved.id).copied();
                Ok(json!({ "schedule": job_view(&saved, next) }))
            }
            "update_schedule" if cfg.allow_schedules => {
                let id = arg_str(&args, "id");
                let mut job = self.config.lock().jobs.iter().find(|j| j.id == id).cloned().ok_or_else(|| fail("không tìm thấy lịch".into()))?;
                if let Some(e) = args.get("enabled").and_then(Value::as_bool) {
                    job.enabled = e;
                }
                if let Some(expr) = args.get("cron").and_then(Value::as_str) {
                    job.schedule = Schedule::Cron { expr: expr.trim().to_owned() };
                } else if let Some(at) = args.get("at") {
                    job.schedule = Schedule::Once { at: parse_at(at).map_err(fail)? };
                }
                if let Some(n) = args.get("name").and_then(Value::as_str) {
                    job.name = n.to_owned();
                }
                if let (Some(t), Action::SendText { text, .. }) = (args.get("text").and_then(Value::as_str), &mut job.action) {
                    *text = t.to_owned();
                }
                let saved = self.save_job(job).map_err(fail)?;
                let next = self.next_due.lock().get(&saved.id).copied();
                Ok(json!({ "schedule": job_view(&saved, next) }))
            }
            "delete_schedule" if cfg.allow_schedules => {
                let deleted = self.delete_job(&arg_str(&args, "id")).map_err(fail)?;
                Ok(json!({ "deleted": deleted }))
            }
            "run_schedule" if cfg.allow_schedules => {
                let run = self.run_job_now(&arg_str(&args, "id")).await.map_err(fail)?;
                if run.ok { Ok(serde_json::to_value(run).unwrap_or_default()) } else { Err(fail(run.status)) }
            }
            "list_external_tools" if cfg.expose_external => {
                let wanted = arg_str(&args, "serverId");
                let clients: Vec<_> = self.config.lock().mcp_clients.iter().filter(|c| c.enabled && (wanted.is_empty() || c.id == wanted)).cloned().collect();
                let mut out = Vec::new();
                for c in clients {
                    let entry = match self.pool.get(&c).await {
                        Ok(client) => match client.list_tools().await {
                            Ok(tools) => json!({ "serverId": c.id, "name": c.name, "tools": tools }),
                            Err(e) => json!({ "serverId": c.id, "name": c.name, "error": e }),
                        },
                        Err(e) => json!({ "serverId": c.id, "name": c.name, "error": e }),
                    };
                    out.push(entry);
                }
                Ok(json!({ "servers": out }))
            }
            "call_external_tool" if cfg.expose_external => {
                let c = self.client_config(&arg_str(&args, "serverId")).ok_or_else(|| fail("máy chủ không tồn tại hoặc đang tắt".into()))?;
                let client = self.pool.get(&c).await.map_err(fail)?;
                let r = client.call_tool(&arg_str(&args, "tool"), args.get("arguments").cloned().unwrap_or(json!({}))).await.map_err(fail)?;
                if r.get("isError").and_then(Value::as_bool) == Some(true) {
                    return Err(fail(mcp_client::result_text(&r)));
                }
                Ok(r)
            }
            other if other.starts_with("addon_") => {
                let target = {
                    let enabled: Vec<String> = self.config.lock().addons.iter().filter(|(_, s)| s.enabled).map(|(k, _)| k.clone()).collect();
                    self.addon_tools.lock().iter().filter(|(a, _)| enabled.contains(a)).find_map(|(addon, list)| {
                        list.iter()
                            .filter_map(|t| t.get("name").and_then(Value::as_str))
                            .find(|t| addon_tool_name(addon, t) == other)
                            .map(|t| (addon.clone(), t.to_owned()))
                    })
                };
                let (addon, tool) = target.ok_or(ToolError::Unknown)?;
                self.call_addon_tool(&addon, &tool, args).await.map_err(fail)
            }
            _ => Err(ToolError::Unknown),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_vietnamese() {
        assert_eq!(fold("Trần Đức Hưng"), "tran duc hung");
        assert_eq!(fold("NHÓM Gia Đình"), "nhom gia dinh");
    }

    #[test]
    fn parses_times() {
        assert_eq!(parse_at(&json!("2026-12-01T09:00:00+07:00")).unwrap(), 1_796_090_400_000);
        assert_eq!(parse_at(&json!(1_796_090_400)).unwrap(), 1_796_090_400_000);
        assert!(parse_at(&json!("tomorrow")).is_err());
    }
}
