//! Persisted automation settings: `~/Library/Application Support/Compola/automation.json`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_PORT: u16 = 39217;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpServerConfig {
    pub enabled: bool,
    pub port: u16,
    /// Bearer token every request must carry.
    pub token: String,
    /// Whether MCP clients may send messages (otherwise the server is read-only).
    pub allow_send: bool,
    /// Whether MCP clients may create, change or delete schedules.
    pub allow_schedules: bool,
    /// Whether the tools of the external MCP servers below are re-exposed (`external_call`).
    pub expose_external: bool,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, token: new_token(), allow_send: false, allow_schedules: true, expose_external: false }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Stdio,
    Http,
}

/// An external MCP server Compola connects to as a client.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientConfig {
    pub id: String,
    pub name: String,
    pub transport: Transport,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    /// 5-field cron expression in local time.
    Cron { expr: String },
    /// Once, at a Unix time in milliseconds.
    Once { at: i64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    /// `text` may contain `{{date}}`, `{{time}}`, `{{weekday}}`.
    #[serde(rename_all = "camelCase")]
    SendText {
        conversation_id: String,
        #[serde(default)]
        conversation_name: String,
        text: String,
        /// The account to send from (missing in jobs from before multi-account: `default`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    McpTool { server_id: String, tool: String, #[serde(default)] arguments: Value },
    /// Delivered to the add-on's `compola.on('schedule', …)` handlers.
    #[serde(rename_all = "camelCase")]
    Addon { addon_id: String, #[serde(default)] payload: Value },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub schedule: Schedule,
    pub action: Action,
    /// `ui`, `mcp` or `addon:<id>`.
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub last_run: Option<i64>,
    #[serde(default)]
    pub last_status: Option<String>,
    #[serde(default)]
    pub last_ok: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonState {
    pub enabled: bool,
    /// Values for the manifest's `settings` fields.
    #[serde(default)]
    pub settings: serde_json::Map<String, Value>,
    /// The add-on's own key/value storage (`compola.storage`).
    #[serde(default)]
    pub storage: serde_json::Map<String, Value>,
}

/// Message search (`search.rs`): keyword search is always on; semantic search needs an embeddings provider.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchConfig {
    /// Index the messages Compola sees (off = nothing is written, the index is emptied).
    pub enabled: bool,
    pub semantic: bool,
    /// `ollama` (local, `/api/embed`) or `openai` (any OpenAI-compatible `/embeddings`).
    pub provider: String,
    pub url: String,
    pub model: String,
    pub api_key: String,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self { enabled: true, semantic: false, provider: "ollama".into(), url: "http://127.0.0.1:11434".into(), model: "bge-m3".into(), api_key: String::new() }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub search: SearchConfig,
    pub mcp_server: McpServerConfig,
    pub mcp_clients: Vec<McpClientConfig>,
    pub jobs: Vec<Job>,
    pub addons: BTreeMap<String, AddonState>,
    /// Built-in add-ons already copied into the add-ons folder (so a removed one is not reinstalled).
    pub seeded_addons: Vec<String>,
}

pub fn path() -> PathBuf {
    crate::platform::app_support().join("automation.json")
}

pub fn load() -> Config {
    match std::fs::read(path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            log::warn!("automation.json unreadable ({e}); starting from defaults");
            let _ = std::fs::rename(path(), path().with_extension("json.bad"));
            Config::default()
        }),
        Err(_) => Config::default(),
    }
}

pub fn save(config: &Config) -> Result<(), String> {
    let p = path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // It holds the MCP token and client credentials.
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

pub fn new_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_text_jobs_from_before_multi_account_belong_to_default() {
        let old: Action = serde_json::from_value(serde_json::json!({ "kind": "sendText", "conversationId": "g1", "text": "hi" })).expect("old job");
        assert!(matches!(old, Action::SendText { account: None, .. }));
        let new = Action::SendText { conversation_id: "g1".into(), conversation_name: String::new(), text: "hi".into(), account: Some("a1b2c3d4e".into()) };
        let v = serde_json::to_value(&new).unwrap();
        assert_eq!(v["account"], "a1b2c3d4e");
        let none = Action::SendText { conversation_id: "g1".into(), conversation_name: String::new(), text: "hi".into(), account: None };
        assert!(serde_json::to_value(&none).unwrap().get("account").is_none());
    }
}
