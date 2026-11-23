// The inspector's shared content (Swift ChatInspector media / files / links sections + InspectorBlocks tiles) and its
// "Kho lưu trữ" page (Swift Shell/SharedMediaBrowser.swift): everything ever shared in the conversation, read page by
// page from the official media service and merged with the loaded messages. Zalo PC right-panel style: collapsible
// "Ảnh/Video" (3-column grid), "File" and "Link" sections, each with "Xem tất cả".

import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Link as LinkIcon,
  MessageSquareText,
  Search,
  Upload,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ChatMessage } from '../../engine/models/chat';
import { saveMediaAs } from '../../engine/save';
import {
  browseSharedMedia,
  closeSharedMediaBrowser,
  didFail,
  feedOf,
  isPending,
  loadedSince,
  days,
  filterFeedState,
  filterKinds,
  kindOf,
  loadFilterIfNeeded,
  loadMoreFilter,
  mergedAll,
  mergedList,
  previewList,
  refreshSharedMedia,
  retryFilter,
  retrySharedMedia,
  sharedMediaFilters,
  useSharedMedia,
  type SharedMediaFilter,
  type SharedMediaKind,
} from '../../engine/sharedMedia';
import { onFileDrop } from '../../engine/backend';
import { reportComposer, sendMedia } from '../../engine/composer';
import { requestJumpToMessage } from '../../engine/messageJump';
import { showToast } from '../../engine/toast';
import { openContextMenu, openMenuBelow, type MenuItem } from '../../ui/Menu';
import { useEngine } from '../../engine/store';
import { openExternal } from '../../engine/system';
import { Spinner } from '../../ui/Spinner';
import { PhotoView, VideoThumb } from '../chat/cards/Media';
import { daySeparator, host, time } from '../chat/format';
import { formatBytes } from '../setup/RuntimeSetupView';
import './sharedMedia.css';

const emptyMessages: ChatMessage[] = [];
const sectionTitles: Record<SharedMediaKind, string> = { images: 'Ảnh/Video', files: 'File', links: 'Link' };
const emptyTexts: Record<SharedMediaKind, string> = { images: 'Chưa có ảnh hoặc video', files: 'Chưa có tệp', links: 'Chưa có liên kết' };

/** Reads the newest page of every list when the conversation shows, and again (a second later) after a new message. */
const useSharedMediaRefresh = (conversationId: string) => {
  const lastId = useEngine((s) => {
    const list = s.messages[conversationId];
    return list?.[list.length - 1]?.id ?? null;
  });
  const first = useRef(true);
  useEffect(() => {
    first.current = true;
  }, [conversationId]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      void refreshSharedMedia(conversationId);
      return;
    }
    const t = setTimeout(() => void refreshSharedMedia(conversationId), 1000);
    return () => clearTimeout(t);
  }, [conversationId, lastId]);
};

// MARK: - Inspector overview

/** The "Ảnh/Video", "File" and "Link" sections of the inspector. */
export function SharedMediaSections({ conversationId }: { conversationId: string }) {
  useSharedMediaRefresh(conversationId);
  const loaded = useEngine((s) => s.messages[conversationId] ?? emptyMessages);
  const feeds = useSharedMedia(
    useShallow((s) => ({ images: feedOf(s, conversationId, 'images'), files: feedOf(s, conversationId, 'files'), links: feedOf(s, conversationId, 'links') })),
  );
  const previews = useMemo(
    () => ({
      images: previewList('images', feeds.images.items, loaded),
      files: previewList('files', feeds.files.items, loaded),
      links: previewList('links', feeds.links.items, loaded),
    }),
    [feeds, loaded],
  );

  return (
    <>
      {(['images', 'files', 'links'] as const).map((kind) => {
        const items = previews[kind];
        const feed = feeds[kind];
        const seeAll = items.length > 0 || didFail(feed) ? () => browseSharedMedia(conversationId, kind) : undefined;
        return (
          <Collapsible key={kind} title={sectionTitles[kind]}>
            {items.length === 0 ? (
              isPending(feed) ? (
                <div className="sm-pending">
                  <Spinner size={14} />
                </div>
              ) : didFail(feed) ? (
                <FailureLine onRetry={() => void retrySharedMedia(conversationId, kind)} />
              ) : (
                <div className="sm-empty">{emptyTexts[kind]}</div>
              )
            ) : kind === 'images' ? (
              <div className="sm-grid is-overview">
                {items.map((m) => (
                  <MediaTile key={m.id} message={m} />
                ))}
              </div>
            ) : (
              <div className="sm-rows">
                {items.map((m) => (kind === 'files' ? <FileRow key={m.id} message={m} /> : <LinkRow key={m.id} message={m} />))}
              </div>
            )}
            {items.length > 0 && didFail(feed) && <FailureLine onRetry={() => void retrySharedMedia(conversationId, kind)} />}
            {seeAll && (
              <button className="sm-see-all" onClick={seeAll}>
                Xem tất cả
              </button>
            )}
          </Collapsible>
        );
      })}
    </>
  );
}

function Collapsible({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="sm-section">
      <button className="sm-section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{title}</span>
        <ChevronDown size={16} className={`sm-chevron ${open ? '' : 'is-closed'}`} />
      </button>
      {open && <div className="sm-section-body">{children}</div>}
    </section>
  );
}

function FailureLine({ onRetry, text = 'Không tải được' }: { onRetry: () => void; text?: string }) {
  return (
    <div className="sm-failure">
      <span>{text}</span>
      <button className="sm-link" onClick={onRetry}>
        Thử lại
      </button>
    </div>
  );
}

// MARK: - Items

/** A photo or video as a square tile; a click opens the media viewer. */
function MediaTile({ message }: { message: ChatMessage }) {
  const k = message.kind;
  if (k.type === 'photo') return <PhotoView message={message} url={k.url} width={k.width} height={k.height} tile={240} />;
  if (k.type === 'video') return <VideoThumb message={message} thumbnail={k.thumbnail} duration={k.duration} url={k.url} tile={240} />;
  return null;
}

const extIcon = (name: string): { icon: LucideIcon; tone: string } => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'dmg'].includes(ext)) return { icon: FileArchive, tone: 'is-archive' };
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(ext)) return { icon: FileSpreadsheet, tone: 'is-sheet' };
  if (['doc', 'docx', 'pdf', 'txt', 'pages', 'rtf', 'md'].includes(ext)) return { icon: FileText, tone: ext === 'pdf' ? 'is-pdf' : 'is-doc' };
  if (['png', 'jpg', 'jpeg', 'gif', 'heic', 'webp'].includes(ext)) return { icon: FileImage, tone: 'is-image' };
  if (['mp4', 'mov', 'm4v', 'webm', 'avi'].includes(ext)) return { icon: FileVideo, tone: 'is-video' };
  return { icon: File, tone: 'is-doc' };
};

const typeLabel = (name: string) => {
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : '';
  return ext && ext.length <= 5 ? ext : 'Tệp';
};

/** A file: icon, name, type · size (· day); a click saves it ("Lưu về máy…"). */
function FileRow({ message, showDay = true }: { message: ChatMessage; showDay?: boolean }) {
  if (message.kind.type !== 'file') return null;
  const { name, size, url } = message.kind;
  const { icon: Icon, tone } = extIcon(name);
  return (
    <button className="sm-row" disabled={!url} onClick={() => url && void saveMediaAs(url, name)} title={`Lưu về máy… — ${name}`}>
      <span className={`sm-file-icon ${tone}`}>
        <Icon size={18} />
      </span>
      <span className="sm-row-text">
        <span className="sm-row-title truncate">{name}</span>
        <span className="sm-row-sub truncate">
          {[typeLabel(name), size > 0 ? formatBytes(size) : null, showDay ? daySeparator(message.date) : null].filter(Boolean).join(' · ')}
        </span>
      </span>
    </button>
  );
}

/** A link: its title and site, opened in the browser. */
function LinkRow({ message }: { message: ChatMessage }) {
  if (message.kind.type !== 'link') return null;
  const { title, url, source } = message.kind;
  return (
    <button className="sm-row" disabled={!url} onClick={() => void openExternal(url)} title={url ?? undefined}>
      <span className="sm-file-icon is-link">
        <LinkIcon size={16} />
      </span>
      <span className="sm-row-text">
        <span className="sm-row-title clamp-2">{title || url || 'Liên kết'}</span>
        <span className="sm-row-sub truncate">{source || host(url)}</span>
      </span>
    </button>
  );
}

// MARK: - "Kho lưu trữ"

const filterTitles: Record<SharedMediaFilter, string> = { all: 'Tất cả', images: 'Ảnh/Video', files: 'File', links: 'Link' };
const filterEmpty: Record<SharedMediaFilter, string> = { all: 'Chưa có ảnh, file hay link nào', ...emptyTexts };

type Run = { kind: 'grid'; items: ChatMessage[] } | { kind: 'rows'; items: ChatMessage[] };

/** A day's items in order, photos / videos side by side in a grid, files and links as rows. */
const runsOf = (items: ChatMessage[]): Run[] => {
  const out: Run[] = [];
  for (const m of items) {
    const kind = kindOf(m.kind) === 'images' ? 'grid' : 'rows';
    const last = out[out.length - 1];
    if (last?.kind === kind) last.items.push(m);
    else out.push({ kind, items: [m] });
  }
  return out;
};

/** The full page, in place of the inspector's overview: a filter menu, a drop target, then everything by day. */
export function SharedMediaBrowser({ conversationId, kind: filter }: { conversationId: string; kind: SharedMediaFilter }) {
  useSharedMediaRefresh(conversationId);
  const loaded = useEngine((s) => s.messages[conversationId] ?? emptyMessages);
  const feeds = useSharedMedia(
    useShallow((s) => ({ images: feedOf(s, conversationId, 'images'), files: feedOf(s, conversationId, 'files'), links: feedOf(s, conversationId, 'links') })),
  );
  const [query, setQuery] = useState('');
  const [sender, setSender] = useState<string | null>(null);
  useEffect(() => {
    setQuery('');
    setSender(null);
  }, [conversationId]);
  const all = useMemo(
    () => (filter === 'all' ? mergedAll(feeds, loaded) : mergedList(feeds[filter].items, loaded, filter, loadedSince(feeds[filter]))),
    [feeds, loaded, filter],
  );
  const senders = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of all) if (!byId.has(m.senderId)) byId.set(m.senderId, senderName(m));
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }, [all]);
  const listing = useMemo(() => {
    const q = fold(query);
    const items = all.filter((m) => (!sender || m.senderId === sender) && (!q || fold(searchText(m)).includes(q)));
    return { items, days: days(items) };
  }, [all, query, sender]);
  const narrowed = !!query.trim() || !!sender;
  const state = filterFeedState(filterKinds(filter).map((k) => feeds[k]));
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // A list the overview had not (or could not) read is read now.
  useEffect(() => {
    void loadFilterIfNeeded(conversationId, filter);
    scroller.current?.scrollTo({ top: 0 });
  }, [conversationId, filter]);

  // The spinner row under the last day asks for the next page while it is on screen, again after each page lands.
  const depth = filterKinds(filter).map((k) => `${feeds[k].items.length}:${feeds[k].cursor}`).join('|');
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !state.canLoadMore) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMoreFilter(conversationId, filter), {
      root: scroller.current,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [conversationId, filter, state.canLoadMore, depth]);

  const chooseSender = (el: Element) =>
    openMenuBelow(el, [
      { label: 'Tất cả người gửi', checked: sender === null, onSelect: () => setSender(null) },
      { kind: 'separator' },
      ...senders.map((p) => ({ label: p.name, checked: sender === p.id, onSelect: () => setSender(p.id) })),
    ]);

  const chooseFilter = (el: Element) =>
    openMenuBelow(
      el,
      sharedMediaFilters.map((f) => ({ label: filterTitles[f], checked: f === filter, onSelect: () => browseSharedMedia(conversationId, f) })),
      'end',
    );

  return (
    <div className="sm-browser" onKeyDown={(e) => e.key === 'Escape' && closeSharedMediaBrowser()}>
      <div className="sm-browser-nav">
        <button className="sm-back" onClick={closeSharedMediaBrowser} title="Quay lại thông tin">
          <ChevronLeft size={16} />
          <span>Thông tin</span>
        </button>
        <div className="sm-browser-title">Kho lưu trữ</div>
        <button className="sm-filter" onClick={(e) => chooseFilter(e.currentTarget)} aria-haspopup="menu" title="Lọc theo loại">
          <span>{filterTitles[filter]}</span>
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="sm-toolbar">
        <label className="sm-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={filter === 'images' ? 'Tìm theo người gửi' : 'Tìm theo tên file, link'}
            aria-label="Tìm trong kho lưu trữ"
          />
          {query && (
            <button className="sm-search-clear" onClick={() => setQuery('')} aria-label="Xóa tìm kiếm">
              <X size={12} />
            </button>
          )}
        </label>
        <button className={`sm-chip ${sender ? 'is-on' : ''}`} onClick={(e) => chooseSender(e.currentTarget)} aria-haspopup="menu" disabled={!senders.length}>
          <User size={13} />
          <span className="truncate">{sender ? (senders.find((p) => p.id === sender)?.name ?? 'Người gửi') : 'Người gửi'}</span>
          <ChevronDown size={12} />
        </button>
      </div>
      <div className="sm-browser-scroll" ref={scroller}>
        {!narrowed && <DropTarget conversationId={conversationId} />}
        {listing.items.length === 0 ? (
          <div className="sm-placeholder">
            {state.failed ? (
              <>
                <AlertTriangle size={22} />
                <span>Không tải được dữ liệu</span>
                <button className="sm-link" onClick={() => void retryFilter(conversationId, filter)}>
                  Thử lại
                </button>
              </>
            ) : state.pending || state.loading ? (
              <Spinner size={16} />
            ) : narrowed ? (
              <>
                <span>Không có kết quả phù hợp</span>
                <button
                  className="sm-link"
                  onClick={() => {
                    setQuery('');
                    setSender(null);
                  }}
                >
                  Xóa bộ lọc
                </button>
              </>
            ) : (
              <span>{filterEmpty[filter]}</span>
            )}
          </div>
        ) : (
          listing.days.map((day) => (
            <div key={day.id} className="sm-day">
              <div className="sm-day-title">{daySeparator(day.date)}</div>
              {runsOf(day.items).map((run) =>
                run.kind === 'grid' ? (
                  <div key={run.items[0].id} className="sm-grid">
                    {run.items.map((m) => (
                      <BrowserTile key={m.id} message={m} />
                    ))}
                  </div>
                ) : (
                  <div key={run.items[0].id} className="sm-rows">
                    {run.items.map((m) => (
                      <BrowserRow key={m.id} message={m} />
                    ))}
                  </div>
                ),
              )}
            </div>
          ))
        )}
        {listing.items.length > 0 &&
          (state.someFailed && !state.loading ? (
            <FailureLine text={state.everLoaded ? 'Không tải thêm được' : 'Không tải được danh sách đầy đủ'} onRetry={() => void retryFilter(conversationId, filter)} />
          ) : state.loading || state.hasMore ? (
            <div ref={sentinel} className="sm-pending">
              <Spinner size={14} />
            </div>
          ) : null)}
      </div>
    </div>
  );
}

/**
 * "Thả vào đây để chia sẻ": files dropped on the window go to the open conversation (the chat's window-wide drop
 * handler sends them); this zone shows where, lights up while files are dragged over the window, and picks files on
 * click ("Ảnh hoặc Video" path: photos as photos, the rest as files).
 */
function DropTarget({ conversationId }: { conversationId: string }) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void onFileDrop((e) => setOver(e.kind === 'over')).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return (
    <button
      className={`sm-drop ${over ? 'is-over' : ''}`}
      onClick={() => void sendMedia(conversationId).then((o) => reportComposer(o, conversationId))}
      title="Chọn ảnh, video hoặc tệp để gửi vào cuộc trò chuyện"
    >
      <Upload size={16} />
      <span className="sm-drop-text">
        <span>Thả vào đây để chia sẻ</span>
        <span className="sm-drop-sub">hoặc bấm để chọn tệp</span>
      </span>
    </button>
  );
}

const showInChat = (m: ChatMessage) => void requestJumpToMessage(m.conversationId, m.id, m.date);

const itemMenu = (m: ChatMessage): MenuItem[] => {
  const k = m.kind;
  const items: MenuItem[] = [{ label: 'Xem trong trò chuyện', icon: MessageSquareText, onSelect: () => showInChat(m) }];
  if (k.type === 'photo' && k.url) items.push({ label: 'Lưu về máy…', icon: Download, onSelect: () => void saveMediaAs(k.url!, `Anh-${m.id}.jpg`, m.conversationId) });
  if (k.type === 'video' && k.url) items.push({ label: 'Lưu về máy…', icon: Download, onSelect: () => void saveMediaAs(k.url!, `Video-${m.id}.mp4`, m.conversationId) });
  if (k.type === 'file' && k.url) items.push({ label: 'Lưu về máy…', icon: Download, onSelect: () => void saveMediaAs(k.url!, k.name, m.conversationId) });
  if (k.type === 'link' && k.url) {
    items.push({ label: 'Mở liên kết', icon: ExternalLink, onSelect: () => void openExternal(k.url) });
    items.push({ label: 'Sao chép liên kết', icon: Copy, onSelect: () => void navigator.clipboard.writeText(k.url!).then(() => showToast('Đã sao chép')) });
  }
  return items;
};

const senderName = (m: ChatMessage) => (m.isMine ? 'Bạn' : m.senderName || 'Thành viên');
const senderLine = (m: ChatMessage) => `${senderName(m)}, ${time(m.date)}`;

/** Case / diacritic-insensitive (`đ` folds to `d`); file-name separators count as spaces ("hop dong" finds "Hop-dong.pdf"). */
const fold = (text: string) =>
  text
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[-_.\s]+/g, ' ')
    .trim()
    .toLowerCase();

/** What the search looks at: file name, link title / address / site, and who sent it. */
const searchText = (m: ChatMessage) => {
  const k = m.kind;
  const parts = [senderName(m)];
  if (k.type === 'file') parts.push(k.name);
  if (k.type === 'link') parts.push(k.title, k.url ?? '', k.source);
  return parts.join(' ');
};

/** A photo / video tile; hover shows "Xem trong trò chuyện", right click the item menu. */
function BrowserTile({ message }: { message: ChatMessage }) {
  return (
    <div className="sm-tile" onContextMenu={(e) => openContextMenu(e, itemMenu(message))} title={senderLine(message)}>
      <MediaTile message={message} />
      <button
        className="sm-tile-jump"
        onClick={(e) => {
          e.stopPropagation();
          showInChat(message);
        }}
        title="Xem trong trò chuyện"
        aria-label="Xem trong trò chuyện"
      >
        <MessageSquareText size={13} />
      </button>
    </div>
  );
}

/** A file or link row with who sent it and when, and "Xem trong trò chuyện". */
function BrowserRow({ message }: { message: ChatMessage }) {
  return (
    <div className="sm-browser-row" onContextMenu={(e) => openContextMenu(e, itemMenu(message))}>
      <div className="sm-row-meta">
        <span className="truncate">{senderLine(message)}</span>
        <button className="sm-jump" onClick={() => showInChat(message)}>
          Xem trong trò chuyện
        </button>
      </div>
      {message.kind.type === 'file' ? <FileRow message={message} showDay={false} /> : <LinkRow message={message} />}
    </div>
  );
}

/** The inspector column's content while "Kho lưu trữ" is open for this conversation, else null. */
export function useBrowsingSharedMedia(conversationId: string | null): SharedMediaFilter | null {
  return useSharedMedia((s) => (s.browsing && s.browsing.conversationId === conversationId ? s.browsing.kind : null));
}
