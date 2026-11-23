// Conversation context-menu actions — pin / unpin, "Khác" / "Tin nhắn", mark read / unread, hide / unhide (PIN), delete —
// bridged to `host-scripts/conversation-actions-adapter.js` (`window.__zaloConvActions`; posts {page:'main', convActions}).
// Port of ZaloEngine+ConversationActions.swift. Every action runs the official service the official menu item calls.
// Conversation ids, names and PINs are never logged; a PIN only ever goes into the official calls.

import { create } from 'zustand';
import { callAdapter, log, raceTimeout } from './call';
import { bool, int, obj, str, strings, type Json } from './models/json';
import { getEngine, setEngine, type ConversationActionsState, type EngineState } from './store';
import { showToast } from './toast';

/** The adapter's `F` table. */
export const ActionFlag = {
  pinned: 1,
  archived: 2,
  hidden: 4,
  /** No last message, a stranger, an OA that cannot be pinned, or hidden. */
  cannotPin: 8,
  cannotArchive: 16,
  cannotMute: 32,
  /** My Cloud. */
  cannotDelete: 64,
  /** An archived chat while pinning there is off: neither pin nor unpin. */
  noPinMenu: 128,
  cannotHide: 256,
  unreadMark: 512,
} as const;

const has = (s: ConversationActionsState, id: string, bit: number) => ((s.flags[id] ?? 0) & bit) !== 0;

/** Which official menu: the list row (`Thread`) or the chat header / info panel (`ChatBox`, no archive, read or delete). */
export type MenuPreset = 'thread' | 'chatBox';

/** What the official menu offers for one conversation (Swift `ConversationMenuPlan`), in official order. */
export interface MenuPlan {
  pin: 'pin' | 'unpin' | null;
  archive: 'moveToOther' | 'moveToFocus' | null;
  read: 'markRead' | 'markUnread' | null;
  mute: 'mute' | 'unmute' | null;
  hide: 'hide' | 'unhide' | null;
  canDelete: boolean;
  showsLabel: boolean;
}

export const menuPlan = (id: string, preset: MenuPreset, s: EngineState): MenuPlan => {
  const a = s.conversationActions;
  const thread = preset === 'thread';
  const plan: MenuPlan = { pin: null, archive: null, read: null, mute: null, hide: null, canDelete: false, showsLabel: false };
  const isSelf = has(a, id, ActionFlag.cannotDelete);
  if (a.left[id]) {
    plan.canDelete = thread && !isSelf;
    return plan;
  }
  if (!has(a, id, ActionFlag.noPinMenu)) {
    if (has(a, id, ActionFlag.pinned)) plan.pin = 'unpin';
    else if (!has(a, id, ActionFlag.cannotPin)) plan.pin = 'pin';
  }
  if (thread && !has(a, id, ActionFlag.cannotArchive)) plan.archive = has(a, id, ActionFlag.archived) ? 'moveToFocus' : 'moveToOther';
  plan.showsLabel = true;
  if (thread && !has(a, id, ActionFlag.hidden) && !isSelf) {
    const unread = s.conversations.find((c) => c.id === id)?.unread ?? 0;
    if (unread > 0 || has(a, id, ActionFlag.unreadMark)) plan.read = 'markRead';
    else if (a.markUnreadEnabled) plan.read = 'markUnread';
  }
  if (s.mutedIds.has(id)) plan.mute = 'unmute';
  else if (!has(a, id, ActionFlag.cannotMute)) plan.mute = 'mute';
  if (a.hiddenEnabled) {
    if (has(a, id, ActionFlag.hidden) || a.hiddenIds.has(id)) plan.hide = 'unhide';
    else if (!has(a, id, ActionFlag.cannotHide)) plan.hide = 'hide';
  }
  plan.canDelete = thread && !isSelf;
  return plan;
};

// MARK: Client-side state (prompts, removals, the one unlocked hidden chat)

export type ConversationPrompt =
  | { kind: 'delete'; id: string }
  | { kind: 'pinBoard'; id: string }
  | { kind: 'hide'; id: string }
  | { kind: 'unhide'; id: string }
  /** Open a hidden conversation (official OPEN_CONV screen). */
  | { kind: 'unlock'; id: string }
  | { kind: 'pinSettings'; flow: 'setPIN' | 'changePIN' | 'resetPIN' };

interface ActionUI {
  prompt: ConversationPrompt | null;
  /** Conversations that left the list (deleted / hidden): the shell clears the selection when it was one of them. */
  removal: { seq: number; ids: ReadonlySet<string> } | null;
  /** The one hidden conversation opened with the PIN (official `byPassPIN` applies to the opened item only). */
  unlockedId: string | null;
  /** Hidden conversations listed by the current PIN search; selecting one unlocks just that one. */
  pinSearchIds: string[];
}

export const useConversationUI = create<ActionUI>(() => ({ prompt: null, removal: null, unlockedId: null, pinSearchIds: [] }));
const ui = useConversationUI;
let removalSeq = 0;

export const setConversationPrompt = (prompt: ConversationPrompt | null) => ui.setState({ prompt });

const remove = (ids: Iterable<string>) => {
  const set = new Set(ids);
  if (!set.size) return;
  removalSeq += 1;
  const unlocked = ui.getState().unlockedId;
  ui.setState({ removal: { seq: removalSeq, ids: set }, ...(unlocked && set.has(unlocked) ? { unlockedId: null } : {}) });
};

export const unlockHiddenConversation = (id: string) => ui.setState({ unlockedId: id });
/** The selection moved to another conversation. */
export const dropUnlock = () => ui.getState().unlockedId && ui.setState({ unlockedId: null });
/** Search cleared, app away a minute, PIN reset, logout. */
export const relockHidden = () => ui.setState({ unlockedId: null, pinSearchIds: [] });

export const isHiddenConversation = (s: EngineState, id: string) => s.conversationActions.hiddenIds.has(id) || has(s.conversationActions, id, ActionFlag.hidden);

/** A hidden conversation stays closed unless it was opened with the PIN (and only that one). */
export const isConversationLocked = (id: string) => isHiddenConversation(getEngine(), id) && ui.getState().unlockedId !== id;

/** Opened from the PIN search results: unlocks that one conversation. */
export const unlockFromPINSearch = (id: string) => {
  if (!ui.getState().pinSearchIds.includes(id)) return false;
  unlockHiddenConversation(id);
  return true;
};

/** The PIN bypass ends after a real absence (a minute inactive); a short focus loss keeps it. */
export const relockAfterInactivity = 60_000;
export const hiddenStateStallLimit = 30_000;
export const hiddenStateStalledText = 'Không đọc được trạng thái trò chuyện ẩn — đang thử lại';

// MARK: Results

export interface ActionResult {
  ok: boolean;
  text: string;
  /** Pin refused because the tab is full: open the board instead. */
  full: boolean;
  badPIN: boolean;
  /** A PIN is already set (the caller's view was stale). */
  pinExists: boolean;
  /** Shown as a plain message, not a success ("Đã chuyển sang mục Khác"). */
  neutral: boolean;
}

const parseResult = (v: unknown): ActionResult => {
  const root = obj(v);
  if (!root || typeof root.ok !== 'boolean') {
    return { ok: false, text: 'Chưa nhận được phản hồi. Hãy kiểm tra lại trước khi thử lại.', full: false, badPIN: false, pinExists: false, neutral: false };
  }
  return {
    ok: root.ok,
    text: str(root.text).slice(0, 300),
    full: bool(root.full),
    badPIN: bool(root.badPin),
    pinExists: bool(root.pinExists),
    neutral: bool(root.neutral),
  };
};

/** Shows the official toast text (empty: nothing to say). */
export const report = (r: ActionResult) => {
  if (!r.text || r.full || r.pinExists) return;
  showToast(r.text, null);
};

const raw = (method: string, args: unknown[]) =>
  callAdapter('__zaloConvActions', method, ...args).catch((e) => {
    log(`convActions.${method} → ${String(e).slice(0, 80)}`);
    return null;
  });

const call = async (method: string, args: unknown[], timeout = 40): Promise<ActionResult> => {
  const answer = await raceTimeout(timeout, raw(method, args));
  if (!answer) {
    return { ok: false, text: 'Thao tác vẫn đang được xử lý. Hãy kiểm tra lại danh sách hội thoại trước khi thử lại.', full: false, badPIN: false, pinExists: false, neutral: false };
  }
  const r = parseResult(answer.value);
  if (!r.ok) log(`conversation action ${method} → failed`);
  return r;
};

// MARK: Actions

/** "Ghim hội thoại": a full tab opens the board instead (`POP_PINNED_CONVERSATION`). */
export const pinConversation = async (id: string) => {
  const r = await call('pin', [id]);
  if (r.full) setConversationPrompt({ kind: 'pinBoard', id });
  else report(r);
};

export const unpinConversation = async (id: string) => report(await call('unpin', [id]));

export interface PinBoard {
  tab: number;
  limit: number;
  total: number;
  /** How many pins must go before a new one fits. */
  need: number;
  /** Pinned conversation ids, newest first. */
  items: string[];
}

export const pinBoard = async (id: string): Promise<PinBoard | null> => {
  const root = obj(await raw('pinBoard', [id]));
  const limit = root ? int(root.limit) : 0;
  if (!root || limit <= 0) return null;
  return { tab: int(root.tab), limit, total: int(root.total), need: int(root.need), items: strings(root.items) };
};

/** Board confirm: unpin the chosen ones, then pin `id`. */
export const pinReplacing = async (unpinIds: string[], id: string) => {
  const r = await call('pinReplacing', [unpinIds, id]);
  report(r);
  return r;
};

export const moveConversation = async (id: string, toOther: boolean) => report(await call(toOther ? 'archive' : 'unarchive', [id], 45));

/** "Xóa hội thoại": asks the official confirmation first. */
export const requestDeleteConversation = (id: string) => setConversationPrompt({ kind: 'delete', id });

export const confirmDeleteConversation = async (id: string) => {
  const r = await call('deleteConversation', [id], 60);
  if (r.ok) remove([id]);
  report(r);
};

export const markConversationRead = async (id: string) => report(await call('markRead', [id]));
export const markConversationUnread = async (id: string) => report(await call('markUnread', [id]));

// MARK: Hidden chats

export const checkHiddenChatPIN = async (pin: string) => parseResult(await raw('checkPin', [pin])).ok;

export const hideConversation = async (id: string, pin: string) => {
  const r = await call('hide', [id, pin]);
  if (r.ok) remove([id]);
  return r;
};

export const hideConversationWithNewPIN = async (id: string, pin: string) => {
  const r = await call('hideWithNewPin', [id, pin]);
  if (r.ok) remove([id]);
  return r;
};

/** `pin` null = the conversation was opened with the PIN already (official UNHIDE_CONV, no PIN field). */
export const unhideConversation = (id: string, pin: string | null) => call('unhide', [id, pin]);

export const setHiddenChatPIN = (pin: string, changed: boolean) => call('setPin', [pin, changed]);

/** Removes the PIN and every hidden chat: they all leave the view and nothing stays unlocked. */
export const resetHiddenChatPIN = async () => {
  const formerly = [...getEngine().conversationActions.hiddenIds];
  const r = await call('resetPin', [], 60);
  if (r.ok) {
    remove(formerly);
    relockHidden();
  }
  return r;
};

/** List search: when `query` is the PIN, the hidden conversations; null otherwise. Nothing is unlocked by a search. */
export const hiddenConversations = async (query: string): Promise<string[] | null> => {
  const a = getEngine().conversationActions;
  if (!a.hiddenEnabled || query.length !== 4) {
    ui.setState({ pinSearchIds: [] });
    return null;
  }
  const root = obj(await raw('hiddenSearch', [query]));
  if (!root || !Array.isArray(root.ids)) {
    ui.setState({ pinSearchIds: [] });
    return null;
  }
  const ids = strings(root.ids);
  ui.setState({ pinSearchIds: ids });
  return ids;
};

/** The page reloaded (or logout): it only posts on change, so ask for the current state again. */
export const republishConversationActions = () => void raw('republish', []);

// MARK: State

let lateEpoch = 0;
let lateSeq = 0;

export const handleConversationActions = (state: Json) => {
  const json = obj(state.convActions);
  if (!json) return;
  const prev = getEngine().conversationActions;
  const next: ConversationActionsState = { ...prev };
  const hidden = obj(json.hidden);
  if (hidden) {
    next.hiddenKnown = true;
    next.hiddenEnabled = bool(hidden.enabled);
    next.hasHiddenPIN = bool(hidden.hasPin);
    next.hiddenIds = new Set(strings(hidden.ids));
  }
  const rawFlags = obj(json.flags);
  if (rawFlags) {
    next.loaded = true;
    const flags: Record<string, number> = {};
    for (const [id, v] of Object.entries(rawFlags)) {
      const bits = int(v);
      if (bits) flags[id] = bits;
    }
    next.flags = flags;
    const left: Record<string, 'kick' | 'disband'> = {};
    for (const [id, v] of Object.entries(obj(json.left) ?? {})) left[id] = v === 'disband' ? 'disband' : 'kick';
    next.left = left;
    next.markUnreadEnabled = bool(json.markUnread);
    const ids = (bit: number) => new Set(Object.entries(flags).flatMap(([id, b]) => (b & bit ? [id] : [])));
    next.pinnedIds = ids(ActionFlag.pinned);
    next.archivedIds = ids(ActionFlag.archived);
    next.unreadMarkIds = ids(ActionFlag.unreadMark);
    const flaggedHidden = ids(ActionFlag.hidden);
    if (flaggedHidden.size) next.hiddenIds = new Set([...next.hiddenIds, ...flaggedHidden]);
  }
  // The outcome of an archive / delete that had answered "pending": report it now. A new page epoch restarts the sequence.
  const epoch = typeof json.epoch === 'number' ? json.epoch : lateEpoch;
  if (epoch !== lateEpoch) {
    lateEpoch = epoch;
    lateSeq = 0;
  }
  const late = obj(json.late);
  if (late && int(late.seq) > lateSeq) {
    lateSeq = int(late.seq);
    if (str(late.text)) showToast(str(late.text), null);
    if (str(late.removedId)) remove([str(late.removedId)]);
  }
  setEngine({ conversationActions: next });
};

/** Logout: nothing of the previous account's menus, prompts or unlocks survives. */
export const resetConversationActions = () => {
  ui.setState({ prompt: null, removal: null, unlockedId: null, pinSearchIds: [] });
  lateEpoch = 0;
  lateSeq = 0;
  republishConversationActions();
};
