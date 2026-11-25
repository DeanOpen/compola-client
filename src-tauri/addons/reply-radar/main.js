// Khách đang chờ — built-in Compola add-on: customers whose latest message is still unanswered.
// One entry per conversation from its first unanswered incoming message until someone on the account replies.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MAX_WAITING = 300;
const STALE_MS = 7 * DAY;
const TITLE = 'Khách đang chờ';

const str = (v) => (v == null ? '' : String(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (account, id) => `${account}|${id}`;
const pad = (n) => String(n).padStart(2, '0');
const preview = (text) => {
  const t = str(text).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 160) : '(hình ảnh, tệp hoặc nhãn dán)';
};
const timeLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? hm : `${hm} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
};
const duration = (ms) => {
  const m = Math.floor(Math.max(0, ms) / MIN);
  if (m < 1) return 'dưới 1 phút';
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} giờ ${m % 60} phút` : `${h} giờ`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} ngày ${h % 24} giờ` : `${d} ngày`;
};

// ---- settings ----
const settings = () => compola.settings || {};
const alertMinutes = () => Math.min(24 * 60, Math.max(1, Number(settings().alertMinutes) || 15));
const includeGroups = () => settings().includeGroups === true;
const notifyOn = () => settings().notify !== false;
const minutesOf = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(str(hhmm));
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : fallback;
};
const workHours = () => ({ start: minutesOf(settings().workStart, 8 * 60), end: minutesOf(settings().workEnd, 21 * 60) });
const hhmm = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const withinHours = (ts) => {
  const { start, end } = workHours();
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  if (start === end) return true;
  return start < end ? m >= start && m < end : m >= start || m < end;
};

// ---- state: { [account|conversationId]: {account, id, name, isGroup, since, last, text, alerted} } ----
let waiting = null;
const rendered = new Map(); // key → the panel label last shown (memory only: panels are re-drawn after a restart)
const state = () => {
  if (!waiting) {
    const saved = compola.storage.get('waiting');
    waiting = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }
  return waiting;
};

let saveTimer = null;
const save = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    compola.storage.set('waiting', state()).catch((e) => compola.warn('không lưu được danh sách chờ:', e.message || e));
  }, 2000);
};

const prune = (now) => {
  const w = state();
  for (const [key, e] of Object.entries(w)) {
    if (!e || !e.id || !(e.since > 0) || now - e.since > STALE_MS || (e.isGroup && !includeGroups())) {
      delete w[key];
      if (e && e.id) clearPanel(key, e);
    }
  }
  const keys = Object.keys(w);
  if (keys.length > MAX_WAITING) {
    // Too many at once: keep the most recent ones (very old waits are most likely forgotten threads).
    keys.sort((a, b) => w[b].last - w[a].last).slice(MAX_WAITING).forEach((k) => { clearPanel(k, w[k]); delete w[k]; });
  }
};

// ---- views ----
const snapshot = () => {
  const now = Date.now();
  const { start, end } = workHours();
  const items = Object.entries(state())
    .map(([key, e]) => ({ key, id: e.id, account: e.account, name: e.name || e.id, isGroup: !!e.isGroup, text: e.text, since: e.since, last: e.last }))
    .sort((a, b) => a.since - b.since);
  return { now, alertMinutes: alertMinutes(), working: withinHours(now), workStart: hhmm(start), workEnd: hhmm(end), items };
};

let changedTimer = null;
const changed = () => {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    compola.views.post('changed', snapshot()).catch((e) => compola.warn('không cập nhật được trang:', e.message || e));
  }, 800);
};

compola.views.handle('list', async () => snapshot());

// ---- inspector panel ----
const clearPanel = (key, e) => {
  rendered.delete(key);
  compola.ui.panel(e.id, null).catch((err) => compola.warn('không xoá được bảng:', err.message || err));
};

const renderPanel = async (key, e, now) => {
  const alertMs = alertMinutes() * MIN;
  const wait = now - e.since;
  const over = wait >= alertMs;
  const label = `${duration(wait)}|${over}|${alertMinutes()}`;
  if (rendered.get(key) === label) return;
  rendered.set(key, label);
  const blocks = [
    { type: 'kv', items: [
      { label: 'Đã chờ', value: duration(wait) },
      { label: 'Tin chưa trả lời từ', value: timeLabel(e.since) },
    ] },
    { type: 'progress', label: over ? `Đã quá ngưỡng ${alertMinutes()} phút` : `Ngưỡng nhắc: ${alertMinutes()} phút`, value: Math.min(1, wait / alertMs) },
    { type: 'text', text: `“${e.text}”`, muted: true },
  ];
  if (over) blocks.unshift({ type: 'badges', items: ['Quá hạn trả lời'] });
  try {
    await compola.ui.panel(e.id, { title: TITLE, account: e.account || undefined, blocks });
  } catch (err) {
    rendered.delete(key);
    compola.warn('không hiện được bảng chờ:', err.message || err);
  }
};

// ---- alerts ----
const tick = async () => {
  const now = Date.now();
  prune(now);
  const alertMs = alertMinutes() * MIN;
  const open = withinHours(now);
  const due = [];
  for (const [key, e] of Object.entries(state())) {
    if (open && !e.alerted && now - e.since >= alertMs) {
      e.alerted = true;
      due.push(e);
    }
    await renderPanel(key, e, now);
  }
  if (!due.length) return;
  save();
  if (!notifyOn()) return;
  try {
    if (due.length <= 3) {
      for (const e of due) {
        await compola.notify(`${e.name || 'Khách'} đã chờ ${duration(now - e.since)}`, e.text);
        await compola.ui.toast(`${e.name || 'Khách'} đã chờ ${duration(now - e.since)} chưa được trả lời`, { conversationId: e.id, account: e.account || undefined, level: 'warning' });
      }
    } else {
      // Many at once (e.g. the morning after): one notification instead of a burst.
      const names = due.slice(0, 3).map((e) => e.name || 'Khách').join(', ');
      await compola.notify(`${due.length} khách đã chờ quá ${alertMinutes()} phút`, `${names} và ${due.length - 3} khách khác`);
      await compola.ui.toast(`${due.length} khách đã chờ quá ${alertMinutes()} phút — xem trang Khách đang chờ`, { level: 'warning' });
    }
  } catch (err) {
    compola.warn('không gửi được thông báo:', err.message || err);
  }
};

const safeTick = () => tick().catch((e) => compola.warn('lỗi khi kiểm tra khách chờ:', e.message || e));
setInterval(safeTick, 60_000);

// ---- messages ----
const onMessage = async (m) => {
  if (!m || typeof m !== 'object') return;
  const id = str(m.conversationId);
  if (!id) return;
  const account = str(m.account);
  const key = keyOf(account, id);
  const w = state();
  if (m.fromMe) {
    const e = w[key];
    if (!e) return;
    delete w[key];
    clearPanel(key, e);
    save();
    changed();
    return;
  }
  if (m.isGroup && !includeGroups()) return;
  const now = Date.now();
  const date = Number(m.date) > 0 ? Math.min(Number(m.date), now) : now;
  if (now - date > STALE_MS) return;
  const e = w[key];
  if (e) {
    e.since = Math.min(e.since, date);
    e.last = Math.max(e.last || 0, date);
    e.text = preview(m.text);
    if (m.conversationName) e.name = str(m.conversationName).slice(0, 80);
  } else {
    w[key] = { account, id, name: str(m.conversationName || m.senderName).slice(0, 80), isGroup: !!m.isGroup, since: date, last: date, text: preview(m.text), alerted: false };
  }
  save();
  changed();
  await renderPanel(key, w[key], now);
};

compola.on('message', (m) => onMessage(m).catch((e) => compola.warn('lỗi khi xử lý tin nhắn:', e.message || e)));

// ---- seeding: who is waiting right now (after a start, the app was closed, or the add-on was off) ----
let seeding = null;
const seedOnce = async () => {
  const now = Date.now();
  const since = now - DAY;
  const w = state();
  const visited = new Set();
  let accounts = [];
  try {
    const list = await compola.accounts();
    accounts = (Array.isArray(list) ? list : []).map((a) => a && str(a.id)).filter(Boolean);
  } catch (e) {
    compola.warn('không đọc được danh sách tài khoản:', e.message || e);
  }
  if (!accounts.length) accounts = [''];

  const check = async (account, conv) => {
    const id = str(conv.id);
    const key = keyOf(account, id);
    visited.add(key);
    const from = Math.min(since, w[key] ? w[key].since - 1 : since);
    let list;
    try {
      list = await compola.history(id, { since: from, limit: 30, ...(account ? { account } : {}) });
    } catch (e) {
      compola.warn('không đọc được lịch sử', conv.name || id, e.message || e);
      return;
    }
    if (!Array.isArray(list) || !list.length) return;
    const last = list[list.length - 1];
    if (!last || last.fromMe) {
      if (w[key]) { clearPanel(key, w[key]); delete w[key]; }
      return;
    }
    let i = list.length - 1;
    while (i > 0 && list[i - 1] && !list[i - 1].fromMe) i--;
    const firstDate = Number(list[i] && list[i].date) || Number(last.date) || now;
    const prev = w[key];
    w[key] = {
      account, id,
      name: str(conv.name || last.conversationName || last.senderName || (prev && prev.name)).slice(0, 80),
      isGroup: !!(conv.isGroup ?? last.isGroup),
      since: prev ? Math.min(prev.since, firstDate) : firstDate,
      last: Number(last.date) || now,
      text: preview(last.text),
      alerted: prev ? !!prev.alerted : false,
    };
  };

  for (const account of accounts) {
    let convs = [];
    try {
      convs = await compola.activeConversations({ since, limit: 150, ...(account ? { account } : {}) });
    } catch (e) {
      compola.warn('không đọc được hội thoại gần đây:', e.message || e);
    }
    for (const c of Array.isArray(convs) ? convs : []) {
      if (!c || !c.id || (c.isGroup && !includeGroups())) continue;
      await check(str(c.account || account), c);
      await sleep(10);
    }
  }
  // Entries older than the last day: still waiting, or answered while Compola was closed?
  for (const [key, e] of Object.entries(w)) {
    if (visited.has(key) || !e || !e.id) continue;
    await check(e.account || '', { id: e.id, name: e.name, isGroup: e.isGroup });
    await sleep(10);
  }
  save();
  changed();
  await tick();
};
const seed = () => {
  if (!seeding) seeding = seedOnce().catch((e) => compola.warn('lỗi khi tìm khách đang chờ:', e.message || e)).finally(() => { seeding = null; });
  return seeding;
};

compola.on('ready', () => { seed(); });

compola.on('settings', async () => {
  try {
    rendered.clear();
    prune(Date.now());
    save();
    changed();
    await seed(); // groups may have been turned on
  } catch (e) {
    compola.warn('lỗi khi áp dụng cài đặt:', e.message || e);
  }
});

compola.on('unload', async () => {
  try {
    if (waiting) await compola.storage.set('waiting', waiting);
  } catch (e) {
    compola.warn('không lưu được danh sách chờ:', e.message || e);
  }
});
