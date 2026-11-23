// Conversation list (ZaloEngine.swift `mergeConversations`) and its extras — labels, list filters, stranger folder,
// My Documents id (ZaloEngine+Conversations.swift), bridged to `window.__zaloConversations`.

import { fireAdapter } from './call';
import { obj, strings, type Json } from './models/json';
import {
  listOrder,
  mergeExtras,
  parseConversation,
  sameConversation,
  type ConversationSummary,
  type TypeFilter,
} from './models/conversations';
import { getEngine, setEngine } from './store';

/** `conversations` by id: the adapter posts only the rows that changed (`reset` replaces everything). */
let index = new Map<string, ConversationSummary>();

/**
 * The list arrives as deltas (state-adapter.js): `conversations` holds the rows that changed since the last post,
 * `removed` the ids that left the official index, `reset` (or the legacy full-list shape) replaces the whole list.
 */
export const mergeConversations = (state: Json) => {
  const rows = (Array.isArray(state.conversations) ? state.conversations : [])
    .map(parseConversation)
    .filter((c): c is ConversationSummary => !!c);
  const reset = typeof state.reset === 'boolean' ? state.reset : state.removed === undefined;
  const removed = strings(state.removed);
  const next = reset ? new Map<string, ConversationSummary>() : new Map(index);
  let changed = reset;
  for (const id of removed) changed = next.delete(id) || changed;
  for (const row of rows) {
    const old = next.get(row.id);
    if (!old || !sameConversation(old, row)) {
      next.set(row.id, row);
      changed = true;
    }
  }
  if (!changed) return;
  index = next;
  setEngine({ conversations: [...next.values()].sort(listOrder) });
};

export const resetConversations = () => {
  index = new Map();
};

export const handleConversationExtras = (state: Json) => {
  const json = obj(state.conversationExtras);
  if (!json) return;
  const s = getEngine();
  const { next, selfId } = mergeExtras(s.extras, json);
  setEngine({ extras: next, ...(selfId && selfId !== s.selfConversationId ? { selfConversationId: selfId } : {}) });
};

// MARK: Actions

/** Drives the official ConvListController filter (type + label ids); the resulting list comes back as `listIds`. */
export const setConversationFilter = (type: TypeFilter, labelIds: string[] = []) => {
  setEngine((s) => ({ extras: { ...s.extras, typeFilter: type, labelFilterIds: labelIds } }));
  fireAdapter('__zaloConversations', 'setFilter', type, labelIds);
};

/** Assigns the conversation to `labelId`, or removes its label when null (optimistic). */
export const setConversationLabel = (conversationId: string, labelId: string | null) => {
  setEngine((s) => {
    const map = { ...s.extras.labelByConversation };
    if (labelId) map[conversationId] = labelId;
    else delete map[conversationId];
    return { extras: { ...s.extras, labelByConversation: map } };
  });
  fireAdapter('__zaloConversations', 'setConvLabel', conversationId, labelId);
};

export const createConversationLabel = (name: string, colorHex: string, conversationIds: string[] = []) =>
  fireAdapter('__zaloConversations', 'createLabel', name, colorHex, conversationIds);
export const updateConversationLabel = (id: string, name: string, colorHex: string) =>
  fireAdapter('__zaloConversations', 'updateLabel', id, name, colorHex);
export const deleteConversationLabel = (id: string) => fireAdapter('__zaloConversations', 'deleteLabel', id);
export const reorderConversationLabels = (ids: string[]) => fireAdapter('__zaloConversations', 'reorderLabels', ids);
