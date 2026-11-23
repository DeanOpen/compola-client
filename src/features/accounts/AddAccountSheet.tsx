// "Thêm tài khoản Zalo": the same QR card as the first sign-in (Telegram's add account), in a sheet over the window.
// It closes on its own once the new account is signed in (the host then lists it as signedIn).

import { useAccounts, cancelAddAccount, refreshAddQr } from '../../engine/accounts';
import { Sheet, SheetHeader } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { QrBody } from '../setup/LoginView';
import './accounts.css';

export function AddAccountHost() {
  const adding = useAccounts((s) => s.adding);
  const account = useAccounts((s) => (s.adding ? (s.accounts.find((a) => a.id === s.adding) ?? null) : null));
  if (!adding) return null;
  return (
    <Sheet onClose={cancelAddAccount} width={420}>
      <SheetHeader title="Thêm tài khoản Zalo" onClose={cancelAddAccount} />
      <div className="add-account-body">
        <p className="add-account-lead">Quét mã bằng Zalo trên điện thoại của tài khoản bạn muốn thêm. Mỗi tài khoản có tin nhắn và cài đặt riêng.</p>
        {account?.login ? (
          <QrBody state={account.login} notice={null} refresh={refreshAddQr} />
        ) : (
          <div className="add-account-wait">
            <Spinner size={18} />
            <span>Đang chuẩn bị đăng nhập…</span>
          </div>
        )}
      </div>
    </Sheet>
  );
}
