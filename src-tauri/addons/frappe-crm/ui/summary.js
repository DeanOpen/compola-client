// "Tóm tắt hôm nay → CRM": AI drafts today's summary, the person checks / edits it, it becomes a comment on the lead.
(function () {
  var app = document.getElementById('app');
  var ctx = null;
  var data = null;

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function load() {
    app.innerHTML = '<div class="row muted"><span class="spin"></span> Đang đọc tin nhắn hôm nay' + ' và tóm tắt…</div>';
    compola.call('summarize', { conversationId: ctx.conversationId }).then(function (d) { data = d; render(); }, function (e) {
      app.innerHTML = '<div class="error">' + esc(e.message) + '</div><div class="foot"><span class="grow"></span><button data-act="close">Đóng</button></div>';
    });
  }

  function render() {
    var d = data;
    var head = '<div class="row"><div class="grow"><div class="lead-name">Tóm tắt ' + esc(d.day) + '</div>' +
      '<div class="small muted">' + esc((ctx.conversationName || 'Hội thoại') + ' · ' + d.count + ' tin hôm nay' + (d.ai ? ' · AI soạn, bạn sửa được' : '')) + '</div></div>' +
      (d.lead ? '<span class="chip accent" title="' + esc(d.lead.url) + '">→ ' + esc(d.lead.title) + '</span>' : '') + '</div>';
    if (!d.configured) {
      app.innerHTML = head + '<div class="note">Chưa kết nối CRM: nhập địa chỉ CRM và API key trong Cài đặt › Add-on › Frappe CRM.</div><div class="foot"><span class="grow"></span><button data-act="close">Đóng</button></div>';
      return;
    }
    if (!d.lead) {
      app.innerHTML = head + '<div class="note">Hội thoại này chưa liên kết với lead nào. Liên kết ở mục <b>Frappe CRM</b> trong bảng thông tin hội thoại rồi thử lại.</div><div class="foot"><span class="grow"></span><button data-act="close">Đóng</button></div>';
      return;
    }
    if (!d.count) {
      app.innerHTML = head + '<div class="note">Hôm nay chưa có tin nhắn nào để tóm tắt.</div><div class="foot"><span class="grow"></span><button data-act="close">Đóng</button></div>';
      return;
    }
    var again = d.posted && d.posted.day === d.day ? '<div class="small muted">Hôm nay đã ghi một bản tóm tắt cho khách này; ghi tiếp sẽ thêm bình luận mới.</div>' : '';
    app.innerHTML = head + again +
      '<textarea id="t" spellcheck="false">' + esc(d.text) + '</textarea>' +
      '<div class="foot"><button data-act="redo" title="Tóm tắt lại">↻ Tóm tắt lại</button><span class="grow"></span>' +
      '<button data-act="close">Huỷ</button><button class="primary" data-act="post">Ghi vào CRM</button></div>';
  }

  function act(name, btn) {
    if (name === 'close') compola.close(null);
    else if (name === 'redo') load();
    else if (name === 'post') {
      var text = document.getElementById('t').value;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> Đang ghi…';
      compola.call('post', { conversationId: ctx.conversationId, text: text, count: data.count }).then(function () {
        compola.toast('Đã ghi tóm tắt vào lead ' + data.lead.title);
        compola.close({ ok: true });
      }, function (e) {
        btn.disabled = false;
        btn.textContent = 'Ghi vào CRM';
        var old = document.querySelector('.error');
        if (old) old.remove();
        var div = document.createElement('div');
        div.className = 'error';
        div.textContent = e.message;
        document.querySelector('.foot').before(div);
      });
    }
  }

  app.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (b && !b.disabled) act(b.getAttribute('data-act'), b);
  });
  compola.ready(function (c) { ctx = c; load(); });
})();
