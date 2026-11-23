// The sticker picker (popover of the composer's sticker button) and the suggestion strip above the input (Swift
// StickerPicker.swift). Official counterparts: the sticker dock (tabs = recent first, then the downloaded sets; search
// debounced 500 ms) and the suggestion popover (horizontal stickers; Esc hides it; a click sends the sticker and clears
// the typed text). Everything comes from the official sticker services (engine/stickers.ts); a send happens only on a click.

import { Clock, Search, Smile, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../../engine/media';
import { getEngine } from '../../engine/store';
import {
  recentTabId,
  searchStickers,
  sendSticker,
  stickersInTab,
  stickerTabs,
  type StickerEntry,
  type StickerSource,
  type StickerTab,
} from '../../engine/stickers';
import { Spinner } from '../../ui/Spinner';
import './stickers.css';

/** "Cuộc trò chuyện chưa sẵn sàng…": a click while another conversation is on screen. */
export const stickerNotReady = 'Cuộc trò chuyện chưa sẵn sàng, hãy thử lại sau giây lát.';

/** A sticker picture: the still picture; where there is an animated source it plays while hovered (`animates`). */
export function StickerThumb({ sticker, size = 64, animates = true }: { sticker: StickerEntry; size?: number; animates?: boolean }) {
  const [hover, setHover] = useState(false);
  const [failed, setFailed] = useState(false);
  const still = mediaUrl(sticker.url);
  const anim = animates && hover ? sticker.animation : null;
  return (
    <span className="sticker-thumb" style={{ width: size, height: size }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {failed || !still ? (
        <Smile size={20} className="tertiary" />
      ) : anim?.kind === 'sprite' ? (
        <SpritePlayer url={anim.url} frames={anim.frames} frameMs={anim.frameMs} size={size} />
      ) : (
        <img src={(anim?.kind === 'animated' && mediaUrl(anim.url)) || still} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

/** Plays a sprite sheet (`frames` equal pictures side by side) in a loop by moving the background. */
function SpritePlayer({ url, frames, frameMs, size }: { url: string; frames: number; frameMs: number; size: number }) {
  const [tick, setTick] = useState(0);
  const src = mediaUrl(url);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), Math.max(frameMs, 30));
    return () => clearInterval(t);
  }, [frameMs]);
  return (
    <span
      className="sticker-sprite"
      style={{
        width: size,
        height: size,
        backgroundImage: src ? `url("${src}")` : undefined,
        backgroundSize: `${frames * 100}% 100%`,
        backgroundPosition: `${((tick % frames) / Math.max(frames - 1, 1)) * 100}% 0`,
      }}
    />
  );
}

type Load = 'loading' | 'ready' | 'failed';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function StickerPicker({ conversationId, onSent }: { conversationId: string; onSent: () => void }) {
  const [tabs, setTabs] = useState<StickerTab[]>([]);
  const [tabsState, setTabsState] = useState<Load>('loading');
  const [selected, setSelected] = useState<number | null>(null);
  const [stickers, setStickers] = useState<StickerEntry[]>([]);
  const [gridState, setGridState] = useState<Load>('loading');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<StickerEntry[] | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;

  // The sticker service may not be resolved right after launch: a few tries, then say so.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const list = await stickerTabs();
        if (cancelled) return;
        if (list) {
          setTabs(list);
          setSelected((s) => (s !== null && list.some((t) => t.id === s) ? s : (list[0]?.id ?? null)));
          return setTabsState('ready');
        }
        if (attempt < 2) await wait(1500);
      }
      if (!cancelled) setTabsState('failed');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    setGridState('loading');
    setStickers([]);
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const list = await stickersInTab(selected);
        if (cancelled) return;
        if (list) {
          setStickers(list);
          return setGridState('ready');
        }
        if (attempt < 1) await wait(1500);
      }
      if (!cancelled) setGridState('failed');
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Official dock search: 500 ms after the last keystroke.
  useEffect(() => {
    const text = query.trim();
    setFound(null);
    setSearchFailed(false);
    if (!text) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void searchStickers(text).then((r) => {
        if (cancelled) return;
        if (r) setFound(r);
        else setSearchFailed(true);
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const send = async (sticker: StickerEntry, source: StickerSource) => {
    if (sending) return;
    // The conversation on screen is not the one this picker was opened for: nothing is sent.
    if (getEngine().openConversationId !== conversationId) return setError(stickerNotReady);
    setSending(sticker.key);
    setError(null);
    const outcome = await sendSticker(sticker, conversationId, source);
    setSending(null);
    if (outcome.kind === 'done') onSent();
    else if ('text' in outcome && typeof outcome.text === 'string') setError(outcome.text);
  };

  const message = (text: string) => <div className="sp-message">{text}</div>;
  const spinner = (
    <div className="sp-message">
      <Spinner size={16} />
    </div>
  );
  const grid = (items: StickerEntry[], source: StickerSource) => (
    <div className="sp-grid" key={source === 'search' ? 'search' : `tab-${selected}`}>
      {items.map((s) => (
        <button
          key={s.key}
          className="sp-cell"
          disabled={sending !== null}
          style={{ opacity: sending === s.key ? 0.4 : 1 }}
          title="Gửi sticker này"
          aria-label="Sticker"
          onClick={() => void send(s, source)}
        >
          <StickerThumb sticker={s} />
        </button>
      ))}
    </div>
  );

  let content;
  if (searching) {
    content = found ? (found.length ? grid(found, 'search') : message('Không có Sticker phù hợp. Vui lòng thử từ khóa khác.')) : searchFailed ? message('Không tìm được sticker. Hãy thử lại sau.') : spinner;
  } else if (tabsState === 'loading') content = spinner;
  else if (tabsState === 'failed') content = message('Không tải được danh sách sticker. Hãy thử lại sau.');
  else if (tabs.length === 0) content = message('Bạn chưa có bộ sticker nào.');
  else if (gridState === 'loading') content = spinner;
  else if (gridState === 'failed') content = message('Không tải được bộ sticker này. Hãy thử lại sau.');
  else if (stickers.length === 0) content = message('Bộ sticker này chưa có sticker nào.');
  else content = grid(stickers, selected === recentTabId ? 'recent' : 'category');

  return (
    <div className="sticker-picker">
      <div className="sp-search">
        <Search size={14} className="secondary" />
        <input
          ref={searchField}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tìm kiếm sticker"
          title="Gõ từ khóa để tìm Sticker"
          aria-label="Tìm kiếm sticker"
          autoFocus
        />
        {query && (
          <button className="icon-button sp-clear" onClick={() => setQuery('')} title="Xóa" aria-label="Xóa">
            <XCircle size={14} />
          </button>
        )}
      </div>
      <div className="sp-content">{content}</div>
      {error && <div className="sp-error">{error}</div>}
      {!searching && tabsState === 'ready' && tabs.length > 0 && (
        <div className="sp-tabs" role="tablist">
          {tabs.map((t) => {
            const name = t.id === recentTabId ? 'Gần đây' : t.name;
            const icon = t.icon ? mediaUrl(t.icon) : null;
            return (
              <button key={t.id} role="tab" aria-selected={selected === t.id} className={`sp-tab ${selected === t.id ? 'is-selected' : ''}`} title={name} aria-label={name} onClick={() => setSelected(t.id)}>
                {t.id === recentTabId ? <Clock size={16} /> : icon ? <img src={icon} alt="" draggable={false} /> : <Smile size={16} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Stickers suggested for the text being typed; Esc (the composer) or × hides it. */
export function TypingStickerStrip({
  stickers,
  sending,
  pick,
  dismiss,
}: {
  stickers: StickerEntry[];
  sending: string | null;
  pick: (s: StickerEntry, index: number) => void;
  dismiss: () => void;
}) {
  return (
    <div className="typing-stickers slide-up" role="group" aria-label="Gợi ý Sticker">
      <div className="typing-stickers-list">
        {stickers.map((s, i) => (
          <button
            key={s.key}
            className="sp-cell"
            disabled={sending !== null}
            style={{ opacity: sending === s.key ? 0.4 : 1 }}
            title="Gửi sticker này"
            aria-label="Gửi sticker gợi ý"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(s, i)}
          >
            <StickerThumb sticker={s} size={56} animates={false} />
          </button>
        ))}
      </div>
      <button className="icon-button" onClick={dismiss} title="Bấm phím Esc để ẩn" aria-label="Ẩn gợi ý">
        <X size={14} />
      </button>
    </div>
  );
}
