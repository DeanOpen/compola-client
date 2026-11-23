// Chat, bridged to `host-scripts/chat-adapter.js` (`window.__zaloChat`). Port of ZaloEngine+Chat.swift.
// Contract: models/chat.ts. All actions run through the official client's own services.

import { sliceTextStyles, type TextStyleRange } from './models/textStyles';
import { commands } from './backend';
import { callAdapter, fireAdapter, log, tryAdapter } from './call';
import { appendDraft, parseChatMessage, parseReactionDetail, type ChatMessage, type ComposerDraft, type Mention, type MentionCandidate, type ReactionDetail } from './models/chat';
import { arr, bool, obj, str, strings, url, type Json } from './models/json';
import { dropMessagePrompts } from './messageActions';
import { getEngine, setEngine } from './store';

export const openConversation = (id: string) => {
  if (getEngine().openConversationId !== id) dropMessagePrompts();
  setEngine({ openConversationId: id });
  reportOpen(id);
  fireAdapter('__zaloChat', 'open', id);
  fireAdapter('__zaloMsgActions', 'watchPins', id);
};

export const closeConversation = () => {
  const id = getEngine().openConversationId;
  if (!id) return;
  setEngine({ openConversationId: null });
  reportOpen(null);
  dropMessagePrompts();
  fireAdapter('__zaloChat', 'close', id);
  fireAdapter('__zaloMsgActions', 'watchPins', null);
};

/** Rust suppresses notifications of the chat on screen. */
const reportOpen = (id: string | null) => void commands.setOpenConversation(id).catch(() => {});

export const loadOlderMessages = (id: string) => fireAdapter('__zaloChat', 'loadMore', id);
export const markRead = (id: string) => fireAdapter('__zaloChat', 'markRead', id);
export const react = (emoji: string, messageId: string, conversationId: string) =>
  fireAdapter('__zaloChat', 'react', conversationId, messageId, emoji);

const isSpace = (c: string) => /\s/.test(c);

/**
 * `mentions` are UTF-16 offsets into `text` as typed; they are re-based when the text is trimmed and dropped when
 * they no longer point at their "@Name". Resolves false when the official client could not take the message.
 */
export const sendText = async (
  text: string,
  conversationId: string,
  quoting: string | null = null,
  mentions: Mention[] = [],
  styles: TextStyleRange[] = [],
): Promise<boolean> => {
  const trimmed = text.trim();
  if (!trimmed) return true;
  let leading = 0;
  while (leading < text.length && isSpace(text[leading])) leading += 1;
  const wire = mentions
    .map((m) => ({ ...m, pos: m.pos - leading }))
    .filter((m) => m.pos >= 0 && m.len > 1 && m.pos + m.len <= trimmed.length && trimmed.charCodeAt(m.pos) === 0x40)
    .map((m) => ({ pos: m.pos, len: m.len, uid: m.uid, type: m.isAll ? 1 : 0 }))
    .sort((a, b) => a.pos - b.pos);
  let result: unknown;
  try {
    // "Định dạng": the ranges follow the trim; none = a plain text send, as before.
    const format = sliceTextStyles(styles, leading, trimmed.length);
    result = format.length
      ? await callAdapter('__zaloChat', 'sendText', conversationId, trimmed, quoting, wire, format)
      : await callAdapter('__zaloChat', 'sendText', conversationId, trimmed, quoting, wire);
  } catch (e) {
    result = String(e);
  }
  if (result !== 'sent') log(`chat sendText → ${String(result)}`);
  return result === 'sent';
};

/** Group members matching `query` from the official suggestion engine ("Tất cả" first when allowed). */
export const mentionCandidates = async (conversationId: string, query: string, excluding: string[]): Promise<MentionCandidate[]> => {
  const rows = await tryAdapter<unknown[]>([], '__zaloChat', 'mentionCandidates', conversationId, query, excluding);
  return arr(rows).flatMap((r) => {
    const row = obj(r);
    const uid = row ? str(row.id) : '';
    if (!row || !uid) return [];
    const isAll = bool(row.isAll);
    const name = str(row.name).trim();
    if (!isAll && !name) return [];
    return [{ id: uid, name: isAll ? 'All' : name, avatar: url(row.avatar), isAll }];
  });
};

/** Who reacted to a message; null when the client could not answer. */
export const reactors = async (messageId: string, conversationId: string): Promise<ReactionDetail | null> =>
  parseReactionDetail(await tryAdapter<unknown>(null, '__zaloChat', 'reactors', conversationId, messageId));

// MARK: State

export const handleChat = (state: Json) => {
  const chat = obj(state.chat);
  if (chat && typeof chat.convId === 'string') mergeChat(chat, chat.convId);
  const typing = obj(state.typing);
  if (typing && typeof typing.convId === 'string') showTyping(str(typing.name), typing.convId);
};

const sameMessage = (a: ChatMessage, b: ChatMessage) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * `reset` replaces the list; otherwise changed messages merge by id (a pending message keeps its id when it is
 * confirmed) and `removed` ids drop out. Kept oldest first.
 */
const mergeChat = (chat: Json, convId: string) => {
  const incoming = arr(chat.messages)
    .map((m) => parseChatMessage(m, convId))
    .filter((m): m is ChatMessage => !!m);
  const removed = new Set(strings(chat.removed));
  const reset = chat.reset === true;
  const s = getEngine();
  const current = s.messages[convId];
  let list = reset ? [] : [...(current ?? [])];
  if (removed.size) list = list.filter((m) => !removed.has(m.id));
  const position = new Map(list.map((m, i) => [m.id, i]));
  let needsSort = reset;
  let changed = reset || removed.size > 0 || current === undefined;
  for (const message of incoming) {
    const at = position.get(message.id);
    if (at !== undefined) {
      if (list[at].date !== message.date) needsSort = true;
      if (!sameMessage(list[at], message)) {
        list[at] = message;
        changed = true;
      }
    } else {
      const last = list[list.length - 1];
      if (last && message.date < last.date) needsSort = true;
      position.set(message.id, list.length);
      list.push(message);
      changed = true;
    }
  }
  if (needsSort) {
    // Stable: equal timestamps keep the order the official client gave them.
    list = list.map((m, i) => ({ m, i })).sort((a, b) => a.m.date - b.m.date || a.i - b.i).map((x) => x.m);
  }
  const patch: Partial<ReturnType<typeof getEngine>> = {};
  if (changed) patch.messages = { ...s.messages, [convId]: list };
  if (typeof chat.hasMore === 'boolean' && s.hasMoreHistory[convId] !== chat.hasMore) {
    patch.hasMoreHistory = { ...s.hasMoreHistory, [convId]: chat.hasMore };
  }
  if (chat.grew === true) patch.historyTicks = { ...s.historyTicks, [convId]: (s.historyTicks[convId] ?? 0) + 1 };
  if (Object.keys(patch).length) setEngine(patch);
  const newest = incoming[incoming.length - 1];
  if (s.typing[convId] && newest && !newest.isMine && newest.date > Date.now() - 5000) clearTyping(convId);
};

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

const showTyping = (name: string, convId: string) => {
  const trimmed = name.trim();
  if (!trimmed) return clearTyping(convId);
  setEngine((s) => ({ typing: { ...s.typing, [convId]: trimmed } }));
  clearTimeout(typingTimers.get(convId));
  typingTimers.set(convId, setTimeout(() => clearTyping(convId), 5000));
};

const clearTyping = (convId: string) => {
  clearTimeout(typingTimers.get(convId));
  typingTimers.delete(convId);
  if (getEngine().typing[convId] === undefined) return;
  setEngine((s) => {
    const typing = { ...s.typing };
    delete typing[convId];
    return { typing };
  });
};

// MARK: Failed drafts (Swift `FailedDraftStore`)

/** Texts the official client refused, kept per conversation until its composer takes them back. Several merge in order. */
export const stashFailedDraft = (draft: ComposerDraft, conversationId: string, silent = false) => {
  if (!draft.text) return;
  setEngine((s) => {
    const fd = s.failedDrafts;
    const existing = fd.drafts[conversationId];
    const silentIds = new Set(fd.silent);
    if (!existing) {
      if (silent) silentIds.add(conversationId);
    } else if (!silent) silentIds.delete(conversationId);
    return {
      failedDrafts: {
        drafts: { ...fd.drafts, [conversationId]: existing ? appendDraft(existing, draft) : draft },
        silent: silentIds,
        revision: fd.revision + 1,
      },
    };
  });
};

/** The held draft and whether giving it back deserves the "not sent" notice. */
export const takeFailedDraft = (conversationId: string): { draft: ComposerDraft; notice: boolean } | null => {
  const fd = getEngine().failedDrafts;
  const draft = fd.drafts[conversationId];
  if (!draft) return null;
  const wasSilent = fd.silent.has(conversationId);
  const drafts = { ...fd.drafts };
  delete drafts[conversationId];
  const silent = new Set(fd.silent);
  silent.delete(conversationId);
  setEngine({ failedDrafts: { drafts, silent, revision: fd.revision } });
  return { draft, notice: !wasSilent };
};
