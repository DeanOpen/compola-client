// Trả lời bằng AI — built-in Compola add-on: debounced AI replies with human handoff.

const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const inWindow = (from, to, date = new Date()) => {
  const a = minutes(from), b = minutes(to);
  if (a === null || b === null || a === b) return true;
  const now = date.getHours() * 60 + date.getMinutes();
  return a < b ? now >= a && now < b : now >= a || now < b;
};

const key = (m) => `${m.account || ''}|${m.conversationId}`;
const pending = new Map(); // key → timer
const busy = new Set(); // key while a reply is being written
const lastHuman = new Map(); // key → when a person (not an add-on) last replied

const allowed = (m) => {
  const s = compola.settings;
  if (s.onlyDirect && m.isGroup) return false;
  const only = Array.isArray(s.conversations) ? s.conversations.filter(Boolean) : [];
  return !only.length || only.includes(m.conversationId);
};

const escalation = (text) => {
  const t = fold(text);
  return String(compola.settings.escalateKeywords || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .find((k) => t.includes(fold(k)));
};

const SYSTEM = (s) => `${s.instructions || ''}

${s.knowledge ? `Thông tin công ty (chỉ dùng thông tin này, không bịa thêm):\n${s.knowledge}\n` : ''}
Bạn nhận lịch sử trò chuyện Zalo với một khách hàng và viết câu trả lời tiếp theo của phía doanh nghiệp, bằng ngôn ngữ của khách.
Trả về JSON: {"reply": "câu trả lời", "confident": true|false, "needsHuman": true|false, "reason": "ngắn gọn"}.
confident = false khi thông tin không đủ để trả lời chính xác; needsHuman = true khi khách cần người thật (khiếu nại, thanh toán, yêu cầu đặc biệt).`;

/** Writes a reply for the conversation's latest messages → {reply, confident, needsHuman, reason} or null. */
const draft = async (account, conversationId) => {
  if (!(await compola.ai.available())) {
    compola.warn('AI chưa được bật (Cài đặt › Add-on › AI)');
    return null;
  }
  const s = compola.settings;
  const n = Math.max(4, Math.min(100, Number(s.historyMessages) || 30));
  const history = await compola.history(conversationId, { account, since: Date.now() - 7 * 86400000, limit: n });
  if (!history.length || history[history.length - 1].fromMe) return null;
  const transcript = history
    .map((m) => `${m.fromMe ? 'Doanh nghiệp' : m.senderName || 'Khách'} (${new Date(m.date).toLocaleString('vi-VN')}): ${m.text}`)
    .join('\n');
  const out = await compola.ai.complete({ system: SYSTEM(s), prompt: `Lịch sử trò chuyện:\n${transcript}\n\nViết câu trả lời tiếp theo.`, json: true, maxTokens: 2000, effort: 'low' });
  const v = out.json && typeof out.json === 'object' ? out.json : { reply: out.text, confident: false, needsHuman: false };
  if (!v.reply || !String(v.reply).trim()) return null;
  return { reply: String(v.reply).trim(), confident: !!v.confident, needsHuman: !!v.needsHuman, reason: String(v.reason || '') };
};

const answer = async (m) => {
  const k = key(m);
  if (busy.has(k)) return;
  busy.add(k);
  try {
    const s = compola.settings;
    const handoff = Math.max(0, Number(s.handoffMinutes) || 0) * 60000;
    if (handoff && Date.now() - (lastHuman.get(k) || 0) < handoff) return;
    const hit = escalation(m.text);
    if (hit) {
      await compola.notes.add(m.conversationId, `⚠️ Khách nhắc “${hit}”: cần nhân viên xử lý.\n“${m.text.slice(0, 300)}”`, { account: m.account, tags: ['cần xử lý'] });
      await compola.notify(`Cần nhân viên: ${m.conversationName}`, m.text);
      return;
    }
    const d = await draft(m.account, m.conversationId);
    if (!d) return;
    const auto = s.mode === 'auto' && inWindow(s.activeFrom, s.activeTo) && d.confident && !d.needsHuman;
    if (auto) {
      await compola.sendText(m.conversationId, d.reply, { account: m.account });
      compola.log(`đã trả lời ${m.conversationName}`);
      return;
    }
    await compola.ui.suggest(m.conversationId, d.reply, {
      account: m.account,
      id: 'reply',
      title: d.needsHuman ? 'AI gợi ý · cần người xem' : d.confident ? 'AI gợi ý' : 'AI gợi ý · chưa chắc chắn',
    });
    if (d.needsHuman) await compola.notes.add(m.conversationId, `🙋 AI: ${d.reason || 'khách cần nhân viên hỗ trợ'}`, { account: m.account, key: 'needs-human', tags: ['cần xử lý'] });
  } catch (e) {
    compola.error(`${m.conversationName}: ${e.message || e}`);
  } finally {
    busy.delete(k);
  }
};

compola.on('message', (m) => {
  const k = key(m);
  if (m.fromMe) {
    // A person answered (not an add-on): stand back for a while and drop stale suggestions.
    if (!m.sentBy) {
      lastHuman.set(k, Date.now());
      clearTimeout(pending.get(k));
      pending.delete(k);
      compola.ui.clearSuggestions(m.conversationId, { account: m.account }).catch(() => {});
    }
    return;
  }
  if (!m.text || !allowed(m)) return;
  // Wait until the customer stops typing, then answer their messages once.
  clearTimeout(pending.get(k));
  const delay = Math.max(0, Number(compola.settings.delaySeconds) || 0) * 1000;
  pending.set(k, setTimeout(() => { pending.delete(k); answer(m); }, delay));
});

compola.on('action', async (a) => {
  if (a.actionId !== 'suggest' || !a.conversationId) return;
  try {
    const d = await draft(a.account, a.conversationId);
    if (!d) return compola.ui.toast('Không có tin nhắn mới của khách để trả lời', { conversationId: a.conversationId });
    await compola.ui.suggest(a.conversationId, d.reply, { account: a.account, id: 'reply', title: 'AI gợi ý' });
  } catch (e) {
    compola.ui.toast(`AI: ${e.message || e}`, { conversationId: a.conversationId, level: 'error' });
  }
});

compola.on('suggestion', (s) => compola.log(`gợi ý ${s.outcome === 'sent' ? 'được gửi' : s.outcome === 'used' ? 'được dùng' : 'bị bỏ qua'} bởi ${s.user || 'nhân viên'}`));
