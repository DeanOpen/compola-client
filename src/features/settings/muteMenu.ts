// Swift `ConversationMuteMenu`: the per-conversation "Tắt thông báo" item (official order: 1 giờ, 4 giờ, đến 8 giờ sáng,
// đến khi mở lại), or "Bật thông báo" while muted. For list-row context menus, the chat header and the inspector.

import { Bell, BellOff } from 'lucide-react';
import { isConversationMuted, muteConversation, muteDurations, unmuteConversation } from '../../engine/notifications';
import type { MenuItem } from '../../ui/Menu';

export const conversationMuteMenu = (conversationId: string): MenuItem =>
  isConversationMuted(conversationId)
    ? { label: 'Bật thông báo', icon: Bell, onSelect: () => unmuteConversation(conversationId) }
    : {
        kind: 'submenu',
        label: 'Tắt thông báo',
        icon: BellOff,
        items: muteDurations.map((d) => ({ label: d.title, onSelect: () => muteConversation(conversationId, d.value) })),
      };
