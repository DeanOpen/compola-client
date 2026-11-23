// One Esc stack for every overlay (menus, popovers, sheets, dialogs, the quick switcher): Esc closes the topmost one only.

import { useEffect, useRef } from 'react';

const stack: { id: number; close: () => void }[] = [];
let nextId = 0;

if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.isComposing || stack.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      stack[stack.length - 1].close();
    },
    true,
  );
}

export const escapeStackDepth = () => stack.length;

/** While `active`, Esc calls `close` (when this is the topmost overlay). */
export const useEscape = (active: boolean, close: () => void) => {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!active) return;
    nextId += 1;
    const entry = { id: nextId, close: () => ref.current() };
    stack.push(entry);
    return () => {
      const i = stack.findIndex((x) => x.id === entry.id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
};
