// Photos, GIFs, stickers, videos and voice messages (Swift `PhotoView`, `VideoThumb`, `VoiceView`). Photos and video
// thumbnails fall back to the official loader (`resolveMedia`) when the CDN link is dead; E2EE media go there first.

import { AudioLines, Pause, Play, Smile, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../../../engine/media';
import { resolveMedia } from '../../../engine/mediaResolver';
import { isEncryptedMedia, type ChatMessage } from '../../../engine/models/chat';
import { RemoteImage } from '../../../ui/RemoteImage';
import { Spinner } from '../../../ui/Spinner';
import { clock } from '../format';
import { openViewer } from '../MediaViewer';

/** Chat size of a photo: at most 280×340, keeping its aspect (Swift `PhotoView.size`). */
export const photoSize = (width: number, height: number) => {
  if (width <= 0 || height <= 0) return { width: 240, height: 180 };
  const scale = Math.min(280 / width, 340 / height, 1.5);
  return { width: Math.max(80, width * scale), height: Math.max(60, height * scale) };
};

export function PhotoView({ message, url, width, height, tile }: { message: ChatMessage; url: string | null; width: number; height: number; tile?: number }) {
  const size = tile ? { width: tile, height: tile } : photoSize(width, height);
  const encrypted = isEncryptedMedia(message, url);
  return (
    <button
      className={`photo ${tile ? 'is-tile' : ''}`}
      style={{ width: size.width, maxWidth: '100%', aspectRatio: `${size.width} / ${size.height}` }}
      onClick={() => url && openViewer({ kind: 'photo', url, message })}
      aria-label="Hình ảnh"
    >
      <RemoteImage
        url={url}
        className="fill"
        resolveFirst={encrypted}
        resolve={(force) => resolveMedia(message.conversationId, message.id, 'photo', force)}
      />
    </button>
  );
}

/** A GIF: Zalo sends some as short MP4s (played muted, looping); the still / animated image otherwise. The frame keeps its
 * size whatever happens, so a dead link shows the "hết hạn" tile instead of an empty box. */
export function GifView({ message, url }: { message: ChatMessage; url: string | null }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const isVideo = !!url && /\.(mp4|webm|mov)(\?|$)/i.test(url);
  const src = isVideo ? mediaUrl(url, 'cors') : null;
  return (
    <div className="gif">
      {src && !videoFailed ? (
        <video className="fill gif-video" src={src} autoPlay loop muted playsInline onError={() => setVideoFailed(true)} />
      ) : (
        <RemoteImage
          url={isVideo ? null : url}
          fit="contain"
          className="fill"
          expiredText="GIF đã hết hạn"
          resolve={(force) => resolveMedia(message.conversationId, message.id, 'photo', force)}
        />
      )}
      <span className="gif-badge">GIF</span>
    </div>
  );
}

export function StickerView({ url }: { url: string | null }) {
  return (
    <div className="sticker">
      <RemoteImage url={url} fit="contain" className="fill" compact placeholder={<span className="sticker-placeholder"><Smile size={28} /></span>} />
    </div>
  );
}

export function VideoThumb({ message, thumbnail, duration, url, tile }: { message: ChatMessage; thumbnail: string | null; duration: number; url: string | null; tile?: number }) {
  const size = tile ? { width: tile, height: tile } : { width: 260, height: 160 };
  const [failed, setFailed] = useState(false);
  /** The official loader said the video (or its thumbnail) is gone for good: no play button, no retry. */
  const [expired, setExpired] = useState(false);
  const encrypted = isEncryptedMedia(message, url);
  const play = async () => {
    if (expired) return;
    setFailed(false);
    // E2EE videos are ciphertext on the CDN: only the official download (which decrypts) can play them.
    if (url && !encrypted) return openViewer({ kind: 'video', url, message });
    const r = await resolveMedia(message.conversationId, message.id, 'video', failed);
    if (r.state === 'file') openViewer({ kind: 'video', url: null, file: r.path, message });
    else if (r.state === 'expired') setExpired(true);
    else setFailed(true);
  };
  return (
    <button
      className={`video-thumb ${tile ? 'is-tile' : ''} ${expired ? 'is-expired' : ''}`}
      style={{ width: size.width, maxWidth: '100%', aspectRatio: `${size.width} / ${size.height}` }}
      onClick={() => void play()}
      disabled={expired}
      aria-label={expired ? 'Video đã hết hạn' : 'Video'}
    >
      {expired ? (
        <span className="remote-image media-failure is-expired fill">
          <VideoOff size={tile ? 16 : 24} />
          {!tile && <span>Video đã hết hạn</span>}
        </span>
      ) : (
        <>
          <RemoteImage
            url={thumbnail}
            className="fill"
            compact
            placeholder={<span className="fill" />}
            expiredText="Video đã hết hạn"
            onExpired={() => setExpired(true)}
            resolve={(force) => resolveMedia(message.conversationId, message.id, 'videoThumb', force)}
          />
          <span className="video-play">
            <Play size={tile ? 12 : 18} fill="currentColor" />
          </span>
          {duration > 0 && <span className="video-duration nums">{clock(duration)}</span>}
          {failed && !tile && <span className="video-failed">Không thể phát video. Nhấn để thử lại.</span>}
        </>
      )}
    </button>
  );
}

export function VoiceView({ url, duration, mine }: { url: string | null; duration: number; mine: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle');
  useEffect(() => () => audio.current?.pause(), []);
  const toggle = () => {
    const src = mediaUrl(url, 'cors');
    if (!src) return;
    if (!audio.current) {
      const a = new Audio(src);
      a.onended = () => setState('idle');
      a.onplaying = () => setState('playing');
      a.onerror = () => setState('idle');
      audio.current = a;
    }
    const a = audio.current;
    if (state === 'playing') {
      a.pause();
      setState('paused');
    } else {
      setState(state === 'idle' ? 'loading' : 'playing');
      void a.play().catch(() => setState('idle'));
    }
  };
  return (
    <span className={`voice ${mine ? 'is-mine' : ''}`}>
      <button className="voice-button" onClick={toggle} disabled={!url} aria-label={state === 'playing' ? 'Tạm dừng' : 'Phát tin nhắn thoại'}>
        {state === 'loading' ? <Spinner size={12} /> : state === 'playing' ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
      </button>
      <AudioLines size={20} className={state === 'playing' ? 'voice-wave is-playing' : 'voice-wave'} />
      <span className="nums">{clock(duration)}</span>
    </span>
  );
}
