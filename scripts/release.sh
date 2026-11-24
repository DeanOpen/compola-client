#!/bin/zsh
# Distributable Compola: Developer ID signed, hardened runtime, notarized and stapled (port of the Swift repo's
# scripts/release.sh). Produces src-tauri/target/dist/Compola-<version>.dmg (drag-to-Applications) and …/Compola-<version>.zip.
# With TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) set, also the auto-update bundle made from the stapled app:
# …/Compola-<version>.app.tar.gz and its .sig (see .github/workflows/release.yml).
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

if ! grep -qF "$IDENTITY" <<< "$(security find-identity -v -p codesigning)"; then
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
SIG="$(codesign -dvv --entitlements - "$APP" 2>&1)"  # -dvv: the Authority lines only print at this level
grep -q 'flags=.*runtime' <<< "$SIG" || { echo "error: hardened runtime missing" >&2; exit 1; }
grep -q 'allow-jit' <<< "$SIG" || { echo "error: entitlements missing" >&2; exit 1; }
grep -q 'Authority=Developer ID Application' <<< "$SIG" || { echo "error: not Developer ID signed" >&2; exit 1; }
# Captured first: `codesign | grep -q` fails under pipefail (grep exits early, codesign gets SIGPIPE).
HELPER_SIG="$(codesign -dvv "$APP/Contents/MacOS/compola-fingerprint-helper" 2>&1)"
grep -q 'flags=.*runtime' <<< "$HELPER_SIG" || { echo "error: fingerprint helper not signed with the hardened runtime" >&2; exit 1; }
grep -q 'Authority=Developer ID Application' <<< "$HELPER_SIG" || { echo "error: fingerprint helper not Developer ID signed" >&2; exit 1; }

mkdir -p "$DIST"
rm -f "$ZIP" "$DMG"

if [[ -n "${COMPOLA_SKIP_NOTARIZE:-}" ]]; then
  ditto -c -k --keepParent "$APP" "$ZIP"
  echo "Signed (not notarized): $APP -> $ZIP"
  exit 0
fi

# Submits one file and waits for Apple's verdict; fails loudly (with Apple's log) unless the ticket was issued.
# Not `notarytool submit --wait`: that gives up on the first network hiccup while Apple is still working (a new team's
# first submissions can sit "In Progress" for hours), and the run then failed although Apple went on to accept it.
# Polling `notarytool info` instead rides out dropped connections until COMPOLA_NOTARY_TIMEOUT seconds (default 4 h).
notarize() {
  local file="$1" out id="" verdict="" try deadline
  echo "==> Notarizing $file"
  for try in 1 2 3 4 5; do
    out="$(xcrun notarytool submit "$file" "${NOTARY[@]}" --output-format plist 2>&1)" || true
    id="$(plutil -extract id raw -o - - <<< "$out" 2>/dev/null)" || id=""
    [[ -n "$id" ]] && break
    echo "$out" >&2
    echo "    upload failed (attempt $try), retrying in $((try * 30)) s" >&2
    sleep $((try * 30))
  done
  [[ -n "$id" ]] || { echo "error: could not upload $file for notarization" >&2; exit 1; }
  echo "    submission $id"

  deadline=$((SECONDS + ${COMPOLA_NOTARY_TIMEOUT:-14400}))
  while (( SECONDS < deadline )); do
    out="$(xcrun notarytool info "$id" "${NOTARY[@]}" --output-format plist 2>&1)" || true
    verdict="$(plutil -extract status raw -o - - <<< "$out" 2>/dev/null)" || verdict=""
    case "$verdict" in
      Accepted) echo "    status: Accepted"; return 0 ;;
      Invalid|Rejected) break ;;
      "") echo "    status unavailable (network?), still waiting" ;;
      *) echo "    status: $verdict ($(( (deadline - SECONDS) / 60 )) min left)" ;;
    esac
    sleep 30
  done

  for try in 1 2 3; do xcrun notarytool log "$id" "${NOTARY[@]}" >&2 && break; sleep 20; done || true
  echo "error: notarization of $file (submission $id) was not accepted: ${verdict:-timed out}" >&2
  echo "       if Apple accepts it later: xcrun notarytool info $id" >&2
  exit 1
}

# stapler fetches the ticket from Apple too: retry it on a flaky connection.
staple() {
  local try
  for try in 1 2 3 4 5; do
    xcrun stapler staple "$1" && return 0
    echo "    stapling $1 failed (attempt $try), retrying" >&2
    sleep $((try * 20))
  done
  echo "error: could not staple $1" >&2
  exit 1
}

# 1. The app itself, so the stapled ticket travels with it even when copied out of the DMG.
ditto -c -k --keepParent "$APP" "$ZIP"
notarize "$ZIP"
staple "$APP"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"   # re-zip the stapled app

# The auto-update bundle (what `createUpdaterArtifacts` makes: a tar.gz holding Compola.app), from the stapled app.
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  UPDATE="$DIST/Compola-$VERSION.app.tar.gz"
  echo "==> Creating $UPDATE"
  COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$UPDATE" -C "$(dirname "$APP")" "$(basename "$APP")"
  npx tauri signer sign "$UPDATE" >/dev/null
  [[ -s "$UPDATE.sig" ]] || { echo "error: $UPDATE was not signed" >&2; exit 1; }
fi

# 2. A drag-to-Applications DMG, signed, notarized and stapled too.
echo "==> Creating $DMG"
COMPOLA_DMG_NOTARIZED=1 scripts/make-dmg.sh "$APP" "$DMG"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
notarize "$DMG"
staple "$DMG"

echo "==> Gatekeeper assessment"
spctl --assess --type execute -vv "$APP"
spctl --assess --type open --context context:primary-signature -vv "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

echo ""
echo "Release $VERSION ready:"
ls -la "$DIST"
shasum -a 256 "$DMG" "$ZIP"
