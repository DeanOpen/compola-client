// Thống kê — tab view. Data: compola.call('dashboard', {range}) → main.js; refreshed on compola.on('changed').
(function () {
  'use strict';
  var CF = window.CF;
  var el = CF.el, svg = CF.svg, num = CF.num;
  var $ = function (id) { return document.getElementById(id); };
  var range = Number(CF.storeGet('insights.range')) || 14;
  if ([7, 14, 30].indexOf(range) < 0) range = 14;
  var data = null;
  var loading = false, again = false;

  // ---- KPI tiles ----
  function kpi(label, value, delta, tone, foot) {
    var k = el('div', 'kpi');
    k.appendChild(el('div', 'label', label));
    k.appendChild(el('div', 'value', value));
    var f = el('div', 'foot');
    if (delta) f.appendChild(el('span', 'delta' + (tone ? ' ' + tone : ''), delta.text));
    f.appendChild(el('span', null, foot));
    k.appendChild(f);
    return k;
  }
  function renderKpis(k) {
    var rt = k.rt7 || {}, prev = k.rtPrev7 || {}, today = k.rtToday || {};
    var rtDelta = rt.median != null && prev.median != null ? CF.change(rt.median, prev.median) : null;
    // Faster answers are better: down is good.
    var rtTone = rtDelta && rtDelta.dir === 'down' ? 'good' : rtDelta && rtDelta.dir === 'up' ? 'bad' : '';
    var rtFoot = rt.median == null ? 'Chưa có lượt trả lời khách nào'
      : 'Hôm nay ' + CF.duration(today.median) + ' · P90 ' + CF.duration(rt.p90);
    $('kpis').replaceChildren(
      kpi('Tin nhận hôm nay', num(k.inToday), CF.change(k.inToday, k.inYesterday), '', 'hôm qua ' + num(k.inYesterday)),
      kpi('Tin gửi hôm nay', num(k.outToday), CF.change(k.outToday, k.outYesterday), '', 'hôm qua ' + num(k.outYesterday)),
      kpi('Hội thoại hoạt động · 7 ngày', num(k.active7), CF.change(k.active7, k.activePrev7), '', '7 ngày trước ' + num(k.activePrev7)),
      kpi('Phản hồi trung vị · 7 ngày', CF.duration(rt.median), rtDelta, rtTone, rtFoot)
    );
  }

  // ---- bar chart: in vs out per day ----
  var tip = null;
  function showTip(box, x, y, d) {
    if (!tip) { tip = el('div', 'tip'); box.appendChild(tip); }
    tip.replaceChildren(el('b', null, CF.longDay(d.date)), el('br'));
    var a = el('span'); a.appendChild(el('i', 'swatch in')); a.appendChild(document.createTextNode('Nhận ' + num(d.in)));
    var b = el('span'); b.appendChild(el('i', 'swatch out')); b.appendChild(document.createTextNode('Gửi ' + num(d.out)));
    tip.appendChild(a); tip.appendChild(document.createTextNode('   ')); tip.appendChild(b);
    tip.hidden = false;
    var half = tip.offsetWidth / 2;
    tip.style.left = Math.max(half, Math.min(box.clientWidth - half, x)) + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; }

  function renderBars(days) {
    var box = $('bars');
    var W = Math.max(240, box.clientWidth || 600);
    var H = 180, L = 34, R = 4, T = 10, B = 22;
    var pw = W - L - R, ph = H - T - B;
    var n = days.length;
    var max = 0;
    days.forEach(function (d) { max = Math.max(max, d.in, d.out); });
    var sc = CF.niceScale(max);
    var y = function (v) { return T + ph - (v / sc.max) * ph; };
    var s = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Tin nhận và gửi theo ngày' });
    for (var v = 0; v <= sc.max + 1e-9; v += sc.step) {
      if (v > 0) svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'gridline' }, s);
      svg('text', { x: L - 6, y: y(v) + 3, 'text-anchor': 'end', class: 'axis' }, s).textContent = num(v);
    }
    var band = pw / n;
    var gw = Math.max(3, Math.min(band * 0.74, 44));
    var bw = Math.max(1, (gw - 2) / 2);
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 42))));
    days.forEach(function (d, i) {
      var g = svg('g', { class: 'col' }, s);
      var x0 = L + i * band;
      var gx = x0 + (band - gw) / 2;
      svg('rect', { x: x0, y: T, width: band, height: ph, class: 'hit' }, g);
      var r = Math.min(4, bw / 2);
      var pIn = CF.barPath(gx, T + ph, bw, (d.in / sc.max) * ph, r);
      var pOut = CF.barPath(gx + bw + 2, T + ph, bw, (d.out / sc.max) * ph, r);
      if (pIn) svg('path', { d: pIn, class: 'bar-in' }, g);
      if (pOut) svg('path', { d: pOut, class: 'bar-out' }, g);
      g.setAttribute('aria-label', CF.longDay(d.date) + ': nhận ' + d.in + ', gửi ' + d.out);
      g.addEventListener('mouseenter', function () { showTip(box, x0 + band / 2, y(Math.max(d.in, d.out)), d); });
      g.addEventListener('mouseleave', hideTip);
      var last = i === n - 1;
      if ((n - 1 - i) % every === 0) {
        svg('text', { x: x0 + band / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis' }, s).textContent = last ? 'Hôm nay' : CF.dayLabel(d.date);
      }
    });
    svg('line', { x1: L, x2: W - R, y1: T + ph, y2: T + ph, class: 'baseline' }, s);
    tip = null;
    box.replaceChildren(s);
  }

  // ---- heatmap: weekday × hour (incoming) ----
  function renderHeat(heat, weeks) {
    var box = $('heat');
    var narrow = (box.clientWidth || 600) < 380;
    var max = 0;
    heat.forEach(function (v) { max = Math.max(max, v); });
    var w = Math.max(1, weeks || 1);
    var nodes = [];
    var peak = -1;
    for (var r = 0; r < 7; r++) {
      var dayName = CF.WEEKDAY_NAMES[(r + 1) % 7];
      nodes.push(el('span', 'wd', CF.WEEKDAYS[(r + 1) % 7]));
      for (var h = 0; h < 24; h++) {
        var v = heat[r * 24 + h] || 0;
        if (v && (peak < 0 || v > heat[peak])) peak = r * 24 + h;
        var c = el('span', 'cell');
        if (v) {
          var fill = el('i');
          fill.style.opacity = String(0.14 + 0.86 * (v / max));
          c.appendChild(fill);
        }
        c.title = dayName + ', ' + h + '–' + (h + 1) + ' giờ: ' + num(v) + ' tin nhận' + (w > 1 ? ' (~' + num(Math.round(v / w)) + '/tuần)' : '');
        nodes.push(c);
      }
    }
    nodes.push(el('span'));
    for (var hr = 0; hr < 24; hr++) nodes.push(el('span', 'hr', hr % (narrow ? 6 : 3) === 0 ? hr + 'h' : ''));
    box.replaceChildren.apply(box, nodes);
    $('heat-meta').textContent = 'Tin nhận, ' + (weeks >= 4 ? '4 tuần' : weeks > 1 ? weeks + ' tuần' : 'tuần này') + ' gần nhất';
    if (peak < 0) { $('heat-peak').textContent = 'Chưa có tin nhận nào'; return; }
    var pr = Math.floor(peak / 24), ph = peak % 24;
    $('heat-peak').textContent = 'Đông nhất: ' + CF.WEEKDAY_NAMES[(pr + 1) % 7] + ', ' + ph + '–' + (ph + 1) + ' giờ';
  }

  // ---- top conversations ----
  function renderTop(top) {
    var list = $('top');
    if (!top.length) { list.replaceChildren(el('li', 'empty', 'Chưa có hội thoại nào trong ' + range + ' ngày qua')); list.firstChild.style.display = 'block'; return; }
    var max = 0;
    top.forEach(function (t) { max = Math.max(max, t.in + t.out); });
    list.replaceChildren.apply(list, top.map(function (t, i) {
      var li = el('li');
      li.tabIndex = 0;
      li.title = (t.name || 'Hội thoại') + ': nhận ' + num(t.in) + ', gửi ' + num(t.out) + ' — bấm để mở';
      li.appendChild(el('span', 'rank', String(i + 1)));
      var who = el('span', 'who', t.name || 'Hội thoại');
      if (t.isGroup) who.appendChild(el('small', null, 'nhóm'));
      li.appendChild(who);
      var mini = el('span', 'mini');
      if (t.in) { var a = el('i', 'in'); a.style.width = (t.in / max) * 100 + '%'; mini.appendChild(a); }
      if (t.out) { var b = el('i', 'out'); b.style.width = (t.out / max) * 100 + '%'; mini.appendChild(b); }
      li.appendChild(mini);
      li.appendChild(el('span', 'count', num(t.in + t.out)));
      var open = function () {
        compola.openConversation(t.id).catch(function (e) { compola.toast('Không mở được hội thoại: ' + ((e && e.message) || e)); });
      };
      li.addEventListener('click', open);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      return li;
    }));
  }

  function render() {
    if (!data) return;
    var d = data;
    var t = d.totals || {};
    $('sub').textContent = 'Cập nhật lúc ' + CF.clock(d.now || Date.now()) + ' · ' + range + ' ngày qua: ' + num(t.in) + ' tin nhận, ' + num(t.out) + ' tin gửi';
    var banner = $('banner');
    if (d.backfilling) { banner.hidden = false; banner.textContent = 'Đang nạp tin nhắn 14 ngày qua từ lịch sử — số liệu sẽ đầy đủ sau ít phút.'; }
    else banner.hidden = true;
    renderKpis(d.kpi || {});
    renderBars(Array.isArray(d.days) ? d.days : []);
    var ci = CF.change(t.in, t.prevIn), co = CF.change(t.out, t.prevOut);
    $('bars-total').textContent = 'Tổng ' + range + ' ngày: ' + num(t.in) + ' nhận' + (ci ? ' (' + ci.text + ')' : '') + ' · ' + num(t.out) + ' gửi' +
      (co ? ' (' + co.text + ')' : '') + (ci || co ? ' so với ' + range + ' ngày trước' : '');
    renderHeat(Array.isArray(d.heat) ? d.heat : [], d.heatWeeks || 0);
    renderTop(Array.isArray(d.top) ? d.top : []);
  }

  function syncRange() {
    Array.prototype.forEach.call(document.querySelectorAll('#range button'), function (b) {
      b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-range')) === range));
    });
  }

  function load() {
    if (loading) { again = true; return; }
    loading = true;
    compola.call('dashboard', { range: range }).then(function (d) {
      if (d && typeof d === 'object') { data = d; render(); }
    }).catch(function (e) {
      $('sub').textContent = 'Không tải được số liệu: ' + ((e && e.message) || e);
    }).then(function () {
      loading = false;
      if (again) { again = false; load(); }
    });
  }

  $('range').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-range]');
    if (!b) return;
    range = Number(b.getAttribute('data-range')) || 14;
    CF.storeSet('insights.range', String(range));
    syncRange();
    load();
  });
  syncRange();

  var lastW = 0;
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () {
      var w = $('bars').clientWidth;
      if (data && Math.abs(w - lastW) > 2) { lastW = w; render(); }
    }).observe(document.body);
  }

  compola.ready(load);
  compola.on('changed', load);
  setInterval(load, 60000);
})();
