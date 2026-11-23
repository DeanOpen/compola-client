// The Zalo PC left rail (docs/zalo-pc-style.md §1): 64px, navbar blue, the account avatar on top (its menu: profile,
// sync, settings, log out), then icon tabs — Tin nhắn, Danh bạ — and at the bottom Cloud của tôi, zCloud, Cài đặt.
// Replaces the Swift app's labelled sidebar (Tin nhắn / Chưa đọc / Người lạ / Lưu trữ / Danh bạ): the mailboxes now
// live in the list column's tabs and the stranger row.

import { Cloud, HardDrive, LogOut, MessageCircle, RefreshCw, Settings, SquareUser, UserRound, type LucideIcon } from 'lucide-react';
import { useMemo, useState, type MouseEvent } from 'react';
import { useContacts } from '../engine/contacts';
import { logOut } from '../engine/lifecycle';
import { deviceTitle, useRemote, userTitle } from '../engine/remote';
import { LeaveServerAlert } from '../features/remote/RemoteGate';
import { openMyProfile } from '../features/contacts/hosts';
import { openSettings } from '../features/settings/hosts';
import { openTransfer } from '../features/transfer/hosts';
import { useEngine } from '../engine/store';
import { unreadCounts } from '../features/conversations/support';
import { Avatar } from '../ui/Avatar';
import { openMenuBelow, type MenuItem } from '../ui/Menu';
import { isContacts, isConversationList, shell, useShell } from './shellStore';
import './shell.css';

export function Rail() {
  const destination = useShell((s) => s.destination);
  const selection = useShell((s) => s.selection);
  const profile = useEngine((s) => s.profile);
  const selfId = useEngine((s) => s.selfConversationId);
  const canStartTransfer = useEngine((s) => s.canStartTransfer);
  const conversations = useEngine((s) => s.conversations);
  const extras = useEngine((s) => s.extras);
  const actions = useEngine((s) => s.conversationActions);
  const counts = useMemo(() => unreadCounts(useEngine.getState()), [conversations, extras, actions]);
  const name = profile?.displayName || 'Tài khoản của tôi';
  const contacts = useContacts();
  // Joined to a Compola Server: no phone sync (the account lives on the host), and "log out" leaves the server.
  const joined = useRemote((s) => s.mode === 'joined');
  const serverName = useRemote((s) => s.connection?.serverName);
  const remoteUser = useRemote((s) => s.connection?.user ?? null);
  const device = useRemote((s) => (s.connection ? deviceTitle(s.connection.deviceName, s.connection.deviceId) : ''));
  const [confirmLeave, setConfirmLeave] = useState(false);

  const onSelfChat = !!selfId && selection === selfId && isConversationList(destination);
  const messagesActive = isConversationList(destination) && !onSelfChat;

  const accountMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const items: MenuItem[] = [
      // Who is signed in (wave 4, after Snowflake's account menu): name, then the number.
      { kind: 'label', label: profile?.phone ? `${name} · ${profile.phone}` : name },
      // Joined: who is signed in to the server (a person's account) and, separately, this device.
      ...(joined
        ? ([
            { kind: 'label', label: `Đăng nhập với tư cách ${userTitle(remoteUser)}` },
            { kind: 'label', label: `Thiết bị: ${device}` },
          ] as MenuItem[])
        : []),
      { label: 'Hồ sơ của bạn', icon: UserRound, onSelect: openMyProfile },
      ...(joined ? [] : [{ label: 'Đồng bộ tin nhắn từ điện thoại…', icon: RefreshCw, disabled: !canStartTransfer, onSelect: openTransfer }]),
      { label: 'Cài đặt', icon: Settings, shortcut: '⌘,', onSelect: openSettings },
      { kind: 'separator' },
      joined
        ? { label: 'Rời Compola Server', icon: LogOut, destructive: true, onSelect: () => setConfirmLeave(true) }
        : { label: 'Đăng xuất', icon: LogOut, destructive: true, onSelect: () => void logOut() },
    ];
    openMenuBelow(e.currentTarget, items);
  };

  return (
    <nav className="rail" aria-label="Điều hướng">
      <div className="rail-titlebar" data-tauri-drag-region />
      <button className="rail-avatar" onClick={accountMenu} title={name} aria-label={`Tài khoản ${name}`}>
        <Avatar url={profile?.avatar} name={name} size={48} />
      </button>
      <div className="rail-group">
        <RailItem
          icon={MessageCircle}
          label={counts.inbox + counts.strangers > 0 ? `Tin nhắn · ${counts.inbox + counts.strangers} chưa đọc` : 'Tin nhắn'}
          badge={counts.inbox + counts.strangers}
          selected={messagesActive}
          onClick={() => {
            if (onSelfChat) shell.select(null);
            if (!isConversationList(destination) || destination === 'myCloud') shell.setDestination('inbox');
          }}
        />
        <RailItem
          icon={SquareUser}
          label={contactsLabel(contacts.pendingRequestCount, contacts.groupInviteUnread)}
          badge={contacts.pendingRequestCount + contacts.groupInviteUnread} selected={isContacts(destination)} onClick={() => shell.setDestination('friends')} />
      </div>
      <div className="rail-spacer" data-tauri-drag-region />
      <div className="rail-group">
        {selfId && (
          <RailItem
            icon={Cloud}
            label="Cloud của tôi"
            selected={onSelfChat}
            onClick={() => {
              shell.setSearch('');
              shell.setDestination('inbox');
              shell.select(selfId);
            }}
          />
        )}
        <RailItem icon={HardDrive} label="zCloud" selected={destination === 'zcloud'} onClick={() => shell.setDestination('zcloud')} />
        <RailItem icon={Settings} label="Cài đặt (⌘,)" selected={false} onClick={() => openSettings()} />
      </div>
      {confirmLeave && <LeaveServerAlert serverName={serverName} onClose={() => setConfirmLeave(false)} />}
    </nav>
  );
}

function RailItem({
  icon: Icon,
  label,
  badge,
  selected,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  badge?: number;
  selected: boolean;
  onClick: (el: HTMLButtonElement) => void;
}) {
  return (
    <button className={`rail-item ${selected ? 'is-selected' : ''}`} title={label} aria-label={label} aria-current={selected} onClick={(e) => onClick(e.currentTarget)}>
      <Icon size={24} strokeWidth={selected ? 2.2 : 1.8} />
      {!!badge && badge > 0 && <span className="rail-badge nums">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}

/** "Danh bạ · 2 lời mời kết bạn, 1 lời mời vào nhóm" for the tooltip. */
const contactsLabel = (requests: number, invites: number) => {
  const parts = [requests > 0 && `${requests} lời mời kết bạn`, invites > 0 && `${invites} lời mời vào nhóm`].filter(Boolean);
  return parts.length ? `Danh bạ · ${parts.join(', ')}` : 'Danh bạ';
};
