// "Lưu về máy…" (Swift `NSSavePanel` + download): the user picks a destination, Rust's `media_save` writes the file
// (from the image cache or through the cors download path, atomically, quarantined). See docs/media.md.

import { commands, usesMock, usesTauri, usesWeb } from './backend';
import { mediaUrl } from './media';
import { showToast } from './toast';

/** Returns the saved path, or null when the user cancelled / it failed (a toast tells why). */
export const saveMediaAs = async (url: string, suggestedName: string, conversationId: string | null = null): Promise<string | null> => {
  const name = suggestedName.replace(/[/\\:]/g, '-').trim() || 'Compola';
  // Browser: a download link (the web client loads it through the server's /media/load).
  if (!usesTauri) {
    const a = document.createElement('a');
    a.href = usesWeb ? (mediaUrl(url, 'file') ?? url) : url;
    a.download = name;
    if (!usesWeb) a.target = '_blank';
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

/**
 * "Mở bằng ứng dụng khác": Rust `media_open_file` stages the file under its real name, quarantines it and opens it in
 * its default app, or reveals it in Finder when it could run code (`revealed`). `url` is a `file://` or CDN URL.
 */
export const openMediaExternally = async (url: string, name: string, conversationId: string | null = null): Promise<boolean> => {
  if (usesMock) {
    window.open(url, '_blank', 'noopener');
    return true;
  }
  try {
    const r = await commands.mediaOpenFile(url, name);
    if (r.revealed) showToast('Tệp này có thể chạy mã nên được hiện trong Finder thay vì mở.', conversationId);
    return true;
  } catch (e) {
    showToast(`Không mở được tệp: ${String(e)}`, conversationId);
    return false;
  }
};
