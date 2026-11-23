// "Thêm tài khoản Zalo": the same QR card as the first sign-in (Telegram's add account), in a sheet over the window.
// The new account stays inactive meanwhile (account_add {activate: false}); once its scan is confirmed the sheet closes
// and Compola switches to it. Closing the sheet before that removes the half-added account.

import { cancelAddAccount, refreshAddQr, useAccounts } from '../../engine/accounts';
import { Sheet, SheetHeader } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { QrBody } from '../setup/LoginView';
import './accounts.css';

export function AddAccountHost() {
  const adding = useAccounts((s) => s.adding);
  const login = useAccounts((s) => s.addingLogin);
  if (!adding) return null;
  return (
    <Sheet onClose={cancelAddAccount} width={420}>
      <SheetHeader title="Thêm tài khoản Zalo" onClose={cancelAddAccount} />
      <div className="add-account-body">
        <p className="add-account-lead">Quét mã bằng Zalo trên điện thoại của tài khoản bạn muốn thêm. Mỗi tài khoản có tin nhắn và cài đặt riêng.</p>
        {login ? (
          <QrBody state={login} notice={null} refresh={refreshAddQr} />
        ) : (
          <div className="add-account-wait">
            <Spinner size={18} />
            <span>Đang chuẩn bị mã đăng nhập…</span>
          </div>
        )}
      </div>
    </Sheet>
  );
}
