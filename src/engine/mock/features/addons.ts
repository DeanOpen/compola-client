// Mock of the add-on host (`addons_*`, Rust src-tauri/src/automation/addons) for the browser preview (`?mock=1`):
// notes, a reply suggestion, a panel, actions, quick replies and the real example package's HTML views
// (examples/addons/crm-demo) with an in-memory copy of its backend. The view documents are assembled here the way
// views.rs does it (inline CSS / scripts, CSP, base style, SDK).

import type { AddonNote, AddonPanel, AddonSuggestion, AddonViewDef, QuickReply } from '../../addons';
import { getEngine } from '../../store';
import { mockContext, registerMockCommand } from '../registry';
import sdk from '../../../../src-tauri/src/automation/addons/view-sdk.js?raw';
import sharedCss from '../../../../examples/addons/crm-demo/ui/shared.css?raw';
import cardHtml from '../../../../examples/addons/crm-demo/ui/card.html?raw';
import cardJs from '../../../../examples/addons/crm-demo/ui/card.js?raw';
import orderHtml from '../../../../examples/addons/crm-demo/ui/order.html?raw';
import dashboardHtml from '../../../../examples/addons/crm-demo/ui/dashboard.html?raw';
import { builtinPackages, createBuiltinHost } from './builtinAddons';

const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src blob:; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'";
const BASE_CSS = `:root{color-scheme:light dark;--c-bg:#fff;--c-fg:#081b3a;--c-muted:#5a6981;--c-border:#dfe2e7;--c-accent:#0068ff;--c-accent-fg:#fff;--c-surface:#f3f5f8;--c-danger:#e53935;--radius:8px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
:root[data-theme="dark"]{--c-bg:#1b1d21;--c-fg:#e7e9ee;--c-muted:#9aa3b2;--c-border:#33373e;--c-accent:#3b8bff;--c-surface:#24272c}
html,body{margin:0;background:transparent;color:var(--c-fg)}button{font:inherit;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-fg);border-radius:var(--radius);padding:5px 10px;cursor:pointer}
button.primary{background:var(--c-accent);border-color:var(--c-accent);color:var(--c-accent-fg)}input,textarea,select{font:inherit;color:var(--c-fg);background:var(--c-bg);border:1px solid var(--c-border);border-radius:var(--radius);padding:5px 8px;box-sizing:border-box}`;

const INJECT = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><style>${BASE_CSS}</style><script>${sdk}</script>`;
const build = (html: string) => {
  const inlined = html
    .replace(/<link rel="stylesheet" href="shared.css">/g, `<style>${sharedCss}</style>`)
    .replace(/<script src="card.js"><\/script>/g, `<script>${cardJs}</script>`);
  return inlined.replace(/<head>/i, `<head>${INJECT}`);
};

const view = (id: string, title: string, location: AddonViewDef['location'], extra: Partial<AddonViewDef> = {}): AddonViewDef => ({
  id,
  title,
  location,
  entry: `ui/${id}.html`,
  icon: 'users',
  height: null,
  width: null,
  addonId: 'crm-demo',
  addonName: 'CRM mẫu',
  ...extra,
});
const views: AddonViewDef[] = [
  view('dashboard', 'Khách hàng', 'tab'),
  view('card', 'Hồ sơ khách', 'inspector', { height: 420 }),
  view('order', 'Tạo đơn hàng', 'modal', { width: 460, height: 480 }),
];
const documents: Record<string, string> = { dashboard: build(dashboardHtml), card: build(cardHtml), order: build(orderHtml) };

const notes = new Map<string, AddonNote[]>();
const suggestions = new Map<string, AddonSuggestion[]>();
const panels = new Map<string, AddonPanel[]>();
const customers = new Map<string, { name: string; stage: string; tags: string[]; orders: { product: string; quantity: number; price: number }[]; conversationId: string; updatedAt: number }>();
const stages = ['Mới', 'Đang tư vấn', 'Đã chốt', 'Chăm sóc lại'];
let seq = 0;

const changed = (kind: string, conversationId: string | null) => mockContext().emit('compola://addons', { kind, account: 'default', conversationId });

const addNote = (conversationId: string, text: string, by: { kind: 'addon' | 'user'; name: string }, tags: string[] = []) => {
  const now = Date.now();
  const n: AddonNote = {
    id: `note_${++seq}`,
    account: 'default',
    conversationId,
    messageId: null,
    authorKind: by.kind,
    authorId: by.kind === 'addon' ? 'daily-summary' : 'local',
    authorName: by.name,
    text,
    pinned: false,
    tags,
    createdAt: now,
    updatedAt: now,
  };
  notes.set(conversationId, [n, ...(notes.get(conversationId) ?? [])]);
  changed('notes', conversationId);
  return n;
};

const quickReplies: QuickReply[] = [
  { addonId: 'quick-replies', shortcut: 'chao', title: 'Xin chào', text: 'Xin chào {{name}}, em có thể hỗ trợ gì cho anh/chị ạ?' },
  { addonId: 'quick-replies', shortcut: 'cam-on', title: 'Cảm ơn', text: 'Cảm ơn anh/chị đã liên hệ. Chúc anh/chị một ngày tốt lành!' },
  { addonId: 'quick-replies', shortcut: 'gio', title: 'Giờ làm việc', text: 'Bên em làm việc từ 8:00 đến 17:30, thứ hai đến thứ bảy.' },
];

const actions = [
  { id: 'suggest', title: 'AI gợi ý trả lời', context: 'conversation', description: '', addonId: 'ai-reply', addonName: 'Trả lời bằng AI' },
  { id: 'summarize', title: 'Tóm tắt hôm nay', context: 'conversation', description: '', addonId: 'daily-summary', addonName: 'Tóm tắt khách hàng hằng ngày' },
  { id: 'new-order', title: 'Tạo đơn', context: 'conversation', description: '', addonId: 'crm-demo', addonName: 'CRM mẫu', view: 'order' },
];

// The real built-in add-ons with HTML views, running in workers (builtinAddons.ts).
const addonNote = (addonId: string, addonName: string, conversationId: string, text: string, opts: Record<string, unknown>) => {
  const list = notes.get(conversationId) ?? [];
  const key = typeof opts.key === 'string' ? `${addonId}:${opts.key}` : null;
  const existing = key ? list.find((n) => (n as AddonNote & { key?: string }).key === key) : undefined;
  const now = Date.now();
  if (existing) {
    Object.assign(existing, { text, pinned: Boolean(opts.pinned ?? existing.pinned), tags: (opts.tags as string[]) ?? existing.tags, updatedAt: now });
    changed('notes', conversationId);
    return existing.id;
  }
  const n = addNote(conversationId, text, { kind: 'addon', name: addonName }, (opts.tags as string[]) ?? []);
  Object.assign(n, { authorId: addonId, pinned: Boolean(opts.pinned), key });
  return n.id;
};
const findNote = (id: string) => [...notes.values()].flat().find((n) => n.id === id);
const builtins = createBuiltinHost({
  addNote: addonNote,
  listNotes: (addonId, conversationId) => (notes.get(conversationId) ?? []).filter((n) => n.authorId === addonId),
  updateNote: (_addonId, id, patch) => {
    const n = findNote(id);
    if (!n) throw new Error('không tìm thấy ghi chú');
    Object.assign(n, patch, { updatedAt: Date.now() });
    changed('notes', n.conversationId);
    return n;
  },
  removeNote: (_addonId, id) => {
    const n = findNote(id);
    if (!n) return;
    notes.set(n.conversationId, (notes.get(n.conversationId) ?? []).filter((x) => x.id !== id));
    changed('notes', n.conversationId);
  },
  setPanel: (addonId, addonName, conversationId, panel) => {
    const key = conversationId ?? '*';
    const rest = (panels.get(key) ?? []).filter((p) => p.addonId !== addonId);
    if (panel) rest.push({ addonId, addonName, conversationId, title: String(panel.title ?? addonName), blocks: (panel.blocks as AddonPanel['blocks']) ?? [], updatedAt: Date.now() });
    panels.set(key, rest);
    changed('panels', conversationId);
  },
  emit: (payload) => mockContext().emit('compola://addons', { account: 'default', ...payload }),
});
/** Which built-ins run in the preview: the ones with HTML views (the others need a real account to show anything). */
export const previewBuiltins = builtinPackages.filter((p) => (p.manifest.contributes?.views ?? []).length > 0).map((p) => p.id);
let started = false;
const startBuiltins = () => {
  if (started) return;
  started = true;
  for (const p of builtinPackages) if (previewBuiltins.includes(p.id)) builtins.start(p);
};
const allViews = () => (startBuiltins(), [...views, ...(builtins.views() as AddonViewDef[])]);
const allActions = () => [...actions, ...builtins.actions()];

let seeded = false;
/** Demo content for the first 1-1 chat, made on first use (the conversation list exists by then). */
const seed = () => {
  if (seeded) return;
  const all = getEngine().conversations;
  const first = all.find((c) => c.name === 'Trần Thị Lan') ?? all.find((c) => !c.isGroup && c.id !== getEngine().selfConversationId);
  if (!first) return;
  seeded = true;
  const today = new Date().toLocaleDateString('vi-VN');
  addNote(
    first.id,
    `📋 Tóm tắt ${today} (12 tin)\n• Khách hỏi giá combo 3 áo thun, size M\n• Đã báo giá 450.000 ₫, miễn phí giao trong nội thành\n• Việc tiếp theo: gửi ảnh màu xanh rêu trước 17:00`,
    { kind: 'addon', name: 'Tóm tắt khách hàng hằng ngày' },
    ['tóm tắt'],
  );
  suggestions.set(first.id, [
    {
      id: 'sg_1',
      addonId: 'ai-reply',
      addonName: 'Trả lời bằng AI',
      account: 'default',
      conversationId: first.id,
      title: 'AI gợi ý',
      text: 'Dạ em gửi anh/chị ảnh màu xanh rêu ngay ạ. Combo 3 áo size M là 450.000 ₫, giao miễn phí trong nội thành. Anh/chị muốn em lên đơn luôn không ạ?',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    },
  ]);
  panels.set(first.id, [
    {
      addonId: 'loyalty',
      addonName: 'Khách hàng thân thiết',
      conversationId: first.id,
      title: 'Khách hàng thân thiết',
      blocks: [
        { type: 'kv', items: [{ label: 'Hạng', value: 'Vàng' }, { label: 'Điểm', value: '1.240' }, { label: 'Đơn gần nhất', value: '12/11' }] },
        { type: 'progress', label: 'Lên hạng Bạch kim', value: 0.62 },
        { type: 'badges', items: ['VIP', 'Hay mua cuối tuần'] },
        { type: 'button', label: 'Tặng mã giảm giá', action: 'coupon', payload: null, style: 'primary' },
      ],
      updatedAt: Date.now(),
    },
  ]);
};

const conv = (a: Record<string, unknown>) => String(a.conversationId ?? '');

registerMockCommand('addons_views', () => allViews());
registerMockCommand('addons_quick_replies', () => quickReplies);
registerMockCommand('addons_note_counts', () => Object.fromEntries([...notes].map(([k, v]) => [k, v.length])));
registerMockCommand('addons_workspace', (a) => (seed(), {
  notes: [...(notes.get(conv(a)) ?? [])].sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.createdAt - x.createdAt),
  suggestions: suggestions.get(conv(a)) ?? [],
  panels: [...(panels.get('*') ?? []), ...(panels.get(conv(a)) ?? [])],
  actions: allActions(),
  views: allViews(),
}));
registerMockCommand('addons_view_document', (a) => {
  if (builtins.has(String(a.addonId))) return builtins.document(String(a.addonId), String(a.viewId), INJECT);
  const d = documents[String(a.viewId)];
  if (!d) throw new Error('add-on không có giao diện này');
  return d;
});
registerMockCommand('addons_note_add', (a) => addNote(conv(a), String(a.text ?? ''), { kind: 'user', name: 'Tôi' }));
registerMockCommand('addons_note_update', (a) => {
  const list = notes.get(conv(a)) ?? [];
  const n = list.find((x) => x.id === a.id);
  if (!n) throw new Error('không tìm thấy ghi chú');
  Object.assign(n, a.patch as object, { updatedAt: Date.now() });
  changed('notes', conv(a));
  return n;
});
registerMockCommand('addons_note_delete', (a) => {
  notes.set(conv(a), (notes.get(conv(a)) ?? []).filter((n) => n.id !== a.id));
  changed('notes', conv(a));
  return null;
});
registerMockCommand('addons_suggestion_resolve', (a) => {
  suggestions.set(conv(a), (suggestions.get(conv(a)) ?? []).filter((s) => s.id !== a.id));
  changed('suggestions', conv(a));
  return null;
});
registerMockCommand('addons_action_run', (a) => {
  const c = (a.conversationId as string | null) ?? null;
  if (builtins.has(String(a.addonId))) {
    builtins.event(String(a.addonId), 'action', {
      actionId: a.actionId, account: 'default', conversationId: c, messageId: a.messageId ?? null, text: a.text ?? null, payload: a.payload ?? null,
      user: { kind: 'local', id: 'me', name: 'Tôi' },
    });
    return null;
  }
  if (a.actionId === 'summarize' && c) addNote(c, '📋 Tóm tắt hôm nay: khách đã xác nhận đơn, chờ chuyển khoản.', { kind: 'addon', name: 'Tóm tắt khách hàng hằng ngày' }, ['tóm tắt']);
  else mockContext().emit('compola://addons', { kind: 'toast', addonName: 'Add-on', text: `đã chạy “${String(a.actionId)}”`, conversationId: c });
  return null;
});

// The crm-demo backend (examples/addons/crm-demo/main.js), in memory.
registerMockCommand('addons_view_call', (a) => {
  if (builtins.has(String(a.addonId))) {
    return builtins.viewCall(String(a.addonId), String(a.name), a.data ?? null, {
      account: 'default', addonId: a.addonId, viewId: a.viewId, conversationId: a.conversationId ?? null, params: a.params ?? null, user: { kind: 'local', id: 'me', name: 'Tôi' },
    });
  }
  const c = (a.conversationId as string | null) ?? '';
  const data = (a.data ?? {}) as Record<string, unknown>;
  const cur = customers.get(c) ?? { name: '', stage: stages[0], tags: [], orders: [], conversationId: c, updatedAt: Date.now() };
  const save = (next: typeof cur) => {
    customers.set(c, { ...next, updatedAt: Date.now() });
    mockContext().emit('compola://addons', { kind: 'viewMessage', addonId: 'crm-demo', name: 'changed', data: { conversationId: c } });
  };
  switch (a.name) {
    case 'customer':
      if (!c) throw new Error('chưa chọn hội thoại');
      return { ...cur, stages };
    case 'setStage':
      if (cur.stage !== data.stage) addNote(c, `Giai đoạn: ${cur.stage} → ${String(data.stage)} (Tôi)`, { kind: 'addon', name: 'CRM mẫu' }, ['CRM']);
      save({ ...cur, stage: String(data.stage), name: String(data.name ?? cur.name) });
      return true;
    case 'setTags':
      save({ ...cur, tags: (data.tags as string[]).map((t) => t.trim()).filter(Boolean) });
      return true;
    case 'addOrder': {
      if (!data.product || !(Number(data.quantity) > 0)) throw new Error('nhập sản phẩm và số lượng');
      const order = { product: String(data.product), quantity: Number(data.quantity), price: Number(data.price) || 0 };
      save({ ...cur, name: String(data.name ?? cur.name), stage: stages[2], orders: [order, ...cur.orders] });
      addNote(c, `🧾 Đơn: ${order.quantity} × ${order.product} = ${(order.quantity * order.price).toLocaleString('vi-VN')} ₫ (Tôi)`, { kind: 'addon', name: 'CRM mẫu' }, ['đơn hàng']);
      return order;
    }
    case 'dashboard': {
      const list = [...customers.values()];
      const byStage = Object.fromEntries(stages.map((s) => [s, list.filter((x) => x.stage === s).length]));
      const revenue = list.reduce((sum, x) => sum + x.orders.reduce((s, o) => s + o.quantity * o.price, 0), 0);
      const active = getEngine()
        .conversations.slice(0, 6)
        .map((x, i) => ({ id: x.id, name: x.name, count: 12 - i, lastDate: x.preview?.date ?? Date.now() }));
      return { stages: byStage, revenue, customers: list, active };
    }
    default:
      throw new Error(`add-on không xử lý "${String(a.name)}"`);
  }
});
