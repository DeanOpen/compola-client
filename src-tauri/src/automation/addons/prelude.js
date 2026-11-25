// Compola add-on runtime prelude (QuickJS, one runtime per add-on: src-tauri/src/automation/addons/runtime.rs).
// Natives: __n_post(kind, json) fire-and-forget · __n_call(id, method, json) → bool · __n_timer(id, ms, repeat) ·
// __n_clear(id) · __n_read(path) → string | null. The host calls __in(json) for everything it delivers.
'use strict';
(function () {
  const g = globalThis;
  const post = (kind, data) => __n_post(kind, JSON.stringify(data === undefined ? null : data));
  // QuickJS's `stack` holds only the frames: the message goes first.
  const errText = (e) => (e instanceof Error ? String(e) + (e.stack ? '\n' + e.stack : '') : String(e));
  const text = (parts) => parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? errText(p) : safeJson(p))).join(' ');
  const safeJson = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };

  // ---- RPC to the host (every async compola.* call) ----
  const pending = new Map();
  let seq = 0;
  const rpc = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    if (!__n_call(id, method, JSON.stringify(args))) return reject(new Error('quá nhiều yêu cầu đang chờ (tối đa 256)'));
    pending.set(id, { resolve, reject, method });
  });

  // ---- events ----
  const handlers = Object.create(null);
  const subscribe = () => post('subscribe', Object.keys(handlers).filter((k) => handlers[k].length));
  const emit = async (name, data) => {
    const list = handlers[name] || [];
    for (const fn of list.slice()) {
      try { await fn(data); } catch (e) { post('log', { level: 'error', text: 'lỗi trong "' + name + '": ' + errText(e) }); }
    }
  };

  // ---- timers (the host owns the clock) ----
  const timers = new Map();
  let timerSeq = 0;
  const addTimer = (fn, ms, args, repeat) => {
    if (typeof fn !== 'function') throw new TypeError('callback must be a function');
    const id = ++timerSeq;
    timers.set(id, { fn, args, repeat });
    __n_timer(id, Math.max(0, Number(ms) || 0), !!repeat);
    return id;
  };
  const clearTimer = (id) => { if (timers.delete(id)) __n_clear(id); };
  g.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
  g.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
  g.clearTimeout = clearTimer;
  g.clearInterval = clearTimer;
  g.queueMicrotask = (fn) => { Promise.resolve().then(fn); };

  const logger = (level) => (...parts) => post('log', { level, text: text(parts) });
  g.console = { log: logger('info'), info: logger('info'), debug: logger('debug'), warn: logger('warn'), error: logger('error') };

  // ---- modules inside the package (CommonJS) ----
  const modules = new Map();
  const normalize = (base, path) => {
    const out = [];
    for (const part of (path.startsWith('/') ? path : base + '/' + path).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!out.length) throw new Error('require: đường dẫn ra ngoài add-on: ' + path); out.pop(); } else out.push(part);
    }
    return out.join('/');
  };
  const makeRequire = (base) => (path) => {
    if (typeof path !== 'string' || !(path.startsWith('./') || path.startsWith('../') || path.startsWith('/'))) throw new Error('require: chỉ nạp được tệp trong add-on ("./x.js")');
    let file = normalize(base, path);
    let src = __n_read(file);
    if (src == null && !/\.(js|json)$/.test(file)) { file += '.js'; src = __n_read(file); }
    if (src == null) throw new Error('require: không tìm thấy ' + path);
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    if (file.endsWith('.json')) module.exports = JSON.parse(src);
    else new Function('module', 'exports', 'require', src + '\n//# sourceURL=' + file)(module, module.exports, makeRequire(file.split('/').slice(0, -1).join('/')));
    return module.exports;
  };
  g.require = makeRequire('');

  // ---- fetch (permission `network`, hosts in the manifest) ----
  const makeResponse = (r) => ({
    ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText || '', url: r.url,
    headers: { get: (k) => r.headers[String(k).toLowerCase()] ?? null, entries: () => Object.entries(r.headers) },
    text: async () => r.body, json: async () => JSON.parse(r.body),
  });
  const doFetch = async (url, init = {}) => {
    let body = init.body;
    if (body != null && typeof body !== 'string') body = JSON.stringify(body);
    const r = await rpc('fetch', String(url), { method: init.method || 'GET', headers: init.headers || {}, body: body ?? null, timeoutMs: init.timeoutMs || 30000 });
    return makeResponse(r);
  };

  let storage = {};
  const tools = new Map();
  const viewHandlers = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const compola = {
    manifest: null,
    settings: {},
    /** The add-on's id (also its folder name). */
    get id() { return compola.manifest && compola.manifest.id; },
    on(name, fn) {
      if (typeof fn !== 'function') throw new TypeError('compola.on(name, fn): fn must be a function');
      (handlers[name] = handlers[name] || []).push(fn);
      subscribe();
      return () => compola.off(name, fn);
    },
    off(name, fn) {
      handlers[name] = (handlers[name] || []).filter((f) => f !== fn);
      subscribe();
    },
    log: logger('info'),
    warn: logger('warn'),
    error: logger('error'),

    // messages
    sendText: (conversationId, text, opts = {}) => rpc('sendText', String(conversationId), String(text), opts),
    conversations: (opts = {}) => rpc('conversations', opts),
    messages: (conversationId = null, limit = 50, opts = {}) => rpc('messages', conversationId, limit, opts),
    history: (conversationId, opts = {}) => rpc('history', String(conversationId), opts),
    /** Conversations with messages since `opts.since` (default: 24 h ago), newest first: [{id, name, isGroup, count, lastDate, account}]. */
    activeConversations: (opts = {}) => rpc('activeConversations', opts),
    search: (query, opts = {}) => rpc('search', String(query), opts),
    accounts: () => rpc('accounts'),

    notify: (title, body = '') => rpc('notify', String(title), String(body)),

    // conversation notes (comments) people see in the chat's inspector
    notes: {
      list: (conversationId, opts = {}) => rpc('notesList', String(conversationId), opts),
      add: (conversationId, text, opts = {}) => rpc('notesAdd', String(conversationId), String(text), opts),
      update: (id, patch) => rpc('notesUpdate', String(id), patch || {}),
      remove: (id) => rpc('notesRemove', String(id)),
    },

    // what people see in the app
    ui: {
      /** A reply suggestion above the composer of a conversation (the person sends it, edits it or dismisses it). */
      suggest: (conversationId, text, opts = {}) => rpc('suggest', String(conversationId), String(text), opts),
      clearSuggestions: (conversationId, opts = {}) => rpc('clearSuggestions', String(conversationId), opts),
      /** A panel in the conversation's inspector (conversationId null: every conversation). blocks: see docs/addons.md. */
      panel: (conversationId, panel) => rpc('panel', conversationId == null ? null : String(conversationId), panel ?? null),
      toast: (text, opts = {}) => rpc('toast', String(text), opts),
      /** Opens one of the add-on's views: a `modal` view as a dialog, a `tab` view as its page. opts: {conversationId?, account?, params?} */
      openView: (viewId, opts = {}) => rpc('openView', String(viewId), opts),
    },
    quickReplies: {
      /** Replaces this add-on's quick replies: [{shortcut, title?, text}]. */
      set: (list) => rpc('quickRepliesSet', Array.isArray(list) ? list : []),
    },
    /** The add-on's HTML views (manifest `contributes.views`). */
    views: {
      /** Answers `compola.call(name, data)` from a view: fn(data, context) → result. */
      handle(name, fn) {
        if (typeof fn !== 'function') throw new TypeError('views.handle(name, fn): fn must be a function');
        viewHandlers.set(String(name), fn);
      },
      /** Sends `name`/`data` to this add-on's open views (`compola.on(name, fn)` in the view); opts: {viewId?, conversationId?, account?}. */
      post: (name, data, opts = {}) => rpc('viewPost', String(name), data === undefined ? null : data, opts),
    },
    actions: {
      /** Replaces the actions added at runtime (the manifest's `contributes.actions` stay). */
      set: (list) => rpc('actionsSet', Array.isArray(list) ? list : []),
    },

    ai: {
      available: () => rpc('aiAvailable'),
      /** {system?, prompt? | messages?:[{role, content}], maxTokens?, effort?, json?} → {text, model, usage} */
      complete: (req) => rpc('aiComplete', typeof req === 'string' ? { prompt: req } : req || {}),
    },

    http: { fetch: doFetch },

    /** Signing in to a service through the browser (OAuth 2 with PKCE; permission `network`). */
    auth: {
      /** A one-time local address the service redirects back to: {id, redirectUri} (http://127.0.0.1:<port>/callback). */
      loopback: () => rpc('authLoopback'),
      /** Asks the person, opens `url` (a host the add-on may reach) in the browser, waits for the redirect: {params}. */
      browser: (id, url) => rpc('authBrowser', String(id), String(url)),
    },
    crypto: {
      /** `bytes` random bytes, base64url (a PKCE verifier, a state). */
      randomString: (bytes = 32) => rpc('cryptoRandom', bytes),
      /** SHA-256 of a string: 'hex' (default) or 'base64url' (a PKCE challenge). */
      sha256: (text, encoding = 'hex') => rpc('cryptoSha256', String(text), encoding),
    },

    storage: {
      get: (key) => clone(storage[key]),
      all: () => clone(storage),
      set: (key, value) => {
        key = String(key);
        if (value === undefined || value === null) delete storage[key]; else storage[key] = clone(value);
        return rpc('storageSet', key, value ?? null);
      },
      remove: (key) => compola.storage.set(key, null),
    },
    /** Text files shipped in the package (prompts, knowledge base…). */
    assets: { read: (path) => { const s = __n_read(normalize('', String(path))); if (s == null) throw new Error('không tìm thấy ' + path); return s; } },

    schedules: {
      list: () => rpc('schedulesList'),
      save: (job) => rpc('scheduleSave', job),
      remove: (id) => rpc('scheduleRemove', id),
      runNow: (id) => rpc('scheduleRun', id),
    },
    mcp: {
      servers: () => rpc('mcpServers'),
      tools: (serverId) => rpc('mcpTools', serverId),
      call: (serverId, tool, args = {}) => rpc('mcpCall', serverId, tool, args),
    },
    tools: {
      register(def, handler) {
        if (!def || !def.name || typeof handler !== 'function') throw new Error('tools.register(def, handler): def.name and handler are required');
        tools.set(def.name, { def, handler });
        post('tools', [...tools.values()].map((t) => t.def));
      },
    },
  };
  g.compola = compola;
  if (!g.fetch) g.fetch = doFetch;

  // ---- what the host delivers ----
  g.__in = (json) => {
    const m = JSON.parse(json);
    switch (m.t) {
      case 'init':
        compola.manifest = m.manifest;
        compola.settings = m.settings || {};
        storage = m.storage || {};
        if (!(m.manifest.permissions || []).includes('network')) { delete g.fetch; compola.http.fetch = () => Promise.reject(new Error('add-on chưa khai báo quyền "network"')); }
        return;
      case 'reply': {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
        return;
      }
      case 'timer': {
        const t = timers.get(m.id);
        if (!t) return;
        if (!t.repeat) timers.delete(m.id);
        try { const r = t.fn(...(t.args || [])); if (r && typeof r.catch === 'function') r.catch((e) => post('log', { level: 'error', text: 'lỗi trong timer: ' + errText(e) })); }
        catch (e) { post('log', { level: 'error', text: 'lỗi trong timer: ' + errText(e) }); }
        return;
      }
      case 'settings':
        compola.settings = m.settings || {};
        emit('settings', compola.settings);
        return;
      case 'event':
        emit(m.name, m.data);
        return;
      case 'viewCall': {
        const h = viewHandlers.get(m.name);
        Promise.resolve()
          .then(() => { if (!h) throw new Error('add-on không xử lý "' + m.name + '" (compola.views.handle)'); return h(m.data, m.context || {}); })
          .then((result) => post('viewResult', { requestId: m.requestId, ok: true, result: result === undefined ? null : result }),
                (e) => post('viewResult', { requestId: m.requestId, ok: false, result: String((e && e.message) || e) }));
        return;
      }
      case 'toolCall': {
        const t = tools.get(m.tool);
        Promise.resolve()
          .then(() => { if (!t) throw new Error('unknown tool ' + m.tool); return t.handler(m.args || {}); })
          .then((result) => post('toolResult', { requestId: m.requestId, ok: true, result: result === undefined ? null : result }),
                (e) => post('toolResult', { requestId: m.requestId, ok: false, result: String((e && e.message) || e) }));
        return;
      }
    }
  };
})();
