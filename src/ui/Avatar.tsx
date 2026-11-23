import { useState } from 'react';
import { mediaUrl } from '../engine/media';
import './ui.css';

/** Initials of a name (Swift `nameInitials`): first + last word, or the first two letters of a single word. */
export const nameInitials = (name: string): string => {
  const words = name.split(/\s+/).filter((w) => /\p{L}/u.test(w.charAt(0)));
  if (!words.length) return name.slice(0, 1).toUpperCase();
  const base = words.length > 1 ? words[0].charAt(0) + words[words.length - 1].charAt(0) : [...words[0]].slice(0, 2).join('');
  return base.toUpperCase();
};

/** Swift `RemoteAvatar`: remote photo, accent-tinted initials while it loads or when there is none. */
export function Avatar({ url, name, size = 40, className = '' }: { url: string | null | undefined; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = mediaUrl(url);
  const showImage = src && failed !== src;
  return (
    <span className={`avatar ${className}`} style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {showImage ? (
        <img src={src} alt="" draggable={false} onError={() => setFailed(src)} loading="lazy" />
      ) : (
        <span className="avatar-initials">{nameInitials(name)}</span>
      )}
    </span>
  );
}
