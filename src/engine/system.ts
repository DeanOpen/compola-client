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
