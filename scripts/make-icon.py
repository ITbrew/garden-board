"""Generate assets/garden.ico without any image library.

Draws a small node graph: three connected cards, the thing the app actually is. Written by
hand because Pillow is not installed and borrowing Chrome's icon would make the shortcut
indistinguishable from every other Chrome shortcut on the desktop.
"""
import struct
import zlib
from pathlib import Path

SIZE = 256
BG = (14, 18, 32)          # card background, matches --bg-node
EDGE = (44, 54, 82)        # card border
ACCENT = (124, 92, 255)    # --accent
TEAL = (45, 212, 191)      # --ok

px = [[(7, 9, 16, 0) for _ in range(SIZE)] for _ in range(SIZE)]


def blend(x, y, colour, alpha):
    if not (0 <= x < SIZE and 0 <= y < SIZE) or alpha <= 0:
        return
    r, g, b, a = px[y][x]
    na = alpha + a * (1 - alpha)
    if na <= 0:
        return
    nr = (colour[0] * alpha + r * a * (1 - alpha)) / na
    ng = (colour[1] * alpha + g * a * (1 - alpha)) / na
    nb = (colour[2] * alpha + b * a * (1 - alpha)) / na
    px[y][x] = (nr, ng, nb, na)


def rounded_rect(cx, cy, w, h, radius, fill, border, width=3.0):
    """Signed-distance rounded rectangle, antialiased at the edge."""
    hw, hh = w / 2.0, h / 2.0
    for y in range(int(cy - hh - 3), int(cy + hh + 4)):
        for x in range(int(cx - hw - 3), int(cx + hw + 4)):
            dx = abs(x + 0.5 - cx) - (hw - radius)
            dy = abs(y + 0.5 - cy) - (hh - radius)
            dx = max(dx, 0.0)
            dy = max(dy, 0.0)
            dist = (dx * dx + dy * dy) ** 0.5 - radius
            if dist < 0:
                blend(x, y, fill, min(1.0, -dist))
            edge = abs(dist + width / 2.0) - width / 2.0
            if edge < 0:
                blend(x, y, border, min(1.0, -edge))


def line(x0, y0, x1, y1, colour, thickness=5.0):
    """Antialiased thick segment via point-to-segment distance."""
    vx, vy = x1 - x0, y1 - y0
    length2 = vx * vx + vy * vy
    minx, maxx = int(min(x0, x1) - thickness - 2), int(max(x0, x1) + thickness + 3)
    miny, maxy = int(min(y0, y1) - thickness - 2), int(max(y0, y1) + thickness + 3)
    for y in range(miny, maxy):
        for x in range(minx, maxx):
            pxc, pyc = x + 0.5, y + 0.5
            t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((pxc - x0) * vx + (pyc - y0) * vy) / length2))
            dx, dy = pxc - (x0 + t * vx), pyc - (y0 + t * vy)
            dist = (dx * dx + dy * dy) ** 0.5 - thickness / 2.0
            if dist < 0:
                blend(x, y, colour, min(1.0, -dist))


# Wires first so the cards sit on top of them.
line(74, 96, 150, 168, TEAL, 6)
line(182, 96, 150, 168, ACCENT, 6)

# Two source cards and one child, the shape of a session with subagents.
rounded_rect(74, 92, 92, 62, 12, BG, TEAL, 5)
rounded_rect(182, 92, 92, 62, 12, BG, ACCENT, 5)
rounded_rect(150, 176, 116, 66, 13, BG, ACCENT, 5)

# A prompt tick inside the child card, so it reads as a terminal.
line(120, 196, 136, 208, TEAL, 6)
line(136, 208, 120, 220, TEAL, 6)
line(146, 222, 182, 222, EDGE, 6)

rows = []
for y in range(SIZE):
    row = bytearray([0])
    for x in range(SIZE):
        r, g, b, a = px[y][x]
        row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(a * 255 + 0.5)))
    rows.append(bytes(row))
raw = b''.join(rows)


def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)


png = (
    b'\x89PNG\r\n\x1a\n'
    + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
    + chunk(b'IDAT', zlib.compress(raw, 9))
    + chunk(b'IEND', b'')
)

# ICO directory with a single PNG-compressed entry (supported since Vista).
ico = struct.pack('<HHH', 0, 1, 1)
ico += struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, len(png), 22)
ico += png

out = Path(__file__).resolve().parent.parent / 'assets'
out.mkdir(exist_ok=True)
(out / 'garden.ico').write_bytes(ico)
(out / 'garden.png').write_bytes(png)
print('wrote', out / 'garden.ico', len(ico), 'bytes')
