# Compola UI — Zalo PC style

**Decision (user):** Compola looks and feels like **Zalo PC**, so Vietnamese users switching feel at home. This replaces the
earlier Mobbin "floating panels / Liquid Glass" brief: keep only its interaction patterns (hover toolbar, grouped
context menu, ⌘K palette), and apply Zalo PC's layout, density and colours below.

**Brand:** the app is **Compola** (not Compola). Logo: `src/assets/compola-logo.svg` / `.png`. Never use Zalo's logo,
icon font, illustrations or images (VNG's assets); use lucide icons and the Compola logo. Say "Zalo" only for the
service ("Đăng nhập bằng Zalo", "Mở Zalo trên điện thoại").

**Reference:** the official stylesheets of Zalo PC 26.10.20 are extracted (read-only reference, do NOT commit or copy them)
at `/private/tmp/claude-501/-Users-dean-code-env-compola/5d0a57eb-252a-441b-98e1-d7203feed2db/scratchpad/zalo-css/`.
The main one is `pc-dist__default-login-startup-main-startup.*.css`: grep class names (`.nav__tabs`, `.conv-item`,
`.chat-box-input`, `.message-view`, `.chat-message`, `.card`, `.header`…) and `--` tokens to get exact sizes and colours.
Write our own CSS; don't paste theirs.

## Tokens (from the official CSS)

| Token | Light | Use |
|---|---|---|
| `--primary` | `#0068FF` | buttons, links, active tab underline, unread state |
| `--primary-pressed` | `#005AE0` (`--B60`) | pressed, focus border |
| `--navbar` | `#005AE0` (`--layer-background-navbar-normal`) | left rail background |
| `--navbar-hover` / `--navbar-selected` | `rgba(0,0,0,.15)` / `rgba(0,0,0,.25)` | rail items |
| `--selected` | `#E5F1FF` (`--layer-background-selected`) | selected conversation row, sub-nav selected |
| `--hover` | `#F1F2F4` (`--layer-background-hover`) | row hover |
| `--subtle` | `#EBECF0` (`--layer-background-subtle`) | search field, chips |
| `--bubble-mine` | `#E5F1FF` (`--blue-message`), selected `#C7E0FF` | my messages |
| `--bubble-theirs` | `#FFFFFF` | others' messages |
| `--quote` | `#C7E0FF` (`--blue-quote`) | quote block inside my bubble |
| `--text` | `#081B3A` | primary text |
| `--text-secondary` | `#7589A3` | previews, times, subtitles |
| `--border` | `rgba(0,0,0,.15)` / subtle `rgba(0,0,0,.1)` | column dividers |
| `--danger` | `#C31818` | destructive |
| `--success` | `#37B361` | online dot |
| dark window bg | `#22262B` | read the official dark-theme block for the rest |
Grep the CSS for the chat-area background (`message-view` / `chat-body` / `--layer-background-chat*`) and the unread badge colour.

## Layout

1. **Left rail, 64px, `--navbar` blue.** Account avatar on top (48px, 1px white ring; click → profile/settings
   menu). Below it white icons: Tin nhắn (badge), Danh bạ (badge = friend requests). At the bottom: Cloud của tôi, zCloud,
   Cài đặt. The selected item is 48×48 with a `--navbar-selected` fill and an 8px radius; tooltips on hover.
2. **List column, 344px, white**, 1px border-right.
   - Top: the search field (`--subtle`, 32px high, 8px radius, "Tìm kiếm"), then an icon button **Thêm bạn**
     (user-plus) and one for **Tạo nhóm** (users-plus).
   - Under it, text tabs **Tất cả | Chưa đọc** (active: `--primary` text plus a 2px underline), with **Phân loại ▾** and
     **⋯** on the right.
   - **Conversation row, 72px:** 48px avatar (group avatars are a 2×2 member mosaic, with a group badge); the name is
     15px semibold `--text`, the preview 13px `--text-secondary`, the time 12px top-right.
   - **Row states:** an unread row has a bold name, a darker preview, and a red count badge bottom-right. A muted
     row shows a bell-off icon. Hover is `--hover`, selected is `--selected`.
3. **Chat**
   - **Header, 68px, white:** avatar 48, name 16px semibold, subtitle 13px `--text-secondary` ("Vừa truy cập",
     "12 thành viên"). Right-hand icon buttons: Thêm vào nhóm, Tìm kiếm tin nhắn, Gọi thoại, Gọi video, and
     Thông tin hội thoại (toggles the right panel).
   - **Body:** the Zalo chat background, a light blue-grey (take the exact value from the CSS).
   - **Bubbles:** 8px radius, padding 8×12, a subtle shadow (`0 1px 2px rgba(0,0,0,.08)`), max ~70% width. In groups
     the sender name is shown above the first bubble of a run, 12px `--text-secondary`. The time sits inside the bubble
     at the bottom, 11px `--text-secondary`. The status ("Đã gửi" / "Đã nhận" / "Đã xem") shows under my last message only.
   - Reactions are a small white pill overlapping the bubble's bottom-right edge. The date separator is a centred
     grey pill. A "Tin nhắn mới" divider marks the first unread.
4. **Composer**
   - A **toolbar row**, 46px, of icons left to right: Sticker, Hình ảnh, Đính kèm file, Chụp màn hình,
     Gửi danh thiếp, Nhắc hẹn, Định dạng tin nhắn, ⋯.
   - Below it, the **input area** (white, border-top `--border`). The placeholder is
     "Nhập @, tin nhắn tới <Tên>". On the right, emoji plus **GỬI** (a `--primary` text button) when there is text,
     otherwise a 👍 quick-like.
   - The reply preview is a bar above the input with a blue left border and an ×.
5. **Right panel, 344px, white** (toggled). Header: "Thông tin hội thoại" / "Thông tin nhóm".
   - Under the header: a big avatar, the name (with an edit pencil), then a row of round action buttons with labels
     (Tắt thông báo, Ghim hội thoại, Thêm thành viên / Tạo nhóm, Quản lý nhóm).
   - Then collapsible sections: Thành viên nhóm, Bảng tin nhóm, Ảnh/Video (3-column grid + "Xem tất cả"), File,
     Link, Thiết lập bảo mật (Tin nhắn tự xóa, Ẩn trò chuyện), and red "Xóa lịch sử trò chuyện" / "Rời nhóm".
6. **Danh bạ** (rail): the list column becomes a sub-nav: Danh sách bạn bè, Danh sách nhóm và cộng đồng,
   Lời mời kết bạn, Lời mời vào nhóm. The selected item uses `--selected` with an icon. The main area has a title bar
   with an icon and the title, then the content:
   - **Bạn bè:** count, a search field, a sort control (Tên A–Z / Z–A) and a filter (Tất cả / Phân loại); an
     alphabetical list with letter headers; each row has a ⋯ menu.
   - **Nhóm:** a list with member counts.
   - **Lời mời:** cards for received requests (avatar, name, time + source, message, **Từ chối** / **Đồng ý**) and
     sent ones (**Thu hồi lời mời**).
7. **Thêm bạn dialog** (Zalo PC style, 400px):
   - A country-code select (+84 default) and a phone field. Below them, recent searches / suggestions.
   - Bottom buttons: Hủy and **Tìm kiếm**.
   - The result shows a profile card (cover, avatar, name, bio). Its buttons are **Kết bạn**, **Nhắn tin**, or the
     state: Đã là bạn bè / Đã gửi lời mời (Thu hồi) / Đồng ý (they requested you).
   - **Kết bạn** opens the message step: a prefilled `defaultMessage` with a counter against `maxMessage`, then Gửi.
8. **Login**: a centred white card (~460px) on a very light blue background (`#E8F3FF`).
   - **Card content:** the Compola logo and wordmark on top, then the line "Đăng nhập tài khoản Zalo để kết nối với
     Compola". A single tab, "Với mã QR". The QR sits in a bordered 240px box, captioned "Chỉ dùng để đăng nhập Compola
     trên máy tính", with numbered steps under it.
   - **States:**
     - expired: the QR is blurred, with a "Lấy mã mới" button over it;
     - waiting-confirm: the scanned avatar + name + "Xác nhận đăng nhập trên điện thoại";
     - second-QR: an info callout.
9. **Density:** 14px base font (system UI / "Segoe UI"/Roboto fallback), compact like Zalo PC; no oversized
   whitespace. Use dark-mode tokens from the official dark theme.
