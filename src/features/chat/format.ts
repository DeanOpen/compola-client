// Swift `ChatFormat`: times, day separators, durations, sizes, link / mention runs of a message text.

import type { Mention } from '../../engine/models/chat';

const pad = (n: number) => String(n).padStart(2, '0');

export const time = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
};

const weekday = new Intl.DateTimeFormat('vi-VN', { weekday: 'long' });

/** "Hôm nay", "Hôm qua", "Thứ Hai, 03/11" (this year) or "03/11/2025". */
export const daySeparator = (ms: number) => {
  const d = new Date(ms);
  const now = new Date();
  if (sameDay(d, now)) return 'Hôm nay';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Hôm qua';
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  if (d.getFullYear() === now.getFullYear()) {
    const w = weekday.format(d);
    return `${w.charAt(0).toUpperCase()}${w.slice(1)}, ${date}`;
  }
  return `${date}/${d.getFullYear()}`;
};

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

export const host = (url: string | null) => {
  if (!url) return '';
  try {
    const h = new URL(url).hostname;
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch {
    return '';
  }
};

export type TextRun =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'mention'; text: string; uid: string; aimsAtMe: boolean; clickable: boolean };

const linkPattern = /\b((?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}])/gi;

const linkify = (text: string): TextRun[] => {
  const out: TextRun[] = [];
  let last = 0;
  for (const m of text.matchAll(linkPattern)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    const raw = m[0];
    out.push({ kind: 'link', text: raw, url: raw.startsWith('www.') ? `https://${raw}` : raw });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
};

/**
 * Link-detected text plus official @mention highlighting. Ranges are the message's `mentions` (UTF-16 offsets = JS
 * string indices); a range that does not start with "@" is ignored. Mentions of me (or everyone) are flagged.
 */
export const textRuns = (text: string, mentions: Mention[], myId: string | null): TextRun[] => {
  const valid = mentions
    .filter((m) => m.pos >= 0 && m.len > 1 && m.pos + m.len <= text.length && text.charCodeAt(m.pos) === 0x40)
    .sort((a, b) => a.pos - b.pos);
  const out: TextRun[] = [];
  let at = 0;
  for (const m of valid) {
    if (m.pos < at) continue;
    if (m.pos > at) out.push(...linkify(text.slice(at, m.pos)));
    const aimsAtMe = m.isAll || (myId !== null && m.uid === myId);
    out.push({ kind: 'mention', text: text.slice(m.pos, m.pos + m.len), uid: m.uid, aimsAtMe, clickable: !m.isAll && m.uid !== myId });
    at = m.pos + m.len;
  }
  if (at < text.length) out.push(...linkify(text.slice(at)));
  return out;
};
