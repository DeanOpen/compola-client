//! MCP server (Streamable HTTP transport, JSON answers) on `127.0.0.1:<port>/mcp`, so Claude Code, Claude Desktop
//! (through `mcp-remote`), Cursor, … can use the Zalo account through Compola's tools (`super::tools`).
//!
//! Security: bound to loopback only; every request needs `Authorization: Bearer <token>`; requests carrying a
//! non-loopback `Origin` are refused (DNS rebinding). Each connection serves one request (`Connection: close`).

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the server serves (implemented by `Automation`; a fake in the tests).
pub trait ToolHost: Send + Sync + 'static {
    /// The bearer token; empty refuses every request.
    fn token(&self) -> String;
    fn tool_list(self: Arc<Self>) -> BoxFuture<'static, Vec<Value>>;
    fn call_tool(self: Arc<Self>, name: String, args: Value) -> BoxFuture<'static, Result<Value, ToolError>>;
}

impl ToolHost for super::Automation {
    fn token(&self) -> String {
        self.server_token()
    }
    fn tool_list(self: Arc<Self>) -> BoxFuture<'static, Vec<Value>> {
        Box::pin(async move { self.mcp_tool_list().await })
    }
    fn call_tool(self: Arc<Self>, name: String, args: Value) -> BoxFuture<'static, Result<Value, ToolError>> {
        Box::pin(async move { self.mcp_call_tool(&name, args).await })
    }
}

const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY: usize = 4 << 20;

pub struct ServerHandle {
    pub port: u16,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn start<H: ToolHost>(automation: Weak<H>, port: u16) -> Result<ServerHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("không mở được cổng {port}: {e}"))?;
    log::info!("mcp server listening on 127.0.0.1:{port}");
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let Some(a) = automation.upgrade() else { break };
            tauri::async_runtime::spawn(async move {
                if let Err(e) = tokio::time::timeout(Duration::from_secs(300), serve(a, stream)).await.unwrap_or(Err("timeout".into())) {
                    log::debug!("mcp server: connection ended: {e}");
                }
            });
        }
    });
    Ok(ServerHandle { port, task })
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

async fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("closed".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 64 * 1024 {
            return Err("headers too large".into());
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let method = first.next().unwrap_or_default().to_owned();
    let path = first.next().unwrap_or_default().to_owned();
    let headers: Vec<(String, String)> =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned())).collect();
    let length: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    if length > MAX_BODY {
        return Err("body too large".into());
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Ok(Request { method, path, headers, body })
}

async fn respond(stream: &mut TcpStream, status: &str, extra: &[(&str, String)], body: Option<&Value>) -> Result<(), String> {
    let bytes = body.map(|b| serde_json::to_vec(b).unwrap_or_default()).unwrap_or_default();
    let mut head = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n", bytes.len());
    if body.is_some() {
        head.push_str("Content-Type: application/json\r\n");
    }
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

fn loopback_origin(origin: &str) -> bool {
    let Ok(u) = url::Url::parse(origin) else { return false };
    matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"))
}

/// Constant-time comparison for the token.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn serve<H: ToolHost>(automation: Arc<H>, mut stream: TcpStream) -> Result<(), String> {
    let req = read_request(&mut stream).await?;
    let path = req.path.split('?').next().unwrap_or("");
    if req.method == "GET" && path == "/health" {
        return respond(&mut stream, "200 OK", &[], Some(&json!({ "ok": true, "name": "compola" }))).await;
    }
    if path != "/mcp" && path != "/mcp/" {
        return respond(&mut stream, "404 Not Found", &[], Some(&json!({ "error": "not found; use /mcp" }))).await;
    }
    if let Some(origin) = req.header("origin") {
        if !loopback_origin(origin) {
            return respond(&mut stream, "403 Forbidden", &[], Some(&json!({ "error": "origin not allowed" }))).await;
        }
    }
    let token = automation.token();
    let given = req.header("authorization").and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))).unwrap_or("").trim();
    if token.is_empty() || !same(given, &token) {
        return respond(&mut stream, "401 Unauthorized", &[("WWW-Authenticate", "Bearer".into())], Some(&json!({ "error": "missing or wrong bearer token" }))).await;
    }
    match req.method.as_str() {
        "POST" => {}
        // No server-initiated stream is offered.
        "GET" => return respond(&mut stream, "405 Method Not Allowed", &[("Allow", "POST, DELETE".into())], None).await,
        "DELETE" => return respond(&mut stream, "200 OK", &[], None).await,
        _ => return respond(&mut stream, "405 Method Not Allowed", &[("Allow", "POST, DELETE".into())], None).await,
    }
    let parsed: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(e) => {
            let err = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("parse error: {e}") } });
            return respond(&mut stream, "400 Bad Request", &[], Some(&err)).await;
        }
    };
    let session = req.header("mcp-session-id").map(str::to_owned).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let headers = [("Mcp-Session-Id", session)];
    match parsed {
        Value::Array(batch) => {
            let mut answers = Vec::new();
            for msg in batch {
                if let Some(a) = handle(&automation, msg).await {
                    answers.push(a);
                }
            }
            if answers.is_empty() {
                respond(&mut stream, "202 Accepted", &headers, None).await
            } else {
                respond(&mut stream, "200 OK", &headers, Some(&Value::Array(answers))).await
            }
        }
        msg => match handle(&automation, msg).await {
            Some(a) => respond(&mut stream, "200 OK", &headers, Some(&a)).await,
            None => respond(&mut stream, "202 Accepted", &headers, None).await,
        },
    }
}

/// One JSON-RPC message → its answer (None for notifications and responses).
async fn handle<H: ToolHost>(automation: &Arc<H>, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str)?.to_owned();
    let id = id?;
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let result: Result<Value, (i64, String)> = match method.as_str() {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(SUPPORTED_VERSIONS[0]);
            let version = if SUPPORTED_VERSIONS.contains(&asked) { asked } else { SUPPORTED_VERSIONS[0] };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "compola", "title": "Compola (Zalo)", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Tools for the Zalo account signed in to Compola on this Mac. Find a conversation id with list_conversations before sending or scheduling. Messages come from what Compola has seen since it started (all conversations' latest messages) plus the full history of chats opened in the app.",
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": automation.clone().tool_list().await })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_owned();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match automation.clone().call_tool(name.clone(), args).await {
                Ok(v) => Ok(tool_result(v, false)),
                Err(ToolError::Unknown) => Err((-32602, format!("unknown tool: {name}"))),
                Err(ToolError::Failed(text)) => Ok(tool_result(Value::String(text), true)),
            }
        }
        "resources/list" => Ok(json!({ "resources": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    })
}

pub enum ToolError {
    Unknown,
    Failed(String),
}

fn tool_result(v: Value, is_error: bool) -> Value {
    let text = match &v {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    let mut out = json!({ "content": [{ "type": "text", "text": text }], "isError": is_error });
    if !is_error && v.is_object() {
        out["structuredContent"] = v;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::config::{McpClientConfig, Transport};
    use crate::automation::mcp_client::{Client, result_text};

    struct Fake;

    impl ToolHost for Fake {
        fn token(&self) -> String {
            "secret-token-123456".into()
        }
        fn tool_list(self: Arc<Self>) -> BoxFuture<'static, Vec<Value>> {
            Box::pin(async { vec![json!({ "name": "hello", "inputSchema": { "type": "object" } })] })
        }
        fn call_tool(self: Arc<Self>, name: String, args: Value) -> BoxFuture<'static, Result<Value, ToolError>> {
            Box::pin(async move {
                match name.as_str() {
                    "hello" => Ok(json!({ "greeting": format!("xin chào {}", args["name"].as_str().unwrap_or("?")) })),
                    "broken" => Err(ToolError::Failed("hỏng".into())),
                    _ => Err(ToolError::Unknown),
                }
            })
        }
    }

    async fn raw(port: u16, request: String) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    fn post(token: &str, origin: Option<&str>, body: &str) -> String {
        let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
        format!("POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\n{origin}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
    }

    #[tokio::test]
    async fn serves_mcp_over_http_to_our_own_client() {
        let host = Arc::new(Fake);
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let _server = start(Arc::downgrade(&host), port).await.unwrap();

        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert!(raw(port, post("wrong", None, ping)).await.starts_with("HTTP/1.1 401"));
        assert!(raw(port, post("secret-token-123456", Some("https://evil.example"), ping)).await.starts_with("HTTP/1.1 403"));
        assert!(raw(port, post("secret-token-123456", Some("http://localhost:3000"), ping)).await.starts_with("HTTP/1.1 200"));
        let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert!(raw(port, post("secret-token-123456", None, note)).await.starts_with("HTTP/1.1 202"));
        let batch = r#"[{"jsonrpc":"2.0","id":7,"method":"ping"},{"jsonrpc":"2.0","id":8,"method":"nope"}]"#;
        let answer = raw(port, post("secret-token-123456", None, batch)).await;
        assert!(answer.contains(r#""id":7"#) && answer.contains("-32601"), "{answer}");

        let mut headers = std::collections::BTreeMap::new();
        headers.insert("Authorization".to_owned(), "Bearer secret-token-123456".to_owned());
        let cfg = McpClientConfig {
            id: "self".into(),
            name: "self".into(),
            transport: Transport::Http,
            command: String::new(),
            args: vec![],
            env: Default::default(),
            url: format!("http://127.0.0.1:{port}/mcp"),
            headers,
            enabled: true,
        };
        let c = Client::connect(cfg).await.unwrap();
        assert_eq!(c.server_info.lock()["name"], "compola");
        assert_eq!(c.list_tools().await.unwrap()[0]["name"], "hello");
        let r = c.call_tool("hello", json!({ "name": "An" })).await.unwrap();
        assert_eq!(r["structuredContent"]["greeting"], "xin chào An");
        assert!(result_text(&r).contains("xin chào An"));
        let r = c.call_tool("broken", json!({})).await.unwrap();
        assert_eq!(r["isError"], true);
        assert_eq!(result_text(&r), "hỏng");
        assert!(c.call_tool("missing", json!({})).await.unwrap_err().contains("unknown tool"));
    }
}
