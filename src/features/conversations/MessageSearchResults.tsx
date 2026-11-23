// "Tin nhắn" results of the conversation list search, from the local message index (src/engine/search.ts, Rust
// src-tauri/src/automation/search.rs): accent-insensitive keyword search, merged with search by meaning when an
// embeddings provider is set up (Settings › Nâng cao › Tìm kiếm). Clicking a hit opens its conversation at the message
// and keeps the search, so the next hit is one click away.

import { Sparkles } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { isHiddenConversation } from '../../engine/conversationActions';
import { requestJumpToMessage } from '../../engine/messageJump';
import { displayName, type ConversationSummary } from '../../engine/models/conversations';
import { messageSearch, type SearchHit, type SearchResult } from '../../engine/search';
import { getEngine } from '../../engine/store';
import { shell } from '../../shell/shellStore';
import { Avatar } from '../../ui/Avatar';
import { Highlight } from '../../ui/Highlight';
import { Spinner } from '../../ui/Spinner';
import { ConversationAvatar } from './ConversationRow';
import { listTime } from './support';

/** Wait after the last keystroke before searching (a semantic search embeds the query). */
const debounceMs = 300;

export interface MessageSearch {
  /** The query the hits answer, null before the first answer. */
  query: string | null;
  result: SearchResult | null;
  busy: boolean;
}

/** Searches the message index for `query` (in `conversationId` when given), debounced; stale answers are dropped. */
export function useMessageSearch(query: string, conversationId: string | null): MessageSearch {
  const [state, setState] = useState<MessageSearch>({ query: null, result: null, busy: false });
  useEffect(() => {
    if (!query) {
      setState({ query: null, result: null, busy: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, busy: true }));
    const timer = setTimeout(() => {
      messageSearch
        .search(query, { conversationId, limit: conversationId ? 50 : 20 })
        .then((result) => !cancelled && setState({ query, result, busy: false }))
        // No index (indexing off, mock backend…): the list shows conversations only.
        .catch(() => !cancelled && setState({ query, result: null, busy: false }));
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, conversationId]);
  return state;
}

/**
 * Hits that may be shown: hidden chats only once their PIN was entered (`visibleHidden`), like the conversation rows.
 * The scoped conversation is open already, so its hits always show.
 */
export const visibleHits = (hits: SearchHit[], visibleHidden: readonly string[], scope: string | null): SearchHit[] => {
  const s = getEngine();
  return hits.filter((h) => h.conversationId === scope || !isHiddenConversation(s, h.conversationId) || visibleHidden.includes(h.conversationId));
};

/** Opens the hit's conversation at the message (a preview row has no message id: just the conversation). */
const openHit = (h: SearchHit) => {
  const open = () => shell.select(h.conversationId);
  if (h.source === 'chat') void requestJumpToMessage(h.conversationId, h.id, h.date, open);
  else open();
};

export function MessageSearchSection({
  hits,
  query,
  busy,
  semantic,
  scoped,
  showTitle,
}: {
  hits: SearchHit[];
  query: string;
  busy: boolean;
  /** Search by meaning took part (hybrid mode). */
  semantic: boolean;
  /** Searching one conversation: the rows name the sender instead of the conversation. */
  scoped: boolean;
  showTitle: boolean;
}) {
  const conversations = new Map(getEngine().conversations.map((c) => [c.id, c]));
  return (
    <div className="msg-hits" aria-label="Tin nhắn">
      {showTitle && (
        <div className="conv-section-title msg-hits-title">
          <span>Tin nhắn{hits.length ? ` (${hits.length})` : ''}</span>
          {semantic && (
            <span className="msg-hits-mode" title="Kết hợp tìm theo từ khoá và theo ý nghĩa">
              <Sparkles size={11} /> theo ý nghĩa
            </span>
          )}
          {busy && <Spinner size={11} />}
        </div>
      )}
      {hits.map((h) => (
        <MessageHitRow key={h.id} hit={h} query={query} scoped={scoped} conversation={conversations.get(h.conversationId) ?? null} />
      ))}
      {!busy && hits.length === 0 && scoped && query && <div className="msg-hits-empty">Không tìm thấy tin nhắn nào cho “{query}”.</div>}
      {hits.length > 0 && <div className="msg-hits-footer">Tìm trong các tin nhắn đã tải về máy này.</div>}
    </div>
  );
}

const MessageHitRow = memo(function MessageHitRow({
  hit,
  query,
  scoped,
  conversation,
}: {
  hit: SearchHit;
  query: string;
  scoped: boolean;
  conversation: ConversationSummary | null;
}) {
  const sender = hit.fromMe ? 'Bạn' : hit.senderName;
  const title = scoped ? sender || hit.conversationName : conversation ? displayName(conversation) : hit.conversationName || 'Hội thoại';
  const { selfConversationId: selfId, profile } = getEngine();
  // Scoped: the sender's face — mine from the profile, the other person's in a 1:1 chat; initials in a group.
  const senderAvatar = hit.fromMe ? (profile?.avatar ?? null) : !hit.isGroup ? (conversation?.avatar ?? null) : null;
  const senderInitials = hit.fromMe ? (profile?.displayName ?? title) : title;
  return (
    <button className="msg-hit" onClick={() => openHit(hit)} title="Xem trong trò chuyện">
      {conversation && !scoped ? (
        <ConversationAvatar conversation={conversation} size={40} isSelf={conversation.id === selfId} />
      ) : (
        <Avatar url={senderAvatar} name={senderInitials} size={40} />
      )}
      <span className="msg-hit-body">
        <span className="msg-hit-top">
          <span className="msg-hit-name truncate">{title}</span>
          {hit.matched === 'semantic' && (
            <span className="msg-hit-semantic" title="Khớp theo ý nghĩa">
              <Sparkles size={11} />
            </span>
          )}
          <span className="conv-row-spacer" />
          <span className="conv-row-time">{listTime(hit.date)}</span>
        </span>
        <span className="msg-hit-text">
          {!scoped && (hit.isGroup || hit.fromMe) && sender && <span className="msg-hit-sender">{sender}: </span>}
          <Highlight text={hit.text} query={query} />
        </span>
      </span>
    </button>
  );
});
