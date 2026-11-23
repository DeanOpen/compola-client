// Routes every `compola://state` snapshot (page == "main") to its feature handler — Swift `ZaloEngine.handle(state:)`.
// A snapshot goes to the FIRST handler whose key it carries, in this exact order (same as Swift). Features of later
// waves register their handler with `registerStateHandler`; until then their snapshots are ignored.

import { obj, optStr, str, type Json } from './models/json';
import { setEngine } from './store';

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

export const dispatchState = (payload: unknown) => {
  const state = obj(payload);
  if (!state || state.page !== 'main') return;
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
      },
    });
  }
};
