import { Search, X, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { displayName } from '../../engine/models/conversations';
import { useEngine } from '../../engine/store';
import { shell, useShell } from '../../shell/shellStore';

/**
 * Glass search capsule above the conversation list. Focuses on ⌘F / ⌥⌘F; Esc clears it, then leaves it. Limited to one
 * conversation ("Tìm kiếm tin nhắn" in the chat header) it shows that conversation as a chip; Esc on empty text drops it.
 */
export function SearchField() {
  const search = useShell((s) => s.search);
  const scope = useShell((s) => s.searchScope);
  const scopeName = useEngine((s) => {
    const c = scope ? s.conversations.find((c) => c.id === scope) : null;
    return c ? displayName(c) : scope ? 'Cuộc trò chuyện' : null;
  });
  const focusTick = useShell((s) => s.searchFocusTick);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusTick) ref.current?.focus();
  }, [focusTick]);
  return (
    <label className="search-field">
      <Search size={13} className="secondary" />
      {scopeName && (
        <span className="search-scope" title={`Tìm trong ${scopeName}`}>
          <span className="truncate">{scopeName}</span>
          <button
            className="search-scope-clear"
            onClick={(e) => {
              e.preventDefault();
              shell.clearSearchScope();
              ref.current?.focus();
            }}
            title="Tìm trong mọi cuộc trò chuyện"
            aria-label="Bỏ giới hạn tìm kiếm trong cuộc trò chuyện này"
          >
            <X size={10} strokeWidth={2.6} />
          </button>
        </span>
      )}
      <input
        ref={ref}
        value={search}
        placeholder={scopeName ? 'Tìm tin nhắn' : 'Tìm kiếm'}
        spellCheck={false}
        onChange={(e) => shell.setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (search) shell.setSearch('');
            else if (scope) shell.clearSearchScope();
            else ref.current?.blur();
          } else if (e.key === 'Backspace' && !search && scope) {
            shell.clearSearchScope();
          }
        }}
        aria-label={scopeName ? `Tìm tin nhắn trong ${scopeName}` : 'Tìm kiếm'}
      />
      {search || scope ? (
        <button className="icon-button" onClick={() => shell.clearSearch()} title="Xoá" aria-label="Xoá nội dung tìm kiếm">
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
