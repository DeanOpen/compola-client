// The transport to the Rust engine (src-tauri/src/engine.rs): Tauri commands + events, or the in-browser mock
// (`?mock=1`, or whenever the page is not running inside Tauri) so the UI can be developed in a plain browser.

import type { Phase } from './models/phase';

export type EngineEvent =
  | 'compola://phase'
  | 'compola://state'
  | 'compola://log'
  | 'compola://badge'
  | 'compola://page'
  /** `{id, convId}`: a notification was clicked — open that conversation. */
  | 'compola://notification-click'
  /** `{id, convId, text}`: an inline reply typed in a notification — send it. */
  | 'compola://notification-reply'
  /** Call helper lifecycle (call UI, later wave). */
  | 'compola://call-event'
  /** ZaloCap outcome: `{kind: send|sendToMe|share|shareText|noPermission|failed, …}`. */
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
  /** Tells Rust which chat is on screen (notifications for it are suppressed); null when none. */
  setOpenConversation: async (id: string | null) => (await backend()).invoke('ui_set_open_conversation', { id }),
  /** Whether notifications may show the message text. */
  setShowsPreview: async (shows: boolean) => (await backend()).invoke('ui_set_shows_preview', { shows }),
  /** Starts the official screenshot tool; the result arrives as `compola://screen-capture`. */
  screenCaptureStart: async (conversationId: string, withCompola: boolean) =>
    (await backend()).invoke('screen_capture_start', { conversationId, withCompola }),
  /** Saves a media URL to an absolute path (its folder must exist) → the path. */
  mediaSave: async (url: string, destPath: string) => (await backend()).invoke<string>('media_save', { url, destPath }),
};
