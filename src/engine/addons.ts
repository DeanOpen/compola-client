// Add-on runtime: each enabled add-on (src-tauri/src/automation/addons.rs) runs in its own Web Worker with a global
// `compola` API (WORKER_PRELUDE). A worker has no access to Tauri, the DOM or the official renderer: everything goes
// through the RPCs below, which check the permissions the add-on's manifest declares. Without the `network` permission
// fetch / XMLHttpRequest / WebSocket / importScripts are removed from the worker (a best effort, not a security
// boundary — install only add-ons you trust).
//
// Events delivered to add-ons (`compola.on(name, fn)`):
//   ready     after the script ran
//   message   {id, conversationId, conversationName, isGroup, senderName, fromMe, text, date} — any conversation
//   schedule  payload of one of the add-on's schedules that fired
//   settings  the user changed the add-on's settings (`compola.settings` already updated)

import { create } from 'zustand';
import { backend, usesTauri } from './backend';
import { messageSearch } from './search';
import { addonSettings, automation, refreshAutomation, useAutomation, type Addon, type Job } from './automation';

const WORKER_PRELUDE = String.raw`
'use strict';
const __pending = new Map();
let __seq = 0;
const __post = (m) => self.postMessage(m);
const __rpc = (method, ...args) => new Promise((resolve, reject) => {
  const id = ++__seq;
  __pending.set(id, { resolve, reject });
  __post({ type: 'rpc', id, method, args });
});
const __handlers = Object.create(null);
const __tools = new Map();
let __storage = {};
const __emit = async (name, data) => {
  for (const fn of __handlers[name] || []) {
    try { await fn(data); } catch (e) { compola.log('lỗi trong "' + name + '": ' + ((e && e.stack) || e)); }
  }
};
const compola = {
  manifest: null,
  settings: {},
  on(name, fn) { (__handlers[name] = __handlers[name] || []).push(fn); },
  log: (...parts) => __post({ type: 'log', text: parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') }),
  sendText: (conversationId, text) => __rpc('sendText', String(conversationId), String(text)),
  conversations: (opts = {}) => __rpc('conversations', opts.query ?? null, opts.limit ?? 50),
  messages: (conversationId = null, limit = 50) => __rpc('messages', conversationId, limit),
  search: (query, opts = {}) => __rpc('search', String(query), opts.conversationId ?? null, opts.limit ?? 10, opts.context ?? 2),
  notify: (title, body = '') => __rpc('notify', String(title), String(body)),
  storage: {
    get: (key) => (key in __storage ? JSON.parse(JSON.stringify(__storage[key])) : undefined),
    all: () => JSON.parse(JSON.stringify(__storage)),
    set: (key, value) => {
      if (value === undefined || value === null) delete __storage[key]; else __storage[key] = JSON.parse(JSON.stringify(value));
      return __rpc('storageSet', String(key), value ?? null);
    },
  },
  schedules: {
    list: () => __rpc('schedulesList'),
    save: (job) => __rpc('scheduleSave', job),
    remove: (id) => __rpc('scheduleRemove', id),
    runNow: (id) => __rpc('scheduleRun', id),
  },
  mcp: {
    servers: () => __rpc('mcpServers'),
    tools: (serverId) => __rpc('mcpTools', serverId),
    call: (serverId, tool, args = {}) => __rpc('mcpCall', serverId, tool, args),
  },
  tools: {
    register(def, handler) {
      if (!def || !def.name || typeof handler !== 'function') throw new Error('tools.register(def, handler): def.name and handler are required');
      __tools.set(def.name, { def, handler });
      __post({ type: 'tools', tools: [...__tools.values()].map((t) => t.def) });
    },
  },
};
self.compola = compola;
self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'rpcResult') {
    const p = __pending.get(m.id);
    if (!p) return;
    __pending.delete(m.id);
    if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
  } else if (m.type === 'init') {
    compola.manifest = m.manifest;
    compola.settings = m.settings || {};
    __storage = m.storage || {};
    if (!(m.manifest.permissions || []).includes('network')) {
      for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
        try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch {}
      }
    }
    try { __addonMain(); } catch (err) { compola.log('lỗi khi chạy: ' + ((err && err.stack) || err)); }
    await __emit('ready');
  } else if (m.type === 'settings') {
    compola.settings = m.settings || {};
    await __emit('settings', compola.settings);
  } else if (m.type === 'event') {
    await __emit(m.name, m.data);
  } else if (m.type === 'toolCall') {
    const t = __tools.get(m.tool);
    try {
      if (!t) throw new Error('unknown tool ' + m.tool);
      const result = await t.handler(m.args || {});
      __post({ type: 'toolResult', requestId: m.requestId, ok: true, result: result === undefined ? null : result });
    } catch (err) {
      __post({ type: 'toolResult', requestId: m.requestId, ok: false, result: String((err && err.message) || err) });
    }
  }
};
`;

interface Running {
  id: string;
  worker: Worker;
  url: string;
  source: string;
  permissions: Set<string>;
  settingsKey: string;
}

export interface AddonLogLine {
  at: number;
  text: string;
}

/** The latest lines each add-on logged (newest last), for the Add-on settings page. */
export const useAddonLogs = create<Record<string, AddonLogLine[]>>()(() => ({}));

const addLog = (id: string, text: string) => {
  if (import.meta.env.DEV) console.debug(`[addon ${id}]`, text);
  useAddonLogs.setState((s) => ({ ...s, [id]: [...(s[id] ?? []), { at: Date.now(), text: text.slice(0, 1000) }].slice(-100) }));
};

const running = new Map<string, Running>();

const ownJobs = (id: string, jobs: Job[]) => jobs.filter((j) => j.action.kind === 'addon' && j.action.addonId === id);

const need = (r: Running, permission: string) => {
  if (!r.permissions.has(permission)) throw new Error(`add-on chưa khai báo quyền "${permission}"`);
};

const notify = async (title: string, body: string) => {
  const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification');
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  if (granted) sendNotification({ title, body });
};

const rpc = async (r: Running, method: string, args: unknown[]): Promise<unknown> => {
  const [a, b, c] = args;
  switch (method) {
    case 'sendText':
      need(r, 'messages:send');
      return automation.sendText(String(a), String(b));
    case 'conversations':
      need(r, 'messages:read');
      return automation.conversations((a as string | null) ?? undefined, Number(b) || 50);
    case 'messages':
      need(r, 'messages:read');
      return automation.messages((a as string | null) ?? null, Number(b) || 50);
    case 'search':
      need(r, 'messages:read');
      return messageSearch.search(String(a), { conversationId: (b as string | null) ?? null, limit: Number(c) || 10, context: Number(args[3]) || 0 });
    case 'notify':
      need(r, 'notifications');
      return notify(String(a), String(b ?? ''));
    case 'storageSet':
      return automation.setAddonStorage(r.id, String(a), b);
    case 'schedulesList': {
      need(r, 'schedules');
      return ownJobs(r.id, (await automation.state()).jobs);
    }
    case 'scheduleSave': {
      need(r, 'schedules');
      const spec = (a ?? {}) as { id?: string; name?: string; cron?: string; at?: number | string; payload?: unknown; enabled?: boolean };
      if (spec.id && !ownJobs(r.id, (await automation.state()).jobs).some((j) => j.id === spec.id)) throw new Error('không phải lịch của add-on này');
      const at = typeof spec.at === 'string' ? Date.parse(spec.at) : spec.at;
      if (!spec.cron && !(typeof at === 'number' && Number.isFinite(at))) throw new Error('cần `cron` hoặc `at`');
      return automation.saveJob({
        id: spec.id ?? '',
        name: spec.name ?? '',
        enabled: spec.enabled ?? true,
        schedule: spec.cron ? { kind: 'cron', expr: spec.cron } : { kind: 'once', at: at as number },
        action: { kind: 'addon', addonId: r.id, payload: spec.payload ?? null },
        createdBy: `addon:${r.id}`,
        lastRun: null,
        lastStatus: null,
        lastOk: null,
      });
    }
    case 'scheduleRemove':
    case 'scheduleRun': {
      need(r, 'schedules');
      if (!ownJobs(r.id, (await automation.state()).jobs).some((j) => j.id === a)) throw new Error('không phải lịch của add-on này');
      return method === 'scheduleRemove' ? automation.deleteJob(String(a)) : automation.runJob(String(a));
    }
    case 'mcpServers':
      need(r, 'mcp');
      return (await automation.state()).clients.filter((x) => x.enabled).map((x) => ({ id: x.id, name: x.name, transport: x.transport }));
    case 'mcpTools':
      need(r, 'mcp');
      return (await automation.clientTools(String(a))).tools;
    case 'mcpCall':
      need(r, 'mcp');
      return automation.clientCall(String(a), String(b), c ?? {});
    default:
      throw new Error(`unknown API ${method}`);
  }
};

const start = (addon: Addon) => {
  const id = addon.manifest.id;
  // The add-on's code runs inside a function so its top-level declarations stay its own.
  const blob = new Blob([WORKER_PRELUDE, '\nfunction __addonMain() {\n', addon.source, '\n}\n'], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { name: `addon:${id}` });
  const settings = addonSettings(addon);
  const r: Running = { id, worker, url, source: addon.source, permissions: new Set(addon.manifest.permissions), settingsKey: JSON.stringify(settings) };
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data ?? {};
    if (m.type === 'log') addLog(id, String(m.text));
    else if (m.type === 'tools') void automation.registerAddonTools(id, Array.isArray(m.tools) ? m.tools : []).catch(() => {});
    else if (m.type === 'toolResult') void automation.addonToolReply(String(m.requestId), !!m.ok, m.result).catch(() => {});
    else if (m.type === 'rpc')
      rpc(r, String(m.method), Array.isArray(m.args) ? m.args : []).then(
        (value) => worker.postMessage({ type: 'rpcResult', id: m.id, ok: true, value: value ?? null }),
        (err: unknown) => worker.postMessage({ type: 'rpcResult', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
  };
  worker.onerror = (e) => addLog(id, `lỗi: ${e.message}`);
  worker.postMessage({ type: 'init', manifest: addon.manifest, settings, storage: addon.storage });
  running.set(id, r);
  addLog(id, 'đã khởi động');
};

const stop = (id: string) => {
  const r = running.get(id);
  if (!r) return;
  r.worker.terminate();
  URL.revokeObjectURL(r.url);
  running.delete(id);
  void automation.registerAddonTools(id, []).catch(() => {});
  addLog(id, 'đã dừng');
};

/** Starts, restarts (new code), updates (new settings) or stops workers to match the stored add-ons. */
const sync = () => {
  const state = useAutomation.getState().state;
  if (!state) return;
  const wanted = new Map(state.addons.filter((a) => a.enabled).map((a) => [a.manifest.id, a]));
  for (const id of [...running.keys()]) if (!wanted.has(id)) stop(id);
  for (const [id, addon] of wanted) {
    const r = running.get(id);
    const permissions = [...new Set(addon.manifest.permissions)].sort().join(',');
    if (r && (r.source !== addon.source || [...r.permissions].sort().join(',') !== permissions)) stop(id);
    const current = running.get(id);
    if (!current) {
      try {
        start(addon);
      } catch (e) {
        addLog(id, `không khởi động được: ${String(e)}`);
      }
      continue;
    }
    const settings = addonSettings(addon);
    const key = JSON.stringify(settings);
    if (key !== current.settingsKey) {
      current.settingsKey = key;
      current.worker.postMessage({ type: 'settings', settings });
    }
  }
};

const deliver = (id: string, message: unknown) => running.get(id)?.worker.postMessage(message);

let started = false;

export const startAddonRuntime = async () => {
  if (started || !usesTauri) return;
  started = true;
  useAutomation.subscribe(sync);
  const b = await backend();
  await b.listen('compola://automation', (payload) => {
    const e = (payload ?? {}) as { kind?: string; [k: string]: unknown };
    switch (e.kind) {
      case 'changed':
        void refreshAutomation();
        break;
      case 'message':
        for (const r of running.values()) if (r.permissions.has('messages:read')) r.worker.postMessage({ type: 'event', name: 'message', data: e.message });
        break;
      case 'schedule':
        deliver(String(e.addonId), { type: 'event', name: 'schedule', data: e.payload });
        break;
      case 'toolCall':
        if (running.has(String(e.addonId))) deliver(String(e.addonId), { type: 'toolCall', requestId: e.requestId, tool: e.tool, args: e.arguments });
        else void automation.addonToolReply(String(e.requestId), false, 'add-on không chạy');
        break;
    }
  });
  await refreshAutomation();
};
