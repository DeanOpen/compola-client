// Remote media goes through the `compola-media` scheme (Rust, docs/media.md): Zalo CDN URLs need the client's network
// stack (headers, cookies, fingerprint helper, disk cache, DoH fallback). In the browser mock the URL is used as is.
//
// The scheme knows two loads: `image` (an `<img>` load) for avatars, photos, thumbnails and stickers, and `cors` (a
// `fetch()` load, streamed to disk with Range support) for video, voice and file attachments. Callers may say `video` /
// `audio` / `file` for `cors`. `retry=1` only for a user's retry click (a failed image URL is otherwise not fetched again
// for 20 s). Errors come back as an HTTP status plus `X-Compola-Error`: an <img> just gets `onerror`.

import { usesMock } from './backend';

export type MediaFlavour = 'image' | 'cors' | 'video' | 'audio' | 'file';

const schemeFlavour = (f: MediaFlavour) => (f === 'image' ? 'image' : 'cors');

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
const origin = isWindows ? 'http://compola-media.localhost' : 'compola-media:/';

/** URL for an `<img>` / `<video>` / `<audio>` src. */
export const mediaUrl = (url: string | null | undefined, flavour: MediaFlavour = 'image', retry = false): string | null => {
  if (!url) return null;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (usesMock) return url;
  return `${origin}/load?url=${encodeURIComponent(url)}&flavour=${schemeFlavour(flavour)}${retry ? '&retry=1' : ''}`;
};

/**
 * A local file the official loader produced (`resolveMedia` → `{state:'ok', path}`, inside Compola's ZaloData /
 * MediaCache): `?file=<absolute path>`. Views that show it fall back to their failure state on `onerror`.
 */
export const mediaFileUrl = (path: string, flavour: MediaFlavour = 'image', retry = false): string | null => {
  if (!path.startsWith('/') || usesMock) return null;
  return `${origin}/load?file=${encodeURIComponent(path)}&flavour=${schemeFlavour(flavour)}${retry ? '&retry=1' : ''}`;
};

/**
 * An official reaction icon PNG (`pc-dist/<path>` inside the runtime's asar): `?asset=pc-dist/<path>`. The view falls
 * back to the emoji text when it does not load.
 */
export const reactionImageUrl = (path: string): string | null => {
  if (!path || usesMock) return null;
  return `${origin}/load?asset=${encodeURIComponent('pc-dist/' + path)}`;
};

/**
 * Preview of a file the user picked, pasted or dropped (outside the data folders): Rust serves it once
 * `commands.mediaAllowPreviews([path])` allowed it (30 min). Null in the mock (no local files there).
 */
export const localPreviewUrl = (path: string, flavour: MediaFlavour = 'image'): string | null => {
  if (!path.startsWith('/') || usesMock) return null;
  return `${origin}/load?file=${encodeURIComponent(path)}&flavour=${schemeFlavour(flavour)}`;
};
