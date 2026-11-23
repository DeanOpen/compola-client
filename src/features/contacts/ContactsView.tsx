// "Danh bạ": friends and groups (Swift ContactsView.swift) in Zalo PC's layout: a page with a title bar, the count, a panel with
// search / sort / filter, then the list. A click opens the conversation; ⋯ (or a right click) opens the row menu; "Xem thông tin"
// shows the profile dialog (Swift `FriendCard`).

import { ArrowDownUp, ChevronDown, Filter, Info, MessageCircle, MoreHorizontal, Phone, Tag, UserRound, Users, Video } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { callAvailability, startCall, useCalls } from '../../engine/calls';
import {
  ago,
  compareSections,
  contactFold,
  contactProfile,
  openContactConversation,
  standardCompare,
  useContacts,
  visibleFriends,
  visibleGroups,
  type ContactGroup,
  type ContactProfile,
  type Friend,
} from '../../engine/contacts';
import { setConversationLabel } from '../../engine/conversations';
import { cssColor, type ConversationLabel } from '../../engine/models/conversations';
import { getEngine, useEngine } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { Sheet } from '../../ui/Overlays';
import { ContactCallActions, ContactsEmpty, ContactsLoading, ContactsPageHeader, ContactsSearchField, DialogHeader } from './ContactsShared';
import { contactsUi, useContactsUi, type FriendSort } from './contactsUi';

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
  label,
  menu,
  onOpen,
}: {
  name: string;
  avatar: string | null;
  online?: boolean;
  subtitle?: ReactNode;
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
        {subtitle && <span className="ct-row-sub truncate">{subtitle}</span>}
      </span>
      {label && (
        <span className="ct-row-label" title={`Phân loại: ${label.name}`}>
          <Tag size={12} style={color ? { color } : undefined} fill={color ?? 'none'} />
        </span>
      )}
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
  const activeLabel = labels.find((l) => l.id === labelFilter) ?? null;

  // A label deleted meanwhile stops filtering.
  useEffect(() => {
    if (labelFilter && !activeLabel) contactsUi.setFriendLabel(null);
  }, [labelFilter, activeLabel]);

  const sections = useMemo(() => {
    const q = contactFold(query).trim();
    let matches = q ? friends.filter((f) => f.sortKey.includes(q) || contactFold(f.zaloName).includes(q)) : friends;
    if (activeLabel) matches = matches.filter((f) => labelOf[f.id] === activeLabel.id);
    const grouped = new Map<string, Friend[]>();
    for (const f of matches) grouped.set(f.section, [...(grouped.get(f.section) ?? []), f]);
    const dir = sort === 'az' ? 1 : -1;
    return [...grouped.keys()]
      .sort((a, b) => (a === '#' || b === '#' ? compareSections(a, b) : dir * compareSections(a, b)))
      .map((letter) => ({ letter, friends: grouped.get(letter)!.sort((a, b) => dir * standardCompare(a.sortKey, b.sortKey)) }));
  }, [friends, query, sort, activeLabel, labelOf]);

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
  else if (sections.length === 0) body = <ContactsEmpty icon={UserRound} title="Không tìm thấy kết quả" description="Vui lòng thử lại từ khóa hoặc bộ lọc khác." />;
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
        <div className="ct-panel">
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
            subtitle={`${group.members} thành viên`}
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
        <div className="ct-panel">
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

// MARK: - Profile dialog

/** Cover band + avatar + name block shared by the profile dialogs ("Thông tin tài khoản"). */
export function ProfileCover({
  avatar,
  name,
  secondaryName,
  status,
  online = false,
}: {
  avatar: string | null;
  name: string;
  secondaryName?: string | null;
  status?: string | null;
  online?: boolean;
}) {
  return (
    <div className="ct-profile-cover">
      <div className="ct-profile-band" aria-hidden />
      <span className="ct-profile-avatar">
        <Avatar url={avatar} name={name} size={80} />
        {online && <span className="ct-presence is-large" aria-hidden />}
      </span>
      <div className="ct-profile-name selectable">{name}</div>
      {secondaryName && secondaryName !== name && <div className="ct-profile-secondary">{secondaryName}</div>}
      {status && <div className={`ct-profile-status ${online ? 'is-online' : ''}`}>{status}</div>}
    </div>
  );
}

/** "Thông tin tài khoản" of a friend (Swift `FriendCard`): local profile data, message / call buttons. */
export function FriendProfileDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const friend = useContacts((s) => s.friends.find((f) => f.id === id) ?? null);
  const [profile, setProfile] = useState<ContactProfile | null>(null);
  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    void contactProfile(id).then((loaded) => {
      // Another profile meanwhile: never show someone else's data.
      if (!cancelled && loaded?.uid === id) setProfile(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!friend) return null;
  const status = friend.online ? 'Đang hoạt động' : friend.lastActive ? `Truy cập ${ago(friend.lastActive)}` : null;
  return (
    <Sheet onClose={onClose} width={400}>
      <DialogHeader title="Thông tin tài khoản" onClose={onClose} />
      <div className="ct-dialog-body">
        <ProfileCover avatar={friend.avatar} name={friend.name} secondaryName={friend.zaloName || profile?.zaloName} status={status} online={friend.online} />
        <div className="ct-profile-buttons">
          <button
            className="ct-btn ct-btn-tonal ct-btn-grow"
            onClick={() => {
              onClose();
              openContactConversation(friend.id);
            }}
          >
            <MessageCircle size={15} /> Nhắn tin
          </button>
        </div>
        <div className="ct-profile-actions">
          <ContactCallActions id={friend.id} name={friend.name} onStart={onClose} />
        </div>
        {(profile?.bio || profile?.isOfficialAccount) && (
          <div className="ct-profile-info">
            <div className="ct-profile-info-title">Thông tin cá nhân</div>
            {profile?.bio && (
              <div className="ct-profile-line">
                <span className="ct-profile-line-key">Giới thiệu</span>
                <span className="selectable">{profile.bio}</span>
              </div>
            )}
            {profile?.isOfficialAccount && (
              <div className="ct-profile-line">
                <span className="ct-profile-line-key">Loại tài khoản</span>
                <span>Tài khoản chính thức</span>
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
