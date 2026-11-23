// The Zalo PC list column (docs/zalo-pc-style.md §2), logic from Swift `ConversationListColumn`: the search field with
// Thêm bạn / Tạo nhóm, the "Tất cả | Chưa đọc" tabs (or "Ưu tiên | Khác" with the official Khác feature) with Phân loại ▾
// and ⋯, then 72px rows — pinned chats first, as the official list orders them. The list is exactly what the official
// ConvListController computed for the active filter; search looks through every conversation.

import { Archive, ArrowLeft, ChevronDown, EyeOff, Lock, LockOpen, MoreHorizontal, ShieldHalf, Tag, UserPlus, UserRoundSearch, UsersRound } from 'lucide-react';
import { openAddFriend, openCreateGroup } from '../contacts/hosts';
import { conversationActionsMenu } from '../conversationActions/menu';
import { openLabelManager } from '../conversationActions/LabelManager';
import { hostSettingsLocked } from '../../engine/remote';
import { PINField } from '../conversationActions/ConversationPrompts';
import { hiddenConversations, hiddenStateStallLimit, isHiddenConversation, relockHidden, unlockFromPINSearch } from '../../engine/conversationActions';
import { openConversation } from '../../engine/chat';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
import { labelIdOf, shell, useShell, type Destination } from '../../shell/shellStore';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { ConversationRow, StrangerBoxRow } from './ConversationRow';
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

  // Hidden chats only show up when the search text is the PIN (official sidebar search).
  const [pinMatches, setPinMatches] = useState<string[]>([]);
  const lastSearch = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = query.length === 4 ? ((await hiddenConversations(query)) ?? []) : [];
      if (cancelled) return;
      setPinMatches(found);
      // The search really changed and no longer is the PIN: the bypass of an earlier result ends (not while the mailbox is unlocked).
      if (lastSearch.current !== null && lastSearch.current !== search && found.length === 0 && useShell.getState().unlockedHiddenIds === null) relockHidden();
      lastSearch.current = search;
    })();
    return () => {
      cancelled = true;
    };
  }, [search]);

  // The hidden-chat state did not arrive for a long while: say so instead of spinning forever (everything stays locked).
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (actions.hiddenKnown) return;
    const t = setTimeout(() => setStalled(true), hiddenStateStallLimit);
    return () => clearTimeout(t);
  }, [actions.hiddenKnown]);

  const items = useMemo<ListItem[]>(() => {
    const conv = (c: ConversationSummary): ListItem => ({ kind: 'conversation', conversation: c });
    if (isSearching) {
      const needle = query.toLocaleLowerCase('vi');
      const byPIN = pinMatches.flatMap((id) => conversations.filter((c) => c.id === id)).map(conv);
      return [...byPIN, ...conversations.filter((c) => !isHiddenConversation(getEngine(), c.id) && displayName(c).toLocaleLowerCase('vi').includes(needle)).map(conv)];
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
  }, [conversations, extras, actions, destination, isSearching, query, unlocked, pinMatches]);

  /** Zalo PC keeps pinned chats as rows (first, with a pin): no tiles. Their order is the official list's. */
  const listing = useMemo(() => {
    const s = getEngine();
    const pins = destination === 'inbox' && !isSearching
      ? items.flatMap((i) => (i.kind === 'conversation' && isPinnedConversation(s, i.conversation) ? [i.conversation] : []))
      : [];
    return { pins, rows: items };
  }, [items, destination, isSearching, actions]);

  const loading = conversations.length === 0 || !actions.hiddenKnown;

  const select = useCallback((id: string) => shell.select(id), []);
  const onContextMenu = useCallback((e: ReactMouseEvent, id: string) => openContextMenu(e, conversationActionsMenu(id, 'thread')), []);

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
    const ids = listing.rows.flatMap((i) => (i.kind === 'conversation' ? [i.conversation.id] : []));
    if (!ids.length) return;
    e.preventDefault();
    const at = selection ? ids.indexOf(selection) : -1;
    const next = ids[Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), ids.length - 1)];
    shell.select(next);
    (e.currentTarget as HTMLElement).querySelector(`[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const banner = !isSearching ? bannerFor(destination, unlocked !== null) : null;

  const folder = destination === 'strangers' || destination === 'hidden';

  return (
    <div className="column conv-column">
      <div className="conv-top" data-tauri-drag-region>
        <SearchField />
        <button className="conv-top-button" onClick={() => openAddFriend()} title="Thêm bạn" aria-label="Thêm bạn">
          <UserPlus size={18} />
        </button>
        <button className="conv-top-button" onClick={() => openCreateGroup()} title="Tạo nhóm trò chuyện (⇧⌘N)" aria-label="Tạo nhóm">
          <UsersRound size={18} />
        </button>
      </div>
      {isSearching ? (
        <div className="conv-tabs">
          <span className="conv-search-title">Kết quả tìm kiếm</span>
        </div>
      ) : folder ? (
        <div className="conv-tabs is-folder">
          <button className="conv-back" onClick={() => shell.setDestination('inbox')} title="Quay lại" aria-label="Quay lại">
            <ArrowLeft size={17} />
          </button>
          <span className="conv-folder-title">{destination === 'strangers' ? 'Tin nhắn từ người lạ' : 'Trò chuyện ẩn'}</span>
        </div>
      ) : (
        <ListTabs destination={destination} activeLabel={activeLabel} offersLabelFilter={offersLabelFilter} />
      )}
      {loading ? (
        <ConversationListLoading stalled={stalled && !actions.hiddenKnown} />
      ) : destination === 'hidden' && actions.hasHiddenPIN && unlocked === null && !isSearching ? (
        <HiddenMailboxLocked />
      ) : listing.rows.length === 0 ? (
        <div className="conv-empty-wrap">
          {banner}
          <ConversationListEmpty
            destination={destination}
            searchText={isSearching ? query : null}
            hiddenEnabled={actions.hiddenEnabled}
            onClearSearch={() => shell.setSearch('')}
            onShowAll={() => shell.setDestination('inbox')}
          />
        </div>
      ) : (
        <div className="conv-list" role="listbox" tabIndex={0} onKeyDown={onListKey} aria-label={titleFor(destination)}>
          {banner && <div className="conv-banner-wrap">{banner}</div>}
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
                showsPin={isPinnedConversation(getEngine(), item.conversation)}
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

const tabTitle = (f: TypeFilter) => (f === TypeFilter.all ? 'Tất cả' : f === TypeFilter.focused ? 'Ưu tiên' : typeFilterTitle(f));
const tabDestination = (f: TypeFilter): Destination => (f === TypeFilter.other ? 'other' : f === TypeFilter.unread ? 'unread' : 'inbox');

/** "Tất cả | Chưa đọc" (or "Ưu tiên | Khác | Chưa đọc"), then Phân loại ▾ and ⋯ on the right. */
function ListTabs({ destination, activeLabel, offersLabelFilter }: { destination: Destination; activeLabel: ConversationLabel | null; offersLabelFilter: boolean }) {
  const archivedEnabled = useEngine((s) => s.extras.archivedEnabled);
  const hiddenEnabled = useEngine((s) => s.conversationActions.hiddenEnabled);
  const tabs = archivedEnabled ? [TypeFilter.focused, TypeFilter.other, TypeFilter.unread] : [TypeFilter.all, TypeFilter.unread];
  const current: Destination = labelIdOf(destination) ? 'inbox' : destination;
  return (
    <div className="conv-tabs" role="tablist">
      {tabs.map((t) => {
        const d = tabDestination(t);
        const on = current === d;
        return (
          <button key={t} role="tab" aria-selected={on} className={`conv-tab ${on ? 'is-active' : ''}`} onClick={() => shell.setDestination(d)}>
            {tabTitle(t)}
          </button>
        );
      })}
      <span className="conv-tabs-spacer" />
      {offersLabelFilter && <LabelFilterButton active={activeLabel} />}
      <button
        className="conv-tab-icon"
        title="Thêm"
        aria-label="Thêm"
        onClick={(e) =>
          openMenuBelow(
            e.currentTarget,
            [
              { label: 'Tin nhắn từ người lạ', icon: UserRoundSearch, onSelect: () => shell.setDestination('strangers') },
              ...(hiddenEnabled ? [{ label: 'Trò chuyện ẩn', icon: EyeOff, onSelect: () => shell.setDestination('hidden') } as MenuItem] : []),
            ],
            'end',
          )
        }
      >
        <MoreHorizontal size={17} />
      </button>
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
      <ListBanner icon={LockOpen} lead="Đang mở khoá." actionTitle="Khoá" onAction={relockHiddenMailbox}>
        Tự khoá lại khi bạn rời {appName} một phút.
      </ListBanner>
    );
  return null;
};

/** "Phân loại ▾": picks the label that filters the inbox ("Tất cả" clears it); shows the active label's name. */
function LabelFilterButton({ active }: { active: ConversationLabel | null }) {
  const open = (el: Element) => {
    const s = getEngine();
    const counts = unreadCounts(s);
    openMenuBelow(
      el,
      [
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
        { label: 'Quản lý thẻ phân loại', disabled: hostSettingsLocked(), onSelect: openLabelManager },
      ],
      'end',
    );
  };
  const color = active ? (cssColor(active.colorHex) ?? undefined) : undefined;
  return (
    <button className={`conv-label-filter ${active ? 'is-active' : ''}`} onClick={(e) => open(e.currentTarget)} title="Lọc theo thẻ phân loại">
      {active ? <Tag size={13} fill={color} color={color} /> : null}
      <span className="truncate">{active ? active.name : 'Phân loại'}</span>
      <ChevronDown size={14} />
    </button>
  );
}


/** "Khoá": forget the PIN bypass and leave a hidden chat that is still open. */
const relockHiddenMailbox = () => {
  useShell.setState({ unlockedHiddenIds: null });
  relockHidden();
  const selected = useShell.getState().selection;
  if (selected && isHiddenConversation(getEngine(), selected)) shell.select(null);
};

/** "Trò chuyện ẩn" while locked: the 4-digit PIN lists the hidden chats (the same search the list field runs for a PIN). */
function HiddenMailboxLocked() {
  const [wrong, setWrong] = useState(false);
  const [checking, setChecking] = useState(false);
  const [token, setToken] = useState(0);
  const submit = async (pin: string) => {
    setChecking(true);
    // Nothing is unlocked by this: the call lists the hidden chats, and opening one unlocks just that chat.
    const ids = await hiddenConversations(pin);
    setChecking(false);
    setToken((t) => t + 1);
    if (ids) {
      setWrong(false);
      useShell.setState({ unlockedHiddenIds: ids });
      // A hidden chat already selected opens now (the PIN search results unlock what is opened from them).
      const selected = useShell.getState().selection;
      if (selected && ids.includes(selected) && unlockFromPINSearch(selected)) openConversation(selected);
      return;
    }
    setWrong(true);
    setTimeout(() => setWrong(false), 2500);
  };
  return (
    <div className="hidden-locked">
      <Lock size={44} className="tertiary" />
      <div className="hidden-locked-title">Trò chuyện ẩn đang khoá</div>
      <div className="secondary">Nhập mã PIN gồm 4 chữ số để xem các trò chuyện ẩn.</div>
      <div className={wrong ? 'shake' : ''}>
        <PINField key={token} onDone={(pin) => void submit(pin)} disabled={checking} />
      </div>
      <div className="hidden-locked-error" style={{ opacity: wrong ? 1 : 0 }}>
        Mã PIN không đúng
      </div>
    </div>
  );
}
