// Defensive readers for the loosely-typed JSON the host scripts post (Swift: `as? String ?? ""`, `NSNumber`…).
// Anything missing or mistyped degrades to an empty value, never a throw.

export type Json = Record<string, unknown>;

export const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** Non-empty string or null. */
export const optStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export const num = (v: unknown, fallback = 0): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return fallback;
};

/** Sender-supplied numbers can be NaN or astronomically large (Swift `clampedInt`). */
export const int = (v: unknown, fallback = 0): number => {
  const n = num(v, fallback);
  return Math.trunc(Math.max(-9e15, Math.min(9e15, n)));
};

export const bool = (v: unknown, fallback = false): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return fallback;
};

export const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

/** Trimmed URL string or null (Swift `URL(string:)` on a non-empty value). */
export const url = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
};

/**
 * The only links a message card may open: plain web pages (Swift `WebLink.sanitized`): http(s) with a host.
 */
export const webLink = (v: unknown): string | null => {
  const u = url(v);
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) return u;
  } catch {
    /* not a URL */
  }
  return null;
};
