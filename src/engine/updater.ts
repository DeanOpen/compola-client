// Compola's own updates (src-tauri/src/updater.rs): state, check now, install now. The core checks by itself (signed in
// or not); this is for Settings › Cài đặt chung › Cập nhật.

import { create } from 'zustand';
import { backend, usesWeb } from './backend';

export interface UpdaterStatus {
  enabled: boolean;
  disabledReason: string | null;
  currentVersion: string;
  channel: 'stable' | 'edge';
  checking: boolean;
  installing: boolean;
  lastCheck: number | null;
  lastError: string | null;
  available: string | null;
  notes: string | null;
}

const call = async <T>(command: string) => (await backend()).invoke<T>(command);

export const updater = {
  status: () => call<UpdaterStatus>('updater_status'),
  check: () =>
    call<UpdaterStatus>('updater_check').then((status) => {
      useUpdater.setState({ status });
      return status;
    }),
  install: () => call<void>('updater_install'),
};

export const useUpdater = create<{ status: UpdaterStatus | null }>()(() => ({ status: null }));

let listening = false;
/** Loads the state and follows `compola://updater`. Nothing in the web client (it is updated with its server). */
export const watchUpdater = async () => {
  if (usesWeb) return;
  void updater.status().then((status) => useUpdater.setState({ status }), () => {});
  if (listening) return;
  listening = true;
  const b = await backend();
  await b.listen('compola://updater', (payload) => useUpdater.setState({ status: payload as UpdaterStatus }));
};
