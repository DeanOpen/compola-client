// Setup step 1: native QR login (Swift `LoginView`) as the Zalo PC login card (docs/zalo-pc-style.md §8): a centred
// white card on a light blue background — the Compola logo and wordmark, "Đăng nhập tài khoản Zalo để kết nối với
// Compola", a single "Với mã QR" tab, the QR in a bordered 240px box with its caption, then the numbered steps. The QR,
// scan detection and confirmation come from the official client running underneath.

import { AlertTriangle, CheckCircle2, Info, RefreshCw } from 'lucide-react';
import logo from '../../assets/compola-logo.svg';
import { commands } from '../../engine/backend';
import type { LoginState } from '../../engine/models/phase';
import { Avatar } from '../../ui/Avatar';
import { Spinner } from '../../ui/Spinner';
import { BrandBackground } from './BrandBackground';
import { appName } from './SplashView';

export function LoginView({ state, notice }: { state: LoginState; notice: string | null }) {
  const step = state.step;
  const refresh = () => void commands.refreshQr();
  return (
    <BrandBackground>
      <div className="login-page fade-in">
        <div className="login-brand">
          <img src={logo} width={56} height={56} alt="" draggable={false} />
          <div className="login-wordmark">{appName}</div>
          <div className="login-lead">Đăng nhập tài khoản Zalo để kết nối với {appName}</div>
        </div>
        <div className="login-card">
          <div className="login-tabs" role="tablist">
            <span className="login-tab is-active" role="tab" aria-selected>
              Với mã QR
            </span>
          </div>
          <div className="login-body">
            {notice && (
              <div className="callout is-warning">
                <AlertTriangle size={15} />
                <span>{notice}</span>
              </div>
            )}
            {state.isSecondQr && step.kind === 'waitingScan' && (
              <div className="callout is-info">
                <Info size={15} />
                <span>Đã quét lần 1. Tài khoản của bạn cần quét thêm mã mới này để xác nhận thiết bị.</span>
              </div>
            )}
            <div className="login-qr-box">
              <QrArea state={state} onRefresh={refresh} />
            </div>
            {step.kind === 'waitingConfirm' ? (
              <button className="btn-link" onClick={refresh}>
                Dùng mã QR khác
              </button>
            ) : step.kind === 'failed' ? (
              <div className="login-caption is-error">{step.message}</div>
            ) : (
              <>
                <div className="login-caption">
                  {step.kind === 'expired' ? 'Mã QR đã hết hạn.' : `Chỉ dùng để đăng nhập ${appName} trên máy tính`}
                </div>
                <ol className="login-steps">
                  <li>Mở Zalo trên điện thoại</li>
                  <li>Nhấn biểu tượng QR ở thanh tìm kiếm</li>
                  <li>Quét mã và xác nhận đăng nhập</li>
                </ol>
              </>
            )}
          </div>
        </div>
        <div className="login-footnote">
          {appName} là ứng dụng độc lập, không liên kết với VNG hay Zalo. Ứng dụng chạy phần lõi chính thức của Zalo PC; tin nhắn
          đi thẳng tới máy chủ Zalo.
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
          <Avatar url={step.avatar} name={step.name} size={80} />
          <span className="login-confirm-check">
            <CheckCircle2 size={22} fill="var(--accent)" color="#fff" />
          </span>
        </span>
        <div className="login-confirm-name clamp-2">{step.name}</div>
        <div className="login-waiting">
          <Spinner size={13} /> <span>Xác nhận đăng nhập trên điện thoại</span>
        </div>
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
        <button className="btn btn-prominent" onClick={onRefresh}>
          Thử lại
        </button>
      </div>
    );
  }
  const expired = step.kind === 'expired';
  return (
    <div className="login-qr">
      {state.qr ? (
        <img src={state.qr} alt="Mã QR đăng nhập Zalo" draggable={false} className={`login-qr-code ${expired ? 'is-expired' : ''}`} />
      ) : (
        <Spinner size={22} />
      )}
      {expired && (
        <button className="btn btn-prominent login-refresh" onClick={onRefresh} autoFocus>
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
