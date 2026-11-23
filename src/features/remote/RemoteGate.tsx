// A joined app's connection to its Compola Server (docs/compola-server.md): until the first connection a splash-like
// screen ("Đang kết nối tới …", the error, Thử lại / Rời máy chủ) replaces the window; a drop afterwards shows a slim
// banner while Rust reconnects (the page reloads once it is back, lifecycle.ts).

import { RefreshCw, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import logo from '../../assets/compola-logo.svg';
import { deviceTitle, remote, useRemote, userTitle, type RemoteConnection } from '../../engine/remote';
import { Alert } from '../../ui/Overlays';
import { BrandBackground } from '../setup/BrandBackground';
import { appName } from '../setup/SplashView';
import './remote.css';

/** Joined and not connected yet since launch. */
export const useRemoteGateActive = () =>
  useRemote((s) => s.mode === 'joined' && !(s.connection?.everConnected || s.connection?.state === 'connected'));

/** Joined, was connected, and lost the connection. */
export const useRemoteDropped = () => useRemote((s) => s.mode === 'joined' && !!s.connection?.everConnected && s.connection.state !== 'connected');

const serverLabel = (c: RemoteConnection | null) => c?.serverName || c?.url.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'máy chủ';

/** Seconds until `at` (epoch ms), ticking. */
export const useSecondsLeft = (at: number | null) => {
  // Re-renders every second; the time is read when rendering so a new `at` never shows a stale value.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!at) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
};

export function RemoteConnectScreen() {
  const connection = useRemote((s) => s.connection);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const failed = connection?.state === 'disconnected';
  const seconds = useSecondsLeft(failed ? connection.retryAt : null);
  return (
    <BrandBackground>
      <div className="splash remote-gate fade-in">
        <span className="login-logo-row">
          <img src={logo} width={48} height={48} alt="" draggable={false} />
          <span className="login-wordmark">{appName}</span>
        </span>
        {!failed && (
          <div className="splash-bar" aria-hidden>
            <div />
          </div>
        )}
        <div className="splash-status" role="status">
          {failed ? `Không kết nối được tới ${serverLabel(connection)}` : `Đang kết nối tới ${serverLabel(connection)}…`}
        </div>
        {failed && (connection.error || seconds !== null) && (
          <div className="remote-gate-error">
            {connection.error}
            {seconds !== null && seconds > 0 ? `${connection.error ? ' · ' : ''}Thử lại sau ${seconds} giây` : ''}
          </div>
        )}
        {connection && (
          <div className="remote-gate-identity">
            {connection.user && (
              <span>
                Đăng nhập với tư cách <b>{userTitle(connection.user)}</b>
              </span>
            )}
            <span>Thiết bị: {deviceTitle(connection.deviceName, connection.deviceId)}</span>
          </div>
        )}
        <div className="remote-gate-actions">
          {failed && (
            <button className="btn btn-prominent" onClick={() => void remote.retry()}>
              <RefreshCw size={14} /> Thử lại
            </button>
          )}
          <button className="btn btn-glass" onClick={() => setConfirmLeave(true)}>
            Rời máy chủ
          </button>
        </div>
      </div>
      {confirmLeave && <LeaveServerAlert serverName={serverLabel(connection)} onClose={() => setConfirmLeave(false)} />}
    </BrandBackground>
  );
}

export function RemoteBanner() {
  const dropped = useRemoteDropped();
  const connecting = useRemote((s) => s.connection?.state === 'connecting');
  if (!dropped) return null;
  return (
    <div className="remote-banner fade-in" role="status">
      <WifiOff size={13} />
      <span className="truncate">Mất kết nối tới máy chủ — đang thử lại…</span>
      <button className="btn btn-glass" disabled={connecting} onClick={() => void remote.retry()}>
        Thử lại
      </button>
    </div>
  );
}

/** "Rời Compola Server?" (Settings, account menu). */
export function LeaveServerAlert({ serverName, onClose }: { serverName?: string; onClose: () => void }) {
  return (
    <Alert
      title="Rời Compola Server?"
      message={`Máy này sẽ ngừng dùng tài khoản Zalo của ${serverName || 'máy chủ'}; tài khoản vẫn đăng nhập trên máy chủ.`}
      buttons={[
        {
          label: 'Rời máy chủ',
          role: 'destructive',
          onClick: () => {
            onClose();
            void remote.leave();
          },
        },
        { label: 'Hủy', role: 'cancel', onClick: onClose },
      ]}
    />
  );
}
