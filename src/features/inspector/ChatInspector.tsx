// The Zalo PC info panel (docs/zalo-pc-style.md §5; logic from Swift `ChatInspector` + InspectorBlocks.swift):
// "Thông tin hội thoại" / "Thông tin nhóm", the avatar and name, round actions, then collapsible sections — members,
// group board, members, then (wave 3 #4, WhatsApp contact-info structure) "Ảnh, file, link · N ›" with one row of
// thumbnails (opens Kho lưu trữ), setting rows with switches, and the red rows at the bottom.

import { GroupMembersSection } from '../groupMembers/GroupMembersSection';
import { Activity, AtSign, UserRound, Ban, BarChart3, Bell, BellOff, PinOff, ChevronDown, ChevronRight, EyeOff, Info, Pencil, Pin, Settings, Tag, Timer, Trash2, UserPlus, UsersRound, LogOut, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { setConversationLabel } from '../../engine/conversations';
import type { ChatMessage } from '../../engine/models/chat';
import { cssColor, type ConversationSummary } from '../../engine/models/conversations';
import { useEngine } from '../../engine/store';
import { ConversationAvatar } from '../conversations/ConversationRow';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { openMenuBelow } from '../../ui/Menu';
import { useConversationSummary } from '../chat/ChatDetail';
import { SharedMediaBrowser, useBrowsingSharedMedia } from '../sharedMedia/SharedMedia';
import { browseSharedMedia, feedOf, isPending, mergedAll, previewList, refreshSharedMedia, sharedMediaKinds, useSharedMedia } from '../../engine/sharedMedia';
import { PhotoView, VideoThumb } from '../chat/cards/Media';
import { Spinner } from '../../ui/Spinner';
import { Alert } from '../../ui/Overlays';
import { blockContact, useContacts } from '../../engine/contacts';
import { muteFor, muteUntil, useNotifications } from '../../engine/notifications';
import { lastSeenText } from '../../engine/groupMembers';
import { openContactProfile } from '../contacts/hosts';
import { showToast } from '../../engine/toast';
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
  const muted = useEngine((s) => s.mutedIds.has(id));
  const mute = useNotifications((s) => muteFor(s, id));
  const muteText = !muted || !mute ? null : (() => {
    const until = muteUntil(mute);
    return until === null ? 'Cho đến khi được mở lại' : `Đến ${muteUntilText(until)}`;
  })();
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

      {!conversation.isGroup && id !== selfId && <PersonInfo conversationId={id} />}

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

      <MediaStrip conversationId={id} />

      {/* WhatsApp-style setting rows (wave 3 #4): the state on the right, a click changes it. */}
      <section className="inspector-block">
        <div className="inspector-list">
          <ToggleRow
            icon={<BellOff size={15} />}
            title="Tắt thông báo"
            subtitle={muteText ?? undefined}
            on={muted}
            onToggle={(el) => {
              const item = muteMenuWithUndo(id);
              if (item.kind === 'submenu') openMenuBelow(el, item.items, 'end');
              else if (item.kind === undefined || item.kind === 'item') item.onSelect();
            }}
          />
          {plan.pin && (
            <ToggleRow
              icon={<Pin size={15} />}
              title="Ghim hội thoại"
              on={plan.pin === 'unpin'}
              onToggle={() => void (plan.pin === 'pin' ? pinConversation(id) : unpinConversation(id))}
            />
          )}
          {plan.hide && (
            <ToggleRow
              icon={<EyeOff size={15} />}
              title="Ẩn trò chuyện"
              on={plan.hide === 'unhide'}
              onToggle={() => setConversationPrompt({ kind: plan.hide === 'hide' ? 'hide' : 'unhide', id })}
            />
          )}
          <ToggleRow icon={<Timer size={15} />} title="Tin nhắn tự xóa" subtitle="Không bao giờ" on={false} disabled help="Chưa hỗ trợ trên phiên bản này" />
        </div>
      </section>

      <div className="inspector-block inspector-danger">
        {!conversation.isGroup && id !== selfId && <BlockRow conversationId={id} name={conversation.name} />}
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

/** "Ảnh, file, link · N ›" and one row of three thumbnails (WhatsApp contact info); opens Kho lưu trữ. */
function MediaStrip({ conversationId }: { conversationId: string }) {
  const lastId = useEngine((s) => {
    const list = s.messages[conversationId];
    return list?.[list.length - 1]?.id ?? null;
  });
  const first = useRef(true);
  useEffect(() => {
    first.current = true;
  }, [conversationId]);
  // The newest page of every list when the conversation shows, and again a second after a new message.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      void refreshSharedMedia(conversationId);
      return;
    }
    const t = setTimeout(() => void refreshSharedMedia(conversationId), 1000);
    return () => clearTimeout(t);
  }, [conversationId, lastId]);
  const loaded = useEngine((s) => s.messages[conversationId] ?? noMessages);
  const feeds = useSharedMedia(
    useShallow((s) => ({ images: feedOf(s, conversationId, 'images'), files: feedOf(s, conversationId, 'files'), links: feedOf(s, conversationId, 'links') })),
  );
  const all = useMemo(() => mergedAll(feeds, loaded), [feeds, loaded]);
  const images = useMemo(() => previewList('images', feeds.images.items, loaded).slice(0, 3), [feeds.images, loaded]);
  const pending = sharedMediaKinds.every((k) => isPending(feeds[k])) && all.length === 0;
  const more = sharedMediaKinds.some((k) => feeds[k].more);
  const count = all.length ? `${all.length}${more ? '+' : ''}` : '';
  const files = all.filter((m) => m.kind.type === 'file').length;
  const links = all.filter((m) => m.kind.type === 'link').length;
  return (
    <section className="inspector-block media-strip">
      <button className="media-strip-head" onClick={() => browseSharedMedia(conversationId, 'all')}>
        <span>Ảnh, file, link</span>
        {count && <span className="inspector-section-count">{count}</span>}
        <span className="conv-tabs-spacer" />
        <ChevronRight size={16} className="tertiary" />
      </button>
      {pending ? (
        <div className="inspector-loading">
          <Spinner size={14} />
        </div>
      ) : images.length ? (
        <div className="media-strip-row">
          {images.map((m) =>
            m.kind.type === 'photo' ? (
              <PhotoView key={m.id} message={m} url={m.kind.url} width={m.kind.width} height={m.kind.height} tile={96} />
            ) : m.kind.type === 'video' ? (
              <VideoThumb key={m.id} message={m} thumbnail={m.kind.thumbnail} duration={m.kind.duration} url={m.kind.url} tile={96} />
            ) : null,
          )}
        </div>
      ) : (
        <div className="inspector-empty">{all.length ? [files && `${files} file`, links && `${links} link`].filter(Boolean).join(' · ') : 'Chưa có ảnh, file hoặc link'}</div>
      )}
    </section>
  );
}

const noMessages: ChatMessage[] = [];

/** A setting row with a switch on the right (the switch mirrors the state; the click runs the action). */
function ToggleRow({
  icon,
  title,
  subtitle,
  on,
  disabled = false,
  help,
  onToggle,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  on: boolean;
  disabled?: boolean;
  help?: string;
  onToggle?: (el: HTMLButtonElement) => void;
}) {
  return (
    <button className="inspector-row inspector-toggle" disabled={disabled} title={help} role="switch" aria-checked={on} onClick={(e) => onToggle?.(e.currentTarget)}>
      <span className="tint inspector-row-icon">{icon}</span>
      <span className="inspector-row-text">
        <span className="truncate">{title}</span>
        {subtitle && <span className="inspector-row-sub truncate">{subtitle}</span>}
      </span>
      <span className={`inspector-switch ${on ? 'is-on' : ''}`} aria-hidden />
    </button>
  );
}

/** "Chặn": confirm, then block messages and calls (official `blockFriend`). */
function BlockRow({ conversationId, name }: { conversationId: string; name: string }) {
  const [asking, setAsking] = useState(false);
  const block = async () => {
    setAsking(false);
    const r = await blockContact(conversationId);
    showToast(r.ok ? `Đã chặn ${name}` : r.text || 'Đã có lỗi xảy ra. Vui lòng thử lại', conversationId);
  };
  return (
    <>
      <button className="inspector-danger-row" onClick={() => setAsking(true)}>
        <Ban size={16} /> Chặn {name}
      </button>
      {asking && (
        <Alert
          title={`Chặn ${name}?`}
          message="Người này sẽ không thể nhắn tin hoặc gọi cho bạn."
          buttons={[
            { label: 'Chặn', role: 'destructive', onClick: () => void block() },
            { label: 'Hủy', role: 'cancel', onClick: () => setAsking(false) },
          ]}
        />
      )}
    </>
  );
}

/** "18:16" today, "08:00, 24/11" on another day. */
const muteUntilText = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${hm}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
};

/** Who this is (Telegram "User info"): Zalo name, activity, and the profile. Only what the friend list knows. */
function PersonInfo({ conversationId }: { conversationId: string }) {
  const friend = useContacts((s) => s.friends.find((f) => f.id === conversationId) ?? null);
  const activity = friend ? lastSeenText({ id: friend.id, name: friend.name, avatar: friend.avatar, role: 'member', isMe: false, lastActive: friend.lastActive, online: friend.online, canRemove: false }) : null;
  return (
    <section className="inspector-block">
      <div className="inspector-list">
        {friend?.zaloName && friend.zaloName !== friend.name && <Row icon={<AtSign size={15} />} title={friend.zaloName} subtitle="Tên Zalo" />}
        {activity && <Row icon={<Activity size={15} />} title={activity} subtitle="Hoạt động" />}
        <Row icon={<UserRound size={15} />} title="Xem trang cá nhân" onClick={() => openContactProfile(conversationId)} />
      </div>
    </section>
  );
}
