// Routes every `compola://state` snapshot (page == "main") to its feature handler — Swift `ZaloEngine.handle(state:)`.
// A snapshot goes to the FIRST handler whose key it carries, in this exact order (same as Swift). Features of later
// waves register their handler with `registerStateHandler`; until then their snapshots are ignored.

import { obj, optStr, str, type Json } from './models/json';
import { getEngine, setEngine } from './store';

export type StateKey =
  | 'convActions'
  | 'conversationExtras'
  | 'zcloud'
  | 'poll'
  | 'compose'
  | 'pins'
  | 'contacts'
  | 'notification'
  | 'call'
  | 'transfer'
  | 'transferAvailable'
  | 'chat'
  | 'conversations';

/** Swift order of `case "main" where state[key] != nil`. `chat` also matches `typing`. */
const order: StateKey[] = [
  'convActions',
  'conversationExtras',
  'zcloud',
  'poll',
  'compose',
  'pins',
  'contacts',
  'notification',
  'call',
  'transfer',
  'transferAvailable',
  'chat',
  'conversations',
];

const handlers = new Map<StateKey, (state: Json) => void>();

export const registerStateHandler = (key: StateKey, handle: (state: Json) => void) => {
  handlers.set(key, handle);
};

const has = (state: Json, key: StateKey) =>
  key === 'chat' ? state.chat !== undefined || state.typing !== undefined : state[key] !== undefined;

/** A full conversation list of the live client (not a chat event, not a delta). */
const isLiveList = (state: Json) =>
  state.conversations !== undefined && state.chat === undefined && (typeof state.reset === 'boolean' ? state.reset : state.removed === undefined);

/** Live snapshots that arrived while the window showed the startup cache, applied in order with the client's own list:
 * the client posts partial state while it boots (an empty filter list, no labels yet) that would blank the cached view. */
let pendingLive: Json[] = [];
const PENDING_CAP = 5000;

/** Account switched or signed out: what was held belongs to the previous one. */
export const dropPendingLive = () => {
  pendingLive = [];
};

export const dispatchState = (payload: unknown) => {
  const state = obj(payload);
  if (!state || state.page !== 'main') return;
  // Startup cache (engine.rs): shown until the official client posts its own list, which replaces it.
  if (state.cached === true) {
    if (!getEngine().cached) setEngine({ cached: true });
  } else if (getEngine().cached) {
    if (!isLiveList(state)) {
      if (pendingLive.length < PENDING_CAP) pendingLive.push(state);
      return;
    }
    const held = pendingLive;
    pendingLive = [];
    setEngine({ cached: false });
    for (const s of held) apply(s);
  }
  apply(state);
};

const apply = (state: Json) => {
  for (const key of order) {
    if (!has(state, key)) continue;
    handlers.get(key)?.(state);
    return;
  }
  // No feature key: the signed-in profile.
  const user = obj(state.user);
  const userId = user ? str(user.userId) : '';
  if (user && userId) {
    setEngine({
      profile: {
        userId,
        displayName: str(user.displayName) || str(user.zaloName),
        avatar: optStr(user.avatar),
        phone: optStr(user.phoneNumber),
        zaloName: optStr(user.zaloName),
        username: optStr(user.username),
        bio: optStr(user.bio),
        cover: optStr(user.cover),
        gender: typeof user.gender === 'number' ? user.gender : null,
        birthday: optStr(user.birthday),
      },
    });
  }
};
