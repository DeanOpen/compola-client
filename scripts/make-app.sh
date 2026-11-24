#!/bin/zsh
# Local build of Compola.app (port of the Swift repo's scripts/make-app.sh, the Tauri way):
# ad-hoc signed ("-", bundle.macOS.signingIdentity), hardened runtime, src-tauri/Entitlements.plist,
# Info.plist keys merged from src-tauri/Info.plist, the fingerprint helper sidecar in Contents/MacOS.
#
#   scripts/make-app.sh            # host architecture, .app only
#   scripts/make-app.sh --dmg      # .app + .dmg (scripts/make-dmg.sh: background + drag-to-Applications layout)
#   scripts/make-app.sh --universal [--dmg]
#   scripts/make-app.sh --updater  # also the signed update bundle (Compola.app.tar.gz + .sig); needs
#                                  # TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD), see .github/workflows/release.yml
set -euo pipefail
cd "$(dirname "$0")/.."

DMG=
TARGET_ARGS=()
CONFIG_ARGS=()
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
for arg in "$@"; do
  case "$arg" in
    --dmg) DMG=1 ;;
    --universal) TRIPLE=universal-apple-darwin; TARGET_ARGS=(--target universal-apple-darwin) ;;
    --updater) CONFIG_ARGS=(--config '{"bundle":{"createUpdaterArtifacts":true}}') ;;
    *) echo "usage: $0 [--dmg] [--universal] [--updater]" >&2; exit 2 ;;
  esac
done

[[ -d node_modules ]] || npm install
# The sidecar for the bundle's architecture (build.rs only builds per-arch helpers, never the universal one).
scripts/build-fingerprint-helper.sh "$TRIPLE"

npx tauri build --bundles app "${TARGET_ARGS[@]}" "${CONFIG_ARGS[@]}"

OUT=src-tauri/target/${TARGET_ARGS:+universal-apple-darwin/}release/bundle
APP="$OUT/macos/Compola.app"
codesign --verify --deep --strict "$APP"
echo "Bundled $APP"
[[ -n "$DMG" ]] && scripts/make-dmg.sh "$APP" "$OUT/dmg/Compola.dmg"
echo "Launch with: open $APP   (quit any running dev instance first: they share the account session)"
