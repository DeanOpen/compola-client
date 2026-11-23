import { AlertTriangle } from 'lucide-react';
import appIcon from '../../assets/app-icon.png';
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

/** First launch: Compola fetches the official Zalo code it runs before the QR sign-in (Swift `RuntimeSetupView`). */
export function RuntimeSetupView({ setup }: { setup: RuntimeSetup }) {
  return (
    <BrandBackground>
      <div className="runtime-setup fade-in">
        <img src={appIcon} width={84} height={84} alt="" draggable={false} />
        <div className="setup-heading">Chuẩn bị {appName}</div>
        <p className="setup-lead">
          Lần đầu mở, {appName} tải phần lõi chính thức của Zalo PC từ máy chủ của VNG (khoảng 340 MB) và kiểm tra chữ ký số
          của VNG. Bạn không cần cài Zalo PC.
        </p>
        <div className="runtime-progress">
          {setup.failure ? (
            <div className="runtime-failure">
              <div className="runtime-failure-text">
                <AlertTriangle size={15} /> <span>{setup.failure}</span>
              </div>
              <button className="btn btn-prominent btn-large" autoFocus onClick={() => void commands.retryRuntime()}>
                Thử lại
              </button>
            </div>
          ) : (
            <Progress setup={setup} />
          )}
        </div>
      </div>
    </BrandBackground>
  );
}

function Progress({ setup }: { setup: RuntimeSetup }) {
  if (setup.step === 'downloading' && setup.total) {
    const received = setup.received ?? 0;
    return (
      <div className="runtime-bar-wrap nums">
        <progress className="runtime-bar" value={received} max={setup.total} />
        <span>
          Đang tải Zalo PC… {formatBytes(received)} / {formatBytes(setup.total)}
        </span>
      </div>
    );
  }
  const status =
    setup.step === 'looking'
      ? 'Đang chuẩn bị…'
      : setup.step === 'downloading'
        ? `Đang tải Zalo PC… ${formatBytes(setup.received ?? 0)}`
        : setup.step === 'verifying'
          ? 'Đang kiểm tra chữ ký của VNG…'
          : 'Đang cài đặt…';
  return (
    <div className="runtime-bar-wrap nums">
      <Spinner size={14} />
      <span>{status}</span>
    </div>
  );
}
