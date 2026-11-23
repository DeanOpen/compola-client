// Compola Server (docs/compola-server.md): the host's settings (Settings › Compola Server), the join flow of the login
// screen and, for a joined app, the connection to the host and the user's access. Commands are `remote_*` in
// src-tauri/src/remote/mod.rs; the store is fed by `compola://remote` plus the initial `remote_status`.

import { create } from 'zustand';
import { backend } from './backend';
import { arr, bool, num, obj, optStr, str, strings, type Json } from './models/json';

// MARK: - Shapes

export type RemoteMode = 'local' | 'joined';
export type RemoteRole = 'admin' | 'agent' | 'viewer';

export interface RemoteScope {
  all: boolean;
  conversations: string[];
  labels: string[];
}

export interface RemoteAccess {
  /** null: signed in but no grant (the host refuses everything). */
  role: RemoteRole | null;
  scope: RemoteScope;
}

export interface RemoteUser {
  username: string;
  displayName: string;
}

export interface RemoteConnection {
  state: 'connecting' | 'connected' | 'disconnected';
  error: string | null;
  serverName: string;
  url: string;
  /** A label for this install only (default: the computer's name); the signed-in identity is `user`. */
  deviceName: string;
  /** Stable id of this install (several devices may share a name). */
  deviceId: string;
  /** Connected at least once since launch: a drop then means "reconnecting", not "cannot connect". */
  everConnected: boolean;
  /** Next automatic attempt (epoch ms). */
  retryAt: number | null;
  user: RemoteUser | null;
  access: RemoteAccess | null;
}

export interface RemoteServerConfig {
  enabled: boolean;
  port: number;
  /** Listen on every interface (LAN, Tailscale); false = this machine only (behind a tunnel / reverse proxy). */
  allowNetwork: boolean;
  name: string;
  publicUrl: string;
}

export interface RemoteAddress {
  ip: string;
  /** lan | tailscale | public */
  kind: string;
}

export interface RemoteSession {
  id: string;
  user: RemoteUser | null;
  /** web (admin console) | device (joined app) */
  kind: string;
  deviceName: string;
  /** Stable id of the install (empty for admin console sessions). */
  deviceId: string;
  ip: string;
  createdAt: number | null;
  lastSeenAt: number | null;
  online: boolean;
  role: RemoteRole | null;
}

export interface RemoteHost {
  config: RemoteServerConfig;
  running: boolean;
  error: string | null;
  addresses: RemoteAddress[];
  hasAdmin: boolean;
  adminUrl: string | null;
  sessions: RemoteSession[];
}

export interface RemoteLastJoin {
  url: string;
  deviceName: string;
}

/** `remote_state()`: everything Settings › Compola Server and the join form show. */
export interface RemoteState {
  mode: RemoteMode;
  computerName: string;
  server: RemoteHost;
  lastJoin: RemoteLastJoin | null;
  connection: RemoteConnection | null;
}

export interface RemoteProvider {
  id: string;
  name: string;
}

/** `remote_providers(url)`: the sign-in options of a server. */
export interface RemoteProviders {
  /** Normalized address. */
  url: string;
  serverName: string;
  local: boolean;
  ldap: RemoteProvider[];
  oidc: RemoteProvider[];
}

/** Device sign-in under way: the code the browser shows. */
export interface JoinProgress {
  userCode: string;
  verifyUrl: string;
  /** When the code expires (epoch ms; `expiresIn` seconds after it arrived, 600 by default). */
  expiresAt: number;
}

// MARK: - Parsing (tolerant: missing fields get defaults)

const time = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

const role = (v: unknown): RemoteRole | null => (v === 'admin' || v === 'agent' || v === 'viewer' ? v : null);

const parseUser = (v: unknown): RemoteUser | null => {
  const o = obj(v);
  if (!o) return null;
  const username = str(o.username);
  return { username, displayName: str(o.displayName) || username };
};

export const parseAccess = (v: unknown): RemoteAccess | null => {
  const o = obj(v);
  if (!o) return null;
  const scope = obj(o.scope);
  return { role: role(o.role), scope: { all: bool(scope?.all), conversations: strings(scope?.conversations), labels: strings(scope?.labels) } };
};

export const parseConnection = (v: unknown): RemoteConnection | null => {
  const o = obj(v);
  if (!o) return null;
  const state = o.state === 'connected' || o.state === 'disconnected' ? o.state : 'connecting';
  return {
    state,
    error: optStr(o.error),
    serverName: str(o.serverName),
    url: str(o.url),
    deviceName: str(o.deviceName),
    deviceId: str(o.deviceId),
    everConnected: bool(o.everConnected),
    retryAt: time(o.retryAt),
    user: parseUser(o.user),
    access: parseAccess(o.access),
  };
};

/** `server.sessions[]`: `{id, userId, username, displayName?, deviceId, deviceName, address, since, role}` (online only). */
const parseSession = (v: unknown): RemoteSession | null => {
  const o = obj(v);
  if (!o) return null;
  const user = parseUser(o.user) ?? (typeof o.username === 'string' ? parseUser({ username: o.username, displayName: o.displayName }) : null);
  return {
    id: str(o.id),
    user,
    kind: str(o.kind, 'device'),
    deviceName: str(o.deviceName),
    deviceId: str(o.deviceId),
    ip: str(o.address) || str(o.ip),
    createdAt: time(o.since ?? o.createdAt),
    lastSeenAt: time(o.lastSeenAt),
    online: bool(o.online, true),
    role: role(o.role),
  };
};

export const parseState = (v: unknown): RemoteState => {
  const o = obj(v) ?? {};
  const server = obj(o.server) ?? {};
  const config = obj(server.config) ?? {};
  const last = obj(o.lastJoin);
  return {
    mode: o.mode === 'joined' ? 'joined' : 'local',
    computerName: str(o.computerName),
    server: {
      config: {
        enabled: bool(config.enabled),
        port: num(config.port, 39218),
        allowNetwork: bool(config.allowNetwork, true),
        name: str(config.name),
        publicUrl: str(config.publicUrl),
      },
      running: bool(server.running),
      error: optStr(server.error),
      addresses: arr(server.addresses)
        .map(obj)
        .filter((a): a is Json => !!a && typeof a.ip === 'string')
        .map((a) => ({ ip: str(a.ip), kind: str(a.kind, 'lan') })),
      hasAdmin: bool(server.hasAdmin),
      adminUrl: optStr(server.adminUrl),
      sessions: arr(server.sessions)
        .map(parseSession)
        .filter((s): s is RemoteSession => !!s),
    },
    lastJoin: last ? { url: str(last.url), deviceName: str(last.deviceName) } : null,
    connection: parseConnection(o.connection),
  };
};

const parseProviders = (v: unknown, fallbackUrl: string): RemoteProviders => {
  const o = obj(v) ?? {};
  const list = (x: unknown): RemoteProvider[] =>
    arr(x)
      .map(obj)
      .filter((p): p is Json => !!p)
      .map((p) => ({ id: str(p.id), name: str(p.name) || str(p.id) }));
  return { url: str(o.url, fallbackUrl), serverName: str(o.serverName), local: bool(o.local, true), ldap: list(o.ldap), oidc: list(o.oidc) };
};

// MARK: - Commands

const call = async <T = unknown>(command: string, args?: Record<string, unknown>) => (await backend()).invoke<T>(command, args);

export const remote = {
  status: async () => {
    const o = obj(await call('remote_status'));
    return { mode: (o?.mode === 'joined' ? 'joined' : 'local') as RemoteMode, connection: parseConnection(o?.connection) };
  },
  state: async () => parseState(await call('remote_state')),

  // Host
  setServer: (config: RemoteServerConfig) => call<void>('remote_set_server', { config }),
  /** Creates the first admin of the admin console (only while there is none). */
  adminSetup: (admin: { username: string; password: string; displayName: string }) => call<void>('remote_admin_setup', admin),
  kick: (sessionId: string) => call<void>('remote_kick', { sessionId }),

  // Joining
  providers: async (url: string) => parseProviders(await call('remote_providers', { url }), url),
  /** Signs in with a password, saves the token and restarts the app (resolves only on failure paths in practice). */
  joinPassword: (a: { url: string; username: string; password: string; provider: string; deviceName: string }) => call<void>('remote_join_password', a),
  /**
   * Device sign-in: opens the browser and waits for approval (`joinProgress` carries the code), then restarts.
   * `provider` (an OIDC provider id) is a hint only; the browser lets the user pick.
   */
  joinBrowser: (a: { url: string; deviceName: string; provider?: string }) => call<void>('remote_join_browser', a),
  joinCancel: () => call<void>('remote_join_cancel'),

  // Joined
  leave: () => call<void>('remote_leave'),
  retry: () => call<void>('remote_retry'),
  waitConnected: () => call<void>('remote_wait_connected'),
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e));

// MARK: - Store

interface RemoteStore {
  /** null until `remote_status` answered. */
  mode: RemoteMode | null;
  connection: RemoteConnection | null;
  joinProgress: JoinProgress | null;
  /** Bumped on `{kind: "changed"}` (host settings, sessions): Settings › Compola Server reloads `remote_state`. */
  revision: number;
}

export const useRemote = create<RemoteStore>()(() => ({ mode: null, connection: null, joinProgress: null, revision: 0 }));

/** A `compola://remote` event. Also used by lifecycle.ts. */
export const handleRemoteEvent = (payload: unknown) => {
  const o = obj(payload);
  if (!o) return;
  switch (o.kind) {
    case 'changed':
      useRemote.setState((s) => ({ revision: s.revision + 1 }));
      break;
    case 'connection': {
      const connection = parseConnection(o);
      // A connection event without the user / access keeps the ones known.
      if (connection)
        useRemote.setState((s) => ({
          connection: { ...connection, user: connection.user ?? s.connection?.user ?? null, access: connection.access ?? s.connection?.access ?? null },
        }));
      break;
    }
    case 'joinProgress': {
      const userCode = str(o.userCode);
      const expiresAt = Date.now() + num(o.expiresIn, 600) * 1000;
      useRemote.setState({ joinProgress: userCode ? { userCode, verifyUrl: str(o.verifyUrl), expiresAt } : null });
      break;
    }
    case 'access': {
      const access = parseAccess(o.access);
      useRemote.setState((s) => (s.connection ? { connection: { ...s.connection, access } } : {}));
      break;
    }
  }
};

let initialized: Promise<void> | null = null;

/** Subscribes to `compola://remote` and reads the mode once. Idempotent. */
export const initRemote = (): Promise<void> => {
  if (!initialized) {
    initialized = (async () => {
      const b = await backend();
      await b.listen('compola://remote', handleRemoteEvent);
      try {
        const status = await remote.status();
        useRemote.setState((s) => ({ mode: status.mode, connection: s.connection ?? status.connection }));
      } catch {
        // An engine without Compola Server.
        useRemote.setState({ mode: 'local' });
      }
    })();
  }
  return initialized;
};

// MARK: - Selectors

export const isViewerState = (s: RemoteStore) => s.mode === 'joined' && s.connection?.access?.role === 'viewer';

/** Joined with read-only access: the UI hides its write actions (the host refuses them anyway). */
export const useIsViewer = () => useRemote(isViewerState);

export const useIsJoinedUi = () => useRemote((s) => s.mode === 'joined');

/**
 * Joined without the admin role: the account's own settings (notifications, sticker suggestions, the hidden-chat PIN,
 * Zalo labels) belong to the host's admins, so the UI disables them with `adminOnlyHint` instead of letting them fail.
 */
export const hostSettingsLockedState = (s: RemoteStore) => s.mode === 'joined' && s.connection?.access?.role !== 'admin';
export const useHostSettingsLocked = () => useRemote(hostSettingsLockedState);
export const hostSettingsLocked = () => hostSettingsLockedState(useRemote.getState());
export const adminOnlyHint = 'Chỉ quản trị viên Compola Server đổi được cài đặt này.';

/** "Nguyễn Thị Lan (@lan.nguyen)": the server account a joined app is signed in with (never the device). */
export const userTitle = (u: RemoteUser | null | undefined) =>
  !u ? '—' : u.displayName && u.displayName !== u.username ? `${u.displayName} (@${u.username})` : `@${u.username}`;

/** A short form of a device id, to tell apart devices with the same name ("#3F9A2C"). */
export const shortDeviceId = (id: string | null | undefined) => {
  const t = (id ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
  return t ? `#${t}` : '';
};

/** "MacBook của Lan · #3F9A2C" */
export const deviceTitle = (name: string | null | undefined, id: string | null | undefined) =>
  [name || 'Thiết bị không tên', shortDeviceId(id)].filter(Boolean).join(' · ');

export const roleTitle = (r: RemoteRole | null | undefined) =>
  r === 'admin' ? 'Quản trị viên' : r === 'agent' ? 'Nhân viên' : r === 'viewer' ? 'Chỉ xem' : 'Chưa được cấp quyền';

export const scopeSummary = (scope: RemoteScope | null | undefined) => {
  if (!scope) return '—';
  if (scope.all) return 'Tất cả cuộc trò chuyện';
  const parts = [`${scope.conversations.length} cuộc trò chuyện`];
  if (scope.labels.length) parts.push(`${scope.labels.length} nhãn`);
  return parts.join(', ');
};
