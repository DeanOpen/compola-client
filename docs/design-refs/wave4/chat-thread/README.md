# Wave 4 — Chat thread (Mobbin refs)

Patterns only, applied inside `docs/zalo-pc-style.md` §3–4 (#EBECF0 thread, white / #E5F1FF bubbles, grey date pills).
No branding copied.

| Image | Source | Takeaway |
|---|---|---|
| `x-thread-start.webp` | [X — DM thread](https://mobbin.com/screens/0222a5a1-2b8d-48de-86ca-6abcd998a695) | The top of a DM introduces the person (avatar, name, a line), so the history has a beginning; small centred system notices; reply preview with a thumbnail above the composer. |
| `pinterest-thread-start.webp` | [Pinterest — messages](https://mobbin.com/screens/d0a43aa1-a4fc-4a1c-a7e0-3d6db690829d) | "This could be the beginning of something good": a friendly start-of-thread note under the avatar. |
| `telegram-thread.webp` | [Telegram — chat](https://mobbin.com/screens/7040e40c-d6c7-4653-a304-d3d1e4ef1007) | Floating date pill, compact bubbles with the time inside the bubble. |
| `discord-message-menu.webp` | [Discord — message menu](https://mobbin.com/screens/3bb788dd-b0b0-4d0b-9713-0c2617017466) | Reaction row at the top of the message menu, grouped actions, destructive action last in red (already our menu). |
| `x-message-menu.webp` | [X — message menu](https://mobbin.com/screens/3401242c-8f06-42bd-aab6-2950291378a5) | Hover row of small actions under the bubble that opens the full menu (already our hover bar). |

## Applied

- **Start of the thread**: once the whole history is loaded, the top shows the avatar (64px), the name, members /
  "Cloud của tôi" line, and a pill "Đây là khởi đầu cuộc trò chuyện của bạn với …" (group / self variants).
- **Reply preview**: the reply bar shows a 36px thumbnail of the quoted photo / video / sticker (a file icon for files)
  and names the media ("Hình ảnh", "Video", the file name…) instead of the raw "[Hình ảnh]" text.
- **Media that is gone**: "Ảnh / GIF / Video đã hết hạn" tiles (fixed frame, icon, no Thử lại) — commit 5c73545.
- Already in place and kept: grey sticky date pills per day, the hover bar + menu with the reaction row, photo mosaics,
  file chips, voice bubbles, the "Tin nhắn mới" divider, scroll-to-bottom with the unread count.
