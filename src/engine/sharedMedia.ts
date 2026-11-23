// Shared media of a conversation ("Kho lưu trữ"; Swift `ZaloEngine+SharedMedia.swift` + Shell/SharedMediaModel.swift),
// bridged to `host-scripts/media-store-adapter.js` (`window.__zaloMediaStore`). Everything ever shared comes from the
// official media service (its local DB), not from the messages loaded in the chat box; those are merged in so what was
// just sent shows up before the store knows it.
//   page(convId, kind, cursor, limit) → {items:[ChatMessageJSON], cursor: string|null, more: bool} | null
//   Items are ordinary chat messages (photo / video / file / link kinds, same ids as the loaded copy), newest first.
//   null = service unavailable / failed (not "nothing shared").

import { create } from 'zustand';
import { callAdapter, log } from './call';
import { arr, bool, obj, optStr } from './models/json';
import { parseChatMessage, type ChatMessage, type MessageKind } from './models/chat';
import { onAccountReset } from './store';

export type SharedMediaKind = 'images' | 'files' | 'links';
export const sharedMediaKinds: SharedMediaKind[] = ['images', 'files', 'links'];
/** The "Kho lưu trữ" filter: one list, or everything ("Tất cả"). */
export type SharedMediaFilter = SharedMediaKind | 'all';
export const sharedMediaFilters: SharedMediaFilter[] = ['all', 'images', 'files', 'links'];
export const filterKinds = (f: SharedMediaFilter): SharedMediaKind[] => (f === 'all' ? sharedMediaKinds : [f]);

/** The list a message belongs to, null when it is not shared content. */
export const kindOf = (k: MessageKind): SharedMediaKind | null => sharedMediaKinds.find((kind) => accepts(kind, k)) ?? null;

/** Whether a message kind belongs in this list (the official panel's split by message type). */
export const accepts = (kind: SharedMediaKind, k: MessageKind): boolean => {
  switch (kind) {
    case 'images':
      return k.type === 'photo' || k.type === 'video';
    case 'files':
      return k.type === 'file';
    case 'links':
      return k.type === 'link' && !!k.url;
  }
};

export interface SharedMediaPage {
  items: ChatMessage[];
  cursor: string | null;
  more: boolean;
}

export const parseSharedMediaPage = (v: unknown, conversationId: string): SharedMediaPage | null => {
  const root = obj(v);
  if (!root || !Array.isArray(root.items)) return null;
  return {
    items: arr(root.items)
      .map((m) => parseChatMessage(m, conversationId))
      .filter((m): m is ChatMessage => !!m),
    cursor: optStr(root.cursor),
    more: bool(root.more),
  };
};

export const pageSize = 30;

/** A page of what was ever shared in `conversationId`, older than `cursor` (null = newest). null when it could not be read. */
export const fetchSharedMedia = async (conversationId: string, kind: SharedMediaKind, cursor: string | null, limit = pageSize) => {
  try {
    return parseSharedMediaPage(await callAdapter('__zaloMediaStore', 'page', conversationId, kind, cursor, limit), conversationId);
  } catch (e) {
    log(`mediaStore.page failed: ${String(e)}`);
    return null;
  }
};

// MARK: - Pure list logic (SharedMediaList)

export const previewLimit = (kind: SharedMediaKind) => (kind === 'images' ? 9 : 4);

/** A loaded message is shared content of this list: not failed, not recalled. */
export const qualifies = (m: ChatMessage, kind: SharedMediaKind) => accepts(kind, m.kind) && m.status !== 'failed';

/** Newest first; equal times fall back to the id (shorter first, as the official DB orders msgIds). */
export const precedes = (a: ChatMessage, b: ChatMessage) => {
  if (a.date !== b.date) return a.date > b.date;
  return a.id.length !== b.id.length ? a.id.length > b.id.length : a.id > b.id;
};

const byPrecedence = (a: ChatMessage, b: ChatMessage) => (precedes(a, b) ? -1 : precedes(b, a) ? 1 : 0);

export const newestFirst = (items: ChatMessage[]) => [...items].sort(byPrecedence);

/**
 * The store items plus the qualifying loaded messages, one per id (the loaded copy wins; a loaded message that no longer
 * qualifies drops the stored one), newest first. Loaded messages older than `loadedSince` are not added.
 */
export const mergedList = (stored: ChatMessage[], loaded: ChatMessage[], kind: SharedMediaKind, loadedSince: number | null = null) => {
  const byId = new Map<string, ChatMessage>();
  for (const m of stored) if (accepts(kind, m.kind)) byId.set(m.id, m);
  for (const m of loaded) {
    if (qualifies(m, kind)) {
      if (loadedSince !== null && m.date < loadedSince) continue;
      byId.set(m.id, m);
    } else byId.delete(m.id);
  }
  return newestFirst([...byId.values()]);
};

/** The overview's items of one list. */
export const previewList = (kind: SharedMediaKind, stored: ChatMessage[], loaded: ChatMessage[]) => {
  const loadedIds = new Set(loaded.map((m) => m.id));
  const pool = [...loaded.filter((m) => qualifies(m, kind)), ...stored.filter((m) => accepts(kind, m.kind) && !loadedIds.has(m.id))];
  return newestFirst(pool).slice(0, previewLimit(kind));
};

export interface Day {
  /** `yyyy-m-d` (local time). */
  id: string;
  /** Epoch ms of the day's newest item. */
  date: number;
  items: ChatMessage[];
}

/** Groups newest-first items into consecutive calendar days. */
export const days = (items: ChatMessage[]): Day[] => {
  const out: Day[] = [];
  for (const m of items) {
    const d = new Date(m.date);
    const id = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const last = out[out.length - 1];
    if (last?.id === id) last.items.push(m);
    else out.push({ id, date: m.date, items: [m] });
  }
  return out;
};

export interface Month {
  id: string;
  title: string;
  items: ChatMessage[];
}

/** Groups newest-first items into consecutive calendar months ("Tháng 10, 2026"). */
export const months = (items: ChatMessage[]): Month[] => {
  const out: Month[] = [];
  for (const m of items) {
    const d = new Date(m.date);
    const id = `${d.getFullYear()}-${d.getMonth() + 1}`;
    const last = out[out.length - 1];
    if (last?.id === id) last.items.push(m);
    else out.push({ id, title: `Tháng ${d.getMonth() + 1}, ${d.getFullYear()}`, items: [m] });
  }
  return out;
};

// MARK: - Feeds (SharedMediaFeed)

export interface SharedMediaFeed {
  items: ChatMessage[];
  cursor: string | null;
  more: boolean;
  phase: 'idle' | 'loading' | 'failed';
  /** A page arrived at least once. */
  loaded: boolean;
}

export const emptyFeed: SharedMediaFeed = { items: [], cursor: null, more: true, phase: 'idle', loaded: false };

export const isPending = (f: SharedMediaFeed) => !f.loaded && f.phase !== 'failed';
export const didFail = (f: SharedMediaFeed) => !f.loaded && f.phase === 'failed';
/** Loaded chat messages older than this are left out of the full page (the store has not paged that far). */
export const loadedSince = (f: SharedMediaFeed): number | null => (f.loaded && f.more ? (f.items[f.items.length - 1]?.date ?? null) : null);

const union = (items: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] | null => {
  const seen = new Set(items.map((m) => m.id));
  const fresh = incoming.filter((m) => !seen.has(m.id) && (seen.add(m.id), true));
  return fresh.length ? newestFirst([...items, ...fresh]) : null;
};

/** The next (older) page. Stops asking when it brought no new id. */
export const appendPage = (f: SharedMediaFeed, page: SharedMediaPage): SharedMediaFeed => {
  const before = f.items.length;
  const items = union(f.items, page.items) ?? f.items;
  return { items, cursor: page.cursor, more: page.more && page.cursor !== null && items.length > before, phase: 'idle', loaded: true };
};

/**
 * The newest page again (after a new message): held items inside that window and missing from the page are gone, the
 * others join; how deep the list was read stays — unless nothing held connects to the page.
 */
export const mergeFirstPage = (f: SharedMediaFeed, page: SharedMediaPage): SharedMediaFeed => {
  if (!f.loaded) return appendPage(f, page);
  const pageIds = new Set(page.items.map((m) => m.id));
  const connected = f.items.some((m) => pageIds.has(m.id));
  let items = f.items;
  const boundary = newestFirst(page.items).pop();
  if (boundary) items = items.filter((m) => pageIds.has(m.id) || !precedes(m, boundary));
  else if (!page.more && page.cursor === null) items = [];
  if (items.length === 0 || !connected) return appendPage({ ...f, items }, page);
  return { ...f, items: union(items, page.items) ?? items, phase: 'idle' };
};

/**
 * "Tất cả": the three lists merged, newest first. Each list is paged on its own, so the merge stops at the deepest
 * point every list that has more has reached (older items of one list would otherwise show up without the others').
 */
export const mergedAll = (feeds: Record<SharedMediaKind, SharedMediaFeed>, loaded: ChatMessage[]): ChatMessage[] => {
  let horizon = -Infinity;
  for (const kind of sharedMediaKinds) {
    const f = feeds[kind];
    if (f.loaded && f.more && f.items.length) horizon = Math.max(horizon, f.items[f.items.length - 1].date);
  }
  const all = sharedMediaKinds.flatMap((kind) => mergedList(feeds[kind].items, loaded, kind, loadedSince(feeds[kind])));
  return newestFirst(all.filter((m) => m.date >= horizon));
};

/** Combined state of the lists behind a filter (for "Tất cả": loading while any loads, failed only when all failed). */
export const filterFeedState = (feeds: SharedMediaFeed[]) => ({
  pending: feeds.some(isPending) && !feeds.some((f) => f.loaded && f.items.length),
  loading: feeds.some((f) => f.phase === 'loading'),
  failed: feeds.every((f) => f.phase === 'failed'),
  someFailed: feeds.some((f) => f.phase === 'failed'),
  canLoadMore: feeds.some((f) => f.phase === 'idle' && f.loaded && f.more),
  hasMore: feeds.some((f) => f.loaded && f.more),
  everLoaded: feeds.some((f) => f.loaded),
});

// MARK: - Store: feeds per conversation, and the "Kho lưu trữ" page of the inspector

interface SharedMediaState {
  feeds: Record<string, Partial<Record<SharedMediaKind, SharedMediaFeed>>>;
  /** The inspector shows the full "Kho lưu trữ" page of this filter instead of its overview. */
  browsing: { conversationId: string; kind: SharedMediaFilter } | null;
}

export const useSharedMedia = create<SharedMediaState>()(() => ({ feeds: {}, browsing: null }));
const set = useSharedMedia.setState;
const get = useSharedMedia.getState;

export const feedOf = (s: SharedMediaState, conversationId: string, kind: SharedMediaKind): SharedMediaFeed =>
  s.feeds[conversationId]?.[kind] ?? emptyFeed;

const update = (conversationId: string, kind: SharedMediaKind, change: (f: SharedMediaFeed) => SharedMediaFeed) =>
  set((s) => ({ feeds: { ...s.feeds, [conversationId]: { ...s.feeds[conversationId], [kind]: change(feedOf(s, conversationId, kind)) } } }));

const refreshing = new Set<string>();

const reload = async (conversationId: string, kind: SharedMediaKind) => {
  const key = `${conversationId}|${kind}`;
  const current = feedOf(get(), conversationId, kind);
  if (current.phase === 'loading' || refreshing.has(key)) return;
  refreshing.add(key);
  try {
    // A list that was read before reloads quietly; a first read (or a retry) shows its state.
    const quiet = current.loaded;
    if (!quiet) update(conversationId, kind, (f) => ({ ...f, phase: 'loading' }));
    const page = await fetchSharedMedia(conversationId, kind, null);
    if (page) update(conversationId, kind, (f) => mergeFirstPage(f, page));
    else if (!quiet) update(conversationId, kind, (f) => ({ ...f, phase: 'failed' }));
  } finally {
    refreshing.delete(key);
  }
};

/** The newest page of every list: the first read, and the reload after a new message. */
export const refreshSharedMedia = (conversationId: string) => Promise.all(sharedMediaKinds.map((k) => reload(conversationId, k)));

export const loadSharedMediaIfNeeded = (conversationId: string, kind: SharedMediaKind) =>
  feedOf(get(), conversationId, kind).loaded ? Promise.resolve() : reload(conversationId, kind);

/** The next older page, when the end of the list came into view (`retrying`: after a failure). */
export const loadMoreSharedMedia = async (conversationId: string, kind: SharedMediaKind, retrying = false) => {
  const f = feedOf(get(), conversationId, kind);
  if (!f.loaded || !f.more || !f.cursor || !(f.phase === 'idle' || (retrying && f.phase === 'failed'))) return;
  update(conversationId, kind, (x) => ({ ...x, phase: 'loading' }));
  const page = await fetchSharedMedia(conversationId, kind, f.cursor);
  update(conversationId, kind, (x) => (page ? appendPage(x, page) : { ...x, phase: 'failed' }));
};

/** "Thử lại": the page that failed again, or the first read. */
export const retrySharedMedia = (conversationId: string, kind: SharedMediaKind) =>
  feedOf(get(), conversationId, kind).loaded ? loadMoreSharedMedia(conversationId, kind, true) : reload(conversationId, kind);

/** Opens "Kho lưu trữ" for a filter ("Tất cả" by default). */
export const browseSharedMedia = (conversationId: string, kind: SharedMediaFilter = 'all') => set({ browsing: { conversationId, kind } });

/** A filter's lists: first reads, next pages (each list that has more), retries. */
export const loadFilterIfNeeded = (conversationId: string, filter: SharedMediaFilter) =>
  Promise.all(filterKinds(filter).map((k) => loadSharedMediaIfNeeded(conversationId, k)));
export const loadMoreFilter = (conversationId: string, filter: SharedMediaFilter) =>
  Promise.all(filterKinds(filter).map((k) => loadMoreSharedMedia(conversationId, k)));
export const retryFilter = (conversationId: string, filter: SharedMediaFilter) =>
  Promise.all(filterKinds(filter).filter((k) => feedOf(get(), conversationId, k).phase === 'failed' || !feedOf(get(), conversationId, k).loaded).map((k) => retrySharedMedia(conversationId, k)));
export const closeSharedMediaBrowser = () => set({ browsing: null });

/** Shared photos / videos of a conversation, oldest first (the media viewer's gallery). */
export const galleryOf = (conversationId: string, loaded: ChatMessage[]): ChatMessage[] => {
  const feed = feedOf(get(), conversationId, 'images');
  return mergedList(feed.items, loaded, 'images', null).reverse();
};

onAccountReset(() => set({ feeds: {}, browsing: null }));
