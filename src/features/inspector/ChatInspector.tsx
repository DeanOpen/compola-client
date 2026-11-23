// Conversation info in the inspector (⌥⌘I; Swift `ChatInspector` + InspectorBlocks.swift): who it is, quick actions,
// the members of a group, polls in the loaded history, and the photos / files / links of the loaded messages.
// The shared photos / files / links and "Kho lưu trữ" come from features/sharedMedia; mute / pin / more actions arrive
// with their waves.

import { BarChart3, ChevronRight, Info, PanelRightClose, Tag } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { mentionCandidates } from '../../engine/chat';
import { setConversationLabel } from '../../engine/conversations';
import type { ChatMessage, MentionCandidate } from '../../engine/models/chat';
import { cssColor, type ConversationSummary } from '../../engine/models/conversations';
import { setEngine, useEngine } from '../../engine/store';
import { shell } from '../../shell/shellStore';
import { Avatar } from '../../ui/Avatar';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { openMenuBelow } from '../../ui/Menu';
import { Spinner } from '../../ui/Spinner';
import { useConversationSummary } from '../chat/ChatDetail';
import { SharedMediaBrowser, SharedMediaSections, useBrowsingSharedMedia } from '../sharedMedia/SharedMedia';
import './inspector.css';

const memberLimit = 8;
const listLimit = 5;

export function ChatInspectorColumn({ conversationId }: { conversationId: string | null }) {
  const conversation = useConversationSummary(conversationId);
  const browsing = useBrowsingSharedMedia(conversation?.id ?? null);
  return (
    <div className="column">
      <div className="toolbar inspector-toolbar" data-tauri-drag-region>
        <span className="inspector-toolbar-title" data-tauri-drag-region>
          Thông tin
        </span>
        <button className="icon-button" style={{ width: 28, height: 28 }} onClick={() => shell.hideInspector()} title="Ẩn thông tin (⌥⌘I)" aria-label="Ẩn thông tin">
          <PanelRightClose size={16} />
        </button>
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
  const [members, setMembers] = useState<MentionCandidate[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    if (!conversation.isGroup) {
      setMembers([]);
      return;
    }
    // The official suggestion list is the only member source.
    void mentionCandidates(id, '', []).then((found) => !cancelled && setMembers(found.filter((m) => !m.isAll)));
    return () => {
      cancelled = true;
    };
  }, [id, conversation.isGroup]);

  const shared = useMemo(() => sharedContent(loaded ?? []), [loaded]);
  const subtitle = id === selfId ? 'Chỉ mình bạn thấy' : conversation.isGroup ? (conversation.members > 0 ? `${conversation.members} thành viên` : 'Nhóm') : null;

  return (
    <div className="inspector">
      <div className="inspector-header">
        <Avatar url={conversation.avatar} name={conversation.name} size={76} />
        <div className="inspector-name clamp-2">{conversation.name}</div>
        {subtitle && <div className="inspector-sub">{subtitle}</div>}
      </div>

      <InspectorActions conversationId={id} />

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
          <Section title="Thành viên" trailing={conversation.members > 0 ? String(conversation.members) : undefined}>
            {members === null ? (
              <div className="inspector-loading">
                <Spinner size={14} />
              </div>
            ) : members.length ? (
              <List>
                {members.slice(0, memberLimit).map((m) => (
                  <button key={m.id} className="inspector-member" title={`Nhắn tin với ${m.name}`} onClick={() => setEngine({ navigationRequest: m.id })}>
                    <Avatar url={m.avatar} name={m.name} size={26} />
                    <span className="truncate">{m.name}</span>
                  </button>
                ))}
                {conversation.members > Math.min(members.length, memberLimit) && (
                  <EmptyLine text={`và ${conversation.members - Math.min(members.length, memberLimit)} thành viên khác`} />
                )}
              </List>
            ) : null}
          </Section>
        </>
      )}

      <SharedMediaSections conversationId={id} />
    </div>
  );
}

/** Round glass actions with captions. Mute / pin / more need the conversation-actions wave; labels work now. */
function InspectorActions({ conversationId }: { conversationId: string }) {
  const labels = useEngine(useShallow((s) => s.extras.labels));
  const current = useEngine((s) => s.extras.labelByConversation[conversationId] ?? null);
  const currentLabel = labels.find((l) => l.id === current);
  return (
    <div className="inspector-actions">
      <div className="action-slot">
        <button
          className="circle-glass"
          style={{ width: 40, height: 40, color: currentLabel ? (cssColor(currentLabel.colorHex) ?? undefined) : undefined }}
          aria-label="Phân loại"
          onClick={(e) =>
            openMenuBelow(
              e.currentTarget,
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
          <Tag size={17} fill={currentLabel ? 'currentColor' : 'none'} />
        </button>
        <span>{currentLabel?.name ?? 'Phân loại'}</span>
      </div>
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
  return (
    <section className="inspector-section">
      <div className="inspector-section-head">
        <span>{title}</span>
        {trailing && <span className="tertiary">{trailing}</span>}
      </div>
      {children}
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
