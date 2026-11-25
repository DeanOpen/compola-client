// Sổ đơn hàng — helpers shared by the backend (require('./lib/format.js')) and the views (<script src="../lib/format.js">).
(function (root) {
  'use strict';

  const STATUSES = [
    { value: 'new', label: 'Mới' },
    { value: 'confirmed', label: 'Đã xác nhận' },
    { value: 'shipping', label: 'Đang giao' },
    { value: 'done', label: 'Hoàn thành' },
    { value: 'cancelled', label: 'Huỷ' },
  ];
  const STATUS_LABEL = {};
  for (const s of STATUSES) STATUS_LABEL[s.value] = s.label;
  const statusOf = (v) => (STATUS_LABEL[v] ? v : 'new');

  const str = (v, max) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max || 200);
  const text = (v, max) => (v == null ? '' : String(v)).trim().slice(0, max || 500);

  /** "350k" → 350000, "1tr2" → 1200000, "1.200.000đ" → 1200000, 35000 → 35000. Anything else → 0. */
  function parseMoney(v) {
    if (typeof v === 'number') return isFinite(v) && v > 0 ? Math.round(v) : 0;
    if (typeof v !== 'string') return 0;
    let s = v.toLowerCase().replace(/\s+/g, '').replace(/(vnđ|vnd|đồng|đ|₫|dong)$/u, '');
    if (!s) return 0;
    let m = s.match(/^(\d+)(?:tr|triệu|trieu|m)(\d{0,3})$/u);
    if (m) return Number(m[1]) * 1e6 + (m[2] ? Number(m[2].padEnd(3, '0')) * 1e3 : 0);
    m = s.match(/^(\d+[.,]\d+)(?:tr|triệu|trieu|m)$/u);
    if (m) return Math.round(Number(m[1].replace(',', '.')) * 1e6);
    m = s.match(/^(\d+(?:[.,]\d+)?)(k|nghìn|nghin|ngàn|ngan)$/u);
    if (m) return Math.round(Number(m[1].replace(',', '.')) * 1e3);
    // 1.200.000 / 1,200,000 are thousands separators; a single "12,5" is a decimal.
    if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
    const n = Number(s.replace(',', '.'));
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  function parseQty(v) {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isFinite(n) && n > 0 ? Math.min(Math.round(n * 100) / 100, 100000) : 0;
  }

  const groups = (n) => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  /** 350000 → "350.000 ₫" */
  const money = (n) => (n < 0 ? '-' : '') + groups(Number(n) || 0) + ' ₫';
  const plain = (n) => (Number(n) ? groups(n) : '');

  const pad = (n) => String(n).padStart(2, '0');
  const dateTime = (ms) => {
    const d = new Date(Number(ms) || 0);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const date = (ms) => {
    const d = new Date(Number(ms) || 0);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  };

  function cleanItems(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const name = str(it.name, 200);
      if (!name) continue;
      out.push({ name, qty: parseQty(it.qty) || 1, price: parseMoney(it.price) });
      if (out.length >= 50) break;
    }
    return out;
  }

  /** The editable part of an order, from anything (a form, AI JSON). */
  function cleanFields(f) {
    f = f && typeof f === 'object' ? f : {};
    return {
      customerName: str(f.customerName, 120),
      phone: str(f.phone, 40).replace(/[^\d+ .()-]/g, ''),
      address: str(f.address, 300),
      items: cleanItems(f.items),
      shippingFee: parseMoney(f.shippingFee),
      note: text(f.note, 500),
      status: statusOf(f.status),
    };
  }

  const subtotal = (o) => (o && Array.isArray(o.items) ? o.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0) : 0);
  const total = (o) => Math.round(subtotal(o) + ((o && Number(o.shippingFee)) || 0));
  const code = (o) => String((o && o.id) || '').slice(-6).toUpperCase();

  const itemLines = (o) => {
    const lines = (o.items || []).map((it) => `• ${it.qty} × ${it.name}${it.price ? ` — ${money(it.qty * it.price)}` : ''}`);
    if (o.shippingFee) lines.push(`• Phí giao hàng: ${money(o.shippingFee)}`);
    return lines.join('\n');
  };

  /** The pinned note on the conversation. */
  function noteText(o) {
    const lines = [`🧾 Đơn #${code(o)} · ${STATUS_LABEL[statusOf(o.status)]}`];
    const who = [o.customerName, o.phone].filter(Boolean).join(' · ');
    if (who) lines.push(`Khách: ${who}`);
    if (o.address) lines.push(`Giao: ${o.address}`);
    if ((o.items || []).length || o.shippingFee) lines.push(itemLines(o));
    lines.push(`Tổng: ${money(total(o))}`);
    if (o.note) lines.push(`Ghi chú: ${o.note}`);
    return lines.join('\n');
  }

  const DEFAULT_TEMPLATE =
    'Dạ shop xin xác nhận đơn hàng của {{name}}:\n{{items}}\nTổng thanh toán: {{total}}\nGiao đến: {{address}}\n' +
    'Anh/chị kiểm tra giúp shop thông tin trên nhé, cần sửa gì cứ nhắn shop ạ. Cảm ơn anh/chị! 🙏';

  /** The confirmation message from the template: {{name}} {{phone}} {{items}} {{total}} {{address}} {{shipping}} {{code}} {{note}}. */
  function confirmText(o, template) {
    const t = typeof template === 'string' && template.trim() ? template : DEFAULT_TEMPLATE;
    const values = {
      name: o.customerName || 'anh/chị',
      phone: o.phone || '',
      items: itemLines(o) || '(chưa có sản phẩm)',
      total: money(total(o)),
      address: o.address || '(chưa có địa chỉ)',
      shipping: o.shippingFee ? money(o.shippingFee) : 'miễn phí',
      code: '#' + code(o),
      note: o.note || '',
    };
    return t.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : all)).trim();
  }

  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  function csv(orders) {
    const head = ['Mã', 'Ngày', 'Khách', 'SĐT', 'Địa chỉ', 'Sản phẩm', 'Phí ship', 'Tổng', 'Trạng thái', 'Ghi chú'];
    const rows = (orders || []).map((o) => [
      code(o), dateTime(o.createdAt), o.customerName, o.phone, o.address,
      (o.items || []).map((it) => `${it.qty} x ${it.name} @ ${it.price}`).join('; '),
      o.shippingFee || 0, total(o), STATUS_LABEL[statusOf(o.status)], o.note,
    ]);
    return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  }

  /** Accent-insensitive lowercase for search. */
  const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

  const api = { STATUSES, STATUS_LABEL, statusOf, parseMoney, parseQty, money, plain, dateTime, date, cleanItems, cleanFields, subtotal, total, code, noteText, confirmText, DEFAULT_TEMPLATE, csv, fold };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.OrderFmt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
