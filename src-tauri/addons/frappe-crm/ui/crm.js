// Frappe CRM card in the conversation's info panel: the linked lead, or candidates to link / a new lead to create.
(function () {
  var app = document.getElementById('app');
  var ctx = null;
  var state = null;
  var busy = false;
  var searchResults = null;
  var creating = false;

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function el(html) { app.innerHTML = html; }

  function load(fresh) {
    if (!ctx || !ctx.conversationId) { el('<div class="muted small">Mở một hội thoại để xem khách trong CRM.</div>'); return; }
    compola.call('state', { conversationId: ctx.conversationId, conversationName: ctx.conversationName, fresh: !!fresh }).then(function (s) {
      state = s; searchResults = null; creating = false; render();
    }, function (e) { state = { error: e.message }; render(); });
  }

  function leadCard(l, extra) {
    return '<div class="card">' +
      '<div class="row"><div class="grow"><div class="lead-name truncate">' + esc(l.title) + '</div>' +
      (l.organization ? '<div class="small muted truncate">' + esc(l.organization) + '</div>' : '') + '</div>' +
      (l.status ? '<span class="chip accent">' + esc(l.status) + '</span>' : '') + '</div>' +
      '<dl class="kv">' +
      (l.mobile ? '<dt>Điện thoại</dt><dd>' + esc(l.mobile) + '</dd>' : '') +
      (l.email ? '<dt>Email</dt><dd>' + esc(l.email) + '</dd>' : '') +
      (l.owner ? '<dt>Phụ trách</dt><dd>' + esc(l.owner) + '</dd>' : '') +
      '<dt>Mã lead</dt><dd class="url" title="' + esc(l.url) + '">' + esc(l.name) + '</dd>' +
      '</dl>' + (extra || '') + '</div>';
  }

  function render() {
    var s = state || {};
    if (!s.configured) {
      el('<div class="note">Chưa kết nối CRM. Vào <b>Cài đặt › Add-on › Frappe CRM › Tuỳ chỉnh</b> và nhập địa chỉ CRM, API Key, API Secret.</div>');
      return;
    }
    var html = '';
    if (s.error) html += '<div class="error">' + esc(s.error) + '</div>';
    if (s.lead) {
      var posted = s.posted && s.posted.lead === s.lead.name ? '<div class="small success" style="margin-top:8px">✓ Đã ghi tóm tắt ' + esc(s.posted.day) + '</div>' : '';
      html += leadCard(s.lead, posted +
        '<div class="actions"><button class="primary" data-act="summary">Tóm tắt hôm nay → CRM</button>' +
        '<button data-act="refresh" title="Tải lại từ CRM">↻</button></div>' +
        '<div class="actions" style="margin-top:6px"><button class="link small" data-act="unlink">Đổi lead khác</button></div>');
      if (s.autoLinked) html = '<div class="small muted" style="margin-bottom:6px">Tự liên kết theo số điện thoại trong chat.</div>' + html;
      el(html);
      return;
    }
    if (s.missing) html += '<div class="note">Lead ' + esc(s.missing.title || s.missing.name) + ' không còn trong CRM. Chọn lead khác.</div>';
    var list = searchResults || s.leads || [];
    html += '<div class="section-title">' + (searchResults ? 'Kết quả tìm' : list.length ? 'Có thể là' : 'Chưa liên kết lead') + '</div>';
    if (list.length) {
      html += '<div class="list">' + list.map(function (l) {
        return '<div class="cand"><div class="grow"><div class="truncate"><b>' + esc(l.title) + '</b>' + (l.status ? ' <span class="chip">' + esc(l.status) + '</span>' : '') + '</div>' +
          '<div class="why truncate">' + esc([l.reason, l.mobile, l.organization].filter(Boolean).join(' · ')) + '</div></div>' +
          '<button data-act="link" data-name="' + esc(l.name) + '">Liên kết</button></div>';
      }).join('') + '</div>';
    } else if (!searchResults) {
      html += '<div class="small muted">Không thấy lead nào khớp số điện thoại hoặc tên trong chat.</div>';
    } else {
      html += '<div class="small muted">Không có kết quả.</div>';
    }
    html += '<div class="search"><input id="q" placeholder="Tìm theo tên, SĐT, email, mã lead…"><button data-act="search">Tìm</button></div>';
    if (creating) {
      var phone = (s.phones && s.phones[0]) || '';
      html += '<div class="form"><input id="cn" placeholder="Tên khách" value="' + esc((ctx && ctx.conversationName) || '') + '">' +
        '<input id="cm" placeholder="Số điện thoại" value="' + esc(phone) + '"><input id="co" placeholder="Công ty (tuỳ chọn)">' +
        '<div class="row"><button class="primary" data-act="create-go">Tạo lead và liên kết</button><button data-act="create-cancel">Huỷ</button></div></div>';
    } else {
      html += '<div class="actions"><button data-act="create">+ Tạo lead mới</button></div>';
    }
    el(html);
    var q = document.getElementById('q');
    if (q) q.addEventListener('keydown', function (e) { if (e.key === 'Enter') act('search'); });
  }

  function run(p, after) {
    if (busy) return;
    busy = true;
    app.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    p.then(function (v) { busy = false; after(v); }, function (e) {
      busy = false; state = Object.assign({}, state, { error: e.message }); render();
    });
  }

  function act(name, target) {
    var conv = ctx && ctx.conversationId;
    if (name === 'summary') compola.openView('summary', {});
    else if (name === 'refresh') { el('<span class="spin"></span>'); load(true); }
    else if (name === 'unlink') run(compola.call('unlink', { conversationId: conv }), function () { load(false); });
    else if (name === 'link') run(compola.call('link', { conversationId: conv, name: target.getAttribute('data-name') }), function () { load(false); });
    else if (name === 'search') {
      var q = (document.getElementById('q') || {}).value || '';
      run(compola.call('search', { query: q }), function (rows) { searchResults = rows; render(); var i = document.getElementById('q'); if (i) i.value = q; });
    } else if (name === 'create') { creating = true; render(); }
    else if (name === 'create-cancel') { creating = false; render(); }
    else if (name === 'create-go') {
      run(compola.call('create', {
        conversationId: conv,
        name: document.getElementById('cn').value,
        mobile: document.getElementById('cm').value,
        organization: document.getElementById('co').value,
      }), function (lead) { compola.toast('Đã tạo lead ' + (lead.title || lead.name)); load(true); });
    }
  }

  app.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (b && !b.disabled) act(b.getAttribute('data-act'), b);
  });

  compola.ready(function (c) { ctx = c; load(false); });
  compola.on('context', function (c) {
    var changed = !ctx || c.conversationId !== ctx.conversationId;
    ctx = c;
    if (changed) { el('<span class="spin"></span>'); load(false); }
  });
  compola.on('changed', function (d) { if (d && ctx && d.conversationId === ctx.conversationId) load(false); });
})();
