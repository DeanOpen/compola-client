// Reminder cards (e-card `action.open.reminder`) and the reminder detail sheet (Swift ReminderViews.swift). The state —
// which variant the official client draws, who may answer, my answer — comes from the official reminder controller
// (engine/reminders.ts). While the controller has nothing to draw, the static card built from the message stays.

import { AlarmClock, ChevronLeft, ChevronRight, Clock, Repeat, User, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatMessage, ECard } from '../../../engine/models/chat';
import {
  followReminder,
  hasResponders,
  isDrawn,
  isRsvpBusy,
  reminderResponders,
  respondToReminder,
  responderSummary,
  showReminderDetail,
  showsRsvpButtons,
  showsRsvpStatus,
  useReminderDetail,
  useRsvpBusy,
  type ReminderPerson,
  type ReminderRequest,
  type ReminderResponders,
  type ReminderSnapshot,
} from '../../../engine/reminders';
import { Avatar } from '../../../ui/Avatar';
import { openMenuBelow } from '../../../ui/Menu';
import { Sheet } from '../../../ui/Overlays';
import { Spinner } from '../../../ui/Spinner';

const capitalize = (s: string) => (s ? s[0].toLocaleUpperCase('vi') + s.slice(1) : s);
const weekday = new Intl.DateTimeFormat('vi-VN', { weekday: 'long' });
const month = new Intl.DateTimeFormat('vi-VN', { month: 'long' });
const dateTime = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
const when = (d: Date) => capitalize(dateTime.format(d));

/** Follows the official controller for one card (null until it answers, or when it is not available). */
const useReminderSnapshot = (conversationId: string, messageId: string) => {
  const [snapshot, setSnapshot] = useState<ReminderSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!conversationId || !messageId) return;
    setSnapshot(null);
    setUnavailable(false);
    return followReminder(conversationId, messageId, setSnapshot, () => setUnavailable(true));
  }, [conversationId, messageId]);
  return { snapshot, unavailable };
};

export function ReminderCalendar({ start }: { start: Date | null }) {
  return (
    <div className="rm-calendar" aria-hidden>
      <div className="rm-calendar-head">{start ? capitalize(weekday.format(start)) : ''}</div>
      <div className="rm-calendar-day">{start ? start.getDate() : '--'}</div>
      <div className="rm-calendar-month">{start ? capitalize(month.format(start)) : ''}</div>
    </div>
  );
}

function ReminderMeta({ start, repeatLabel }: { start: Date | null; repeatLabel: string }) {
  return (
    <div className="rm-meta">
      {start && (
        <span>
          <Clock size={12} /> {when(start)}
        </span>
      )}
      {repeatLabel && (
        <span>
          <Repeat size={12} /> {repeatLabel}
        </span>
      )}
    </div>
  );
}

/** "Từ chối" | "Tham gia" (official `RsvpButtons`). */
function RsvpButtons({ s, conversationId, messageId }: { s: ReminderSnapshot; conversationId: string; messageId: string }) {
  const busy = useRsvpBusy((x) => x.busy);
  const locked = isRsvpBusy(busy, conversationId, s.id, messageId) || s.pending !== null;
  const button = (title: string, accept: boolean) => {
    const ref = accept ? 'accept' : 'reject';
    const sending = isRsvpBusy(busy, conversationId, s.id, messageId, ref) || s.pending === ref;
    return (
      <button className={`card-button ${accept ? '' : 'is-secondary'}`} disabled={locked} onClick={() => void respondToReminder(conversationId, messageId, s.id, accept)}>
        {sending ? <Spinner size={12} /> : title}
      </button>
    );
  };
  return (
    <div className="card-button-bar rm-rsvp">
      {button('Từ chối', false)}
      {button('Tham gia', true)}
    </div>
  );
}

/** "Bạn xác nhận: Tham gia · Thay đổi" (official `RsvpStatusBar` + `RsvpStatusMenu`). */
function RsvpStatus({ s, conversationId, messageId }: { s: ReminderSnapshot; conversationId: string; messageId: string }) {
  const busy = useRsvpBusy((x) => x.busy);
  const sending = isRsvpBusy(busy, conversationId, s.id, messageId) || s.pending !== null;
  return (
    <div className="rm-status">
      <span className="secondary">{s.mine === 'accept' ? 'Bạn xác nhận: Tham gia' : 'Bạn xác nhận: Từ chối'}</span>
      {sending ? (
        <Spinner size={12} />
      ) : (
        s.canRsvp &&
        !s.deleted && (
          <button
            className="rm-link"
            onClick={(e) =>
              openMenuBelow(
                e.currentTarget,
                [
                  { label: 'Tham gia', disabled: s.mine === 'accept', onSelect: () => void respondToReminder(conversationId, messageId, s.id, true) },
                  { label: 'Từ chối', disabled: s.mine === 'reject', onSelect: () => void respondToReminder(conversationId, messageId, s.id, false) },
                ],
                'end',
              )
            }
          >
            Thay đổi
          </button>
        )
      )}
    </div>
  );
}

/** The card in the chat: the official variant when the controller draws one, else the static card from the message. */
export function ReminderCardView({ card, message }: { card: ECard; message: ChatMessage }) {
  const { conversationId, id: messageId } = message;
  const { snapshot: s } = useReminderSnapshot(conversationId, messageId);
  const show = (openList = false) => showReminderDetail({ conversationId, messageId, openList });

  if (!s || !isDrawn(s)) {
    return (
      <div className="ecard-wrap">
        <button className="rm-card card-chrome rm-static" onClick={() => show()} title="Xem chi tiết">
          <ReminderCalendar start={card.reminderStart ? new Date(card.reminderStart) : null} />
          <span className="rm-text">
            <span className="rm-title clamp-3">{card.reminderTitle || card.title || 'Nhắc hẹn'}</span>
            <ReminderMeta start={card.reminderStart ? new Date(card.reminderStart) : null} repeatLabel={card.reminderRepeat} />
          </span>
        </button>
      </div>
    );
  }

  if (s.variant === 'demotedCreate' || s.variant === 'demotedAlert') {
    const at = s.start ? when(s.start) : '';
    const text =
      s.variant === 'demotedAlert'
        ? `Nhắc hẹn: ${s.title} - ${at}`
        : s.onlyMe
          ? `(Chỉ bạn nhìn thấy) Bạn đã tạo nhắc hẹn mới ${s.title} - ${at}.`
          : `${s.creatorName} tạo nhắc hẹn mới ${s.title} - ${at}.`;
    return (
      <div className="rm-demoted">
        <span>{text}</span>{' '}
        <button className="rm-link" onClick={() => show()}>
          Xem
        </button>
      </div>
    );
  }

  if (s.variant === 'alert') {
    return (
      <div className="ecard-wrap">
        <div className="rm-card card-chrome">
          <div className="rm-alert">
            <AlarmClock size={22} color="var(--warning)" />
            <span className="rm-text">
              {s.onlyMe && <span className="rm-small secondary">(Chỉ bạn nhìn thấy)</span>}
              <span className={`rm-title clamp-3 ${s.deleted ? 'is-deleted' : ''}`}>Nhắc hẹn: {s.title}</span>
              {s.start && <span className="rm-small secondary">{when(s.start)}</span>}
            </span>
          </div>
          <div className="card-button-bar">
            <button className="card-button" onClick={() => show()}>
              Xem chi tiết
            </button>
          </div>
        </div>
      </div>
    );
  }

  // `MessageInviteCard`
  return (
    <div className="ecard-wrap">
      <div className="rm-card card-chrome">
        <button className="rm-invite" onClick={() => show()} title="Xem chi tiết">
          {s.onlyMe && <span className="rm-small secondary">(Chỉ bạn nhìn thấy)</span>}
          {s.creatorName && <span className="rm-small secondary">{s.creatorName} tạo nhắc hẹn</span>}
          <span className="rm-row">
            <ReminderCalendar start={s.start} />
            <span className="rm-text">
              <span className={`rm-title clamp-3 ${s.deleted ? 'is-deleted' : ''}`}>{s.title || 'Nhắc hẹn'}</span>
              <ReminderMeta start={s.start} repeatLabel={s.repeatLabel} />
            </span>
          </span>
          {s.deleted && <span className="rm-small rm-warning">Nhắc hẹn đã bị xoá</span>}
        </button>
        {hasResponders(s) && (
          <button className="rm-responders" disabled={s.deleted} onClick={() => show(true)}>
            <Users size={13} /> <span>Danh sách tham gia</span>
            {!s.deleted && <ChevronRight size={12} />}
          </button>
        )}
        {showsRsvpButtons(s) ? (
          <RsvpButtons s={s} conversationId={conversationId} messageId={messageId} />
        ) : showsRsvpStatus(s) ? (
          <RsvpStatus s={s} conversationId={conversationId} messageId={messageId} />
        ) : null}
      </div>
    </div>
  );
}

// MARK: Detail sheet

/** Rendered by the chat: the detail of the reminder whose card was clicked. */
export function ReminderDetailHost({ conversationId }: { conversationId: string }) {
  const request = useReminderDetail((s) => s.request);
  useEffect(() => () => showReminderDetail(null), [conversationId]);
  if (!request || request.conversationId !== conversationId) return null;
  return <ReminderDetailSheet key={request.messageId} request={request} onClose={() => showReminderDetail(null)} />;
}

type Responders = { state: 'idle' | 'loading' | 'failed' } | { state: 'ready'; list: ReminderResponders };

function ReminderDetailSheet({ request, onClose }: { request: ReminderRequest; onClose: () => void }) {
  const { conversationId, messageId } = request;
  const { snapshot: s, unavailable } = useReminderSnapshot(conversationId, messageId);
  const [showingList, setShowingList] = useState(request.openList);
  const [responders, setResponders] = useState<Responders>({ state: 'idle' });
  const [tab, setTab] = useState<'accept' | 'reject'>('accept');

  const load = async () => {
    setResponders({ state: 'loading' });
    const list = await reminderResponders(conversationId, messageId);
    setResponders(list ? { state: 'ready', list } : { state: 'failed' });
  };
  useEffect(() => {
    if (showingList) void load();
  }, [showingList]);

  const close = (
    <div className="rm-sheet-footer">
      <button className="btn btn-glass" onClick={onClose}>
        Đóng
      </button>
    </div>
  );

  if (showingList && (s === null || hasResponders(s))) {
    const list = responders.state === 'ready' ? responders.list : null;
    const peopleOf = list ? (tab === 'accept' ? list.accept : list.reject) : [];
    const more = list ? (tab === 'accept' ? list.acceptMore : list.rejectMore) : 0;
    return (
      <Sheet onClose={onClose} width={360}>
        <div className="rm-sheet">
          <div className="rm-sheet-head">
            <button className="icon-button" onClick={() => setShowingList(false)} title="Quay lại" aria-label="Quay lại">
              <ChevronLeft size={16} />
            </button>
            <span className="rm-sheet-title">Danh sách tham gia</span>
          </div>
          <div className="cs-segmented" role="tablist">
            {(['accept', 'reject'] as const).map((t) => {
              const n = list ? (t === 'accept' ? list.acceptTotal : list.rejectTotal) : null;
              const title = t === 'accept' ? 'Tham gia' : 'Từ chối';
              return (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-selected' : ''} onClick={() => setTab(t)}>
                  {n === null ? title : `${title} ${n}`}
                </button>
              );
            })}
          </div>
          <div className="rm-people">
            {responders.state === 'ready' ? (
              peopleOf.length === 0 ? (
                <div className="rm-empty secondary">{tab === 'accept' ? 'Chưa có ai tham gia.' : 'Chưa có ai từ chối.'}</div>
              ) : (
                <>
                  {peopleOf.map((p: ReminderPerson) => (
                    <div key={p.uid} className="rm-person">
                      <Avatar url={p.avatar} name={p.name || '?'} size={32} />
                      <span className="truncate">{p.isMe ? 'Bạn' : p.name || 'Người dùng Zalo'}</span>
                    </div>
                  ))}
                  {more > 0 && <div className="rm-empty secondary">và {more} người khác</div>}
                </>
              )
            ) : responders.state === 'failed' ? (
              <div className="rm-empty">
                <span className="secondary">Có lỗi xảy ra</span>
                <button className="btn btn-glass btn-small" onClick={() => void load()}>
                  Thử lại
                </button>
              </div>
            ) : (
              <div className="rm-empty">
                <Spinner size={14} />
              </div>
            )}
          </div>
        </div>
        {close}
      </Sheet>
    );
  }

  const summary = s && hasResponders(s) ? responderSummary(s) : null;
  return (
    <Sheet onClose={onClose} width={360}>
      <div className="rm-sheet">
        <div className="rm-row">
          <ReminderCalendar start={s?.start ?? null} />
          <span className="rm-text">
            <span className={`rm-sheet-title ${s?.deleted ? 'is-deleted' : ''}`}>{s?.title || 'Nhắc hẹn'}</span>
            <ReminderMeta start={s?.start ?? null} repeatLabel={s?.repeatLabel ?? ''} />
          </span>
        </div>
        {s ? (
          <>
            {s.onlyMe ? (
              <div className="rm-small secondary">Chỉ bạn nhìn thấy</div>
            ) : (
              s.creatorName && (
                <div className="rm-small secondary rm-inline">
                  <User size={13} /> {s.creatorName} tạo nhắc hẹn
                </div>
              )
            )}
            {summary && (
              <button className="rm-responders is-inline" disabled={s.deleted} onClick={() => setShowingList(true)}>
                <Users size={13} /> <span>{summary}</span>
                {!s.deleted && <ChevronRight size={12} />}
              </button>
            )}
            {s.deleted ? (
              <div className="rm-small rm-warning">Nhắc hẹn đã bị xoá</div>
            ) : showsRsvpButtons(s) ? (
              <div className="rm-rsvp-box">
                <RsvpButtons s={s} conversationId={conversationId} messageId={messageId} />
              </div>
            ) : showsRsvpStatus(s) ? (
              <RsvpStatus s={s} conversationId={conversationId} messageId={messageId} />
            ) : null}
          </>
        ) : unavailable ? (
          <div className="rm-small secondary">Không tải được chi tiết nhắc hẹn lúc này.</div>
        ) : (
          <Spinner size={14} />
        )}
      </div>
      {close}
    </Sheet>
  );
}
