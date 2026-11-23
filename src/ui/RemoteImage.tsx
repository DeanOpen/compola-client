// Swift `RemoteImage` (+ `resolvingWith` / `onFailure`): a CDN image through the media scheme, falling back to the
// official loader (`resolveMedia`) when the link is dead, with an "expired / unavailable · retry" state.

import { ImageOff, RefreshCw } from 'lucide-react';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { mediaFileUrl, mediaUrl } from '../engine/media';
import type { MediaResolution } from '../engine/mediaResolver';
import { Spinner } from './Spinner';
import './ui.css';

type Phase = { kind: 'loading'; src: string | null } | { kind: 'ok'; src: string } | { kind: 'failed'; reason: 'expired' | 'unavailable' };

export function RemoteImage({
  url,
  fit = 'cover',
  className = '',
  style,
  resolve,
  resolveFirst = false,
  placeholder,
  compact = false,
  alt = '',
}: {
  url: string | null;
  fit?: 'cover' | 'contain';
  className?: string;
  style?: CSSProperties;
  /** The official loader for this message (photo / video thumbnail); used when the CDN link fails. */
  resolve?: (force: boolean) => Promise<MediaResolution>;
  /** E2EE media: the CDN bytes are ciphertext, go through the official loader first. */
  resolveFirst?: boolean;
  placeholder?: ReactNode;
  compact?: boolean;
  alt?: string;
}) {
  const direct = resolveFirst ? null : mediaUrl(url);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading', src: direct });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setPhase({ kind: 'loading', src: direct });
    if (!direct) void fallback(false);
  }, [url, resolveFirst]);

  const fallback = async (force: boolean) => {
    if (!resolve) return setPhase({ kind: 'failed', reason: 'unavailable' });
    setPhase({ kind: 'loading', src: null });
    const r = await resolve(force);
    if (r.state === 'file') {
      const src = mediaFileUrl(r.path);
      if (src) return setPhase({ kind: 'loading', src: src + (force ? `&r=${attempt}` : '') });
    }
    setPhase({ kind: 'failed', reason: r.state === 'expired' ? 'expired' : 'unavailable' });
  };

  const retry = () => {
    setAttempt((a) => a + 1);
    if (direct && attempt === 0) setPhase({ kind: 'loading', src: `${direct}${direct.includes('?') ? '&' : '?'}retry=1` });
    else void fallback(true);
  };

  if (phase.kind === 'failed') {
    return (
      <div className={`remote-image media-failure ${compact ? 'is-compact' : ''} ${className}`} style={style}>
        <ImageOff size={compact ? 16 : 22} />
        {!compact && <span>{phase.reason === 'expired' ? 'Ảnh đã hết hạn' : 'Không tải được ảnh'}</span>}
        {phase.reason !== 'expired' && (
          <button className="btn btn-glass btn-small" onClick={(e) => { e.stopPropagation(); retry(); }} title="Thử lại">
            <RefreshCw size={12} /> {compact ? '' : 'Thử lại'}
          </button>
        )}
      </div>
    );
  }
  const src = phase.src;
  return (
    <div className={`remote-image ${className}`} style={style}>
      {(phase.kind === 'loading' || !src) && (placeholder ?? <div className="remote-image-placeholder"><Spinner size={14} /></div>)}
      {src && (
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{ objectFit: fit, opacity: phase.kind === 'ok' ? 1 : 0 }}
          onLoad={() => setPhase({ kind: 'ok', src })}
          onError={() => (direct && src.startsWith(direct) ? void fallback(false) : setPhase({ kind: 'failed', reason: 'unavailable' }))}
        />
      )}
    </div>
  );
}
