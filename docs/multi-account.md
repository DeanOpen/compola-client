# Multiple Zalo accounts in one Compola — design & contract

One Compola (the desktop app, or the host of a Compola Server) keeps several Zalo accounts signed in at once, for
example sales accounts 1, 2 and 3. Admins add an account (QR sign-in), sign it out and remove it. Staff get access per
account (Compola Server grants). This document is the contract between the Rust core (`src-tauri/`), the UI (`src/`)
and Compola Server (`src-tauri/src/remote/`, `docs/compola-server.md`).

Status: contract. Implemented in milestones on `feature/multi-account-core`; see "Rollout".

## 1. Account model

### Identity

- **`accountId`**: matches `default` or `a` followed by 8 lowercase hex characters (`a1b2c3d4`). It is assigned when
  the account is added and **never changes**. It names the account's data folder, cookie jar, webview labels and
  WebKit origin (§2). WebKit storage is bound to the origin, so the id cannot be renamed after sign-in without losing
  the renderer's IndexedDB and localStorage: the official client keeps its device identity, session keys and message
  database there.
- **`uid`**: the Zalo user id. It is unknown while the account sits on the QR screen and recorded at sign-in.
  - It is the account's stable *Zalo* identity: Compola Server grants and audit entries record `{accountId, uid}`.
  - The same `uid` may not be signed in twice. If a QR sign-in resolves to a `uid` another account already has, the new
    account is signed out and removed, the existing one becomes active, and the UI gets
    `compola://accounts {kind: "duplicate", account: <existing id>}`.
- Ids are validated everywhere they arrive from outside (commands, URLs, the server API). They must match
  `^(default|a[0-9a-f]{8})$` because they end up in paths, labels and origins.

### Registry: `~/Library/Application Support/Compola/accounts.json`

```json
{
  "version": 1,
  "active": "default",
  "maxAccounts": 5,
  "accounts": [
    { "id": "default", "uid": "123…", "name": "Sales 1", "avatar": "https://…", "order": 0,
      "enabled": true, "addedAt": 1763900000000 },
    { "id": "a1b2c3d4", "uid": null, "name": null, "avatar": null, "order": 1, "enabled": true,
      "addedAt": 1763900100000 }
  ]
}
```

- **`active`**: the account the UI window shows. It is the default target of every command and the only account whose
  UI events reach a UI that has not opted into all accounts (§6).
- **`maxAccounts`**: the cap, default **5**. `account_add` refuses beyond it.
- **`order`**: rail / switcher order (`account_reorder`).
- **`enabled`**: `false` keeps the account (data and session) without starting its renderers. It neither receives
  messages nor notifies (§8).
- `name` and `avatar` are refreshed from the renderer's signed-in user, so the switcher can show them before the
  renderer is up.
- The file is written atomically (tmp + rename). An unreadable file is kept as `accounts.json.bad` and the registry
  restarts from the accounts found on disk: `default`, plus every valid `Accounts/<id>/`.

## 2. Isolation per account

| | `default` (the existing install) | added account `<id>` |
|---|---|---|
| data root | `Compola/` | `Compola/Accounts/<id>/` |
| Electron `userData` | `Compola/ZaloData/` | `Compola/Accounts/<id>/ZaloData/` |
| cookie jar | `Compola/cookies.json` | `Compola/Accounts/<id>/cookies.json` |
| SQLite host root | `ZaloData/sqlite/_production` | `Accounts/<id>/ZaloData/sqlite/_production` |
| WebKit origin | `zalo-app://local` | `zalo-app://<id>` |
| host webview labels | `zalo-host`, `zalo-worker` | `zalo-host-<id>`, `zalo-worker-<id>` |

- **WebKit storage**: localStorage, IndexedDB and service workers are partitioned by origin. Each account loads its
  pages from its own `zalo-app://<host>` origin, so nothing mixes. This works on every macOS version Compola supports
  and needs no `data_store_identifier` (macOS 14+). The default account keeps `zalo-app://local`, the origin its data
  already lives under.
  - The `zalo-app` protocol handler routes by **webview label** (`Hosts` is keyed by label), so origins and routing are
    independent.
  - A non-host webview (the UI window) that asks `zalo-app://<host>/…` for renderer assets is served from the runtime
    of the account named by `<host>`.
  - Bridge values that are URLs of the renderer (`get-child-url`, `get-photo-viewer-url`, `get-resource-dir`) use the
    account's origin.
- **Per account, in Rust**: one `Engine`, which owns the account's `MainProcess`, `Platform` (userData, stores),
  `SharedWorkerRouter`, `CookieJar`, download manager and replay log, plus the automation mirror. Each `Host` knows
  its account; its `NetworkProxy` and `net::fetch` use that account's jar.
- **Shared**: the official runtime (one install), the fingerprint helper (one process; each request carries the cookie
  header of the account's jar), the call helper (§4), the notifier (§5), the screen-capture tool, the media loader, the
  automation server, the Compola Server listener.
- **Media**: `compola-media://load?…&account=<id>`. The account selects the cookie jar. The URL cache and on-disk media
  cache keys include the account, because the same URL can answer differently with another account's cookies. A
  missing `account` means the active account, and `file=` paths must lie under some account's data root.
  - Pre-multi-account cache entries count as `default`'s.

## 3. Lifecycle and resources

- The runtime is installed or located once, then every **enabled** account boots its engine: main host and worker
  host.
- Each account costs about 300 MB of RAM (two hidden WKWebViews plus their WebContent processes).
- **Decision: every enabled account stays running.** Zalo delivers messages and calls to a live client (the renderer's
  WebSocket and its shared-worker sync); a stopped account would miss them and notify late. So:
  - **No lazy start.** The cap (default 5) and `enabled: false` are the resource controls.
  - **No throttling.** Background throttling stays **disabled for every hidden renderer**, active or not: throttled
    timers delay the WebSocket keep-alive and message processing.
- Hosts start one after another, each about 2 s after the previous one reaches `ready` or `login`, so ten WebContent
  processes don't start at once.
- **`account_add`**: creates the id and folder, adds the registry row, boots a host on the QR page, and sets it active
  unless `{activate: false}`.
- **`account_remove(id)`**: signs the account out (renderer logout, cookie jar cleared), stops its hosts, deletes
  `Accounts/<id>/` and the row, and clears its cache entries.
  - `default` is never deleted: removing it signs it out and leaves it on the QR screen, keeping its row.
  - If the active account is removed, the first remaining one in `order` becomes active.
- **Sign-out from Zalo** (another PC took the session, or the user logs out in the renderer) leaves the account
  registered, on its QR screen.
- **App exit**: every engine shuts down. The helpers die through the parent-death watchdog.

## 4. Calls

VNG's `ZaloCall` is a single process. Two concurrent calls make no sense, and one helper instance cannot serve two
signed-in users. So:

- **One `ZaloCall` helper**, with an **owner account** at any time (or none). The helper's events (`call-update`,
  `call-send-signal`, `call-request`, `call-response-*`) go to the owner's main host only.
- Every account's `call-init` payload is remembered **per account**. When the helper (re)starts for an owner, that
  owner's init is sent on `native-ready`.
- **Owner changes** happen only while no call is in progress (helper `callState` is `free` or the helper is not
  running):
  - A non-optional message from a non-owner that is not `update/init` or `update/updateLocal` (a call request, an
    incoming call's control message) makes that account the owner: the helper is restarted with its init and the
    message is delivered after `native-ready`.
  - Startup `init` messages (`launch_native_in_startup`) only set the owner when there is none, preferring the active
    account, so N accounts starting up don't flip the helper N times.
- **Busy**: a message from another account while a call is in progress on the owner is not delivered. The UI gets
  `compola://call-event {kind: "busy", account: <requester>, owner: <owner>}`: "Đang có cuộc gọi trên tài khoản …".
- `compola://call-event` payloads carry `account` (the owner). `calls_status` → `{…, owner}`.

## 5. Notifications

- Each banner is tied to its account. The title is prefixed with the account's name (`"Sales 2 · Mẹ"`) when more than
  one account is registered.
- The UN thread id is `<accountId>:<conversationId>`, so `clearDelivered` is per account and conversation.
- A click on a non-active account's banner calls `account_set_active(account)`, then navigates. The UI gets
  `compola://notification-click {account, id, convId}`. `compola://notification-reply` also carries `account`.
- Suppression ("you are looking at this conversation") applies only to the active account.
- `_noti_on-*` callbacks go back to the host that created the notification (already the case).
- **Badges** are per account: `compola://badge {account, count}`. The dock badge is the sum over accounts (official
  formatting: nothing at 0, `5+` above 5).

## 6. UI contract

### Events

Every `compola://*` event carries the account. Object payloads gain a top-level `account` field. Payloads that were not
objects change shape:

| event | before | after |
|---|---|---|
| `compola://state` | renderer payload `{kind, …}` | same + `account` |
| `compola://phase` | `Phase` `{kind, …}` | same + `account` |
| `compola://page` | `{…}` | same + `account` |
| `compola://badge` | `n` | `{account, count}` |
| `compola://log` | `"line"` | `{account, line}` |
| `compola://call-event` | `{kind, …}` | same + `account` (owner) |
| `compola://notification-click` / `-reply` | `{id, convId, …}` | same + `account` |
| `compola://screen-capture` | `{kind, …}` | same + `account` (the capture's conversation) |
| `compola://automation` | `{kind, …}` | same + `account` where it concerns one |
| `compola://remote`, `compola://remote-notification` | | `account` where it concerns one |

- **Delivery to the UI**:
  - By default, account-scoped events (`state`, `phase`, `page`, `log`) reach the UI window only for the **active**
    account.
  - `badge`, notifications, `call-event` and `accounts` always reach it.
  - `ui_set_event_scope("all" | "active")` opts into every account's events, for a UI that renders several accounts at
    once.
  - Internal consumers (Compola Server, automation) always get every account.
- **New events**:
  - `compola://accounts {kind: "changed", list: AccountList}`: anything in the switcher changed (list, phase, profile,
    badge, order).
  - `compola://accounts {kind: "active", account}`: the active account changed. The UI clears its store, then rebuilds
    from `engine_phase({account})` and `engine_replay({account})`.
  - `compola://accounts {kind: "duplicate", account}` (§1).

### Commands

- Every engine and media command takes an optional `account` (camelCase in `invoke` args). When it is missing, the
  active account is used:
  - `engine_phase`, `engine_info`, `engine_call`, `engine_call_with_files`, `engine_eval`, `engine_replay`,
    `engine_refresh_qr`, `engine_logout`, `engine_show_renderer`, `engine_switch_to_sqlite`;
  - `ui_set_open_conversation`;
  - `media_save`, `media_open_file`, and `media_allow_previews` (paths only, no account);
  - `screen_capture_start`, `call_show_window`.
- `engine_retry_runtime` and `ui_set_shows_preview` stay global.
- Unknown or invalid account → `Err("Tài khoản không tồn tại")`.
- **New commands**:
  - `accounts_list()` → `AccountList`:

    ```text
    {active, maxAccounts, accounts: [{id, uid, name, avatar, order, enabled, active,
      phase: "disabled" | "starting" | "preparing" | "login" | "signingIn" | "ready", badge}]}
    ```

  - `account_add({activate?: boolean = true})` → `{id}`. It refuses at the cap: `"Đã đạt số tài khoản tối đa (5)"`. The
    new account's QR arrives as its `compola://phase` (`login`).
  - `account_remove({account})` (§3).
  - `account_set_active({account})`.
  - `account_reorder({ids})`: all ids, in the new order.
  - `account_set_enabled({account, enabled})`: stops or starts its hosts.
  - `account_rename({account, name})`: a local label, shown instead of the Zalo name when set.
  - `ui_set_event_scope({scope})`.

## 7. Compola Server

The server shares **every** account of its host. The account becomes a dimension of access, of the mirror and of the
wire protocol.

- **Grants**: `{…, account: <accountId> | "*", role, scope: {all, conversations, labels}}`.
  - `"*"` means every account, present and future, with this role and scope; conversation and label lists then only
    make sense with `all`.
  - **Migration**: existing grants get `account: "default"` (they were made for that account).
  - **Effective access** is per account: `access: {accounts: {<accountId>: {role, scope}}}`, the highest role and the
    union of scopes over the user's and their groups' grants for that account, plus `"*"` grants. Admins have
    everything.
- **Mirror and policy**: `Mirror` is kept per account (conversation ids are only unique within an account: the same
  group can be in two accounts). `check_call`, `filter_event` and `filter_result` take the account. Deny by default for
  an account the user has no grant on.
- **Wire** (`/ws`):
  - Server → app: `{t: "event", account, event, payload}`, `{t: "hello", server, user, access, accounts:
    [{id, name, avatar, phase}]}` (only the accounts the user has access to), `{t: "access", access, accounts}`.
  - App → server: `{t: "invoke", id, cmd, args}`, where `args.account` selects the account (missing → the user's first
    accessible account in `order`).
  - Media: `/media/load?…&account=` is checked against the user's access.
  - A joined app shows the server's accounts in its switcher. `account_set_active` on a joined app is local: it only
    picks which account its UI shows.
- **Admin API**. These replace `/api/admin/zalo`, which stays as an alias of `/api/admin/accounts/<active>` for one
  release:
  - `GET /api/admin/accounts` → `{maxAccounts, accounts: [{id, uid, name, avatar, order, enabled, phase}]}`
  - `POST /api/admin/accounts` → `{id}`. It starts a sign-in; poll the detail for the QR.
  - `GET /api/admin/accounts/<id>` → `{id, …, phase, login: {qr, step, …}}`, the same shape as today's
    `/api/admin/zalo`.
  - `POST /api/admin/accounts/<id>/qr` (new QR) · `POST /api/admin/accounts/<id>/logout` · `DELETE
    /api/admin/accounts/<id>` (remove; `default` → logout only).
  - `PATCH /api/admin/accounts/<id>` `{name?, enabled?, order?}`
  - `GET /api/admin/conversations?account=<id>` (required when more than one account is registered).
  - Audit entries for `zalo.*`, `message.send` and other writes carry `account`.

## 8. Automation (MCP tools, add-ons, schedules)

- Every Zalo tool takes an optional `account` (missing → active).
- The feed `compola://automation {kind: 'message', account, message}` covers every running account.
- Add-ons and jobs may be restricted to accounts: `accounts: ["*"] | [ids]`, default `["*"]`.

## 9. Migration (existing installs)

- No `accounts.json` → `{version: 1, active: "default", maxAccounts: 5, accounts: [{id: "default", order: 0, enabled:
  true}]}` is written, and **nothing moves**:
  - `ZaloData/`, `cookies.json` and the media cache stay where they are;
  - the renderer keeps `zalo-app://local` and the labels `zalo-host` / `zalo-worker`.

  A user who is signed in stays signed in, untouched.
- An already present `Accounts/<id>/` without a registry row (an interrupted add) is adopted if its id is valid, else
  ignored.
- Dev builds and the release bundle share `~/Library/Application Support/Compola`. Tests never touch it: registry and
  path code take the root as a parameter.

## 10. Rollout (core milestones)

1. **Registry and paths**: `account.rs` (registry, ids, migration, paths) with tests. Behaviour is unchanged: one
   `default` account.
2. **Per-account plumbing**:
   - `Host` and `MainProcess` know their account (jar, labels, origin, userData, worker router);
   - `net::fetch`, downloads and media take the account;
   - the per-account cookie-isolation test.

   With one account, behaviour is unchanged.
3. **Several engines**: the accounts manager boots N engines; new commands; `account` on commands and events; per-UI
   event scope. Origin isolation is checked in a WKWebView harness (no app launch).
4. **Notifications, badges, calls owner, screen capture.**
5. **Compola Server and automation**: the account dimension, coordinated with the Compola Server session.

The `default` account keeps working, and `cargo test` stays green, after every milestone.
