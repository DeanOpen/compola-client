# Wave 4 (g): media viewer + Kho lưu trữ

Mobbin references for the photo / video viewer (`src/features/media/`) and the "Kho lưu trữ" page of the info panel
(`src/features/sharedMedia/`). We borrow the patterns and keep the look within `docs/zalo-pc-style.md`: the viewer stays
Zalo PC's dark viewer, and the panel stays a flat white right-hand column with `#0068FF` accents. Don't copy other
products' branding or colours.

| Image | Source | Takeaway |
|---|---|---|
| `carecom-lightbox-filmstrip.jpg` | [Care.com](https://mobbin.com/screens/3efcd915-240f-4a52-881e-270f3941cd49) | A thumbnail strip under the photo, with the current photo framed, so you can jump without stepping one by one. |
| `savee-dark-viewer-menu.jpg` | [Savee](https://mobbin.com/screens/db8f90be-a734-4094-b5e7-c527150c8b3b) | A near-black stage with a slim top bar: who and when on the left, actions on the right, and a filmstrip along the bottom edge. |
| `meetup-photo-viewer-counter.jpg` | [Meetup](https://mobbin.com/screens/1f8846d0-b0c8-47d9-9358-dbe5aca33011) | A centred "2 / 11" counter, the uploader's avatar and date, and Download as a direct action. |
| `obvious-files-panel.jpg` | [Obvious](https://mobbin.com/screens/56f48e80-6d1a-46b1-bd0c-4e96e2e3b639) | A files side panel with a search field and filter next to the list; each row reads "type · size" under the name. |
| `mindtrip-media-drop-tile.jpg` | [Mindtrip](https://mobbin.com/screens/7d8a3480-ea46-4bcc-a37f-90b93925f639) | A "Drop files or click to upload" target inside the media panel itself, which also works as a click-to-pick button. |

## Applied

**Media viewer** (`MediaViewer.tsx`, `media.css`)
- Zalo PC dark, flat: a 56px top bar (`#1f2226`) and the stage on `#131518`. The glass capsules are kept only over the
  picture: previous / next and the video controls.
- **Top bar:** the sender's avatar, name and "day · time · conversation" on the left, and a centred `n / N` counter.
- **Top bar actions:** zoom controls (photos), Xem trong trò chuyện (closes the viewer and jumps to the message), Chia sẻ
  (the forward sheet), Mở bằng ứng dụng khác (`media_open_file`), Lưu về máy… and Đóng.
- **Filmstrip** (76px) of the conversation's photos and videos (the media store merged with the loaded messages): the
  current one is framed in `#0068FF` and scrolled to the centre; a click jumps to it; videos carry a play badge. In video
  mode it fades with the bars.

**Kho lưu trữ** (`SharedMedia.tsx`, `sharedMedia.css`)
- Under the title bar, a toolbar with a search field ("Tìm theo tên file, link"; it matches file names, link titles,
  addresses and senders, and ignores diacritics and separators) and a **Người gửi ▾** filter (Zalo PC's own sender
  filter).
- An empty result shows "Không có kết quả phù hợp · Xóa bộ lọc".
- File rows read "PDF · 2,4 MB" (type · size) as in the Obvious panel; the day is the group header.
- The "Thả vào đây để chia sẻ" target (wave 3 #6) stays at the top, lights up while files are dragged over the window,
  and opens the file picker on click. It hides while a search or filter is active.
