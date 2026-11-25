// Gửi sang Webhook — built-in Compola add-on: POSTs each matching message as JSON to the address the user typed in.
//
// The host lets `fetch` reach only the host of the `url` setting (no `hosts` in the manifest), never a private or
// loopback address, and refuses redirects elsewhere. Delivery: a queue kept in storage (500 at most, the oldest are
// dropped and counted), one request at a time in order, retried with backoff 5 s … 10 min on network errors, 5xx and
// 429; other 4xx are given up with a warning. Storage: `queue` [{id, body, tries, next, at}], `stats`.

const MAX_QUEUE = 500;
const MAX_TEXT = 8000;
const MIN_BACKOFF = 5000;
const MAX_BACKOFF = 600000;
const MAX_AGE = 24 * 3600000; // a message still not delivered after a day is given up

const str = (v, max = 500) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const short = (s, max = 200) => str(s, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);

let queue = Array.isArray(compola.storage.get('queue')) ? compola.storage.get('queue').filter((q) => q && typeof q.body === 'string') : [];
const loaded = compola.storage.get('stats');
const stats = Object.assign({ sent: 0, failed: 0, dropped: 0, lastError: '', lastErrorAt: 0, lastSuccessAt: 0, lastStatus: 0 }, loaded && typeof loaded === 'object' ? loaded : {});
let seq = 0;
let sending = false;
let retryTimer = null;
let nextRetryAt = 0;
let warnedUrl = '';

/** The webhook address when it is usable (https), else null. */
const target = () => {
  const u = str(compola.settings.url, 2000).trim();
  return /^https:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i.test(u) ? u : null;
};
const hostOf = (u) => {
  const m = /^https?:\/\/([^\s/?#]+)/i.exec(String(u || '').trim());
  return m ? m[1].replace(/^[^@]*@/, '').toLowerCase() : '';
};
/** Logs once per bad value why nothing is sent. */
const explainNoTarget = () => {
  const u = str(compola.settings.url, 2000).trim();
  if (warnedUrl === (u || '(empty)')) return;
  warnedUrl = u || '(empty)';
  if (!u) compola.log('chưa nhập địa chỉ webhook: chưa gửi gì');
  else compola.warn('địa chỉ webhook phải bắt đầu bằng https:// — chưa gửi gì');
};

const save = async () => {
  try {
    await compola.storage.set('queue', queue);
    await compola.storage.set('stats', stats);
  } catch (e) {
    compola.warn(`không lưu được hàng đợi: ${e.message || e}`);
  }
};

const status = () => {
  const u = str(compola.settings.url, 2000).trim();
  return {
    configured: !!target(),
    url: u ? hostOf(u) : '',
    urlProblem: !u ? 'empty' : target() ? '' : 'not-https',
    queue: queue.length,
    sent: stats.sent,
    failed: stats.failed,
    dropped: stats.dropped,
    lastError: stats.lastError,
    lastErrorAt: stats.lastErrorAt,
    lastSuccessAt: stats.lastSuccessAt,
    nextRetryAt: queue.length && nextRetryAt > Date.now() ? nextRetryAt : 0,
    sending,
  };
};

let postTimer = null;
/** Tells an open settings view (best effort, at most every 500 ms). */
const notifyViews = () => {
  if (postTimer) return;
  postTimer = setTimeout(() => {
    postTimer = null;
    compola.views.post('status', status()).catch(() => {}); // no view open: nothing to tell
  }, 500);
};

const headers = () => {
  const h = { 'Content-Type': 'application/json', 'User-Agent': 'Compola-Webhook/1.0' };
  const token = str(compola.settings.token, 4000).trim();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
};

/** One POST → {ok, retry, status, error}. Never throws. */
const post = async (url, body) => {
  try {
    const r = await fetch(url, { method: 'POST', headers: headers(), body, timeoutMs: 20000 });
    const code = Number(r && r.status) || 0;
    if (code >= 200 && code < 300) return { ok: true, status: code };
    let detail = '';
    try { detail = short(await r.text(), 160); } catch (e) { /* no body */ }
    const error = `HTTP ${code}${r.statusText ? ' ' + r.statusText : ''}${detail ? ': ' + detail : ''}`;
    return { ok: false, retry: code === 429 || code >= 500 || code === 408 || code === 0, status: code, error };
  } catch (e) {
    return { ok: false, retry: true, status: 0, error: short((e && e.message) || e, 200) || 'lỗi mạng' };
  }
};

const schedule = (at) => {
  clearTimeout(retryTimer);
  nextRetryAt = at;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    pump().catch((e) => compola.warn(`lỗi khi gửi webhook: ${e.message || e}`));
  }, Math.max(0, at - Date.now()));
};

/** Sends the queue in order until it is empty or a delivery has to wait. */
const pump = async () => {
  if (sending) return;
  const url = target();
  if (!url) {
    if (queue.length) explainNoTarget();
    return;
  }
  sending = true;
  try {
    while (queue.length) {
      const item = queue[0];
      const now = Date.now();
      if (now - (Number(item.at) || now) > MAX_AGE) {
        queue.shift();
        stats.failed++;
        stats.lastError = 'Bỏ một tin vì gửi không được sau 24 giờ';
        stats.lastErrorAt = now;
        compola.warn('bỏ một tin chưa gửi được sau 24 giờ');
        continue;
      }
      if ((Number(item.next) || 0) > now) {
        schedule(item.next);
        break;
      }
      const res = await post(url, item.body);
      if (res.ok) {
        if (queue[0] === item) queue.shift();
        stats.sent++;
        stats.lastSuccessAt = Date.now();
        stats.lastStatus = res.status;
        nextRetryAt = 0;
      } else if (res.retry) {
        item.tries = (Number(item.tries) || 0) + 1;
        const wait = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** Math.min(item.tries - 1, 10));
        item.next = Date.now() + wait;
        stats.lastError = res.error;
        stats.lastErrorAt = Date.now();
        stats.lastStatus = res.status;
        if (item.tries === 1 || item.tries % 5 === 0) compola.warn(`gửi webhook chưa được (${res.error}), thử lại sau ${Math.round(wait / 1000)} giây`);
        await save();
        notifyViews();
        schedule(item.next);
        break;
      } else {
        if (queue[0] === item) queue.shift();
        stats.failed++;
        stats.lastError = res.error;
        stats.lastErrorAt = Date.now();
        stats.lastStatus = res.status;
        compola.warn(`webhook từ chối tin (${res.error}): bỏ qua tin này`);
      }
      await save();
      notifyViews();
    }
  } finally {
    sending = false;
  }
};

const enqueue = async (payload) => {
  queue.push({ id: `${Date.now()}-${++seq}`, body: JSON.stringify(payload), tries: 0, next: 0, at: Date.now() });
  if (queue.length > MAX_QUEUE) {
    const n = queue.length - MAX_QUEUE;
    queue.splice(0, n);
    stats.dropped += n;
    if (stats.dropped === n || stats.dropped % 50 === 0) compola.warn(`hàng đợi webhook đầy (${MAX_QUEUE} tin): đã bỏ ${stats.dropped} tin cũ nhất`);
  }
  await save();
  notifyViews();
};

const wanted = (m) => {
  const s = compola.settings;
  if (m.fromMe ? s.outgoing !== true : s.incoming === false) return false;
  if (m.isGroup && s.includeGroups !== true) return false;
  const only = Array.isArray(s.only) ? s.only.filter(Boolean) : [];
  return !only.length || only.includes(m.conversationId);
};

compola.on('message', async (m) => {
  try {
    if (!m || typeof m !== 'object' || !m.conversationId || !wanted(m)) return;
    if (!target()) {
      explainNoTarget();
      return;
    }
    await enqueue({
      event: 'message',
      account: str(m.account, 200),
      conversationId: str(m.conversationId, 200),
      conversationName: str(m.conversationName, 200),
      isGroup: !!m.isGroup,
      senderName: str(m.senderName, 200),
      fromMe: !!m.fromMe,
      text: str(m.text, MAX_TEXT),
      date: Number.isFinite(Number(m.date)) ? Number(m.date) : Date.now(),
      messageId: str(m.id, 200),
    });
    await pump();
  } catch (e) {
    compola.warn(`lỗi khi xếp tin vào hàng đợi: ${e.message || e}`);
  }
});

/** A test request sent right away (not queued) → {ok, text}. */
const sendTest = async (ctx = {}) => {
  const url = target();
  if (!url) {
    const u = str(compola.settings.url, 2000).trim();
    return { ok: false, text: u ? 'Địa chỉ webhook phải bắt đầu bằng https://' : 'Chưa nhập địa chỉ webhook (https://…) trong tuỳ chỉnh' };
  }
  const res = await post(url, JSON.stringify({
    event: 'test',
    account: str(ctx.account, 200),
    conversationId: str(ctx.conversationId, 200),
    text: 'Tin thử từ Compola',
    date: Date.now(),
  }));
  if (res.ok) {
    stats.lastSuccessAt = Date.now();
    stats.lastStatus = res.status;
    await save();
    notifyViews();
    if (queue.length) pump().catch((e) => compola.warn(`lỗi khi gửi webhook: ${e.message || e}`));
    return { ok: true, text: `Gửi thử thành công tới ${hostOf(url)} (HTTP ${res.status})` };
  }
  stats.lastError = res.error;
  stats.lastErrorAt = Date.now();
  stats.lastStatus = res.status;
  await save();
  notifyViews();
  return { ok: false, text: `Gửi thử thất bại: ${res.error}` };
};

compola.on('action', async (a) => {
  try {
    if (!a || a.actionId !== 'test') return;
    const r = await sendTest({ account: a.account, conversationId: a.conversationId });
    await compola.ui.toast(r.text, { conversationId: a.conversationId || undefined, account: a.account || undefined, level: r.ok ? 'info' : 'error' });
  } catch (e) {
    compola.warn(`gửi thử thất bại: ${e.message || e}`);
  }
});

compola.on('settings', async () => {
  try {
    warnedUrl = '';
    // A new address (or one fixed) gets the queue going again now.
    queue.forEach((q) => { q.next = 0; });
    clearTimeout(retryTimer);
    nextRetryAt = 0;
    notifyViews();
    if (target()) await pump();
  } catch (e) {
    compola.warn(`lỗi khi đổi tuỳ chỉnh: ${e.message || e}`);
  }
});

compola.views.handle('status', async () => status());
compola.views.handle('test', async (data, ctx) => {
  const r = await sendTest({ account: ctx && ctx.account, conversationId: ctx && ctx.conversationId });
  return Object.assign({ result: r }, status());
});
compola.views.handle('clear', async () => {
  const n = queue.length;
  queue = [];
  clearTimeout(retryTimer);
  nextRetryAt = 0;
  await save();
  if (n) compola.log(`đã xoá ${n} tin trong hàng đợi`);
  return status();
});
// Whatever was left in the queue when the add-on stopped goes out once it starts again.
if (queue.length) setTimeout(() => pump().catch((e) => compola.warn(`lỗi khi gửi webhook: ${e.message || e}`)), 2000);
