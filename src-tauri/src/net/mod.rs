//! Performs the official renderer's http(s) and ws(s) traffic (see `network-shim.js`) — port of
//! `NetworkProxy.swift`. Rust owns the transport: one persistent cookie jar, the client user agent, Chromium's
//! header set, and no CORS (the Electron renderer had none either — it ran from file://).

pub mod cookies;
pub mod fingerprint;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::host::Host;
use crate::values::{b64, js_literal, unb64};
use cookies::CookieJar;

/// Identity and header constants of the official Zalo PC build (`ClientFingerprint.swift`,
/// `reanalysis/wire-fingerprint.md`). Zalo sees these on the wire, so they must match the official client.
pub mod fp {
    pub const CLIENT_TYPE: &str = "23";
    pub const DEFAULT_CLIENT_VERSION: &str = "694";
    pub const SEC_CH_UA: &str = r#""Not?A_Brand";v="8", "Chromium";v="108""#;
    pub const SEC_CH_UA_MOBILE: &str = "?0";
    pub const SEC_CH_UA_PLATFORM: &str = r#""macOS""#;
    pub const ACCEPT_ENCODING: &str = "gzip, deflate, br";
    pub const IMAGE_ACCEPT: &str = "image/webp,image/apng,image/*,*/*;q=0.8";
    pub const WEBSOCKET_ORIGIN: &str = "file://";

    pub fn user_agent(client_version: &str) -> String {
        format!("ZaloPC-darwin-{CLIENT_TYPE}v{client_version}")
    }

    /// Chromium's Accept-Language from the system's preferred languages (`en-US`, then descending q-values).
    pub fn accept_language() -> String {
        let langs: Vec<String> = sys_locale_list();
        if langs.is_empty() {
            return "en-US".into();
        }
        langs
            .iter()
            .enumerate()
            .map(|(i, l)| if i == 0 { l.clone() } else { format!("{l};q={:.1}", 1.0 - 0.1 * i as f64) })
            .collect::<Vec<_>>()
            .join(",")
    }

    fn sys_locale_list() -> Vec<String> {
        // `defaults read -g AppleLanguages` is what Locale.preferredLanguages reads.
        static CACHE: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
        CACHE
            .get_or_init(|| {
                let out = std::process::Command::new("defaults").args(["read", "-g", "AppleLanguages"]).output();
                let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
                text.split(['\n', ',', '(', ')'])
                    .map(|s| s.trim().trim_matches('"').replace('_', "-"))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .clone()
    }

    /// Chromium's multipart boundary: `----WebKitFormBoundary` + 16 chars of `[0-9A-Za-z]`.
    pub fn form_boundary() -> String {
        use rand::Rng;
        const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        let mut rng = rand::thread_rng();
        let tail: String = (0..16).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect();
        format!("----WebKitFormBoundary{tail}")
    }
}

enum WsCmd {
    Send(Message),
    Close(u16, String),
}

pub struct NetworkProxy {
    app: AppHandle,
    label: String,
    user_agent: String,
    client: reqwest::Client,
    sockets: Mutex<HashMap<i64, mpsc::UnboundedSender<WsCmd>>>,
}

/// One HTTP response as the shim expects it.
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub url: String,
    pub body: Vec<u8>,
}

impl NetworkProxy {
    pub fn new(app: AppHandle, label: String, user_agent: String) -> Arc<Self> {
        let client = reqwest::Client::builder()
            .user_agent(user_agent.clone())
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .expect("http client");
        Arc::new(Self { app, label, user_agent, client, sockets: Mutex::new(HashMap::new()) })
    }

    fn jar(&self) -> Arc<CookieJar> {
        self.app.state::<Arc<CookieJar>>().inner().clone()
    }

    pub async fn handle(self: Arc<Self>, host: Arc<Host>, body: Value) -> Value {
        match body.get("op").and_then(Value::as_str) {
            Some("http") => json!({ "value": self.perform_http(&body).await }),
            Some("ws.open") => {
                self.open_socket(host, &body);
                json!({ "value": null })
            }
            Some("ws.send") => {
                self.send_socket(&body);
                json!({ "value": null })
            }
            Some("ws.close") => {
                let id = body.get("id").and_then(Value::as_i64).unwrap_or(0);
                let code = body.get("code").and_then(Value::as_u64).unwrap_or(1000) as u16;
                let reason = body.get("reason").and_then(Value::as_str).unwrap_or("").to_owned();
                if let Some(tx) = self.sockets.lock().remove(&id) {
                    let _ = tx.send(WsCmd::Close(code, reason));
                }
                json!({ "value": null })
            }
            Some(op) => json!({ "error": format!("unknown op {op}") }),
            None => json!({ "error": "bad message" }),
        }
    }

    // ---- HTTP ----

    async fn perform_http(&self, body: &Value) -> Value {
        let Some(url) = body.get("url").and_then(Value::as_str).and_then(|u| url::Url::parse(u).ok()) else {
            return json!({ "error": "bad url" });
        };
        let method = body.get("method").and_then(Value::as_str).unwrap_or("GET").to_owned();
        let timeout = body.get("timeout").and_then(Value::as_f64).filter(|t| *t > 0.0).map(|t| Duration::from_millis(t as u64));

        let mut headers: Vec<(String, String)> = Vec::new();
        if let Some(h) = body.get("headers").and_then(Value::as_object) {
            for (k, v) in h {
                if let Some(v) = v.as_str() {
                    headers.push((k.clone(), v.to_owned()));
                }
            }
        }
        let payload = body.get("body").filter(|b| b.is_object()).map(|b| encode_body(b, &mut headers)).unwrap_or_default();
        apply_client_headers(&mut headers);

        match self.request(&method, &url, headers, payload, timeout).await {
            Ok(r) => {
                if let Some(engine) = self.app.try_state::<Arc<crate::engine::Engine>>() {
                    engine.observe_response(&url, r.status, &r.body);
                }
                let mut map = serde_json::Map::new();
                for (k, v) in &r.headers {
                    let k = k.to_ascii_lowercase();
                    match map.get_mut(&k) {
                        Some(Value::String(existing)) => {
                            existing.push_str(", ");
                            existing.push_str(v);
                        }
                        _ => {
                            map.insert(k, Value::String(v.clone()));
                        }
                    }
                }
                json!({
                    "status": r.status,
                    "statusText": r.status_text,
                    "headers": map,
                    "url": r.url,
                    "body": b64(&r.body),
                })
            }
            Err(e) => {
                let timed_out = e.to_ascii_lowercase().contains("timed out") || e.to_ascii_lowercase().contains("timeout");
                json!({ "error": e, "timedOut": timed_out })
            }
        }
    }

    /// One request with the client's cookies, through the fingerprint helper when it runs, else reqwest.
    pub async fn request(
        &self,
        method: &str,
        url: &url::Url,
        mut headers: Vec<(String, String)>,
        body: Vec<u8>,
        timeout: Option<Duration>,
    ) -> Result<HttpResponse, String> {
        let jar = self.jar();
        if let Some(cookie) = jar.header_for(url) {
            headers.push(("cookie".into(), cookie));
        }
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("user-agent")) {
            headers.push(("User-Agent".into(), self.user_agent.clone()));
        }

        if let Some(helper) = fingerprint::FingerprintProxy::shared().ready(Duration::from_secs(3)).await {
            match helper.perform(method, url.as_str(), &headers, &body, timeout).await {
                Ok(r) => {
                    jar.store_from_headers(url, &r.headers);
                    return Ok(r);
                }
                Err(fingerprint::Error::Unavailable) => log::warn!("fingerprint helper unavailable — reqwest fallback"),
                Err(fingerprint::Error::Failed(msg)) => return Err(msg),
            }
        }

        let mut map = HeaderMap::new();
        for (k, v) in &headers {
            if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                map.append(name, value);
            }
        }
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut req = self.client.request(method, url.clone()).headers(map);
        if !body.is_empty() {
            req = req.body(body);
        }
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        let resp = req.send().await.map_err(|e| format!("{e}"))?;
        let status = resp.status();
        let final_url = resp.url().to_string();
        let headers: Vec<(String, String)> =
            resp.headers().iter().map(|(k, v)| (k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect();
        jar.store_from_headers(url, &headers);
        let bytes = resp.bytes().await.map_err(|e| format!("{e}"))?;
        Ok(HttpResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_owned(),
            headers,
            url: final_url,
            body: bytes.to_vec(),
        })
    }

    // ---- WebSocket ----

    fn open_socket(self: &Arc<Self>, host: Arc<Host>, body: &Value) {
        let Some(id) = body.get("id").and_then(Value::as_i64) else { return };
        let Some(url) = body.get("url").and_then(Value::as_str).map(str::to_owned) else { return };
        let protocols: Vec<String> =
            body.get("protocols").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        let (tx, mut rx) = mpsc::unbounded_channel::<WsCmd>();
        self.sockets.lock().insert(id, tx);
        let this = self.clone();
        let weak_host = Arc::downgrade(&host);
        drop(host);
        tauri::async_runtime::spawn(async move {
            let emit = |kind: &str, payload: Value| {
                if let Some(h) = weak_host.upgrade() {
                    h.eval(&format!(
                        "window.__zaloNet && window.__zaloNet.socketEvent({id}, {}, {});",
                        js_literal(&json!(kind)),
                        js_literal(&payload)
                    ));
                }
            };
            let mut request = match url.as_str().into_client_request() {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("ws#{id} bad request: {e}");
                    emit("error", json!({}));
                    emit("close", json!({ "code": 1006, "reason": "", "wasClean": false }));
                    return;
                }
            };
            {
                let h = request.headers_mut();
                let mut put = |k: &'static str, v: &str| {
                    if let Ok(v) = HeaderValue::from_str(v) {
                        h.insert(k, v);
                    }
                };
                put("User-Agent", &this.user_agent);
                // Browsers always send Origin on the upgrade; the Electron renderer was a file:// page.
                put("Origin", fp::WEBSOCKET_ORIGIN);
                put("Accept-Language", &fp::accept_language());
                if !protocols.is_empty() {
                    put("Sec-WebSocket-Protocol", &protocols.join(", "));
                }
                if let Ok(mut http_url) = url::Url::parse(&url) {
                    let _ = http_url.set_scheme(if http_url.scheme() == "ws" { "http" } else { "https" });
                    if let Some(cookie) = this.jar().header_for(&http_url) {
                        put("Cookie", &cookie);
                    }
                }
            }
            let stream = match tokio_tungstenite::connect_async(request).await {
                Ok((stream, response)) => {
                    let proto = response
                        .headers()
                        .get("sec-websocket-protocol")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_owned();
                    log::info!("[{}] ws#{id} handshake ok", this.label);
                    emit("open", json!({ "protocol": proto }));
                    stream
                }
                Err(e) => {
                    log::warn!("[{}] ws#{id} connect failed: {e}", this.label);
                    this.sockets.lock().remove(&id);
                    emit("error", json!({}));
                    emit("close", json!({ "code": 1006, "reason": "", "wasClean": false }));
                    return;
                }
            };
            let (mut sink, mut source) = stream.split();
            loop {
                tokio::select! {
                    cmd = rx.recv() => match cmd {
                        Some(WsCmd::Send(m)) => { if sink.send(m).await.is_err() { break; } }
                        Some(WsCmd::Close(code, reason)) => {
                            let frame = tokio_tungstenite::tungstenite::protocol::CloseFrame { code: code.into(), reason: reason.clone().into() };
                            let _ = sink.send(Message::Close(Some(frame))).await;
                            emit("close", json!({ "code": code, "reason": reason, "wasClean": true }));
                            return;
                        }
                        None => { let _ = sink.close().await; return; }
                    },
                    msg = source.next() => match msg {
                        Some(Ok(Message::Text(t))) => emit("text", json!({ "text": t.as_str() })),
                        Some(Ok(Message::Binary(b))) => emit("binary", json!({ "data": b64(&b) })),
                        Some(Ok(Message::Close(frame))) => {
                            let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                            this.sockets.lock().remove(&id);
                            emit("close", json!({ "code": code, "reason": reason, "wasClean": true }));
                            return;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => {
                            log::warn!("[{}] ws#{id} error: {e}", this.label);
                            this.sockets.lock().remove(&id);
                            emit("error", json!({}));
                            emit("close", json!({ "code": 1006, "reason": "", "wasClean": false }));
                            return;
                        }
                        None => {
                            this.sockets.lock().remove(&id);
                            emit("close", json!({ "code": 1006, "reason": "", "wasClean": false }));
                            return;
                        }
                    }
                }
            }
        });
    }

    fn send_socket(&self, body: &Value) {
        let Some(id) = body.get("id").and_then(Value::as_i64) else { return };
        let msg = if let Some(t) = body.get("text").and_then(Value::as_str) {
            Message::Text(t.to_owned().into())
        } else if let Some(d) = body.get("data").and_then(Value::as_str) {
            Message::Binary(unb64(d).into())
        } else {
            return;
        };
        if let Some(tx) = self.sockets.lock().get(&id) {
            let _ = tx.send(WsCmd::Send(msg));
        }
    }

    pub fn close_all(&self) {
        for (_, tx) in self.sockets.lock().drain() {
            let _ = tx.send(WsCmd::Close(1001, String::new()));
        }
    }
}

/// Fingerprint-helper request for callers without a `NetworkProxy` (the media loader), with the client cookie jar
/// like `NetworkProxy::request`. `Ok(None)`: the helper is not running — the caller uses its own fallback transport.
/// `Err`: an upstream failure reported by the helper.
pub async fn perform_via_helper(
    app: &AppHandle,
    method: &str,
    url: &url::Url,
    mut headers: Vec<(String, String)>,
    body: &[u8],
    timeout: Option<Duration>,
    wait: Duration,
) -> Result<Option<HttpResponse>, String> {
    let Some(helper) = fingerprint::FingerprintProxy::shared().ready(wait).await else { return Ok(None) };
    let jar = app.try_state::<Arc<CookieJar>>().map(|j| j.inner().clone());
    if let Some(cookie) = jar.as_ref().and_then(|j| j.header_for(url)) {
        headers.push(("cookie".into(), cookie));
    }
    match helper.perform(method, url.as_str(), &headers, body, timeout).await {
        Ok(r) => {
            if let Some(jar) = &jar {
                jar.store_from_headers(url, &r.headers);
            }
            Ok(Some(r))
        }
        Err(fingerprint::Error::Unavailable) => Ok(None),
        Err(fingerprint::Error::Failed(msg)) => Err(msg),
    }
}

/// Headers Chromium 108 adds to every renderer request (notably **no** `Origin`/`Referer`).
pub fn apply_client_headers(headers: &mut Vec<(String, String)>) {
    let mut set_default = |name: &str, value: String| {
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(name)) {
            headers.push((name.to_owned(), value));
        }
    };
    set_default("sec-ch-ua", fp::SEC_CH_UA.into());
    set_default("sec-ch-ua-mobile", fp::SEC_CH_UA_MOBILE.into());
    set_default("sec-ch-ua-platform", fp::SEC_CH_UA_PLATFORM.into());
    set_default("sec-fetch-dest", "empty".into());
    set_default("sec-fetch-mode", "cors".into());
    set_default("sec-fetch-site", "cross-site".into());
    set_default("accept-language", fp::accept_language());
}

/// The shim's body description → bytes (and Content-Type).
fn encode_body(encoded: &Value, headers: &mut Vec<(String, String)>) -> Vec<u8> {
    let mut set_default_ct = |headers: &mut Vec<(String, String)>, v: &str| {
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
            headers.push(("Content-Type".into(), v.to_owned()));
        }
    };
    if let Some(ct) = encoded.get("contentType").and_then(Value::as_str) {
        set_default_ct(headers, ct);
    }
    match encoded.get("kind").and_then(Value::as_str) {
        Some("text") => {
            set_default_ct(headers, "text/plain;charset=UTF-8");
            encoded.get("text").and_then(Value::as_str).unwrap_or("").as_bytes().to_vec()
        }
        Some("base64") => unb64(encoded.get("data").and_then(Value::as_str).unwrap_or("")),
        Some("formdata") => {
            let boundary = fp::form_boundary();
            let mut data = Vec::new();
            for part in encoded.get("parts").and_then(Value::as_array).into_iter().flatten() {
                let name = part.get("name").and_then(Value::as_str).unwrap_or("");
                data.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
                if let Some(filename) = part.get("filename").and_then(Value::as_str) {
                    let ty = part.get("type").and_then(Value::as_str).unwrap_or("application/octet-stream");
                    data.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n").as_bytes());
                    data.extend_from_slice(format!("Content-Type: {ty}\r\n\r\n").as_bytes());
                    data.extend_from_slice(&unb64(part.get("data").and_then(Value::as_str).unwrap_or("")));
                } else {
                    data.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
                    data.extend_from_slice(part.get("value").and_then(Value::as_str).unwrap_or("").as_bytes());
                }
                data.extend_from_slice(b"\r\n");
            }
            data.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
            // multipart always overrides whatever the page guessed
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type"));
            headers.push(("Content-Type".into(), format!("multipart/form-data; boundary={boundary}")));
            data
        }
        _ => Vec::new(),
    }
}
