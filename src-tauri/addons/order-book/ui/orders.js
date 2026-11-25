// Sổ đơn hàng — the orders of the conversation on screen (inspector).
(function () {
  'use strict';
  const F = window.OrderFmt;
  const $ = (id) => document.getElementById(id);
  const SHOWN = 6;
  let seq = 0;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function render(orders) {
    const list = $('list');
    list.textContent = '';
    const live = orders.filter((o) => o.status !== 'cancelled');
    const sum = $('sum');
    sum.textContent = '';
    if (!orders.length) {
      sum.textContent = 'Khách này chưa có đơn';
      list.appendChild(el('div', 'empty', 'Bấm “Tạo đơn” để lập đơn từ hội thoại.'));
      return;
    }
    sum.append(el('b', '', `${orders.length} đơn`), document.createTextNode(` · ${F.money(live.reduce((s, o) => s + (Number(o.total) || 0), 0))}`));
    for (const o of orders.slice(0, SHOWN)) {
      const st = F.statusOf(o.status);
      const b = el('button', 'o');
      b.title = 'Mở đơn';
      const items = Array.isArray(o.items) ? o.items : [];
      const what = items.length ? items.map((it) => `${it.qty}× ${it.name}`).join(', ') : 'Không có sản phẩm';
      b.append(el('span', 'chip st-' + st, F.STATUS_LABEL[st]), el('span', 'what', what), el('span', 'total num', F.money(o.total)),
        el('span', 'meta', `#${o.code} · ${F.dateTime(o.createdAt)}${o.address ? ' · ' + o.address : ''}`));
      b.onclick = () => compola.openView('order', { orderId: o.id }).catch(() => {});
      list.appendChild(b);
    }
    if (orders.length > SHOWN) list.appendChild(el('div', 'more', `và ${orders.length - SHOWN} đơn cũ hơn — xem ở tab Đơn hàng`));
  }

  async function load() {
    const ctx = compola.context;
    const mine = ++seq;
    if (!ctx || !ctx.conversationId) { render([]); return; }
    try {
      const r = await compola.call('conversationOrders');
      if (mine !== seq) return;
      $('err').classList.add('hidden');
      render(r && Array.isArray(r.orders) ? r.orders : []);
    } catch (e) {
      if (mine !== seq) return;
      $('err').textContent = (e && e.message) || String(e);
      $('err').classList.remove('hidden');
    }
  }

  $('new').onclick = () => compola.openView('order', null).catch(() => {});
  compola.ready(load);
  compola.on('context', load);
  compola.on('orders-changed', (d) => {
    const ctx = compola.context;
    if (!d || !ctx || !d.conversationId || d.conversationId === ctx.conversationId) load();
  });
})();
