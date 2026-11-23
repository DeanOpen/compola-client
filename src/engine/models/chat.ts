// Port of `ChatModels.swift`: the chat contract shared with `host-scripts/chat-adapter.js` (see its header for the
// full JSON shapes). Values are produced by the official renderer's own services; nothing here is synthesized.
// Dates are epoch milliseconds.

import { parseTextStyles, type TextStyleRange } from './textStyles';
import { arr, bool, int, num, obj, optStr, str, strings, url, webLink, type Json } from './json';

/** An @mention inside a text: `pos`/`len` are UTF-16 offsets (JS string indices) covering "@Name". */
export interface Mention {
  uid: string;
  pos: number;
  len: number;
  isAll: boolean;
}

/** A group member offered by the composer's @-popover (official suggestion engine). */
export interface MentionCandidate {
  id: string;
  /** Display name without the "@" ("All" for everyone). */
  name: string;
  avatar: string | null;
  isAll: boolean;
}

/** A reaction icon of the official client: a `pc-dist` image path with the icon text as fallback. */
export interface ReactionIcon {
  type: string;
  key: string;
  emoji: string;
  image: string;
}

export const parseReactionIcon = (json: Json): ReactionIcon | null => {
  const emoji = str(json.emoji);
  const key = str(json.key);
  if (!emoji && !key) return null;
  const type = optStr(json.type) ?? (key || emoji);
  return { type, key, emoji: emoji || key, image: str(json.image) };
};

export interface Reaction {
  icon: ReactionIcon;
  count: number;
  includesMe: boolean;
  /** Up to 3 reactor names (me first, as "Bạn"). */
  names: string[];
  /** Distinct people who used this reaction. */
  people: number;
}

/** Chip tooltip: "A", "A và B", "A, B và C", "A, B, C và 2 người khác"; null when nobody is known. */
export const reactionTooltip = (r: Reaction): string | null => {
  const names = r.names;
  const others = Math.max(0, r.people - names.length);
  if (names.length === 0) return others === 0 ? null : `${others} người`;
  if (others === 0) {
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + ' và ' + names[names.length - 1];
  }
  return names.join(', ') + ` và ${others} người khác`;
};

export interface ContactCard {
  name: string;
  uid: string;
  avatar: string | null;
  phone: string;
  qr: string | null;
  oaLink: string;
  isOfficialAccount: boolean;
}

export interface LocationInfo {
  title: string;
  address: string;
  coordinate: { latitude: number; longitude: number } | null;
  thumbnail: string | null;
}

/** The link the official card opens (`maps.google.com/maps?q=lat,lo&z=14`). */
export const locationMapUrl = (info: LocationInfo): string | null =>
  info.coordinate
    ? `https://maps.google.com/maps?q=${info.coordinate.latitude},${info.coordinate.longitude}&z=14&t=m`
    : null;

export interface ECard {
  style: 'banner' | 'friend' | 'birthday' | 'reminder';
  image: string | null;
  thumb: string | null;
  title: string;
  description: string;
  actions: string[];
  avatars: string[];
  reminderTitle: string;
  reminderStart: number | null;
  reminderRepeat: string;
}

export interface OAPart {
  isHeader: boolean;
  title: string;
  description: string;
  thumb: string | null;
  url: string | null;
  help: string;
}

export interface PollInfo {
  question: string;
  header: string;
  anonymous: boolean;
  pollId: string;
  conversationId: string;
}

export type MessageKind =
  /** `styles`: Zalo rich text ("Định dạng tin nhắn") ranges, offsets into the message text. */
  | { type: 'text'; styles?: TextStyleRange[] }
  | { type: 'photo'; url: string | null; width: number; height: number }
  | { type: 'sticker'; url: string | null }
  | { type: 'gif'; url: string | null }
  | { type: 'video'; thumbnail: string | null; duration: number; url: string | null }
  | { type: 'voice'; url: string | null; duration: number }
  | { type: 'file'; name: string; size: number; url: string | null }
  | { type: 'link'; title: string; url: string | null; thumbnail: string | null; description: string; source: string }
  | { type: 'contactCard'; card: ContactCard }
  | { type: 'location'; info: LocationInfo }
  | { type: 'call'; video: boolean; missed: boolean; duration: number; title: string; detail: string }
  | { type: 'ecard'; card: ECard }
  | { type: 'oaMessage'; parts: OAPart[] }
  | { type: 'poll'; poll: PollInfo }
  | { type: 'stickerSet'; title: string; thumbnail: string | null }
  | { type: 'zinstant'; title: string; text: string; thumbnail: string | null }
  /** Centered notice; `symbol` is an SF Symbol name (mapped to an icon by the view). */
  | { type: 'notice'; symbol: string; text: string }
  | { type: 'placeholder'; symbol: string; text: string }
  | { type: 'system' }
  | { type: 'recalled' }
  | { type: 'unsupported'; rawType: string };

/** Kinds the official client lays out centered, outside the message bubbles. */
export const isStandalone = (kind: MessageKind): boolean =>
  kind.type === 'system' || kind.type === 'notice' || kind.type === 'ecard';

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'seen' | 'failed';

export interface Quote {
  senderName: string;
  text: string;
}

/** A button on a message card; `ref` names it for `__zaloChat.performAction`. */
export interface CardButton {
  ref: string;
  label: string;
  enabled: boolean;
  help: string;
}

/** Items of the official message context menu (message-actions-adapter.js `describe`). */
export interface MessageMenu {
  forward: 'hidden' | 'available' | 'blocked';
  recall: boolean;
  delete: 'plain' | 'forMe' | null;
  pin: boolean;
  star: 'star' | 'unstar' | 'blocked' | null;
  starred: boolean;
  pinned: boolean;
  /** "Chặn chia sẻ" is on: nothing may be forwarded, copied or saved. */
  isProtected: boolean;
}

export const emptyMenu: MessageMenu = {
  forward: 'hidden',
  recall: false,
  delete: null,
  pin: false,
  star: null,
  starred: false,
  pinned: false,
  isProtected: false,
};

export const parseMenu = (v: unknown): MessageMenu => {
  const row = obj(v);
  if (!row) return emptyMenu;
  const forward = row.forward === 'ok' ? 'available' : row.forward === 'blocked' ? 'blocked' : 'hidden';
  const del = row.delete === 'plain' || row.delete === 'forMe' ? row.delete : null;
  const star = row.star === 'star' || row.star === 'unstar' || row.star === 'blocked' ? row.star : null;
  return {
    forward,
    recall: bool(row.recall),
    delete: del,
    pin: bool(row.pin),
    star,
    starred: bool(row.starred),
    pinned: bool(row.pinned),
    isProtected: bool(row.protected),
  };
};

export interface ChatMessage {
  /** Server `msgId`, or the client id (`cliMsgId`) of my own messages. */
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string | null;
  isMine: boolean;
  kind: MessageKind;
  /** Text body, caption, or a readable fallback for non-text kinds. */
  text: string;
  /** Epoch ms. */
  date: number;
  status: MessageStatus;
  quote: Quote | null;
  reactions: Reaction[];
  isE2EE: boolean;
  mentions: Mention[];
  cardButtons: CardButton[];
  suggestsStickers: boolean;
  menu: MessageMenu;
}

const plausibleMs = (ms: number): number | null => (ms > 0 && ms < 4_102_444_800_000 ? ms : null);

export const parseKind = (json: Json): MessageKind => {
  const text = (k: string) => str(json[k]);
  switch (str(json.type, 'text')) {
    case 'text': {
      const styles = parseTextStyles(json.styles, Number.MAX_SAFE_INTEGER);
      return styles.length ? { type: 'text', styles } : { type: 'text' };
    }
    case 'photo':
      return { type: 'photo', url: url(json.url), width: int(json.width), height: int(json.height) };
    case 'sticker':
      return { type: 'sticker', url: url(json.url) };
    case 'gif':
      return { type: 'gif', url: url(json.url) };
    case 'video':
      return { type: 'video', thumbnail: url(json.thumbnail), duration: int(json.duration), url: url(json.url) };
    case 'voice':
      return { type: 'voice', url: url(json.url), duration: int(json.duration) };
    case 'file':
      return { type: 'file', name: text('name'), size: int(json.size), url: url(json.url) };
    case 'link':
      return {
        type: 'link',
        title: text('title'),
        url: webLink(json.url),
        thumbnail: url(json.thumbnail),
        description: text('description'),
        source: text('source'),
      };
    case 'contactCard':
      return {
        type: 'contactCard',
        card: {
          name: text('name'),
          uid: text('uid'),
          avatar: url(json.avatar),
          phone: text('phone'),
          qr: url(json.qr),
          oaLink: text('oaLink'),
          isOfficialAccount: bool(json.isOA),
        },
      };
    case 'location': {
      let coordinate: LocationInfo['coordinate'] = null;
      if (bool(json.hasCoordinates)) {
        const lat = num(json.latitude);
        const lon = num(json.longitude);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) coordinate = { latitude: lat, longitude: lon };
      }
      return {
        type: 'location',
        info: { title: text('title'), address: text('address'), coordinate, thumbnail: url(json.thumbnail) },
      };
    }
    case 'call':
      return {
        type: 'call',
        video: bool(json.video),
        missed: bool(json.missed),
        duration: int(json.duration),
        title: text('title'),
        detail: text('detail'),
      };
    case 'ecard': {
      const style = text('style');
      return {
        type: 'ecard',
        card: {
          style: style === 'friend' || style === 'birthday' || style === 'reminder' ? style : 'banner',
          image: url(json.image),
          thumb: url(json.thumb),
          title: text('title'),
          description: text('description'),
          actions: strings(json.actions).filter((s) => s.length > 0),
          avatars: arr(json.avatars).map(url).filter((u): u is string => !!u),
          reminderTitle: text('reminderTitle'),
          reminderStart: plausibleMs(num(json.reminderStart)),
          reminderRepeat: text('reminderRepeat'),
        },
      };
    }
    case 'oaMessage':
      return {
        type: 'oaMessage',
        parts: arr(json.parts)
          .map(obj)
          .filter((r): r is Json => !!r)
          .map((row) => ({
            isHeader: bool(row.header),
            title: str(row.title),
            description: str(row.description),
            thumb: url(row.thumb),
            url: webLink(row.url),
            help: str(row.help),
          }))
          .filter((p) => p.title.length > 0 || p.thumb !== null),
      };
    case 'poll':
      return {
        type: 'poll',
        poll: {
          question: text('question'),
          header: text('header'),
          anonymous: bool(json.anonymous),
          pollId: text('pollId'),
          conversationId: text('conversationId'),
        },
      };
    case 'stickerSet':
      return { type: 'stickerSet', title: text('title'), thumbnail: url(json.thumb) };
    case 'zinstant':
      return { type: 'zinstant', title: text('title'), text: text('text'), thumbnail: url(json.thumb) };
    case 'notice':
      return { type: 'notice', symbol: text('symbol') || 'info.circle', text: text('text') };
    case 'placeholder':
      return { type: 'placeholder', symbol: text('symbol') || 'lock', text: text('text') };
    case 'system':
      return { type: 'system' };
    case 'recalled':
      return { type: 'recalled' };
    default:
      return { type: 'unsupported', rawType: text('rawType') };
  }
};

export const parseCardButtons = (v: unknown): CardButton[] =>
  arr(v)
    .map(obj)
    .filter((r): r is Json => !!r)
    .map((row) => ({
      ref: str(row.ref),
      label: str(row.label).trim(),
      enabled: bool(row.enabled),
      help: str(row.help),
    }))
    .filter((b) => b.ref.length > 0 && b.label.length > 0);

/** Parses one `ChatMessageJSON`; null without an id. */
export const parseChatMessage = (v: unknown, fallbackConversation: string): ChatMessage | null => {
  const json = obj(v);
  if (!json) return null;
  const id = str(json.id);
  if (!id) return null;
  const q = obj(json.quote);
  const reactions: Reaction[] = [];
  for (const r of arr(json.reactions)) {
    const row = obj(r);
    const icon = row && parseReactionIcon(row);
    if (!row || !icon) continue;
    reactions.push({
      icon,
      count: int(row.count),
      includesMe: bool(row.includesMe),
      names: strings(row.names),
      people: int(row.people),
    });
  }
  const mentions: Mention[] = [];
  for (const m of arr(json.mentions)) {
    const row = obj(m);
    const uid = row ? str(row.uid) : '';
    if (!row || !uid) continue;
    mentions.push({ uid, pos: int(row.pos), len: int(row.len), isAll: bool(row.isAll) });
  }
  const status = str(json.status);
  return {
    id,
    conversationId: str(json.conversationId) || fallbackConversation,
    senderId: str(json.senderId),
    senderName: str(json.senderName),
    senderAvatar: url(json.senderAvatar),
    isMine: bool(json.isMine),
    kind: parseKind(obj(json.kind) ?? {}),
    text: str(json.text),
    date: num(json.date),
    status:
      status === 'sending' || status === 'sent' || status === 'delivered' || status === 'seen' || status === 'failed'
        ? status
        : 'sent',
    quote: q ? { senderName: str(q.senderName), text: str(q.text) } : null,
    reactions,
    isE2EE: bool(json.isE2EE),
    mentions,
    cardButtons: parseCardButtons(json.buttons),
    suggestsStickers: bool(json.stickers),
    menu: parseMenu(json.menu),
  };
};

/** What "Copy tin nhắn" puts on the clipboard: the text of a text / link message. */
export const copyableText = (m: ChatMessage): string | null => {
  if (m.kind.type === 'text') return m.text || null;
  if (m.kind.type === 'link') {
    if (m.text && !m.text.startsWith('[Link]')) return m.text;
    return m.kind.url ?? (m.kind.title || null);
  }
  return null;
};

/** The caption of a photo / video ("Copy chú thích"). */
export const captionOf = (m: ChatMessage): string | null =>
  (m.kind.type === 'photo' || m.kind.type === 'video') && m.text && !m.text.startsWith('[') ? m.text : null;

/** Media of an E2EE message is ciphertext on the CDN: only the official downloader can read it. */
export const isEncryptedMedia = (m: ChatMessage, mediaUrl: string | null): boolean =>
  m.isE2EE || (mediaUrl?.includes('e2esession') ?? false);

// MARK: - Composer draft

/** What the composer holds: text with its mentions and the message being replied to. */
export interface ComposerDraft {
  text: string;
  mentions: Mention[];
  replyTo: ChatMessage | null;
  /** "Định dạng" ranges (offsets into `text`); absent = plain text. */
  styles?: TextStyleRange[];
}

/** `other` after `self`, one line below when both have text; its mention offsets move with it. */
export const appendDraft = (self: ComposerDraft, other: ComposerDraft): ComposerDraft => {
  if (!self.text) return { text: other.text, mentions: other.mentions, replyTo: self.replyTo ?? other.replyTo, styles: other.styles };
  if (!other.text) return self;
  const shift = self.text.length + 1;
  return {
    text: self.text + '\n' + other.text,
    mentions: [...self.mentions, ...other.mentions.map((m) => ({ ...m, pos: m.pos + shift }))],
    replyTo: self.replyTo ?? other.replyTo,
    styles: [...(self.styles ?? []), ...(other.styles ?? []).map((r) => ({ ...r, start: r.start + shift }))],
  };
};

// MARK: - Reaction detail ("Biểu cảm" popup)

export interface ReactionDetailUser {
  uid: string;
  name: string;
  avatar: string | null;
  isMe: boolean;
  total: number;
  icons: { icon: ReactionIcon; count: number }[];
}

export interface ReactionDetail {
  tabs: { icon: ReactionIcon; total: number }[];
  users: ReactionDetailUser[];
}

export const unknownReactorName = 'Người dùng Zalo';

export const parseReactionDetail = (v: unknown): ReactionDetail | null => {
  const root = obj(v);
  if (!root) return null;
  const tabs = arr(root.tabs)
    .map(obj)
    .filter((r): r is Json => !!r)
    .flatMap((row) => {
      const icon = parseReactionIcon(row);
      return icon ? [{ icon, total: int(row.total) }] : [];
    });
  const users = arr(root.users)
    .map(obj)
    .filter((r): r is Json => !!r)
    .flatMap((row) => {
      const uid = str(row.uid);
      if (!uid) return [];
      const name = str(row.name).trim();
      const icons = arr(row.icons)
        .map(obj)
        .filter((r): r is Json => !!r)
        .flatMap((e) => {
          const icon = parseReactionIcon(e);
          return icon ? [{ icon, count: int(e.count) }] : [];
        });
      return [
        { uid, name: name || unknownReactorName, avatar: url(row.avatar), isMe: bool(row.isMe), total: int(row.total), icons },
      ];
    });
  return { tabs, users };
};

/** Rows for a tab: null = "Tất cả" (up to 6 icons each); a type = people who used it, with their count of it. */
export const reactionRows = (detail: ReactionDetail, type: string | null): ReactionDetailUser[] => {
  if (type === null) return detail.users.map((u) => ({ ...u, icons: u.icons.slice(0, 6) }));
  return detail.users
    .map((u, index) => {
      const used = u.icons.find((i) => i.icon.type === type);
      return used ? { index, user: { ...u, icons: [used], total: used.count } } : null;
    })
    .filter((x): x is { index: number; user: ReactionDetailUser } => !!x)
    .sort((a, b) => b.user.total - a.user.total || Number(b.user.isMe) - Number(a.user.isMe) || a.index - b.index)
    .map((x) => x.user);
};

/** The official count label: up to 999 as is, then "1k" … "9k"; "k+" with a remainder or over 9999. */
export const shortCount = (n: number): string => {
  if (n <= 0) return '0';
  if (n <= 999) return String(n);
  const thousands = Math.floor(n / 1000);
  const k = Math.min(thousands, 9);
  return n % 1000 > 0 || thousands > 9 ? `${k}k+` : `${k}k`;
};
