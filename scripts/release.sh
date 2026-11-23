#!/bin/zsh
# Distributable Compola: Developer ID signed, hardened runtime, notarized and stapled (port of the Swift repo's
# scripts/release.sh). Produces src-tauri/target/dist/Compola-<version>.dmg (drag-to-Applications) and …/Compola-<version>.zip.
#
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" scripts/release.sh
#   COMPOLA_VERSION=0.2.0 scripts/release.sh            # overrides tauri.conf.json's version
#   COMPOLA_SKIP_NOTARIZE=1 scripts/release.sh          # sign only (local check of the signed bundle)
#
# Notarization credentials, first match wins:
#   1. COMPOLA_NOTARY_PROFILE (default "compola-notary"), a notarytool keychain profile, stored once with
#        xcrun notarytool store-credentials compola-notary --apple-id <apple-id> --team-id <team-id>
#   2. APPLE_ID + APPLE_PASSWORD (app-specific password) + APPLE_TEAM_ID
#   3. APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH (App Store Connect API key)
# These are the Tauri bundler's variable names, but this script hides them from `tauri build` and notarizes
# itself, so the app and the DMG go through the same path (and a keychain profile works too).
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application}"   # codesign matches by substring
VERSION="${COMPOLA_VERSION:-$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')}"
PROFILE="${COMPOLA_NOTARY_PROFILE:-compola-notary}"
TRIPLE=universal-apple-darwin
APP="src-tauri/target/$TRIPLE/release/bundle/macos/Compola.app"
DIST=src-tauri/target/dist   # not ./dist: that is the Vite output (frontendDist)
ZIP="$DIST/Compola-$VERSION.zip"
DMG="$DIST/Compola-$VERSION.dmg"

if ! security find-identity -v -p codesigning | grep -qF "$IDENTITY"; then
  echo "error: no code-signing identity matching '$IDENTITY' in the keychain" >&2
  exit 2
fi
# The exact identity name (Tauri wants the full name or hash, not a substring).
IDENTITY="$(security find-identity -v -p codesigning | grep -F "$IDENTITY" | head -1 | sed -E 's/^[^"]*"(.*)"$/\1/')"

NOTARY=()
if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  NOTARY=(--keychain-profile "$PROFILE")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  NOTARY=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
elif [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  NOTARY=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
elif [[ -z "${COMPOLA_SKIP_NOTARIZE:-}" ]]; then
  echo "error: no notarization credentials (see the header of $0), or set COMPOLA_SKIP_NOTARIZE=1" >&2
  exit 2
fi

echo "==> Building and signing Compola $VERSION ($TRIPLE) as '$IDENTITY'"
[[ -d node_modules ]] || npm install
scripts/build-fingerprint-helper.sh aarch64-apple-darwin x86_64-apple-darwin universal-apple-darwin
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
  APPLE_SIGNING_IDENTITY="$IDENTITY" \
  npx tauri build --target "$TRIPLE" --bundles app --config "{\"version\":\"$VERSION\"}"

codesign --verify --deep --strict --verbose=2 "$APP"
SIG="$(codesign -dv --entitlements - "$APP" 2>&1)"
grep -q 'flags=.*runtime' <<< "$SIG" || { echo "error: hardened runtime missing" >&2; exit 1; }
grep -q 'allow-jit' <<< "$SIG" || { echo "error: entitlements missing" >&2; exit 1; }
grep -q 'Authority=Developer ID Application' <<< "$SIG" || { echo "error: not Developer ID signed" >&2; exit 1; }
codesign -dv "$APP/Contents/MacOS/compola-fingerprint-helper" 2>&1 | grep -q 'flags=.*runtime' \
  || { echo "error: fingerprint helper not signed with the hardened runtime" >&2; exit 1; }

mkdir -p "$DIST"
rm -f "$ZIP" "$DMG"

if [[ -n "${COMPOLA_SKIP_NOTARIZE:-}" ]]; then
  ditto -c -k --keepParent "$APP" "$ZIP"
  echo "Signed (not notarized): $APP -> $ZIP"
  exit 0
fi

# Submits one file and fails loudly (with Apple's log) unless the ticket was issued.
notarize() {
  local file="$1" out id
  echo "==> Notarizing $file"
  out="$(xcrun notarytool submit "$file" "${NOTARY[@]}" --wait 2>&1)" || true
  echo "$out"
  if ! grep -q 'status: Accepted' <<< "$out"; then
    id="$(grep -m1 -E '^\s*id:' <<< "$out" | awk '{print $2}')"
    [[ -n "$id" ]] && xcrun notarytool log "$id" "${NOTARY[@]}" >&2 || true
    echo "error: notarization of $file was not accepted" >&2
    exit 1
  fi
}

# 1. The app itself, so the stapled ticket travels with it even when copied out of the DMG.
ditto -c -k --keepParent "$APP" "$ZIP"
notarize "$ZIP"
xcrun stapler staple "$APP"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"   # re-zip the stapled app

# 2. A drag-to-Applications DMG, signed, notarized and stapled too.
echo "==> Creating $DMG"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Compola" -srcfolder "$STAGE" -ov -quiet -format UDZO "$DMG"
rm -rf "$STAGE"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
notarize "$DMG"
xcrun stapler staple "$DMG"

echo "==> Gatekeeper assessment"
spctl --assess --type execute -vv "$APP"
spctl --assess --type open --context context:primary-signature -vv "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

echo ""
echo "Release $VERSION ready:"
ls -la "$DIST"
shasum -a 256 "$DMG" "$ZIP"
