# Deploying Compola Server

**No Mac is needed.** Compola Server runs on Linux: the Zalo engine, the Compola Server API and WebSocket, the admin
console (`/admin`) and the web client (`/web`) all run in one container (`compola-server`). In front of it, the
**gateway** (`compola-gateway`, Caddy) gives it an HTTPS address with automatic certificates. People use it from a
browser (`/web`) or from a Compola desktop app joined to it.

```
 browsers (/web, /admin) · joined Compola apps
            │  https://compola.example.com
            ▼
 ┌───────────────────── gateway (compola-gateway, Caddy) ─────────────────────┐
 │  HTTPS (Let's Encrypt), compression                                          │
 │  /admin/*, /web/*  → served from the image                                   │
 │  /api /ws /media /upload /info → reverse proxy ──────────────┐              │
 └───────────────────────────────────────────────────────────────┼──────────────┘
                                                                 ▼
 ┌───────────────────── server (compola-server, Linux) ─────────────────────────┐
 │  Zalo engine (official Zalo PC renderer, headless) · API · /admin · /web       │
 │  data in /data (Zalo session, messages, users, audit log)                      │
 └────────────────────────────────────────────────────────────────────────────────┘
```

Three ways to run it, from simplest:

| | Command | HTTPS |
|---|---|---|
| [Docker Compose](#docker-compose-server--gateway) (recommended) | `docker compose -f deploy/docker-compose.yml up -d` | built in (gateway) |
| [Kubernetes (Helm)](#kubernetes-helm) | `helm install compola https://github.com/DeanOpen/compola-client/releases/latest/download/compola-helm.tgz …` | ingress |
| [One container](#one-container-no-gateway) | `docker run … compola-server` | bring your own proxy |

## Docker Compose (server + gateway)

```sh
cp deploy/.env.example deploy/.env       # set COMPOLA_ADMIN; for HTTPS also SITE_ADDRESS and COMPOLA_PUBLIC_URL
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

1. On first start the server downloads the official Zalo PC installer for Windows from VNG (the pinned release, checked
   against its SHA-256) and keeps only the renderer in the `compola-data` volume.
2. Open `http://<server>:8080/admin/` (or `https://<your-domain>/admin/`), sign in with `COMPOLA_ADMIN`, then sign in
   to Zalo by scanning the QR code under *Tài khoản Zalo* with the Zalo app on your phone.
3. Add people and grant access. They open `/web/`, or join from a Compola app with the server's address.

| Variable (`deploy/.env`) | Default | Meaning |
|---|---|---|
| `COMPOLA_ADMIN` | — | `user:password` of the first admin, created only while there is none |
| `SITE_ADDRESS` | `:8080` | `:8080` serves plain HTTP on `HTTP_PORT`. A domain (e.g. `compola.example.com`) makes Caddy obtain a Let's Encrypt certificate over port 443; publish `443:443` instead of `HTTP_PORT` (see `docker-compose.yml`) |
| `HTTP_PORT` | `8080` | Host port for plain HTTP |
| `COMPOLA_PUBLIC_URL` | — | How people reach Compola (e.g. `https://compola.example.com`); used for SSO redirects and device sign-in links |
| `COMPOLA_TAG` | `latest` | Tag of both images: a version (`0.1.6`), `latest` (last release) or `edge` (main) |
| `COMPOLA_UPSTREAM` | `http://server:39218` | Only to put the gateway in front of a desktop host instead (see below) |

Only the gateway is published; the server is reachable from the gateway alone. All data lives in the `compola-data`
volume: back it up. To build both images yourself instead of pulling them: `docker compose -f deploy/docker-compose.yml build`.

## Kubernetes (Helm)

The chart runs the server (a StatefulSet with one replica and a persistent volume) and the gateway (a stateless
Deployment) behind your ingress:

Straight from GitHub (no clone needed; the chart is attached to every release):

```sh
helm install compola https://github.com/DeanOpen/compola-client/releases/latest/download/compola-helm.tgz \
  --set server.admin='admin:<password>' \
  --set ingress.enabled=true \
  --set 'ingress.hosts[0].host=compola.example.com' \
  --set 'ingress.tls[0].secretName=compola-tls' \
  --set 'ingress.tls[0].hosts[0]=compola.example.com'
```

From a clone, use `deploy/helm/compola` instead of the URL.

- The server keeps **one replica**: one container holds one Zalo session. Its data is on a 10 Gi volume
  (`server.persistence`); `/dev/shm` is a 1 Gi memory volume for WebKitGTK. `server.existingSecret` takes the first
  admin from a Secret (key `COMPOLA_ADMIN`) instead of `server.admin`.
- `COMPOLA_PUBLIC_URL` is set to `https://<first ingress host>` unless `server.publicUrl` says otherwise.
- The default ingress annotations are for ingress-nginx: a 1-hour timeout for the `/ws` WebSocket and a 200 MB body
  size for uploads. Add `cert-manager.io/cluster-issuer` for automatic certificates.
- Gateway pods run non-root with a read-only root filesystem and all capabilities dropped; probes hit `/healthz`.

All settings are in [`helm/compola/values.yaml`](helm/compola/values.yaml).

## One container (no gateway)

```sh
docker run -d --name compola --restart unless-stopped --shm-size 1g \
  -p 39218:39218 -v compola-data:/data \
  -e COMPOLA_ADMIN=admin:<password> \
  ghcr.io/deanopen/compola-server:latest
```

Then open `http://<server>:39218/admin/`. For HTTPS, put any reverse proxy in front (Caddy, nginx, a cloud load
balancer); WebSockets on `/ws` must be allowed. Compose without the gateway: `deploy/server/docker-compose.yml`.

| Variable | Default | Meaning |
|---|---|---|
| `COMPOLA_ADMIN` | — | `user:password` of the first admin, created only while there is none |
| `COMPOLA_PUBLIC_URL` | — | How people reach the server; used for SSO redirects and device links |
| `COMPOLA_PORT` | `39218` | Port inside the container |

How it works: the container runs Compola in headless mode (`COMPOLA_HEADLESS=1`). The official Zalo renderer runs in a
WebKitGTK webview on a virtual display (Xvfb) that nobody looks at, exactly as it runs hidden inside the desktop app.
Not available on the Linux server: voice/video calls and screen capture (they use Zalo's desktop call helper).

## Gateway in front of a desktop host (optional)

A Compola desktop app (macOS, Windows or Linux) can also be the host: *Settings › Compola Server*, server on, LAN
access allowed. To give it an HTTPS address, run only the gateway and point it at that machine:

```sh
# deploy/.env: COMPOLA_UPSTREAM=http://<desktop-host-address>:39218 (reachable directly or over a VPN)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d gateway

# or Helm
helm install compola https://github.com/DeanOpen/compola-client/releases/latest/download/compola-helm.tgz --set server.enabled=false --set upstream.url=http://<desktop-host-address>:39218
```

Use the gateway version that matches the desktop app's version. In the admin console, set *Cài đặt máy chủ › Địa chỉ
công khai* to the gateway's public URL.

## Images

CI publishes both images for `linux/amd64` and `linux/arm64`, publicly on GHCR:

| Image | Workflow |
|---|---|
| `ghcr.io/deanopen/compola-server` | `.github/workflows/server-image.yml` |
| `ghcr.io/deanopen/compola-gateway` | `.github/workflows/docker.yml` |

| Tag | From |
|---|---|
| `X.Y.Z`, `X.Y`, `latest` | a `vX.Y.Z` release tag |
| `edge` | `main` |
| `sha-<commit>` | every published build |

The gateway keeps the `Host` header and adds `X-Forwarded-Host` / `X-Forwarded-Proto`; the server's Origin check
accepts these, so WebSockets, uploads and cookie sign-in work through it.
