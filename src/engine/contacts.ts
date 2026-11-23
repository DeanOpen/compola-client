// Friends, groups, friend requests, add friend (Swift ZaloEngine+Contacts.swift). Bridged to
// `host-scripts/contacts-adapter.js` (`window.__zaloContacts`), which posts `{page:'main', contacts:{…}}`: each key
// replaces that section. Every action runs through the official client's own services (see the adapter header).

import { create } from 'zustand';
import { callAdapter, fireAdapter, raceTimeout, tryAdapter } from './call';
import { registerStateHandler } from './dispatch';
import { arr, bool, int, obj, optStr, str, url, type Json } from './models/json';
import type { ConversationSummary } from './models/conversations';
import { onAccountReset, setEngine, type EngineState } from './store';
import { showToast } from './toast';

export interface Friend {
  id: string;
  name: string;
  zaloName: string;
  avatar: string | null;
  /** Last activity (epoch ms) reported by the official profile, null when unknown. */
  lastActive: number | null;
  online: boolean;
  /** Upper-case Latin initial used for the alphabetical sections ("#" when not a letter). */
  section: string;
  /** Diacritic-folded lowercase name for sorting and searching. */
  sortKey: string;
}

export interface ContactGroup {
  id: string;
  name: string;
  avatar: string | null;
  members: number;
  sortKey: string;
}

export interface FriendRequest {
  id: string;
  name: string;
  avatar: string | null;
  message: string;
  /** Epoch ms; null when the official client has no timestamp for the request. */
  date: number | null;
}

export interface FoundUser {
  id: string;
  name: string;
  zaloName: string;
  avatar: string | null;
  bio: string;
  isFriend: boolean;
  isSelf: boolean;
  /** I already sent this person a request. */
  requested: boolean;
  /** This person already sent me a request. */
  requesting: boolean;
  /** Official default greeting for "find by phone" (editable by the user). */
  defaultMessage: string;
  maxMessage: number;
}

export type SearchStatus = 'idle' | 'searching' | 'found' | 'error';

export interface FriendSearch {
  status: SearchStatus;
  error: string | null;
  user: FoundUser | null;
}

/** "Có thể bạn quen": a friend suggestion of the official recommendation cache. */
export interface FriendSuggestion {
  id: string;
  name: string;
  avatar: string | null;
  /** Where the suggestion comes from ("Từ số điện thoại", "Từ nhóm trò chuyện"…), empty when unknown. */
  reason: string;
  /** Official "say hi" text for a request from this suggestion. */
  defaultMessage: string;
}

/** An invitation to join a group or community ("Lời mời vào nhóm và cộng đồng"). */
export interface GroupInvite {
  /** The group's conversation id (`g…`). */
  id: string;
  name: string;
  avatar: string | null;
  members: number;
  community: boolean;
  inviterId: string;
  inviterName: string;
  inviterAvatar: string | null;
  /** The inviter created the group (the official card marks them "Trưởng nhóm"). */
  inviterIsOwner: boolean;
  /** Epoch ms; null when unknown. */
  expiresAt: number | null;
  /** I already asked to join; the group's admins have to approve. */
  pendingReview: boolean;
}

export interface GroupInvites {
  /** The official invitation box was found in the client. */
  available: boolean;
  loading: boolean;
  total: number;
  hasMore: boolean;
  items: GroupInvite[];
}

/** Result of the latest accept / decline / cancel / send action. */
export interface ContactsNotice {
  seq: number;
  ok: boolean;
  text: string;
}

export interface ContactsState {
  friends: Friend[];
  groups: ContactGroup[];
  received: FriendRequest[];
  sent: FriendRequest[];
  /** Pending received friend requests (sidebar badge). */
  pendingRequestCount: number;
  suggestions: FriendSuggestion[];
  /** Read only while the invitation page is on screen (like the official page). */
  groupInvites: GroupInvites;
  /** New group invitations not yet seen on the invitation page. */
  groupInviteUnread: number;
  loadingRequests: boolean;
  search: FriendSearch;
  notice: ContactsNotice | null;
  /** True once the official friend list has been read at least once. */
  friendsLoaded: boolean;
  groupsLoaded: boolean;
  /** People opened from the add-friend dialog who are neither friends nor in a conversation (chat placeholder). */
  known: Record<string, { name: string; avatar: string | null }>;
}

const idleSearch: FriendSearch = { status: 'idle', error: null, user: null };

const initial = (): ContactsState => ({
  friends: [],
  groups: [],
  received: [],
  sent: [],
  pendingRequestCount: 0,
  suggestions: [],
  groupInvites: { available: true, loading: false, total: 0, hasMore: false, items: [] },
  groupInviteUnread: 0,
  loadingRequests: false,
  search: idleSearch,
  notice: null,
  friendsLoaded: false,
  groupsLoaded: false,
  known: {},
});

export const useContacts = create<ContactsState>()(() => initial());
const set = useContacts.setState;

onAccountReset(() => set(initial()));

// MARK: - Folding

/** Lower-cased, diacritic-folded text (Vietnamese đ/Đ included) for searching and sorting. */
export const contactFold = (text: string): string =>
  text
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFKC')
    .toLowerCase();

/** Swift `localizedStandardCompare`. */
export const standardCompare = (a: string, b: string) => a.localeCompare(b, 'vi', { numeric: true, sensitivity: 'base' });

/** Letters A–Z first, "#" last. */
export const compareSections = (a: string, b: string) => {
  if (a === b) return 0;
  if (a === '#') return 1;
  if (b === '#') return -1;
  return a < b ? -1 : 1;
};

// MARK: - Parsing

const friendOf = (json: Json): Friend | null => {
  const id = str(json.id);
  if (!id) return null;
  const name = str(json.name) || str(json.zaloName);
  const key = contactFold(name).trim();
  const first = key.charAt(0).toUpperCase();
  const section = /^[A-Z]$/.test(first) ? first : '#';
  const last = int(json.lastActive);
  return {
    id,
    name,
    zaloName: str(json.zaloName),
    avatar: url(json.avatar),
    lastActive: last > 0 ? last : null,
    online: bool(json.online),
    section,
    sortKey: key,
  };
};

const groupOf = (json: Json): ContactGroup | null => {
  const id = str(json.id);
  if (!id) return null;
  const name = str(json.name);
  return { id, name, avatar: url(json.avatar), members: int(json.members), sortKey: contactFold(name) };
};

const requestOf = (json: Json): FriendRequest | null => {
  const id = str(json.id);
  if (!id) return null;
  const time = int(json.time);
  return { id, name: str(json.name), avatar: url(json.avatar), message: str(json.message), date: time > 0 ? time : null };
};

const searchOf = (json: Json): FriendSearch => {
  const raw = str(json.status);
  const status: SearchStatus = raw === 'searching' || raw === 'found' || raw === 'error' ? raw : 'idle';
  const u = obj(json.user);
  const id = u ? str(u.id) : '';
  return {
    status,
    error: optStr(json.error),
    user:
      u && id
        ? {
            id,
            name: str(u.name),
            zaloName: str(u.zaloName),
            avatar: url(u.avatar),
            bio: str(u.bio),
            isFriend: bool(u.isFriend),
            isSelf: bool(u.isSelf),
            requested: bool(u.requested),
            requesting: bool(u.requesting),
            defaultMessage: str(u.defaultMessage),
            maxMessage: int(u.maxMessage, 150) || 150,
          }
        : null,
  };
};

const suggestionOf = (j: Json): FriendSuggestion | null => {
  const id = str(j.id);
  if (!id) return null;
  return { id, name: str(j.name), avatar: url(j.avatar), reason: str(j.reason), defaultMessage: str(j.defaultMessage) };
};

const groupInviteOf = (j: Json): GroupInvite | null => {
  const id = str(j.id);
  if (!id) return null;
  const expires = int(j.expiresAt);
  return {
    id,
    name: str(j.name) || 'Nhóm',
    avatar: url(j.avatar),
    members: Math.max(0, int(j.members)),
    community: bool(j.community),
    inviterId: str(j.inviterId),
    inviterName: str(j.inviterName),
    inviterAvatar: url(j.inviterAvatar),
    inviterIsOwner: bool(j.inviterIsOwner),
    expiresAt: expires > 0 ? expires : null,
    pendingReview: bool(j.pendingReview),
  };
};

const rows = <T>(v: unknown, parse: (j: Json) => T | null): T[] =>
  arr(v)
    .map(obj)
    .filter((r): r is Json => !!r)
    .map(parse)
    .filter((x): x is T => x !== null);

export const handleContacts = (state: Json) => {
  const json = obj(state.contacts);
  if (!json) return;
  const next: Partial<ContactsState> = {};
  if (Array.isArray(json.friends)) {
    next.friends = rows(json.friends, friendOf);
    next.friendsLoaded = true;
  }
  if (Array.isArray(json.groups)) {
    next.groups = rows(json.groups, groupOf);
    next.groupsLoaded = true;
  }
  if (Array.isArray(json.received)) next.received = rows(json.received, requestOf);
  if (Array.isArray(json.sent)) next.sent = rows(json.sent, requestOf);
  if (Array.isArray(json.suggestions)) next.suggestions = rows(json.suggestions, suggestionOf);
  if (typeof json.pendingRequestCount === 'number') next.pendingRequestCount = Math.max(0, int(json.pendingRequestCount));
  const invites = obj(json.groupInvites);
  if (invites) {
    next.groupInvites = {
      available: invites.available !== false,
      loading: bool(invites.loading),
      total: Math.max(0, int(invites.total)),
      hasMore: bool(invites.hasMore),
      items: rows(invites.items, groupInviteOf),
    };
  }
  if (typeof json.groupInviteUnread === 'number') next.groupInviteUnread = Math.max(0, int(json.groupInviteUnread));
  const loading = obj(json.loading);
  if (loading && typeof loading.requests === 'boolean') next.loadingRequests = loading.requests;
  const search = obj(json.search);
  if (search) next.search = searchOf(search);
  const notice = obj(json.notice);
  if (notice && typeof notice.seq === 'number') {
    const n = { seq: int(notice.seq), ok: bool(notice.ok), text: str(notice.text) };
    const previous = useContacts.getState().notice;
    if (!previous || previous.seq !== n.seq || previous.text !== n.text) {
      next.notice = n;
      // The result of an accept / decline / cancel / send, wherever it was started.
      showToast(n.text);
    }
  }
  if (Object.keys(next).length) set(next);
};

registerStateHandler('contacts', handleContacts);

// MARK: - Visible lists (hidden chats left out, like the official friend list)

export const visibleFriends = (c: ContactsState, e: EngineState): Friend[] =>
  e.conversationActions.hiddenKnown ? c.friends.filter((f) => !e.conversationActions.hiddenIds.has(f.id)) : [];

export const visibleGroups = (c: ContactsState, e: EngineState): ContactGroup[] =>
  e.conversationActions.hiddenKnown ? c.groups.filter((g) => !e.conversationActions.hiddenIds.has(g.id)) : [];

// MARK: - Actions

/** Re-reads friend requests from the server (as opening the official invitation page does). */
export const refreshContacts = () => fireAdapter('__zaloContacts', 'refresh');

export const acceptFriendRequest = (id: string) => fireAdapter('__zaloContacts', 'accept', id);
export const declineFriendRequest = (id: string) => fireAdapter('__zaloContacts', 'decline', id);
export const cancelFriendRequest = (id: string) => fireAdapter('__zaloContacts', 'cancel', id);

// MARK: - Suggestions, strangers

/** ✕ on a suggestion: the official `removeSuggestFriend` (the server stops suggesting this person). Hidden right away here. */
export const dismissSuggestion = (id: string) => {
  set((s) => ({ suggestions: s.suggestions.filter((x) => x.id !== id) }));
  fireAdapter('__zaloContacts', 'dismissSuggestion', id);
};

/** Friendship state of a stranger whose chat is open (StrangerRequestBar), with the official greeting for a request. */
export interface StrangerInfo {
  isFriend: boolean;
  requested: boolean;
  requesting: boolean;
  defaultMessage: string;
  maxMessage: number;
}

export const strangerInfo = async (id: string): Promise<StrangerInfo | null> => {
  const root = obj(await tryAdapter<unknown>(null, '__zaloContacts', 'requestInfo', id));
  if (!root) return null;
  return {
    isFriend: bool(root.isFriend),
    requested: bool(root.requested),
    requesting: bool(root.requesting),
    defaultMessage: str(root.defaultMessage),
    maxMessage: int(root.maxMessage) || 150,
  };
};

/** "Chặn": blocks messages and calls from this person (official `blockFriend(uid, SET_BLOCK)`). */
export const blockContact = async (id: string): Promise<{ ok: boolean; text: string }> => {
  const answer = await raceTimeout(30, callAdapter<unknown>('__zaloContacts', 'block', id).catch(() => null));
  const root = obj(answer?.value);
  return root ? { ok: bool(root.ok), text: str(root.text) } : { ok: false, text: 'Đã có lỗi xảy ra. Vui lòng thử lại' };
};

// Group invitations: the official box loads them only while its page is open.
let inviteWatchers = 0;
export const watchGroupInvites = (on: boolean) => {
  inviteWatchers = Math.max(0, inviteWatchers + (on ? 1 : -1));
  fireAdapter('__zaloContacts', 'watchGroupInvites', inviteWatchers > 0);
};
export const loadMoreGroupInvites = () => fireAdapter('__zaloContacts', 'loadMoreGroupInvites');

export interface GroupInviteResult {
  ok: boolean;
  /** "Join request sent to the admins" (the invitation now waits for approval). */
  pending: boolean;
  text: string;
}

const inviteAnswer = (v: unknown, fallback: string): GroupInviteResult => {
  const root = obj(v);
  return root ? { ok: bool(root.ok), pending: bool(root.pending), text: str(root.text) } : { ok: false, pending: false, text: fallback };
};

/** "Tham gia": joins through the official invitation box; on success the group opens (as in Zalo PC). */
export const acceptGroupInvite = async (id: string): Promise<GroupInviteResult> => {
  const answer = await raceTimeout(45, callAdapter<unknown>('__zaloContacts', 'acceptGroupInvite', id).catch(() => null));
  const result = inviteAnswer(answer?.value, 'Đã có lỗi xảy ra. Vui lòng thử lại');
  if (result.ok) setEngine({ navigationRequest: id });
  return result;
};

/** "Từ chối", optionally blocking further invitations to this group and / or the inviter. */
export const declineGroupInvite = async (id: string, blockGroup: boolean, blockInviter: boolean): Promise<GroupInviteResult> => {
  const answer = await raceTimeout(45, callAdapter<unknown>('__zaloContacts', 'declineGroupInvite', id, blockGroup, blockInviter).catch(() => null));
  return inviteAnswer(answer?.value, 'Đã có lỗi xảy ra. Vui lòng thử lại');
};

/** "Hết hạn sau 3 ngày" (official countdown units: days, hours, minutes). */
export const inviteExpiryText = (expiresAt: number | null, now = Date.now()): string | null => {
  if (!expiresAt) return null;
  const ms = expiresAt - now;
  if (ms <= 0) return null;
  const days = ms / 86_400_000;
  const hours = ms / 3_600_000;
  if (days >= 1) return `Hết hạn sau ${Math.round(days)} ngày`;
  if (hours >= 1) return `Hết hạn sau ${Math.round(hours)} giờ`;
  return `Hết hạn sau ${Math.max(1, Math.round(ms / 60_000))} phút`;
};

/**
 * Looks a user up by phone number through the official find-user API. `iso`: the country picked next to the field (the adapter
 * normalises the number like the official add-friend form; a number starting with + keeps its own country).
 */
export const findFriend = (phone: string, iso = 'VN') => {
  const trimmed = phone.trim();
  if (!trimmed) return;
  set({ search: { status: 'searching', error: null, user: null } });
  fireAdapter('__zaloContacts', 'search', trimmed, iso);
};

export const resetFriendSearch = () => {
  const s = useContacts.getState().search;
  if (s.status !== 'idle' || s.error || s.user) set({ search: idleSearch });
  fireAdapter('__zaloContacts', 'resetSearch');
};

export interface SendRequestResult {
  ok: boolean;
  text: string;
  /** No answer yet: the request may still go out, so nothing may invite a second send. */
  pending: boolean;
}

/**
 * Sends the friend request the user confirmed (official `requestAddFriend`) and waits for its result. Never reports success
 * without the adapter's answer; it answers within ~60 s (`pending` after that).
 */
export const sendFriendRequest = async (id: string, message: string): Promise<SendRequestResult> => {
  const pendingText = 'Chưa nhận được phản hồi. Hãy kiểm tra mục “Đã gửi” trong Lời mời kết bạn trước khi thử lại.';
  try {
    const answer = await raceTimeout(65, callAdapter<unknown>('__zaloContacts', 'sendRequest', id, message));
    if (!answer) return { ok: false, text: pendingText, pending: true };
    const root = obj(answer.value);
    if (!root) return { ok: false, text: 'Không thể gửi lời mời kết bạn.', pending: false };
    return { ok: bool(root.ok), text: str(root.text), pending: bool(root.pending) };
  } catch {
    return { ok: false, text: 'Ứng dụng chưa sẵn sàng, hãy thử lại sau giây lát.', pending: false };
  }
};

/**
 * Opens the 1-1 or group conversation with `id` (the shell observes `navigationRequest`). `person`: who it is when they may be
 * neither a friend nor in the conversation list yet (found by phone), so the chat can show their name.
 */
export const openContactConversation = (id: string, person?: { name: string; avatar: string | null }) => {
  if (person && !useContacts.getState().known[id]) set((s) => ({ known: { ...s.known, [id]: person } }));
  setEngine({ navigationRequest: id });
};

// MARK: - Profile (card-actions adapter, local data only)

/** Profile summary of a contact (official profile popup, reduced to what the client holds locally). */
export interface ContactProfile {
  uid: string;
  name: string;
  zaloName: string;
  avatar: string | null;
  bio: string;
  isSelf: boolean;
  isFriend: boolean;
  /** Official `isOAType(profile)`: an Official Account. */
  isOfficialAccount: boolean;
}

export const contactProfile = async (uid: string): Promise<ContactProfile | null> => {
  const root = obj(await tryAdapter<unknown>(null, '__zaloChat', 'contactProfile', uid));
  const id = root ? str(root.uid) : '';
  if (!root || !id) return null;
  return {
    uid: id,
    name: str(root.name),
    zaloName: str(root.zaloName),
    avatar: url(root.avatar),
    bio: str(root.bio),
    isSelf: bool(root.isSelf),
    isFriend: bool(root.isFriend),
    isOfficialAccount: bool(root.isOA),
  };
};

// MARK: - Formatting

const relative = new Intl.RelativeTimeFormat('vi', { numeric: 'always' });

/** "5 phút trước" style text. */
export const ago = (ms: number, now = Date.now()): string => {
  const seconds = (ms - now) / 1000;
  if (Math.abs(seconds) < 60) return 'vừa xong';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'vừa xong';
};

/**
 * A contact or group without a conversation yet (opened from Danh bạ): a placeholder summary built from the contact data —
 * the official chatbox creates the conversation (Swift `ConversationDetail.summary`).
 */
export const contactConversationSummary = (c: ContactsState, id: string): ConversationSummary | null => {
  const friend = c.friends.find((f) => f.id === id);
  if (friend) return { id, isGroup: false, name: friend.name, avatar: friend.avatar, pinned: false, members: 0, unread: 0, preview: null };
  const group = c.groups.find((g) => g.id === id);
  if (group) return { id, isGroup: true, name: group.name, avatar: group.avatar, pinned: false, members: group.members, unread: 0, preview: null };
  const person = c.known[id];
  if (person) return { id, isGroup: false, name: person.name, avatar: person.avatar, pinned: false, members: 0, unread: 0, preview: null };
  return null;
};
