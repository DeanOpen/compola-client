// Rows of the conversation list column (Swift ConversationListRows.swift): the two-line row, the Messages-style pinned
// tile, the avatar with the group badge.

import { BellOff, Cloud, Pin, Users } from 'lucide-react';
import { memo } from 'react';
import { cssColor, displayName, selfConversationTitle, type ConversationLabel, type ConversationSummary, type StrangerBox } from '../../engine/models/conversations';
import { Avatar } from '../../ui/Avatar';
import { useGroupMosaic } from '../../engine/groupMosaic';
import { listTime, tileName } from './support';

/** Conversation avatar: remote photo, tinted cloud for "Cloud của tôi", a small people badge on groups. */
export function ConversationAvatar({ conversation, size, isSelf }: { conversation: ConversationSummary; size: number; isSelf: boolean }) {
  const badge = Math.max(15, size * 0.34);
  return (
    <span className="conv-avatar" style={{ width: size, height: size }}>
      {isSelf ? (
        <span className="conv-avatar-cloud" style={{ width: size, height: size }}>
          <Cloud size={size * 0.45} fill="currentColor" strokeWidth={1.5} />
        </span>
      ) : conversation.isGroup && !conversation.avatar ? (
        <GroupMosaic conversation={conversation} size={size} />
      ) : (
        <Avatar url={conversation.avatar} name={displayName(conversation)} size={size} />
      )}
      {conversation.isGroup && !isSelf && conversation.avatar && (
        <span className="conv-avatar-group" style={{ width: badge, height: badge }}>
          <Users size={badge * 0.5} strokeWidth={2.6} />
        </span>
      )}
    </span>
  );
}

/**
 * Zalo's group avatar when the group has no photo of its own: up to four member avatars in a 2×2 mosaic; with more than
 * four members the last tile is the member count. Initials while the members are not known.
 */
export function GroupMosaic({ conversation, size }: { conversation: ConversationSummary; size: number }) {
  const members = useGroupMosaic(conversation.id, true);
  if (members.length < 2) return <Avatar url={null} name={displayName(conversation)} size={size} />;
  const tile = Math.round(size * 0.52);
  const shown = conversation.members > 4 ? members.slice(0, 3) : members.slice(0, 4);
  const rest = conversation.members > 4 ? conversation.members - 3 : 0;
  return (
    <span className={`group-mosaic is-${Math.min(4, shown.length + (rest ? 1 : 0))}`} style={{ width: size, height: size }} aria-hidden>
      {shown.map((m, i) => (
        <span key={i} className="group-mosaic-tile">
          <Avatar url={m.avatar} name={m.name} size={tile} />
        </span>
      ))}
      {rest > 0 && (
        <span className="group-mosaic-tile group-mosaic-count" style={{ width: tile, height: tile, fontSize: tile * 0.4 }}>
          {rest > 99 ? '99+' : rest}
        </span>
      )}
    </span>
  );
}

export function UnreadBadge({ count, muted }: { count: number; muted: boolean }) {
  return (
    <span className={`badge ${muted ? 'is-muted' : ''}`} aria-label={`${count} tin chưa đọc`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function LabelTag({ label }: { label: ConversationLabel }) {
  const color = cssColor(label.colorHex) ?? 'var(--accent)';
  return (
    <span className="label-tag" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }} title={label.name}>
      {label.name}
    </span>
  );
}

export const ConversationRow = memo(function ConversationRow({
  conversation,
  label,
  showsPin,
  unreadMark,
  isStranger,
  isSelf,
  muted,
  typing,
  selected,
  onSelect,
  onContextMenu,
}: {
  conversation: ConversationSummary;
  label: ConversationLabel | null;
  showsPin: boolean;
  unreadMark: boolean;
  isStranger: boolean;
  isSelf: boolean;
  muted: boolean;
  typing: string | undefined;
  selected: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
}) {
  const unread = conversation.unread > 0;
  const p = conversation.preview;
  const subtitle =
    p && p.text
      ? (p.fromMe ? 'Bạn: ' : '') + p.text
      : conversation.isGroup && conversation.members > 0
        ? `${conversation.members} thành viên`
        : isSelf
          ? 'Lưu trữ và truy cập nhanh những nội dung quan trọng'
          : conversation.isGroup
            ? 'Nhóm'
            : isStranger
              ? 'Chưa là bạn'
              : 'Bạn bè';
  return (
    <div
      role="option"
      aria-selected={selected}
      data-id={conversation.id}
      className={`conv-row ${selected ? 'is-selected' : ''} ${unread ? 'is-unread' : ''}`}
      onMouseDown={() => onSelect(conversation.id)}
      onContextMenu={(e) => onContextMenu(e, conversation.id)}
    >
      <ConversationAvatar conversation={conversation} size={48} isSelf={isSelf} />
      <div className="conv-row-body">
        <div className="conv-row-top">
          <span className="conv-row-name truncate">{isSelf ? selfConversationTitle : displayName(conversation)}</span>
          {label && <LabelTag label={label} />}
          {isStranger && !isSelf && <span className="stranger-badge">Người lạ</span>}
          {muted && <BellOff size={10} className="conv-row-muted" aria-label="Đã tắt thông báo" />}
          <span className="conv-row-spacer" />
          {p?.date && <span className="conv-row-time nums">{listTime(p.date)}</span>}
        </div>
        <div className="conv-row-bottom">
          {typing ? (
            <span className="conv-row-preview is-typing truncate">{typing} đang soạn tin…</span>
          ) : (
            <span className="conv-row-preview truncate">{subtitle}</span>
          )}
          {unread ? (
            <UnreadBadge count={conversation.unread} muted={muted} />
          ) : unreadMark ? (
            <span className="unread-dot" title="Đánh dấu chưa đọc" />
          ) : showsPin ? (
            <Pin size={12} className="conv-row-pin" aria-label="Đã ghim" />
          ) : null}
        </div>
      </div>
    </div>
  );
});

/** A pinned conversation as a tile (avatar, short name, unread badge); ⌘1…⌘9 open the first nine. */
export function PinTile({
  conversation,
  index,
  isSelf,
  selected,
  muted,
  unreadMark,
  onSelect,
  onContextMenu,
}: {
  conversation: ConversationSummary;
  index: number;
  isSelf: boolean;
  selected: boolean;
  muted: boolean;
  unreadMark: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
}) {
  const name = isSelf ? selfConversationTitle : displayName(conversation);
  const unread = conversation.unread > 0;
  return (
    <button
      className={`pin-tile ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(conversation.id)}
      onContextMenu={(e) => onContextMenu(e, conversation.id)}
      title={index < 9 ? `${name} (⌘${index + 1})` : name}
      aria-label={name}
      aria-pressed={selected}
    >
      <span className="pin-tile-avatar">
        <ConversationAvatar conversation={conversation} size={54} isSelf={isSelf} />
        {unread ? (
          <span className="pin-tile-badge">
            <UnreadBadge count={conversation.unread} muted={muted} />
          </span>
        ) : unreadMark ? (
          <span className="pin-tile-dot unread-dot" />
        ) : null}
      </span>
      <span className={`pin-tile-name truncate ${unread ? 'is-unread' : ''}`}>{tileName(conversation, isSelf)}</span>
    </button>
  );
}

/** The official stranger pseudo-row ("Tin nhắn từ người lạ") opening the folder. */
export function StrangerBoxRow({ box, newest, onOpen }: { box: StrangerBox; newest: ConversationSummary | null; onOpen: () => void }) {
  return (
    <div className="conv-row" role="option" aria-selected={false} onMouseDown={onOpen}>
      <span className="conv-avatar stranger-box-avatar" style={{ width: 48, height: 48 }}>
        <Users size={20} />
      </span>
      <div className="conv-row-body">
        <div className="conv-row-top">
          <span className="conv-row-name truncate">Tin nhắn từ người lạ</span>
          <span className="conv-row-spacer" />
          {newest?.preview?.date && <span className="conv-row-time nums">{listTime(newest.preview.date)}</span>}
        </div>
        <div className="conv-row-bottom">
          <span className="conv-row-preview truncate">
            {newest ? `${displayName(newest)}: ${newest.preview?.text ?? ''}` : `${box.chats} cuộc trò chuyện`}
          </span>
          {box.unreadChats > 0 && <UnreadBadge count={box.unreadChats} muted={false} />}
        </div>
      </div>
    </div>
  );
}
