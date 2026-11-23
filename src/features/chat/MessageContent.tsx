// The content of a bubble row per message kind (Swift `MessageRow.content` + `bubble`): text, media, files, cards.

import { CornerDownLeft, Phone, PhoneIncoming, PhoneMissed, Video, VideoOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { performCardAction } from '../../engine/cardActions';
import type { ChatMessage, Quote } from '../../engine/models/chat';
import { setEngine, useEngine } from '../../engine/store';
import { openExternal } from '../../engine/system';
import { symbolIcon } from '../../ui/symbols';
import { clock, textRuns } from './format';
import { ContactCardView, FileCard, LinkCard, LocationCard, OAMessageCard, StickerSetCard, ZInstantCard } from './cards/Cards';
import { LivePollCard } from '../poll/PollCard';
import { GifView, PhotoView, StickerView, VideoThumb, VoiceView } from './cards/Media';

interface ContentProps {
  message: ChatMessage;
  firstInGroup: boolean;
  lastInGroup: boolean;
}

export function BubbleContent({ message, firstInGroup, lastInGroup }: ContentProps) {
  const mine = message.isMine;
  const k = message.kind;
  const bubble = (children: ReactNode, opts: { tail?: boolean; muted?: boolean; padding?: number } = {}) => (
    <Bubble message={message} firstInGroup={firstInGroup} lastInGroup={lastInGroup} {...opts}>
      {children}
    </Bubble>
  );
  const caption = message.text && !message.text.startsWith('[') ? bubble(<MessageText message={message} />, { tail: false }) : null;

  switch (k.type) {
    case 'sticker':
      return <StickerView url={k.url} />;
    case 'photo':
      return (
        <div className="media-stack">
          <PhotoView message={message} url={k.url} width={k.width} height={k.height} />
          {caption}
        </div>
      );
    case 'gif':
      return <GifView url={k.url} />;
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
      return bubble(<VoiceView url={k.url} duration={k.duration} mine={mine} />);
    case 'file':
      // Files are cards, not bubbles: neutral for both sides, no tail.
      return (
        <div className={`file-message card-chrome ${message.status === 'sending' ? 'is-sending' : ''}`}>
          {message.quote && <QuoteBlock quote={message.quote} mine={false} />}
          <FileCard name={k.name} size={k.size} url={k.url} />
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
      const Icon = k.video ? (k.missed ? VideoOff : Video) : k.missed ? PhoneMissed : mine ? Phone : PhoneIncoming;
      const callBack = message.cardButtons.find((b) => b.ref === 'call:back');
      return bubble(
        <div className="call-log">
          <span className={`call-icon ${k.missed ? 'is-missed' : ''}`}>
            <Icon size={17} strokeWidth={2.2} />
          </span>
          <span className="call-text">
            <span className={`call-title ${k.missed ? 'is-missed' : ''}`}>{k.title || (k.video ? 'Cuộc gọi video' : 'Cuộc gọi thoại')}</span>
            <span className="call-detail">{k.detail || (k.missed ? 'Cuộc gọi nhỡ' : k.duration > 0 ? clock(k.duration) : 'Đã kết thúc')}</span>
          </span>
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
        </div>,
        { padding: 10 },
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
 * Bubble chrome: tighter corners between the bubbles of one run; the last bubble of a run carries the Messages tail on
 * its sender's side. `muted` draws an outline instead of a fill (recalled / unsupported / pending encryption).
 */
function Bubble({
  message,
  firstInGroup,
  lastInGroup,
  tail = true,
  muted = false,
  padding,
  children,
}: ContentProps & { tail?: boolean; muted?: boolean; padding?: number; children: ReactNode }) {
  const mine = message.isMine;
  const hasTail = tail && !muted && lastInGroup;
  const big = 18;
  const small = 6;
  const lastBottom = lastInGroup ? (hasTail ? 4 : big) : small;
  const radius = mine
    ? `${big}px ${firstInGroup ? big : small}px ${lastBottom}px ${big}px`
    : `${firstInGroup ? big : small}px ${big}px ${big}px ${lastBottom}px`;
  return (
    <div
      className={`bubble ${mine ? 'is-mine' : 'is-theirs'} ${muted ? 'is-muted' : ''} ${message.status === 'sending' ? 'is-sending' : ''}`}
      style={{ borderRadius: radius, padding: padding !== undefined ? padding : undefined }}
    >
      {hasTail && (
        <svg className="bubble-tail" width="11" height="17" viewBox="0 0 11 17" aria-hidden>
          <path d="M11 0C11 8 7 14 0 17L11 17Z" fill="currentColor" />
        </svg>
      )}
      {message.quote && <QuoteBlock quote={message.quote} mine={mine && !muted} />}
      {children}
    </div>
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
  return (
    <span className="message-text selectable">
      {runs.map((r, i) => {
        if (r.kind === 'text') return <span key={i}>{r.text}</span>;
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
              {r.text}
            </a>
          );
        return (
          <span
            key={i}
            className={`mention ${r.aimsAtMe ? 'is-me' : ''} ${r.clickable ? 'is-clickable' : ''}`}
            onClick={r.clickable ? () => setEngine({ navigationRequest: r.uid }) : undefined}
          >
            {r.text}
          </span>
        );
      })}
    </span>
  );
}

