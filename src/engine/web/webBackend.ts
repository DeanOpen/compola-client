// The web client's backend (docs/compola-server.md, "Web client"): the app in a browser at `<server>/web/`, signed in
// with the admin console's cookie session. One WebSocket to `/ws` speaks what the desktop's joined client
// (src-tauri/src/remote/client.rs) speaks: server → `hello`, `event`, `result`, `access`, `bye`; app → `invoke`. The UI
// treats it as a joined app: commands go through the same routing (`routeJoined`), and the `remote_*` commands the
// joined desktop UI uses are answered here (connection state, files, media, the REST API, sign-out).
// Multiple Zalo accounts (M5): `hello` / `access` list the accounts the user may see; the one on screen is chosen here
// (remembered per browser), events of other accounts are dropped unless the scope is "all", and every engine command
// without an `account` gets the active one.

import { routeJoined, type Backend, type EngineEvent, type RawInvoke } from '../backend';
import { mediaUrl } from '../media';
import { capturePastes, clipboardFiles, pickFiles, uploadRefs } from './webFiles';

const loginUrl = () => `/admin/#/login?next=${encodeURIComponent('/web/')}`;
const notificationEvent = 'compola://remote-notification';

/** "Chrome · macOS": this browser, as the device name (the identity is the signed-in user). */
const browserName = () => {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Trình duyệt';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
};

type Json = Record<string, unknown>;
type Handler = (payload: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const byeText = (reason: unknown) => {
  switch (reason) {
    case 'kicked':
    case 'revoked':
      return 'Quản trị viên đã thu hồi phiên đăng nhập hoặc quyền của bạn.';
    case 'disabled':
      return 'Tài khoản của bạn đã bị khoá.';
    case 'restarted':
      return 'Compola Server vừa khởi động lại.';
    case 'lagged':
      return 'Kết nối quá chậm, đang kết nối lại.';
    default:
      return 'Mất kết nối tới Compola Server.';
  }
};

export const createWebBackend = (): Backend => {
  const listeners = new Map<string, Set<Handler>>();
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload));

  // MARK: Connection

  const connection: Json = {
    state: 'connecting',
    error: null,
    serverName: location.host,
    url: `${location.origin}/`,
    deviceId: '',
    deviceName: browserName(),
    everConnected: false,
    retryAt: null,
    user: null,
    access: null,
  };
  const update = (patch: Json) => {
    Object.assign(connection, patch);
    emit('compola://remote', { kind: 'connection', ...connection });
  };

  // MARK: Accounts

  const activeKey = 'compola.web.activeAccount';
  let accounts: Json[] = [];
  let active: string | null = (() => {
    try {
      return localStorage.getItem(activeKey);
    } catch {
      return null;
    }
  })();
  let eventScope: 'active' | 'all' = 'active';
  const accountList = () => ({
    active: active ?? '',
    maxAccounts: Math.max(accounts.length, 1),
    accounts: accounts.map((a) => ({ ...a, active: a.id === active })),
  });
  const setActive = (id: string, announce: boolean) => {
    if (id === active) return;
    active = id;
    try {
      localStorage.setItem(activeKey, id);
    } catch {
      /* private mode */
    }
    if (announce) emit('compola://accounts', { kind: 'active', account: id });
  };
  /** The accounts of `hello` / `access` (the ones this user may see, in order). */
  const applyAccounts = (list: unknown) => {
    if (!Array.isArray(list)) return;
    accounts = (list.filter((a) => a && typeof a === 'object' && typeof (a as Json).id === 'string') as Json[]).sort(
      (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0),
    );
    const keep = accounts.some((a) => a.id === active);
    if (!keep && accounts.length) setActive(String(accounts[0].id), true);
    emit('compola://accounts', { kind: 'changed', list: accountList() });
  };
  /** Events that reach the UI whatever account they belong to (docs/multi-account.md §6). */
  const everyAccount = new Set(['compola://badge', 'compola://call-event', 'compola://accounts', 'compola://notification-click', 'compola://remote']);
  const delivers = (event: string, account: unknown, payload: unknown) => {
    const id = typeof account === 'string' && account ? account : typeof (payload as Json | null)?.account === 'string' ? String((payload as Json).account) : '';
    return !id || !active || id === active || eventScope === 'all' || everyAccount.has(event);
  };

  let ws: WebSocket | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const waiters: (() => void)[] = [];

  const connected = () => connection.state === 'connected' && ws?.readyState === WebSocket.OPEN;

  const failPending = (text: string) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(text);
    }
    pending.clear();
  };

  /** Signed out (or the session expired): to the console's sign-in, back here afterwards. */
  const checkSignedIn = async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res.status === 401) {
        location.href = loginUrl();
        return false;
      }
      if (res.ok) {
        const me = (await res.json()) as { user?: Json; access?: Json | null };
        if (me.user) connection.user = { username: me.user.username, displayName: me.user.displayName };
        // `{admin, accounts}` (multi-account servers) or `{role, scope}`.
        const access = me.access as { role?: unknown; admin?: unknown; accounts?: Record<string, unknown> } | null | undefined;
        if (!access || (!access.role && !access.admin && !Object.keys(access.accounts ?? {}).length)) {
          update({ error: 'Tài khoản của bạn chưa được cấp quyền dùng tài khoản Zalo này. Hãy liên hệ quản trị viên.' });
          return false;
        }
      }
    } catch {
      /* offline: keep retrying */
    }
    return true;
  };

  const scheduleRetry = (error: string) => {
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    update({ state: 'disconnected', error, retryAt: Date.now() + delay });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  };

  function connect() {
    clearTimeout(retryTimer);
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    update({ state: 'connecting', retryAt: null });
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws = socket;
    let hello = false;
    let byeError: string | null = null;
    socket.onmessage = (e) => {
      let msg: Json;
      try {
        msg = JSON.parse(String(e.data)) as Json;
      } catch {
        return;
      }
      switch (msg.t) {
        case 'hello': {
          hello = true;
          attempt = 0;
          const server = (msg.server ?? {}) as Json;
          update({
            state: 'connected',
            error: null,
            everConnected: true,
            retryAt: null,
            serverName: typeof server.name === 'string' && server.name ? server.name : connection.serverName,
            user: msg.user ?? connection.user,
            access: msg.access ?? null,
          });
          applyAccounts(msg.accounts);
          waiters.splice(0).forEach((w) => w());
          break;
        }
        case 'result': {
          const p = pending.get(Number(msg.id));
          if (!p) break;
          pending.delete(Number(msg.id));
          clearTimeout(p.timer);
          if (msg.ok === true) p.resolve(msg.value ?? null);
          else p.reject(typeof msg.error === 'string' ? msg.error : 'Lỗi không rõ');
          break;
        }
        case 'event': {
          const event = String(msg.event ?? '');
          if (event === notificationEvent) showNotification((msg.payload ?? {}) as Json, msg.account);
          else if (event.startsWith('compola://') && delivers(event, msg.account, msg.payload)) emit(event, msg.payload ?? null);
          break;
        }
        case 'access':
          if (msg.accounts) applyAccounts(msg.accounts);
          if (msg.access) {
            update({ access: msg.access });
            emit('compola://remote', { kind: 'access', access: msg.access });
          }
          break;
        case 'bye':
          byeError = byeText(msg.reason);
          break;
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      failPending('Mất kết nối tới Compola Server.');
      // Closed before `hello`, or a "bye" for a revoked / disabled account: maybe signed out.
      const mayBeSignedOut = !hello || byeError === byeText('revoked') || byeError === byeText('disabled');
      void (mayBeSignedOut ? checkSignedIn() : Promise.resolve(true)).then((ok) => {
        if (ok) scheduleRetry(byeError ?? (hello ? 'Mất kết nối tới Compola Server.' : 'Không kết nối được tới Compola Server.'));
      });
    };
  }

  const waitConnected = (limitMs?: number) =>
    new Promise<void>((resolve, reject) => {
      if (connected()) return resolve();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = limitMs
        ? setTimeout(() => {
            const i = waiters.indexOf(done);
            if (i >= 0) waiters.splice(i, 1);
            reject('Chưa kết nối được tới Compola Server.');
          }, limitMs)
        : undefined;
      waiters.push(done);
    });

  /** One of the engine's commands, run by the host (`remote_invoke` of the desktop). */
  const invokeRemote = async (cmd: string, args: unknown): Promise<unknown> => {
    await waitConnected(20_000);
    // Engine commands act on the account on screen unless they name one.
    if (cmd.startsWith('engine_') && active) {
      const a = (args && typeof args === 'object' ? args : {}) as Json;
      if (!a.account) args = { ...a, account: active };
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject('Compola Server không trả lời kịp.');
      }, 300_000);
      pending.set(id, { resolve, reject, timer });
      try {
        ws!.send(JSON.stringify({ t: 'invoke', id, cmd, args: args ?? {} }));
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject('Mất kết nối tới Compola Server.');
      }
    });
  };

  // MARK: Notifications

  let openConversation: string | null = null;
  let showsPreview = true;
  const permission = () => (typeof Notification === 'undefined' ? 'unavailable' : Notification.permission);
  const authorization = () => {
    const p = permission();
    return p === 'granted' ? 'authorized' : p === 'denied' ? 'denied' : p === 'default' ? 'notDetermined' : 'unavailable';
  };

  function showNotification(payload: Json, wireAccount: unknown) {
    if (permission() !== 'granted') return;
    const tag = typeof payload.tag === 'string' ? payload.tag : '';
    const account = typeof payload.account === 'string' ? payload.account : typeof wireAccount === 'string' ? wireAccount : '';
    // The chat on screen does not notify (the desktop suppresses it the same way).
    if (document.hasFocus() && tag && tag === openConversation && (!account || account === active)) return;
    const image = typeof payload.image === 'string' && payload.image ? `data:image/png;base64,${payload.image}` : undefined;
    try {
      const n = new Notification(showsPreview ? String(payload.title ?? 'Compola') : 'Compola', {
        body: showsPreview ? String(payload.body ?? '') : 'Bạn có tin nhắn mới',
        tag: tag || undefined,
        icon: showsPreview ? image : undefined,
        silent: payload.silent === true,
      });
      n.onclick = () => {
        window.focus();
        n.close();
        // With the account: lifecycle switches to it first when it is not the one on screen.
        if (tag) emit('compola://notification-click', { id: tag, convId: tag, ...(account ? { account } : {}) });
      };
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }

  // The permission prompt needs a user gesture: the first click on the page asks once.
  const askOnGesture = () => {
    window.removeEventListener('pointerdown', askOnGesture, true);
    if (permission() === 'default') void Notification.requestPermission().catch(() => {});
  };

  // MARK: Commands

  const api = async (method: string, path: string, body: unknown) => {
    const res = await fetch(`/api/${path.replace(/^\/+/, '')}`, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Compola': '1', Accept: 'application/json', ...(body != null ? { 'Content-Type': 'application/json' } : {}) },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status === 401) location.href = loginUrl();
    if (!res.ok) throw (data as { error?: string } | null)?.error ?? `Lỗi máy chủ (${res.status}).`;
    return data;
  };

  const download = (url: string, name: string) => {
    const a = document.createElement('a');
    a.href = mediaUrl(url, 'file') ?? url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const signOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-Compola': '1' } });
    } catch {
      /* go to the sign-in anyway */
    }
    location.href = loginUrl();
  };

  /** What a joined desktop's Rust answers locally (the `remote_*` commands and the commands kept local). */
  const raw: RawInvoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const a = args;
    const value = await (async (): Promise<unknown> => {
      switch (command) {
        case 'remote_status':
          return { mode: 'joined', connection: { ...connection } };
        case 'remote_state':
          return {
            mode: 'joined',
            computerName: browserName(),
            server: { config: {}, running: false, error: null, addresses: [], hasAdmin: true, adminUrl: '/admin/', sessions: [] },
            join: null,
            lastJoin: null,
            connection: { ...connection },
          };
        case 'remote_wait_connected':
          return waitConnected();
        case 'remote_retry':
          attempt = 0;
          connect();
          return null;
        case 'remote_leave':
          return signOut();
        case 'remote_invoke':
          return invokeRemote(String(a.command), a.args);
        case 'remote_call_with_files': {
          const refs = Array.isArray(a.files) ? (a.files as string[]) : await pickFiles(typeof a.pick === 'string' ? a.pick : null);
          if (!refs.length) return null;
          const files = await uploadRefs(refs);
          return invokeRemote('engine_call_with_files', { target: a.target, method: a.method, args: a.args, files, ...(a.account ? { account: a.account } : {}) });
        }
        case 'remote_media_save': {
          const dest = String(a.destPath ?? '');
          download(String(a.url), dest.split('/').pop() || 'Compola');
          return dest;
        }
        case 'remote_media_open_file':
          window.open(mediaUrl(String(a.url), 'file') ?? String(a.url), '_blank', 'noopener');
          return { path: '', revealed: false };
        case 'remote_api':
          return api(String(a.method ?? 'GET').toUpperCase(), String(a.path ?? ''), a.body);
        case 'remote_admin_open': {
          const next = typeof a.next === 'string' && a.next.startsWith('/admin/') ? a.next : '/admin/';
          window.open(next, '_blank', 'noopener');
          return `${location.origin}${next}`;
        }
        case 'remote_join_cancel':
          return null;
        // Multiple Zalo accounts
        case 'remote_accounts_list':
          return accountList();
        case 'remote_account_set_active': {
          const id = String(a.account ?? '');
          if (!accounts.some((x) => x.id === id)) throw 'Tài khoản không tồn tại';
          setActive(id, true);
          emit('compola://accounts', { kind: 'changed', list: accountList() });
          return null;
        }
        case 'remote_set_event_scope':
          eventScope = a.scope === 'all' ? 'all' : 'active';
          return null;
        // Kept local by the joined routing
        case 'ui_set_open_conversation':
          openConversation = typeof a.id === 'string' ? a.id : null;
          return null;
        case 'ui_set_shows_preview':
          showsPreview = a.shows !== false;
          return null;
        case 'ui_widen_window':
          return null;
        case 'media_allow_previews':
          return Array.isArray(a.paths) ? a.paths.length : 0;
        case 'clipboard_paste_files':
          return clipboardFiles();
        case 'notification_authorization':
          return authorization();
        case 'notification_request_authorization':
          if (permission() === 'default') await Notification.requestPermission().catch(() => 'default');
          return authorization();
        case 'calls_status':
          return { helperInstalled: false, running: false, pid: null, problem: 'Gọi điện chưa có trên bản web.' };
        default:
          if (command.startsWith('remote_')) throw 'Không có trên bản web.';
          throw `Không có trên bản web: ${command}`;
      }
    })();
    return value as T;
  };

  // MARK: Start

  capturePastes();
  // Files dropped outside the chat must not navigate the tab away.
  window.addEventListener('dragover', (e) => e.dataTransfer?.types.includes('Files') && e.preventDefault());
  window.addEventListener('drop', (e) => e.dataTransfer?.types.includes('Files') && e.preventDefault());
  if (permission() === 'default') window.addEventListener('pointerdown', askOnGesture, true);
  connect();

  return {
    isMock: false,
    invoke: <T>(command: string, args?: Record<string, unknown>) => routeJoined<T>(raw, command, args),
    listen: async (event: EngineEvent, handler: Handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
  };
};
