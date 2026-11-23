// Port of ZaloEngine+Media.swift: when a CDN link fails, the official image loader is asked for the message's media
// (`window.__zaloChat.resolveMedia`: local copy → other qualities → Zalo Cloud fallback → "expired").
// De-duplicated and throttled (max 3 at once, newest request first) like Swift's `MediaResolver`.

import { tryAdapter } from './call';
import { obj, str } from './models/json';

export type MediaResolution =
  /** A local file (absolute path) the official loader produced. */
  | { state: 'file'; path: string }
  /** Every source is gone and the message is past the official shelf life. */
  | { state: 'expired' }
  /** Could not be loaded now; worth a retry. */
  | { state: 'unavailable' }
  | { state: 'unsupported' };

export type MediaKind = 'photo' | 'videoThumb' | 'video';

const parse = (v: unknown): MediaResolution => {
  const d = obj(v);
  switch (d ? str(d.state) : '') {
    case 'ok': {
      const path = str(d?.path);
      return path.startsWith('/') ? { state: 'file', path } : { state: 'unavailable' };
    }
    case 'expired':
      return { state: 'expired' };
    case 'unsupported':
      return { state: 'unsupported' };
    default:
      return { state: 'unavailable' };
  }
};

const unavailableTTL = 30_000;
const maxConcurrent = 3;
const settled = new Map<string, { resolution: MediaResolution; until: number }>();
const flights = new Map<string, Promise<MediaResolution>>();
const queue: (() => void)[] = [];
let running = 0;

const acquire = (): Promise<void> => {
  if (running < maxConcurrent) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
};

const release = () => {
  const next = queue.pop(); // newest first
  if (next) next();
  else running -= 1;
};

/** `force` (retry button) ignores a remembered "unavailable" or file; "expired" is final. */
export const resolveMedia = (conversationId: string, messageId: string, kind: MediaKind = 'photo', force = false): Promise<MediaResolution> => {
  const key = `${conversationId}|${messageId}|${kind}`;
  const known = settled.get(key);
  if (known && known.until > Date.now() && !(force && known.resolution.state !== 'expired')) {
    return Promise.resolve(known.resolution);
  }
  const existing = flights.get(key);
  if (existing) return existing;
  const flight = (async () => {
    await acquire();
    try {
      const resolution = parse(
        await tryAdapter<unknown>({ state: 'unavailable' }, '__zaloChat', 'resolveMedia', conversationId, messageId, kind),
      );
      settled.set(key, {
        resolution,
        until: resolution.state === 'unavailable' ? Date.now() + unavailableTTL : Number.POSITIVE_INFINITY,
      });
      if (settled.size > 2000) for (const [k, v] of settled) if (v.until <= Date.now()) settled.delete(k);
      return resolution;
    } finally {
      release();
      flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight;
};
