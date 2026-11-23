// The inspector's shared content (Swift ChatInspector media / files / links sections + InspectorBlocks tiles) and its
// "Kho lưu trữ" page (Swift Shell/SharedMediaBrowser.swift): everything ever shared in the conversation, read page by
// page from the official media service and merged with the loaded messages. Zalo PC right-panel style: collapsible
// "Ảnh/Video" (3-column grid), "File" and "Link" sections, each with "Xem tất cả".

import { AlertTriangle, ChevronDown, ChevronLeft, File, FileArchive, FileImage, FileSpreadsheet, FileText, FileVideo, Link as LinkIcon, type LucideIcon } from 'lucide-react';
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
  loadMoreSharedMedia,
  loadSharedMediaIfNeeded,
  mergedList,
  months,
  previewList,
  refreshSharedMedia,
  retrySharedMedia,
  useSharedMedia,
  type SharedMediaKind,
} from '../../engine/sharedMedia';
import { useEngine } from '../../engine/store';
import { openExternal } from '../../engine/system';
import { Spinner } from '../../ui/Spinner';
import { PhotoView, VideoThumb } from '../chat/cards/Media';
import { daySeparator, host } from '../chat/format';
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

/** A file: icon, name, size and day; a click saves it ("Lưu về máy…"). */
function FileRow({ message }: { message: ChatMessage }) {
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
          {[size > 0 ? formatBytes(size) : null, daySeparator(message.date)].filter(Boolean).join(' · ')}
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

/** The full page, in place of the inspector's overview. */
export function SharedMediaBrowser({ conversationId, kind }: { conversationId: string; kind: SharedMediaKind }) {
  useSharedMediaRefresh(conversationId);
  const loaded = useEngine((s) => s.messages[conversationId] ?? emptyMessages);
  const feed = useSharedMedia((s) => feedOf(s, conversationId, kind));
  const listing = useMemo(() => {
    const items = mergedList(feed.items, loaded, kind, loadedSince(feed));
    return { items, months: months(items) };
  }, [feed, loaded, kind]);
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // A tab the overview had not (or could not) read is read now.
  useEffect(() => {
    void loadSharedMediaIfNeeded(conversationId, kind);
    scroller.current?.scrollTo({ top: 0 });
  }, [conversationId, kind]);

  // The spinner row under the last month asks for the next page while it is on screen, again after each page lands.
  const canLoadMore = feed.phase === 'idle' && feed.loaded && feed.more;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canLoadMore) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMoreSharedMedia(conversationId, kind), {
      root: scroller.current,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [conversationId, kind, canLoadMore, feed.items.length, feed.cursor]);

  return (
    <div className="sm-browser" onKeyDown={(e) => e.key === 'Escape' && closeSharedMediaBrowser()}>
      <div className="sm-browser-nav">
        <button className="sm-back" onClick={closeSharedMediaBrowser} title="Quay lại thông tin">
          <ChevronLeft size={16} />
          <span>Thông tin</span>
        </button>
        <div className="sm-browser-title">Kho lưu trữ</div>
      </div>
      <div className="sm-tabs" role="tablist" aria-label="Loại nội dung">
        {(['images', 'files', 'links'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={k === kind} className={k === kind ? 'is-selected' : ''} onClick={() => browseSharedMedia(conversationId, k)}>
            {k === 'images' ? 'Ảnh/Video' : k === 'files' ? 'Tệp' : 'Liên kết'}
          </button>
        ))}
      </div>
      <div className="sm-browser-scroll" ref={scroller}>
        {listing.items.length === 0 ? (
          <div className="sm-placeholder">
            {feed.phase === 'failed' ? (
              <>
                <AlertTriangle size={22} />
                <span>Không tải được dữ liệu</span>
                <button className="sm-link" onClick={() => void retrySharedMedia(conversationId, kind)}>
                  Thử lại
                </button>
              </>
            ) : isPending(feed) || feed.phase === 'loading' ? (
              <Spinner size={16} />
            ) : (
              <span>{emptyTexts[kind]}</span>
            )}
          </div>
        ) : (
          listing.months.map((month) => (
            <div key={month.id} className="sm-month">
              <div className="sm-month-title">{month.title}</div>
              {kind === 'images' ? (
                <div className="sm-grid">
                  {month.items.map((m) => (
                    <MediaTile key={m.id} message={m} />
                  ))}
                </div>
              ) : (
                <div className="sm-rows">
                  {month.items.map((m) => (kind === 'files' ? <FileRow key={m.id} message={m} /> : <LinkRow key={m.id} message={m} />))}
                </div>
              )}
            </div>
          ))
        )}
        {listing.items.length > 0 &&
          (feed.phase === 'failed' ? (
            <FailureLine text={feed.loaded ? 'Không tải thêm được' : 'Không tải được danh sách đầy đủ'} onRetry={() => void retrySharedMedia(conversationId, kind)} />
          ) : feed.phase === 'loading' || (feed.loaded && feed.more) ? (
            <div ref={sentinel} className="sm-pending">
              <Spinner size={14} />
            </div>
          ) : null)}
      </div>
    </div>
  );
}

/** The inspector column's content while "Kho lưu trữ" is open for this conversation, else null. */
export function useBrowsingSharedMedia(conversationId: string | null): SharedMediaKind | null {
  return useSharedMedia((s) => (s.browsing && s.browsing.conversationId === conversationId ? s.browsing.kind : null));
}
