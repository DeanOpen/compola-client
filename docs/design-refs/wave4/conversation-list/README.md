# Wave 4 — Conversation list + row states (Mobbin refs)

Patterns only, inside `docs/zalo-pc-style.md` §2 (white 344px column, 72px rows, #E5F1FF selection). No branding copied.

| Image | Source | Takeaway |
|---|---|---|
| `front-filter-empty.webp` | [Front — filtered inbox, no results](https://mobbin.com/screens/ea6e2bb3-753a-40f4-a461-1e7b58a9dc58) | An empty *filtered* list says so and offers the way out ("Clear filter"), instead of looking like an empty inbox. |
| `contra-inbox.webp` | [Contra — messages](https://mobbin.com/screens/88131907-9600-431a-99ad-5f1fe227daef) | Tabs with a count, quiet "Select a conversation" detail state, a short confirmation toast after an action. |
| `contra-skeleton.webp` | [Contra — loading list](https://mobbin.com/screens/fda1ccc5-b3d0-417a-bb2f-47d8b47bfea5) | Loading shows skeleton rows shaped like the real ones (circle + two bars), so nothing jumps when data lands. |
| `quo-inbox-filters.webp` | [Quo — chats](https://mobbin.com/screens/ae4f7cd1-f5cf-4d7b-885f-67742e7905eb) | Small filter chips over a dense list; unread shown as a blue count on the row's right edge. |

## Applied

- Loading: a status line ("Đang đồng bộ hội thoại…" / the hidden-state stall text) over seven pulsing skeleton rows
  with the real row geometry (48px avatar, two bars, 72px height), fading towards the bottom.
- Empty filtered lists (Chưa đọc, Khác, a Phân loại label): the message plus a "Xem tất cả tin nhắn" button back to
  the inbox. A search without results gets "Xóa tìm kiếm".
- Already in place: hover ⋯ replacing the time (wave 3 #3), undo toasts (#9), Tất cả | Chưa đọc tabs + Phân loại ▾,
  unread badges / dots, the pin glyph.
