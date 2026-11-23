// Mock `window.__zaloCloud` (host-scripts/zcloud-adapter.js): plan, usage, conversations, a paged item table, fetch,
// delete and the offload setting. Dev aids: `&dest=zcloud`, `&cloudRoute=media|conversations|myCloud|plan|settings`,
// `&cloudPreview=photo|video|file`, `&cloudPlan=free|grace`, `&cloudConv=<id>`, `&cloudClick=Danh sách,Chọn` (clicks
// buttons by aria-label or text, in order, once the screen is up).

import type { Json } from '../../models/json';
import { conversations, SELF_CONV } from '../mockData';
import { onMockBoot, registerMockAdapter, type MockContext } from '../registry';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const day = 86_400_000;

type Kind = 'photo' | 'video' | 'file' | 'voice';

interface Item {
  key: string;
  kind: Kind;
  conv: string;
  convName: string;
  size: number;
  date: number;
  title: string;
  ext: string;
  duration: number;
  width: number;
  height: number;
}

const files = [
  ['Bao-cao-quy-3.pdf', 'pdf'],
  ['Hop-dong-thue-nha.docx', 'docx'],
  ['Ngan-sach-2026.xlsx', 'xlsx'],
  ['Slide-ra-mat-Compola.pptx', 'pptx'],
  ['Anh-cuoi.zip', 'zip'],
  ['ghi-chu.txt', 'txt'],
  ['nhac-dam-cuoi.mp3', 'mp3'],
] as const;

const sampleVideo = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const samplePdf = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';

const build = (): Item[] => {
  const convs = conversations.filter((c) => !c.stranger);
  const items: Item[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let i = 0; i < 150; i += 1) {
    const c = convs[i % convs.length];
    const r = rand();
    const kind: Kind = r < 0.55 ? 'photo' : r < 0.72 ? 'video' : r < 0.9 ? 'file' : 'voice';
    const file = files[i % files.length];
    items.push({
      key: `z${i}`,
      kind,
      conv: c.id,
      convName: c.id === SELF_CONV ? 'Cloud của tôi' : c.name,
      size: Math.round(kind === 'photo' ? 0.3 * MB + rand() * 3 * MB : kind === 'video' ? 8 * MB + rand() * 180 * MB : kind === 'file' ? 40_000 + rand() * 24 * MB : 30_000 + rand() * 600_000),
      date: Date.now() - Math.round(rand() * 220 * day),
      title: kind === 'file' ? file[0] : '',
      ext: kind === 'file' ? file[1] : '',
      duration: kind === 'video' ? Math.round(5_000 + rand() * 300_000) : kind === 'voice' ? Math.round(2_000 + rand() * 60_000) : 0,
      width: 1200,
      height: 900,
    });
  }
  // One expired photo, to show the state.
  items[3].key = 'z-expired';
  return items;
};

let items: Item[] = [];
let changed = 0;
let offload = false;
let ctx: MockContext | null = null;

const sum = (list: Item[], kind: Kind) => list.filter((i) => i.kind === kind).reduce((n, i) => n + i.size, 0);
const breakdown = (list: Item[]) => ({ photo: sum(list, 'photo'), video: sum(list, 'video'), file: sum(list, 'file'), voice: sum(list, 'voice') });
const total = (list: Item[]) => list.reduce((n, i) => n + i.size, 0);

const snapshot = (): Json => {
  const plan = ctx?.params.get('cloudPlan') ?? 'paid';
  const media = items.filter((i) => i.conv !== SELF_CONV);
  const mine = items.filter((i) => i.conv === SELF_CONV);
  const byConv = new Map<string, Item[]>();
  for (const i of media) byConv.set(i.conv, [...(byConv.get(i.conv) ?? []), i]);
  return {
    selfId: SELF_CONV,
    plan: {
      kind: plan,
      name: 'zCloud 100 GB',
      quota: plan === 'free' ? 1 * GB : 100 * GB,
      usage: total(items) + 2.4 * GB,
      family: plan === 'free' ? 0 : 6.2 * GB,
      cloudMedia: total(media),
      messageBackup: 2.4 * GB,
      myCloud: total(mine),
      expireAt: Date.now() + 140 * day,
      autoRenew: true,
      months: 12,
      hasKey: true,
      optIn: { media: true, myCloud: true, backup: false },
      enableOffload: true,
      fileLimit: 2 * GB,
    },
    types: { media: breakdown(media), myCloud: breakdown(mine) },
    conversations: [...byConv].map(([id, list]) => {
      const c = conversations.find((x) => x.id === id);
      return { id, name: c?.name ?? '', avatar: c?.avatar ?? '', isGroup: !!c?.isGroup, total: total(list), lastTs: Math.max(...list.map((i) => i.date)) };
    }),
    settings: {
      offloadEnabled: offload,
      offloadAvailable: plan !== 'free',
      lastOffloadAt: Date.now() - 3 * day,
      lastOffloadSize: 1.8 * GB,
      ttlDays: 30,
    },
    changed,
    loaded: true,
    hiddenLookup: true,
  };
};

const publish = () => ctx?.post({ zcloud: snapshot() });

const pathFor = (item: Item, full: boolean): string => {
  const n = Number(item.key.slice(1)) || 1;
  switch (item.kind) {
    case 'photo':
      return `https://picsum.photos/id/${(n * 7) % 90 + 10}/${full ? '1600/1200' : '400/400'}`;
    case 'video':
      return full ? sampleVideo : `https://picsum.photos/id/${(n * 11) % 90 + 10}/400/400`;
    case 'file':
      return item.ext === 'pdf' ? samplePdf : 'https://example.com/' + encodeURIComponent(item.title);
    case 'voice':
      return 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3';
  }
};

const delay = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

registerMockAdapter('__zaloCloud', {
  refresh: () => {
    setTimeout(publish, 200);
  },
  list: (o: Json) => {
    const convId = String(o.convId ?? '');
    let list = convId ? items.filter((i) => i.conv === convId) : items.filter((i) => i.conv !== SELF_CONV);
    if (o.kind) list = list.filter((i) => i.kind === o.kind);
    const dir = o.dir === 'asc' ? 1 : -1;
    list = [...list].sort((a, b) => dir * (o.sort === 'size' ? a.size - b.size : a.date - b.date));
    const offset = Number(o.offset) || 0;
    const limit = Number(o.limit) || 60;
    const page = list.slice(offset, offset + limit);
    return delay(300, { items: page, hasMore: offset + limit < list.length });
  },
  thumb: (key: string) => {
    const item = items.find((i) => i.key === key);
    if (!item) return { state: 'unavailable', reason: 'no-item' };
    if (key === 'z-expired') return delay(400, { state: 'expired' });
    if (item.kind !== 'photo' && item.kind !== 'video') return { state: 'unsupported' };
    return delay(150 + Math.random() * 400, { state: 'ok', kind: item.kind, path: pathFor(item, false) });
  },
  fetch: (key: string) => {
    const item = items.find((i) => i.key === key);
    if (!item) return { state: 'unavailable', reason: 'no-item' };
    if (key === 'z-expired') return delay(500, { state: 'expired' });
    return delay(700, { state: 'ok', path: pathFor(item, true), kind: item.kind, title: item.title, ext: item.ext, size: item.size, date: item.date });
  },
  deleteItems: (keys: string[]) => {
    const wanted = new Set(keys);
    items = items.filter((i) => !wanted.has(i.key));
    changed += 1;
    setTimeout(publish, 100);
    return delay(600, { ok: true, deleted: keys, failed: [] });
  },
  setOffload: (enabled: boolean) => {
    offload = !!enabled;
    setTimeout(publish, 100);
    return delay(400, { ok: true });
  },
});

onMockBoot((c) => {
  ctx = c;
  items = build();
  publish();
  const p = c.params;
  if (!p.has('dest') && !p.has('cloudRoute') && !p.has('cloudPreview') && !p.has('cloudConv')) return;
  const clicks = (p.get('cloudClick') ?? '').split(',').filter(Boolean);
  clicks.forEach((label, i) =>
    setTimeout(() => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.cloud-root button')];
      buttons.find((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label)?.click();
    }, 1500 + i * 400),
  );
  void Promise.all([import('../../../shell/shellStore'), import('../../../features/cloud/support')]).then(([{ shell }, { cloudUi }]) => {
    const dest = p.get('dest');
    const conv = p.get('cloudConv');
    if (dest === 'zcloud' || p.has('cloudRoute') || p.has('cloudPreview') || conv) shell.setDestination('zcloud');
    const route = p.get('cloudRoute');
    if (route === 'media' || route === 'conversations' || route === 'myCloud' || route === 'plan' || route === 'settings') cloudUi.setRoute(route);
    if (conv) {
      cloudUi.setRoute('conversations');
      cloudUi.openConversation({ id: conv, name: conversations.find((x) => x.id === conv)?.name ?? '' });
    }
    const preview = p.get('cloudPreview');
    if (preview) {
      const kind = (['photo', 'video', 'file', 'voice'].includes(preview) ? preview : 'photo') as Kind;
      const item = items.find((i) => i.kind === kind && i.key !== 'z-expired' && (kind !== 'file' || i.ext === 'pdf'))!;
      setTimeout(
        () =>
          cloudUi.preview({
            id: item.key,
            kind: item.kind,
            conversationId: item.conv,
            conversationName: item.convName,
            size: item.size,
            date: item.date,
            title: item.title,
            ext: item.ext,
            duration: item.duration / 1000,
            width: item.width,
            height: item.height,
          }),
        600,
      );
    }
  });
});
