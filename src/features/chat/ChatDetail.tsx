import { MessagesSquare } from 'lucide-react';
import { useMemo } from 'react';
import { selfConversationTitle, type ConversationSummary } from '../../engine/models/conversations';
import { useEngine } from '../../engine/store';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { ChatView } from './ChatView';

/**
 * The summary the official list knows for a conversation id (Swift `ConversationDetail.summary`). "Cloud của tôi" is
 * renamed; contacts without a conversation yet (Danh bạ) arrive with the contacts wave.
 */
export const useConversationSummary = (id: string | null): ConversationSummary | null => {
  // Rows are replaced only when they change, so the found object is a stable selector result.
  const known = useEngine((s) => (id ? s.conversations.find((c) => c.id === id) : undefined));
  const selfId = useEngine((s) => s.selfConversationId);
  return useMemo(() => (!known ? null : known.id === selfId ? { ...known, name: selfConversationTitle } : known), [known, selfId]);
};

/** Detail column of the conversation lists: the chat, or the "pick a conversation" state. */
export function ChatDetail({ conversationId }: { conversationId: string | null }) {
  const conversation = useConversationSummary(conversationId);
  if (!conversation) {
    return (
      <div className="column">
        <div className="toolbar" data-tauri-drag-region />
        <ContentUnavailable
          icon={MessagesSquare}
          title="Chọn một cuộc trò chuyện"
          description="Chọn ở danh sách bên cạnh, hoặc nhấn ⌘K để đi tới một cuộc trò chuyện."
        />
      </div>
    );
  }
  return <ChatView key={conversation.id} conversation={conversation} />;
}
