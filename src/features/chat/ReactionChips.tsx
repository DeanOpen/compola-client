// Tapback-style chips over the bubble's top corner (Swift `ReactionChips`); a click shows who reacted — the official
// "Biểu cảm" popup (Swift `ReactionDetailView`).

import { useEffect, useRef, useState } from 'react';
import { reactors } from '../../engine/chat';
import { reactionImageUrl } from '../../engine/media';
import { reactionRows, reactionTooltip, shortCount, type Reaction, type ReactionDetail, type ReactionIcon } from '../../engine/models/chat';
import { Avatar } from '../../ui/Avatar';
import { Popover } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';

export function ReactionIconView({ icon, size }: { icon: ReactionIcon; size: number }) {
  const src = reactionImageUrl(icon.image);
  if (src) return <img src={src} width={size} height={size} alt={icon.emoji} draggable={false} />;
  return (
    <span className="reaction-emoji" style={{ fontSize: size * 0.95 }} aria-label={icon.emoji}>
      {icon.emoji}
    </span>
  );
}

export function ReactionChips({ reactions, conversationId, messageId, mine }: { reactions: Reaction[]; conversationId: string; messageId: string; mine: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={anchor} className={`reaction-chips ${mine ? 'is-mine' : ''}`}>
        {reactions.map((r) => (
          <button
            key={r.icon.type}
            className={`reaction-chip glass ${r.includesMe ? 'is-mine' : ''}`}
            title={reactionTooltip(r) ?? ''}
            aria-label={`${r.icon.emoji} ${r.count}`}
            onClick={() => setOpen(true)}
          >
            <ReactionIconView icon={r.icon} size={14} />
            {r.count > 1 && <span className="nums">{r.count}</span>}
          </button>
        ))}
      </div>
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} placement="bottom">
          <ReactionDetailView conversationId={conversationId} messageId={messageId} reactions={reactions} />
        </Popover>
      )}
    </>
  );
}

function ReactionDetailView({ conversationId, messageId, reactions }: { conversationId: string; messageId: string; reactions: Reaction[] }) {
  const [detail, setDetail] = useState<ReactionDetail | null | 'loading'>('loading');
  const [tab, setTab] = useState<string | null>(null);
  const signature = reactions.map((r) => `${r.icon.type}:${r.count}`).join();
  useEffect(() => {
    let cancelled = false;
    void reactors(messageId, conversationId).then((d) => !cancelled && setDetail(d));
    return () => {
      cancelled = true;
    };
  }, [conversationId, messageId, signature]);

  if (detail === 'loading') {
    return (
      <div className="reaction-detail is-centered">
        <Spinner />
      </div>
    );
  }
  if (!detail || detail.users.length === 0) {
    return <div className="reaction-detail is-centered secondary">{detail ? 'Chưa có biểu cảm' : 'Không tải được danh sách biểu cảm.'}</div>;
  }
  const total = detail.users.reduce((n, u) => n + u.total, 0);
  const rows = reactionRows(detail, tab);
  return (
    <div className="reaction-detail">
      <div className="reaction-tabs">
        <button className={`reaction-tab ${tab === null ? 'is-selected' : ''}`} onClick={() => setTab(null)}>
          Tất cả <span className="nums">{shortCount(total)}</span>
        </button>
        {detail.tabs.map((t) => (
          <button key={t.icon.type} className={`reaction-tab ${tab === t.icon.type ? 'is-selected' : ''}`} onClick={() => setTab(t.icon.type)}>
            <ReactionIconView icon={t.icon} size={15} /> <span className="nums">{shortCount(t.total)}</span>
          </button>
        ))}
      </div>
      <div className="reaction-users">
        {rows.map((u) => (
          <div key={u.uid} className="reaction-user">
            <Avatar url={u.avatar} name={u.name} size={30} />
            <span className="truncate" style={{ flex: 1 }}>
              {u.isMe ? `${u.name} (Bạn)` : u.name}
            </span>
            <span className="reaction-user-icons">
              {u.icons.map((i) => (
                <ReactionIconView key={i.icon.type} icon={i.icon} size={14} />
              ))}
            </span>
            <span className="nums secondary">{u.total}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
