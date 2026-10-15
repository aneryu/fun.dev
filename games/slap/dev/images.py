"""Converts Blender outputs and MakeHuman CC0 textures into the game's runtime images."""
import os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT, ASSETS = os.path.join(HERE, "out"), os.path.join(HERE, "..", "assets")
MH = os.path.expanduser("~/tools/mh-assets/sys")

head = Image.open(os.path.join(OUT, "head.png")).convert("RGB")
head.save(os.path.join(ASSETS, "head.jpg"), quality=86, optimize=True, progressive=True)
Image.open(os.path.join(OUT, "hand.png")).convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(ASSETS, "hand.jpg"), quality=86, optimize=True)
# MakeHuman's brown iris reads as red at game size: recolour iris pixels to a dark brown.
eye = Image.open(os.path.join(MH, "eyes/materials/brown_eye.png")).convert("RGB").resize((256, 256), Image.LANCZOS)
px = eye.load()
for y in range(eye.height):
    for x in range(eye.width):
        r, g, b = px[x, y]
        if r - max(g, b) > 25:
            lum = 0.3 * r + 0.59 * g + 0.11 * b
            px[x, y] = (int(lum * 0.8 + 12), int(lum * 0.6 + 8), int(lum * 0.45 + 4))
eye.save(os.path.join(ASSETS, "eye.jpg"), quality=88)
for name, path, size in [("brows", "eyebrows/eyebrow009/eyebrow009.png", 256), ("lashes", "eyelashes/eyelashes01/eyelashes01.png", 256)]:
    Image.open(os.path.join(MH, path)).convert("RGBA").resize((size, size), Image.LANCZOS).save(os.path.join(ASSETS, name + ".png"), optimize=True)
for name in os.listdir(ASSETS):
    p = os.path.join(ASSETS, name)
    if os.path.isfile(p): print(f"{name}: {os.path.getsize(p) // 1024} KB")
