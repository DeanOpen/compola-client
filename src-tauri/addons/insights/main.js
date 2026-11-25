// Thống kê tin nhắn — built-in Compola add-on: a dashboard of the account's messaging (tab view) and per-conversation
// stats (inspector view). Aggregates are kept in storage and updated from `message` events; the first start backfills
// the last 14 days from the message index.
//
// storage:
//   days    { 'YYYY-MM-DD': [in, out] }                      last KEEP_DAYS days
//   heat    { '<monday YYYY-MM-DD>': [168 incoming counts] } Monday-first, hour of the week; last HEAT_WEEKS weeks
//   convs   { 'account|id': {id, a, n, g, l, d: {'YYYY-MM-DD': [in, out]}} }  at most MAX_CONVS, by recent activity
//   rt      [[answeredAt, ms], …]                             first-response times (direct chats), last RT_DAYS days
//   pending { 'account|id': firstUnansweredIncomingAt }
//   meta    { backfilled }

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEEP_DAYS = 35;
const CONV_DAYS = 31;
const HEAT_WEEKS = 5;
const MAX_CONVS = 300;
const KEEP_CONVS = 250;
const RT_DAYS = 15;
const MAX_RT = 5000;
const MAX_RT_MS = 48 * HOUR;
const MAX_PENDING = 400;
const BACKFILL_DAYS = 14;

const str = (v) => (v == null ? '' : String(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** Local midnight `back` days before the day of `ts`. */
const dayStart = (ts, back = 0) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime(); };
const mondayKey = (ts) => dayKey(dayStart(ts, (new Date(ts).getDay() + 6) % 7));
const slotOf = (ts) => { const d = new Date(ts); return ((d.getDay() + 6) % 7) * 24 + d.getHours(); };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ---- state ----
const S = { days: {}, heat: {}, convs: {}, rt: [], pending: {}, meta: {} };
let loaded = false;
const ensure = () => {
  if (loaded) return;
  loaded = true;
  for (const k of Object.keys(S)) {
    const v = compola.storage.get(k);
    if (Array.isArray(S[k]) ? Array.isArray(v) : isObj(v)) S[k] = v;
  }
};

const dirty = new Set();
let flushTimer = null;
const touch = (...keys) => {
  keys.forEach((k) => dirty.add(k));
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 4000);
};
const flush = async () => {
  try { prune(Date.now()); } catch (e) { compola.warn('lỗi khi dọn dữ liệu cũ:', e.message || e); }
  const keys = [...dirty];
  dirty.clear();
  for (const k of keys) {
    try { await compola.storage.set(k, S[k]); } catch (e) { compola.warn('không lưu được', k, e.message || e); }
  }
};

const prune = (now) => {
  const oldestDay = dayKey(dayStart(now, KEEP_DAYS));
  for (const k of Object.keys(S.days)) if (k < oldestDay) delete S.days[k];
  const weeks = Object.keys(S.heat).sort();
  for (const k of weeks.slice(0, Math.max(0, weeks.length - HEAT_WEEKS))) delete S.heat[k];
  const oldestConvDay = dayKey(dayStart(now, CONV_DAYS));
  for (const [key, c] of Object.entries(S.convs)) {
    if (!isObj(c) || !isObj(c.d)) { delete S.convs[key]; continue; }
    for (const k of Object.keys(c.d)) if (k < oldestConvDay) delete c.d[k];
    if (!Object.keys(c.d).length) delete S.convs[key];
  }
  const convKeys = Object.keys(S.convs);
  if (convKeys.length > MAX_CONVS) {
    convKeys.sort((a, b) => (S.convs[b].l || 0) - (S.convs[a].l || 0)).slice(KEEP_CONVS).forEach((k) => delete S.convs[k]);
  }
  const rtFrom = now - RT_DAYS * DAY;
  S.rt = S.rt.filter((r) => Array.isArray(r) && r[0] >= rtFrom).slice(-MAX_RT);
  for (const [k, at] of Object.entries(S.pending)) if (!(at > now - MAX_RT_MS)) delete S.pending[k];
  const pend = Object.keys(S.pending);
  if (pend.length > MAX_PENDING) pend.sort((a, b) => S.pending[b] - S.pending[a]).slice(MAX_PENDING).forEach((k) => delete S.pending[k]);
};

// ---- counting ----
const recent = []; // [{fp, date}] of the last live messages: the same message can arrive as a preview and from the chat
const isDuplicate = (key, m, date) => {
  const fp = `${key}|${m.fromMe ? 1 : 0}|${m.id ? 'id:' + m.id : ''}`;
  const tp = `${key}|${m.fromMe ? 1 : 0}|${str(m.text).trim().slice(0, 200)}`;
  const dup = recent.some((r) => (m.id && r.fp === fp) || (r.tp === tp && Math.abs(r.date - date) < 5000));
  recent.push({ fp, tp, date });
  if (recent.length > 300) recent.splice(0, recent.length - 300);
  return dup;
};

/** Adds one message to every aggregate. */
const ingest = (m, { live }) => {
  if (!isObj(m)) return false;
  const id = str(m.conversationId);
  if (!id) return false;
  const now = Date.now();
  const date = Number(m.date) > 0 ? Math.min(Number(m.date), now) : now;
  if (date < dayStart(now, KEEP_DAYS)) return false;
  const account = str(m.account);
  const key = `${account}|${id}`;
  if (live && isDuplicate(key, m, date)) return false;
  const fromMe = !!m.fromMe;
  const col = fromMe ? 1 : 0;
  const dk = dayKey(date);

  const day = Array.isArray(S.days[dk]) ? S.days[dk] : (S.days[dk] = [0, 0]);
  day[col] = (day[col] || 0) + 1;
  if (!fromMe) {
    const wk = mondayKey(date);
    if (!Array.isArray(S.heat[wk]) || S.heat[wk].length !== 168) S.heat[wk] = new Array(168).fill(0);
    S.heat[wk][slotOf(date)]++;
  }
  const c = isObj(S.convs[key]) ? S.convs[key] : (S.convs[key] = { id, a: account, n: '', g: false, l: 0, d: {} });
  if (!isObj(c.d)) c.d = {};
  if (m.conversationName) c.n = str(m.conversationName).slice(0, 80);
  else if (!c.n && !fromMe && m.senderName) c.n = str(m.senderName).slice(0, 80);
  if (typeof m.isGroup === 'boolean') c.g = m.isGroup;
  c.l = Math.max(c.l || 0, date);
  const cd = Array.isArray(c.d[dk]) ? c.d[dk] : (c.d[dk] = [0, 0]);
  cd[col] = (cd[col] || 0) + 1;

  // First-response time: an incoming message (the first of a run) → the next message from us. Direct chats only.
  if (!c.g) {
    if (!fromMe) {
      if (!(S.pending[key] > 0)) S.pending[key] = date;
    } else if (S.pending[key] > 0) {
      const ms = date - S.pending[key];
      delete S.pending[key];
      if (ms >= 0 && ms <= MAX_RT_MS) S.rt.push([date, ms]);
    }
  }
  return true;
};

// ---- live updates ----
const changedConvs = new Set();
let changedTimer = null;
const changed = (conversationId) => {
  if (conversationId) changedConvs.add(conversationId);
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    const conversations = [...changedConvs].slice(0, 200);
    changedConvs.clear();
    compola.views.post('changed', { conversations }).catch((e) => compola.warn('không cập nhật được trang thống kê:', e.message || e));
  }, 5000);
};

compola.on('message', (m) => {
  try {
    ensure();
    if (ingest(m, { live: true })) {
      touch('days', 'heat', 'convs', 'rt', 'pending');
      changed(str(m.conversationId));
    }
  } catch (e) {
    compola.warn('lỗi khi đếm tin nhắn:', e.message || e);
  }
});

// ---- backfill (once) ----
let backfilling = false;
const backfill = async () => {
  ensure();
  if (S.meta.backfilled || backfilling) return;
  backfilling = true;
  const start = Date.now();
  const since = dayStart(start, BACKFILL_DAYS);
  let total = 0;
  try {
    let accounts = [];
    try {
      const list = await compola.accounts();
      accounts = (Array.isArray(list) ? list : []).map((a) => a && str(a.id)).filter(Boolean);
    } catch (e) {
      compola.warn('không đọc được danh sách tài khoản:', e.message || e);
    }
    if (!accounts.length) accounts = [''];
    for (const account of accounts) {
      let convs = [];
      try {
        convs = await compola.activeConversations({ since, limit: 100, ...(account ? { account } : {}) });
      } catch (e) {
        compola.warn('không đọc được hội thoại gần đây:', e.message || e);
      }
      for (const c of Array.isArray(convs) ? convs : []) {
        if (!c || !c.id) continue;
        const acc = str(c.account || account);
        let list = [];
        try {
          // Only what came before this start: later messages arrive as live events.
          list = await compola.history(str(c.id), { since, until: start, limit: 200, ...(acc ? { account: acc } : {}) });
        } catch (e) {
          compola.warn('không đọc được lịch sử', c.name || c.id, e.message || e);
        }
        for (const m of Array.isArray(list) ? list : []) {
          if (!isObj(m) || !(Number(m.date) < start)) continue;
          const ok = ingest({ ...m, conversationId: m.conversationId || c.id, account: acc, conversationName: m.conversationName || c.name,
                              isGroup: typeof m.isGroup === 'boolean' ? m.isGroup : !!c.isGroup }, { live: false });
          if (ok) total++;
        }
        await sleep(20); // let live events and view calls through between conversations
      }
    }
    compola.log(`đã nạp ${total} tin nhắn của ${BACKFILL_DAYS} ngày qua`);
  } catch (e) {
    compola.warn('lỗi khi nạp dữ liệu cũ:', e.message || e);
  } finally {
    backfilling = false;
    S.meta.backfilled = Date.now();
    touch('meta', 'days', 'heat', 'convs', 'rt', 'pending');
    changed();
  }
};

compola.on('ready', () => {
  try {
    ensure();
    prune(Date.now());
  } catch (e) {
    compola.warn('lỗi khi đọc dữ liệu:', e.message || e);
  }
  backfill();
});

compola.on('unload', () => flush());
setInterval(() => { try { prune(Date.now()); touch('days'); } catch (e) { compola.warn('lỗi khi dọn dữ liệu cũ:', e.message || e); } }, HOUR);

// ---- stats ----
const quantile = (list, q) => {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (pos - lo));
};
const rtStats = (from, until) => {
  const list = S.rt.filter((r) => r[0] >= from && r[0] < until).map((r) => r[1]);
  return { median: quantile(list, 0.5), p90: quantile(list, 0.9), count: list.length };
};
const sumDays = (d, from, to) => { // d: {dayKey: [in, out]}, days `from`..`to` back from today (inclusive)
  const now = Date.now();
  let i = 0, o = 0;
  for (let b = from; b <= to; b++) {
    const v = d[dayKey(dayStart(now, b))];
    if (Array.isArray(v)) { i += v[0] || 0; o += v[1] || 0; }
  }
  return [i, o];
};

const dashboard = (range) => {
  ensure();
  const now = Date.now();
  const days = [];
  for (let b = range - 1; b >= 0; b--) {
    const t = dayStart(now, b);
    const v = S.days[dayKey(t)] || [0, 0];
    days.push({ date: t, in: v[0] || 0, out: v[1] || 0 });
  }
  const [inToday, outToday] = sumDays(S.days, 0, 0);
  const [inYesterday, outYesterday] = sumDays(S.days, 1, 1);
  const [rangeIn, rangeOut] = sumDays(S.days, 0, range - 1);
  const [prevIn, prevOut] = sumDays(S.days, range, 2 * range - 1);

  const convs = Object.values(S.convs).filter(isObj);
  const activeIn = (from, to) => convs.filter((c) => { const [i, o] = sumDays(c.d || {}, from, to); return i + o > 0; }).length;
  const top = convs
    .map((c) => { const [i, o] = sumDays(c.d || {}, 0, range - 1); return { id: c.id, account: c.a, name: c.n || c.id, isGroup: !!c.g, in: i, out: o, last: c.l }; })
    .filter((c) => c.in + c.out > 0)
    .sort((a, b) => b.in + b.out - (a.in + a.out) || b.last - a.last)
    .slice(0, 10);

  const heat = new Array(168).fill(0);
  const fromWeek = mondayKey(dayStart(now, 21));
  let heatWeeks = 0;
  for (const [wk, arr] of Object.entries(S.heat)) {
    if (wk < fromWeek || !Array.isArray(arr)) continue;
    heatWeeks++;
    for (let i = 0; i < 168; i++) heat[i] += arr[i] || 0;
  }

  const today = dayStart(now);
  return {
    now,
    range,
    backfilling,
    since: Object.keys(S.days).sort()[0] || null,
    kpi: {
      inToday, inYesterday, outToday, outYesterday,
      active7: activeIn(0, 6), activePrev7: activeIn(7, 13),
      rtToday: rtStats(today, now + 1),
      rt7: rtStats(dayStart(now, 6), now + 1),
      rtPrev7: rtStats(dayStart(now, 13), dayStart(now, 6)),
    },
    totals: { in: rangeIn, out: rangeOut, prevIn, prevOut },
    days,
    heat,
    heatWeeks,
    top,
  };
};

compola.views.handle('dashboard', async (data) => {
  const r = Number(data && data.range);
  return dashboard([7, 14, 30].includes(r) ? r : 14);
});

/** One conversation, straight from the message index (exact, and nothing to store). */
compola.views.handle('conversation', async (data, ctx) => {
  const id = str((data && data.conversationId) || (ctx && ctx.conversationId));
  if (!id) return { empty: true };
  const account = str((data && data.account) || (ctx && ctx.account));
  const now = Date.now();
  const since = dayStart(now, 29);
  const list = await compola.history(id, { since, limit: 2000, ...(account ? { account } : {}) });
  const msgs = (Array.isArray(list) ? list : []).filter(isObj);
  const isGroup = typeof (data && data.isGroup) === 'boolean' ? data.isGroup : msgs.some((m) => m.isGroup);
  const spark = [];
  const index = new Map();
  for (let b = 29; b >= 0; b--) { const k = dayKey(dayStart(now, b)); index.set(k, spark.length); spark.push({ date: dayStart(now, b), in: 0, out: 0 }); }
  let inc = 0, out = 0, pendingAt = 0;
  const rts = [];
  for (const m of msgs) {
    const date = Number(m.date) || 0;
    const slot = index.get(dayKey(date));
    if (m.fromMe) {
      out++;
      if (slot != null) spark[slot].out++;
      if (pendingAt) { const ms = date - pendingAt; if (ms >= 0 && ms <= MAX_RT_MS) rts.push(ms); pendingAt = 0; }
    } else {
      inc++;
      if (slot != null) spark[slot].in++;
      if (!pendingAt) pendingAt = date;
    }
  }
  const last = msgs[msgs.length - 1];
  return {
    now,
    in: inc,
    out,
    isGroup,
    capped: msgs.length >= 2000,
    rtMedian: isGroup ? null : quantile(rts, 0.5),
    rtCount: isGroup ? 0 : rts.length,
    waitingSince: last && !last.fromMe ? pendingAt || null : null,
    lastDate: last ? Number(last.date) || null : null,
    spark,
  };
});
