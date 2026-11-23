// The official conversation menu (Swift `ConversationActionsMenu`), as menu items in official order:
// pin · (Khác / Tin nhắn · Phân loại · đã đọc / chưa đọc) · (thông báo · ẩn) · xóa.
// `thread` = the list row, `chatBox` = the chat's own menus (no archive, read or delete).

import { ArchiveRestore, Archive, Eye, EyeOff, MailCheck, MailOpen, Pin, PinOff, Settings2, Tag, Trash2 } from 'lucide-react';
import {
  markConversationRead,
  markConversationUnread,
  menuPlan,
  moveConversation,
  pinConversation,
  requestDeleteConversation,
  setConversationPrompt,
  unpinConversation,
  type MenuPreset,
} from '../../engine/conversationActions';
import { setConversationLabel } from '../../engine/conversations';
import { cssColor } from '../../engine/models/conversations';
import { getEngine } from '../../engine/store';
import type { MenuItem } from '../../ui/Menu';
import { conversationMuteMenu } from '../settings/muteMenu';
import { openLabelManager } from './LabelManager';

/** "Phân loại ▸": the labels (one per conversation; the checked one clears it) and the label manager. */
export const labelMenu = (id: string): MenuItem => {
  const s = getEngine();
  const current = s.extras.labelByConversation[id] ?? null;
  const labels: MenuItem[] = s.extras.labels.map((l) => ({
    label: l.name,
    dot: cssColor(l.colorHex) ?? undefined,
    checked: current === l.id,
    onSelect: () => setConversationLabel(id, current === l.id ? null : l.id),
  }));
  return {
    kind: 'submenu',
    label: 'Phân loại',
    icon: Tag,
    disabled: !s.extras.loaded,
    items: [
      ...(labels.length ? labels : [{ label: 'Chưa có thẻ phân loại', disabled: true, onSelect: () => {} } as MenuItem]),
      { kind: 'separator' },
      { label: 'Quản lý thẻ phân loại', icon: Settings2, onSelect: openLabelManager },
    ],
  };
};

export const conversationActionsMenu = (id: string, preset: MenuPreset = 'thread'): MenuItem[] => {
  const s = getEngine();
  if (!s.conversationActions.loaded) {
    // The adapter has not published yet: only what does not depend on it.
    return [labelMenu(id), conversationMuteMenu(id)];
  }
  const plan = menuPlan(id, preset, s);
  const items: MenuItem[] = [];
  if (plan.pin === 'pin') items.push({ label: 'Ghim hội thoại', icon: Pin, onSelect: () => void pinConversation(id) });
  if (plan.pin === 'unpin') items.push({ label: 'Bỏ ghim hội thoại', icon: PinOff, onSelect: () => void unpinConversation(id) });
  items.push({ kind: 'separator' });
  if (plan.archive === 'moveToOther') items.push({ label: 'Chuyển sang mục Khác', icon: Archive, onSelect: () => void moveConversation(id, true) });
  if (plan.archive === 'moveToFocus') items.push({ label: 'Chuyển sang Tin nhắn', icon: ArchiveRestore, onSelect: () => void moveConversation(id, false) });
  if (plan.showsLabel) items.push(labelMenu(id));
  if (plan.read === 'markRead') items.push({ label: 'Đánh dấu đã đọc', icon: MailCheck, onSelect: () => void markConversationRead(id) });
  if (plan.read === 'markUnread') items.push({ label: 'Đánh dấu chưa đọc', icon: MailOpen, onSelect: () => void markConversationUnread(id) });
  items.push({ kind: 'separator' });
  if (plan.mute) items.push(conversationMuteMenu(id));
  if (plan.hide === 'hide') items.push({ label: 'Ẩn trò chuyện', icon: EyeOff, onSelect: () => setConversationPrompt({ kind: 'hide', id }) });
  if (plan.hide === 'unhide') items.push({ label: 'Bỏ ẩn trò chuyện', icon: Eye, onSelect: () => setConversationPrompt({ kind: 'unhide', id }) });
  if (plan.canDelete) {
    items.push({ kind: 'separator' });
    items.push({ label: 'Xóa hội thoại', icon: Trash2, destructive: true, onSelect: () => requestDeleteConversation(id) });
  }
  return items;
};
