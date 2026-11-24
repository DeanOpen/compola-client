#!/bin/sh
# Compola Server container entrypoint: a virtual display for the WebKitGTK webviews (nobody looks at it), a session
# D-Bus for GTK, then Compola in headless server mode (COMPOLA_HEADLESS=1).
set -e
mkdir -p "$COMPOLA_DATA_DIR"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
exec dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24 -nolisten tcp" /usr/local/bin/compola "$@"
