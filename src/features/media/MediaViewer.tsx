// Swift `MediaViewer` (+ ZoomableImageView, VideoPlayerView): a dark, Quick Look-style viewer over the window for chat
// photos and videos. Photos zoom and pan; videos get a full player. ← / → step through the conversation's shared photos
// and videos (the media store's list merged with the loaded messages), "Lưu về máy…" saves through `media_save`.
//
// Keys: Esc close · ← → previous / next · F full screen · photos: ⌘+ ⌘− ⌘0 ⌘9 · videos: Space play, ⇧← ⇧→ ±5 s,
// ↑ ↓ volume, M mute.
// Privacy: the viewer closes the moment its conversation is locked (hidden chat), the hidden state is unknown, or the
// account signs out.

import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { create } from 'zustand';
import { mediaFileUrl, mediaUrl } from '../../engine/media';
import { resolveMedia } from '../../engine/mediaResolver';
import { isEncryptedMedia, type ChatMessage } from '../../engine/models/chat';
import { saveMediaAs } from '../../engine/save';
import { galleryOf } from '../../engine/sharedMedia';
import { getEngine, isHidden, useEngine } from '../../engine/store';
import { useShell } from '../../shell/shellStore';
import { useEscape } from '../../ui/escape';
import { Spinner } from '../../ui/Spinner';
import { MediaFailure } from './MediaFailure';
import { VideoPlayer, type VideoPlayerHandle } from './VideoPlayer';
import { ZoomableImage, ZoomControls, zoom } from './ZoomableImage';
import { daySeparator, time } from '../chat/format';
import './media.css';

export type ViewerItem = { kind: 'photo' | 'video'; url: string | null; file?: string; message: ChatMessage };

interface ViewerState {
  items: ViewerItem[];
  index: number;
}

const useViewer = create<ViewerState>()(() => ({ items: [], index: -1 }));

const itemOf = (m: ChatMessage): ViewerItem | null => {
  if (m.kind.type === 'photo') return { kind: 'photo', url: m.kind.url, message: m };
  if (m.kind.type === 'video') return { kind: 'video', url: m.kind.url, message: m };
  return null;
};

/** Opens the viewer on `item`, with the conversation's other photos / videos one arrow key away. */
export const openViewer = (item: ViewerItem) => {
  const conv = item.message.conversationId;
  const gallery = galleryOf(conv, getEngine().messages[conv] ?? [])
    .map(itemOf)
    .filter((x): x is ViewerItem => !!x);
  let index = gallery.findIndex((g) => g.message.id === item.message.id);
  if (index < 0) {
    gallery.splice(0, gallery.length, item);
    index = 0;
  } else gallery[index] = item; // keeps the resolved file of the opener
  useViewer.setState({ items: gallery, index });
};

export const closeViewer = () => useViewer.setState({ items: [], index: -1 });

const step = (delta: number) =>
  useViewer.setState((s) => {
    const index = s.index + delta;
    return index >= 0 && index < s.items.length ? { index } : s;
  });

/** The viewer may only stay open while its conversation is readable. */
const useMustClose = (conversationId: string | null) => {
  const locked = useEngine((s) => (conversationId ? isHidden(s, conversationId) : false));
  const unlocked = useShell((s) => (conversationId ? (s.unlockedHiddenIds?.includes(conversationId) ?? false) : false));
  const hiddenKnown = useEngine((s) => s.conversationActions.hiddenKnown);
  const signedIn = useEngine((s) => s.profile !== null && s.phase.kind === 'ready');
  return !!conversationId && ((locked && !unlocked) || !hiddenKnown || !signedIn);
};

export function MediaViewerHost() {
  const { items, index } = useViewer();
  const item = index >= 0 ? items[index] : null;
  const mustClose = useMustClose(item?.message.conversationId ?? null);
  useEscape(!!item, closeViewer);
  useEffect(() => {
    if (mustClose) closeViewer();
  }, [mustClose]);
  if (!item || mustClose) return null;
  return <Viewer item={item} index={index} count={items.length} />;
}

function Viewer({ item, index, count }: { item: ViewerItem; index: number; count: number }) {
  const root = useRef<HTMLDivElement>(null);
  const player = useRef<VideoPlayerHandle>(null);
  const [barsVisible, setBarsVisible] = useState(true);
  const [fullScreen, setFullScreen] = useState(false);
  const conversationName = useEngine((s) => {
    const id = item.message.conversationId;
    if (id === s.selfConversationId) return 'Cloud của tôi';
    return s.conversations.find((c) => c.id === id)?.name ?? null;
  });

  const toggleFullScreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.current?.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const onChange = () => setFullScreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Keys go to the viewer only (capture phase), never to the chat or the list behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.key === 'Escape') return;
      const cmd = e.metaKey || e.ctrlKey;
      let handled = true;
      if (cmd && !e.altKey) {
        if (item.kind !== 'photo') return;
        if (e.key === '+' || e.key === '=') zoom.zoomIn();
        else if (e.key === '-' || e.key === '_') zoom.zoomOut();
        else if (e.key === '0') zoom.actualSize();
        else if (e.key === '9') zoom.fit();
        else handled = false;
      } else if (e.altKey || cmd) {
        handled = false;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey && item.kind === 'video') player.current?.skip(delta * 5);
        else step(delta);
      } else if (e.key === 'f' || e.key === 'F') {
        if (!e.repeat) toggleFullScreen();
      } else if (item.kind === 'video' && player.current) {
        if (e.key === ' ') !e.repeat && player.current.togglePlay();
        else if (e.key === 'ArrowUp') player.current.adjustVolume(0.1);
        else if (e.key === 'ArrowDown') player.current.adjustVolume(-0.1);
        else if (e.key === 'm' || e.key === 'M') !e.repeat && player.current.toggleMute();
        else handled = false;
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [item, toggleFullScreen]);

  const m = item.message;
  const who = m.isMine ? 'Bạn' : m.senderName || (item.kind === 'photo' ? 'Ảnh' : 'Video');
  const subtitle = [`${daySeparator(m.date)} · ${time(m.date)}`, conversationName && conversationName !== who ? conversationName : null]
    .filter(Boolean)
    .join(' · ');
  const showBars = item.kind === 'photo' || barsVisible;

  const save = () => {
    const source = item.url ?? (item.file ? 'file://' + item.file : null);
    if (!source) return;
    const d = new Date(m.date);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
    void saveMediaAs(source, `${item.kind === 'photo' ? 'Ảnh' : 'Video'} ${stamp}.${item.kind === 'photo' ? 'jpg' : 'mp4'}`, null);
  };

  return (
    <div ref={root} className={`mv-root fade-in ${item.kind === 'photo' ? 'is-photo' : 'is-video'}`} role="dialog" aria-modal aria-label={who}>
      <div className="mv-stage">
        {item.kind === 'photo' ? (
          <PhotoStage key={m.id} item={item} />
        ) : (
          <VideoStage key={m.id} item={item} player={player} onBarsVisible={setBarsVisible} fullScreen={{ isOn: fullScreen, toggle: toggleFullScreen }} />
        )}
      </div>

      <div className={`mv-topbar ${showBars ? '' : 'mv-hidden'}`} onPointerEnter={() => setBarsVisible(true)}>
        <div className="mv-info">
          <div className="mv-who truncate">{who}</div>
          <div className="mv-when truncate">{subtitle}</div>
        </div>
        {count > 1 && (
          <div className="mv-counter nums" aria-label={`${index + 1} trên ${count}`}>
            {index + 1} / {count}
          </div>
        )}
        <div className="mv-spacer" />
        {item.kind === 'photo' && <ZoomControls />}
        <div className="mv-group">
          <button className="mv-icon" onClick={save} disabled={!item.url && !item.file} title="Lưu về máy…" aria-label="Lưu về máy…">
            <Download size={15} />
          </button>
          <button className="mv-icon" onClick={closeViewer} title="Đóng (Esc)" aria-label="Đóng">
            <X size={16} />
          </button>
        </div>
      </div>

      {index > 0 && (
        <button className={`mv-nav is-prev ${showBars ? '' : 'mv-hidden'}`} onClick={() => step(-1)} title="Trước (←)" aria-label="Ảnh hoặc video trước">
          <ChevronLeft size={22} />
        </button>
      )}
      {index < count - 1 && (
        <button className={`mv-nav is-next ${showBars ? '' : 'mv-hidden'}`} onClick={() => step(1)} title="Tiếp theo (→)" aria-label="Ảnh hoặc video tiếp theo">
          <ChevronRight size={22} />
        </button>
      )}
    </div>
  );
}

/** A chat photo through the media scheme; E2EE or dead links go through the official loader (`resolveMedia`). */
function PhotoStage({ item }: { item: ViewerItem }) {
  const m = item.message;
  const encrypted = isEncryptedMedia(m, item.url);
  const direct = item.file ? mediaFileUrl(item.file) : encrypted ? null : mediaUrl(item.url);
  const [src, setSrc] = useState<string | null>(direct);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'expired' | 'failed'>('loading');
  const tried = useRef(false);

  const fallback = useCallback(
    async (force: boolean) => {
      setPhase('loading');
      setSrc(null);
      const r = await resolveMedia(m.conversationId, m.id, 'photo', force);
      const file = r.state === 'file' ? mediaFileUrl(r.path) : null;
      if (file) setSrc(file);
      else setPhase(r.state === 'expired' ? 'expired' : 'failed');
    },
    [m.conversationId, m.id],
  );

  useEffect(() => {
    if (!direct) void fallback(false);
  }, []);

  const onError = () => {
    if (!tried.current && src === direct) {
      tried.current = true;
      void fallback(false);
    } else setPhase('failed');
  };

  if (phase === 'expired' || phase === 'failed') {
    return (
      <MediaFailure
        expired={phase === 'expired'}
        retry={() => {
          if (direct && !tried.current) setSrc(`${direct}${direct.includes('?') ? '&' : '?'}retry=1`);
          else void fallback(true);
          setPhase('loading');
        }}
      />
    );
  }
  return (
    <>
      {src && <ZoomableImage key={src} src={src} onError={onError} onLoad={() => setPhase('ok')} />}
      {phase === 'loading' && (
        <div className="mv-center">
          <Spinner size={28} />
        </div>
      )}
    </>
  );
}

/** A video: its CDN link streamed with `flavour=cors`, or the official download for E2EE / linkless videos. */
function VideoStage({
  item,
  player,
  onBarsVisible,
  fullScreen,
}: {
  item: ViewerItem;
  player: RefObject<VideoPlayerHandle | null>;
  onBarsVisible: (v: boolean) => void;
  fullScreen: { isOn: boolean; toggle: () => void };
}) {
  const m = item.message;
  const encrypted = isEncryptedMedia(m, item.url);
  const initial = useMemo(
    () => (item.file ? mediaFileUrl(item.file, 'video') : item.url && !encrypted ? mediaUrl(item.url, 'video') : null),
    [item.file, item.url, encrypted],
  );
  const [src, setSrc] = useState<string | null>(initial);
  const [failed, setFailed] = useState<'expired' | 'failed' | null>(null);

  const resolve = useCallback(
    async (force: boolean) => {
      setFailed(null);
      const r = await resolveMedia(m.conversationId, m.id, 'video', force);
      const file = r.state === 'file' ? mediaFileUrl(r.path, 'video') : null;
      if (file) setSrc(file);
      else setFailed(r.state === 'expired' ? 'expired' : 'failed');
    },
    [m.conversationId, m.id],
  );

  useEffect(() => {
    if (!initial) void resolve(false);
  }, []);

  if (failed) return <MediaFailure expired={failed === 'expired'} video retry={() => void resolve(true)} />;
  if (!src)
    return (
      <div className="mv-center">
        <Spinner size={28} />
      </div>
    );
  return <VideoPlayer ref={player} src={src} onBarsVisible={onBarsVisible} fullScreen={fullScreen} />;
}
