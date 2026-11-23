// Port of `ZaloEngine.ConversationSummary` (ZaloEngine.swift) and `ConversationExtras` (ZaloEngine+Conversations.swift).

import { arr, bool, int, num, obj, optStr, str, strings, url, type Json } from './json';

export interface ConversationPreview {
  text: string;
  /** Epoch ms, null when unknown. */
  date: number | null;
  fromMe: boolean;
}

/** A conversation as the official client knows it (conv-info-manager + profiles). */
export interface ConversationSummary {
  id: string;
  isGroup: boolean;
  name: string;
  avatar: string | null;
  pinned: boolean;
  members: number;
  unread: number;
  preview: ConversationPreview | null;
}

export const displayName = (c: Pick<ConversationSummary, 'name' | 'isGroup'>): string =>
  c.name ? c.name : c.isGroup ? 'Nhóm' : 'Người dùng Zalo';

export const parseConversation = (v: unknown): ConversationSummary | null => {
  const row = obj(v);
  const id = row ? str(row.id) : '';
  if (!row || !id) return null;
  const p = obj(row.preview);
  let preview: ConversationPreview | null = null;
  if (p) {
    const ts = num(p.ts);
    preview = { text: str(p.text), date: ts > 0 ? (ts > 1e12 ? ts : ts * 1000) : null, fromMe: bool(p.fromMe) };
  }
  return {
    id,
    isGroup: bool(row.isGroup),
    name: str(row.name),
    avatar: url(row.avatar),
    pinned: bool(row.pinned),
    members: int(row.members),
    unread: int(row.unread),
    preview,
  };
};

const collator = new Intl.Collator('vi');

/** Pinned first, then most recent activity, then name. */
export const listOrder = (a: ConversationSummary, b: ConversationSummary): number => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const da = a.preview?.date ?? -Infinity;
  const db = b.preview?.date ?? -Infinity;
  if (da !== db) return da > db ? -1 : 1;
  return collator.compare(displayName(a), displayName(b));
};

export const sameConversation = (a: ConversationSummary, b: ConversationSummary): boolean =>
  a.id === b.id &&
  a.isGroup === b.isGroup &&
  a.name === b.name &&
  a.avatar === b.avatar &&
  a.pinned === b.pinned &&
  a.members === b.members &&
  a.unread === b.unread &&
  a.preview?.text === b.preview?.text &&
  a.preview?.date === b.preview?.date &&
  a.preview?.fromMe === b.preview?.fromMe;

// MARK: - Extras (labels, filters, stranger folder)

/** Official `FilterType` values the sidebar can request. */
export enum TypeFilter {
  all = 0,
  unread = 1,
  focused = 3,
  other = 4,
}

/** What Compola's own UI calls the default list, whatever the official tab is named. */
export const inboxTitle = 'Tin nhắn';
export const strangerBoxId = 'stranger_box';
export const selfConversationTitle = 'Cloud của tôi';

export const typeFilterTitle = (f: TypeFilter): string =>
  f === TypeFilter.unread ? 'Chưa đọc' : f === TypeFilter.other ? 'Khác' : inboxTitle;

export interface ConversationLabel {
  id: string;
  name: string;
  /** "#0068ff" as stored by the official client. */
  colorHex: string;
  convIds: string[];
}

export interface StrangerBox {
  chats: number;
  unreadChats: number;
  unreadMessages: number;
  newestId: string | null;
}

export interface ConversationExtras {
  loaded: boolean;
  labels: ConversationLabel[];
  limits: { maxLabels: number; maxNameLength: number; palette: string[] };
  archivedEnabled: boolean;
  typeFilter: TypeFilter;
  labelFilterIds: string[];
  /** Ids of the list the controller computed for the current filter (may contain `stranger_box`). */
  listIds: string[];
  strangerIds: Set<string>;
  strangerFolderIds: string[];
  strangerBox: StrangerBox;
  unboxStranger: boolean;
  notice: { seq: number; ok: boolean; text: string } | null;
  /** conversation id → label id */
  labelByConversation: Record<string, string>;
}

export const emptyExtras: ConversationExtras = {
  loaded: false,
  labels: [],
  limits: {
    maxLabels: 15,
    maxNameLength: 30,
    palette: ['#D91B1B', '#F31BC8', '#FF6905', '#FAC000', '#4BC377', '#2AC5BB', '#0068FF', '#6F3FCF'],
  },
  archivedEnabled: false,
  typeFilter: TypeFilter.all,
  labelFilterIds: [],
  listIds: [],
  strangerIds: new Set(),
  strangerFolderIds: [],
  strangerBox: { chats: 0, unreadChats: 0, unreadMessages: 0, newestId: null },
  unboxStranger: false,
  notice: null,
  labelByConversation: {},
};

export const extrasTabs = (e: ConversationExtras): TypeFilter[] =>
  e.archivedEnabled ? [TypeFilter.focused, TypeFilter.other, TypeFilter.unread] : [TypeFilter.all, TypeFilter.unread];

export const defaultTab = (e: ConversationExtras): TypeFilter => (e.archivedEnabled ? TypeFilter.focused : TypeFilter.all);

export const labelOf = (e: ConversationExtras, conversationId: string): ConversationLabel | null => {
  const id = e.labelByConversation[conversationId];
  return id ? (e.labels.find((l) => l.id === id) ?? null) : null;
};

/** Merges a `conversationExtras` snapshot into the current value (only the keys present change). */
export const mergeExtras = (current: ConversationExtras, json: Json): { next: ConversationExtras; selfId: string | null } => {
  const next: ConversationExtras = { ...current, loaded: true };
  const selfId = optStr(json.selfConversationId);
  if (Array.isArray(json.labels)) {
    next.labels = arr(json.labels)
      .map(obj)
      .filter((r): r is Json => !!r && typeof r.id === 'string')
      .map((row) => ({ id: str(row.id), name: str(row.name), colorHex: str(row.color), convIds: strings(row.convIds) }));
    const map: Record<string, string> = {};
    for (const label of next.labels) for (const conv of label.convIds) map[conv] = label.id;
    next.labelByConversation = map;
  }
  const limits = obj(json.limits);
  if (limits) {
    const l = { ...next.limits };
    if (int(limits.maxLabels) > 0) l.maxLabels = int(limits.maxLabels);
    if (int(limits.maxNameLength) > 0) l.maxNameLength = int(limits.maxNameLength);
    const palette = strings(limits.palette);
    if (palette.length) l.palette = palette;
    next.limits = l;
  }
  if (typeof json.archivedEnabled === 'boolean') next.archivedEnabled = json.archivedEnabled;
  const filter = obj(json.filter);
  if (filter) {
    if (typeof filter.type === 'number') next.typeFilter = filter.type as TypeFilter;
    next.labelFilterIds = strings(filter.labelIds);
  }
  if (Array.isArray(json.listIds)) next.listIds = strings(json.listIds);
  if (Array.isArray(json.strangerIds)) next.strangerIds = new Set(strings(json.strangerIds));
  if (Array.isArray(json.strangerFolderIds)) next.strangerFolderIds = strings(json.strangerFolderIds);
  const box = obj(json.strangerBox);
  if (box) {
    next.strangerBox = {
      chats: int(box.chats),
      unreadChats: int(box.unreadChats),
      unreadMessages: int(box.unreadMessages),
      newestId: optStr(box.newestId),
    };
  }
  if (typeof json.unboxStranger === 'boolean') next.unboxStranger = json.unboxStranger;
  const action = obj(json.action);
  if (action && typeof action.seq === 'number') {
    next.notice = { seq: int(action.seq), ok: bool(action.ok), text: str(action.text) };
  }
  return { next, selfId };
};

/** "#RRGGBB" / "RRGGBB" → CSS color, null when malformed. */
export const cssColor = (hex: string): string | null => {
  let t = hex.trim();
  if (t.startsWith('#')) t = t.slice(1);
  return /^[0-9a-fA-F]{6}$/.test(t) ? `#${t}` : null;
};
