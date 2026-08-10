"""Importazione: MagicaVoxel .vox, OBJ (con voxelizzazione), PNG, glTF/GLB.

E' l'altra meta' del "collegarlo ad altri programmi". Esportare e' facile: si
decide la forma dei byte. Importare significa accettare cio' che ha scritto
qualcun altro, e i file veri sono piu' vari di quanto un formato prometta.

TRE COSE CHE NON SI VEDONO LEGGENDO UNA SPECIFICA.

1. **Un `.vox` puo' NON avere il chunk RGBA.** In quel caso i colori sono quelli
   della palette PREDEFINITA di MagicaVoxel, che e' una tabella precisa: se la si
   inventa, il modello si importa con colori completamente sbagliati e sembra un
   difetto del file. `VOX_DEFAULT_PALETTE` qui sotto la genera esatta (216 colori
   del cubo 6x6x6 piu' quattro rampe da dieci), non approssimata.

2. **Un OBJ non contiene voxel.** Contiene triangoli, e riportarli a voxel e'
   una scelta, non una conversione. Si campiona la SUPERFICIE (il guscio), non il
   volume: riempire l'interno richiede sapere cosa sia "dentro" per una mesh che
   puo' essere aperta, e su una mesh aperta ogni algoritmo di riempimento sbaglia.
   Chi vuole il pieno lo ottiene dopo, con un'operazione che sa di essere
   un'operazione.

3. **La Y di MagicaVoxel e' la Z**, nei due versi. Vale all'import come
   all'export: senza lo scambio ogni modello arriva coricato su un fianco.

Gli import NON aprono una sessione di modifica: ritornano `{(x,y,z): Cell}` e
chi chiama decide se e' un oggetto nuovo, una fusione o un rimpiazzo. Cosi' lo
stesso lettore serve a "apri" e a "incolla dentro questo modello".
"""

import base64
import json
import math
import struct

from . import png as pngmod
from .document import Cell
from .palette import rgb_to_hex

# --- MagicaVoxel .vox --------------------------------------------------------


def _build_vox_default_palette():
    """La palette predefinita di MagicaVoxel, generata ESATTA.

    Indicizzata come il chunk RGBA: l'elemento `i` e' il colore dell'indice
    `i + 1` dei voxel (nel formato l'indice 0 e' il vuoto e non ha colore).

    **Il cubo da' 215 colori, non 216: il NERO non c'e'.** La tabella vera ha
    256 posizioni di cui la prima e' il vuoto, quindi ne restano 255 per i
    colori: 215 di cubo piu' 40 di rampa. Generare tutte e 216 le combinazioni
    sembra giusto (6^3 = 216) e sposta di uno TUTTE le quaranta rampe, cioe' i
    grigi e i colori saturi — che e' proprio la parte di palette che un modello
    senza chunk RGBA usa di piu'. Verificato voce per voce contro la specifica
    di ephtracy.

    Il cubo scorre il BLU per primo e il rosso per ultimo, sui livelli
    255/204/153/102/51/0; le rampe sono quattro da dieci (rosso, verde, blu,
    grigio) sui livelli 0xEE..0x11, che saltano i multipli di 0x33 perche'
    quelli sono gia' nel cubo.
    """
    levels = (255, 204, 153, 102, 51, 0)
    pal = []
    for r in levels:
        for g in levels:
            for b in levels:
                pal.append((r, g, b))
    pal.pop()                       # (0, 0, 0): vedi il docstring
    ramp = (0xEE, 0xDD, 0xBB, 0xAA, 0x88, 0x77, 0x55, 0x44, 0x22, 0x11)
    for v in ramp:
        pal.append((v, 0, 0))
    for v in ramp:
        pal.append((0, v, 0))
    for v in ramp:
        pal.append((0, 0, v))
    for v in ramp:
        pal.append((v, v, v))
    # 255 colori. La 256esima posizione non e' un colore: esiste solo perche'
    # un indice 0 (il vuoto) arriverebbe qui come (0 - 1) & 0xFF = 255, e un
    # file malformato non deve far sollevare l'importatore.
    pal.append((204, 204, 204))
    return pal


VOX_DEFAULT_PALETTE = _build_vox_default_palette()


def read_vox(blob):
    """`.vox` -> [{'name', 'cells', 'size'}], un elemento per modello.

    Si ritornano TUTTI i modelli, non solo il primo: un `.vox` multi-modello e'
    il modo normale di distribuire un set di blocchi, e importarne uno solo
    perde silenziosamente il resto (e' il limite dichiarato dell'importatore
    della GUI). Chi ne vuole uno prende `[0]`.
    """
    if len(blob) < 8 or blob[:4] != b"VOX ":
        raise ValueError("non e' un file .vox di MagicaVoxel")
    models = []
    found = {}

    def walk(pos, end):
        while pos + 12 <= end:
            tag = blob[pos:pos + 4]
            n_content, n_children = struct.unpack("<ii", blob[pos + 4:pos + 12])
            content = pos + 12
            children = content + n_content
            nxt = children + n_children
            if tag == b"MAIN":
                walk(children, nxt)
            elif tag == b"SIZE":
                sx, sy, sz = struct.unpack("<iii", blob[content:content + 12])
                models.append({"size": (sx, sy, sz), "vox": []})
            elif tag == b"XYZI":
                count = struct.unpack("<i", blob[content:content + 4])[0]
                body = blob[content + 4:content + 4 + count * 4]
                items = [tuple(body[i * 4:i * 4 + 4]) for i in range(count)]
                if models:
                    models[-1]["vox"] = items
                else:
                    models.append({"size": None, "vox": items})
            elif tag == b"RGBA":
                # In un dizionario e non in una variabile: un assegnamento qui
                # dentro sarebbe LOCALE a `walk`, quindi silenziosamente inutile,
                # e il file si importerebbe con la palette predefinita pur
                # avendone una propria.
                raw = blob[content:content + 1024]
                found["palette"] = [(raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2])
                                    for i in range(256)]
            pos = nxt

    walk(8, len(blob))
    palette = found.get("palette") or VOX_DEFAULT_PALETTE
    if not models:
        raise ValueError("il file .vox non contiene modelli")

    out = []
    for n, m in enumerate(models):
        cells = {}
        for vx, vy, vz, ci in m["vox"]:
            r, g, b = palette[(ci - 1) & 0xFF]
            # Inverso dell'export: vox(x, y, z) -> app(x, z, y).
            cells[(vx, vz, vy)] = Cell(rgb_to_hex(r, g, b), None, None)
        size = m["size"]
        out.append({
            "name": "Modello %d" % (n + 1),
            "cells": cells,
            # Anche la dimensione si riordina, o un modello alto verrebbe
            # descritto come largo.
            "size": (size[0], size[2], size[1]) if size else None,
        })
    return out


# --- OBJ ---------------------------------------------------------------------

def read_obj(text, mtl_text=None, resolution=64, fill=False):
    """OBJ -> celle, campionando la superficie dei triangoli.

    `resolution` e' il lato piu' lungo del risultato in voxel: e' l'unico
    parametro che conta davvero, perche' un OBJ e' in unita' arbitrarie (metri,
    centimetri, pollici) e non c'e' modo di indovinarle. 64 e' la scelta di
    partenza perche' e' la griglia piu' comune dell'app.

    Il campionamento e' per AREA, non per vertice: un triangolo grande con tre
    vertici lontani lascerebbe tre voxel isolati e un guscio bucato. Si passa
    sui due assi baricentrici a passo mezzo voxel, che e' la condizione perche'
    non restino fori (il criterio di Nyquist applicato a una griglia).
    """
    colors = _parse_mtl(mtl_text) if mtl_text else {}
    verts = []
    faces = []                                   # (indici, nome materiale)
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        kind = parts[0]
        if kind == "v" and len(parts) >= 4:
            try:
                verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError:
                continue
        elif kind == "usemtl":
            current = parts[1] if len(parts) > 1 else None
        elif kind == "f" and len(parts) >= 4:
            idx = []
            for token in parts[1:]:
                head = token.split("/")[0]
                try:
                    i = int(head)
                except ValueError:
                    idx = []
                    break
                # Un indice NEGATIVO conta dalla fine: e' nello standard e i
                # programmi che esportano a flusso lo usano, quindi ignorarlo
                # significa importare un modello vuoto da quei file.
                idx.append(i - 1 if i > 0 else len(verts) + i)
            if len(idx) >= 3:
                faces.append((idx, current))
    if not verts or not faces:
        raise ValueError("l'OBJ non contiene geometria leggibile")

    xs = [v[0] for v in verts]
    ys = [v[1] for v in verts]
    zs = [v[2] for v in verts]
    span = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
    if span <= 0:
        raise ValueError("l'OBJ e' degenere (tutti i vertici coincidono)")
    res = max(2, int(resolution))
    k = (res - 1) / span
    origin = (min(xs), min(ys), min(zs))

    def to_voxel(p):
        return (int(round((p[0] - origin[0]) * k)),
                int(round((p[1] - origin[1]) * k)),
                int(round((p[2] - origin[2]) * k)))

    cells = {}
    for idx, mat in faces:
        color = colors.get(mat, "#CCCCCC")
        # Un poligono di n lati si triangola a ventaglio dal primo vertice: e'
        # corretto per un poligono convesso, e un OBJ non convesso e' raro
        # abbastanza da non giustificare un tassellatore.
        for t in range(1, len(idx) - 1):
            try:
                a, b, c = verts[idx[0]], verts[idx[t]], verts[idx[t + 1]]
            except IndexError:
                continue
            _sample_triangle(cells, a, b, c, to_voxel, color, k)
    if fill:
        cells = _fill_interior(cells)
    return cells


def _sample_triangle(cells, a, b, c, to_voxel, color, k):
    """Riempie i voxel toccati da un triangolo."""
    ab = math.dist(a, b) * k
    ac = math.dist(a, c) * k
    steps = max(2, int(math.ceil(max(ab, ac) * 2)))
    inv = 1.0 / steps
    for i in range(steps + 1):
        u = i * inv
        # Il secondo passo si accorcia con il primo: sul bordo del triangolo
        # (u vicino a 1) restano pochi punti da campionare, e passarci sopra a
        # passo pieno costerebbe steps^2 campioni per ogni triangolo.
        rows = max(1, int(math.ceil((1.0 - u) * steps)))
        for j in range(rows + 1):
            v = (1.0 - u) * (j / float(rows))
            w = 1.0 - u - v
            if w < 0:
                continue
            p = (a[0] * w + b[0] * u + c[0] * v,
                 a[1] * w + b[1] * u + c[1] * v,
                 a[2] * w + b[2] * u + c[2] * v)
            cells.setdefault(to_voxel(p), Cell(color, None, None))


def _fill_interior(cells):
    """Riempie l'interno del guscio, per PIANI e a partire da FUORI.

    Un flood dal centro presuppone che il centro sia dentro; un flood
    dall'esterno non presuppone nulla e cio' che non raggiunge e' interno per
    definizione. Su una mesh aperta il riempimento cola fuori dal buco e non
    riempie niente — che e' il comportamento giusto: meglio un modello cavo che
    un blocco solido dove c'era un vaso.
    """
    if not cells:
        return cells
    keys = list(cells)
    x0 = min(k[0] for k in keys) - 1
    x1 = max(k[0] for k in keys) + 1
    y0 = min(k[1] for k in keys) - 1
    y1 = max(k[1] for k in keys) + 1
    z0 = min(k[2] for k in keys) - 1
    z1 = max(k[2] for k in keys) + 1
    outside = set()
    stack = [(x0, y0, z0)]
    while stack:
        p = stack.pop()
        if p in outside or p in cells:
            continue
        if not (x0 <= p[0] <= x1 and y0 <= p[1] <= y1 and z0 <= p[2] <= z1):
            continue
        outside.add(p)
        x, y, z = p
        stack += [(x + 1, y, z), (x - 1, y, z), (x, y + 1, z),
                  (x, y - 1, z), (x, y, z + 1), (x, y, z - 1)]
    out = dict(cells)
    # Il colore dell'interno e' quello del voxel di guscio piu' vicino sull'asse
    # X: un interno grigio si vedrebbe appena si taglia il modello.
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            for z in range(z0, z1 + 1):
                p = (x, y, z)
                if p in out or p in outside:
                    continue
                out[p] = _nearest_shell_color(cells, p)
    return out


def _nearest_shell_color(cells, p):
    x, y, z = p
    for d in range(1, 64):
        for q in ((x + d, y, z), (x - d, y, z), (x, y + d, z),
                  (x, y - d, z), (x, y, z + d), (x, y, z - d)):
            cell = cells.get(q)
            if cell is not None:
                return cell
    return Cell("#CCCCCC", None, None)


def _parse_mtl(text):
    """MTL -> {nome materiale: hex}. Serve solo `Kd`: il resto (speculare,
    rugosita', mappe) non ha un posto in un voxel, che porta un colore."""
    out = {}
    name = None
    for raw in (text or "").splitlines():
        parts = raw.strip().split()
        if not parts:
            continue
        if parts[0] == "newmtl" and len(parts) > 1:
            name = parts[1]
        elif parts[0] == "Kd" and len(parts) >= 4 and name:
            try:
                r, g, b = (float(parts[1]), float(parts[2]), float(parts[3]))
            except ValueError:
                continue
            out[name] = rgb_to_hex(int(round(r * 255)), int(round(g * 255)),
                                   int(round(b * 255)))
    return out


# --- PNG ---------------------------------------------------------------------

def read_png_flat(blob, thickness=1, plane="xy"):
    """Un PNG -> una lastra di voxel spessa `thickness`.

    La riga 0 di un'immagine e' quella IN ALTO, la y 0 di un voxel e' in BASSO:
    senza il ribaltamento ogni sprite entra capovolto. E' lo stesso scambio che
    fa il renderer in export, in senso opposto.

    I pixel trasparenti non diventano voxel neri: non diventano niente. La
    soglia e' 8 come altrove, perche' un PNG salvato da un editor lascia spesso
    alfa 1..4 dove intendeva 0.
    """
    buf, w, h = pngmod.decode_png(blob)
    depth = max(1, int(thickness))
    cells = {}
    for iy in range(h):
        for ix in range(w):
            i = (iy * w + ix) * 4
            if buf[i + 3] < 8:
                continue
            color = rgb_to_hex(buf[i], buf[i + 1], buf[i + 2])
            y = h - 1 - iy
            for d in range(depth):
                if plane == "xz":
                    cells[(ix, d, y)] = Cell(color, None, None)
                else:
                    cells[(ix, y, d)] = Cell(color, None, None)
    if not cells:
        raise ValueError("il PNG e' interamente trasparente")
    return cells


def read_png_stack(blob, frames, cols=None, bottom_first=True):
    """Sprite stack: un foglio di `frames` fotogrammi -> un modello 3D.

    Ogni fotogramma e' una FETTA ORIZZONTALE (il piano XZ a una certa altezza),
    non un fotogramma d'animazione: e' cosi' che si distribuiscono i modelli
    voxel come singolo PNG. I fotogrammi si leggono in ordine di lettura (per
    righe), e `bottom_first` dice se il primo e' la fetta piu' bassa o la piu'
    alta — le due convenzioni esistono entrambe in natura e sbagliarla capovolge
    il modello senza che nulla segnali un errore.

    Dentro una fetta la riga 0 e' il RETRO (z minore), non l'alto: una fetta
    orizzontale non ha un alto e un basso, ha un davanti e un dietro.
    """
    n = max(1, int(frames))
    buf, w, h = pngmod.decode_png(blob)
    ncols = int(cols) if cols else n
    ncols = max(1, min(ncols, n))
    nrows = (n + ncols - 1) // ncols
    if w % ncols or h % nrows:
        raise ValueError(
            "il foglio %dx%d non si divide in %dx%d fotogrammi interi"
            % (w, h, ncols, nrows))
    fw, fh = w // ncols, h // nrows
    cells = {}
    for f in range(n):
        ox = (f % ncols) * fw
        oy = (f // ncols) * fh
        y = f if bottom_first else n - 1 - f
        for iy in range(fh):
            for ix in range(fw):
                i = ((oy + iy) * w + ox + ix) * 4
                if buf[i + 3] < 8:
                    continue
                cells[(ix, y, iy)] = Cell(
                    rgb_to_hex(buf[i], buf[i + 1], buf[i + 2]), None, None)
    if not cells:
        raise ValueError("lo sprite stack e' interamente trasparente")
    return cells


# --- glTF / GLB --------------------------------------------------------------

_COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
         5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_gltf(blob, resolution=64, fill=False):
    """glTF o GLB -> celle, voxelizzando i triangoli.

    Due trappole che fanno importare un modello sbagliato senza un errore.

    1. **Le trasformazioni dei nodi vanno applicate.** In glTF la geometria e' in
       spazio locale e la posa sta sui nodi; ignorarla accatasta ogni pezzo
       nell'origine, il che assomiglia a un modello "esploso" ma e' un modello
       privo di scena. Si compone la matrice lungo tutta la gerarchia.

    2. **`baseColorFactor` e' LINEARE.** Preso com'e' da' colori troppo scuri —
       l'errore speculare a quello che l'esportatore evita convertendo in
       lineare. Qui si riconverte in sRGB.

    Le pelli e le animazioni non si applicano: si importa la posa di RIPOSO, che
    e' la forma in cui un modello si modifica. La posa e' un'altra cosa e ha i
    suoi strumenti.
    """
    doc, bins = _gltf_chunks(blob)
    nodes = doc.get("nodes") or []
    meshes = doc.get("meshes") or []
    mats = doc.get("materials") or []

    tris = []                                    # (a, b, c, hex)
    seen = set()

    def visit(index, parent):
        if index in seen or index >= len(nodes):
            return
        seen.add(index)
        node = nodes[index]
        world = _mat_mul(parent, _node_matrix(node))
        mi = node.get("mesh")
        if mi is not None and mi < len(meshes):
            _gltf_mesh_tris(doc, bins, meshes[mi], mats, world, tris)
        for child in node.get("children") or []:
            visit(child, world)
        seen.discard(index)

    scenes = doc.get("scenes") or []
    roots = []
    si = doc.get("scene", 0)
    if scenes and si < len(scenes):
        roots = scenes[si].get("nodes") or []
    if not roots:
        # Senza una scena dichiarata si prendono tutti i nodi di primo livello,
        # cioe' quelli che nessuno elenca come figlio: un glTF senza `scenes` e'
        # legale e alcuni esportatori lo producono.
        children = {c for n in nodes for c in (n.get("children") or [])}
        roots = [i for i in range(len(nodes)) if i not in children]
    for r in roots:
        visit(r, None)
    if not tris:
        raise ValueError("il glTF non contiene triangoli leggibili")

    pts = [p for t in tris for p in t[:3]]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    zs = [p[2] for p in pts]
    span = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
    if span <= 0:
        raise ValueError("il glTF e' degenere (tutti i vertici coincidono)")
    res = max(2, int(resolution))
    k = (res - 1) / span
    origin = (min(xs), min(ys), min(zs))

    def to_voxel(p):
        return (int(round((p[0] - origin[0]) * k)),
                int(round((p[1] - origin[1]) * k)),
                int(round((p[2] - origin[2]) * k)))

    cells = {}
    for a, b, c, color in tris:
        _sample_triangle(cells, a, b, c, to_voxel, color, k)
    if fill:
        cells = _fill_interior(cells)
    return cells


def _gltf_chunks(blob):
    """Ritorna (documento JSON, {indice buffer: byte}). Accetta GLB e .gltf."""
    if blob[:4] == b"glTF":
        if len(blob) < 12:
            raise ValueError("GLB troncato")
        doc = None
        bin_chunk = None
        pos = 12
        while pos + 8 <= len(blob):
            length, kind = struct.unpack("<II", blob[pos:pos + 8])
            body = blob[pos + 8:pos + 8 + length]
            if kind == 0x4E4F534A:
                doc = json.loads(body.decode("utf-8"))
            elif kind == 0x004E4942 and bin_chunk is None:
                bin_chunk = body
            pos += 8 + length + ((-length) % 4)
        if doc is None:
            raise ValueError("GLB senza blocco JSON")
        bins = {0: bin_chunk} if bin_chunk is not None else {}
    else:
        text = blob.decode("utf-8") if isinstance(blob, (bytes, bytearray)) else blob
        doc = json.loads(text)
        bins = {}
    for i, buf in enumerate(doc.get("buffers") or []):
        if i in bins and bins[i] is not None:
            continue
        uri = buf.get("uri") or ""
        if uri.startswith("data:"):
            comma = uri.find(",")
            bins[i] = base64.b64decode(uri[comma + 1:])
        elif uri:
            # Un buffer in un file a fianco non si puo' leggere da un blob: e'
            # meglio dirlo che importare un modello a meta'.
            raise ValueError("il glTF rimanda al file esterno '%s': "
                             "usa un GLB o incorpora i buffer" % uri)
    return doc, bins


def _accessor(doc, bins, index):
    acc = (doc.get("accessors") or [])[index]
    if "sparse" in acc:
        raise ValueError("accessor sparse non supportato")
    n = _NCOMP.get(acc["type"])
    fmt, size = _COMP.get(acc["componentType"], (None, 0))
    if not n or not fmt:
        raise ValueError("accessor glTF di tipo ignoto")
    count = acc["count"]
    if "bufferView" not in acc:
        return [(0,) * n] * count
    view = (doc.get("bufferViews") or [])[acc["bufferView"]]
    data = bins.get(view.get("buffer", 0))
    if data is None:
        raise ValueError("il glTF cita un buffer che non c'e'")
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    # `byteStride` non e' un dettaglio: un accessor interlacciato letto a passo
    # compatto da' vertici presi da meta' di un altro attributo, cioe' geometria
    # plausibile e sbagliata.
    stride = view.get("byteStride") or (size * n)
    out = []
    for i in range(count):
        off = base + i * stride
        out.append(struct.unpack_from("<" + fmt * n, data, off))
    return out


def _gltf_mesh_tris(doc, bins, mesh, mats, world, tris):
    for prim in mesh.get("primitives") or []:
        if prim.get("mode", 4) != 4:
            continue                             # solo TRIANGLES
        attrs = prim.get("attributes") or {}
        if "POSITION" not in attrs:
            continue
        pos = _accessor(doc, bins, attrs["POSITION"])
        pts = [_mat_apply(world, p) for p in pos]
        if "indices" in prim:
            idx = [v[0] for v in _accessor(doc, bins, prim["indices"])]
        else:
            idx = list(range(len(pts)))
        color = _gltf_color(mats, prim.get("material"))
        for t in range(0, len(idx) - 2, 3):
            try:
                tris.append((pts[idx[t]], pts[idx[t + 1]], pts[idx[t + 2]],
                             color))
            except IndexError:
                continue


def _gltf_color(mats, index):
    if index is None or index >= len(mats):
        return "#CCCCCC"
    pbr = (mats[index] or {}).get("pbrMetallicRoughness") or {}
    f = pbr.get("baseColorFactor") or [1.0, 1.0, 1.0, 1.0]
    return rgb_to_hex(*[_unsrgb(v) for v in f[:3]])


def _unsrgb(v):
    """Lineare 0..1 -> sRGB 0..255. Inverso esatto di `_srgb` in exporters.py:
    le due devono restare una l'inversa dell'altra, o un giro export-import
    schiarisce i colori a ogni passaggio."""
    c = max(0.0, min(1.0, float(v)))
    s = c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055
    return int(round(s * 255))


def _node_matrix(node):
    if "matrix" in node:
        m = node["matrix"]
        # glTF elenca le matrici per COLONNE; qui si tengono per righe, quindi
        # si traspone. Senza, rotazione e traslazione si scambiano di posto.
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = node.get("translation") or [0, 0, 0]
    q = node.get("rotation") or [0, 0, 0, 1]
    s = node.get("scale") or [1, 1, 1]
    x, y, z, w = q
    rot = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    return [[rot[r][c] * s[c] for c in range(3)] + [t[r]] for r in range(3)] + \
           [[0.0, 0.0, 0.0, 1.0]]


def _mat_mul(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return [[sum(a[r][i] * b[i][c] for i in range(4)) for c in range(4)]
            for r in range(4)]


def _mat_apply(m, p):
    if m is None:
        return (p[0], p[1], p[2])
    return tuple(m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3]
                 for r in range(3))
