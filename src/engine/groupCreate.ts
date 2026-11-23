// "Tạo nhóm": the official group compose (modal CREATE_GROUP_COMPOSE) as a native sheet (Swift ZaloEngine+GroupCreate.swift,
// features/contacts/CreateGroupSheet.tsx). The picker list, the selection rules and the group photo are built here from what the
// engine already has, the way the official picker builds them; creating goes through `host-scripts/group-create-adapter.js`
// (`window.__zaloGroupCreate`), which runs the official quota check, `createGroupV2`, the open of the new conversation, its summary
// messages and the avatar upload (see the adapter header).

import { callAdapter, log, raceTimeout } from './call';
import { contactFold, compareSections, standardCompare, useContacts, type Friend } from './contacts';
import { arr, bool, int, obj, optStr, str } from './models/json';
import type { ConversationSummary } from './models/conversations';
import { getEngine, setEngine } from './store';
import { showToast } from './toast';

// MARK: - Limits

/** Limits of the official compose (`info()`): `settings.group.max_member`, `group_config`, and the blocked friends. */
export interface GroupCreateLimits {
  maxMembers: number;
  maxNameLength: number;
  /** `group_config.group_name_regex` (JavaScript source): a name it matches is refused (STR_GROUP_NAME_INVALID). */
  namePattern: string;
  blocked: ReadonlySet<string>;
  /** Friends that are official accounts (`isOAType`): never among the recent chats. */
  officialAccounts: ReadonlySet<string>;
}

export const defaultLimits: GroupCreateLimits = {
  maxMembers: 100,
  maxNameLength: 50,
  namePattern: '`|~|!|@|#|%|\\*|\\^|\\$',
  blocked: new Set(),
  officialAccounts: new Set(),
};

const parseLimits = (v: unknown): GroupCreateLimits | null => {
  const root = obj(v);
  if (!root || root.status !== 'ok') return null;
  const max = int(root.maxMembers);
  const length = int(root.maxNameLength);
  return {
    maxMembers: max > 0 ? max : defaultLimits.maxMembers,
    maxNameLength: length > 0 ? length : defaultLimits.maxNameLength,
    namePattern: optStr(root.nameRegex) ?? defaultLimits.namePattern,
    blocked: new Set(arr(root.blocked).filter((x): x is string => typeof x === 'string')),
    officialAccounts: new Set(arr(root.officialAccounts).filter((x): x is string => typeof x === 'string')),
  };
};

/** The compose's `onChangeGroupName` check. A pattern the browser cannot read lets the name through: the renderer checks again. */
export const isValidGroupName = (limits: GroupCreateLimits, name: string): boolean => {
  if (!name) return true;
  try {
    return !new RegExp(limits.namePattern).test(name);
  } catch {
    return true;
  }
};

/** The name field's `maxLength` (UTF-16 units, like the HTML input), never cutting a character in half. */
export const clampGroupName = (limits: GroupCreateLimits, name: string): string => {
  if (name.length <= limits.maxNameLength) return name;
  let result = '';
  for (const ch of name) {
    if (result.length + ch.length > limits.maxNameLength) break;
    result += ch;
  }
  return result;
};

/** STR_MAX_MEM_TOAST. */
export const overLimitText = (limits: GroupCreateLimits) => `Bạn chỉ có thể tạo nhóm với ${limits.maxMembers} người khác`;
export const blockedText = 'Bỏ chặn để thêm người này'; // STR_UNBLOCK_TO_ADD_TO_GROUP
export const invalidNameText = 'Tên nhóm chứa ký tự không hợp lệ. Vui lòng thử lại.'; // STR_GROUP_NAME_INVALID

// MARK: - Roster

export interface RosterPerson {
  id: string;
  name: string;
  avatar: string | null;
  section: string;
  sortKey: string;
  /** Folded Zalo name (search matches it too, like the friends list). */
  zaloKey: string;
}

export interface GroupComposeRoster {
  recent: RosterPerson[];
  friends: RosterPerson[];
}

const recentLimit = 5;

export const rosterPerson = (f: Friend): RosterPerson => ({
  id: f.id,
  name: f.name || 'Người dùng Zalo',
  avatar: f.avatar,
  section: f.section,
  sortKey: f.sortKey,
  zaloKey: contactFold(f.zaloName),
});

/**
 * The people the compose lists (official member picker `W`): "Trò chuyện gần đây" = the 5 latest 1:1 conversations with friends
 * that are not official accounts, then every friend by name. Hidden chats and My Cloud never show up.
 */
export const makeRoster = (
  source: Friend[],
  conversations: ConversationSummary[],
  selfId: string | null,
  officialAccounts: ReadonlySet<string>,
): GroupComposeRoster => {
  const people = source.map(rosterPerson);
  const byId = new Map<string, RosterPerson>();
  for (const p of people) if (!byId.has(p.id)) byId.set(p.id, p);
  const friends = [...people].sort((a, b) => compareSections(a.section, b.section) || standardCompare(a.sortKey, b.sortKey));
  const recent = conversations
    .filter((c) => !c.isGroup && c.id !== selfId && byId.has(c.id) && !officialAccounts.has(c.id))
    .sort((a, b) => (b.preview?.date ?? 0) - (a.preview?.date ?? 0))
    .slice(0, recentLimit)
    .map((c) => byId.get(c.id)!);
  return { recent, friends };
};

/** Friends whose name contains `query` (case, diacritics and đ folded). */
export const rosterMatching = (roster: GroupComposeRoster, query: string): RosterPerson[] => {
  const needle = contactFold(query).trim();
  if (!needle) return roster.friends;
  return roster.friends.filter((p) => p.sortKey.includes(needle) || p.zaloKey.includes(needle));
};

/** Alphabetical sections of the roster's friends (the picker's letter titles). */
export const rosterSections = (roster: GroupComposeRoster): { title: string; people: RosterPerson[] }[] => {
  const result: { title: string; people: RosterPerson[] }[] = [];
  for (const p of roster.friends) {
    const last = result[result.length - 1];
    if (last && last.title === p.section) last.people.push(p);
    else result.push({ title: p.section, people: [p] });
  }
  return result;
};

// MARK: - Selection

export type SelectionChange = 'added' | 'removed' | 'overLimit' | 'blocked';

/** The picks of the compose (`onItemClick`): blocked friends and picks beyond the limit are refused; 2 picks enable "Tạo nhóm". */
export const toggleSelection = (ids: string[], id: string, limits: GroupCreateLimits): { ids: string[]; change: SelectionChange } => {
  if (ids.includes(id)) return { ids: ids.filter((x) => x !== id), change: 'removed' };
  if (limits.blocked.has(id)) return { ids, change: 'blocked' };
  if (ids.length >= limits.maxMembers) return { ids, change: 'overLimit' };
  return { ids: [...ids, id], change: 'added' };
};

// MARK: - Group photo

/**
 * The group photo: centre square of the picked image, JPEG. Like the official avatar picker, the picked FILE must be 7 KB – 30 MB
 * (`update_avatar.min_size_kb` / `max_local_size`) and the image at least 240×240; the upload takes up to 1 MB for a group.
 */
export interface GroupAvatarImage {
  /** `data:image/jpeg;base64,…` (preview). */
  dataUrl: string;
  /** Base64 JPEG without the prefix (adapter input). */
  base64: string;
  side: number;
}

const minSide = 240;
const maxSide = 1024;
const minFileBytes = 7 * 1024;
const maxFileBytes = 30_000_000;
const maxBytes = 1024 * 1024;

export const avatarErrorText = {
  unreadable: 'Không đọc được ảnh này. Hãy chọn một ảnh khác.',
  tooSmall: 'Ảnh đại diện quá nhỏ. Kích thước tối thiểu là 240 x 240.', // update_avatar.min_dimension_error
  tooLight: 'Ảnh đại diện quá nhỏ. Dung lượng tối thiểu là 7 KB.', // update_avatar.min_size_error
  tooHeavy: 'Đã có lỗi xảy ra. Vui lòng sử dụng ảnh khác hoặc thử lại sau', // STR_TOAST_UPLOAD_FAILED
};

/** Reads `file` (EXIF orientation applied by the browser), crops the centre square and encodes it, or says why it cannot be used. */
export const makeGroupAvatar = async (file: File): Promise<{ ok: GroupAvatarImage } | { error: string }> => {
  if (file.size < minFileBytes) return { error: avatarErrorText.tooLight };
  if (file.size >= maxFileBytes) return { error: avatarErrorText.tooHeavy };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { error: avatarErrorText.unreadable };
  }
  const short = Math.min(bitmap.width, bitmap.height);
  if (short < minSide) {
    bitmap.close();
    return { error: avatarErrorText.tooSmall };
  }
  const side = Math.min(short, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { error: avatarErrorText.unreadable };
  // JPEG has no alpha: transparent parts become white, as on a light avatar background.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, side, side);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - short) / 2, (bitmap.height - short) / 2, short, short, 0, 0, side, side);
  bitmap.close();
  for (let quality = 0.9; quality > 0.45 - 1e-9; quality -= 0.15) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if ((base64.length * 3) / 4 <= maxBytes) return { ok: { dataUrl, base64, side } };
  }
  return { error: avatarErrorText.unreadable };
};

// MARK: - Create

/** Answer of group-create-adapter.js `create()`. */
export type GroupCreateOutcome =
  /** `failed`: picked members the server did not add (its `errorInfo`). */
  | { kind: 'created'; id: string; failed: string[] }
  /** The same group already existed (STR_GROUP_EXISTS); it is opened. */
  | { kind: 'exists'; id: string; text: string }
  /** Refused before anything was sent: the sheet stays to fix it. `dropped`: picks that can no longer be added, to be unpicked. */
  | { kind: 'invalid'; text: string; dropped: string[] }
  /** Refused by the quota check or the server. `title` set: shown as a confirm. `closes`: the compose closes after it. */
  | { kind: 'failed'; title: string | null; message: string; closes: boolean }
  /** No answer in time: the group may still be created, so nothing invites a retry. */
  | { kind: 'pending'; text: string };

const defaultFailure = 'Tạo nhóm không thành công.'; // STR_CREATE_GROUP_FAIL
const notReadyText = 'Ứng dụng chưa sẵn sàng, hãy thử lại sau giây lát.';
const noAnswerText = 'Chưa nhận được phản hồi. Hãy kiểm tra danh sách hội thoại trước khi thử lại.';

export const parseGroupCreateOutcome = (v: unknown): GroupCreateOutcome => {
  const root = obj(v);
  const status = root ? str(root.status) : '';
  if (!root || !status) return { kind: 'failed', title: null, message: defaultFailure, closes: false };
  const text = optStr(root.text);
  const id = str(root.convId);
  const ids = (x: unknown) => arr(x).filter((y): y is string => typeof y === 'string');
  if (status === 'created' && id) return { kind: 'created', id, failed: ids(root.failed) };
  if (status === 'exists' && id) return { kind: 'exists', id, text: text ?? 'Nhóm bạn vừa tạo đã tồn tại' };
  switch (status) {
    case 'invalid':
      return { kind: 'invalid', text: text ?? defaultFailure, dropped: ids(root.dropped) };
    case 'pending':
      return { kind: 'pending', text: text ?? noAnswerText };
    case 'not-ready':
      return { kind: 'failed', title: null, message: text ?? notReadyText, closes: false };
    case 'busy':
      return { kind: 'failed', title: null, message: text ?? defaultFailure, closes: false };
    default:
      return { kind: 'failed', title: optStr(root.title), message: text ?? defaultFailure, closes: bool(root.close) };
  }
};

const evaluate = async (method: string, ...args: unknown[]): Promise<unknown> => {
  try {
    return await callAdapter('__zaloGroupCreate', method, ...args);
  } catch (e) {
    log(`__zaloGroupCreate.${method} failed: ${String(e)}`);
    return { status: 'not-ready' };
  }
};

/** The compose's limits, null while the official services are not ready. */
export const groupCreateLimits = async (): Promise<GroupCreateLimits | null> => parseLimits(await evaluate('info'));

/** `groupCreateLimits()`, asked again until the official services answer (the blocked list must not stay unknown). */
export const groupCreateLimitsWhenReady = async (isCancelled: () => boolean, attempts = 20): Promise<GroupCreateLimits | null> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const limits = await groupCreateLimits();
    if (limits) return limits;
    if (isCancelled()) return null;
    if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 1000));
    if (isCancelled()) return null;
  }
  return null;
};

/** "Chưa thêm được A, B và 3 người khác vào nhóm." */
export const notAddedText = (names: string[]): string => {
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length - Math.min(names.length, 3);
  return 'Chưa thêm được ' + (rest > 0 ? `${shown} và ${rest} người khác` : shown) + ' vào nhóm.';
};

const contactName = (id: string) => useContacts.getState().friends.find((f) => f.id === id)?.name || 'Người dùng Zalo';

/** Waits (briefly) for the new conversation to reach the list, then shows it. */
const openCreatedGroup = async (id: string) => {
  for (let i = 0; i < 50; i += 1) {
    if (getEngine().conversations.some((c) => c.id === id) || useContacts.getState().groups.some((g) => g.id === id)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  setEngine({ navigationRequest: id });
};

/**
 * Creates the group in the official client. On success the new (or existing) group is opened in the shell once the conversation
 * list knows it; members the server did not add are named in a toast.
 */
export const createGroup = async (name: string, members: string[], avatar: GroupAvatarImage | null): Promise<GroupCreateOutcome> => {
  const input: Record<string, unknown> = { name, members, avatar: avatar ? { data: avatar.base64, width: avatar.side, height: avatar.side } : null };
  const answer = await raceTimeout(45, evaluate('create', input));
  const outcome: GroupCreateOutcome = answer ? parseGroupCreateOutcome(answer.value) : { kind: 'pending', text: noAnswerText };
  log(`group create → ${outcome.kind}`);
  switch (outcome.kind) {
    case 'created':
      await openCreatedGroup(outcome.id);
      if (outcome.failed.length) showToast(notAddedText(outcome.failed.map(contactName)));
      break;
    case 'exists':
      await openCreatedGroup(outcome.id);
      showToast(outcome.text);
      break;
    case 'pending':
      showToast(outcome.text);
      break;
  }
  return outcome;
};
