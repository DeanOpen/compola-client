(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var last = null;
  var armTimer = null;

  function pad(n) { return String(n).padStart(2, '0'); }
  function when(t) {
    var n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return '';
    var d = new Date(n);
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    if (d.toDateString() === new Date().toDateString()) return hm + ' hôm nay';
    return hm + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
  }
  function count(n) { return (Number(n) || 0).toLocaleString('vi-VN'); }

  function render(s) {
    if (!s || typeof s !== 'object') return;
    last = s;
    var state = $('state');
    var text;
    if (s.urlProblem === 'empty') { state.className = 'state off'; text = 'Chưa nhập địa chỉ webhook: chưa gửi gì.'; }
    else if (s.urlProblem === 'not-https') { state.className = 'state warn'; text = 'Địa chỉ phải bắt đầu bằng https:// — chưa gửi gì.'; }
    else if (s.queue && s.nextRetryAt) { state.className = 'state warn'; text = 'Đang chờ gửi lại tới ' + s.url; }
    else { state.className = 'state ok'; text = 'Đang gửi tới ' + s.url; }
    $('stateText').textContent = text;
    $('stateText').title = text;
    $('queue').textContent = count(s.queue);
    $('sent').textContent = count(s.sent);
    $('failed').textContent = count(s.failed);
    $('dropped').textContent = count(s.dropped);
    $('failedBox').classList.toggle('bad', Number(s.failed) > 0);
    $('droppedBox').classList.toggle('bad', Number(s.dropped) > 0);
    $('lastOk').textContent = when(s.lastSuccessAt) || 'Chưa có';
    $('retryRow').hidden = !(s.queue && s.nextRetryAt);
    $('retry').textContent = when(s.nextRetryAt);
    $('errRow').hidden = !s.lastError;
    $('lastErr').textContent = s.lastError ? s.lastError + (s.lastErrorAt ? ' (' + when(s.lastErrorAt) + ')' : '') : '';
    $('clear').disabled = !Number(s.queue);
    $('test').disabled = !!s.urlProblem;
    $('test').title = s.urlProblem ? 'Nhập địa chỉ https:// ở trên trước' : '';
  }

  function showResult(ok, text) {
    var r = $('result');
    r.className = 'result ' + (ok ? 'ok' : 'bad');
    r.textContent = text;
  }

  function load() {
    compola.call('status').then(render, function (e) { showResult(false, e.message || String(e)); });
  }

  $('test').addEventListener('click', function () {
    var btn = $('test');
    btn.disabled = true;
    btn.textContent = 'Đang gửi…';
    showResult(true, '');
    compola.call('test').then(function (s) {
      render(s);
      if (s && s.result) showResult(!!s.result.ok, s.result.text);
    }, function (e) {
      showResult(false, e.message || String(e));
    }).then(function () {
      btn.textContent = 'Gửi thử';
      if (last) render(last); else btn.disabled = false;
    });
  });

  // Two clicks to clear (no browser dialogs in a view).
  $('clear').addEventListener('click', function () {
    var btn = $('clear');
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Bấm lần nữa để xoá ' + count(last && last.queue) + ' tin';
      clearTimeout(armTimer);
      armTimer = setTimeout(function () { btn.classList.remove('armed'); btn.textContent = 'Xoá hàng đợi'; }, 4000);
      return;
    }
    clearTimeout(armTimer);
    btn.classList.remove('armed');
    btn.textContent = 'Xoá hàng đợi';
    compola.call('clear').then(function (s) { render(s); showResult(true, 'Đã xoá hàng đợi.'); }, function (e) { showResult(false, e.message || String(e)); });
  });

  compola.on('status', render);
  // Settings are saved outside this view: poll a little so the state follows them.
  setInterval(load, 5000);
  compola.ready(load);
})();
