// The one store the UI binds to (Swift: the observable `ZaloEngine`). Feature logic lives in the sibling modules
// (`chat.ts`, `conversations.ts`, `messageActions.ts`, `composer.ts`, …) which update this store; views read it with
// selectors. Later waves add their slices here (contacts, polls, cloud, calls, transfer, …).

import { create } from 'zustand';
import type { ScreenshotShare } from './composer';
import type { ChatMessage, ComposerDraft } from './models/chat';
import { emptyExtras, type ConversationExtras, type ConversationSummary } from './models/conversations';
import type { PinnedList } from './models/outcomes';
import type { Phase, Profile } from './models/phase';

/** A confirmation a message action asks for, answered natively (Swift `MessageActionConfirm`). */
export interface MessageActionConfirm {
  id: number;
  conversationId: string;
  action:
    | { kind: 'deleteForMe'; message: ChatMessage }
    | { kind: 'pin'; message: ChatMessage; replacing: string }
    | { kind: 'unpin'; ref: string };
  title: string;
  message: string;
  ok: string;
  cancel: string;
  destructive: boolean;
}

/** "N tin nhắn đã xóa · Khôi phục": the official undo window of a delete-for-me. */
export interface DeleteUndo {
  id: string;
  conversationId: string;
  count: number;
  /** Epoch ms. */
  deadline: number;
}

/** "Chia sẻ": the message waiting for the conversations to forward it to. */
export interface ForwardRequest {
  id: number;
  conversationId: string;
  message: ChatMessage;
}

/** An official confirm asked while a composer action ran. */
export interface ComposerConfirm {
  id: string;
  conversationId: string;
  title: string;
  message: string;
  ok: string;
  cancel: string;
}

/** A short notice (Swift `CardActionCenter.show(text, in:)`): shown in that conversation, or app-wide when null. */
export interface Toast {
  seq: number;
  text: string;
  conversationId: string | null;
}

/**
 * Conversation context-menu state (flags, pin board, hidden chats). Fed by `convActions` snapshots in a later wave
 * (ZaloEngine+ConversationActions.swift); until then everything is "known" and nothing is hidden.
 */
export interface ConversationActionsState {
  loaded: boolean;
  hiddenKnown: boolean;
  hiddenEnabled: boolean;
  hasHiddenPIN: boolean;
  hiddenIds: ReadonlySet<string>;
  /** Official pin board; null = not reported yet (the row's own `pinned` flag is used). */
  pinnedIds: ReadonlySet<string> | null;
  archivedIds: ReadonlySet<string>;
  unreadMarkIds: ReadonlySet<string>;
}

export interface FailedDrafts {
  drafts: Record<string, ComposerDraft>;
  /** Conversations whose held draft was stashed silently (the caller already told the user why). */
  silent: ReadonlySet<string>;
  revision: number;
}

export interface EngineState {
  phase: Phase;
  profile: Profile | null;
  badge: number;

  // Conversations (ZaloEngine.swift + ZaloEngine+Conversations.swift)
  conversations: ConversationSummary[];
  selfConversationId: string | null;
  extras: ConversationExtras;
  conversationActions: ConversationActionsState;
  /** Muted conversations (notification settings, later wave). */
  mutedIds: ReadonlySet<string>;
  /** Set by any view to ask the shell to show a conversation. */
  navigationRequest: string | null;

  // Chat (ZaloEngine+Chat.swift)
  openConversationId: string | null;
  /** Messages per conversation, oldest first. */
  messages: Record<string, ChatMessage[]>;
  hasMoreHistory: Record<string, boolean>;
  /** Bumped when an older page arrived whose messages are all hidden cards. */
  historyTicks: Record<string, number>;
  /** Who is typing per conversation (display name), cleared after a few seconds. */
  typing: Record<string, string>;
  failedDrafts: FailedDrafts;
  /** Whether a manual phone → PC sync can start now (transfer, later wave). */
  canStartTransfer: boolean;

  // Message actions (ZaloEngine+MessageActions.swift)
  pins: Record<string, PinnedList>;
  forwardRequest: ForwardRequest | null;
  messageConfirm: MessageActionConfirm | null;
  deleteUndo: DeleteUndo | null;

  // Composer (ZaloEngine+Composer.swift)
  composerConfirm: ComposerConfirm | null;
  queuedComposerConfirms: ComposerConfirm[];
  /** "Chia sẻ" from the screenshot tool, waiting for its conversations. */
  screenshotShare: ScreenshotShare | null;
  /** The screenshot tool may not record the screen (System Settings ▸ Privacy ▸ Screen Recording). */
  screenCaptureNeedsPermission: boolean;

  toast: Toast | null;
}

export const initialConversationActions: ConversationActionsState = {
  loaded: false,
  hiddenKnown: true,
  hiddenEnabled: false,
  hasHiddenPIN: false,
  hiddenIds: new Set(),
  pinnedIds: null,
  archivedIds: new Set(),
  unreadMarkIds: new Set(),
};

/** Everything of a signed-in account; reset on logout so nothing carries over to the next account. */
const accountState = (): Omit<EngineState, 'phase' | 'badge'> => ({
  profile: null,
  conversations: [],
  selfConversationId: null,
  extras: emptyExtras,
  conversationActions: initialConversationActions,
  mutedIds: new Set(),
  navigationRequest: null,
  openConversationId: null,
  messages: {},
  hasMoreHistory: {},
  historyTicks: {},
  typing: {},
  failedDrafts: { drafts: {}, silent: new Set(), revision: 0 },
  canStartTransfer: false,
  pins: {},
  forwardRequest: null,
  messageConfirm: null,
  deleteUndo: null,
  composerConfirm: null,
  queuedComposerConfirms: [],
  screenshotShare: null,
  screenCaptureNeedsPermission: false,
  toast: null,
});

export const useEngine = create<EngineState>()(() => ({
  phase: { kind: 'starting' },
  badge: 0,
  ...accountState(),
}));

export const getEngine = useEngine.getState;
export const setEngine = useEngine.setState;

/** Logout / logged out: drop everything of the previous account. */
export const resetAccount = () => setEngine(accountState());

// MARK: - Derived helpers (pure; take the state so they work in selectors)

export const isHidden = (s: EngineState, id: string) => s.conversationActions.hiddenIds.has(id);

export const isPinnedConversation = (s: EngineState, c: ConversationSummary) =>
  s.conversationActions.pinnedIds ? s.conversationActions.pinnedIds.has(c.id) : c.pinned;

export const isMuted = (s: EngineState, id: string) => s.mutedIds.has(id);

/** Conversations that may be counted / listed: none while the hidden state is unknown. */
export const visibleConversations = (s: EngineState): ConversationSummary[] =>
  s.conversationActions.hiddenKnown ? s.conversations.filter((c) => !isHidden(s, c.id)) : [];
