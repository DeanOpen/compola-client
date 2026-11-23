// Setup step 1: native QR login (Swift `LoginView`) as the Zalo PC login card (docs/zalo-pc-style.md §8): a centred
// white card on a light blue background — the Compola logo and wordmark, "Đăng nhập tài khoản Zalo để kết nối với
// Compola", a single "Với mã QR" tab, the QR in a bordered 240px box with its caption, then the numbered steps. The QR,
// scan detection and confirmation come from the official client running underneath.
// Wave 4 (docs/design-refs/wave4/login-setup): Telegram's compact QR card with numbered steps whose key words are bold,
// an expired overlay inside the QR box, WhatsApp's trust line at the foot of the card.

import { AlertTriangle, Info, Lock, RefreshCw, Smartphone } from 'lucide-react';
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
          <span className="login-logo-row">
            <img src={logo} width={40} height={40} alt="" draggable={false} />
            <span className="login-wordmark">{appName}</span>
          </span>
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
                <span>
                  <b>Bước 2/2.</b> Đã quét lần 1. Tài khoản của bạn cần quét thêm mã mới này để xác nhận thiết bị.
                </span>
              </div>
            )}
            <div className={`login-qr-box ${step.kind === 'waitingConfirm' || step.kind === 'failed' ? 'is-panel' : ''}`}>
              <QrArea state={state} onRefresh={refresh} />
            </div>
            {step.kind === 'waitingConfirm' ? (
              <div className="login-confirm-hint">
                Chưa thấy yêu cầu trên điện thoại?{' '}
                <button className="btn-link" onClick={refresh}>
                  Dùng mã QR khác
                </button>
              </div>
            ) : step.kind === 'failed' ? (
              <div className="login-caption is-error">{step.message}</div>
            ) : (
              <>
                <div className={`login-caption ${step.kind === 'expired' ? 'is-muted' : ''}`}>
                  {step.kind === 'expired' ? 'Lấy mã mới rồi quét lại bằng Zalo trên điện thoại.' : `Chỉ dùng để đăng nhập ${appName} trên máy tính`}
                </div>
                <ol className="login-steps">
                  <li>
                    <span>
                      Mở <b>Zalo</b> trên điện thoại
                    </span>
                  </li>
                  <li>
                    <span>
                      Nhấn biểu tượng <b>QR</b> ở thanh tìm kiếm
                    </span>
                  </li>
                  <li>
                    <span>
                      Quét mã và <b>xác nhận đăng nhập</b>
                    </span>
                  </li>
                </ol>
              </>
            )}
          </div>
          <div className="login-trust">
            <Lock size={12} />
            <span>Tin nhắn đi thẳng tới máy chủ Zalo, không qua máy chủ nào khác.</span>
          </div>
        </div>
        <div className="login-footnote">
          {appName} là ứng dụng độc lập, không liên kết với VNG hay Zalo. Ứng dụng chạy phần lõi chính thức của Zalo PC.
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
          <Avatar url={step.avatar} name={step.name} size={76} />
          <span className="login-confirm-badge">
            <Smartphone size={13} strokeWidth={2.4} />
          </span>
        </span>
        <div className="login-confirm-name clamp-2">{step.name}</div>
        <div className="login-waiting">
          <Spinner size={12} />
          <span>Xác nhận đăng nhập trên điện thoại</span>
        </div>
      </div>
    );
  }
  if (step.kind === 'failed') {
    return (
      <div className="login-confirm fade-in">
        <span className="login-fail-icon">
          <AlertTriangle size={24} />
        </span>
        <div className="login-confirm-name">Chưa lấy được mã QR</div>
        <button className="btn btn-prominent" onClick={onRefresh}>
          <RefreshCw size={14} /> Thử lại
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
        <div className="login-expired fade-in">
          <span className="login-expired-title">Mã QR đã hết hạn</span>
          <button className="btn btn-prominent login-refresh" onClick={onRefresh} autoFocus>
            <RefreshCw size={14} /> Lấy mã mới
          </button>
        </div>
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
