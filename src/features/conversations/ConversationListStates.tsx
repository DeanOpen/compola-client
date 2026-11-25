// Non-list states of the conversation list column (Swift ConversationListStates.swift).

import { Archive, CheckCircle2, EyeOff, MessagesSquare, Search, Tag, UserRoundSearch, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { isLabel, type Destination } from '../../shell/shellStore';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { Spinner } from '../../ui/Spinner';
import { hiddenStateStalledText } from '../../engine/conversationActions';

/** Explanatory strip at the top of the stranger / "Khác" / unlocked-hidden mailboxes. */
export function ListBanner({
  icon: Icon,
  lead,
  separator = ' ',
  children,
  actionTitle,
  onAction,
}: {
  icon: LucideIcon;
  lead: string;
  separator?: ReactNode;
  children: ReactNode;
  actionTitle?: string;
  onAction?: () => void;
}) {
  return (
    <div className="list-banner">
      <Icon size={16} className="tint" style={{ flex: 'none' }} />
      <div className="list-banner-text">
        <strong>{lead}</strong>
        {separator}
        {children}
      </div>
      {actionTitle && onAction && (
        <button className="btn btn-glass btn-small" onClick={onAction}>
          {actionTitle}
        </button>
      )}
    </div>
  );
}

/** "Đang tải hội thoại…" while the list (or the hidden-chat state it depends on) has not arrived: a status line over
 * skeleton rows shaped like the real ones (wave 4, after Contra), so the column does not jump when the list lands. */
export function ConversationListLoading({ stalled = false }: { stalled?: boolean }) {
  return (
    <div className="conv-loading" aria-busy>
      <div className="conv-loading-status">
        <Spinner size={13} />
        <span>{stalled ? hiddenStateStalledText : 'Đang tải hội thoại…'}</span>
      </div>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="conv-skeleton" aria-hidden style={{ opacity: 1 - i * 0.12 }}>
          <span className="conv-skeleton-avatar" />
          <span className="conv-skeleton-lines">
            <span style={{ width: `${62 - (i % 3) * 12}%` }} />
            <span style={{ width: `${84 - (i % 2) * 20}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Over the startup cache (the list saved when the app last ran) while the official client boots: says the list may be
 * a little behind and that what is clicked or sent runs as soon as Zalo is connected. */
export function ConnectingStrip() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="conv-connecting" role="status">
      <Spinner size={12} />
      <span>{slow ? 'Vẫn đang kết nối Zalo. Tin nhắn mới sẽ hiện khi xong.' : 'Đang kết nối Zalo, đang hiện dữ liệu đã lưu'}</span>
    </div>
  );
}

/** Empty list of one mailbox, or no search result. */
export function ConversationListEmpty({
  destination,
  searchText,
  hiddenEnabled,
  onClearSearch,
  onShowAll,
}: {
  destination: Destination;
  searchText: string | null;
  hiddenEnabled: boolean;
  /** "Xóa tìm kiếm" under a search without results. */
  onClearSearch?: () => void;
  /** "Xem tất cả tin nhắn" under an empty filter (Chưa đọc, Khác, a label) — wave 4, after Front's "Clear filter". */
  onShowAll?: () => void;
}) {
  if (searchText !== null) {
    return (
      <ContentUnavailable
        icon={Search}
        title={`Không có kết quả cho “${searchText}”`}
        description={hiddenEnabled ? 'Thử tìm theo tên, hoặc nhập mã PIN để xem trò chuyện ẩn.' : 'Thử tìm theo tên người hoặc nhóm.'}
        actions={
          onClearSearch && (
            <button className="btn btn-glass btn-small" onClick={onClearSearch}>
              Xóa tìm kiếm
            </button>
          )
        }
      />
    );
  }
  const [icon, title, message]: [LucideIcon, string, string] =
    destination === 'unread'
      ? [CheckCircle2, 'Không có tin nhắn chưa đọc', 'Bạn đã đọc hết mọi cuộc trò chuyện.']
      : destination === 'strangers'
        ? [UserRoundSearch, 'Không có tin nhắn từ người lạ', 'Tin nhắn từ người chưa kết bạn sẽ hiện ở đây.']
        : destination === 'hidden'
          ? [EyeOff, 'Chưa có trò chuyện ẩn', 'Chuột phải vào một cuộc trò chuyện và chọn Ẩn trò chuyện.']
          : destination === 'other'
            ? [Archive, 'Mục Khác đang trống', 'Chuột phải vào một cuộc trò chuyện để chuyển nó sang Khác.']
            : isLabel(destination)
              ? [Tag, 'Chưa có cuộc trò chuyện', 'Chuột phải vào một cuộc trò chuyện và chọn Phân loại để gắn nhãn này.']
              : [MessagesSquare, 'Chưa có cuộc trò chuyện', 'Cuộc trò chuyện mới sẽ hiện ở đây.'];
  const filtered = destination === 'unread' || destination === 'other' || isLabel(destination);
  return (
    <ContentUnavailable
      icon={icon}
      title={title}
      description={message}
      actions={
        filtered && onShowAll ? (
          <button className="btn btn-glass btn-small" onClick={onShowAll}>
            Xem tất cả tin nhắn
          </button>
        ) : undefined
      }
    />
  );
}
