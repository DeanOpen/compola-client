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
  | 'compola://screen-capture'
  /** Automation (MCP, schedules, add-ons): `{kind: changed|message|schedule|toolCall, …}` (src-tauri/src/automation). */
  | 'compola://automation'
  /** Compola Server (src/engine/remote.ts): `{kind: changed|connection|joinProgress|access, …}`. */
  | 'compola://remote'
  /** Multi-account (src/engine/accounts.ts): `{accounts:[…], activeId}` — PROVISIONAL until docs/multi-account.md. */
  | 'compola://accounts';

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

type RawInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

// MARK: - Joined to a Compola Server (docs/compola-server.md, "Joined app — Tauri commands")

/** Commands a joined UI still runs on this machine (besides every `remote_*`). */
const joinedLocal = new Set([
  'ui_widen_window',
  'clipboard_paste_files',
  'media_allow_previews',
  'notification_authorization',
  'notification_request_authorization',
  'ui_set_open_conversation',
  'ui_set_shows_preview',
  'calls_status',
]);

/** Commands a joined UI runs through their `remote_*` counterpart (same arguments). */
const joinedRewritten: Record<string, string> = {
  engine_call_with_files: 'remote_call_with_files',
  media_save: 'remote_media_save',
  media_open_file: 'remote_media_open_file',
  engine_logout: 'remote_leave',
};

/** Only make sense on the machine signed in to Zalo. */
const joinedRefused = new Set(['screen_capture_start', 'call_show_window', 'engine_show_renderer', 'engine_switch_to_sqlite', 'engine_eval']);

/** The automation commands the host serves to joined apps (with their access applied). */
const joinedHostAutomation = new Set(['automation_search', 'automation_search_status', 'automation_conversations', 'automation_messages']);

export const joinedRefusal = 'Tính năng này chỉ dùng được trên máy chủ Compola Server.';

const routeJoined = <T>(raw: RawInvoke, command: string, args?: Record<string, unknown>): Promise<T> => {
  if (command.startsWith('remote_') || joinedLocal.has(command)) return raw<T>(command, args);
  const rewritten = joinedRewritten[command];
  if (rewritten) return raw<T>(rewritten, args);
  if (
    joinedRefused.has(command) ||
    ((command.startsWith('automation_') || command.startsWith('ai_clients_')) && !joinedHostAutomation.has(command))
  ) {
    // Rejected like a Tauri command error (a string).
    return Promise.reject(joinedRefusal);
  }
  return raw<T>('remote_invoke', { command, args: args ?? {} });
};

const readJoined = (raw: RawInvoke): Promise<boolean> =>
  raw<{ mode?: string } | null>('remote_status').then(
    (s) => s?.mode === 'joined',
    () => false,
  );

/** The real app's answer, read while its backend is created. */
let tauriJoined: Promise<boolean> | null = null;
let joinedPromise: Promise<boolean> | null = null;
let joinedNow = false;

const tauriBackend = async (): Promise<Backend> => {
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  const raw: RawInvoke = (command, args) => invoke(command, args);
  // Asked once: joining or leaving a server restarts the app.
  tauriJoined = readJoined(raw);
  const joined = await tauriJoined;
  return {
    isMock: false,
    invoke: joined ? (command, args) => routeJoined(raw, command, args) : raw,
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

/**
 * Whether this app is joined to a Compola Server (its UI then talks to the host; the local engine does not run).
 * Asked once per launch. The mock answers too (its commands are not routed).
 */
export const isJoined = (): Promise<boolean> => {
  if (!joinedPromise) {
    joinedPromise = backend()
      .then((b) => (b.isMock || !tauriJoined ? readJoined((c, a) => b.invoke(c, a)) : tauriJoined))
      .then((joined) => {
        joinedNow = joined;
        return joined;
      });
  }
  return joinedPromise;
};

/** `isJoined()` once it resolved (false before). */
export const joinedSync = () => joinedNow;

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
  /** Lets the media scheme serve these user-picked / pasted / dropped files (`?file=`) for 30 min; returns the count. */
  mediaAllowPreviews: async (paths: string[]) => (await backend()).invoke<number>('media_allow_previews', { paths }),
  setShowsPreview: async (shows: boolean) => (await backend()).invoke('ui_set_shows_preview', { shows }),
  /** Starts the official screenshot tool; the result arrives as `compola://screen-capture`. */
  screenCaptureStart: async (conversationId: string, withCompola: boolean) =>
    (await backend()).invoke('screen_capture_start', { conversationId, withCompola }),
  /** Widens (or with a negative delta narrows) the main window by `delta` logical px; the minimum width is 960. */
  widenWindow: async (delta: number) => (await backend()).invoke('ui_widen_window', { delta }),
  /** Downloads an attachment through the client's network stack and opens it (files that could run code are revealed). */
  mediaOpenFile: async (url: string, name: string) => (await backend()).invoke<{ path: string; revealed: boolean }>('media_open_file', { url, name }),
  /** Saves a media URL to an absolute path (its folder must exist) → the path. */
  mediaSave: async (url: string, destPath: string) => (await backend()).invoke<string>('media_save', { url, destPath }),
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
