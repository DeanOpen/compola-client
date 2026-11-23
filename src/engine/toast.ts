// Swift `CardActionCenter.shared.show(text, in:)`: a short notice in the conversation it belongs to (or app-wide).

import { getEngine, setEngine } from './store';

let seq = 0;

export const showToast = (text: string, conversationId: string | null = null) => {
  if (!text) return;
  seq += 1;
  setEngine({ toast: { seq, text, conversationId } });
  const mine = seq;
  setTimeout(() => {
    if (getEngine().toast?.seq === mine) setEngine({ toast: null });
  }, 3200);
};

export const dismissToast = () => setEngine({ toast: null });
