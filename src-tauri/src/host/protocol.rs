//! The `zalo-app://` scheme: serves `pc-dist` straight out of `app.asar` (the Swift app's `AsarSchemeHandler`) plus
//! the `/__compola/*` transport endpoints.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder};

use super::{Host, Hosts, patches};

fn respond(responder: UriSchemeResponder, status: u16, mime: &str, body: Vec<u8>) {
    let response = http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap();
    responder.respond(response);
}

fn json(responder: UriSchemeResponder, value: &Value) {
    respond(responder, 200, "application/json", serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()));
}

pub fn handle<R: tauri::Runtime>(ctx: UriSchemeContext<'_, R>, request: http::Request<Vec<u8>>, responder: UriSchemeResponder)
where
    AppHandle<R>: Manager<R>,
{
    let label = ctx.webview_label().to_owned();
    let app = ctx.app_handle();
    let Some(hosts) = app.try_state::<Hosts>() else {
        return respond(responder, 503, "text/plain", b"not ready".to_vec());
    };
    let Some(host) = hosts.get(&label) else {
        // A non-host webview (the UI) asking for renderer assets (e.g. stickers/emoji sprites): serve files only.
        if let Some(any) = hosts.0.lock().values().next().cloned() {
            return off_ui_thread(move || serve_file(&any, request.uri().path(), responder));
        }
        return respond(responder, 404, "text/plain", Vec::new());
    };
    off_ui_thread(move || route(host, request, responder));
}

/// WebView2 (Windows) has no custom schemes: every request of the renderer reaches us on the window's UI thread (the
/// one that also draws the app), and wry posts each response back to it. Answering there — synchronous bridge calls,
/// asar reads, script patching — made the whole app stutter under the renderer's traffic. On Windows the work runs on a
/// blocking-pool thread; the UI thread only hands the request over and the response back. WebKit is left as it was.
fn off_ui_thread(work: impl FnOnce() + Send + 'static) {
    if cfg!(windows) {
        tauri::async_runtime::spawn_blocking(work);
    } else {
        work();
    }
}

fn route(host: Arc<Host>, request: http::Request<Vec<u8>>, responder: UriSchemeResponder) {
    let path = percent_decode(request.uri().path());

    if path == "/__compola/blank.html" {
        return respond(responder, 200, "text/html; charset=utf-8", b"<!doctype html><title>compola</title>".to_vec());
    }
    if path == "/__compola/bridge-sync" {
        // Answered synchronously: the page is blocked on this XHR.
        let reply = host.handle_sync_request(request.body());
        return json(responder, &reply);
    }
    if path == "/__compola/reply" {
        host.resolve_reply(request.body());
        return json(responder, &serde_json::json!({}));
    }
    if let Some(handler) = path.strip_prefix("/__compola/msg/") {
        let handler = handler.to_owned();
        let body: Value = serde_json::from_slice(request.body()).unwrap_or(Value::Null);
        let host = host.clone();
        tauri::async_runtime::spawn(async move {
            let reply = host.handle_message(&handler, body).await;
            json(responder, &reply);
        });
        return;
    }
    if let Some(rest) = path.strip_prefix("/__compola/file") {
        // Local file the user picked (composer): `/__compola/file?path=…` → bytes. Read-only.
        let _ = rest;
        let file = request
            .uri()
            .query()
            .and_then(|q| url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "path").map(|(_, v)| v.into_owned()));
        return match file.and_then(|p| std::fs::read(&p).ok().map(|d| (p, d))) {
            Some((p, data)) => respond(responder, 200, &mime_for(&p), data),
            None => respond(responder, 404, "text/plain", Vec::new()),
        };
    }
    serve_file(&host, &path, responder)
}

fn serve_file(host: &Arc<Host>, path: &str, responder: UriSchemeResponder) {
    let path = percent_decode(path);
    let candidates = [format!("pc-dist{path}"), path.trim_start_matches('/').to_owned()];
    let Some(data) = candidates.iter().find_map(|c| host.asar.read(c)) else {
        log::warn!("[{}] 404 {path}", host.label);
        return respond(responder, 404, "text/plain", Vec::new());
    };
    let body = patches::apply(&path, data);
    respond(responder, 200, &mime_for(&path), body);
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn mime_for(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "js" | "jsapi" | "mjs" => "text/javascript; charset=utf-8".into(),
        "wasm" => "application/wasm".into(),
        "json" => "application/json".into(),
        "html" => "text/html; charset=utf-8".into(),
        "css" => "text/css; charset=utf-8".into(),
        _ => mime_guess::from_ext(&ext).first_or_octet_stream().essence_str().to_owned(),
    }
}
