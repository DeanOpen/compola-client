// Nhiệt kế khách hàng — built-in Compola add-on: AI rates the customer's mood per conversation (-2 … 2).
//
// Storage: one key per conversation, `c:<conversationId>` → {id, account, name, isGroup, score, label, reason, urgent,
// t, lastMsgId, notifiedAt, h: [[t, score], …]} (last 20 ratings), at most 300 conversations.

const SCALE = {
  '-2': { emoji: '😡', label: 'Rất không hài lòng' },
  '-1': { emoji: '😟', label: 'Không hài lòng' },
  '0': { emoji: '😐', label: 'Bình thường' },
  '1': { emoji: '🙂', label: 'Hài lòng' },
  '2': { emoji: '😄', label: 'Rất hài lòng' },
};
const HISTORY = 20;
const MAX_CONVERSATIONS = 300;
const NOTIFY_EVERY = 3600000;

const pending = new Map(); // conversationId → debounce timer
const busy = new Set(); // conversationId while the AI is rating it
const spent = []; // times of automatic ratings in the last hour
let aiOffWarned = false;

const str = (v, max = 200) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);
const num = (v, def) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : def);
const hhmm = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};
const keyOf = (id) => `c:${id}`;
const record = (id) => {
  const r = compola.storage.get(keyOf(id));
  return r && typeof r === 'object' ? r : null;
};
const allRecords = () => {
  const all = compola.storage.all() || {};
  return Object.keys(all)
    .filter((k) => k.startsWith('c:'))
    .map((k) => all[k])
    .filter((r) => r && typeof r === 'object' && Number.isFinite(r.score));
};

const allowed = (m) => {
  const s = compola.settings;
  if (m.isGroup && !s.includeGroups) return false;
  const only = Array.isArray(s.conversations) ? s.conversations.filter(Boolean) : [];
  return !only.length || only.includes(m.conversationId);
};

/** Room in the hourly budget for an automatic rating. */
const budgetLeft = () => {
  const hourAgo = Date.now() - 3600000;
  while (spent.length && spent[0] < hourAgo) spent.shift();
  return spent.length < Math.max(1, num(compola.settings.maxPerHour, 30));
};

const SYSTEM = `Bạn là chuyên viên chăm sóc khách hàng giàu kinh nghiệm. Bạn đọc đoạn trò chuyện Zalo giữa doanh nghiệp và một khách hàng và đánh giá cảm xúc HIỆN TẠI của khách (chủ yếu dựa trên các tin nhắn gần nhất của khách).
Trả về đúng một đối tượng JSON, không thêm chữ nào khác:
{"score": số nguyên từ -2 đến 2, "label": "nhãn ngắn tiếng Việt", "reason": "lý do ngắn gọn bằng tiếng Việt, tối đa 120 ký tự", "urgent": true|false}
score: -2 rất bực / giận, -1 không hài lòng / lo lắng, 0 bình thường, 1 hài lòng, 2 rất vui / khen ngợi.
urgent = true khi khách cần nhân viên xử lý ngay (phàn nàn, doạ huỷ đơn, đòi hoàn tiền, chờ lâu chưa được trả lời).`;

const transcript = (history) =>
  history
    .map((m) => `${m.fromMe ? 'Doanh nghiệp' : str(m.senderName, 60) || 'Khách'}: ${str(m.text, 500) || '[tệp / hình ảnh]'}`)
    .join('\n');

/** The panel in the conversation's info panel. */
const showPanel = async (r) => {
  const sc = SCALE[String(r.score)] || SCALE['0'];
  const prev = Array.isArray(r.h) && r.h.length > 1 ? r.h[r.h.length - 2][1] : null;
  const trend = prev == null ? '' : r.score > prev ? ' · đang tốt lên ↑' : r.score < prev ? ' · đang xấu đi ↓' : ' · không đổi →';
  const blocks = [
    { type: 'badges', items: [`${sc.emoji} ${r.label || sc.label}`].concat(r.urgent ? ['⚠️ Cần xử lý gấp'] : []) },
    { type: 'progress', label: 'Mức hài lòng', value: (r.score + 2) / 4 },
  ];
  if (r.reason) blocks.push({ type: 'text', text: r.reason });
  blocks.push({ type: 'text', text: `Đánh giá lúc ${hhmm(r.t)}${trend}`, muted: true });
  blocks.push({ type: 'button', label: 'Đánh giá lại', action: 'rate-now' });
  try {
    await compola.ui.panel(r.id, { title: 'Cảm xúc khách', blocks });
  } catch (e) {
    compola.warn(`không hiện được bảng cảm xúc: ${e.message || e}`);
  }
};

/** Keeps at most MAX_CONVERSATIONS conversations (the least recently rated go first). */
const prune = async () => {
  const all = compola.storage.all() || {};
  const keys = Object.keys(all).filter((k) => k.startsWith('c:'));
  if (keys.length <= MAX_CONVERSATIONS) return;
  keys.sort((a, b) => (num(all[a] && all[a].t, 0)) - (num(all[b] && all[b].t, 0)));
  for (const k of keys.slice(0, keys.length - MAX_CONVERSATIONS)) await compola.storage.remove(k);
};

/**
 * Rates a conversation. opts: {account, name, isGroup, force (manual: ignores the budget and "nothing new")}.
 * → {record} | {skipped: reason} | {error: text}. Never throws.
 */
const rate = async (conversationId, opts = {}) => {
  const id = str(conversationId, 200);
  if (!id) return { error: 'Chưa chọn hội thoại' };
  if (busy.has(id)) return { skipped: 'Đang đánh giá…' };
  busy.add(id);
  try {
    if (!(await compola.ai.available())) {
      if (!aiOffWarned) compola.warn('AI chưa được bật (Cài đặt › Add-on › AI cho add-on)');
      aiOffWarned = true;
      return { error: 'AI chưa được bật trong Cài đặt › Add-on' };
    }
    aiOffWarned = false;
    if (!opts.force && !budgetLeft()) return { skipped: 'Đã hết lượt đánh giá tự động trong giờ này' };
    const old = record(id);
    const raw = await compola.history(id, { account: opts.account || (old && old.account) || undefined, since: Date.now() - 14 * 86400000, limit: HISTORY });
    const history = (Array.isArray(raw) ? raw : []).filter((m) => m && typeof m === 'object');
    const fromCustomer = history.filter((m) => !m.fromMe);
    if (!fromCustomer.length) return { skipped: 'Chưa có tin nhắn nào của khách' };
    const last = fromCustomer[fromCustomer.length - 1];
    const lastId = str(last.id, 200) || `${num(last.date, 0)}`;
    if (!opts.force && old && old.lastMsgId === lastId) return { skipped: 'Không có tin nhắn mới từ lần đánh giá trước' };
    if (!opts.force) spent.push(Date.now());

    const out = await compola.ai.complete({
      system: SYSTEM,
      prompt: `Đoạn trò chuyện (cũ → mới):\n${transcript(history)}\n\nĐánh giá cảm xúc hiện tại của khách.`,
      json: true,
      effort: 'low',
      maxTokens: 400,
    });
    const v = out && out.json && typeof out.json === 'object' && !Array.isArray(out.json) ? out.json : null;
    const score = v ? Math.round(Number(v.score)) : NaN;
    if (!Number.isFinite(score)) {
      compola.warn('AI không trả về điểm cảm xúc hợp lệ');
      return { error: 'AI không trả về kết quả hợp lệ, hãy thử lại' };
    }
    const s = Math.max(-2, Math.min(2, score));
    const now = Date.now();
    const h = (old && Array.isArray(old.h) ? old.h : []).filter((x) => Array.isArray(x) && x.length === 2);
    h.push([now, s]);
    const r = {
      id,
      account: str(opts.account, 200) || (old && old.account) || str(last.account, 200) || '',
      name: str(opts.name, 120) || (old && old.name) || (opts.isGroup ? '' : str(last.senderName, 120)) || 'Hội thoại',
      isGroup: opts.isGroup == null ? !!(old && old.isGroup) : !!opts.isGroup,
      score: s,
      label: str(v.label, 40) || SCALE[String(s)].label,
      reason: str(v.reason, 120),
      urgent: v.urgent === true || v.urgent === 'true',
      t: now,
      lastMsgId: lastId,
      notifiedAt: num(old && old.notifiedAt, 0),
      h: h.slice(-HISTORY),
    };

    if (r.score <= -1 && r.urgent && compola.settings.notifyAngry !== false && now - r.notifiedAt > NOTIFY_EVERY) {
      r.notifiedAt = now;
      try {
        await compola.notify(`${SCALE[String(r.score)].emoji} Khách cần xử lý gấp: ${r.name}`, r.reason || r.label);
      } catch (e) {
        compola.warn(`không gửi được thông báo: ${e.message || e}`);
      }
    }
    await compola.storage.set(keyOf(id), r);
    await prune();
    await showPanel(r);
    try {
      await compola.views.post('mood', { conversationId: id, record: view(r) });
    } catch (e) {
      compola.warn(`không cập nhật được giao diện: ${e.message || e}`);
    }
    return { record: view(r) };
  } catch (e) {
    compola.warn(`đánh giá cảm xúc thất bại: ${e.message || e}`);
    return { error: `Không đánh giá được: ${e.message || e}` };
  } finally {
    busy.delete(id);
  }
};

/** What views see of a record. */
const view = (r) => {
  const h = Array.isArray(r.h) ? r.h.filter((x) => Array.isArray(x) && Number.isFinite(x[1])) : [];
  const prev = h.length > 1 ? h[h.length - 2][1] : null;
  return {
    id: r.id, account: r.account || '', name: r.name || 'Hội thoại', isGroup: !!r.isGroup,
    score: r.score, label: r.label || (SCALE[String(r.score)] || SCALE['0']).label, reason: r.reason || '', urgent: !!r.urgent,
    t: r.t, trend: prev == null ? 0 : Math.sign(r.score - prev), history: h.map((x) => ({ t: x[0], score: x[1] })),
  };
};

compola.on('message', (m) => {
  try {
    if (!m || typeof m !== 'object' || m.fromMe || m.sentBy || !m.conversationId || !allowed(m)) return;
    const id = String(m.conversationId);
    clearTimeout(pending.get(id));
    const wait = Math.max(5, Math.min(3600, num(compola.settings.debounceSeconds, 90))) * 1000;
    const meta = { account: m.account, name: m.isGroup ? m.conversationName : m.conversationName || m.senderName, isGroup: !!m.isGroup };
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id);
        if (!allowed({ conversationId: id, isGroup: meta.isGroup })) return; // settings changed while waiting
        rate(id, meta).catch((e) => compola.warn(`đánh giá cảm xúc thất bại: ${e.message || e}`));
      }, wait),
    );
  } catch (e) {
    compola.warn(`lỗi khi nhận tin nhắn: ${e.message || e}`);
  }
});

compola.on('action', async (a) => {
  try {
    if (!a || a.actionId !== 'rate-now') return;
    if (!a.conversationId) {
      await compola.ui.toast('Hãy mở một hội thoại để đánh giá', { level: 'info' });
      return;
    }
    const res = await rate(a.conversationId, { account: a.account, force: true });
    const r = res.record;
    const text = r ? `${(SCALE[String(r.score)] || SCALE['0']).emoji} ${r.label}${r.reason ? ' — ' + r.reason : ''}` : res.error || res.skipped;
    await compola.ui.toast(text, { conversationId: a.conversationId, account: a.account, level: res.error ? 'error' : 'info' });
  } catch (e) {
    compola.warn(`lỗi khi đánh giá theo yêu cầu: ${e.message || e}`);
  }
});

// ---- views ----

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

compola.views.handle('list', async () => {
  try {
    const items = allRecords().map(view);
    items.sort((a, b) => a.score - b.score || (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || b.t - a.t);
    const today = items.filter((r) => r.t >= startOfToday());
    return {
      items,
      today: {
        total: today.length,
        happy: today.filter((r) => r.score > 0).length,
        neutral: today.filter((r) => r.score === 0).length,
        unhappy: today.filter((r) => r.score < 0).length,
      },
    };
  } catch (e) {
    compola.warn(`không đọc được danh sách: ${e.message || e}`);
    return { items: [], today: { total: 0, happy: 0, neutral: 0, unhappy: 0 } };
  }
});

compola.views.handle('get', async (data, ctx) => {
  const id = str((data && data.conversationId) || (ctx && ctx.conversationId), 200);
  const r = id ? record(id) : null;
  return { record: r && Number.isFinite(r.score) ? view(r) : null, busy: busy.has(id), ai: await compola.ai.available().catch(() => false) };
});

compola.views.handle('rate', async (data, ctx) => {
  const id = str((data && data.conversationId) || (ctx && ctx.conversationId), 200);
  return rate(id, { account: ctx && ctx.account, name: ctx && ctx.conversationName, isGroup: ctx && ctx.isGroup, force: true });
});
