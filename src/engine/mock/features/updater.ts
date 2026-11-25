// Mock of Compola's updater (src-tauri/src/updater.rs) for the browser preview: an edge build with a newer one waiting.

import { registerMockCommand } from '../registry';

let status = {
  enabled: true,
  disabledReason: null as string | null,
  currentVersion: '0.1.5-21',
  channel: 'edge',
  checking: false,
  installing: false,
  lastCheck: null as number | null,
  lastError: null as string | null,
  available: null as string | null,
  notes: null as string | null,
};

registerMockCommand('updater_status', () => status);
registerMockCommand('updater_check', () => {
  status = { ...status, lastCheck: Date.now(), available: '0.1.5-22', notes: 'Compola 0.1.5-22: https://github.com/DeanOpen/compola-client/releases/tag/edge' };
  return status;
});
registerMockCommand('updater_install', () => {
  throw new Error('Không cài cập nhật trong bản xem trước.');
});
