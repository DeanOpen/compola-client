# Wave 3 — UI refinements from Mobbin (within the Zalo PC style)

The base stays `docs/zalo-pc-style.md` (blue rail, white list, #EBECF0 chat, Zalo tokens). These are **patterns** to
borrow from best-in-class messengers, judged against the live app (screenshot of 2026-11-23, real account). Do not
copy other products' branding or colours. The priority order is the order below.

| # | Where | Problem in the live app | Pattern (reference) |
|---|---|---|---|
| 1 | Rail | The avatar sits under the macOS traffic lights | Start the rail content ~44px from the top; the strip stays a drag region |
| 2 | Paste / drop | ⌘V shows a plain text Alert with file names | **Send preview sheet**: thumbnail grid (1 large + up to 3 small, "+N"), a caption field, Hủy / Gửi (`telegram-send-photos-preview.webp`, [Telegram](https://mobbin.com/screens/2de06f9c-7f3c-4721-b96e-a965f5e0df83)). Use the same sheet for dropped images when there are >1 or the user holds ⌥. The caption is sent as a text message after the media. |
| 3 | List rows | No quick actions; the context menu is right-click only | On hover, show a **chevron/⋯ at the row's right edge** (replacing the time) that opens the row menu: Ghim, Đánh dấu chưa đọc, Tắt thông báo, Phân loại, Ẩn, Xóa hội thoại (`whatsapp-row-menu.webp`, [WhatsApp](https://mobbin.com/screens/14c85a2d-f032-4cce-bd70-3ab4c460cdfd)). Pinned rows: a small pin glyph next to the time. |
| 4 | Info panel | A huge 3×3 photo grid dominates; settings are buttons only | **WhatsApp contact-info structure** (`whatsapp-contact-info.webp`, [WhatsApp](https://mobbin.com/screens/69c39275-8505-4ab9-aacd-ff9481413e5d)): a header row "Ảnh, file, link · N >" with a **one-row strip of 3 thumbnails** (opens Kho lưu trữ), then **setting rows with toggles** (Tắt thông báo, Ghim hội thoại, Ẩn trò chuyện, Tin nhắn tự xóa), then the red rows at the bottom (Chặn, Báo xấu, Xóa lịch sử trò chuyện / Rời nhóm). Keep Zalo's round quick actions under the avatar. |
| 5 | Group members | — | **Members list with role badges** ("Trưởng nhóm", "Phó nhóm") and online/last-seen subtitles; admins get a hover "Xóa khỏi nhóm" button (`telegram-group-info.webp` [Telegram](https://mobbin.com/screens/b36e89d1-94f1-40e1-a6d6-6965c1bf15a3), `whop-group-members.webp` [Whop](https://mobbin.com/screens/01f3db74-560d-4145-b306-f92b57822d61)). Show 5 rows and "Xem tất cả (N)". |
| 6 | Kho lưu trữ | — | **Filter menu Tất cả / Ảnh-Video / File / Link**, grouped by day, each item with **"Xem trong trò chuyện"** that jumps to the message (`skype-gallery-filter.webp`, [Skype](https://mobbin.com/screens/66569117-a2f6-4658-812b-bf273422d1f0)). A "Thả vào đây để chia sẻ" drop target at the top. |
| 7 | Chat: attachments | File cards are generic | **File chip**: type icon (pdf/doc/xls/zip colour-coded), name (middle-ellipsis), size · type, a ⋯ menu (Mở, Lưu về máy, Chia sẻ, Xem trong thư mục) (`teams-file-card.webp`, [Teams](https://mobbin.com/screens/7a7e1979-91e7-4df8-a1e4-77afe3d04737)). Several photos from one send are shown as a **mosaic grid** (2/3/4 layouts), not stacked singles. **Voice messages**: play button + waveform + duration (`instagram-voice-photos.webp`, [Instagram](https://mobbin.com/screens/a9292a66-ec89-4ca5-859e-2e7acec4757f)). |
| 8 | Strangers | Stranger chats look like normal chats | A **request bar at the bottom** of a stranger's chat: "<Tên> chưa có trong danh bạ của bạn" + Chặn / Kết bạn (`instagram-message-request.webp`, [Instagram](https://mobbin.com/screens/fa37dc74-c6a4-4627-b6ed-ce9fa1b42d21)); wire it to `__zaloContacts.sendRequest`. |
| 9 | Feedback | Actions feel silent | **Undo toasts**, bottom-centre dark pill: "Đã tắt thông báo · Hoàn tác", "Đã ghim", "Đã ẩn trò chuyện" (`substack-mute-toast.webp`, [Substack](https://mobbin.com/screens/82ef8fa0-b22e-443a-81ff-c70f4a5fbeaf)). Plus a **scroll-to-bottom button** (round, bottom-right of the chat) with an unread count. |
| 10 | Composer | "Định dạng" does nothing visible | Toggling it expands a **formatting row above the field** (B, I, U, S, text colour, size, bulleted/numbered list, clear), Zalo's styled-text features (`teams-format-toolbar.webp`, [Teams](https://mobbin.com/screens/be5cd855-09ee-4648-878d-51e87b13e09a)). Only offer what the official composer can send; check `composer-adapter.js` / the official rich-text sender first. |
| 11 | Thêm bạn | The dialog is empty until a search | Below the phone field: **"Có thể bạn quen"** suggestions with an inline Kết bạn button and ✕ to dismiss (`duolingo-friend-suggestions.webp`, [Duolingo](https://mobbin.com/screens/f2beb455-a670-44cb-95fb-f004b5c6b637)), fed by the recommendations the contacts adapter already reads, when available. |

## Acceptance

- Each item gets a headless screenshot (light + dark, 1200×780) in mock mode with realistic mock data (several photos,
  files of several types, a voice message, a stranger chat, a group with roles).
- No regressions: ⌘V/drop, mentions, reactions, the hover toolbar, contacts, polls.
- Small commits, one or two items each, so they can be merged into the live app one by one.
