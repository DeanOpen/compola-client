// Reminder e-cards (`action.open.reminder`), bridged to card-actions-adapter.js (port of the reminder part of
// ZaloEngine+CardActions.swift, ReminderSnapshot / ReminderResponders of ChatModels.swift and CardActionCenter's RSVP
// busy state). The state comes from the official reminder e-card controller; an RSVP is sent only from a click.

import { create } from 'zustand';
import { callAdapter, raceTimeout } from './call';
import { arr, obj, str } from './models/json';
import { showToast } from './toast';

export type ReminderVariant = 'hidden' | 'pending' | 'invite' | 'alert' | 'demotedCreate' | 'demotedAlert';
export type ReminderAnswer = 'accept' | 'reject';

export interface ReminderSnapshot {
  variant: ReminderVariant;
  /** Reminder id (not the message id): every card of the reminder shares its RSVP busy state. */
  id: string;
  title: string;
  start: Date | null;
  repeatLabel: string;
  creatorName: string;
  onlyMe: boolean;
  isGroup: boolean;
  mine: ReminderAnswer | null;
  /** An answer is still being sent by the official controller. */
  pending: ReminderAnswer | null;
  acceptedCount: number;
  rejectedCount: number;
  canRsvp: boolean;
  canView: boolean;
  deleted: boolean;
  sig: string;
}

const variants: ReminderVariant[] = ['hidden', 'pending', 'invite', 'alert', 'demotedCreate', 'demotedAlert'];
const answer = (v: unknown): ReminderAnswer | null => (v === 'accept' || v === 'reject' ? v : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);

export const parseReminderSnapshot = (v: unknown): ReminderSnapshot | null => {
  const r = obj(v);
  if (!r) return null;
  const ms = typeof r.start === 'number' ? r.start : 0;
  return {
    variant: variants.includes(r.variant as ReminderVariant) ? (r.variant as ReminderVariant) : 'hidden',
    id: str(r.rid),
    title: str(r.title),
    // Plausible timestamps only (1970 … 2100).
    start: ms > 0 && ms < 4_102_444_800_000 ? new Date(ms) : null,
    repeatLabel: str(r.repeat),
    creatorName: str(r.creatorName),
    onlyMe: r.onlyMe === true,
    isGroup: r.isGroup === true,
    mine: answer(r.mine),
    pending: answer(r.pending),
    acceptedCount: count(r.accepted),
    rejectedCount: count(r.rejected),
    canRsvp: r.canRsvp === true,
    canView: r.canView === true,
    deleted: r.deleted === true,
    sig: str(r.sig),
  };
};

/** The official card draws something (not hidden / pending). */
export const isDrawn = (s: ReminderSnapshot) => s.variant !== 'hidden' && s.variant !== 'pending';
/** Official: group, not "only me", may answer, not deleted, no answer yet → "Tham gia" / "Từ chối". */
export const showsRsvpButtons = (s: ReminderSnapshot) => s.isGroup && !s.onlyMe && s.canRsvp && !s.deleted && s.mine === null;
export const showsRsvpStatus = (s: ReminderSnapshot) => s.isGroup && !s.onlyMe && s.mine !== null;
export const hasResponders = (s: ReminderSnapshot) => s.isGroup && !s.onlyMe;
/** "N người tham gia, M người từ chối" (null while nobody answered). */
export const responderSummary = (s: ReminderSnapshot) => {
  const parts = [];
  if (s.acceptedCount > 0) parts.push(`${s.acceptedCount} người tham gia`);
  if (s.rejectedCount > 0) parts.push(`${s.rejectedCount} người từ chối`);
  return parts.length ? parts.join(', ') : null;
};

/**
 * Reminder state from the official controller. Answers when the state differs from `signature` (or after ~25 s with the
 * unchanged state); null when the controller is not available.
 */
export const reminderWatch = async (conversationId: string, messageId: string, signature: string) => {
  const r = await raceTimeout(40, callAdapter('__zaloChat', 'reminderWatch', conversationId, messageId, signature).catch(() => null));
  return parseReminderSnapshot(r?.value);
};

/** Follows a reminder until `isCancelled`; gives up after three misses (`onUnavailable`). */
export const followReminder = (
  conversationId: string,
  messageId: string,
  onSnapshot: (s: ReminderSnapshot) => void,
  onUnavailable?: () => void,
): (() => void) => {
  let cancelled = false;
  void (async () => {
    let sig = '';
    let misses = 0;
    while (!cancelled) {
      const next = await reminderWatch(conversationId, messageId, sig);
      if (cancelled) return;
      if (next) {
        onSnapshot(next);
        sig = next.sig;
        misses = 0;
      } else {
        misses += 1;
        if (misses >= 3) return onUnavailable?.();
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  })();
  return () => {
    cancelled = true;
  };
};

// MARK: RSVP

/** Keys `<conversation>|<reminder>|rsvp:accept|reject` of answers being sent (shared by every card of the reminder). */
export const useRsvpBusy = create<{ busy: ReadonlySet<string> }>()(() => ({ busy: new Set() }));
const scopeOf = (conversationId: string, reminderId: string, messageId: string) => `${conversationId}|${reminderId ? `reminder:${reminderId}` : messageId}`;

export const isRsvpBusy = (busy: ReadonlySet<string>, conversationId: string, reminderId: string, messageId: string, ref?: ReminderAnswer) => {
  const scope = scopeOf(conversationId, reminderId, messageId);
  return ref ? busy.has(`${scope}|rsvp:${ref}`) : [...busy].some((k) => k.startsWith(`${scope}|`));
};

/** RSVP (official controller `respond`); only from a click. One answer at a time per reminder. */
export const respondToReminder = async (conversationId: string, messageId: string, reminderId: string, accept: boolean) => {
  const { busy } = useRsvpBusy.getState();
  if (isRsvpBusy(busy, conversationId, reminderId, messageId)) return;
  const key = `${scopeOf(conversationId, reminderId, messageId)}|rsvp:${accept ? 'accept' : 'reject'}`;
  useRsvpBusy.setState({ busy: new Set([...busy, key]) });
  try {
    const r = await raceTimeout(40, callAdapter('__zaloChat', 'reminderRespond', conversationId, messageId, accept ? 'accept' : 'reject').catch(() => null));
    const root = obj(r?.value);
    // No answer is not a failure: the answer may still land.
    if (!root) return showToast('Đang xử lý, hãy kiểm tra lại sau.', conversationId);
    if (root.ok !== true) showToast(str(root.text) || 'Có lỗi xảy ra', conversationId);
  } finally {
    const now = new Set(useRsvpBusy.getState().busy);
    now.delete(key);
    useRsvpBusy.setState({ busy: now });
  }
};

// MARK: Responders

export interface ReminderPerson {
  uid: string;
  name: string;
  avatar: string | null;
  isMe: boolean;
}

export interface ReminderResponders {
  accept: ReminderPerson[];
  reject: ReminderPerson[];
  /** Full counts (they include people without a profile, who are not listed). */
  acceptTotal: number;
  rejectTotal: number;
  /** People left out only because the list is capped. */
  acceptMore: number;
  rejectMore: number;
}

const people = (v: unknown): ReminderPerson[] => {
  const seen = new Set<string>();
  return arr(v).flatMap((raw) => {
    const row = obj(raw);
    const uid = row ? str(row.uid) : '';
    if (!row || !uid || seen.has(uid)) return [];
    seen.add(uid);
    return [{ uid, name: str(row.name), avatar: str(row.avatar) || null, isMe: row.isMe === true }];
  });
};

/** Who accepted / declined (official responders page, a read); only when the user opens the list. null = unreadable. */
export const reminderResponders = async (conversationId: string, messageId: string): Promise<ReminderResponders | null> => {
  const r = obj((await raceTimeout(40, callAdapter('__zaloChat', 'reminderResponders', conversationId, messageId).catch(() => null)))?.value);
  if (!r || r.ok !== true) return null;
  const accept = people(r.accept);
  const reject = people(r.reject);
  return {
    accept,
    reject,
    acceptTotal: Math.max(accept.length, count(r.acceptTotal)),
    rejectTotal: Math.max(reject.length, count(r.rejectTotal)),
    acceptMore: count(r.acceptMore),
    rejectMore: count(r.rejectMore),
  };
};

// MARK: Detail sheet request

export interface ReminderRequest {
  conversationId: string;
  messageId: string;
  openList: boolean;
}

export const useReminderDetail = create<{ request: ReminderRequest | null }>()(() => ({ request: null }));
export const showReminderDetail = (request: ReminderRequest | null) => useReminderDetail.setState({ request });
