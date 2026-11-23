// Mock of `window.__zaloSticker` (host-scripts/sticker-adapter.js): two sets plus "Gần đây", search, typing
// suggestions (only for a few keywords) and send (posts a sticker message into the chat).
import { ME, message } from '../mockData';
import { mockContext, registerMockAdapter } from '../registry';

const twemoji = (code: string) => `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${code}.png`;
const sets: { id: number; name: string; codes: string[] }[] = [
  { id: 10, name: 'Mặt cười', codes: ['1f600', '1f602', '1f60d', '1f60e', '1f622', '1f621', '1f914', '1f973', '1f634', '1f970', '1f92f', '1f644'] },
  { id: 11, name: 'Thú cưng', codes: ['1f436', '1f431', '1f43c', '1f98a', '1f430', '1f428', '1f42f', '1f981', '1f438'] },
];
const sticker = (cateId: number, code: string) => ({ cateId, id: parseInt(code, 16), url: twemoji(code) });
const all = sets.flatMap((s) => s.codes.map((c) => sticker(s.id, c)));
const keywords: Record<string, string[]> = { haha: ['1f602', '1f923'], 'yêu': ['1f60d', '1f970'], buồn: ['1f622'], 'mèo': ['1f431'], ok: ['1f60e', '1f44d'] };
const recent: ReturnType<typeof sticker>[] = [];
let suggestOn = true;
const later = <T>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(v), ms));

registerMockAdapter('__zaloSticker', {
  categories: () =>
    later([...(recent.length ? [{ id: -2, name: 'Gần đây', icon: '', count: recent.length }] : []), ...sets.map((s) => ({ id: s.id, name: s.name, icon: twemoji(s.codes[0]), count: s.codes.length }))]),
  category: (id: number) => later({ id, stickers: id === -2 ? recent : (sets.find((s) => s.id === id)?.codes ?? []).map((c) => sticker(id, c)) }),
  search: (text: string) => {
    const q = text.trim().toLowerCase();
    const codes = Object.entries(keywords).flatMap(([k, v]) => (k.includes(q) || q.includes(k) ? v : []));
    return later(codes.map((c) => all.find((s) => s.url === twemoji(c)) ?? sticker(10, c)), 300);
  },
  suggest: (_conv: string, text: string) => {
    if (!suggestOn) return [];
    const codes = keywords[text.trim().toLowerCase()] ?? [];
    return later(codes.map((c) => sticker(10, c)), 120);
  },
  send: (convId: string, target: { cateId: number; id: number }) => {
    const s = all.find((x) => x.cateId === target.cateId && x.id === target.id) ?? sticker(target.cateId, target.id.toString(16));
    const i = recent.findIndex((r) => r.id === s.id);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(s);
    recent.splice(12);
    const m = message(convId, { from: ME.userId, text: '[Sticker]', kind: { type: 'sticker', url: s.url }, ago: 0 });
    mockContext().post({ chat: { convId, messages: [m], removed: [], hasMore: true, reset: false } });
    return later({ status: 'done' }, 200);
  },
  suggestSetting: () => ({ ok: true, enabled: suggestOn, debounce: 0 }),
  setSuggestSetting: (on: boolean) => {
    suggestOn = on;
    return { ok: true, enabled: on };
  },
  reset: () => undefined,
});
