// Settings (Swift `SettingsView` in SettingsWindow.swift, SettingsAppearance.swift, NotificationSettingsView.swift,
// StickerSettings.swift), laid out like Zalo PC's settings dialog: a list of sections on the left, the section's grouped
// rows on the right. Notification and sticker rows read / write the official client's own settings.

import { setConversationPrompt } from '../../engine/conversationActions';
import { setStickerSuggest } from '../../engine/stickers';
import {
  Bell,
  CalendarClock,
  Puzzle,
  Server,
  BellOff,
  BellRing,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Cpu,
  Info,
  Lock,
  LogOut,
  Monitor,
  Network,
  Moon,
  Palette,
  RefreshCw,
  Search,
  TextSearch,
  Settings as SettingsIcon,
  Smartphone,
  Smile,
  Sun,
  UserCircle,
  X,
  type LucideIcon,
} from 'lucide-react';
import logo from '../../assets/compola-logo.svg';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { backend, commands, usesTauri, usesWeb } from '../../engine/backend';
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
import { accents, appearances, setAppearancePref, textSizes, useAppearancePrefs, type Appearance } from './appearance';
import { transferBlockedText } from '../../engine/transfer';
import { AddonSettings, McpSettings, ScheduleSettings } from './AutomationSettings';
import { SearchSettings } from './SearchSettings';
import { adminOnlyHint, deviceTitle, leaveCopy, useHostSettingsLocked, useRemote, userTitle } from '../../engine/remote';
import { LeaveServerAlert } from '../remote/RemoteGate';
import { ServerSettings } from '../remote/ServerSettings';
import './settings.css';
import './automation.css';

export type SettingsTab = 'general' | 'appearance' | 'notifications' | 'privacy' | 'sticker' | 'account' | 'mcp' | 'schedules' | 'addons' | 'search' | 'engine' | 'server';

interface TabInfo {
  id: SettingsTab;
  title: string;
  icon: LucideIcon;
  /** Subtitle of the pane header (Slack / Replit: what this section is about). */
  subtitle: string;
  /** Extra words the nav search matches (the rows of the section). */
  keywords: string;
}

const tabs: TabInfo[] = [
  { id: 'general', title: 'Cài đặt chung', icon: SettingsIcon, subtitle: 'Chế độ sáng / tối và thông tin ứng dụng.', keywords: 'sáng tối hệ thống phiên bản về' },
  { id: 'appearance', title: 'Giao diện', icon: Palette, subtitle: 'Chủ đề, màu nhấn và cỡ chữ tin nhắn.', keywords: 'chủ đề màu nhấn cỡ chữ sáng tối' },
  { id: 'notifications', title: 'Thông báo', icon: Bell, subtitle: 'Chọn cách Compola báo tin nhắn mới.', keywords: 'âm thanh nội dung xem trước tắt thông báo macos' },
  { id: 'privacy', title: 'Quyền riêng tư', icon: Lock, subtitle: 'Trò chuyện ẩn và mã PIN.', keywords: 'ẩn trò chuyện pin' },
  { id: 'sticker', title: 'Sticker', icon: Smile, subtitle: 'Gợi ý sticker khi soạn tin nhắn.', keywords: 'gợi ý sticker' },
  { id: 'account', title: 'Tài khoản', icon: UserCircle, subtitle: 'Tài khoản Zalo, đồng bộ và đăng xuất.', keywords: 'đồng bộ điện thoại đăng xuất sao lưu' },
  { id: 'mcp', title: 'MCP', icon: Server, subtitle: 'Máy chủ MCP cho ứng dụng AI và kết nối tới máy chủ MCP khác.', keywords: 'mcp ai claude cursor máy chủ server token công cụ tools openmcp' },
  { id: 'schedules', title: 'Lịch tự động', icon: CalendarClock, subtitle: 'Hẹn giờ gửi tin nhắn và chạy công cụ theo lịch cron.', keywords: 'cron lịch hẹn giờ tự động gửi tin nhắn định kỳ schedule' },
  { id: 'search', title: 'Tìm kiếm', icon: TextSearch, subtitle: 'Tìm tin nhắn không phân biệt dấu và theo ý nghĩa (RAG).', keywords: 'tìm kiếm search rag embeddings ollama ý nghĩa chỉ mục index' },
  { id: 'addons', title: 'Add-on', icon: Puzzle, subtitle: 'Mở rộng Compola bằng các tiện ích JavaScript.', keywords: 'add-on addon plugin tiện ích mở rộng trả lời tự động từ khoá tóm tắt' },
  {
    id: 'server',
    title: 'Compola Server',
    icon: Network,
    subtitle: 'Chia sẻ tài khoản Zalo này cho cả nhóm qua mạng.',
    keywords: 'compola server máy chủ chia sẻ nhóm nhân viên quản trị ldap sso đăng nhập lan tailscale thiết bị',
  },
  { id: 'engine', title: 'Engine', icon: Cpu, subtitle: 'Mã Zalo PC chính thức chạy ẩn bên dưới Compola.', keywords: 'sqlite indexeddb renderer nhật ký log lưu trữ' },
];

/** Nav groups (Todoist / Replit: labelled groups instead of one long list). */
const navGroups: { title: string; ids: SettingsTab[] }[] = [
  { title: 'Ứng dụng', ids: ['general', 'appearance', 'notifications', 'privacy', 'sticker'] },
  { title: 'Tài khoản', ids: ['account'] },
  { title: 'Nâng cao', ids: ['server', 'search', 'mcp', 'schedules', 'addons', 'engine'] },
];

/** Sections that act on this machine's own engine: hidden while joined to a Compola Server (the host refuses them). */
const localOnlyTabs: SettingsTab[] = ['mcp', 'schedules', 'addons', 'search', 'engine'];

const fold = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');

export function SettingsDialog({ tab: requested, onTab, onClose }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void }) {
  useEscape(true, onClose);
  const [query, setQuery] = useState('');
  const profile = useEngine((s) => s.profile);
  const joined = useRemote((s) => s.mode === 'joined');
  const available = joined ? tabs.filter((t) => !localOnlyTabs.includes(t.id)) : tabs;
  const current = available.find((t) => t.id === requested) ?? available[0];
  const tab = current.id;
  const q = fold(query.trim());
  const matches = (t: TabInfo) => available.includes(t) && (!q || fold(`${t.title} ${t.keywords}`).includes(q));
  const visible = tabs.filter(matches);
  return createPortal(
    <div className="sheet-backdrop fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-dialog pop-in" role="dialog" aria-modal aria-label="Cài đặt">
        <nav className="st-nav" aria-label="Mục cài đặt">
          <div className="st-nav-title">Cài đặt</div>
          <button className={`st-nav-account ${tab === 'account' ? 'is-selected' : ''}`} onClick={() => onTab('account')} title="Tài khoản">
            <Avatar url={profile?.avatar} name={profile?.displayName ?? '?'} size={34} />
            <span className="st-nav-account-text">
              <span className="truncate">{profile?.displayName ?? 'Chưa đăng nhập'}</span>
              <span className="st-nav-account-sub truncate">{profile?.phone || 'Tài khoản Zalo'}</span>
            </span>
          </button>
          <label className="st-nav-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && visible[0]) onTab(visible[0].id);
              }}
              placeholder="Tìm cài đặt"
              aria-label="Tìm cài đặt"
              spellCheck={false}
            />
          </label>
          <div className="st-nav-list">
            {navGroups.map((g) => {
              const items = g.ids.map((id) => tabs.find((t) => t.id === id)!).filter(matches);
              if (!items.length) return null;
              return (
                <div key={g.title} className="st-nav-group">
                  <div className="st-nav-heading">{g.title}</div>
                  {items.map((t) => (
                    <button key={t.id} className={`st-nav-item ${t.id === tab ? 'is-selected' : ''}`} aria-current={t.id === tab} onClick={() => onTab(t.id)}>
                      <t.icon size={16} />
                      <span>{t.title}</span>
                    </button>
                  ))}
                </div>
              );
            })}
            {!visible.length && <div className="st-nav-empty">Không tìm thấy cài đặt phù hợp</div>}
          </div>
        </nav>
        <section className="st-pane">
          <header className="st-pane-header">
            <span className="st-pane-titles">
              <span className="st-pane-title">{current.title}</span>
              <span className="st-pane-subtitle">{current.subtitle}</span>
            </span>
            <button className="st-close" onClick={onClose} aria-label="Đóng" title="Đóng">
              <X size={16} />
            </button>
          </header>
          <div className="st-pane-body" key={tab}>
            {tab === 'general' && <GeneralSettings onTab={onTab} />}
            {tab === 'appearance' && <AppearanceSettings />}
            {tab === 'notifications' && <NotificationSettings />}
            {tab === 'privacy' && <PrivacySettings />}
            {tab === 'sticker' && <StickerSettings />}
            {tab === 'account' && <AccountSettings onClose={onClose} />}
            {tab === 'mcp' && <McpSettings />}
            {tab === 'schedules' && <ScheduleSettings />}
            {tab === 'addons' && <AddonSettings />}
            {tab === 'search' && <SearchSettings />}
            {tab === 'engine' && <EngineSettings />}
            {tab === 'server' && <ServerSettings />}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

// MARK: - Building blocks

export function Section({ title, description, footer, children, tone }: { title?: ReactNode; description?: ReactNode; footer?: ReactNode; children: ReactNode; tone?: 'danger' }) {
  return (
    <div className={`st-section ${tone === 'danger' ? 'is-danger' : ''}`}>
      {title && <div className="st-section-title">{title}</div>}
      {description && <div className="st-section-desc">{description}</div>}
      <div className="st-group">{children}</div>
      {footer && <div className="st-footer">{footer}</div>}
    </div>
  );
}

export function Row({ label, detail, children, column = false }: { label: ReactNode; detail?: ReactNode; children?: ReactNode; column?: boolean }) {
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

/** A coloured notice row at the top of a section (hilos: "Your browser has not allowed these yet"). */
function Callout({ tone, icon: Icon, title, detail, action }: { tone: 'info' | 'warning'; icon: LucideIcon; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className={`st-callout is-${tone}`} role="status">
      <Icon size={18} className="st-callout-icon" />
      <div className="st-row-text">
        <div className="st-callout-title">{title}</div>
        {detail && <div className="st-row-detail">{detail}</div>}
      </div>
      {action}
    </div>
  );
}

/** Joined to a Compola Server without the admin role: the account's settings are the host admins'. */
function HostSettingsNote() {
  return <Callout tone="info" icon={Lock} title={adminOnlyHint} detail="Cài đặt này áp dụng cho tài khoản Zalo trên máy chủ, cho mọi người dùng chung." />;
}

export function Toggle({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`st-switch ${on ? 'is-on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="st-switch-knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  icons,
}: {
  value: T;
  options: { value: T; title: string }[];
  onChange: (v: T) => void;
  label: string;
  icons?: Partial<Record<T, LucideIcon>>;
}) {
  return (
    <div className="st-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const Icon: LucideIcon | undefined = icons?.[o.value];
        return (
          <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? 'is-selected' : ''} onClick={() => onChange(o.value)}>
            {Icon && <Icon size={13} />}
            {o.title}
          </button>
        );
      })}
    </div>
  );
}

const appearanceIcons: Record<Appearance, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

// MARK: - Cài đặt chung

function GeneralSettings({ onTab }: { onTab: (t: SettingsTab) => void }) {
  const prefs = useAppearancePrefs();
  const [version, setVersion] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<string | null>(null);
  useEffect(() => {
    void commands
      .info()
      .then((i) => setRuntime(i.runtimeVersion))
      .catch(() => {});
    if (!usesTauri) return setVersion(usesWeb ? 'Bản web' : '0.1.0 (mock)');
    void import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);
  return (
    <>
      <Section title="Chế độ giao diện">
        <Row label="Chế độ" detail="Theo hệ thống dùng cài đặt Sáng / Tối của macOS.">
          <Segmented label="Chế độ giao diện" value={prefs.appearance} options={appearances} icons={appearanceIcons} onChange={(v) => setAppearancePref('appearance', v)} />
        </Row>
        <button className="st-row st-link-row" onClick={() => onTab('appearance')}>
          <span className="st-row-text">
            <span className="st-row-label">Màu nhấn và cỡ chữ</span>
          </span>
          <ChevronRight size={16} className="st-chevron" />
        </button>
      </Section>
      <Section title={`Về ${appName}`}>
        <div className="st-about">
          <img src={logo} width={44} height={44} alt="" draggable={false} />
          <div className="st-row-text">
            <div className="st-about-name">{appName}</div>
            <div className="st-row-detail">Ứng dụng Zalo cho macOS, chạy mã Zalo PC chính thức.</div>
          </div>
        </div>
        <Row label="Phiên bản">
          <span className="st-value nums">{version ?? '—'}</span>
        </Row>
        <Row label="Zalo PC">
          <span className="st-value nums">{runtime ?? '—'}</span>
        </Row>
      </Section>
    </>
  );
}

// MARK: - Giao diện

function AppearanceSettings() {
  const prefs = useAppearancePrefs();
  const scale = textSizes.find((t) => t.value === prefs.textSize)?.scale ?? 1;
  return (
    <>
      <Section title="Chủ đề">
        <div className="st-themes" role="radiogroup" aria-label="Chủ đề">
          {appearances.map((a) => (
            <button
              key={a.value}
              role="radio"
              aria-checked={prefs.appearance === a.value}
              className={`st-theme ${prefs.appearance === a.value ? 'is-selected' : ''}`}
              onClick={() => setAppearancePref('appearance', a.value)}
            >
              <ThemeThumb kind={a.value} />
              <span className="st-theme-label">
                {prefs.appearance === a.value ? <CheckCircle2 size={14} className="st-theme-check" /> : <span className="st-theme-dot" />}
                {a.title}
              </span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Màu nhấn" description="Dùng cho tin nhắn của bạn, nút và lựa chọn.">
        <Row label={accents.find((a) => a.value === prefs.accent)?.title ?? 'Màu nhấn'}>
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
          <div className="st-preview-label">Xem trước</div>
          <div className="st-preview" aria-hidden>
            <div className="st-bubble is-theirs" style={{ fontSize: 14 * scale }}>
              Chiều nay đi cà phê không?
              <span className="st-bubble-time">14:02</span>
            </div>
            <div className="st-bubble is-mine" style={{ fontSize: 14 * scale }}>
              Được chứ, 3 giờ nhé!
              <span className="st-bubble-time">14:03</span>
            </div>
          </div>
        </Row>
      </Section>
    </>
  );
}

/** A miniature window (rail, list, chat) in the theme's colours; "system" is split light / dark. */
function ThemeThumb({ kind }: { kind: Appearance }) {
  const pane = (mode: 'light' | 'dark') => (
    <span className={`st-thumb-pane is-${mode}`}>
      <span className="st-thumb-rail" />
      <span className="st-thumb-list">
        <span />
        <span />
        <span />
      </span>
      <span className="st-thumb-chat">
        <span className="st-thumb-bubble" />
        <span className="st-thumb-bubble is-mine" />
      </span>
    </span>
  );
  return (
    <span className={`st-thumb ${kind === 'system' ? 'is-split' : ''}`} aria-hidden>
      {kind === 'dark' ? pane('dark') : pane('light')}
      {kind === 'system' && pane('dark')}
    </span>
  );
}

// MARK: - Thông báo

function NotificationSettings() {
  const s = useNotifications();
  const locked = useHostSettingsLocked();
  useEffect(() => notificationSettingsDidAppear(), []);
  // Back from System Settings ("Mở Cài đặt…"): the permission may have changed.
  useEffect(() => {
    const onFocus = () => void refreshNotificationAuthorization();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  return (
    <>
      {s.authorization === 'notDetermined' && (
        <Callout
          tone="info"
          icon={BellRing}
          title="macOS chưa cho phép hiển thị thông báo"
          detail="Cho phép để nhận thông báo khi Compola chạy nền."
          action={
            <button className="st-button is-primary" onClick={() => void requestNotificationAuthorization()}>
              Cho phép
            </button>
          }
        />
      )}
      {s.authorization === 'denied' && (
        <Callout
          tone="warning"
          icon={BellOff}
          title="Thông báo đang bị tắt trong Cài đặt hệ thống"
          detail="Bật lại Compola trong Cài đặt hệ thống ▸ Thông báo."
          action={
            <button className="st-button" onClick={() => void openSystemNotificationSettings()}>
              Mở Cài đặt…
            </button>
          }
        />
      )}
      {s.authorization === 'unavailable' && <Callout tone="info" icon={Info} title={`Thông báo chỉ hoạt động khi chạy ${appName}.app.`} />}
      {locked && <HostSettingsNote />}
      <Section
        title="Tin nhắn"
        footer="Zalo quyết định khi nào báo tin mới (tắt thông báo hội thoại, nhóm hay cá nhân, đang mở ứng dụng…). Chế độ Tập trung / Không làm phiền của macOS vẫn được áp dụng."
      >
        <Row label="Thông báo tin nhắn mới" detail="Nhận được thông báo mỗi khi có tin nhắn mới">
          <Toggle label="Thông báo tin nhắn mới" on={s.enabled} disabled={!s.isLoaded || locked} onChange={setNotificationsEnabled} />
        </Row>
        <Row label="Phát âm thanh khi có tin nhắn & thông báo mới" detail={s.enabled ? undefined : 'Bật thông báo tin nhắn mới để dùng tuỳ chọn này'}>
          <Toggle label="Phát âm thanh khi có tin nhắn & thông báo mới" on={s.sound} disabled={!s.isLoaded || !s.enabled || locked} onChange={setNotificationSound} />
        </Row>
        <Row label="Hiện nội dung tin nhắn" detail="Tắt để chỉ hiện “Bạn có tin nhắn mới”">
          <Toggle label="Hiện nội dung tin nhắn" on={s.showsPreview} onChange={setMessagePreview} />
        </Row>
        <div className="st-notif-preview" aria-hidden>
          <img src={logo} width={28} height={28} alt="" draggable={false} />
          <span className="st-row-text">
            <span className="st-notif-head">
              <span className="st-notif-app">{appName}</span>
              <span className="st-notif-time">bây giờ</span>
            </span>
            <span className="st-notif-title">{s.showsPreview ? 'Trần Thị Lan' : appName}</span>
            <span className="st-notif-body">{s.showsPreview ? 'Mai đi ăn trưa nhé 🍜' : 'Bạn có tin nhắn mới'}</span>
          </span>
        </div>
      </Section>
      <MutedConversations locked={locked} />
    </>
  );
}

/** Conversations whose notifications are off, with a way to turn them back on (hidden chats stay out). */
function MutedConversations({ locked }: { locked: boolean }) {
  const settings = useNotifications();
  const engine = useEngine();
  const muted = engine.conversationActions.hiddenKnown ? activeMutes(settings).filter((m) => !isHidden(engine, m.id)) : [];
  if (!muted.length) return null;
  const nameOf = (id: string) => engine.conversations.find((c) => c.id === id)?.name ?? (id.startsWith('g') ? 'Nhóm' : 'Người dùng Zalo');
  const avatarOf = (id: string) => engine.conversations.find((c) => c.id === id)?.avatar ?? null;
  return (
    <Section title={`Hội thoại đã tắt thông báo (${muted.length})`}>
      {muted.map((m) => (
        <div key={m.id} className="st-row">
          <Avatar url={avatarOf(m.id)} name={nameOf(m.id)} size={32} />
          <div className="st-row-text">
            <div className="st-row-label truncate">{nameOf(m.id)}</div>
            <div className="st-row-detail">{muteDescription(m.info)}</div>
          </div>
          <button className="st-button" disabled={locked} title={locked ? adminOnlyHint : undefined} onClick={() => unmuteConversation(m.id)}>
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
  const locked = useHostSettingsLocked();
  return (
    <>
      {locked && <HostSettingsNote />}
      <Section title="Thiết lập ẩn trò chuyện">
        {state.loaded && state.hiddenEnabled ? (
          // Swift `HiddenChatSettingsSection`: set the PIN, or change / reset it (the flows run in ConversationPrompts).
          state.hasHiddenPIN ? (
            <>
              <Row label="Đổi mã PIN" detail="Đổi mã PIN cho trò chuyện ẩn">
                <button className="btn btn-glass btn-small" disabled={locked} onClick={() => setConversationPrompt({ kind: 'pinSettings', flow: 'changePIN' })}>
                  Đổi mã PIN
                </button>
              </Row>
              <Row label="Đặt lại mã PIN" detail="Tất cả trò chuyện đang ẩn sẽ bị xóa và không thể khôi phục">
                <button className="btn btn-glass btn-small btn-danger" disabled={locked} onClick={() => setConversationPrompt({ kind: 'pinSettings', flow: 'resetPIN' })}>
                  Đặt lại mã PIN
                </button>
              </Row>
            </>
          ) : (
            <Row label="Ẩn trò chuyện" detail="Đặt mã PIN cho các cuộc trò chuyện riêng tư để tránh người khác nhìn thấy trên máy của bạn">
              <button className="btn btn-prominent btn-small" disabled={locked} onClick={() => setConversationPrompt({ kind: 'pinSettings', flow: 'setPIN' })}>
                Cài đặt mã PIN
              </button>
            </Row>
          )
        ) : (
          <Row label={<span className="st-muted">{state.loaded ? 'Tính năng ẩn trò chuyện chưa được bật cho tài khoản này.' : 'Đang tải thiết lập từ Zalo…'}</span>} />
        )}
      </Section>
    </>
  );
}

// MARK: - Sticker

/** "Gợi ý Sticker": the official `auto_sticker` flag (sticker-adapter.js `suggestSetting` / `setSuggestSetting`). */
function StickerSettings() {
  const locked = useHostSettingsLocked();
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
    // Through the shared state (engine/stickers.ts), so open composers follow the change at once.
    const now = (await setStickerSuggest(on))?.enabled ?? null;
    if (now !== null) setEnabled(now);
    setBusy(false);
    if (now !== on) setFailed(true);
  };

  return (
    <>
      {locked && <HostSettingsNote />}
      <Section title="Gợi ý Sticker" footer={failed ? <span className="st-warning">Không thể đổi cài đặt này lúc này. Hãy thử lại sau.</span> : undefined}>
        <Row label="Hiện gợi ý Sticker phù hợp với nội dung tin nhắn đang soạn">
          <Toggle label="Gợi ý Sticker" on={enabled ?? true} disabled={enabled === null || busy || locked} onChange={(on) => void change(on)} />
        </Row>
      </Section>
    </>
  );
}

// MARK: - Tài khoản

function AccountSettings({ onClose }: { onClose: () => void }) {
  const profile = useEngine((s) => s.profile);
  const canStartTransfer = useEngine((s) => s.canStartTransfer);
  const blocked = useEngine((s) => s.transferStartBlockedReason);
  const [confirmLogout, setConfirmLogout] = useState(false);
  // Joined to a Compola Server: the account is signed in on the host; this machine can only leave the server.
  const joined = useRemote((s) => s.mode === 'joined');
  const serverName = useRemote((s) => s.connection?.serverName);
  const remoteUser = useRemote((s) => s.connection?.user ?? null);
  const device = useRemote((s) => (s.connection ? deviceTitle(s.connection.deviceName, s.connection.deviceId) : ''));
  return (
    <>
      <div className="st-profile-card">
        <div className="st-profile-cover" />
        <div className="st-profile">
          <Avatar url={profile?.avatar} name={profile?.displayName ?? '?'} size={64} className="st-profile-avatar" />
          <div className="st-row-text">
            <div className="st-profile-name">{profile?.displayName ?? 'Chưa đăng nhập'}</div>
            <div className="st-row-detail">{profile?.phone || 'Tài khoản Zalo'}</div>
          </div>
          <span className="st-status">
            <span className="st-status-dot" /> Đã kết nối
          </span>
        </div>
      </div>
      {!joined && (
        <Section title="Sao lưu & đồng bộ">
          <div className="st-row">
            <span className="st-icon-tile">
              <Smartphone size={18} />
            </span>
            <div className="st-row-text">
              <div className="st-row-label">Đồng bộ tin nhắn từ điện thoại</div>
              <div className="st-row-detail">
                {canStartTransfer ? 'Đưa lịch sử trò chuyện từ điện thoại sang máy Mac này.' : blocked ? transferBlockedText(blocked) : 'Đang chuẩn bị…'}
              </div>
            </div>
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
          </div>
        </Section>
      )}
      {joined ? (
        <>
          <Section title="Compola Server">
            <Row label="Đăng nhập với tư cách">
              <span className="st-value">{userTitle(remoteUser)}</span>
            </Row>
            <Row label="Thiết bị">
              <span className="st-value">{device}</span>
            </Row>
          </Section>
          <Section title={leaveCopy.action} tone="danger">
            <div className="st-row">
              <div className="st-row-text">
                <div className="st-row-label">{leaveCopy.row}</div>
                <div className="st-row-detail">{leaveCopy.detail(serverName || 'máy chủ')}</div>
              </div>
              <button className="st-button is-danger" onClick={() => setConfirmLogout(true)}>
                <LogOut size={14} /> {leaveCopy.action}
              </button>
            </div>
          </Section>
        </>
      ) : (
        <Section title="Đăng xuất" tone="danger">
          <div className="st-row">
            <div className="st-row-text">
              <div className="st-row-label">Đăng xuất khỏi {appName}</div>
              <div className="st-row-detail">Dữ liệu trên máy này được xoá; lần sau cần quét mã QR để đăng nhập lại.</div>
            </div>
            <button className="st-button is-danger" disabled={!profile} onClick={() => setConfirmLogout(true)}>
              <LogOut size={14} /> Đăng xuất
            </button>
          </div>
        </Section>
      )}
      {confirmLogout && joined && <LeaveServerAlert serverName={serverName} onClose={() => setConfirmLogout(false)} />}
      {confirmLogout && !joined && (
        <Alert
          title="Đăng xuất?"
          message="Bạn sẽ cần quét mã QR bằng Zalo trên điện thoại để đăng nhập lại."
          buttons={[
            {
              label: 'Đăng xuất',
              role: 'destructive',
              onClick: () => {
                setConfirmLogout(false);
                onClose();
                void logOut();
              },
            },
            { label: 'Hủy', role: 'cancel', onClick: () => setConfirmLogout(false) },
          ]}
        />
      )}
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
  const [copied, setCopied] = useState(false);

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

  const copyLog = () => {
    if (!info) return;
    void navigator.clipboard.writeText(info.recentLog.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <>
      <div className="st-stats">
        <Stat label="Zalo PC" value={info?.runtimeVersion ?? '—'} detail="Mã chính thức" />
        <Stat label="Hội thoại" value={conversations} detail="Đang hiển thị" />
        <Stat
          label="Lưu trữ"
          value={info?.storage === 'sqlite' ? 'SQLite' : info?.storage === 'idb' ? 'IndexedDB' : '—'}
          detail={info?.storage === 'sqlite' ? 'Gốc' : info?.storage === 'idb' ? 'WebKit' : ''}
        />
      </div>
      <Section title="Gỡ lỗi">
        <Row label="Renderer chính thức" detail="Mở cửa sổ của trình kết xuất Zalo PC đang chạy ẩn (gỡ lỗi).">
          <button className="st-button" onClick={() => void commands.showRenderer().catch((e) => setError(String(e)))}>
            Hiện renderer
          </button>
        </Row>
      </Section>
      <Section title="Nhật ký gần đây">
        <div className="st-log-wrap">
          <div className="st-log-bar">
            <span className="st-log-count nums">{info ? `${info.recentLog.length} dòng` : ''}</span>
            <button className="st-log-action" onClick={copyLog} disabled={!info?.recentLog.length} title="Sao chép nhật ký">
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Đã chép' : 'Sao chép'}
            </button>
            <button className="st-log-action" onClick={() => void load()} title="Làm mới" aria-label="Làm mới">
              <RefreshCw size={13} /> Làm mới
            </button>
          </div>
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
      {info?.storage === 'idb' && (
        <Section title="Chuyển sang SQLite" tone="danger">
          <div className="st-row">
            <div className="st-row-text">
              <div className="st-row-label">Dùng SQLite thay cho IndexedDB</div>
              <div className="st-row-detail">Nhanh hơn nhiều với tài khoản có nhiều tin nhắn. Cần đăng xuất, đăng nhập lại và đồng bộ lại tin nhắn từ điện thoại.</div>
            </div>
            <button className="st-button is-danger" onClick={() => setConfirmSqlite(true)}>
              Chuyển sang SQLite…
            </button>
          </div>
        </Section>
      )}
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

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="st-stat">
      <div className="st-stat-label">{label}</div>
      <div className="st-stat-value nums truncate">{value}</div>
      {detail && <div className="st-stat-detail">{detail}</div>}
    </div>
  );
}
