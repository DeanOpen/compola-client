# dmgbuild settings for Compola's drag-to-Applications DMG (scripts/make-dmg.sh passes -D app=<path> -D assets=<dir>).
# dmgbuild writes the Finder layout (.DS_Store) itself, so this works headless (CI) — no AppleScript / Finder.
# Window and icon positions match the artwork drawn by scripts/dmg/make-background.py.
import os.path

app = defines["app"]  # noqa: F821 (injected by dmgbuild)
here = defines.get("assets", "scripts/dmg")  # noqa: F821 (make-dmg.sh passes the absolute path)
app_name = os.path.basename(app)

format = "ULMO"  # LZMA (macOS 10.15+; the app needs 11)
filesystem = "HFS+"
size = None

files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(os.path.dirname(app), app_name, "Contents/Resources/icon.icns")
if not os.path.exists(icon):
    icon = None

background = os.path.join(here, "background.tiff")
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
default_view = "icon-view"
show_icon_preview = False

window_rect = ((200, 160), (660, 432))  # 400 pt of content + the title bar
icon_size = 128
text_size = 13
arrange_by = None
label_pos = "bottom"
icon_locations = {app_name: (165, 185), "Applications": (495, 185)}
hide_extensions = [app_name]
