const $ = (id) => document.getElementById(id);
const fail = (e) => ($('err').textContent = e.message || String(e));

async function load() {
  const ctx = compola.context;
  if (!ctx || !ctx.conversationId) return;
  try {
    const c = await compola.call('customer');
    $('stages').innerHTML = '';
    for (const s of c.stages) {
      const b = document.createElement('button');
      b.className = 'chip' + (s === c.stage ? ' on' : '');
      b.textContent = s;
      b.onclick = () => compola.call('setStage', { stage: s, name: ctx.conversationName }).then(load, fail);
      $('stages').appendChild(b);
    }
    $('tags').value = c.tags.join(', ');
    const total = c.orders.reduce((s, o) => s + o.quantity * o.price, 0);
    $('orders').textContent = c.orders.length ? `${c.orders.length} đơn · ${total.toLocaleString('vi-VN')} ₫` : 'Chưa có';
    $('err').textContent = '';
  } catch (e) {
    fail(e);
  }
}

$('tags').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  compola.call('setTags', { tags: $('tags').value.split(','), name: compola.context.conversationName }).then(() => compola.toast('Đã lưu nhãn'), fail);
});
$('order').onclick = () => compola.openView('order');

compola.ready(load);
compola.on('context', load); // another conversation
compola.on('changed', (d) => (!d || d.conversationId === compola.context.conversationId) && load());
