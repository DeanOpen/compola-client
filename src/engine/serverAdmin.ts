// Native admin screens of Compola Server (Settings › Compola Server › Quản trị máy chủ): the server's REST API
// (docs/compola-server.md, "Admin") through `remote_api` — as the owner on the host, as the device's user when joined
// (the server checks admin rights on every call). The shapes are the admin console's (admin/src/types.ts, tested
// against the real server), imported as types only.

import type {
  AccountData,
  EffectiveAccess,
  Grant,
  Group,
  Role,
  Scope,
  Session,
  Subject,
  Timestamp,
  User,
  UserBrief,
} from '../../admin/src/types';
import { backend } from './backend';
import type { Phase } from './models/phase';

export type { AccountData, EffectiveAccess, Grant, Group, Role, Scope, Session, Subject, Timestamp, User, UserBrief };

/** `GET admin/zalo`: the host's engine phase and its signed-in account. */
export interface ZaloStatus {
  phase: Phase;
  account: { name: string; avatar: string; phase: string } | null;
}

export interface UserInput {
  username: string;
  displayName: string;
  email: string;
  password?: string;
  isAdmin: boolean;
  /** Pre-creates an LDAP / SSO user ("ldap:<id>" | "oidc:<id>"); absent = local (admin console's `UserInput`). */
  source?: string;
}

export type GrantInput = Omit<Grant, 'id' | 'createdAt'>;

/** Errors come back as the server's Vietnamese `{error}` text (Rust passes it through as the rejection). */
const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> =>
  (await backend()).invoke<T>('remote_api', { method, path, body: body === undefined ? null : body });

/** Lists may come bare (`[...]`) or wrapped (`{users: [...]}`); accept both (as the admin console does). */
const list = <T>(value: unknown, ...keys: string[]): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    for (const k of [...keys, 'items', 'data']) {
      const v = (value as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
};

const one = <T>(value: unknown, key: string): T => {
  if (value && typeof value === 'object' && key in (value as object)) {
    const v = (value as Record<string, unknown>)[key];
    if (v && typeof v === 'object') return v as T;
  }
  return value as T;
};

const enc = encodeURIComponent;

export const serverAdmin = {
  // The host's Zalo account
  zalo: () => api<ZaloStatus>('GET', 'admin/zalo'),
  zaloNewQr: () => api('POST', 'admin/zalo/qr', {}),
  zaloLogout: () => api('POST', 'admin/zalo/logout', {}),
  zaloRetry: () => api('POST', 'admin/zalo/retry', {}),

  // Users
  users: () => api('GET', 'admin/users').then((r) => list<User>(r, 'users')),
  createUser: (input: UserInput) => api('POST', 'admin/users', input).then((r) => one<User>(r, 'user')),
  updateUser: (id: string, patch: Partial<Pick<User, 'displayName' | 'email' | 'isAdmin' | 'disabled'>>) =>
    api('PATCH', `admin/users/${enc(id)}`, patch),
  setPassword: (id: string, password: string) => api('POST', `admin/users/${enc(id)}/password`, { password }),
  deleteUser: (id: string) => api('DELETE', `admin/users/${enc(id)}`),

  // Groups
  groups: () => api('GET', 'admin/groups').then((r) => list<Group>(r, 'groups')),
  createGroup: (g: { name: string; description: string }) => api('POST', 'admin/groups', g).then((r) => one<Group>(r, 'group')),
  updateGroup: (id: string, patch: { name?: string; description?: string }) => api('PATCH', `admin/groups/${enc(id)}`, patch),
  setGroupMembers: (id: string, userIds: string[]) => api('PUT', `admin/groups/${enc(id)}/members`, { userIds }),
  deleteGroup: (id: string) => api('DELETE', `admin/groups/${enc(id)}`),

  // Grants
  grants: () => api('GET', 'admin/grants').then((r) => list<Grant>(r, 'grants')),
  createGrant: (g: GrantInput) => api('POST', 'admin/grants', g).then((r) => one<Grant>(r, 'grant')),
  updateGrant: (id: string, patch: Partial<GrantInput>) => api('PATCH', `admin/grants/${enc(id)}`, patch),
  deleteGrant: (id: string) => api('DELETE', `admin/grants/${enc(id)}`),
  access: (userId: string) => api<EffectiveAccess>('GET', `admin/access/${enc(userId)}`),
  accountData: () =>
    api<Partial<AccountData> | null>('GET', 'admin/conversations').then((r) => ({ conversations: r?.conversations ?? [], labels: r?.labels ?? [] })),

  // Sign-in providers (names for the user source picker)
  providers: () =>
    api('GET', 'admin/providers').then((r) => list<{ id: string; kind: 'ldap' | 'oidc'; name: string; enabled: boolean }>(r, 'providers')),

  // Sessions / devices
  sessions: () => api('GET', 'admin/sessions').then((r) => list<Session>(r, 'sessions')),
  revokeSession: (id: string) => api('DELETE', `admin/sessions/${enc(id)}`),
};

/** Opens the full web console (or a page of it, e.g. `/admin/#/audit`) signed in. */
export const openAdminConsole = async (next?: string) => (await backend()).invoke<string>('remote_admin_open', next ? { next } : {});

// MARK: - Formatting

export const toDate = (t: Timestamp | null | undefined): Date | null => {
  if (t === null || t === undefined || t === '') return null;
  if (typeof t === 'number') return new Date(t < 1e12 ? t * 1000 : t);
  if (/^\d+$/.test(t)) return toDate(Number(t));
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const formatRelative = (t: Timestamp | null | undefined, never = 'Chưa bao giờ'): string => {
  const d = toDate(t);
  if (!d) return never;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'Vừa xong';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} ngày trước`;
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

export const roleNames: Record<Role, string> = { viewer: 'Người xem', agent: 'Nhân viên' };

export const roleHints: Record<Role | 'admin', string> = {
  viewer: 'Chỉ xem tin nhắn; không gửi, thả cảm xúc, thu hồi, ghim hay quản lý nhóm.',
  agent: 'Xem và thao tác (gửi, trả lời, thả cảm xúc…) trong phạm vi được cấp.',
  admin: 'Quản trị máy chủ và thấy mọi cuộc trò chuyện với quyền nhân viên.',
};

/** "Nội bộ" / "LDAP · AD Công ty" / "SSO · Google". */
export const sourceLabel = (source: string, providers: { id: string; name: string }[] = []) => {
  if (!source || source === 'local') return 'Nội bộ';
  const [kind, id] = source.split(':');
  const p = providers.find((x) => x.id === id);
  const base = kind === 'ldap' ? 'LDAP' : 'SSO';
  return p ? `${base} · ${p.name}` : base;
};

export const scopeText = (scope: Scope | null | undefined) => {
  if (!scope) return 'Không có';
  if (scope.all) return 'Tất cả cuộc trò chuyện';
  const parts: string[] = [];
  if (scope.conversations.length) parts.push(`${scope.conversations.length} cuộc trò chuyện`);
  if (scope.labels.length) parts.push(`${scope.labels.length} nhãn`);
  return parts.join(', ') || 'Không có';
};

/** "Nguyễn Thị Lan (@lan)" — a person, never a device. */
export const personText = (u: { username: string; displayName?: string } | null | undefined) =>
  !u ? 'Không rõ' : u.displayName && u.displayName !== u.username ? `${u.displayName} (@${u.username})` : `@${u.username}`;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e));
