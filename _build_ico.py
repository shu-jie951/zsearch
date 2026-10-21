# -*- coding: utf-8 -*-
"""
Build the Windows .ico for the ZSEARCH desktop shortcut.

The tile artwork is NOT redrawn here. It is rendered from public/static/logo.svg
by the browser (see _render_icons.js), so the icon can never drift from the logo
the site actually shows. This script only does the last mile:

  1. read each supersampled tile the browser produced,
  2. downscale it with a high-quality filter,
  3. pack the lot into a multi-resolution .ico by hand.

Sizes cover everything Windows asks for, from the 256px used by large icon views
down to the 16px in the taskbar.

Usage: python _build_ico.py [out.ico] [supersample]
"""
import io
import os
import re
import struct
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "_icons_raw")
# Must match the <ss> handed to _render_icons.js -- the tiles are read back as
# `icon-<size>@<ss>x.png`.
SS = 4
SIZES = [256, 128, 96, 64, 48, 40, 32, 24, 20, 16]
ZOOM_SHEET = 6


def load_raw(size):
    """Read the biggest supersampled tile available for this size.

    The renderer quietly drops the supersample factor for the very largest
    entries (a 256px tile at 8x is a 2048px render, taller than any viewport we
    can guarantee), so the file on disk is not always `@...<SS>x`. Take whatever
    the largest factor present is rather than hard-coding one.
    """
    found = []
    for name in os.listdir(RAW) if os.path.isdir(RAW) else []:
        m = re.match(r"^icon-%d@(\d+)x\.png$" % size, name)
        if m:
            found.append((int(m.group(1)), os.path.join(RAW, name)))
    if not found:
        raise SystemExit("missing icon-%d@Nx.png in %s -- run: "
                         "node _render_icons.js public/static/logo.svg %s %d"
                         % (size, RAW, RAW, SS))
    ss, p = max(found, key=lambda t: t[0])
    img = Image.open(p).convert("RGBA")
    # Supersampled render -> one clean downscale. Doing it in a single step is
    # what keeps the tiny entries sharp; going via an intermediate size softens
    # the corners noticeably.
    small = img.resize((size, size), Image.LANCZOS)
    img.close()
    return small


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def build(out_path):
    entries = []
    for s in SIZES:
        img = load_raw(s)
        entries.append((s, png_bytes(img)))
        img.close()

    n = len(entries)
    header = struct.pack("<HHH", 0, 1, n)          # ICONDIR: reserved, type, count
    offset = 6 + 16 * n                            # data begins after the directory
    directory = b""
    blob = b""
    for size, data in entries:
        wh = 0 if size >= 256 else size            # 0 encodes 256 in the ICO format
        directory += struct.pack("<BBBBHHII", wh, wh, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blob += data

    with open(out_path, "wb") as f:
        f.write(header + directory + blob)
    return out_path, n


def read_entries(path):
    raw = open(path, "rb").read()
    _, _, n = struct.unpack("<HHH", raw[:6])
    out = []
    for i in range(n):
        off = 6 + 16 * i
        w, h, _, _, _, bpp, size, do = struct.unpack("<BBBBHHII", raw[off:off + 16])
        out.append((w or 256, Image.open(io.BytesIO(raw[do:do + size])).convert("RGBA")))
    return out


def sheets(entries, out_dir):
    """Blow the small frames up with NEAREST so any defect is obvious."""
    small = sorted([e for e in entries if 16 <= e[0] <= 64], key=lambda e: e[0])
    pad = 10
    w = sum(e[0] * ZOOM_SHEET for e in small) + pad * (len(small) + 1)
    h = max(e[0] * ZOOM_SHEET for e in small) + pad * 2
    for name, bg in (("ico-sheet.png", (251, 250, 249)),
                     ("ico-sheet-dark.png", (14, 14, 17)),
                     ("ico-sheet-wall.png", (58, 62, 88))):
        sheet = Image.new("RGB", (w, h), bg)
        x = pad
        for size, img in small:
            big = img.resize((size * ZOOM_SHEET, size * ZOOM_SHEET), Image.NEAREST)
            sheet.paste(big, (x, (h - size * ZOOM_SHEET) // 2), big)
            x += size * ZOOM_SHEET + pad
        sheet.save(os.path.join(out_dir, name))


def verify(path):
    """Structural check + a couple of pixel spot-checks. Returns (size, image)."""
    raw = open(path, "rb").read()
    reserved, kind, n = struct.unpack("<HHH", raw[:6])
    ok = reserved == 0 and kind == 1
    print("  ICONDIR  reserved=%d type=%d count=%d  %s"
          % (reserved, kind, n, "ok" if ok else "BAD"))
    total = 0
    entries = []
    for i in range(n):
        off = 6 + 16 * i
        w, h, colors, res, planes, bpp, size, do = struct.unpack(
            "<BBBBHHII", raw[off:off + 16])
        px = w or 256
        payload = raw[do:do + size]
        sig = payload[:8] == b"\x89PNG\r\n\x1a\n"
        total += size
        print("  %3dpx  %6d B  bpp=%d  png=%s  fits=%s"
              % (px, size, bpp, "yes" if sig else "NO",
                 "yes" if do + size <= len(raw) else "NO"))
        entries.append((px, Image.open(io.BytesIO(payload)).convert("RGBA")))
    print("  payload total %d B, file %d B" % (total, len(raw)))
    return entries


def quality(entries):
    """Per-size sanity, in four parts.

    opaque%   -- a rounded tile fills ~75% of the square once the corners are
                 cut; it must not collapse at the small end (that would mean the
                 downsample smeared alpha over the whole frame).
    corner a  -- the four extreme pixels must still be transparent, or the
                 rounded corners have been squared off.
    tile box  -- bounding box of the solid area. This is the check that catches
                 a CLIPPED frame: the renderer screenshots a fixed rect, and if
                 the window is too small the right/bottom edge is cut off and the
                 box comes out asymmetric. A centred tile has equal margins, so
                 flag any frame where left vs right (or top vs bottom) disagree.
    accent    -- the orange dot. It is only a few pixels at 16px but it must
                 never vanish, and it must sit at the centre of the frame.
    """
    print("\n-- per-size quality --")
    print("  %4s %9s %9s %8s  %-13s %s" % ("px", "opaque%", "accent%", "corner a",
                                           "tile box", "accent centre"))
    bad = []
    for size, img in sorted(entries, key=lambda e: e[0]):
        px = img.load()
        n = size * size
        opaque = accent = 0
        tx0 = ty0 = 10 ** 9
        tx1 = ty1 = -1
        ax = ay = an = 0
        for y in range(size):
            for x in range(size):
                r, g, b, a = px[x, y]
                if a >= 200:
                    opaque += 1
                    tx0 = min(tx0, x); tx1 = max(tx1, x)
                    ty0 = min(ty0, y); ty1 = max(ty1, y)
                if a >= 120 and (r - b) >= 40 and r >= 120:
                    accent += 1
                    ax += x; ay += y; an += 1
        cmax = max(px[0, 0][3], px[size - 1, 0][3], px[0, size - 1][3], px[size - 1, size - 1][3])
        op = 100.0 * opaque / n
        box = "%d,%d-%d,%d" % (tx0, ty0, tx1, ty1) if tx1 >= 0 else "none"
        ctr = "%.1f,%.1f" % (ax / an - (size - 1) / 2.0,
                             ay / an - (size - 1) / 2.0) if an else "MISSING"
        print("  %4d %8.1f%% %8.1f%% %8d  %-13s %s" % (size, op, 100.0 * accent / n, cmax, box, ctr))
        # Margins must match: a clipped frame shows up as lopsided ones.
        off = max(abs(tx0 - (size - 1 - tx1)), abs(ty0 - (size - 1 - ty1))) if tx1 >= 0 else 99
        why = []
        if op < 50:
            why.append("opaque=%.1f%%" % op)
        if cmax > 40:
            why.append("corner_a=%d" % cmax)
        if off > 1:
            why.append("tile off-centre by %dpx (box %s)" % (off, box))
        if an == 0:
            why.append("accent dot missing")
        if why:
            bad.append((size, why))
    if bad:
        print("\n  !! needs a look:")
        for size, why in bad:
            print("     %dpx: %s" % (size, "; ".join(why)))
    else:
        print("\n  all sizes solid, centred, corners clear, accent present.")
    return bad


def main():
    global SS
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "zsearch.ico")
    if len(sys.argv) > 2:
        SS = int(sys.argv[2])
    p, n = build(out)
    print("ICO  %s  (%d sizes, %d bytes, ss=%dx)" % (p, n, os.path.getsize(p), SS))
    print("\n-- structure --")
    entries = verify(p)
    quality(entries)
    od = os.path.join(HERE, "_logo_out")
    os.makedirs(od, exist_ok=True)
    sheets(entries, od)
    print("\nsheets -> _logo_out/ico-sheet{,-dark,-wall}.png")


if __name__ == "__main__":
    main()
