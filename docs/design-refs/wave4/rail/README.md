# Wave 4 — Rail + account menu (Mobbin refs)

Patterns only, inside `docs/zalo-pc-style.md` §1 (64px blue rail, avatar on top under the traffic lights, Tin nhắn /
Danh bạ, then Cloud / zCloud / Cài đặt at the bottom). No branding copied.

| Image | Source | Takeaway |
|---|---|---|
| `snowflake-account-menu.webp` | [Snowflake — account menu](https://mobbin.com/screens/41e8b27f-bbca-4be6-9136-a536e37c17b4) | The avatar at the edge of a narrow icon rail opens a menu that starts with who is signed in, groups items with icons, and ends with Sign out. |
| `confluence-account-switch.webp` | [Confluence — choose account](https://mobbin.com/screens/ed0de1ce-bf14-4cfc-a512-d95ac91bc369) | Identity = name + a secondary line (email / number); "Log out" set apart. |
| `linktree-switch.webp` | [Linktree — switch](https://mobbin.com/screens/3ca438ce-19a1-4255-97fe-0a3b18395b1e) | One clear row per identity with avatar, name and handle. |

## Applied

- Account menu: the header says who is signed in with the number ("Nguyễn Minh Anh · 0901…"), then Hồ sơ của bạn
  (disabled until a self profile card exists), Đồng bộ tin nhắn từ điện thoại…, Cài đặt ⌘,, separator, Đăng xuất (red).
- Rail tooltips carry the counts behind the badges: "Tin nhắn · 5 chưa đọc", "Danh bạ · 3 lời mời kết bạn, 2 lời mời
  vào nhóm" (the Danh bạ badge now includes group invitations).
- The top strip under the traffic lights stays a drag region (`.rail-titlebar`, main).
