# Design references (Mobbin)

Pulled from Mobbin to raise the bar on the React UI. Use these as **patterns**, not skins: Compola keeps the Zalo blue
`#0068FF` and the macOS "Liquid Glass" feel of the Swift app (translucent sidebar, floating panels). Do not copy any
other product's branding, illustrations or colours.

| File | App | What to take from it |
|---|---|---|
| `telegram-chat.webp` | [Telegram Web](https://mobbin.com/screens/65ec4464-e604-44bb-8986-f62f7b4f3ae4) | **Floating rounded panels**: list column and chat header/composer as separate rounded cards over the window background; compact header (avatar + name + "last seen"); pill composer with attach left, emoji + round send right; centred date pill ("Today"); read ticks + time inside the bubble corner. |
| `discord-chat-inspector.webp` | [Discord](https://mobbin.com/screens/89cc8383-a4f3-4189-84fa-359dafe0ad28) | Three-column layout with a **collapsible inspector** on the right (big avatar, name, quick facts); system rows (missed call, forwarded) rendered as muted one-liners with an icon, not bubbles. |
| `telegram-qr-login.webp` | [Telegram Web](https://mobbin.com/screens/8b6bb588-c12b-4915-b0c8-a39292edfd24) | **QR login card**: one centred card, QR with the app logo in the middle, title, subtitle, then **numbered steps** (1 Open Zalo on your phone, 2 tap the QR icon next to search, 3 scan and confirm). |
| `whatsapp-qr-login.webp` | [WhatsApp Web](https://mobbin.com/screens/eb733a82-584e-43a4-8e59-9f8b620f17b0) | Steps left / QR right on a wide card; footnote line ("messages stay on your phone…"). Good for the Compola login at window width ≥ 900px. |
| `discord-message-menu.webp` | [Discord](https://mobbin.com/screens/3bb788dd-b0b0-4d0b-9713-0c2617017466) | **Message context menu**: quick-reaction row on top, then grouped actions with right-aligned icons, destructive action (Thu hồi / Xóa) last in red, separators between groups. |
| `expensify-hover-reactions.webp` | [Expensify](https://mobbin.com/screens/359fe258-1e6a-4eba-a3ff-aa74b5eaa2b0) | **Hover toolbar** at the bubble's top-right edge: 3–4 quick reactions + reply + more, with tooltips; whole row gets a subtle highlight on hover. |
| `quo-reaction-bar-inspector.webp` | [Quo](https://mobbin.com/screens/9fbe01c1-4a84-4e43-aa9e-ac40a155fa1c) | Compact reaction bar floating above a bubble; timestamp tooltip on hover; inspector with round quick-action buttons under the avatar (Gọi, Nhắn tin, Tìm kiếm, …). |
| `quo-command-palette.webp` | [Quo](https://mobbin.com/screens/dfea71ab-f939-48cd-a568-c4330ae52c31) | **⌘K quick switcher**: centred palette, search field on top, grouped sections ("Hội thoại", "Hành động"), icon + label rows, keyboard-highlighted row. |
| `intercom-action-palette.webp` | [Intercom](https://mobbin.com/screens/c56996fd-659b-44dd-9206-717c08c3aa97) | Footer hint row in the palette: `↑↓ di chuyển · ↵ chọn · Esc đóng`. |

## Concrete rules for Compola

- **Layout**: rail (icons, 64px) · conversation list (300–340px, resizable) · chat · optional inspector (300px, toggled from the chat header). Panels have 12px radius, 8px gaps, sit on a translucent window background (`backdrop-filter: blur(30px) saturate(180%)`).
- **Conversation row**: 48px avatar, name (semibold, 1 line) + time on the right, preview (1 line, muted) + unread badge (Zalo blue pill, white digits) or pin icon. The selected row is filled with Zalo blue tinted at 12% (not solid blue), and hover is a 6% tint.
- **Bubbles**: mine are Zalo blue tonal `#E5F1FF` with dark text in light mode (as the official client does) and a solid `#0068FF` variant in dark mode. Theirs are neutral surface. 18px radius with a smaller corner on the sender side for runs. Time + status inside the bottom-right. Group consecutive messages from the same sender within 5 minutes (avatar only on the last one).
- **Date separator**: centred pill, muted, sticky while scrolling.
- **Hover toolbar + context menu**: as in the references. The menu's actions map to `__zaloMsgActions`/`__zaloChat.performAction` (Trả lời, Chia sẻ, Sao chép, Ghim, Đánh dấu sao, Thu hồi, Xóa chỉ ở phía tôi).
- **Composer**: pill field that grows to 8 lines, `+` menu on the left (Ảnh/Video, Tệp, Chụp màn hình, Danh thiếp, Nhắc hẹn), emoji/sticker + send on the right. The send button is disabled when the field is empty. The reply preview is a card above the field with an ×.
- **Login**: a Telegram-style card with the QR at 240px and the Compola logo overlaid, numbered steps, and the second-QR hint as an info callout. On expiry, blur the QR and put a "Lấy mã mới" button over it. On waiting-confirm, replace the QR with the scanned avatar + name + "Xác nhận đăng nhập trên điện thoại".
- **Motion**: 150ms ease-out for hover/menus and a spring-ish 220ms for sheets. Respect `prefers-reduced-motion`.
- **Empty states**: centred illustration-free icon + one line + optional action (no stock art).
