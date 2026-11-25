// Dịch nhanh — inspector: the customer's language and the latest translations of their messages.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MESSAGES = {
    off: 'Cần bật AI trong Cài đặt › Add-on để dịch.',
    vietnamese: 'Các tin gần đây của khách đều là tiếng Việt — không cần dịch.',
    'bad-answer': 'AI chưa trả lời đúng định dạng, bấm Dịch lại sau ít phút nhé.',
  };
  let seq = 0;
  let busy = false;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const when = (ms) => {
    const d = new Date(Number(ms) || 0);
    const today = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === today.toDateString() ? hm : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
  };
  const showError = (msg) => { $('err').textContent = msg || ''; $('err').classList.toggle('hidden', !msg); };

  function render(s) {
    const st = s || {};
    const lang = $('lang');
    lang.textContent = '';
    if (st.langLabel) lang.append(document.createTextNode('Khách viết '), el('span', 'chip', st.langLabel));
    else lang.textContent = 'Chưa nhận ra ngôn ngữ của khách';
    const list = $('list');
    list.textContent = '';
    const items = Array.isArray(st.items) ? st.items.slice().reverse() : [];
    if (st.result && st.result !== 'ok' && MESSAGES[st.result]) list.appendChild(el('div', 'empty', MESSAGES[st.result]));
    else if (!st.ai) list.appendChild(el('div', 'empty', MESSAGES.off));
    else if (!items.length) list.appendChild(el('div', 'empty', 'Chưa có bản dịch. Bấm “Dịch lại” để dịch 10 tin gần nhất của khách sang tiếng Việt.'));
    for (const it of items) {
      if (!it || typeof it.text !== 'string') continue;
      const box = el('div', 't');
      const orig = el('div', 'orig');
      if (it.date) orig.appendChild(el('span', 'when', when(it.date)));
      orig.appendChild(document.createTextNode(it.text));
      box.append(orig, el('div', it.vi ? 'vi' : 'vi none', it.vi || 'Chưa dịch được'));
      list.appendChild(box);
    }
    const foot = $('foot');
    const bits = [];
    if (st.at) bits.push(`Cập nhật ${when(st.at)}`);
    if (st.autoPanel) bits.push('tự dịch tin mới đang bật');
    foot.textContent = bits.join(' · ');
    foot.classList.toggle('hidden', !bits.length);
    $('again').disabled = busy || !st.ai;
  }

  async function load() {
    const mine = ++seq;
    showError('');
    const ctx = compola.context;
    if (!ctx || !ctx.conversationId) { render({ ai: true }); return; }
    try {
      const s = await compola.call('state');
      if (mine === seq) render(s);
    } catch (e) {
      if (mine === seq) showError((e && e.message) || String(e));
    }
  }

  $('again').onclick = async () => {
    if (busy) return;
    const mine = seq;
    busy = true;
    const b = $('again');
    b.disabled = true;
    b.textContent = '';
    const sp = el('span', 'spinner');
    b.append(sp, document.createTextNode('Đang dịch…'));
    showError('');
    try {
      const s = await compola.call('retranslate', { detect: true });
      if (mine === seq) render(s);
    } catch (e) {
      if (mine === seq) showError((e && e.message) || String(e));
    } finally {
      busy = false;
      b.textContent = 'Dịch lại';
      b.disabled = false;
    }
  };

  let lastConv;
  compola.on('context', (ctx) => {
    const conv = (ctx && ctx.conversationId) || null;
    if (conv === lastConv) return;
    lastConv = conv;
    load();
  });
  compola.on('translations', (d) => {
    const ctx = compola.context;
    if (d && ctx && d.conversationId === ctx.conversationId && d.state && !busy) render(d.state);
  });
})();
