import type { ReactNode } from 'react';
import './setup.css';

/** Soft accent-tinted backdrop that the glass surfaces refract (Swift `BrandBackground`). Draggable window area. */
export function BrandBackground({ children }: { children?: ReactNode }) {
  return (
    <div className="brand-bg" data-tauri-drag-region>
      <div className="brand-blob brand-blob-1" />
      <div className="brand-blob brand-blob-2" />
      <div className="brand-blob brand-blob-3" />
      <div className="brand-content">{children}</div>
    </div>
  );
}
