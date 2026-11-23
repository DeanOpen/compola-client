// Mock of `window.__zaloNotification` (notification-adapter.js) and of the Settings commands (`engine_info`,
// `engine_show_renderer`, `engine_switch_to_sqlite`, `ui_set_shows_preview`). Dev aid: `&settings=<tab>` opens Settings
// on a section (general | appearance | notifications | privacy | sticker | account | engine).

import type { Json } from '../../models/json';
import { mockContext, onMockBoot, registerMockAdapter, registerMockCommand } from '../registry';

const now = () => Date.now() / 1000;
let enabled = true;
let sound = true;
let hasSoundSetting = true;
const mutes = new Map<string, { startTime: number; duration: number }>([
  ['g-k15', { startTime: now() - 86400 * 3, duration: -1 }],
  ['u-tuan', { startTime: now() - 600, duration: 3600 }],
]);
let storage: 'idb' | 'sqlite' = 'idb';

const publish = () =>
  mockContext().post({
    notification: {
      kind: 'settings',
      userId: 'u-me',
      enabled,
      sound,
      hasSoundSetting,
      mutes: [...mutes].map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    } as Json,
  });

const modeSeconds = (mode: number): number => {
  if (mode === 1) return 3600;
  if (mode === 2) return 4 * 3600;
  if (mode === 3) {
    const t = new Date();
    t.setHours(8, 0, 0, 0);
    if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
    return (t.getTime() - Date.now()) / 1000;
  }
  return -1;
};

registerMockAdapter('__zaloNotification', {
  setPermission: () => undefined,
  permissionResult: () => undefined,
  refresh: () => publish(),
  setEnabled: (on: boolean) => {
    enabled = on;
    sound = on;
    setTimeout(publish, 250);
  },
  setSound: (on: boolean) => {
    sound = on;
    hasSoundSetting = true;
    setTimeout(publish, 250);
  },
  reconcileDefaults: () => undefined,
  mute: (id: string, mode: number) => {
    mutes.set(String(id), { startTime: now(), duration: modeSeconds(Number(mode)) });
    setTimeout(publish, 250);
  },
  unmute: (id: string) => {
    mutes.delete(String(id));
    setTimeout(publish, 250);
  },
  activity: () => undefined,
});

let stickerSuggest = true;
registerMockAdapter('__zaloSticker', {
  suggestSetting: () => ({ ok: true, enabled: stickerSuggest, debounce: 400 }),
  setSuggestSetting: (on: boolean) => {
    stickerSuggest = !!on;
    return { ok: true, enabled: stickerSuggest };
  },
});

const fakeLog = (): string[] => {
  const t = new Date();
  const stamp = (s: number) => new Date(t.getTime() - s * 1000).toTimeString().slice(0, 8);
  return [
    `[info] ${stamp(310)} [adapter] state-adapter installed (page main)`,
    `[info] ${stamp(309)} [adapter] conversations-adapter: ConvListController found`,
    `[log] ${stamp(305)} sqliteHost: open main.db (${storage})`,
    `[info] ${stamp(300)} [chat] chat-adapter ready`,
    `[log] ${stamp(240)} socket connected wss://ws2-msg.chat.zalo.me`,
    `[info] ${stamp(120)} [adapter] media-store-adapter: service dEOl resolved`,
    `[log] ${stamp(30)} sync: 0 pending messages`,
  ];
};

registerMockCommand('engine_info', () => ({ runtimeVersion: '26.10.20', storage, recentLog: fakeLog() }));
registerMockCommand('engine_show_renderer', () => undefined);
registerMockCommand('engine_switch_to_sqlite', () => {
  storage = 'sqlite';
  // Rust logs out after switching; the mock's own logout path shows the QR again.
  return import('../../backend').then(({ commands }) => commands.logout());
});
registerMockCommand('ui_set_shows_preview', () => undefined);
registerMockCommand('ui_set_open_conversation', () => undefined);

onMockBoot((ctx) => {
  ctx.post({ notification: { kind: 'ready' } });
  setTimeout(publish, 100);
  const tab = ctx.params.get('settings');
  if (tab !== null) {
    void import('../../../features/settings/hosts').then(({ openSettings }) =>
      setTimeout(() => openSettings((tab || 'general') as Parameters<typeof openSettings>[0]), 400),
    );
  }
  // A log line every so often, for the Engine tab's live log.
  setInterval(() => ctx.emit('compola://log', `[log] ${new Date().toTimeString().slice(0, 8)} heartbeat ok`), 15_000);
});

// macOS authorization (Rust notifications/): `&notifAuth=notDetermined|denied|unavailable`; "Cho phép" grants it.
let mockAuthorization: string | null = null;
const authorization = () => (mockAuthorization ??= mockContext().params.get('notifAuth') ?? 'authorized');
registerMockCommand('notification_authorization', () => authorization());
registerMockCommand('notification_request_authorization', () => {
  if (authorization() === 'notDetermined') mockAuthorization = 'authorized';
  return authorization();
});
