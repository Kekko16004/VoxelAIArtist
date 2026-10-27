"""Anteprime PNG che si possono GUARDARE: isometrica ombreggiata e ortografiche.

PERCHE' ESISTE. `render_ortho` (exporters.py) da' un pixel per voxel e nessuna
ombreggiatura: e' giusto per gli sprite, ma come anteprima e' inservibile. In
BLIND-KOUR (gate 042 e char-047) l'export `.png` di un pezzo da 16x4 voxel usciva
un'immagine di 16x4 PIXEL, e due agenti su due hanno dovuto scriversi un
renderer proprio per vedere cosa avevano fatto. Il difetto non era il formato
ma il parametro: `scale` dell'export vale "metri per voxel" per il GLB (0.25) e
`int(0.25)` = 0 = un pixel.

Qui:
- **la dimensione si chiede in PIXEL** (`size`, il lato lungo), e il lato del
  voxel si ricava da quella: nessun parametro che significa due cose;
- l'**isometrica** (2:1, come la pixel art) mostra tre facce con tre luci
  diverse, quindi la forma si legge; le quattro azimut (`iso`, `iso_left`,
  `iso_back`, `iso_back_left`) coprono i quattro spigoli;
- le **ortografiche** hanno un contorno dove la profondita' salta, altrimenti
  una vista frontale e' una sagoma piatta di un colore solo;
- uno **z-buffer** per pixel, quindi l'ordine di disegno non conta e non ci
  sono gli errori del pittore sui cubi a pari profondita'.

Puro Python, nessuna dipendenza (come png.py): l'MCP deve partire anche dove
Pillow non c'e'. Costo misurato: ~2000 voxel di superficie a 512 px in meno di
un secondo.
"""

from .palette import hex_to_rgb, normalize_hex

ISO_VIEWS = ("iso", "iso_left", "iso_back", "iso_back_left")
ORTHO_VIEWS = ("front", "back", "left", "right", "top", "bottom")
SHEET_VIEWS = ("sheet",)
ALL_VIEWS = ISO_VIEWS + ORTHO_VIEWS + SHEET_VIEWS

# Luce per faccia nell'isometrica: sopra, lato "destro" (+x'), lato "sinistro"
# (+z'). Tre valori distinti sono il minimo perche' uno spigolo si legga.
_SHADE_TOP, _SHADE_X, _SHADE_Z = 1.0, 0.80, 0.62
_OUTLINE = 0.55


def _rot_iso(view):
    """(x, z) -> (x', z') perche' la camera stia sempre verso +x' +z'.

    `iso` guarda da +X +Z (davanti a destra, se il davanti e' +Z), le altre
    girano di 90 gradi alla volta attorno all'asse verticale.
    """
    return {
        "iso": lambda x, z: (x, z),
        "iso_left": lambda x, z: (z, -x),
        "iso_back": lambda x, z: (-x, -z),
        "iso_back_left": lambda x, z: (-z, x),
    }[view]


def _tile(s):
    """Maschera del cubo isometrico a lato `s` (pari): {(dx, dy): faccia}.

    Faccia 0 = sopra, 1 = +x', 2 = +z'. Coordinate relative al punto
    ((x'-z')*s, (x'+z')*s/2 - y*s), cioe' il centro del bordo alto del rombo
    superiore spostato di mezzo cubo. Il test e' sul CENTRO del pixel e
    inclusivo: due cubi vicini si sovrappongono di un filo invece di lasciare
    una fessura, e lo z-buffer decide chi vince.
    """
    h = s / 2.0

    def proj(px, py, pz):
        return ((px - pz) * s, (px + pz) * h - py * s)

    def inside(poly, x, y):
        sign = 0
        n = len(poly)
        for i in range(n):
            ax, ay = poly[i]
            bx, by = poly[(i + 1) % n]
            c = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
            if abs(c) < 1e-9:
                continue
            sg = 1 if c > 0 else -1
            if sign == 0:
                sign = sg
            elif sg != sign:
                return False
        return True

    top = [proj(0, 1, 0), proj(1, 1, 0), proj(1, 1, 1), proj(0, 1, 1)]
    fx = [proj(1, 1, 0), proj(1, 0, 0), proj(1, 0, 1), proj(1, 1, 1)]
    fz = [proj(0, 1, 1), proj(1, 1, 1), proj(1, 0, 1), proj(0, 0, 1)]
    out = {}
    for dy in range(-s - 1, 2 * s + 2):
        for dx in range(-s - 1, s + 2):
            cx, cy = dx + 0.5, dy + 0.5
            if inside(top, cx, cy):
                out[(dx, dy)] = 0
            elif inside(fx, cx, cy):
                out[(dx, dy)] = 1
            elif inside(fz, cx, cy):
                out[(dx, dy)] = 2
    return out


def _shade(rgb, f):
    return tuple(max(0, min(255, int(round(c * f)))) for c in rgb)


def _outline(color, owner, w, h, bg_rgba):
    """Contorno: scurisce il pixel dove confina con un voxel NON adiacente.

    `owner[i]` e' la cella (x,y,z) che possiede il pixel. Due pixel di celle a
    distanza 1 (stessa superficie, anche in diagonale) non fanno contorno; una
    cella lontana si' — e' una sagoma o un pezzo che ne copre un altro (il
    braccio davanti al busto), che senza contorno sarebbe una macchia unica.
    Il confronto e' sulle CELLE e non sulla profondita' di schermo: nella vista
    isometrica due rombi complanari che si toccano in un vertice differiscono
    di 2 in profondita', e un contorno basato su quella punteggiava ogni piano.
    """
    out = bytearray(w * h * 4)
    br, bgc, bb, ba = bg_rgba
    for y in range(h):
        for x in range(w):
            i = y * w + x
            c = color[i]
            if c is None:
                out[i * 4:i * 4 + 4] = bytes((br, bgc, bb, ba))
                continue
            k = owner[i]
            edge = False
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if nx < 0 or ny < 0 or nx >= w or ny >= h:
                    edge = True
                    break
                kj = owner[ny * w + nx]
                if kj is None or (kj is not k and max(
                        abs(k[0] - kj[0]), abs(k[1] - kj[1]),
                        abs(k[2] - kj[2])) > 1):
                    edge = True
                    break
            r, g, b = _shade(c, _OUTLINE) if edge else c
            out[i * 4:i * 4 + 4] = bytes((r, g, b, 255))
    return out


def _bg(background):
    bg = normalize_hex(background, None)
    if not bg:
        return (0, 0, 0, 0)
    r, g, b = hex_to_rgb(bg)
    return (r, g, b, 255)


def render_iso(cells, view="iso", size=512, background=None):
    """Isometrica 2:1 ombreggiata di `cells` ({(x,y,z): "#RRGGBB"}).

    Ritorna (buf RGBA, w, h). Il lato del voxel `s` e' pari (meta' altezza del
    rombo intera) e scelto perche' il lato lungo stia in `size` pixel.
    """
    if not cells:
        raise ValueError("niente da disegnare")
    rot = _rot_iso(view)
    pts = {}
    for (x, y, z), col in cells.items():
        xr, zr = rot(x, z)
        pts[(xr, y, zr)] = col
    # Ingombro in unita' di schermo a s = 1.
    umin = min(p[0] - p[2] for p in pts) - 1
    umax = max(p[0] - p[2] for p in pts) + 1
    vmin = min((p[0] + p[2]) * 0.5 - p[1] for p in pts) - 1
    vmax = max((p[0] + p[2]) * 0.5 - p[1] for p in pts) + 1
    span = max(umax - umin, vmax - vmin, 1)
    s = int(max(2, min(48, int(size) // max(1, int(span + 1)))))
    s -= s % 2
    s = max(2, s)
    tile = _tile(s)
    pad = 2
    w = int((umax - umin) * s) + 2 * pad + 2
    h = int((vmax - vmin) * s) + 2 * pad + 2
    ox = -umin * s + pad
    oy = -vmin * s + pad
    color = [None] * (w * h)
    depth = [-1e18] * (w * h)
    owner = [None] * (w * h)
    rgb_cache = {}
    for (xr, y, zr), col in pts.items():
        vis = (((xr, y + 1, zr) not in pts),
               ((xr + 1, y, zr) not in pts),
               ((xr, y, zr + 1) not in pts))
        if not any(vis):
            continue
        rgb = rgb_cache.get(col)
        if rgb is None:
            base = hex_to_rgb(col)
            rgb = rgb_cache[col] = (_shade(base, _SHADE_TOP),
                                    _shade(base, _SHADE_X),
                                    _shade(base, _SHADE_Z))
        bx = int(round((xr - zr) * s + ox))
        by = int(round((xr + zr) * s * 0.5 - y * s + oy))
        d = xr + y + zr
        cell = (xr, y, zr)
        for (dx, dy), face in tile.items():
            if not vis[face]:
                continue
            px, py = bx + dx, by + dy
            if px < 0 or py < 0 or px >= w or py >= h:
                continue
            i = py * w + px
            if d >= depth[i]:
                depth[i] = d
                color[i] = rgb[face]
                owner[i] = cell
    return _outline(color, owner, w, h, _bg(background)), w, h


def render_ortho_shaded(cells, view="front", size=512, background=None):
    """Ortografica a blocchi di `s` pixel per voxel, con contorno di profondita'.

    Le viste e i versi sono quelli di `render_ortho` (exporters.py), cosi'
    `front` qui e la' mostrano la stessa faccia del modello.
    """
    if not cells:
        raise ValueError("niente da disegnare")
    axes = {
        "front": (0, 1, 2, +1),
        "back": (0, 1, 2, -1),
        "right": (2, 1, 0, +1),
        "left": (2, 1, 0, -1),
        "top": (0, 2, 1, +1),
        "bottom": (0, 2, 1, -1),
    }.get(view)
    if axes is None:
        raise ValueError("vista sconosciuta: %s" % view)
    ha, va, da, sign = axes
    keys = list(cells)
    lo = [min(k[a] for k in keys) for a in range(3)]
    hi = [max(k[a] for k in keys) for a in range(3)]
    gw = hi[ha] - lo[ha] + 1
    gh = hi[va] - lo[va] + 1
    best = {}
    for k, col in cells.items():
        u = k[ha] - lo[ha]
        v = k[va] - lo[va]
        dd = k[da] * sign
        cur = best.get((u, v))
        if cur is None or dd > cur[0]:
            best[(u, v)] = (dd, col)
    s = int(max(1, min(48, int(size) // max(gw, gh))))
    pad = 2
    w, h = gw * s + 2 * pad, gh * s + 2 * pad
    color = [None] * (w * h)
    owner = [None] * (w * h)
    dmin = min(e[0] for e in best.values())
    dmax = max(e[0] for e in best.values())
    rng = float(dmax - dmin) or 1.0
    for (u, v), (dd, col) in best.items():
        row = (gh - 1 - v) if va == 1 else v
        # Un filo di nebbia: cio' che sta dietro e' un po' piu' scuro, ed e'
        # l'unico indizio di profondita' che una vista frontale puo' dare.
        rgb = _shade(hex_to_rgb(col), 0.78 + 0.22 * ((dd - dmin) / rng))
        cell = (u, v, dd)
        for yy in range(s):
            base = (pad + row * s + yy) * w + pad + u * s
            for xx in range(s):
                color[base + xx] = rgb
                owner[base + xx] = cell
    return _outline(color, owner, w, h, _bg(background)), w, h


def render_view(cells, view="iso", size=512, background=None):
    """Punto d'ingresso unico: `view` fra `ALL_VIEWS`."""
    view = str(view or "iso").strip().lower()
    if view in ISO_VIEWS:
        return render_iso(cells, view, size, background)
    if view in ORTHO_VIEWS:
        return render_ortho_shaded(cells, view, size, background)
    if view == "sheet":
        return render_sheet(cells, size, background)
    raise ValueError("vista sconosciuta: '%s'. Disponibili: %s"
                     % (view, ", ".join(ALL_VIEWS)))


def render_sheet(cells, size=512, background=None):
    """Le quattro isometriche affiancate, ognuna grande `size`."""
    shots = [render_iso(cells, v, size, background) for v in ISO_VIEWS]
    cw = max(r[1] for r in shots)
    ch = max(r[2] for r in shots)
    tw = cw * len(shots)
    buf = bytearray(tw * ch * 4)
    bg = _bg(background)
    if bg[3]:
        for i in range(0, len(buf), 4):
            buf[i:i + 4] = bytes(bg)
    for n, (sb, sw, sh) in enumerate(shots):
        ox = n * cw + (cw - sw) // 2
        oy = (ch - sh) // 2
        for y in range(sh):
            di = ((oy + y) * tw + ox) * 4
            buf[di:di + sw * 4] = sb[y * sw * 4:(y + 1) * sw * 4]
    return buf, tw, ch


def cells_of(obj):
    """{(x,y,z): colore} di un `VoxelObject`, nella forma che vogliono qui."""
    return {k: c.color for k, c in obj.cells.items()}
