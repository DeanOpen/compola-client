// A minimal in-window media viewer (Swift `MediaViewer` is a window of its own with zoom, save and gallery — later
// wave): the photo or video over a dim backdrop, with who sent it and when. Esc / click outside closes.

import { X } from 'lucide-react';
import { create } from 'zustand';
import { mediaFileUrl, mediaUrl } from '../../engine/media';
import type { ChatMessage } from '../../engine/models/chat';
import { useEscape } from '../../ui/escape';
import { daySeparator, time } from './format';

export type ViewerItem = { kind: 'photo' | 'video'; url: string | null; file?: string; message: ChatMessage };

const useViewer = create<{ item: ViewerItem | null }>(() => ({ item: null }));

export const openViewer = (item: ViewerItem) => useViewer.setState({ item });
const close = () => useViewer.setState({ item: null });

export function MediaViewerHost() {
  const item = useViewer((s) => s.item);
  useEscape(!!item, close);
  if (!item) return null;
  const flavour = item.kind === 'video' ? 'cors' : 'image';
  const src = item.file ? mediaFileUrl(item.file, flavour) : mediaUrl(item.url, flavour);
  const who = item.message.isMine ? 'Bạn' : item.message.senderName;
  return (
    <div className="viewer fade-in" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="viewer-bar">
        <div>
          <div className="viewer-who">{who}</div>
          <div className="viewer-when">
            {daySeparator(item.message.date)} {time(item.message.date)}
          </div>
        </div>
        <button className="circle-glass" style={{ width: 32, height: 32 }} onClick={close} aria-label="Đóng">
          <X size={16} />
        </button>
      </div>
      {src &&
        (item.kind === 'video' ? (
          <video className="viewer-media pop-in" src={src} controls autoPlay />
        ) : (
          <img className="viewer-media pop-in" src={src} alt="" draggable={false} />
        ))}
    </div>
  );
}
