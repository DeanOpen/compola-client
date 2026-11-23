# Compola

**A native macOS client for Zalo, built for teams.** Compola runs the official Zalo PC engine headless and puts a
fast, keyboard-friendly UI on top. It also ships **Compola Server**: one Compola shares its Zalo account with your
staff, each with their own sign-in, role and conversation scope, managed from a web admin console.

Rust + Tauri 2 · React 19 · macOS 11+ (Apple silicon and Intel) · port of `zalo-swift-re`

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Compola Server](#compola-server)
- [Testing](#testing)
- [Building the app](#building-the-app)
- [Releasing](#releasing)
- [Configuration reference](#configuration-reference)
- [Documentation](#documentation)
- [Data, privacy and third-party code](#data-privacy-and-third-party-code)

## Features

**Messaging client**
- Zalo PC look and feel: conversations, chat, reactions, replies, pins, polls, reminders, stickers, cloud (My
  Documents), shared media, contacts, group creation and group members.
- QR sign-in, native notifications, voice/video calls through Zalo's call helper, file transfer and downloads.
- ⌘K quick switcher, a command palette and hover actions on messages.
- **Multiple Zalo accounts** in one app, with an account switcher on the rail (`docs/multi-account.md`).

**Compola Server (sharing one account with a team)**
- Per-person sign-in: local passwords (argon2id), **LDAP / Active Directory** and **SSO** (OpenID Connect, OAuth 2).
- Role-based access: *viewer* (read only) or *agent* (read and act), scoped to all conversations or to chosen
  conversations and Zalo labels, granted to people or groups.
- Device sign-in for joined apps, session management and remote sign-out.
- Audit log plus per-person activity tracking and statistics, all with CSV export.
- An **admin console** at `/admin` (users and groups, permissions, sign-in providers, devices, audit log, activity,
  statistics, the Zalo account and server settings), with light and dark themes. Staff can also use a web client at
  `/web`.

**Automation**
- An MCP server so AI apps can read and act on Compola, scheduled jobs (cron) and add-ons (`docs/automation.md`).

## How it works

```
┌──────────────────────────── Compola.app ────────────────────────────┐
│                                                                     │
│  UI window (React, src/)          Rust core (src-tauri/)            │
│  ─ chat, settings, admin   ◀────▶ ─ preload + main-process stand-in │
│                            Tauri  ─ net proxy, cookies, media cache │
│                                   ─ notifications, calls, sqlite    │
│                                   ─ Compola Server (remote/)        │
│                                        ▲                            │
│  Hidden renderer webview ──────────────┘                            │
│  (official Zalo PC renderer, downloaded from VNG on first start)    │
└─────────────────────────────────────────────────────────────────────┘
         ▲ HTTP / WebSocket (Compola Server)
         │
  Joined Compola apps · admin console (/admin) · web client (/web)
```

- The **official Zalo PC renderer** runs in a hidden webview. Rust plays the parts Electron's preload and main process
  play in the real app (`bridge-table.json` maps each bridge member to its IPC channel).
- The **UI window** never talks to Zalo directly. It reads the renderer's state through Rust and loads media through
  the `compola-media` scheme, which fetches with the official client's headers, cookies and TLS fingerprint
  (`docs/media.md`).
- The **fingerprint helper** (`fingerprint-helper/`, Go) is a sidecar that gives outgoing requests Chromium's TLS
  fingerprint.
- **Compola Server** is part of the same app. A *host* Compola serves its account over HTTP/WebSocket, and *joined*
  apps sign in to it instead of running their own engine.

## Repository layout

| Path | What |
|---|---|
| `src/` | UI (React + Vite): `shell/` (window, rail), `features/` (chat, conversations, settings, accounts, remote …), `engine/` (state and backend calls; `mock/` for browser-only development), `ui/` (shared components), `styles/` |
| `src-tauri/src/` | Rust core: `engine.rs`, `main_process.rs`, `bridge/`, `host/`, `net/`, `media/`, `notifications/`, `calls/`, `downloads.rs`, `installer.rs` (Zalo runtime download and verification), `account.rs` (multi-account), `automation/`, `remote/` (Compola Server) |
| `admin/` | Compola Server admin console (React + Vite), built into `src-tauri/admin-dist/` and embedded in the app |
| `fingerprint-helper/` | Go TLS-fingerprint sidecar |
| `scripts/` | `make-app.sh`, `release.sh`, `build-fingerprint-helper.sh` |
| `docs/` | Design documents and UI references (see [Documentation](#documentation)) |

## Getting started

### Requirements

- macOS 11 or later
- Rust (stable), Node.js + npm, Xcode command line tools
- Go, for the fingerprint helper. Without Go the build still works, but requests fall back to reqwest's TLS
  fingerprint instead of Chromium's.

### Run in development

```sh
npm install
npx tauri dev
```

On first start Compola downloads the official Zalo PC runtime from VNG and checks its signature. To use an installed
Zalo instead, set `COMPOLA_ZALO_APP=/Applications/Zalo.app`.

`src-tauri/build.rs` builds the fingerprint helper for your machine the first time
(`scripts/build-fingerprint-helper.sh`).

> Only one Compola may run per data folder: the dev build and an installed app share
> `~/Library/Application Support/Compola`. Quit one before opening the other, or give the dev build its own folder
> with `COMPOLA_DATA_DIR`.

### UI only, in a browser (mock data)

No Rust, no Zalo account:

```sh
npm run dev                    # http://localhost:1420/?mock=1
npm run dev:admin              # http://localhost:1430/admin/?mock=1  (sign in as admin, lan or minh)
```

The UI falls back to its mock backend whenever it isn't running inside Tauri.

## Compola Server

1. **Host:** in the Compola that is signed in to Zalo, open *Settings › Compola Server*, turn the server on, and
   choose the port and whether the LAN may connect. Open the admin console (`http://<host>:<port>/admin/`) and set the
   server's public address in *Cài đặt máy chủ*.
2. **People:** add users (or connect LDAP / SSO under *Đăng nhập*), then grant access under *Phân quyền*: a role plus
   a scope of conversations or labels, for a person or a group.
3. **Joined apps:** in another Compola, open the *Compola Server* tab on the sign-in screen, enter the address and
   sign in. With SSO, the app shows
   a code that the person approves in the browser.

Everything a joined person does goes through the host's policy (`src-tauri/src/remote/policy.rs`) and is audited.
The full design and HTTP contract is in `docs/compola-server.md`.

To develop the server without touching your real session, run a second instance with its own data folder:

```sh
COMPOLA_DATA_DIR=/tmp/compola-host \
COMPOLA_ZALO_APP="$HOME/Library/Application Support/Compola/ZaloRuntime/current" \
COMPOLA_SERVER_ADMIN=admin:changeme \
npx tauri dev
```

`COMPOLA_SERVER_ADMIN` (debug builds only) creates that admin user on start. Build the console before Cargo, or
`/admin` will be empty: `npm run build:admin`.

## Testing

```sh
npx tsc --noEmit               # UI type check
npm run build && npm run build:admin
cd src-tauri && cargo test --lib
```

Some installer tests are ignored by default. They need the official Zalo DMG on disk:
`COMPOLA_ZALO_DMG=/path/to/ZaloSetup.dmg cargo test -- --ignored`.

## Building the app

```sh
scripts/make-app.sh                 # src-tauri/target/release/bundle/macos/Compola.app
scripts/make-app.sh --dmg           # + bundle/dmg/Compola_<version>_<arch>.dmg
scripts/make-app.sh --universal     # arm64 + x86_64 (src-tauri/target/universal-apple-darwin/…)
```

The script wraps `npx tauri build`, which builds the UI and the admin console first. Packaging is configured in:

- `src-tauri/tauri.conf.json` → `bundle.macOS`:
  - bundle id `app.compola.desktop`, minimum macOS 11.0;
  - hardened runtime and entitlements;
  - `signingIdentity: "-"`, which signs local builds ad hoc. With `null` Tauri leaves the binary only linker-signed,
    without entitlements or a sealed bundle.
- `src-tauri/Entitlements.plist`: JIT, plus microphone and camera for the call helper (`ZaloCall`), which macOS holds
  Compola responsible for.
- `src-tauri/Info.plist`: keys merged into the generated Info.plist (the microphone and camera prompt texts).
- `bundle.externalBin`: the fingerprint helper, at `Contents/MacOS/compola-fingerprint-helper`.

Notifications go through `UNUserNotificationCenter` only inside the bundle. `npx tauri dev` runs an unbundled binary,
which falls back to the older notification API.

## Releasing

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" scripts/release.sh
```

`scripts/release.sh` does the following:

1. Builds a universal app and signs it with the Developer ID (hardened runtime, secure timestamp, sidecar included).
2. Verifies the signature and entitlements.
3. Notarizes and staples the app.
4. Builds, signs, notarizes and staples a drag-to-Applications DMG.
5. Runs the Gatekeeper checks.

Output goes to `src-tauri/target/dist/Compola-<version>.{dmg,zip}`.

Notarization credentials, first match wins:

1. A notarytool keychain profile (`COMPOLA_NOTARY_PROFILE`, default `compola-notary`):
   `xcrun notarytool store-credentials compola-notary --apple-id <apple-id> --team-id <team-id>`
2. `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`
3. `APPLE_API_KEY`, `APPLE_API_ISSUER` and `APPLE_API_KEY_PATH`

`COMPOLA_VERSION=x.y.z` overrides the version in `tauri.conf.json`. `COMPOLA_SKIP_NOTARIZE=1` only signs the build.

## Configuration reference

| Variable | Effect |
|---|---|
| `COMPOLA_ZALO_APP` | Use this Zalo.app (or an unpacked runtime) instead of downloading one |
| `COMPOLA_DATA_DIR` | Data folder instead of `~/Library/Application Support/Compola` (run instances side by side) |
| `COMPOLA_DEBUG=1` | Debug log; `COMPOLA_DEBUG_RESPONSES=1` also logs response bodies |
| `COMPOLA_SHOW_RENDERER=1` | Show the hidden Zalo renderer windows |
| `COMPOLA_NO_FINGERPRINT_HELPER=1` | Don't start the TLS-fingerprint sidecar |
| `COMPOLA_NO_SHARED_WORKER=1`, `COMPOLA_TRACE_WORKERS=1` | Disable / trace the renderer's shared worker |
| `COMPOLA_STORAGE` | Force the renderer's storage backend |
| `COMPOLA_QR_OUT=<file.png>` | Also write the sign-in QR to a file (sign in without the UI) |
| `COMPOLA_SERVER_ADMIN=user:pass` | Debug builds: create this Compola Server admin on start |
| `COMPOLA_VERSION`, `COMPOLA_NOTARY_PROFILE`, `COMPOLA_SKIP_NOTARIZE` | Release script, see above |

## Documentation

| Document | Covers |
|---|---|
| `docs/compola-server.md` | Compola Server: concepts, HTTP API, policy, activity tracking, web client |
| `docs/multi-account.md` | Several Zalo accounts in one Compola: account model, isolation, UI and server hooks |
| `docs/media.md` | The `compola-media` scheme: how the UI loads Zalo media |
| `docs/automation.md` | MCP server, scheduled jobs and add-ons |
| `docs/zalo-pc-style.md` | UI style decisions (Zalo PC look) |
| `docs/design-refs/` | Mobbin references behind each screen, including the admin console |

## Data, privacy and third-party code

- Compola keeps everything on your Mac, in `~/Library/Application Support/Compola`: the Zalo runtime, session
  cookies, caches, the multi-account registry (`accounts.json`) and, for a host, the Compola Server database. None of
  this is in the repository.
- The **Zalo PC runtime is VNG's software.** Compola downloads it from VNG on first start and verifies its signature;
  it is never bundled or committed here. Do not commit files extracted from it.
- This is a private project with no license file; all rights reserved unless stated otherwise.
