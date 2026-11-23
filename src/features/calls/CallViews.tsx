// Incoming-call card, the ongoing-call / helper status pill and the call notice dialog (Swift `CallOverlay` /
// `IncomingCallBanner`). The native helper (ZaloCall) draws the ringing window with Accept / Decline; the card tells the
// user where to look and brings that window forward.
// Patterns (docs/design-refs/wave4/calls): Teams' corner "is calling you" card, Dialpad's floating call pill, Discord's
// centred notice.

import { AlertTriangle, PhoneIncoming, PhoneOff, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { dismissCallNotice, dismissIncomingCall, isInCall, showCallWindow, useCalls, type IncomingCall } from '../../engine/calls';
import { Avatar } from '../../ui/Avatar';
import { ZaloDialog } from './ZaloDialog';
import './dialog.css';
import './calls.css';

export function IncomingCallBanner({ incoming }: { incoming: IncomingCall }) {
  const subtitle = incoming.group ? (incoming.caller ? `${incoming.caller} đang gọi nhóm` : 'Cuộc gọi nhóm') : 'đang gọi cho bạn';
  return (
    <div className="incoming-call cx-slide-up" role="alertdialog" aria-live="assertive" aria-label={`${incoming.name} ${subtitle}`}>
      <div className="incoming-call-head">
        <PhoneIncoming size={13} className="incoming-call-head-icon" />
        <span className="incoming-call-head-title">{incoming.group ? 'Cuộc gọi nhóm đến' : 'Cuộc gọi đến'}</span>
        <button className="cx-icon-button incoming-call-hide" onClick={dismissIncomingCall} title="Ẩn" aria-label="Ẩn">
          <X size={15} />
        </button>
      </div>
      <div className="incoming-call-body">
        <span className="incoming-call-ring" aria-hidden>
          <Avatar url={incoming.avatar} name={incoming.name} size={64} />
          {incoming.group && (
            <span className="incoming-call-group" aria-hidden>
              <Users size={11} />
            </span>
          )}
        </span>
        <div className="incoming-call-name truncate">{incoming.name}</div>
        <div className="incoming-call-sub truncate">{subtitle}</div>
      </div>
      <button className="cx-btn cx-btn-primary incoming-call-open" onClick={() => void showCallWindow()}>
        Mở cửa sổ cuộc gọi
      </button>
      <div className="incoming-call-hint">Trả lời hoặc từ chối trong cửa sổ cuộc gọi của Zalo</div>
    </div>
  );
}

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * A floating pill at the top of the window: the call in progress (elapsed time + "Mở cửa sổ cuộc gọi"), or why calls
 * cannot run (the helper is missing / failed), dismissible for this problem text.
 */
export function CallStatusPill() {
  const calls = useCalls();
  const inCall = isInCall(calls) && !calls.incoming;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const started = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!inCall) {
      started.current = null;
      return;
    }
    started.current ??= Date.now();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [inCall]);

  if (inCall) {
    const elapsed = Math.max(0, Math.floor((now - (started.current ?? now)) / 1000));
    return (
      <div className="call-pill-layer">
        <div className="call-pill cx-slide-down" role="status">
          <span className="call-pill-dot" aria-hidden />
          <span className="call-pill-text">Đang trong cuộc gọi</span>
          <span className="call-pill-time nums">{clock(elapsed)}</span>
          <button className="cx-btn cx-btn-primary cx-btn-small" onClick={() => void showCallWindow()}>
            Mở cửa sổ cuộc gọi
          </button>
        </div>
      </div>
    );
  }

  const problem = calls.helperProblem;
  if (!problem || dismissed === problem) return null;
  return (
    <div className="call-pill-layer">
      <div className="call-pill is-warning cx-slide-down" role="status">
        <AlertTriangle size={15} className="call-pill-warn" aria-hidden />
        <span className="call-pill-text">
          <b>Chưa gọi được.</b> {problem}
        </span>
        <button className="cx-icon-button" onClick={() => setDismissed(problem)} title="Ẩn" aria-label="Ẩn">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/** "Chưa gọi được" and the helper's own popups (Swift `.alert`): a small centred Zalo PC dialog with an icon. */
export function CallNoticeAlert() {
  const notice = useCalls((s) => s.notice);
  if (!notice) return null;
  return (
    <ZaloDialog key={notice.id} label={notice.title || 'Cuộc gọi'} onClose={dismissCallNotice} width={340}>
      <div className="call-notice">
        <span className="call-notice-icon" aria-hidden>
          <PhoneOff size={22} />
        </span>
        <div className="call-notice-title">{notice.title || 'Cuộc gọi'}</div>
        {notice.message && <div className="call-notice-text">{notice.message}</div>}
        <button className="cx-btn cx-btn-primary call-notice-ok" autoFocus onClick={dismissCallNotice}>
          Đã hiểu
        </button>
      </div>
    </ZaloDialog>
  );
}
