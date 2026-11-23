// Placeholder: the Danh bạ columns (Swift Shell/ContactsColumns.swift), filled in by the contacts port.

import { BookUser, MessagesSquare } from 'lucide-react';
import type { Destination } from '../../shell/shellStore';
import { ContentUnavailable } from '../../ui/ContentUnavailable';

export function ContactsContentColumn({ destination: _d }: { destination: Destination }) {
  return (
    <div className="column">
      <div className="toolbar" data-tauri-drag-region />
      <ContentUnavailable icon={BookUser} title="Danh bạ" />
    </div>
  );
}

export function ContactsDetailColumn({ destination: _d }: { destination: Destination }) {
  return (
    <div className="column">
      <div className="toolbar" data-tauri-drag-region />
      <ContentUnavailable icon={MessagesSquare} title="Chưa có nội dung" />
    </div>
  );
}
