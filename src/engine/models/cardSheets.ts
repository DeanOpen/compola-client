// Models of the card actions that open a native sheet (Swift CardSheetModels.swift): alias, group invite, sticker
// category, poll, side-bar tabs. card-actions-adapter.js answers with plain JSON; everything is validated here.

import { arr, bool, int, obj, str, webLink, type Json } from './json';

/** Official `groupLinkRegEx`: `^https?://(zaloapp.com|zalo.me)/g/`. */
export const isGroupInviteLink = (link: string | null | undefined): boolean => {
  const safe = webLink(link);
  if (!safe) return false;
  try {
    const u = new URL(safe);
    const host = u.hostname.toLowerCase();
    return (host === 'zalo.me' || host === 'zaloapp.com') && u.pathname.startsWith('/g/');
  } catch {
    return false;
  }
};

/** Where a side-bar action (`action.open.tab.chat`, `.tab.contact`, `.grouplist`) goes. */
export type SidebarTarget = 'chats' | 'contacts' | 'groups';

/** The pre-filled "Đặt tên gợi nhớ" dialog (official EDIT_ALIAS). */
export interface AliasDraft {
  uid: string;
  name: string;
  /** The card's `suggestName` (the dialog's initial text). */
  suggest: string;
  placeholder: string;
  /** Official input limit: `group_config.max_group_name_length` (UTF-16 units). */
  max: number;
  /** Whether an alias is set now (null = unknown). An empty confirm removes it. */
  hasAlias: boolean | null;
}

export const aliasFallbackMax = 50;

/** Control characters 0-7 are stripped, as the official `stripInvalidChar` does. */
// eslint-disable-next-line no-control-regex
export const sanitizeAlias = (text: string) => text.replace(/[\u0000-\u0007]/g, '');

/** At most `limit` UTF-16 units (JS `slice` semantics), never splitting a character. */
export const prefixUTF16 = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > limit) break;
    out += ch;
  }
  return out;
};

export type CardSheet =
  | { type: 'alias'; draft: AliasDraft }
  | { type: 'groupInvite'; url: string }
  | { type: 'stickers'; cateId: number }
  | { type: 'poll'; pollId: string }
  | { type: 'tab'; target: SidebarTarget };

export const cardSheetTypes = new Set(['alias', 'groupInvite', 'stickers', 'poll', 'tab']);

const digits = (v: unknown): string | null => {
  const text = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(Math.trunc(v)) : '';
  return text && text.length <= 24 && /^[0-9]+$/.test(text) ? text : null;
};

const clip = (v: unknown, limit: number) => str(v).slice(0, limit);

/** Parses an `effect` object; null when it is not a sheet effect or is malformed. */
export const parseCardSheet = (effect: Json): CardSheet | null => {
  switch (str(effect.type)) {
    case 'alias': {
      const uid = digits(effect.uid);
      if (!uid) return null;
      const limit = typeof effect.max === 'number' ? int(effect.max) : aliasFallbackMax;
      return {
        type: 'alias',
        draft: {
          uid,
          name: clip(effect.name, 200),
          suggest: sanitizeAlias(clip(effect.suggest, 400)),
          placeholder: clip(effect.placeholder, 200),
          max: limit > 0 ? Math.min(limit, 200) : aliasFallbackMax,
          hasAlias: typeof effect.hasAlias === 'boolean' || typeof effect.hasAlias === 'number' ? bool(effect.hasAlias) : null,
        },
      };
    }
    case 'groupInvite': {
      const link = webLink(effect.url);
      return link && isGroupInviteLink(link) ? { type: 'groupInvite', url: link } : null;
    }
    case 'stickers': {
      const text = digits(effect.cateId);
      const id = text ? Number(text) : 0;
      return id > 0 && Number.isSafeInteger(id) ? { type: 'stickers', cateId: id } : null;
    }
    case 'poll': {
      const id = digits(effect.pollId);
      return id ? { type: 'poll', pollId: id } : null;
    }
    case 'tab': {
      const tab = str(effect.tab);
      return tab === 'chats' || tab === 'contacts' || tab === 'groups' ? { type: 'tab', target: tab } : null;
    }
    default:
      return null;
  }
};

const validGroupId = (g: string) => g.length > 1 && g.length <= 25 && /^g[0-9]+$/.test(g);

export interface GroupInviteMember {
  id: string;
  name: string;
  avatar: string | null;
  admin: boolean;
}

/** The group an invite link points at (official `getGroupInfoByLink`). */
export interface GroupInvitePreview {
  state: 'preview' | 'member' | 'error';
  /** Conversation id with its "g" prefix. */
  groupId: string;
  name: string;
  avatar: string | null;
  totalMember: number;
  desc: string;
  community: boolean;
  creatorName: string;
  members: GroupInviteMember[];
  text: string;
}

export const parseGroupInvitePreview = (v: unknown): GroupInvitePreview => {
  const root = obj(v) ?? {};
  const text = clip(root.text, 300);
  const group = str(root.groupId);
  const base: GroupInvitePreview = { state: 'error', groupId: '', name: '', avatar: null, totalMember: 0, desc: '', community: false, creatorName: '', members: [], text };
  const state = str(root.state);
  if (state === 'member' && validGroupId(group)) return { ...base, state: 'member', groupId: group };
  if (state === 'preview' && validGroupId(group)) {
    return {
      ...base,
      state: 'preview',
      groupId: group,
      name: clip(root.name, 200),
      avatar: webLink(root.avatar),
      totalMember: Math.max(0, int(root.totalMember)),
      desc: clip(root.desc, 2000),
      community: bool(root.community),
      creatorName: clip(root.creatorName, 200),
      members: arr(root.members)
        .slice(0, 12)
        .map(obj)
        .filter((r): r is Json => !!r && !!str(r.id))
        .map((r) => ({ id: str(r.id), name: clip(r.name, 200), avatar: webLink(r.avatar), admin: bool(r.admin) })),
    };
  }
  return { ...base, text: text || 'Đã có lỗi xảy ra. Vui lòng thử lại' };
};

/** Result of "Tham gia" on a group invite. */
export interface GroupJoinResult {
  state: 'joined' | 'pending' | 'already' | 'error';
  groupId: string;
  text: string;
}

export const parseGroupJoinResult = (v: unknown): GroupJoinResult => {
  const root = obj(v) ?? {};
  const group = str(root.groupId);
  const text = clip(root.text, 300);
  switch (str(root.state)) {
    case 'joined':
      if (validGroupId(group)) return { state: 'joined', groupId: group, text };
      break;
    case 'already':
      if (validGroupId(group)) return { state: 'already', groupId: group, text };
      break;
    case 'pending':
      return { state: 'pending', groupId: '', text };
  }
  return { state: 'error', groupId: '', text: text || 'Vào nhóm không thành công.' };
};

export interface StickerCategoryItem {
  /** `<cateId>_<stickerId>` */
  ref: string;
  url: string;
  stickerId: number;
}

/** The stickers of one category (official sticker manager). */
export interface StickerCategory {
  id: number;
  name: string;
  icon: string | null;
  stickers: StickerCategoryItem[];
}

export const parseStickerCategory = (v: unknown): StickerCategory | null => {
  const root = obj(v);
  if (!root || typeof root.id !== 'number') return null;
  const id = int(root.id);
  if (id <= 0) return null;
  const prefix = `${id}_`;
  const stickers = arr(root.stickers)
    .slice(0, 300)
    .map(obj)
    .filter((r): r is Json => !!r)
    .flatMap((row) => {
      const ref = str(row.ref);
      const rest = ref.startsWith(prefix) ? ref.slice(prefix.length) : '';
      const link = webLink(row.url);
      if (!rest || !/^-?[0-9]+$/.test(rest) || !link) return [];
      return [{ ref, url: link, stickerId: Number(rest) }];
    });
  if (!stickers.length) return null;
  return { id, name: clip(root.name, 200), icon: webLink(root.icon), stickers };
};
