// Boot: subscribe to the Rust engine's events and wire the feature handlers (Swift `ZaloEngine.boot` / `handle`).

import { resetStickers } from './stickers';
import { backend, commands } from './backend';
import { handleChat, sendText, stashFailedDraft } from './chat';
import { dropComposerConfirms, handleCompose, handleScreenCapture } from './composer';
import { obj, str } from './models/json';
import { showToast } from './toast';
import { handleConversationExtras, mergeConversations, resetConversations } from './conversations';
import { dispatchState, registerStateHandler } from './dispatch';
import { handleConversationActions, republishConversationActions, resetConversationActions } from './conversationActions';
import { resetGroupMosaics } from './groupMosaic';
import { handlePins, resetMessageActions, rewatchPins } from './messageActions';
import type { Phase } from './models/phase';
import { getEngine, resetAccount, setEngine } from './store';
import './features';

registerStateHandler('convActions', handleConversationActions);
registerStateHandler('conversationExtras', handleConversationExtras);
registerStateHandler('compose', handleCompose);
registerStateHandler('pins', handlePins);
registerStateHandler('chat', handleChat);
registerStateHandler('conversations', mergeConversations);

const setPhase = (phase: Phase) => {
  const previous = getEngine().phase;
  // Logged out (or signed out by the server): nothing of the previous account may carry over.
  if (phase.kind === 'login' && previous.kind !== 'login' && previous.kind !== 'starting' && previous.kind !== 'preparing') {
    resetAccountState();
  }
  setEngine({ phase });
};

const resetAccountState = () => {
  resetStickers();
  resetConversationActions();
  resetGroupMosaics();
  resetConversations();
  resetMessageActions();
  resetAccount();
};

let started: Promise<void> | null = null;

export const startEngine = (): Promise<void> => {
  if (started) return started;
  started = (async () => {
    const b = await backend();
    await Promise.all([
      b.listen('compola://phase', (p) => setPhase(p as Phase)),
      b.listen('compola://state', dispatchState),
      b.listen('compola://badge', (n) => setEngine({ badge: typeof n === 'number' ? n : 0 })),
      b.listen('compola://page', (page) => {
        // The main page (re)loaded: watch the open conversation's pins again; its unanswered confirms are gone.
        dropComposerConfirms();
        if (page === 'main' || page === 'Main') {
          rewatchPins();
          republishConversationActions();
        }
      }),
      // A notification was clicked: show its conversation (the shell consumes the request).
      b.listen('compola://notification-click', (p) => {
        const convId = str(obj(p)?.convId);
        if (convId) setEngine({ navigationRequest: convId });
      }),
      // An inline reply typed in a notification: send it; a refusal goes back to that conversation's composer.
      b.listen('compola://notification-reply', (p) => {
        const json = obj(p);
        const convId = str(json?.convId);
        const text = str(json?.text);
        if (!convId || !text.trim()) return;
        void sendText(text, convId).then((ok) => {
          if (ok) return;
          stashFailedDraft({ text, mentions: [], replyTo: null }, convId, true);
          showToast('Chưa gửi được trả lời từ thông báo. Nội dung đã được giữ lại trong ô soạn thảo.', null);
        });
      }),
      b.listen('compola://screen-capture', handleScreenCapture),
    ]);
    try {
      setPhase(await commands.phase());
    } catch {
      /* the phase event follows */
    }
    // A UI that (re)loaded after the main page catches up: the host scripts post changes, not full state, so replay
    // what the page posted since it loaded (Rust keeps it compacted). Merges are idempotent, so overlap with live
    // events is harmless.
    if (!b.isMock) {
      try {
        const events = await b.invoke<unknown[]>('engine_replay');
        for (const event of events) dispatchState(event);
      } catch {
        /* older engine */
      }
    }
  })();
  return started;
};

/** Clears the session cookies and local client data, then shows a fresh QR. */
export const logOut = async () => {
  resetAccountState();
  await commands.logout();
};
