// The content of a bubble row per message kind (Swift `MessageRow.content` + `bubble`): text, media, files, cards.

import { styledSegments, tokenStyle, type TextStyleRange } from '../../engine/models/textStyles';
import { AlertCircle, CornerDownLeft, Lock, Phone, PhoneIncoming, PhoneMissed, Video, VideoOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { performCardAction } from '../../engine/cardActions';
import type { ChatMessage, Quote } from '../../engine/models/chat';
import { setEngine, useEngine } from '../../engine/store';
import { openExternal } from '../../engine/system';
import { symbolIcon } from '../../ui/symbols';
import { clock, statusText, textRuns, time } from './format';
import { ContactCardView, LinkCard, LocationCard, OAMessageCard, StickerSetCard, ZInstantCard } from './cards/Cards';
import { LivePollCard } from '../poll/PollCard';
import { GifView, PhotoView, StickerView, VideoThumb } from './cards/Media';
import { FileChip, PhotoMosaic, VoiceBubble } from '../chat-parts';
import { openViewer } from '../media/MediaViewer';
import { requestForward } from '../../engine/messageActions';

interface ContentProps {
  message: ChatMessage;
  firstInGroup: boolean;
  lastInGroup: boolean;
  /** Photos of one send (rows.ts): drawn as one mosaic. */
  album?: ChatMessage[];
}

export function BubbleContent({ message, firstInGroup, lastInGroup, album }: ContentProps) {
  const mine = message.isMine;
  const k = message.kind;
  const bubble = (children: ReactNode, opts: { tail?: boolean; muted?: boolean; padding?: number; meta?: 'inline' | 'block' | false } = {}) => (
    <Bubble message={message} firstInGroup={firstInGroup} lastInGroup={lastInGroup} {...opts}>
      {children}
    </Bubble>
  );
  const caption = message.text && !message.text.startsWith('[') ? bubble(<MessageText message={message} />, { tail: false }) : null;

  switch (k.type) {
    case 'sticker':
      return (
        <span className="media-with-meta">
          <StickerView url={k.url} />
          <BubbleMeta message={message} overlay />
        </span>
      );
    case 'photo':
      if (album && album.length > 1) {
        const photos = album.map((m) => (m.kind.type === 'photo' ? { url: m.kind.url, width: m.kind.width, height: m.kind.height } : { url: null, width: 1, height: 1 }));
        const last = album[album.length - 1];
        return (
          <span className="media-with-meta">
            <PhotoMosaic
              photos={photos}
              onOpen={(i) => {
                const m = album[i];
                if (m.kind.type === 'photo' && m.kind.url) openViewer({ kind: 'photo', url: m.kind.url, message: m });
              }}
            />
            <BubbleMeta message={last} overlay />
          </span>
        );
      }
      return (
        <div className="media-stack">
          <span className="media-with-meta">
            <PhotoView message={message} url={k.url} width={k.width} height={k.height} />
            {!caption && <BubbleMeta message={message} overlay />}
          </span>
          {caption}
        </div>
      );
    case 'gif':
      return <GifView message={message} url={k.url} />;
    case 'video':
      return (
        <div className="media-stack">
          <VideoThumb message={message} thumbnail={k.thumbnail} duration={k.duration} url={k.url} />
          {caption}
        </div>
      );
    case 'recalled':
      return bubble(<em>Tin nhắn đã được thu hồi</em>, { muted: true });
    case 'unsupported':
      return bubble(<span>[{k.rawType}]</span>, { muted: true });
    case 'text':
      return bubble(<MessageText message={message} />);
    case 'voice':
      return bubble(<VoiceBubble url={k.url} duration={k.duration} isMine={mine} />, { meta: 'block' });
    case 'file':
      // Files are cards, not bubbles: neutral for both sides, no tail.
      return (
        <div className={`file-message card-chrome ${message.status === 'sending' ? 'is-sending' : ''}`}>
          {message.quote && <QuoteBlock quote={message.quote} mine={false} />}
          <FileChip
            name={k.name}
            size={k.size}
            url={k.url}
            conversationId={message.conversationId}
            isMine={mine}
            onShare={message.menu.forward === 'available' ? () => requestForward(message) : undefined}
          />
        </div>
      );
    case 'link': {
      const showText = message.text && message.text !== k.url && message.text !== k.title && !message.text.startsWith('[Link]');
      return (
        <div className="media-stack">
          {showText && bubble(<MessageText message={message} />, { tail: false })}
          <LinkCard title={k.title} url={k.url} thumbnail={k.thumbnail} description={k.description} source={k.source} conversationId={message.conversationId} />
        </div>
      );
    }
    case 'contactCard':
      return <ContactCardView card={k.card} conversationId={message.conversationId} />;
    case 'location':
      return <LocationCard info={k.info} />;
    case 'call': {
      // A system-style one-liner with an icon, not a bubble.
      const Icon = k.video ? (k.missed ? VideoOff : Video) : k.missed ? PhoneMissed : mine ? Phone : PhoneIncoming;
      const callBack = message.cardButtons.find((b) => b.ref === 'call:back');
      return (
        <div className={`call-log ${k.missed ? 'is-missed' : ''}`}>
          <span className="call-icon">
            <Icon size={14} strokeWidth={2.2} />
          </span>
          <span className="call-title">{k.title || (k.video ? 'Cuộc gọi video' : 'Cuộc gọi thoại')}</span>
          <span className="call-detail">· {k.detail || (k.missed ? 'Cuộc gọi nhỡ' : k.duration > 0 ? clock(k.duration) : 'Đã kết thúc')}</span>
          <span className="call-detail nums">· {time(message.date)}</span>
          {callBack && (
            <button
              className="call-back"
              title={callBack.help || (k.video ? 'Gọi lại video' : 'Gọi lại')}
              onClick={() => void performCardAction(message.conversationId, message.id, callBack.ref)}
              disabled={!callBack.enabled}
            >
              <CornerDownLeft size={12} /> {callBack.label}
            </button>
          )}
        </div>
      );
    }
    case 'oaMessage':
      return k.parts.length === 0 ? bubble(<MessageText message={message} />) : <OAMessageCard parts={k.parts} />;
    case 'poll':
      return <LivePollCard poll={k.poll} message={message} />;
    case 'stickerSet':
      return <StickerSetCard title={k.title} thumbnail={k.thumbnail} />;
    case 'zinstant':
      if (!k.title && !k.text && !k.thumbnail) {
        return bubble(<MessageText message={message} fallback="Tin nhắn chưa hỗ trợ hiển thị trên phiên bản hiện tại" />);
      }
      return <ZInstantCard title={k.title} text={k.text} thumbnail={k.thumbnail} message={message} />;
    case 'placeholder': {
      const Icon = symbolIcon(k.symbol);
      return bubble(
        <span className="placeholder-text">
          <Icon size={13} /> {k.text}
        </span>,
        { muted: true },
      );
    }
    default:
      return null;
  }
}

/**
 * Bubble chrome: 18px corners, smaller on the sender's side between the bubbles of one run. Mine are Zalo tonal (solid
 * blue in dark mode), theirs a neutral surface. Time and delivery status sit inside the bottom-right corner; `muted` draws
 * an outline instead of a fill (recalled / unsupported / pending encryption).
 */
function Bubble({
  message,
  lastInGroup,
  muted = false,
  padding,
  meta = 'inline',
  children,
}: ContentProps & { tail?: boolean; muted?: boolean; padding?: number; meta?: 'inline' | 'block' | false; children: ReactNode }) {
  const mine = message.isMine;
  // Zalo PC: the time shows on the last bubble of a run only.
  const showsMeta = meta !== false && lastInGroup;
  return (
    <div
      className={`bubble ${mine ? 'is-mine' : 'is-theirs'} ${muted ? 'is-muted' : ''} ${message.status === 'sending' ? 'is-sending' : ''}`}
      style={{ padding: padding !== undefined ? padding : undefined }}
    >
      {message.quote && <QuoteBlock quote={message.quote} mine={mine && !muted} />}
      {children}
      {showsMeta && (
        <div className="bubble-meta-row">
          <BubbleMeta message={message} inline />
        </div>
      )}
    </div>
  );
}

/** The time inside the bubble (Zalo PC); the delivery status is the line under my last message (MessageRow). */
export function BubbleMeta({ message, inline = false, overlay = false }: { message: ChatMessage; inline?: boolean; overlay?: boolean }) {
  return (
    <span className={`bubble-meta ${inline ? 'is-inline' : ''} ${overlay ? 'is-overlay' : ''} nums`}>
      {message.isE2EE && <Lock size={9} aria-label="Mã hóa đầu cuối" />}
      {time(message.date)}
      {message.status === 'failed' && <AlertCircle size={12} className="bubble-status is-failed" aria-label={statusText.failed} />}
    </span>
  );
}

export function QuoteBlock({ quote, mine }: { quote: Quote; mine: boolean }) {
  return (
    <div className={`quote-block ${mine ? 'is-mine' : ''}`}>
      <div className="quote-sender">{quote.senderName}</div>
      <div className="quote-text clamp-2">{quote.text}</div>
    </div>
  );
}

/** Link-detected text with official @mention highlighting; a clicked mention opens that member's 1-1 chat. */
export function MessageText({ message, fallback }: { message: ChatMessage; fallback?: string }) {
  const myId = useEngine((s) => s.profile?.userId ?? null);
  const text = message.text || fallback || '';
  const runs = textRuns(text, message.mentions, myId);
  // "Định dạng tin nhắn": the official rich-text ranges cut every run where the style changes.
  const styles = message.kind.type === 'text' ? (message.kind.styles ?? []) : [];
  const styled = styles.length ? styledText(text, styles) : null;
  let at = 0;
  return (
    <span className="message-text selectable">
      {runs.map((r, i) => {
        const from = at;
        at += r.text.length;
        const body = styled ? styled(from, at, i) : r.text;
        if (r.kind === 'text') return <span key={i}>{body}</span>;
        if (r.kind === 'link')
          return (
            <a
              key={i}
              href={r.url}
              onClick={(e) => {
                e.preventDefault();
                void openExternal(r.url);
              }}
            >
              {body}
            </a>
          );
        return (
          <span
            key={i}
            className={`mention ${r.aimsAtMe ? 'is-me' : ''} ${r.clickable ? 'is-clickable' : ''}`}
            onClick={r.clickable ? () => setEngine({ navigationRequest: r.uid }) : undefined}
          >
            {body}
          </span>
        );
      })}
    </span>
  );
}

/** The pieces of [from, to) with their styles; list bullets / numbers and indents go in front of the lines that carry them. */
const styledText = (text: string, ranges: TextStyleRange[]) => {
  const segments = styledSegments(text.length, ranges);
  // Numbered lines count up while consecutive lines are numbered.
  const numbers = new Map<number, number>();
  let n = 0;
  for (let line = 0; line <= text.length; ) {
    const next = text.indexOf('\n', line);
    const end = next < 0 ? text.length : next;
    const seg = segments.find((s) => s.start <= line && line < s.end);
    if (seg?.tokens.includes('lst_2')) numbers.set(line, (n += 1));
    else n = 0;
    if (next < 0) break;
    line = end + 1;
  }
  return (from: number, to: number, key: number) =>
    segments
      .filter((s) => s.end > from && s.start < to)
      .map((s, j) => {
        const a = Math.max(from, s.start);
        const b = Math.min(to, s.end);
        const lineStart = a === 0 || text[a - 1] === '\n';
        const indent = lineStart ? Number(s.tokens.find((t) => t.startsWith('ind_'))?.slice(4) ?? 0) : 0;
        const marker = !lineStart ? null : s.tokens.includes('lst_1') ? '• ' : s.tokens.includes('lst_2') ? `${numbers.get(a) ?? 1}. ` : null;
        return (
          <span key={`${key}-${j}`} style={tokenStyle(s.tokens)}>
            {indent > 0 && <span className="rtf-indent" style={{ width: Math.min(indent, 120) }} />}
            {marker && <span className="rtf-marker">{marker}</span>}
            {text.slice(a, b)}
          </span>
        );
      });
};

