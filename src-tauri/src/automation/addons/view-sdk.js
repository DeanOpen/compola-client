// Compola view SDK — injected first into every add-on view (src-tauri/src/automation/addons/views.rs).
// The view is a sandboxed iframe with an opaque origin: it talks to Compola only through postMessage with its parent,
// and to its add-on's code through compola.call() → compola.views.handle(name, fn) in main.js.
(function () {
  'use strict';
  if (window.compola) return;
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
    var h = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
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
