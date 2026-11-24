// Tóm tắt khách hàng hằng ngày — built-in Compola add-on: one summary note per conversation per day.

const JOB = 'daily-summary';
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayLabel = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const transcriptOf = (messages) =>
  messages.map((m) => `${m.fromMe ? 'Doanh nghiệp' : m.senderName || 'Khách'} ${new Date(m.date).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}: ${m.text}`).join('\n');

/** Without AI: the first and last messages of the day from the customer, and our last answer. */
const plainSummary = (messages) => {
  const theirs = messages.filter((m) => !m.fromMe);
  const ours = messages.filter((m) => m.fromMe);
  const lines = [`${messages.length} tin (${theirs.length} từ khách, ${ours.length} từ doanh nghiệp).`];
  for (const m of theirs.slice(0, 3)) lines.push(`• Khách: ${m.text.slice(0, 200)}`);
  if (theirs.length > 3) lines.push(`• … Khách (cuối): ${theirs[theirs.length - 1].text.slice(0, 200)}`);
  if (ours.length) lines.push(`• Trả lời cuối: ${ours[ours.length - 1].text.slice(0, 200)}`);
  return lines.join('\n');
};

const summarize = async (account, conversation, since, until) => {
  const messages = await compola.history(conversation.id, { account, since, until, limit: 400 });
  if (messages.length < Math.max(1, Number(compola.settings.minMessages) || 1)) return null;
  let body;
  if (await compola.ai.available().catch(() => false)) {
    const out = await compola.ai.complete({
      system: `Bạn tóm tắt cuộc trò chuyện Zalo giữa doanh nghiệp và khách cho nhân viên đọc nhanh. Viết tiếng Việt, gạch đầu dòng ngắn, tối đa 8 dòng. Tập trung: ${compola.settings.focus}. Không bịa thông tin.`,
      prompt: `Khách: ${conversation.name || conversation.id}\n\n${transcriptOf(messages)}`,
      maxTokens: 1500,
      effort: 'low',
    });
    body = out.text.trim();
  }
  if (!body) body = plainSummary(messages);
  return { body, count: messages.length };
};

/** Summarizes one conversation for the day of `date` and saves the note (one per day: re-running updates it). */
const summarizeOne = async (account, conversation, date) => {
  const since = startOfDay(date);
  const r = await summarize(account, conversation, since, since + 86400000);
  if (!r) return null;
  await compola.notes.add(conversation.id, `📋 Tóm tắt ${dayLabel(date)} (${r.count} tin)\n${r.body}`, {
    account,
    key: `${JOB}:${dayKey(date)}`,
    pinned: !!compola.settings.pin,
    tags: ['tóm tắt'],
  });
  return r;
};

const runDaily = async () => {
  const s = compola.settings;
  const now = new Date();
  const since = startOfDay(now);
  const only = Array.isArray(s.conversations) ? s.conversations.filter(Boolean) : [];
  const report = [];
  for (const account of await compola.accounts()) {
    const active = await compola.activeConversations({ account: account.id, since, limit: 500 });
    for (const c of active) {
      if (only.length && !only.includes(c.id)) continue;
      if (s.scope !== 'all' && c.isGroup) continue;
      if (c.id === s.reportTo) continue;
      try {
        const r = await summarizeOne(account.id, c, now);
        if (r) report.push(`• ${c.name || c.id} (${r.count} tin): ${r.body.split('\n')[0].replace(/^[-•*]\s*/, '').slice(0, 160)}`);
      } catch (e) {
        compola.error(`${c.name || c.id}: ${e.message || e}`);
      }
    }
  }
  compola.log(`đã tóm tắt ${report.length} hội thoại`);
  if (s.reportTo && report.length) {
    await compola.sendText(s.reportTo, [`📋 Tóm tắt khách hàng ${dayLabel(now)} — ${report.length} hội thoại`, '', ...report].join('\n').slice(0, 4000));
  }
};

/** Keeps exactly one schedule of this add-on, with the cron from settings. */
const syncSchedule = async () => {
  const cron = String(compola.settings.cron || '').trim();
  const mine = (await compola.schedules.list()).filter((j) => j.action.payload && j.action.payload.job === JOB);
  for (const extra of mine.slice(1)) await compola.schedules.remove(extra.id);
  if (!cron) {
    if (mine[0]) await compola.schedules.remove(mine[0].id);
    return;
  }
  if (mine[0] && mine[0].schedule.expr === cron) return;
  await compola.schedules.save({ id: mine[0] ? mine[0].id : undefined, name: 'Tóm tắt khách hàng hằng ngày', cron, payload: { job: JOB } });
};

compola.on('ready', syncSchedule);
compola.on('settings', syncSchedule);
compola.on('schedule', (p) => (p && p.job === JOB ? runDaily() : undefined));

compola.on('action', async (a) => {
  if (a.actionId !== 'summarize' || !a.conversationId) return;
  try {
    const r = await summarizeOne(a.account, { id: a.conversationId, name: '' }, new Date());
    compola.ui.toast(r ? 'Đã lưu tóm tắt hôm nay vào ghi chú' : 'Hôm nay chưa đủ tin nhắn để tóm tắt', { conversationId: a.conversationId });
  } catch (e) {
    compola.ui.toast(`Không tóm tắt được: ${e.message || e}`, { conversationId: a.conversationId, level: 'error' });
  }
});

compola.tools.register(
  {
    name: 'summarize_conversation',
    description: 'Summary of one Zalo conversation for a day (default today). Also saved as a note on the conversation.',
    inputSchema: { type: 'object', properties: { conversationId: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['conversationId'] },
  },
  async ({ conversationId, date }) => {
    const d = date ? new Date(`${date}T12:00:00`) : new Date();
    const r = await summarizeOne(undefined, { id: conversationId, name: '' }, d);
    return r ? r.body : 'Không đủ tin nhắn để tóm tắt.';
  },
);
