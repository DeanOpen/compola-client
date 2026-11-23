// Placeholder: the zCloud columns (Swift Shell/CloudColumns.swift), filled in by the cloud port.

import { HardDrive, MessagesSquare } from 'lucide-react';
import { ContentUnavailable } from '../../ui/ContentUnavailable';

export function CloudContentColumn() {
  return (
    <div className="column">
      <div className="toolbar" data-tauri-drag-region />
      <ContentUnavailable icon={HardDrive} title="zCloud" />
    </div>
  );
}

export function CloudDetailColumn() {
  return (
    <div className="column">
      <div className="toolbar" data-tauri-drag-region />
      <ContentUnavailable icon={MessagesSquare} title="Chưa có nội dung" />
    </div>
  );
}
