// Danh bạ columns (Swift Shell/ContactsColumns.swift, in Zalo PC's layout): the list column is the Danh bạ sub-nav (with the
// search, "Thêm bạn" and "Tạo nhóm" buttons on top); the main area shows the picked page (friends, groups, requests, group
// invitations). "Thêm bạn" is a dialog: the `addFriend` destination opens it over the friends page.

import { Search, UserPlus, UserRound, Users, UsersRound, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { refreshContacts, useContacts } from '../../engine/contacts';
import { shell, type Destination } from '../../shell/shellStore';
import { GroupInvitesPage, RequestsPage } from './ContactsRequestsView';
import { FriendsPage, GroupsPage, useVisibleFriends, useVisibleGroups } from './ContactsView';
import { contactsUi } from './contactsUi';
import './contacts.css';
import './contactsPages.css';

/** Content column for Danh bạ destinations: the sub-nav. */
export function ContactsContentColumn({ destination }: { destination: Destination }) {
  const pending = useContacts((s) => s.pendingRequestCount);
  const inviteUnread = useContacts((s) => s.groupInviteUnread);
  const friendCount = useVisibleFriends().length;
  const groupCount = useVisibleGroups().length;

  useEffect(() => {
    refreshContacts();
  }, []);

  // "Thêm bạn" is a dialog over the friends page.
  useEffect(() => {
    if (destination !== 'addFriend') return;
    shell.setDestination('friends');
    contactsUi.openAddFriend();
  }, [destination]);

  const item = (d: Destination, label: string, icon: LucideIcon, badge?: number, count?: number) => {
    const Icon = icon;
    const selected = destination === d || (d === 'friends' && destination === 'addFriend');
    return (
      <button key={d} className={`ct-nav-item ${selected ? 'is-selected' : ''}`} aria-current={selected} onClick={() => shell.setDestination(d)}>
        <span className="cp-nav-icon">
          <Icon size={18} strokeWidth={1.9} />
        </span>
        <span className="ct-nav-label truncate">{label}</span>
        {!!badge && badge > 0 ? (
          <span className="ct-nav-badge nums">{badge > 99 ? '99+' : badge}</span>
        ) : count ? (
          <span className="cp-nav-count nums">{count}</span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="column ct-column">
      <div className="ct-column-top" data-tauri-drag-region>
        <button className="ct-fake-search" onClick={() => shell.toggleQuickSwitcher()} title="Tìm kiếm (⌘K)">
          <Search size={15} />
          <span>Tìm kiếm</span>
        </button>
        <button className="ct-icon-button" onClick={contactsUi.openAddFriend} title="Thêm bạn" aria-label="Thêm bạn">
          <UserPlus size={18} />
        </button>
        <button className="ct-icon-button" onClick={() => contactsUi.composeGroup()} title="Tạo nhóm (⇧⌘N)" aria-label="Tạo nhóm">
          <UsersRound size={18} />
        </button>
      </div>
      <nav className="ct-nav" aria-label="Danh bạ">
        {item('friends', 'Danh sách bạn bè', UserRound, undefined, friendCount)}
        {item('groups', 'Danh sách nhóm và cộng đồng', Users, undefined, groupCount)}
        {item('requests', 'Lời mời kết bạn', UserPlus, pending)}
        {item('groupInvites', 'Lời mời vào nhóm và cộng đồng', UsersRound, inviteUnread)}
      </nav>
    </div>
  );
}

/** Main area for Danh bạ destinations: the picked page. */
export function ContactsDetailColumn({ destination }: { destination: Destination }) {
  return (
    <div className="column ct-main">
      {destination === 'groups' ? (
        <GroupsPage />
      ) : destination === 'requests' ? (
        <RequestsPage />
      ) : destination === 'groupInvites' ? (
        <GroupInvitesPage />
      ) : (
        <FriendsPage />
      )}
    </div>
  );
}
