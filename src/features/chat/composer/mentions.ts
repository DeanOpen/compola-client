// Mention bookkeeping of the composer (Swift `ComposerTextView.Coordinator`): mentions are atomic "@Name" tokens with
// UTF-16 offsets (= JS string indices) into the draft text.

import type { Mention, MentionCandidate } from '../../../engine/models/chat';

/** The "@…" being typed: `start` is the "@", `end` the caret; `text` what follows the "@". */
export interface MentionQuery {
  start: number;
  end: number;
  text: string;
}

/**
 * Moves the mentions along a text edit (old → new): tokens before the edit stay, tokens after it shift, tokens the edit
 * touched are dropped (they no longer read "@Name"). Tokens that no longer start with "@" are dropped too.
 */
export const rebaseMentions = (oldText: string, newText: string, mentions: Mention[]): Mention[] => {
  if (!mentions.length || oldText === newText) return mentions;
  let prefix = 0;
  const max = Math.min(oldText.length, newText.length);
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  )
    suffix += 1;
  const oldEnd = oldText.length - suffix;
  const delta = newText.length - oldText.length;
  return mentions
    .flatMap((m) => {
      if (m.pos + m.len <= prefix) return [m];
      if (m.pos >= oldEnd) return [{ ...m, pos: m.pos + delta }];
      return [];
    })
    .filter((m) => newText.charCodeAt(m.pos) === 0x40 && m.pos + m.len <= newText.length);
};

/** The token the caret / selection touches, if any (edits there replace the whole token). */
export const tokenAt = (mentions: Mention[], start: number, end: number, direction: 'back' | 'forward'): Mention | null => {
  for (const m of mentions) {
    const tokenEnd = m.pos + m.len;
    if (start !== end) {
      if (start < tokenEnd && end > m.pos) return m;
    } else if (direction === 'back' ? start > m.pos && start <= tokenEnd : start >= m.pos && start < tokenEnd) {
      return m;
    }
  }
  return null;
};

const isSpace = (c: string) => /\s/.test(c);

/** "@query" ending at the caret: "@" at the start or after whitespace, not inside a token, within 40 characters. */
export const mentionQueryAt = (text: string, caret: number, mentions: Mention[]): MentionQuery | null => {
  const floor = Math.max(0, caret - 40);
  for (let i = caret; i > floor; i -= 1) {
    const c = text[i - 1];
    if (c === '\n') return null;
    if (c === '@') {
      const at = i - 1;
      const startsWord = at === 0 || isSpace(text[at - 1]);
      const insideToken = mentions.some((m) => at >= m.pos && at < m.pos + m.len);
      if (!startsWord || insideToken) return null;
      const typed = text.slice(at + 1, caret);
      if (typed.startsWith(' ')) return null;
      return { start: at, end: caret, text: typed };
    }
  }
  return null;
};

/** Replaces the query with "@Name " and records the token. */
export const insertMention = (
  text: string,
  mentions: Mention[],
  query: MentionQuery,
  candidate: MentionCandidate,
): { text: string; mentions: Mention[]; caret: number } => {
  const label = '@' + candidate.name.replace(/\n/g, ' ');
  const next = text.slice(0, query.start) + label + ' ' + text.slice(query.end);
  const rebased = rebaseMentions(text, next, mentions).filter((m) => m.pos !== query.start);
  const token: Mention = { uid: candidate.isAll ? '-1' : candidate.id, pos: query.start, len: label.length, isAll: candidate.isAll };
  return { text: next, mentions: [...rebased, token].sort((a, b) => a.pos - b.pos), caret: query.start + label.length + 1 };
};
