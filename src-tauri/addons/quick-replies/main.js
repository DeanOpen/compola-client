// Tin nhắn nhanh — built-in Compola add-on: quick replies from one settings field.

/** "/chao | Xin chào" lines → [{shortcut, title, text}] (a line without "|" is skipped). */
const parse = (raw) =>
  String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('|'))
    .map((line) => {
      const i = line.indexOf('|');
      const shortcut = line.slice(0, i).trim().replace(/^\//, '');
      const text = line.slice(i + 1).trim().replace(/\\n/g, '\n');
      return { shortcut, title: text.split('\n')[0].slice(0, 60), text };
    })
    .filter((q) => q.shortcut && !/\s/.test(q.shortcut) && q.text);

const publish = async () => {
  const n = await compola.quickReplies.set(parse(compola.settings.replies));
  compola.log(`${n} mẫu tin nhắn nhanh`);
};

compola.on('ready', publish);
compola.on('settings', publish);
