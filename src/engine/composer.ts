// Composer "+" actions bridged to `host-scripts/composer-adapter.js` (`window.__zaloCompose`). Port of the parts of
// ZaloEngine+Composer.swift the adapters allow without native pickers: photo/video and file sends (through the Rust
// file-input answer, see `callAdapterWithFiles`), official confirms and toasts. Screenshot, my card and reminders are
// later waves.

import { callAdapter, callAdapterWithFiles, log, raceTimeout } from './call';
import { obj, str, type Json } from './models/json';
import { noAnswerText, parseComposerOutcome, type ComposerOutcome } from './models/outcomes';
import { getEngine, setEngine, type ComposerConfirm } from './store';
import { showToast } from './toast';

const composeWithFiles = async (method: string, args: unknown[], kind: 'media' | 'files'): Promise<ComposerOutcome> => {
  let call: Promise<unknown>;
  try {
    call = callAdapterWithFiles('__zaloCompose', method, args, { paths: null, kind });
  } catch (e) {
    call = Promise.reject(e);
  }
  // Photos are processed before the call returns; the uploads themselves continue in the page.
  const answer = await raceTimeout(
    180,
    call.catch((e: unknown) => {
      const text = String(e);
      log(`compose ${method} → ${text}`);
      return { status: 'error', text: /engine_call_with_files|not found|unknown command/i.test(text) ? 'Chưa hỗ trợ gửi tệp trên phiên bản này.' : undefined };
    }),
  );
  if (!answer) return { kind: 'pending', text: noAnswerText };
  const outcome = parseComposerOutcome(answer.value);
  log(`compose ${method} → ${outcome.kind}`);
  return outcome;
};

/** "Ảnh hoặc Video": photos through the official photo button's path, videos and other files as files. */
export const sendMedia = (conversationId: string) => composeWithFiles('sendMedia', [conversationId], 'media');

/** "Tệp": the official file button's path. */
export const sendFiles = (conversationId: string) => composeWithFiles('sendFiles', [conversationId], 'files');

/** Shows a failure or pending text for a composer action as the conversation's toast. */
export const reportComposer = (outcome: ComposerOutcome, conversationId: string) => {
  if (outcome.kind === 'failed' || outcome.kind === 'pending') showToast(outcome.text, conversationId || null);
};

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
