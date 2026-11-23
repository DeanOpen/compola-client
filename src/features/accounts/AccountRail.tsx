// The account column at the top of the blue rail (docs/design-refs/multi-account: Discord's server rail): one avatar per
// Zalo account with its unread badge, the active one larger with a white pill on the rail's edge; hover = name and
// number; a click switches (the active one opens the account menu); right-click = that account's menu; "+" adds one.

import { AlertCircle, ArrowLeftRight, LogOut, Plus, Settings, Trash2 } from 'lucide-react';
import { type MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { beginAddAccount, canAddAccount, maxAccounts, removeAccount, signOutAccount, switchAccount, useAccounts, type AccountInfo } from '../../engine/accounts';
import { Avatar } from '../../ui/Avatar';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { openSettings } from '../settings/hosts';
import './accounts.css';

const titleOf = (a: AccountInfo) => a.name || (a.state === 'signingIn' ? 'Đang đăng nhập…' : 'Tài khoản Zalo');

/** Menu of an account that is not on screen (right-click). */
const accountMenu = (a: AccountInfo, active: boolean): MenuItem[] => [
  { kind: 'label', label: a.phone ? `${titleOf(a)} · ${a.phone}` : titleOf(a) },
  ...(active ? [] : [{ label: 'Chuyển sang tài khoản này', icon: ArrowLeftRight, disabled: a.state !== 'signedIn', onSelect: () => switchAccount(a.id) }]),
  { label: 'Quản lý tài khoản…', icon: Settings, onSelect: () => openSettings('account') },
  { kind: 'separator' },
  { label: 'Đăng xuất', icon: LogOut, destructive: true, disabled: a.state !== 'signedIn', onSelect: () => signOutAccount(a.id) },
  ...(active ? [] : [{ label: 'Xóa khỏi Compola', icon: Trash2, destructive: true, onSelect: () => removeAccount(a.id) }]),
];

/**
 * The column; `activeMenu` opens the menu of the account on screen (the rail's existing account menu: profile, sync,
 * settings, sign out). `activeUnread` is the live count of the account on screen (the host's number is for the others).
 */
export function AccountRail({ activeMenu, activeUnread }: { activeMenu: (e: MouseEvent<HTMLButtonElement>) => void; activeUnread: number }) {
  const accounts = useAccounts(useShallow((s) => s.accounts));
  const activeId = useAccounts((s) => s.activeId);
  return (
    <div className="account-rail" role="tablist" aria-label="Tài khoản Zalo">
      {accounts.map((a, i) => {
        const active = a.id === activeId;
        const unread = active ? activeUnread : a.unread;
        const title = `${titleOf(a)}${a.phone ? ` · ${a.phone}` : ''}${i < 5 ? ` (⌃${i + 1})` : ''}${unread ? ` · ${unread} chưa đọc` : ''}`;
        return (
          <button
            key={a.id}
            role="tab"
            aria-selected={active}
            className={`account-item ${active ? 'is-active' : ''} ${a.state !== 'signedIn' ? 'is-out' : ''}`}
            title={title}
            aria-label={title}
            onClick={(e) => (active ? activeMenu(e) : a.state === 'signedIn' ? switchAccount(a.id) : openMenuBelow(e.currentTarget, accountMenu(a, false)))}
            onContextMenu={(e) => openContextMenu(e, accountMenu(a, active))}
          >
            <span className="account-pill" aria-hidden />
            <Avatar url={a.avatar} name={titleOf(a)} size={active ? 44 : 36} />
            {a.state !== 'signedIn' ? (
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
        <button className="account-add" title="Thêm tài khoản Zalo (⌘⇧N)" aria-label="Thêm tài khoản Zalo" onClick={() => void beginAddAccount()}>
          <Plus size={18} />
        </button>
      ) : (
        <span className="account-full" title={`Tối đa ${maxAccounts} tài khoản`} />
      )}
    </div>
  );
}
