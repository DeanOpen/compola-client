// Shared by the mood views: the 5-step scale, time text and small DOM helpers.
(function () {
  'use strict';
  var SCALE = {
    '-2': { emoji: '😡', label: 'Rất không hài lòng' },
    '-1': { emoji: '😟', label: 'Không hài lòng' },
    '0': { emoji: '😐', label: 'Bình thường' },
    '1': { emoji: '🙂', label: 'Hài lòng' },
    '2': { emoji: '😄', label: 'Rất hài lòng' },
  };
  function clampScore(s) {
    var n = Math.round(Number(s));
    return Number.isFinite(n) ? Math.max(-2, Math.min(2, n)) : 0;
  }
  function step(s) { return SCALE[String(clampScore(s))]; }
  function cls(s) { return 's' + clampScore(s); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function when(t) {
    var n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return '';
    var diff = Date.now() - n;
    if (diff < 60000) return 'vừa xong';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' phút trước';
    var d = new Date(n);
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === new Date().toDateString()) return hm;
    return hm + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
  }
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }
  function trendEl(trend) {
    var t = Number(trend) || 0;
    var e = el('span', 'trend ' + (t > 0 ? 'up' : t < 0 ? 'down' : 'flat'), t > 0 ? '↑' : t < 0 ? '↓' : '→');
    e.title = t > 0 ? 'Tốt hơn lần trước' : t < 0 ? 'Xấu hơn lần trước' : 'Như lần trước';
    return e;
  }
  window.Mood = { SCALE: SCALE, step: step, cls: cls, clampScore: clampScore, when: when, el: el, trendEl: trendEl };
})();
