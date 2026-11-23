// Swift `CardActionCenter.shared.show(text, in:)`: a short notice in the conversation it belongs to (or app-wide).

import { getEngine, setEngine, type ToastAction } from './store';

let seq = 0;

/** `action` adds an inline button (e.g. "Hoàn tác"); such a toast stays a little longer. */
export const showToast = (text: string, conversationId: string | null = null, action?: ToastAction | null) => {
  if (!text) return;
  seq += 1;
  setEngine({ toast: { seq, text, conversationId, action } });
  const mine = seq;
  setTimeout(
    () => {
      if (getEngine().toast?.seq === mine) setEngine({ toast: null });
    },
    action ? 5000 : 3200,
  );
};

/** "<text> · Hoàn tác" (wave 3 #9): the undo runs once and closes the toast. */
export const showUndoToast = (text: string, undo: () => void, conversationId: string | null = null) =>
  showToast(text, conversationId, {
    label: 'Hoàn tác',
    run: () => {
      setEngine({ toast: null });
      undo();
    },
  });

export const dismissToast = () => setEngine({ toast: null });
