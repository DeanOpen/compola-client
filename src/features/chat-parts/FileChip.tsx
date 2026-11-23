// Wave 3 #7 (Teams file card): a file attachment as a chip — colour-coded type icon, the name with a middle ellipsis
// (the extension always shows), "size · TYPE", and a ⋯ menu: Mở, Lưu về máy, Chia sẻ, Xem trong thư mục.

import { Download, ExternalLink, FolderOpen, MoreHorizontal, Share2 } from 'lucide-react';
import type { MouseEvent } from 'react';
import { openMediaExternally, saveMediaAs } from '../../engine/save';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { fileTypeOf, formatBytes, splitForMiddleEllipsis } from './fileTypes';
import './chatParts.css';

export interface FileChipProps {
  name: string;
  /** Bytes; null when unknown. */
  size: number | null;
  /** Remote (CDN) or `file://` URL; used by the default Mở / Lưu về máy actions. */
  url?: string | null;
  /** Overrides the extension taken from `name`. */
  ext?: string | null;
  /** Default: `openMediaExternally(url, name)` (Rust `media_open_file`). */
  onOpen?: () => void;
  /** Default: `saveMediaAs(url, name)` (save panel + `media_save`). */
  onSave?: () => void;
  /** "Chia sẻ" (forward); the item is hidden when omitted. */
  onShare?: () => void;
  /** "Xem trong thư mục" (reveal the downloaded copy); the item is hidden when omitted. */
  onReveal?: () => void;
  /** Conversation for the save / open toasts. */
  conversationId?: string | null;
  /** Inside my bubble (tints the chip for the blue bubble). */
  isMine?: boolean;
  /** Extra trailing content instead of the ⋯ button (e.g. a remove ×). */
  trailing?: React.ReactNode;
  className?: string;
}

export function FileChip({ name, size, url, ext, onOpen, onSave, onShare, onReveal, conversationId = null, isMine, trailing, className = '' }: FileChipProps) {
  const type = fileTypeOf(name, ext);
  const Icon = type.icon;
  const [head, tail] = splitForMiddleEllipsis(name || 'Tệp');
  const open = onOpen ?? (url ? () => void openMediaExternally(url, name, conversationId) : undefined);
  const save = onSave ?? (url ? () => void saveMediaAs(url, name, conversationId) : undefined);

  const items = (): MenuItem[] => [
    { label: 'Mở', icon: ExternalLink, disabled: !open, onSelect: () => open?.() },
    { label: 'Lưu về máy…', icon: Download, disabled: !save, onSelect: () => save?.() },
    ...(onShare ? [{ label: 'Chia sẻ', icon: Share2, onSelect: onShare }] : []),
    ...(onReveal ? [{ label: 'Xem trong thư mục', icon: FolderOpen, onSelect: onReveal }] : []),
  ];
  const meta = [formatBytes(size), type.label].filter(Boolean).join(' · ');

  return (
    <div
      className={`file-chip ${isMine ? 'is-mine' : ''} ${open ? 'is-openable' : ''} ${className}`}
      role="button"
      tabIndex={0}
      title={name}
      onClick={() => open?.()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open?.())}
      onContextMenu={(e: MouseEvent) => openContextMenu(e, items())}
    >
      <span className="file-chip-icon" style={{ color: type.color, background: `color-mix(in srgb, ${type.color} 14%, transparent)` }}>
        <Icon size={20} strokeWidth={1.8} />
      </span>
      <span className="file-chip-body">
        <span className="file-chip-name" aria-label={name}>
          <span className="file-chip-head">{head}</span>
          {tail && <span className="file-chip-tail">{tail}</span>}
        </span>
        {meta && <span className="file-chip-meta">{meta}</span>}
      </span>
      {trailing ?? (
        <button
          className="file-chip-more"
          aria-label="Tùy chọn tệp"
          title="Tùy chọn"
          onClick={(e) => {
            e.stopPropagation();
            openMenuBelow(e.currentTarget, items(), 'end');
          }}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
    </div>
  );
}
