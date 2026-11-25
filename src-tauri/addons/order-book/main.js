// Sổ đơn hàng — built-in Compola add-on. Orders live in the add-on's storage (key "orders", newest first, capped);
// each one is also a pinned note on its conversation (key "order:<id>") so colleagues see it in the info panel.

const F = require('./lib/format.js');

const MAX_ORDERS = 2000;
const HISTORY = 30;
const MAX_TRANSCRIPT = 6000;

const SYSTEM =
  'Bạn trích thông tin đơn hàng từ cuộc trò chuyện Zalo giữa shop ("Shop") và khách ("Khách"). ' +
  'Trả về đúng một JSON: {"customerName": string, "phone": string, "address": string, ' +
  '"items": [{"name": string, "qty": number, "price": number}], "shippingFee": number, "note": string}. ' +
  'price là đơn giá MỘT sản phẩm, tính bằng đồng (350k = 350000, 1tr2 = 1200000); nếu shop chỉ báo tổng tiền cho nhiều cái thì chia ra đơn giá. ' +
  'name ghi rõ phân loại (size, màu) nếu có. note: yêu cầu riêng của khách (giờ giao, gói quà…). ' +
  'Chỉ dùng thông tin có trong hội thoại; thiếu thì để "" hoặc 0, items rỗng nếu chưa chốt món nào. Không bịa.';

const warn = (where, e) => compola.warn(`${where}: ${(e && e.message) || e}`);

// ---- storage ----
const all = () => {
  const list = compola.storage.get('orders');
  return Array.isArray(list) ? list.filter((o) => o && typeof o === 'object' && o.id) : [];
};

/** Keeps at most MAX_ORDERS: drops the oldest finished (Hoàn thành / Huỷ) first, then the oldest of any kind. */
const cap = (list) => {
  if (list.length <= MAX_ORDERS) return list;
  const extra = list.length - MAX_ORDERS;
  const finished = list
    .filter((o) => o.status === 'done' || o.status === 'cancelled')
    .sort((a, b) => (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt))
    .slice(0, extra);
  const drop = new Set(finished.map((o) => o.id));
  let out = list.filter((o) => !drop.has(o.id));
  if (out.length > MAX_ORDERS) out = out.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ORDERS);
  return out;
};

const persist = async (list) => {
  await compola.storage.set('orders', cap(list.sort((a, b) => b.createdAt - a.createdAt)));
};

const find = (id) => all().find((o) => o.id === id) || null;
const newId = () => 'o' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');

/** Writes (or updates) the order's note (remembering its id on `o`); an order still in progress stays pinned. */
const syncNote = async (o) => {
  if (!o.conversationId) return;
  try {
    const opts = { key: `order:${o.id}`, pinned: o.status !== 'done' && o.status !== 'cancelled', tags: ['đơn hàng'] };
    if (o.account) opts.account = o.account;
    const n = await compola.notes.add(o.conversationId, F.noteText(o), opts);
    const id = n && typeof n === 'object' ? n.id : n;
    if (typeof id === 'string' && id) o.noteId = id;
  } catch (e) {
    warn('không ghi được ghi chú đơn', e);
  }
};

const changed = (o) => compola.views.post('orders-changed', { conversationId: o.conversationId || null, id: o.id }).catch((e) => warn('views.post', e));

const summary = (o) => ({
  id: o.id,
  code: F.code(o),
  conversationId: o.conversationId,
  conversationName: o.conversationName || '',
  account: o.account || null,
  customerName: o.customerName,
  phone: o.phone,
  address: o.address,
  items: o.items,
  shippingFee: o.shippingFee,
  note: o.note,
  status: o.status,
  total: F.total(o),
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

// ---- AI extraction ----
const transcriptOf = (messages) => {
  const lines = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const t = m && typeof m.text === 'string' ? m.text.replace(/\s+/g, ' ').trim() : '';
    if (!t) continue;
    const line = `${m.fromMe ? 'Shop' : 'Khách'}: ${t.slice(0, 800)}`;
    if (size + line.length > MAX_TRANSCRIPT) break;
    size += line.length + 1;
    lines.unshift(line);
  }
  return lines.join('\n');
};

const parseJson = (out) => {
  if (out && out.json && typeof out.json === 'object') return out.json;
  const t = out && typeof out.text === 'string' ? out.text : '';
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
};

const extract = async (conversationId, account) => {
  if (!conversationId) return { ai: false, reason: 'no-conversation' };
  if (!(await compola.ai.available().catch(() => false))) return { ai: false, reason: 'off' };
  const opts = { limit: HISTORY };
  if (account) opts.account = account;
  const messages = await compola.history(conversationId, opts).catch(() => []);
  const transcript = transcriptOf(Array.isArray(messages) ? messages : []);
  if (!transcript) return { ai: false, reason: 'empty' };
  const out = await compola.ai.complete({ system: SYSTEM, prompt: `Hội thoại:\n${transcript}\n\nTrả về JSON đơn hàng.`, json: true, maxTokens: 1200, effort: 'low' });
  const v = parseJson(out);
  if (!v || typeof v !== 'object') return { ai: false, reason: 'bad-answer' };
  const fields = F.cleanFields(v);
  const found = fields.customerName || fields.phone || fields.address || fields.items.length || fields.shippingFee || fields.note;
  return { ai: !!found, reason: found ? '' : 'nothing', fields };
};

// ---- view handlers ----
compola.views.handle('init', async (data, ctx) => {
  const d = data && typeof data === 'object' ? data : {};
  if (d.orderId) {
    const o = find(String(d.orderId));
    if (!o) throw new Error('Không tìm thấy đơn (có thể đã bị xoá)');
    return { mode: 'edit', order: summary(o) };
  }
  try {
    return { mode: 'new', ...(await extract(ctx && ctx.conversationId, ctx && ctx.account)) };
  } catch (e) {
    warn('AI đọc hội thoại', e);
    return { mode: 'new', ai: false, reason: 'error' };
  }
});

compola.views.handle('save', async (data, ctx) => {
  const d = data && typeof data === 'object' ? data : {};
  const fields = F.cleanFields(d.order);
  if (!fields.items.length) throw new Error('Thêm ít nhất một sản phẩm');
  const list = all();
  const now = Date.now();
  let o;
  const i = d.orderId ? list.findIndex((x) => x.id === d.orderId) : -1;
  if (i >= 0) {
    o = { ...list[i], ...fields, updatedAt: now };
    list[i] = o;
  } else {
    if (!ctx || !ctx.conversationId) throw new Error('Mở một hội thoại để tạo đơn');
    o = {
      id: newId(),
      conversationId: String(ctx.conversationId),
      conversationName: String(d.conversationName || '').slice(0, 120),
      account: ctx.account || null,
      createdAt: now,
      updatedAt: now,
      by: (ctx.user && ctx.user.name) || '',
      ...fields,
    };
    list.unshift(o);
  }
  await syncNote(o);
  await persist(list);
  await changed(o);
  return { order: summary(o), confirmText: d.confirm ? F.confirmText(o, compola.settings.confirmTemplate) : null };
});

compola.views.handle('setStatus', async (data) => {
  const d = data && typeof data === 'object' ? data : {};
  const list = all();
  const o = list.find((x) => x.id === d.orderId);
  if (!o) throw new Error('Không tìm thấy đơn');
  const status = F.statusOf(d.status);
  if (o.status !== status) {
    o.status = status;
    o.updatedAt = Date.now();
    await syncNote(o);
    await persist(list);
    await changed(o);
  }
  return summary(o);
});

compola.views.handle('remove', async (data) => {
  const id = data && data.orderId;
  const list = all();
  const o = list.find((x) => x.id === id);
  if (!o) return true;
  await persist(list.filter((x) => x.id !== id));
  try {
    if (o.noteId) await compola.notes.remove(o.noteId);
  } catch (e) {
    warn('không xoá được ghi chú đơn', e);
  }
  await changed(o);
  return true;
});

/** Orders of the view's conversation (inspector). */
compola.views.handle('conversationOrders', async (_data, ctx) => {
  const conv = ctx && ctx.conversationId;
  if (!conv) return { orders: [] };
  const orders = all().filter((o) => o.conversationId === conv && (!ctx.account || !o.account || o.account === ctx.account));
  return { orders: orders.slice(0, 50).map(summary) };
});

/** Every order with revenue totals (tab). */
compola.views.handle('allOrders', async () => {
  const orders = all();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const week = today - 6 * 86400000;
  const stats = { today: 0, todayCount: 0, week: 0, weekCount: 0, open: 0 };
  for (const o of orders) {
    if (o.status !== 'done' && o.status !== 'cancelled') stats.open++;
    if (o.status === 'cancelled') continue;
    if (o.createdAt >= today) { stats.today += F.total(o); stats.todayCount++; }
    if (o.createdAt >= week) { stats.week += F.total(o); stats.weekCount++; }
  }
  return { orders: orders.map(summary), stats };
});

// Without the host's "view" support an action event arrives instead: open the form ourselves.
compola.on('action', async (a) => {
  try {
    if (!a || a.actionId !== 'new-order' || !a.conversationId) return;
    await compola.ui.openView('order', { conversationId: a.conversationId, account: a.account || undefined });
  } catch (e) {
    warn('mở form đơn', e);
  }
});

compola.on('ready', () => {
  try {
    compola.log(`${all().length} đơn hàng`);
  } catch (e) {
    warn('ready', e);
  }
});
