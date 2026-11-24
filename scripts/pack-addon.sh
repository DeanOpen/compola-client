#!/usr/bin/env bash
# Packs an add-on folder (manifest.json at its root) into <id>-<version>.zip for Settings › Add-on › "Cài từ tệp .zip…".
# Usage: scripts/pack-addon.sh <folder> [output-dir]
set -euo pipefail
dir="${1:?usage: scripts/pack-addon.sh <folder> [output-dir]}"
out="${2:-$PWD}"
[ -f "$dir/manifest.json" ] || { echo "no manifest.json in $dir" >&2; exit 1; }
read -r id version < <(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["id"], m.get("version") or "0")' "$dir/manifest.json")
zip_path="$(cd "$out" && pwd)/$id-$version.zip"
rm -f "$zip_path"
(cd "$dir" && zip -qr "$zip_path" . -x '.*' -x '*/.*' -x 'node_modules/*' -x '__MACOSX/*')
echo "$zip_path"
