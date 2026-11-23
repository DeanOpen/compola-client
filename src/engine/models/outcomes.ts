// Results of adapter calls (Swift: `MessageActionOutcome`, `ComposerOutcome`, `CardActionOutcome`) and the pinned list.

import { arr, obj, optStr, str, url, webLink, type Json } from './json';

export const defaultPending =
  'Thao tác đang được xử lý, chưa nhận được phản hồi. Hãy kiểm tra lại cuộc trò chuyện trước khi thử lại.';
/** The page did not answer within the cap: the action may still happen, so the wording never invites a retry. */
export const noAnswerText = 'Thao tác vẫn đang được xử lý. Hãy kiểm tra lại cuộc trò chuyện trước khi thử lại.';
export const defaultUnsupported = 'Chưa hỗ trợ trên ứng dụng này';
export const notReadyText = 'Zalo chưa sẵn sàng, hãy thử lại sau giây lát.';
export const notOpenText = 'Cuộc trò chuyện chưa sẵn sàng, hãy thử lại sau giây lát.';
export const protectedText = 'Trò chuyện này đã bật Chặn chia sẻ';

export type MessageActionOutcome =
  | { kind: 'done'; text: string | null }
  | { kind: 'confirm'; title: string; message: string; ok: string; cancel: string; ref: string | null }
  | { kind: 'failed'; text: string }
  | { kind: 'pending'; text: string };

export const parseMessageActionOutcome = (v: unknown, failure: string): MessageActionOutcome => {
  const root = obj(v);
  const status = root ? str(root.status) : '';
  if (!root || !status) return { kind: 'failed', text: failure };
  const text = optStr(root.text);
  switch (status) {
    case 'done':
      return { kind: 'done', text };
    case 'confirm':
      return {
        kind: 'confirm',
        title: str(root.title),
        message: str(root.message),
        ok: str(root.ok, 'OK'),
        cancel: str(root.cancel, 'Hủy'),
        ref: optStr(root.ref),
      };
    case 'pending':
      return { kind: 'pending', text: text ?? defaultPending };
    case 'not-ready':
      return { kind: 'failed', text: text ?? notReadyText };
    case 'not-open':
      return { kind: 'failed', text: text ?? notOpenText };
    default:
      return { kind: 'failed', text: text ?? failure };
  }
};

export type ComposerOutcome =
  | { kind: 'done' }
  /** Nothing was picked, or the official client already said why. */
  | { kind: 'cancelled' }
  | { kind: 'failed'; text: string }
  | { kind: 'pending'; text: string };

export const composerGenericFailure = 'Không gửi được. Hãy thử lại.';

export const parseComposerOutcome = (v: unknown): ComposerOutcome => {
  const root = obj(v);
  const status = root ? str(root.status) : '';
  if (!root || !status) return { kind: 'failed', text: composerGenericFailure };
  const text = optStr(root.text);
  switch (status) {
    case 'done':
      return { kind: 'done' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'invalid':
      return text ? { kind: 'failed', text } : { kind: 'cancelled' };
    case 'pending':
      return { kind: 'pending', text: text ?? defaultPending };
    case 'not-open':
      return { kind: 'failed', text: notOpenText };
    case 'not-ready':
      return { kind: 'failed', text: notReadyText };
    default:
      return { kind: 'failed', text: text ?? composerGenericFailure };
  }
};

export type CardActionOutcome =
  | { kind: 'done' }
  | { kind: 'openChat'; id: string }
  | { kind: 'openProfile'; id: string }
  | { kind: 'openURL'; url: string }
  | { kind: 'copy'; text: string }
  /** A native sheet the official action opens (alias, group invite, poll…): `effect` is kept for the later sheet ports. */
  | { kind: 'present'; effect: Json }
  | { kind: 'unsupported'; text: string }
  | { kind: 'locked'; text: string }
  | { kind: 'failed'; text: string }
  | { kind: 'pending'; text: string };

/** Effect types the card-sheet ports (CardSheetModels.swift, later wave) will present natively. */
const sheetEffects = new Set(['alias', 'groupInvite', 'stickerCategory', 'poll', 'sidebarTab', 'reminder', 'groupPreview']);

export const parseCardActionOutcome = (v: unknown): CardActionOutcome => {
  const root = obj(v);
  const status = root ? str(root.status) : '';
  if (!root || !status) return { kind: 'failed', text: 'Không thực hiện được thao tác.' };
  const text = optStr(root.text);
  switch (status) {
    case 'done':
      return { kind: 'done' };
    case 'effect': {
      const effect = obj(root.effect) ?? {};
      const id = str(effect.id) || str(effect.uid);
      const type = str(effect.type);
      if (type === 'openChat' && id) return { kind: 'openChat', id };
      if (type === 'openProfile' && id) return { kind: 'openProfile', id };
      if (type === 'copy' && str(effect.text)) return { kind: 'copy', text: str(effect.text) };
      if (type === 'openURL') {
        const link = webLink(effect.url);
        return link ? { kind: 'openURL', url: link } : { kind: 'unsupported', text: defaultUnsupported };
      }
      if (sheetEffects.has(type)) return { kind: 'present', effect };
      return { kind: 'unsupported', text: defaultUnsupported };
    }
    case 'unsupported':
      return { kind: 'unsupported', text: text ?? defaultUnsupported };
    case 'locked':
      return { kind: 'locked', text: text ?? 'Bạn không thể gửi tin nhắn vào cuộc trò chuyện này.' };
    case 'not-open':
      return { kind: 'failed', text: notOpenText };
    case 'busy':
      return { kind: 'failed', text: text ?? 'Thao tác đang được xử lý, hãy chờ giây lát.' };
    case 'pending':
      return { kind: 'pending', text: text ?? defaultPending };
    default:
      return { kind: 'failed', text: text ?? 'Không thực hiện được thao tác.' };
  }
};

// MARK: - Pins of a conversation

export type PinnedKind = 'message' | 'note' | 'link' | 'poll' | 'reminder';

export interface PinnedItem {
  ref: string;
  kind: PinnedKind;
  title: string;
  sender: string;
  thumbnail: string | null;
  msgId: string;
  cliMsgId: string;
}

export interface PinnedList {
  /** The pins could be read. */
  ready: boolean;
  /** I may pin / unpin here. */
  canPin: boolean;
  items: PinnedItem[];
}

/** The official board's label of the pin's type. */
export const pinnedLabel = (item: PinnedItem): string => {
  switch (item.kind) {
    case 'message':
      return 'Tin nhắn';
    case 'note':
    case 'link':
      return 'Ghi chú';
    case 'poll':
      return 'Bình chọn';
    case 'reminder':
      return 'Nhắc hẹn';
  }
};

export const parsePinnedList = (json: Json): PinnedList => ({
  ready: json.ready === true,
  canPin: json.canPin === true,
  items: arr(json.items)
    .map(obj)
    .filter((r): r is Json => !!r && !!str(r.ref))
    .map((row) => {
      const kind = str(row.kind);
      return {
        ref: str(row.ref),
        kind: (['message', 'note', 'link', 'poll', 'reminder'].includes(kind) ? kind : 'note') as PinnedKind,
        title: str(row.title),
        sender: str(row.sender),
        thumbnail: url(row.thumb),
        msgId: str(row.msgId),
        cliMsgId: str(row.cliMsgId),
      };
    }),
});
