// Placeholder: native sheets of card-action effects (CardSheetModels.swift), filled in by the card-sheets port.

import type { Json } from './models/json';
import { showToast } from './toast';

export const presentCardEffect = (_effect: Json, conversationId: string) => {
  showToast('Chưa hỗ trợ trên ứng dụng này', conversationId);
};
