// Phone → PC message transfer over the main window (Swift `TransferOverlay` / `TransferCard`), as a Zalo PC dialog:
// title bar "Đồng bộ tin nhắn" with ×, the state in the body, the actions bottom-right. The flow itself (offer, phone
// confirmation, progress, result) is the official client's (`engine/transfer.ts`); this only renders it. Modal: the
// window behind is covered while it is up.

import { Check, Clock, Info, Smartphone, Wifi, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useEngine } from '../../engine/store';
import { dismissTransfer, respondToTransfer, stageTitle, transferCountText, waitingDetail, type MessageTransferState } from '../../engine/transfer';
import { Spinner } from '../../ui/Spinner';
import { ZaloDialog } from '../calls/ZaloDialog';
import { FailedMark, FinishedMark, TransferRoute } from './TransferParts';
import './transfer.css';

export function TransferOverlay() {
  const transfer = useEngine((s) => s.transfer);
  if (!transfer) return null;
  return <TransferDialog state={transfer} />;
}

function TransferDialog({ state }: { state: MessageTransferState }) {
  const kind = state.phase;
  // "Hoàn tất" closes itself after a few seconds.
  useEffect(() => {
    if (kind !== 'finished') return;
    const t = setTimeout(dismissTransfer, 4000);
    return () => clearTimeout(t);
  }, [kind]);
  // × / Esc = "Để sau" on the offer, otherwise hide (a running sync continues in the background).
  const close = () => (kind === 'offer' ? respondToTransfer(false) : dismissTransfer());

  let body;
  let footer;
  switch (state.phase) {
    case 'offer':
      body = <Offer state={state} />;
      footer = (
        <>
          <span style={{ flex: 1 }} />
          <button className="cx-btn" onClick={() => respondToTransfer(false)}>
            Để sau
          </button>
          <button className="cx-btn cx-btn-primary" onClick={() => respondToTransfer(true)}>
            Đồng bộ ngay
          </button>
        </>
      );
      break;
    case 'waitingForPhone':
    case 'transferring':
      body = state.phase === 'waitingForPhone' ? <Waiting state={state} /> : <Transferring state={state} />;
      // "Ẩn" keeps the sync running in the background; "Hủy đồng bộ" stops it.
      footer = (
        <>
          <button className="cx-btn cx-btn-danger" onClick={() => respondToTransfer(false)}>
            Hủy đồng bộ
          </button>
          <span style={{ flex: 1 }} />
          <button className="cx-btn cx-btn-primary" onClick={dismissTransfer}>
            Ẩn
          </button>
        </>
      );
      break;
    case 'finished':
      body = <Finished state={state} />;
      footer = (
        <>
          <span style={{ flex: 1 }} />
          <button className="cx-btn cx-btn-primary" autoFocus onClick={dismissTransfer}>
            Xong
          </button>
        </>
      );
      break;
    case 'failed':
      body = <Failed state={state} reason={state.failure ?? 'Đồng bộ không thành công.'} />;
      footer = (
        <>
          <span style={{ flex: 1 }} />
          <button className="cx-btn" onClick={dismissTransfer}>
            Đóng
          </button>
          {/* No Return default: a retry pings the phone, so it takes a deliberate click. */}
          {state.canRetry && (
            <button className="cx-btn cx-btn-primary" onClick={() => respondToTransfer(true)}>
              Thử lại
            </button>
          )}
        </>
      );
      break;
  }

  return (
    <ZaloDialog title="Đồng bộ tin nhắn" onClose={close} width={480} footer={footer}>
      {kind !== 'offer' && <TransferStepper state={state} />}
      <div key={kind} className="transfer-body fade-in">
        {body}
      </div>
    </ZaloDialog>
  );
}

/** PandaDoc / Podia: where the sync is (phone confirmation → receiving → done) as a stepper under the title bar. */
function TransferStepper({ state }: { state: MessageTransferState }) {
  const steps = ['Xác nhận trên điện thoại', 'Đồng bộ', 'Hoàn tất'];
  const current = state.phase === 'waitingForPhone' ? 0 : state.phase === 'transferring' ? 1 : 2;
  const failed = state.phase === 'failed';
  return (
    <ol className="transfer-stepper" aria-label="Tiến trình đồng bộ">
      {steps.map((title, i) => {
        const done = !failed && (i < current || state.phase === 'finished');
        const active = !failed && i === current && state.phase !== 'finished';
        return (
          <li key={title} className={`transfer-step ${done ? 'is-done' : ''} ${active ? 'is-active' : ''}`} aria-current={active ? 'step' : undefined}>
            <span className="transfer-step-dot">{done ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
            <span className="transfer-step-title">{title}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Offer({ state }: { state: MessageTransferState }) {
  return (
    <>
      <TransferRoute animated={false} />
      <div className="transfer-title">Đồng bộ tin nhắn từ điện thoại?</div>
      <p className="transfer-text">
        {state.message ??
          'Để đảm bảo tính bảo mật, Zalo chỉ hiển thị tin nhắn từ sau lần đăng nhập đầu tiên trên thiết bị này.'}
      </p>
      <div className="transfer-bullets">
        <Bullet icon={Smartphone} text="Chỉ bắt đầu khi bạn chọn Đồng ý trên điện thoại." />
        <Bullet icon={Clock} text="Thường mất vài phút, tuỳ số lượng tin nhắn." />
        <Bullet icon={Wifi} text="Giữ Zalo mở và có mạng cho đến khi xong." />
      </div>
    </>
  );
}

function Bullet({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="transfer-bullet">
      <span className="transfer-bullet-icon">
        <Icon size={15} />
      </span>
      <span>{text}</span>
    </div>
  );
}

/** Care.com "Follow the link sent to your phone": the device picture, then numbered steps of what to do there. */
function Waiting({ state }: { state: MessageTransferState }) {
  return (
    <>
      <TransferRoute animated />
      <div className="transfer-title">Mở Zalo trên điện thoại để xác nhận</div>
      <p className="transfer-text">{waitingDetail(state)}</p>
      <ol className="transfer-howto">
        <li>Mở ứng dụng Zalo trên điện thoại</li>
        <li>Chạm vào thông báo yêu cầu đồng bộ tin nhắn</li>
        <li>
          Chọn <b>Đồng ý</b> và giữ Zalo mở
        </li>
      </ol>
      <WaitingPill />
    </>
  );
}

export function WaitingPill() {
  return (
    <div className="transfer-pill">
      <Spinner size={13} /> Đang chờ xác nhận từ điện thoại…
    </div>
  );
}

/** Names of the official sync-v2 stages, in order (the client reports `stageIndex` / `stageCount`). */
const stageNames = ['Danh sách hội thoại', 'Tin nhắn gần đây', 'Tin nhắn cũ hơn'];

/** Confluence: label + percentage over a linear bar; PandaDoc: one row per stage with ✓ / spinner / pending. */
function Transferring({ state }: { state: MessageTransferState }) {
  const percent = state.progress === null ? null : Math.round(state.progress * 100);
  const count = transferCountText(state);
  const stages = state.stageCount && state.stageCount > 0 ? state.stageCount : null;
  return (
    <>
      <TransferRoute animated />
      <div className="transfer-progress">
        <div className="transfer-progress-head">
          <span className="transfer-progress-title">Đang đồng bộ tin nhắn…</span>
          {percent !== null && <span className="transfer-progress-pct nums">{percent}%</span>}
        </div>
        <div className={`transfer-bar ${percent === null ? 'is-indeterminate' : ''}`} role="progressbar" aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
          <span style={percent === null ? undefined : { width: `${Math.max(2, percent)}%` }} />
        </div>
        {count && <div className="transfer-progress-count nums">{count}</div>}
      </div>
      {stages !== null && state.stageIndex !== null && (
        <ul className="transfer-stages">
          {Array.from({ length: stages }, (_, i) => {
            const n = i + 1;
            const done = n < state.stageIndex!;
            const active = n === state.stageIndex;
            const name = stages === stageNames.length ? stageNames[i] : `Bước ${n}`;
            return (
              <li key={n} className={`transfer-stage ${done ? 'is-done' : ''} ${active ? 'is-active' : ''}`}>
                <span className="transfer-stage-mark">{done ? <Check size={13} strokeWidth={3} /> : active ? <Spinner size={13} /> : <span className="transfer-stage-dot" />}</span>
                <span className="transfer-stage-text">
                  <span className="transfer-stage-name">{name}</span>
                  <span className="transfer-stage-detail">{done ? 'Xong' : active ? stageTitle(state) : 'Đang chờ'}</span>
                </span>
                {active && state.stageProgress !== null && <span className="transfer-stage-pct nums">{Math.round(state.stageProgress * 100)}%</span>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="transfer-note">
        <Info size={14} />
        <span>Có thể ẩn cửa sổ này, đồng bộ vẫn tiếp tục. Giữ Zalo mở trên điện thoại cho đến khi hoàn tất.</span>
      </div>
    </>
  );
}

function Finished({ state }: { state: MessageTransferState }) {
  const count = transferCountText(state);
  return (
    <>
      <FinishedMark />
      <div className="transfer-title">Hoàn tất</div>
      <p className="transfer-text">Tin nhắn từ điện thoại đã được đồng bộ sang máy tính.</p>
      {count && <div className="transfer-summary nums">{count}</div>}
    </>
  );
}

function Failed({ state, reason }: { state: MessageTransferState; reason: string }) {
  return (
    <>
      <FailedMark />
      <div className="transfer-title">Đồng bộ không thành công</div>
      <p className="transfer-text">{state.message ?? reason}</p>
      <div className="transfer-tips">
        <div className="transfer-tips-title">Trước khi thử lại</div>
        <Bullet icon={Smartphone} text="Mở Zalo trên điện thoại và giữ ứng dụng ở màn hình chính." />
        <Bullet icon={Wifi} text="Kiểm tra cả hai thiết bị đều có kết nối mạng." />
      </div>
      {state.errorCode !== null && <div className="transfer-small nums">Mã lỗi {state.errorCode}</div>}
    </>
  );
}
