#!/bin/zsh
# Local build of Compola.app (port of the Swift repo's scripts/make-app.sh, the Tauri way):
# ad-hoc signed ("-", bundle.macOS.signingIdentity), hardened runtime, src-tauri/Entitlements.plist,
# Info.plist keys merged from src-tauri/Info.plist, the fingerprint helper sidecar in Contents/MacOS.
#
#   scripts/make-app.sh            # host architecture, .app only
#   scripts/make-app.sh --dmg      # .app + .dmg
#   scripts/make-app.sh --universal [--dmg]
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLES=app
TARGET_ARGS=()
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
for arg in "$@"; do
  case "$arg" in
    --dmg) BUNDLES=app,dmg ;;
    --universal) TRIPLE=universal-apple-darwin; TARGET_ARGS=(--target universal-apple-darwin) ;;
    *) echo "usage: $0 [--dmg] [--universal]" >&2; exit 2 ;;
  esac
done

[[ -d node_modules ]] || npm install
# The sidecar for the bundle's architecture (build.rs only builds per-arch helpers, never the universal one).
scripts/build-fingerprint-helper.sh "$TRIPLE"

npx tauri build --bundles "$BUNDLES" "${TARGET_ARGS[@]}"

OUT=src-tauri/target/${TARGET_ARGS:+universal-apple-darwin/}release/bundle
APP="$OUT/macos/Compola.app"
codesign --verify --deep --strict "$APP"
echo "Bundled $APP"
[[ "$BUNDLES" == *dmg* ]] && ls "$OUT"/dmg/*.dmg
echo "Launch with: open $APP   (quit any running dev instance first: they share the account session)"
