// Mock of `window.__zaloMediaStore` (media-store-adapter.js): months of photos / videos, files and links per
// conversation, newest first, paged by cursor. Dev aids: `&sharedMedia=images|files|links` opens "Kho lưu trữ" in the
// inspector of the open chat (with `&open=<id>&inspector=1`), `&viewer=1` opens the media viewer on its newest photo.

import type { Json } from '../../models/json';
import { message } from '../mockData';
import { onMockBoot, registerMockAdapter } from '../registry';

const day = 86_400_000;
const people = [
  { from: 'u-lan', name: 'Trần Thị Lan', avatar: 'https://i.pravatar.cc/150?img=47' },
  { from: 'u-huy', name: 'Lê Quang Huy', avatar: 'https://i.pravatar.cc/150?img=12' },
  { from: 'u-me' },
  { from: 'u-mai', name: 'Phạm Ngọc Mai', avatar: 'https://i.pravatar.cc/150?img=32' },
];
const photoIds = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43];
const files = [
  ['Bao-cao-quy-3.xlsx', 48_211],
  ['Hop-dong-thue-nha.pdf', 2_400_000],
  ['Thiet-ke-v2.fig', 18_000_000],
  ['Anh-su-kien.zip', 95_300_000],
  ['Ke-hoach-2027.docx', 120_400],
  ['Danh-sach-khach-moi.csv', 8_900],
] as const;
const links = [
  ['Compola – Thiết kế giao diện', 'https://www.figma.com/file/compola-design', 'figma.com'],
  ['Lịch nghỉ Tết 2027', 'https://vnexpress.net/lich-nghi-tet-2027', 'vnexpress.net'],
  ['Hướng dẫn chạy bộ 10K', 'https://runningvn.com/huong-dan-10k', 'runningvn.com'],
  ['Album ảnh Đà Lạt', 'https://photos.google.com/share/dalat', 'photos.google.com'],
] as const;

const stores = new Map<string, Record<string, Json[]>>();

const build = (convId: string): Record<string, Json[]> => {
  const seed = [...convId].reduce((n, c) => n + c.charCodeAt(0), 0);
  const make = (kind: string, count: number, f: (i: number) => Json) =>
    Array.from({ length: count }, (_, i) => ({ ...f(i), id: `store-${convId}-${kind}-${i}` }));
  const who = (i: number) => people[(i + seed) % people.length];
  const ago = (i: number, spread: number) => day + i * spread * day + ((i * 7919) % 36_000_000);
  return {
    images: make('img', 64, (i) => {
      const p = who(i);
      if (i % 9 === 4) {
        return message(convId, { ...p, text: '[Video]', ago: ago(i, 2.3), kind: { type: 'video', thumbnail: `https://picsum.photos/id/${photoIds[(i + seed) % photoIds.length]}/520/320`, duration: 30 + i, url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' } });
      }
      const id = photoIds[(i + seed) % photoIds.length];
      const w = i % 3 === 0 ? 800 : 1200;
      const h = i % 3 === 0 ? 1100 : 800;
      return message(convId, { ...p, text: '[Hình ảnh]', ago: ago(i, 2.3), kind: { type: 'photo', url: `https://picsum.photos/id/${id}/${w}/${h}`, width: w, height: h } });
    }),
    files: make('file', 14, (i) => {
      const [name, size] = files[(i + seed) % files.length];
      return message(convId, { ...who(i), text: `[File] ${name}`, ago: ago(i, 9), kind: { type: 'file', name, size, url: `https://example.com/${name}` } });
    }),
    links: make('link', 9, (i) => {
      const [title, url, source] = links[(i + seed) % links.length];
      return message(convId, { ...who(i), text: url, ago: ago(i, 13), kind: { type: 'link', title, url, thumbnail: null, description: '', source } });
    }),
  };
};

registerMockAdapter('__zaloMediaStore', {
  page: (convId: string, kind: string, cursor: string | null, limit: number) =>
    new Promise((resolve) => {
      if (!stores.has(convId)) stores.set(convId, build(convId));
      const all = stores.get(convId)![kind] ?? [];
      const start = cursor ? all.findIndex((m) => m.id === cursor) + 1 : 0;
      const items = all.slice(start, start + (Number(limit) || 30));
      const last = items[items.length - 1];
      setTimeout(() => resolve({ items, cursor: last ? String(last.id) : null, more: start + items.length < all.length }), 350);
    }),
  item: () => null,
});

onMockBoot((ctx) => {
  const kind = ctx.params.get('sharedMedia');
  const open = ctx.params.get('open');
  if (kind && open) {
    void import('../../sharedMedia').then(({ browseSharedMedia }) =>
      setTimeout(() => browseSharedMedia(open, (['images', 'files', 'links'].includes(kind) ? kind : 'images') as 'images'), 300),
    );
  }
  if (ctx.params.has('viewer') && open) {
    void Promise.all([import('../../sharedMedia'), import('../../store'), import('../../../features/media/MediaViewer')]).then(([sm, st, mv]) =>
      setTimeout(async () => {
        await sm.refreshSharedMedia(open);
        const loaded = st.getEngine().messages[open] ?? [];
        const gallery = sm.galleryOf(open, loaded);
        const pick = ctx.params.get('viewer') === 'video' ? [...gallery].reverse().find((m) => m.kind.type === 'video') : gallery[gallery.length - 1];
        if (pick && (pick.kind.type === 'photo' || pick.kind.type === 'video')) mv.openViewer({ kind: pick.kind.type, url: pick.kind.url, message: pick });
      }, 1200),
    );
  }
});
