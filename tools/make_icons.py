"""Regenerates the app icons in web/icons/. Usage: python3 tools/make_icons.py (needs Pillow)."""
from PIL import Image, ImageDraw

def icon(size, pad_frac, path):
    S = size * 4
    img = Image.new('RGB', (S, S), '#0b1020')
    d = ImageDraw.Draw(img)
    p = int(S * pad_frac); r = (S - 2 * p) // 2; cx = cy = S // 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill='#fccc0a')
    ri = int(r * 0.80); d.ellipse([cx - ri, cy - ri, cx + ri, cy + ri], fill='#0b1020')
    w = int(r * 0.13)
    d.line([cx, cy, cx, cy - int(ri * 0.72)], fill='#ffffff', width=w)
    d.line([cx, cy, cx + int(ri * 0.5), cy + int(ri * 0.1)], fill='#ffffff', width=w)
    d.ellipse([cx - w, cy - w, cx + w, cy + w], fill='#fccc0a')
    img.resize((size, size), Image.LANCZOS).save(path)

icon(192, 0.10, 'web/icons/icon-192.png')
icon(512, 0.10, 'web/icons/icon-512.png')
icon(512, 0.22, 'web/icons/icon-maskable-512.png')
