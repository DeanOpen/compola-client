import { Search, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { shell, useShell } from '../../shell/shellStore';

/** Glass search capsule above the conversation list. Focuses on ⌘F / ⌥⌘F; Esc clears it, then leaves it. */
export function SearchField() {
  const search = useShell((s) => s.search);
  const focusTick = useShell((s) => s.searchFocusTick);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusTick) ref.current?.focus();
  }, [focusTick]);
  return (
    <label className="search-field glass">
      <Search size={13} className="secondary" />
      <input
        ref={ref}
        value={search}
        placeholder="Tìm kiếm"
        spellCheck={false}
        onChange={(e) => shell.setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (search) shell.setSearch('');
            else ref.current?.blur();
          }
        }}
        aria-label="Tìm kiếm"
      />
      {search ? (
        <button className="icon-button" onClick={() => shell.setSearch('')} title="Xoá" aria-label="Xoá nội dung tìm kiếm">
          <XCircle size={14} fill="currentColor" stroke="var(--content)" />
        </button>
      ) : (
        <span className="search-hint" aria-hidden>
          ⌘K
        </span>
      )}
    </label>
  );
}
