// Boot: subscribe to the Rust engine's events and wire the feature handlers (Swift `ZaloEngine.boot` / `handle`).

import { backend, commands } from './backend';
import { handleChat } from './chat';
import { handleCompose, dropComposerConfirms } from './composer';
import { handleConversationExtras, mergeConversations, resetConversations } from './conversations';
import { dispatchState, registerStateHandler } from './dispatch';
import { handlePins, resetMessageActions, rewatchPins } from './messageActions';
import type { Phase } from './models/phase';
import { getEngine, resetAccount, setEngine } from './store';
import './features';

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
        if (page === 'main' || page === 'Main') rewatchPins();
      }),
    ]);
    try {
      setPhase(await commands.phase());
    } catch {
      /* the phase event follows */
    }
  })();
  return started;
};

/** Clears the session cookies and local client data, then shows a fresh QR. */
export const logOut = async () => {
  resetAccountState();
  await commands.logout();
};
