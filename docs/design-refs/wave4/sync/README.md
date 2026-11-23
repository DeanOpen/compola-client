# Wave 4 — Phone → PC sync window (Mobbin pass)

Patterns borrowed for `src/features/transfer/TransferView.tsx` within `docs/zalo-pc-style.md` (white Zalo PC dialog,
title bar with ×, actions bottom-right, #0068FF).

| Image | Reference | Takeaway applied |
|---|---|---|
| `confluence-import-progress.webp` | [Confluence — Importing document](https://mobbin.com/screens/4ca4995a-8a4f-4c55-b89c-346f0c0b269e) | Illustration on top, then **label + percentage over a linear bar** → "Đang đồng bộ tin nhắn… 72%" with a bar and the received count (replaces the big ring). |
| `pandadoc-import-steps.webp` | [PandaDoc — Bulk import](https://mobbin.com/screens/f7443f66-5e59-433b-a611-deebd86db562) | Breadcrumb steps under the title, **one row per item with ✓ / spinner / pending**, "Keep this window open" → the stepper and the official sync stages (Danh sách hội thoại / Tin nhắn gần đây / Tin nhắn cũ hơn) as a checklist with the current stage's %. |
| `podia-import-stepper.webp` | [Podia — Import data](https://mobbin.com/screens/6f5360c0-5b24-4b36-8d46-17a2c70a2d6c) | Numbered **stepper with checks** for finished steps → "Xác nhận trên điện thoại — Đồng bộ — Hoàn tất". |
| `lyssna-importing.webp` | [Lyssna — Importing data](https://mobbin.com/screens/915a036a-f15d-448c-b977-f8360bacbebb) | A plain note about the window during the import → an info note: hiding the window keeps the sync going, keep Zalo open on the phone. |
| `care-follow-phone.webp` | [Care.com — Follow the link sent to your phone](https://mobbin.com/screens/19ea6e00-7b66-4ce7-99fc-3dfc12270e39) | Device illustration + "what to do on your phone" → the waiting state lists **numbered steps** (open Zalo, tap the request, choose Đồng ý). |

Also: the offer lists what to expect as three icon bullets (like the setup sync step); the finished state shows the
received-messages count as a pill; the failed state adds "Trước khi thử lại" tips and the error code.
