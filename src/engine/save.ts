// "Lưu về máy…" (Swift `NSSavePanel` + download): the user picks a destination, Rust's `media_save` writes the file
// (from the image cache or through the cors download path, atomically, quarantined). See docs/media.md.

import { commands, usesMock } from './backend';
import { showToast } from './toast';

/** Returns the saved path, or null when the user cancelled / it failed (a toast tells why). */
export const saveMediaAs = async (url: string, suggestedName: string, conversationId: string | null = null): Promise<string | null> => {
  const name = suggestedName.replace(/[/\\:]/g, '-').trim() || 'Compola';
  if (usesMock) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
    showToast('Đã lưu', conversationId);
    return name;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const dest = await save({ defaultPath: name, title: 'Lưu về máy' });
  if (!dest) return null;
  try {
    const path = await commands.mediaSave(url, dest);
    showToast('Đã lưu', conversationId);
    return path;
  } catch (e) {
    showToast(`Không lưu được tệp: ${String(e)}`, conversationId);
    return null;
  }
};
