import { AlertTriangle, Check, Download, PackageCheck, RefreshCw, Search, ShieldCheck, X, type LucideIcon } from 'lucide-react';
import logo from '../../assets/compola-logo.svg';
import { commands } from '../../engine/backend';
import type { RuntimeSetup } from '../../engine/models/phase';
import { Spinner } from '../../ui/Spinner';
import { BrandBackground } from './BrandBackground';
import { appName } from './SplashView';

/** "12,3 MB" — Swift `ByteCountFormatter` (file style, decimal units). */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} byte`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  return `${value.toLocaleString('vi-VN', { maximumFractionDigits: value < 10 ? 1 : value < 100 ? 1 : 0 })} ${units[i]}`;
};

/** The installer's steps in order (Rust `installer::Step`). */
const steps: { key: RuntimeSetup['step']; title: string; icon: LucideIcon }[] = [
  { key: 'looking', title: 'Tìm bản Zalo PC mới nhất', icon: Search },
  { key: 'downloading', title: 'Tải phần lõi Zalo PC', icon: Download },
  { key: 'verifying', title: 'Kiểm tra chữ ký số của VNG', icon: ShieldCheck },
  { key: 'installing', title: 'Cài đặt', icon: PackageCheck },
];

/**
 * First launch: Compola fetches the official Zalo code it runs before the QR sign-in (Swift `RuntimeSetupView`).
 * Wave 4: the login card's frame with an Emergent-style checklist of the installer steps (done / running / waiting),
 * the download bar inside its own row, and the failure attached to the step that failed.
 */
export function RuntimeSetupView({ setup }: { setup: RuntimeSetup }) {
  const current = Math.max(0, steps.findIndex((s) => s.key === setup.step));
  return (
    <BrandBackground>
      <div className="login-page fade-in">
        <div className="login-brand">
          <span className="login-logo-row">
            <img src={logo} width={40} height={40} alt="" draggable={false} />
            <span className="login-wordmark">{appName}</span>
          </span>
          <div className="login-lead">Chuẩn bị {appName} cho lần đầu sử dụng</div>
        </div>
        <div className="login-card runtime-card">
          <p className="runtime-lead">
            {appName} tải phần lõi chính thức của Zalo PC từ máy chủ của VNG (khoảng 340 MB) và kiểm tra chữ ký số của VNG. Bạn
            không cần cài Zalo PC.
          </p>
          <ol className="runtime-steps">
            {steps.map((s, i) => {
              const state = i < current ? 'done' : i > current ? 'waiting' : setup.failure ? 'failed' : 'running';
              return <StepRow key={s.key} step={s} state={state} setup={setup} />;
            })}
          </ol>
          {setup.failure && (
            <div className="runtime-failure">
              <div className="callout is-danger">
                <AlertTriangle size={15} />
                <span>{setup.failure}</span>
              </div>
              <button className="btn btn-prominent" autoFocus onClick={() => void commands.retryRuntime()}>
                <RefreshCw size={14} /> Thử lại
              </button>
            </div>
          )}
        </div>
        <div className="login-footnote">Chỉ cần làm một lần. Những lần sau {appName} mở ngay.</div>
      </div>
    </BrandBackground>
  );
}

function StepRow({
  step,
  state,
  setup,
}: {
  step: (typeof steps)[number];
  state: 'done' | 'running' | 'waiting' | 'failed';
  setup: RuntimeSetup;
}) {
  const Icon = step.icon;
  const downloading = state === 'running' && step.key === 'downloading';
  const received = setup.received ?? 0;
  return (
    <li className={`runtime-step is-${state}`}>
      <span className="runtime-step-mark">
        {state === 'done' ? (
          <Check size={13} strokeWidth={3} />
        ) : state === 'running' ? (
          <Spinner size={13} />
        ) : state === 'failed' ? (
          <X size={13} strokeWidth={3} />
        ) : (
          <Icon size={13} />
        )}
      </span>
      <span className="runtime-step-body">
        <span className="runtime-step-title">
          <span>{step.title}</span>
          {downloading && setup.total ? <span className="runtime-step-pct nums">{Math.round((received / setup.total) * 100)}%</span> : null}
        </span>
        {downloading && (
          <>
            {setup.total ? <progress className="runtime-bar" value={received} max={setup.total} /> : null}
            <span className="runtime-step-detail nums">
              {setup.total ? `${formatBytes(received)} / ${formatBytes(setup.total)}` : formatBytes(received)}
            </span>
          </>
        )}
      </span>
    </li>
  );
}
