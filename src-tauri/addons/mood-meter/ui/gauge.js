(function () {
  'use strict';
  var M = window.Mood;
  var $ = function (id) { return document.getElementById(id); };
  var SVG = 'http://www.w3.org/2000/svg';
  var current = null;
  var convId = null;

  function svg(tag, attrs) {
    var e = document.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  /** A small line of the recent scores (-2 at the bottom, 2 at the top). */
  function spark(history) {
    var pts = (Array.isArray(history) ? history : []).slice(-20);
    var W = 200, H = 34, pad = 4;
    var s = svg('svg', { class: 'spark', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img',
      'aria-label': 'Diễn biến ' + pts.length + ' lần đánh giá gần đây' });
    var y = function (score) { return pad + ((2 - M.clampScore(score)) / 4) * (H - pad * 2); };
    s.appendChild(svg('line', { class: 'base', x1: 0, x2: W, y1: y(0), y2: y(0), 'vector-effect': 'non-scaling-stroke' }));
    if (pts.length < 2) return s;
    var step = (W - pad * 2) / (pts.length - 1);
    var x = function (i) { return pad + i * step; };
    s.appendChild(svg('polyline', { class: 'line', 'vector-effect': 'non-scaling-stroke',
      points: pts.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p.score).toFixed(1); }).join(' ') }));
    return s;
  }

  /** One colored tick per rating under the line (the SVG is stretched, so its own dots would be ovals). */
  function dots(history) {
    var pts = (Array.isArray(history) ? history : []).slice(-20);
    var wrap = M.el('div');
    wrap.style.cssText = 'display:flex;gap:2px;margin-top:3px';
    pts.forEach(function (p) {
      var d = M.el('span', M.cls(p.score));
      d.style.cssText = 'flex:1;height:3px;border-radius:2px;background:var(--m)';
      d.title = M.step(p.score).emoji + ' ' + M.when(p.t);
      wrap.appendChild(d);
    });
    return wrap;
  }

  function render(rec, opts) {
    opts = opts || {};
    var root = $('root');
    root.textContent = '';
    if (!rec) {
      var e = M.el('div', 'empty s0');
      e.appendChild(M.el('span', 'face', '🌡️'));
      e.appendChild(M.el('div', 'muted small', opts.ai === false
        ? 'Cần bật AI trong Cài đặt › Add-on để đánh giá cảm xúc khách.'
        : 'Chưa đánh giá. AI sẽ đánh giá sau khi khách nhắn xong, hoặc bấm "Đánh giá lại".'));
      root.appendChild(e);
      $('status').textContent = '';
      return;
    }
    var st = M.step(rec.score);
    var box = M.el('div', M.cls(rec.score));
    var head = M.el('div', 'head');
    head.appendChild(M.el('span', 'face', st.emoji));
    var main = M.el('div', 'main');
    var title = M.el('div', 'title');
    title.appendChild(M.el('b', null, rec.label || st.label));
    if (rec.urgent && Number(rec.score) < 0) title.appendChild(M.el('span', 'chip urgent', 'Cần xử lý gấp'));
    main.appendChild(title);
    var scale = M.el('div', 'scale');
    for (var i = -2; i <= 2; i++) {
      var seg = M.el('span', i <= M.clampScore(rec.score) ? 'on' : '');
      seg.title = M.SCALE[String(i)].emoji + ' ' + M.SCALE[String(i)].label;
      scale.appendChild(seg);
    }
    main.appendChild(scale);
    head.appendChild(main);
    box.appendChild(head);
    if (rec.reason) box.appendChild(M.el('div', 'reason', rec.reason));
    if (Array.isArray(rec.history) && rec.history.length > 1) {
      box.appendChild(spark(rec.history));
      box.appendChild(dots(rec.history));
    }
    root.appendChild(box);
    var status = $('status');
    status.textContent = 'Lúc ' + M.when(rec.t) + ' ';
    if (Array.isArray(rec.history) && rec.history.length > 1) status.appendChild(M.trendEl(rec.trend));
  }

  function setBusy(b) {
    var btn = $('rate');
    btn.disabled = b;
    btn.textContent = b ? 'Đang đánh giá…' : 'Đánh giá lại';
  }

  function load() {
    var ctx = compola.context || {};
    convId = ctx.conversationId || null;
    if (!convId) { render(null); return; }
    var asked = convId;
    compola.call('get', { conversationId: convId }).then(function (res) {
      if (asked !== convId) return;
      current = res && res.record ? res.record : null;
      $('err').textContent = '';
      render(current, { ai: res ? res.ai : undefined });
      setBusy(!!(res && res.busy));
    }, function (e) {
      $('err').textContent = e.message || String(e);
    });
  }

  $('rate').addEventListener('click', function () {
    if (!convId) return;
    var asked = convId;
    setBusy(true);
    $('err').textContent = '';
    compola.call('rate', { conversationId: convId }).then(function (res) {
      if (asked !== convId) return;
      if (res && res.record) { current = res.record; render(current); }
      else if (res && (res.error || res.skipped)) $('err').textContent = res.error || res.skipped;
    }, function (e) {
      $('err').textContent = e.message || String(e);
    }).then(function () { setBusy(false); });
  });

  compola.on('context', function (ctx) { if (!ctx || ctx.conversationId !== convId) load(); });
  compola.on('mood', function (d) {
    if (d && d.conversationId === convId && d.record) { current = d.record; render(current); setBusy(false); }
  });
  setInterval(function () { if (current) render(current); }, 60000);
  compola.ready(load);
})();
