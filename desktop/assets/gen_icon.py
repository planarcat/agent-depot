#!/usr/bin/env python3
"""Generate the Agent Depot icon source PNG (1024x1024, RGBA). stdlib only."""
import struct, sys, zlib

S = 2048          # 2x supersample
OUT = 1024
BG = (13, 106, 99, 255)      # #0d6a63 deep teal (product accent)
FG = (249, 250, 250, 255)    # #f9fafa near-white

def spans_rr(y, x0, y0, x1, y1, r):
    """x-span(s) of a rounded rect at row y -> list of (a, b) or []"""
    if y < y0 or y > y1:
        return []
    if y0 + r <= y <= y1 - r:
        return [(x0, x1)]
    dy = (y0 + r) - y if y < y0 + r else y - (y1 - r)
    if dy > r:
        return []
    half = (r * r - dy * dy) ** 0.5
    return [(x0 + r - half, x1 - r + half)]

def clip_spans(spans, lo, hi):
    out = []
    for a, b in spans:
        a2, b2 = max(a, lo), min(b, hi)
        if b2 > a2:
            out.append((a2, b2))
    return out

def merge(spans):
    spans.sort()
    out = []
    for a, b in spans:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out

M, R = 0.06, 0.16                       # tile margin & corner radius
bar_h, gap = 0.062, 0.062
widths = [0.46, 0.60, 0.46]             # three pills: narrow / wide / narrow
top = 0.5 - (3 * bar_h + 2 * gap) / 2

buf = bytearray(S * S * 4)
for py in range(S):
    y = (py + 0.5) / S
    row = py * S * 4
    tile = merge(clip_spans(spans_rr(y, M, M, 1 - M, 1 - M, R), 0.0, 1.0))
    marks = []
    for i, w in enumerate(widths):
        y0 = top + i * (bar_h + gap)
        marks += clip_spans(spans_rr(y, (1 - w) / 2, y0, (1 + w) / 2, y0 + bar_h, bar_h / 2), M, 1 - M)
    marks = merge(marks)
    rowbuf = bytearray(S * 4)
    for a, b in tile:
        for x in range(int(a * S), int(b * S)):
            rowbuf[x * 4: x * 4 + 4] = bytes(BG)
    for a, b in marks:
        for x in range(int(a * S), int(b * S)):
            rowbuf[x * 4: x * 4 + 4] = bytes(FG)
    buf[row: row + S * 4] = rowbuf

def downsample2x(src, s):
    """2x box downsample with alpha-weighted color averaging (correct AA)."""
    w = s // 2
    out = bytearray(w * w * 4)
    for oy in range(w):
        r0 = (2 * oy) * s * 4
        r1 = r0 + s * 4
        orow = oy * w * 4
        for ox in range(w):
            i0 = r0 + ox * 8
            i1 = r1 + ox * 8
            a1, a2, a3, a4 = src[i0 + 3], src[i0 + 7], src[i1 + 3], src[i1 + 7]
            sa = a1 + a2 + a3 + a4
            if sa == 0:
                continue
            p = orow + ox * 4
            out[p]     = (src[i0]     * a1 + src[i0 + 4] * a2 + src[i1]     * a3 + src[i1 + 4] * a4) // sa
            out[p + 1] = (src[i0 + 1] * a1 + src[i0 + 5] * a2 + src[i1 + 1] * a3 + src[i1 + 5] * a4) // sa
            out[p + 2] = (src[i0 + 2] * a1 + src[i0 + 6] * a2 + src[i1 + 2] * a3 + src[i1 + 6] * a4) // sa
            out[p + 3] = sa // 4
    return out

img = downsample2x(buf, S)

def write_png(path, w, h, rgba):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    raw = b''.join(b'\x00' + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

write_png(sys.argv[1] if len(sys.argv) > 1 else 'icon-source.png', OUT, OUT, img)
print('icon source written')
