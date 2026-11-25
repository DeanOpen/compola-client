// Shared helpers for the insights views (loaded before dashboard.js / conversation.js).
(function () {
  'use strict';
  var SVG = 'http://www.w3.org/2000/svg';
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  var WEEKDAY_NAMES = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

  function num(n) {
    n = Number(n) || 0;
    try { return n.toLocaleString('vi-VN'); } catch (e) { return String(n); }
  }
  /** A response time: 45 giây · 12 phút · 1 giờ 5 phút · 2 ngày 3 giờ. */
  function duration(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    var s = Math.round(Math.max(0, ms) / 1000);
    if (s < 60) return s + ' giây';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' phút';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' giờ' + (m % 60 ? ' ' + (m % 60) + ' phút' : '');
    var d = Math.floor(h / 24);
    return d + ' ngày' + (h % 24 ? ' ' + (h % 24) + ' giờ' : '');
  }
  function dayLabel(ts) { var d = new Date(ts); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1); }
  function longDay(ts) { var d = new Date(ts); return WEEKDAY_NAMES[d.getDay()] + ', ' + dayLabel(ts); }
  function clock(ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  /** Change of `cur` against `prev`: {text, dir: 'up'|'down'|'flat'|'new'} or null when there is nothing to compare. */
  function change(cur, prev) {
    cur = Number(cur) || 0; prev = Number(prev) || 0;
    if (!prev) return cur ? { text: 'mới', dir: 'new' } : null;
    var pct = Math.round(((cur - prev) / prev) * 100);
    if (!pct) return { text: '0%', dir: 'flat' };
    return { text: (pct > 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '%', dir: pct > 0 ? 'up' : 'down' };
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svg(tag, attrs, parent) {
    var e = document.createElementNS(SVG, tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function title(node, text) { svg('title', null, node).textContent = text; return node; }
  /** A bar of width w anchored at the baseline y0, top corners rounded by r. */
  function barPath(x, y0, w, h, r) {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    var top = y0 - h;
    return 'M' + x + ',' + y0 + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top + 'H' + (x + w - r) +
      'Q' + (x + w) + ',' + top + ' ' + (x + w) + ',' + (top + r) + 'V' + y0 + 'Z';
  }
  /** A "nice" axis maximum and step for 3–4 grid lines. */
  function niceScale(max) {
    if (!(max > 0)) return { max: 4, step: 1 };
    var raw = max / 4;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 2.5, 5, 10].map(function (f) { return f * mag; }).find(function (s) { return s >= raw; }) || 10 * mag;
    step = Math.max(1, step);
    return { max: Math.ceil(max / step) * step, step: step };
  }
  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* opaque origin: no storage */ } }

  window.CF = {
    num: num, duration: duration, dayLabel: dayLabel, longDay: longDay, clock: clock, change: change, el: el, svg: svg, title: title,
    barPath: barPath, niceScale: niceScale, WEEKDAYS: WEEKDAYS, WEEKDAY_NAMES: WEEKDAY_NAMES, storeGet: storeGet, storeSet: storeSet,
  };
})();
