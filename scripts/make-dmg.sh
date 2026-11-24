#!/bin/zsh
# Drag-to-Applications DMG with Compola's background and icon layout (scripts/dmg/), built by dmgbuild
# (no Finder scripting, so it looks the same on CI as locally).
#
#   scripts/make-dmg.sh <path/to/Compola.app> <out.dmg> [volume name]
#   COMPOLA_DMG_NOTARIZED=1 scripts/make-dmg.sh …   # background without the first-launch "right-click → Open" hint
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:?usage: $0 <Compola.app> <out.dmg> [volume name]}"
OUT="${2:?usage: $0 <Compola.app> <out.dmg> [volume name]}"
VOLUME="${3:-Compola}"
[[ -d "$APP" ]] || { echo "error: $APP is not an app bundle" >&2; exit 1; }

# dmgbuild in a cached private venv (Homebrew/system Pythons refuse global pip installs).
VENV="${COMPOLA_DMG_VENV:-${TMPDIR:-/tmp}/compola-dmgbuild-venv}"
if [[ ! -x "$VENV/bin/dmgbuild" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check 'dmgbuild==2.0.0'
fi

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
"$VENV/bin/dmgbuild" -s scripts/dmg/settings.py -D assets="$PWD/scripts/dmg" -D notarized="${COMPOLA_DMG_NOTARIZED:-0}" -D app="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")" "$VOLUME" "$OUT"
echo "Built $OUT"
