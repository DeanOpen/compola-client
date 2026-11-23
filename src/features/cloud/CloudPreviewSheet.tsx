// Preview of one cloud item (Swift CloudPreviewSheet.swift): downloads it through the official downloader, then shows
// the photo (zoomable), plays the video / voice message, or previews the file when the web view can (PDF, images,
// text). Save goes through the save panel + `media_save`.

import { CheckCircle2, CloudAlert, Clock, Minus, Plus, Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cloudFetch, cloudFileSrc, cloudFileUrl, type CloudFile, type CloudItem } from '../../engine/cloud';
import { saveMediaAs } from '../../engine/save';
import { ContentUnavailable } from '../../ui/ContentUnavailable';
import { Sheet } from '../../ui/Overlays';
import { Spinner } from '../../ui/Spinner';
import { conversationLabel, formatDate, formatSize, itemIcon, itemName, outputName } from './support';

type Phase = { kind: 'loading' } | { kind: 'ready'; file: CloudFile } | { kind: 'expired' } | { kind: 'failed'; message: string };

/** Files the web view previews natively. */
const inlineExts = new Set(['pdf', 'txt', 'md', 'csv', 'json', 'log', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic']);

export function CloudPreviewSheet({ item, onClose }: { item: CloudItem; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSaved(false);
    setPhase({ kind: 'loading' });
    cloudFetch(item.id).then((r) => {
      if (!live) return;
      if (r.state === 'ready') setPhase({ kind: 'ready', file: r.file });
      else if (r.state === 'expired') setPhase({ kind: 'expired' });
      else setPhase({ kind: 'failed', message: r.message });
    });
    return () => {
      live = false;
    };
  }, [item.id, attempt]);

  const save = async () => {
    if (phase.kind !== 'ready') return;
    setNote(null);
    const path = await saveMediaAs(cloudFileUrl(phase.file.path), outputName(item, phase.file.ext));
    if (path) setSaved(true);
  };

  const Icon = itemIcon(item);
  const width = Math.min(980, window.innerWidth - 80);
  const height = Math.min(700, window.innerHeight - 80);

  return (
    <Sheet onClose={onClose} width={width} height={height}>
      <div className="cloud-root cloud-preview">
      <div className="cloud-preview-header">
        <Icon size={18} className="tint" />
        <span className="cloud-preview-titles">
          <span className="cloud-preview-name truncate">{itemName(item)}</span>
          <span className="cloud-preview-meta truncate">{[formatSize(item.size), conversationLabel(item), formatDate(item.date)].join(' • ')}</span>
        </span>
        <button className="cz-icon-btn" onClick={onClose} aria-label="Đóng" title="Đóng">
          <X size={18} />
        </button>
      </div>
      <div className="cloud-preview-content">
        <PreviewContent item={item} phase={phase} onRetry={() => setAttempt((a) => a + 1)} />
      </div>
      <div className="cloud-preview-footer">
        {saved && (
          <span className="cloud-saved">
            <CheckCircle2 size={14} /> Đã lưu về máy
          </span>
        )}
        {note && <span className="cloud-card-warning">{note}</span>}
        <span style={{ flex: 1 }} />
        <button className="cz-btn" onClick={onClose}>
          Đóng
        </button>
        {phase.kind === 'ready' && (
          <button className="cz-btn cz-btn-primary" onClick={() => void save()}>
            <Save size={14} /> Lưu về máy…
          </button>
        )}
      </div>
      </div>
    </Sheet>
  );
}

function PreviewContent({ item, phase, onRetry }: { item: CloudItem; phase: Phase; onRetry: () => void }) {
  switch (phase.kind) {
    case 'loading':
      return (
        <div className="cloud-center">
          <Spinner size={18} />
          <span className="secondary">Đang tải từ zCloud…</span>
        </div>
      );
    case 'expired':
      return <ContentUnavailable icon={Clock} title="Nội dung đã hết hạn" description="Nội dung này không còn trên zCloud." />;
    case 'failed':
      return (
        <ContentUnavailable
          icon={CloudAlert}
          title="Không tải được"
          description={phase.message}
          actions={
            <button className="cz-btn" onClick={onRetry}>
              Thử lại
            </button>
          }
        />
      );
    case 'ready':
      return <ReadyContent item={item} file={phase.file} />;
  }
}

function ReadyContent({ item, file }: { item: CloudItem; file: CloudFile }) {
  const [broken, setBroken] = useState(false);
  if (item.kind === 'photo') return <ZoomableImage src={cloudFileSrc(file.path, 'image')} />;
  if (item.kind === 'video' || item.kind === 'voice') {
    const src = cloudFileSrc(file.path, item.kind === 'video' ? 'video' : 'audio');
    if (broken || !src) {
      return (
        <ContentUnavailable
          icon={CloudAlert}
          title="Không phát được"
          description="Định dạng này không phát được trong ứng dụng. Hãy lưu về máy hoặc mở bằng ứng dụng khác."
        />
      );
    }
    return item.kind === 'video' ? (
      <video className="cloud-preview-video" src={src} controls autoPlay onError={() => setBroken(true)} />
    ) : (
      <div className="cloud-center">
        <audio src={src} controls autoPlay onError={() => setBroken(true)} />
      </div>
    );
  }
  const ext = (file.ext || item.ext).toLowerCase();
  const src = cloudFileSrc(file.path, 'file');
  if (src && inlineExts.has(ext)) return <iframe className="cloud-preview-frame" src={src} title={itemName(item)} sandbox={ext === 'pdf' ? undefined : ''} />;
  const Icon = itemIcon(item);
  return <ContentUnavailable icon={Icon} title={itemName(item)} description="Không xem trước được tệp này. Hãy lưu về máy để mở." />;
}

/** Fit-to-window photo; zoom with the buttons, ⌘ + scroll / pinch, or a double click. */
function ZoomableImage({ src }: { src: string | null }) {
  const [scale, setScale] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const clamp = (s: number) => Math.min(8, Math.max(1, s));
  return (
    <div
      className={`cloud-zoom ${scale > 1 ? 'is-zoomed' : ''}`}
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setScale((s) => clamp(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      }}
      onDoubleClick={() => setScale((s) => (s > 1 ? 1 : 2))}
    >
      {!loaded && (
        <div className="cloud-center" style={{ position: 'absolute', inset: 0 }}>
          <Spinner size={18} />
        </div>
      )}
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          style={scale > 1 ? { width: `${scale * 100}%`, maxWidth: 'none', maxHeight: 'none' } : undefined}
        />
      )}
      <div className="cloud-zoom-controls">
        <button className="cz-icon-btn" onClick={() => setScale((s) => clamp(s / 1.5))} disabled={scale <= 1} title="Thu nhỏ" aria-label="Thu nhỏ">
          <Minus size={14} />
        </button>
        <span className="cloud-zoom-value nums">{Math.round(scale * 100)}%</span>
        <button className="cz-icon-btn" onClick={() => setScale((s) => clamp(s * 1.5))} disabled={scale >= 8} title="Phóng to" aria-label="Phóng to">
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
