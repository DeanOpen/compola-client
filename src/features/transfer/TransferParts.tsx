// Pieces of the transfer window (Swift TransferView.swift): the phone ⟶ computer
// illustration and the progress ring.

import { CheckCircle2, Laptop, RefreshCw, Smartphone, ArrowRight, ChevronRight, AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import './transfer.css';

/** Phone ⟶ laptop. With `animated`, a pulse radiates from the phone and chevrons stream towards the computer. */
export function TransferRoute({ animated }: { animated: boolean }) {
  return (
    <div className="transfer-route" aria-hidden>
      <Device pulsing={animated}>
        <Smartphone size={30} strokeWidth={1.6} />
      </Device>
      {animated ? (
        <span className="transfer-chevrons">
          {[0, 1, 2].map((i) => (
            <ChevronRight key={i} size={18} strokeWidth={2.6} style={{ animationDelay: `${i * 0.2}s` }} />
          ))}
        </span>
      ) : (
        <ArrowRight size={20} strokeWidth={2.2} className="transfer-arrow" />
      )}
      <Device pulsing={false}>
        <Laptop size={30} strokeWidth={1.6} />
      </Device>
    </div>
  );
}

function Device({ pulsing, children }: { pulsing: boolean; children: ReactNode }) {
  return (
    <span className="transfer-device">
      {pulsing && (
        <>
          <span className="transfer-pulse" />
          <span className="transfer-pulse" style={{ animationDelay: '0.7s' }} />
        </>
      )}
      <span className="transfer-device-tile">{children}</span>
    </span>
  );
}

/** Determinate ring with the percentage; a spinning arc while `progress` is unknown. */
export function ProgressRing({ progress, size = 104 }: { progress: number | null; size?: number }) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const center = size / 2;
  return (
    <div className="progress-ring" style={{ width: size, height: size }} role="progressbar" aria-valuenow={progress === null ? undefined : Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
      <svg width={size} height={size} className={progress === null ? 'progress-ring-spin' : ''}>
        <circle cx={center} cy={center} r={r} className="progress-ring-track" strokeWidth={stroke} fill="none" />
        <circle
          cx={center}
          cy={center}
          r={r}
          className="progress-ring-bar"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={progress === null ? c * 0.72 : c * (1 - Math.max(0.012, progress))}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <span className="progress-ring-label">
        {progress === null ? <RefreshCw size={26} className="tint progress-ring-pulse" /> : <span className="nums">{Math.round(progress * 100)}%</span>}
      </span>
    </div>
  );
}

export function FinishedMark() {
  return (
    <span className="transfer-finished-mark" aria-hidden>
      <CheckCircle2 size={48} strokeWidth={1.8} />
    </span>
  );
}

export function FailedMark() {
  return (
    <span className="transfer-failed-mark" aria-hidden>
      <AlertTriangle size={30} />
    </span>
  );
}
