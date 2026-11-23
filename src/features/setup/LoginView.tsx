// Setup step 1: native QR login (Swift `LoginView`), laid out as one centred card (docs/design-refs: Telegram /
// WhatsApp QR login): title, subtitle and numbered steps beside a 240px QR with the Compola logo over its centre; stacked
// on narrow windows. The QR, scan detection and confirmation come from the official client running underneath; copy
// follows the official language pack.

import { AlertTriangle, CheckCircle2, Info, RefreshCw, ShieldCheck } from 'lucide-react';
import appIcon from '../../assets/app-icon.png';
import { commands } from '../../engine/backend';
import type { LoginState } from '../../engine/models/phase';
import { Avatar } from '../../ui/Avatar';
import { Spinner } from '../../ui/Spinner';
import { BrandBackground } from './BrandBackground';
import { appName } from './SplashView';

export function LoginView({ state, notice }: { state: LoginState; notice: string | null }) {
  const step = state.step;
  const refresh = () => void commands.refreshQr();
  const confirming = step.kind === 'waitingConfirm';

  const subtitle = (() => {
    switch (step.kind) {
      case 'generating':
        return 'Đang tạo mã QR…';
      case 'waitingScan':
        return 'Mở Zalo trên điện thoại, chạm biểu tượng quét mã QR rồi quét mã này.';
      case 'waitingConfirm':
        return 'Chọn Đăng nhập trên điện thoại của bạn để tiếp tục.';
      case 'expired':
        return 'Mã QR đã hết hạn.';
      case 'failed':
        return step.message;
    }
  })();

  return (
    <BrandBackground>
      <div className="login-card fade-in">
        {notice && (
          <div className="callout is-warning login-notice">
            <AlertTriangle size={15} />
            <span>{notice}</span>
          </div>
        )}
        <div className="login-main">
          <div className="login-text">
            <img className="login-logo" src={appIcon} width={44} height={44} alt="" draggable={false} />
            <h1 className="login-title">{confirming ? 'Xác nhận trên điện thoại' : 'Đăng nhập bằng Zalo'}</h1>
            <p className="login-subtitle">{subtitle}</p>
            {!confirming && step.kind !== 'failed' && (
              <ol className="login-steps">
                <li>Mở Zalo trên điện thoại</li>
                <li>Nhấn biểu tượng QR ở thanh tìm kiếm</li>
                <li>Quét mã và xác nhận đăng nhập</li>
              </ol>
            )}
            {state.isSecondQr && step.kind === 'waitingScan' && (
              <div className="callout is-info">
                <Info size={15} />
                <span>Đã quét lần 1. Tài khoản của bạn cần quét thêm mã mới này để xác nhận thiết bị.</span>
              </div>
            )}
          </div>
          <div className="login-qr-area">
            <QrArea state={state} onRefresh={refresh} />
          </div>
        </div>
        <div className="login-footnote">
          <ShieldCheck size={13} color="var(--success)" />
          <span>
            {appName} là ứng dụng độc lập, không liên kết với VNG hay Zalo. Ứng dụng chạy phần lõi chính thức của Zalo PC; tin
            nhắn đi thẳng tới máy chủ Zalo.
          </span>
        </div>
      </div>
    </BrandBackground>
  );
}

function QrArea({ state, onRefresh }: { state: LoginState; onRefresh: () => void }) {
  const step = state.step;
  if (step.kind === 'waitingConfirm') {
    return (
      <div className="login-confirm fade-in">
        <span className="login-confirm-avatar">
          <Avatar url={step.avatar} name={step.name} size={84} />
          <span className="login-confirm-check">
            <CheckCircle2 size={22} fill="var(--accent)" color="#fff" />
          </span>
        </span>
        <div className="login-confirm-name clamp-2">{step.name}</div>
        <div className="login-waiting">
          <Spinner size={13} /> <span>Xác nhận đăng nhập trên điện thoại</span>
        </div>
        <button className="btn-link" onClick={onRefresh}>
          Dùng mã QR khác
        </button>
      </div>
    );
  }
  if (step.kind === 'failed') {
    return (
      <div className="login-confirm fade-in">
        <AlertTriangle size={34} color="var(--warning)" />
        <div className="secondary" style={{ fontWeight: 500 }}>
          Chưa lấy được mã QR
        </div>
        <button className="btn btn-prominent btn-large" onClick={onRefresh}>
          Thử lại
        </button>
      </div>
    );
  }
  const expired = step.kind === 'expired';
  return (
    <div className="login-qr">
      {state.qr ? (
        <>
          <img src={state.qr} alt="Mã QR đăng nhập Zalo" draggable={false} className={`login-qr-code ${expired ? 'is-expired' : ''}`} />
          {!expired && <img src={appIcon} className="login-qr-logo" alt="" draggable={false} />}
        </>
      ) : (
        <Spinner size={22} />
      )}
      {expired && (
        <button className="btn btn-prominent btn-large login-refresh" onClick={onRefresh} autoFocus>
          <RefreshCw size={15} /> Lấy mã mới
        </button>
      )}
    </div>
  );
}

/** Setup step 1 after the QR was confirmed: the official client is logging in and loading. */
export function SigningInView() {
  return (
    <div className="setup-step fade-in" style={{ gap: 14 }}>
      <Spinner size={28} />
      <div className="setup-heading">Đang đăng nhập…</div>
      <p className="setup-lead">Đang tải dữ liệu từ Zalo. Việc này có thể mất một lúc.</p>
    </div>
  );
}
