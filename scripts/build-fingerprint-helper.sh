#!/usr/bin/env bash
# Builds the Go fingerprint helper (fingerprint-helper/) as a Tauri sidecar:
#   src-tauri/binaries/compola-fingerprint-helper-<target-triple>
# (registered as bundle.externalBin in tauri.conf.json; Tauri strips the triple when it copies the
# binary next to the app executable).
#
# Usage: scripts/build-fingerprint-helper.sh [target-triple ...]
#   Without arguments: on macOS aarch64-, x86_64- and universal-apple-darwin; elsewhere the host triple.
#
# Without Go the helper is not built and Compola falls back to reqwest / tokio-tungstenite (Apple/rustls
# fingerprint instead of Chromium 108's) — see reanalysis/wire-fingerprint.md in the Swift repo.
#
# Binaries are written in place by `go build -o` (never `cp` a new build over an existing one: macOS
# kills an overwritten, provenance-tagged binary at exec).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/src-tauri/binaries"
NAME="compola-fingerprint-helper"

command -v go >/dev/null || {
  echo "warning: Go toolchain not found — the fingerprint helper is not built; Compola will use reqwest" >&2
  exit 0
}

host_triple() {
  if command -v rustc >/dev/null; then
    rustc -vV | sed -n 's/^host: //p'
  else
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64) echo aarch64-apple-darwin ;;
      Darwin-x86_64) echo x86_64-apple-darwin ;;
      Linux-x86_64) echo x86_64-unknown-linux-gnu ;;
      Linux-aarch64) echo aarch64-unknown-linux-gnu ;;
      MINGW*-x86_64 | MSYS*-x86_64 | CYGWIN*-x86_64) echo x86_64-pc-windows-msvc ;;
      *) echo "unsupported host $(uname -s)-$(uname -m)" >&2; exit 1 ;;
    esac
  fi
}

if [ "$#" -gt 0 ]; then
  TRIPLES=("$@")
elif [ "$(uname -s)" = Darwin ]; then
  TRIPLES=(aarch64-apple-darwin x86_64-apple-darwin universal-apple-darwin)
else
  TRIPLES=("$(host_triple)")
fi

mkdir -p "$OUT"
cd "$ROOT/fingerprint-helper"
export CGO_ENABLED=0

build_one() { # <triple>
  local triple="$1" goos goarch
  case "$triple" in
    aarch64-apple-darwin) goos=darwin goarch=arm64 ;;
    x86_64-apple-darwin) goos=darwin goarch=amd64 ;;
    aarch64-unknown-linux-*) goos=linux goarch=arm64 ;;
    x86_64-unknown-linux-*) goos=linux goarch=amd64 ;;
    x86_64-pc-windows-*) goos=windows goarch=amd64 ;;
    aarch64-pc-windows-*) goos=windows goarch=arm64 ;;
    *) echo "unsupported target $triple" >&2; exit 1 ;;
  esac
  local dest="$OUT/$NAME-$triple"
  [ "$goos" = windows ] && dest="$dest.exe"
  rm -f "$dest"
  GOOS=$goos GOARCH=$goarch go build -trimpath -ldflags="-s -w" -o "$dest" .
  echo "Built ${dest#"$ROOT"/} ($(du -h "$dest" | cut -f1))"
}

for triple in "${TRIPLES[@]}"; do
  if [ "$triple" = universal-apple-darwin ]; then
    [ -x "$OUT/$NAME-aarch64-apple-darwin" ] || build_one aarch64-apple-darwin
    [ -x "$OUT/$NAME-x86_64-apple-darwin" ] || build_one x86_64-apple-darwin
    dest="$OUT/$NAME-universal-apple-darwin"
    rm -f "$dest"
    lipo -create -output "$dest" "$OUT/$NAME-aarch64-apple-darwin" "$OUT/$NAME-x86_64-apple-darwin"
    echo "Built ${dest#"$ROOT"/} ($(du -h "$dest" | cut -f1))"
  else
    build_one "$triple"
  fi
done
