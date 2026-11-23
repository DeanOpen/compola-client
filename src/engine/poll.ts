// Group polls (MSG_POLL 26), bridged to `host-scripts/poll-adapter.js` (`window.__zaloPoll`; posts
// {page:'main', poll:{id, detail}} / {page:'main', poll:{id, error}}) — port of ZaloEngine+Poll.swift. Everything runs
// through the official GroupPollManager. Writes (vote / lock / share / create / pin) only run from explicit clicks.

import { create } from 'zustand';
import { backend } from './backend';
import { callAdapter, fireAdapter, raceTimeout } from './call';
import { registerStateHandler } from './dispatch';
import type { ChatMessage } from './models/chat';
import { obj, str, type Json } from './models/json';
import {
  createSpec,
  parsePollActionResult,
  parsePollCapabilities,
  parsePollDetail,
  parsePollPinConfirm,
  parsePollPinState,
  parsePollVoters,
  voteRequest,
  type PollActionResult,
  type PollCapabilities,
  type PollConfig,
  type PollCreateDraft,
  type PollDetail,
  type PollPinOutcome,
  type PollPinState,
  type PollVoteDraft,
  type PollVoters,
} from './models/poll';
import { onAccountReset, useEngine } from './store';

interface PollState {
  details: Record<string, PollDetail>;
  /** Board state per poll (read when a card / the sheet is on screen). */
  pins: Record<string, PollPinState>;
  /** Polls whose last read failed (the card offers a retry). */
  failed: ReadonlySet<string>;
}

const empty = (): PollState => ({ details: {}, pins: {}, failed: new Set() });

export const usePolls = create<PollState>()(empty);

const set = usePolls.setState;
const get = usePolls.getState;

const withoutFailed = (id: string) => {
  const failed = get().failed;
  if (!failed.has(id)) return failed;
  const next = new Set(failed);
  next.delete(id);
  return next;
};

// Module-level clocks (Swift `PollClock`).
const refreshTasks = new Map<string, ReturnType<typeof setTimeout>>();
/** Poll event messages already answered with a refresh (each message once). */
let seenMessages = new Set<string>();
/** Polls on screen (id → conversation): re-registered with the page after a reload. */
const watched = new Map<string, string>();
const lastAttempt = new Map<string, number>();

const callPoll = (method: string, ...args: unknown[]) => fireAdapter('__zaloPoll', method, ...args);

/** `await __zaloPoll[method](...)` that gives up after `seconds`; null = no answer. */
const awaitPoll = async (seconds: number, method: string, ...args: unknown[]): Promise<unknown> => {
  const answer = await raceTimeout(seconds, callAdapter('__zaloPoll', method, ...args).catch(() => null));
  return answer ? answer.value : null;
};

/** Starts reading the poll (cache → DB → server) and keeps it live. Called when a card is on screen. */
export const watchPoll = (id: string, conversationId: string) => {
  if (!id) return;
  watched.set(id, conversationId);
  if (watched.size > 500) {
    const drop = [...watched.keys()].find((k) => k !== id);
    if (drop) {
      watched.delete(drop);
      lastAttempt.delete(drop);
    }
  }
  if (get().details[id]) return;
  // A failed read is retried at most every 5 s by scrolling; the card's "Thử lại" button retries at once.
  const last = lastAttempt.get(id);
  if (last && Date.now() - last < 5000) return;
  lastAttempt.set(id, Date.now());
  set({ failed: withoutFailed(id) });
  callPoll('watch', id, conversationId);
};

export const retryPoll = (id: string, conversationId: string) => {
  lastAttempt.set(id, Date.now());
  set({ failed: withoutFailed(id) });
  callPoll('watch', id, conversationId);
};

/** The main page (re)loaded: its JS context knows no watches, so register every poll on screen again. */
export const rewatchPolls = () => {
  for (const [id, conversationId] of watched) callPoll('watch', id, conversationId);
};

export const refreshPoll = (id: string) => callPoll('refresh', id, false);

/** Who voted for what. null = could not be read. */
export const pollVoters = async (id: string): Promise<PollVoters | null> => parsePollVoters(await awaitPoll(45, 'voters', id));

/** Reads the group's board topics and whether this poll is pinned. Read-only. */
export const refreshPollPin = async (id: string, conversationId: string): Promise<PollPinState> => {
  const state = parsePollPinState(await awaitPoll(30, 'pinState', conversationId, id));
  const known = get().pins[id];
  // A transient failure keeps what was known (the menu item does not flicker away).
  if ((state.ready || !known) && JSON.stringify(known) !== JSON.stringify(state)) set({ pins: { ...get().pins, [id]: state } });
  return get().pins[id] ?? state;
};

/** The board is updated by the sync event: show the answer at once, then re-read until the board agrees (bounded). */
const settlePollPin = (id: string, conversationId: string, expected: boolean, optimistic = true) => {
  const state = get().pins[id];
  if (optimistic && state?.ready) set({ pins: { ...get().pins, [id]: { ...state, pinned: expected } } });
  void (async () => {
    for (const delay of [1000, 2500, 5000]) {
      await new Promise((r) => setTimeout(r, delay));
      if ((await refreshPollPin(id, conversationId)).pinned === expected) return;
    }
  })();
};

/**
 * WRITE ("Ghim lên đầu trò chuyện"): when the board is full the first call answers `needsConfirmation` (nothing changed);
 * the user's confirmation calls again with that `ref`, which drops the oldest pin first.
 */
export const pinPoll = async (id: string, conversationId: string, confirmingRef: string | null = null): Promise<PollPinOutcome> => {
  const answer = await awaitPoll(100, 'pin', conversationId, id, confirmingRef);
  if (answer === null || answer === undefined) {
    settlePollPin(id, conversationId, true, false);
    return { kind: 'failed', result: { ok: false, error: 'unknown', pinSkipped: false } };
  }
  const json = obj(answer);
  if (json && str(json.error) === 'confirm') {
    const confirm = parsePollPinConfirm(json);
    if (confirm) return { kind: 'needsConfirmation', confirm };
  }
  const result = parsePollActionResult(answer);
  if (result.ok) settlePollPin(id, conversationId, true);
  return result.ok ? { kind: 'done' } : { kind: 'failed', result };
};

/** WRITE ("Bỏ ghim bình chọn"). */
export const unpinPoll = async (id: string, conversationId: string): Promise<PollActionResult> => {
  const answer = await awaitPoll(100, 'unpin', conversationId, id);
  if (answer === null || answer === undefined) {
    settlePollPin(id, conversationId, false, false);
    return { ok: false, error: 'unknown', pinSkipped: false };
  }
  const result = parsePollActionResult(answer);
  if (result.ok) settlePollPin(id, conversationId, false);
  return result;
};

export const pollCapabilities = async (conversationId: string): Promise<PollCapabilities> =>
  parsePollCapabilities(await awaitPoll(30, 'capabilities', conversationId));

const awaitAction = async (method: string, ...args: unknown[]): Promise<PollActionResult> => {
  try {
    return parsePollActionResult(await callAdapter('__zaloPoll', method, ...args));
  } catch {
    return parsePollActionResult(null);
  }
};

/** WRITE ("Xác nhận"): vote / change vote / unvote, plus options added by me. */
export const votePoll = (id: string, conversationId: string, draft: PollVoteDraft, detail: PollDetail) => {
  const r = voteRequest(draft, detail);
  return awaitAction('vote', conversationId, id, r.newOptions, r.votedIds);
};

/** WRITE ("Khóa bình chọn"). */
export const lockPoll = (id: string, conversationId: string) => awaitAction('lock', conversationId, id);

/** WRITE ("Gửi vào nhóm"): posts the poll again into the group. */
export const sharePoll = (id: string, conversationId: string) => awaitAction('share', conversationId, id);

/** WRITE ("Tạo bình chọn"). */
export const createPoll = (conversationId: string, draft: PollCreateDraft, config: PollConfig, canPin: boolean) =>
  awaitAction('create', conversationId, createSpec(draft, config, canPin));

/** New poll event messages (vote / update / close by anyone) → re-read the poll if the official sync did not refresh it. */
const notePollMessages = (incoming: ChatMessage[]) => {
  const recent = Date.now() - 120_000;
  for (const message of incoming) {
    if (message.kind.type !== 'poll') continue;
    const id = message.kind.poll.pollId;
    if (!id || !get().details[id] || message.date <= recent || seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);
    if (seenMessages.size > 2000) seenMessages = new Set([message.id]);
    clearTimeout(refreshTasks.get(id));
    refreshTasks.set(
      id,
      setTimeout(() => {
        refreshTasks.delete(id);
        callPoll('refresh', id, true);
      }, 1500),
    );
  }
};

const handlePoll = (state: Json) => {
  const json = obj(state.poll);
  const id = json ? str(json.id) : '';
  if (!json || !id) return;
  const detail = parsePollDetail(json.detail);
  if (detail) {
    const current = get().details[id];
    const failed = withoutFailed(id);
    if (!current || JSON.stringify(current) !== JSON.stringify(detail)) set({ details: { ...get().details, [id]: detail }, failed });
    else if (failed !== get().failed) set({ failed });
  } else if (json.error !== undefined && !get().details[id]) {
    set({ failed: new Set(get().failed).add(id) });
  }
};

registerStateHandler('poll', handlePoll);

// New messages of any conversation: the tail of each changed list (the newest messages arrive at the end).
useEngine.subscribe((s, prev) => {
  if (s.messages === prev.messages) return;
  for (const [convId, list] of Object.entries(s.messages)) {
    if (list === prev.messages[convId] || !list.length) continue;
    const before = new Set((prev.messages[convId] ?? []).map((m) => m.id));
    notePollMessages(list.slice(-20).filter((m) => !before.has(m.id)));
  }
});

void backend().then((b) =>
  b.listen('compola://page', (payload) => {
    const page = typeof payload === 'string' ? payload : str(obj(payload)?.page);
    if (page === 'main' || page === 'Main') rewatchPolls();
  }),
);

onAccountReset(() => {
  set(empty());
  for (const t of refreshTasks.values()) clearTimeout(t);
  refreshTasks.clear();
  seenMessages = new Set();
  watched.clear();
  lastAttempt.clear();
  callPoll('reset');
});
