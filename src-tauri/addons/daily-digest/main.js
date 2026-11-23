// Tóm tắt hằng ngày — built-in Compola add-on: a schedule, the message feed and an MCP tool.

const JOB = 'digest';

const digest = async (since) => {
  const all = await compola.messages(null, 500);
  const fresh = all.filter((m) => !m.fromMe && m.date > since && m.conversationId !== compola.settings.target);
  if (!fresh.length) return null;
  const by = new Map();
  for (const m of fresh) {
    const row = by.get(m.conversationId) || { name: m.conversationName || m.conversationId, items: [] };
    row.items.push(m);
    by.set(m.conversationId, row);
  }
  const max = Math.max(1, Number(compola.settings.maxPerConversation) || 3);
  const lines = [`📋 Tóm tắt ${fresh.length} tin nhắn từ ${by.size} hội thoại:`];
  for (const { name, items } of [...by.values()].sort((a, b) => b.items.length - a.items.length)) {
    lines.push('', `• ${name} (${items.length})`);
    for (const m of items.slice(-max)) lines.push(`   – ${m.senderName ? m.senderName + ': ' : ''}${m.text.slice(0, 160)}`);
  }
  return lines.join('\n');
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
  await compola.schedules.save({ id: mine[0] ? mine[0].id : undefined, name: 'Tóm tắt hằng ngày', cron, payload: { job: JOB } });
};

compola.on('ready', syncSchedule);
compola.on('settings', syncSchedule);

compola.on('schedule', async (payload) => {
  if (!payload || payload.job !== JOB) return;
  const since = compola.storage.get('lastDigest') || Date.now() - 86400000;
  const text = await digest(since);
  await compola.storage.set('lastDigest', Date.now());
  if (!text) return compola.log('không có tin nhắn mới');
  if (!compola.settings.target) return compola.log('chưa chọn hội thoại nhận bản tóm tắt');
  await compola.sendText(compola.settings.target, text);
});

compola.tools.register(
  {
    name: 'digest',
    description: 'Summary of incoming Zalo messages since `hours` ago, grouped by conversation.',
    inputSchema: { type: 'object', properties: { hours: { type: 'number', default: 24 } } },
  },
  async ({ hours = 24 }) => (await digest(Date.now() - Number(hours) * 3600000)) || 'Không có tin nhắn mới.',
);
