// The Zalo PC composer (docs/zalo-pc-style.md §4; logic from Swift `ChatComposer` + `ComposerTextView`): typing
// indicator, the icon toolbar row (Sticker, Hình ảnh, Đính kèm file, Chụp màn hình, Gửi danh thiếp, Nhắc hẹn, Định dạng,
// ⋯), the reply bar, @mention suggestions, then the input with emoji and GỬI (or 👍 while empty).
// Keys: Return sends (never while an IME composition is open — Vietnamese Telex), Shift/Option+Return inserts a newline,
// ↑ ↓ Return/Tab Esc drive the mention list while it is open. Mentions are atomic tokens.

import {
  AlarmClock,
  BarChart3,
  Bold,
  Camera,
  CaseSensitive,
  ChevronDown,
  Eraser,
  Italic,
  Strikethrough,
  Underline,
  FileText,
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
import { reminderComposeInfo, reportComposer, sendFiles, sendMedia, startScreenCapture, type ReminderComposeInfo } from '../../../engine/composer';
import { MyCardSheet, ReminderComposeSheet } from './ComposerSheets';
import {
  clearTokens,
  commonTokens,
  mediumSize,
  rebaseTextStyles,
  setGroupToken,
  styledSegments,
  textColors,
  textSizes,
  toggleToken,
  tokenStyle,
  type TextStyleRange,
} from '../../../engine/models/textStyles';
import type { ChatMessage, ComposerDraft, MentionCandidate } from '../../../engine/models/chat';
import { RemoteImage } from '../../../ui/RemoteImage';
import { Avatar } from '../../../ui/Avatar';
import { openMenuBelow } from '../../../ui/Menu';
import { openCreatePoll } from '../../poll/pollSheets';
import { getEngine } from '../../../engine/store';
import { showToast } from '../../../engine/toast';
import { loadStickerSuggestIfNeeded, sendSticker, stickerSuggestDelay, typingStickerSuggestions, useStickerSuggest, type StickerEntry } from '../../../engine/stickers';
import { Popover } from '../../../ui/Overlays';
import { StickerPicker, stickerNotReady, TypingStickerStrip } from '../../stickers/StickerPicker';
import { EmojiPicker } from '../../stickers/EmojiPicker';
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

  // Sticker picker popover, and the stickers suggested for the draft (Swift `TypingStickerState`): they show only while
  // the draft still is the text they were found for; a send with no answer holds that text away from the strip.
  const [showStickers, setShowStickers] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  // "Định dạng" (official ⌘⇧X): the formatting row works on the selected text.
  const [showFormat, setShowFormat] = useState(false);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const styles = draft.styles ?? [];
  const active = commonTokens(draft.text.length, styles, sel.start, sel.end);
  const hasSelection = sel.end > sel.start;
  /** The field's selection right now (the row's buttons keep the focus in the field, see onMouseDown). */
  const liveSel = () => {
    const el = field.current;
    return el && document.activeElement === el ? { start: el.selectionStart, end: el.selectionEnd } : sel;
  };
  const applyFormat = (make: (start: number, end: number) => TextStyleRange[]) => {
    const { start, end } = liveSel();
    if (end <= start && make.length) return;
    onDraftChange({ ...draft, styles: make(start, end) });
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(start, end);
    });
  };
  const toggle = (t: 'b' | 'i' | 'u' | 's') => applyFormat((a, b) => toggleToken(draft.text.length, styles, a, b, t));
  const emojiButton = useRef<HTMLButtonElement>(null);
  /** Inserts at the caret (replacing a selection) and keeps it after the insertion. */
  const insertText = (t: string) => {
    const el = field.current;
    const start = el ? el.selectionStart : draft.text.length;
    const end = el ? el.selectionEnd : draft.text.length;
    pendingCaret.current = start + t.length;
    update(draft.text.slice(0, start) + t + draft.text.slice(end), start + t.length);
  };
  const [showMyCard, setShowMyCard] = useState(false);
  const [reminderInfo, setReminderInfo] = useState<ReminderComposeInfo | null>(null);
  /** OA conversations have no "Nhắc hẹn" (learned from the gate's answer). */
  const [reminderHidden, setReminderHidden] = useState(false);

  /** The chat-bar gate decides on click, as the official item does (its warning when I may not create one here). */
  const openReminder = () => {
    const target = conversationId;
    void reminderComposeInfo(target).then((info) => {
      if (!info) return showToast('Chưa đọc được thông tin nhắc hẹn từ Zalo. Hãy thử lại sau giây lát.', target);
      if (info.hidden) setReminderHidden(true);
      if (!info.allowed) return showToast(info.text || 'Không thể tạo nhắc hẹn trong cuộc trò chuyện này.', target);
      if (getEngine().openConversationId === target) setReminderInfo(info);
    });
  };
  const stickerButton = useRef<HTMLButtonElement>(null);
  const [typing, setTyping] = useState<{ stickers: StickerEntry[]; for: string | null }>({ stickers: [], for: null });
  const [stripDismissed, setStripDismissed] = useState(false);
  const [sendingSuggestion, setSendingSuggestion] = useState<string | null>(null);
  const heldText = useRef<string | null>(null);
  const suggestEnabled = useStickerSuggest((s) => s.setting?.enabled ?? null);
  const stripOpen =
    typing.stickers.length > 0 && typing.for === draft.text && !isEmpty && !stripDismissed && !suggestionsOpen && suggestEnabled !== false;

  // Official `_checkStickerSuggestion` (debounced): nothing is asked while the setting is off, for blank or over-long
  // text, while the mention list is open or an IME composition is running.
  useEffect(() => {
    setStripDismissed(false);
    const text = draft.text;
    const clear = () => setTyping((t) => (t.stickers.length ? { stickers: [], for: null } : t));
    if (!text.trim() || text.length > 200 || suggestionsOpen) return clear();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      await loadStickerSuggestIfNeeded();
      if (cancelled) return;
      if (useStickerSuggest.getState().setting?.enabled !== true) return clear();
      timer = setTimeout(async () => {
        // A half-typed syllable: wait (bounded) for the composition to end, never ask about it.
        for (let waits = 0; composing.current && waits < 20 && !cancelled; waits += 1) await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;
        if (composing.current || heldText.current === text) return clear();
        const found = await typingStickerSuggestions(conversationId, text);
        if (cancelled) return;
        heldText.current = null;
        setTyping({ stickers: found, for: found.length ? text : null });
      }, stickerSuggestDelay());
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft.text, conversationId, suggestionsOpen]);

  /** Official `_sendSuggestionSticker`: the box is cleared first (the typed text is not sent), then the sticker goes out. */
  const sendSuggestion = (sticker: StickerEntry, index: number) => {
    if (sendingSuggestion || !stripOpen || composing.current) return;
    const target = conversationId;
    if (getEngine().openConversationId !== target) return showToast(stickerNotReady, target);
    const taken = draft;
    const typed = typing.for ?? draft.text;
    setTyping({ stickers: [], for: null });
    setSendingSuggestion(sticker.key);
    onDraftChange({ ...draft, text: '', mentions: [], styles: [] });
    void sendSticker(sticker, target, 'suggestion', typed, index).then((outcome) => {
      setSendingSuggestion(null);
      if (outcome.kind === 'done') return;
      if (outcome.kind === 'pending') {
        // The sticker may be on its way: the text is not given back and the strip stays away for it.
        heldText.current = typed;
        return showToast(outcome.text, target);
      }
      if (outcome.kind === 'locked' || outcome.kind === 'failed' || outcome.kind === 'unsupported') {
        // The text comes back, before whatever was typed meanwhile.
        onDraftChange((d) => (d.text ? { ...d, text: `${taken.text}${d.text}`, mentions: [...taken.mentions, ...d.mentions.map((m) => ({ ...m, pos: m.pos + taken.text.length }))] } : { ...d, text: taken.text, mentions: taken.mentions }));
        showToast(outcome.text, target);
      }
    });
  };

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
    onDraftChange({ ...draft, text, mentions, styles: rebaseTextStyles(draft.text, text, draft.styles ?? []) });
    refreshQuery(text, caret, mentions);
  };

  const pick = (c: MentionCandidate) => {
    if (!query) return;
    const next = insertMention(draft.text, draft.mentions, query, c);
    pendingCaret.current = next.caret;
    onDraftChange({ ...draft, text: next.text, mentions: next.mentions, styles: rebaseTextStyles(draft.text, next.text, draft.styles ?? []) });
    setQuery(null);
    setCandidates([]);
    field.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // An open IME composition owns Return / arrows / Esc (keyCode 229 = composition key in WebKit).
    if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
    const el = e.currentTarget;
    if (e.metaKey && !e.altKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === 'x') {
        e.preventDefault();
        return setShowFormat((v) => !v);
      }
      if (!e.shiftKey && (k === 'b' || k === 'i' || k === 'u') && el.selectionEnd > el.selectionStart) {
        e.preventDefault();
        const { selectionStart: s0, selectionEnd: e0 } = el;
        onDraftChange({ ...draft, styles: toggleToken(draft.text.length, styles, s0, e0, k) });
        return;
      }
    }
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
    } else if (stripOpen && e.key === 'Escape') {
      // Esc hides the sticker suggestions (they take no other key: Return keeps sending the text).
      e.preventDefault();
      e.stopPropagation();
      return setStripDismissed(true);
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
        <button
          ref={stickerButton}
          className={`composer-tool ${showStickers ? 'is-active' : ''}`}
          title="Gửi Sticker"
          aria-label="Gửi Sticker"
          aria-expanded={showStickers}
          onClick={() => setShowStickers((v) => !v)}
        >
          <Sticker size={20} strokeWidth={1.7} />
        </button>
        {showStickers && (
          <Popover anchor={stickerButton} onClose={() => setShowStickers(false)} placement="top">
            <StickerPicker conversationId={conversationId} onSent={() => setShowStickers(false)} />
          </Popover>
        )}
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
        <ToolButton icon={ContactRound} label="Gửi danh thiếp" onClick={() => setShowMyCard(true)} />
        {!reminderHidden && <ToolButton icon={AlarmClock} label="Tạo nhắc hẹn" onClick={openReminder} />}
        <button
          className={`composer-tool ${showFormat ? 'is-active' : ''}`}
          title="Định dạng tin nhắn (⌘⇧X)"
          aria-label="Định dạng tin nhắn"
          aria-pressed={showFormat}
          onClick={() => setShowFormat((v) => !v)}
        >
          <Type size={20} strokeWidth={1.7} />
        </button>
        <ToolButton
          icon={MoreHorizontal}
          label="Tiện ích khác"
          onClick={(el) =>
            openMenuBelow(el, [
              ...(isGroup ? [{ label: 'Tạo bình chọn', icon: BarChart3, onSelect: () => openCreatePoll(conversationId) }] : []),
              { label: 'Biểu tượng cảm xúc', icon: Smile, onSelect: () => setShowEmoji(true) },
            ])
          }
        />
      </div>
      {showFormat && (
        <FormatRow
          active={active}
          enabled={hasSelection}
          hasStyles={styles.length > 0}
          onToggle={toggle}
          onSize={(px) => applyFormat((a, b) => setGroupToken(draft.text.length, styles, a, b, 'f_', px === mediumSize ? null : `f_${px}`))}
          onColor={(hex) => applyFormat((a, b) => setGroupToken(draft.text.length, styles, a, b, 'c_', hex ? `c_${hex}` : null))}
          onClear={() => {
            const { start, end } = liveSel();
            onDraftChange({ ...draft, styles: end > start ? clearTokens(draft.text.length, styles, start, end) : [] });
          }}
        />
      )}
      {draft.replyTo && (
        <div className="composer-reply slide-up">
          <ReplyThumb message={draft.replyTo} />
          <span className="composer-reply-text">
            <span className="composer-reply-title">
              <Quote size={12} /> Trả lời {draft.replyTo.isMine ? 'chính mình' : draft.replyTo.senderName}
            </span>
            <span className="composer-reply-body truncate">{replyText(draft.replyTo)}</span>
          </span>
          <button className="icon-button" style={{ width: 24, height: 24 }} onClick={() => onDraftChange({ ...draft, replyTo: null })} title="Hủy trả lời" aria-label="Hủy trả lời">
            <X size={14} />
          </button>
        </div>
      )}
      {showMyCard && <MyCardSheet conversationId={conversationId} conversationName={name} onClose={() => setShowMyCard(false)} />}
      {reminderInfo && <ReminderComposeSheet conversationId={conversationId} info={reminderInfo} onClose={() => setReminderInfo(null)} />}
      {stripOpen && (
        <TypingStickerStrip stickers={typing.stickers} sending={sendingSuggestion} pick={sendSuggestion} dismiss={() => setStripDismissed(true)} />
      )}
      {suggestionsOpen && <MentionSuggestions candidates={candidates} selected={selected} setSelected={setSelected} pick={pick} />}
      <div className="composer-row">
        <div className={`composer-input ${styles.length ? 'has-styles' : ''}`} style={{ height }}>
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
            onSelect={(e) => {
              const el = e.currentTarget;
              refreshQuery(draft.text, el.selectionStart);
              setSel((old) => (old.start === el.selectionStart && old.end === el.selectionEnd ? old : { start: el.selectionStart, end: el.selectionEnd }));
            }}
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
        <button
          ref={emojiButton}
          className={`icon-button composer-icon ${showEmoji ? 'is-active' : ''}`}
          title="Biểu tượng cảm xúc"
          aria-label="Biểu tượng cảm xúc"
          aria-expanded={showEmoji}
          onClick={() => setShowEmoji((v) => !v)}
        >
          <Smile size={20} strokeWidth={1.8} />
        </button>
        {showEmoji && (
          <Popover anchor={emojiButton} onClose={() => setShowEmoji(false)} placement="top">
            <EmojiPicker onPick={insertText} />
          </Popover>
        )}
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
/** What the field shows behind the text: mention tokens, and the "Định dạng" styles. With styles, the mirror draws the
 * glyphs (the textarea's own text turns transparent) using width-preserving styles, so the caret stays aligned. */
const renderMirror = (draft: ComposerDraft) => {
  const text = draft.text;
  const mentions = [...draft.mentions].sort((a, b) => a.pos - b.pos);
  const segments = styledSegments(text.length, draft.styles ?? []);
  const cuts = new Set<number>([0, text.length]);
  for (const m of mentions) cuts.add(m.pos).add(m.pos + m.len);
  for (const sg of segments) cuts.add(sg.start).add(sg.end);
  const points = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const inMention = mentions.some((m) => m.pos <= a && b <= m.pos + m.len);
    const tokens = segments.find((sg) => sg.start <= a && b <= sg.end)?.tokens ?? [];
    const style = tokenStyle(tokens, true);
    parts.push(
      inMention ? (
        <mark key={a} className="composer-token" style={style}>
          {text.slice(a, b)}
        </mark>
      ) : (
        <span key={a} style={style}>
          {text.slice(a, b)}
        </span>
      ),
    );
  }
  parts.push('\u200b');
  return parts;
};

/** The formatting row (official RTF toolbar subset the sender supports): B, I, U, S, Cỡ chữ, Màu chữ, Bỏ định dạng. */
function FormatRow({
  active,
  enabled,
  hasStyles,
  onToggle,
  onSize,
  onColor,
  onClear,
}: {
  active: Set<string>;
  enabled: boolean;
  hasStyles: boolean;
  onToggle: (t: 'b' | 'i' | 'u' | 's') => void;
  onSize: (px: number) => void;
  onColor: (hex: string) => void;
  onClear: () => void;
}) {
  const hint = enabled ? undefined : 'Chọn đoạn văn bản để định dạng';
  const btn = (t: 'b' | 'i' | 'u' | 's', Icon: LucideIcon, label: string, keys?: string) => (
    <button
      className={`format-button ${active.has(t) ? 'is-on' : ''}`}
      disabled={!enabled}
      title={hint ?? (keys ? `${label} (${keys})` : label)}
      aria-label={label}
      aria-pressed={active.has(t)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onToggle(t)}
    >
      <Icon size={16} strokeWidth={2} />
    </button>
  );
  const size = [...active].find((t) => t.startsWith('f_'));
  const color = [...active].find((t) => t.startsWith('c_'));
  return (
    <div className="format-row slide-up" role="toolbar" aria-label="Định dạng tin nhắn">
      {btn('b', Bold, 'In đậm', '⌘B')}
      {btn('i', Italic, 'In nghiêng', '⌘I')}
      {btn('u', Underline, 'Gạch chân', '⌘U')}
      {btn('s', Strikethrough, 'Gạch ngang')}
      <span className="format-sep" />
      <button
        className={`format-button is-wide ${size ? 'is-on' : ''}`}
        disabled={!enabled}
        title={hint ?? 'Cỡ chữ'}
        aria-label="Cỡ chữ"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) =>
          openMenuBelow(
            e.currentTarget,
            [...textSizes].reverse().map((z) => ({
              label: z.title,
              checked: size ? size === `f_${z.px}` : z.px === mediumSize,
              onSelect: () => onSize(z.px),
            })),
          )
        }
      >
        <CaseSensitive size={18} strokeWidth={1.8} />
        <ChevronDown size={12} />
      </button>
      <button
        className="format-button is-wide"
        disabled={!enabled}
        title={hint ?? 'Đổi màu chữ'}
        aria-label="Đổi màu chữ"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) =>
          openMenuBelow(
            e.currentTarget,
            textColors.map((c) => ({
              label: c.title,
              dot: c.hex ? `#${c.hex}` : 'var(--text)',
              checked: color ? color === `c_${c.hex}` : !c.hex,
              onSelect: () => onColor(c.hex),
            })),
          )
        }
      >
        <span className="format-color" style={{ background: color ? `#${color.slice(2)}` : 'var(--text)' }} />
        <ChevronDown size={12} />
      </button>
      <span className="format-sep" />
      <button
        className="format-button"
        disabled={!enabled && !hasStyles}
        title={enabled ? 'Bỏ định dạng nội dung đã chọn' : 'Bỏ tất cả định dạng'}
        aria-label="Bỏ định dạng"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClear}
      >
        <Eraser size={16} strokeWidth={1.9} />
      </button>
      <span className="format-hint">{enabled ? '' : 'Chọn đoạn văn bản để định dạng'}</span>
    </div>
  );
}

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

/** What a reply quotes, in one line: the text, or the kind of media (X-style reply preview). */
const replyText = (m: ChatMessage) => {
  const k = m.kind;
  if (k.type === 'photo') return m.text && !m.text.startsWith('[') ? m.text : 'Hình ảnh';
  if (k.type === 'video') return 'Video';
  if (k.type === 'file') return k.name || 'Tệp';
  if (k.type === 'sticker') return 'Sticker';
  if (k.type === 'voice') return 'Tin nhắn thoại';
  return m.text || 'Tin nhắn';
};

/** A small picture of the quoted photo / video / sticker beside the reply bar's text. */
function ReplyThumb({ message }: { message: ChatMessage }) {
  const k = message.kind;
  const url = k.type === 'photo' || k.type === 'sticker' ? k.url : k.type === 'video' ? k.thumbnail : null;
  if (k.type === 'file') return <span className="composer-reply-thumb is-icon"><FileText size={16} /></span>;
  if (!url) return null;
  return (
    <span className="composer-reply-thumb">
      <RemoteImage url={url} fit={k.type === 'sticker' ? 'contain' : 'cover'} className="fill" compact placeholder={<span />} />
    </span>
  );
}
