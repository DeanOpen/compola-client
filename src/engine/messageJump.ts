// "Xem trong trò chuyện" (Kho lưu trữ, search results…): show a message in its conversation. The conversation is opened
// when it is not, older pages are read until the message is loaded (the chat adapter has no jump-to-message of its own,
// so this is `loadMore` page by page, bounded), then the request turns `ready` and the chat view scrolls to it and
// flashes it (`useMessageJumpRequest`, wired in the chat's MessageList owner).

import { create } from 'zustand';
import { loadOlderMessages } from './chat';
import { getEngine, onAccountReset, setEngine, useEngine } from './store';
import { showToast } from './toast';

export interface MessageJumpRequest {
  seq: number;
  conversationId: string;
  messageId: string;
  /** The message is loaded: the chat may scroll to it now. */
  ready: boolean;
}

export const useMessageJump = create<{ request: MessageJumpRequest | null }>()(() => ({ request: null }));

/** Pages read at most while looking for the message (about 20 messages each). */
const maxPages = 40;
const pageWait = 5000;
let seq = 0;

/** The loaded message with one of `ids` (a pin may know a message by its server or its client id), or null. */
const findLoaded = (conversationId: string, ids: string[]) => (getEngine().messages[conversationId] ?? []).find((m) => ids.includes(m.id)) ?? null;

/** Resolves when `test` holds (true) or after `ms` (false). */
const waitFor = (test: () => boolean, ms: number) =>
  new Promise<boolean>((resolve) => {
    if (test()) return resolve(true);
    const timer = setTimeout(() => {
      off();
      resolve(test());
    }, ms);
    const off = useEngine.subscribe(() => {
      if (!test()) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });

/**
 * Shows `messageId` of `conversationId` in the chat. `date` (epoch ms, when known) stops the search once the history is
 * read past it (the message was deleted or recalled).
 */
export const requestJumpToMessage = async (
  conversationId: string,
  /** The message's id, or every id it may be known by. */
  messageId: string | string[],
  date: number | null = null,
  /** Opens the conversation; by default a navigation request (back to the unfiltered inbox, search cleared). */
  open: () => void = () => setEngine({ navigationRequest: conversationId }),
  /** The toast when the message cannot be loaded. */
  notFound = 'Không tìm thấy tin nhắn này trong cuộc trò chuyện.',
) => {
  const ids = (Array.isArray(messageId) ? messageId : [messageId]).filter(Boolean);
  if (!ids.length) return;
  const isLoaded = () => !!findLoaded(conversationId, ids);
  seq += 1;
  const mine = seq;
  const current = () => useMessageJump.getState().request?.seq === mine;
  useMessageJump.setState({ request: { seq: mine, conversationId, messageId: ids[0], ready: false } });

  if (getEngine().openConversationId !== conversationId) {
    open();
    const opened = await waitFor(() => getEngine().openConversationId === conversationId && !!getEngine().messages[conversationId], pageWait);
    if (!current()) return;
    if (!opened) return fail(mine, conversationId, notFound);
  }

  for (let page = 0; !isLoaded(); page++) {
    const s = getEngine();
    const list = s.messages[conversationId] ?? [];
    const oldest = list[0]?.date ?? null;
    if (page >= maxPages || s.hasMoreHistory[conversationId] === false || (date !== null && oldest !== null && oldest < date)) {
      return fail(mine, conversationId, notFound);
    }
    const before = list.length;
    loadOlderMessages(conversationId);
    const grew = await waitFor(() => (getEngine().messages[conversationId]?.length ?? 0) > before || isLoaded(), pageWait);
    if (!current()) return;
    if (!grew) return fail(mine, conversationId, notFound);
  }
  const found = findLoaded(conversationId, ids);
  if (current() && found) useMessageJump.setState({ request: { seq: mine, conversationId, messageId: found.id, ready: true } });
};

const fail = (mine: number, conversationId: string, text: string) => {
  if (useMessageJump.getState().request?.seq !== mine) return;
  useMessageJump.setState({ request: null });
  showToast(text, conversationId);
};

/** The chat view's side: the loaded message to scroll to in this conversation, or null. Call `consume` once scrolled. */
export const useMessageJumpRequest = (conversationId: string): { messageId: string; consume: () => void } | null => {
  const request = useMessageJump((s) => s.request);
  if (!request || !request.ready || request.conversationId !== conversationId) return null;
  return {
    messageId: request.messageId,
    consume: () => {
      if (useMessageJump.getState().request?.seq === request.seq) useMessageJump.setState({ request: null });
    },
  };
};

/** Whether a jump is being prepared (older pages are being read) for this conversation. */
export const useMessageJumpPending = (conversationId: string) =>
  useMessageJump((s) => !!s.request && !s.request.ready && s.request.conversationId === conversationId);

onAccountReset(() => useMessageJump.setState({ request: null }));
