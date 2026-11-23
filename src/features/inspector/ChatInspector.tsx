// The Zalo PC info panel (docs/zalo-pc-style.md §5; logic from Swift `ChatInspector` + InspectorBlocks.swift):
// "Thông tin hội thoại" / "Thông tin nhóm", the avatar and name, round actions, then collapsible sections — members,
// group board, photos / videos, files, links (features/sharedMedia: the official media store), security settings, and the
// red actions.
// Actions that need the conversation-actions port are shown disabled until it lands.

import { GroupMembersSection } from '../groupMembers/GroupMembersSection';
import { BarChart3, Bell, BellOff, PinOff, ChevronDown, ChevronRight, EyeOff, Info, Pencil, Pin, Settings, Tag, Timer, Trash2, UserPlus, UsersRound, LogOut, type LucideIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { setConversationLabel } from '../../engine/conversations';
import type { ChatMessage } from '../../engine/models/chat';
import { cssColor, type ConversationSummary } from '../../engine/models/conversations';
import { useEngine } from '../../engine/store';
import { ConversationAvatar } from '../conversations/ConversationRow';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { openMenuBelow } from '../../ui/Menu';
import { useConversationSummary } from '../chat/ChatDetail';
import { SharedMediaBrowser, SharedMediaSections, useBrowsingSharedMedia } from '../sharedMedia/SharedMedia';
import { muteMenuWithUndo } from '../conversationActions/menu';
import { menuPlan, pinConversation, requestDeleteConversation, setConversationPrompt, unpinConversation } from '../../engine/conversationActions';
import './inspector.css';

const listLimit = 5;

export function ChatInspectorColumn({ conversationId }: { conversationId: string | null }) {
  const conversation = useConversationSummary(conversationId);
  const browsing = useBrowsingSharedMedia(conversation?.id ?? null);
  return (
    <div className="column">
      <div className="toolbar inspector-toolbar" data-tauri-drag-region>
        <span className="inspector-toolbar-title" data-tauri-drag-region>
          {conversation?.isGroup ? 'Thông tin nhóm' : 'Thông tin hội thoại'}
        </span>
      </div>
      {conversation && browsing ? (
        <SharedMediaBrowser conversationId={conversation.id} kind={browsing} />
      ) : conversation ? (
        <ChatInspector key={conversation.id} conversation={conversation} />
      ) : (
        <ContentUnavailable icon={Info} title="Không có cuộc trò chuyện" />
      )}
    </div>
  );
}

function ChatInspector({ conversation }: { conversation: ConversationSummary }) {
  const id = conversation.id;
  const loaded = useEngine((s) => s.messages[id]);
  const selfId = useEngine((s) => s.selfConversationId);

  const shared = useMemo(() => sharedContent(loaded ?? []), [loaded]);
  const actionsState = useEngine((s) => s.conversationActions);
  const plan = useMemo(() => menuPlan(id, 'chatBox', useEngine.getState()), [id, actionsState]);
  const threadPlan = useMemo(() => menuPlan(id, 'thread', useEngine.getState()), [id, actionsState]);
  const subtitle = id === selfId ? 'Chỉ mình bạn thấy' : conversation.isGroup ? (conversation.members > 0 ? `${conversation.members} thành viên` : 'Nhóm') : null;

  return (
    <div className="inspector">
      <div className="inspector-block inspector-header">
        <ConversationAvatar conversation={conversation} size={56} isSelf={false} />
        <div className="inspector-name">
          <span className="clamp-2">{conversation.name}</span>
          <button className="icon-button" style={{ width: 24, height: 24 }} disabled title="Đổi tên gợi nhớ — chưa hỗ trợ" aria-label="Đổi tên">
            <Pencil size={14} />
          </button>
        </div>
        {subtitle && <div className="inspector-sub">{subtitle}</div>}
        <InspectorActions conversationId={id} isGroup={conversation.isGroup} />
      </div>

      {conversation.isGroup && (
        <>
          <Section title="Bảng tin nhóm">
            <List>
              {shared.polls.length === 0 ? (
                <EmptyLine text="Chưa có bình chọn trong nội dung đã tải" />
              ) : (
                shared.polls.slice(0, listLimit).map((p) => <Row key={p.id} icon={<BarChart3 size={14} />} title={p.question || 'Bình chọn'} lines={2} />)
              )}
            </List>
          </Section>
          <Section title="Thành viên nhóm" trailing={conversation.members > 0 ? String(conversation.members) : undefined}>
            <GroupMembersSection conversationId={id} showTitle={false} />
          </Section>
        </>
      )}

      <SharedMediaSections conversationId={id} />

      <Section title="Thiết lập bảo mật">
        <List>
          <Row icon={<Timer size={15} />} title="Tin nhắn tự xóa" subtitle="Không bao giờ" />
          {plan.hide && (
            <Row
              icon={<EyeOff size={15} />}
              title={plan.hide === 'hide' ? 'Ẩn trò chuyện' : 'Bỏ ẩn trò chuyện'}
              onClick={() => setConversationPrompt({ kind: plan.hide === 'hide' ? 'hide' : 'unhide', id })}
            />
          )}
        </List>
      </Section>

      <div className="inspector-block inspector-danger">
        <button className="inspector-danger-row" disabled={!threadPlan.canDelete} onClick={() => requestDeleteConversation(id)}>
          <Trash2 size={16} /> Xóa lịch sử trò chuyện
        </button>
        {conversation.isGroup && (
          <button className="inspector-danger-row" disabled title="Chưa hỗ trợ trên phiên bản này">
            <LogOut size={16} /> Rời nhóm
          </button>
        )}
      </div>
    </div>
  );
}

/** Round actions with captions (Zalo PC): Tắt thông báo, Ghim hội thoại, Thêm thành viên / Tạo nhóm, Quản lý nhóm, and
 * Phân loại. Mute / pin / group management arrive with the conversation-actions port. */
function InspectorActions({ conversationId, isGroup }: { conversationId: string; isGroup: boolean }) {
  const labels = useEngine(useShallow((s) => s.extras.labels));
  const current = useEngine((s) => s.extras.labelByConversation[conversationId] ?? null);
  const currentLabel = labels.find((l) => l.id === current);
  const muted = useEngine((s) => s.mutedIds.has(conversationId));
  const actionsState = useEngine((s) => s.conversationActions);
  const plan = useMemo(() => menuPlan(conversationId, 'chatBox', useEngine.getState()), [conversationId, actionsState, muted]);
  const soon = (label: string) => `${label} — chưa hỗ trợ trên phiên bản này`;
  const action = (icon: LucideIcon, label: string) => (
    <ActionSlot label={label} help={soon(label)} disabled>
      {(() => {
        const I = icon;
        return <I size={18} />;
      })()}
    </ActionSlot>
  );
  return (
    <div className="inspector-actions">
      <ActionSlot
        label={muted ? 'Bật thông báo' : 'Tắt thông báo'}
        help={muted ? 'Bật thông báo' : 'Tắt thông báo'}
        onClick={(el) => {
          const item = muteMenuWithUndo(conversationId);
          if (item.kind === 'submenu') openMenuBelow(el, item.items);
          else if (item.kind === undefined || item.kind === 'item') item.onSelect();
        }}
      >
        {muted ? <Bell size={18} /> : <BellOff size={18} />}
      </ActionSlot>
      {plan.pin ? (
        <ActionSlot
          label={plan.pin === 'pin' ? 'Ghim hội thoại' : 'Bỏ ghim hội thoại'}
          help={plan.pin === 'pin' ? 'Ghim hội thoại' : 'Bỏ ghim hội thoại'}
          onClick={() => void (plan.pin === 'pin' ? pinConversation(conversationId) : unpinConversation(conversationId))}
        >
          {plan.pin === 'pin' ? <Pin size={18} /> : <PinOff size={18} />}
        </ActionSlot>
      ) : (
        action(Pin, 'Ghim hội thoại')
      )}
      {action(isGroup ? UserPlus : UsersRound, isGroup ? 'Thêm thành viên' : 'Tạo nhóm trò chuyện')}
      {isGroup && action(Settings, 'Quản lý nhóm')}
      <ActionSlot
        label={currentLabel?.name ?? 'Phân loại'}
        help="Phân loại"
        color={currentLabel ? (cssColor(currentLabel.colorHex) ?? undefined) : undefined}
        onClick={(el) =>
          openMenuBelow(
            el,
            labels.length
              ? labels.map((l) => ({
                  label: l.name,
                  dot: cssColor(l.colorHex) ?? undefined,
                  checked: current === l.id,
                  onSelect: () => setConversationLabel(conversationId, current === l.id ? null : l.id),
                }))
              : [{ label: 'Chưa có thẻ phân loại', disabled: true, onSelect: () => {} }],
          )
        }
      >
        <Tag size={18} fill={currentLabel ? 'currentColor' : 'none'} />
      </ActionSlot>
    </div>
  );
}

/** A round glass action with its caption underneath. */
function ActionSlot({
  label,
  help,
  color,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  help: string;
  color?: string;
  disabled?: boolean;
  onClick?: (el: HTMLButtonElement) => void;
  children: ReactNode;
}) {
  return (
    <div className="action-slot">
      <button className="action-button" style={{ color }} disabled={disabled} title={help} aria-label={help} onClick={(e) => onClick?.(e.currentTarget)}>
        {children}
      </button>
      <span className="truncate">{label}</span>
    </div>
  );
}

/** Photos / videos, files, links and polls found in the loaded part of the history, newest first. */
const sharedContent = (messages: ChatMessage[]) => {
  const media: ChatMessage[] = [];
  const files: ChatMessage[] = [];
  const links: ChatMessage[] = [];
  const polls: { id: string; question: string }[] = [];
  const seenPolls = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const t = m.kind.type;
    if (t === 'photo' || t === 'video') media.push(m);
    else if (t === 'file') files.push(m);
    else if (t === 'link') links.push(m);
    else if (m.kind.type === 'poll' && m.kind.poll.pollId && !seenPolls.has(m.kind.poll.pollId)) {
      seenPolls.add(m.kind.poll.pollId);
      polls.push({ id: m.kind.poll.pollId, question: m.kind.poll.question });
    }
  }
  return { media, files, links, polls };
};

function Section({ title, trailing, children }: { title: string; trailing?: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="inspector-block inspector-section">
      <button className="inspector-section-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{title}</span>
        {trailing && <span className="inspector-section-count">{trailing}</span>}
        <span className="conv-tabs-spacer" />
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && children}
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <div className="inspector-list">{children}</div>;
}

function Row({ icon, title, subtitle, lines = 1, onClick }: { icon: ReactNode; title: string; subtitle?: string; lines?: number; onClick?: () => void }) {
  return (
    <button className="inspector-row" onClick={onClick}>
      <span className="tint inspector-row-icon">{icon}</span>
      <span className="inspector-row-text">
        <span className={lines > 1 ? 'clamp-2' : 'truncate'}>{title}</span>
        {subtitle && <span className="inspector-row-sub truncate">{subtitle}</span>}
      </span>
      {onClick && <ChevronRight size={12} className="tertiary" />}
    </button>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="inspector-empty">{text}</div>;
}
