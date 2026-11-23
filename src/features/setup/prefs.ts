// First-run setup flags (Swift `CompolaPrefs.didFinishSetup` / `setupPending`, @AppStorage) in localStorage.

import { useSyncExternalStore } from 'react';

const keys = { didFinishSetup: 'compola.didFinishSetup', setupPending: 'compola.setupPending' } as const;
type Key = keyof typeof keys;

const listeners = new Set<() => void>();

const read = (k: Key) => {
  try {
    return localStorage.getItem(keys[k]) === '1';
  } catch {
    return false;
  }
};

export const setPref = (k: Key, value: boolean) => {
  try {
    localStorage.setItem(keys[k], value ? '1' : '0');
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
};

export const getPref = read;

export const usePref = (k: Key) =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => read(k),
  );
