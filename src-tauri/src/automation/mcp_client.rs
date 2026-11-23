//! MCP client: connects to external MCP servers over stdio (a spawned process, newline-delimited JSON-RPC) or
//! Streamable HTTP (POST, JSON or SSE answers, `Mcp-Session-Id`). Connections are opened on first use and reused;
//! a broken one is dropped and reopened on the next call.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use super::config::{McpClientConfig, Transport};

const PROTOCOL_VERSION: &str = "2025-06-18";
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>;

enum Conn {
    Stdio { stdin: AsyncMutex<tokio::process::ChildStdin>, pending: Pending, child: Mutex<tokio::process::Child>, alive: Arc<std::sync::atomic::AtomicBool> },
    Http { http: reqwest::Client, url: String, headers: Vec<(String, String)>, session: Mutex<Option<String>> },
}

pub struct Client {
    pub config: McpClientConfig,
    conn: Conn,
    next_id: AtomicI64,
    pub server_info: Mutex<Value>,
}

impl Drop for Client {
    fn drop(&mut self) {
        if let Conn::Stdio { child, .. } = &self.conn {
            let _ = child.lock().start_kill();
        }
    }
}

/// The user's login-shell PATH: an app started from Finder only has `/usr/bin:/bin:…`, so `npx`, `uvx`, `docker`, …
/// would not be found.
fn user_path() -> String {
    static PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let from_shell = std::process::Command::new(shell)
            .args(["-l", "-c", "printf %s \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .filter(|p| !p.is_empty());
        let mut parts: Vec<String> = from_shell.or_else(|| std::env::var("PATH").ok()).unwrap_or_default().split(':').map(str::to_owned).collect();
        for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            if !parts.iter().any(|p| p == extra) {
                parts.push(extra.into());
            }
        }
        parts.retain(|p| !p.is_empty());
        parts.join(":")
    })
    .clone()
}

impl Client {
    pub async fn connect(config: McpClientConfig) -> Result<Arc<Self>, String> {
        let conn = match config.transport {
            Transport::Stdio => {
                if config.command.trim().is_empty() {
                    return Err("chưa nhập lệnh khởi chạy".into());
                }
                let mut cmd = tokio::process::Command::new(config.command.trim());
                cmd.args(&config.args)
                    .env("PATH", user_path())
                    .envs(&config.env)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);
                let mut child = cmd.spawn().map_err(|e| format!("không chạy được \"{}\": {e}", config.command))?;
                let stdin = child.stdin.take().ok_or("no stdin")?;
                let stdout = child.stdout.take().ok_or("no stdout")?;
                let stderr = child.stderr.take();
                let pending: Pending = Arc::default();
                let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
                let (p, a, name) = (pending.clone(), alive.clone(), config.name.clone());
                tauri::async_runtime::spawn(async move {
                    let mut lines = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                        if let Some(id) = msg.get("id").and_then(Value::as_i64).filter(|_| msg.get("method").is_none()) {
                            if let Some(tx) = p.lock().remove(&id) {
                                let _ = tx.send(msg);
                            }
                        }
                    }
                    a.store(false, Ordering::SeqCst);
                    p.lock().clear();
                    log::info!("mcp client [{name}]: process exited");
                });
                if let Some(stderr) = stderr {
                    let name = config.name.clone();
                    tauri::async_runtime::spawn(async move {
                        let mut lines = BufReader::new(stderr).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            log::debug!("mcp client [{name}] stderr: {}", line.chars().take(300).collect::<String>());
                        }
                    });
                }
                Conn::Stdio { stdin: AsyncMutex::new(stdin), pending, child: Mutex::new(child), alive }
            }
            Transport::Http => {
                let url = config.url.trim().to_owned();
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err("URL phải bắt đầu bằng http:// hoặc https://".into());
                }
                let http = reqwest::Client::builder().timeout(CALL_TIMEOUT).build().map_err(|e| e.to_string())?;
                Conn::Http { http, url, headers: config.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect(), session: Mutex::new(None) }
            }
        };
        let client = Arc::new(Self { config, conn, next_id: AtomicI64::new(1), server_info: Mutex::new(Value::Null) });
        let init = client
            .request("initialize", json!({ "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "compola", "version": env!("CARGO_PKG_VERSION") } }))
            .await?;
        *client.server_info.lock() = init.get("serverInfo").cloned().unwrap_or(Value::Null);
        client.notify("notifications/initialized", json!({})).await?;
        Ok(client)
    }

    pub fn is_alive(&self) -> bool {
        match &self.conn {
            Conn::Stdio { alive, .. } => alive.load(Ordering::SeqCst),
            Conn::Http { .. } => true,
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        match &self.conn {
            Conn::Stdio { stdin, .. } => write_line(stdin, &msg).await,
            Conn::Http { .. } => self.http_post(&msg, None).await.map(|_| ()),
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let answer = match &self.conn {
            Conn::Stdio { stdin, pending, alive, .. } => {
                if !alive.load(Ordering::SeqCst) {
                    return Err("tiến trình MCP đã dừng".into());
                }
                let (tx, rx) = oneshot::channel();
                pending.lock().insert(id, tx);
                if let Err(e) = write_line(stdin, &msg).await {
                    pending.lock().remove(&id);
                    return Err(e);
                }
                match tokio::time::timeout(CALL_TIMEOUT, rx).await {
                    Ok(Ok(v)) => v,
                    Ok(Err(_)) => return Err("tiến trình MCP đã dừng".into()),
                    Err(_) => {
                        pending.lock().remove(&id);
                        return Err(format!("{method}: hết thời gian chờ"));
                    }
                }
            }
            Conn::Http { .. } => self.http_post(&msg, Some(id)).await?.ok_or("máy chủ không trả lời")?,
        };
        if let Some(err) = answer.get("error") {
            let text = err.get("message").and_then(Value::as_str).unwrap_or("lỗi");
            return Err(format!("{method}: {text}"));
        }
        Ok(answer.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn http_post(&self, msg: &Value, id: Option<i64>) -> Result<Option<Value>, String> {
        let Conn::Http { http, url, headers, session } = &self.conn else { unreachable!() };
        let mut req = http
            .post(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION)
            .body(serde_json::to_vec(msg).map_err(|e| e.to_string())?);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        if let Some(s) = session.lock().clone() {
            req = req.header("Mcp-Session-Id", s);
        }
        let resp = req.send().await.map_err(|e| format!("không kết nối được: {e}"))?;
        if let Some(s) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *session.lock() = Some(s.to_owned());
        }
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {status}: {}", body.chars().take(200).collect::<String>()));
        }
        let Some(id) = id else { return Ok(None) };
        let is_sse = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|c| c.contains("text/event-stream"));
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if !is_sse {
            let v: Value = serde_json::from_str(&body).map_err(|e| format!("trả lời không phải JSON: {e}"))?;
            return Ok(Some(match v {
                Value::Array(items) => items.into_iter().find(|m| m.get("id").and_then(Value::as_i64) == Some(id)).unwrap_or(Value::Null),
                other => other,
            }));
        }
        // SSE: events separated by blank lines, `data:` lines joined.
        for event in body.split("\n\n") {
            let data: String = event.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim_start).collect::<Vec<_>>().join("\n");
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if v.get("id").and_then(Value::as_i64) == Some(id) && v.get("method").is_none() {
                    return Ok(Some(v));
                }
            }
        }
        Err("máy chủ không trả lời yêu cầu".into())
    }

    pub async fn list_tools(&self) -> Result<Vec<Value>, String> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let page = self.request("tools/list", params).await?;
            tools.extend(page.get("tools").and_then(Value::as_array).cloned().unwrap_or_default());
            cursor = page.get("nextCursor").and_then(Value::as_str).map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }

    pub async fn call_tool(&self, tool: &str, arguments: Value) -> Result<Value, String> {
        let args = if arguments.is_object() { arguments } else { json!({}) };
        self.request("tools/call", json!({ "name": tool, "arguments": args })).await
    }
}

async fn write_line(stdin: &AsyncMutex<tokio::process::ChildStdin>, msg: &Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    line.push(b'\n');
    let mut w = stdin.lock().await;
    w.write_all(&line).await.map_err(|e| format!("ghi vào tiến trình MCP thất bại: {e}"))?;
    w.flush().await.map_err(|e| e.to_string())
}

/// The text of a `tools/call` result (its text content blocks), for logs and schedules.
pub fn result_text(result: &Value) -> String {
    let text: Vec<&str> = result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| c.get("text").and_then(Value::as_str))
        .collect();
    if text.is_empty() { result.to_string() } else { text.join("\n") }
}

/// Live connections by server id.
#[derive(Default)]
pub struct Pool {
    clients: AsyncMutex<HashMap<String, Arc<Client>>>,
}

impl Pool {
    pub async fn get(&self, config: &McpClientConfig) -> Result<Arc<Client>, String> {
        let mut map = self.clients.lock().await;
        if let Some(c) = map.get(&config.id) {
            if c.is_alive() && same_target(&c.config, config) {
                return Ok(c.clone());
            }
            map.remove(&config.id);
        }
        let client = Client::connect(config.clone()).await?;
        map.insert(config.id.clone(), client.clone());
        Ok(client)
    }

    pub async fn drop_client(&self, id: &str) {
        self.clients.lock().await.remove(id);
    }

    pub async fn connected(&self) -> Vec<String> {
        self.clients.lock().await.iter().filter(|(_, c)| c.is_alive()).map(|(k, _)| k.clone()).collect()
    }
}

fn same_target(a: &McpClientConfig, b: &McpClientConfig) -> bool {
    a.transport == b.transport && a.command == b.command && a.args == b.args && a.env == b.env && a.url == b.url && a.headers == b.headers
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal MCP server in Python: stdio (newline JSON) or HTTP (answers as SSE, checks the session header).
    const FAKE: &str = r#"
import json, sys
def answer(m):
    meth = m.get("method")
    if "id" not in m: return None
    if meth == "initialize": r = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}}
    elif meth == "tools/list": r = {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}
    elif meth == "tools/call": r = {"content": [{"type": "text", "text": "echo:" + m["params"]["arguments"].get("x", "")}]}
    else: return {"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "nope"}}
    return {"jsonrpc": "2.0", "id": m["id"], "result": r}
if sys.argv[1] == "stdio":
    for line in sys.stdin:
        a = answer(json.loads(line))
        if a: print(json.dumps(a), flush=True)
else:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_POST(self):
            m = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if m.get("method") != "initialize" and self.headers.get("Mcp-Session-Id") != "s1":
                self.send_response(400); self.end_headers(); return
            a = answer(m)
            if a is None:
                self.send_response(202); self.end_headers(); return
            body = ("event: message\ndata: " + json.dumps(a) + "\n\n").encode()
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Mcp-Session-Id", "s1")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    s = HTTPServer(("127.0.0.1", 0), H)
    print(s.server_port, flush=True)
    s.serve_forever()
"#;

    fn config(transport: Transport, args: Vec<String>, url: String) -> McpClientConfig {
        McpClientConfig { id: "t".into(), name: "fake".into(), transport, command: "python3".into(), args, env: Default::default(), url, headers: Default::default(), enabled: true }
    }

    async fn exercise(c: &Client) {
        assert_eq!(c.server_info.lock().get("name").and_then(Value::as_str), Some("fake"));
        let tools = c.list_tools().await.unwrap();
        assert_eq!(tools[0]["name"], "echo");
        let r = c.call_tool("echo", json!({ "x": "hi" })).await.unwrap();
        assert_eq!(result_text(&r), "echo:hi");
        assert!(c.request("bogus", json!({})).await.unwrap_err().contains("nope"));
    }

    #[tokio::test]
    async fn stdio_and_http_round_trip() {
        let dir = std::env::temp_dir().join(format!("compola-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake_mcp.py");
        std::fs::write(&script, FAKE).unwrap();
        let path = script.to_string_lossy().into_owned();

        let c = Client::connect(config(Transport::Stdio, vec![path.clone(), "stdio".into()], String::new())).await.unwrap();
        exercise(&c).await;
        drop(c);

        let mut server = tokio::process::Command::new("python3").args([path.as_str(), "http"]).stdout(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
        let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
        let port = lines.next_line().await.unwrap().unwrap();
        let c = Client::connect(config(Transport::Http, vec![], format!("http://127.0.0.1:{port}/mcp"))).await.unwrap();
        exercise(&c).await;
        let _ = server.kill().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
