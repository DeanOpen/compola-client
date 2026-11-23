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

const isLoaded = (conversationId: string, messageId: string) => (getEngine().messages[conversationId] ?? []).some((m) => m.id === messageId);

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
export const requestJumpToMessage = async (conversationId: string, messageId: string, date: number | null = null) => {
  seq += 1;
  const mine = seq;
  const current = () => useMessageJump.getState().request?.seq === mine;
  useMessageJump.setState({ request: { seq: mine, conversationId, messageId, ready: false } });

  if (getEngine().openConversationId !== conversationId) {
    setEngine({ navigationRequest: conversationId });
    const opened = await waitFor(() => getEngine().openConversationId === conversationId && !!getEngine().messages[conversationId], pageWait);
    if (!current()) return;
    if (!opened) return fail(mine, conversationId);
  }

  for (let page = 0; !isLoaded(conversationId, messageId); page++) {
    const s = getEngine();
    const list = s.messages[conversationId] ?? [];
    const oldest = list[0]?.date ?? null;
    if (page >= maxPages || s.hasMoreHistory[conversationId] === false || (date !== null && oldest !== null && oldest < date)) {
      return fail(mine, conversationId);
    }
    const before = list.length;
    loadOlderMessages(conversationId);
    const grew = await waitFor(() => (getEngine().messages[conversationId]?.length ?? 0) > before || isLoaded(conversationId, messageId), pageWait);
    if (!current()) return;
    if (!grew) return fail(mine, conversationId);
  }
  if (current()) useMessageJump.setState({ request: { seq: mine, conversationId, messageId, ready: true } });
};

const fail = (mine: number, conversationId: string) => {
  if (useMessageJump.getState().request?.seq !== mine) return;
  useMessageJump.setState({ request: null });
  showToast('Không tìm thấy tin nhắn này trong cuộc trò chuyện.', conversationId);
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
