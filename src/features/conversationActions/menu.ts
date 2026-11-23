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
import { hostSettingsLocked } from '../../engine/remote';
import { getEngine } from '../../engine/store';
import type { MenuItem } from '../../ui/Menu';
import { Bell, BellOff } from 'lucide-react';
import { isConversationMuted, muteConversation, muteDurations, unmuteConversation } from '../../engine/notifications';
import { showUndoToast } from '../../engine/toast';
import { openLabelManager } from './LabelManager';

/**
 * "Phân loại ▸": the labels (one per conversation; the checked one clears it) and the label manager. Read only for a
 * Compola Server user who is not an admin (Zalo labels are the host admins').
 */
export const labelMenu = (id: string): MenuItem => {
  const s = getEngine();
  const locked = hostSettingsLocked();
  const current = s.extras.labelByConversation[id] ?? null;
  const labels: MenuItem[] = s.extras.labels.map((l) => ({
    label: l.name,
    dot: cssColor(l.colorHex) ?? undefined,
    checked: current === l.id,
    disabled: locked,
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
      locked
        ? { kind: 'label', label: 'Chỉ quản trị viên Compola Server đổi được phân loại' }
        : { label: 'Quản lý thẻ phân loại', icon: Settings2, onSelect: openLabelManager },
    ],
  };
};

export const conversationActionsMenu = (id: string, preset: MenuPreset = 'thread'): MenuItem[] => {
  const s = getEngine();
  if (!s.conversationActions.loaded) {
    // The adapter has not published yet: only what does not depend on it.
    return [labelMenu(id), muteMenuWithUndo(id)];
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
  if (plan.mute) items.push(muteMenuWithUndo(id));
  // Hidden chats need the account's PIN: the host admins' on a Compola Server.
  const pinLocked = hostSettingsLocked();
  if (plan.hide === 'hide') items.push({ label: 'Ẩn trò chuyện', icon: EyeOff, disabled: pinLocked, onSelect: () => setConversationPrompt({ kind: 'hide', id }) });
  if (plan.hide === 'unhide')
    items.push({ label: 'Bỏ ẩn trò chuyện', icon: Eye, disabled: pinLocked, onSelect: () => setConversationPrompt({ kind: 'unhide', id }) });
  if (plan.canDelete) {
    items.push({ kind: 'separator' });
    items.push({ label: 'Xóa hội thoại', icon: Trash2, destructive: true, onSelect: () => requestDeleteConversation(id) });
  }
  return items;
};

/** "Tắt thông báo ▸" / "Bật thông báo" (as settings/muteMenu.ts) with the wave-3 undo toast. */
export const muteMenuWithUndo = (id: string): MenuItem =>
  isConversationMuted(id)
    ? {
        label: 'Bật thông báo',
        icon: Bell,
        onSelect: () => {
          const before = muteDurations[muteDurations.length - 1].value;
          unmuteConversation(id);
          showUndoToast('Đã bật thông báo', () => muteConversation(id, before));
        },
      }
    : {
        kind: 'submenu',
        label: 'Tắt thông báo',
        icon: BellOff,
        items: muteDurations.map((d) => ({
          label: d.title,
          onSelect: () => {
            muteConversation(id, d.value);
            showUndoToast('Đã tắt thông báo', () => unmuteConversation(id));
          },
        })),
      };
