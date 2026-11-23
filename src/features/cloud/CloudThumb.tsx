// Square-ish thumbnail of a photo / video (Swift `CloudThumbnailView`): the official downloader fetches the item (photos
// are small; videos only up to a size), then the image is shown or a video frame is drawn by a muted <video>.

import { Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cloudFileSrc, cloudThumbnail, type CloudItem, type CloudThumb } from '../../engine/cloud';
import { kindIcon } from './support';

export function CloudThumbView({ item, compact = false }: { item: CloudItem; compact?: boolean }) {
  const [state, setState] = useState<CloudThumb | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);
  /** A video the web view cannot decode for a frame: try it as an image (a poster), then give up. */
  const [asImage, setAsImage] = useState(false);

  useEffect(() => {
    let live = true;
    setState(null);
    setBroken(false);
    setAsImage(false);
    cloudThumbnail(item.id, attempt > 0).then((r) => live && setState(r));
    return () => {
      live = false;
    };
  }, [item.id, attempt]);

  const Icon = kindIcon(item.kind);
  let body;
  if (state?.state === 'file' && !broken) {
    const src = cloudFileSrc(state.path, item.kind === 'video' ? 'video' : 'image');
    body =
      item.kind === 'video' && !asImage ? (
        <video className="cloud-thumb-media" src={src ? `${src}#t=0.4` : undefined} muted preload="metadata" playsInline onError={() => setAsImage(true)} />
      ) : (
        <img className="cloud-thumb-media" src={src ?? undefined} alt="" draggable={false} loading="lazy" onError={() => setBroken(true)} />
      );
  } else if (state?.state === 'expired') {
    body = (
      <span className="cloud-thumb-state">
        <Clock size={compact ? 16 : 20} />
        {!compact && <span>Đã hết hạn</span>}
      </span>
    );
  } else if (state) {
    body = (
      <button
        className="cloud-thumb-state"
        onClick={(e) => {
          e.stopPropagation();
          setAttempt((a) => a + 1);
        }}
        title="Thử lại"
      >
        <Icon size={compact ? 18 : 22} />
        {item.kind === 'photo' && !compact && <span>Thử lại</span>}
      </button>
    );
  } else {
    body = <span className="cloud-skeleton" aria-label="Đang tải" />;
  }
  return <div className="cloud-thumb">{body}</div>;
}
