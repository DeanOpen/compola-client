(function () {
  'use strict';
  var M = window.Mood;
  var $ = function (id) { return document.getElementById(id); };
  var data = { items: [], today: { total: 0, happy: 0, neutral: 0, unhappy: 0 } };
  var onlyUnhappy = false;
  try { onlyUnhappy = localStorage.getItem('mood.onlyUnhappy') === '1'; } catch (e) { /* no storage in the sandbox */ }

  function pct(n, total) { return total ? Math.round((n / total) * 100) : 0; }

  function renderSummary() {
    var t = data.today || {};
    var total = Number(t.total) || 0;
    var parts = [
      { key: 'happy', n: Number(t.happy) || 0, label: 'Hài lòng', color: 'var(--m1)' },
      { key: 'neutral', n: Number(t.neutral) || 0, label: 'Bình thường', color: 'var(--m0)' },
      { key: 'unhappy', n: Number(t.unhappy) || 0, label: 'Không hài lòng', color: 'var(--m-2)' },
    ];
    $('total').textContent = total ? total + ' hội thoại được đánh giá' : 'Chưa có đánh giá nào';
    var bar = $('bar');
    bar.textContent = '';
    parts.forEach(function (p) {
      if (!p.n) return;
      var s = M.el('span');
      s.style.width = pct(p.n, total) + '%';
      s.style.background = p.color;
      s.title = p.label + ': ' + p.n;
      bar.appendChild(s);
    });
    var legend = $('legend');
    legend.textContent = '';
    parts.forEach(function (p) {
      var d = M.el('div');
      var dot = M.el('span', 'dot');
      dot.style.background = p.color;
      d.appendChild(dot);
      d.appendChild(M.el('b', null, pct(p.n, total) + '%'));
      d.appendChild(M.el('small', null, p.label));
      d.title = p.label + ': ' + p.n + ' hội thoại';
      legend.appendChild(d);
    });
  }

  function renderList() {
    var list = $('list');
    list.textContent = '';
    var items = (Array.isArray(data.items) ? data.items : []).filter(function (r) { return r && (!onlyUnhappy || Number(r.score) < 0); });
    if (!items.length) {
      var empty = M.el('div', 'empty');
      empty.appendChild(M.el('div', 'big', onlyUnhappy ? '🙂' : '🌡️'));
      empty.appendChild(M.el('div', null, onlyUnhappy
        ? 'Không có khách nào đang không hài lòng.'
        : 'Chưa có đánh giá. Khi khách nhắn tin, AI sẽ đánh giá cảm xúc sau khi khách nhắn xong.'));
      list.appendChild(empty);
      return;
    }
    items.forEach(function (r) {
      var st = M.step(r.score);
      var row = M.el('button', 'row ' + M.cls(r.score));
      row.type = 'button';
      var face = M.el('span', 'face', st.emoji);
      face.title = st.label;
      row.appendChild(face);
      var main = M.el('div', 'main');
      var name = M.el('div', 'name');
      name.appendChild(M.el('b', null, r.name || 'Hội thoại'));
      if (r.isGroup) name.appendChild(M.el('span', 'chip', 'Nhóm'));
      if (r.urgent && Number(r.score) < 0) name.appendChild(M.el('span', 'chip urgent', 'Gấp'));
      main.appendChild(name);
      if (r.reason) main.appendChild(M.el('div', 'reason', r.reason));
      row.appendChild(main);
      var side = M.el('div', 'side');
      var top = M.el('div');
      top.appendChild(M.el('span', 'label', (r.label || st.label) + ' '));
      if (Array.isArray(r.history) && r.history.length > 1) top.appendChild(M.trendEl(r.trend));
      side.appendChild(top);
      side.appendChild(M.el('span', 'muted', M.when(r.t)));
      row.appendChild(side);
      row.addEventListener('click', function () {
        compola.openConversation(r.id).catch(function (e) { $('err').textContent = e.message || String(e); });
      });
      list.appendChild(row);
    });
  }

  function render() {
    renderSummary();
    renderList();
  }

  var loading = false;
  var again = false;
  function load() {
    if (loading) { again = true; return; }
    loading = true;
    compola.call('list').then(function (res) {
      if (res && typeof res === 'object') data = res;
      $('err').textContent = '';
      render();
    }, function (e) {
      $('err').textContent = 'Không tải được: ' + (e.message || e);
    }).then(function () {
      loading = false;
      if (again) { again = false; load(); }
    });
  }

  var filter = $('filter');
  filter.checked = onlyUnhappy;
  $('filterWrap').classList.toggle('on', onlyUnhappy);
  filter.addEventListener('change', function () {
    onlyUnhappy = filter.checked;
    $('filterWrap').classList.toggle('on', onlyUnhappy);
    try { localStorage.setItem('mood.onlyUnhappy', onlyUnhappy ? '1' : '0'); } catch (e) { /* ignore */ }
    renderList();
  });
  $('refresh').addEventListener('click', load);

  var timer = null;
  compola.on('mood', function () { clearTimeout(timer); timer = setTimeout(load, 300); });
  setInterval(function () { renderList(); }, 60000); // keep "x phút trước" fresh
  compola.ready(load);
})();
