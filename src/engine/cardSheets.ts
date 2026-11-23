// Native sheets of card-button effects (Swift `CardActionCenter` sheets + the card parts of ZaloEngine+CardActions.swift):
// alias, group invite, sticker category, poll, side-bar tab. Opening a sheet only reads; every write (alias, join,
// sticker) runs from the sheet's own button through card-actions-adapter.js (`window.__zaloChat`).

import { create } from 'zustand';
import { callAdapter, fireAdapter, raceTimeout } from './call';
import {
  isGroupInviteLink,
  parseCardSheet,
  parseGroupInvitePreview,
  parseGroupJoinResult,
  parseStickerCategory,
  type CardSheet,
  type GroupInvitePreview,
  type GroupJoinResult,
  type SidebarTarget,
  type StickerCategory,
} from './models/cardSheets';
import { obj, optStr, str, type Json } from './models/json';
import { defaultUnsupported, noAnswerText, parseCardActionOutcome, type CardActionOutcome } from './models/outcomes';
import { getEngine, onAccountReset, setEngine, useEngine } from './store';
import { openExternal } from './system';
import { showToast } from './toast';

export interface PresentedCardSheet {
  /** Bumped per presentation (re-keys the sheet view). */
  seq: number;
  conversationId: string;
  sheet: Exclude<CardSheet, { type: 'tab' }>;
}

interface CardSheetState {
  sheet: PresentedCardSheet | null;
  /** A side-bar action asked the shell to show a section (applied by the card hosts view). */
  tabRequest: { seq: number; target: SidebarTarget } | null;
}

export const useCardSheets = create<CardSheetState>()(() => ({ sheet: null, tabRequest: null }));

let seq = 0;

/** A `present` effect of a card button (`cardActions.ts`). Dropped when the user moved to another conversation. */
export const presentCardEffect = (effect: Json, conversationId: string) => {
  const sheet = parseCardSheet(effect);
  if (!sheet) {
    showToast(defaultUnsupported, conversationId);
    return;
  }
  if (getEngine().openConversationId !== conversationId) return;
  presentCardSheet(sheet, conversationId);
};

export const presentCardSheet = (sheet: CardSheet, conversationId: string) => {
  seq += 1;
  if (sheet.type === 'tab') {
    useCardSheets.setState({ tabRequest: { seq, target: sheet.target } });
    return;
  }
  useCardSheets.setState({ sheet: { seq, conversationId, sheet } });
};

export const dismissCardSheet = (which?: number) => {
  const current = useCardSheets.getState().sheet;
  if (!current || (which !== undefined && current.seq !== which)) return;
  useCardSheets.setState({ sheet: null });
};

/** The sheet with `seq` is still the one on screen, in the conversation it was opened from. */
export const isCardSheetPresented = (which: number) => {
  const current = useCardSheets.getState().sheet;
  return !!current && current.seq === which && getEngine().openConversationId === current.conversationId;
};

/**
 * Opens a link from a card: a group invite link shows the group sheet (official GROUP_PREVIEW), anything else goes to
 * the browser (http/https only).
 */
export const openCardLink = (link: string | null | undefined, conversationId: string) => {
  if (link && isGroupInviteLink(link)) presentCardSheet({ type: 'groupInvite', url: link }, conversationId);
  else void openExternal(link);
};

// Nothing opened from one conversation may show up in another.
useEngine.subscribe((s, prev) => {
  if (s.openConversationId !== prev.openConversationId && useCardSheets.getState().sheet) useCardSheets.setState({ sheet: null });
});

onAccountReset(() => {
  useCardSheets.setState({ sheet: null, tabRequest: null });
  // Logout: forget group previews and in-flight slots of the previous session (best effort).
  fireAdapter('__zaloChat', 'cardReset');
});

// MARK: - Adapter calls (`window.__zaloChat`)

const callCard = async (seconds: number, method: string, ...args: unknown[]): Promise<{ value: unknown } | null> =>
  raceTimeout(seconds, callAdapter('__zaloChat', method, ...args).catch(() => null));

export interface ContactProfileLite {
  uid: string;
  name: string;
  avatar: string | null;
}

export const contactProfile = async (uid: string): Promise<ContactProfileLite | null> => {
  const answer = await callCard(30, 'contactProfile', uid);
  const root = obj(answer?.value);
  if (!root || !str(root.uid)) return null;
  return { uid: str(root.uid), name: str(root.name), avatar: optStr(root.avatar) };
};

/** Sets (or, with an empty name, removes) the alias of a person after the user confirmed (official `setAliasName`). */
export const saveAlias = async (uid: string, name: string): Promise<{ ok: boolean; text: string }> => {
  const answer = await callCard(90, 'aliasSave', uid, name);
  const root = obj(answer?.value);
  if (!root || typeof root.ok !== 'boolean') return { ok: false, text: 'Chưa nhận được phản hồi. Hãy kiểm tra lại tên gợi nhớ trước khi thử lại.' };
  return { ok: root.ok, text: str(root.text).slice(0, 300) };
};

/** The group an invite link points at (official `getGroupInfoByLink`; a read, nothing is joined). */
export const groupInvitePreview = async (link: string): Promise<GroupInvitePreview> =>
  parseGroupInvitePreview((await callCard(60, 'groupPreview', link))?.value);

/** "Tham gia": joins through the official group manager. Only called from the button. */
export const joinGroup = async (link: string): Promise<GroupJoinResult> => {
  const answer = await callCard(90, 'groupJoin', link);
  if (!answer) return { state: 'error', groupId: '', text: 'Chưa nhận được phản hồi. Hãy kiểm tra danh sách nhóm trước khi thử lại.' };
  return parseGroupJoinResult(answer.value);
};

/** Category info and sticker list from the official sticker manager; null when unavailable. */
export const stickerCategory = async (id: number): Promise<StickerCategory | null> =>
  parseStickerCategory((await callCard(60, 'stickerCategory', id))?.value);

/** Sends one sticker of the category (the user clicked it); same safe send path as the e-card stickers. */
export const sendCategorySticker = async (conversationId: string, category: number, sticker: number): Promise<CardActionOutcome> => {
  const answer = await callCard(90, 'stickerCategorySend', conversationId, category, sticker);
  if (!answer) return { kind: 'pending', text: noAnswerText };
  return parseCardActionOutcome(answer.value);
};

/** Opens the conversation `id` (the shell observes `navigationRequest`). */
export const openConversationFromCard = (id: string) => setEngine({ navigationRequest: id });
