// Mock of Compola Server (src-tauri/src/remote, docs/compola-server.md): the host settings and the join flow.
//
// Dev aids:
// * Join from the login screen (`&phase=login`): any address works except one containing "fail"; password
//   "compola" signs in (a username containing "viewer" gets the viewer role), anything else is refused; "Đăng nhập
//   bằng trình duyệt" is approved after 6 s. A joined mock is remembered for the tab (sessionStorage) until
//   "Rời máy chủ".
// * `&remote=agent|viewer` starts joined right away; `&remote=offline` cannot connect until "Thử lại";
//   `&providers=many` lists five SSO providers (tiles instead of buttons).
//   `&remote=drop` loses the connection 6 s after connecting and gets it back 4 s later (the page then reloads; once
//   per tab).

import type { Json } from '../../models/json';
import { mockContext, registerMockCommand } from '../registry';

const storageKey = 'compola.mockRemote';

interface MockJoin {
  url: string;
  serverName: string;
  deviceName: string;
  username: string;
  displayName: string;
  role: 'admin' | 'agent' | 'viewer';
}

const readJoin = (): MockJoin | null => {
  const forced = new URLSearchParams(location.search).get('remote');
  if (forced) {
    return {
      url: 'https://compola.congty.vn/',
      serverName: 'Compola — Công ty ABC',
      deviceName: 'MacBook của Lan',
      username: 'lan.nguyen',
      displayName: 'Nguyễn Thị Lan',
      role: forced === 'viewer' ? 'viewer' : 'agent',
    };
  }
  try {
    const raw = sessionStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as MockJoin) : null;
  } catch {
    return null;
  }
};

const join = readJoin();
const scenario = new URLSearchParams(location.search).get('remote');
const computerName = 'MacBook Pro của Lan';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emit = (payload: Json) => mockContext().emit('compola://remote', payload);

// MARK: - Joined: the connection

let connection: Json | null = join
  ? {
      state: 'connecting',
      error: null,
      serverName: join.serverName,
      url: join.url,
      deviceName: join.deviceName,
      deviceId: '3f9a2c7e51d04b6c9e1a',
      everConnected: false,
      retryAt: null,
      user: { username: join.username, displayName: join.displayName },
      access: { role: join.role, scope: join.role === 'viewer' ? { all: false, conversations: ['g-k15', 'u-tuan', 'u-minh'], labels: ['l1'] } : { all: true, conversations: [], labels: [] } },
    }
  : null;
let offline = scenario === 'offline';
/** `&remote=drop` drops once per tab (the reload after the reconnect would drop again otherwise). */
const dropKey = 'compola.mockRemoteDropped';
const droppedOnce = () => {
  try {
    if (sessionStorage.getItem(dropKey)) return true;
    sessionStorage.setItem(dropKey, '1');
  } catch {
    /* private mode */
  }
  return false;
};
const waiters: (() => void)[] = [];

const setConnection = (patch: Json) => {
  if (!connection) return;
  connection = { ...connection, ...patch };
  emit({ kind: 'connection', ...connection });
  if (connection.state === 'connected') waiters.splice(0).forEach((w) => w());
};

const connect = () => {
  setConnection({ state: 'connecting', error: null, retryAt: null });
  setTimeout(() => {
    if (offline) {
      setConnection({ state: 'disconnected', error: 'Không kết nối được tới máy chủ (connection refused).', retryAt: Date.now() + 15_000 });
      return;
    }
    setConnection({ state: 'connected', error: null, everConnected: true });
    if (scenario === 'drop' && !droppedOnce()) {
      setTimeout(() => {
        setConnection({ state: 'disconnected', error: 'Mất kết nối (timeout).', retryAt: Date.now() + 4000 });
        setTimeout(connect, 4000);
      }, 6000);
    }
  }, 900);
};

registerMockCommand('remote_status', () => (join ? { mode: 'joined', connection } : { mode: 'local' }));

registerMockCommand('remote_wait_connected', () => {
  if (!join) throw 'not joined';
  if (connection?.state === 'connected') return undefined;
  const done = new Promise<void>((r) => waiters.push(r));
  if (connection?.state === 'connecting' && waiters.length === 1) connect();
  return done;
});

registerMockCommand('remote_retry', () => {
  offline = false;
  connect();
});

registerMockCommand('remote_leave', () => {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* private mode */
  }
  const url = new URL(location.href);
  url.searchParams.delete('remote');
  setTimeout(() => location.replace(url.toString()), 300);
});

// MARK: - Joining

let browserJoin: { cancel: () => void } | null = null;

const normalize = (raw: string) => {
  const t = raw.trim();
  if (!t) throw 'Nhập địa chỉ của Compola Server.';
  const withScheme = /^https?:\/\//i.test(t) ? t : `http://${t}`;
  const u = new URL(withScheme);
  if (!u.port && u.protocol === 'http:' && !/[a-z]/i.test(u.hostname.replace(/\./g, ''))) u.port = '39218';
  return u.toString();
};

const finishJoin = (j: MockJoin) => {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(j));
  } catch {
    /* private mode */
  }
  // The real app restarts.
  setTimeout(() => location.reload(), 400);
};

registerMockCommand('remote_providers', async (args) => {
  const url = normalize(String(args.url ?? ''));
  await delay(600);
  if (url.includes('fail')) throw 'Không kết nối được tới máy chủ. Kiểm tra địa chỉ và mạng.';
  return {
    url,
    serverName: 'Compola — Công ty ABC',
    local: true,
    ldap: [{ id: 'ad', name: 'Active Directory' }],
    // `&providers=many`: more SSO providers than fit as buttons (tiles).
    oidc: [
      { id: 'google', name: 'Google Workspace' },
      { id: 'entra', name: 'Microsoft Entra ID' },
      ...(new URLSearchParams(location.search).get('providers') === 'many'
        ? [
            { id: 'okta', name: 'Okta' },
            { id: 'keycloak', name: 'Keycloak' },
            { id: 'github', name: 'GitHub' },
          ]
        : []),
    ],
  };
});

registerMockCommand('remote_join_password', async (args) => {
  const username = String(args.username ?? '').trim();
  await delay(800);
  if (!username || args.password !== 'compola') throw 'Sai tên đăng nhập hoặc mật khẩu.';
  finishJoin({
    url: String(args.url),
    serverName: 'Compola — Công ty ABC',
    deviceName: String(args.deviceName ?? computerName),
    username,
    displayName: username,
    role: username.includes('viewer') ? 'viewer' : 'agent',
  });
});

registerMockCommand('remote_join_browser', (args) => {
  browserJoin?.cancel();
  const userCode = 'KXRT-WQMB';
  const verifyUrl = `${String(args.url).replace(/\/$/, '')}/admin/#/device?code=${userCode}`;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      browserJoin = null;
      emit({ kind: 'joinProgress', userCode: '', verifyUrl: '' });
      finishJoin({
        url: String(args.url),
        serverName: 'Compola — Công ty ABC',
        deviceName: String(args.deviceName ?? computerName),
        username: 'lan.nguyen@congty.vn',
        displayName: 'Nguyễn Thị Lan',
        role: 'agent',
      });
      resolve();
    }, 6000);
    browserJoin = {
      cancel: () => {
        clearTimeout(timer);
        browserJoin = null;
        emit({ kind: 'joinProgress', userCode: '', verifyUrl: '' });
        reject('Đã huỷ đăng nhập.');
      },
    };
    setTimeout(() => emit({ kind: 'joinProgress', userCode, verifyUrl, expiresIn: 600 }), 400);
  });
});

registerMockCommand('remote_join_cancel', () => browserJoin?.cancel());

// MARK: - Host

const server = {
  config: { enabled: false, port: 39218, allowNetwork: true, name: 'Compola — Công ty ABC', publicUrl: '' },
  running: false,
  error: null as string | null,
  hasAdmin: false,
  // Rust's shape: online sessions only, `{id, userId, username, deviceId, deviceName, address, since, role}`.
  sessions: [
    { id: 's1', userId: 'u1', username: 'lan.nguyen', deviceName: 'MacBook Air', deviceId: '3f9a2c7e51d04b6c9e1a', address: '192.168.1.24', since: Date.now() - 86400_000 * 3, role: 'agent' },
    { id: 's4', userId: 'u2', username: 'tuan.pham', deviceName: 'MacBook Air', deviceId: 'b71e04d29a3c4f88a0d2', address: '192.168.1.31', since: Date.now() - 7200_000, role: 'viewer' },
    { id: 's2', userId: 'u2', username: 'tuan.pham', deviceName: 'iMac phòng kinh doanh', deviceId: '9c02aa61e7f54e1b8b33', address: '100.88.12.7', since: Date.now() - 86400_000, role: 'viewer' },
    { id: 's3', userId: 'u0', username: 'admin', deviceName: 'MacBook Pro của Hùng', deviceId: 'e40b7d1c22a94f0aa5b8', address: '100.101.7.9', since: Date.now() - 600_000, role: 'admin' },
  ],
};

const changed = () => emit({ kind: 'changed' });

registerMockCommand('remote_state', () => ({
  mode: join ? 'joined' : 'local',
  computerName,
  server: {
    ...server,
    addresses: server.running
      ? [
          { ip: '192.168.1.10', kind: 'lan' },
          { ip: '100.101.7.42', kind: 'tailscale' },
        ]
      : [],
    adminUrl: server.running ? `http://127.0.0.1:${server.config.port}/admin/` : null,
    sessions: server.running ? server.sessions : [],
  },
  join: null,
  lastJoin: join ? null : { url: 'http://192.168.1.10:39218/', deviceName: computerName },
  connection,
}));

registerMockCommand('remote_set_server', async (args) => {
  const config = args.config as typeof server.config;
  if (config.port < 1024 || config.port > 65535) throw 'Cổng phải từ 1024 đến 65535';
  await delay(250);
  server.config = { ...config, name: config.name.trim() || computerName };
  server.running = config.enabled && config.port !== 80;
  server.error = config.enabled && !server.running ? `Không mở được cổng ${config.port}: Address already in use` : null;
  changed();
});

registerMockCommand('remote_admin_setup', async (args) => {
  if (server.hasAdmin) throw 'Đã có tài khoản quản trị.';
  if (String(args.password ?? '').length < 8) throw 'Mật khẩu cần ít nhất 8 ký tự.';
  await delay(400);
  server.hasAdmin = true;
  changed();
});

registerMockCommand('remote_admin_open', () => {
  const link = `http://127.0.0.1:${server.config.port}/api/auth/otp?t=mock`;
  window.open(link, '_blank', 'noopener');
  return link;
});

registerMockCommand('remote_kick', (args) => {
  const id = String(args.sessionId ?? '');
  server.sessions = server.sessions.filter((s) => s.id !== id);
  changed();
});
