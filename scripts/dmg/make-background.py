#!/usr/bin/env python3
"""Renders the DMG window backgrounds (scripts/dmg/background*.tiff, 1x + 2x) used by scripts/make-dmg.sh:
`background.tiff` (ad-hoc signed: tells how to open it the first time) and `background-notarized.tiff`.

Needs Pillow and macOS (SF Pro); the TIFF is committed, so this only runs when the artwork changes:
    python3 scripts/dmg/make-background.py
Layout must match scripts/dmg/settings.py: a 660x400 window, icons centred at (165, 185) and (495, 185).
"""
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
W, H = 660, 400
APP_X, APPS_X, ICON_Y = 165, 495, 185
SF = "/System/Library/Fonts/SFNS.ttf"

INK = (11, 31, 68)
BODY = (58, 74, 102)
MUTED = (107, 122, 144)
ACCENT = (0, 104, 255)


def font(size: float, weight: str) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(SF, round(size))
    f.set_variation_by_name(weight)
    return f


def render(scale: int, notarized: bool = False) -> Image.Image:
    s = scale
    w, h = W * s, H * s
    # Soft vertical gradient.
    top, bottom = (248, 251, 255), (232, 240, 255)
    img = Image.new("RGB", (w, h))
    px = ImageDraw.Draw(img)
    for y in range(h):
        t = y / (h - 1)
        px.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))

    # Two blurred brand-colour glows for depth.
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse([-120 * s, -160 * s, 300 * s, 220 * s], fill=(0, 104, 255, 34))
    g.ellipse([430 * s, 250 * s, 820 * s, 560 * s], fill=(90, 160, 255, 30))
    glow = glow.filter(ImageFilter.GaussianBlur(70 * s))
    img = Image.alpha_composite(img.convert("RGBA"), glow)

    d = ImageDraw.Draw(img)

    # Title.
    title = font(24 * s, "Semibold")
    d.text((w / 2, 46 * s), "Compola", font=title, fill=INK, anchor="mm")
    sub = font(12.5 * s, "Regular")
    d.text((w / 2, 72 * s), "Zalo cho đội nhóm · Zalo for teams", font=sub, fill=MUTED, anchor="mm")

    # Soft "wells" behind the two icons.
    wells = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wells)
    for cx in (APP_X, APPS_X):
        r = 78 * s
        wd.rounded_rectangle([cx * s - r, ICON_Y * s - r, cx * s + r, ICON_Y * s + r + 18 * s], radius=26 * s, fill=(255, 255, 255, 150))
    img = Image.alpha_composite(img, wells)
    d = ImageDraw.Draw(img)

    # Arrow from the app to Applications.
    x0, x1, y = (APP_X + 92) * s, (APPS_X - 92) * s, ICON_Y * s
    lw = 4 * s
    dash, gap = 10 * s, 8 * s
    x = x0
    while x < x1 - 18 * s:
        d.line([(x, y), (min(x + dash, x1 - 18 * s), y)], fill=ACCENT + (200,), width=lw)
        x += dash + gap
    head = 14 * s
    d.polygon([(x1, y), (x1 - head * 1.4, y - head), (x1 - head * 1.4, y + head)], fill=ACCENT + (230,))

    # Instructions (Finder draws the icon labels just under the icons, ~y 270).
    main = font(14 * s, "Medium")
    if notarized:  # Two lines only: lower them a little to keep the block centred.
        d.text((w / 2, 330 * s), "Kéo Compola vào Applications để cài đặt", font=main, fill=BODY, anchor="mm")
        d.text((w / 2, 356 * s), "Drag Compola to Applications to install", font=font(11.5 * s, "Regular"), fill=MUTED, anchor="mm")
        return img.convert("RGB")
    d.text((w / 2, 318 * s), "Kéo Compola vào Applications để cài đặt", font=main, fill=BODY, anchor="mm")
    small = font(11.5 * s, "Regular")
    d.text((w / 2, 342 * s), "Drag Compola to Applications to install", font=small, fill=MUTED, anchor="mm")
    d.text((w / 2, 370 * s), "Lần đầu mở: nhấp chuột phải vào Compola → Mở  ·  First launch: right-click → Open",
           font=small, fill=MUTED, anchor="mm")
    return img.convert("RGB")


def main() -> None:
    for name, notarized in (("background", False), ("background-notarized", True)):
        with tempfile.TemporaryDirectory() as tmp:
            one, two = Path(tmp, "bg.png"), Path(tmp, "bg@2x.png")
            image = render(2, notarized)
            image.resize((W, H), Image.LANCZOS).save(one, dpi=(72, 72))
            image.save(two, dpi=(144, 144))
            out = HERE / f"{name}.tiff"
            subprocess.run(["tiffutil", "-cathidpicheck", str(one), str(two), "-out", str(out)], check=True)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
