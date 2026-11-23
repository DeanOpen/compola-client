// Compola (Tauri) host script — injected first, before every other host script.
//
// The Swift app talked to the page through WKScriptMessageHandlers
// (`window.webkit.messageHandlers.<name>.postMessage(msg)` → Promise of the reply).
// Tauri owns the WKWebView's message handlers, so the host scripts are rewritten at
// load time to use `window.__compolaMH.<name>.postMessage(msg)` instead, which posts to
// the same-origin `zalo-app://local/__compola/msg/<name>` endpoint served by Rust.
(() => {
  'use strict';
  if (window.__compolaMH) return;
  const nativeFetch = window.fetch.bind(window);
  const base = location.protocol === 'zalo-app:' ? '' : 'zalo-app://local';
  const handler = (name) => ({
    postMessage(msg) {
      let body;
      try { body = JSON.stringify(msg === undefined ? null : msg); } catch (e) { return Promise.reject(String(e)); }
      return nativeFetch(base + '/__compola/msg/' + name, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
        .then((r) => r.json())
        .then((r) => { if (r && r.error != null) throw r.error; return r ? r.value : undefined; });
    },
  });
  const cache = {};
  window.__compolaMH = new Proxy(cache, { get: (t, k) => (typeof k === 'string' ? (t[k] || (t[k] = handler(k))) : undefined) });
  // Results of scripts Rust evaluates (`Host::call_js`).
  window.__compolaReply = (id, out) => {
    nativeFetch(base + '/__compola/reply', { method: 'POST', body: JSON.stringify({ id, out }) }).catch(() => {});
  };
})();
