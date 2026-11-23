// Swift `VideoPlayerView` + `VideoPlayback`: the picture, a click to play or pause, and a glass control bar (play,
// scrubber, time, volume, full screen) that fades while the video plays and the pointer rests. Volume / mute persist
// (`compola.video.volume`, `compola.video.muted`). The source streams through `compola-media` with `flavour=cors` (Range).

import { AlertTriangle, Maximize2, Minimize2, Pause, Play, RotateCcw, Volume1, Volume2, VolumeX } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Spinner } from '../../ui/Spinner';

export const failureMessage = 'Không thể phát video này.';

/** "1:05" / "1:02:03" (Swift `VideoPlayback.timeString`). */
export const timeString = (seconds: number) => {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

const readNumber = (key: string, fallback: number) => {
  try {
    const v = localStorage.getItem(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};

export interface VideoPlayerHandle {
  togglePlay: () => void;
  skip: (seconds: number) => void;
  adjustVolume: (delta: number) => void;
  toggleMute: () => void;
}

export const VideoPlayer = forwardRef<
  VideoPlayerHandle,
  { src: string; onBarsVisible?: (visible: boolean) => void; fullScreen?: { isOn: boolean; toggle: () => void } }
>(function VideoPlayer({ src, onBarsVisible, fullScreen }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(() => Math.min(1, Math.max(0, readNumber('compola.video.volume', 1))));
  const [muted, setMuted] = useState(() => readNumber('compola.video.muted', 0) === 1);
  const [hasVideo, setHasVideo] = useState(true);
  const [barsVisible, setBarsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overBar = useRef(false);
  const scrubbing = useRef(false);

  const displayedVolume = muted ? 0 : volume;

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setBarsVisible(true);
    hideTimer.current = setTimeout(() => {
      if (!overBar.current && video.current && !video.current.paused) setBarsVisible(false);
    }, 2500);
  }, []);

  useEffect(() => {
    onBarsVisible?.(barsVisible || status !== 'ready');
  }, [barsVisible, status, onBarsVisible]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v || status !== 'ready') return;
    if (v.paused || v.ended) {
      if (v.ended) v.currentTime = 0;
      void v.play().catch(() => {});
    } else v.pause();
    scheduleHide();
  }, [status, scheduleHide]);

  const setVolume = useCallback((value: number) => {
    const clamped = Math.min(1, Math.max(0, value));
    setVolumeState(clamped);
    setMuted(clamped === 0);
    write('compola.video.volume', String(clamped));
    write('compola.video.muted', clamped === 0 ? '1' : '0');
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      write('compola.video.muted', next ? '1' : '0');
      if (!next && volume === 0) setVolumeState(0.5);
      return next;
    });
    scheduleHide();
  }, [volume, scheduleHide]);

  useImperativeHandle(
    ref,
    () => ({
      togglePlay,
      skip: (s) => {
        const v = video.current;
        if (!v || !Number.isFinite(v.duration)) return;
        v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + s));
        scheduleHide();
      },
      adjustVolume: (d) => {
        setVolume(displayedVolume + d);
        scheduleHide();
      },
      toggleMute,
    }),
    [togglePlay, toggleMute, setVolume, displayedVolume, scheduleHide],
  );

  const VolumeIcon = displayedVolume === 0 ? VolumeX : displayedVolume < 0.5 ? Volume1 : Volume2;
  const playLabel = ended ? 'Phát lại' : playing ? 'Tạm dừng' : 'Phát';

  return (
    <div className={`mv-player ${barsVisible || status !== 'ready' ? '' : 'is-idle'}`} onPointerMove={scheduleHide}>
      <video
        ref={video}
        src={src}
        autoPlay
        playsInline
        style={{ opacity: hasVideo && status !== 'failed' ? 1 : 0 }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDuration(Number.isFinite(v.duration) ? v.duration : 0);
          setHasVideo(v.videoWidth > 0);
          setStatus('ready');
        }}
        onDurationChange={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        onTimeUpdate={(e) => !scrubbing.current && setTime(e.currentTarget.currentTime)}
        onPlay={() => {
          setPlaying(true);
          setEnded(false);
          scheduleHide();
        }}
        onPause={() => {
          setPlaying(false);
          setBarsVisible(true);
        }}
        onEnded={() => {
          setEnded(true);
          setPlaying(false);
          setBarsVisible(true);
        }}
        onError={() => setStatus('failed')}
        onClick={togglePlay}
      />
      {status === 'loading' && (
        <div className="mv-center">
          <Spinner size={28} />
        </div>
      )}
      {status === 'failed' && (
        <div className="mv-center mv-failure">
          <AlertTriangle size={28} />
          <span>{failureMessage}</span>
        </div>
      )}
      {status === 'ready' && (
        <div
          className="mv-controls"
          onPointerEnter={() => (overBar.current = true)}
          onPointerLeave={() => {
            overBar.current = false;
            scheduleHide();
          }}
        >
          <button className="mv-icon is-large" onClick={togglePlay} title={playLabel + (ended ? '' : ' (Dấu cách)')} aria-label={playLabel}>
            {ended ? <RotateCcw size={16} /> : playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
          <div className="mv-capsule mv-scrubber">
            <span className="nums">{timeString(time)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.01}
              value={Math.min(time, Math.max(duration, 0.1))}
              disabled={duration <= 0}
              aria-label="Vị trí phát"
              aria-valuetext={`${timeString(time)} trên ${timeString(duration)}`}
              style={{ ['--fill' as string]: `${duration > 0 ? (time / duration) * 100 : 0}%` }}
              onPointerDown={() => (scrubbing.current = true)}
              onPointerUp={() => (scrubbing.current = false)}
              onChange={(e) => {
                const t = Number(e.currentTarget.value);
                setTime(t);
                if (video.current) video.current.currentTime = t;
              }}
            />
            <span className="nums secondary-on-dark">{timeString(duration)}</span>
          </div>
          <div className="mv-capsule mv-volume">
            <button className="mv-plain" onClick={toggleMute} title={(displayedVolume === 0 ? 'Bật tiếng' : 'Tắt tiếng') + ' (M)'} aria-label={displayedVolume === 0 ? 'Bật tiếng' : 'Tắt tiếng'}>
              <VolumeIcon size={15} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={displayedVolume}
              title="Âm lượng (↑ ↓)"
              aria-label="Âm lượng"
              aria-valuetext={`${Math.round(displayedVolume * 100)} phần trăm`}
              style={{ ['--fill' as string]: `${displayedVolume * 100}%` }}
              onChange={(e) => setVolume(Number(e.currentTarget.value))}
            />
          </div>
          {fullScreen && (
            <button
              className="mv-icon is-large"
              onClick={fullScreen.toggle}
              title={(fullScreen.isOn ? 'Thoát toàn màn hình' : 'Toàn màn hình') + ' (F)'}
              aria-label={fullScreen.isOn ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
            >
              {fullScreen.isOn ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
