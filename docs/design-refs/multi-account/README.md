# Multi-account — account switcher (Mobbin refs)

Patterns only, inside `docs/zalo-pc-style.md` (76px blue rail, avatar under the traffic lights). No branding copied.

| Image | Source | Takeaway |
|---|---|---|
| `discord-server-rail.webp` | [Discord — server rail](https://mobbin.com/screens/34bc4bcb-1f0d-4b19-8f31-6b50b787d0a3) | A narrow column of round identities at the far left; the current one is marked by a pill on the rail's edge and a squarer shape; "+" to add sits right under them; hover shows the name. |
| `slack-workspace-menu.webp` | [Slack — workspaces menu](https://mobbin.com/screens/dffa5e88-3773-4e0c-8c0d-f37498390fef) | Each workspace one row with its icon and a ✓ on the current one, then "Sign in to another workspace…" as the last row. |
| `slack-choose-workspace.webp` | [Slack — choose a workspace](https://mobbin.com/screens/e7908004-fe36-4773-9b2f-a61122692bb0) | A list card of identities (icon, name, secondary line) with an arrow to enter; adding another is a separate, quieter action. |
| `telegram-add-account.webp` | [Telegram — main menu](https://mobbin.com/screens/f2754259-02ed-483a-bea2-46f28704824b) | The signed-in account on top of the menu, "Add Account" right under it. |
| `telegram-qr-login.webp` | [Telegram — QR login](https://mobbin.com/screens/8b6bb588-c12b-4915-b0c8-a39292edfd24) | Adding an account reuses the same QR card as the first sign-in, with numbered steps. |
| `elevenlabs-workspaces-settings.webp` | [ElevenLabs — workspaces settings](https://mobbin.com/screens/3f499169-e6b6-4653-817c-5edeb081778e) | Settings list of all identities with "Current" vs "Switch" and a per-row settings button. |

## How it maps to Compola

- **Rail**: the accounts are a column of 40px avatars at the top of the blue rail (Discord), the active one 48px with a
  white pill on the left edge; each shows its unread badge; hover = the account name (and number); right-click = the
  account menu (Hồ sơ, Cài đặt, Đăng xuất). "+" under the column adds an account. ⌃1–5 switch, ⌘⇧N adds.
- **Add account**: a sheet with the same Zalo login card / QR as the first sign-in (Telegram), titled
  "Thêm tài khoản Zalo".
- **Settings ▸ Tài khoản**: one row per account (avatar, name, number, unread), "Đang dùng" / "Chuyển", drag or ↑↓ to
  reorder, Đăng xuất, Xóa khỏi Compola (ElevenLabs list + Slack's quiet "add another" row at the end).
- **Notifications / toasts**: prefixed with the account when it is not the one on screen ("[Công việc] Lan: …").
