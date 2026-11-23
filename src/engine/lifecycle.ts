// Boot: subscribe to the Rust engine's events and wire the feature handlers (Swift `ZaloEngine.boot` / `handle`).

import { resetStickers } from './stickers';
import { startAddonRuntime } from './addons';
import { backend, commands, isJoined } from './backend';
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
import { initRemote, remote, useRemote } from './remote';
import { getEngine, resetAccount, setEngine } from './store';
import { accountPrefix, isForActiveAccount, otherAccount, setAccountResync, switchAccount } from './accounts';
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
    const joined = await isJoined();
    await initRemote();
    await Promise.all([
      // Multi-account hosts tag events with their account; one for another account than the one on screen (a race
      // right after a switch) is dropped.
      b.listen('compola://phase', (p) => isForActiveAccount(p) && setPhase(p as Phase)),
      b.listen('compola://state', (s) => isForActiveAccount(s) && dispatchState(s)),
      // `n`, or `{account, count}` per account (the rail shows the others' from the account list).
      b.listen('compola://badge', (n) => {
        if (typeof n === 'number') return setEngine({ badge: n });
        const r = obj(n);
        if (r && isForActiveAccount(r)) setEngine({ badge: typeof r.count === 'number' ? r.count : 0 });
      }),
      b.listen('compola://page', (page) => {
        if (!isForActiveAccount(page)) return;
        if (page && typeof page === 'object') page = str(obj(page)?.page ?? obj(page)?.kind);
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
        // Another account's banner: Rust makes it active (§5); switch here too so the navigation lands in its stores
        // even when this event arrives before compola://accounts {kind: 'active'}.
        const other = otherAccount(p);
        if (other) switchAccount(other);
        if (convId) setEngine({ navigationRequest: convId });
      }),
      // An inline reply typed in a notification: send it; a refusal goes back to that conversation's composer.
      b.listen('compola://notification-reply', (p) => {
        const json = obj(p);
        const convId = str(json?.convId);
        const text = str(json?.text);
        if (!convId || !text.trim()) return;
        // A reply in another account's notification is sent by that account (engine_call {account}), not the one on
        // screen; a refusal is reported with the account's name (its composer is not on screen).
        const other = otherAccount(p);
        if (other) {
          void b
            .invoke('engine_call', { target: '__zaloChat', method: 'sendText', args: [convId, text.trim(), null, []], account: other })
            .then((r) => r === 'sent')
            .catch(() => false)
            .then((ok) => !ok && showToast(`${accountPrefix(other)}Chưa gửi được trả lời từ thông báo. Hãy mở tài khoản đó và gửi lại.`, null));
          return;
        }
        void sendText(text, convId).then((ok) => {
          if (ok) return;
          stashFailedDraft({ text, mentions: [], replyTo: null }, convId, true);
          showToast('Chưa gửi được trả lời từ thông báo. Nội dung đã được giữ lại trong ô soạn thảo.', null);
        });
      }),
      b.listen('compola://screen-capture', handleScreenCapture),
    ]);
    if (joined) {
      // The UI's state comes from the host: wait for the connection (the connection gate shows meanwhile), then
      // read the phase and the replay like a local UI would.
      try {
        await remote.waitConnected();
      } catch (e) {
        console.warn('[remote] wait for the connection failed', e);
      }
      watchRemoteResync();
    } else {
      // Add-ons run in workers next to the UI (they get their events from Rust, not from this page's state). A joined
      // app runs none: they act on the account, which lives on the host.
      void startAddonRuntime().catch((e) => console.warn('[addons] runtime failed to start', e));
    }
    await catchUp();
    // Another account became active (docs/multi-account.md §6): its stores were swapped in; catch up the same way.
    setAccountResync(catchUp);
  })();
  return started;
};

/**
 * The active account's phase, then what its main page posted since it loaded (Rust keeps it compacted): a UI that
 * (re)loaded, or switched to another account, catches up. Merges are idempotent, so overlap with live events is harmless.
 */
const catchUp = async () => {
  const b = await backend();
  try {
    setPhase(await commands.phase());
  } catch {
    /* the phase event follows */
  }
  if (b.isMock) return;
  try {
    const events = await b.invoke<unknown[]>('engine_replay');
    for (const event of events) dispatchState(event);
  } catch {
    /* older engine */
  }
};

/**
 * Joined: events missed while the connection was down cannot be merged, so once it comes back the page reloads and
 * resyncs from the host's replay; a changed access (role / scope) reloads too, since what the UI holds was filtered
 * for the previous one.
 */
const watchRemoteResync = () => {
  let dropped = false;
  useRemote.subscribe((s, prev) => {
    const c = s.connection;
    if (!c || c === prev.connection) return;
    const before = prev.connection?.access;
    if (before && c.access && JSON.stringify(before) !== JSON.stringify(c.access)) location.reload();
    else if (c.state !== 'connected') dropped = true;
    else if (dropped) location.reload();
  });
};

/**
 * Clears the session cookies and local client data, then shows a fresh QR. Joined to a Compola Server: leaves the
 * server instead (the Zalo account stays signed in on the host) and the app restarts.
 */
export const logOut = async () => {
  if (await isJoined()) {
    await remote.leave();
    return;
  }
  resetAccountState();
  await commands.logout();
};
