// The transport to the Rust engine (src-tauri/src/engine.rs): Tauri commands + events, or the in-browser mock
// (`?mock=1`, or whenever the page is not running inside Tauri) so the UI can be developed in a plain browser.

import type { Phase } from './models/phase';

export type EngineEvent =
  | 'compola://phase'
  | 'compola://state'
  | 'compola://log'
  | 'compola://badge'
  | 'compola://page'
  | 'compola://call-event'
  | 'compola://notification-click'
  | 'compola://notification-reply'
  | 'compola://screen-capture';

export interface Backend {
  readonly isMock: boolean;
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Returns an unsubscribe function. */
  listen(event: EngineEvent, handler: (payload: unknown) => void): Promise<() => void>;
}

export const insideTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const mockRequested = (() => {
  if (typeof location === 'undefined') return false;
  const p = new URLSearchParams(location.search);
  return p.has('mock') && p.get('mock') !== '0';
})();

export const usesMock = mockRequested || !insideTauri;

const tauriBackend = async (): Promise<Backend> => {
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  return {
    isMock: false,
    invoke: (command, args) => invoke(command, args),
    listen: async (event, handler) => listen(event, (e) => handler(e.payload)),
  };
};

let backendPromise: Promise<Backend> | null = null;

export const backend = (): Promise<Backend> => {
  if (!backendPromise) {
    backendPromise = usesMock ? import('./mock/mockBackend').then((m) => m.createMockBackend()) : tauriBackend();
  }
  return backendPromise;
};

/** Commands of the Rust engine (engine.rs `#[tauri::command]`). */
export const commands = {
  phase: async () => (await backend()).invoke<Phase>('engine_phase'),
  info: async () =>
    (await backend()).invoke<{ runtimeVersion: string | null; storage: string | null; recentLog: string[] }>('engine_info'),
  refreshQr: async () => (await backend()).invoke('engine_refresh_qr'),
  logout: async () => (await backend()).invoke('engine_logout'),
  retryRuntime: async () => (await backend()).invoke('engine_retry_runtime'),
  showRenderer: async () => (await backend()).invoke('engine_show_renderer'),
  switchToSqlite: async () => (await backend()).invoke('engine_switch_to_sqlite'),
  /** Saves a media URL to `destPath` (absolute, folder must exist); see docs/media.md. */
  mediaSave: async (url: string, destPath: string) => (await backend()).invoke<string>('media_save', { url, destPath }),
  /** Stages + quarantines a media file and opens it (or reveals it in Finder when it could run code). */
  mediaOpenFile: async (url: string, name: string) =>
    (await backend()).invoke<{ path: string; revealed: boolean }>('media_open_file', { url, name }),
  setShowsPreview: async (shows: boolean) => (await backend()).invoke('ui_set_shows_preview', { shows }),
  setOpenConversation: async (id: string | null) => (await backend()).invoke('ui_set_open_conversation', { id }),
};

/** Files dragged over / dropped on the main window (Tauri's native drag-drop; the page's own HTML5 drop never fires).
 * Returns an unsubscribe function. A no-op in the mock. */
export const onFileDrop = async (
  handler: (event: { kind: 'over' } | { kind: 'leave' } | { kind: 'drop'; paths: string[] }) => void,
): Promise<() => void> => {
  if (usesMock) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === 'enter' || p.type === 'over') handler({ kind: 'over' });
    else if (p.type === 'leave') handler({ kind: 'leave' });
    else if (p.type === 'drop') handler({ kind: 'drop', paths: p.paths });
  });
};
