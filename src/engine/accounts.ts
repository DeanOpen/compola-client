// Several Zalo accounts in one Compola, UI side (docs/multi-account.md §6). The host keeps every enabled account running;
// the window shows the active one. Switching swaps every account-scoped store at once (a snapshot per account), then
// re-reads that account's phase and replay from the host, so the screen changes without a reload and an account seen
// before comes back instantly.
//
// Contract: accounts_list → AccountList · compola://accounts {kind: changed | active | duplicate} ·
// account_add({activate}) · account_remove · account_set_active · account_reorder · account_set_enabled ·
// account_rename · engine_* {account?} · compola://badge {account, count} · compola://call-event {kind:'busy', …}.
// A host without accounts_list (single-account builds) keeps today's UI: the list stays empty.

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { backend, setAccountOnScreen } from './backend';
import { log } from './call';
import { arr, bool, int, obj, str } from './models/json';
import type { LoginState, Phase } from './models/phase';
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
import { showToast } from './toast';
import { useShell } from '../shell/shellStore';

export type AccountPhase = 'disabled' | 'starting' | 'preparing' | 'login' | 'signingIn' | 'ready';

export interface AccountInfo {
  id: string;
  uid: string | null;
  /** The admin's local label when set, else the Zalo name (§1). */
  name: string;
  avatar: string | null;
  order: number;
  enabled: boolean;
  phase: AccountPhase;
  /** Unread count of the account (its badge). */
  badge: number;
}

interface AccountsState {
  accounts: AccountInfo[];
  activeId: string | null;
  maxAccounts: number;
  /** The account being added: its QR shows in a sheet (it stays inactive until signed in). */
  adding: string | null;
  /** That account's login card while it is on the QR screen. */
  addingLogin: LoginState | null;
}

export const useAccounts = create<AccountsState>()(() => ({ accounts: [], activeId: null, maxAccounts: 5, adding: null, addingLogin: null }));
const set = useAccounts.setState;
const get = useAccounts.getState;

export const defaultAccountId = 'default';
const validId = (id: string) => /^(default|a[0-9a-f]{8})$/.test(id);
const phases: AccountPhase[] = ['disabled', 'starting', 'preparing', 'login', 'signingIn', 'ready'];

const parseAccount = (v: unknown): AccountInfo | null => {
  const r = obj(v);
  const id = r ? str(r.id) : '';
  if (!r || !validId(id)) return null;
  const phase = phases.includes(r.phase as AccountPhase) ? (r.phase as AccountPhase) : 'starting';
  return {
    id,
    uid: str(r.uid) || null,
    name: str(r.label) || str(r.name),
    avatar: str(r.avatar) || null,
    order: int(r.order),
    enabled: bool(r.enabled, true),
    phase,
    badge: Math.max(0, int(r.badge)),
  };
};

export const accountTitle = (a: AccountInfo) =>
  a.name || (a.phase === 'login' || a.phase === 'signingIn' ? 'Chưa đăng nhập' : a.id === defaultAccountId ? 'Tài khoản chính' : 'Tài khoản Zalo');

// MARK: Per-account stores

/** Stores whose content belongs to one account. Their state at load time is a fresh account's. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scoped: UseBoundStore<StoreApi<any>>[] = [
  useEngine,
  useShell,
  useContacts,
  useNotifications,
  // Not useCalls: one call helper serves every account (§4); a call goes on while another account is on screen.
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

/** Keeps the account on screen and shows `to`: its last state, or a fresh one the first time. */
const swapStores = (from: string | null, to: string) => {
  // The first account the host names is the one whose data is already in the stores.
  if (from === to || from === null) return;
  snapshots.set(from, scoped.map((s) => s.getState()));
  const next = snapshots.get(to) ?? fresh;
  scoped.forEach((s, i) => s.setState(next[i], true));
};

/** Set by lifecycle.ts: re-read the active account's phase and replay (what a UI does when it loads). */
let resync: () => Promise<void> = async () => {};
export const setAccountResync = (fn: () => Promise<void>) => {
  resync = fn;
};

/** Events tagged with another account than the one on screen are not this screen's (a race right after a switch). */
export const isForActiveAccount = (payload: unknown) => {
  const account = str(obj(payload)?.account);
  const active = get().activeId;
  return !account || !active || account === active;
};

// MARK: Host → UI

const applyList = (v: unknown) => {
  const r = obj(v);
  if (!r) return;
  const accounts = arr(r.accounts)
    .flatMap((a) => parseAccount(a) ?? [])
    .sort((a, b) => a.order - b.order);
  for (const id of [...snapshots.keys()]) if (!accounts.some((a) => a.id === id)) snapshots.delete(id);
  const adding = get().adding;
  set({ accounts, maxAccounts: int(r.maxAccounts) || 5, adding: adding && accounts.some((a) => a.id === adding) ? adding : null });
  const active = str(r.active);
  if (active && validId(active)) activate(active);
};

const activate = (id: string) => {
  const before = get().activeId;
  if (id === before) return;
  swapStores(before, id);
  set({ activeId: id });
  setAccountOnScreen(id);
  if (before !== null) void resync();
};

const onAccountsEvent = (v: unknown) => {
  const r = obj(v);
  if (!r) return;
  switch (r.kind) {
    case 'changed':
      return applyList(r.list);
    case 'active': {
      const id = str(r.account);
      if (validId(id)) activate(id);
      return;
    }
    case 'duplicate': {
      // The QR resolved to an account Compola already has: the new one is gone, the existing one is active.
      const id = str(r.account);
      if (get().adding) set({ adding: null, addingLogin: null });
      const a = get().accounts.find((x) => x.id === id);
      showToast(`Tài khoản Zalo này đã có trên Compola${a ? ` (${accountTitle(a)})` : ''}. Đã chuyển sang tài khoản đó.`, null);
      if (validId(id)) activate(id);
    }
  }
};

let started = false;
export const startAccounts = async () => {
  if (started) return;
  started = true;
  const b = await backend();
  await b.listen('compola://accounts', onAccountsEvent);
  // Badges always reach the UI, per account (§5): the rail's numbers for the accounts not on screen stay live.
  await b.listen('compola://badge', (p) => {
    const r = obj(p);
    const id = r ? str(r.account) : '';
    if (!r || !id || id === get().activeId || typeof r.count !== 'number') return;
    const count = Math.max(0, Math.trunc(r.count));
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id && a.badge !== count ? { ...a, badge: count } : a)) }));
  });
  // Another account wants the call helper while a call runs on the owner (§4).
  await b.listen('compola://call-event', (p) => {
    const r = obj(p);
    if (r?.kind !== 'busy') return;
    const owner = get().accounts.find((a) => a.id === str(r.owner));
    showToast(`Đang có cuộc gọi trên tài khoản ${owner ? accountTitle(owner) : 'khác'}.`, null);
  });
  try {
    applyList(await b.invoke('accounts_list'));
  } catch (e) {
    // Single-account host: the rail keeps its one avatar.
    log(`accounts_list → ${String(e)}`);
  }
};

// MARK: UI → host

const call = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  try {
    return await (await backend()).invoke(command, args);
  } catch (e) {
    const text = String(e).replace(/^Error:\s*/, '');
    log(`${command} → ${text}`);
    if (text) showToast(text, null);
    return null;
  }
};

/** Shows another account: the stores swap right away, the host makes it active and the UI resyncs. */
export const switchAccount = (id: string) => {
  const { activeId, accounts } = get();
  if (id === activeId || !accounts.some((a) => a.id === id)) return;
  activate(id);
  void call('account_set_active', { account: id });
};

/** ⌃1–5: the n-th account of the rail. */
export const switchToIndex = (index: number) => {
  const a = get().accounts[index];
  if (a) switchAccount(a.id);
};

export const canAddAccount = () => get().accounts.length > 0 && get().accounts.length < get().maxAccounts;

// MARK: Adding an account

let addPoll: ReturnType<typeof setInterval> | null = null;
const stopAddPoll = () => {
  if (addPoll) clearInterval(addPoll);
  addPoll = null;
};

/** Reads the new account's phase (its events do not reach a UI scoped to the active account). */
const pollAdding = async () => {
  const id = get().adding;
  if (!id) return stopAddPoll();
  let phase: Phase | null = null;
  try {
    phase = await (await backend()).invoke<Phase>('engine_phase', { account: id });
  } catch {
    return;
  }
  if (get().adding !== id || !phase) return;
  if (phase.kind === 'login') set({ addingLogin: phase.login });
  else if (phase.kind === 'signingIn' || phase.kind === 'ready') {
    // Signed in: close the sheet and show the new account.
    stopAddPoll();
    set({ adding: null, addingLogin: null });
    switchAccount(id);
  }
};

/** "+" / ⇧⌘N: a new account on its QR screen, kept inactive while its login card shows in a sheet. */
export const beginAddAccount = async () => {
  if (!canAddAccount() || get().adding) return;
  const r = obj(await call('account_add', { activate: false }));
  const id = r ? str(r.id) : '';
  if (!validId(id)) return;
  set({ adding: id, addingLogin: null });
  stopAddPoll();
  void pollAdding();
  addPoll = setInterval(() => void pollAdding(), 1500);
};

/** Closing the sheet before the scan: the half-added account is removed again. */
export const cancelAddAccount = () => {
  const id = get().adding;
  stopAddPoll();
  set({ adding: null, addingLogin: null });
  if (id) void call('account_remove', { account: id });
};

export const refreshAddQr = () => {
  const id = get().adding;
  if (id) void call('engine_refresh_qr', { account: id }).then(() => pollAdding());
};

// MARK: Managing accounts

export const signOutAccount = (id: string) => void call('engine_logout', { account: id });
/** `default` is never deleted: removing it signs it out (§3). */
export const removeAccount = (id: string) => void call('account_remove', { account: id });
export const renameAccount = (id: string, name: string) => void call('account_rename', { account: id, name: name.trim() });
export const setAccountEnabled = (id: string, enabled: boolean) => void call('account_set_enabled', { account: id, enabled });
export const reorderAccounts = (ids: string[]) => {
  const byId = new Map(get().accounts.map((a) => [a.id, a]));
  set({ accounts: ids.flatMap((i) => byId.get(i) ?? []) });
  void call('account_reorder', { ids });
};

/** The account a notification / event belongs to, when it is another one than the one on screen. */
export const otherAccount = (payload: unknown): string | null => {
  const account = str(obj(payload)?.account);
  return account && validId(account) && account !== get().activeId ? account : null;
};

/** "Sales 2 · …": names the account a notice belongs to when it is not the one on screen. */
export const accountPrefix = (accountId: string | null | undefined) => {
  const { activeId, accounts } = get();
  if (!accountId || accountId === activeId || accounts.length < 2) return '';
  const a = accounts.find((x) => x.id === accountId);
  return a ? `${accountTitle(a)} · ` : '';
};
