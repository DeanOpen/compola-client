// The Zalo PC composer (docs/zalo-pc-style.md §4; logic from Swift `ChatComposer` + `ComposerTextView`): typing
// indicator, the icon toolbar row (Sticker, Hình ảnh, Đính kèm file, Chụp màn hình, Gửi danh thiếp, Nhắc hẹn, Định dạng,
// ⋯), the reply bar, @mention suggestions, then the input with emoji and GỬI (or 👍 while empty).
// Keys: Return sends (never while an IME composition is open — Vietnamese Telex), Shift/Option+Return inserts a newline,
// ↑ ↓ Return/Tab Esc drive the mention list while it is open. Mentions are atomic tokens.

import {
  AlarmClock,
  BarChart3,
  Camera,
  ContactRound,
  ImageIcon,
  MessageCircleMore,
  MoreHorizontal,
  Paperclip,
  Quote,
  Smile,
  Sticker,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { mentionCandidates } from '../../../engine/chat';
import { reportComposer, sendFiles, sendMedia, startScreenCapture } from '../../../engine/composer';
import type { ComposerDraft, MentionCandidate } from '../../../engine/models/chat';
import { Avatar } from '../../../ui/Avatar';
import { openMenuBelow } from '../../../ui/Menu';
import { openCreatePoll } from '../../poll/pollSheets';
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
  onPasteFiles,
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
  /** ⌘V with files or an image on the clipboard. */
  onPasteFiles?: () => void;
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

  const placeholder = isGroup ? `Nhập @, tin nhắn tới ${name}` : `Nhập tin nhắn tới ${name}`;
  const attach = (kind: 'media' | 'files') =>
    void (kind === 'media' ? sendMedia(conversationId) : sendFiles(conversationId)).then((o) => reportComposer(o, conversationId));

  return (
    <div className="composer">
      {typingName && (
        <div className="composer-typing fade-in">
          <MessageCircleMore size={13} style={{ animation: 'compola-pulse 1.4s ease-in-out infinite' }} />
          {typingName} đang soạn tin…
        </div>
      )}
      <div className="composer-toolbar" role="toolbar" aria-label="Công cụ soạn tin">
        <ToolButton icon={Sticker} label="Gửi Sticker" disabled />
        <ToolButton icon={ImageIcon} label="Gửi hình ảnh" onClick={() => attach('media')} />
        <ToolButton icon={Paperclip} label="Đính kèm File" onClick={() => attach('files')} />
        <ToolButton
          icon={Camera}
          label="Chụp màn hình"
          onClick={(el) =>
            openMenuBelow(el, [
              { label: 'Chụp kèm cửa sổ Compola', onSelect: () => startScreenCapture(conversationId, true) },
              { label: 'Chụp không kèm cửa sổ Compola', onSelect: () => startScreenCapture(conversationId, false) },
            ])
          }
        />
        <ToolButton icon={ContactRound} label="Gửi danh thiếp" disabled />
        <ToolButton icon={AlarmClock} label="Tạo nhắc hẹn" disabled />
        <ToolButton icon={Type} label="Định dạng tin nhắn" disabled />
        <ToolButton
          icon={MoreHorizontal}
          label="Tiện ích khác"
          onClick={(el) =>
            openMenuBelow(el, [
              ...(isGroup ? [{ label: 'Tạo bình chọn', icon: BarChart3, onSelect: () => openCreatePoll(conversationId) }] : []),
              { label: 'Emoji', icon: Smile, shortcut: '⌃⌘Space', disabled: true, onSelect: () => {} },
            ])
          }
        />
      </div>
      {draft.replyTo && (
        <div className="composer-reply slide-up">
          <span className="composer-reply-text">
            <span className="composer-reply-title">
              <Quote size={12} /> Trả lời {draft.replyTo.isMine ? 'chính mình' : draft.replyTo.senderName}
            </span>
            <span className="composer-reply-body truncate">{draft.replyTo.text || 'Tin nhắn'}</span>
          </span>
          <button className="icon-button" style={{ width: 24, height: 24 }} onClick={() => onDraftChange({ ...draft, replyTo: null })} title="Hủy trả lời" aria-label="Hủy trả lời">
            <X size={14} />
          </button>
        </div>
      )}
      {suggestionsOpen && <MentionSuggestions candidates={candidates} selected={selected} setSelected={setSelected} pick={pick} />}
      <div className="composer-row">
        <div className="composer-input" style={{ height }}>
          <div className="composer-mirror" ref={mirror} aria-hidden>
            {renderMirror(draft)}
          </div>
          <textarea
            ref={field}
            rows={1}
            value={draft.text}
            placeholder={placeholder}
            aria-label="Nhập tin nhắn"
            spellCheck
            onChange={(e) => update(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onSelect={(e) => refreshQuery(draft.text, e.currentTarget.selectionStart)}
            onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
            onPaste={(e) => {
              // Files / an image on the clipboard: ⌘V attaches them (asked first, like Zalo PC's paste preview).
              const types = Array.from(e.clipboardData.types);
              if (onPasteFiles && (e.clipboardData.files.length > 0 || types.includes('Files') || types.some((t) => t.startsWith('image/')))) {
                e.preventDefault();
                onPasteFiles();
                return;
              }
              // Otherwise plain text only, like the Swift field.
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
        <button className="icon-button composer-icon" disabled title="Biểu cảm" aria-label="Biểu cảm">
          <Smile size={20} strokeWidth={1.8} />
        </button>
        {isEmpty ? (
          <button className="icon-button composer-icon composer-like" onClick={onSendLike} title="Gửi nhanh biểu tượng cảm xúc" aria-label="Gửi biểu tượng thích">
            👍
          </button>
        ) : (
          <button className="composer-send" onClick={onSend} title="Gửi (Enter)" aria-label="Gửi tin nhắn">
            GỬI
          </button>
        )}
      </div>
    </div>
  );
}

function ToolButton({ icon: Icon, label, disabled = false, onClick }: { icon: LucideIcon; label: string; disabled?: boolean; onClick?: (el: HTMLButtonElement) => void }) {
  return (
    <button
      className="composer-tool"
      disabled={disabled}
      title={disabled ? `${label} — chưa hỗ trợ trên phiên bản này` : label}
      aria-label={label}
      onClick={(e) => onClick?.(e.currentTarget)}
    >
      <Icon size={20} strokeWidth={1.7} />
    </button>
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
