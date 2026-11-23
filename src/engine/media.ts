// Remote media goes through the `compola-media` custom scheme (Rust): Zalo CDN URLs need the client's network stack
// (fingerprint, DoH fallback, cache). In the browser mock the URL is used as is.

import { usesMock } from './backend';

export type MediaFlavour = 'image' | 'video' | 'audio' | 'file';

/** The scheme knows two loads (docs/media.md): `image` (an `<img>` load) and `cors` (a `fetch()` load, streamed to disk
 * with Range support) for video, voice and file attachments. */
const schemeFlavour = (f: MediaFlavour) => (f === 'image' ? 'image' : 'cors');

/** URL for an `<img>` / `<video>` / `<audio>` src. */
export const mediaUrl = (url: string | null | undefined, flavour: MediaFlavour = 'image'): string | null => {
  if (!url) return null;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (usesMock) return url;
  return `compola-media://load?url=${encodeURIComponent(url)}&flavour=${schemeFlavour(flavour)}`;
};

/**
 * A local file the official loader produced (`resolveMedia` → `{state:'ok', path}`, the official `ZaloDownloads` copy).
 * docs/media.md: `url=file://…` is served when it points inside Compola's own data / cache folders.
 */
export const mediaFileUrl = (path: string, flavour: MediaFlavour = 'image'): string | null => {
  if (!path.startsWith('/')) return null;
  if (usesMock) return null;
  const fileUrl = 'file://' + path.split('/').map(encodeURIComponent).join('/');
  return `compola-media://load?url=${encodeURIComponent(fileUrl)}&flavour=${schemeFlavour(flavour)}`;
};

/**
 * An official reaction icon PNG (`pc-dist/<path>` inside the runtime's asar). Contract request:
 * `compola-media://load?asset=pc-dist/<path>`. Until it exists, views fall back to the emoji text.
 */
export const reactionImageUrl = (path: string): string | null => {
  if (!path || usesMock || !assetSchemeAvailable) return null;
  return `compola-media://load?asset=${encodeURIComponent('pc-dist/' + path)}`;
};

/** Flip once the Rust side serves `asset=` (see `reactionImageUrl`). */
const assetSchemeAvailable = false;
