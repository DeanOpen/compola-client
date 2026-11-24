# Compola Server for Linux: the whole server in one container — Zalo engine (the official Zalo PC renderer running in
# a WebKitGTK webview on a virtual display), Compola Server API + WebSocket, the admin console (/admin) and the web
# client (/web), all on one port. People use it from a browser (/web) or a Compola desktop app joined to it.
#
# Build from the repository root:
#   docker build -f deploy/server/Dockerfile -t compola-server .
# Run:
#   docker run -d --name compola --restart unless-stopped --shm-size 1g -p 39218:39218 -v compola-data:/data \
#     -e COMPOLA_ADMIN=admin:<password> compola-server
#   → http://<server>:39218/admin/  (sign in, then sign in to Zalo with the QR code under "Tài khoản Zalo")

# ---- build ----
FROM rust:1-bookworm AS build
COPY --from=golang:1.27-bookworm /usr/local/go /usr/local/go
COPY --from=node:24-bookworm /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-bookworm /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ENV PATH="/usr/local/go/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libsecret-1-dev \
      patchelf file \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/src/src-tauri/target,id=compola-server-target \
    npm run build && npm run build:admin && npm run build:web \
 && scripts/build-fingerprint-helper.sh \
 && cd src-tauri && cargo build --release --locked \
 && mkdir -p /out \
 && cp target/release/compola /out/compola \
 && cp binaries/compola-fingerprint-helper-$(rustc -vV | sed -n 's/^host: //p') /out/compola-fingerprint-helper

# ---- runtime ----
FROM debian:bookworm-slim
LABEL org.opencontainers.image.title="compola-server" \
      org.opencontainers.image.description="Compola Server: Zalo engine, API, admin console and web client in one container"
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2 libsecret-1-0 \
      xvfb xauth dbus-x11 wget ca-certificates fonts-noto-core fonts-noto-color-emoji p7zip-full tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/compola /usr/local/bin/compola
COPY --from=build /out/compola-fingerprint-helper /usr/local/bin/compola-fingerprint-helper
COPY deploy/server/entrypoint.sh /usr/local/bin/compola-entrypoint
ENV COMPOLA_DATA_DIR=/data \
    COMPOLA_HEADLESS=1 \
    COMPOLA_PORT=39218 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1
VOLUME /data
EXPOSE 39218
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s CMD wget -qO- "http://127.0.0.1:${COMPOLA_PORT}/info" >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/compola-entrypoint"]
