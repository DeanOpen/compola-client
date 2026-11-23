// First-run setup inside the main window: sign-in (QR) → sync history from the phone → welcome (Swift `SetupFlowView`,
// `SetupCard`, `SetupSidebar`, `SetupStepper`). The sync step drives the phone → PC transfer, a later wave: until then it
// explains and lets the user continue.

import { Check, Clock, Minus, Phone, Plus, Search, ShieldCheck, Smartphone, Smile, Inbox, Wifi, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import appIcon from '../../assets/app-icon.png';
import illoSync from '../../assets/illo-sync.png';
import { useEngine } from '../../engine/store';
import { Avatar } from '../../ui/Avatar';
import { Spinner } from '../../ui/Spinner';
import { BrandBackground } from './BrandBackground';
import { LoginView, SigningInView } from './LoginView';
import { appName } from './SplashView';

type Stage = 0 | 1 | 2; // signIn, sync, welcome
type SyncOutcome = 'done' | 'skipped' | null;

export function SetupFlow({ onFinish }: { onFinish: (startTour: boolean) => void }) {
  const phase = useEngine((s) => s.phase);
  const [afterSignIn, setAfterSignIn] = useState<1 | 2>(1);
  const [syncOutcome, setSyncOutcome] = useState<SyncOutcome>(null);
  const isLogin = phase.kind === 'login';

  // Logging out (or being signed out) mid-setup starts over at the QR code.
  useEffect(() => {
    if (isLogin) {
      setAfterSignIn(1);
      setSyncOutcome(null);
    }
  }, [isLogin]);

  const stage: Stage = phase.kind === 'ready' ? afterSignIn : 0;
  const contentKey = phase.kind === 'login' ? 'login' : phase.kind === 'ready' ? (afterSignIn === 2 ? 'welcome' : 'sync') : 'signingIn';

  // The QR sign-in is its own centred card; the setup card with its stepper follows once signed in.
  if (phase.kind === 'login') return <LoginView state={phase.login} notice={phase.notice ?? null} />;

  return (
    <BrandBackground>
      <div className="setup-card glass">
        <SetupSidebar stage={stage} syncOutcome={syncOutcome} />
        <div className="setup-content" key={contentKey}>
          {phase.kind === 'ready' ? (
            afterSignIn === 2 ? (
              <WelcomeStep syncSkipped={syncOutcome === 'skipped'} onFinish={onFinish} />
            ) : (
              <SyncStep
                onDone={(outcome) => {
                  setSyncOutcome(outcome);
                  setAfterSignIn(2);
                }}
              />
            )
          ) : (
            <SigningInView />
          )}
        </div>
      </div>
    </BrandBackground>
  );
}

function SetupSidebar({ stage, syncOutcome }: { stage: Stage; syncOutcome: SyncOutcome }) {
  const items = [
    { title: 'Đăng nhập', subtitle: 'Quét mã QR bằng Zalo' },
    { title: 'Đồng bộ tin nhắn', subtitle: syncOutcome === 'skipped' ? 'Đã để sau' : 'Từ điện thoại sang Mac' },
    { title: `Làm quen với ${appName}`, subtitle: 'Hướng dẫn nhanh, 1 phút' },
  ];
  const stateOf = (i: number) => {
    if (i === stage) return 'current';
    if (i > stage) return 'upcoming';
    return i === 1 && syncOutcome === 'skipped' ? 'skipped' : 'done';
  };
  return (
    <div className="setup-sidebar">
      <img src={appIcon} width={64} height={64} alt="" draggable={false} />
      <div className="setup-welcome-title">Chào mừng đến {appName}</div>
      <ol className="stepper">
        {items.map((item, i) => {
          const st = stateOf(i);
          return (
            <li key={i} className={`stepper-item is-${st}`}>
              <span className="stepper-dot">
                {st === 'done' ? <Check size={11} strokeWidth={3.5} /> : st === 'skipped' ? <Minus size={11} strokeWidth={3.5} /> : i + 1}
              </span>
              <span className="stepper-text">
                <span className="stepper-title">{item.title}</span>
                <span className="stepper-subtitle">{item.subtitle}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="setup-footnote">
        <ShieldCheck size={13} color="var(--success)" />
        <span>
          {appName} là ứng dụng độc lập, không liên kết với VNG hay Zalo. Ứng dụng chạy phần lõi chính thức của Zalo PC, tải trực
          tiếp từ VNG; tin nhắn đi thẳng tới máy chủ Zalo.
        </span>
      </div>
    </div>
  );
}

/** Setup step 2 (Swift `SetupSyncStep` intro). Starting the transfer arrives with the transfer wave. */
function SyncStep({ onDone }: { onDone: (outcome: SyncOutcome) => void }) {
  const canStart = useEngine((s) => s.canStartTransfer);
  return (
    <div className="setup-step fade-in">
      <img src={illoSync} width={190} alt="" draggable={false} />
      <div className="setup-heading" style={{ fontSize: 21 }}>
        Đưa lịch sử trò chuyện sang Mac
      </div>
      <p className="setup-lead">
        Máy Mac này mới chỉ có “Cloud của tôi”. Lịch sử trò chuyện nằm trên điện thoại của bạn; đồng bộ sẽ gửi yêu cầu tới
        điện thoại và chờ bạn xác nhận ở đó.
      </p>
      <div className="sync-bullets">
        <Bullet icon={Smartphone} text="Chỉ bắt đầu khi bạn chọn Đồng ý trên điện thoại." />
        <Bullet icon={Clock} text="Thường mất vài phút, tuỳ số lượng tin nhắn." />
        <Bullet icon={Wifi} text="Giữ Zalo mở và có mạng cho đến khi xong." />
      </div>
      <div className="setup-actions">
        <button className="btn btn-prominent btn-large" disabled={!canStart} onClick={() => onDone('done')}>
          {canStart ? (
            'Đồng bộ ngay'
          ) : (
            <>
              <Spinner size={13} /> Đang chuẩn bị…
            </>
          )}
        </button>
        <button className="btn-link" onClick={() => onDone('skipped')}>
          Để sau, chỉ nhận tin nhắn mới
        </button>
      </div>
    </div>
  );
}

function Bullet({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="sync-bullet">
      <Icon size={14} className="tint" />
      <span>{text}</span>
    </div>
  );
}

const tourSteps: { title: string; icon: LucideIcon }[] = [
  { title: 'Hộp thư ở thanh bên', icon: Inbox },
  { title: 'Tìm mọi thứ với ⌘K', icon: Search },
  { title: 'Rê chuột lên tin nhắn', icon: Smile },
  { title: 'Nhắn tin, sticker và bình chọn', icon: Plus },
  { title: 'Gọi điện và xem thông tin', icon: Phone },
];

/** Setup step 3 (Swift `SetupWelcomeStep`). */
function WelcomeStep({ syncSkipped, onFinish }: { syncSkipped: boolean; onFinish: (startTour: boolean) => void }) {
  const profile = useEngine((s) => s.profile);
  const tour = `Xem nhanh ${tourSteps.length} điều giúp bạn dùng ${appName} thuận tay nhất, chưa tới một phút.`;
  return (
    <div className="setup-step fade-in">
      {profile ? (
        <span className="welcome-avatar">
          <Avatar url={profile.avatar} name={profile.displayName} size={64} />
          <span className="welcome-check">
            <Check size={12} strokeWidth={3.5} />
          </span>
        </span>
      ) : (
        <img src={appIcon} width={64} height={64} alt="" draggable={false} />
      )}
      <div className="setup-heading" style={{ marginTop: 12 }}>
        {appName} đã sẵn sàng
      </div>
      <p className="setup-lead">{syncSkipped ? `Bạn có thể đồng bộ tin nhắn cũ bất cứ lúc nào trong Cài đặt. ${tour}` : tour}</p>
      <div className="tour-list">
        {tourSteps.map(({ title, icon: Icon }) => (
          <div key={title} className="tour-item">
            <span className="tour-icon">
              <Icon size={12} strokeWidth={2.4} />
            </span>
            {title}
          </div>
        ))}
      </div>
      <div className="setup-actions">
        <button className="btn btn-prominent btn-large" autoFocus onClick={() => onFinish(true)}>
          Bắt đầu hướng dẫn
        </button>
        <button className="btn-link" onClick={() => onFinish(false)}>
          Bỏ qua, vào {appName}
        </button>
      </div>
    </div>
  );
}
