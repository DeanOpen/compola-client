// Content column for the conversation mailboxes / labels (Swift `ConversationListColumn`): search field (and the label
// filter of the inbox) on top, pinned tiles, then the rows. The list is exactly what the official ConvListController
// computed for the active filter; search looks through every conversation.

import { Archive, LockOpen, ShieldHalf, Tag, UsersRound, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { setConversationLabel } from '../../engine/conversations';
import {
  cssColor,
  displayName,
  inboxTitle,
  labelOf,
  strangerBoxId,
  typeFilterTitle,
  TypeFilter,
  type ConversationLabel,
  type ConversationSummary,
} from '../../engine/models/conversations';
import { getEngine, isPinnedConversation, useEngine } from '../../engine/store';
import { appName } from '../setup/SplashView';
import { ColumnToolbar } from '../../shell/MainShell';
import { labelIdOf, shell, useShell, type Destination } from '../../shell/shellStore';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { ConversationRow, PinTile, StrangerBoxRow } from './ConversationRow';
import { ConversationListEmpty, ConversationListLoading, ListBanner } from './ConversationListStates';
import { SearchField } from './SearchField';
import { unreadCounts, unreadInLabel } from './support';
import './conversations.css';

type ListItem = { kind: 'conversation'; conversation: ConversationSummary } | { kind: 'strangerBox' };

export function ConversationListColumn() {
  const { rawDestination, search, selection, unlocked } = useShell(
    useShallow((s) => ({ rawDestination: s.destination, search: s.search, selection: s.selection, unlocked: s.unlockedHiddenIds })),
  );
  const conversations = useEngine((s) => s.conversations);
  const extras = useEngine((s) => s.extras);
  const actions = useEngine((s) => s.conversationActions);
  const selfId = useEngine((s) => s.selfConversationId);
  const typing = useEngine((s) => s.typing);
  const mutedIds = useEngine((s) => s.mutedIds);

  /** "Cloud của tôi" is the inbox with the self conversation open. */
  const destination: Destination = rawDestination === 'myCloud' ? 'inbox' : rawDestination;
  const query = search.trim();
  const isSearching = query.length > 0;
  const activeLabel = !isSearching ? labelFor(destination, extras.labels) : null;
  const offersLabelFilter = extras.loaded && (destination === 'inbox' || labelIdOf(destination) !== null);

  const items = useMemo<ListItem[]>(() => {
    const conv = (c: ConversationSummary): ListItem => ({ kind: 'conversation', conversation: c });
    if (isSearching) {
      const needle = query.toLocaleLowerCase('vi');
      return conversations.filter((c) => !actions.hiddenIds.has(c.id) && displayName(c).toLocaleLowerCase('vi').includes(needle)).map(conv);
    }
    const byId = new Map(conversations.map((c) => [c.id, c]));
    if (destination === 'hidden') return (unlocked ?? []).flatMap((id) => (byId.has(id) ? [conv(byId.get(id)!)] : []));
    // Hidden chats are removed in every mode (the controller may still list one right after a local hide).
    for (const id of actions.hiddenIds) byId.delete(id);
    if (!extras.loaded) return [...byId.values()].map(conv);
    if (destination === 'strangers') return extras.strangerFolderIds.flatMap((id) => (byId.has(id) ? [conv(byId.get(id)!)] : []));
    return extras.listIds.flatMap((id): ListItem[] => {
      if (id === strangerBoxId) return extras.strangerBox.chats > 0 ? [{ kind: 'strangerBox' }] : [];
      const c = byId.get(id);
      return c ? [conv(c)] : [];
    });
  }, [conversations, extras, actions, destination, isSearching, query, unlocked]);

  /** In the inbox the pinned chats leave the rows and become tiles (not while searching). */
  const listing = useMemo(() => {
    if (destination !== 'inbox' || isSearching) return { pins: [] as ConversationSummary[], rows: items };
    const s = getEngine();
    const pins: ConversationSummary[] = [];
    const rows: ListItem[] = [];
    for (const item of items) {
      if (item.kind === 'conversation' && isPinnedConversation(s, item.conversation)) pins.push(item.conversation);
      else rows.push(item);
    }
    return { pins, rows };
  }, [items, destination, isSearching, actions]);

  const unreadChats =
    listing.rows.reduce((n, i) => n + (i.kind === 'conversation' && i.conversation.unread > 0 ? 1 : 0), 0) +
    listing.pins.filter((c) => c.unread > 0).length;
  const loading = conversations.length === 0 || !actions.hiddenKnown;
  const status = unreadChats > 0 ? `${unreadChats} cuộc trò chuyện chưa đọc` : 'Đã đọc hết';
  const subtitle = loading ? (activeLabel?.name ?? '') : activeLabel ? `${activeLabel.name} · ${status}` : status;

  const select = useCallback((id: string) => shell.select(id), []);
  const onContextMenu = useCallback((e: ReactMouseEvent, id: string) => openContextMenu(e, conversationMenu(id)), []);

  // ⌘1…⌘9 open the pinned tiles while the list is on screen.
  const pinsRef = useRef(listing.pins);
  pinsRef.current = listing.pins;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.shiftKey || e.ctrlKey || !/^Digit[1-9]$/.test(e.code)) return;
      const c = pinsRef.current[Number(e.code.slice(5)) - 1];
      if (!c) return;
      e.preventDefault();
      shell.select(c.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ↑ / ↓ move the selection through the rows when the list has focus.
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const ids = [...listing.pins.map((c) => c.id), ...listing.rows.flatMap((i) => (i.kind === 'conversation' ? [i.conversation.id] : []))];
    if (!ids.length) return;
    e.preventDefault();
    const at = selection ? ids.indexOf(selection) : -1;
    const next = ids[Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), ids.length - 1)];
    shell.select(next);
    (e.currentTarget as HTMLElement).querySelector(`[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const banner = !isSearching ? bannerFor(destination, unlocked !== null) : null;

  return (
    <div className="column conv-column">
      <ColumnToolbar title={titleFor(destination)} subtitle={subtitle} />
      <div className="conv-header">
        <div className="conv-header-row">
          <SearchField />
          {offersLabelFilter && <LabelFilterButton active={activeLabel} disabled={isSearching} />}
          <button className="circle-glass" style={{ width: 30, height: 30 }} disabled title="Tạo nhóm trò chuyện (⇧⌘N)" aria-label="Tạo nhóm">
            <UsersRound size={14} />
          </button>
        </div>
        {activeLabel && <LabelChip label={activeLabel} onClear={() => shell.setDestination('inbox')} />}
      </div>
      {loading ? (
        <ConversationListLoading />
      ) : listing.pins.length === 0 && listing.rows.length === 0 ? (
        <div className="conv-empty-wrap">
          {banner}
          <ConversationListEmpty destination={destination} searchText={isSearching ? query : null} hiddenEnabled={actions.hiddenEnabled} />
        </div>
      ) : (
        <div className="conv-list" role="listbox" tabIndex={0} onKeyDown={onListKey} aria-label={titleFor(destination)}>
          {banner && <div className="conv-banner-wrap">{banner}</div>}
          {listing.pins.length > 0 && (
            <div className="pin-grid">
              {listing.pins.map((c, i) => (
                <PinTile
                  key={c.id}
                  conversation={c}
                  index={i}
                  isSelf={c.id === selfId}
                  selected={selection === c.id}
                  muted={mutedIds.has(c.id)}
                  unreadMark={actions.unreadMarkIds.has(c.id)}
                  onSelect={select}
                  onContextMenu={onContextMenu}
                />
              ))}
            </div>
          )}
          {isSearching && <div className="conv-section-title">Cuộc trò chuyện</div>}
          {listing.rows.map((item) =>
            item.kind === 'strangerBox' ? (
              <StrangerBoxRow
                key={strangerBoxId}
                box={extras.strangerBox}
                newest={conversations.find((c) => c.id === extras.strangerBox.newestId && !actions.hiddenIds.has(c.id)) ?? null}
                onOpen={() => {
                  shell.setSearch('');
                  shell.setDestination('strangers');
                }}
              />
            ) : (
              <ConversationRow
                key={item.conversation.id}
                conversation={item.conversation}
                label={labelOf(extras, item.conversation.id)}
                showsPin={!(destination === 'inbox' && !isSearching) && isPinnedConversation(getEngine(), item.conversation)}
                unreadMark={actions.unreadMarkIds.has(item.conversation.id)}
                isStranger={destination !== 'strangers' && extras.strangerIds.has(item.conversation.id)}
                isSelf={item.conversation.id === selfId}
                muted={mutedIds.has(item.conversation.id)}
                typing={typing[item.conversation.id]}
                selected={selection === item.conversation.id}
                onSelect={select}
                onContextMenu={onContextMenu}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

const labelFor = (d: Destination, labels: ConversationLabel[]) => {
  const id = labelIdOf(d);
  return id ? (labels.find((l) => l.id === id) ?? null) : null;
};

const titleFor = (d: Destination): string => {
  if (d === 'other') return typeFilterTitle(TypeFilter.other);
  if (d === 'unread') return typeFilterTitle(TypeFilter.unread);
  if (d === 'strangers') return 'Người lạ';
  if (d === 'hidden') return 'Trò chuyện ẩn';
  return inboxTitle;
};

const bannerFor = (d: Destination, hiddenUnlocked: boolean) => {
  if (d === 'strangers')
    return (
      <ListBanner icon={ShieldHalf} lead="Tin nhắn từ người lạ" separator={<br />}>
        Người gửi chưa có trong danh bạ. Trả lời để chuyển vào {inboxTitle}.
        <br />
        Lưu ý rủi ro lừa đảo từ người lạ.
      </ListBanner>
    );
  if (d === 'other')
    return (
      <ListBanner icon={Archive} lead="Khác">
        giữ các nhóm đông người và tin ít quan trọng, không làm phiền bạn.
      </ListBanner>
    );
  if (d === 'hidden' && hiddenUnlocked)
    return (
      <ListBanner icon={LockOpen} lead="Đang mở khoá.">
        Tự khoá lại khi bạn rời {appName} một phút.
      </ListBanner>
    );
  return null;
};

/**
 * Context menu of a conversation. The full official menu (pin, mute, hide, delete, mark read…) arrives with the
 * conversation-actions wave; the label ("Phân loại") items are the official label manager already.
 */
const conversationMenu = (id: string): MenuItem[] => {
  const s = getEngine();
  const current = s.extras.labelByConversation[id] ?? null;
  const labels: MenuItem[] = s.extras.labels.map((l) => ({
    label: l.name,
    dot: cssColor(l.colorHex) ?? undefined,
    checked: current === l.id,
    onSelect: () => setConversationLabel(id, current === l.id ? null : l.id),
  }));
  return [
    { label: 'Mở cuộc trò chuyện', onSelect: () => shell.select(id) },
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: 'Phân loại',
      icon: Tag,
      disabled: !s.extras.loaded,
      items: labels.length ? labels : [{ label: 'Chưa có thẻ phân loại', disabled: true, onSelect: () => {} }],
    },
  ];
};

/** Round glass button beside the search field: picks the label that filters "Tin nhắn" ("Tất cả" clears it). */
function LabelFilterButton({ active, disabled }: { active: ConversationLabel | null; disabled: boolean }) {
  const open = (el: Element) => {
    const s = getEngine();
    const counts = unreadCounts(s);
    openMenuBelow(el, [
      { label: 'Tất cả', checked: !active, onSelect: () => shell.setDestination('inbox') },
      { kind: 'separator' },
      ...(s.extras.labels.length === 0 ? [{ label: 'Chưa có thẻ phân loại', disabled: true, onSelect: () => {} } as MenuItem] : []),
      ...s.extras.labels.map((l): MenuItem => {
        const unread = unreadInLabel(counts, l);
        return {
          label: l.name,
          dot: cssColor(l.colorHex) ?? undefined,
          checked: active?.id === l.id,
          trailing: unread > 0 ? <span className="menu-shortcut">{unread}</span> : undefined,
          onSelect: () => shell.setDestination(active?.id === l.id ? 'inbox' : `label:${l.id}`),
        };
      }),
      { kind: 'separator' },
      { label: 'Quản lý thẻ phân loại…', disabled: true, onSelect: () => {} },
    ]);
  };
  return (
    <button
      className={`circle-glass ${active ? 'is-active-filter' : ''}`}
      style={{ width: 30, height: 30 }}
      disabled={disabled}
      onClick={(e) => open(e.currentTarget)}
      title="Lọc theo thẻ phân loại"
      aria-label="Lọc theo thẻ phân loại"
    >
      <Tag size={14} fill={active ? 'currentColor' : 'none'} />
    </button>
  );
}

/** "● Gia đình  ✕" under the search field while a label filters the inbox. */
function LabelChip({ label, onClear }: { label: ConversationLabel; onClear: () => void }) {
  return (
    <div className="label-chip glass slide-up">
      <span className="label-chip-dot" style={{ background: cssColor(label.colorHex) ?? 'var(--accent)' }} />
      <span className="truncate">{label.name}</span>
      <button className="icon-button" style={{ width: 16, height: 16 }} onClick={onClear} title="Bỏ lọc" aria-label={`Bỏ lọc ${label.name}`}>
        <X size={10} strokeWidth={3} />
      </button>
    </div>
  );
}
