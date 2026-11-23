// Settings ▸ Tài khoản ▸ "Tài khoản Zalo trên Compola" (ElevenLabs' workspaces list): every account with its state and
// unread count, "Đang dùng" / "Chuyển", a local name (account_rename), on / off (account_set_enabled: an account that is
// off keeps its data but neither receives nor notifies), ↑ ↓ to reorder (the rail and ⌃1–5 follow), Đăng xuất, Xóa
// khỏi Compola (the main account is only signed out), and a quiet "Thêm tài khoản Zalo" row at the end.

import { ArrowDown, ArrowUp, LogOut, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  accountTitle,
  accountsManagedHere,
  beginAddAccount,
  canAddAccount,
  defaultAccountId,
  removeAccount,
  renameAccount,
  reorderAccounts,
  setAccountEnabled,
  signOutAccount,
  switchAccount,
  useAccounts,
  type AccountInfo,
} from '../../engine/accounts';
import { Avatar } from '../../ui/Avatar';
import { Alert, Sheet, SheetHeader } from '../../ui/Overlays';
import './accounts.css';

const stateText = (a: AccountInfo) =>
  a.phase === 'disabled'
    ? 'Đã tắt'
    : a.phase === 'login'
      ? 'Chưa đăng nhập'
      : a.phase === 'ready'
        ? a.badge
          ? `${a.badge} chưa đọc`
          : 'Đang hoạt động'
        : 'Đang khởi động…';

export function AccountsSettings() {
  const accounts = useAccounts(useShallow((s) => s.accounts));
  const activeId = useAccounts((s) => s.activeId);
  const max = useAccounts((s) => s.maxAccounts);
  const [removing, setRemoving] = useState<AccountInfo | null>(null);
  const [renaming, setRenaming] = useState<AccountInfo | null>(null);
  // On a Compola Server the list is read-only here (switching stays).
  const manage = accountsManagedHere();
  if (!accounts.length) return null;
  const move = (i: number, d: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    reorderAccounts(ids);
  };
  return (
    <div className="st-section">
      <div className="st-section-title">{manage ? 'Tài khoản Zalo trên Compola' : 'Tài khoản Zalo trên Compola Server'}</div>
      <div className="st-group">
        {accounts.map((a, i) => {
          const active = a.id === activeId;
          return (
            <div key={a.id} className={`accounts-row ${a.phase === 'disabled' ? 'is-off' : ''}`}>
              <Avatar url={a.avatar} name={accountTitle(a)} size={36} />
              <div className="accounts-text">
                <div className="accounts-name truncate">
                  {accountTitle(a)}
                  {i < 5 && <span className="accounts-key">⌃{i + 1}</span>}
                </div>
                <div className="accounts-sub truncate">{stateText(a)}</div>
              </div>
              {manage && (
                <>
                  <button className="icon-button accounts-icon" title="Đặt tên gợi nhớ" aria-label="Đặt tên gợi nhớ" onClick={() => setRenaming(a)}>
                    <Pencil size={13} />
                  </button>
                  <button className="icon-button accounts-icon" disabled={i === 0} title="Lên" aria-label="Lên" onClick={() => move(i, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button className="icon-button accounts-icon" disabled={i === accounts.length - 1} title="Xuống" aria-label="Xuống" onClick={() => move(i, 1)}>
                    <ArrowDown size={14} />
                  </button>
                  <input
                    type="checkbox"
                    className="app-switch"
                    checked={a.enabled}
                    disabled={active}
                    title={active ? 'Không thể tắt tài khoản đang dùng' : a.enabled ? 'Tắt: giữ dữ liệu nhưng không nhận tin nhắn, không thông báo' : 'Bật tài khoản'}
                    aria-label={`Bật ${accountTitle(a)}`}
                    onChange={(e) => setAccountEnabled(a.id, e.target.checked)}
                  />
                </>
              )}
              {active ? (
                <span className="accounts-current">Đang dùng</span>
              ) : (
                <button className="st-button" disabled={a.phase === 'disabled'} onClick={() => switchAccount(a.id)}>
                  Chuyển
                </button>
              )}
              {manage && (
                <>
                  <button className="icon-button accounts-icon" disabled={a.phase !== 'ready'} title="Đăng xuất" aria-label="Đăng xuất" onClick={() => signOutAccount(a.id)}>
                    <LogOut size={14} />
                  </button>
                  <button
                    className="icon-button accounts-icon is-danger"
                    disabled={active || a.id === defaultAccountId}
                    title={a.id === defaultAccountId ? 'Tài khoản chính chỉ có thể đăng xuất' : active ? 'Chuyển sang tài khoản khác để xóa' : 'Xóa khỏi Compola'}
                    aria-label="Xóa khỏi Compola"
                    onClick={() => setRemoving(a)}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          );
        })}
        {manage && (
          <button className="accounts-add" disabled={!canAddAccount()} onClick={() => void beginAddAccount()}>
            <Plus size={15} /> {canAddAccount() ? 'Thêm tài khoản Zalo' : `Đã đủ ${max} tài khoản`}
            <span className="accounts-key">⇧⌘N</span>
          </button>
        )}
      </div>
      {!manage && <div className="st-footer">Các tài khoản Zalo của Compola Server mà bạn được cấp quyền. Quản trị viên thêm, đăng xuất hoặc xóa tài khoản trong Quản trị máy chủ.</div>}
      {removing && (
        <Alert
          title={`Xóa ${accountTitle(removing)} khỏi Compola?`}
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
      {renaming && <RenameSheet account={renaming} onClose={() => setRenaming(null)} />}
    </div>
  );
}

/** A local name for the account (shown instead of the Zalo name in the rail and in notification titles). */
function RenameSheet({ account, onClose }: { account: AccountInfo; onClose: () => void }) {
  const [name, setName] = useState(account.name);
  const save = () => {
    renameAccount(account.id, name);
    onClose();
  };
  return (
    <Sheet onClose={onClose} width={380}>
      <SheetHeader title="Đặt tên gợi nhớ" onClose={onClose} />
      <div className="accounts-rename">
        <input
          className="text-field"
          value={name}
          maxLength={40}
          autoFocus
          placeholder="Ví dụ: Bán hàng 1"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <div className="accounts-sub">Chỉ hiện trên Compola: thanh tài khoản và tiêu đề thông báo. Để trống để dùng tên Zalo.</div>
      </div>
      <div className="sheet-footer">
        <span />
        <button className="btn btn-glass" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-prominent" onClick={save}>
          Lưu
        </button>
      </div>
    </Sheet>
  );
}
