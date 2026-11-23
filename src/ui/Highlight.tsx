// Search-result text with the query words marked, accent-insensitive ("hop" marks "Họp"): the settings search and the
// message results of the conversation list.

/** `text` with the query words (accent-insensitive) wrapped in <mark>. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const words = fold(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (!words.length) return <>{text}</>;
  // Fold per character so offsets in the folded text map back to the original.
  const chars = [...text];
  const folded = chars.map((c) => fold(c) || c);
  const flat = folded.join('');
  const marks = new Array(chars.length).fill(false);
  const starts: number[] = [];
  let pos = 0;
  for (const f of folded) {
    starts.push(pos);
    pos += f.length;
  }
  for (const w of words) {
    let i = flat.indexOf(w);
    while (i >= 0) {
      chars.forEach((_, k) => {
        if (starts[k] >= i && starts[k] < i + w.length) marks[k] = true;
      });
      i = flat.indexOf(w, i + w.length);
    }
  }
  const out: { text: string; mark: boolean }[] = [];
  chars.forEach((c, k) => {
    const last = out[out.length - 1];
    if (last && last.mark === marks[k]) last.text += c;
    else out.push({ text: c, mark: marks[k] });
  });
  return <>{out.map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}
