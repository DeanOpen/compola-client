# Wave 4 — Calls UI + group call picker (Mobbin references)

Applied within `docs/zalo-pc-style.md` to `src/features/calls/`. Patterns only; no other product's branding or colours.

| Image | Source | Takeaway |
|---|---|---|
| `teams-incoming-call-card.webp` | [Microsoft Teams](https://mobbin.com/screens/4cfdf580-dad0-41b0-a523-cef08401b3b5) | Incoming call as a **corner card**: small app/kind header, centred avatar, "<Name> is calling you", actions as one row of large buttons. We can't answer in-app (ZaloCall rings), so the action is "Mở cửa sổ cuộc gọi". |
| `discord-incoming-call.webp` | [Discord](https://mobbin.com/screens/c97ecd49-45bb-4d4b-b042-3ebb92ff761c) | Ringing avatar with a ring around it; very little text. → pulsing double ring on our avatar, and the centred icon layout of the "Chưa gọi được" notice. |
| `dialpad-call-pill.webp` | [Dialpad](https://mobbin.com/screens/de94489f-6011-4908-b235-9232e2c6ffcf) | A **floating call pill** while a call runs (state + timer + one action) that stays out of the conversation's way. → "Đang trong cuộc gọi 0:42 · Mở cửa sổ cuộc gọi" over the chat column; the same slot carries the helper-problem warning. |
| `x-create-group-chips.webp` | [X](https://mobbin.com/screens/b7eb7b43-0fb6-4553-a328-29274111601a) | Picked people as **removable chips** between the search field and the list; checks stay on the rows. |
| `meet-add-people.webp` | [Google Meet](https://mobbin.com/screens/0a7276d2-a01c-4040-93df-7ad492d399cc) | Compact "Add people" dialog: one search field, checkbox rows, nothing else. → section label with count, selected rows tinted `--selected`, Backspace in the empty search removes the last chip. |

Also looked at: [Whop new group chat](https://mobbin.com/screens/09626aac-0bcc-4363-94ea-c2b8c4091563) (chips above list), [Quo add people to call](https://mobbin.com/screens/a3e7160d-c581-43b1-9fcb-bd1afff6915e), [Telegram ringing card](https://mobbin.com/screens/c19b6e4b-7fe9-47ba-90e6-e2f188bfc388).

Mock routes: `?mock=1&open=u-lan&incomingCall=1|group`, `&open=g-team&callPicker=1|add`, `&open=g-k15&callPicker=k15`,
`&open=u-huy&callActive=1`, `&callHelper=missing`, `&callNotice=1`, `&callUnsupported=1`.
