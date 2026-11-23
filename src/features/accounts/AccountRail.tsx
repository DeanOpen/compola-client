// The account column at the top of the blue rail (docs/design-refs/multi-account: Discord's server rail): one avatar per
// Zalo account with its unread badge, the active one larger with a white pill on the rail's edge; hover = name, ⌃n and
// unread; a click switches (the active one opens the account menu); right-click = that account's menu; "+" adds one.

import { AlertCircle, ArrowLeftRight, LogOut, Plus, Settings, Trash2 } from 'lucide-react';
import { type MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  accountTitle,
  beginAddAccount,
  canAddAccount,
  defaultAccountId,
  removeAccount,
  signOutAccount,
  switchAccount,
  useAccounts,
  type AccountInfo,
} from '../../engine/accounts';
import { Avatar } from '../../ui/Avatar';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { openSettings } from '../settings/hosts';
import './accounts.css';

const phaseNote = (a: AccountInfo) =>
  a.phase === 'disabled' ? 'Đã tắt' : a.phase === 'login' ? 'Chưa đăng nhập' : a.phase === 'starting' || a.phase === 'preparing' || a.phase === 'signingIn' ? 'Đang khởi động' : '';

/** An account's menu (right-click on its avatar). */
const accountMenu = (a: AccountInfo, active: boolean): MenuItem[] => [
  { kind: 'label', label: [accountTitle(a), phaseNote(a)].filter(Boolean).join(' · ') },
  ...(active ? [] : [{ label: 'Chuyển sang tài khoản này', icon: ArrowLeftRight, disabled: a.phase === 'disabled', onSelect: () => switchAccount(a.id) }]),
  { label: 'Quản lý tài khoản…', icon: Settings, onSelect: () => openSettings('account') },
  { kind: 'separator' },
  { label: 'Đăng xuất', icon: LogOut, destructive: true, disabled: a.phase !== 'ready', onSelect: () => signOutAccount(a.id) },
  ...(active || a.id === defaultAccountId ? [] : [{ label: 'Xóa khỏi Compola', icon: Trash2, destructive: true, onSelect: () => removeAccount(a.id) }]),
];

/** `activeMenu` opens the account-on-screen's menu (profile, sync, settings, sign out); `activeUnread` is its live count. */
export function AccountRail({ activeMenu, activeUnread }: { activeMenu: (e: MouseEvent<HTMLButtonElement>) => void; activeUnread: number }) {
  const accounts = useAccounts(useShallow((s) => s.accounts));
  const activeId = useAccounts((s) => s.activeId);
  const max = useAccounts((s) => s.maxAccounts);
  return (
    <div className="account-rail" role="tablist" aria-label="Tài khoản Zalo">
      {accounts.map((a, i) => {
        const active = a.id === activeId;
        const unread = active ? activeUnread : a.badge;
        const note = phaseNote(a);
        const title = [accountTitle(a), note, i < 5 ? `⌃${i + 1}` : '', unread ? `${unread} chưa đọc` : ''].filter(Boolean).join(' · ');
        return (
          <button
            key={a.id}
            role="tab"
            aria-selected={active}
            className={`account-item ${active ? 'is-active' : ''} ${a.phase !== 'ready' ? 'is-out' : ''}`}
            title={title}
            aria-label={title}
            onClick={(e) => (active ? activeMenu(e) : a.phase !== 'disabled' ? switchAccount(a.id) : openMenuBelow(e.currentTarget, accountMenu(a, false)))}
            onContextMenu={(e) => openContextMenu(e, accountMenu(a, active))}
          >
            <span className="account-pill" aria-hidden />
            <Avatar url={a.avatar} name={accountTitle(a)} size={active ? 44 : 36} />
            {a.phase === 'login' || a.phase === 'disabled' ? (
              <span className="account-state" aria-hidden>
                <AlertCircle size={12} />
              </span>
            ) : unread > 0 ? (
              <span className="rail-badge nums">{unread > 99 ? '99+' : unread}</span>
            ) : null}
          </button>
        );
      })}
      {canAddAccount() ? (
        <button className="account-add" title="Thêm tài khoản Zalo (⇧⌘N)" aria-label="Thêm tài khoản Zalo" onClick={() => void beginAddAccount()}>
          <Plus size={18} />
        </button>
      ) : accounts.length >= max ? (
        <span className="account-full" title={`Tối đa ${max} tài khoản`} />
      ) : null}
    </div>
  );
}
