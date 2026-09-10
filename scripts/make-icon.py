"""Generate assets/garden.ico from the same seedling the browser tab shows.

The desktop shortcut at OneDrive\\Desktop\\Garden.lnk points its IconLocation at
assets/garden.ico, so this file is the desktop icon and nothing else sets it.

It used to draw a small node graph, three connected cards, which was the app's mark before the
seedling existed. The owner's instruction on 2026-09-09 was to make this one the plant "as well",
so the two marks are now one mark: the shapes below are the paths out of
apps/web/public/garden.svg, scaled by eight from that file's 32-unit viewBox to 256 pixels, in the
same two colours. If that SVG is ever redrawn, redraw this from it rather than nudging this by eye,
because the whole point of the change is that the tab and the desktop agree.

Written by hand with no image library because Pillow is not installed here, which is why there is a
Bezier flattener and a scanline fill in a file that would otherwise be twenty lines. Borrowing
Chrome's icon would make the shortcut indistinguishable from every other Chrome shortcut on the
desktop, which is the problem this file exists to solve.
"""
import struct
import zlib
from pathlib import Path

SIZE = 256
SCALE = SIZE / 32.0         # the source SVG's viewBox is 32 units wide

GROUND = (11, 14, 22)       # #0b0e16, the panel background the favicon sits on
PLANT = (45, 212, 191)      # #2dd4bf, the same green a working card's status dot uses
LEAF_FILL_ALPHA = 0.22      # fill-opacity on both leaves in the SVG

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


def rounded_rect(cx, cy, w, h, radius, fill, border=None, width=3.0):
    """Signed-distance rounded rectangle, antialiased at the edge."""
    hw, hh = w / 2.0, h / 2.0
    for y in range(int(cy - hh - 3), int(cy + hh + 4)):
        for x in range(int(cx - hw - 3), int(cx + hw + 4)):
            dx = max(abs(x + 0.5 - cx) - (hw - radius), 0.0)
            dy = max(abs(y + 0.5 - cy) - (hh - radius), 0.0)
            dist = (dx * dx + dy * dy) ** 0.5 - radius
            if dist < 0:
                blend(x, y, fill, min(1.0, -dist))
            if border is not None:
                edge = abs(dist + width / 2.0) - width / 2.0
                if edge < 0:
                    blend(x, y, border, min(1.0, -edge))


def line(x0, y0, x1, y1, colour, thickness=5.0):
    """Antialiased thick segment via point-to-segment distance, round ends like the SVG's."""
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


def bezier(p0, p1, p2, p3, steps=64):
    """One cubic segment as points, at the SVG's own coordinates. The caller scales."""
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        out.append((x, y))
    return out


def fill_polygon(points, colour, alpha):
    """
    Even-odd scanline fill, antialiased by supersampling.

    Four samples across and four down per pixel, which is enough at 256 for an edge that is about
    to be covered by a 16px stroke anyway. A signed-distance approach like the one the rectangle
    uses has no closed form for a flattened Bezier outline, and a marching-squares edge pass would
    be more code than this icon is worth.
    """
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    minx, maxx = max(int(min(xs)) - 1, 0), min(int(max(xs)) + 2, SIZE)
    miny, maxy = max(int(min(ys)) - 1, 0), min(int(max(ys)) + 2, SIZE)
    n = len(points)
    grid = 4
    step = 1.0 / grid

    for y in range(miny, maxy):
        for x in range(minx, maxx):
            hits = 0
            for sy in range(grid):
                py = y + (sy + 0.5) * step
                for sx in range(grid):
                    pxs = x + (sx + 0.5) * step
                    inside = False
                    j = n - 1
                    for i in range(n):
                        yi, yj = points[i][1], points[j][1]
                        if (yi > py) != (yj > py):
                            xi, xj = points[i][0], points[j][0]
                            if pxs < xi + (py - yi) * (xj - xi) / (yj - yi):
                                inside = not inside
                        j = i
                    if inside:
                        hits += 1
            if hits:
                blend(x, y, colour, alpha * hits / (grid * grid))


def stroke_polygon(points, colour, thickness):
    """The outline of a flattened path, drawn as overlapping round-ended segments."""
    for i in range(len(points)):
        a = points[i]
        b = points[(i + 1) % len(points)]
        line(a[0], a[1], b[0], b[1], colour, thickness)


def leaf(start, c1, c2, mid, c3, c4):
    """One leaf: two cubic segments from the stem out and back, closed, in SVG units."""
    pts = [start] + bezier(start, c1, c2, mid) + bezier(mid, c3, c4, start)
    return [(x * SCALE, y * SCALE) for (x, y) in pts]


# The ground the mark sits on. rx 7 of 32 in the SVG, so 56 of 256 here.
rounded_rect(SIZE / 2, SIZE / 2, SIZE, SIZE, 7 * SCALE, GROUND)

# The stem, M16 26 V14 at stroke-width 2.6, drawn before the leaves as the SVG draws it.
line(16 * SCALE, 26 * SCALE, 16 * SCALE, 14 * SCALE, PLANT, 2.6 * SCALE)

# The two leaves, each a closed curve springing from the stem rather than floating beside it.
left = leaf((16, 15), (16, 9.5), (12, 7), (8.5, 7), (8.5, 11.5), (11.5, 15))
right = leaf((16, 17), (16, 11.5), (20, 9), (23.5, 9), (23.5, 13.5), (20.5, 17))
for shape in (left, right):
    fill_polygon(shape, PLANT, LEAF_FILL_ALPHA)
    stroke_polygon(shape, PLANT, 2 * SCALE)

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
