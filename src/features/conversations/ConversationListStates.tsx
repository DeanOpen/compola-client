// Non-list states of the conversation list column (Swift ConversationListStates.swift).

import { Archive, CheckCircle2, EyeOff, MessagesSquare, Search, Tag, UserRoundSearch, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
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

/** "Đang đồng bộ hội thoại…" while the list (or the hidden-chat state it depends on) has not arrived. */
export function ConversationListLoading({ stalled = false }: { stalled?: boolean }) {
  return (
    <div className="conv-loading">
      <Spinner size={18} />
      <span>{stalled ? hiddenStateStalledText : 'Đang đồng bộ hội thoại…'}</span>
    </div>
  );
}

/** Empty list of one mailbox, or no search result. */
export function ConversationListEmpty({ destination, searchText, hiddenEnabled }: { destination: Destination; searchText: string | null; hiddenEnabled: boolean }) {
  if (searchText !== null) {
    return (
      <ContentUnavailable
        icon={Search}
        title={`Không có kết quả cho “${searchText}”`}
        description={hiddenEnabled ? 'Thử tìm theo tên, hoặc nhập mã PIN để xem trò chuyện ẩn.' : 'Thử tìm theo tên người hoặc nhóm.'}
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
  return <ContentUnavailable icon={icon} title={title} description={message} />;
}
