// A Zalo PC-style modal dialog (docs/zalo-pc-style.md): white panel on the curtain, a title bar with ×, the body, and an
// optional footer (Hủy + primary bottom-right). Esc and the × call `onClose`; clicks on the curtain do nothing, like
// Zalo PC's modals.

import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscape } from '../../ui/escape';
import './dialog.css';

export function ZaloDialog({
  title,
  onClose,
  children,
  footer,
  width = 400,
  height,
  label,
}: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  height?: number;
  label?: string;
}) {
  useEscape(true, onClose);
  const ref = useRef<HTMLDivElement>(null);
  // Modal keyboard focus: take it from whatever sits under the curtain (e.g. the chat composer).
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);
  return createPortal(
    <div className="cx-curtain fade-in">
      <div ref={ref} tabIndex={-1} className="cx-dialog cx-dialog-in" style={{ width, height }} role="dialog" aria-modal aria-label={title ?? label}>
        {title !== undefined && (
          <div className="cx-dialog-header">
            <div className="cx-dialog-title truncate">{title}</div>
            <button className="cx-icon-button" onClick={onClose} aria-label="Đóng" title="Đóng">
              <X size={18} />
            </button>
          </div>
        )}
        <div className="cx-dialog-body">{children}</div>
        {footer && <div className="cx-dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
