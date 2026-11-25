//! Assembles the document-start script injected into every frame of a host webview (the Swift app's
//! `WKUserScript` list, same order).

use crate::bridge::Registry;

macro_rules! host_script {
    ($name:literal) => {
        ($name, include_str!(concat!("../../host-scripts/", $name, ".js")))
    };
}

/// In injection order. `bridge-spec` is generated and goes between `network-shim` and `local-modules`.
const BEFORE_SPEC: &[(&str, &str)] = &[host_script!("webkit-shim"), host_script!("console"), host_script!("network-shim")];
const AFTER_SPEC: &[(&str, &str)] = &[
    host_script!("local-modules"),
    host_script!("bridge"),
    host_script!("sqlite-host"),
    host_script!("state-adapter"),
    host_script!("chat-adapter"),
    host_script!("media-store-adapter"),
    host_script!("card-actions-adapter"),
    host_script!("sticker-adapter"),
    host_script!("composer-adapter"),
    host_script!("message-actions-adapter"),
    host_script!("transfer-adapter"),
    host_script!("conversations-adapter"),
    host_script!("conversation-actions-adapter"),
    host_script!("contacts-adapter"),
    host_script!("group-create-adapter"),
    host_script!("notification-adapter"),
    host_script!("zcloud-adapter"),
    host_script!("poll-adapter"),
    host_script!("call-adapter"),
];

/// WKScriptMessageHandler calls → the `__compolaMH` transport of `webkit-shim.js`.
pub fn rewrite(source: &str) -> String {
    source
        .replace("window.webkit.messageHandlers.", "window.__compolaMH.")
        .replace("webkit.messageHandlers.", "window.__compolaMH.")
}

fn wrap(name: &str, source: &str) -> String {
    // Each script runs in its own try so one failing adapter cannot take the bridge down.
    let tag = if cfg!(debug_assertions) { format!("\n//# sourceURL=compola-{name}.js") } else { String::new() };
    format!("try {{\n{}\n}} catch (e) {{ try {{ window.__compolaMH.zlog.postMessage('[host-script] {name} failed: ' + e); }} catch {{}} }}{tag}\n", rewrite(source))
}

/// `page_origin`: the renderer pages' `location.origin` (`zalo-app://local`, or `https://zalo-app.local` on Windows).
pub fn compose(registry: &Registry, page_origin: &str) -> String {
    let mut out = String::with_capacity(1 << 20);
    let origin = serde_json::to_string(page_origin).unwrap_or_else(|_| "\"\"".into());
    // Only zalo-app documents (and their about:blank/srcdoc children) get the host; Tauri's own pages do not.
    // WebKit reports `zalo-app:` as the protocol; on Windows the pages are plain https at the page origin.
    out.push_str(&format!(
        "if ((() => {{ const own = (l) => l.protocol === 'zalo-app:' || l.origin === {origin}; return own(location) || ((location.protocol === 'about:' || location.protocol === 'blob:') && (() => {{ try {{ return window.parent !== window && own(window.parent.location); }} catch {{ return false; }} }})()); }})()) {{\nwindow.__compolaOrigin = {origin};\n"
    ));
    if std::env::var_os("COMPOLA_TRACE_WORKERS").is_some() {
        out.push_str("window.__zaloTraceWorkers = true;\n");
    }
    for (name, src) in BEFORE_SPEC {
        out.push_str(&wrap(name, src));
    }
    out.push_str(&registry.spec_script());
    out.push('\n');
    for (name, src) in AFTER_SPEC {
        out.push_str(&wrap(name, src));
    }
    out.push_str("}\n");
    out
}
