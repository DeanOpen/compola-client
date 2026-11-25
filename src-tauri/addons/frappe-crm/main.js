// Frappe CRM for Compola: links a Zalo conversation to a CRM Lead (found by the phone numbers in the chat or by
// name, or created), and writes today's conversation summary as a comment on that lead.
//
// Frappe REST: POST {url}/api/method/<method> with `Authorization: token <key>:<secret>`, answer `{message}`.
// Methods: frappe.client.get_list / insert (stock), crm.api.comment.add_comment (Frappe CRM), and when the site has
// it, crm.nextwaves.lead_dedupe.check_lead_duplicate (phone match with +84 folded to 0).

const LEAD_FIELDS = ['name', 'lead_name', 'first_name', 'organization', 'status', 'mobile_no', 'phone', 'email', 'lead_owner', 'converted', 'modified'];
const MAX_LINKS = 5000;
const MAX_TRANSCRIPT = 12000;
const CACHE_MS = 60_000;

const s = () => compola.settings || {};
const warn = (where, e) => compola.warn(`${where}: ${(e && e.message) || e}`);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// ---- settings ----

const base = () => {
  const u = String(s().url || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+/i.test(u) ? u.replace(/\/(app|crm)(\/.*)?$/i, '') : '';
};
const configured = () => !!(base() && String(s().apiKey || '').trim() && String(s().apiSecret || '').trim());
const leadUrl = (name) => `${base()}/crm/leads/${encodeURIComponent(name)}`;

// ---- Frappe client ----

class CrmError extends Error {}

const frappeMessage = (body) => {
  try {
    const j = JSON.parse(body);
    if (j._server_messages) {
      const list = JSON.parse(j._server_messages);
      const texts = list.map((m) => { try { return JSON.parse(m).message; } catch (e) { return String(m); } }).filter(Boolean);
      if (texts.length) return texts.join(' · ').replace(/<[^>]+>/g, '');
    }
    if (j.exception) return String(j.exception).split('\n')[0].replace(/^[\w.]+: /, '');
    if (j.message && typeof j.message === 'string') return j.message;
  } catch (e) { /* not JSON */ }
  return '';
};

async function call(method, args) {
  if (!configured()) throw new CrmError('Chưa nhập địa chỉ CRM và API key trong tuỳ chỉnh của add-on.');
  let r;
  try {
    r = await fetch(`${base()}/api/method/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `token ${String(s().apiKey).trim()}:${String(s().apiSecret).trim()}`,
      },
      body: JSON.stringify(args || {}),
      timeoutMs: 20000,
    });
  } catch (e) {
    throw new CrmError(`Không kết nối được CRM (${base()}): ${(e && e.message) || e}`);
  }
  const text = await r.text();
  if (r.status === 401) throw new CrmError('CRM từ chối đăng nhập: kiểm tra API Key và API Secret.');
  if (r.status === 403) throw new CrmError(frappeMessage(text) || 'Tài khoản API không có quyền với CRM Lead.');
  if (!r.ok) {
    const err = new CrmError(frappeMessage(text) || `CRM trả lỗi ${r.status}`);
    err.status = r.status;
    throw err;
  }
  try {
    return JSON.parse(text).message;
  } catch (e) {
    throw new CrmError('CRM trả về dữ liệu không đọc được (địa chỉ có đúng là Frappe không?)');
  }
}

const getList = (doctype, opts) =>
  call('frappe.client.get_list', { doctype, fields: LEAD_FIELDS, limit_page_length: 8, order_by: 'modified desc', ...opts });

const leadView = (l) => ({
  name: l.name,
  title: l.lead_name || [l.first_name].filter(Boolean).join(' ') || l.name,
  organization: l.organization || '',
  status: l.status || '',
  mobile: l.mobile_no || l.phone || '',
  email: l.email || '',
  owner: l.lead_owner || '',
  converted: !!l.converted,
  url: leadUrl(l.name),
});

// ---- phones in the chat ----

/** Vietnamese mobile numbers written in messages, normalised to 0xxxxxxxxx, most recent first. */
function phonesIn(messages) {
  const seen = [];
  for (const m of messages.slice().reverse()) {
    const text = String((m && m.text) || '');
    const found = text.match(/(?:\+?84|0)[\s.\-]?(?:\d[\s.\-]?){8,9}\d?/g) || [];
    for (const raw of found) {
      let d = raw.replace(/\D/g, '');
      if (d.startsWith('84')) d = '0' + d.slice(2);
      if (/^0[35789]\d{8}$/.test(d) && !seen.includes(d)) seen.push(d);
    }
    if (seen.length >= 3) break;
  }
  return seen;
}

let dedupeEndpoint = true; // the site's own phone matcher, until it turns out to be missing

async function leadsByPhone(phone) {
  if (dedupeEndpoint) {
    try {
      const rows = await call('crm.nextwaves.lead_dedupe.check_lead_duplicate', { mobile_no: phone });
      if (Array.isArray(rows)) {
        if (!rows.length) return [];
        const names = rows.map((r) => r.name).filter(Boolean);
        return await getList('CRM Lead', { filters: [['name', 'in', names]] });
      }
    } catch (e) {
      if (!(e instanceof CrmError) || e.status === undefined) throw e;
      dedupeEndpoint = false; // stock Frappe CRM: fall back to a LIKE on the last 9 digits
    }
  }
  const tail = '%' + phone.slice(-9);
  const a = await getList('CRM Lead', { filters: [['mobile_no', 'like', tail]] });
  const b = await getList('CRM Lead', { filters: [['phone', 'like', tail]] });
  const out = [...a];
  for (const l of b) if (!out.some((x) => x.name === l.name)) out.push(l);
  return out;
}

const cleanName = (name) => String(name || '').replace(/[^\p{L}\p{N}\s.'-]/gu, ' ').replace(/\s+/g, ' ').trim();

async function leadsByName(name) {
  const n = cleanName(name);
  if (n.length < 3) return [];
  return getList('CRM Lead', { or_filters: [['lead_name', 'like', `%${n}%`], ['organization', 'like', `%${n}%`]], limit_page_length: 5 });
}

// ---- links (conversation → lead), kept in storage ----

const links = () => obj(compola.storage.get('links'));
async function saveLink(conv, lead) {
  const map = links();
  if (lead) map[conv] = { name: lead.name, title: lead.title, at: Date.now() };
  else delete map[conv];
  const ids = Object.keys(map);
  if (ids.length > MAX_LINKS) {
    ids.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
    for (const id of ids.slice(0, ids.length - MAX_LINKS)) delete map[id];
  }
  await compola.storage.set('links', map);
  await compola.views.post('changed', { conversationId: conv }, { conversationId: conv }).catch(() => {});
}

const leadCache = new Map();
async function fetchLead(name, fresh) {
  const c = leadCache.get(name);
  if (!fresh && c && Date.now() - c.at < CACHE_MS) return c.lead;
  const rows = await getList('CRM Lead', { filters: [['name', '=', name]], limit_page_length: 1 });
  const lead = rows && rows[0] ? leadView(rows[0]) : null;
  leadCache.set(name, { at: Date.now(), lead });
  return lead;
}

async function candidates(conv, convName) {
  const since = Date.now() - 90 * 86400000;
  const msgs = await compola.history(conv, { since, limit: 400 }).catch(() => []);
  const phones = phonesIn(Array.isArray(msgs) ? msgs : []);
  const out = [];
  const add = (rows, reason) => {
    for (const l of rows || []) {
      if (!l || !l.name || out.some((x) => x.name === l.name)) continue;
      out.push({ ...leadView(l), reason });
    }
  };
  for (const p of phones) add(await leadsByPhone(p), `SĐT ${p}`);
  if (convName) add(await leadsByName(convName), 'Trùng tên');
  return { phones, leads: out.slice(0, 8) };
}

// ---- today's summary ----

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayLabel = (t = Date.now()) => new Date(t).toLocaleDateString('vi-VN');
const timeLabel = (t) => new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

async function todaysMessages(conv) {
  const list = await compola.history(conv, { since: startOfToday(), limit: 500 });
  return (Array.isArray(list) ? list : []).filter((m) => m && String(m.text || '').trim());
}

function transcript(msgs, convName) {
  const lines = msgs.map((m) => `[${timeLabel(m.date)}] ${m.fromMe ? 'Nhân viên' : m.senderName || convName || 'Khách'}: ${String(m.text).replace(/\s+/g, ' ').trim()}`);
  let text = lines.join('\n');
  if (text.length > MAX_TRANSCRIPT) text = '…\n' + text.slice(-MAX_TRANSCRIPT);
  return text;
}

const SYSTEM =
  'Bạn là trợ lý bán hàng. Tóm tắt cuộc trò chuyện Zalo hôm nay giữa nhân viên và khách để ghi vào CRM. ' +
  'Viết tiếng Việt, ngắn gọn, mỗi ý một dòng bắt đầu bằng "- ", tối đa 8 dòng, theo thứ tự: nhu cầu / câu hỏi của khách; ' +
  'sản phẩm, giá, số lượng đã trao đổi; điều hai bên đã thống nhất hoặc hứa; việc cần làm tiếp (ai, khi nào); mức độ quan tâm của khách. ' +
  'Chỉ ghi điều có trong hội thoại, giữ nguyên số điện thoại, giá, ngày. Không chào hỏi, không lời dẫn.';

async function summarize(conv, convName) {
  const msgs = await todaysMessages(conv);
  if (!msgs.length) return { count: 0, text: '', ai: false };
  const incoming = msgs.filter((m) => !m.fromMe).length;
  if (await compola.ai.available().catch(() => false)) {
    try {
      const focus = String(s().focus || '').trim();
      const out = await compola.ai.complete({
        system: SYSTEM + (focus ? ` Chú ý thêm: ${focus}` : ''),
        prompt: `Khách: ${convName || 'khách'}\nHội thoại hôm nay (${dayLabel()}):\n${transcript(msgs, convName)}`,
        maxTokens: 900,
        effort: 'low',
      });
      const text = String((out && out.text) || '').trim();
      if (text && text !== '{}') return { count: msgs.length, incoming, text, ai: true };
    } catch (e) {
      warn('AI tóm tắt', e);
    }
  }
  // Without AI: the customer's own messages of the day.
  const quoted = msgs.filter((m) => !m.fromMe).slice(-10).map((m) => `- ${timeLabel(m.date)}: ${String(m.text).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  return { count: msgs.length, incoming, text: [`${msgs.length} tin hôm nay (${incoming} tin của khách).`, ...quoted].join('\n'), ai: false };
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The comment's HTML: a heading line, then "- " lines as a list and other lines as paragraphs. */
function commentHtml(text, meta) {
  const out = [`<p><b>Zalo</b> · Tóm tắt ${esc(meta.day)}${meta.count ? ` (${meta.count} tin)` : ''}${meta.who ? ` · ${esc(meta.who)}` : ''}</p>`];
  let list = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`); list = []; } };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = /^[-•*]\s+(.*)$/.exec(line);
    if (bullet) list.push(bullet[1]);
    else { flush(); out.push(`<p>${esc(line)}</p>`); }
  }
  flush();
  return out.join('');
}

// ---- views ----

compola.views.handle('state', async (data, ctx) => {
  const conv = String((data && data.conversationId) || ctx.conversationId || '');
  if (!conv) return { configured: configured(), conversation: null };
  const info = { configured: configured(), crmUrl: configured() ? base() : '', conversationId: conv, posted: obj(compola.storage.get('posted'))[conv] || null };
  if (!configured()) return info;
  const link = links()[conv];
  try {
    if (link) {
      const lead = await fetchLead(link.name, !!(data && data.fresh));
      if (lead) return { ...info, lead };
      return { ...info, lead: null, missing: link };
    }
    const found = await candidates(conv, (data && data.conversationName) || ctx.conversationName);
    if (s().autoLink !== false) {
      const byPhone = found.leads.filter((l) => l.reason.startsWith('SĐT'));
      if (byPhone.length === 1) {
        await saveLink(conv, byPhone[0]);
        return { ...info, lead: byPhone[0], autoLinked: true };
      }
    }
    return { ...info, lead: null, ...found };
  } catch (e) {
    return { ...info, error: (e && e.message) || String(e) };
  }
});

compola.views.handle('search', async (data) => {
  const q = cleanName(data && data.query);
  if (q.length < 2) return [];
  const digits = q.replace(/\D/g, '');
  const rows = digits.length >= 8
    ? await leadsByPhone(digits.startsWith('84') ? '0' + digits.slice(2) : digits)
    : await getList('CRM Lead', { or_filters: [['lead_name', 'like', `%${q}%`], ['organization', 'like', `%${q}%`], ['email', 'like', `%${q}%`], ['name', 'like', `%${q}%`]], limit_page_length: 10 });
  return (rows || []).map(leadView);
});

compola.views.handle('link', async (data, ctx) => {
  const conv = String((data && data.conversationId) || ctx.conversationId || '');
  const lead = await fetchLead(String((data && data.name) || ''), true);
  if (!conv || !lead) throw new Error('Không tìm thấy lead này trong CRM');
  await saveLink(conv, lead);
  return lead;
});

compola.views.handle('unlink', async (data, ctx) => {
  const conv = String((data && data.conversationId) || ctx.conversationId || '');
  if (conv) await saveLink(conv, null);
  return true;
});

compola.views.handle('create', async (data, ctx) => {
  const conv = String((data && data.conversationId) || ctx.conversationId || '');
  const name = cleanName(data && data.name) || cleanName(ctx.conversationName) || 'Khách Zalo';
  const mobile = String((data && data.mobile) || '').replace(/[^\d+]/g, '');
  const doc = { doctype: 'CRM Lead', first_name: name, lead_name: name };
  if (mobile) doc.mobile_no = mobile;
  if (data && data.organization) doc.organization = String(data.organization).slice(0, 140);
  const source = String(s().leadSource || '').trim();
  let created;
  try {
    created = await call('frappe.client.insert', { doc: source ? { ...doc, source } : doc });
  } catch (e) {
    // A source the site does not have: create without it rather than fail.
    if (!source || !/source|Lead Source|Could not find|không tìm thấy/i.test(String(e && e.message))) throw e;
    created = await call('frappe.client.insert', { doc });
  }
  const lead = leadView(obj(created));
  if (conv && lead.name) await saveLink(conv, lead);
  return lead;
});

compola.views.handle('summarize', async (data, ctx) => {
  const conv = String((data && data.conversationId) || ctx.conversationId || '');
  if (!conv) throw new Error('Chưa chọn hội thoại');
  const link = links()[conv];
  const lead = link && configured() ? await fetchLead(link.name).catch(() => null) : null;
  const sum = await summarize(conv, ctx.conversationName);
  return { ...sum, day: dayLabel(), lead, configured: configured(), posted: obj(compola.storage.get('posted'))[conv] || null };
});

compola.views.handle('post', async (data, ctx) => {
  const conv = String((data && data.conversationId) || ctx.conversationId || '');
  const text = String((data && data.text) || '').trim();
  if (!text) throw new Error('Nội dung tóm tắt đang trống');
  const link = links()[conv];
  if (!link) throw new Error('Hội thoại chưa liên kết với lead nào trong CRM');
  const who = (ctx.user && ctx.user.name) || '';
  await call('crm.api.comment.add_comment', {
    reference_doctype: 'CRM Lead',
    reference_name: link.name,
    content: commentHtml(text, { day: dayLabel(), count: Number(data && data.count) || 0, who: who && who !== 'Tôi' ? who : '' }),
  });
  const posted = obj(compola.storage.get('posted'));
  posted[conv] = { at: Date.now(), day: dayLabel(), lead: link.name };
  const keys = Object.keys(posted);
  if (keys.length > MAX_LINKS) for (const k of keys.sort((a, b) => posted[a].at - posted[b].at).slice(0, keys.length - MAX_LINKS)) delete posted[k];
  await compola.storage.set('posted', posted);
  await compola.notes
    .add(conv, `Đã ghi tóm tắt ${dayLabel()} vào CRM (lead ${link.title || link.name}).`, { key: `crm-summary-${dayLabel()}`, tags: ['CRM'] })
    .catch((e) => warn('ghi chú', e));
  await compola.views.post('changed', { conversationId: conv }, { conversationId: conv }).catch(() => {});
  return { ok: true, lead: link.name, url: leadUrl(link.name) };
});

// ---- automatic linking when a phone number shows up ----

const pending = new Map();
compola.on('message', (m) => {
  try {
    if (!m || m.isGroup || !configured() || s().autoLink === false) return;
    const conv = String(m.conversationId || '');
    if (!conv || links()[conv] || !phonesIn([m]).length) return;
    clearTimeout(pending.get(conv));
    pending.set(conv, setTimeout(async () => {
      pending.delete(conv);
      try {
        const phones = phonesIn([m]);
        const rows = await leadsByPhone(phones[0]);
        if (rows.length === 1 && !links()[conv]) {
          const lead = leadView(rows[0]);
          await saveLink(conv, lead);
          compola.log(`liên kết ${m.conversationName || conv} → ${lead.name} (SĐT ${phones[0]})`);
        }
      } catch (e) {
        warn('tự liên kết', e);
      }
    }, 3000));
  } catch (e) {
    warn('tin nhắn', e);
  }
});

compola.on('ready', () => {
  if (!configured()) compola.log('chưa cấu hình: nhập địa chỉ CRM, API Key và API Secret trong tuỳ chỉnh');
});
