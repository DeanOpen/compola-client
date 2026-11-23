// Buttons of message cards (e-card actions, info-message links, "GỌI LẠI"), bridged to
// `host-scripts/card-actions-adapter.js` (`__zaloChat.performAction`). The core of CardActions.swift: effects that only
// need the app (open a chat, a link, copy) are applied here; native sheets arrive with the card-sheet wave.

import { callAdapter, raceTimeout } from './call';
import { noAnswerText, parseCardActionOutcome, type CardActionOutcome } from './models/outcomes';
import { getEngine, setEngine } from './store';
import { showToast } from './toast';
import { openExternal } from './system';
import { presentCardEffect } from './cardSheets';

const running = new Set<string>();

export const performCardAction = async (conversationId: string, messageId: string, ref: string): Promise<CardActionOutcome | null> => {
  const key = `${conversationId}|${messageId}|${ref}`;
  if (running.has(key)) return null;
  running.add(key);
  try {
    const answer = await raceTimeout(45, callAdapter('__zaloChat', 'performAction', conversationId, messageId, ref).catch(() => null));
    let outcome: CardActionOutcome = answer ? parseCardActionOutcome(answer.value) : { kind: 'pending', text: noAnswerText };
    // The answer can arrive after the user moved to another conversation: effects then belong to a screen that is gone.
    if (getEngine().openConversationId !== conversationId && ['openChat', 'openURL', 'copy', 'present'].includes(outcome.kind)) outcome = { kind: 'done' };
    applyCardOutcome(outcome, conversationId);
    return outcome;
  } finally {
    running.delete(key);
  }
};

export const applyCardOutcome = (outcome: CardActionOutcome, conversationId: string) => {
  switch (outcome.kind) {
    case 'done':
      return;
    case 'openChat':
      setEngine({ navigationRequest: outcome.id });
      return;
    case 'openProfile':
      void import('../features/contacts/hosts').then(({ openContactProfile }) => openContactProfile(outcome.id));
      return;
    case 'openURL':
      void openExternal(outcome.url);
      return;
    case 'copy':
      void navigator.clipboard.writeText(outcome.text).then(() => showToast('Đã sao chép', conversationId));
      return;
    case 'present':
      presentCardEffect(outcome.effect, conversationId);
      return;
    default:
      showToast(outcome.text, conversationId);
  }
};
