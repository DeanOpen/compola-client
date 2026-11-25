// Thống kê hội thoại — inspector view for the conversation on screen. Data: compola.call('conversation', …) → main.js.
(function () {
  'use strict';
  var CF = window.CF;
  var svg = CF.svg, num = CF.num;
  var $ = function (id) { return document.getElementById(id); };
  var current = null;   // conversation id on screen
  var seq = 0;
  var last = null;

  function spark(days) {
    var box = $('spark');
    var W = Math.max(160, box.clientWidth || 260), H = 44, P = 3;
    var n = days.length;
    var totals = days.map(function (d) { return (d.in || 0) + (d.out || 0); });
    var max = Math.max.apply(null, totals.concat([1]));
    var x = function (i) { return P + (n > 1 ? (i / (n - 1)) * (W - 2 * P) : (W - 2 * P) / 2); };
    var y = function (v) { return P + (H - 2 * P) * (1 - v / max); };
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'Số tin mỗi ngày, 30 ngày qua' });
    var line = totals.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join('');
    svg('path', { d: line + 'L' + x(n - 1).toFixed(1) + ',' + (H - P) + 'L' + x(0).toFixed(1) + ',' + (H - P) + 'Z', class: 'area' }, s);
    svg('path', { d: line, class: 'line' }, s);
    svg('circle', { cx: x(n - 1), cy: y(totals[n - 1]), r: 3.5, class: 'dot' }, s);
    var step = n > 1 ? (W - 2 * P) / (n - 1) : W;
    days.forEach(function (d, i) {
      var r = svg('rect', { x: x(i) - step / 2, y: 0, width: step, height: H, class: 'hit' }, s);
      CF.title(r, CF.longDay(d.date) + ': nhận ' + num(d.in) + ', gửi ' + num(d.out));
    });
    box.replaceChildren(s);
    var peak = 0;
    totals.forEach(function (v, i) { if (v > totals[peak]) peak = i; });
    $('cap-left').textContent = '30 ngày qua';
    $('cap-right').textContent = totals[peak] ? 'Nhiều nhất ' + num(totals[peak]) + ' tin (' + CF.dayLabel(days[peak].date) + ')' : 'Chưa có tin nào';
  }

  function render(d) {
    last = d;
    if (!d || d.empty) {
      $('in').textContent = $('out').textContent = $('rt').textContent = '—';
      $('spark').replaceChildren();
      $('cap-left').textContent = 'Mở một hội thoại để xem thống kê';
      $('cap-right').textContent = '';
      $('note').hidden = true;
      return;
    }
    $('in').textContent = num(d.in);
    $('out').textContent = num(d.out);
    $('rt').textContent = d.isGroup ? 'nhóm' : CF.duration(d.rtMedian);
    $('rt').title = d.isGroup ? 'Không tính thời gian phản hồi cho nhóm' : d.rtCount ? 'Từ ' + num(d.rtCount) + ' lượt trả lời' : 'Chưa có lượt trả lời nào';
    spark(Array.isArray(d.spark) ? d.spark : []);
    var note = $('note');
    note.className = 'note';
    if (d.waitingSince && !d.isGroup) {
      note.hidden = false;
      note.className = 'note wait';
      note.textContent = 'Khách đang chờ trả lời ' + CF.duration((d.now || Date.now()) - d.waitingSince);
    } else if (d.capped) {
      note.hidden = false;
      note.textContent = 'Tính trên 2.000 tin gần nhất.';
    } else note.hidden = true;
  }

  function load() {
    var ctx = compola.context || {};
    current = ctx.conversationId || null;
    var mine = ++seq;
    if (!current) { render(null); return; }
    compola.call('conversation', { conversationId: current, account: ctx.account || null, isGroup: typeof ctx.isGroup === 'boolean' ? ctx.isGroup : null })
      .then(function (d) { if (mine === seq) render(d); })
      .catch(function (e) {
        if (mine !== seq) return;
        $('cap-left').textContent = 'Không tải được thống kê: ' + ((e && e.message) || e);
      });
  }

  compola.ready(load);
  compola.on('context', function (ctx) { if (!ctx || ctx.conversationId !== current) load(); });
  compola.on('changed', function (d) {
    var ids = d && Array.isArray(d.conversations) ? d.conversations : [];
    if (current && (!ids.length || ids.indexOf(current) >= 0)) load();
  });
  if (typeof ResizeObserver === 'function') {
    var lastW = 0;
    new ResizeObserver(function () {
      var w = $('spark').clientWidth;
      if (last && !last.empty && Math.abs(w - lastW) > 2) { lastW = w; spark(last.spark || []); }
    }).observe(document.body);
  }
})();
