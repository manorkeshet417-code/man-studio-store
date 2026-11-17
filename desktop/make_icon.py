"""Draws store.ico: the blue/purple rounded square with a play triangle (same as the site logo)."""
import os
from PIL import Image, ImageDraw

S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
grad = Image.new("RGBA", (S, S))
px = grad.load()
a, b = (0x66, 0xC0, 0xF4), (0x9B, 0x5C, 0xFF)  # --acc → violet, diagonal
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * (S - 1))
        px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((8, 8, S - 8, S - 8), radius=56, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)
d.polygon([(96, 70), (96, 186), (194, 128)], fill=(255, 255, 255, 255))
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "store.ico")
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out)
