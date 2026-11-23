// Small pieces shared by the conversation list column, the sidebar and the quick switcher (Swift
// ConversationListSupport.swift): timestamps, unread counts per mailbox / label, tile names, name folding.

import { displayName, selfConversationTitle, type ConversationLabel, type ConversationSummary } from '../../engine/models/conversations';
import { visibleConversations, type EngineState } from '../../engine/store';

/** Unread numbers beside the sidebar rows and the label menu: chats (not messages) with something unread. */
export interface UnreadCounts {
  inbox: number;
  other: number;
  strangers: number;
  unreadIds: Set<string>;
}

export const unreadCounts = (s: EngineState): UnreadCounts => {
  const folder = new Set(s.extras.strangerFolderIds);
  const out: UnreadCounts = { inbox: 0, other: 0, strangers: 0, unreadIds: new Set() };
  for (const c of visibleConversations(s)) {
    if (c.unread <= 0) continue;
    out.unreadIds.add(c.id);
    if (folder.has(c.id)) out.strangers += 1;
    if (s.conversationActions.archivedIds.has(c.id)) out.other += 1;
    else if (!folder.has(c.id)) out.inbox += 1;
  }
  return out;
};

export const unreadInLabel = (counts: UnreadCounts, label: ConversationLabel) =>
  label.convIds.reduce((n, id) => n + (counts.unreadIds.has(id) ? 1 : 0), 0);

const pad = (n: number) => String(n).padStart(2, '0');
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const weekdays = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/** Compact row time: today "HH:mm", yesterday "Hôm qua", within the week "T2…CN", otherwise "dd/MM". */
export const listTime = (ms: number, now = Date.now()): string => {
  const date = new Date(ms);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (days === 1) return 'Hôm qua';
  if (days < 7) return weekdays[date.getDay()];
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
};

/** Name under a pinned tile: the given name (last word) of a person, the full name of a group. */
export const tileName = (c: ConversationSummary, isSelf: boolean): string => {
  if (isSelf) return 'Cloud';
  const name = displayName(c);
  if (c.isGroup) return name;
  const words = name.split(' ').filter(Boolean);
  return words[words.length - 1] ?? name;
};

/** List / chat / inspector title: the official record names My Documents in English. */
export const conversationTitle = (c: ConversationSummary, selfId: string | null) =>
  c.id === selfId ? selfConversationTitle : displayName(c);

/** Case- and diacritic-insensitive key (Swift `contactFold`): "Đỗ Anh Tuấn" → "do anh tuan". */
export const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
