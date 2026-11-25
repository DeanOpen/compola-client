// Swift `MessageRow`: one message — a centered notice / e-card, or a bubble row with avatar, sender name, Tapback
// chips, the starred mark, the hover bar (time, react, reply, forward), the status line and the official context menu.

import {
  ArrowUpRight,
  Copy,
  Forward,
  ImageIcon,
  MoreHorizontal,
  Pin,
  PinOff,
  Quote,
  Reply,
  Star,
  StarOff,
  ThumbsUp,
  Trash2,
  Undo2,
} from 'lucide-react';
import { memo, useState, type ReactNode, type RefObject } from 'react';
import { copyPhoto, copyText, deleteForMe, pinMessage, recall, requestForward, requestUnpinMessage, setStarred } from '../../engine/messageActions';
import { captionOf, copyableText, type ChatMessage } from '../../engine/models/chat';
import { useIsViewer } from '../../engine/remote';
import { Avatar } from '../../ui/Avatar';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { BubbleContent } from './MessageContent';
import { statusText } from './format';
import { ECardView, NoticeRow } from './cards/Cards';
import { listScroll } from './listScroll';
import { ReactionChips } from './ReactionChips';
import { openContactProfile } from '../contacts/hosts';

export const reactionEmojis = ['❤️', '👍', '😆', '😮', '😢', '😡'];


interface Props {
  message: ChatMessage;
  isGroup: boolean;
  firstInGroup: boolean;
  lastInGroup: boolean;
  /** Status line only under my most recent message. */
  showStatus: boolean;
  isNewest: boolean;
  /** Photos of one send drawn as a mosaic (this row's message is the first). */
  album?: ChatMessage[];
  onReply: (m: ChatMessage) => void;
  onReact: (emoji: string, m: ChatMessage) => void;
}

export const MessageRow = memo(function MessageRow(props: Props) {
  const { message } = props;
  switch (message.kind.type) {
    case 'system':
      return (
        <div data-message-id={message.id}>
          <NoticeRow text={message.text} />
        </div>
      );
    case 'notice':
      return (
        <div data-message-id={message.id}>
          <NoticeRow symbol={message.kind.symbol} text={message.kind.text} buttons={message.cardButtons} message={message} />
        </div>
      );
    case 'ecard':
      return (
        <div data-message-id={message.id} aria-label={message.text}>
          <ECardView card={message.kind.card} message={message} />
        </div>
      );
    default:
      return <BubbleRow {...props} />;
  }
});

/** Tapping a sender's avatar or name opens their "Thông tin tài khoản" (Zalo PC). */
const openSender = (message: ChatMessage) =>
  openContactProfile(message.senderId, { name: message.senderName, avatar: message.senderAvatar ?? null });

function BubbleRow({ message, firstInGroup, lastInGroup, showStatus, isGroup, album, onReply, onReact }: Props) {
  const mine = message.isMine;
  const recalled = message.kind.type === 'recalled';
  const showsName = isGroup && !mine && firstInGroup;
  const myReactions = new Set(message.reactions.filter((r) => r.includesMe).map((r) => r.icon.emoji));
  // Joined to a Compola Server as a viewer: read and copy only.
  const readOnly = useIsViewer();
  const menu = () => messageMenu(message, onReply, onReact, readOnly);
  // The hover bar and the reaction strip exist only for the row under the pointer (or holding keyboard focus): drawn
  // for every row they were about a third of the chat's DOM (~13 hidden nodes and 8 SVG paths a row), all restyled,
  // laid out and hit-tested on every scroll frame.
  const [active, setActive] = useState(false);

  return (
    <div
      className={`bubble-row ${mine ? 'is-mine' : ''} ${firstInGroup ? 'is-first' : ''} ${message.reactions.length ? 'has-reactions' : ''}`}
      data-message-id={message.id}
      onContextMenu={(e) => openContextMenu(e, menu())}
      // Not while the list scrolls under a still pointer; the next real move over the row shows it.
      onMouseEnter={() => !listScroll.active && setActive(true)}
      onMouseMove={() => !active && !listScroll.active && setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setActive(false)}
    >
      {!mine && (
        <div className="bubble-avatar">
          {firstInGroup && (
            <button className="bubble-who" title={`Xem thông tin ${message.senderName}`} aria-label={`Xem thông tin ${message.senderName}`} onClick={() => openSender(message)}>
              <Avatar url={message.senderAvatar} name={message.senderName} size={40} />
            </button>
          )}
        </div>
      )}
      <div className="bubble-column">
        {showsName && (
          <button className="bubble-sender" onClick={() => openSender(message)}>
            {message.senderName}
          </button>
        )}
        <div className="bubble-stack" title={fullTime(message.date)}>
          <BubbleContent message={message} firstInGroup={firstInGroup} lastInGroup={lastInGroup} album={album} />
          {message.reactions.length > 0 && (
            <ReactionChips reactions={message.reactions} conversationId={message.conversationId} messageId={message.id} mine={mine} />
          )}
          {message.menu.starred && (
            <span className="bubble-star" title="Đã đánh dấu" aria-hidden>
              <Star size={9} fill="currentColor" strokeWidth={3} />
            </span>
          )}
          {/* Actions beside the bubble, aligned with its top edge: like · reply · forward · ⋯ (only for the active row) */}
          {active && (
          <div className="hover-bar" role="toolbar" aria-label="Thao tác tin nhắn">
            {/* Like: hovering it opens the six reactions. In the bar beside the bubble, so it never covers the time,
                the reaction chips or the delivery status under the bubble. */}
            {!recalled && !readOnly && (
              <div className="react-trigger">
                <button
                  className={`react-trigger-btn ${myReactions.size ? 'is-mine' : ''}`}
                  title="Thả cảm xúc"
                  aria-label="Thả 👍"
                  onClick={() => onReact(myReactions.size ? [...myReactions][0] : '👍', message)}
                >
                  {myReactions.size ? [...myReactions][0] : <ThumbsUp size={13} />}
                </button>
                <div className="react-strip" role="toolbar" aria-label="Cảm xúc">
                  {reactionEmojis.map((emoji) => (
                    <button
                      key={emoji}
                      className={`hover-reaction ${myReactions.has(emoji) ? 'is-selected' : ''}`}
                      title={`Thả ${emoji}`}
                      aria-label={`Thả ${emoji}`}
                      onClick={() => onReact(emoji, message)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!recalled && !readOnly && (
              <>
                <BarButton title="Trả lời" onClick={() => onReply(message)}>
                  <Quote size={14} />
                </BarButton>
                {message.menu.forward === 'available' && (
                  <BarButton title="Chia sẻ" onClick={() => requestForward(message)}>
                    <Forward size={14} />
                  </BarButton>
                )}
              </>
            )}
            <BarButton title="Thêm" onClick={(el) => openMenuBelow(el, menu(), mine ? 'start' : 'end')}>
              <MoreHorizontal size={14} />
            </BarButton>
          </div>
          )}
        </div>
        {mine && showStatus && <div className={`bubble-status-line ${message.status === 'failed' ? 'is-failed' : ''}`}>{statusText[message.status]}</div>}
      </div>
    </div>
  );
}

const fullTimeFormat = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fullTime = (ms: number) => fullTimeFormat.format(ms);

function BarButton({ title, onClick, children, refEl }: { title: string; onClick: (el: HTMLButtonElement) => void; children: ReactNode; refEl?: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={refEl} className="hover-button" title={title} aria-label={title} onClick={(e) => onClick(e.currentTarget)}>
      {children}
    </button>
  );
}

/** The six Zalo reactions, Tapback style. */
export function ReactionPicker({ mine, pick }: { mine: Set<string>; pick: (emoji: string) => void }) {
  return (
    <div className="reaction-picker">
      {reactionEmojis.map((emoji) => (
        <button key={emoji} className={`reaction-pick ${mine.has(emoji) ? 'is-selected' : ''}`} onClick={() => pick(emoji)} aria-label={emoji}>
          {emoji}
        </button>
      ))}
    </div>
  );
}

/**
 * The official message menu, in its order: quick actions (reply, forward), copy, reactions, pin / star, then recall
 * and delete. Which items show comes from the official builder (`message.menu`); copying follows "Chặn chia sẻ" too.
 * `readOnly` (a Compola Server viewer): copying only.
 */
const messageMenu = (
  message: ChatMessage,
  onReply: (m: ChatMessage) => void,
  onReact: (emoji: string, m: ChatMessage) => void,
  readOnly = false,
): MenuItem[] => {
  const a = message.menu;
  const items: MenuItem[] = [];
  const recalled = message.kind.type === 'recalled';
  if (readOnly) {
    if (recalled) return items;
    if (a.isProtected) return [{ kind: 'label', label: 'Trò chuyện này đã bật Chặn chia sẻ' }];
    const text = copyableText(message);
    if (text) items.push({ label: 'Copy tin nhắn', icon: Copy, onSelect: () => void copyText(text, message.conversationId) });
    if (message.kind.type === 'photo') items.push({ label: 'Copy hình ảnh', icon: ImageIcon, onSelect: () => void copyPhoto(message) });
    return items;
  }
  if (!recalled) {
    items.push({
      kind: 'reactions',
      emojis: reactionEmojis,
      selected: new Set(message.reactions.filter((r) => r.includesMe).map((r) => r.icon.emoji)),
      onPick: (emoji) => onReact(emoji, message),
    });
    items.push({ label: 'Trả lời', icon: Reply, onSelect: () => onReply(message) });
    if (a.forward !== 'hidden') items.push({ label: 'Chia sẻ', icon: ArrowUpRight, disabled: a.forward === 'blocked', onSelect: () => requestForward(message) });
    if (!a.isProtected) {
      const copies: MenuItem[] = [];
      const text = copyableText(message);
      if (text) copies.push({ label: 'Copy tin nhắn', icon: Copy, onSelect: () => void copyText(text, message.conversationId) });
      if (message.kind.type === 'photo') copies.push({ label: 'Copy hình ảnh', icon: ImageIcon, onSelect: () => void copyPhoto(message) });
      const caption = captionOf(message);
      if (caption) copies.push({ label: 'Copy chú thích', icon: Quote, onSelect: () => void copyText(caption, message.conversationId) });
      if (copies.length) items.push({ kind: 'separator' }, ...copies);
    }
    if (a.pin || a.star) {
      items.push({ kind: 'separator' });
      if (a.pinned) items.push({ label: 'Bỏ ghim tin nhắn', icon: PinOff, onSelect: () => requestUnpinMessage(message) });
      else if (a.pin) items.push({ label: 'Ghim tin nhắn', icon: Pin, onSelect: () => pinMessage(message) });
      if (a.star === 'unstar') items.push({ label: 'Bỏ đánh dấu tin nhắn', icon: StarOff, onSelect: () => setStarred(message, false) });
      else if (a.star === 'star') items.push({ label: 'Đánh dấu tin nhắn', icon: Star, onSelect: () => setStarred(message, true) });
      else if (a.star === 'blocked') items.push({ label: 'Đánh dấu tin nhắn', icon: Star, disabled: true, onSelect: () => {} });
    }
    if (a.isProtected) items.push({ kind: 'label', label: 'Trò chuyện này đã bật Chặn chia sẻ' });
  }
  // Destructive actions last, in red.
  if (a.recall || a.delete) {
    items.push({ kind: 'separator' });
    if (a.recall && !recalled) items.push({ label: 'Thu hồi', icon: Undo2, destructive: true, onSelect: () => recall(message) });
    if (a.delete)
      items.push({ label: a.delete === 'plain' ? 'Xóa' : 'Xóa chỉ ở phía tôi', icon: Trash2, destructive: true, onSelect: () => deleteForMe(message) });
  }
  return items;
};
