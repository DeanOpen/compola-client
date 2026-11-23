// Settings (Swift `SettingsView` in SettingsWindow.swift, SettingsAppearance.swift, NotificationSettingsView.swift,
// StickerSettings.swift), laid out like Zalo PC's settings dialog: a list of sections on the left, the section's grouped
// rows on the right. Notification and sticker rows read / write the official client's own settings.

import {
  Bell,
  Check,
  Cpu,
  Lock,
  Palette,
  RefreshCw,
  Settings as SettingsIcon,
  Smile,
  UserCircle,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { backend, commands, usesMock } from '../../engine/backend';
import { callAdapter, raceTimeout } from '../../engine/call';
import { logOut } from '../../engine/lifecycle';
import { obj } from '../../engine/models/json';
import {
  activeMutes,
  muteDescription,
  notificationSettingsDidAppear,
  openSystemNotificationSettings,
  refreshNotificationAuthorization,
  requestNotificationAuthorization,
  setMessagePreview,
  setNotificationsEnabled,
  setNotificationSound,
  unmuteConversation,
  useNotifications,
} from '../../engine/notifications';
import { isHidden, useEngine, visibleConversations } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { useEscape } from '../../ui/escape';
import { Alert } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { appName } from '../setup/SplashView';
import { openTransfer } from '../transfer/hosts';
import { accents, appearances, setAppearancePref, textSizes, useAppearancePrefs } from './appearance';
import './settings.css';

export type SettingsTab = 'general' | 'appearance' | 'notifications' | 'privacy' | 'sticker' | 'account' | 'engine';

const tabs: { id: SettingsTab; title: string; icon: LucideIcon }[] = [
  { id: 'general', title: 'Cài đặt chung', icon: SettingsIcon },
  { id: 'appearance', title: 'Giao diện', icon: Palette },
  { id: 'notifications', title: 'Thông báo', icon: Bell },
  { id: 'privacy', title: 'Quyền riêng tư', icon: Lock },
  { id: 'sticker', title: 'Sticker', icon: Smile },
  { id: 'account', title: 'Tài khoản', icon: UserCircle },
  { id: 'engine', title: 'Engine', icon: Cpu },
];

export function SettingsDialog({ tab, onTab, onClose }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void }) {
  useEscape(true, onClose);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  return createPortal(
    <div className="sheet-backdrop fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-dialog pop-in" role="dialog" aria-modal aria-label="Cài đặt">
        <nav className="st-nav" aria-label="Mục cài đặt">
          <div className="st-nav-title">Cài đặt</div>
          {tabs.map((t) => (
            <button key={t.id} className={`st-nav-item ${t.id === tab ? 'is-selected' : ''}`} aria-current={t.id === tab} onClick={() => onTab(t.id)}>
              <t.icon size={16} />
              <span>{t.title}</span>
            </button>
          ))}
        </nav>
        <section className="st-pane">
          <header className="st-pane-header">
            <span>{current.title}</span>
            <button className="st-close" onClick={onClose} aria-label="Đóng" title="Đóng">
              <X size={16} />
            </button>
          </header>
          <div className="st-pane-body" key={tab}>
            {tab === 'general' && <GeneralSettings />}
            {tab === 'appearance' && <AppearanceSettings />}
            {tab === 'notifications' && <NotificationSettings />}
            {tab === 'privacy' && <PrivacySettings />}
            {tab === 'sticker' && <StickerSettings />}
            {tab === 'account' && <AccountSettings onClose={onClose} />}
            {tab === 'engine' && <EngineSettings />}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

// MARK: - Building blocks

function Section({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="st-section">
      {title && <div className="st-section-title">{title}</div>}
      <div className="st-group">{children}</div>
      {footer && <div className="st-footer">{footer}</div>}
    </div>
  );
}

function Row({ label, detail, children, column = false }: { label: ReactNode; detail?: ReactNode; children?: ReactNode; column?: boolean }) {
  return (
    <div className={`st-row ${column ? 'is-column' : ''}`}>
      <div className="st-row-text">
        <div className="st-row-label">{label}</div>
        {detail && <div className="st-row-detail">{detail}</div>}
      </div>
      {children !== undefined && <div className="st-row-control">{children}</div>}
    </div>
  );
}

function Toggle({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`st-switch ${on ? 'is-on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="st-switch-knob" />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; title: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="st-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? 'is-selected' : ''} onClick={() => onChange(o.value)}>
          {o.title}
        </button>
      ))}
    </div>
  );
}

// MARK: - Cài đặt chung

function GeneralSettings() {
  const prefs = useAppearancePrefs();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (usesMock) return setVersion('0.1.0 (mock)');
    void import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);
  return (
    <>
      <Section title="Chế độ giao diện">
        <Row label="Chế độ">
          <Segmented label="Chế độ giao diện" value={prefs.appearance} options={appearances} onChange={(v) => setAppearancePref('appearance', v)} />
        </Row>
      </Section>
      {version && (
        <Section title={`Về ${appName}`}>
          <Row label="Phiên bản">
            <span className="st-value nums">{version}</span>
          </Row>
        </Section>
      )}
    </>
  );
}

// MARK: - Giao diện

function AppearanceSettings() {
  const prefs = useAppearancePrefs();
  const scale = textSizes.find((t) => t.value === prefs.textSize)?.scale ?? 1;
  return (
    <>
      <Section footer="Dùng cho tin nhắn của bạn, nút và lựa chọn.">
        <Row label="Màu nhấn">
          <div className="st-swatches">
            {accents.map((a) => (
              <button
                key={a.value}
                className={`st-swatch ${prefs.accent === a.value ? 'is-selected' : ''}`}
                style={{ background: a.color }}
                title={a.title}
                aria-label={a.title}
                aria-pressed={prefs.accent === a.value}
                onClick={() => setAppearancePref('accent', a.value)}
              >
                {prefs.accent === a.value && <Check size={11} strokeWidth={3.5} />}
              </button>
            ))}
          </div>
        </Row>
      </Section>
      <Section title="Cỡ chữ tin nhắn">
        <Row label="Cỡ chữ" column>
          <Segmented label="Cỡ chữ" value={prefs.textSize} options={textSizes} onChange={(v) => setAppearancePref('textSize', v)} />
          <div className="st-preview" aria-hidden>
            <div className="st-bubble is-theirs" style={{ fontSize: 14 * scale }}>
              Chiều nay đi cà phê không?
            </div>
            <div className="st-bubble is-mine" style={{ fontSize: 14 * scale }}>
              Được chứ, 3 giờ nhé!
            </div>
          </div>
        </Row>
      </Section>
    </>
  );
}

// MARK: - Thông báo

function NotificationSettings() {
  const s = useNotifications();
  useEffect(() => notificationSettingsDidAppear(), []);
  // Back from System Settings ("Mở Cài đặt…"): the permission may have changed.
  useEffect(() => {
    const onFocus = () => void refreshNotificationAuthorization();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  return (
    <>
      <Section
        title="Thông báo"
        footer="Zalo quyết định khi nào báo tin mới (tắt thông báo hội thoại, nhóm hay cá nhân, đang mở ứng dụng…). Chế độ Tập trung / Không làm phiền của macOS vẫn được áp dụng."
      >
        <Row label="Thông báo tin nhắn mới" detail="Nhận được thông báo mỗi khi có tin nhắn mới">
          <Toggle label="Thông báo tin nhắn mới" on={s.enabled} disabled={!s.isLoaded} onChange={setNotificationsEnabled} />
        </Row>
        <Row label="Phát âm thanh khi có tin nhắn & thông báo mới">
          <Toggle label="Phát âm thanh khi có tin nhắn & thông báo mới" on={s.sound} disabled={!s.isLoaded || !s.enabled} onChange={setNotificationSound} />
        </Row>
        <Row label="Hiện nội dung tin nhắn" detail="Tắt để chỉ hiện “Bạn có tin nhắn mới”">
          <Toggle label="Hiện nội dung tin nhắn" on={s.showsPreview} onChange={setMessagePreview} />
        </Row>
        {s.authorization === 'notDetermined' && (
          <Row label="macOS chưa cho phép hiển thị thông báo">
            <button className="st-button" onClick={() => void requestNotificationAuthorization()}>
              Cho phép
            </button>
          </Row>
        )}
        {s.authorization === 'denied' && (
          <Row label="Thông báo đang bị tắt trong Cài đặt hệ thống">
            <button className="st-button" onClick={() => void openSystemNotificationSettings()}>
              Mở Cài đặt…
            </button>
          </Row>
        )}
        {s.authorization === 'unavailable' && <Row label={<span className="st-muted">Thông báo chỉ hoạt động khi chạy {appName}.app.</span>} />}
      </Section>
      <MutedConversations />
    </>
  );
}

/** Conversations whose notifications are off, with a way to turn them back on (hidden chats stay out). */
function MutedConversations() {
  const settings = useNotifications();
  const engine = useEngine();
  const muted = engine.conversationActions.hiddenKnown ? activeMutes(settings).filter((m) => !isHidden(engine, m.id)) : [];
  if (!muted.length) return null;
  const nameOf = (id: string) => engine.conversations.find((c) => c.id === id)?.name ?? (id.startsWith('g') ? 'Nhóm' : 'Người dùng Zalo');
  const avatarOf = (id: string) => engine.conversations.find((c) => c.id === id)?.avatar ?? null;
  return (
    <Section title="Hội thoại đã tắt thông báo">
      {muted.map((m) => (
        <div key={m.id} className="st-row">
          <Avatar url={avatarOf(m.id)} name={nameOf(m.id)} size={32} />
          <div className="st-row-text">
            <div className="st-row-label truncate">{nameOf(m.id)}</div>
            <div className="st-row-detail">{muteDescription(m.info)}</div>
          </div>
          <button className="st-button" onClick={() => unmuteConversation(m.id)}>
            Bật lại
          </button>
        </div>
      ))}
    </Section>
  );
}

// MARK: - Quyền riêng tư

function PrivacySettings() {
  const state = useEngine((s) => s.conversationActions);
  return (
    <Section title="Thiết lập ẩn trò chuyện">
      {state.loaded && state.hiddenEnabled ? (
        <Row label="Mã PIN ẩn trò chuyện" detail="Trò chuyện ẩn chỉ hiện khi nhập đúng mã PIN.">
          <span className="st-value">{state.hasHiddenPIN ? 'Đã đặt' : 'Chưa đặt'}</span>
        </Row>
      ) : (
        <Row label={<span className="st-muted">{state.loaded ? 'Tính năng ẩn trò chuyện chưa được bật cho tài khoản này.' : 'Đang tải thiết lập từ Zalo…'}</span>} />
      )}
    </Section>
  );
}

// MARK: - Sticker

/** "Gợi ý Sticker": the official `auto_sticker` flag (sticker-adapter.js `suggestSetting` / `setSuggestSetting`). */
function StickerSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const read = async (): Promise<boolean | null> => {
    const r = await raceTimeout(15, callAdapter('__zaloSticker', 'suggestSetting').catch(() => null));
    const root = obj(r?.value);
    return root && root.ok === true ? root.enabled !== false : null;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // The sticker service may not be resolved right after launch: a few tries.
      for (let attempt = 0; attempt < 4 && !cancelled; attempt += 1) {
        const v = await read();
        if (v !== null) return !cancelled && setEnabled(v);
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const r = await raceTimeout(15, callAdapter('__zaloSticker', 'setSuggestSetting', on).catch(() => null));
    const ok = obj(r?.value)?.ok === true;
    const now = ok ? await read() : null;
    if (now !== null) setEnabled(now);
    setBusy(false);
    if (now !== on) setFailed(true);
  };

  return (
    <Section title="Gợi ý Sticker" footer={failed ? <span className="st-warning">Không thể đổi cài đặt này lúc này. Hãy thử lại sau.</span> : undefined}>
      <Row label="Hiện gợi ý Sticker phù hợp với nội dung tin nhắn đang soạn">
        <Toggle label="Gợi ý Sticker" on={enabled ?? true} disabled={enabled === null || busy} onChange={(on) => void change(on)} />
      </Row>
    </Section>
  );
}

// MARK: - Tài khoản

function AccountSettings({ onClose }: { onClose: () => void }) {
  const profile = useEngine((s) => s.profile);
  const canStartTransfer = useEngine((s) => s.canStartTransfer);
  return (
    <>
      <Section>
        <div className="st-profile">
          <Avatar url={profile?.avatar} name={profile?.displayName ?? '?'} size={52} />
          <div>
            <div className="st-profile-name">{profile?.displayName ?? 'Chưa đăng nhập'}</div>
            <div className="st-row-detail">{profile?.phone || 'Tài khoản Zalo'}</div>
          </div>
        </div>
      </Section>
      <Section title="Sao lưu & đồng bộ">
        <Row label="Đồng bộ tin nhắn từ điện thoại">
          <button
            className="st-button is-primary"
            disabled={!canStartTransfer}
            onClick={() => {
              onClose();
              openTransfer();
            }}
          >
            Đồng bộ ngay
          </button>
        </Row>
      </Section>
      <Section>
        <button
          className="st-row st-destructive"
          disabled={!profile}
          onClick={() => {
            onClose();
            void logOut();
          }}
        >
          Đăng xuất
        </button>
      </Section>
    </>
  );
}

// MARK: - Engine

interface EngineInfo {
  runtimeVersion: string | null;
  storage: string | null;
  recentLog: string[];
}

function EngineSettings() {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [confirmSqlite, setConfirmSqlite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversations = useEngine((s) => (s.conversationActions.hiddenKnown ? String(visibleConversations(s).length) : '—'));
  const logBox = useRef<HTMLPreElement>(null);

  const load = () =>
    commands
      .info()
      .then((i) => setInfo({ runtimeVersion: i.runtimeVersion, storage: i.storage, recentLog: i.recentLog ?? [] }))
      .catch((e) => setError(String(e)));

  useEffect(() => {
    void load();
    // New renderer log lines while the tab is open.
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void backend()
      .then((b) => b.listen('compola://log', (line) => setInfo((i) => (i ? { ...i, recentLog: [...i.recentLog, String(line)].slice(-400) } : i))))
      .then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const el = logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [info?.recentLog.length]);

  return (
    <>
      <Section title="Engine">
        <Row label="Giao thức">
          <span className="st-value">Zalo PC {info?.runtimeVersion ?? '—'} (mã chính thức)</span>
        </Row>
        <Row label="Hội thoại">
          <span className="st-value nums">{conversations}</span>
        </Row>
        <Row label="Lưu trữ">
          <span className="st-value">{info?.storage === 'sqlite' ? 'SQLite (gốc)' : info?.storage === 'idb' ? 'IndexedDB (WebKit)' : '—'}</span>
        </Row>
        {info?.storage === 'idb' && (
          <Row label="Chuyển sang SQLite" detail="SQLite nhanh hơn nhiều với tài khoản có nhiều tin nhắn.">
            <button className="st-button" onClick={() => setConfirmSqlite(true)}>
              Chuyển sang SQLite…
            </button>
          </Row>
        )}
        <Row label="Renderer chính thức" detail="Mở cửa sổ của trình kết xuất Zalo PC đang chạy ẩn (gỡ lỗi).">
          <button className="st-button" onClick={() => void commands.showRenderer().catch((e) => setError(String(e)))}>
            Hiện renderer
          </button>
        </Row>
      </Section>
      <Section title="Nhật ký gần đây">
        <div className="st-log-wrap">
          <button className="st-log-refresh" onClick={() => void load()} title="Làm mới" aria-label="Làm mới">
            <RefreshCw size={13} />
          </button>
          {info === null ? (
            <div className="st-log-empty">
              <Spinner size={14} />
            </div>
          ) : (
            <pre ref={logBox} className="st-log selectable">
              {info.recentLog.length ? info.recentLog.join('\n') : 'Chưa có nhật ký.'}
            </pre>
          )}
        </div>
        {error && <div className="st-footer st-warning">{error}</div>}
      </Section>
      {confirmSqlite && (
        <Alert
          title="Chuyển sang SQLite?"
          message="Tin nhắn đã lưu trên máy sẽ không được chuyển: sau khi đăng nhập lại, hãy đồng bộ tin nhắn từ điện thoại. SQLite nhanh hơn nhiều với tài khoản có nhiều tin nhắn."
          buttons={[
            {
              label: 'Đăng xuất và chuyển',
              role: 'destructive',
              onClick: () => {
                setConfirmSqlite(false);
                void commands.switchToSqlite();
              },
            },
            { label: 'Hủy', role: 'cancel', onClick: () => setConfirmSqlite(false) },
          ]}
        />
      )}
    </>
  );
}
