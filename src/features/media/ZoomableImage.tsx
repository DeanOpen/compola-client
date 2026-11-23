// Swift `ZoomableImageView` + `ZoomController` + `ZoomControls`: a photo that opens fitted, zooms around the pointer
// (pinch / ⌘-scroll, ⌘+ ⌘− ⌘0 ⌘9, double click = fit ↔ 100 %) and pans by dragging or scrolling while zoomed.

import { Maximize, Minimize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { create } from 'zustand';

const minScale = 0.05;
const maxScale = 8;
const step = 1.25;

/** What the zoom controls of the top bar read and drive (one viewer, one controller). */
interface ZoomState {
  /** Scale relative to the image's pixels (1 = 100 %). */
  scale: number;
  isFitted: boolean;
  hasContent: boolean;
  /** Set by the mounted image. */
  actions: { zoomBy: (factor: number) => void; fit: () => void; actualSize: () => void } | null;
}

export const useZoom = create<ZoomState>()(() => ({ scale: 1, isFitted: true, hasContent: false, actions: null }));

export const zoom = {
  zoomIn: () => useZoom.getState().actions?.zoomBy(step),
  zoomOut: () => useZoom.getState().actions?.zoomBy(1 / step),
  fit: () => useZoom.getState().actions?.fit(),
  actualSize: () => useZoom.getState().actions?.actualSize(),
  toggleActualSize: () => (useZoom.getState().isFitted ? zoom.actualSize() : zoom.fit()),
};

interface View {
  scale: number;
  x: number;
  y: number;
  fitted: boolean;
}

export function ZoomableImage({ src, onError, onLoad }: { src: string; onError: () => void; onLoad?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, fitted: true });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBoxSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fitScale = natural && boxSize.w > 0 ? Math.min(1, boxSize.w / natural.w, boxSize.h / natural.h) : 1;

  /** Keeps the picture centered when smaller than the box, and its edges inside the box when larger. */
  const clamp = useCallback(
    (v: View): View => {
      if (!natural) return v;
      const w = natural.w * v.scale;
      const h = natural.h * v.scale;
      const limX = Math.max(0, (w - boxSize.w) / 2);
      const limY = Math.max(0, (h - boxSize.h) / 2);
      return { ...v, x: Math.min(limX, Math.max(-limX, v.x)), y: Math.min(limY, Math.max(-limY, v.y)) };
    },
    [natural, boxSize],
  );

  // A fitted image stays fitted when the window resizes.
  useEffect(() => {
    setView((v) => (v.fitted ? { scale: fitScale, x: 0, y: 0, fitted: true } : clamp(v)));
  }, [fitScale, clamp]);

  /** Zoom by `factor` keeping the point (`px`,`py`, box coordinates from its center) under the pointer. */
  const zoomAt = useCallback(
    (factor: number, px = 0, py = 0) => {
      setView((v) => {
        const scale = Math.min(maxScale, Math.max(Math.min(minScale, fitScale), v.scale * factor));
        const k = scale / v.scale;
        const next = { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k, fitted: Math.abs(scale - fitScale) < 1e-3 };
        return clamp(next);
      });
    },
    [fitScale, clamp],
  );

  useEffect(() => {
    useZoom.setState({
      scale: view.scale,
      isFitted: view.fitted,
      hasContent: !!natural,
      actions: {
        zoomBy: (f) => zoomAt(f),
        fit: () => setView({ scale: fitScale, x: 0, y: 0, fitted: true }),
        actualSize: () => setView(clamp({ scale: 1, x: 0, y: 0, fitted: Math.abs(1 - fitScale) < 1e-3 })),
      },
    });
  }, [view, natural, zoomAt, fitScale, clamp]);

  useEffect(() => () => useZoom.setState({ hasContent: false, actions: null, scale: 1, isFitted: true }), []);

  // Wheel: pinch (ctrl-wheel) or ⌘-scroll zooms around the pointer; plain scrolling pans a zoomed photo.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left - r.width / 2;
      const py = e.clientY - r.top - r.height / 2;
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), px, py);
      else setView((v) => clamp({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, clamp]);

  const canPan = natural ? natural.w * view.scale > boxSize.w + 1 || natural.h * view.scale > boxSize.h + 1 : false;

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!canPan || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => clamp({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    if (view.fitted && fitScale < 1) zoomAt(1 / view.scale, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    else setView({ scale: fitScale, x: 0, y: 0, fitted: true });
  };

  return (
    <div
      ref={box}
      className={`mv-zoom ${canPan ? (dragging ? 'is-grabbing' : 'can-pan') : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          setNatural({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
          onLoad?.();
        }}
        onError={onError}
        style={
          natural
            ? {
                width: natural.w,
                height: natural.h,
                transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                opacity: 1,
              }
            : { opacity: 0 }
        }
      />
    </div>
  );
}

/** Zoom out, percent (click = fit), zoom in, fit / 100 % toggle (Swift `ZoomControls`). */
export function ZoomControls() {
  const { scale, isFitted, hasContent } = useZoom();
  const percent = Math.round(scale * 100);
  return (
    <div className="mv-group">
      <button className="mv-icon" disabled={!hasContent} onClick={zoom.zoomOut} title="Thu nhỏ (⌘−)" aria-label="Thu nhỏ">
        <ZoomOut size={15} />
      </button>
      <button className="mv-pill nums" disabled={!hasContent} onClick={zoom.fit} title="Vừa khung (⌘9)" aria-label={`Mức thu phóng ${percent} phần trăm`}>
        {percent}%
      </button>
      <button className="mv-icon" disabled={!hasContent} onClick={zoom.zoomIn} title="Phóng to (⌘+)" aria-label="Phóng to">
        <ZoomIn size={15} />
      </button>
      {isFitted ? (
        <button className="mv-icon" disabled={!hasContent} onClick={zoom.actualSize} title="Kích thước thật (⌘0)" aria-label="Kích thước thật">
          <Maximize size={14} />
        </button>
      ) : (
        <button className="mv-icon" disabled={!hasContent} onClick={zoom.fit} title="Vừa khung (⌘9)" aria-label="Vừa khung">
          <Minimize2 size={14} />
        </button>
      )}
    </div>
  );
}
