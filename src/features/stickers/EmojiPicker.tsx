// The composer's emoji picker (wave 4, after Substack / Microsoft Loop): search, a category strip, "Gần đây" first,
// then the categories as sections; a click inserts the emoji at the caret and keeps the picker open.

import { Clock, Search, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { emojiCategories, recentEmojis, rememberEmoji, searchEmojis } from './emojiData';
import './stickers.css';

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(recentEmojis);
  const [active, setActive] = useState(recent.length ? 'recent' : emojiCategories[0].id);
  const body = useRef<HTMLDivElement>(null);
  const found = useMemo(() => (query.trim() ? searchEmojis(query) : null), [query]);

  const pick = (e: string) => {
    rememberEmoji(e);
    onPick(e);
    setRecent(recentEmojis());
  };
  const jump = (id: string) => {
    setActive(id);
    body.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: 'start' });
  };
  // Highlight the section on screen while scrolling.
  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    let current = active;
    for (const s of el.querySelectorAll<HTMLElement>('[data-section]')) if (s.getBoundingClientRect().top - top <= 24) current = s.dataset.section!;
    if (current !== active) setActive(current);
  };

  const grid = (items: string[]) => (
    <div className="ep-grid">
      {items.map((e) => (
        <button key={e} className="ep-cell" onClick={() => pick(e)} title={e} aria-label={e}>
          {e}
        </button>
      ))}
    </div>
  );

  return (
    <div className="emoji-picker">
      <div className="sp-search">
        <Search size={14} className="secondary" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm biểu tượng cảm xúc" aria-label="Tìm biểu tượng cảm xúc" autoFocus />
        {query && (
          <button className="icon-button sp-clear" onClick={() => setQuery('')} title="Xóa" aria-label="Xóa">
            <XCircle size={14} />
          </button>
        )}
      </div>
      {!found && (
        <div className="ep-tabs" role="tablist">
          {recent.length > 0 && (
            <button role="tab" aria-selected={active === 'recent'} className={`ep-tab ${active === 'recent' ? 'is-selected' : ''}`} title="Gần đây" onClick={() => jump('recent')}>
              <Clock size={15} />
            </button>
          )}
          {emojiCategories.map((c) => (
            <button key={c.id} role="tab" aria-selected={active === c.id} className={`ep-tab ${active === c.id ? 'is-selected' : ''}`} title={c.title} onClick={() => jump(c.id)}>
              {c.icon}
            </button>
          ))}
        </div>
      )}
      <div className="ep-body" ref={body} onScroll={onScroll}>
        {found ? (
          found.length ? (
            grid(found)
          ) : (
            <div className="sp-message">Không tìm thấy biểu tượng phù hợp.</div>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <section data-section="recent">
                <div className="ep-title">Gần đây</div>
                {grid(recent)}
              </section>
            )}
            {emojiCategories.map((c) => (
              <section key={c.id} data-section={c.id}>
                <div className="ep-title">{c.title}</div>
                {grid(c.items.map(([e]) => e))}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
