// Zalo rich text ("Định dạng tin nhắn"): the official RTF ranges `{start, len, st}` (UTF-16 offsets into the text), `st`
// a comma list of tokens (official `normalizeFormat` / `denormalizeFormat`):
//   b · i · u · s              bold, italic, underline, strikethrough
//   f_<px>                     font size (13 Nhỏ, 15 Trung bình = no token, 18 Lớn, 20 Rất lớn)
//   c_<hex>                    text colour (the official palette below; black = no token)
//   ind_<n> · lst_1 · lst_2    indent, bullet list, numbered list (line-level; drawn, not offered by the composer)

import type { CSSProperties } from 'react';

export interface TextStyleRange {
  start: number;
  len: number;
  st: string;
}

/** Official sizes (`STR_FORMAT_*`, px). Medium sends no token. */
export const textSizes = [
  { px: 13, title: 'Nhỏ' },
  { px: 15, title: 'Trung bình' },
  { px: 18, title: 'Lớn' },
  { px: 20, title: 'Rất lớn' },
] as const;
export const mediumSize = 15;

/** Official text colours (`supportedColor`, black first = no token). */
export const textColors = [
  { hex: '', title: 'Mặc định' },
  { hex: 'db342e', title: 'Đỏ' },
  { hex: 'f27806', title: 'Cam' },
  { hex: 'f7b503', title: 'Vàng' },
  { hex: '15a85f', title: 'Xanh lá' },
] as const;

const TOKEN = /^(b|i|u|s|f_\d{1,2}|c_[0-9a-fA-F]{6}|ind_\d{1,3}|lst_[12])$/;

export const parseTextStyles = (v: unknown, length: number): TextStyleRange[] => {
  if (!Array.isArray(v)) return [];
  const out: TextStyleRange[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const { start, len, st } = r as Record<string, unknown>;
    if (typeof start !== 'number' || typeof len !== 'number' || !Number.isInteger(start) || !Number.isInteger(len)) continue;
    if (start < 0 || len <= 0 || start + len > length) continue;
    const tokens = String(st ?? '').split(',').filter((t) => TOKEN.test(t));
    if (tokens.length) out.push({ start, len, st: tokens.join(',') });
  }
  return out;
};

// MARK: Per-character marks (editing)

const marksOf = (length: number, ranges: TextStyleRange[]): string[][] => {
  const marks: string[][] = Array.from({ length }, () => []);
  for (const r of ranges)
    for (let i = r.start; i < Math.min(length, r.start + r.len); i += 1)
      for (const t of r.st.split(',')) if (t && !marks[i].includes(t)) marks[i].push(t);
  return marks;
};

const rangesOf = (marks: string[][]): TextStyleRange[] => {
  const out: TextStyleRange[] = [];
  let i = 0;
  while (i < marks.length) {
    const key = [...marks[i]].sort().join(',');
    let j = i + 1;
    while (j < marks.length && [...marks[j]].sort().join(',') === key) j += 1;
    if (key) out.push({ start: i, len: j - i, st: key });
    i = j;
  }
  return out;
};

/** The tokens every character of [start, end) carries (for the toolbar's active state). */
export const commonTokens = (length: number, ranges: TextStyleRange[], start: number, end: number): Set<string> => {
  const marks = marksOf(length, ranges);
  if (end <= start) {
    // A caret: the style of the character before it.
    return new Set(start > 0 ? marks[start - 1] : []);
  }
  let common: string[] | null = null;
  for (let i = start; i < end; i += 1) {
    const here = marks[i];
    common = common === null ? [...here] : common.filter((t: string) => here.includes(t));
  }
  return new Set<string>(common ?? []);
};

/** B / I / U / S on the selection: removed when every character has it, added otherwise. */
export const toggleToken = (length: number, ranges: TextStyleRange[], start: number, end: number, token: 'b' | 'i' | 'u' | 's') => {
  if (end <= start) return ranges;
  const marks = marksOf(length, ranges);
  const all = marks.slice(start, end).every((m) => m.includes(token));
  for (let i = start; i < end; i += 1) marks[i] = all ? marks[i].filter((t) => t !== token) : [...marks[i].filter((t) => t !== token), token];
  return rangesOf(marks);
};

/** Size / colour on the selection: the group's token replaced (null = the default, no token). */
export const setGroupToken = (length: number, ranges: TextStyleRange[], start: number, end: number, prefix: 'f_' | 'c_', token: string | null) => {
  if (end <= start) return ranges;
  const marks = marksOf(length, ranges);
  for (let i = start; i < end; i += 1) marks[i] = [...marks[i].filter((t) => !t.startsWith(prefix)), ...(token ? [token] : [])];
  return rangesOf(marks);
};

/** "Bỏ định dạng nội dung đã chọn" / "Bỏ tất cả định dạng". */
export const clearTokens = (length: number, ranges: TextStyleRange[], start: number, end: number) => {
  if (end <= start) return [];
  const marks = marksOf(length, ranges);
  for (let i = start; i < end; i += 1) marks[i] = [];
  return rangesOf(marks);
};

/** Follows a text edit: ranges before / after the changed part move with it, text typed inside a range takes its style. */
export const rebaseTextStyles = (oldText: string, newText: string, ranges: TextStyleRange[]): TextStyleRange[] => {
  if (!ranges.length || oldText === newText) return ranges;
  let prefix = 0;
  const max = Math.min(oldText.length, newText.length);
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) suffix += 1;
  const oldEnd = oldText.length - suffix;
  const newEnd = newText.length - suffix;
  const delta = newText.length - oldText.length;
  const out: TextStyleRange[] = [];
  for (const r of ranges) {
    const a = r.start;
    const b = r.start + r.len;
    const na = a < prefix ? a : a >= oldEnd ? a + delta : newEnd;
    // Typing at the very end of a styled run continues it (like rich-text editors).
    const nb = b <= prefix ? (b === prefix && oldEnd === prefix && delta > 0 ? b + delta : b) : b >= oldEnd ? b + delta : newEnd;
    if (nb > na) out.push({ start: na, len: nb - na, st: r.st });
  }
  return out;
};

/** Shifts and clips to a trimmed text (`leading` characters removed, `length` kept). */
export const sliceTextStyles = (ranges: TextStyleRange[], leading: number, length: number): TextStyleRange[] =>
  ranges.flatMap((r) => {
    const a = Math.max(0, r.start - leading);
    const b = Math.min(length, r.start + r.len - leading);
    return b > a ? [{ start: a, len: b - a, st: r.st }] : [];
  });

// MARK: Drawing

export interface StyledSegment {
  start: number;
  end: number;
  tokens: string[];
}

/** The text cut where the style changes. */
export const styledSegments = (length: number, ranges: TextStyleRange[]): StyledSegment[] =>
  ranges.length
    ? (() => {
        const marks = marksOf(length, ranges);
        const out: StyledSegment[] = [];
        let i = 0;
        while (i < length) {
          const key = [...marks[i]].sort().join(',');
          let j = i + 1;
          while (j < length && [...marks[j]].sort().join(',') === key) j += 1;
          out.push({ start: i, end: j, tokens: key ? key.split(',') : [] });
          i = j;
        }
        return out;
      })()
    : [{ start: 0, end: length, tokens: [] }];

/** CSS of a token set. `mirror`: the composer's overlay, where glyph widths must not change (caret alignment):
 * bold is drawn with a stroke, and sizes are only hinted. */
export const tokenStyle = (tokens: string[], mirror = false): CSSProperties | undefined => {
  if (!tokens.length) return undefined;
  const css: CSSProperties = {};
  const lines: string[] = [];
  for (const t of tokens) {
    if (t === 'b') {
      if (mirror) css.WebkitTextStroke = '0.45px currentColor';
      else css.fontWeight = 600;
    } else if (t === 'i') css.fontStyle = 'italic';
    else if (t === 'u') lines.push('underline');
    else if (t === 's') lines.push('line-through');
    else if (t.startsWith('f_')) {
      const px = Math.min(24, Math.max(11, Number(t.slice(2)) || mediumSize));
      if (mirror) css.backgroundColor = 'var(--accent-faint)';
      else css.fontSize = `${px}px`;
    } else if (t.startsWith('c_')) {
      const hex = t.slice(2).toLowerCase();
      // The official "black" follows the theme (it would vanish on a dark bubble).
      if (hex !== '000000' && hex !== '050a19') css.color = `#${hex}`;
    }
  }
  if (lines.length) {
    css.textDecorationLine = lines.join(' ');
    css.textDecorationSkipInk = 'none';
  }
  return css;
};
