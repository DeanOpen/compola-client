# Compola gateway: a public HTTPS front for a Compola Server host.
# Serves the admin console (/admin) and the web client (/web) from this image, and reverse-proxies everything else
# (/api, /ws, /media, /upload, /info) to the Mac that runs Compola (COMPOLA_UPSTREAM).
#
# Build and run with Docker alone (no Compose), one port for everything:
#   docker build -f deploy/gateway/Dockerfile -t compola-gateway .          # from the repository root
#   docker run -d --name compola-gateway --restart unless-stopped -p 8080:8080 \
#     -e COMPOLA_UPSTREAM=http://192.168.1.20:39218 compola-gateway
#   → http://<docker-host>:8080/admin/   (/web/, /api, /ws, /healthz on the same port)
# HTTPS with your own domain, still one port:
#   docker run -d ... -p 443:443 -e SITE_ADDRESS=compola.example.com -v compola-gateway-data:/data compola-gateway

FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:admin && npm run build:web

FROM caddy:2.10-alpine
LABEL org.opencontainers.image.title="compola-gateway" \
      org.opencontainers.image.description="HTTPS gateway for Compola Server: admin console + web client, API proxied to the Compola host"
# Drop the binary's cap_net_bind_service file capability: with it, exec fails under no-new-privileges (Kubernetes
# allowPrivilegeEscalation: false). Ports 80/443 still work when the container runs as root (Docker Compose default).
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap
COPY deploy/gateway/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/src-tauri/admin-dist /srv/admin
COPY --from=build /src/src-tauri/web-dist /srv/web
# SITE_ADDRESS: ":8080" (plain HTTP, behind a load balancer / ingress) or a domain such as "compola.example.com"
# (Caddy gets a Let's Encrypt certificate itself; publish ports 80 and 443).
ENV SITE_ADDRESS=":8080" \
    COMPOLA_UPSTREAM="http://host.docker.internal:39218" \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/config
# 8080 = plain HTTP (default). With SITE_ADDRESS set to a domain, publish 443 instead.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1
