// Settings ▸ Tài khoản ▸ "Tài khoản Zalo trên Compola" (ElevenLabs' workspaces list): every account with its number and
// unread count, "Đang dùng" / "Chuyển", ↑ ↓ to reorder (the rail and ⌃1–5 follow), Đăng xuất, Xóa khỏi Compola, and a
// quiet "Thêm tài khoản" row at the end.

import { ArrowDown, ArrowUp, LogOut, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  beginAddAccount,
  canAddAccount,
  maxAccounts,
  removeAccount,
  reorderAccounts,
  signOutAccount,
  switchAccount,
  useAccounts,
  type AccountInfo,
} from '../../engine/accounts';
import { Avatar } from '../../ui/Avatar';
import { Alert } from '../../ui/Overlays';
import './accounts.css';

export function AccountsSettings() {
  const accounts = useAccounts(useShallow((s) => s.accounts));
  const activeId = useAccounts((s) => s.activeId);
  const [removing, setRemoving] = useState<AccountInfo | null>(null);
  if (!accounts.length) return null;
  const move = (i: number, d: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    reorderAccounts(ids);
  };
  return (
    <div className="st-section">
      <div className="st-section-title">Tài khoản Zalo trên Compola</div>
      <div className="st-group">
        {accounts.map((a, i) => {
          const active = a.id === activeId;
          return (
            <div key={a.id} className="accounts-row">
              <Avatar url={a.avatar} name={a.name || '?'} size={36} />
              <div className="accounts-text">
                <div className="accounts-name truncate">
                  {a.name || 'Tài khoản Zalo'}
                  {i < 5 && <span className="accounts-key">⌃{i + 1}</span>}
                </div>
                <div className="accounts-sub truncate">
                  {a.state === 'signedOut' ? 'Đã đăng xuất' : a.state === 'signingIn' ? 'Đang đăng nhập…' : [a.phone, !active && a.unread ? `${a.unread} chưa đọc` : ''].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button className="icon-button accounts-icon" disabled={i === 0} title="Lên" aria-label="Lên" onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </button>
              <button className="icon-button accounts-icon" disabled={i === accounts.length - 1} title="Xuống" aria-label="Xuống" onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </button>
              {active ? (
                <span className="accounts-current">Đang dùng</span>
              ) : (
                <button className="st-button" disabled={a.state !== 'signedIn'} onClick={() => switchAccount(a.id)}>
                  Chuyển
                </button>
              )}
              <button className="icon-button accounts-icon" disabled={a.state !== 'signedIn'} title="Đăng xuất" aria-label="Đăng xuất" onClick={() => signOutAccount(a.id)}>
                <LogOut size={14} />
              </button>
              <button className="icon-button accounts-icon is-danger" disabled={active} title={active ? 'Chuyển sang tài khoản khác để xóa' : 'Xóa khỏi Compola'} aria-label="Xóa khỏi Compola" onClick={() => setRemoving(a)}>
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
        <button className="accounts-add" disabled={!canAddAccount()} onClick={() => void beginAddAccount()}>
          <Plus size={15} /> {canAddAccount() ? 'Thêm tài khoản Zalo' : `Đã đủ ${maxAccounts} tài khoản`}
          <span className="accounts-key">⌘⇧N</span>
        </button>
      </div>
      {removing && (
        <Alert
          title={`Xóa ${removing.name || 'tài khoản này'} khỏi Compola?`}
          message="Tài khoản sẽ được đăng xuất và dữ liệu của nó trên máy này sẽ bị xóa. Bạn có thể thêm lại sau bằng mã QR."
          buttons={[
            { label: 'Hủy', role: 'cancel', onClick: () => setRemoving(null) },
            {
              label: 'Xóa',
              role: 'destructive',
              onClick: () => {
                removeAccount(removing.id);
                setRemoving(null);
              },
            },
          ]}
        />
      )}
    </div>
  );
}
