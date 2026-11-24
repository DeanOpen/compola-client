// CRM mẫu — an example add-on with HTML views (docs/addons.md). Customers live in the add-on's storage, keyed by
// account and conversation; orders also become notes on the conversation, so colleagues see them.

const { stagesOf, money } = require('./lib/format.js');

const keyOf = (ctx) => `${ctx.account || ''}|${ctx.conversationId}`;
const all = () => compola.storage.get('customers') || {};
const customer = (ctx) => all()[keyOf(ctx)] || { stage: stagesOf(compola.settings.stages)[0], tags: [], orders: [], name: '' };

const save = async (ctx, c) => {
  const map = all();
  map[keyOf(ctx)] = { ...c, conversationId: ctx.conversationId, account: ctx.account, updatedAt: Date.now() };
  await compola.storage.set('customers', map);
  // Open views of this add-on refresh (the tab, other inspectors).
  await compola.views.post('changed', { conversationId: ctx.conversationId });
};

compola.views.handle('customer', async (_data, ctx) => {
  if (!ctx.conversationId) throw new Error('chưa chọn hội thoại');
  return { ...customer(ctx), stages: stagesOf(compola.settings.stages) };
});

compola.views.handle('setStage', async ({ stage, name }, ctx) => {
  const c = customer(ctx);
  if (c.stage !== stage) await compola.notes.add(ctx.conversationId, `Giai đoạn: ${c.stage} → ${stage} (${ctx.user.name})`, { account: ctx.account, tags: ['CRM'] });
  await save(ctx, { ...c, stage, name: name || c.name });
  return true;
});

compola.views.handle('setTags', async ({ tags, name }, ctx) => {
  await save(ctx, { ...customer(ctx), tags: [...new Set(tags.map(String).map((t) => t.trim()).filter(Boolean))].slice(0, 10), name: name || customer(ctx).name });
  return true;
});

compola.views.handle('addOrder', async ({ product, quantity, price, name }, ctx) => {
  if (!product || !(quantity > 0)) throw new Error('nhập sản phẩm và số lượng');
  const c = customer(ctx);
  const order = { id: Date.now(), product: String(product).slice(0, 200), quantity: Number(quantity), price: Number(price) || 0, by: ctx.user.name, at: Date.now() };
  await save(ctx, { ...c, name: name || c.name, orders: [order, ...c.orders].slice(0, 100), stage: stagesOf(compola.settings.stages)[2] || c.stage });
  await compola.notes.add(ctx.conversationId, `🧾 Đơn: ${order.quantity} × ${order.product} = ${money(order.quantity * order.price)} (${order.by})`, { account: ctx.account, tags: ['đơn hàng'] });
  return order;
});

compola.views.handle('dashboard', async () => {
  const customers = Object.values(all());
  const stages = stagesOf(compola.settings.stages);
  const byStage = Object.fromEntries(stages.map((s) => [s, 0]));
  for (const c of customers) byStage[c.stage] = (byStage[c.stage] || 0) + 1;
  const active = await compola.activeConversations({ since: Date.now() - 86400000, limit: 50 }).catch(() => []);
  const revenue = customers.reduce((sum, c) => sum + c.orders.reduce((s, o) => s + o.quantity * o.price, 0), 0);
  return {
    stages: byStage,
    revenue,
    customers: customers.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100),
    active: active.map((a) => ({ id: a.id, name: a.name, count: a.count, lastDate: a.lastDate })),
  };
});

compola.on('ready', () => compola.log(`${Object.keys(all()).length} khách hàng`));
