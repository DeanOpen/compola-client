// Swift `MediaViewer` (+ ZoomableImageView, VideoPlayerView): a dark, Quick Look-style viewer over the window for chat
// photos and videos. Photos zoom and pan; videos get a full player. ← / → step through the conversation's shared photos
// and videos (the media store's list merged with the loaded messages), "Lưu về máy…" saves through `media_save`.
//
// Wave 4 (Mobbin: Care.com / Savee lightbox filmstrip, Meetup's counter + labelled actions), Zalo PC dark: flat bars,
// the sender's avatar, a "1 / N" counter, "Xem trong trò chuyện" / "Chia sẻ" / "Mở bằng ứng dụng khác" / "Lưu về máy…",
// and a filmstrip of the conversation's photos and videos along the bottom.
//
// Keys: Esc close · ← → previous / next · F full screen · photos: ⌘+ ⌘− ⌘0 ⌘9 · videos: Space play, ⇧← ⇧→ ±5 s,
// ↑ ↓ volume, M mute.
// Privacy: the viewer closes the moment its conversation is locked (hidden chat), the hidden state is unknown, or the
// account signs out.

import { ChevronLeft, ChevronRight, Download, ExternalLink, Film, Forward, ImageOff, MessageSquareText, Play, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { create } from 'zustand';
import { mediaFileUrl, mediaUrl } from '../../engine/media';
import { resolveMedia } from '../../engine/mediaResolver';
import { isEncryptedMedia, type ChatMessage } from '../../engine/models/chat';
import { requestForward } from '../../engine/messageActions';
import { requestJumpToMessage } from '../../engine/messageJump';
import { openMediaExternally, saveMediaAs } from '../../engine/save';
import { galleryOf } from '../../engine/sharedMedia';
import { getEngine, isHidden, useEngine } from '../../engine/store';
import { useShell } from '../../shell/shellStore';
import { Avatar } from '../../ui/Avatar';
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
  return <Viewer item={item} index={index} items={items} />;
}

function Viewer({ item, index, items }: { item: ViewerItem; index: number; items: ViewerItem[] }) {
  const count = items.length;
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

  const source = item.url ?? (item.file ? 'file://' + item.file : null);
  const fileName = () => {
    const d = new Date(m.date);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
    return `${item.kind === 'photo' ? 'Ảnh' : 'Video'} ${stamp}.${item.kind === 'photo' ? 'jpg' : 'mp4'}`;
  };
  const save = () => source && void saveMediaAs(source, fileName(), null);
  const openElsewhere = () => source && void openMediaExternally(source, fileName(), null);
  // The chat (or its forward sheet) is behind the viewer: close it first.
  const showInChat = () => {
    closeViewer();
    void requestJumpToMessage(m.conversationId, m.id, m.date);
  };
  const forward = () => {
    closeViewer();
    requestForward(m);
  };
  const canForward = m.menu.forward === 'available';
  const hasStrip = count > 1;

  return (
    <div
      ref={root}
      className={`mv-root fade-in ${item.kind === 'photo' ? 'is-photo' : 'is-video'} ${hasStrip ? 'has-strip' : ''} ${fullScreen ? 'is-fullscreen' : ''}`}
      role="dialog"
      aria-modal
      aria-label={who}
    >
      <div className="mv-stage">
        {item.kind === 'photo' ? (
          <PhotoStage key={m.id} item={item} />
        ) : (
          <VideoStage key={m.id} item={item} player={player} onBarsVisible={setBarsVisible} fullScreen={{ isOn: fullScreen, toggle: toggleFullScreen }} />
        )}
      </div>

      <div className={`mv-topbar ${showBars ? '' : 'mv-hidden'}`} onPointerEnter={() => setBarsVisible(true)}>
        <div className="mv-info">
          <Avatar url={m.isMine ? null : m.senderAvatar} name={who} size={32} />
          <div className="mv-info-text">
            <div className="mv-who truncate">{who}</div>
            <div className="mv-when truncate">{subtitle}</div>
          </div>
        </div>
        {count > 1 && (
          <div className="mv-counter nums" aria-label={`${index + 1} trên ${count}`}>
            {index + 1} / {count}
          </div>
        )}
        <div className="mv-spacer" />
        {item.kind === 'photo' && <ZoomControls />}
        <div className="mv-group mv-actions">
          <button className="mv-icon" onClick={showInChat} title="Xem trong trò chuyện" aria-label="Xem trong trò chuyện">
            <MessageSquareText size={16} />
          </button>
          <button className="mv-icon" onClick={forward} disabled={!canForward} title="Chia sẻ" aria-label="Chia sẻ">
            <Forward size={16} />
          </button>
          <button className="mv-icon" onClick={openElsewhere} disabled={!source} title="Mở bằng ứng dụng khác" aria-label="Mở bằng ứng dụng khác">
            <ExternalLink size={15} />
          </button>
          <button className="mv-icon" onClick={save} disabled={!source} title="Lưu về máy…" aria-label="Lưu về máy…">
            <Download size={16} />
          </button>
          <span className="mv-divider" aria-hidden />
          <button className="mv-icon" onClick={closeViewer} title="Đóng (Esc)" aria-label="Đóng">
            <X size={18} />
          </button>
        </div>
      </div>

      {hasStrip && <Filmstrip items={items} index={index} hidden={!showBars} />}

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

/** The conversation's photos and videos along the bottom; the current one framed in blue and kept in view. */
function Filmstrip({ items, index, hidden }: { items: ViewerItem[]; index: number; hidden: boolean }) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('.mv-thumb.is-current');
    const box = strip.current;
    if (!el || !box) return;
    const left = el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2;
    box.scrollTo({ left, behavior: 'smooth' });
  }, [index]);
  return (
    <div className={`mv-filmstrip ${hidden ? 'mv-hidden' : ''}`} role="listbox" aria-label="Ảnh và video trong cuộc trò chuyện">
      <div className="mv-filmstrip-track" ref={strip}>
        {items.map((it, i) => (
          <button
            key={it.message.id}
            role="option"
            aria-selected={i === index}
            className={`mv-thumb ${i === index ? 'is-current' : ''}`}
            onClick={() => useViewer.setState({ index: i })}
            title={`${it.message.isMine ? 'Bạn' : it.message.senderName} · ${daySeparator(it.message.date)} ${time(it.message.date)}`}
          >
            <Thumb item={it} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Thumb({ item }: { item: ViewerItem }) {
  const k = item.message.kind;
  const encrypted = isEncryptedMedia(item.message, item.url);
  const src =
    item.kind === 'photo'
      ? item.file
        ? mediaFileUrl(item.file)
        : encrypted
          ? null
          : mediaUrl(item.url)
      : k.type === 'video' && !encrypted
        ? mediaUrl(k.thumbnail)
        : null;
  const [failed, setFailed] = useState(false);
  return (
    <>
      {src && !failed ? (
        <img src={src} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="mv-thumb-empty">{item.kind === 'video' ? <Film size={16} /> : <ImageOff size={16} />}</span>
      )}
      {item.kind === 'video' && (
        <span className="mv-thumb-play">
          <Play size={10} fill="currentColor" />
        </span>
      )}
    </>
  );
}
