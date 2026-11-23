// Wave 3 #7: several photos of one send as one mosaic (2 / 3 / 4 layouts, "+N" on the last tile beyond 4) instead of
// stacked singles. Tiles go through RemoteImage (media scheme, failure + retry state).

import type { CSSProperties } from 'react';
import { RemoteImage } from '../../ui/RemoteImage';
import './chatParts.css';

export interface MosaicPhoto {
  url: string | null;
  width: number;
  height: number;
}

export interface PhotoMosaicProps {
  photos: MosaicPhoto[];
  onOpen?: (index: number) => void;
  /** Width of the whole mosaic in px (default 360). */
  width?: number;
  className?: string;
}

const ratio = (p: MosaicPhoto) => (p.width > 0 && p.height > 0 ? p.width / p.height : 1);
const GAP = 2;

export function PhotoMosaic({ photos, onOpen, width = 360, className = '' }: PhotoMosaicProps) {
  if (!photos.length) return null;
  const shown = photos.slice(0, 4);
  const extra = photos.length - shown.length;

  const tile = (i: number, style: CSSProperties) => (
    <button key={i} className="mosaic-tile" style={style} onClick={() => onOpen?.(i)} aria-label={`Ảnh ${i + 1}/${photos.length}`}>
      <RemoteImage url={shown[i].url} compact />
      {extra > 0 && i === shown.length - 1 && <span className="mosaic-more">+{extra}</span>}
    </button>
  );

  let height: number;
  let tiles: React.ReactNode[];
  switch (shown.length) {
    case 1: {
      const r = Math.min(Math.max(ratio(shown[0]), 0.6), 2.2);
      height = Math.round(width / r);
      tiles = [tile(0, { left: 0, top: 0, width, height })];
      break;
    }
    case 2: {
      // Side by side (portrait pair) or stacked (two wide panoramas).
      const wide = ratio(shown[0]) > 1.6 && ratio(shown[1]) > 1.6;
      const half = (width - GAP) / 2;
      height = wide ? Math.round(width / 1.25) : Math.round(half * 1.25);
      tiles = wide
        ? [tile(0, { left: 0, top: 0, width, height: (height - GAP) / 2 }), tile(1, { left: 0, top: (height + GAP) / 2, width, height: (height - GAP) / 2 })]
        : [tile(0, { left: 0, top: 0, width: half, height }), tile(1, { left: half + GAP, top: 0, width: half, height })];
      break;
    }
    case 3: {
      // A landscape first photo goes on top; otherwise it fills the left two thirds.
      if (ratio(shown[0]) >= 1.15) {
        const top = Math.round(width / Math.min(ratio(shown[0]), 2));
        const bottom = Math.round((width - GAP) / 2);
        height = top + GAP + bottom;
        tiles = [
          tile(0, { left: 0, top: 0, width, height: top }),
          tile(1, { left: 0, top: top + GAP, width: (width - GAP) / 2, height: bottom }),
          tile(2, { left: (width + GAP) / 2, top: top + GAP, width: (width - GAP) / 2, height: bottom }),
        ];
      } else {
        height = Math.round(width * 0.8);
        const big = Math.round((width - GAP) * 0.62);
        const small = width - GAP - big;
        tiles = [
          tile(0, { left: 0, top: 0, width: big, height }),
          tile(1, { left: big + GAP, top: 0, width: small, height: (height - GAP) / 2 }),
          tile(2, { left: big + GAP, top: (height + GAP) / 2, width: small, height: (height - GAP) / 2 }),
        ];
      }
      break;
    }
    default: {
      const half = (width - GAP) / 2;
      height = width;
      tiles = [0, 1, 2, 3].map((i) => tile(i, { left: (i % 2) * (half + GAP), top: Math.floor(i / 2) * (half + GAP), width: half, height: half }));
    }
  }

  return (
    <div className={`photo-mosaic ${className}`} style={{ width, height }} role="group" aria-label={`${photos.length} ảnh`}>
      {tiles}
    </div>
  );
}
