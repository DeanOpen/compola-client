// Remote media goes through the `compola-media` scheme (Rust, docs/media.md): Zalo CDN URLs need the client's network
// stack (headers, cookies, fingerprint helper, disk cache, DoH fallback). In the browser mock the URL is used as is.
//
// Flavours: `image` (default) for avatars, photos, thumbnails and stickers (incl. animated GIF / WebP); `cors` for video,
// voice and file attachments (use it for <video> / <audio>: Range requests are supported). `retry=1` only for a user's
// retry click (a failed image URL is otherwise not fetched again for 20 s). Errors come back as an HTTP status plus an
// `X-Compola-Error` header: an <img> just gets `onerror`, which shows the retry affordance.

import { usesMock } from './backend';

export type MediaFlavour = 'image' | 'cors';

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
const origin = isWindows ? 'http://compola-media.localhost' : 'compola-media:/';

/** URL for an `<img>` / `<video>` / `<audio>` src. */
export const mediaUrl = (url: string | null | undefined, flavour: MediaFlavour = 'image', retry = false): string | null => {
  if (!url) return null;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (usesMock) return url;
  return `${origin}/load?url=${encodeURIComponent(url)}&flavour=${flavour}${retry ? '&retry=1' : ''}`;
};

/**
 * A local file the official loader produced (`resolveMedia` → `{state:'ok', path}`, inside Compola's ZaloData / MediaCache):
 * served by the same scheme as a `file://` URL.
 */
export const mediaFileUrl = (path: string, flavour: MediaFlavour = 'image', retry = false): string | null => {
  if (!path.startsWith('/') || usesMock) return null;
  return mediaUrl('file://' + encodeURI(path), flavour, retry);
};

/**
 * An official reaction icon PNG (`pc-dist/<path>` inside the runtime's asar). Not served yet: views fall back to the
 * emoji text. Flip `assetSchemeAvailable` once Rust serves `asset=`.
 */
export const reactionImageUrl = (path: string): string | null => {
  if (!path || usesMock || !assetSchemeAvailable) return null;
  return `${origin}/load?asset=${encodeURIComponent('pc-dist/' + path)}`;
};

const assetSchemeAvailable = false;
