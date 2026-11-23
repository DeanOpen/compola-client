// What conversation actions ask the shell to show (Swift `ConversationPromptModifier`, `PinBoardSheet`,
// `HiddenChatSheet`, `PINEntryField`): the official delete confirmation, the full pin board ("Ghim hội thoại") and the
// hidden-chat PIN flows (hide, unhide, open, and from Settings: set / change / reset the PIN).

import { CheckCircle2, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  checkHiddenChatPIN,
  confirmDeleteConversation,
  hideConversation,
  hideConversationWithNewPIN,
  isHiddenConversation,
  pinBoard,
  pinReplacing,
  report,
  resetHiddenChatPIN,
  setConversationPrompt,
  setHiddenChatPIN,
  unhideConversation,
  unlockHiddenConversation,
  useConversationUI,
  type ActionResult,
  type PinBoard,
} from '../../engine/conversationActions';
import { displayName, selfConversationTitle } from '../../engine/models/conversations';
import { getEngine, useEngine } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { Alert, Sheet } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { back, conversationOf, flowTitle, pinAlreadyExists, startFlow, submitPIN, succeeded, takesPIN, wrongPIN, type Flow, type FlowKind, type Step } from './hiddenFlow';
import { LabelManagerHost } from './LabelManager';
import './conversationActions.css';

/** The shell opens a conversation once it was unlocked with the PIN. */
export function ConversationPrompts({ onUnlocked }: { onUnlocked: (id: string) => void }) {
  const prompt = useConversationUI((s) => s.prompt);
  const hasPIN = useEngine((s) => s.conversationActions.hasHiddenPIN);
  const unlockedId = useConversationUI((s) => s.unlockedId);
  const close = () => setConversationPrompt(null);
  let content = null;
  if (prompt?.kind === 'delete') {
    const id = prompt.id;
    content = (
      <Alert
        title="Toàn bộ nội dung trò chuyện sẽ bị xóa vĩnh viễn."
        message="Bạn có chắc chắn muốn xóa?"
        buttons={[
          {
            label: 'Xóa',
            role: 'destructive',
            onClick: () => {
              close();
              void confirmDeleteConversation(id);
            },
          },
          { label: 'Không', role: 'cancel', onClick: close },
        ]}
      />
    );
  } else if (prompt?.kind === 'pinBoard') content = <PinBoardSheet id={prompt.id} onClose={close} />;
  else if (prompt?.kind === 'hide') content = <HiddenChatSheet key={prompt.kind + prompt.id} kind={{ kind: 'hide', id: prompt.id }} hasPIN={hasPIN} onClose={close} onUnlocked={onUnlocked} />;
  else if (prompt?.kind === 'unhide')
    content = (
      <HiddenChatSheet key={prompt.kind + prompt.id} kind={{ kind: 'unhide', id: prompt.id, requiresPIN: unlockedId !== prompt.id }} hasPIN={hasPIN} onClose={close} onUnlocked={onUnlocked} />
    );
  else if (prompt?.kind === 'unlock') content = <HiddenChatSheet key={prompt.kind + prompt.id} kind={{ kind: 'open', id: prompt.id }} hasPIN onClose={close} onUnlocked={onUnlocked} />;
  else if (prompt?.kind === 'pinSettings') content = <HiddenChatSheet key={prompt.flow} kind={{ kind: prompt.flow }} hasPIN={hasPIN} onClose={close} onUnlocked={onUnlocked} />;
  return (
    <>
      {content}
      <LabelManagerHost />
    </>
  );
}

const nameOf = (id: string) => {
  const s = getEngine();
  if (isHiddenConversation(s, id)) return 'Trò chuyện ẩn';
  if (id === s.selfConversationId) return selfConversationTitle;
  const c = s.conversations.find((x) => x.id === id);
  return c ? displayName(c) : id.startsWith('g') ? 'Nhóm' : 'Người dùng Zalo';
};

// MARK: Pin board (official POP_PINNED_CONVERSATION)

function PinBoardSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const [board, setBoard] = useState<PinBoard | null | 'loading'>('loading');
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const conversations = useEngine((s) => s.conversations);
  useEffect(() => {
    void pinBoard(id).then(setBoard);
  }, [id]);
  const confirm = async () => {
    if (board === 'loading' || !board) return;
    setBusy(true);
    const r = await pinReplacing([...removed], id);
    setBusy(false);
    if (r.ok) return onClose();
    // The unpin may have gone through while the pin failed: show the board as it is now.
    setRemoved(new Set());
    const fresh = await pinBoard(id);
    if (!fresh) onClose();
    else setBoard(fresh);
  };
  const frees = board !== 'loading' && board !== null && board.items.length - removed.size < board.limit;
  return (
    <Sheet onClose={onClose} width={440}>
      <div className="ca-sheet">
        <div className="ca-title">Ghim hội thoại</div>
        {board === 'loading' ? (
          <div className="ca-loading">
            <Spinner />
          </div>
        ) : !board ? (
          <ContentUnavailable icon={Lock} title="Không tải được danh sách ghim" />
        ) : (
          <>
            <p className="ca-text">
              Bạn chỉ được ghim tối đa {board.limit} trò chuyện.
              <br />
              Để ghim trò chuyện <strong>{nameOf(id)}</strong>, vui lòng bỏ ghim ít nhất {board.need} trò chuyện bên dưới.
            </p>
            <div className="ca-list">
              {board.items
                .filter((x) => !removed.has(x))
                .map((x) => {
                  const hidden = isHiddenConversation(getEngine(), x);
                  const c = conversations.find((y) => y.id === x);
                  return (
                    <div key={x} className="ca-row">
                      {hidden ? (
                        <span className="ca-lock">
                          <Lock size={14} />
                        </span>
                      ) : (
                        <Avatar url={c?.avatar} name={nameOf(x)} size={36} />
                      )}
                      <span className="truncate" style={{ flex: 1 }}>
                        {nameOf(x)}
                      </span>
                      <button className="btn btn-glass btn-small" onClick={() => setRemoved(new Set([...removed, x]))}>
                        Bỏ ghim
                      </button>
                    </div>
                  );
                })}
            </div>
          </>
        )}
      </div>
      <div className="sheet-footer">
        <span />
        <button className="btn btn-glass" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-prominent" disabled={!frees || busy} onClick={() => void confirm()}>
          Ghim hội thoại
        </button>
      </div>
    </Sheet>
  );
}

// MARK: Hidden chats

export function HiddenChatSheet({
  kind,
  hasPIN,
  onClose,
  onUnlocked,
  onResult,
}: {
  kind: FlowKind;
  hasPIN: boolean;
  onClose: () => void;
  onUnlocked: (id: string) => void;
  /** Settings shows results inline instead of the toast. */
  onResult?: (r: ActionResult) => void;
}) {
  const [flow, setFlow] = useState<Flow>(() => startFlow(kind, hasPIN));
  const [busy, setBusy] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const id = conversationOf(flow);
  const name = id ? nameOf(id) : '';

  const finish = (r: ActionResult) => {
    if (onResult) onResult(r);
    else report(r);
    if (r.ok) onClose();
  };

  const fail = (text: string) => {
    setFlow((f) => ({ ...f, error: text }));
    setResetToken((t) => t + 1);
  };

  const run = async (step: Step, current: Flow) => {
    if (step.kind === 'none') return;
    setBusy(true);
    try {
      switch (step.kind) {
        case 'hide': {
          const r = await hideConversation(id!, step.pin);
          if (r.badPIN) fail(r.text);
          else finish(r);
          return;
        }
        case 'hideWithNewPIN': {
          const r = await hideConversationWithNewPIN(id!, step.pin);
          if (r.ok) setFlow(succeeded(current) ?? current);
          else if (r.pinExists) {
            setFlow(pinAlreadyExists(current));
            setResetToken((t) => t + 1);
          } else fail(r.text);
          return;
        }
        case 'unhide': {
          const r = await unhideConversation(id!, step.pin);
          if (r.badPIN) fail(r.text);
          else finish(r);
          return;
        }
        case 'verifyToOpen':
          if (await checkHiddenChatPIN(step.pin)) {
            unlockHiddenConversation(id!);
            onUnlocked(id!);
            onClose();
          } else fail(wrongPIN);
          return;
        case 'verifyOld':
          if (await checkHiddenChatPIN(step.pin)) setFlow({ ...current, error: null, screen: 'newPIN' });
          else setFlow({ ...current, error: wrongPIN });
          setResetToken((t) => t + 1);
          return;
        case 'setPIN': {
          const r = await setHiddenChatPIN(step.pin, step.changed);
          if (r.ok) setFlow(succeeded(current) ?? current);
          else if (r.pinExists) {
            setFlow(pinAlreadyExists(current));
            setResetToken((t) => t + 1);
          } else fail(r.text);
          return;
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const onPIN = (pin: string) => {
    const [next, step] = submitPIN(flow, pin);
    setFlow(next);
    setResetToken((t) => t + 1);
    void run(step, next);
  };

  const resetPIN = async () => {
    setBusy(true);
    const r = await resetHiddenChatPIN();
    setBusy(false);
    finish(r);
  };

  return (
    <Sheet onClose={onClose} width={400}>
      <div className="ca-sheet ca-center" aria-busy={busy}>
        <div className="ca-title">{flowTitle(flow)}</div>
        <FlowContent flow={flow} name={name} onPIN={onPIN} resetToken={resetToken} disabled={busy} />
        {flow.error && <div className="ca-error">{flow.error}</div>}
      </div>
      <div className="sheet-footer">
        <span />
        <FlowButtons
          flow={flow}
          busy={busy}
          onClose={onClose}
          onStartPIN={() => setFlow({ ...flow, error: null, screen: 'createPIN' })}
          onUnhide={() => void run({ kind: 'unhide', pin: null }, flow)}
          onReset={() => void resetPIN()}
          onBack={() => {
            setFlow(back(flow));
            setResetToken((t) => t + 1);
          }}
        />
      </div>
    </Sheet>
  );
}

function FlowContent({ flow, name, onPIN, resetToken, disabled }: { flow: Flow; name: string; onPIN: (pin: string) => void; resetToken: number; disabled: boolean }) {
  const notice = (
    <p className="ca-note">
      <strong>Chú ý: </strong>Ghi nhớ mã PIN để xem lại trò chuyện. Trò chuyện sẽ mất nếu bạn cài đặt lại mã PIN.
    </p>
  );
  const field = <PINField key={resetToken} onDone={onPIN} disabled={disabled} />;
  switch (flow.screen) {
    case 'introduce':
      return <p className="ca-text">Trò chuyện sẽ được ẩn khỏi danh sách tin nhắn. Chỉ có bạn mới có thể tìm thấy và mở lại chúng bằng cách sử dụng mã PIN.</p>;
    case 'createPIN':
      return (
        <>
          <p className="ca-text">Nhập mã PIN</p>
          {field}
          {notice}
        </>
      );
    case 'confirmPIN':
      return (
        <>
          <p className="ca-text">Nhập lại mã PIN của bạn</p>
          {field}
          {notice}
        </>
      );
    case 'enterPIN':
      return (
        <>
          {field}
          <p className="ca-note">
            Quên mã PIN? Bạn phải <strong>cài đặt lại mã.</strong>
          </p>
        </>
      );
    case 'unhideConfirm':
      return (
        <p className="ca-text">
          Bạn có muốn hiện lại trò chuyện <strong>{name}</strong> ?
        </p>
      );
    case 'oldPIN':
      return (
        <>
          <p className="ca-text">Nhập mã PIN cũ</p>
          {field}
        </>
      );
    case 'newPIN':
      return (
        <>
          <p className="ca-text">Nhập mã PIN mới</p>
          {field}
        </>
      );
    case 'repeatPIN':
      return (
        <>
          <p className="ca-text">Xác nhận lại mã PIN mới</p>
          {field}
        </>
      );
    case 'resetConfirm':
      return <p className="ca-text">Khi đặt lại mã PIN, tất cả trò chuyện đang được ẩn sẽ bị xoá (bao gồm toàn bộ nội dung cuộc trò chuyện). Bạn có muốn tiếp tục?</p>;
    case 'hideSuccess':
      return (
        <div className="ca-text">
          <p>
            Bạn đã ẩn trò chuyện <strong>{name}</strong> thành công.
          </p>
          <p>
            Để mở các trò chuyện đã ẩn, bạn có thể nhập <strong>mã PIN đã cài đặt hoặc tên trò chuyện ẩn</strong> tại khung tìm kiếm.
          </p>
          <p className="ca-note">
            Ngoài ra bạn có thể vào <strong>Cài đặt › Quyền riêng tư › Thiết lập ẩn trò chuyện</strong> để thay đổi hoặc đặt lại mã PIN.
          </p>
        </div>
      );
    case 'setPINSuccess':
      return (
        <div className="ca-success">
          <CheckCircle2 size={40} color="var(--success)" />
          <p className="ca-text">
            Chúc mừng bạn đã cài mã PIN thành công, bạn có thể dùng mã PIN này để ẩn các trò chuyện và mở lại các trò chuyện đã ẩn bằng cách tìm kiếm theo tên hoặc mã PIN vừa cài đặt.
          </p>
        </div>
      );
    case 'changeSuccess':
      return (
        <div className="ca-success">
          <CheckCircle2 size={40} color="var(--success)" />
          <p className="ca-text">Mã PIN của bạn đã được đổi thành công</p>
        </div>
      );
  }
}

function FlowButtons({
  flow,
  busy,
  onClose,
  onStartPIN,
  onUnhide,
  onReset,
  onBack,
}: {
  flow: Flow;
  busy: boolean;
  onClose: () => void;
  onStartPIN: () => void;
  onUnhide: () => void;
  onReset: () => void;
  onBack: () => void;
}) {
  const cancel = (
    <button className="btn btn-glass" onClick={onClose}>
      Hủy
    </button>
  );
  switch (flow.screen) {
    case 'introduce':
      return (
        <>
          {cancel}
          <button className="btn btn-prominent" onClick={onStartPIN}>
            Đặt mã PIN
          </button>
        </>
      );
    case 'unhideConfirm':
      return (
        <>
          {cancel}
          <button className="btn btn-prominent" disabled={busy} onClick={onUnhide}>
            Bỏ ẩn trò chuyện
          </button>
        </>
      );
    case 'resetConfirm':
      return (
        <>
          <button className="btn btn-glass" onClick={onClose}>
            Đóng
          </button>
          <button className="btn btn-prominent ca-danger" disabled={busy} onClick={onReset}>
            Đặt lại mã PIN
          </button>
        </>
      );
    case 'hideSuccess':
    case 'setPINSuccess':
    case 'changeSuccess':
      return (
        <button className="btn btn-prominent" onClick={onClose} autoFocus>
          Đóng
        </button>
      );
    case 'repeatPIN':
    case 'confirmPIN':
      return (
        <>
          <button className="btn btn-glass" onClick={onBack}>
            Quay lại
          </button>
          {cancel}
        </>
      );
    default:
      return takesPIN(flow) ? cancel : cancel;
  }
}

/** Four-digit PIN field (Swift `PINEntryField`): dots for the typed digits; calls `onDone` with the 4th digit. A password
 * input underneath keeps the digits out of autofill and screen readers' echo. */
export function PINField({ onDone, disabled = false }: { onDone: (pin: string) => void; disabled?: boolean }) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <div className="pin-field" onClick={() => input.current?.focus()}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={`pin-cell ${i < text.length ? 'is-filled' : ''} ${i === text.length ? 'is-current' : ''}`}>
          {i < text.length && <span className="pin-dot" />}
        </span>
      ))}
      <input
        ref={input}
        className="pin-input"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        aria-label="Mã PIN"
        disabled={disabled}
        value={text}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
          if (digits.length === 4) {
            setText('');
            onDone(digits);
          } else setText(digits);
        }}
      />
    </div>
  );
}
