// Native chat pane for one conversation (Swift `ChatView`): header in the toolbar, pinned bar, message list, composer.

import { BellOff, Info, MessageSquareDashed, MoreHorizontal, Phone, Tag, Video } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { markRead, sendText, stashFailedDraft, takeFailedDraft } from '../../engine/chat';
import { setConversationLabel } from '../../engine/conversations';
import { pinnedMessage } from '../../engine/messageActions';
import { appendDraft, isStandalone, type ChatMessage, type ComposerDraft } from '../../engine/models/chat';
import { cssColor, type ConversationSummary } from '../../engine/models/conversations';
import { pinnedLabel, type PinnedItem } from '../../engine/models/outcomes';
import { getEngine, useEngine } from '../../engine/store';
import { showToast } from '../../engine/toast';
import { shell, useShell } from '../../shell/shellStore';
import { Avatar } from '../../ui/Avatar';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { openMenuBelow } from '../../ui/Menu';
import { Alert } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { ToastView } from '../../ui/Toast';
import { Composer } from './composer/Composer';
import { MessageActionPresenter } from './MessageActionPresenter';
import { MessageList } from './MessageList';
import { PinnedBar } from './PinnedBar';
import './chat.css';

const emptyDraft: ComposerDraft = { text: '', mentions: [], replyTo: null };

export function ChatView({ conversation }: { conversation: ConversationSummary }) {
  const id = conversation.id;
  const loaded = useEngine((s) => s.messages[id]);
  const typingName = useEngine((s) => s.typing[id]);
  const muted = useEngine((s) => s.mutedIds.has(id));
  const failedRevision = useEngine((s) => s.failedDrafts.revision);
  const replyTick = useShell((s) => s.replyTick);
  const canStartTransfer = useEngine((s) => s.canStartTransfer);

  const [draft, setDraft] = useState<ComposerDraft>(emptyDraft);
  const [focusTick, setFocusTick] = useState(0);
  const [sendTick, setSendTick] = useState(0);
  const [notice, setNotice] = useState<'restored' | 'like' | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lastMarkedId = useRef<string | null>(null);

  const last = loaded?.[loaded.length - 1];

  // The header and composer float over the messages: the list pads itself by their measured heights.
  const root = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !top.current || !bottom.current) return;
    const update = () => {
      el.style.setProperty('--top-h', `${top.current?.offsetHeight ?? 0}px`);
      el.style.setProperty('--bottom-h', `${bottom.current?.offsetHeight ?? 0}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(top.current);
    ro.observe(bottom.current);
    return () => ro.disconnect();
  }, []);

  /** Marks read only when there is something unread (no redundant server round trips). */
  const markReadIfNeeded = useCallback(
    (newIncomingOnly: boolean) => {
      const s = getEngine();
      if (document.visibilityState !== 'visible' || s.openConversationId !== id) return;
      const list = s.messages[id];
      const newest = list?.[list.length - 1];
      const unread = s.conversations.find((c) => c.id === id)?.unread ?? 0;
      if (newest && !newest.isMine && newest.id !== lastMarkedId.current && (newIncomingOnly || unread > 0)) {
        lastMarkedId.current = newest.id;
        markRead(id);
      } else if (!newIncomingOnly && unread > 0) {
        markRead(id);
      }
      if (lastMarkedId.current === null) lastMarkedId.current = newest?.id ?? null;
    },
    [id],
  );

  /** Puts a failed draft back after whatever is in the composer now; a reply target chosen meanwhile wins. */
  const restoreFailedDraft = useCallback(() => {
    const taken = takeFailedDraft(id);
    if (!taken) return;
    setDraft((current) => appendDraft(current, taken.draft));
    if (taken.notice) setNotice('restored');
  }, [id]);

  useEffect(() => {
    setFocusTick((t) => t + 1);
    restoreFailedDraft();
    markReadIfNeeded(false);
    const onVisible = () => markReadIfNeeded(false);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [id, restoreFailedDraft, markReadIfNeeded]);

  useEffect(() => restoreFailedDraft(), [failedRevision, restoreFailedDraft]);
  useEffect(() => markReadIfNeeded(true), [last?.id, markReadIfNeeded]);
  useEffect(() => markReadIfNeeded(false), [conversation.unread, markReadIfNeeded]);

  const reply = useCallback((message: ChatMessage) => {
    setDraft((d) => ({ ...d, replyTo: message }));
    setFocusTick((t) => t + 1);
  }, []);

  // ⌘R: reply to the newest incoming message.
  const firstReplyTick = useRef(replyTick);
  useEffect(() => {
    if (replyTick === firstReplyTick.current) return;
    const list = getEngine().messages[id] ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m.isMine && !isStandalone(m.kind) && m.kind.type !== 'recalled') return reply(m);
    }
  }, [replyTick, id, reply]);

  const send = useCallback(() => {
    const sent = draftRef.current;
    if (!sent.text.trim()) return;
    setDraft(emptyDraft);
    setSendTick((t) => t + 1);
    void (async () => {
      // Untrimmed text: the engine re-bases mention offsets when it trims.
      if (await sendText(sent.text, id, sent.replyTo?.id ?? null, sent.mentions)) return;
      // Nothing was sent. The view may be gone by now: the engine keeps the text for this conversation's composer.
      stashFailedDraft(sent, id);
    })();
  }, [id]);

  const sendLike = useCallback(() => {
    setSendTick((t) => t + 1);
    void sendText('👍', id).then((ok) => !ok && setNotice('like'));
  }, [id]);

  /** A pin of the pinned bar: its message when it is loaded, otherwise its full text. */
  const openPin = useCallback(
    (item: PinnedItem) => {
      if (item.kind === 'message') {
        const target = pinnedMessage(item, getEngine().messages[id] ?? []);
        if (target) setJumpTarget(target.id);
        else showToast('Tin nhắn đã ghim chưa được tải. Kéo lên để xem tin nhắn cũ hơn.', id);
      } else {
        showToast(item.title || pinnedLabel(item), id);
      }
    },
    [id],
  );

  const subtitle = typingName
    ? `${typingName} đang soạn tin…`
    : conversation.isGroup && conversation.members > 0
      ? `${conversation.members} thành viên`
      : last?.isE2EE
        ? 'Mã hóa đầu cuối'
        : '';

  return (
    <div className="chat column" ref={root}>
      <div className="chat-top" ref={top}>
        <ChatHeader conversation={conversation} subtitle={subtitle} typing={!!typingName} muted={muted} />
        <PinnedBar conversationId={id} open={openPin} />
      </div>
      <div className="chat-body">
        {loaded === undefined ? (
          <div className="chat-loading">
            <Spinner size={18} />
            <span>Đang tải tin nhắn…</span>
          </div>
        ) : loaded.length === 0 ? (
          <ContentUnavailable
            icon={MessageSquareDashed}
            title="Chưa có tin nhắn"
            description={`Tin nhắn cũ nằm trên điện thoại của bạn. Đồng bộ để xem lịch sử trò chuyện với ${conversation.name} trên máy tính.`}
            actions={canStartTransfer ? <button className="btn btn-prominent">Đồng bộ tin nhắn</button> : undefined}
          />
        ) : (
          <MessageList conversation={conversation} scrollToBottomTick={sendTick} jumpTarget={jumpTarget} onJumped={() => setJumpTarget(null)} onReply={reply} />
        )}
      </div>
      <div className="chat-bottom" ref={bottom}>
        <ToastView conversationId={id} bottom={0} />
        <Composer
        name={conversation.name}
        conversationId={id}
        isGroup={conversation.isGroup}
        draft={draft}
        onDraftChange={setDraft}
        typingName={typingName ?? null}
        focusTick={focusTick}
        onSend={send}
        onSendLike={sendLike}
        />
      </div>
      <MessageActionPresenter conversationId={id} />
      {notice && (
        <Alert
          title="Chưa gửi được tin nhắn"
          message={notice === 'like' ? 'Không gửi được biểu tượng 👍. Hãy thử lại.' : 'Nội dung đã được trả lại vào ô soạn thảo. Hãy thử gửi lại.'}
          buttons={[{ label: 'OK', role: 'cancel', onClick: () => setNotice(null) }]}
        />
      )}
    </div>
  );
}

/** Avatar, name and subtitle, then the call / info / "⋯" buttons: the chat column's toolbar. */
function ChatHeader({ conversation, subtitle, typing, muted }: { conversation: ConversationSummary; subtitle: string; typing: boolean; muted: boolean }) {
  const showInspector = useShell((s) => s.showInspector);
  const labels = useEngine(useShallow((s) => s.extras.labels));
  const current = useEngine((s) => s.extras.labelByConversation[conversation.id] ?? null);
  return (
    <div className="chat-toolbar" data-tauri-drag-region>
      <div className="chat-bar glass" data-tauri-drag-region>
      <div className="chat-header" data-tauri-drag-region>
        <Avatar url={conversation.avatar} name={conversation.name} size={30} />
        <div className="chat-header-text" data-tauri-drag-region>
          <div className="chat-header-name">
            <span className="truncate">{conversation.name}</span>
            {muted && <BellOff size={11} className="secondary" />}
          </div>
          {subtitle && <div className={`chat-header-sub truncate ${typing ? 'tint' : ''}`}>{subtitle}</div>}
        </div>
      </div>
      <div className="toolbar-group">
        <button className="toolbar-button" disabled title="Gọi thoại — chưa hỗ trợ trên phiên bản này" aria-label="Gọi thoại">
          <Phone size={15} />
        </button>
        <button className="toolbar-button" disabled title="Gọi video — chưa hỗ trợ trên phiên bản này" aria-label="Gọi video">
          <Video size={16} />
        </button>
      </div>
      <span className="toolbar-divider" />
      <div className="toolbar-group">
        <button className={`toolbar-button ${showInspector ? 'is-on' : ''}`} onClick={() => shell.toggleInspector()} title="Thông tin (⌥⌘I)" aria-label="Thông tin">
          <Info size={16} />
        </button>
        <button
          className="toolbar-button"
          title="Tùy chọn"
          aria-label="Tùy chọn"
          onClick={(e) =>
            openMenuBelow(
              e.currentTarget,
              [
                {
                  kind: 'submenu',
                  label: 'Phân loại',
                  icon: Tag,
                  items: labels.length
                    ? labels.map((l) => ({
                        label: l.name,
                        dot: cssColor(l.colorHex) ?? undefined,
                        checked: current === l.id,
                        onSelect: () => setConversationLabel(conversation.id, current === l.id ? null : l.id),
                      }))
                    : [{ label: 'Chưa có thẻ phân loại', disabled: true, onSelect: () => {} }],
                },
              ],
              'end',
            )
          }
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      </div>
    </div>
  );
}
