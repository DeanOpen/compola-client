# Deploying Compola Server

There are two ways to run Compola Server:

1. **Linux server (recommended): everything in one container.** The Zalo engine, the Compola Server API and WebSocket,
   the admin console (`/admin`) and the web client (`/web`) run in one Docker image on one port. No Mac is needed.
   People use it from a browser (`/web`) or from a Compola desktop app joined to it.
2. **A Mac (or Windows PC) running the Compola app**, with the optional **gateway** image in front of it for a public
   HTTPS address. See [Gateway](#gateway-for-a-compola-app-host) below.

## Linux server (one container)

```sh
docker run -d --name compola --restart unless-stopped --shm-size 1g \
  -p 39218:39218 -v compola-data:/data \
  -e COMPOLA_ADMIN=admin:<password> \
  ghcr.io/deanopen/compola-server:edge
```

Or with Compose: `COMPOLA_ADMIN=admin:<password> docker compose -f deploy/server/docker-compose.yml up -d`.
To build the image yourself: `docker build -f deploy/server/Dockerfile -t compola-server .` (from the repository root).

1. On first start the container downloads the official Zalo PC installer for Windows from VNG (the pinned release,
   checked against its SHA-256) and keeps only the renderer (`app.asar`) in the `/data` volume.
2. Open `http://<server>:39218/admin/`, sign in with `COMPOLA_ADMIN`, then sign in to Zalo by scanning the QR code
   under *Tài khoản Zalo* with the Zalo app on your phone.
3. Add people and grant access as usual. They open `http://<server>:39218/web/`, or join from a Compola app.

| Variable | Default | Meaning |
|---|---|---|
| `COMPOLA_ADMIN` | — | `user:password` of the first admin, created only while there is none |
| `COMPOLA_PUBLIC_URL` | — | How people reach the server (e.g. `https://compola.example.com`); used for SSO redirects and device links |
| `COMPOLA_PORT` | `39218` | Port inside the container |

All data (Zalo session, messages database, server users, audit log) lives in `/data`; back up that volume. For HTTPS,
put any reverse proxy in front (Caddy, nginx, a cloud load balancer); WebSockets on `/ws` must be allowed. Not
available on Linux: voice/video calls and screen capture (they use Zalo's macOS helper).

How it works: the container runs Compola in headless mode (`COMPOLA_HEADLESS=1`). The official Zalo renderer runs in
a WebKitGTK webview on a virtual display (Xvfb) that nobody looks at, exactly as it runs hidden inside the desktop app.

## Gateway (for a Compola app host)

The gateway is a small Caddy image that gives a Compola **app** host (a Mac running Compola with Compola Server on) a
public HTTPS address. You do not need it with the Linux server above.

```
 browser / joined Compola apps
            │  https://compola.example.com
            ▼
 ┌─────────────────────────── gateway (this image) ───────────────────────────┐
 │  /admin/*  → admin console, served from the image                           │
 │  /web/*    → web client, served from the image                              │
 │  /api /ws /media /upload /info → reverse proxy ─────────────┐               │
 └─────────────────────────────────────────────────────────────┼───────────────┘
                                                               ▼
                               Mac running Compola, Compola Server on (port 39218)
```

The gateway keeps the `Host` header and adds `X-Forwarded-Host` / `X-Forwarded-Proto`. The host's Origin check accepts
these, so WebSockets, uploads and cookie sign-in all work through it.

### Before you start: the Compola host

1. On the Mac, open Compola › *Settings › Compola Server*, turn the server on and **allow LAN access**. The gateway
   must reach `http://<mac-ip>:39218`, either directly on the LAN or over a VPN such as Tailscale or WireGuard.
2. After the gateway is up, sign in to its admin console. Under *Cài đặt máy chủ › Địa chỉ công khai*, set the
   gateway's public URL (e.g. `https://compola.example.com`). SSO redirects and device sign-in links are built from it.
3. Use the gateway image version that matches the Compola app version on the host (`0.2.0` with app 0.2.0). The admin
   console and web client in the image talk to that host's API.

### Docker (Dockerfile only)

Everything is on one port. Build from the repository root and run:

```sh
docker build -f deploy/gateway/Dockerfile -t compola-gateway .
docker run -d --name compola-gateway --restart unless-stopped -p 8080:8080 \
  -e COMPOLA_UPSTREAM=http://192.168.1.20:39218 compola-gateway
```

Then open `http://<docker-host>:8080/admin/`. The web client (`/web/`), API, WebSocket and `/healthz` use the same
port. On Linux, if the Compola host is the Docker host itself, add `--add-host=host.docker.internal:host-gateway` and
leave `COMPOLA_UPSTREAM` at its default.

HTTPS with your own domain, still a single port (Caddy gets the certificate over 443 with TLS-ALPN):

```sh
docker run -d --name compola-gateway --restart unless-stopped -p 443:443 \
  -e SITE_ADDRESS=compola.example.com -e COMPOLA_UPSTREAM=http://192.168.1.20:39218 \
  -v compola-gateway-data:/data compola-gateway
```

### Docker Compose

```sh
cp deploy/.env.example deploy/.env      # set COMPOLA_UPSTREAM, and SITE_ADDRESS for HTTPS
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

| Variable | Default | Meaning |
|---|---|---|
| `COMPOLA_UPSTREAM` | `http://host.docker.internal:39218` | The Compola host |
| `SITE_ADDRESS` | `:8080` | `:8080` serves plain HTTP. A domain (e.g. `compola.example.com`) makes Caddy obtain a Let's Encrypt certificate over port 443; publish 443 instead of `HTTP_PORT` (see the comment in `docker-compose.yml`) |
| `HTTP_PORT` | `8080` | Host port for plain HTTP |
| `COMPOLA_GATEWAY_TAG` | `latest` | Image tag: a version, `latest` (last release) or `edge` (main) |

To build the image yourself instead of pulling it: `docker compose -f deploy/docker-compose.yml build`.

### Kubernetes (Helm)

```sh
helm install compola deploy/helm/compola-gateway \
  --set upstream.url=http://192.168.1.20:39218 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=compola.example.com \
  --set ingress.tls[0].secretName=compola-tls \
  --set ingress.tls[0].hosts[0]=compola.example.com
```

- `upstream.url` is required. The cluster must be able to reach the Mac.
- The default ingress annotations are for ingress-nginx: a 1-hour timeout for the `/ws` WebSocket and a 200 MB body
  size for uploads. Add `cert-manager.io/cluster-issuer` for automatic certificates.
- Pods run non-root with a read-only root filesystem and all capabilities dropped. Probes hit `/healthz` on the `http` port (8080).
- 2 replicas with a PodDisruptionBudget by default. The gateway is stateless; sessions live on the host.

All settings are in [`helm/compola-gateway/values.yaml`](helm/compola-gateway/values.yaml).

### Images

CI publishes `ghcr.io/deanopen/compola-gateway` for `linux/amd64` and `linux/arm64` (`.github/workflows/docker.yml`):

| Tag | From |
|---|---|
| `X.Y.Z`, `X.Y`, `latest` | a `vX.Y.Z` release tag |
| `edge` | `main` |
| `sha-<commit>` | every published build |

The repository is private, so the package is private too. Log in before pulling
(`echo $TOKEN | docker login ghcr.io -u <user> --password-stdin`, with a token that has `read:packages`). In
Kubernetes, add an `imagePullSecrets` entry.
