// Swift `MessageList`: the scrolling message list. Starts at the bottom, follows new messages while the reader is near
// the bottom (or the message is mine), pages older history in one page per pull with the reading position kept, and
// jumps to a pinned message.

import { ChevronDown } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { loadOlderMessages, react } from '../../engine/chat';
import type { ChatMessage } from '../../engine/models/chat';
import { selfConversationTitle, type ConversationSummary } from '../../engine/models/conversations';
import { ConversationAvatar } from '../conversations/ConversationRow';
import { useRemote } from '../../engine/remote';
import { useEngine } from '../../engine/store';
import { openTransfer } from '../transfer/hosts';
import { Spinner } from '../../ui/Spinner';
import { daySeparator, time } from './format';
import { MessageRow } from './MessageRow';
import { buildRows, groupByDay } from './rows';

const topBand = 120;
const nearBottomBand = 160;

export function MessageList({
  conversation,
  scrollToBottomTick,
  jumpTarget,
  onJumped,
  onReply,
}: {
  conversation: ConversationSummary;
  scrollToBottomTick: number;
  jumpTarget: string | null;
  onJumped: () => void;
  onReply: (m: ChatMessage) => void;
}) {
  const id = conversation.id;
  const msgs = useEngine((s) => s.messages[id]) ?? [];
  const hasMore = useEngine((s) => s.hasMoreHistory[id] ?? false);
  const historyTick = useEngine((s) => s.historyTicks[id] ?? 0);
  const rows = useMemo(() => buildRows(msgs), [msgs]);
  const days = useMemo(() => groupByDay(rows), [rows]);
  /** Zalo PC's "Tin nhắn mới" divider: the first message that was unread when the chat opened. */
  const [firstUnreadId] = useState(() => {
    const n = conversation.unread;
    const m = n > 0 && n <= msgs.length ? msgs[msgs.length - n] : null;
    return m && !m.isMine ? m.id : null;
  });
  const newestId = msgs[msgs.length - 1]?.id;

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [nearBottom, setNearBottom] = useState(true);
  /** Messages from others that arrived while the reader was scrolled up (badge on the scroll-to-bottom button). */
  const [unseen, setUnseen] = useState(0);
  useEffect(() => {
    if (nearBottom) setUnseen(0);
  }, [nearBottom]);
  const nearBottomRef = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const state = useRef({ atTop: false, armed: true, firstId: msgs[0]?.id, lastId: newestId, height: 0, top: 0, pending: 0 as number | ReturnType<typeof setTimeout>, giveUp: 0 as number | ReturnType<typeof setTimeout> });

  const scrollToBottom = (smooth: boolean) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  const record = () => {
    const el = scroller.current;
    if (!el) return;
    state.current.height = el.scrollHeight;
    state.current.top = el.scrollTop;
  };

  const maybeLoadOlder = () => {
    const st = state.current;
    if (!st.atTop || !st.armed || !hasMore || loadingOlder || msgs.length === 0) return;
    clearTimeout(st.pending);
    st.pending = setTimeout(() => {
      if (!state.current.atTop || !state.current.armed) return;
      setLoadingOlder(true);
      loadOlderMessages(id);
      clearTimeout(state.current.giveUp);
      // Give up the spinner if nothing arrives (and stop a short history from asking again until something changes).
      state.current.giveUp = setTimeout(() => {
        state.current.armed = false;
        setLoadingOlder(false);
      }, 6000);
    }, 250);
  };

  /** History too short to scroll: no scroll event can ever pull older pages, so it counts as being at the top. */
  const fillIfShort = () => {
    const el = scroller.current;
    if (!el || el.scrollHeight - el.clientHeight >= topBand) return;
    state.current.atTop = true;
    state.current.armed = true;
  };

  // Initial position: the bottom.
  useLayoutEffect(() => {
    scrollToBottom(false);
    record();
    fillIfShort();
    return () => {
      clearTimeout(state.current.pending);
      clearTimeout(state.current.giveUp);
    };
  }, []);

  // Content changed: older history prepended → keep the reading position; a new newest message → follow it when near
  // the bottom or when it is mine.
  useLayoutEffect(() => {
    const el = scroller.current;
    const st = state.current;
    if (!el) return;
    const firstId = msgs[0]?.id;
    const lastId = msgs[msgs.length - 1]?.id;
    const prepended = st.firstId !== undefined && firstId !== st.firstId && msgs.findIndex((m) => m.id === st.firstId) > 0;
    if (prepended) {
      el.scrollTop = el.scrollHeight - st.height + st.top;
      // One page per pull: wait for the reader to leave the top before the next one.
      st.armed = false;
      setLoadingOlder(false);
    } else if (lastId !== st.lastId && st.lastId !== undefined) {
      if (nearBottomRef.current || msgs[msgs.length - 1]?.isMine) scrollToBottom(true);
      else {
        const from = msgs.findIndex((m) => m.id === st.lastId);
        const fresh = from >= 0 ? msgs.slice(from + 1).filter((m) => !m.isMine).length : 1;
        if (fresh) setUnseen((n) => n + fresh);
      }
    }
    if (msgs.length !== 0 && st.firstId !== firstId) setLoadingOlder(false);
    st.firstId = firstId;
    st.lastId = lastId;
    record();
    fillIfShort();
  }, [msgs]);

  // Images settling change the height: stay pinned to the bottom while the reader is there.
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (nearBottomRef.current) scrollToBottom(false);
      record();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (scrollToBottomTick) scrollToBottom(true);
  }, [scrollToBottomTick]);

  // An older page arrived but every message in it is a hidden card: ask for the next one.
  useEffect(() => {
    if (!historyTick) return;
    setLoadingOlder(false);
    state.current.armed = true;
    maybeLoadOlder();
  }, [historyTick]);

  useEffect(() => {
    if (!hasMore) setLoadingOlder(false);
    maybeLoadOlder();
  }, [hasMore, msgs.length, loadingOlder]);

  useEffect(() => {
    if (!jumpTarget) return;
    const el = scroller.current?.querySelector(`[data-message-id="${CSS.escape(jumpTarget)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('is-flash');
      setTimeout(() => el.classList.remove('is-flash'), 1400);
    }
    onJumped();
  }, [jumpTarget, onJumped]);

  const onReact = useCallback((emoji: string, m: ChatMessage) => react(emoji, m.id, id), [id]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const st = state.current;
    const top = el.scrollTop < topBand;
    // Re-armed once the reader is away from the top, or when the history is too short to ever leave the top band.
    if (!st.armed && (!top || el.scrollHeight - el.clientHeight < topBand)) st.armed = true;
    st.atTop = top;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomBand;
    if (near !== nearBottomRef.current) {
      nearBottomRef.current = near;
      setNearBottom(near);
    }
    record();
    if (top) maybeLoadOlder();
  };

  return (
    <div className="message-list">
    <div className="message-scroller" ref={scroller} onScroll={onScroll}>
      <div className="message-content" ref={content}>
        {loadingOlder && (
          <div className="message-older">
            <Spinner size={14} />
          </div>
        )}
        {!hasMore && msgs.length > 0 && <ThreadStart conversation={conversation} />}
        {days.map((day) => (
          // One section per day: its date pill sticks only while its own messages are on screen.
          <section key={day.id} className="day-group">
            <div className="day-separator" role="heading" aria-level={3}>
              <span>
                <strong>{daySeparator(day.date)}</strong> {time(day.date)}
              </span>
            </div>
            {day.rows.map((row) => (
              <Fragment key={row.id}>
                {row.id === firstUnreadId && (
                  <div className="unread-divider">
                    <span>Tin nhắn mới</span>
                  </div>
                )}
                <MessageRow
                  message={row.message}
                  isGroup={conversation.isGroup}
                  firstInGroup={row.first}
                  lastInGroup={row.last}
                  showStatus={row.status}
                  album={row.album}
                  isNewest={row.id === newestId}
                  onReply={onReply}
                  onReact={onReact}
                />
              </Fragment>
            ))}
          </section>
        ))}
        <div style={{ height: 8 }} />
      </div>
    </div>
      {!nearBottom && (
        <button
          className="scroll-bottom circle-glass pop-in"
          onClick={() => scrollToBottom(true)}
          aria-label={unseen ? `${unseen} tin nhắn mới, cuộn xuống` : 'Cuộn xuống tin nhắn mới nhất'}
          title={unseen ? `${unseen} tin nhắn mới` : 'Cuộn xuống tin nhắn mới nhất'}
        >
          <ChevronDown size={16} strokeWidth={2.6} />
          {unseen > 0 && <span className="scroll-bottom-count nums">{unseen > 99 ? '99+' : unseen}</span>}
        </button>
      )}
    </div>
  );
}

/** The top of a fully loaded history (wave 4, after X / Pinterest DMs): who this is, and that it starts here. */
function ThreadStart({ conversation }: { conversation: ConversationSummary }) {
  const selfId = useEngine((s) => s.selfConversationId);
  const isSelf = conversation.id === selfId;
  // Zalo PC reads older history from the cloud only for groups (and Cloud của tôi): a 1-1 chat holds what arrived on
  // this computer plus what was synced from the phone, so the end of the local history is not the start of the chat.
  if (!isSelf && !conversation.isGroup) return <PhoneHistoryNote />;
  const name = isSelf ? selfConversationTitle : conversation.name;
  const sub = isSelf
    ? 'Lưu trữ và truy cập nhanh những nội dung quan trọng'
    : conversation.isGroup
      ? conversation.members > 0
        ? `${conversation.members} thành viên`
        : 'Nhóm'
      : null;
  return (
    <div className="thread-start">
      <ConversationAvatar conversation={conversation} size={64} isSelf={isSelf} />
      <div className="thread-start-name">{name}</div>
      {sub && <div className="thread-start-sub">{sub}</div>}
      <div className="thread-start-note">
        {isSelf ? 'Đây là nơi bạn lưu tin nhắn, ảnh và tệp cho riêng mình.' : conversation.isGroup ? `Đây là khởi đầu của nhóm ${name}.` : `Đây là khởi đầu cuộc trò chuyện của bạn với ${name}.`}
      </div>
    </div>
  );
}

/** Top of a 1-1 chat whose local history is read to the end: older messages live on the phone. */
function PhoneHistoryNote() {
  const canStartTransfer = useEngine((s) => s.canStartTransfer);
  const joined = useRemote((s) => s.mode === 'joined');
  return (
    <div className="thread-start thread-start-sync">
      <div className="thread-start-note">Tin nhắn cũ hơn nằm trên điện thoại của bạn. Đồng bộ để xem trên máy tính.</div>
      {!joined && canStartTransfer && (
        <button type="button" className="btn btn-small" onClick={openTransfer}>
          Đồng bộ tin nhắn
        </button>
      )}
    </div>
  );
}
