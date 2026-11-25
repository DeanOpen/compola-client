// The real built-in add-ons (src-tauri/addons/*) running in the browser preview (`?mock=1`). Each one runs in its own
// Web Worker with the real runtime prelude (src-tauri/src/automation/addons/prelude.js): the worker implements the
// prelude's natives (__n_post, __n_call, __n_timer, __n_clear, __n_read) the way runtime.rs does, and this file answers
// the API calls from the mock data, like host.rs does from the real account. Their HTML views are assembled the way
// views.rs does it. AI answers are canned (no network in the preview).

import prelude from '../../../../src-tauri/src/automation/addons/prelude.js?raw';
import { conversations as mockConversations, historyFor, ME, SELF_CONV } from '../mockData';

const raw = import.meta.glob('../../../../src-tauri/addons/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface BuiltinPackage {
  id: string;
  manifest: Record<string, unknown> & {
    id: string;
    name: string;
    permissions: string[];
    settings?: { key: string; type?: string; default?: unknown }[];
    contributes?: { views?: ViewDecl[]; actions?: Record<string, unknown>[] };
  };
  files: Record<string, string>;
}

export interface ViewDecl {
  id: string;
  title: string;
  location: 'tab' | 'inspector' | 'composer' | 'settings' | 'modal';
  entry: string;
  icon?: string;
  height?: number;
  width?: number;
}

export const builtinPackages: BuiltinPackage[] = (() => {
  const byId = new Map<string, Record<string, string>>();
  for (const [path, text] of Object.entries(raw)) {
    const m = /src-tauri\/addons\/([^/]+)\/(.+)$/.exec(path);
    if (!m) continue;
    const files = byId.get(m[1]) ?? {};
    files[m[2]] = text;
    byId.set(m[1], files);
  }
  const out: BuiltinPackage[] = [];
  for (const [id, files] of byId) {
    try {
      out.push({ id, manifest: JSON.parse(files['manifest.json']), files });
    } catch {
      // A package being written: skip it.
    }
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
})();

// ---- the worker: prelude + main.js, natives over postMessage ----

const WORKER = `
const realSetTimeout = setTimeout, realSetInterval = setInterval, realClear = clearTimeout, realClearInterval = clearInterval;
let files = {};
const timers = new Map();
self.__n_post = (kind, json) => { self.postMessage({ k: 'post', kind, data: JSON.parse(json) }); };
self.__n_call = (id, method, json) => { self.postMessage({ k: 'call', id, method, args: JSON.parse(json) }); return true; };
self.__n_timer = (id, ms, repeat) => {
  const fire = () => self.__in(JSON.stringify({ t: 'timer', id }));
  timers.set(id, repeat ? realSetInterval(fire, Math.max(ms, 1)) : realSetTimeout(() => { timers.delete(id); fire(); }, ms));
};
self.__n_clear = (id) => { const t = timers.get(id); if (t !== undefined) { realClear(t); realClearInterval(t); timers.delete(id); } };
self.__n_read = (path) => (Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null);
self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'boot') {
    files = m.files;
    try {
      (0, eval)(m.prelude);
      self.__in(JSON.stringify({ t: 'init', manifest: m.manifest, settings: m.settings, storage: {} }));
      (0, eval)(m.main + '\\n//# sourceURL=' + m.manifest.id + '/' + (m.manifest.main || 'main.js'));
      self.__in(JSON.stringify({ t: 'event', name: 'ready', data: null }));
    } catch (err) {
      self.postMessage({ k: 'post', kind: 'log', data: { level: 'error', text: 'khởi động: ' + (err && err.stack || err) } });
    }
    return;
  }
  self.__in(JSON.stringify(m));
};
`;

export interface HostHooks {
  addNote: (addonId: string, addonName: string, conversationId: string, text: string, opts: Record<string, unknown>) => unknown;
  listNotes: (addonId: string, conversationId: string) => unknown[];
  updateNote: (addonId: string, id: string, patch: Record<string, unknown>) => unknown;
  removeNote: (addonId: string, id: string) => void;
  setPanel: (addonId: string, addonName: string, conversationId: string | null, panel: Record<string, unknown> | null) => void;
  emit: (payload: Record<string, unknown>) => void;
}

interface Running {
  pkg: BuiltinPackage;
  worker: Worker;
  storage: Record<string, unknown>;
  viewCalls: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  actions: Record<string, unknown>[];
}

const defaults = (pkg: BuiltinPackage) => {
  const out: Record<string, unknown> = {};
  for (const s of pkg.manifest.settings ?? []) out[s.key] = s.default ?? (s.type === 'boolean' ? false : s.type === 'conversations' ? [] : s.type === 'number' ? 0 : '');
  return out;
};

const DAY = 86_400_000;

/** Mock history as the host returns it: oldest first, `fromMe`, plus a few days of earlier traffic for charts. */
const historyOf = (id: string) => {
  const c = mockConversations.find((x) => x.id === id);
  if (!c) return [];
  type Msg = { id: string; isMine: boolean; senderName: string; text: string; date: number };
  const recent = (historyFor(c) as unknown as Msg[]).map((m) => ({ id: m.id, fromMe: m.isMine, senderName: m.senderName, text: m.text, date: m.date }));
  // Older days, deterministic per conversation, so dashboards have something to draw.
  const seed = [...id].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const older: typeof recent = [];
  for (let d = 13; d >= 1; d--) {
    const n = (seed * (d + 3)) % 7;
    for (let i = 0; i < n; i++) {
      const at = Date.now() - d * DAY - ((seed * (i + 1) * 7919) % (10 * 3600_000)) - 2 * 3600_000;
      older.push({ id: `${id}-d${d}-${i}`, fromMe: i % 2 === 1, senderName: i % 2 ? ME.displayName : c.name, text: i % 2 ? 'Dạ em cảm ơn ạ' : 'Cho mình hỏi chút', date: at });
    }
  }
  return [...older, ...recent]
    .filter((m) => m.date <= Date.now())
    .sort((a, b) => a.date - b.date)
    .map((m) => ({ ...m, account: 'default', conversationId: id, conversationName: c.name, isGroup: c.isGroup, sentBy: null, source: 'mock' }));
};

const realConversations = () => mockConversations.filter((c) => c.id !== SELF_CONV);

/** Canned AI: enough for every built-in's JSON shapes to render something real-looking. */
const cannedAi = (addonId: string, req: Record<string, unknown>) => {
  const prompt = JSON.stringify(req).toLowerCase();
  const json = (() => {
    if (addonId === 'order-book')
      return {
        customerName: 'Trần Thị Lan',
        phone: '0908 123 456',
        address: '12 Lê Lợi, P. Bến Nghé, Quận 1, TP.HCM',
        items: [
          { name: 'Áo thun cotton trắng (M)', qty: 2, price: 150000 },
          { name: 'Quần short kaki be', qty: 1, price: 220000 },
        ],
        shippingFee: 30000,
        note: 'Giao giờ hành chính, gọi trước khi tới',
      };
    if (addonId === 'mood-meter') {
      const n = prompt.length % 5;
      const options = [
        { score: -2, label: 'Rất bực', reason: 'Khách phàn nàn giao hàng trễ hai lần và đòi huỷ đơn', urgent: true },
        { score: -1, label: 'Không hài lòng', reason: 'Khách chờ phản hồi lâu, hỏi lại nhiều lần', urgent: true },
        { score: 0, label: 'Bình thường', reason: 'Khách hỏi thông tin sản phẩm, chưa thể hiện cảm xúc rõ', urgent: false },
        { score: 1, label: 'Hài lòng', reason: 'Khách cảm ơn và hẹn mua thêm', urgent: false },
        { score: 2, label: 'Rất vui', reason: 'Khách khen sản phẩm đẹp, giao nhanh', urgent: false },
      ];
      return options[n];
    }
    if (addonId === 'translator') {
      const lines = String(req.prompt ?? '').split('\n').filter((l) => /^\d+\. /.test(l)).length;
      return {
        code: 'en',
        name: 'English',
        language: 'English',
        translation: 'Hello! The set of 3 cotton T-shirts is 450,000 VND with free delivery in the city.',
        translations: Array.from({ length: lines }, (_, i) => ['Chị ơi, áo này còn size M không ạ?', 'Bao lâu thì giao tới Quận 1 vậy shop?', 'Mình muốn đổi sang màu xanh rêu.'][i % 3]),
      };
    }
    return {};
  })();
  const text = addonId === 'translator' && !req.json ? String((json as { translation?: string }).translation ?? 'Hello!') : JSON.stringify(json);
  return { text, json, model: 'mock', usage: { inputTokens: 120, outputTokens: 60 } };
};

export function createBuiltinHost(hooks: HostHooks) {
  const running = new Map<string, Running>();
  let seq = 0;

  const api = async (r: Running, method: string, args: unknown[]): Promise<unknown> => {
    const id = r.pkg.id;
    const name = r.pkg.manifest.name;
    const a0 = args[0] as Record<string, unknown> | string | null;
    const opts = (i: number) => (args[i] ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'conversations':
        return realConversations()
          .slice(0, Number(opts(0).limit) || 50)
          .map((c) => ({ id: c.id, name: c.name, isGroup: c.isGroup, unread: c.unread, account: 'default' }));
      case 'activeConversations': {
        const since = Number(opts(0).since) || Date.now() - DAY;
        return realConversations()
          .map((c) => {
            const msgs = historyOf(c.id).filter((m) => m.date >= since);
            return { id: c.id, name: c.name, isGroup: c.isGroup, count: msgs.length, lastDate: msgs[msgs.length - 1]?.date ?? 0, account: 'default' };
          })
          .filter((c) => c.count > 0)
          .sort((x, y) => y.lastDate - x.lastDate)
          .slice(0, Number(opts(0).limit) || 50);
      }
      case 'history': {
        const o = opts(1);
        const since = Number(o.since) || 0;
        const until = Number(o.until) || Infinity;
        const list = historyOf(String(a0)).filter((m) => m.date >= since && m.date <= until);
        return o.limit ? list.slice(-Number(o.limit)) : list;
      }
      case 'messages':
        return a0 ? historyOf(String(a0)).slice(-(Number(args[1]) || 50)) : [];
      case 'search':
        return [];
      case 'accounts':
        return [{ id: 'default', name: ME.displayName, phone: ME.phoneNumber }];
      case 'notify':
        hooks.emit({ kind: 'toast', addonId: id, addonName: name, text: `${String(args[0])}${args[1] ? ` — ${String(args[1])}` : ''}`, level: 'info' });
        return null;
      case 'sendText':
        hooks.emit({ kind: 'toast', addonId: id, addonName: name, text: `(giả lập) gửi: ${String(args[1]).slice(0, 80)}`, conversationId: a0 });
        return null;
      case 'notesList':
        return hooks.listNotes(id, String(a0));
      case 'notesAdd':
        return hooks.addNote(id, name, String(a0), String(args[1]), opts(2));
      case 'notesUpdate':
        return hooks.updateNote(id, String(a0), opts(1));
      case 'notesRemove':
        hooks.removeNote(id, String(a0));
        return null;
      case 'panel':
        hooks.setPanel(id, name, (a0 as string | null) ?? null, (args[1] as Record<string, unknown> | null) ?? null);
        return null;
      case 'toast':
        hooks.emit({ kind: 'toast', addonId: id, addonName: name, text: String(a0), conversationId: opts(1).conversationId ?? null, level: opts(1).level ?? 'info' });
        return null;
      case 'suggest':
        return `sg_${++seq}`;
      case 'clearSuggestions':
        return 0;
      case 'openView':
        hooks.emit({ kind: 'openView', addonId: id, viewId: String(a0), conversationId: opts(1).conversationId ?? null, params: opts(1).params ?? null });
        return null;
      case 'viewPost':
        hooks.emit({ kind: 'viewMessage', addonId: id, viewId: opts(2).viewId ?? null, name: String(a0), data: args[1] ?? null, conversationId: opts(2).conversationId ?? null });
        return null;
      case 'quickRepliesSet':
        return 0;
      case 'actionsSet':
        r.actions = Array.isArray(a0) ? (a0 as Record<string, unknown>[]) : [];
        hooks.emit({ kind: 'actions' });
        return null;
      case 'aiAvailable':
        return true;
      case 'aiComplete':
        await new Promise((res) => setTimeout(res, 600));
        return cannedAi(id, (a0 ?? {}) as Record<string, unknown>);
      case 'fetch':
        return { status: 200, statusText: 'OK', url: a0, headers: {}, body: '{"ok":true}' };
      case 'storageSet':
        if (args[1] == null) delete r.storage[String(a0)];
        else r.storage[String(a0)] = args[1];
        return null;
      case 'schedulesList':
      case 'mcpServers':
      case 'mcpTools':
        return [];
      case 'scheduleSave':
        return { id: `job_${++seq}` };
      default:
        return null;
    }
  };

  const start = (pkg: BuiltinPackage) => {
    if (running.has(pkg.id)) return;
    const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })), { name: `addon-${pkg.id}` });
    const r: Running = { pkg, worker, storage: {}, viewCalls: new Map(), actions: [] };
    running.set(pkg.id, r);
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { k: string; kind?: string; data?: Record<string, unknown>; id?: number; method?: string; args?: unknown[] };
      if (m.k === 'call') {
        void api(r, m.method!, m.args ?? []).then(
          (value) => worker.postMessage({ t: 'reply', id: m.id, ok: true, value: value ?? null }),
          (err: unknown) => worker.postMessage({ t: 'reply', id: m.id, ok: false, error: String(err) }),
        );
      } else if (m.kind === 'log') {
        const level = String(m.data?.level ?? 'info');
        (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(`[addon ${pkg.id}]`, m.data?.text);
      } else if (m.kind === 'viewResult') {
        const p = r.viewCalls.get(String(m.data?.requestId));
        if (!p) return;
        r.viewCalls.delete(String(m.data?.requestId));
        if (m.data?.ok) p.resolve(m.data.result);
        else p.reject(new Error(String(m.data?.result)));
      }
    };
    const main = pkg.files[String(pkg.manifest.main ?? 'main.js')] ?? '';
    worker.postMessage({ t: 'boot', prelude, files: pkg.files, main, manifest: pkg.manifest, settings: defaults(pkg) });
  };

  return {
    start,
    has: (id: string) => running.has(id),
    viewCall: (addonId: string, name: string, data: unknown, context: Record<string, unknown>) => {
      const r = running.get(addonId);
      if (!r) return Promise.reject(new Error('add-on không chạy'));
      const requestId = `v${++seq}`;
      return new Promise((resolve, reject) => {
        r.viewCalls.set(requestId, { resolve, reject });
        r.worker.postMessage({ t: 'viewCall', requestId, name, data, context });
      });
    },
    event: (addonId: string, name: string, data: unknown) => running.get(addonId)?.worker.postMessage({ t: 'event', name, data }),
    actions: () =>
      [...running.values()].flatMap((r) =>
        [...(r.pkg.manifest.contributes?.actions ?? []), ...r.actions].map((a) => ({ description: '', ...a, addonId: r.pkg.id, addonName: r.pkg.manifest.name })),
      ),
    views: () =>
      [...running.values()].flatMap((r) =>
        (r.pkg.manifest.contributes?.views ?? []).map((v) => ({ icon: null, height: null, width: null, ...v, addonId: r.pkg.id, addonName: r.pkg.manifest.name })),
      ),
    document: (addonId: string, viewId: string, inject: string) => {
      const pkg = running.get(addonId)?.pkg;
      const v = pkg?.manifest.contributes?.views?.find((x) => x.id === viewId);
      if (!pkg || !v) throw new Error('add-on không có giao diện này');
      return buildDocument(pkg.files, v.entry, inject);
    },
  };
}

/** views.rs, abridged: relative scripts and stylesheets inlined, the CSP / base style / SDK first. */
const buildDocument = (files: Record<string, string>, entry: string, inject: string) => {
  const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
  const resolve = (href: string) => {
    const parts: string[] = [];
    for (const p of (href.startsWith('/') ? href.slice(1) : dir + href).split('/')) {
      if (!p || p === '.') continue;
      if (p === '..') parts.pop();
      else parts.push(p);
    }
    return parts.join('/').split(/[?#]/)[0];
  };
  const html = (files[entry] ?? '')
    .replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (_all, _a, src: string) => {
      const js = files[resolve(src)];
      return js == null ? '' : `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`;
    })
    .replace(/<link\b[^>]*>/gi, (tag) => {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href || !/stylesheet/i.test(tag)) return /icon|prefetch|preconnect|preload/i.test(tag) ? '' : tag;
      const css = files[resolve(href)];
      return css == null ? tag : `<style>${css}</style>`;
    })
    .replace(/^\s*<!doctype[^>]*>/i, '');
  return `<!doctype html><html><head>${inject}${html}`;
};
