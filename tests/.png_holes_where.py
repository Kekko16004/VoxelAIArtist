# Dove stanno i buchi passanti di un render RGBA? Stampa bbox e frazione di
# altezza (0 = piedi, 1 = testa) di ogni zona racchiusa dalla silhouette.
import sys, zlib, struct
from collections import deque

def read_png(p):
    d = open(p, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    off, idat, W, H, bd, ct = 8, b'', 0, 0, 0, 0
    while off < len(d):
        ln = struct.unpack_from('>I', d, off)[0]
        ty = d[off+4:off+8]
        if ty == b'IHDR':
            W, H, bd, ct = struct.unpack_from('>IIBB', d, off+8)
        elif ty == b'IDAT':
            idat += d[off+8:off+8+ln]
        off += 12 + ln
    raw = zlib.decompress(idat)
    assert ct == 6, f'serve RGBA, ct={ct}'
    nch, bpp = 4, (4 * bd // 8)
    stride = W * bpp
    out = bytearray(H * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(H):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos+stride]); pos += stride
        if f == 1:
            for i in range(bpp, stride): line[i] = (line[i] + line[i-bpp]) & 255
        elif f == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i-bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i-bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i-bpp] if i >= bpp else 0
                pp = a + b - c
                pa, pb, pc = abs(pp-a), abs(pp-b), abs(pp-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y*stride:(y+1)*stride] = line
        prev = line
    step = bd // 8
    alpha = [out[y*stride + x*bpp + 3*step] for y in range(H) for x in range(W)]
    return W, H, alpha

W, H, alpha = read_png(sys.argv[1])
opaque = [a > 127 for a in alpha]
seen = bytearray(W*H); dq = deque()
for x in range(W):
    for y in (0, H-1):
        i = y*W+x
        if not opaque[i] and not seen[i]: seen[i]=1; dq.append(i)
for y in range(H):
    for x in (0, W-1):
        i = y*W+x
        if not opaque[i] and not seen[i]: seen[i]=1; dq.append(i)
while dq:
    i = dq.popleft(); x, y = i % W, i // W
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < W and 0 <= ny < H:
            j = ny*W+nx
            if not opaque[j] and not seen[j]: seen[j]=1; dq.append(j)

hs = {i for i in range(W*H) if not opaque[i] and not seen[i]}
print(f'{sys.argv[1]}: {W}x{H}, pixel corpo {sum(opaque)}, buchi {len(hs)} px')
vis, comps = set(), []
for i in sorted(hs):
    if i in vis: continue
    dq2 = deque([i]); vis.add(i); px = []
    while dq2:
        k = dq2.popleft(); px.append(k)
        x, y = k % W, k // W
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy; j = ny*W+nx
            if 0 <= nx < W and 0 <= ny < H and j in hs and j not in vis:
                vis.add(j); dq2.append(j)
    comps.append(px)
comps.sort(key=len, reverse=True)
# righe PNG: y=0 in alto. La silhouette del corpo da' i piedi e la testa.
ys = [i//W for i in range(W*H) if opaque[i]]
top, bot = min(ys), max(ys)
for px in comps[:10]:
    xs = [i % W for i in px]; yy = [i//W for i in px]
    # frazione di altezza: 1 = testa, 0 = piedi
    fr_hi = 1 - (min(yy)-top)/(bot-top)
    fr_lo = 1 - (max(yy)-top)/(bot-top)
    print(f'  zona {len(px):5} px  x[{min(xs)},{max(xs)}] y[{min(yy)},{max(yy)}]'
          f'  altezza corpo {fr_lo:.2f}..{fr_hi:.2f}')
