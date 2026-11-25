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
  // Same-origin pages post relative; about:blank / blob children post to the renderer's origin (`https://zalo-app.<host>`
  // on Windows, where WebView2 has no custom schemes).
  const origin = window.__compolaOrigin || 'zalo-app://local';
  const base = location.protocol === 'zalo-app:' || location.origin === origin ? '' : origin;
  window.__compolaSyncUrl = (location.protocol === 'zalo-app:' ? 'zalo-app://local' : origin) + '/__compola/bridge-sync';
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

// Files Rust picked for the next file input (`engine_call_with_files`; Swift answered the hidden input's open panel through
// WKUIDelegate). While `__compolaPendingFiles` is set, a file input's click() takes exactly those `File`s instead of opening a
// panel; without it the page never shows its own file dialog.
(() => {
  if (window.__compolaFileInputPatched) return; window.__compolaFileInputPatched = true;
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type !== 'file') return click.call(this);
    const files = window.__compolaPendingFiles; window.__compolaPendingFiles = null;
    const input = this;
    setTimeout(() => {
      if (!files || !files.length) { input.dispatchEvent(new Event('cancel')); return; }
      const dt = new DataTransfer();
      for (const f of (input.multiple ? files : files.slice(0, 1))) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  // Loads local files (served read-only by `/__compola/file`) as browser Files.
  window.__compolaLoadFiles = (paths) => Promise.all(paths.map(async (p) => {
    const r = await fetch('/__compola/file?path=' + encodeURIComponent(p));
    if (!r.ok) throw new Error('ENOENT: ' + p);
    const blob = await r.blob();
    return new File([blob], p.split('/').pop(), { type: blob.type, lastModified: Date.now() });
  }));
})();
