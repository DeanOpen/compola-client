// The login card's "Compola Server" tab (docs/compola-server.md, "Joined app"; design refs in
// docs/design-refs/compola-server/README.md › Desktop):
// 1. Address (Miro): the server address first and prominent, the device name (a label for this install, not the
//    account), "Tiếp tục", and a quiet link back to the QR sign-in.
// 2. Sign-in (Notion / Calendly): a "Máy chủ: <name> · đổi" chip, username + password (local or LDAP), then
//    "hoặc tiếp tục với" and the browser options: provider tiles, or full-width "Tiếp tục với …" buttons when there are
//    only one or two SSO providers.
// 3. Browser (incident.io "Sign in with Slack"): Compola ⇄ server logos, the code in segmented boxes to compare with
//    the browser, its expiry, a small "Huỷ".
// On success Rust saves the token and restarts the app joined.

import { ArrowLeftRight, ExternalLink, Globe, Server, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import logo from '../../assets/compola-logo.svg';
import { errorText, remote, useRemote, type RemoteProvider, type RemoteProviders } from '../../engine/remote';
import { openExternal } from '../../engine/system';
import { Spinner } from '../../ui/Spinner';
import { useSecondsLeft } from './RemoteGate';
import './remote.css';

type Step = 'address' | 'signin' | 'browser' | 'restarting';

/** More SSO providers than this: tiles instead of full-width buttons. */
const maxProviderButtons = 2;

export function JoinServer({ onUseQr }: { onUseQr: () => void }) {
  const [step, setStep] = useState<Step>('address');
  const [url, setUrl] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [server, setServer] = useState<RemoteProviders | null>(null);
  const [provider, setProvider] = useState('local');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browserCancelled = useRef(false);

  // Prefill from the last server left and the computer's name.
  useEffect(() => {
    void remote
      .state()
      .then((s) => {
        setUrl((u) => u || s.lastJoin?.url || '');
        setDeviceName((d) => d || s.lastJoin?.deviceName || s.computerName);
      })
      .catch(() => {});
  }, []);

  const lookUp = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    void remote
      .providers(url.trim())
      .then((p) => {
        setServer(p);
        setUrl(p.url);
        setProvider(p.local ? 'local' : (p.ldap[0]?.id ?? 'local'));
        setStep('signin');
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    if (!server || !username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    void remote
      .joinPassword({ url: server.url, username: username.trim(), password, provider, deviceName: deviceName.trim() })
      .then(() => setStep('restarting'))
      .catch((err) => {
        setError(errorText(err));
        setPassword('');
      })
      .finally(() => setBusy(false));
  };

  /** Device sign-in in the browser; with an OIDC provider id, the browser goes straight to that provider. */
  const signInWithBrowser = (oidcProvider?: string) => {
    if (!server || busy) return;
    browserCancelled.current = false;
    setError(null);
    useRemote.setState({ joinProgress: null });
    setStep('browser');
    void remote
      .joinBrowser({ url: server.url, deviceName: deviceName.trim(), ...(oidcProvider ? { provider: oidcProvider } : {}) })
      .then(() => setStep('restarting'))
      .catch((err) => {
        if (!browserCancelled.current) setError(errorText(err));
        setStep('signin');
      });
  };

  const cancelBrowser = () => {
    browserCancelled.current = true;
    setStep('signin');
    void remote.joinCancel().catch(() => {});
  };

  const backToAddress = () => {
    setError(null);
    setStep('address');
  };

  if (step === 'restarting') {
    return (
      <div className="login-body join-body">
        <div className="join-waiting">
          <Spinner size={22} />
          <div className="join-waiting-title">Đã đăng nhập</div>
          <div className="join-hint">Đang khởi động lại để kết nối tới {server?.serverName || 'máy chủ'}…</div>
        </div>
      </div>
    );
  }

  if (step === 'browser') return <BrowserStep serverName={server?.serverName || 'Compola Server'} onCancel={cancelBrowser} />;

  if (step === 'signin' && server) {
    const passwordProviders: RemoteProvider[] = [...(server.local ? [{ id: 'local', name: 'Tài khoản Compola Server' }] : []), ...server.ldap];
    return (
      <div className="login-body join-body">
        <ServerChip name={server.serverName || server.url} url={server.url} deviceName={deviceName} onChange={backToAddress} />
        {error && <JoinError text={error} />}
        {passwordProviders.length > 0 && (
          <form className="join-form" onSubmit={signIn}>
            {passwordProviders.length > 1 && (
              <label className="join-field">
                <span>Đăng nhập bằng</span>
                <select className="join-input" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {passwordProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="join-field">
              <span>Tên đăng nhập</span>
              <input
                className="join-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
              />
            </label>
            <label className="join-field">
              <span>Mật khẩu</span>
              <input className="join-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <button className="btn btn-prominent btn-large join-submit" disabled={busy || !username.trim() || !password}>
              {busy ? <Spinner size={14} /> : null} Đăng nhập
            </button>
          </form>
        )}
        {passwordProviders.length > 0 && (
          <div className="join-divider">
            <span>hoặc tiếp tục với</span>
          </div>
        )}
        {server.oidc.length > maxProviderButtons ? (
          <div className="join-tiles" role="group" aria-label="Đăng nhập bằng trình duyệt">
            {server.oidc.map((p) => (
              <button key={p.id} type="button" className="join-tile" disabled={busy} onClick={() => signInWithBrowser(p.id)} title={`Tiếp tục với ${p.name}`}>
                <span className="join-tile-mark" aria-hidden>
                  {p.name.trim().charAt(0).toUpperCase() || '?'}
                </span>
                <span className="join-tile-name truncate">{p.name}</span>
              </button>
            ))}
            <button type="button" className="join-tile" disabled={busy} onClick={() => signInWithBrowser()} title="Đăng nhập bằng trình duyệt">
              <span className="join-tile-mark" aria-hidden>
                <Globe size={16} />
              </span>
              <span className="join-tile-name">Trình duyệt</span>
            </button>
          </div>
        ) : (
          <div className="join-sso">
            {server.oidc.map((p) => (
              <button key={p.id} type="button" className="btn btn-glass join-sso-button" disabled={busy} onClick={() => signInWithBrowser(p.id)}>
                Tiếp tục với {p.name}
              </button>
            ))}
            <button type="button" className="btn btn-glass join-sso-button" disabled={busy} onClick={() => signInWithBrowser()}>
              <Globe size={14} /> Tiếp tục với trình duyệt
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="login-body join-body">
      {error && <JoinError text={error} />}
      <form className="join-form" onSubmit={lookUp}>
        <label className="join-field">
          <span>Địa chỉ Compola Server</span>
          <input
            className="join-input is-large"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="192.168.1.10 hoặc https://compola.congty.vn"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
          <span className="join-field-hint">Hỏi quản trị viên của công ty bạn nếu chưa có địa chỉ.</span>
        </label>
        <label className="join-field">
          <span>Tên thiết bị</span>
          <input className="join-input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={60} spellCheck={false} />
          <span className="join-field-hint">Chỉ để nhận ra máy này trong danh sách thiết bị, không phải tài khoản đăng nhập.</span>
        </label>
        <button className="btn btn-prominent btn-large join-submit" disabled={busy || !url.trim()}>
          {busy ? <Spinner size={14} /> : null} Tiếp tục
        </button>
      </form>
      <div className="join-secondary">
        Dùng tài khoản Zalo của riêng bạn?{' '}
        <button type="button" className="btn-link" onClick={onUseQr}>
          Đăng nhập bằng mã QR
        </button>
      </div>
    </div>
  );
}

/** "Máy chủ: <name> · đổi", and which device is signing in. */
function ServerChip({ name, url, deviceName, onChange }: { name: string; url: string; deviceName: string; onChange: () => void }) {
  return (
    <div className="join-server">
      <span className="join-chip" title={url}>
        <Server size={13} />
        <span className="truncate">
          Máy chủ: <b>{name}</b>
        </span>
        <span aria-hidden>·</span>
        <button type="button" className="btn-link" onClick={onChange}>
          đổi
        </button>
      </span>
      <span className="join-device">Thiết bị: {deviceName.trim() || 'chưa đặt tên'}</span>
    </div>
  );
}

const expiryText = (seconds: number | null) => {
  if (seconds === null) return '';
  if (seconds <= 0) return 'Mã đã hết hạn. Huỷ rồi thử lại.';
  if (seconds < 60) return 'Mã hết hạn sau chưa đầy 1 phút';
  return `Mã hết hạn sau ${Math.ceil(seconds / 60)} phút`;
};

function BrowserStep({ serverName, onCancel }: { serverName: string; onCancel: () => void }) {
  const progress = useRemote((s) => s.joinProgress);
  const seconds = useSecondsLeft(progress?.expiresAt ?? null);
  return (
    <div className="login-body join-body join-browser">
      <div className="join-logos" aria-hidden>
        <img src={logo} width={40} height={40} alt="" draggable={false} />
        <ArrowLeftRight size={16} className="join-logos-arrow" />
        <span className="join-logos-server">
          <Server size={20} />
        </span>
      </div>
      <div className="join-browser-text">
        <div className="join-waiting-title">Xác nhận trên trình duyệt</div>
        <div className="join-hint">
          Đăng nhập {serverName} trên trình duyệt vừa mở, kiểm tra mã này trùng với mã trên trang rồi bấm <b>Cho phép</b>.
        </div>
      </div>
      <div className="join-code" aria-live="polite" aria-label={progress?.userCode ? `Mã ${progress.userCode}` : 'Đang lấy mã'}>
        {progress?.userCode ? (
          [...progress.userCode].map((ch, i) =>
            ch === '-' ? (
              <span key={i} className="join-code-dash" aria-hidden>
                –
              </span>
            ) : (
              <span key={i} className="join-code-box nums">
                {ch}
              </span>
            ),
          )
        ) : (
          <Spinner size={20} />
        )}
      </div>
      {progress && <div className={`join-hint ${seconds === 0 ? 'is-error' : ''}`}>{expiryText(seconds)}</div>}
      <div className="login-waiting">
        <Spinner size={12} />
        <span>Đang chờ xác nhận trên trình duyệt…</span>
      </div>
      <div className="join-actions">
        {progress?.verifyUrl && (
          <button type="button" className="btn-link" onClick={() => void openExternal(progress.verifyUrl)}>
            <ExternalLink size={12} /> Mở lại trình duyệt
          </button>
        )}
        <button type="button" className="btn-link join-cancel" onClick={onCancel}>
          Huỷ
        </button>
      </div>
    </div>
  );
}

function JoinError({ text }: { text: string }) {
  return (
    <div className="callout is-danger" role="alert">
      <XCircle size={15} />
      <span>{text}</span>
    </div>
  );
}
