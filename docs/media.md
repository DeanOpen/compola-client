# Media in the UI: the `compola-media` scheme

The UI window never loads Zalo CDN URLs directly. It asks Rust, which fetches them the way the
official client does: the same headers and cookies, the fingerprint helper when it is running, a
disk cache, and DNS-over-HTTPS when the system resolver fails for `*.zadn.vn`.
Source: `src-tauri/src/media/`.

## URL

```
compola-media://load?url=<encodeURIComponent(originalUrl)>&flavour=image|cors[&retry=1]
```

On Windows and Android (WebView2) the same request is written as
`http://compola-media.localhost/load?url=…`.

```ts
const media = (url: string, flavour: "image" | "cors" = "image", retry = false) =>
  `compola-media://load?url=${encodeURIComponent(url)}&flavour=${flavour}${retry ? "&retry=1" : ""}`;

<img src={media(avatarUrl)} />
<video src={media(videoUrl, "cors")} controls />
```

| param | meaning |
|---|---|
| `url` | Original `https://` URL (`http://` is upgraded to https). A `file://` URL also works when it points inside Compola's own data or cache directories (`…/CompolaTauri/ZaloData`, `…/CompolaTauri/MediaCache`), for example a file the official download path saved. |
| `flavour=image` (default) | Sent as an `<img>` load (`sec-fetch-dest: image`, `no-cors`, image `Accept`). Use it for avatars, photos, stickers and thumbnails. The whole body is held in memory, with a 25 s deadline. Cached in `MediaCache/media` (400 MB, LRU). |
| `flavour=cors` | Sent as a `fetch()` load (`Accept: */*`, `sec-fetch-mode: cors`). Use it for video, voice and file attachments. It downloads to `MediaCache/files` (2 GB, LRU), with no total deadline: it fails only after 30 s with no data. `Range` requests are answered while the download is still running, so a video starts playing before it is fully downloaded. A request without `Range` waits for the whole file. Use this flavour for `<video>` and `<audio>`. |
| `retry=1` | A failed image URL is not fetched again for 20 s. `retry=1` skips that wait; use it for a user's "retry" click. |

Only Zalo hosts are served: `*.zadn.vn`, `*.zdn.vn`, `*.zalo.me`, `*.zaloapp.com`, `*.zingcdn.me`,
`*.zalo.vn`, `*.zing.vn` and `*.z-cdn.me`. Any other host gets `403`.

## Responses

- **Success:** `200` with the body and its `Content-Type`. The type comes from the server; when the
  server gives a generic type, Compola sniffs the bytes instead.
  Every success also carries `Accept-Ranges: bytes` and `Cache-Control: private, max-age=86400`.
- **`Range` requests:** answered with `206` and `Content-Range`, or `416` when the range cannot be
  satisfied. An open-ended range (`bytes=N-`) returns at most 8 MB; media players then request the rest.
  While a `cors` download is still running, an open-ended range returns the bytes already on disk as soon
  as at least one byte at the start offset has arrived. An explicit range (`bytes=A-B`) waits until byte B
  has arrived. If the server sends no `Content-Length`, a range request waits for the whole download.
- **`HEAD`:** returns the same headers with no body.
- **Errors:** `400` means a bad request URL and `403` a host or path that is not allowed. Other errors
  use these statuses:

  | status | meaning |
  |---|---|
  | the CDN's own status (for example `404`) | the CDN answered with an error |
  | `404` | the host no longer exists (NXDOMAIN) |
  | `413` | the file is too large |
  | `502` | a network, DNS or TLS failure |
  | `504` | a timeout |

  Each error response has an `X-Compola-Error` header with the failure class: `http-404`, `dns`,
  `dns-unreachable`, `timeout`, `offline`, `tls`, `size` or `other`.
  Treat an error as "show the placeholder or retry button".

Concurrent requests for the same URL share one download.

## Saving to disk

```ts
await invoke("media_save", { url, destPath }); // → destPath
```

`destPath` must be absolute and its folder must already exist; it is usually a path the user picked
in a save dialog. If the image is already in the image cache, Compola copies it from there. Otherwise it
downloads the file through the `cors` path. Compola writes the file atomically and marks it quarantined,
so macOS checks it like any other download.
