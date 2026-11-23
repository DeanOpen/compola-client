// Incoming-call banner and the call notice alert (Swift `CallOverlay` / `IncomingCallBanner`). The native helper
// (ZaloCall) draws the ringing window with Accept / Decline; the banner tells the user where to look.

import { PhoneIncoming, X } from 'lucide-react';
import { dismissCallNotice, dismissIncomingCall, showCallWindow, useCalls, type IncomingCall } from '../../engine/calls';
import { Avatar } from '../../ui/Avatar';
import { ZaloDialog } from './ZaloDialog';
import './dialog.css';
import './calls.css';

export function IncomingCallBanner({ incoming }: { incoming: IncomingCall }) {
  return (
    <div className="incoming-call cx-slide-down" role="status" aria-live="polite">
      <div className="incoming-call-avatar">
        <Avatar url={incoming.avatar} name={incoming.name} size={40} />
        <span className="incoming-call-badge" aria-hidden>
          <PhoneIncoming size={10} />
        </span>
      </div>
      <div className="incoming-call-text">
        <div className="incoming-call-kind">{incoming.group ? 'Cuộc gọi nhóm đến' : 'Cuộc gọi đến'}</div>
        <div className="incoming-call-name truncate">{incoming.name}</div>
        {incoming.caller && <div className="incoming-call-kind truncate">{incoming.caller} đang gọi</div>}
      </div>
      <button className="cx-btn cx-btn-primary" onClick={() => void showCallWindow()} title="Trả lời hoặc từ chối trong cửa sổ cuộc gọi của Zalo">
        Mở cửa sổ cuộc gọi
      </button>
      <button className="cx-icon-button" onClick={dismissIncomingCall} title="Ẩn" aria-label="Ẩn">
        <X size={16} />
      </button>
    </div>
  );
}

/** "Chưa gọi được" and the helper's own popups (Swift `.alert`): a small Zalo PC confirm dialog. */
export function CallNoticeAlert() {
  const notice = useCalls((s) => s.notice);
  if (!notice) return null;
  return (
    <ZaloDialog
      key={notice.id}
      title={notice.title || 'Cuộc gọi'}
      onClose={dismissCallNotice}
      width={360}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="cx-btn cx-btn-primary" autoFocus onClick={dismissCallNotice}>
            OK
          </button>
        </>
      }
    >
      <div className="call-notice-text">{notice.message}</div>
    </ZaloDialog>
  );
}
