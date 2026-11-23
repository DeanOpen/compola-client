// Swift `RemoteImage` (+ `resolvingWith` / `onFailure`): a CDN image through the media scheme, falling back to the
// official loader (`resolveMedia`) when the link is dead, with an "expired / unavailable · retry" state.

import { ImageOff, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  /** Which source failed last: the CDN link first, then the official loader's file. */
  const stage = useRef<'direct' | 'resolved'>('direct');
  const forced = useRef(false);

  const fallback = async (force: boolean) => {
    stage.current = 'resolved';
    if (!resolve) return setPhase({ kind: 'failed', reason: 'unavailable' });
    setPhase({ kind: 'loading', src: null });
    const r = await resolve(force);
    const src = r.state === 'file' ? mediaFileUrl(r.path, 'image', force) : null;
    if (src) return setPhase({ kind: 'loading', src });
    setPhase({ kind: 'failed', reason: r.state === 'expired' ? 'expired' : 'unavailable' });
  };

  useEffect(() => {
    stage.current = 'direct';
    setPhase({ kind: 'loading', src: direct });
    if (!direct) void fallback(false);
  }, [url, resolveFirst]);

  /** The user's retry click: the CDN link again with `retry=1` (skips the scheme's failure cache), then the loader. */
  const retry = () => {
    forced.current = true;
    const again = resolveFirst ? null : mediaUrl(url, 'image', true);
    if (!again) return void fallback(true);
    stage.current = 'direct';
    setPhase({ kind: 'loading', src: again });
  };

  if (phase.kind === 'failed') {
    return (
      <div className={`remote-image media-failure ${compact ? 'is-compact' : ''} ${className}`} style={style}>
        <ImageOff size={compact ? 16 : 22} />
        {!compact && <span>{phase.reason === 'expired' ? 'Ảnh đã hết hạn' : 'Không tải được ảnh'}</span>}
        {phase.reason !== 'expired' && (
          <button
            className="btn btn-glass btn-small"
            onClick={(e) => {
              e.stopPropagation();
              retry();
            }}
            title="Thử lại"
            aria-label="Thử lại"
          >
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
          onError={() => (stage.current === 'direct' ? void fallback(forced.current) : setPhase({ kind: 'failed', reason: 'unavailable' }))}
        />
      )}
    </div>
  );
}
