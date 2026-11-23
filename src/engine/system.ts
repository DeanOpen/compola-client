// OS integration: opening web links in the default browser (Swift `WebLink.open`).

import { usesMock } from './backend';
import { webLink } from './models/json';

export const openExternal = async (link: string | null | undefined) => {
  const safe = webLink(link);
  if (!safe) return;
  if (usesMock) {
    window.open(safe, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(safe);
};

/** Opens a file attachment natively (`media_open_file`); until that command exists, the link opens in the browser. */
export const openAttachment = async (url: string | null, name: string) => {
  if (!url) return;
  if (!usesMock) {
    try {
      const { commands } = await import('./backend');
      const outcome = await commands.mediaOpenFile(url, name);
      if (outcome?.revealed) {
        const { showToast } = await import('./toast');
        showToast('Đã mở trong Finder vì tệp có thể chạy mã');
      }
      return;
    } catch {
      /* fall back to the browser */
    }
  }
  await openExternal(url);
};
