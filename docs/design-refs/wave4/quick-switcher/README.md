# Wave 4 — ⌘K quick switcher

Mobbin references for the command palette (`src/features/quickSwitcher`), applied within `docs/zalo-pc-style.md`
(white 8px panel, `--primary` #0068FF, `--selected` rows, compact density, light + dark tokens).

| Image | Source | Takeaway |
|---|---|---|
| `whop-search-scopes.webp` | [Whop](https://mobbin.com/screens/45edfe65-a5a2-4a15-8f2d-50760e0c5740) | Scope chips under the field (All / People / Chats…), sections with a count and "See all", the matched text coloured, a footer with the result count and key hints. |
| `vapi-actions-recent.webp` | [Vapi](https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b) | With an empty query, lead with Recent items and Actions; shortcuts right-aligned in muted text. |
| `stackai-row-subtitles.webp` | [StackAI](https://mobbin.com/screens/bbcc94bb-f535-4dca-8532-56b135fce5c3) | Two-line rows (title + muted subtitle) make look-alike names distinguishable. |
| `gumloop-grouped-open-hint.webp` | [Gumloop](https://mobbin.com/screens/97f3400e-39b6-469b-b208-addb2d51e850) | Typed groups (Teams / Agents / Files) and an "Open ↵" hint only on the active row; ⌘K badge inside the field. |
| `juicebox-accent-sections.webp` | [Juicebox](https://mobbin.com/screens/84169c57-5cd6-4495-bb71-93d37266f4c4) | A left accent bar marks the active row; Tab jumps between sections. |

## Applied

- Field with a ⌘K badge (clear ✕ once typing), then scope chips **Tất cả / Trò chuyện / Bạn bè / Nhóm / Lệnh**; Tab /
  ⇧Tab cycle them, Backspace on an empty field returns to Tất cả.
- Sections: **Trò chuyện gần đây** (empty query) or **Trò chuyện**, **Bạn bè**, **Nhóm** (friends / groups without a
  listed conversation), **Lệnh** (Thêm bạn, Tạo nhóm, mailboxes, Danh bạ, zCloud, sync, Cài đặt). Counts per section
  and "Xem tất cả →" switching to that scope when Tất cả truncates.
- 52px rows: 36px avatar (online dot for friends), highlighted match (diacritic-insensitive), subtitle, time + red unread
  badge; the active row gets `--selected`, a 3px primary bar and "Mở ↵".
- Empty result: icon, message and a **Thêm bạn / Tìm số điện thoại** action (phone-looking queries).
- Footer: "N kết quả" and ↑ ↓ Chọn · ↵ Mở · tab Đổi mục · esc Đóng.
