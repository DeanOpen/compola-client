// Dịch nhanh — composer strip: Vietnamese in, the customer's language into the message box.
(function () {
  'use strict';
  const L = window.Lang;
  const $ = (id) => document.getElementById(id);
  const AUTO = 'Tự nhận diện theo khách';
  let busy = false;
  let seq = 0;

  const sel = $('lang');
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = AUTO;
  sel.appendChild(auto);
  for (const l of L.LANGS) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.label;
    sel.appendChild(o);
  }

  function setAutoLabel(label) {
    auto.textContent = label ? `Tự nhận diện (${label})` : AUTO;
  }

  function setBusy(on) {
    busy = on;
    const go = $('go');
    go.disabled = on;
    go.textContent = '';
    if (on) {
      const s = document.createElement('span');
      s.className = 'spinner';
      go.append(s, document.createTextNode('Đang dịch…'));
    } else {
      go.textContent = 'Dịch & chèn';
    }
  }

  async function load() {
    const mine = ++seq;
    $('text').value = '';
    setAutoLabel('');
    sel.value = 'auto';
    const ctx = compola.context;
    if (!ctx || !ctx.conversationId) return;
    try {
      const s = await compola.call('state');
      if (mine !== seq || !s) return;
      setAutoLabel(s.langLabel || '');
      sel.value = s.pick && (s.pick === 'auto' || L.byCode[s.pick]) ? s.pick : 'auto';
      $('text').title = s.ai ? '' : 'Cần bật AI trong Cài đặt › Add-on';
    } catch (e) {
      /* the add-on may be restarting: the strip still works */
    }
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const text = $('text').value.trim();
    if (!text) { $('text').focus(); return; }
    const mine = seq;
    setBusy(true);
    try {
      const r = await compola.call('translate', { text, lang: sel.value });
      if (mine !== seq) return; // another conversation is on screen now
      if (sel.value === 'auto' && r && r.lang && r.lang.label) setAutoLabel(r.lang.label);
      await compola.insertText((r && r.text) || '');
      $('text').value = '';
    } catch (err) {
      compola.toast((err && err.message) || String(err), 'error').catch(() => {});
    } finally {
      setBusy(false);
      $('text').focus();
    }
  });

  // Fires with the first context too; a theme change keeps the conversation (and what is typed).
  let lastConv;
  compola.on('context', (ctx) => {
    const conv = (ctx && ctx.conversationId) || null;
    if (conv === lastConv) return;
    lastConv = conv;
    load();
  });
  compola.on('translations', (d) => {
    const ctx = compola.context;
    if (d && ctx && d.conversationId === ctx.conversationId && d.state) setAutoLabel(d.state.langLabel || '');
  });
})();
