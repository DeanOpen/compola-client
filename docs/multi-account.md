# Multiple Zalo accounts in one Compola — design & contract

One Compola (the desktop app, or the host of a Compola Server) keeps several Zalo accounts signed in at once, for
example sales accounts 1, 2 and 3. Admins add an account (QR sign-in), sign it out and remove it. Staff get access per
account (Compola Server grants). This document is the contract between the Rust core (`src-tauri/`), the UI (`src/`)
and Compola Server (`src-tauri/src/remote/`, `docs/compola-server.md`).

Status: contract. Implemented in milestones on `feature/multi-account-core`; see "Rollout".

## 1. Account model

### Identity

- **`accountId`**: matches `default` or `a` followed by 8 lowercase hex characters (`a1b2c3d4e`). It is assigned when
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
    { "id": "default", "uid": "123…", "name": "Nguyễn A", "label": "Sales 1", "avatar": "https://…", "order": 0,
      "enabled": true, "addedAt": 1763900000000 },
    { "id": "a1b2c3d4e", "uid": null, "name": null, "label": null, "avatar": null, "order": 1, "enabled": true,
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
  renderer is up. `label` is a local name an admin gave the account (`account_rename`); when set it is shown instead
  of `name`, in the switcher and in notification titles.
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
  - Verified headlessly by `scripts/check-origin-isolation.swift` (WKWebView, non-persistent store, no app launch):
    `zalo-app://a1b2c3d4e` sees neither the localStorage nor the IndexedDB of `zalo-app://local`, and `local` keeps its
    own.
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
- **Media**: `compola-media://load?…&account=<id>`. Each account has its own media loader (its cookie jar) and its own
  cache directory: `MediaCache/` for `default` (unchanged), `Accounts/<id>/MediaCache/` for the others. That isolates
  the cache keys by construction. The account selects the cookie jar. The URL cache and on-disk media
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

- **Grants**: `{…, account: <accountId> | "*", role, scope: {all, conversations, labels}}`. A `"*"` grant requires
  `scope.all` (enforced by the server).
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
  - Audit entries for `zalo.*`, `message.send` and other writes, and the activity log, carry both `accountId` and `uid`.
- **Joined apps**:
  - `accounts_list` and `account_set_active` are answered by `remote.rs` as local commands: the host's accounts the user
    may use (`hello.accounts`), and which of them this UI shows. They never touch the joined app's own
    `accounts.json`.
  - `remote_invoke` fills `args.account` with the joined app's active account when the UI omits it.

### Hooks in the core (what Compola Server calls)

These are implemented in `src-tauri/src/account.rs`. Forwarding is switched off until the server's per-account
mirror and policy are in.

- **Forwarding switch**: `crate::account::set_server_multi_account(true)`. Flip it once (at server start) when the
  policy has the account dimension.
  - **Off (default)**: `remote::forward_event` gets the `default` account's events only, with the old untagged
    payloads, exactly as before multi-account. `remote::forward_notification(app, None, …)` gets `default`'s
    notifications only. `remote/server.rs`'s automation calls use `default`.
  - **On**: every account's `compola://state|phase|page|badge` reaches `forward_event` tagged (`tag_payload`:
    objects gain `account`; `page` → `{account, page}`, `badge` → `{account, count}`). `forward_notification` gets
    `Some(account)`, so its payload carries `account`. The automation calls take `args.account` (missing → active).
  - `crate::account::server_forwarding(account) -> Option<bool>` says which applies.
- **List**: `crate::account::list(app) -> Option<AccountList>`, for `hello.accounts`, `{t: "access"}` and
  `GET /api/admin/accounts`. Shape: `{active, maxAccounts, accounts: [{id, uid, name, label, avatar, order, enabled,
  active, phase, badge}]}`. The server filters it by the user's access.
- **Admin**: `admin_add(app) -> id` (QR page; not made active on the host), `admin_phase(app, id)` (the detail's
  `phase` with `login.qr`), `admin_refresh_qr`, `admin_logout`, `admin_remove` (`default`: sign-out only),
  `admin_set_enabled`, `admin_rename`, `admin_reorder`. Errors are Vietnamese text for the API's `{error}`.
- **Engines for invokes**: `crate::account::engine(app, Some(id))` (the engine of `args.account`).
  `crate::account::accounts(app).registry().resolve(Some(id))` validates an id.

## 8. Automation (MCP tools, add-ons, schedules)

- Every Zalo tool takes an optional `account` (missing → active).
- The message index and the automation mirror exist **per account** (conversation ids are only unique within an
  account). `default` keeps `search.db` at the root; each other account has `Accounts/<id>/search.db`. Like the media
  cache, this isolates the accounts by construction, with no schema change.
- `automation_search`, `automation_search_status`, `automation_conversations`, `automation_messages` and
  `automation_send_text` take an optional `account` (missing → active). `automation_search_clear` without `account`
  clears every account's index.
- MCP tools: `status`, `list_conversations`, `get_messages`, `search_messages`, `send_message` and `create_schedule`
  take an optional `account`; `status` lists the accounts.
- Send-text jobs store their account. Jobs from before multi-account have none and run on `default`.
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

## 11. Operations

### Capacity

- **Cap**: `maxAccounts` in `accounts.json`, default **5**. `account_add` refuses at the cap. To raise it, edit the
  file while Compola is not running. The value is not validated beyond `> 0`, so size it against memory (below).
- **Memory per account**: two hidden WKWebViews, the main renderer and the shared worker. Each runs in its own
  WebContent process.
  - Expect roughly **250–400 MB** per signed-in account once its message database is warm. It grows with large
    groups, many open chats and media previews.
  - Compola's own process adds little per account: the cookie jar, the mirror, the media loader state and the search
    index connection.
  - Measure in Activity Monitor: each account adds two "Compola Web Content" processes.
- **Disabled accounts** (`account_set_enabled(false)`) cost no renderer memory: their hosts are stopped. They keep
  their data and session, and receive nothing (no messages, no notifications) until enabled again.
- **CPU and network**: every enabled account keeps its renderer's WebSocket and its shared-worker sync running.
  Background throttling is off for all of them on purpose (§3).
- **Disk per account**: `ZaloData/` (IndexedDB / SQLite message store), `MediaCache/` and `search.db`, all under
  the account's data root.
  - The media cache is trimmed per account.
  - Removing an account deletes its whole `Accounts/<id>/` folder, about 2 s after its renderers stop.
- **Startup**: the first enabled account locates or installs the runtime, then the others boot 2 s apart. N accounts
  are all running about 2·N s after the first one.

### Failure isolation

- **A renderer crash stays inside its account.** WebKit runs every webview in its own WebContent process. When one
  dies (WebKit crash, memory-pressure kill, manual kill), macOS reports it through
  `webViewWebContentProcessDidTerminate`. Compola hooks that with Tauri's `on_web_content_process_terminate`:
  - A hidden renderer is reloaded **by its own account's engine only**: `Engine::renderer_terminated`. The main page
    loads again on `index.html` (signed in) or `login.html`; a dead shared worker is recreated. Other accounts keep
    running untouched.
  - Repeated crashes back off: 1 s, 2 s, 4 s … at most 60 s between restarts, counted over the last 10 minutes.
  - The account's log (`compola://log`) shows `renderer process terminated (<label>) — reloading`.
  - The UI window reloading after its own process crash rebuilds from `engine_replay`.
- **Things every account shares**, and what happens when one of them fails:
  - **Fingerprint helper**: one process. If it dies, requests fall back to reqwest until it restarts, for every
    account.
  - **ZaloCall**: one process, owned by one account (§4). When it exits, the owner's renderer gets
    `callState: free`; other accounts are not affected.
  - **The Compola process itself**: release builds use `panic = "abort"`, so a Rust panic anywhere ends every
    account. Panics in a spawned task only end that task; panics on the main thread or in a hook end the app.
    Handlers return errors rather than panic, and the registry and paths code is covered by tests.
- **Signed out by Zalo**: another PC took the session, or the account was logged out on the phone. This affects only
  that account: its phase goes to `login` with a notice. The others stay signed in.
- **Corrupt `accounts.json`**: kept as `accounts.json.bad`; the registry is rebuilt from `default` and the valid
  `Accounts/<id>/` folders (§1). Sessions survive, because cookies and data live in the account folders. Labels,
  order and the cap revert to defaults.

### Diagnostics

- `accounts_list` shows every account's `phase` and `badge`. `engine_info({account})` shows its runtime version,
  storage backend and recent renderer log.
- `engine_show_renderer({account})` shows that account's hidden renderer in development builds. Its webview labels
  are `zalo-host[-<id>]` / `zalo-worker[-<id>]`.
- `scripts/check-origin-isolation.swift` re-checks the WebKit storage isolation (§2) on a new macOS version.
