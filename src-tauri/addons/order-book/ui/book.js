// Sổ đơn hàng — every order (tab): revenue, status filter, search, inline status, CSV.
(function () {
  'use strict';
  const F = window.OrderFmt;
  const $ = (id) => document.getElementById(id);
  const PAGE = 100;
  let orders = [];
  let filter = 'all';
  let query = '';
  let shown = PAGE;
  let seq = 0;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const showError = (msg) => { $('err').textContent = msg || ''; $('err').classList.toggle('hidden', !msg); };

  const haystack = (o) => F.fold([o.code, o.customerName, o.conversationName, o.phone, o.address, o.note,
    ...(Array.isArray(o.items) ? o.items.map((it) => it.name) : [])].join(' ')) + ' ' + String(o.phone || '').replace(/\D/g, '');

  function matching() {
    const q = F.fold(query.trim());
    const words = q ? q.split(/\s+/) : [];
    return orders.filter((o) => {
      if (filter !== 'all' && F.statusOf(o.status) !== filter) return false;
      if (!words.length) return true;
      const h = o._h || (o._h = haystack(o));
      return words.every((w) => h.includes(w));
    });
  }

  function renderFilters() {
    const counts = { all: orders.length };
    for (const o of orders) { const s = F.statusOf(o.status); counts[s] = (counts[s] || 0) + 1; }
    const box = $('filters');
    box.textContent = '';
    for (const f of [{ value: 'all', label: 'Tất cả' }, ...F.STATUSES]) {
      const b = el('button', filter === f.value ? 'on' : '');
      b.append(document.createTextNode(f.label), el('span', 'n', String(counts[f.value] || 0)));
      b.onclick = () => { filter = f.value; shown = PAGE; render(); };
      box.appendChild(b);
    }
  }

  function statusSelect(o) {
    const s = el('select', 'st st-' + F.statusOf(o.status));
    s.title = 'Đổi trạng thái';
    for (const st of F.STATUSES) {
      const opt = el('option', '', st.label);
      opt.value = st.value;
      s.appendChild(opt);
    }
    s.value = F.statusOf(o.status);
    s.onclick = (e) => e.stopPropagation();
    s.onchange = async () => {
      const prev = o.status;
      s.disabled = true;
      try {
        const r = await compola.call('setStatus', { orderId: o.id, status: s.value });
        o.status = (r && r.status) || s.value;
        render();
      } catch (e) {
        o.status = prev;
        s.value = F.statusOf(prev);
        showError((e && e.message) || String(e));
      } finally {
        s.disabled = false;
      }
    };
    return s;
  }

  function render() {
    renderFilters();
    const list = matching();
    const rows = $('rows');
    rows.textContent = '';
    const th = el('div', 'r th');
    th.append(el('span', '', 'Mã · Ngày'), el('span', '', 'Khách'), el('span', '', 'Sản phẩm · Địa chỉ'), el('span', '', 'Tổng'), el('span', '', 'Trạng thái'));
    th.lastChild.previousSibling.style.textAlign = 'right';
    rows.appendChild(th);
    if (!list.length) {
      rows.appendChild(el('div', 'empty', orders.length ? 'Không có đơn nào khớp bộ lọc.' : 'Chưa có đơn nào. Mở một hội thoại và chọn “Tạo đơn”.'));
    }
    for (const o of list.slice(0, shown)) {
      const st = F.statusOf(o.status);
      const r = el('div', 'r' + (st === 'cancelled' ? ' cancelled' : ''));
      r.title = o.conversationId ? 'Mở hội thoại' : '';
      const code = el('div', 'c-code');
      code.append(el('div', 'line1', '#' + o.code), el('div', 'line2', F.dateTime(o.createdAt)));
      const cust = el('div', 'c-cust');
      cust.append(el('div', 'line1', o.customerName || o.conversationName || 'Khách'), el('div', 'line2', o.phone || '—'));
      const items = el('div', 'c-items');
      const names = Array.isArray(o.items) ? o.items.map((it) => `${it.qty}× ${it.name}`).join(', ') : '';
      items.append(el('div', 'line1', names || '—'), el('div', 'line2', o.address || ''));
      const total = el('div', 'c-total num', F.money(o.total));
      const status = el('div', 'c-status');
      status.appendChild(statusSelect(o));
      r.append(code, cust, items, total, status);
      r.onclick = () => { if (o.conversationId) compola.openConversation(o.conversationId).catch((e) => showError((e && e.message) || String(e))); };
      rows.appendChild(r);
    }
    $('more').classList.toggle('hidden', list.length <= shown);
    $('more').textContent = `Xem thêm (${list.length - shown} đơn)`;
  }

  function renderStats(s) {
    const v = s || {};
    $('today').textContent = F.money(v.today || 0);
    $('todayN').textContent = `${v.todayCount || 0} đơn (không tính Huỷ)`;
    $('week').textContent = F.money(v.week || 0);
    $('weekN').textContent = `${v.weekCount || 0} đơn (không tính Huỷ)`;
    $('open').textContent = String(v.open || 0);
  }

  async function load() {
    const mine = ++seq;
    try {
      const r = await compola.call('allOrders');
      if (mine !== seq) return;
      orders = r && Array.isArray(r.orders) ? r.orders : [];
      renderStats(r && r.stats);
      showError('');
      render();
    } catch (e) {
      if (mine === seq) showError((e && e.message) || String(e));
    }
  }

  let reloadTimer = 0;
  const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 300); };

  let qTimer = 0;
  $('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { query = $('q').value; shown = PAGE; render(); }, 120); });
  $('more').onclick = () => { shown += PAGE; render(); };
  $('csvBtn').onclick = () => {
    const list = matching();
    const box = $('csvText');
    box.value = F.csv(list);
    $('csv').classList.remove('hidden');
    box.focus();
    box.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
    $('csvMsg').textContent = copied
      ? `Đã chép ${list.length} đơn — dán vào Excel hoặc Google Sheets.`
      : `${list.length} đơn, đã chọn sẵn — nhấn Ctrl+C (⌘C trên Mac) để chép rồi dán vào Excel hoặc Google Sheets.`;
  };
  $('csvClose').onclick = () => $('csv').classList.add('hidden');

  compola.ready(load);
  compola.on('orders-changed', reloadSoon);
})();
