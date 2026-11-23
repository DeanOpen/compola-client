// Sheets of the composer toolbar (Swift ComposerSheets.swift): my contact card ("Gửi danh thiếp", the payload of the
// official SHARE_CONTACT modal) and a new reminder ("Tạo nhắc hẹn", the official legacy compose modal). Sending goes
// through engine/composer.ts, only from the sheet's button.

import { AlarmClock, ContactRound, Info } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  createReminder,
  myCard,
  reminderRepeats,
  reminderTitleTooLong,
  sendMyCard,
  type MyCardInfo,
  type ReminderComposeInfo,
} from '../../../engine/composer';
import type { ComposerOutcome } from '../../../engine/models/outcomes';
import { showToast } from '../../../engine/toast';
import { Avatar } from '../../../ui/Avatar';
import { Alert, Sheet, SheetHeader } from '../../../ui/Overlays';
import { Spinner } from '../../../ui/Spinner';

/** Footer: the failure (or what is still missing) on the left, Hủy and the action on the right. */
function SheetFooter({
  message,
  hint,
  action,
  busy,
  disabled,
  onCancel,
  onAction,
}: {
  message: string | null;
  hint?: string | null;
  action: string;
  busy: boolean;
  disabled: boolean;
  onCancel: () => void;
  onAction: () => void;
}) {
  return (
    <div className="sheet-footer">
      <span className={message ? 'sheet-footer-error' : 'secondary'}>{message ?? hint ?? ''}</span>
      <button className="btn btn-glass" onClick={onCancel}>
        Hủy
      </button>
      <button className="btn btn-prominent" disabled={disabled || busy} onClick={onAction}>
        {busy ? <Spinner size={12} /> : action}
      </button>
    </div>
  );
}

/** The outcome of a sheet's send: done closes, "no answer yet" closes with the notice, a failure stays with its text. */
const settle = (outcome: ComposerOutcome, conversationId: string, close: () => void, fail: (t: string) => void) => {
  switch (outcome.kind) {
    case 'done':
    case 'cancelled':
      return close();
    case 'pending':
      showToast(outcome.text, conversationId);
      return close();
    case 'failed':
      return fail(outcome.text);
  }
};

// MARK: Danh thiếp

export function MyCardSheet({ conversationId, conversationName, onClose }: { conversationId: string; conversationName: string; onClose: () => void }) {
  const [card, setCard] = useState<MyCardInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [withPhone, setWithPhone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void myCard().then((c) => {
      if (cancelled) return;
      setCard(c);
      setWithPhone((c?.withPhone ?? true) && !!c?.phone);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const send = async () => {
    if (!card || busy) return;
    setBusy(true);
    setMessage(null);
    const outcome = await sendMyCard(conversationId, withPhone);
    setBusy(false);
    settle(outcome, conversationId, onClose, setMessage);
  };

  return (
    <Sheet onClose={onClose} width={380}>
      <SheetHeader title="Gửi danh thiếp" onClose={onClose} />
      <div className="cs-body">
        {card ? (
          <>
            <div className="cs-card">
              <Avatar url={card.avatar} name={card.name || '?'} size={48} />
              <div className="cs-card-text">
                <div className="cs-card-name truncate">{card.name || 'Tài khoản của bạn'}</div>
                <div className="secondary truncate">{withPhone && card.phone ? card.phone : 'Danh thiếp Zalo'}</div>
              </div>
              <ContactRound size={18} className="tint" />
            </div>
            <label className={`poll-switch-row ${card.phone ? '' : 'is-disabled'}`}>
              <span className="poll-switch-label">Gửi kèm số điện thoại</span>
              <input type="checkbox" className="app-switch" checked={withPhone} disabled={!card.phone} onChange={(e) => setWithPhone(e.target.checked)} />
            </label>
            <div className="cs-note">Danh thiếp của bạn sẽ được gửi tới {conversationName}.</div>
          </>
        ) : loaded ? (
          <div className="cs-note cs-info">
            <Info size={14} /> Chưa đọc được hồ sơ của bạn từ Zalo. Hãy thử lại sau giây lát.
          </div>
        ) : (
          <div className="cs-loading">
            <Spinner />
          </div>
        )}
      </div>
      <SheetFooter message={message} action="Gửi" busy={busy} disabled={!card} onCancel={onClose} onAction={() => void send()} />
    </Sheet>
  );
}

// MARK: Nhắc hẹn

type TimeChoice = 'in15' | 'in30' | 'tomorrow9' | 'custom';

/** The modal's chips: seconds dropped, "9:00 ngày mai" in local time. */
export const reminderTime = (choice: TimeChoice, now = new Date()): Date => {
  const base = new Date(now);
  base.setSeconds(0, 0);
  switch (choice) {
    case 'in15':
      return new Date(base.getTime() + 15 * 60_000);
    case 'in30':
    case 'custom':
      return new Date(base.getTime() + 30 * 60_000);
    case 'tomorrow9': {
      const t = new Date(now);
      t.setDate(t.getDate() + 1);
      t.setHours(9, 0, 0, 0);
      return t;
    }
  }
};

const pad = (n: number) => String(n).padStart(2, '0');
/** `<input type="datetime-local">` value in local time. */
const localValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const whenFormat = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function ReminderComposeSheet({ conversationId, info, onClose }: { conversationId: string; info: ReminderComposeInfo; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [choice, setChoice] = useState<TimeChoice>('in30');
  const [start, setStart] = useState(() => reminderTime('in30'));
  const [repeat, setRepeat] = useState(0);
  const [pin, setPin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Re-evaluates "is the time still in the future" while the sheet stays open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(t);
  }, []);

  const trimmed = title.trim();
  const issue = useMemo(() => {
    if (!trimmed) return 'Vui lòng nhập nội dung nhắc hẹn';
    if (reminderTitleTooLong(info, title)) return 'Bạn đã nhập quá số kí tự cho phép';
    if (start.getTime() < now.getTime() - 59_000) return 'Vui lòng chọn thời gian tương lai';
    return null;
  }, [trimmed, title, start, now, info]);

  const pick = (next: TimeChoice) => {
    setChoice(next);
    if (next !== 'custom') setStart(reminderTime(next));
  };
  const requestClose = () => (trimmed ? setConfirmDiscard(true) : onClose());

  const create = async () => {
    const at = new Date();
    setNow(at);
    if (issue || busy || start.getTime() < at.getTime() - 59_000) return;
    setBusy(true);
    setMessage(null);
    const outcome = await createReminder(conversationId, title, start, repeat, info.canPin && pin);
    setBusy(false);
    settle(outcome, conversationId, onClose, setMessage);
  };

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  return (
    <Sheet onClose={requestClose} width={440}>
      <SheetHeader title="Tạo nhắc hẹn" onClose={requestClose} />
      <div className="cs-body">
        <label className="cs-field">
          <span className="cs-label">Nội dung</span>
          <textarea className="text-field cs-textarea" rows={3} value={title} placeholder="Nhập nội dung mới hoặc dán link" autoFocus onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="cs-field">
          <span className="cs-label">Chọn thời gian</span>
          <div className="cs-segmented" role="radiogroup" aria-label="Chọn thời gian">
            {(
              [
                ['in15', '15 phút nữa'],
                ['in30', '30 phút nữa'],
                ['tomorrow9', '9:00 ngày mai'],
                ['custom', 'Khác'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={choice === v} className={choice === v ? 'is-selected' : ''} onClick={() => pick(v)}>
                {label}
              </button>
            ))}
          </div>
          {choice === 'custom' ? (
            <input
              type="datetime-local"
              className="text-field"
              aria-label="Chọn ngày nhắc hẹn"
              min={localValue(today)}
              value={localValue(start)}
              onChange={(e) => {
                const d = new Date(e.target.value);
                if (!Number.isNaN(d.getTime())) setStart(d);
              }}
            />
          ) : (
            <div className="cs-when secondary">
              <AlarmClock size={14} /> {whenFormat.format(start)}
            </div>
          )}
        </div>
        <label className="cs-field cs-inline">
          <span className="cs-label">Lặp lại</span>
          <select className="text-field cs-select" value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>
            {reminderRepeats.map((r) => (
              <option key={r.value} value={r.value}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
        {info.pinToggle && (
          <label className="poll-switch-row">
            <span className="poll-switch-label">Ghim nhắc hẹn</span>
            <input type="checkbox" className="app-switch" checked={pin} onChange={(e) => setPin(e.target.checked)} />
          </label>
        )}
      </div>
      <SheetFooter message={message} hint={issue} action="Tạo nhắc hẹn" busy={busy} disabled={issue !== null} onCancel={requestClose} onAction={() => void create()} />
      {confirmDiscard && (
        <Alert
          title="Bạn muốn huỷ nhắc hẹn đang được tạo?"
          buttons={[
            { label: 'Hủy thay đổi', role: 'destructive', onClick: onClose },
            { label: 'Không', role: 'cancel', onClick: () => setConfirmDiscard(false) },
          ]}
        />
      )}
    </Sheet>
  );
}
