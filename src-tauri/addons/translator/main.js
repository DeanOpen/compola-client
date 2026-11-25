// Dịch nhanh — built-in Compola add-on for shops chatting with foreign customers: Vietnamese → the customer's language
// into the message box (composer view), and the customer's recent messages → Vietnamese (panel + inspector view).

const L = require('./lib/lang.js');

const RECENT = 10;          // incoming messages translated at a time
const HISTORY = 40;         // messages read to find them
const MAX_CHARS = 6000;     // text sent to the AI per request
const AUTO_DELAY = 20000;   // auto panel: wait for the customer to finish (per conversation)
const LANG_TTL = 12 * 3600000;
const MAX_CONVS = 300;

const TONES = {
  polite: 'polite and respectful, like a courteous shop assistant',
  friendly: 'warm and friendly, casual but still respectful',
  formal: 'formal and professional',
};

const OUT_SYSTEM = (lang, tone) =>
  `You translate messages that a Vietnamese shop sends to its customer in a chat app. Translate the Vietnamese text into ${lang}. ` +
  `Tone: ${tone}. Keep the meaning, names, numbers, prices, sizes, links and emoji exactly; sound natural for chat; do not add greetings or ` +
  'information that is not in the text. Reply with the translation only — no quotes, notes or explanations.';

const IN_SYSTEM =
  'Bạn dịch tin nhắn khách nước ngoài gửi cho một shop Việt Nam. Dịch từng tin sang tiếng Việt tự nhiên, sát nghĩa, giữ số, giá, size, tên riêng và emoji. ' +
  'Trả về đúng một JSON: {"language": "<tên tiếng Anh của ngôn ngữ khách dùng>", "code": "<mã ISO 639-1>", "translations": ["<bản dịch tin 1>", ...]} ' +
  '— đúng số lượng và thứ tự như danh sách. Tin đã là tiếng Việt thì giữ nguyên.';

const DETECT_SYSTEM =
  'Identify the language of these chat messages from a customer. Reply with JSON only: {"code": "<ISO 639-1>", "name": "<language name in English>"}.';

const warn = (where, e) => compola.warn(`${where}: ${(e && e.message) || e}`);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// ---- storage (maps keyed by conversation id, capped) ----
const getMap = (key) => obj(compola.storage.get(key));
const putMap = async (key, map, stamp = (v) => (v && v.at) || 0) => {
  const ids = Object.keys(map);
  if (ids.length > MAX_CONVS) {
    ids.sort((a, b) => stamp(map[b]) - stamp(map[a]));
    for (const id of ids.slice(MAX_CONVS)) delete map[id];
  }
  await compola.storage.set(key, map);
};

const cachedLang = (conv) => {
  const l = obj(getMap('langs')[conv]);
  return typeof l.code === 'string' && l.code ? l : null;
};
const saveLang = async (conv, lang) => {
  const map = getMap('langs');
  const prev = obj(map[conv]);
  if (prev.code === lang.code && prev.source === lang.source && Date.now() - (prev.at || 0) < LANG_TTL / 2) return;
  map[conv] = { code: lang.code, name: lang.name, source: lang.source, at: Date.now() };
  await putMap('langs', map);
};
const langLabel = (l) => (l ? (L.byCode[l.code] ? L.byCode[l.code].label : l.name || l.code) : '');

const aiOn = () => compola.ai.available().catch(() => false);

const parseJson = (out) => {
  if (out && out.json && typeof out.json === 'object') return out.json;
  const t = out && typeof out.text === 'string' ? out.text : '';
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
};

const normLang = (code, name, source) => {
  const c = String(code || '').toLowerCase().slice(0, 2);
  if (!/^[a-z]{2}$/.test(c)) return null;
  const known = L.byCode[c];
  return { code: c, name: known ? known.name : String(name || c).slice(0, 40), source };
};

// ---- reading the conversation ----
/** The customer's last `n` messages with text, oldest first. */
const incoming = async (conv, account, n = RECENT) => {
  const opts = { limit: HISTORY };
  if (account) opts.account = account;
  const list = await compola.history(conv, opts).catch(() => []);
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && !m.fromMe && typeof m.text === 'string' && m.text.trim())
    .slice(-n);
};

/** The customer's language: by script when certain, else asked of the AI (cached per conversation). */
const resolveLang = async (conv, account, force) => {
  const cached = cachedLang(conv);
  if (cached && !force && Date.now() - (cached.at || 0) < LANG_TTL) return cached;
  const foreign = (await incoming(conv, account)).filter((m) => !L.looksVietnamese(m.text));
  if (!foreign.length) return cached;
  const votes = {};
  for (const m of foreign) { const c = L.codeByScript(m.text); if (c) votes[c] = (votes[c] || 0) + 1; }
  const top = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
  let lang = top && votes[top] * 2 >= foreign.length ? normLang(top, '', 'script') : null;
  if (!lang && (await aiOn())) {
    try {
      const sample = foreign.slice(-5).map((m) => m.text.slice(0, 300)).join('\n');
      const v = parseJson(await compola.ai.complete({ system: DETECT_SYSTEM, prompt: sample, json: true, maxTokens: 200, effort: 'low' }));
      if (v) lang = normLang(v.code, v.name, 'ai');
      if (lang && lang.code === 'vi') return cached;
    } catch (e) {
      warn('nhận diện ngôn ngữ', e);
    }
  }
  if (!lang) lang = { code: 'en', name: 'English', source: 'guess' };
  await saveLang(conv, lang);
  return { ...lang, at: Date.now() };
};

// ---- outgoing: Vietnamese → customer's language ----
const cleanOut = (t) => String(t || '').trim().replace(/^```[a-z]*\n?|```$/g, '').replace(/^["“](.*)["”]$/s, '$1').trim();

const translateOut = async (text, target) => {
  const tone = TONES[compola.settings.tone] || TONES.polite;
  const out = await compola.ai.complete({ system: OUT_SYSTEM(target.name, tone), prompt: text, maxTokens: 1500, effort: 'low' });
  const t = cleanOut(out && out.text);
  if (!t) throw new Error('AI không trả về bản dịch, thử lại nhé');
  return t;
};

// ---- incoming: customer's recent messages → Vietnamese ----
const inflight = new Map();

const translateRecent = (conv, account, fresh) => {
  if (inflight.has(conv)) return inflight.get(conv);
  const p = doTranslateRecent(conv, account, fresh).finally(() => inflight.delete(conv));
  inflight.set(conv, p);
  return p;
};

const doTranslateRecent = async (conv, account, fresh) => {
  if (!(await aiOn())) return { ok: false, reason: 'off' };
  const foreign = (await incoming(conv, account)).filter((m) => !L.looksVietnamese(m.text));
  if (!foreign.length) return { ok: false, reason: 'vietnamese' };
  const recentMap = getMap('recent');
  const before = new Map((Array.isArray(obj(recentMap[conv]).items) ? recentMap[conv].items : []).map((x) => [x && x.id, x]));
  const todo = foreign.filter((m) => fresh || !m.id || !before.has(m.id) || !before.get(m.id).vi);
  let lang = cachedLang(conv);
  const got = new Map();
  if (todo.length) {
    let budget = MAX_CHARS;
    const lines = [];
    for (const m of todo) {
      const t = m.text.replace(/\s+/g, ' ').trim().slice(0, 1000);
      if (budget - t.length < 0 && lines.length) break;
      budget -= t.length;
      lines.push(t);
    }
    const sent = todo.slice(0, lines.length);
    const out = await compola.ai.complete({
      system: IN_SYSTEM,
      prompt: lines.map((t, i) => `${i + 1}. ${t}`).join('\n'),
      json: true,
      maxTokens: 3000,
      effort: 'low',
    });
    const v = parseJson(out);
    const list = v && Array.isArray(v.translations) ? v.translations : null;
    if (!list) return { ok: false, reason: 'bad-answer' };
    sent.forEach((m, i) => { if (typeof list[i] === 'string' && list[i].trim()) got.set(m, list[i].trim().slice(0, 2000)); });
    const detected = normLang(v.code, v.language, 'ai');
    if (detected && detected.code !== 'vi') {
      // Script beats the AI's word when the script is certain.
      const byScript = L.codeByScript(sent.map((m) => m.text).join(' '));
      lang = byScript ? normLang(byScript, '', 'script') : detected;
      await saveLang(conv, lang);
    }
  }
  const items = foreign.map((m) => {
    const old = m.id ? before.get(m.id) : null;
    return {
      id: m.id || null,
      sender: String(m.senderName || '').slice(0, 60),
      date: Number(m.date) || 0,
      text: m.text.slice(0, 600),
      vi: got.get(m) || (old && old.vi) || '',
    };
  });
  recentMap[conv] = { at: Date.now(), items };
  await putMap('recent', recentMap);
  return { ok: true, items, lang };
};

const REASONS = {
  off: 'Cần bật AI trong Cài đặt › Add-on để dịch.',
  vietnamese: 'Các tin gần đây của khách đều là tiếng Việt — không cần dịch.',
  'bad-answer': 'AI chưa trả lời đúng định dạng, thử lại sau nhé.',
};

const showPanel = async (conv, r) => {
  const blocks = [];
  if (!r.ok) {
    blocks.push({ type: 'text', text: REASONS[r.reason] || 'Chưa dịch được.', muted: true });
  } else {
    if (r.lang) blocks.push({ type: 'badges', items: [`Khách viết: ${langLabel(r.lang)}`] });
    r.items.forEach((it, i) => {
      if (i) blocks.push({ type: 'divider' });
      blocks.push({ type: 'text', text: it.text.slice(0, 300), muted: true });
      blocks.push({ type: 'text', text: it.vi ? `→ ${it.vi}` : '→ (chưa dịch được)' });
    });
  }
  blocks.push({ type: 'button', label: 'Dịch lại', action: 'translate-recent', payload: { fresh: true } });
  await compola.ui.panel(conv, { title: 'Bản dịch', blocks });
};

const stateOf = async (conv) => {
  const r = obj(getMap('recent')[conv]);
  return {
    ai: !!(await aiOn()),
    lang: cachedLang(conv),
    langLabel: langLabel(cachedLang(conv)),
    pick: (conv && typeof getMap('picks')[conv] === 'string' && getMap('picks')[conv]) || 'auto',
    items: Array.isArray(r.items) ? r.items : [],
    at: r.at || 0,
    autoPanel: !!compola.settings.autoPanel,
  };
};

const runRecent = async (conv, account, fresh) => {
  const r = await translateRecent(conv, account, fresh);
  await showPanel(conv, r).catch((e) => warn('panel', e));
  const state = { ...(await stateOf(conv)), result: r.ok ? 'ok' : r.reason };
  await compola.views.post('translations', { conversationId: conv, state }).catch((e) => warn('views.post', e));
  return state;
};

// ---- views ----
compola.views.handle('state', async (_data, ctx) => stateOf(ctx && ctx.conversationId));

compola.views.handle('translate', async (data, ctx) => {
  const d = obj(data);
  const text = String(d.text || '').trim().slice(0, 4000);
  if (!text) throw new Error('Nhập nội dung cần dịch');
  if (!(await aiOn())) throw new Error(REASONS.off);
  const conv = ctx && ctx.conversationId;
  const pick = typeof d.lang === 'string' && (d.lang === 'auto' || L.byCode[d.lang]) ? d.lang : 'auto';
  let target;
  if (pick === 'auto') {
    target = conv ? await resolveLang(conv, ctx.account) : null;
    if (!target) throw new Error('Chưa nhận ra ngôn ngữ của khách (khách đang nhắn tiếng Việt?) — hãy chọn ngôn ngữ');
  } else {
    target = { ...L.byCode[pick], source: 'pick' };
  }
  if (conv) {
    const picks = getMap('picks');
    if (picks[conv] !== pick) {
      if (pick === 'auto') delete picks[conv]; else picks[conv] = pick;
      const ids = Object.keys(picks);
      if (ids.length > MAX_CONVS) for (const id of ids.slice(0, ids.length - MAX_CONVS)) delete picks[id];
      await compola.storage.set('picks', picks);
    }
  }
  return { text: await translateOut(text, target), lang: { code: target.code, label: langLabel(target) } };
});

compola.views.handle('retranslate', async (data, ctx) => {
  const conv = ctx && ctx.conversationId;
  if (!conv) throw new Error('Chưa chọn hội thoại');
  if (obj(data).detect) await resolveLang(conv, ctx.account, true);
  return runRecent(conv, ctx.account, true);
});

// ---- actions & events ----
compola.on('action', async (a) => {
  try {
    if (!a || !a.conversationId || a.actionId !== 'translate-recent') return;
    const state = await runRecent(String(a.conversationId), a.account, !!(a.payload && a.payload.fresh));
    if (state.result === 'off') await compola.ui.toast(REASONS.off, { conversationId: a.conversationId, level: 'warn' });
  } catch (e) {
    warn('dịch tin gần đây', e);
    await compola.ui.toast(`Không dịch được: ${(e && e.message) || e}`, { conversationId: a.conversationId, level: 'error' }).catch(() => {});
  }
});

const pendingAuto = new Map();

compola.on('message', async (m) => {
  try {
    if (!m || m.fromMe || m.sentBy || m.isGroup || !m.conversationId || typeof m.text !== 'string') return;
    if (L.looksVietnamese(m.text)) return;
    const conv = String(m.conversationId);
    // A language the script gives away costs nothing: remember it for "Tự nhận diện".
    const byScript = L.codeByScript(m.text);
    if (byScript) await saveLang(conv, normLang(byScript, '', 'script'));
    if (!compola.settings.autoPanel || pendingAuto.has(conv)) return;
    pendingAuto.set(conv, setTimeout(() => {
      pendingAuto.delete(conv);
      runRecent(conv, m.account, false).catch((e) => warn('tự dịch', e));
    }, AUTO_DELAY));
  } catch (e) {
    warn('tin nhắn đến', e);
  }
});

compola.on('settings', () => {
  if (compola.settings.autoPanel) return;
  for (const t of pendingAuto.values()) clearTimeout(t);
  pendingAuto.clear();
});
