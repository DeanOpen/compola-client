// Swift `MediaFailureView`: the photo / video could not be loaded — expired, or unavailable with a retry.

import { ImageOff, RefreshCw, VideoOff } from 'lucide-react';

export function MediaFailure({ expired, video = false, retry }: { expired: boolean; video?: boolean; retry: () => void }) {
  const Icon = video ? VideoOff : ImageOff;
  const what = video ? 'Video' : 'Ảnh';
  return (
    <div className="mv-failure-card">
      <Icon size={26} />
      <span>{expired ? `${what} đã hết hạn` : video ? 'Không thể phát video này.' : 'Không tải được ảnh'}</span>
      {!expired && (
        <button className="mv-pill" onClick={retry}>
          <RefreshCw size={12} /> Thử lại
        </button>
      )}
    </div>
  );
}
