// Placeholder: the chat header's call buttons (Swift CallViews.swift), filled in by the calls port.

import { Phone, Video } from 'lucide-react';
import type { ConversationSummary } from '../../engine/models/conversations';

export function CallButtons({ conversation: _c }: { conversation: ConversationSummary }) {
  return (
    <>
      <button className="toolbar-button" disabled title="Gọi thoại — chưa hỗ trợ trên phiên bản này" aria-label="Gọi thoại">
        <Phone size={15} />
      </button>
      <button className="toolbar-button" disabled title="Gọi video — chưa hỗ trợ trên phiên bản này" aria-label="Gọi video">
        <Video size={16} />
      </button>
    </>
  );
}
