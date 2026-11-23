// Sheets (modal panels), alerts and anchored popovers. Esc closes the topmost (see escape.ts).

import { X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useEscape } from './escape';
import './ui.css';

/** A modal sheet over the window (SwiftUI `.sheet`). */
export function Sheet({ onClose, children, width = 440, height }: { onClose: () => void; children: ReactNode; width?: number; height?: number }) {
  useEscape(true, onClose);
  return createPortal(
    <div className="sheet-backdrop fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet glass-strong sheet-in" style={{ width, height }} role="dialog" aria-modal>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Title row of a sheet with its close button. */
export function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="sheet-header">
      <div className="sheet-title">{title}</div>
      <button className="icon-button" style={{ width: 26, height: 26 }} onClick={onClose} aria-label="Đóng" title="Đóng">
        <X size={15} />
      </button>
    </div>
  );
}

export interface AlertButton {
  label: string;
  role?: 'cancel' | 'destructive' | 'default';
  onClick: () => void;
}

/**
 * SwiftUI `.alert`, drawn as a Zalo PC confirm: the title row (with × when there is a cancel button), the message,
 * then the buttons bottom-right (cancel first, the action filled: blue, red when destructive). Esc presses the cancel
 * button (answered only by its buttons).
 */
export function Alert({ title, message, buttons }: { title: string; message?: string; buttons: AlertButton[] }) {
  const cancel = buttons.find((b) => b.role === 'cancel');
  useEscape(true, () => cancel?.onClick());
  const primary = useRef<HTMLButtonElement>(null);
  const primaryIndex = buttons.findIndex((b) => b.role !== 'cancel');
  useEffect(() => primary.current?.focus(), []);
  return createPortal(
    <div className="sheet-backdrop fade-in">
      <div className="alert glass-strong sheet-in" role="alertdialog" aria-modal aria-label={title}>
        <div className="alert-header">
          <div className="alert-title">{title}</div>
          {cancel && (
            <button className="icon-button alert-close" onClick={cancel.onClick} aria-label={cancel.label} title={cancel.label}>
              <X size={16} />
            </button>
          )}
        </div>
        {message && <div className="alert-message">{message}</div>}
        <div className="alert-buttons">
          {buttons.map((b, i) => (
            <button
              key={i}
              ref={i === primaryIndex ? primary : undefined}
              className={`btn ${b.role === 'cancel' ? 'btn-glass alert-button-cancel' : b.role === 'destructive' ? 'alert-button-destructive' : 'btn-prominent'}`}
              onClick={b.onClick}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A popover anchored to an element (SwiftUI `.popover`). Closes on outside click and Esc. */
export function Popover({
  anchor,
  onClose,
  children,
  placement = 'top',
  className = '',
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  placement?: 'top' | 'bottom';
  className?: string;
}) {
  useEscape(true, onClose);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const el = ref.current?.getBoundingClientRect();
    if (!a || !el) return;
    let left = a.left + a.width / 2 - el.width / 2;
    left = Math.min(Math.max(8, left), window.innerWidth - el.width - 8);
    let top = placement === 'top' ? a.top - el.height - 8 : a.bottom + 8;
    if (top < 8) top = a.bottom + 8;
    if (top + el.height > window.innerHeight - 8) top = Math.max(8, a.top - el.height - 8);
    setPos({ left, top });
  }, [anchor, placement]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className={`popover glass-strong ${pos ? 'pop-in' : ''} ${className}`} style={pos ?? { left: -9999, top: -9999 }}>
      {children}
    </div>,
    document.body,
  );
}
