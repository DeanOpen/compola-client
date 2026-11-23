// Composer "+" actions bridged to `host-scripts/composer-adapter.js` (`window.__zaloCompose`). Port of
// ZaloEngine+Composer.swift: photo / video and file sends and screenshots (files reach the page through the Rust
// file-input answer, see `callAdapterWithFiles`), the official screenshot tool (`screen_capture_start` →
// `compola://screen-capture`), official confirms and toasts, my contact card ("Gửi danh thiếp") and new reminders ("Tạo nhắc hẹn").

import { backend, commands } from './backend';
import { callAdapter, callAdapterWithFiles, log, raceTimeout } from './call';
import { sendText } from './chat';
import { obj, str, type Json } from './models/json';
import { noAnswerText, parseComposerOutcome, type ComposerOutcome } from './models/outcomes';
import { getEngine, setEngine, type ComposerConfirm } from './store';
import { showToast } from './toast';

const missingCommand = /engine_call_with_files|not found|unknown command|not allowed/i;

/** `files` = paths to hand over, or null to let Rust show the open panel filtered by `pick`. */
const composeWithFiles = async (method: string, args: unknown[], files: string[] | null, pick: 'media' | 'files' = 'files'): Promise<ComposerOutcome> => {
  if (files && files.length === 0) return { kind: 'cancelled' };
  // Photos are processed before the call returns; the uploads themselves continue in the page.
  const answer = await raceTimeout(
    180,
    callAdapterWithFiles('__zaloCompose', method, args, files, pick).catch((e: unknown) => {
      const text = String(e);
      log(`compose ${method} → ${text}`);
      return { status: 'error', text: missingCommand.test(text) ? 'Chưa hỗ trợ gửi tệp trên phiên bản này.' : undefined };
    }),
  );
  if (!answer) return { kind: 'pending', text: noAnswerText };
  let outcome = parseComposerOutcome(answer.value);
  // Files were handed over but the page's file input received none: say so instead of nothing.
  if (files && outcome.kind === 'cancelled' && obj(answer.value)?.status === 'cancelled') {
    outcome = { kind: 'failed', text: 'Không đọc được tệp đã chọn. Hãy thử lại.' };
  }
  log(`compose ${method} → ${outcome.kind}`);
  return outcome;
};

/** "Ảnh hoặc Video": photos through the official photo button's path, videos and other files as files. */
export const sendMedia = (conversationId: string) => composeWithFiles('sendMedia', [conversationId], null, 'media');

/** Files dropped on the chat or pasted with ⌘V: photos go as photos, everything else as files (same split as
 * "Ảnh hoặc Video"). */
export const sendPaths = (conversationId: string, paths: string[]) => composeWithFiles('sendMedia', [conversationId], paths, 'media');

/** What ⌘V would attach: files copied in Finder, or the clipboard image as a PNG (Rust `clipboard_paste_files`). */
export const clipboardFiles = async (): Promise<string[]> => {
  try {
    return await (await backend()).invoke<string[]>('clipboard_paste_files');
  } catch (e) {
    log(`clipboard_paste_files → ${String(e)}`);
    return [];
  }
};

/** "Tệp": the official file button's path. */
export const sendFiles = (conversationId: string) => composeWithFiles('sendFiles', [conversationId], null, 'files');

/** Shows a failure or pending text for a composer action as the conversation's toast. */
export const reportComposer = (outcome: ComposerOutcome, conversationId: string) => {
  if (outcome.kind === 'failed' || outcome.kind === 'pending') showToast(outcome.text, conversationId || null);
};

// MARK: Screenshot (official ZaloCap tool, Rust screen_capture.rs)

/** "Chia sẻ" from the screenshot tool: the shot (or its recognised text) waiting for the conversations to send it to. */
export interface ScreenshotShare {
  id: number;
  image: string | null;
  text: string | null;
  conversationId: string;
}

let shareSeq = 0;

export const startScreenCapture = (conversationId: string, withCompola: boolean) =>
  void commands.screenCaptureStart(conversationId, withCompola).catch((e) => {
    log(`screen_capture_start → ${String(e)}`);
    showToast('Không mở được công cụ chụp màn hình.', conversationId);
  });

export const handleScreenCapture = (payload: unknown) => {
  const event = obj(payload);
  if (!event) return;
  const id = str(event.conversationId);
  switch (event.kind) {
    case 'send':
    case 'sendToMe': {
      const toMe = event.kind === 'sendToMe';
      void composeWithFiles('sendShot', [id, toMe], [str(event.path)]).then((o) => reportComposer(o, id));
      return;
    }
    case 'share':
      shareSeq += 1;
      setEngine({ screenshotShare: { id: shareSeq, image: str(event.path) || null, text: null, conversationId: id } });
      return;
    case 'shareText':
      shareSeq += 1;
      setEngine({ screenshotShare: { id: shareSeq, image: null, text: str(event.text) || null, conversationId: id } });
      return;
    case 'noPermission':
      setEngine({ screenCaptureNeedsPermission: true });
      return;
    case 'failed':
      showToast(str(event.message) || 'Không chụp được màn hình.', id || null);
  }
};

/** Sends the shared shot (or its text) to every conversation picked. */
export const shareScreenshot = async (share: ScreenshotShare, ids: string[]): Promise<ComposerOutcome> => {
  if (share.text) {
    let sent = 0;
    for (const id of ids) if (await sendText(share.text, id)) sent += 1;
    return sent > 0 ? { kind: 'done' } : { kind: 'failed', text: 'Không gửi được. Hãy thử lại.' };
  }
  if (!share.image) return { kind: 'cancelled' };
  return composeWithFiles('shareShot', [ids], [share.image]);
};

// MARK: Danh thiếp, Nhắc hẹn

/** A compose call without files (Swift `compose(_:_:timeout:)`). */
const compose = async (method: string, args: unknown[], seconds: number): Promise<ComposerOutcome> => {
  const answer = await raceTimeout(seconds, callAdapter('__zaloCompose', method, ...args).catch(() => ({ status: 'error' })));
  if (!answer) return { kind: 'pending', text: noAnswerText };
  const outcome = parseComposerOutcome(answer.value);
  log(`compose ${method} → ${outcome.kind}`);
  return outcome;
};

/** My own contact card as the official "Gửi danh thiếp" modal would send it. */
export interface MyCardInfo {
  uid: string;
  name: string;
  avatar: string | null;
  /** Display form of my number, "" when the profile has none. */
  phone: string;
  /** The official "Gửi kèm số điện thoại" choice remembered for this account. */
  withPhone: boolean;
}

export const myCard = async (): Promise<MyCardInfo | null> => {
  const row = obj((await raceTimeout(15, callAdapter('__zaloCompose', 'myCard').catch(() => null)))?.value);
  const uid = row ? str(row.uid) : '';
  if (!row || !uid) return null;
  return { uid, name: str(row.name), avatar: str(row.avatar) || null, phone: str(row.phone), withPhone: row.withPhone !== false };
};

export const sendMyCard = (conversationId: string, withPhone: boolean) => compose('sendMyCard', [conversationId, withPhone], 45);

/** What the official chat-bar gate and compose modal allow for a conversation. */
export interface ReminderComposeInfo {
  allowed: boolean;
  /** OA conversations have no "Nhắc hẹn" item at all. */
  hidden: boolean;
  /** Why it is not allowed (official warning), "" when there is nothing to say. */
  text: string;
  isGroup: boolean;
  /** Group reminders are pinned (official default) when I may pin; `pinToggle` = the modal shows the checkbox. */
  canPin: boolean;
  pinToggle: boolean;
  titleMaxChars: number;
  titleMaxBytes: number;
}

export const reminderComposeInfo = async (conversationId: string): Promise<ReminderComposeInfo | null> => {
  const row = obj((await raceTimeout(15, callAdapter('__zaloCompose', 'reminderInfo', conversationId).catch(() => null)))?.value);
  if (!row) return null;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : d);
  return {
    allowed: row.allowed === true,
    hidden: row.hidden === true,
    text: str(row.text),
    isGroup: row.isGroup === true,
    canPin: row.canPin === true,
    pinToggle: row.pinToggle === true,
    titleMaxChars: n(row.titleMaxChars, 3000),
    titleMaxBytes: n(row.titleMaxBytes, 3700),
  };
};

/** Official limits: fewer than `titleMaxChars` UTF-16 units of raw text and at most `titleMaxBytes` UTF-8 bytes trimmed. */
export const reminderTitleTooLong = (info: ReminderComposeInfo, raw: string) =>
  raw.length >= info.titleMaxChars || new TextEncoder().encode(raw.trim()).length > info.titleMaxBytes;

/** Repeat choices of the legacy compose modal. */
export const reminderRepeats = [
  { value: 0, title: 'Không lặp lại' },
  { value: 1, title: 'Hàng ngày' },
  { value: 2, title: 'Hàng tuần' },
  { value: 3, title: 'Hàng tháng' },
] as const;

/** WRITE: runs only from the "Tạo nhắc hẹn" button. */
export const createReminder = (conversationId: string, title: string, start: Date, repeat: number, pin: boolean) =>
  compose('createReminder', [conversationId, { title, startTime: Math.round(start.getTime()), repeat, needPin: pin }], 40);

// MARK: Official confirms / toasts

export const handleCompose = (state: Json) => {
  const event = obj(state.compose);
  if (!event) return;
  const conversation = str(event.convId) || null;
  if (event.kind === 'toast') {
    const text = str(event.text);
    if (text) showToast(text, conversation);
  } else if (event.kind === 'confirm' && typeof event.token === 'string') {
    const confirm: ComposerConfirm = {
      id: event.token,
      conversationId: conversation ?? '',
      title: str(event.title),
      message: str(event.message),
      ok: str(event.ok, 'OK'),
      cancel: str(event.cancel, 'Hủy'),
    };
    // One at a time, in the order asked.
    const s = getEngine();
    if (!s.composerConfirm) setEngine({ composerConfirm: confirm });
    else setEngine({ queuedComposerConfirms: [...s.queuedComposerConfirms, confirm] });
  }
};

export const answerComposerConfirm = (confirm: ComposerConfirm, ok: boolean) => {
  if (getEngine().composerConfirm?.id !== confirm.id) return;
  setEngine({ composerConfirm: null });
  callAdapter('__zaloCompose', 'answer', confirm.id, ok).catch(() => {});
  if (!getEngine().queuedComposerConfirms.length) return;
  // The next one after a beat, so the dialog closes and opens again with its own text.
  setTimeout(() => {
    const s = getEngine();
    if (s.composerConfirm || !s.queuedComposerConfirms.length) return;
    const [next, ...rest] = s.queuedComposerConfirms;
    setEngine({ composerConfirm: next, queuedComposerConfirms: rest });
  }, 300);
};

/** A page reload: its unanswered confirms are gone with it. */
export const dropComposerConfirms = () => setEngine({ composerConfirm: null, queuedComposerConfirms: [] });
