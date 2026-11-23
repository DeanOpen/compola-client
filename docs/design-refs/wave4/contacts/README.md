# Wave 4 — Danh bạ: friends, groups, invitations (Mobbin refs)

Patterns only, applied inside `docs/zalo-pc-style.md` §6 (sub-nav + page panels, #0068FF, compact). No branding copied.

| Image | Source | Takeaway |
|---|---|---|
| `discord-friends-list.webp` | [Discord — Friends](https://mobbin.com/screens/e001c6d2-6dd4-41c9-bc93-ed814b7a1eff) | "Online / All" tabs with counts over the list; rows show a status line and reveal a message button + ⋯ on hover. |
| `telegram-contacts-last-seen.webp` | [Telegram — Contacts](https://mobbin.com/screens/a90e7b59-3143-45fc-bb7c-dfccce452e62) | Every contact row carries a presence / "last seen" subtitle. |
| `teams-community-invite.webp` | [Microsoft Teams — Pending community invite](https://mobbin.com/screens/c152a4d9-5fa0-4d54-8d2a-4824c008976a) | Invite card: group avatar + name + member count, "Invited by" with the inviter's avatar, equal Decline / Accept buttons (Accept filled). |
| `dub-invitation-card.webp` | [Dub — Invitations](https://mobbin.com/screens/acda4b70-c912-41a1-b3c1-d68b4337a4ad) | A small status chip on the card ("Invited …") instead of plain text. |
| `lovable-invite-inbox.webp` | [Lovable — Invites inbox](https://mobbin.com/screens/62e25c34-01f5-452e-ac45-254a7c726a86) | A "new" dot on fresh invitations, relative time next to the sender. |

## Applied

- Sub-nav: icons in rounded tiles (the selected one turns blue), muted counts for friends / groups, red badges for requests.
- Friends: "Tất cả N · Đang hoạt động N" underline tabs; status subtitles ("Đang hoạt động" / "Truy cập …"); a hover "Nhắn
  tin" quick action next to ⋯; label chips with the label's colour; sticky blue letter headers.
- Groups: the same rows (member counts grouped "1.840"), quick action and label chips.
- Lời mời kết bạn: cards with a "new" dot (< 24 h), "25 phút trước · Muốn kết bạn", the greeting as a quote with a blue rule,
  filled Đồng ý; sent requests as dense rows with "Đã gửi …" and Thu hồi lời mời; count chips on the section titles.
- Lời mời vào nhóm: an expiry chip ("Hết hạn sau 6 ngày" / "Chờ phê duyệt"), "Lời mời từ <avatar> <name>" + the owner tag,
  filled Tham gia.
