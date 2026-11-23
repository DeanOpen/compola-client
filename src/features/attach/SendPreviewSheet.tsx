// Wave 3 #2 (Telegram "Send N photos"): what ⌘V / drop is about to send — photos and videos as a mosaic (1 large + up
// to 3 small, "+N"), other files as chips — each removable, plus a caption that goes out as a text message after the
// media. Hủy / Gửi; Enter sends, ⇧Enter is a new line. Local files are served by the media scheme once
// `media_allow_previews` allowed them (paths outside the data folders, 30 min).

import { Film, ImageOff, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { commands, usesMock } from '../../engine/backend';
import { localPreviewUrl } from '../../engine/media';
import { FileChip } from '../chat-parts/FileChip';
import { extensionOf, fileTypeOf } from '../chat-parts/fileTypes';
import { Sheet } from '../../ui/Overlays';
import './attach.css';

export interface SendPreviewSheetProps {
  conversationName: string;
  /** Absolute paths (picked, pasted or dropped). In the browser mock, http(s) URLs stand in for files. */
  paths: string[];
  onCancel: () => void;
  /** The paths left after removals, and the trimmed caption ("" when none). */
  onSend: (paths: string[], caption: string) => void;
}

type Kind = 'image' | 'video' | 'file';

const kindOf = (path: string): Kind => {
  const family = fileTypeOf(path).family;
  // Mock stand-ins (picsum URLs) have no extension: they are photos.
  if (family === 'image' || (/^https?:/.test(path) && !extensionOf(path.split('?')[0]))) return 'image';
  return family === 'video' ? 'video' : 'file';
};

const fileName = (path: string) => decodeURIComponent(path.split('?')[0].split('/').pop() || path);

/** "Gửi 4 ảnh tới Lan", "Gửi 2 video …", "Gửi 3 ảnh và video …", "Gửi 2 tệp …", "Gửi 5 mục …". */
export const sendTitle = (kinds: Kind[], name: string): string => {
  const n = kinds.length;
  const has = (k: Kind) => kinds.includes(k);
  const what =
    n === 0
      ? 'mục'
      : !has('file')
        ? has('image') && has('video')
          ? 'ảnh và video'
          : has('video')
            ? 'video'
            : 'ảnh'
        : has('image') || has('video')
          ? 'mục'
          : 'tệp';
  return `Gửi ${n} ${what} tới ${name}`;
};

export function SendPreviewSheet({ conversationName, paths, onCancel, onSend }: SendPreviewSheetProps) {
  const [items, setItems] = useState(() => [...new Set(paths)]);
  const [caption, setCaption] = useState('');
  const [showAll, setShowAll] = useState(false);
  // Local files may only be requested once Rust allowed them.
  const [allowed, setAllowed] = useState(usesMock);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
    if (usesMock) return;
    commands
      .mediaAllowPreviews(paths.filter((p) => p.startsWith('/')))
      .catch(() => 0)
      .finally(() => setAllowed(true));
  }, []);

  const media = useMemo(() => items.filter((p) => kindOf(p) !== 'file'), [items]);
  const files = useMemo(() => items.filter((p) => kindOf(p) === 'file'), [items]);
  const title = sendTitle(items.map(kindOf), conversationName);
  const remove = (p: string) => setItems((list) => list.filter((x) => x !== p));
  const send = () => items.length && onSend(items, caption.trim());

  useEffect(() => {
    if (media.length <= 4) setShowAll(false);
  }, [media.length]);

  return (
    <Sheet onClose={onCancel} width={440}>
      <div className="send-preview">
        <div className="send-preview-header">
          <span className="send-preview-title truncate" title={title}>
            {title}
          </span>
          <button className="send-preview-close" onClick={onCancel} aria-label="Đóng" title="Đóng">
            <X size={18} />
          </button>
        </div>
        <div className="send-preview-body">
          {media.length > 0 &&
            (showAll ? (
              <div className="send-preview-all">
                {media.map((p) => (
                  <Tile key={p} path={p} allowed={allowed} onRemove={() => remove(p)} />
                ))}
              </div>
            ) : (
              <div className={`send-preview-mosaic is-${Math.min(media.length, 4)}`}>
                {media.slice(0, 4).map((p, i) => (
                  <Tile
                    key={p}
                    path={p}
                    allowed={allowed}
                    onRemove={() => remove(p)}
                    more={i === 3 && media.length > 4 ? media.length - 4 : 0}
                    onMore={() => setShowAll(true)}
                  />
                ))}
              </div>
            ))}
          {showAll && (
            <button className="send-preview-collapse" onClick={() => setShowAll(false)}>
              Thu gọn
            </button>
          )}
          {files.length > 0 && (
            <div className="send-preview-files">
              {files.map((p) => (
                <FileChip
                  key={p}
                  name={fileName(p)}
                  size={null}
                  onOpen={() => {}}
                  trailing={
                    <button className="send-preview-remove-file" onClick={() => remove(p)} aria-label={`Bỏ ${fileName(p)}`} title="Bỏ tệp này">
                      <X size={15} />
                    </button>
                  }
                />
              ))}
            </div>
          )}
          {!items.length && <div className="send-preview-empty">Không còn gì để gửi.</div>}
        </div>
        <div className="send-preview-caption">
          <textarea
            ref={field}
            rows={1}
            value={caption}
            placeholder="Thêm chú thích…"
            onChange={(e) => {
              setCaption(e.target.value);
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
        </div>
        <div className="send-preview-footer">
          <button className="send-preview-btn" onClick={onCancel}>
            Hủy
          </button>
          <button className="send-preview-btn is-primary" onClick={send} disabled={!items.length}>
            Gửi
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function Tile({ path, allowed, onRemove, more = 0, onMore }: { path: string; allowed: boolean; onRemove: () => void; more?: number; onMore?: () => void }) {
  const kind = kindOf(path);
  const [failed, setFailed] = useState(false);
  const src = !allowed ? null : /^https?:/.test(path) ? path : localPreviewUrl(path, kind === 'video' ? 'video' : 'image');
  return (
    <div className="send-tile" title={fileName(path)}>
      {src && !failed ? (
        kind === 'video' ? (
          <video src={src} muted preload="metadata" onError={() => setFailed(true)} />
        ) : (
          <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />
        )
      ) : (
        <span className="send-tile-fallback">
          {kind === 'video' ? <Film size={22} /> : <ImageOff size={22} />}
          <span className="truncate">{fileName(path)}</span>
        </span>
      )}
      {kind === 'video' && src && !failed && (
        <span className="send-tile-badge">
          <Film size={11} /> Video
        </span>
      )}
      {more > 0 && (
        <button className="send-tile-more" onClick={onMore} aria-label={`Xem thêm ${more} mục`}>
          +{more}
        </button>
      )}
      <button className="send-tile-remove" onClick={onRemove} aria-label={`Bỏ ${fileName(path)}`} title="Bỏ">
        <X size={13} />
      </button>
    </div>
  );
}
