// Setup step 1: native QR login (Swift `LoginView`) as the Zalo PC login card (docs/zalo-pc-style.md §8): a centred
// white card on a light blue background — the Compola logo and wordmark, "Đăng nhập tài khoản Zalo để kết nối với
// Compola", a single "Với mã QR" tab, the QR in a bordered 240px box with its caption, then the numbered steps. The QR,
// scan detection and confirmation come from the official client running underneath.
// A second tab, "Compola Server", joins another Compola app's account instead (src/features/remote/JoinServer.tsx).
// A joined app whose host is at the QR shows the host's QR here (only that tab), with "Rời máy chủ"; only to admins:
// other users cannot sign the host in, so they see that the server is waiting for an admin.
// Wave 4 (docs/design-refs/wave4/login-setup): Telegram's compact QR card with numbered steps whose key words are bold,
// an expired overlay inside the QR box, WhatsApp's trust line at the foot of the card.

import { AlertTriangle, Info, Lock, RefreshCw, Server, Smartphone } from 'lucide-react';
import { useState } from 'react';
import logo from '../../assets/compola-logo.svg';
import { commands } from '../../engine/backend';
import type { LoginState } from '../../engine/models/phase';
import { remote, useHostSettingsLocked, useRemote } from '../../engine/remote';
import { JoinServer } from '../remote/JoinServer';
import { LeaveServerAlert } from '../remote/RemoteGate';
import { Avatar } from '../../ui/Avatar';
import { Spinner } from '../../ui/Spinner';
import { BrandBackground } from './BrandBackground';
import { appName } from './SplashView';

export function LoginView({ state, notice }: { state: LoginState; notice: string | null }) {
  const refresh = () => void commands.refreshQr();
  const joined = useRemote((s) => s.mode === 'joined');
  const serverName = useRemote((s) => s.connection?.serverName || 'Compola Server');
  const [tab, setTab] = useState<'qr' | 'server'>('qr');
  const onServer = tab === 'server' && !joined;
  // Joined without the admin role: the host sends no QR and refuses `engine_refresh_qr`.
  const waitingForAdmin = useHostSettingsLocked();
  return (
    <BrandBackground>
      <div className="login-page fade-in">
        <div className="login-brand">
          <span className="login-logo-row">
            <img src={logo} width={40} height={40} alt="" draggable={false} />
            <span className="login-wordmark">{appName}</span>
          </span>
          <div className="login-lead">
            {onServer
              ? 'Đăng nhập Compola Server để dùng tài khoản Zalo chung'
              : waitingForAdmin
                ? `Đang dùng Compola Server ${serverName}`
                : joined
                  ? `Đăng nhập tài khoản Zalo cho ${serverName}`
                  : `Đăng nhập tài khoản Zalo để kết nối với ${appName}`}
          </div>
        </div>
        <div className="login-card">
          <div className="login-tabs" role="tablist">
            <button className={`login-tab ${!onServer ? 'is-active' : ''}`} role="tab" aria-selected={!onServer} onClick={() => setTab('qr')}>
              {waitingForAdmin ? 'Compola Server' : 'Với mã QR'}
            </button>
            {!joined && (
              <button className={`login-tab ${onServer ? 'is-active' : ''}`} role="tab" aria-selected={onServer} onClick={() => setTab('server')}>
                Compola Server
              </button>
            )}
          </div>
          {onServer ? (
            <JoinServer onUseQr={() => setTab('qr')} />
          ) : waitingForAdmin ? (
            <HostSignedOut serverName={serverName} />
          ) : (
            <QrBody state={state} notice={notice} refresh={refresh} />
          )}
          <div className="login-trust">
            {onServer ? <Server size={12} /> : <Lock size={12} />}
            <span>
              {onServer
                ? 'Phiên Zalo nằm trên máy chủ; máy này chỉ thấy những gì bạn được cấp quyền.'
                : 'Tin nhắn đi thẳng tới máy chủ Zalo, không qua máy chủ nào khác.'}
            </span>
          </div>
        </div>
        {waitingForAdmin ? null : joined ? (
          <div className="login-footnote join-footnote">
            <span>Máy này đang dùng tài khoản Zalo của {serverName}.</span>
            <button className="btn-link" onClick={() => void remote.leave()}>
              Rời máy chủ
            </button>
          </div>
        ) : (
          <div className="login-footnote">
            {appName} là ứng dụng độc lập, không liên kết với VNG hay Zalo. Ứng dụng chạy phần lõi chính thức của Zalo PC.
          </div>
        )}
      </div>
    </BrandBackground>
  );
}

/** Joined, not an admin, and the host's Zalo account is signed out: only an admin can scan the host's QR. */
function HostSignedOut({ serverName }: { serverName: string }) {
  const [confirmLeave, setConfirmLeave] = useState(false);
  return (
    <div className="login-body">
      <div className="login-qr-box is-panel">
        <div className="login-confirm fade-in">
          <span className="login-fail-icon">
            <Server size={24} />
          </span>
          <div className="login-confirm-name">Máy chủ {serverName} chưa đăng nhập Zalo</div>
          <div className="login-caption is-muted">Quản trị viên cần quét mã QR trên máy chủ hoặc trong ứng dụng của họ.</div>
          <div className="login-waiting">
            <Spinner size={12} />
            <span>Tự động tiếp tục khi máy chủ đăng nhập xong</span>
          </div>
        </div>
      </div>
      <button className="btn-link" onClick={() => setConfirmLeave(true)}>
        Rời máy chủ
      </button>
      {confirmLeave && <LeaveServerAlert serverName={serverName} onClose={() => setConfirmLeave(false)} />}
    </div>
  );
}

/**
 * The QR card's body (notice, second-scan hint, QR / confirm / failed panel, caption and steps). Also shown by
 * Settings › Compola Server › Tài khoản Zalo, where an admin signs the host in (`refresh` = a new QR on the host).
 */
export function QrBody({ state, notice, refresh }: { state: LoginState; notice: string | null; refresh: () => void }) {
  const step = state.step;
  return (
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
