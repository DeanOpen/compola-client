// Phone → PC message transfer over the main window (Swift `TransferOverlay` / `TransferCard`), as a Zalo PC dialog:
// title bar "Đồng bộ tin nhắn" with ×, the state in the body, the actions bottom-right. The flow itself (offer, phone
// confirmation, progress, result) is the official client's (`engine/transfer.ts`); this only renders it. Modal: the
// window behind is covered while it is up.

import { useEffect } from 'react';
import { useEngine } from '../../engine/store';
import { dismissTransfer, respondToTransfer, stageTitle, waitingDetail, type MessageTransferState } from '../../engine/transfer';
import { Spinner } from '../../ui/Spinner';
import { ZaloDialog } from '../calls/ZaloDialog';
import { FailedMark, FinishedMark, ProgressRing, TransferRoute } from './TransferParts';
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
      body = <Finished />;
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
    <ZaloDialog title="Đồng bộ tin nhắn" onClose={close} width={440} footer={footer}>
      <div key={kind} className="transfer-body fade-in">
        {body}
      </div>
    </ZaloDialog>
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
      <p className="transfer-text">Đồng bộ từ điện thoại để xem đầy đủ nội dung các cuộc trò chuyện.</p>
    </>
  );
}

function Waiting({ state }: { state: MessageTransferState }) {
  return (
    <>
      <TransferRoute animated />
      <div className="transfer-title">Mở Zalo trên điện thoại để xác nhận</div>
      <p className="transfer-text">{waitingDetail(state)}</p>
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

const transferDetail = (state: MessageTransferState): string => {
  if (state.receivedMessages && state.receivedMessages > 0) return `Đã nhận ${state.receivedMessages.toLocaleString('vi-VN')} tin nhắn`;
  if (state.totalConversations && state.totalConversations > 0) return `Đã đồng bộ ${state.syncedConversations}/${state.totalConversations} hội thoại`;
  if (state.syncedConversations > 0) return `Đã đồng bộ ${state.syncedConversations} hội thoại`;
  return stageTitle(state);
};

function Transferring({ state }: { state: MessageTransferState }) {
  return (
    <>
      <ProgressRing progress={state.progress} />
      <div className="transfer-title">Đang đồng bộ tin nhắn</div>
      <div className="transfer-detail nums">{transferDetail(state)}</div>
      {state.stageIndex !== null && state.stageCount !== null && (
        <div className="transfer-small">
          Bước {state.stageIndex}/{state.stageCount} · {stageTitle(state)}
        </div>
      )}
      <div className="transfer-small">Giữ Zalo mở trên điện thoại cho đến khi hoàn tất.</div>
    </>
  );
}

function Finished() {
  return (
    <>
      <FinishedMark />
      <div className="transfer-title">Hoàn tất</div>
      <p className="transfer-text">Tin nhắn từ điện thoại đã được đồng bộ sang máy tính.</p>
    </>
  );
}

function Failed({ state, reason }: { state: MessageTransferState; reason: string }) {
  return (
    <>
      <FailedMark />
      <div className="transfer-title">Đồng bộ không thành công</div>
      <p className="transfer-text">{state.message ?? reason}</p>
    </>
  );
}
