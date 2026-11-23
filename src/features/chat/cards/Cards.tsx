// Native renderings of the PC app's rich message types (Swift MessageCards.swift + the button rows of CardActions.swift).
// Everything shown comes from the official message object; buttons run the official handlers (`performAction`).

import {
  AlarmClock,
  ArrowDownCircle,
  BarChart3,
  File as FileIcon,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Film,
  Map as MapIcon,
  MapPin,
  Music,
  Smile,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { performCardAction } from '../../../engine/cardActions';
import { tryAdapter } from '../../../engine/call';
import { arr, obj, str, webLink } from '../../../engine/models/json';
import { locationMapUrl, type CardButton, type ChatMessage, type ContactCard, type ECard, type LocationInfo, type OAPart, type PollInfo } from '../../../engine/models/chat';
import { setEngine } from '../../../engine/store';
import { openAttachment, openExternal } from '../../../engine/system';
import { openCardLink } from '../../../engine/cardSheets';
import { formatBytes } from '../../setup/RuntimeSetupView';
import { Avatar } from '../../../ui/Avatar';
import { RemoteImage } from '../../../ui/RemoteImage';
import { Spinner } from '../../../ui/Spinner';
import { symbolIcon } from '../../../ui/symbols';
import { host, textRuns } from '../format';

// MARK: - Buttons

function useCardRunner(message: ChatMessage | undefined) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (ref: string) => {
    if (!message || busy) return;
    setBusy(ref);
    try {
      await performCardAction(message.conversationId, message.id, ref);
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/** The buttons of an e-card (official action names). */
export function CardButtonBar({ buttons, message, width = 300 }: { buttons: CardButton[]; message: ChatMessage; width?: number }) {
  const { busy, run } = useCardRunner(message);
  if (!buttons.length) return null;
  return (
    <div className="card-button-bar" style={{ width }}>
      {buttons.map((b) => (
        <button key={b.ref} className="card-button" disabled={!b.enabled || !!busy} title={b.help} onClick={() => void run(b.ref)}>
          {busy === b.ref ? <Spinner size={13} /> : <span className="truncate">{b.label}</span>}
        </button>
      ))}
    </div>
  );
}

/** Inline links under an info message / ZInstant text. */
export function CardLinkRow({ buttons, message }: { buttons: CardButton[]; message?: ChatMessage }) {
  const { busy, run } = useCardRunner(message);
  if (!buttons.length || !message) return null;
  return (
    <div className="card-link-row">
      {buttons.map((b) => (
        <button key={b.ref} className="card-link" disabled={!b.enabled || !!busy} title={b.help} onClick={() => void run(b.ref)}>
          {b.label}
        </button>
      ))}
    </div>
  );
}

/** The stickers an e-card suggests (new friend, birthday): the official list, sent on click. */
function StickerSuggestionStrip({ message }: { message: ChatMessage }) {
  const [stickers, setStickers] = useState<{ ref: string; url: string }[]>([]);
  const { busy, run } = useCardRunner(message);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // The sticker service may not be resolved yet right after launch: a few tries, then give up quietly.
      for (let attempt = 0; attempt < 4 && !cancelled; attempt += 1) {
        const rows = await tryAdapter<unknown[]>([], '__zaloChat', 'cardStickers', message.conversationId, message.id);
        const list = arr(rows).flatMap((r) => {
          const row = obj(r);
          const ref = row ? str(row.ref) : '';
          const u = row ? webLink(row.url) : null;
          return ref && u ? [{ ref, url: u }] : [];
        });
        if (list.length) {
          if (!cancelled) setStickers(list);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [message.conversationId, message.id]);
  if (!stickers.length) return null;
  return (
    <div className="sticker-strip">
      {stickers.map((s) => (
        <button key={s.ref} disabled={!!busy} style={{ opacity: busy === s.ref ? 0.4 : 1 }} title="Gửi sticker này" onClick={() => void run(s.ref)}>
          <RemoteImage url={s.url} fit="contain" className="fill" compact placeholder={<Smile size={18} className="tertiary" />} />
        </button>
      ))}
    </div>
  );
}

// MARK: - Contact card

/**
 * Official name card: avatar, name, phone / OA link, QR, account type, and the footer: KẾT BẠN (stranger) or GỌI ĐIỆN
 * (friend), then NHẮN TIN; none on my own card. The profile sheet and calls arrive in later waves.
 */
export function ContactCardView({ card }: { card: ContactCard; conversationId: string }) {
  const [state, setState] = useState<{ isSelf: boolean; isFriend: boolean } | null>(null);
  useEffect(() => {
    if (!card.uid) return;
    let cancelled = false;
    void tryAdapter<unknown>(null, '__zaloChat', 'contactState', card.uid).then((r) => {
      const row = obj(r);
      if (!cancelled) setState({ isSelf: row?.isSelf === true, isFriend: row?.isFriend === true });
    });
    return () => {
      cancelled = true;
    };
  }, [card.uid]);
  const extra = card.phone || card.oaLink;
  return (
    <div className="contact-card card-chrome">
      <div className="contact-card-head">
        <Avatar url={card.avatar} name={card.name} size={52} />
        <div className="contact-card-text">
          <div className="contact-card-name clamp-2">{card.name || 'Danh thiếp'}</div>
          {extra && <div className="contact-card-extra truncate selectable">{extra}</div>}
          <div className={`contact-card-kind ${card.isOfficialAccount ? 'is-oa' : ''}`}>{card.isOfficialAccount ? 'Official Account' : 'Danh thiếp Zalo'}</div>
        </div>
        {card.qr && <RemoteImage url={card.qr} fit="contain" className="contact-card-qr" placeholder={<span />} />}
      </div>
      {card.uid && !state?.isSelf && (
        <div className="contact-card-footer">
          {state && !card.isOfficialAccount && (
            <button className="card-button" disabled title={state.isFriend ? 'Gọi thoại — chưa hỗ trợ' : 'Gửi lời mời kết bạn — chưa hỗ trợ'}>
              {state.isFriend ? 'GỌI ĐIỆN' : 'KẾT BẠN'}
            </button>
          )}
          <button className="card-button" title={`Mở cuộc trò chuyện với ${card.name}`} onClick={() => setEngine({ navigationRequest: card.uid })}>
            NHẮN TIN
          </button>
        </div>
      )}
    </div>
  );
}

// MARK: - Link, location

export function LinkCard({ title, url, thumbnail, description, source, conversationId }: { title: string; url: string | null; thumbnail: string | null; description: string; source: string; conversationId?: string }) {
  const site = source || host(url);
  return (
    <button className="link-card card-chrome" disabled={!webLink(url)} title={url ?? ''} onClick={() => (conversationId ? openCardLink(url, conversationId) : void openExternal(url))}>
      {thumbnail && <RemoteImage url={thumbnail} className="link-card-thumb" placeholder={<span />} />}
      <span className="link-card-body">
        <span className="link-card-title clamp-2">{title || url || 'Liên kết'}</span>
        {description && <span className="link-card-desc clamp-2">{description}</span>}
        {site && <span className="link-card-site truncate">{site}</span>}
      </span>
    </button>
  );
}

export function LocationCard({ info }: { info: LocationInfo }) {
  const map = locationMapUrl(info);
  return (
    <button className="location-card card-chrome" disabled={!map} title={map ? 'Mở bản đồ' : ''} onClick={() => void openExternal(map)}>
      {(info.coordinate || info.thumbnail) && (
        <span className="location-map">
          {info.thumbnail ? (
            <RemoteImage url={info.thumbnail} className="fill" placeholder={<span />} />
          ) : (
            <>
              <MapIcon size={28} className="tertiary" />
              <MapPin size={26} className="location-pin" fill="currentColor" stroke="#fff" />
            </>
          )}
        </span>
      )}
      <span className="link-card-body">
        <span className="location-title">
          <MapPin size={14} color="var(--danger)" style={{ flex: 'none' }} />
          <span className="clamp-2">{info.title || info.address || 'Vị trí'}</span>
        </span>
        {info.title && info.address && <span className="link-card-desc clamp-3">{info.address}</span>}
      </span>
    </button>
  );
}

// MARK: - E-card (standalone)

const reminderFormat = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ECardView({ card, message }: { card: ECard; message: ChatMessage }) {
  const buttons = message.cardButtons;
  const backdrop = card.image ? <RemoteImage url={card.image} className="fill" placeholder={<span className="ecard-gradient fill" />} /> : <span className="ecard-gradient fill" />;

  if (card.style === 'reminder') {
    // The live reminder controller (RSVP, responders) is a later wave: the static official card.
    return (
      <div className="ecard-wrap">
        <div className="reminder-card card-chrome">
          <div className="reminder-head">
            <AlarmClock size={16} className="tint" />
            <span>Nhắc hẹn</span>
          </div>
          <div className="reminder-title">{card.reminderTitle || card.title || 'Nhắc hẹn'}</div>
          {card.reminderStart && <div className="reminder-when">{reminderFormat.format(card.reminderStart)}</div>}
          {card.reminderRepeat && <div className="reminder-when">{card.reminderRepeat}</div>}
          <CardButtonBar buttons={buttons} message={message} width={280} />
        </div>
      </div>
    );
  }

  if (card.style === 'friend' || card.style === 'birthday') {
    const framed = message.suggestsStickers || buttons.length > 0;
    return (
      <div className="ecard-wrap">
        <div className={`ecard ${framed ? 'card-chrome' : 'is-bare'}`}>
          <div className="ecard-greeting">
            {backdrop}
            <span className="ecard-greeting-shade" />
            <span className="ecard-greeting-content">
              <span className="ecard-avatars">
                {card.avatars.map((u, i) => (
                  <Avatar key={i} url={u} name="" size={52} className="ecard-avatar" />
                ))}
              </span>
              {card.title && <span className="ecard-greeting-title clamp-2">{card.title}</span>}
            </span>
          </div>
          {framed && (
            <div className="ecard-extras">
              {message.suggestsStickers && (
                <>
                  <div className="ecard-hint">
                    {card.style === 'birthday' ? 'Gửi ngay sticker dưới đây thay lời chúc mừng' : 'Chọn một sticker dưới đây để bắt đầu trò chuyện'}
                  </div>
                  <StickerSuggestionStrip message={message} />
                </>
              )}
              <CardButtonBar buttons={buttons} message={message} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ecard-wrap">
      <div className="ecard card-chrome">
        <div className="ecard-banner">
          {backdrop}
          <span className="ecard-banner-shade" />
          <span className="ecard-banner-content">
            {card.thumb && <RemoteImage url={card.thumb} className="ecard-thumb" placeholder={<span />} />}
            <span className="ecard-banner-spacer" />
            {card.title && <span className="ecard-banner-title clamp-2">{card.title}</span>}
            {card.description && <span className="ecard-banner-desc clamp-2">{card.description}</span>}
          </span>
        </div>
        {message.suggestsStickers && <StickerSuggestionStrip message={message} />}
        <CardButtonBar buttons={buttons} message={message} />
      </div>
    </div>
  );
}

// MARK: - OA list message / article

export function OAMessageCard({ parts }: { parts: OAPart[] }) {
  return (
    <div className="oa-card card-chrome">
      {parts.map((p, i) => (
        <button key={i} className={p.isHeader ? 'oa-header' : 'oa-row'} disabled={!p.url} title={p.help || p.url || ''} onClick={() => void openExternal(p.url)}>
          {p.isHeader ? (
            <>
              {p.thumb && <RemoteImage url={p.thumb} className="oa-header-thumb" placeholder={<span />} />}
              <span className="oa-header-text">
                <span className="oa-header-title clamp-3">{p.title}</span>
                {p.description && <span className="link-card-desc clamp-3">{p.description}</span>}
              </span>
            </>
          ) : (
            <>
              <span className="oa-row-title clamp-3">{p.title}</span>
              {p.thumb && <RemoteImage url={p.thumb} className="oa-row-thumb" placeholder={<span />} />}
            </>
          )}
        </button>
      ))}
    </div>
  );
}

// MARK: - Poll, sticker set, ZInstant, notices

/** Poll event (voting, voter list and lock arrive with the poll wave). */
export function PollCard({ poll }: { poll: PollInfo }) {
  return (
    <div className="poll-card card-chrome">
      {poll.header && <div className="poll-header">{poll.header}</div>}
      <div className="poll-question">
        <BarChart3 size={16} className="tint" style={{ flex: 'none' }} />
        <span>{poll.question || 'Bình chọn'}</span>
      </div>
      <div className="poll-note">{poll.anonymous ? 'Bình chọn ẩn danh' : 'Bình chọn'} · Xem chi tiết trên điện thoại</div>
    </div>
  );
}

export function StickerSetCard({ title, thumbnail }: { title: string; thumbnail: string | null }) {
  return (
    <div className="sticker-set-card card-chrome">
      <RemoteImage url={thumbnail} fit="contain" className="sticker-set-thumb" compact placeholder={<Smile size={26} className="tertiary" />} />
      <span className="link-card-body">
        <span className="link-card-title clamp-2">{title || 'Bộ sticker'}</span>
        <span className="link-card-site">Bộ sticker</span>
      </span>
    </div>
  );
}

export function ZInstantCard({ title, text, thumbnail, message }: { title: string; text: string; thumbnail: string | null; message: ChatMessage }) {
  return (
    <div className="zinstant-card card-chrome">
      {thumbnail && <RemoteImage url={thumbnail} className="zinstant-thumb" placeholder={<span />} />}
      <div className="zinstant-body">
        {title && <div className="link-card-title">{title}</div>}
        {text && (
          <div className="zinstant-text selectable">
            {textRuns(text, [], null).map((r, i) =>
              r.kind === 'link' ? (
                <a key={i} href={r.url} onClick={(e) => { e.preventDefault(); void openExternal(r.url); }}>
                  {r.text}
                </a>
              ) : (
                <span key={i}>{r.text}</span>
              ),
            )}
          </div>
        )}
        <CardLinkRow buttons={message.cardButtons} message={message} />
      </div>
    </div>
  );
}

/** Centered notice (info message, to-do, vanish, syncing): small secondary text with an optional symbol. */
export function NoticeRow({ symbol, text, buttons = [], message }: { symbol?: string; text: string; buttons?: CardButton[]; message?: ChatMessage }) {
  const Icon = symbol ? symbolIcon(symbol) : null;
  return (
    <div className="notice-row" aria-label={`Hệ thống: ${text}`}>
      <div className="notice-text">
        {Icon && <Icon size={11} />}
        <span>{text}</span>
      </div>
      <CardLinkRow buttons={buttons} message={message} />
    </div>
  );
}

// MARK: - File

const fileIcon = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return FileText;
  if (['zip', 'rar', '7z', 'gz'].includes(ext)) return FileArchive;
  if (['xls', 'xlsx', 'csv'].includes(ext)) return FileSpreadsheet;
  if (['mp3', 'm4a', 'wav'].includes(ext)) return Music;
  if (['mp4', 'mov', 'mkv'].includes(ext)) return Film;
  return FileIcon;
};

/** A file card: opens through `media_open_file` (download + open, or reveal in Finder for files that could run code). */
export function FileCard({ name, size, url }: { name: string; size: number; url: string | null }) {
  const Icon = fileIcon(name);
  return (
    <button className="file-card" disabled={!url} onClick={() => void openAttachment(url, name)} title={name}>
      <span className="file-icon">
        <Icon size={20} />
      </span>
      <span className="file-text">
        <span className="file-name clamp-2">{name}</span>
        {size > 0 && <span className="file-size">{formatBytes(size)}</span>}
      </span>
      {url && <ArrowDownCircle size={16} className="file-download" />}
    </button>
  );
}
