// Shared pieces of the Danh bạ screens (Swift ContactsView.swift "Shared pieces"), Zalo PC style: the search field, the page
// title bar, the round action buttons, the contact call buttons and the loading / empty states.

import { ChevronLeft, Phone, Search, Video, X, XCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { callAvailability, startCall, useCalls, type CallAvailability } from '../../engine/calls';
import { useEngine } from '../../engine/store';
import { Spinner } from '../../ui/Spinner';
import './contacts.css';

/** Search input of the contacts pages (32px, 6px radius). Esc clears it. */
export function ContactsSearchField({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="ct-search">
      <Search size={15} className="ct-search-icon" />
      <input
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }
        }}
        aria-label={placeholder}
      />
      {value && (
        <button className="ct-search-clear" onClick={() => onChange('')} title="Xoá" aria-label="Xoá nội dung tìm kiếm">
          <XCircle size={15} fill="currentColor" stroke="var(--ct-layer)" />
        </button>
      )}
    </label>
  );
}

/** Title bar of a contacts page (64px): icon + title. */
export function ContactsPageHeader({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="ct-page-header" data-tauri-drag-region>
      <Icon size={22} strokeWidth={1.8} />
      <span className="ct-page-header-title truncate" data-tauri-drag-region>
        {title}
      </span>
      <span className="ct-spacer" data-tauri-drag-region />
      {children}
    </div>
  );
}

/** Round button with its caption underneath (message / voice / video of a profile). */
export function ContactActionButton({
  title,
  icon: Icon,
  help,
  disabled = false,
  onClick,
}: {
  title: string;
  icon: LucideIcon;
  help?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`ct-action ${disabled ? 'is-disabled' : ''}`}>
      <button className="ct-action-button" onClick={onClick} disabled={disabled} title={help ?? title} aria-label={title}>
        <Icon size={18} />
      </button>
      <span aria-hidden>{title}</span>
    </div>
  );
}

/**
 * Voice / video call buttons of a person who may have no conversation yet. Same availability rules (and tooltips) as the chat
 * header; a call is only placed by a click.
 */
export function ContactCallActions({ id, name, onStart }: { id: string; name: string; onStart?: () => void }) {
  const calls = useCalls();
  const selfId = useEngine((s) => s.selfConversationId);
  const target = { id, isGroup: false };
  const audio = callAvailability(calls, target, false, selfId);
  const video = callAvailability(calls, target, true, selfId);
  const button = (title: string, icon: LucideIcon, availability: CallAvailability, isVideo: boolean) => (
    <ContactActionButton
      title={title}
      icon={icon}
      help={availability.kind === 'disabled' ? availability.reason : `${title} với ${name}`}
      disabled={availability.kind !== 'available'}
      onClick={() => {
        onStart?.();
        startCall(id, isVideo);
      }}
    />
  );
  return (
    <>
      {audio.kind !== 'hidden' && button('Gọi thoại', Phone, audio, false)}
      {video.kind !== 'hidden' && button('Gọi video', Video, video, true)}
    </>
  );
}

/** Centered spinner with a caption while a contacts list is being read. */
export function ContactsLoading({ text }: { text: string }) {
  return (
    <div className="ct-loading">
      <Spinner size={18} />
      <span>{text}</span>
    </div>
  );
}

/** Empty state inside a contacts page panel (official `empty__search`). */
export function ContactsEmpty({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="ct-empty">
      <span className="ct-empty-icon">
        <Icon size={40} strokeWidth={1.4} />
      </span>
      <div className="ct-empty-title">{title}</div>
      {description && <div className="ct-empty-desc">{description}</div>}
      {action}
    </div>
  );
}

/** Header of a contacts dialog (Zalo PC: 48px, title, optional back arrow, close). */
export function DialogHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }) {
  return (
    <div className="ct-dialog-header">
      {onBack && (
        <button className="ct-icon-button" onClick={onBack} title="Quay lại" aria-label="Quay lại">
          <ChevronLeft size={18} />
        </button>
      )}
      <div className="ct-dialog-title">{title}</div>
      <button className="ct-icon-button" onClick={onClose} title="Đóng" aria-label="Đóng">
        <X size={18} />
      </button>
    </div>
  );
}
