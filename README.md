# Compola

A native-shell Zalo client for macOS (Rust + Tauri 2): the official Zalo PC renderer runs headless in a hidden webview,
Rust plays Electron's preload and main process, and the UI window (React, `src/`) is driven from the renderer's state.
Port of `zalo-swift-re`.

## Requirements

- macOS 11 or later (Apple silicon or Intel)
- Rust (stable), Node.js + npm, Xcode command line tools
- Go, for the fingerprint helper (`fingerprint-helper/`). Without Go the build still works, but Compola falls back to
  reqwest's TLS fingerprint instead of Chromium's.
- On first start Compola downloads the official Zalo PC runtime from VNG and checks its signature. Set
  `COMPOLA_ZALO_APP=/Applications/Zalo.app` to use an installed Zalo instead.

## Develop

```sh
npm install
npx tauri dev
```

`src-tauri/build.rs` builds the fingerprint helper sidecar for the host the first time
(`scripts/build-fingerprint-helper.sh`). Useful environment variables: `COMPOLA_DEBUG=1` (debug log),
`COMPOLA_SHOW_RENDERER=1` (show the hidden renderer windows), `COMPOLA_NO_FINGERPRINT_HELPER=1`.

```sh
cd src-tauri && cargo test
```

## Build the app

```sh
scripts/make-app.sh                 # src-tauri/target/release/bundle/macos/Compola.app
scripts/make-app.sh --dmg           # + bundle/dmg/Compola_<version>_<arch>.dmg
scripts/make-app.sh --universal     # arm64 + x86_64 (src-tauri/target/universal-apple-darwin/…)
```

The script wraps `npx tauri build`. Packaging is configured in:

- `src-tauri/tauri.conf.json` → `bundle.macOS`: bundle id `app.compola.desktop`, minimum macOS 11.0, hardened runtime,
  entitlements, and `signingIdentity: "-"`, which signs local builds ad-hoc. With `null` Tauri leaves the binary only
  linker-signed, without entitlements or a sealed bundle.
- `src-tauri/Entitlements.plist`: JIT, plus microphone and camera for the call helper (`ZaloCall`), which macOS holds
  Compola responsible for.
- `src-tauri/Info.plist`: keys merged into the generated Info.plist (the microphone and camera prompt texts).
- `bundle.externalBin`: the fingerprint helper lands in `Contents/MacOS/compola-fingerprint-helper`.

Only one Compola may run per account session: the dev build and a built app share
`~/Library/Application Support/Compola`. Quit one before opening the other.

Notifications go through `UNUserNotificationCenter` only inside the bundle. `npx tauri dev` runs an unbundled binary,
which falls back to the older notification API.

## Release

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" scripts/release.sh
```

`scripts/release.sh` does the following:

1. Builds universal and signs with the Developer ID (hardened runtime, secure timestamp, sidecar included).
2. Verifies the signature and entitlements.
3. Notarizes and staples the app.
4. Builds, signs, notarizes and staples a drag-to-Applications DMG.
5. Runs the Gatekeeper checks.

Output goes to `src-tauri/target/dist/Compola-<version>.{dmg,zip}`.

Notarization credentials, first match wins:

1. a notarytool keychain profile (`COMPOLA_NOTARY_PROFILE`, default `compola-notary`):
   `xcrun notarytool store-credentials compola-notary --apple-id <apple-id> --team-id <team-id>`
2. `APPLE_ID`, `APPLE_PASSWORD` (app-specific password) and `APPLE_TEAM_ID`
3. `APPLE_API_KEY`, `APPLE_API_ISSUER` and `APPLE_API_KEY_PATH`

`COMPOLA_VERSION=x.y.z` overrides the version in `tauri.conf.json`. `COMPOLA_SKIP_NOTARIZE=1` only signs the build.
