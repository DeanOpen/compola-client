# Wave 4 — Thêm bạn + profile card (Mobbin refs)

Patterns only, applied inside `docs/zalo-pc-style.md` §7 (Zalo PC dialog, #0068FF, compact 14px). No branding copied.

| Image | Source | Takeaway |
|---|---|---|
| `telegram-add-contact.webp` | [Telegram — Add Contact](https://mobbin.com/screens/0702442c-b12c-4814-ae54-70329d839f8c) | One outlined phone field that holds the country prefix; the whole field gets the focus ring. |
| `skype-number-result.webp` | [Skype — New SMS by number](https://mobbin.com/screens/f847f4be-a97b-4172-9bac-02ed539e74e9) | The typed number turns into an inline result row under the field (searching / found / not found) instead of a silent button spinner. |
| `x-new-message-suggestions.webp` | [X — New message](https://mobbin.com/screens/6b41dc4e-b000-46c6-94cf-eb9eeec09280) | Filled search pill, then a quiet section heading and dense person rows (avatar, name, secondary line). |
| `discord-profile-card.webp` | [Discord — profile modal](https://mobbin.com/screens/dbef610f-902d-4af3-94e9-97971748f692) | Cover band + overlapping avatar with a ring, name + secondary name, primary action next to the identity, then a details section. |
| `featurebase-profile-details.webp` | [Featurebase — person details](https://mobbin.com/screens/045c0572-ca9e-49c8-a60b-cc6992c0c904) | Key/value detail rows (label above or left, value selectable) in a separate block under the hero. |

## Applied

- Phone step: one 40px outlined field (country button + divider + number + clear ✕), focus ring on the field; inline
  status row under it while searching ("Đang tìm …") and a not-found card with an icon instead of red text only.
- Sections "Kết quả gần nhất" / "Có thể bạn quen" with a small heading + count and 52px person rows; an empty state
  when there is neither.
- Fixed dialog height, so the steps don't jump.
- Profile card: cover band, ringed avatar, name, Zalo name, a relationship pill (Bạn bè / Đã gửi lời mời / Muốn kết
  bạn với bạn), action buttons, then "Thông tin cá nhân" rows (Điện thoại with the searched number, Giới thiệu).
- Message step: mini profile header, the greeting box with its counter inside, and the target named in the button.
