// Source list (Swift `SidebarView` + `SidebarAccountFooter`): mailboxes, storage and Danh bạ, as a floating Liquid
// Glass panel. The "Phân loại" labels are not listed here: they filter "Tin nhắn" from the list column.

import {
  Archive,
  ChevronsUpDown,
  Cloud,
  EyeOff,
  HardDrive,
  Inbox,
  Lock,
  LogOut,
  MessagesSquare,
  RefreshCw,
  Settings,
  User,
  UserPlus,
  UserRoundSearch,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useContacts, visibleFriends } from '../engine/contacts';
import { logOut } from '../engine/lifecycle';
import { openSettings } from '../features/settings/hosts';
import { openTransfer } from '../features/transfer/hosts';
import { inboxTitle, typeFilterTitle, TypeFilter } from '../engine/models/conversations';
import { useEngine } from '../engine/store';
import { unreadCounts } from '../features/conversations/support';
import { Avatar } from '../ui/Avatar';
import { openMenuBelow } from '../ui/Menu';
import { isLabel, shell, sidebarRow, useShell, type Destination } from './shellStore';
import './shell.css';

export function Sidebar() {
  const { destination, selection, search, unlocked } = useShell(
    useShallow((s) => ({ destination: s.destination, selection: s.selection, search: s.search, unlocked: s.unlockedHiddenIds })),
  );
  const { selfId, archivedEnabled, hiddenEnabled } = useEngine(
    useShallow((s) => ({
      selfId: s.selfConversationId,
      archivedEnabled: s.extras.archivedEnabled,
      hiddenEnabled: s.conversationActions.hiddenEnabled,
    })),
  );
  const conversations = useEngine((s) => s.conversations);
  const extras = useEngine((s) => s.extras);
  const actions = useEngine((s) => s.conversationActions);
  const counts = useMemo(() => unreadCounts(useEngine.getState()), [conversations, extras, actions]);
  const contacts = useContacts();
  const friendCount = useMemo(() => visibleFriends(contacts, useEngine.getState()).length, [contacts, actions]);

  /** "Cloud của tôi" is the inbox with the self conversation open: that is what the sidebar highlights then. */
  const highlighted: Destination =
    destination === 'myCloud' || (destination === 'inbox' && selfId && selection === selfId) ? 'myCloud' : sidebarRow(destination);

  const select = (d: Destination) => {
    // Like Mail, picking a mailbox ends the search of the previous one.
    if (search) shell.setSearch('');
    if (d === 'myCloud') {
      if (!selfId) return;
      shell.setDestination('inbox');
      shell.select(selfId);
      return;
    }
    if (d === 'inbox') {
      // Leaving "Cloud của tôi" for the inbox closes that chat so the highlight really moves; a click on the highlighted
      // row under a label filter clears the filter.
      if (highlighted === 'myCloud') shell.select(null);
      shell.setDestination('inbox');
      return;
    }
    shell.setDestination(d);
  };

  const row = (d: Destination, label: string, icon: LucideIcon, badge?: number, trailing?: ReactNode) => (
    <SidebarRow
      key={d}
      label={label}
      icon={icon}
      badge={badge}
      selected={highlighted === d}
      onClick={() => select(d)}
      trailing={trailing}
      hint={d === 'inbox' && isLabel(destination) ? 'Bỏ lọc thẻ phân loại' : undefined}
    />
  );

  return (
    <nav className="sidebar glass" aria-label="Thanh bên">
      <div className="sidebar-titlebar" data-tauri-drag-region />
      <div className="sidebar-scroll">
        <div className="sidebar-section">
          {row('inbox', inboxTitle, Inbox, counts.inbox)}
          {archivedEnabled && row('other', typeFilterTitle(TypeFilter.other), Archive, counts.other)}
          {row('unread', typeFilterTitle(TypeFilter.unread), MessagesSquare)}
          {row('strangers', 'Người lạ', UserRoundSearch, counts.strangers)}
          {hiddenEnabled &&
            row('hidden', 'Trò chuyện ẩn', EyeOff, undefined, unlocked === null ? <Lock size={10} className="tertiary" aria-label="Đang khoá" /> : undefined)}
        </div>
        <div className="sidebar-section">
          <div className="sidebar-heading">Lưu trữ</div>
          {selfId && row('myCloud', 'Cloud của tôi', Cloud)}
          {row('zcloud', 'zCloud', HardDrive)}
        </div>
        <div className="sidebar-section">
          <div className="sidebar-heading">Danh bạ</div>
          {row('friends', 'Bạn bè', User, friendCount)}
          {row('groups', 'Nhóm và cộng đồng', Users)}
          {row('requests', 'Lời mời kết bạn', UserPlus, contacts.pendingRequestCount)}
        </div>
      </div>
      <AccountFooter />
    </nav>
  );
}

function SidebarRow({
  label,
  icon: Icon,
  badge,
  selected,
  onClick,
  trailing,
  hint,
}: {
  label: string;
  icon: LucideIcon;
  badge?: number;
  selected: boolean;
  onClick: () => void;
  trailing?: ReactNode;
  hint?: string;
}) {
  return (
    <button className={`sidebar-row ${selected ? 'is-selected' : ''}`} onClick={onClick} aria-current={selected} title={hint}>
      <Icon size={16} className="sidebar-row-icon" />
      <span className="sidebar-row-label truncate">{label}</span>
      {trailing}
      {!!badge && badge > 0 && <span className="sidebar-row-badge nums">{badge}</span>}
    </button>
  );
}

/** Account row pinned to the bottom of the sidebar: avatar, name and the phone-sync state; opens the account menu. */
function AccountFooter() {
  const profile = useEngine((s) => s.profile);
  const name = profile?.displayName || 'Tài khoản của tôi';
  const canStartTransfer = useEngine((s) => s.canStartTransfer);
  return (
    <button
      className="account-footer"
      title="Tài khoản và đồng bộ"
      aria-label={`Tài khoản ${name}, Đã kết nối`}
      onClick={(e) =>
        openMenuBelow(e.currentTarget, [
          { kind: 'label', label: name },
          { label: 'Đồng bộ tin nhắn từ điện thoại…', icon: RefreshCw, disabled: !canStartTransfer, onSelect: openTransfer },
          { label: 'Cài đặt…', icon: Settings, shortcut: '⌘,', onSelect: openSettings },
          { kind: 'separator' },
          { label: 'Đăng xuất', icon: LogOut, destructive: true, onSelect: () => void logOut() },
        ])
      }
    >
      <Avatar url={profile?.avatar} name={name} size={30} />
      <span className="account-text">
        <span className="account-name truncate">{name}</span>
        <span className="account-status">
          <span className="account-dot" /> Đã kết nối
        </span>
      </span>
      <ChevronsUpDown size={12} className="secondary" />
    </button>
  );
}
