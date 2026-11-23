// zCloud ("Zalo Cloud" sidebar tab of the official client) — port of ZaloEngine+Cloud.swift: storage quota & usage,
// plan, browsing the media / files stored in the cloud, download, delete, auto-free-up setting. Bridged to
// `host-scripts/zcloud-adapter.js` (`window.__zaloCloud`; posts {page:'main', zcloud:{…}} — each key replaces that
// section). Every call runs through the official client's own cloud services.

import { create } from 'zustand';
import { usesMock } from './backend';
import { callAdapter, fireAdapter, log } from './call';
import { registerStateHandler } from './dispatch';
import { mediaUrl, type MediaFlavour } from './media';
import { arr, bool, num, obj, optStr, str, strings, type Json } from './models/json';
import { onAccountReset } from './store';

export type CloudItemKind = 'photo' | 'video' | 'file' | 'voice' | 'other';

export const cloudKinds: CloudItemKind[] = ['photo', 'video', 'file', 'voice'];

export const cloudKindTitle = (k: CloudItemKind): string => {
  switch (k) {
    case 'photo':
      return 'Ảnh';
    case 'video':
      return 'Video';
    case 'file':
      return 'File';
    case 'voice':
      return 'Tin nhắn thoại';
    case 'other':
      return 'Khác';
  }
};

/** One media / file item stored in zCloud, as the official ZCloud table describes it. */
export interface CloudItem {
  /** Official `zKey`; the adapter resolves items by it. */
  id: string;
  kind: CloudItemKind;
  conversationId: string;
  conversationName: string;
  size: number;
  /** Epoch ms, null when unknown. */
  date: number | null;
  /** File name as sent (empty for photos / videos / voice messages). */
  title: string;
  ext: string;
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
}

export interface CloudPage {
  items: CloudItem[];
  hasMore: boolean;
  error: string | null;
}

/** Bytes per category (official usage legend: Ảnh / Video / File / Tin nhắn thoại). */
export interface CloudBreakdown {
  photo: number;
  video: number;
  file: number;
  voice: number;
}

export const breakdownTotal = (b: CloudBreakdown) => b.photo + b.video + b.file + b.voice;
export const breakdownBytes = (b: CloudBreakdown, k: CloudItemKind) => (k === 'other' ? 0 : b[k]);

export type CloudPlanKind = 'paid' | 'free' | 'grace' | 'afterGrace';

export interface CloudPlan {
  kind: CloudPlanKind;
  name: string;
  quota: number;
  usage: number;
  /** Other family members' usage. */
  family: number;
  cloudMedia: number;
  messageBackup: number;
  myCloud: number;
  expireAt: number | null;
  /** null when the server does not say. */
  autoRenew: boolean | null;
  months: number;
  /** The personal cloud key (from the phone) is available, so contents can be decrypted. */
  hasKey: boolean;
  backupMedia: boolean;
  backupMyCloud: boolean;
  backupMessages: boolean;
  fileLimit: number;
}

export const planRemaining = (p: CloudPlan) => Math.max(0, p.quota - p.usage - p.family);
export const planIsPaid = (p: CloudPlan) => p.kind === 'paid' || p.kind === 'grace';

export interface CloudConversation {
  id: string;
  name: string;
  avatar: string | null;
  isGroup: boolean;
  total: number;
  lastActivity: number | null;
}

export interface CloudSettings {
  offloadEnabled: boolean;
  /** Plan, cloud key and server flag all allow the feature. */
  offloadAvailable: boolean;
  lastOffloadAt: number | null;
  lastOffloadSize: number;
  ttlDays: number;
}

export interface CloudState {
  plan: CloudPlan | null;
  media: CloudBreakdown;
  myCloudTypes: CloudBreakdown;
  conversations: CloudConversation[];
  settings: CloudSettings;
  /** Bumped by the adapter whenever cloud items were added / removed. */
  changed: number;
  loaded: boolean;
  /** False when the official hidden-chat lookup was not found: conversation-grouped data is withheld (fail closed). */
  hiddenLookup: boolean;
  /** Official My Cloud (send-to-me) conversation id. */
  selfId: string | null;
}

const emptyBreakdown: CloudBreakdown = { photo: 0, video: 0, file: 0, voice: 0 };

const initialCloud = (): CloudState => ({
  plan: null,
  media: emptyBreakdown,
  myCloudTypes: emptyBreakdown,
  conversations: [],
  settings: { offloadEnabled: false, offloadAvailable: false, lastOffloadAt: null, lastOffloadSize: 0, ttlDays: 0 },
  changed: 0,
  loaded: false,
  hiddenLookup: true,
  selfId: null,
});

export const useCloud = create<CloudState>()(initialCloud);

/** Free accounts only have "Cloud của tôi" (official: the media entries are hidden for the free plan). */
export const hasMediaScreens = (s: CloudState) => (s.plan ? s.plan.kind !== 'free' && s.plan.kind !== 'afterGrace' : true);

// MARK: - State

const date = (v: unknown): number | null => {
  const ms = num(v);
  return ms > 0 ? ms : null;
};

const breakdown = (v: unknown): CloudBreakdown => {
  const d = obj(v) ?? {};
  return { photo: num(d.photo), video: num(d.video), file: num(d.file), voice: num(d.voice) };
};

const planKinds: CloudPlanKind[] = ['paid', 'free', 'grace', 'afterGrace'];

const handleCloud = (state: Json) => {
  const json = obj(state.zcloud);
  if (!json) return;
  const next: Partial<CloudState> = {};
  const selfId = optStr(json.selfId);
  if (selfId) next.selfId = selfId;
  const p = obj(json.plan);
  if (p) {
    const optIn = obj(p.optIn) ?? {};
    const kind = str(p.kind) as CloudPlanKind;
    next.plan = {
      kind: planKinds.includes(kind) ? kind : 'free',
      name: str(p.name, 'zCloud') || 'zCloud',
      quota: num(p.quota),
      usage: num(p.usage),
      family: num(p.family),
      cloudMedia: num(p.cloudMedia),
      messageBackup: num(p.messageBackup),
      myCloud: num(p.myCloud),
      expireAt: date(p.expireAt),
      autoRenew: typeof p.autoRenew === 'boolean' ? p.autoRenew : null,
      months: Math.trunc(num(p.months)),
      hasKey: bool(p.hasKey),
      backupMedia: bool(optIn.media),
      backupMyCloud: bool(optIn.myCloud),
      backupMessages: bool(optIn.backup),
      fileLimit: num(p.fileLimit),
    };
  }
  const t = obj(json.types);
  if (t) {
    next.media = breakdown(t.media);
    next.myCloudTypes = breakdown(t.myCloud);
  }
  if (Array.isArray(json.conversations)) {
    next.conversations = arr(json.conversations)
      .map(obj)
      .filter((r): r is Json => !!r && !!str(r.id))
      .map((r) => ({
        id: str(r.id),
        name: str(r.name),
        avatar: optStr(r.avatar),
        isGroup: bool(r.isGroup),
        total: num(r.total),
        lastActivity: date(r.lastTs),
      }));
  }
  const s = obj(json.settings);
  if (s) {
    next.settings = {
      offloadEnabled: bool(s.offloadEnabled),
      offloadAvailable: bool(s.offloadAvailable),
      lastOffloadAt: date(s.lastOffloadAt),
      lastOffloadSize: num(s.lastOffloadSize),
      ttlDays: Math.trunc(num(s.ttlDays)),
    };
  }
  if (typeof json.changed === 'number') next.changed = json.changed;
  if (json.loaded === true) next.loaded = true;
  if (typeof json.hiddenLookup === 'boolean') next.hiddenLookup = json.hiddenLookup;
  if (Object.keys(next).length) useCloud.setState(next);
};

registerStateHandler('zcloud', handleCloud);

/** Sign-out: drop everything zCloud kept (state, thumbnails of the previous account). */
onAccountReset(() => {
  useCloud.setState(initialCloud());
  thumbs.clear();
  queue.length = 0;
});

// MARK: - Actions

const unreachable = 'Chưa kết nối được tới zCloud.';

/** `await window.__zaloCloud[method](...args)`; null when the adapter is missing or threw. */
const callCloud = async (method: string, ...args: unknown[]): Promise<Json | null> => {
  try {
    return obj(await callAdapter('__zaloCloud', method, ...args));
  } catch (e) {
    log(`__zaloCloud.${method} failed: ${String(e)}`);
    return null;
  }
};

/** Re-reads plan / usage / conversations from the official services. */
export const refreshCloud = () => fireAdapter('__zaloCloud', 'refresh');

const cloudItem = (v: unknown): CloudItem | null => {
  const json = obj(v);
  const key = json ? str(json.key) : '';
  if (!json || !key) return null;
  const kind = str(json.kind) as CloudItemKind;
  return {
    id: key,
    kind: (['photo', 'video', 'file', 'voice'] as string[]).includes(kind) ? kind : 'other',
    conversationId: str(json.conv),
    conversationName: str(json.convName),
    size: num(json.size),
    date: date(json.date),
    title: str(json.title),
    ext: str(json.ext),
    duration: num(json.duration) / 1000,
    width: Math.trunc(num(json.width)),
    height: Math.trunc(num(json.height)),
  };
};

export interface CloudListQuery {
  conversationId: string | null;
  kind: CloudItemKind | null;
  sortBySize: boolean;
  ascending: boolean;
  offset: number;
  limit?: number;
}

/** One page of items (official `filterAndSort`, 60 per page by default). */
export const cloudList = async (q: CloudListQuery): Promise<CloudPage> => {
  const json = await callCloud('list', {
    convId: q.conversationId ?? '',
    kind: q.kind ?? '',
    sort: q.sortBySize ? 'size' : 'date',
    dir: q.ascending ? 'asc' : 'desc',
    offset: q.offset,
    limit: q.limit ?? 60,
  });
  if (!json) return { items: [], hasMore: false, error: unreachable };
  return {
    items: arr(json.items).map(cloudItem).filter((x): x is CloudItem => !!x),
    hasMore: bool(json.hasMore),
    error: optStr(json.error),
  };
};

/** A local file the official downloader produced. In the mock the "path" is an https URL. */
export type CloudThumb = { state: 'file'; path: string } | { state: 'expired' } | { state: 'missing' };

const parseThumb = (json: Json | null): CloudThumb => {
  switch (json ? str(json.state) : '') {
    case 'ok': {
      const path = str(json?.path);
      return path.startsWith('/') || (usesMock && path.startsWith('http')) ? { state: 'file', path } : { state: 'missing' };
    }
    case 'expired':
      return { state: 'expired' };
    default:
      return { state: 'missing' };
  }
};

// Thumbnails: de-duplicated and throttled (3 at once, newest request first) like Swift `MediaResolver(maxConcurrent: 3)`.
const thumbs = new Map<string, Promise<CloudThumb>>();
const queue: (() => void)[] = [];
let running = 0;
const maxConcurrent = 3;

const pump = () => {
  while (running < maxConcurrent && queue.length) {
    const job = queue.pop()!;
    running += 1;
    job();
  }
};

/** A local file to draw the item's thumbnail from (photo: the image itself; video: the video). */
export const cloudThumbnail = (key: string, force = false): Promise<CloudThumb> => {
  const cached = thumbs.get(key);
  if (cached && !force) return cached;
  const promise = new Promise<CloudThumb>((resolve) => {
    queue.push(() => {
      callCloud('thumb', key)
        .then((json) => resolve(parseThumb(json)))
        .finally(() => {
          running -= 1;
          pump();
        });
    });
    pump();
  });
  thumbs.set(key, promise);
  // A miss is retried on the next request (not cached).
  void promise.then((r) => {
    if (r.state === 'missing' && thumbs.get(key) === promise) thumbs.delete(key);
  });
  return promise;
};

/** A cloud item downloaded (through the official path) to the official zCloud cache. */
export interface CloudFile {
  path: string;
  kind: CloudItemKind;
  title: string;
  ext: string;
  size: number;
  date: number | null;
}

export type CloudFetch = { state: 'ready'; file: CloudFile } | { state: 'expired' } | { state: 'failed'; message: string };

/** Downloads the whole item through the official downloader (cached in the official zCloud folder). */
export const cloudFetch = async (key: string): Promise<CloudFetch> => {
  const json = await callCloud('fetch', key);
  if (!json) return { state: 'failed', message: unreachable };
  switch (str(json.state)) {
    case 'ok': {
      const path = str(json.path);
      if (!path.startsWith('/') && !(usesMock && path.startsWith('http'))) return { state: 'failed', message: 'Không tìm thấy tệp đã tải.' };
      const kind = str(json.kind) as CloudItemKind;
      return {
        state: 'ready',
        file: {
          path,
          kind: (['photo', 'video', 'file', 'voice'] as string[]).includes(kind) ? kind : 'other',
          title: str(json.title),
          ext: str(json.ext),
          size: num(json.size),
          date: date(json.date),
        },
      };
    }
    case 'expired':
      return { state: 'expired' };
    default:
      return { state: 'failed', message: 'Không tải được nội dung này lúc này. Vui lòng thử lại sau.' };
  }
};

export interface CloudActionResult {
  ok: boolean;
  deleted: string[];
  failed: string[];
  error: string | null;
}

/** WRITE: removes the items the way the official "Xoá dữ liệu" confirmation does (sync-delete of the messages). */
export const cloudDelete = async (keys: string[]): Promise<CloudActionResult> => {
  const json = await callCloud('deleteItems', keys);
  if (!json) return { ok: false, deleted: [], failed: keys, error: unreachable };
  return { ok: bool(json.ok), deleted: strings(json.deleted), failed: strings(json.failed), error: optStr(json.error) };
};

/** WRITE: Settings ▸ "Tự động giải phóng dung lượng" (official `changeEnableOffload`). */
export const cloudSetOffload = async (enabled: boolean): Promise<CloudActionResult> => {
  const json = await callCloud('setOffload', enabled);
  if (!json) return { ok: false, deleted: [], failed: [], error: unreachable };
  return { ok: bool(json.ok), deleted: [], failed: [], error: optStr(json.error) };
};

/**
 * `src` for a file of the official zCloud cache: `compola-media://load?url=file://…` (served when it lies under the Zalo
 * data folder, docs/media.md). The mock answers with https URLs, used as they are.
 */
export const cloudFileSrc = (path: string, flavour: MediaFlavour = 'image'): string | null => {
  if (path.startsWith('http')) return mediaUrl(path, flavour);
  if (!path.startsWith('/')) return null;
  return mediaUrl('file://' + path.split('/').map(encodeURIComponent).join('/'), flavour);
};

/** URL to hand to `media_save` for a fetched cloud file. */
export const cloudFileUrl = (path: string): string =>
  path.startsWith('http') ? path : 'file://' + path.split('/').map(encodeURIComponent).join('/');
