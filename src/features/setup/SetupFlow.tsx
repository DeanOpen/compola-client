// First-run setup inside the main window: sign-in (QR) → sync history from the phone → welcome (Swift `SetupFlowView`,
// `SetupCard`, `SetupSidebar`, `SetupStepper`). The sync step drives the phone → PC transfer (engine/transfer.ts).

import { Check, Clock, Minus, Phone, Plus, Search, ShieldCheck, Smartphone, Smile, Inbox, TriangleAlert, Wifi, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import logo from '../../assets/compola-logo.svg';
import illoSync from '../../assets/illo-sync.png';
import { fireAdapter } from '../../engine/call';
import { useEngine } from '../../engine/store';
import {
  dismissTransfer,
  respondToTransfer,
  stageTitle,
  startTransfer,
  transferBlockedText,
  transferCountText,
  waitingDetail,
} from '../../engine/transfer';
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
      <div className="setup-card">
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
      <span className="login-logo-row">
        <img src={logo} width={36} height={36} alt="" draggable={false} />
        <span className="login-wordmark is-small">{appName}</span>
      </span>
      <div className="setup-welcome-title">Chào mừng đến {appName}</div>
      <div className="setup-progress" aria-label={`Bước ${stage + 1} trên ${items.length}`}>
        <div className="setup-progress-row">
          <span>Thiết lập ban đầu</span>
          <span className="nums">
            {stage + 1}/{items.length}
          </span>
        </div>
        <div className="setup-progress-bar">
          <div style={{ width: `${((stage + 1) / items.length) * 100}%` }} />
        </div>
      </div>
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

/** Setup step 2 (Swift `SetupSyncStep`): intro → waiting for the phone → transferring → finished / failed, mirroring the
 * official sync state machine (`engine.transfer`) with only the numbers it reports. */
function SyncStep({ onDone }: { onDone: (outcome: SyncOutcome) => void }) {
  const canStartTransfer = useEngine((s) => s.canStartTransfer);
  const blocked = useEngine((s) => s.transferStartBlockedReason);
  const transfer = useEngine((s) => s.transfer);
  const offered = transfer?.phase === 'offer';
  const canStart = offered || canStartTransfer;

  // Ask for the current availability on mount (and every few seconds while it can't start), so the button never waits
  // on a change the UI missed.
  useEffect(() => {
    if (canStart) return;
    fireAdapter('__zaloTransfer', 'availability');
    const t = setInterval(() => fireAdapter('__zaloTransfer', 'availability'), 3000);
    return () => clearInterval(t);
  }, [canStart]);

  // Zalo may never say sync can start (its sync module not ready, or no answer at all): after a while the step stops
  // looking busy and going on without syncing becomes the main button, so the window is never stuck here.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (canStart) return;
    const t = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(t);
  }, [canStart]);

  const startSync = () => (offered ? respondToTransfer(true) : canStartTransfer ? startTransfer() : undefined);
  const later = () => {
    if (transfer?.phase === 'offer') respondToTransfer(false);
    else if (transfer?.phase === 'failed') dismissTransfer();
    onDone('skipped');
  };

  if (transfer?.phase === 'waitingForPhone') {
    return (
      <div className="setup-step fade-in">
        <img src={illoSync} width={190} alt="" draggable={false} />
        <div className="setup-heading" style={{ fontSize: 21 }}>Mở Zalo trên điện thoại để xác nhận</div>
        <p className="setup-lead">{waitingDetail(transfer)}</p>
        <div className="sync-pill">
          <Spinner size={13} /> Đang chờ xác nhận từ điện thoại…
        </div>
        <div className="setup-actions">
          <button className="btn-link" onClick={() => respondToTransfer(false)}>Huỷ</button>
          <button
            className="btn-link"
            onClick={() => {
              respondToTransfer(false);
              onDone('skipped');
            }}
          >
            Để sau, vào {appName}
          </button>
        </div>
      </div>
    );
  }

  if (transfer?.phase === 'transferring') {
    const count = transferCountText(transfer);
    return (
      <div className="setup-step fade-in">
        <img src={illoSync} width={190} alt="" draggable={false} />
        <div className="setup-heading" style={{ fontSize: 21 }}>Đang nhận tin nhắn…</div>
        <p className="setup-lead">Giữ Zalo mở trên điện thoại. {appName} sẽ mở ngay khi đồng bộ xong.</p>
        <div className="sync-progress">
          <div className={'sync-bar' + (transfer.progress == null ? ' indeterminate' : '')}>
            <div style={{ width: `${Math.round((transfer.progress ?? 0.3) * 100)}%` }} />
          </div>
          <div className="sync-progress-row">
            <span>{count}</span>
            {transfer.progress != null && <span className="sync-pct">{Math.round(transfer.progress * 100)}%</span>}
          </div>
          <div className="sync-progress-stage">
            {stageTitle(transfer)}
            {transfer.stageIndex != null && transfer.stageCount != null && ` · Bước ${transfer.stageIndex}/${transfer.stageCount}`}
          </div>
        </div>
        <div className="setup-actions">
          <button className="btn-link danger" onClick={() => respondToTransfer(false)}>Huỷ đồng bộ</button>
        </div>
      </div>
    );
  }

  if (transfer?.phase === 'finished') {
    return (
      <div className="setup-step fade-in">
        <div className="sync-result ok"><Check size={44} strokeWidth={3} /></div>
        <div className="setup-heading" style={{ fontSize: 21 }}>Đã đồng bộ xong</div>
        <p className="setup-lead">
          {transfer.syncedConversations > 0
            ? `${transfer.syncedConversations} cuộc trò chuyện từ điện thoại đã có trên máy Mac này.`
            : 'Tin nhắn từ điện thoại đã được đồng bộ sang máy Mac này.'}
        </p>
        <div className="setup-actions">
          <button className="btn btn-prominent btn-large" onClick={() => { dismissTransfer(); onDone('done'); }}>Tiếp tục</button>
        </div>
      </div>
    );
  }

  if (transfer?.phase === 'failed') {
    const retry = () => {
      if (transfer.canRetry) respondToTransfer(true);
      else if (canStartTransfer) { dismissTransfer(); startTransfer(); }
    };
    return (
      <div className="setup-step fade-in">
        <div className="sync-result fail"><TriangleAlert size={36} /></div>
        <div className="setup-heading" style={{ fontSize: 21 }}>Đồng bộ không thành công</div>
        <p className="setup-lead">{transfer.message ?? transfer.failure}</p>
        <div className="setup-actions">
          <button className="btn btn-prominent btn-large" disabled={!transfer.canRetry && !canStartTransfer} onClick={retry}>Thử lại</button>
          <button className="btn-link" onClick={later}>Để sau</button>
        </div>
      </div>
    );
  }

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
      <div className="setup-list">
        <Bullet icon={Smartphone} title="Bạn quyết định trên điện thoại" text="Chỉ bắt đầu khi bạn chọn Đồng ý trên điện thoại." />
        <Bullet icon={Clock} title="Vài phút" text="Thường mất vài phút, tuỳ số lượng tin nhắn." />
        <Bullet icon={Wifi} title="Giữ kết nối" text="Giữ Zalo mở và có mạng cho đến khi xong." />
      </div>
      {slow && !canStart ? (
        <div className="setup-actions">
          <div className="sync-blocked">
            {blocked ? transferBlockedText(blocked) : 'Zalo chưa sẵn sàng để đồng bộ lúc này.'} Bạn có thể vào {appName} ngay và đồng
            bộ sau trong Cài đặt › Sao lưu & đồng bộ.
          </div>
          <button className="btn btn-prominent btn-large" onClick={later}>
            Vào {appName}
          </button>
          <button className="btn-link" onClick={() => fireAdapter('__zaloTransfer', 'availability')}>
            Kiểm tra lại
          </button>
        </div>
      ) : (
        <div className="setup-actions">
          <button className="btn btn-prominent btn-large" disabled={!canStart} onClick={startSync}>
            {canStart ? (
              'Đồng bộ ngay'
            ) : (
              <>
                <Spinner size={13} /> Đang chuẩn bị…
              </>
            )}
          </button>
          {!canStart && blocked && <div className="sync-blocked">{transferBlockedText(blocked)}</div>}
          <button className="btn-link" onClick={later}>
            Để sau, chỉ nhận tin nhắn mới
          </button>
        </div>
      )}
    </div>
  );
}

function Bullet({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="setup-list-row">
      <span className="setup-list-icon">
        <Icon size={15} />
      </span>
      <span className="setup-list-text">
        <span className="setup-list-title">{title}</span>
        <span className="setup-list-sub">{text}</span>
      </span>
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
        <img src={logo} width={64} height={64} alt="" draggable={false} />
      )}
      <div className="setup-heading" style={{ marginTop: 12 }}>
        {appName} đã sẵn sàng
      </div>
      <p className="setup-lead">{syncSkipped ? `Bạn có thể đồng bộ tin nhắn cũ bất cứ lúc nào trong Cài đặt. ${tour}` : tour}</p>
      <ol className="setup-list tour-list">
        {tourSteps.map(({ title, icon: Icon }, i) => (
          <li key={title} className="setup-list-row is-compact">
            <span className="tour-number nums">{i + 1}</span>
            <span className="setup-list-title">{title}</span>
            <span className="setup-list-icon is-small">
              <Icon size={13} />
            </span>
          </li>
        ))}
      </ol>
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
