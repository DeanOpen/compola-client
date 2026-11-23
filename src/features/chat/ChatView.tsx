// Native chat pane for one conversation (Swift `ChatView`): header in the toolbar, pinned bar, message list, composer.

import { StrangerRequestBar } from '../contacts/StrangerRequestBar';
import { useMessageJumpRequest } from '../../engine/messageJump';
import { SendPreviewSheet } from '../attach/SendPreviewSheet';
import { ReminderDetailHost } from './cards/ReminderCard';
import { BellOff, Eye, MessageSquareDashed, PanelRight, Search, Upload, UserPlus, type LucideIcon } from 'lucide-react';
import { CallButtons } from '../calls/CallButtons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { onFileDrop } from '../../engine/backend';
import { markRead, sendText, stashFailedDraft, takeFailedDraft } from '../../engine/chat';
import { clipboardFiles, reportComposer, sendPaths } from '../../engine/composer';
import { pinnedMessage } from '../../engine/messageActions';
import { useIsViewer } from '../../engine/remote';
import { appendDraft, isStandalone, type ChatMessage, type ComposerDraft } from '../../engine/models/chat';
import { type ConversationSummary } from '../../engine/models/conversations';
import { pinnedLabel, type PinnedItem } from '../../engine/models/outcomes';
import { getEngine, useEngine } from '../../engine/store';
import { showToast } from '../../engine/toast';
import { shell, useShell } from '../../shell/shellStore';
import { ConversationAvatar } from '../conversations/ConversationRow';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
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
  const [pendingPaste, setPendingPaste] = useState<string[] | null>(null);
  const [dropping, setDropping] = useState(false);
  // Joined to a Compola Server with the viewer role: nothing can be sent (the host refuses it anyway).
  const readOnly = useIsViewer();
  // Files dropped anywhere on the window go to the open conversation (photos as photos, the rest as files). Several
  // files, or a drop with ⌥ held, open the send preview first (remove items, add a caption).
  useEffect(() => {
    if (readOnly) return;
    let off: (() => void) | undefined;
    let alive = true;
    let option = false;
    const key = (e: KeyboardEvent) => (option = e.altKey);
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    void onFileDrop((e) => {
      if (e.kind === 'over') setDropping(true);
      else if (e.kind === 'leave') setDropping(false);
      else {
        setDropping(false);
        if (!e.paths.length) return;
        if (e.paths.length > 1 || option) setPendingPaste(e.paths);
        else void sendPaths(conversation.id, e.paths).then((o) => reportComposer(o, conversation.id));
      }
    }).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
    };
  }, [conversation.id, readOnly]);
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
  // "Xem trong trò chuyện" (Kho lưu trữ): the engine loaded the message, scroll to it and flash it.
  const jump = useMessageJumpRequest(id);
  useEffect(() => {
    if (!jump) return;
    setJumpTarget(jump.messageId);
    jump.consume();
  }, [jump?.messageId]);
  const selfId = useEngine((s) => s.selfConversationId);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lastMarkedId = useRef<string | null>(null);

  const last = loaded?.[loaded.length - 1];


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
      if (await sendText(sent.text, id, sent.replyTo?.id ?? null, sent.mentions, sent.styles ?? [])) return;
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
    <div className="chat column">
      <div className="chat-top">
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
      <div className="chat-bottom">
        <ToastView conversationId={id} bottom={0} />
        {/* Hides itself for friends and blocked people. */}
        {!conversation.isGroup && id !== selfId && <StrangerRequestBar conversationId={id} name={conversation.name} />}
        {readOnly ? (
          // Styled in features/remote/remote.css.
          <div className="composer-readonly" role="note">
            <Eye size={15} />
            <span>Bạn chỉ có quyền xem cuộc trò chuyện này</span>
          </div>
        ) : (
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
            onPasteFiles={() => void clipboardFiles().then((paths) => paths.length && setPendingPaste(paths))}
          />
        )}
      </div>
      {dropping && (
        <div className="chat-drop-overlay fade-in">
          <div className="chat-drop-card">
            <Upload size={28} />
            <div>Thả để gửi tới {conversation.name}</div>
          </div>
        </div>
      )}
      {pendingPaste && (
        <SendPreviewSheet
          conversationName={conversation.name}
          paths={pendingPaste}
          onCancel={() => setPendingPaste(null)}
          onSend={(paths, caption) => {
            setPendingPaste(null);
            if (!paths.length) return;
            // The caption goes as a text message after the media.
            void sendPaths(id, paths).then((o) => {
              reportComposer(o, id);
              if (caption && (o.kind === 'done' || o.kind === 'pending')) void sendText(caption, id);
            });
          }}
        />
      )}
      <MessageActionPresenter conversationId={id} />
      <ReminderDetailHost conversationId={id} />
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

/** The 68px chat header (Zalo PC): avatar, name and subtitle, then Thêm vào nhóm, Tìm kiếm tin nhắn, Gọi thoại,
 * Gọi video and Thông tin hội thoại (toggles the right panel). */
function ChatHeader({ conversation, subtitle, typing, muted }: { conversation: ConversationSummary; subtitle: string; typing: boolean; muted: boolean }) {
  const showInspector = useShell((s) => s.showInspector);
  return (
    <div className="toolbar chat-toolbar" data-tauri-drag-region>
      <div className="chat-header" data-tauri-drag-region>
        <ConversationAvatar conversation={conversation} size={48} isSelf={false} />
        <div className="chat-header-text" data-tauri-drag-region>
          <div className="chat-header-name">
            <span className="truncate">{conversation.name}</span>
            {muted && <BellOff size={13} className="secondary" />}
          </div>
          {subtitle && <div className={`chat-header-sub truncate ${typing ? 'tint' : ''}`}>{subtitle}</div>}
        </div>
      </div>
      <div className="toolbar-group">
        <HeaderButton icon={UserPlus} label={conversation.isGroup ? 'Thêm thành viên' : 'Tạo nhóm với người này'} disabled />
        <HeaderButton icon={Search} label="Tìm kiếm tin nhắn" disabled />
        <CallButtons conversation={conversation} />
        <HeaderButton icon={PanelRight} label="Thông tin hội thoại (⌥⌘I)" on={showInspector} onClick={() => shell.toggleInspector()} />
      </div>
    </div>
  );
}

function HeaderButton({ icon: Icon, label, on = false, disabled = false, onClick }: { icon: LucideIcon; label: string; on?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button className={`toolbar-button ${on ? 'is-on' : ''}`} disabled={disabled} title={disabled ? `${label} — chưa hỗ trợ trên phiên bản này` : label} aria-label={label} onClick={onClick}>
      <Icon size={20} strokeWidth={1.8} />
    </button>
  );
}
