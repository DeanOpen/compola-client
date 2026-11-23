// Floating glass composer (Swift `ChatComposer` + `ComposerTextView`): typing indicator, reply banner, @mention
// suggestions, then one row of "+" menu, text capsule and send / like button.
// Keys: Return sends (never while an IME composition is open — Vietnamese Telex), Shift/Option+Return inserts a newline,
// ↑ ↓ Return/Tab Esc drive the mention list while it is open. Mentions are atomic tokens.

import {
  AlarmClock,
  ArrowUp,
  BarChart3,
  Camera,
  ContactRound,
  ImageIcon,
  MessageCircleMore,
  Paperclip,
  Plus,
  Smile,
  Sticker,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { mentionCandidates } from '../../../engine/chat';
import { reportComposer, sendFiles, sendMedia, startScreenCapture } from '../../../engine/composer';
import type { ComposerDraft, MentionCandidate } from '../../../engine/models/chat';
import { Avatar } from '../../../ui/Avatar';
import { openMenuBelow } from '../../../ui/Menu';
import { insertMention, mentionQueryAt, rebaseMentions, tokenAt, type MentionQuery } from './mentions';

const lineHeight = 19;
const maxLines = 8;

export function Composer({
  name,
  conversationId,
  isGroup,
  draft,
  onDraftChange,
  typingName,
  focusTick,
  onSend,
  onSendLike,
}: {
  name: string;
  conversationId: string;
  isGroup: boolean;
  draft: ComposerDraft;
  onDraftChange: (d: ComposerDraft | ((d: ComposerDraft) => ComposerDraft)) => void;
  typingName: string | null;
  focusTick: number;
  onSend: () => void;
  onSendLike: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [selected, setSelected] = useState(0);
  const [height, setHeight] = useState(lineHeight);

  const isEmpty = draft.text.trim().length === 0;
  const suggestionsOpen = isGroup && query !== null && candidates.length > 0;

  useEffect(() => {
    if (focusTick) field.current?.focus();
  }, [focusTick]);

  // Auto-grow up to six lines; keep the caret where an insertion put it.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = '0px';
    const h = Math.min(Math.max(lineHeight, el.scrollHeight), lineHeight * maxLines);
    el.style.height = `${h}px`;
    setHeight(h);
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    if (mirror.current) mirror.current.scrollTop = el.scrollTop;
  }, [draft.text]);

  // Debounced lookup against the official member list; stale answers are discarded.
  useEffect(() => {
    if (!isGroup || !query) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void mentionCandidates(conversationId, query.text, draft.mentions.map((m) => m.uid)).then((found) => {
        if (cancelled) return;
        setCandidates(found);
        setSelected(0);
      });
    }, 40);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query?.text, query?.start, isGroup, conversationId]);

  const refreshQuery = (text: string, caret: number, mentions = draft.mentions) => {
    if (!isGroup) return;
    const q = mentionQueryAt(text, caret, mentions);
    setQuery((old) => (old?.start === q?.start && old?.text === q?.text && old?.end === q?.end ? old : q));
  };

  const update = (text: string, caret: number) => {
    const mentions = rebaseMentions(draft.text, text, draft.mentions);
    onDraftChange({ ...draft, text, mentions });
    refreshQuery(text, caret, mentions);
  };

  const pick = (c: MentionCandidate) => {
    if (!query) return;
    const next = insertMention(draft.text, draft.mentions, query, c);
    pendingCaret.current = next.caret;
    onDraftChange({ ...draft, text: next.text, mentions: next.mentions });
    setQuery(null);
    setCandidates([]);
    field.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // An open IME composition owns Return / arrows / Esc (keyCode 229 = composition key in WebKit).
    if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
    const el = e.currentTarget;
    if (suggestionsOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        return setSelected((s) => (s + 1) % candidates.length);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        return setSelected((s) => (s - 1 + candidates.length) % candidates.length);
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        return pick(candidates[Math.min(selected, candidates.length - 1)]);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setQuery(null);
        return setCandidates([]);
      }
    }
    if (e.key === 'Enter') {
      if (e.shiftKey || e.altKey) {
        if (e.altKey) {
          // Option+Return: newline at the caret (Shift+Return is the textarea's own).
          e.preventDefault();
          const { selectionStart: s, selectionEnd: en } = el;
          pendingCaret.current = s + 1;
          update(draft.text.slice(0, s) + '\n' + draft.text.slice(en), s + 1);
        }
        return;
      }
      e.preventDefault();
      onSend();
      setQuery(null);
      return;
    }
    // A mention is atomic: deleting into it removes the whole token.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const token = tokenAt(draft.mentions, el.selectionStart, el.selectionEnd, e.key === 'Backspace' ? 'back' : 'forward');
      if (token) {
        e.preventDefault();
        const start = Math.min(token.pos, el.selectionStart);
        const end = Math.max(token.pos + token.len, el.selectionEnd);
        pendingCaret.current = start;
        update(draft.text.slice(0, start) + draft.text.slice(end), start);
      }
    }
  };

  const plusMenu = (el: Element) =>
    openMenuBelow(el, [
      {
        label: 'Ảnh hoặc Video',
        icon: ImageIcon,
        onSelect: () => void sendMedia(conversationId).then((o) => reportComposer(o, conversationId)),
      },
      {
        label: 'Tệp',
        icon: Paperclip,
        onSelect: () => void sendFiles(conversationId).then((o) => reportComposer(o, conversationId)),
      },
      {
        kind: 'submenu',
        label: 'Chụp màn hình',
        icon: Camera,
        items: [
          { label: 'Chụp kèm cửa sổ Compola', onSelect: () => startScreenCapture(conversationId, true) },
          { label: 'Chụp không kèm cửa sổ Compola', onSelect: () => startScreenCapture(conversationId, false) },
        ],
      },
      { label: 'Danh thiếp của tôi', icon: ContactRound, disabled: true, onSelect: () => {} },
      { kind: 'separator' },
      { label: 'Nhắc hẹn', icon: AlarmClock, disabled: true, onSelect: () => {} },
      ...(isGroup ? [{ label: 'Bình chọn', icon: BarChart3, disabled: true, onSelect: () => {} }] : []),
      { label: 'Sticker', icon: Sticker, disabled: true, onSelect: () => {} },
      { label: 'Emoji', icon: Smile, shortcut: '⌃⌘Space', disabled: true, onSelect: () => {} },
    ]);

  return (
    <div className="composer">
      {typingName && (
        <div className="composer-typing glass fade-in">
          <MessageCircleMore size={13} style={{ animation: 'compola-pulse 1.4s ease-in-out infinite' }} />
          {typingName} đang soạn tin…
        </div>
      )}
      {draft.replyTo && (
        <div className="composer-reply glass slide-up">
          <span className="composer-reply-bar" />
          <span className="composer-reply-text">
            <span className="composer-reply-title">Trả lời {draft.replyTo.isMine ? 'chính mình' : draft.replyTo.senderName}</span>
            <span className="composer-reply-body truncate">{draft.replyTo.text || 'Tin nhắn'}</span>
          </span>
          <button className="icon-button" style={{ width: 22, height: 22 }} onClick={() => onDraftChange({ ...draft, replyTo: null })} title="Hủy trả lời" aria-label="Hủy trả lời">
            <X size={13} />
          </button>
        </div>
      )}
      {suggestionsOpen && <MentionSuggestions candidates={candidates} selected={selected} setSelected={setSelected} pick={pick} />}
      <div className="composer-row">
        <div className="composer-field glass">
          <button className="icon-button composer-icon composer-plus" onClick={(e) => plusMenu(e.currentTarget)} title="Thêm" aria-label="Thêm">
            <Plus size={19} strokeWidth={2.3} />
          </button>
          <div className="composer-input" style={{ height }}>
            <div className="composer-mirror" ref={mirror} aria-hidden>
              {renderMirror(draft)}
            </div>
            <textarea
              ref={field}
              rows={1}
              value={draft.text}
              placeholder={`Tin nhắn tới ${name}`}
              aria-label="Nhập tin nhắn"
              spellCheck
              onChange={(e) => update(e.target.value, e.target.selectionStart)}
              onKeyDown={onKeyDown}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              onSelect={(e) => refreshQuery(draft.text, e.currentTarget.selectionStart)}
              onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
              onPaste={(e) => {
                // Plain text only, like the Swift field.
                const text = e.clipboardData.getData('text/plain');
                if (!text) return;
                e.preventDefault();
                const el = e.currentTarget;
                const s = el.selectionStart;
                pendingCaret.current = s + text.length;
                update(draft.text.slice(0, s) + text + draft.text.slice(el.selectionEnd), s + text.length);
              }}
            />
          </div>
          {isEmpty && (
            <button className="icon-button composer-icon composer-like" onClick={onSendLike} title="Gửi biểu tượng thích" aria-label="Gửi biểu tượng thích">
              👍
            </button>
          )}
          <button className="icon-button composer-icon" disabled title="Gửi Sticker" aria-label="Gửi Sticker">
            <Smile size={18} />
          </button>
        </div>
        <button className="composer-send" onClick={onSend} disabled={isEmpty} title="Gửi" aria-label="Gửi tin nhắn">
          <ArrowUp size={17} strokeWidth={2.8} />
        </button>
      </div>
    </div>
  );
}

/** Same text as the field, transparent, with the mention tokens highlighted behind the real text. */
const renderMirror = (draft: ComposerDraft) => {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of [...draft.mentions].sort((a, b) => a.pos - b.pos)) {
    if (m.pos < at) continue;
    parts.push(draft.text.slice(at, m.pos));
    parts.push(
      <mark key={m.pos} className="composer-token">
        {draft.text.slice(m.pos, m.pos + m.len)}
      </mark>,
    );
    at = m.pos + m.len;
  }
  parts.push(draft.text.slice(at) + '​');
  return parts;
};

function MentionSuggestions({
  candidates,
  selected,
  setSelected,
  pick,
}: {
  candidates: MentionCandidate[];
  selected: number;
  setSelected: (i: number) => void;
  pick: (c: MentionCandidate) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <div ref={list} className="mention-list glass slide-up" role="listbox" aria-label="Gợi ý nhắc thành viên">
      {candidates.map((c, i) => (
        <button
          key={c.id}
          data-index={i}
          role="option"
          aria-selected={i === selected}
          className={`mention-row ${i === selected ? 'is-selected' : ''}`}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            pick(c);
          }}
          aria-label={c.isAll ? 'Nhắc tất cả thành viên' : `Nhắc ${c.name}`}
        >
          {c.isAll ? <span className="mention-all">@</span> : <Avatar url={c.avatar} name={c.name} size={26} />}
          <span className="mention-text">
            <span className="truncate">{c.isAll ? 'Tất cả' : c.name}</span>
            {c.isAll && <span className="mention-sub">Nhắc tất cả thành viên</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
