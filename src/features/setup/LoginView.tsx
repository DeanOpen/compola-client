import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { commands } from '../../engine/backend';
import type { LoginState } from '../../engine/models/phase';
import { Avatar } from '../../ui/Avatar';
import { Spinner } from '../../ui/Spinner';

/**
 * Setup step 1: native QR login (Swift `LoginView`). The QR, scan detection and confirmation are produced by the
 * official client underneath; this view only renders them. Copy follows the official language pack.
 */
export function LoginView({ state, notice }: { state: LoginState; notice: string | null }) {
  const step = state.step;
  const confirming = step.kind === 'waitingConfirm';
  const qrSize = notice ? 168 : 216;
  const refresh = () => void commands.refreshQr();

  const subtitle = (() => {
    switch (step.kind) {
      case 'generating':
        return 'Đang tạo mã QR…';
      case 'waitingScan':
        return state.isSecondQr
          ? 'Đã quét lần 1. Tài khoản của bạn cần quét thêm mã mới dưới đây để xác nhận thiết bị.'
          : 'Mở Zalo trên điện thoại, chạm biểu tượng quét mã QR rồi quét mã dưới đây.';
      case 'waitingConfirm':
        return 'Chọn Đăng nhập trên điện thoại của bạn để tiếp tục.';
      case 'expired':
        return 'Mã QR đã hết hạn.';
      case 'failed':
        return step.message;
    }
  })();

  return (
    <div className="login">
      {notice && (
        <div className="login-notice fade-in">
          <AlertTriangle size={15} />
          <span>{notice}</span>
        </div>
      )}
      <div className="login-head">
        <div className="setup-heading">{confirming ? 'Xác nhận trên điện thoại' : 'Đăng nhập bằng Zalo'}</div>
        <p className="setup-lead">{subtitle}</p>
      </div>

      <div className="login-qr-area" style={{ width: qrSize, height: qrSize }}>
        {step.kind === 'waitingConfirm' ? (
          <div className="login-confirm fade-in">
            <Avatar url={step.avatar} name={step.name} size={84} />
            <div className="login-confirm-name clamp-2">{step.name}</div>
            <div className="login-confirm-scanned tint">
              <CheckCircle2 size={14} /> Đã quét mã
            </div>
          </div>
        ) : step.kind === 'failed' ? (
          <div className="login-confirm fade-in">
            <AlertTriangle size={34} color="var(--warning)" />
            <div className="secondary" style={{ fontWeight: 500 }}>
              Chưa lấy được mã QR
            </div>
          </div>
        ) : (
          <div className="login-qr fade-in">
            {state.qr ? (
              <img
                src={state.qr}
                alt="Mã QR đăng nhập Zalo"
                draggable={false}
                className={step.kind === 'expired' ? 'is-expired' : ''}
              />
            ) : (
              <Spinner size={20} />
            )}
            {step.kind === 'expired' && (
              <button className="btn btn-prominent btn-large login-refresh" onClick={refresh}>
                <RefreshCw size={15} /> Lấy mã mới
              </button>
            )}
          </div>
        )}
      </div>

      {step.kind === 'waitingConfirm' ? (
        <div className="login-footer">
          <div className="login-waiting">
            <Spinner size={14} /> <span>Đang chờ xác nhận trên điện thoại…</span>
          </div>
          <button className="btn-link" onClick={refresh}>
            Dùng mã QR khác
          </button>
        </div>
      ) : step.kind === 'failed' ? (
        <button className="btn btn-prominent btn-large" onClick={refresh}>
          Thử lại
        </button>
      ) : (
        <div className="login-steps">
          <InstructionRow n={1} text="Mở Zalo trên điện thoại" />
          <InstructionRow n={2} text="Nhấn biểu tượng QR ở thanh tìm kiếm" />
          <InstructionRow n={3} text="Quét mã và xác nhận đăng nhập" />
        </div>
      )}
    </div>
  );
}

function InstructionRow({ n, text }: { n: number; text: string }) {
  return (
    <div className="login-step">
      <span className="login-step-n">{n}</span>
      <span>{text}</span>
    </div>
  );
}

/** Setup step 1 after the QR was confirmed: the official client is logging in and loading. */
export function SigningInView() {
  return (
    <div className="login fade-in">
      <Spinner size={28} />
      <div className="setup-heading">Đang đăng nhập…</div>
      <p className="setup-lead">Đang tải dữ liệu từ Zalo. Việc này có thể mất một lúc.</p>
    </div>
  );
}
