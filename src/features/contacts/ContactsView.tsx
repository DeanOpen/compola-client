// "Danh bạ": friends and groups (Swift ContactsView.swift) in Zalo PC's layout: a page with a title bar, the count, a panel with
// search / sort / filter, then the list. A click opens the conversation; ⋯ (or a right click) opens the row menu; "Xem thông tin"
// shows the profile dialog (ProfileCard.tsx). Wave 4 (docs/design-refs/wave4/contacts): presence tabs, status subtitles, a hover
// "Nhắn tin" quick action, label chips and sticky letter headers.

import { ArrowDownUp, ChevronDown, Filter, Info, MessageCircle, MoreHorizontal, Phone, Tag, UserRound, Users, Video } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { callAvailability, startCall, useCalls } from '../../engine/calls';
import {
  ago,
  compareSections,
  contactFold,
  openContactConversation,
  standardCompare,
  useContacts,
  visibleFriends,
  visibleGroups,
  type ContactGroup,
  type Friend,
} from '../../engine/contacts';
import { phoneMatches, phoneText, useContactPhones } from '../../engine/contactPhones';
import { setConversationLabel } from '../../engine/conversations';
import { cssColor, type ConversationLabel } from '../../engine/models/conversations';
import { getEngine, useEngine } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { ContactsEmpty, ContactsLoading, ContactsPageHeader, ContactsSearchField } from './ContactsShared';
import { contactsUi, useContactsUi, type FriendSort } from './contactsUi';
import './contactsPages.css';

// MARK: - Visible lists

export const useVisibleFriends = (): Friend[] => {
  const contacts = useContacts();
  const actions = useEngine((s) => s.conversationActions);
  return useMemo(() => visibleFriends(contacts, getEngine()), [contacts, actions]);
};

export const useVisibleGroups = (): ContactGroup[] => {
  const contacts = useContacts();
  const actions = useEngine((s) => s.conversationActions);
  return useMemo(() => visibleGroups(contacts, getEngine()), [contacts, actions]);
};

const useHiddenKnown = () => useEngine((s) => s.conversationActions.hiddenKnown);

// MARK: - Menus

/** "Phân loại" submenu of a friend / group row (the conversation's label). */
const labelMenu = (id: string, labels: ConversationLabel[], current: string | null): MenuItem => ({
  kind: 'submenu',
  label: 'Phân loại',
  icon: Tag,
  items: labels.length
    ? labels.map((l) => ({
        label: l.name,
        dot: cssColor(l.colorHex) ?? undefined,
        checked: current === l.id,
        onSelect: () => setConversationLabel(id, current === l.id ? null : l.id),
      }))
    : [{ label: 'Chưa có thẻ phân loại', disabled: true, onSelect: () => {} }],
});

const friendMenuItems = (friend: Friend): MenuItem[] => {
  const engine = getEngine();
  const calls = useCalls.getState();
  const target = { id: friend.id, isGroup: false };
  const audio = callAvailability(calls, target, false, engine.selfConversationId);
  const video = callAvailability(calls, target, true, engine.selfConversationId);
  const items: MenuItem[] = [
    { label: 'Xem thông tin', icon: Info, onSelect: () => contactsUi.showProfile(friend.id) },
    { label: 'Nhắn tin', icon: MessageCircle, onSelect: () => openContactConversation(friend.id) },
  ];
  if (audio.kind !== 'hidden') items.push({ label: 'Gọi thoại', icon: Phone, disabled: audio.kind !== 'available', onSelect: () => startCall(friend.id, false) });
  if (video.kind !== 'hidden') items.push({ label: 'Gọi video', icon: Video, disabled: video.kind !== 'available', onSelect: () => startCall(friend.id, true) });
  items.push({ kind: 'separator' }, labelMenu(friend.id, engine.extras.labels, engine.extras.labelByConversation[friend.id] ?? null));
  return items;
};

const groupMenuItems = (group: ContactGroup): MenuItem[] => {
  const engine = getEngine();
  return [
    { label: 'Mở trò chuyện', icon: MessageCircle, onSelect: () => openContactConversation(group.id) },
    { kind: 'separator' },
    labelMenu(group.id, engine.extras.labels, engine.extras.labelByConversation[group.id] ?? null),
  ];
};

// MARK: - Rows

/** A friend / group row: click opens the conversation, ⋯ and right click open the row menu. */
function ContactRow({
  name,
  avatar,
  online = false,
  subtitle,
  subtitleTone,
  label,
  menu,
  onOpen,
}: {
  name: string;
  avatar: string | null;
  online?: boolean;
  subtitle?: ReactNode;
  subtitleTone?: 'online';
  label?: ConversationLabel | null;
  menu: () => MenuItem[];
  onOpen: () => void;
}) {
  const showMenu = (e: MouseEvent, below: boolean) => {
    if (below) openMenuBelow(e.currentTarget, menu(), 'end');
    else openContextMenu(e, menu());
  };
  const color = label ? cssColor(label.colorHex) : null;
  return (
    <div
      className="ct-row"
      role="button"
      tabIndex={0}
      aria-label={online ? `${name}, đang hoạt động` : name}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      onContextMenu={(e) => showMenu(e, false)}
    >
      <span className="ct-row-avatar">
        <Avatar url={avatar} name={name} size={48} />
        {online && <span className="ct-presence" aria-hidden />}
      </span>
      <span className="ct-row-text">
        <span className="ct-row-name truncate">{name}</span>
        {subtitle && <span className={`ct-row-sub truncate ${subtitleTone === 'online' ? 'is-online' : ''}`}>{subtitle}</span>}
      </span>
      {label && (
        <span className="cp-row-label" title={`Phân loại: ${label.name}`} style={color ? { color, background: `color-mix(in srgb, ${color} 14%, transparent)` } : undefined}>
          <Tag size={11} fill="currentColor" />
          <span className="truncate">{label.name}</span>
        </span>
      )}
      <button
        className="cp-row-quick"
        title="Nhắn tin"
        aria-label={`Nhắn tin cho ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <MessageCircle size={16} />
      </button>
      <button
        className="ct-row-more"
        title="Tùy chọn"
        aria-label={`Tùy chọn cho ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          showMenu(e, true);
        }}
      >
        <MoreHorizontal size={16} />
      </button>
    </div>
  );
}

/** Pull-down control of the filter bar ("Tên (A-Z) ▾", "Tất cả ▾"). */
function FilterSelect({ icon: Icon, text, active, items }: { icon: typeof Filter; text: string; active?: boolean; items: () => MenuItem[] }) {
  return (
    <button className={`ct-select ${active ? 'is-active' : ''}`} onClick={(e) => openMenuBelow(e.currentTarget, items())}>
      <Icon size={14} />
      <span className="truncate">{text}</span>
      <ChevronDown size={14} className="ct-select-chevron" />
    </button>
  );
}

const sortText = (sort: FriendSort) => (sort === 'az' ? 'Tên (A-Z)' : 'Tên (Z-A)');

const sortItems = (sort: FriendSort, set: (s: FriendSort) => void): MenuItem[] => [
  { label: 'Tên (A-Z)', checked: sort === 'az', onSelect: () => set('az') },
  { label: 'Tên (Z-A)', checked: sort === 'za', onSelect: () => set('za') },
];

/** A friend's second line: "Đang hoạt động", "Truy cập 5 phút trước", or the Zalo name. */
const friendStatus = (f: Friend): string | undefined => {
  if (f.online) return 'Đang hoạt động';
  if (f.lastActive) return `Truy cập ${ago(f.lastActive)}`;
  return f.zaloName && f.zaloName !== f.name ? f.zaloName : undefined;
};

/** "0912 345 678 · Truy cập 5 phút trước": the number found by phone (when known) before the status. */
const withPhone = (phone: string | null, status: string | undefined): string | undefined =>
  phone ? (status ? `${phone} · ${status}` : phone) : status;

/** Text tab of the friends panel ("Tất cả 17 · Đang hoạt động 3"), Zalo PC underline style. */
function PresenceTab({ selected, onClick, title, count, dot }: { selected: boolean; onClick: () => void; title: string; count: number; dot?: boolean }) {
  return (
    <button className={`cp-tab ${selected ? 'is-selected' : ''}`} role="tab" aria-selected={selected} onClick={onClick}>
      {dot && <span className="cp-tab-dot" aria-hidden />}
      {title}
      <span className="cp-tab-count nums">{count}</span>
    </button>
  );
}

// MARK: - Friends

/** "Danh sách bạn bè": alphabetical friends with letter headers, search, sort and the "Phân loại" filter. */
export function FriendsPage() {
  const friendsLoaded = useContacts((s) => s.friendsLoaded);
  const hiddenKnown = useHiddenKnown();
  const friends = useVisibleFriends();
  const labels = useEngine((s) => s.extras.labels);
  const labelOf = useEngine((s) => s.extras.labelByConversation);
  const sort = useContactsUi((s) => s.friendSort);
  const labelFilter = useContactsUi((s) => s.friendLabel);
  const [query, setQuery] = useState('');
  const [presence, setPresence] = useState<'all' | 'online'>('all');
  const phones = useContactPhones((s) => s.book);
  const activeLabel = labels.find((l) => l.id === labelFilter) ?? null;
  const onlineCount = useMemo(() => friends.filter((f) => f.online).length, [friends]);

  // A label deleted meanwhile stops filtering.
  useEffect(() => {
    if (labelFilter && !activeLabel) contactsUi.setFriendLabel(null);
  }, [labelFilter, activeLabel]);

  const sections = useMemo(() => {
    const q = contactFold(query).trim();
    let matches = q
      ? friends.filter((f) => f.sortKey.includes(q) || contactFold(f.zaloName).includes(q) || phoneMatches(phones, f.id, query))
      : friends;
    if (activeLabel) matches = matches.filter((f) => labelOf[f.id] === activeLabel.id);
    if (presence === 'online') matches = matches.filter((f) => f.online);
    const grouped = new Map<string, Friend[]>();
    for (const f of matches) grouped.set(f.section, [...(grouped.get(f.section) ?? []), f]);
    const dir = sort === 'az' ? 1 : -1;
    return [...grouped.keys()]
      .sort((a, b) => (a === '#' || b === '#' ? compareSections(a, b) : dir * compareSections(a, b)))
      .map((letter) => ({ letter, friends: grouped.get(letter)!.sort((a, b) => dir * standardCompare(a.sortKey, b.sortKey)) }));
  }, [friends, query, sort, activeLabel, labelOf, presence, phones]);

  let body: ReactNode;
  if (!friendsLoaded || !hiddenKnown) body = <ContactsLoading text="Đang tải danh sách bạn bè…" />;
  else if (friends.length === 0)
    body = (
      <ContactsEmpty
        icon={Users}
        title="Chưa có bạn bè"
        description="Tìm bạn bằng số điện thoại để gửi lời mời kết bạn."
        action={
          <button className="ct-btn ct-btn-primary" onClick={contactsUi.openAddFriend}>
            Thêm bạn
          </button>
        }
      />
    );
  else if (sections.length === 0)
    body =
      presence === 'online' && !query && !activeLabel ? (
        <ContactsEmpty icon={UserRound} title="Chưa có bạn bè nào đang hoạt động" description="Bạn bè đang mở Zalo sẽ hiện ở đây." />
      ) : (
        <ContactsEmpty icon={UserRound} title="Không tìm thấy kết quả" description="Vui lòng thử lại từ khóa hoặc bộ lọc khác." />
      );
  else
    body = (
      <div className="ct-list" aria-label="Bạn bè">
        {sections.map((section) => (
          <div key={section.letter} role="group" aria-label={section.letter}>
            <div className="ct-letter">{section.letter}</div>
            {section.friends.map((friend) => (
              <ContactRow
                key={friend.id}
                name={friend.name}
                avatar={friend.avatar}
                online={friend.online}
                subtitle={withPhone(phones[friend.id] ? phoneText(phones[friend.id]) : null, friendStatus(friend))}
                subtitleTone={friend.online ? 'online' : undefined}
                label={labels.find((l) => l.id === labelOf[friend.id]) ?? null}
                menu={() => friendMenuItems(friend)}
                onOpen={() => openContactConversation(friend.id)}
              />
            ))}
          </div>
        ))}
      </div>
    );

  return (
    <div className="ct-page">
      <ContactsPageHeader icon={UserRound} title="Danh sách bạn bè" />
      <div className="ct-page-scroll">
        <div className="ct-list-title">Bạn bè ({friends.length})</div>
        <div className="ct-panel cp-panel">
          <div className="cp-tabs" role="tablist" aria-label="Lọc theo trạng thái">
            <PresenceTab selected={presence === 'all'} onClick={() => setPresence('all')} title="Tất cả" count={friends.length} />
            <PresenceTab selected={presence === 'online'} onClick={() => setPresence('online')} title="Đang hoạt động" count={onlineCount} dot />
          </div>
          <div className="ct-filter">
            <ContactsSearchField value={query} onChange={setQuery} placeholder="Tìm bạn" />
            <div className="ct-filter-selects">
              <FilterSelect icon={ArrowDownUp} text={sortText(sort)} items={() => sortItems(sort, contactsUi.setFriendSort)} />
              <FilterSelect
                icon={Filter}
                text={activeLabel ? activeLabel.name : 'Tất cả'}
                active={!!activeLabel}
                items={() => [
                  { label: 'Tất cả', checked: !activeLabel, onSelect: () => contactsUi.setFriendLabel(null) },
                  {
                    kind: 'submenu',
                    label: 'Phân loại',
                    icon: Tag,
                    items: labels.length
                      ? labels.map((l) => ({
                          label: l.name,
                          dot: cssColor(l.colorHex) ?? undefined,
                          checked: activeLabel?.id === l.id,
                          onSelect: () => contactsUi.setFriendLabel(l.id),
                        }))
                      : [{ label: 'Chưa có thẻ phân loại', disabled: true, onSelect: () => {} }],
                  },
                ]}
              />
            </div>
          </div>
          {body}
        </div>
      </div>
    </div>
  );
}

// MARK: - Groups

/** "Danh sách nhóm và cộng đồng": the groups the user is in, with member counts. */
export function GroupsPage() {
  const groupsLoaded = useContacts((s) => s.groupsLoaded);
  const hiddenKnown = useHiddenKnown();
  const visible = useVisibleGroups();
  const labels = useEngine((s) => s.extras.labels);
  const labelOf = useEngine((s) => s.extras.labelByConversation);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<FriendSort>('az');

  const groups = useMemo(() => {
    const q = contactFold(query).trim();
    const list = q ? visible.filter((g) => g.sortKey.includes(q)) : visible;
    const dir = sort === 'az' ? 1 : -1;
    return [...list].sort((a, b) => dir * standardCompare(a.sortKey, b.sortKey));
  }, [visible, query, sort]);

  let body: ReactNode;
  if (!groupsLoaded || !hiddenKnown) body = <ContactsLoading text="Đang tải danh sách nhóm…" />;
  else if (visible.length === 0)
    // Official empty group list: STR_TEXT_CREATE_GROUPS_LIST + "Tạo nhóm".
    body = (
      <ContactsEmpty
        icon={Users}
        title="Chưa tham gia nhóm nào"
        description="Tạo nhóm để cùng nhau trò chuyện và trao đổi với bạn bè đồng nghiệp"
        action={
          <button className="ct-btn ct-btn-primary" onClick={() => contactsUi.composeGroup()}>
            Tạo nhóm
          </button>
        }
      />
    );
  else if (groups.length === 0) body = <ContactsEmpty icon={Users} title="Không tìm thấy kết quả" description="Vui lòng thử lại từ khóa khác." />;
  else
    body = (
      <div className="ct-list" aria-label="Nhóm và cộng đồng">
        {groups.map((group) => (
          <ContactRow
            key={group.id}
            name={group.name}
            avatar={group.avatar}
            subtitle={`${group.members.toLocaleString('vi-VN')} thành viên`}
            label={labels.find((l) => l.id === labelOf[group.id]) ?? null}
            menu={() => groupMenuItems(group)}
            onOpen={() => openContactConversation(group.id)}
          />
        ))}
      </div>
    );

  return (
    <div className="ct-page">
      <ContactsPageHeader icon={Users} title="Danh sách nhóm và cộng đồng" />
      <div className="ct-page-scroll">
        <div className="ct-list-title">Nhóm và cộng đồng ({visible.length})</div>
        <div className="ct-panel cp-panel">
          <div className="ct-filter">
            <ContactsSearchField value={query} onChange={setQuery} placeholder="Tìm kiếm..." />
            <div className="ct-filter-selects is-single">
              <FilterSelect icon={ArrowDownUp} text={sortText(sort)} items={() => sortItems(sort, setSort)} />
            </div>
          </div>
          {body}
        </div>
      </div>
    </div>
  );
}
