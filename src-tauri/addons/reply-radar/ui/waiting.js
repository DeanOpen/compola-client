// Khách đang chờ — tab view. Data: compola.call('list') and compola.on('changed') from main.js.
(function () {
  'use strict';
  var MIN = 60000;
  var data = null;
  var offset = 0; // add-on clock − view clock
  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, '0'); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function now() { return Date.now() + offset; }
  function duration(ms) {
    var m = Math.floor(Math.max(0, ms) / MIN);
    if (m < 1) return '< 1 phút';
    if (m < 60) return m + ' phút';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' giờ' + (m % 60 ? ' ' + (m % 60) + ' ph' : '');
    var d = Math.floor(h / 24);
    return d + ' ngày' + (h % 24 ? ' ' + (h % 24) + ' giờ' : '');
  }
  function clock(ts) {
    var d = new Date(ts);
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return d.toDateString() === new Date(now()).toDateString() ? 'từ ' + hm : 'từ ' + hm + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
  }
  function median(list) {
    if (!list.length) return 0;
    var s = list.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function initials(name) {
    var words = String(name || '?').trim().split(/\s+/).filter(Boolean);
    var w = words.length ? words[words.length - 1] : '?';
    return w.charAt(0).toUpperCase();
  }
  function level(wait, alertMs) {
    if (wait < 5 * MIN) return 'ok';
    return wait < alertMs ? 'warn' : 'bad';
  }

  function stat(label, value, cls) {
    var s = el('div', 'stat' + (cls ? ' ' + cls : ''));
    s.appendChild(el('span', null, label));
    s.appendChild(el('b', null, value));
    return s;
  }

  function render() {
    if (!data) return;
    var items = Array.isArray(data.items) ? data.items : [];
    var t = now();
    var alertMin = Number(data.alertMinutes) || 15;
    var alertMs = alertMin * MIN;
    var waits = items.map(function (i) { return t - (Number(i.since) || t); });
    var over = waits.filter(function (w) { return w >= alertMs; }).length;

    $('sub').textContent = items.length
      ? 'Ai chờ lâu nhất ở trên cùng. Bấm vào một khách để mở hội thoại.'
      : 'Theo dõi khách có tin nhắn mới nhất chưa được trả lời.';
    var stats = $('stats');
    stats.replaceChildren(
      stat('Đang chờ', String(items.length)),
      stat('Quá ' + alertMin + ' phút', String(over), over ? 'bad' : ''),
      stat('Chờ trung vị', items.length ? duration(median(waits)) : '—')
    );

    var notice = $('notice');
    if (data.working === false) {
      notice.hidden = false;
      notice.textContent = 'Ngoài giờ làm việc (' + data.workStart + '–' + data.workEnd + '): vẫn theo dõi nhưng tạm không gửi thông báo.';
    } else notice.hidden = true;

    var list = $('list');
    var rows = items.map(function (i, n) {
      var wait = waits[n];
      var li = el('li', 'row');
      li.tabIndex = 0;
      li.title = 'Mở hội thoại với ' + (i.name || 'khách');
      var av = el('div', 'avatar' + (i.isGroup ? ' group' : ''), initials(i.name));
      var main = el('div', 'main');
      var name = el('div', 'name', i.name || 'Khách');
      if (i.isGroup) name.appendChild(el('small', null, 'nhóm'));
      main.appendChild(name);
      main.appendChild(el('div', 'text', i.text || ''));
      var side = el('div', 'side');
      side.appendChild(el('span', 'badge ' + level(wait, alertMs), duration(wait)));
      side.appendChild(el('span', 'at', clock(i.since)));
      li.appendChild(av);
      li.appendChild(main);
      li.appendChild(side);
      var open = function () {
        compola.openConversation(i.id).catch(function (e) { compola.toast('Không mở được hội thoại: ' + (e && e.message || e)); });
      };
      li.addEventListener('click', open);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      return li;
    });
    list.replaceChildren.apply(list, rows);
    $('empty').hidden = items.length > 0;
  }

  function apply(d) {
    if (!d || typeof d !== 'object') return;
    data = d;
    if (Number(d.now) > 0) offset = Number(d.now) - Date.now();
    render();
  }
  function load() {
    compola.call('list').then(apply).catch(function (e) {
      $('sub').textContent = 'Không tải được danh sách: ' + (e && e.message || e);
    });
  }

  compola.ready(load);
  compola.on('changed', apply);
  setInterval(load, 30000); // wait times tick (and anything a missed post changed)
})();
