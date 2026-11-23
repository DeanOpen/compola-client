// Several Zalo accounts in one Compola (UI side). The account list and the active account come from the host; switching
// swaps every account-scoped store at once (a snapshot per account), so the window changes accounts without reloading
// and coming back is instant.
//
// TRANSPORT IS PROVISIONAL — to be aligned with docs/multi-account.md (branch feature/multi-account) when it lands:
//   accounts_list → {accounts, activeId}          event compola://accounts {accounts, activeId}
//   account_switch {id}   account_add → {id}   account_cancel_add {id}   account_refresh_qr {id}   account_logout {id}
//   account_remove {id}
//   accounts_reorder {ids}
// Account = {id, name, avatar, phone, unread, state: 'signedIn' | 'signingIn' | 'signedOut', login?: LoginState}.

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { backend } from './backend';
import { log } from './call';
import { arr, int, obj, str } from './models/json';
import type { LoginState } from './models/phase';
import { useCalls } from './calls';
import { useCardSheets } from './cardSheets';
import { useCloud } from './cloud';
import { useContacts } from './contacts';
import { useConversationUI } from './conversationActions';
import { useGroupMembers } from './groupMembers';
import { useMessageJump } from './messageJump';
import { useNotifications } from './notifications';
import { usePolls } from './poll';
import { useReminderDetail, useRsvpBusy } from './reminders';
import { useSharedMedia } from './sharedMedia';
import { useStickerSuggest } from './stickers';
import { useEngine } from './store';
import { useShell } from '../shell/shellStore';

export type AccountState = 'signedIn' | 'signingIn' | 'signedOut';

export interface AccountInfo {
  id: string;
  name: string;
  avatar: string | null;
  phone: string | null;
  /** Unread conversations (the rail badge), also for accounts not on screen. */
  unread: number;
  state: AccountState;
  /** While `signingIn`: the login card's state (QR, waiting for confirmation…). */
  login: LoginState | null;
}

interface AccountsState {
  accounts: AccountInfo[];
  activeId: string | null;
  /** The account being added (its login card shows in a sheet), null otherwise. */
  adding: string | null;
}

export const useAccounts = create<AccountsState>()(() => ({ accounts: [], activeId: null, adding: null }));
const set = useAccounts.setState;
const get = useAccounts.getState;

export const maxAccounts = 5;

const parseAccount = (v: unknown): AccountInfo | null => {
  const r = obj(v);
  const id = r ? str(r.id) : '';
  if (!r || !id) return null;
  const state = r.state === 'signingIn' || r.state === 'signedOut' ? r.state : 'signedIn';
  const l = obj(r.login);
  const step = l ? obj(l.step) : null;
  const login: LoginState | null =
    l && step && typeof step.kind === 'string' ? { step: step as unknown as LoginState['step'], qr: str(l.qr) || null, isSecondQr: l.isSecondQr === true } : null;
  return { id, name: str(r.name), avatar: str(r.avatar) || null, phone: str(r.phone) || null, unread: Math.max(0, int(r.unread)), state, login };
};

// MARK: Per-account stores

/** Stores whose content belongs to one account. Their state at load time is the "fresh account" state. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scoped: UseBoundStore<StoreApi<any>>[] = [
  useEngine,
  useShell,
  useContacts,
  useNotifications,
  useCalls,
  useCloud,
  useGroupMembers,
  usePolls,
  useSharedMedia,
  useCardSheets,
  useMessageJump,
  useConversationUI,
  useReminderDetail,
  useRsvpBusy,
  useStickerSuggest,
];
const fresh = scoped.map((s) => s.getState());
const snapshots = new Map<string, unknown[]>();

/** Keeps the account on screen and shows `to`: its last state when it was on screen before, a fresh one otherwise. */
const swapStores = (from: string | null, to: string) => {
  if (from === to) return;
  if (from) snapshots.set(from, scoped.map((s) => s.getState()));
  const next = snapshots.get(to) ?? fresh;
  scoped.forEach((s, i) => s.setState(next[i], true));
};

// MARK: Host → UI

const apply = (v: unknown) => {
  const r = obj(v);
  if (!r) return;
  const accounts = arr(r.accounts).flatMap((a) => parseAccount(a) ?? []);
  const activeId = str(r.activeId) || null;
  const before = get().activeId;
  if (activeId && activeId !== before) swapStores(before, activeId);
  // A removed account's snapshot goes with it.
  for (const id of [...snapshots.keys()]) if (!accounts.some((a) => a.id === id)) snapshots.delete(id);
  const adding = get().adding;
  set({ accounts, activeId, adding: adding && accounts.some((a) => a.id === adding && a.state === 'signingIn') ? adding : null });
};

let started = false;
export const startAccounts = async () => {
  if (started) return;
  started = true;
  const b = await backend();
  await b.listen('compola://accounts', apply);
  try {
    apply(await b.invoke('accounts_list'));
  } catch (e) {
    // Not offered by this host (single-account build): the rail shows the one account as before.
    log(`accounts_list → ${String(e)}`);
  }
};

// MARK: UI → host

const call = async (command: string, args?: Record<string, unknown>) => {
  try {
    return await (await backend()).invoke(command, args);
  } catch (e) {
    log(`${command} → ${String(e)}`);
    return null;
  }
};

/** Shows another account. The stores swap right away; the host follows with that account's page. */
export const switchAccount = (id: string) => {
  const { activeId, accounts } = get();
  if (id === activeId || !accounts.some((a) => a.id === id)) return;
  swapStores(activeId, id);
  set({ activeId: id });
  void call('account_switch', { id });
};

/** ⌃1–5: the n-th account of the rail. */
export const switchToIndex = (index: number) => {
  const a = get().accounts[index];
  if (a) switchAccount(a.id);
};

export const canAddAccount = () => get().accounts.length < maxAccounts;

/** "+" / ⌘⇧N: a new account slot whose login card opens in a sheet. */
export const beginAddAccount = async () => {
  if (!canAddAccount() || get().adding) return;
  const r = obj(await call('account_add'));
  const id = r ? str(r.id) : '';
  if (id) set({ adding: id });
};

export const cancelAddAccount = () => {
  const id = get().adding;
  set({ adding: null });
  if (id) void call('account_cancel_add', { id });
};

/** A fresh QR for the account being added. */
export const refreshAddQr = () => {
  const id = get().adding;
  if (id) void call('account_refresh_qr', { id });
};

export const signOutAccount = (id: string) => void call('account_logout', { id });
export const removeAccount = (id: string) => void call('account_remove', { id });
export const reorderAccounts = (ids: string[]) => {
  const byId = new Map(get().accounts.map((a) => [a.id, a]));
  set({ accounts: ids.flatMap((i) => byId.get(i) ?? []) });
  void call('accounts_reorder', { ids });
};

/** "[Công việc] …": names the account a notice belongs to when it is not the one on screen. */
export const accountPrefix = (accountId: string | null | undefined) => {
  const { activeId, accounts } = get();
  if (!accountId || accountId === activeId || accounts.length < 2) return '';
  const a = accounts.find((x) => x.id === accountId);
  return a ? `[${a.name || 'Tài khoản khác'}] ` : '';
};
