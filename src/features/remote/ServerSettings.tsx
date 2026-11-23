// Settings › Nâng cao › Compola Server (docs/compola-server.md). On the host: share this Zalo account (listener,
// addresses to join with, the first admin of the admin console, signed-in devices). On a joined app: the server, who is
// signed in with which access, and "Rời máy chủ".

import { Check, Copy, ExternalLink, Globe, LogOut, Monitor } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { formatTime } from '../../engine/automation';
import {
  errorText,
  remote,
  deviceTitle,
  roleTitle,
  scopeSummary,
  shortDeviceId,
  userTitle,
  useRemote,
  type RemoteHost,
  type RemoteServerConfig,
  type RemoteSession,
  type RemoteState,
} from '../../engine/remote';
import { Alert } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { LeaveServerAlert } from './RemoteGate';
import { Row, Section, Toggle } from '../settings/SettingsView';
import './remote.css';

export function ServerSettings() {
  const mode = useRemote((s) => s.mode);
  return mode === 'joined' ? <JoinedSettings /> : <HostSettings />;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="st-button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {done ? 'Đã chép' : 'Sao chép'}
    </button>
  );
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <div className="st-auto-error" role="alert">
      {text}
    </div>
  ) : null;
}

// MARK: - Host

const kindTitle = (kind: string) => (kind === 'tailscale' ? 'Tailscale' : kind === 'public' ? 'Public' : 'LAN');

function HostSettings() {
  const revision = useRemote((s) => s.revision);
  const [state, setState] = useState<RemoteState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void remote
      .state()
      .then((s) => alive && setState(s))
      .catch((e) => alive && setLoadError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [revision]);
  if (!state) {
    if (!loadError)
      return (
        <div className="st-auto-loading">
          <Spinner size={18} />
        </div>
      );
    return (
      <Section>
        <Row label="Không tải được cài đặt Compola Server" detail={loadError} />
      </Section>
    );
  }
  const host = state.server;
  return (
    <>
      <ListenerSection host={host} />
      {host.running && <AddressesSection host={host} />}
      {host.running && <AdminSection host={host} />}
      {host.running && <SessionsSection sessions={host.sessions} />}
    </>
  );
}

function ListenerSection({ host }: { host: RemoteHost }) {
  const config = host.config;
  const [port, setPort] = useState(String(config.port));
  const [name, setName] = useState(config.name);
  const [publicUrl, setPublicUrl] = useState(config.publicUrl);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setPort(String(config.port)), [config.port]);
  useEffect(() => setName(config.name), [config.name]);
  useEffect(() => setPublicUrl(config.publicUrl), [config.publicUrl]);

  const save = (patch: Partial<RemoteServerConfig>) => {
    setProblem(null);
    void remote.setServer({ ...config, ...patch }).catch((e) => setProblem(errorText(e)));
  };

  const status = host.running
    ? `Đang chạy · cổng ${config.port}`
    : config.enabled && host.error
      ? `Lỗi: ${host.error}`
      : config.enabled
        ? 'Đang khởi động…'
        : 'Đang tắt';

  return (
    <>
      <Section
        title="Chia sẻ tài khoản Zalo"
        footer="Người khác đăng nhập từ ứng dụng Compola trên máy của họ (thẻ Compola Server ở màn hình đăng nhập) và dùng tài khoản Zalo này theo quyền quản trị viên cấp. Phiên Zalo không rời khỏi máy này."
      >
        <Row label="Bật Compola Server" detail={status}>
          <Toggle label="Bật Compola Server" on={config.enabled} onChange={(enabled) => save({ enabled })} />
        </Row>
        <Row label="Tên máy chủ" detail="Hiện cho người đăng nhập.">
          <input
            className="st-input is-narrow"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() !== config.name && save({ name: name.trim() })}
          />
        </Row>
        <Row label="Cổng" detail="Từ 1024 đến 65535. Đổi cổng sẽ ngắt các máy đang kết nối.">
          <input
            className="st-input is-narrow nums"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            onBlur={() => {
              const n = Number(port);
              if (n === config.port) return;
              if (n >= 1024 && n <= 65535) save({ port: n });
              else {
                setProblem('Cổng phải từ 1024 đến 65535');
                setPort(String(config.port));
              }
            }}
          />
        </Row>
        <Row label="Cho phép kết nối từ mạng khác" detail="Mạng LAN, Tailscale… Tắt: chỉ nhận kết nối từ máy này (khi dùng tunnel hoặc reverse proxy).">
          <Toggle label="Cho phép kết nối từ mạng khác" on={config.allowNetwork} onChange={(allowNetwork) => save({ allowNetwork })} />
        </Row>
        <Row
          column
          label="Địa chỉ công khai"
          detail="Địa chỉ mọi người dùng để vào máy chủ, ví dụ https://compola.congty.vn. Cần cho đăng nhập bằng trình duyệt (SSO) từ ngoài mạng nội bộ."
        >
          <input
            className="st-input"
            value={publicUrl}
            placeholder="https://compola.congty.vn"
            spellCheck={false}
            onChange={(e) => setPublicUrl(e.target.value)}
            onBlur={() => publicUrl.trim() !== config.publicUrl && save({ publicUrl: publicUrl.trim() })}
          />
        </Row>
      </Section>
      <Problem text={problem} />
    </>
  );
}

function AddressesSection({ host }: { host: RemoteHost }) {
  const port = host.config.port;
  const addresses = [
    ...(host.config.publicUrl ? [{ url: host.config.publicUrl, kind: 'public' }] : []),
    ...(host.config.allowNetwork ? host.addresses.map((a) => ({ url: `http://${a.ip}:${port}`, kind: a.kind })) : []),
  ];
  return (
    <Section title="Địa chỉ để kết nối" footer="Nhập một trong các địa chỉ này ở máy khác: màn hình đăng nhập › thẻ Compola Server.">
      {addresses.length ? (
        addresses.map((a) => (
          <Row
            key={a.url}
            label={
              <span className="st-auto-title">
                <span className="st-auto-mono selectable">{a.url}</span>
                <span className="st-chip">{kindTitle(a.kind)}</span>
              </span>
            }
          >
            <CopyButton text={a.url} />
          </Row>
        ))
      ) : (
        <Row
          label="Chưa có địa chỉ"
          detail={host.config.allowNetwork ? 'Máy này chưa kết nối mạng nào.' : `Chỉ nhận kết nối từ máy này (http://127.0.0.1:${port}). Đặt địa chỉ công khai nếu dùng tunnel.`}
        />
      )}
    </Section>
  );
}

function AdminSection({ host }: { host: RemoteHost }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  if (!host.hasAdmin) return <AdminSetup />;
  return (
    <>
      <Section title="Quản trị">
        <Row label="Trang quản trị" detail="Người dùng, nhóm, quyền truy cập, đăng nhập LDAP / SSO, thiết bị và nhật ký.">
          <button
            className="st-button is-primary"
            disabled={opening}
            onClick={() => {
              setOpening(true);
              setProblem(null);
              void remote
                .adminOpen()
                .catch((e) => setProblem(errorText(e)))
                .finally(() => setOpening(false));
            }}
          >
            <ExternalLink size={14} /> Mở trang quản trị
          </button>
        </Row>
      </Section>
      <Problem text={problem} />
    </>
  );
}

function AdminSetup() {
  const [username, setUsername] = useState('admin');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!username.trim()) return setProblem('Nhập tên đăng nhập.');
    if (password.length < 8) return setProblem('Mật khẩu cần ít nhất 8 ký tự.');
    if (password !== again) return setProblem('Hai mật khẩu không khớp.');
    setBusy(true);
    setProblem(null);
    void remote
      .adminSetup({ username: username.trim(), password, displayName: displayName.trim() || username.trim() })
      .catch((err) => setProblem(errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Section title="Tạo tài khoản quản trị" description="Tài khoản đầu tiên của trang quản trị: tạo người dùng, cấp quyền và cấu hình đăng nhập.">
        <form className="rs-form" onSubmit={submit}>
          <label className="st-field">
            <span>Tên đăng nhập</span>
            <input className="st-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="st-field">
            <span>Tên hiển thị</span>
            <input className="st-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Quản trị viên" />
          </label>
          <label className="st-field">
            <span>Mật khẩu</span>
            <input className="st-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="st-field">
            <span>Nhập lại mật khẩu</span>
            <input className="st-input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          </label>
          <div className="st-auto-actions is-end is-wide">
            <button className="st-button is-primary" disabled={busy || !password || !again}>
              {busy && <Spinner size={12} />} Tạo tài khoản quản trị
            </button>
          </div>
        </form>
      </Section>
      <Problem text={problem} />
    </>
  );
}

function SessionsSection({ sessions }: { sessions: RemoteSession[] }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [kicking, setKicking] = useState<RemoteSession | null>(null);
  const online = sessions.filter((s) => s.online);
  return (
    <>
      <Section title="Đang đăng nhập" description={online.length ? undefined : 'Chưa có ai đang kết nối.'}>
        {online.map((s) => {
          const Icon = s.kind === 'web' ? Globe : Monitor;
          const device = s.kind === 'web' ? ['Trang quản trị', s.deviceName] : [s.deviceName || 'Thiết bị không tên', shortDeviceId(s.deviceId)];
          return (
            <div key={s.id} className="st-row rs-session">
              <span className="st-icon-tile rs-session-icon">
                <Icon size={17} />
                <span className="st-dot is-on rs-session-dot" title="Đang trực tuyến" />
              </span>
              <div className="st-row-text">
                <div className="st-row-label rs-session-person truncate">
                  {s.user?.displayName && s.user.displayName !== s.user.username ? <b>{s.user.displayName}</b> : null}
                  {s.user ? <span className="rs-session-username">@{s.user.username}</span> : 'Không rõ'}
                  {s.role === 'admin' && <span className="st-chip">Quản trị</span>}
                </div>
                <div className="st-row-detail truncate">
                  {[...device, s.ip, s.createdAt ? `từ ${formatTime(s.createdAt)}` : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button className="st-button is-danger" onClick={() => setKicking(s)}>
                Ngắt
              </button>
            </div>
          );
        })}
      </Section>
      <Problem text={problem} />
      {kicking && (
        <Alert
          title="Ngắt phiên này?"
          message={`${userTitle(kicking.user)} sẽ bị đăng xuất khỏi ${kicking.kind === 'web' ? 'trang quản trị' : deviceTitle(kicking.deviceName, kicking.deviceId)}; các thiết bị khác của họ vẫn đăng nhập.`}
          buttons={[
            {
              label: 'Ngắt',
              role: 'destructive',
              onClick: () => {
                const id = kicking.id;
                setKicking(null);
                setProblem(null);
                void remote.kick(id).catch((e) => setProblem(errorText(e)));
              },
            },
            { label: 'Hủy', role: 'cancel', onClick: () => setKicking(null) },
          ]}
        />
      )}
    </>
  );
}

// MARK: - Joined

const connectionTitle = (state: string | undefined) => (state === 'connected' ? 'Đã kết nối' : state === 'connecting' ? 'Đang kết nối…' : 'Mất kết nối');

function JoinedSettings() {
  const connection = useRemote((s) => s.connection);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const access = connection?.access;
  return (
    <>
      <Section title="Tài khoản" footer="Bạn dùng tài khoản Zalo của máy chủ theo quyền quản trị viên cấp cho tài khoản này.">
        <Row label="Đăng nhập với tư cách">
          <span className="st-value">{userTitle(connection?.user)}</span>
        </Row>
        <Row label="Vai trò" detail={access?.role === 'viewer' ? 'Chỉ đọc: không gửi, thả cảm xúc hay thu hồi tin nhắn.' : undefined}>
          <span className="st-value">{roleTitle(access?.role)}</span>
        </Row>
        <Row label="Phạm vi">
          <span className="st-value">{access ? scopeSummary(access.scope) : '—'}</span>
        </Row>
      </Section>
      <Section title="Máy chủ">
        <Row label="Tên">
          <span className="st-value">{connection?.serverName || '—'}</span>
        </Row>
        <Row label="Địa chỉ">
          <span className="st-value st-auto-mono selectable">{connection?.url || '—'}</span>
        </Row>
        <Row label="Trạng thái" detail={connection?.state !== 'connected' ? (connection?.error ?? undefined) : undefined}>
          <span className="st-auto-title">
            <span className={`st-dot ${connection?.state === 'connected' ? 'is-on' : 'is-bad'}`} />
            {connectionTitle(connection?.state)}
          </span>
        </Row>
      </Section>
      <Section title="Thiết bị này" footer="Tên thiết bị chỉ để nhận ra máy này trong danh sách thiết bị của quản trị viên; nó không phải tài khoản đăng nhập.">
        <Row label="Thiết bị">
          <span className="st-value">{connection?.deviceName || '—'}</span>
        </Row>
        <Row label="Mã thiết bị">
          <span className="st-value st-auto-mono selectable">{shortDeviceId(connection?.deviceId) || '—'}</span>
        </Row>
      </Section>
      <Section title="Rời máy chủ" tone="danger">
        <Row label="Rời Compola Server" detail="Tài khoản Zalo vẫn đăng nhập trên máy chủ. Ứng dụng khởi động lại và dùng riêng trên máy này.">
          <button className="st-button is-danger" onClick={() => setConfirmLeave(true)}>
            <LogOut size={14} /> Rời máy chủ
          </button>
        </Row>
      </Section>
      {confirmLeave && <LeaveServerAlert serverName={connection?.serverName} onClose={() => setConfirmLeave(false)} />}
    </>
  );
}
