# Wave 4 — Composer + emoji / sticker pickers (Mobbin refs)

Patterns only, inside `docs/zalo-pc-style.md` §4 (toolbar row over the input, 😊 + GỬI / 👍 on the right). No branding copied.

| Image | Source | Takeaway |
|---|---|---|
| `substack-emoji-popover.webp` | [Substack — emoji popover](https://mobbin.com/screens/aee4dbeb-e7ea-4015-83d8-f651825800b6) | Search on top, then "Suggested" / "Frequently used" before the full categories, as titled sections in one scroll. |
| `loop-emoji-categories.webp` | [Microsoft Loop — emoji picker](https://mobbin.com/screens/c577b189-9bf4-4793-b1e8-a50091782d7d) | A strip of category icons under the search that jumps to each section and follows the scroll (Recent first). |
| `teams-emoji-search.webp` | [Microsoft Teams — emoji search](https://mobbin.com/screens/aa994f72-cd75-46d3-88cf-6f5d25b9f5e7) | Search replaces the sections with a flat result grid; a clear ✕ in the field. |
| `strut-emoji-frequent.webp` | [Strut — emoji picker](https://mobbin.com/screens/daad9306-f669-4866-8178-70b80068dd28) | Compact popover anchored to the composer button, "Frequently used" row first. |

## Applied

- The composer's 😊 (and ⋯ ▸ Biểu tượng cảm xúc) opens an emoji popover: search (Vietnamese + English words,
  accent-insensitive, word-prefix match), a category strip (Gần đây, Mặt cười, Cử chỉ, Trái tim, Động vật & thiên nhiên,
  Đồ ăn & thức uống, Hoạt động, Đồ vật & biểu tượng) that follows the scroll, sticky section titles, an 8-column grid.
  A click inserts at the caret (atomic @mentions are rebased) and keeps the popover open; recent picks are remembered.
- The sticker picker (search, Gần đây + sets tab strip, hover animation) and the typing suggestions strip landed with
  a183c1a; the reply bar thumbnail with c79435f.
