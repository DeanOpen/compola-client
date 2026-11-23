// The conversation's pins above its messages (official topic banner, Swift `PinnedBar`): the newest pin, the others in
// a menu.

import { ArrowRightCircle, Pin, PinOff } from 'lucide-react';
import { requestUnpin } from '../../engine/messageActions';
import { pinnedLabel, type PinnedItem } from '../../engine/models/outcomes';
import { useEngine } from '../../engine/store';
import { openMenuBelow, type MenuItem } from '../../ui/Menu';
import { RemoteImage } from '../../ui/RemoteImage';

export function PinnedBar({ conversationId, open }: { conversationId: string; open: (item: PinnedItem) => void }) {
  const list = useEngine((s) => s.pins[conversationId]);
  if (!list || !list.ready || list.items.length === 0) return null;
  const first = list.items[0];
  const caption = (item: PinnedItem) => (item.sender ? `${pinnedLabel(item)} của ${item.sender}` : pinnedLabel(item));
  return (
    <div className="pinned-bar glass slide-up" aria-label="Tin nhắn đã ghim">
      <Pin size={13} className="pinned-icon" fill="currentColor" />
      <button className="pinned-main" onClick={() => open(first)} title={first.title}>
        {first.thumbnail && <RemoteImage url={first.thumbnail} className="pinned-thumb" placeholder={<span />} />}
        <span className="pinned-text">
          <span className="pinned-caption truncate">{caption(first)}</span>
          <span className="pinned-title truncate">{first.title || pinnedLabel(first)}</span>
        </span>
      </button>
      {list.items.length > 1 ? (
        <button
          className="btn btn-glass btn-small"
          title={`Danh sách ghim (${list.items.length})`}
          onClick={(e) =>
            openMenuBelow(
              e.currentTarget,
              list.items.map(
                (item): MenuItem => ({
                  kind: 'submenu',
                  label: (item.title || pinnedLabel(item)).slice(0, 60),
                  items: [
                    { label: item.kind === 'message' ? 'Xem tin nhắn' : 'Xem', icon: ArrowRightCircle, onSelect: () => open(item) },
                    ...(list.canPin ? [{ label: 'Bỏ ghim', icon: PinOff, destructive: true, onSelect: () => requestUnpin(item, conversationId) } as MenuItem] : []),
                  ],
                }),
              ),
              'end',
            )
          }
        >
          +{list.items.length - 1} ghim
        </button>
      ) : list.canPin ? (
        <button className="icon-button" style={{ width: 24, height: 24 }} title="Bỏ ghim" aria-label="Bỏ ghim" onClick={() => requestUnpin(first, conversationId)}>
          <PinOff size={13} />
        </button>
      ) : null}
    </div>
  );
}
