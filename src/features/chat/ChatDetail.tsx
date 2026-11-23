import { Lock, MessagesSquare } from 'lucide-react';
import { isConversationLocked, setConversationPrompt, useConversationUI } from '../../engine/conversationActions';
import { Spinner } from '../../ui/Spinner';
import { useMemo } from 'react';
import { selfConversationTitle, type ConversationSummary } from '../../engine/models/conversations';
import { useEngine } from '../../engine/store';
import { contactConversationSummary, useContacts } from '../../engine/contacts';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { ChatView } from './ChatView';

/**
 * The summary the official list knows for a conversation id (Swift `ConversationDetail.summary`). "Cloud của tôi" is
 * renamed; a contact or group without a conversation yet (Danh bạ) gets a placeholder from the contact data.
 */
export const useConversationSummary = (id: string | null): ConversationSummary | null => {
  // Rows are replaced only when they change, so the found object is a stable selector result.
  const known = useEngine((s) => (id ? s.conversations.find((c) => c.id === id) : undefined));
  const selfId = useEngine((s) => s.selfConversationId);
  const contacts = useContacts();
  return useMemo(
    () => (!known ? (id ? contactConversationSummary(contacts, id) : null) : known.id === selfId ? { ...known, name: selfConversationTitle } : known),
    [known, selfId, id, contacts],
  );
};

/** Detail column of the conversation lists: the chat, or the "pick a conversation" state. */
export function ChatDetail({ conversationId }: { conversationId: string | null }) {
  const conversation = useConversationSummary(conversationId);
  const hiddenKnown = useEngine((s) => s.conversationActions.hiddenKnown);
  // Re-render on lock changes (hidden ids, the one unlocked chat).
  useEngine((s) => s.conversationActions.hiddenIds);
  useConversationUI((s) => s.unlockedId);
  if (conversationId && !hiddenKnown) {
    return (
      <div className="column">
        <div className="toolbar" data-tauri-drag-region />
        <div className="chat-loading">
          <Spinner size={18} />
        </div>
      </div>
    );
  }
  if (conversation && isConversationLocked(conversation.id)) {
    const id = conversation.id;
    return (
      <div className="column">
        <div className="toolbar" data-tauri-drag-region />
        <ContentUnavailable
          icon={Lock}
          title="Trò chuyện ẩn"
          description="Nhập mã PIN để mở trò chuyện"
          actions={
            <button className="btn btn-prominent" onClick={() => setConversationPrompt({ kind: 'unlock', id })}>
              Nhập mã PIN
            </button>
          }
        />
      </div>
    );
  }
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
