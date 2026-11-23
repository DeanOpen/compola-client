// Cảnh báo từ khoá — built-in Compola add-on.

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

/** [{word as typed, folded}] — matched folded, shown as typed. */
const keywords = () =>
  String(compola.settings.keywords || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((word) => ({ word, folded: fold(word) }));

compola.on('message', async (m) => {
  const s = compola.settings;
  if (!m.text || (m.fromMe && !s.includeMine)) return;
  if (s.forwardTo && m.conversationId === s.forwardTo) return; // never alert on our own forwards
  const text = fold(m.text);
  const match = keywords().find((k) => text.includes(k.folded));
  if (!match) return;
  const hit = match.word;
  const who = m.isGroup ? `${m.conversationName}${m.senderName ? ' · ' + m.senderName : ''}` : m.conversationName;
  if (s.notify) compola.notify(`Từ khoá “${hit}” — ${who}`, m.text);
  if (s.forwardTo) {
    try {
      await compola.sendText(s.forwardTo, `🔔 [${hit}] ${who}: ${m.text}`);
    } catch (e) {
      compola.log(`chuyển tiếp thất bại: ${e.message || e}`);
    }
  }
});
