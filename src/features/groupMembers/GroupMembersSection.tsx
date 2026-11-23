// Members of a group for the info panel (wave 3 #5; Telegram / Whop member lists within the Zalo PC style): role badges
// ("Trưởng nhóm", "Phó nhóm"), online / last-seen subtitles, a hover "Xóa khỏi nhóm" for the owner and deputies (the
// official confirm with "Chặn người này tham gia lại"), the first 5 rows and "Xem tất cả (N)" opening a searchable list.
// Self-loading from the conversation id; reloads when the group's member count changes.

import { MessageCircle, Search, UserMinus, X } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  foldText,
  lastSeenText,
  loadGroupMembers,
  removeGroupMember,
  roleTitle,
  useGroupMembers,
  type GroupMember,
} from '../../engine/groupMembers';
import { setEngine, useEngine } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { openContextMenu, type MenuItem } from '../../ui/Menu';
import { Spinner } from '../../ui/Spinner';
import { ZaloDialog } from '../calls/ZaloDialog';
import './groupMembers.css';

const previewCount = 5;

export interface GroupMembersSectionProps {
  /** The group conversation (`g…` id). */
  conversationId: string;
  /** Draws its own "Thành viên nhóm (N)" title row (off when the info panel's section header shows it). */
  showTitle?: boolean;
}

export function GroupMembersSection({ conversationId, showTitle = false }: GroupMembersSectionProps) {
  const phase = useGroupMembers((s) => s.byGroup[conversationId]);
  const count = useEngine((s) => s.conversations.find((c) => c.id === conversationId)?.members ?? 0);
  const [showAll, setShowAll] = useState(false);
  const [removing, setRemoving] = useState<GroupMember | null>(null);

  // First read, and again when the official member count moves (someone joined / left / was removed).
  useEffect(() => void loadGroupMembers(conversationId), [conversationId, count]);

  const list = phase?.kind === 'ok' ? phase.list : null;
  const total = list ? Math.max(list.total, count) : count;

  return (
    <div className="gm-section">
      {showTitle && (
        <div className="gm-title">
          Thành viên nhóm{total > 0 && <span className="gm-count"> ({total})</span>}
        </div>
      )}
      {!phase || phase.kind === 'loading' ? (
        <div className="gm-state">
          <Spinner size={14} />
        </div>
      ) : phase.kind === 'failed' ? (
        <div className="gm-state is-failed">
          <span>{phase.text}</span>
          <button className="gm-link" onClick={() => void loadGroupMembers(conversationId)}>
            Thử lại
          </button>
        </div>
      ) : (
        <>
          <div className="gm-rows">
            {phase.list.members.slice(0, previewCount).map((m) => (
              <MemberRow key={m.id} member={m} onRemove={() => setRemoving(m)} />
            ))}
          </div>
          {total > previewCount && (
            <button className="gm-see-all" onClick={() => setShowAll(true)}>
              Xem tất cả ({total})
            </button>
          )}
        </>
      )}
      {showAll && list && <AllMembersDialog conversationId={conversationId} onClose={() => setShowAll(false)} onRemove={setRemoving} />}
      {removing && <RemoveMemberDialog conversationId={conversationId} member={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

const openChat = (m: GroupMember) => {
  if (!m.isMe) setEngine({ navigationRequest: m.id });
};

const rowMenu = (m: GroupMember, onRemove: () => void): MenuItem[] => [
  ...(m.isMe ? [] : [{ label: 'Nhắn tin', icon: MessageCircle, onSelect: () => openChat(m) }]),
  ...(m.canRemove ? [{ kind: 'separator' as const }, { label: 'Xóa khỏi nhóm', icon: UserMinus, destructive: true, onSelect: onRemove }] : []),
];

function MemberRow({ member: m, onRemove }: { member: GroupMember; onRemove: () => void }) {
  const role = roleTitle(m.role);
  const seen = lastSeenText(m);
  return (
    <div
      className={`gm-row ${m.isMe ? 'is-me' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => openChat(m)}
      onKeyDown={(e) => e.key === 'Enter' && openChat(m)}
      onContextMenu={(e: MouseEvent) => openContextMenu(e, rowMenu(m, onRemove))}
      title={m.isMe ? undefined : `Nhắn tin cho ${m.name}`}
    >
      <span className="gm-avatar">
        <Avatar url={m.avatar} name={m.name} size={40} />
        {m.online && !m.isMe && <span className="gm-online" aria-label="Đang hoạt động" />}
      </span>
      <span className="gm-text">
        <span className="gm-name-line">
          <span className="gm-name truncate">{m.isMe ? 'Bạn' : m.name}</span>
          {role && <span className={`gm-badge is-${m.role}`}>{role}</span>}
        </span>
        {seen && <span className={`gm-sub truncate ${m.online ? 'is-online' : ''}`}>{seen}</span>}
      </span>
      {m.canRemove && (
        <button
          className="gm-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Xóa khỏi nhóm"
        >
          Xóa khỏi nhóm
        </button>
      )}
    </div>
  );
}

/** "Xem tất cả": every member, searchable by name. */
function AllMembersDialog({ conversationId, onClose, onRemove }: { conversationId: string; onClose: () => void; onRemove: (m: GroupMember) => void }) {
  const phase = useGroupMembers((s) => s.byGroup[conversationId]);
  const [query, setQuery] = useState('');
  const list = phase?.kind === 'ok' ? phase.list : null;
  const shown = useMemo(() => {
    const q = foldText(query);
    return (list?.members ?? []).filter((m) => !q || foldText(m.isMe ? `${m.name} bạn` : m.name).includes(q));
  }, [list, query]);
  const counts = useMemo(
    () => ({ owner: list?.members.filter((m) => m.role !== 'member').length ?? 0, online: list?.members.filter((m) => m.online && !m.isMe).length ?? 0 }),
    [list],
  );
  return (
    <ZaloDialog title={`Thành viên (${list ? Math.max(list.total, list.members.length) : 0})`} onClose={onClose} width={420} height={560}>
      <div className="gm-dialog">
        <label className="gm-search">
          <Search size={15} />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm thành viên" aria-label="Tìm thành viên" />
          {query && (
            <button className="gm-search-clear" onClick={() => setQuery('')} aria-label="Xóa tìm kiếm">
              <X size={13} />
            </button>
          )}
        </label>
        <div className="gm-summary">
          {counts.owner > 0 && <span>{counts.owner} trưởng/phó nhóm</span>}
          {counts.online > 0 && <span>{counts.online} đang hoạt động</span>}
        </div>
        <div className="gm-dialog-list">
          {shown.length ? (
            shown.map((m) => <MemberRow key={m.id} member={m} onRemove={() => onRemove(m)} />)
          ) : (
            <div className="gm-state">Không tìm thấy thành viên</div>
          )}
          {list && list.total > list.members.length && !query && (
            <div className="gm-note">Danh sách chỉ hiển thị {list.members.length} thành viên Zalo đã tải.</div>
          )}
        </div>
      </div>
    </ZaloDialog>
  );
}

/** The official confirm (STR_CONFIRM_REMOVE_MEMBER + STR_BLOCK_REJOIN_GROUP). */
function RemoveMemberDialog({ conversationId, member, onClose }: { conversationId: string; member: GroupMember; onClose: () => void }) {
  const [block, setBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    await removeGroupMember(conversationId, member.id, block);
    setBusy(false);
    onClose();
  };
  return (
    <ZaloDialog
      title="Xóa khỏi nhóm"
      onClose={busy ? () => {} : onClose}
      width={380}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="cx-btn" onClick={onClose} disabled={busy}>
            Đóng
          </button>
          <button className="cx-btn cx-btn-primary cx-btn-danger-fill" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Spinner size={12} /> : null} Đồng ý
          </button>
        </>
      }
    >
      <div className="gm-confirm">
        <div className="gm-confirm-who">
          <Avatar url={member.avatar} name={member.name} size={36} />
          <span className="truncate">{member.name}</span>
        </div>
        <p>Xoá thành viên này khỏi nhóm?</p>
        <label className="gm-check">
          <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />
          <span>Chặn người này tham gia lại</span>
        </label>
      </div>
    </ZaloDialog>
  );
}
