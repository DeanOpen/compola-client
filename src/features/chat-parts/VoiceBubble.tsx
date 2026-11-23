// Wave 3 #7 (Instagram voice message): play / pause, a waveform whose played part is coloured, elapsed / duration.
// Audio streams through the media scheme (`flavour=cors`, Range requests), so playback starts before the download ends.

import { Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { mediaUrl } from '../../engine/media';
import './chatParts.css';

export interface VoiceBubbleProps {
  url: string | null;
  /** Seconds (from the message; the element's own duration wins once known). */
  duration: number;
  isMine: boolean;
  className?: string;
}

const BARS = 34;

/** Deterministic bar heights (0.18 – 1) from the URL, smoothed so it reads like speech. */
export const waveformFor = (seed: string, bars = BARS): number[] => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const raw: number[] = [];
  for (let i = 0; i < bars; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    raw.push((h % 1000) / 1000);
  }
  return raw.map((v, i) => {
    const prev = raw[i - 1] ?? v;
    const next = raw[i + 1] ?? v;
    const envelope = Math.sin(((i + 0.5) / bars) * Math.PI) * 0.45 + 0.55;
    return Math.max(0.18, Math.min(1, ((prev + v * 2 + next) / 4) * envelope * 1.35));
  });
};

export const clockText = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function VoiceBubble({ url, duration, isMine, className = '' }: VoiceBubbleProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState(duration);
  const [failed, setFailed] = useState(false);
  const src = mediaUrl(url, 'audio');
  const bars = useMemo(() => waveformFor(url ?? 'voice'), [url]);
  const progress = total > 0 ? Math.min(1, elapsed / total) : 0;

  useEffect(() => {
    setPlaying(false);
    setElapsed(0);
    setFailed(false);
    setTotal(duration);
  }, [url, duration]);

  const toggle = () => {
    const a = audio.current;
    if (!a || !src) return;
    if (a.paused) {
      // One voice message at a time.
      document.querySelectorAll('audio.voice-audio').forEach((el) => el !== a && (el as HTMLAudioElement).pause());
      a.play().catch(() => setFailed(true));
    } else a.pause();
  };

  const seek = (e: MouseEvent<HTMLDivElement>) => {
    const a = audio.current;
    if (!a || !total) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
    a.currentTime = t;
    setElapsed(t);
    if (a.paused) toggle();
  };

  return (
    <div className={`voice-bubble ${isMine ? 'is-mine' : ''} ${className}`}>
      <button className="voice-play" onClick={toggle} disabled={!src || failed} aria-label={playing ? 'Tạm dừng' : 'Phát tin nhắn thoại'}>
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" style={{ marginLeft: 2 }} />}
      </button>
      <div className="voice-wave" onClick={seek} role="slider" aria-label="Tiến trình" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(elapsed)}>
        {bars.map((b, i) => (
          <span key={i} className={`voice-bar ${(i + 0.5) / bars.length <= progress ? 'is-played' : ''}`} style={{ height: `${Math.round(b * 100)}%` }} />
        ))}
      </div>
      <span className="voice-time nums">{failed ? 'Lỗi' : clockText(playing || elapsed > 0 ? elapsed : total)}</span>
      {src && (
        <audio
          ref={audio}
          className="voice-audio"
          src={src}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setElapsed(0);
          }}
          onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0 && setTotal(e.currentTarget.duration)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
