// Settings ▸ Chung / Giao diện preferences (Swift `CompolaPrefs.appearance / accent / textSize`, @AppStorage) in
// localStorage, applied to the whole window live: the colour scheme through the window theme, the accent and the
// message text scale as CSS variables on :root.

import { useSyncExternalStore } from 'react';
import { usesTauri } from '../../engine/backend';

export type Appearance = 'system' | 'light' | 'dark';
export type Accent = 'blue' | 'teal' | 'indigo' | 'pink' | 'orange' | 'green' | 'graphite';
export type TextSize = 'small' | 'standard' | 'large' | 'extraLarge';

export const appearances: { value: Appearance; title: string }[] = [
  { value: 'system', title: 'Theo hệ thống' },
  { value: 'light', title: 'Sáng' },
  { value: 'dark', title: 'Tối' },
];

export const accents: { value: Accent; title: string; color: string }[] = [
  { value: 'blue', title: 'Xanh dương', color: '#0068ff' },
  { value: 'teal', title: 'Xanh ngọc', color: 'rgb(0, 158, 179)' },
  { value: 'indigo', title: 'Chàm', color: 'rgb(92, 87, 214)' },
  { value: 'pink', title: 'Hồng', color: 'rgb(237, 64, 122)' },
  { value: 'orange', title: 'Cam', color: 'rgb(245, 128, 26)' },
  { value: 'green', title: 'Xanh lá', color: 'rgb(41, 168, 84)' },
  { value: 'graphite', title: 'Than chì', color: 'rgb(110, 115, 125)' },
];

export const textSizes: { value: TextSize; title: string; scale: number }[] = [
  { value: 'small', title: 'Nhỏ', scale: 0.92 },
  { value: 'standard', title: 'Vừa', scale: 1 },
  { value: 'large', title: 'Lớn', scale: 1.12 },
  { value: 'extraLarge', title: 'Rất lớn', scale: 1.26 },
];

const defaults = { appearance: 'system' as Appearance, accent: 'blue' as Accent, textSize: 'standard' as TextSize };
type Prefs = typeof defaults;
const keys: Record<keyof Prefs, string> = { appearance: 'compola.appearance', accent: 'compola.accent', textSize: 'compola.textSize' };
const allowed: Record<keyof Prefs, string[]> = {
  appearance: appearances.map((a) => a.value),
  accent: accents.map((a) => a.value),
  textSize: textSizes.map((t) => t.value),
};

const listeners = new Set<() => void>();
let cache: Prefs | null = null;

const read = (): Prefs => {
  if (cache) return cache;
  const out = { ...defaults };
  for (const k of Object.keys(keys) as (keyof Prefs)[]) {
    try {
      const v = localStorage.getItem(keys[k]);
      if (v && allowed[k].includes(v)) (out as Record<string, string>)[k] = v;
    } catch {
      /* private mode */
    }
  }
  cache = out;
  return out;
};

export const setAppearancePref = <K extends keyof Prefs>(k: K, value: Prefs[K]) => {
  try {
    localStorage.setItem(keys[k], value);
  } catch {
    /* private mode */
  }
  cache = { ...read(), [k]: value };
  apply(cache);
  listeners.forEach((l) => l());
};

export const useAppearancePrefs = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
  );

const apply = (p: Prefs) => {
  const root = document.documentElement;
  const accent = accents.find((a) => a.value === p.accent) ?? accents[0];
  if (p.accent === 'blue') {
    for (const v of ['--accent', '--accent-pressed', '--accent-soft', '--accent-faint', '--primary', '--primary-pressed']) root.style.removeProperty(v);
  } else {
    root.style.setProperty('--accent', accent.color);
    root.style.setProperty('--primary', accent.color);
    root.style.setProperty('--accent-pressed', `color-mix(in srgb, ${accent.color} 86%, black)`);
    root.style.setProperty('--primary-pressed', `color-mix(in srgb, ${accent.color} 86%, black)`);
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent.color} 16%, transparent)`);
    root.style.setProperty('--accent-faint', `color-mix(in srgb, ${accent.color} 10%, transparent)`);
  }
  root.style.setProperty('--message-scale', String(textSizes.find((t) => t.value === p.textSize)?.scale ?? 1));
  // Light / dark: the window theme drives `prefers-color-scheme` in the webview (needs `core:window:allow-set-theme`).
  root.dataset.theme = p.appearance;
  if (usesTauri) {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(p.appearance === 'system' ? null : p.appearance))
      .catch(() => {});
  }
};

if (typeof document !== 'undefined') apply(read());
