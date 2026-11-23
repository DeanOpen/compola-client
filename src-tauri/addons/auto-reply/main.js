// Trả lời tự động — built-in Compola add-on (also an example of the add-on API).

const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Inside [from, to) local time; a window may cross midnight (18:00 → 08:00). Empty = always. */
const inWindow = (from, to, date = new Date()) => {
  const a = minutes(from), b = minutes(to);
  if (a === null || b === null || a === b) return true;
  const now = date.getHours() * 60 + date.getMinutes();
  return a < b ? now >= a && now < b : now >= a || now < b;
};

compola.on('message', async (m) => {
  const s = compola.settings;
  if (m.fromMe || !m.text) return;
  if (s.onlyDirect && m.isGroup) return;
  if (!inWindow(s.activeFrom, s.activeTo)) return;
  const last = compola.storage.get('lastReply') || {};
  const cooldown = Math.max(0, Number(s.cooldownMinutes) || 0) * 60000;
  if (last[m.conversationId] && Date.now() - last[m.conversationId] < cooldown) return;
  last[m.conversationId] = Date.now();
  // Forget conversations older than a week so storage stays small.
  for (const [id, t] of Object.entries(last)) if (Date.now() - t > 7 * 86400000) delete last[id];
  await compola.storage.set('lastReply', last);
  try {
    await compola.sendText(m.conversationId, s.message);
    compola.log(`đã trả lời ${m.conversationName}`);
  } catch (e) {
    compola.log(`không trả lời được ${m.conversationName}: ${e.message || e}`);
  }
});
