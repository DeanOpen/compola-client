# Wave 4 — Tạo nhóm (create group)

Live problem: the dialog was a plain list. Target: Zalo PC's two-pane "Tạo nhóm" dialog (docs/zalo-pc-style.md),
with patterns borrowed below. No Zalo/VNG assets here.

| Ref | Takeaway |
|---|---|
| [Discord — Select Friends](https://mobbin.com/screens/a2d59552-c815-4d34-bcaa-3f7ef478990a) (`discord-select-friends.webp`) | Selected people as removable tokens + a live "You can add N more" counter next to the title. → "Đã chọn N/100" header with the remaining count. |
| [Whop — New group chat](https://mobbin.com/screens/59b49a0e-f4a2-4c84-89b8-c6c74cf1077e) (`whop-new-group-chat.webp`) | Group name on top, then the search, then a sectioned list ("Suggested") with a checkbox at the row's trailing edge. → name row first, "Trò chuyện gần đây" section. |
| [Telegram — New Group](https://mobbin.com/screens/ae2edcdc-70c2-46de-b1e7-63f36b130165) (`telegram-new-group.webp`) | A round camera avatar picker beside the name field; members listed with a subtitle. → camera circle left of "Nhập tên nhóm…". |
| [Confluence — Create a team](https://mobbin.com/screens/ee934074-df0a-48d5-8d8a-02463f19f291) (`confluence-create-team.webp`) | Avatar chips with × inside the people field and the limit stated in a hint ("up to 50 people"). → × on every selected row, limit warning inline. |
| [Dialpad — Create a new group](https://mobbin.com/screens/80ed4758-0e79-42b3-a15a-f05837d2fde2) (`dialpad-create-group.webp`) | Footer shows the member count on the left, Cancel + a disabled primary until valid on the right. → footer hint "Chọn ít nhất 2 người", Tạo nhóm enabled at ≥2. |

Also considered: [Basecamp](https://mobbin.com/screens/196b9431-0399-46ab-8d6b-2b4d9c139946), [Whop chips](https://mobbin.com/screens/e2498bcf-1efe-40b5-b1d1-9ecc8a21569f).

Applied in `src/features/contacts/CreateGroupSheet.tsx` + `createGroup.css`.
