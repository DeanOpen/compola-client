// Notification settings + per-conversation mutes (Swift `ZaloEngine+Notifications.swift`, UI side), bridged to
// `host-scripts/notification-adapter.js` (`window.__zaloNotification`; posts {page:'main', notification:{kind, …}}).
//
// Who decides what:
//   * The official renderer decides *whether* a message notifies (global toggle, per-conversation mute incl. timed mute,
//     group/1-1/stranger rules, sound setting, "app is focused") and builds the text.
//   * Rust (`notifications/`) shows it as a native banner and plays the official sound (`kind:'sound'` never reaches us).
//   * Settings live in the official client's storage (`askNoti`, `z_sound`) and mute service (`MuteDataManager`); this
//     module mirrors and drives them. "Hiện nội dung tin nhắn" is ours: `ui_set_shows_preview`.
// A banner click (`compola://notification-click`) opens its conversation; an inline reply (`compola://notification-reply`) is
// sent like a composer message.

import { create } from 'zustand';
import { backend, commands, usesMock } from './backend';
import { fireAdapter, log } from './call';
import { sendText } from './chat';
import { registerStateHandler } from './dispatch';
import { arr, bool, num, obj, str, type Json } from './models/json';
import { getEngine, onAccountReset, setEngine } from './store';

// MARK: - Mute durations

/** The four choices of the official "Tắt thông báo" menu; values are `MuteDataManager.onMute(convId, mode)` modes. */
export const MuteDuration = { oneHour: 1, fourHours: 2, until8AM: 3, untilReopened: 4 } as const;
export type MuteDuration = (typeof MuteDuration)[keyof typeof MuteDuration];

export const muteDurations: { value: MuteDuration; title: string }[] = [
  { value: MuteDuration.oneHour, title: 'Trong 1 giờ' },
  { value: MuteDuration.fourHours, title: 'Trong 4 giờ' },
  { value: MuteDuration.until8AM, title: 'Cho đến 8:00 AM' },
  { value: MuteDuration.untilReopened, title: 'Cho đến khi được mở lại' },
];

/** When the mute ends (epoch ms), null = until the user turns notifications back on. "8 AM" is the next 08:00. */
export const muteExpiry = (d: MuteDuration, now = Date.now()): number | null => {
  switch (d) {
    case MuteDuration.oneHour:
      return now + 3600_000;
    case MuteDuration.fourHours:
      return now + 4 * 3600_000;
    case MuteDuration.until8AM: {
      const t = new Date(now);
      t.setHours(8, 0, 0, 0);
      if (t.getTime() <= now) t.setDate(t.getDate() + 1);
      return t.getTime();
    }
    default:
      return null;
  }
};

/** A conversation mute as the official `MuteDataManager` stores it (seconds; `duration` -1 = until reopened). */
export interface MuteInfo {
  startTime: number;
  duration: number;
}

export const muteUntil = (m: MuteInfo): number | null => (m.duration < 0 ? null : (m.startTime + m.duration) * 1000);

export const isMuteActive = (m: MuteInfo, now = Date.now()) => {
  const until = muteUntil(m);
  return until === null || until > now;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "Cho đến 14:30" / "Cho đến 14:30 ngày 27/10" / "Cho đến khi được mở lại". */
export const muteDescription = (m: MuteInfo, now = Date.now()): string => {
  const until = muteUntil(m);
  if (until === null) return 'Cho đến khi được mở lại';
  const d = new Date(until);
  const n = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? `Cho đến ${time}` : `Cho đến ${time} ngày ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
};

/** Menu status line: "Đang tắt đến 14:30" / "Đang tắt cho đến khi được mở lại". */
export const muteStatusText = (m: MuteInfo, now = Date.now()): string =>
  muteUntil(m) === null ? 'Đang tắt cho đến khi được mở lại' : 'Đang tắt đến' + muteDescription(m, now).slice('Cho đến'.length);

// MARK: - State

/** macOS permission for banners. `unknown` = not queried (the Rust contract has no status command yet). */
export type NotificationAuthorization = 'unknown' | 'unavailable' | 'notDetermined' | 'denied' | 'authorized';

const previewKey = 'compola.notifications.showsPreview';

const readPreview = (): boolean => {
  try {
    const v = localStorage.getItem(previewKey);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
};

export interface NotificationSettingsState {
  /** A settings snapshot from the official client has arrived. */
  isLoaded: boolean;
  /** Official "Cài đặt thông báo ▸ Bật" (`askNoti`). */
  enabled: boolean;
  /** Official "Phát âm thanh khi có tin nhắn & thông báo mới" (`z_sound`). */
  sound: boolean;
  hasSoundSetting: boolean;
  /** Show message text in banners; off → "Bạn có tin nhắn mới". */
  showsPreview: boolean;
  authorization: NotificationAuthorization;
  /** Conversation id → mute, as stored by the official mute service (may include expired entries). */
  mutes: Record<string, MuteInfo>;
}

const initial = (): NotificationSettingsState => ({
  isLoaded: false,
  enabled: true,
  sound: false,
  hasSoundSetting: false,
  showsPreview: readPreview(),
  authorization: 'unknown',
  mutes: {},
});

export const useNotifications = create<NotificationSettingsState>()(initial);
const set = useNotifications.setState;
const get = useNotifications.getState;

/** Active mute of a conversation, null when notifications are on. */
export const muteFor = (s: NotificationSettingsState, id: string, now = Date.now()): MuteInfo | null => {
  const m = s.mutes[id];
  return m && isMuteActive(m, now) ? m : null;
};

/** Active mutes, longest-standing first. */
export const activeMutes = (s: NotificationSettingsState, now = Date.now()): { id: string; info: MuteInfo }[] =>
  Object.entries(s.mutes)
    .filter(([, m]) => isMuteActive(m, now))
    .map(([id, info]) => ({ id, info }))
    .sort((a, b) => a.info.startTime - b.info.startTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// The engine store's `mutedIds` (list rows, chat header) follows the active mutes, re-derived when the next one ends.
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const syncMuted = () => {
  const now = Date.now();
  const active = activeMutes(get(), now).map((m) => m.id);
  const current = getEngine().mutedIds;
  if (active.length !== current.size || active.some((id) => !current.has(id))) setEngine({ mutedIds: new Set(active) });
  if (expiryTimer) clearTimeout(expiryTimer);
  const next = Object.values(get().mutes)
    .map(muteUntil)
    .filter((t): t is number => t !== null && t > now)
    .sort((a, b) => a - b)[0];
  if (next !== undefined) expiryTimer = setTimeout(syncMuted, Math.min(next - now + 500, 2 ** 31 - 1));
};
useNotifications.subscribe((s, prev) => {
  if (s.mutes !== prev.mutes) syncMuted();
});

const applySettings = (json: Json) => {
  const mutes: Record<string, MuteInfo> = {};
  for (const entry of arr(json.mutes)) {
    const e = obj(entry);
    const id = e ? str(e.id) : '';
    if (!e || !id) continue;
    mutes[id] = { startTime: num(e.startTime), duration: e.duration == null ? -1 : num(e.duration, -1) };
  }
  const s = get();
  const next = {
    isLoaded: true,
    enabled: json.enabled === undefined ? s.enabled : bool(json.enabled),
    sound: json.sound === undefined ? s.sound : bool(json.sound),
    hasSoundSetting: json.hasSoundSetting === undefined ? s.hasSoundSetting : bool(json.hasSoundSetting),
    mutes: JSON.stringify(mutes) === JSON.stringify(s.mutes) ? s.mutes : mutes,
  };
  if (next.isLoaded !== s.isLoaded || next.enabled !== s.enabled || next.sound !== s.sound || next.hasSoundSetting !== s.hasSoundSetting || next.mutes !== s.mutes) {
    set(next);
  }
};

// MARK: - macOS authorization

/**
 * The shim's `Notification.permission` is what the official code gates on: Rust reports the macOS authorization
 * (`notification_authorization`, `notification_request_authorization` → "authorized" | "denied" | "notDetermined" |
 * "unavailable"). If the command fails the shim is told "granted" (Rust drops banners macOS refuses).
 */
const queryAuthorization = async (request: boolean): Promise<NotificationAuthorization> => {
  try {
    const b = await backend();
    const status = await b.invoke<string>(request ? 'notification_request_authorization' : 'notification_authorization');
    return (['unavailable', 'notDetermined', 'denied', 'authorized'] as const).find((x) => x === status) ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

const permissionOf = (a: NotificationAuthorization) => (a === 'denied' ? 'denied' : a === 'notDetermined' ? 'default' : 'granted');

const applyAuthorization = (a: NotificationAuthorization) => {
  if (get().authorization !== a) set({ authorization: a });
  fireAdapter('__zaloNotification', 'setPermission', permissionOf(a));
  return permissionOf(a);
};

export const requestNotificationAuthorization = async () => applyAuthorization(await queryAuthorization(true));
export const refreshNotificationAuthorization = async () => applyAuthorization(await queryAuthorization(false));

export const openSystemNotificationSettings = async () => {
  if (usesMock) return;
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
  } catch (e) {
    log(`open notification settings: ${String(e)}`);
  }
};

// MARK: - Actions

/** Official toggle: notifications on/off (also switches the sound like the official page does). */
export const setNotificationsEnabled = (enabled: boolean) => {
  set({ enabled, sound: enabled });
  fireAdapter('__zaloNotification', 'setEnabled', enabled);
  if (enabled) void requestNotificationAuthorization();
};

export const setNotificationSound = (sound: boolean) => {
  set({ sound, hasSoundSetting: true });
  fireAdapter('__zaloNotification', 'setSound', sound);
};

export const setMessagePreview = (shown: boolean) => {
  set({ showsPreview: shown });
  try {
    localStorage.setItem(previewKey, shown ? '1' : '0');
  } catch {
    /* private mode */
  }
  commands.setShowsPreview(shown).catch((e) => log(`ui_set_shows_preview: ${String(e)}`));
};

/** When the settings UI appears: the official settings page's first-visit defaults, a fresh snapshot. */
export const notificationSettingsDidAppear = () => {
  fireAdapter('__zaloNotification', 'reconcileDefaults');
  fireAdapter('__zaloNotification', 'refresh');
  void refreshNotificationAuthorization();
};

export const isConversationMuted = (id: string) => muteFor(get(), id) !== null;

/** Official "Tắt thông báo" submenu → `MuteDataManager.onMute(convId, mode)`; syncs to the server. */
export const muteConversation = (id: string, duration: MuteDuration) => {
  const now = Date.now();
  const until = muteExpiry(duration, now);
  // Optimistic: the official service confirms through the next settings snapshot.
  set((s) => ({ mutes: { ...s.mutes, [id]: { startTime: now / 1000, duration: until === null ? -1 : (until - now) / 1000 } } }));
  fireAdapter('__zaloNotification', 'mute', id, duration);
};

/** Official "Bật thông báo" → `MuteDataManager.onUnMute(convId)`. */
export const unmuteConversation = (id: string) => {
  set((s) => {
    const mutes = { ...s.mutes };
    delete mutes[id];
    return { mutes };
  });
  fireAdapter('__zaloNotification', 'unmute', id);
};

/** Native user input, forwarded as the DOM event the official activity tracker listens for. */
export const reportActivity = () => fireAdapter('__zaloNotification', 'activity');

// MARK: - Adapter events

const handleNotification = (state: Json) => {
  const payload = obj(state.notification);
  if (!payload) return;
  switch (str(payload.kind)) {
    case 'ready':
      // Renderer booted: tell the shim the permission, then read the settings.
      void (async () => {
        let a = await queryAuthorization(false);
        if (a === 'notDetermined') a = await queryAuthorization(true);
        applyAuthorization(a);
        fireAdapter('__zaloNotification', 'refresh');
      })();
      return;
    case 'requestPermission':
      // The official code asked (`Notification.requestPermission`): answer with the macOS decision.
      void (async () => {
        const a = await queryAuthorization(true);
        if (get().authorization !== a) set({ authorization: a });
        fireAdapter('__zaloNotification', 'permissionResult', permissionOf(a));
      })();
      return;
    case 'settings':
      applySettings(payload);
      return;
    default:
      return;
  }
};

registerStateHandler('notification', handleNotification);

onAccountReset(() => {
  set({ ...initial(), showsPreview: get().showsPreview, authorization: get().authorization });
  syncMuted();
});

// Rust keeps the preview setting in memory only: tell it the persisted value at launch.
if (!usesMock) commands.setShowsPreview(readPreview()).catch(() => {});

// Banner click → that conversation; inline reply → sent like a composer message.
void backend().then((b) => {
  void b.listen('compola://notification-click', (p) => {
    const conv = str(obj(p)?.convId);
    if (conv) setEngine({ navigationRequest: conv });
  });
  void b.listen('compola://notification-reply', (p) => {
    const o = obj(p);
    const conv = o ? str(o.convId) : '';
    const text = o ? str(o.text).trim() : '';
    if (conv && text) void sendText(text, conv);
  });
});
