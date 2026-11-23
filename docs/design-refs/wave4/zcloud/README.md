# Wave 4 — zCloud / Cloud của tôi (Mobbin pass)

Base style: `docs/zalo-pc-style.md`. Patterns only — no other product's branding or colours.
Code: `src/features/cloud/` (CloudScreens, CloudMediaView, CloudThumb, CloudPreviewSheet, cloud.css).

| Reference | Pattern taken |
|---|---|
| `google-drive-storage.webp` — [Google Drive · Storage](https://mobbin.com/screens/89cc34fe-8600-470f-b5f3-eb9445af7cfa) | Lead with the used figure ("11,14 GB / 100 GB đã dùng"), then a thin split bar whose segments explain themselves on hover. |
| `gitlab-usage-breakdown.webp` — [GitLab · Usage Quotas](https://mobbin.com/screens/b243d839-d464-4d13-8af1-27e93eaa70e1) | Legend as rows with the size right-aligned; tables with a quiet column header ("Dung lượng", "Gần nhất"). |
| `later-media-selection.webp` — [Later · Media library](https://mobbin.com/screens/272cbc05-555c-43ba-bdff-bbea6e5af7b6) | Edge-to-edge square tiles grouped by time ("Hôm nay", "7 ngày qua"); in selection mode the header becomes the selection toolbar (count, Chọn tất cả, Xoá). |
| `descript-media-library.webp` — [Descript · Media library](https://mobbin.com/screens/6850c209-be11-44e8-894c-ac77d82666a2) | List view as a table (Tên / Trò chuyện / Kích thước / Ngày gửi) with compact rows; "N mục đã chọn" with an × to leave selection. |
| `krea-date-groups-filter.webp` — [Krea AI · Assets](https://mobbin.com/screens/23d8f1f5-629b-43a0-887e-4e0e4d1203bc) | Date-group headings with counts; captions only on hover so the grid stays calm. |

## Applied

- **Storage card** (list column): big used figure, 6px split bar with tooltips, one-column legend with sizes, "Còn trống" + "Chi tiết" (→ Thông tin gói).
- **Thông tin gói**: the same figure at 26px with the percentage, legend rows with sizes.
- **Media grid**: day groups (Hôm nay / Hôm qua / 7 ngày qua / Tháng N) with "N mục • size" when sorted by time; 4px-gap square tiles; photos/videos edge to edge with a hover caption (size • date); files and voice as type tiles with name and "EXT • size"; a round check on hover (click = start selecting) and always in selection mode; per-group "Chọn tất cả"; a pulse skeleton while thumbnails load.
- **Selection mode**: the header turns into a tinted selection toolbar (× / Esc, "Đã chọn N mục" + total size, Chọn tất cả / Bỏ chọn tất cả, Xoá…); the bottom bar is gone.
- **List view**: sticky column header, 52px rows, 36px thumbnails.
- **Theo trò chuyện**: column header with the count, each conversation's size with a meter relative to the largest.
- **Preview sheet**: photos and videos on a dark stage with dark floating zoom controls.
