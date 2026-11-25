// Sổ đơn hàng — the order form (modal). New: the add-on reads the conversation and AI pre-fills the form. Edit: params.orderId.
(function () {
  'use strict';
  const F = window.OrderFmt;
  const $ = (id) => document.getElementById(id);
  let orderId = null;
  let busy = false;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function showError(msg) {
    $('err').textContent = msg || '';
    $('err').classList.toggle('hidden', !msg);
  }

  // ---- item rows ----
  function addRow(item, focus) {
    const it = item || {};
    const row = el('div', 'irow item');
    const name = el('input', 'name');
    name.placeholder = 'VD: Áo thun trắng size M';
    name.maxLength = 200;
    name.value = it.name || '';
    const qty = el('input', 'qty num');
    qty.inputMode = 'decimal';
    qty.value = it.qty ? String(it.qty) : '1';
    const price = el('input', 'price num');
    price.inputMode = 'numeric';
    price.placeholder = '0';
    price.title = 'Gõ 350000, 350k hoặc 1tr2';
    price.value = F.plain(it.price);
    const line = el('span', 'line num muted', '');
    const x = el('button', 'ghost x', '×');
    x.type = 'button';
    x.title = 'Bỏ dòng này';
    x.onclick = () => {
      row.remove();
      if (!document.querySelector('.irow.item')) addRow(null, true);
      recalc();
    };
    price.addEventListener('blur', () => { const n = F.parseMoney(price.value); price.value = F.plain(n); recalc(); });
    qty.addEventListener('blur', () => { qty.value = String(F.parseQty(qty.value) || 1); recalc(); });
    price.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (row === lastRow()) addRow(null, true); }
    });
    row.append(name, qty, price, line, x);
    $('items').appendChild(row);
    if (focus) name.focus();
    recalc();
    return row;
  }
  const lastRow = () => { const rows = document.querySelectorAll('.irow.item'); return rows[rows.length - 1]; };

  function readItems() {
    const out = [];
    document.querySelectorAll('.irow.item').forEach((row) => {
      const name = row.querySelector('.name').value.trim();
      if (!name) return;
      out.push({ name, qty: F.parseQty(row.querySelector('.qty').value) || 1, price: F.parseMoney(row.querySelector('.price').value) });
    });
    return out;
  }

  function readForm() {
    return {
      customerName: $('customerName').value,
      phone: $('phone').value,
      address: $('address').value,
      items: readItems(),
      shippingFee: F.parseMoney($('shippingFee').value),
      note: $('note').value,
      status: $('status').value,
    };
  }

  function recalc() {
    let sub = 0;
    let n = 0;
    document.querySelectorAll('.irow.item').forEach((row) => {
      const name = row.querySelector('.name').value.trim();
      const v = (F.parseQty(row.querySelector('.qty').value) || 0) * F.parseMoney(row.querySelector('.price').value);
      row.querySelector('.line').textContent = v ? F.money(v) : '';
      if (name) { sub += v; n++; }
    });
    const ship = F.parseMoney($('shippingFee').value);
    $('subtotal').textContent = F.money(sub);
    $('ship').textContent = ship ? F.money(ship) : 'Miễn phí';
    $('total').textContent = F.money(sub + ship);
    $('count').textContent = n ? `${n} sản phẩm` : '';
    const ok = n > 0 && !busy;
    $('save').disabled = !ok;
    $('saveInsert').disabled = !ok;
  }

  function fill(f, conversationName) {
    const v = f || {};
    $('customerName').value = v.customerName || conversationName || '';
    $('phone').value = v.phone || '';
    $('address').value = v.address || '';
    $('shippingFee').value = F.plain(v.shippingFee);
    $('note').value = v.note || '';
    $('status').value = F.statusOf(v.status);
    document.querySelectorAll('.irow.item').forEach((r) => r.remove());
    const items = Array.isArray(v.items) && v.items.length ? v.items : [null];
    items.forEach((it) => addRow(it, false));
    recalc();
  }

  function showForm() {
    $('loading').classList.add('hidden');
    $('form').classList.remove('hidden');
  }

  function hint(nodes) {
    $('hint').textContent = '';
    if (!nodes) { $('hint').classList.add('hidden'); return; }
    $('hint').append(...nodes);
    $('hint').classList.remove('hidden');
  }

  // ---- start ----
  async function start(ctx) {
    const params = (ctx && ctx.params) || {};
    orderId = params && typeof params.orderId === 'string' ? params.orderId : null;
    if (orderId) $('loadingText').textContent = 'Đang mở đơn…';
    let r;
    try {
      r = await compola.call('init', { orderId });
    } catch (e) {
      showForm();
      fill(null, ctx && ctx.conversationName);
      showError((e && e.message) || String(e));
      if (orderId) { $('save').disabled = true; $('saveInsert').disabled = true; }
      return;
    }
    showForm();
    if (r && r.mode === 'edit' && r.order) {
      const o = r.order;
      fill(o);
      const head = $('head');
      head.textContent = '';
      head.append(el('strong', '', `Đơn #${o.code}`), el('span', 'chip st-' + F.statusOf(o.status), F.STATUS_LABEL[F.statusOf(o.status)]),
        el('span', 'muted', `tạo ${F.dateTime(o.createdAt)}`));
      head.classList.remove('hidden');
      $('remove').classList.remove('hidden');
      return;
    }
    fill(r && r.fields, ctx && ctx.conversationName);
    if (r && r.ai) hint([el('span', '', '✨'), el('b', '', 'AI đã điền sẵn'), el('span', '', '— kiểm tra lại trước khi lưu')]);
    else if (r && r.reason === 'off') hint([el('span', '', 'Bật AI trong Cài đặt › Add-on để tự điền đơn từ hội thoại.')]);
    else if (r && (r.reason === 'nothing' || r.reason === 'empty')) hint([el('span', '', 'Chưa thấy thông tin đơn trong hội thoại — nhập tay nhé.')]);
    else if (r && (r.reason === 'error' || r.reason === 'bad-answer')) hint([el('span', '', 'AI chưa đọc được hội thoại — nhập tay nhé.')]);
    const first = $('customerName').value ? document.querySelector('.irow.item .name') : $('customerName');
    if (first && !(r && r.ai)) first.focus();
  }

  async function save(confirm) {
    if (busy) return;
    showError('');
    const order = readForm();
    if (!order.items.length) { showError('Thêm ít nhất một sản phẩm'); return; }
    busy = true;
    recalc();
    const btn = confirm ? $('saveInsert') : $('save');
    const label = btn.textContent;
    btn.textContent = 'Đang lưu…';
    try {
      const ctx = compola.context || {};
      const r = await compola.call('save', { orderId, order, confirm: !!confirm, conversationName: ctx.conversationName || '' });
      if (confirm && r && r.confirmText) {
        try { await compola.insertText(r.confirmText); } catch (e) { /* the message box may be gone */ }
      }
      await compola.toast(`Đã lưu đơn #${(r && r.order && r.order.code) || ''}${confirm ? ' — kiểm tra tin xác nhận rồi bấm gửi' : ''}`);
      compola.close(r && r.order ? { orderId: r.order.id } : null);
    } catch (e) {
      showError((e && e.message) || String(e));
      btn.textContent = label;
      busy = false;
      recalc();
    }
  }

  let armTimer = 0;
  $('remove').onclick = async () => {
    const b = $('remove');
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.textContent = 'Bấm lần nữa để xoá';
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Xoá đơn'; }, 3000);
      return;
    }
    clearTimeout(armTimer);
    try {
      await compola.call('remove', { orderId });
      await compola.toast('Đã xoá đơn');
      compola.close(null);
    } catch (e) {
      showError((e && e.message) || String(e));
    }
  };

  const sel = $('status');
  F.STATUSES.forEach((s) => { const o = el('option', '', s.label); o.value = s.value; sel.appendChild(o); });
  $('addItem').onclick = () => addRow(null, true);
  $('cancel').onclick = () => compola.close(null);
  $('save').onclick = () => save(false);
  $('saveInsert').onclick = () => save(true);
  $('form').addEventListener('input', recalc);
  $('form').addEventListener('submit', (e) => e.preventDefault());
  $('shippingFee').addEventListener('blur', () => { $('shippingFee').value = F.plain(F.parseMoney($('shippingFee').value)); recalc(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') compola.close(null);
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(false); }
  });

  compola.ready(start);
})();
