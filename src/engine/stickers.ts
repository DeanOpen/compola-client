// Stickers: the composer's picker and the suggestions while typing (port of ZaloEngine+Stickers.swift), bridged to
// host-scripts/sticker-adapter.js (`window.__zaloSticker`; the official entry points are listed in that file's header).
// Sending runs only from a click on a sticker. Typed text goes to the JS side only while "Gợi ý Sticker" is on, and the
// adapter never asks the server for an end-to-end encrypted chat. No ids, names or content are logged.

import { create } from 'zustand';
import { callAdapter, log, raceTimeout } from './call';
import { arr, int, obj, str, webLink } from './models/json';
import { noAnswerText, parseCardActionOutcome, type CardActionOutcome } from './models/outcomes';

/** Where a sticker animates from when it has an animated source (adapter `animOf`). */
export type StickerAnimation = { kind: 'sprite'; url: string; frames: number; frameMs: number } | { kind: 'animated'; url: string };

/** A sticker as the picker and the suggestion strip draw it; `url` is the still picture (the chat bubble's endpoint). */
export interface StickerEntry {
  key: string;
  cateId: number;
  stickerId: number;
  url: string;
  animation: StickerAnimation | null;
}

/** One tab of the picker: a downloaded set, or the recent stickers (`recentTabId`, first when present). */
export interface StickerTab {
  id: number;
  name: string;
  icon: string | null;
  count: number;
}

export const recentTabId = -2;
export type StickerSource = 'category' | 'recent' | 'search' | 'suggestion';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const parseAnimation = (v: unknown): StickerAnimation | null => {
  const row = obj(v);
  const u = row && webLink(row.url);
  if (!row || !u) return null;
  switch (row.kind) {
    case 'sprite': {
      const frames = int(row.frames);
      if (frames < 2 || frames > 200) return null;
      return { kind: 'sprite', url: u, frames, frameMs: clamp(int(row.ms), 30, 1000) };
    }
    case 'gif':
    case 'webp':
      return { kind: 'animated', url: u };
    default:
      return null;
  }
};

/** Rows that are not a sticker (no ids, no web link) are dropped; each sticker once, at most `limit`. */
export const parseStickers = (v: unknown, limit = 500): StickerEntry[] => {
  const seen = new Set<string>();
  const out: StickerEntry[] = [];
  for (const raw of arr(v)) {
    const row = obj(raw);
    if (!row || typeof row.cateId !== 'number' || typeof row.id !== 'number') continue;
    const cateId = Math.trunc(row.cateId);
    const stickerId = Math.trunc(row.id);
    const u = webLink(row.url);
    if (cateId < 0 || stickerId <= 0 || !u) continue;
    const key = `${cateId}_${stickerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, cateId, stickerId, url: u, animation: parseAnimation(row.anim) });
    if (out.length >= limit) break;
  }
  return out;
};

/** nil (null) = the list could not be read, not "no sets". */
export const parseStickerTabs = (v: unknown): StickerTab[] | null => {
  if (!Array.isArray(v)) return null;
  const seen = new Set<number>();
  const out: StickerTab[] = [];
  for (const raw of v) {
    const row = obj(raw);
    if (!row || typeof row.id !== 'number') continue;
    const id = Math.trunc(row.id);
    if (id < recentTabId || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: str(row.name).slice(0, 200), icon: webLink(row.icon), count: clamp(int(row.count), 0, 10_000) });
    if (out.length >= 200) break;
  }
  return out;
};

const call = async (seconds: number, method: string, ...args: unknown[]) =>
  (await raceTimeout(seconds, callAdapter('__zaloSticker', method, ...args).catch(() => null)))?.value ?? null;

/** The user's downloaded sets in the official order, "Gần đây" first when there are recent stickers. null = unavailable. */
export const stickerTabs = async () => parseStickerTabs(await call(60, 'categories'));

/** The stickers of one tab. null = unavailable. */
export const stickersInTab = async (id: number): Promise<StickerEntry[] | null> => {
  const root = obj(await call(60, 'category', id));
  if (!root || root.id !== id) return null;
  return parseStickers(root.stickers);
};

/** Official dock search (`searchSticker(keyword, 40)`). null = could not be asked; [] = nothing matches. */
export const searchStickers = async (text: string): Promise<StickerEntry[] | null> => {
  const rows = await call(40, 'search', text);
  return Array.isArray(rows) ? parseStickers(rows, 40) : null;
};

/** What the official suggestion logic offers for the typed text; [] when off, encrypted or nothing matches. */
export const typingStickerSuggestions = async (conversationId: string, text: string) =>
  parseStickers(await call(25, 'suggest', conversationId, text), 30);

/** Sends one sticker through the official chat-box path (the user clicked it). */
export const sendSticker = async (
  sticker: StickerEntry,
  conversationId: string,
  source: StickerSource,
  typed: string | null = null,
  index = -1,
): Promise<CardActionOutcome> => {
  const target = { cateId: sticker.cateId, id: sticker.stickerId };
  const context = source === 'suggestion' ? { text: typed ?? '', index } : {};
  // The JS side answers within ~40 s and keeps the slot taken until the send settles.
  const answer = await raceTimeout(90, callAdapter('__zaloSticker', 'send', conversationId, target, source, context).catch(() => null));
  if (!answer) return { kind: 'pending', text: noAnswerText };
  const outcome = parseCardActionOutcome(answer.value);
  if (outcome.kind !== 'done') log(`sticker send ${source} → ${outcome.kind}`);
  return outcome;
};

// MARK: "Gợi ý Sticker" setting, shared by the composer and Settings (Swift `StickerSuggestState`)

export interface StickerSuggestSetting {
  enabled: boolean;
  /** Official `sticker_post_typing.debounce`, ms. */
  debounce: number;
}

const parseSetting = (v: unknown): StickerSuggestSetting | null => {
  const root = obj(v);
  if (!root || root.ok !== true || typeof root.enabled !== 'boolean') return null;
  return { enabled: root.enabled, debounce: clamp(int(root.debounce), 0, 2000) };
};

export const useStickerSuggest = create<{ setting: StickerSuggestSetting | null }>()(() => ({ setting: null }));

/** Never faster than this between keystrokes, whatever the server config says. */
const minimumDelay = 120;
/** A failed read is not repeated sooner than this. */
const retryInterval = 5000;
let lastAttempt = 0;
let loading = false;

export const stickerSuggestSetting = async () => parseSetting(await call(15, 'suggestSetting'));

export const loadStickerSuggestIfNeeded = async () => {
  if (useStickerSuggest.getState().setting || loading || Date.now() - lastAttempt < retryInterval) return;
  loading = true;
  lastAttempt = Date.now();
  const fresh = await stickerSuggestSetting();
  if (fresh) useStickerSuggest.setState({ setting: fresh });
  loading = false;
};

/** Milliseconds to wait after the last keystroke before asking. */
export const stickerSuggestDelay = () => Math.max(minimumDelay, useStickerSuggest.getState().setting?.debounce ?? 0);

/** Turns "Gợi ý Sticker" on or off and returns the value now in force; null = could not be changed. */
export const setStickerSuggest = async (enabled: boolean): Promise<StickerSuggestSetting | null> => {
  const r = obj(await call(15, 'setSuggestSetting', enabled));
  if (r?.ok !== true) return null;
  const now = await stickerSuggestSetting();
  useStickerSuggest.setState({ setting: now });
  return now;
};

/** Logout: forget the setting of the previous session. */
export const resetStickers = () => {
  useStickerSuggest.setState({ setting: null });
  lastAttempt = 0;
  void call(5, 'reset');
};
