// Compola view SDK — injected first into every add-on view (src-tauri/src/automation/addons/views.rs).
// The view is a sandboxed iframe with an opaque origin: it talks to Compola only through postMessage with its parent,
// and to its add-on's code through compola.call() → compola.views.handle(name, fn) in main.js.
(function () {
  'use strict';
  if (window.compola) return;

  // ---- Ways out the CSP cannot close (defence in depth; the CSP and the app's frame-src do the rest) ----
  // WebRTC: ICE / STUN traffic is not covered by connect-src, so a peer connection could carry data out.
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCSctpTransport'].forEach(function (name) {
    try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch (e) { /* already locked */ }
  });
  // A nested frame is a fresh window with its own WebRTC: nested frames are removed the moment they appear (the
  // package's markup has none: views.rs renames those tags). Connection hints are removed too.
  var BLOCKED = 'iframe,frame,frameset,object,embed,portal,fencedframe,link[rel~="dns-prefetch" i],link[rel~="preconnect" i],link[rel~="prefetch" i],link[rel~="prerender" i]';
  var roots = [document];
  function purge() {
    for (var r = 0; r < roots.length; r++) {
      var found = roots[r].querySelectorAll(BLOCKED);
      for (var i = 0; i < found.length; i++) {
        var el = found[i];
        if (el.parentNode) el.parentNode.removeChild(el);
        console.warn('Compola: ' + el.tagName.toLowerCase() + ' không được phép trong giao diện add-on');
      }
    }
  }
  function guard(proto, name) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (!d) return;
    if (typeof d.value === 'function') {
      var fn = d.value;
      // Cheap check first: `window.length` counts nested browsing contexts, so most DOM work costs nothing extra.
      d.value = function () { var out = fn.apply(this, arguments); if (window.length) purge(); return out; };
    } else if (d.set) {
      var set = d.set;
      d.set = function (v) { set.call(this, v); if (window.length) purge(); };
    } else return;
    try { Object.defineProperty(proto, name, d); } catch (e) { /* not configurable */ }
  }
  [[Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']],
   [Element.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren', 'insertAdjacentElement', 'moveBefore', 'insertAdjacentHTML', 'innerHTML', 'outerHTML', 'setHTMLUnsafe']],
   [typeof DocumentFragment !== 'undefined' && DocumentFragment.prototype, ['append', 'prepend', 'replaceChildren']],
   [typeof ShadowRoot !== 'undefined' && ShadowRoot.prototype, ['innerHTML', 'setHTMLUnsafe']],
   [Document.prototype, ['write', 'writeln', 'append', 'prepend', 'replaceChildren', 'execCommand']],
   [typeof Range !== 'undefined' && Range.prototype, ['insertNode', 'surroundContents']],
  ].forEach(function (pair) { (pair[1] || []).forEach(function (n) { guard(pair[0], n); }); });
  var attachShadow = Element.prototype.attachShadow;
  if (attachShadow) {
    Element.prototype.attachShadow = function () { var root = attachShadow.apply(this, arguments); roots.push(root); return root; };
  }
  ['contentWindow', 'contentDocument'].forEach(function (name) {
    [typeof HTMLIFrameElement !== 'undefined' && HTMLIFrameElement.prototype, typeof HTMLFrameElement !== 'undefined' && HTMLFrameElement.prototype,
     typeof HTMLObjectElement !== 'undefined' && HTMLObjectElement.prototype, typeof HTMLEmbedElement !== 'undefined' && HTMLEmbedElement.prototype].forEach(function (proto) {
      if (proto && Object.getOwnPropertyDescriptor(proto, name)) {
        try { Object.defineProperty(proto, name, { get: function () { return null; }, configurable: false }); } catch (e) { /* ignore */ }
      }
    });
  });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(purge).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['rel'] });
  }
  var parentWin = window.parent;
  var pending = new Map();
  var listeners = Object.create(null);
  var seq = 0;
  var context = null;
  var readyFns = [];

  function send(msg) {
    msg.__compola = 1;
    parentWin.postMessage(msg, '*');
  }
  function request(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      send({ type: type, id: id, payload: payload === undefined ? null : payload });
    });
  }
  function emit(name, data) {
    (listeners[name] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { console.error(e); }
    });
  }
  function applyTheme(ctx) {
    if (ctx && ctx.theme) document.documentElement.setAttribute('data-theme', ctx.theme);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var m = e.data;
    if (!m || m.__compola !== 1) return;
    if (m.type === 'reply') {
      var p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error || 'lỗi'));
    } else if (m.type === 'context') {
      var first = !context;
      context = m.context || {};
      applyTheme(context);
      if (first) readyFns.splice(0).forEach(function (fn) { try { fn(context); } catch (err) { console.error(err); } });
      emit('context', context);
    } else if (m.type === 'message') {
      emit(m.name, m.data);
    }
  });

  // Inline views (inspector, composer, settings) grow with their content.
  var lastHeight = 0;
  function reportHeight() {
    // The content's own height (the <html> box), not scrollHeight: that is never less than the frame, so a view that
    // started tall could never shrink to fit.
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h && Math.abs(h - lastHeight) > 1) {
      lastHeight = h;
      send({ type: 'resize', payload: { height: h } });
    }
  }
  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(reportHeight);
    document.addEventListener('DOMContentLoaded', function () { ro.observe(document.documentElement); if (document.body) ro.observe(document.body); reportHeight(); });
  } else {
    setInterval(reportHeight, 500);
  }
  // Browsers pause rendering work (ResizeObserver included) in frames that are off screen, such as a view further
  // down the info panel: DOM changes still report, so it already has the right height when it scrolls into view.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(reportHeight).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  }
  window.addEventListener('load', reportHeight);

  window.compola = {
    /** {addonId, viewId, location, account, conversationId, conversationName, isGroup, theme, user, params} */
    get context() { return context; },
    /** Runs fn once the context arrived (immediately if it already did). */
    ready: function (fn) { if (context) fn(context); else readyFns.push(fn); },
    /** Calls the add-on: compola.views.handle(name, (data, ctx) => result) in its main.js. */
    call: function (name, data) { return request('call', { name: String(name), data: data === undefined ? null : data }); },
    /** 'context' (conversation / theme changed) or a name the add-on posts with compola.views.post(name, data). */
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); }; },
    toast: function (text, level) { return request('toast', { text: String(text), level: level || 'info' }); },
    /** Puts text in the message box of the conversation on screen (not sent). */
    insertText: function (text) { return request('insertText', { text: String(text) }); },
    openConversation: function (conversationId) { return request('openConversation', { conversationId: String(conversationId) }); },
    /** Opens another view of this add-on as a modal (`location: modal`). */
    openView: function (viewId, params) { return request('openView', { viewId: String(viewId), params: params || null }); },
    resize: function (height) { send({ type: 'resize', payload: { height: Number(height) || 0 } }); },
    /** Closes a modal view (optionally returning a value to whoever opened it). */
    close: function (result) { send({ type: 'close', payload: result === undefined ? null : result }); },
  };

  send({ type: 'hello' });
})();
