// Message context-menu actions — Chia sẻ, Copy, Thu hồi, Xóa chỉ ở phía tôi, Ghim tin nhắn, Đánh dấu tin nhắn — bridged to
// `host-scripts/message-actions-adapter.js` (`window.__zaloMsgActions`). Port of ZaloEngine+MessageActions.swift.
// Copy is native (clipboard). The pinned list of the open conversation arrives as `pins` states.

import { callAdapter, fireAdapter, log, raceTimeout } from './call';
import { mediaUrl } from './media';
import type { ChatMessage } from './models/chat';
import { obj, num, str, type Json } from './models/json';
import {
  noAnswerText,
  parseMessageActionOutcome,
  parsePinnedList,
  protectedText,
  type MessageActionOutcome,
  type PinnedItem,
} from './models/outcomes';
import { getEngine, setEngine, type DeleteUndo, type MessageActionConfirm } from './store';
import { showToast } from './toast';

/** Message actions in flight ("conv|msg|action"): a second click while one runs is ignored. */
const busy = new Set<string>();
let confirmSeq = 0;
let forwardSeq = 0;

const evaluate = (method: string, args: unknown[]): Promise<unknown> =>
  callAdapter('__zaloMsgActions', method, ...args).catch((e) => {
    log(`msgActions.${method} → ${String(e)}`);
    return { status: 'not-ready' };
  });

const callActions = async (method: string, args: unknown[], timeout: number, failure: string): Promise<{ outcome: MessageActionOutcome; raw: unknown }> => {
  const answer = await raceTimeout(timeout, evaluate(method, args));
  if (!answer) return { outcome: { kind: 'pending', text: noAnswerText }, raw: null };
  const outcome = parseMessageActionOutcome(answer.value, failure);
  log(`message ${method} → ${outcome.kind}`);
  return { outcome, raw: answer.value };
};

const once = async (key: string, work: () => Promise<void>) => {
  if (busy.has(key)) return;
  busy.add(key);
  try {
    await work();
  } finally {
    busy.delete(key);
  }
};

// MARK: Copy (native)

/** Copies are refused under "Chặn chia sẻ", read fresh: it may have been turned on after the menu was built. */
const copyAllowed = async (conversationId: string): Promise<boolean> => {
  const answer = await raceTimeout(5, evaluate('isProtected', [conversationId]));
  if (answer?.value !== true) return true;
  showToast(protectedText, conversationId);
  return false;
};

export const copyText = async (text: string, conversationId: string) => {
  if (!(await copyAllowed(conversationId))) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Đã sao chép', conversationId);
  } catch {
    showToast('Không sao chép được. Hãy thử lại.', conversationId);
  }
};

/** "Copy hình ảnh": the photo through the media scheme, onto the clipboard as PNG. */
export const copyPhoto = async (message: ChatMessage) => {
  if (message.kind.type !== 'photo') return;
  const conversation = message.conversationId;
  if (!(await copyAllowed(conversation))) return;
  try {
    const src = mediaUrl(message.kind.url);
    if (!src || message.isE2EE) throw new Error('no source');
    const blob = await (await fetch(src)).blob();
    const png = blob.type === 'image/png' ? blob : await toPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    showToast('Đã sao chép', conversation);
  } catch {
    showToast('Không sao chép được hình ảnh. Hãy thử lại.', conversation);
  }
};

const toPng = async (blob: Blob): Promise<Blob> => {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png'));
};

// MARK: Chia sẻ

export const requestForward = (message: ChatMessage) => {
  if (message.menu.forward !== 'available') {
    if (message.menu.forward === 'blocked') showToast(protectedText, message.conversationId);
    return;
  }
  forwardSeq += 1;
  setEngine({ forwardRequest: { id: forwardSeq, conversationId: message.conversationId, message } });
};

export const dismissForward = () => setEngine({ forwardRequest: null });

/** Forwards to every conversation in `targets` through the official forward module. */
export const forward = async (message: ChatMessage, targets: string[]): Promise<MessageActionOutcome> =>
  (await callActions('forward', [message.conversationId, message.id, targets], 75, 'Có lỗi khi chia sẻ tin nhắn')).outcome;

// MARK: Thu hồi / Đánh dấu

/** One action at a time per message and kind; failures, pending answers and official info texts become the toast. */
const runAction = (message: ChatMessage, name: string, args: unknown[], failure: string, method = name) => {
  const conversation = message.conversationId;
  void once(`${conversation}|${message.id}|${name}`, async () => {
    const { outcome } = await callActions(method, args, 45, failure);
    if (outcome.kind === 'done' && outcome.text) showToast(outcome.text, conversation);
    if (outcome.kind === 'failed' || outcome.kind === 'pending') showToast(outcome.text, conversation);
  });
};

export const recall = (message: ChatMessage) =>
  runAction(message, 'recall', [message.conversationId, message.id], 'Thu hồi tin nhắn không thành công');

export const setStarred = (message: ChatMessage, on: boolean) => {
  if (on && message.menu.star === 'blocked') return showToast(protectedText, message.conversationId);
  runAction(message, on ? 'star' : 'unstar', [message.conversationId, message.id, on], 'Có lỗi xảy ra', 'star');
};

// MARK: Xóa chỉ ở phía tôi

export const deleteForMe = (message: ChatMessage, confirmed = false) => {
  const conversation = message.conversationId;
  void once(`${conversation}|${message.id}|delete`, async () => {
    const answer = await raceTimeout(45, evaluate('deleteForMe', [conversation, message.id, confirmed]));
    if (!answer) return showToast(noAnswerText, conversation);
    const outcome = parseMessageActionOutcome(answer.value, 'Không thể xóa tin nhắn');
    switch (outcome.kind) {
      case 'done': {
        const undo = obj(obj(answer.value)?.undo);
        const id = undo ? str(undo.id) : '';
        if (!undo || !id) return;
        showDeleteUndo({
          id,
          conversationId: conversation,
          count: Math.max(1, num(undo.count, 1)),
          deadline: Date.now() + Math.max(1000, num(undo.ms)),
        });
        return;
      }
      case 'confirm':
        return ask({
          conversationId: conversation,
          action: { kind: 'deleteForMe', message },
          title: outcome.title,
          message: outcome.message,
          ok: outcome.ok,
          cancel: outcome.cancel,
          destructive: true,
        });
      default:
        showToast(outcome.text, conversation);
    }
  });
};

const showDeleteUndo = (undo: DeleteUndo) => {
  // A newer delete takes the bar: the earlier one just runs out, as its official snackbar would.
  const previous = getEngine().deleteUndo;
  if (previous) fireAdapter('__zaloMsgActions', 'dropDelete', previous.id);
  setEngine({ deleteUndo: undo });
  setTimeout(() => {
    if (getEngine().deleteUndo !== undo) return;
    setEngine({ deleteUndo: null });
    fireAdapter('__zaloMsgActions', 'dropDelete', undo.id);
  }, Math.max(500, undo.deadline - Date.now()));
};

/** "Khôi phục": the deleted message comes back (official undoDeleteMsgs). */
export const undoDelete = async () => {
  const undo = getEngine().deleteUndo;
  if (!undo) return;
  setEngine({ deleteUndo: null });
  const { outcome } = await callActions('undoDelete', [undo.id], 30, 'Không thể khôi phục');
  if (outcome.kind === 'done') showToast('Khôi phục thành công', undo.conversationId);
  else if (outcome.kind === 'failed' || outcome.kind === 'pending') showToast(outcome.text, undo.conversationId);
};

/** The bar's close button: the official client deletes for good at once. */
export const dismissDeleteUndo = () => {
  const undo = getEngine().deleteUndo;
  if (!undo) return;
  setEngine({ deleteUndo: null });
  fireAdapter('__zaloMsgActions', 'commitDelete', undo.id);
};

// MARK: Ghim tin nhắn

export const pinMessage = (message: ChatMessage, replacing: string | null = null) => {
  const conversation = message.conversationId;
  void once(`${conversation}|${message.id}|pin`, async () => {
    const { outcome } = await callActions('pin', [conversation, message.id, replacing], 60, 'Ghim tin nhắn không thành công.');
    if (outcome.kind === 'confirm') {
      if (!outcome.ref) return showToast('Ghim tin nhắn không thành công.', conversation);
      ask({
        conversationId: conversation,
        action: { kind: 'pin', message, replacing: outcome.ref },
        title: outcome.title,
        message: outcome.message,
        ok: outcome.ok,
        cancel: outcome.cancel,
        destructive: false,
      });
    } else if (outcome.kind === 'failed' || outcome.kind === 'pending') showToast(outcome.text, conversation);
  });
};

/** The pin of a loaded chat message (own messages are keyed by client id, others by server id). */
export const pinnedMessage = (item: PinnedItem, list: ChatMessage[]): ChatMessage | null => {
  if (item.kind !== 'message') return null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if ((item.msgId && m.id === item.msgId) || (item.cliMsgId && m.id === item.cliMsgId)) return m;
  }
  return null;
};

/** Asks the official "Bạn muốn bỏ ghim tin nhắn?" first. */
export const requestUnpin = (item: PinnedItem, conversationId: string) =>
  ask({
    conversationId,
    action: { kind: 'unpin', ref: item.ref },
    title: item.kind === 'message' ? 'Bỏ ghim tin nhắn' : 'Bỏ ghim',
    message: item.kind === 'message' ? 'Bạn muốn bỏ ghim tin nhắn?' : 'Bạn muốn bỏ ghim nội dung này?',
    ok: 'Bỏ ghim',
    cancel: 'Hủy',
    destructive: true,
  });

/** Unpins the message's own pin (the context menu's "Bỏ ghim tin nhắn"). */
export const requestUnpinMessage = (message: ChatMessage) => {
  const item = getEngine().pins[message.conversationId]?.items.find((i) => pinnedMessage(i, [message]));
  if (item) requestUnpin(item, message.conversationId);
};

const unpin = (ref: string, conversationId: string) =>
  void once(`${conversationId}|${ref}|unpin`, async () => {
    const { outcome } = await callActions('unpin', [conversationId, ref], 40, 'Yêu cầu thực hiện không thành công');
    if (outcome.kind === 'failed' || outcome.kind === 'pending') showToast(outcome.text, conversationId);
  });

// MARK: Confirms

/** A confirm belongs to the conversation on screen and comes one at a time; anything else is dropped. */
const ask = (confirm: Omit<MessageActionConfirm, 'id'>) => {
  const s = getEngine();
  if (s.openConversationId !== confirm.conversationId || s.messageConfirm) {
    log('message confirm dropped (conversation left or another confirm open)');
    return;
  }
  confirmSeq += 1;
  setEngine({ messageConfirm: { ...confirm, id: confirmSeq } });
};

export const answerMessageConfirm = (confirm: MessageActionConfirm, ok: boolean) => {
  if (getEngine().messageConfirm?.id !== confirm.id) return;
  setEngine({ messageConfirm: null });
  if (!ok) return;
  const a = confirm.action;
  if (a.kind === 'deleteForMe') deleteForMe(a.message, true);
  else if (a.kind === 'pin') pinMessage(a.message, a.replacing);
  else unpin(a.ref, confirm.conversationId);
};

// MARK: Pins of the open conversation

export const handlePins = (state: Json) => {
  const json = obj(state.pins);
  const conversation = json ? str(json.convId) : '';
  if (!json || !conversation) return;
  const list = parsePinnedList(json);
  const current = getEngine().pins[conversation];
  if (current && JSON.stringify(current) === JSON.stringify(list)) return;
  setEngine((s) => ({ pins: { ...s.pins, [conversation]: list } }));
};

/** The page reloaded: watch the open conversation's pins again. */
export const rewatchPins = () => {
  const id = getEngine().openConversationId;
  if (id) fireAdapter('__zaloMsgActions', 'watchPins', id);
};

/** Another conversation opens: a picker or confirm of the previous one must not answer for it. */
export const dropMessagePrompts = () => setEngine({ forwardRequest: null, messageConfirm: null });

/** Logout: nothing of the previous account may be asked, undone or shown in the next. */
export const resetMessageActions = () => busy.clear();
