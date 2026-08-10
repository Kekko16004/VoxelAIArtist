"""Esportazione: OBJ/MTL, glTF/GLB, MagicaVoxel .vox, PNG, ZIP.

E' la meta' del "collegarlo ad altri programmi": un modello fatto qui deve
aprirsi in Blender, in un motore di gioco e in MagicaVoxel senza passaggi
manuali. Tre scelte che sembrano dettagli e non lo sono:

1. **OBJ e MTL viaggiano INSIEME, in un ZIP se ci sono texture.** Blender mostra
   materiali bianchi se l'`.mtl` non sta accanto all'`.obj` con lo stesso nome
   dichiarato in `mtllib`. Nel browser il problema e' che i download multipli
   vengono bloccati; qui i file si scrivono su disco, ma l'archivio unico resta
   la forma giusta quando ci sono anche i PNG.

2. **Nel GLB la texture e' incorporata e i materiali sono FrontSide.**
   `DoubleSide` sembra piu' sicuro e invece nasconde il difetto che conta: due
   quad coincidenti guardano in versi OPPOSTI, quindi il backface culling ne
   disegna sempre esattamente uno e lo z-fighting non esiste. Con DoubleSide se
   ne disegnano due e sfarfallano.

3. **`.vox` di MagicaVoxel ha un limite di 256 per lato e 255 colori**, e non e'
   negoziabile: e' il formato. Un modello piu' grande si divide in pezzi
   (`.vox` supporta piu' modelli in un file) e una palette piu' ricca si rimappa
   con `enforce_palette` — che e' meglio di un file che non si apre.

La Y DI MAGICAVOXEL E' LA Z. MagicaVoxel usa Z verso l'alto, l'app Y: senza lo
scambio ogni modello esportato arriva coricato su un fianco. Vale nei due versi.
"""

import json
import struct

from . import png as pngmod
from .materials import material_render_mode
from .meshing import greedy_mesh, quad_uvs
from .palette import enforce_palette, hex_to_rgb, normalize_hex

# --- OBJ / MTL ---------------------------------------------------------------


def _mat_name(token):
    """Nome di materiale valido in un MTL: niente `#`, che li' e' un commento."""
    if token.startswith("@"):
        return "mat_" + token[1:]
    return "col_" + token.lstrip("#")


def build_obj(doc, obj, mtl_name="model.mtl", scale=1.0, origin=None):
    """OBJ testuale. `origin` sposta il modello (di solito il suo centro a terra),
    `scale` porta il voxel a metri — 1 voxel = 1 unita' se resta 1."""
    quads = greedy_mesh(obj.cells)
    ox, oy, oz = origin or (0.0, 0.0, 0.0)
    lines = ["# VoxelAIArtist - export MCP",
             "mtllib " + mtl_name]
    verts, uvs = [], []
    vindex, uindex = {}, {}
    faces_by_mat = {}
    for q in quads:
        idx = []
        for corner, uv in zip(q.corners, quad_uvs(q)):
            p = ((corner[0] - ox) * scale, (corner[1] - oy) * scale,
                 (corner[2] - oz) * scale)
            vi = vindex.get(p)
            if vi is None:
                verts.append(p)
                vi = vindex[p] = len(verts)
            ui = uindex.get(uv)
            if ui is None:
                uvs.append(uv)
                ui = uindex[uv] = len(uvs)
            idx.append((vi, ui))
        faces_by_mat.setdefault(q.token, []).append(idx)

    for v in verts:
        lines.append("v %.6g %.6g %.6g" % v)
    for u in uvs:
        lines.append("vt %.6g %.6g" % u)
    for token, faces in faces_by_mat.items():
        lines.append("usemtl " + _mat_name(token))
        for f in faces:
            lines.append("f " + " ".join("%d/%d" % pair for pair in f))
    return "\n".join(lines) + "\n"


def build_mtl(doc, obj, texture_names=None):
    """MTL. La trasparenza va in `d` (+ `illum 2`), non in `Tr`: sono la stessa
    cosa invertita e i loader la risolvono in modo diverso — lo stesso file
    apparirebbe opaco in uno e invisibile in un altro."""
    texture_names = texture_names or {}
    tokens = sorted({(("@" + c.material) if c.material else c.color)
                     for c in obj.cells.values()})
    out = ["# VoxelAIArtist - export MCP"]
    for token in tokens:
        out.append("newmtl " + _mat_name(token))
        if token.startswith("@"):
            mat = doc.material_by_id(token[1:])
            if mat is None:
                out += ["Kd 0.8 0.8 0.8", "Ka 0 0 0", "Ks 0 0 0", "illum 1", ""]
                continue
            r, g, b = hex_to_rgb(mat.get("color"))
            mode, _at, opacity = material_render_mode(mat)
            out.append("Kd %.4f %.4f %.4f" % (r / 255.0, g / 255.0, b / 255.0))
            out.append("Ks %.4f %.4f %.4f" % ((mat.get("metalness", 0),) * 3))
            out.append("Ns %.1f" % (max(1.0, (1.0 - mat.get("roughness", 0.6)) * 200)))
            png_name = texture_names.get(mat["id"])
            if png_name:
                out.append("map_Kd " + png_name)
                if mode == "mask":
                    out.append("map_d " + png_name)
            if opacity < 1.0:
                out.append("d %.4f" % opacity)
                out.append("illum 2")
            else:
                out.append("illum 1")
        else:
            r, g, b = hex_to_rgb(token)
            out.append("Kd %.4f %.4f %.4f" % (r / 255.0, g / 255.0, b / 255.0))
            out += ["Ka 0 0 0", "Ks 0 0 0", "illum 1"]
        out.append("")
    return "\n".join(out)


def export_obj_bundle(doc, obj, base_name="model", scale=1.0, center=True):
    """[(nome, byte)] con OBJ, MTL e i PNG delle texture usate."""
    origin = None
    if center:
        b = obj.bounds()
        if b:
            origin = ((b[0] + b[3] + 1) / 2.0, b[1], (b[2] + b[5] + 1) / 2.0)
    tex_names = {}
    files = []
    used = {c.material for c in obj.cells.values() if c.material}
    for mid in sorted(x for x in used if x):
        mat = doc.material_by_id(mid)
        if not mat:
            continue
        tex = mat.get("texture") or next(iter((mat.get("faces") or {}).values()), None)
        if not tex:
            continue
        try:
            buf, w, h = pngmod.from_data_url(tex["data"])
        except Exception:                                    # noqa: BLE001
            continue
        name = "%s_%s.png" % (base_name, mid)
        tex_names[mid] = name
        files.append((name, pngmod.encode_png(buf, w, h)))
    mtl_name = base_name + ".mtl"
    files.insert(0, (mtl_name, build_mtl(doc, obj, tex_names).encode("utf-8")))
    files.insert(0, (base_name + ".obj",
                     build_obj(doc, obj, mtl_name, scale, origin).encode("utf-8")))
    return files


# --- glTF / GLB --------------------------------------------------------------

class _GltfBuilder(object):
    """Accumula il blob binario e le tabelle del glTF.

    Esiste per UNA ragione: l'offset nel buffer e' uno stato condiviso fra chi
    scrive gli accessor della mesh e chi scrive i PNG delle texture, e i due si
    alternano (mesh del token, poi la sua texture, poi il token dopo). Tenerlo
    in una variabile passata a funzioni libere significa restituirlo insieme al
    risultato vero a ogni chiamata, e basta dimenticarsene una volta perche' le
    viste successive puntino al punto sbagliato del buffer: il file si apre, si
    valida, e mostra spazzatura. Qui l'offset e' un campo e `_push` l'unico
    modo di far crescere il blob, quindi la coerenza e' per costruzione.

    OGNI SEGMENTO E' ALLINEATO A 4 BYTE. glTF lo pretende per i bufferView con
    un target, e i float e gli indici a 32 bit lo pretendono comunque: un
    accessor a offset dispari e' un file che alcuni loader rifiutano e altri
    leggono storto.
    """

    def __init__(self):
        self.parts = []
        self.offset = 0
        self.buffer_views = []
        self.accessors = []
        self.materials = []
        self.images = []
        self.textures = []
        self.samplers = []
        self.mat_index = {}

    def _push(self, blob, target=None):
        """Aggiunge byte al buffer e ritorna l'indice del bufferView."""
        pad = (-len(blob)) % 4
        self.parts.append(blob + b"\x00" * pad)
        view = {"buffer": 0, "byteOffset": self.offset, "byteLength": len(blob)}
        if target is not None:
            view["target"] = target
        self.buffer_views.append(view)
        self.offset += len(blob) + pad
        return len(self.buffer_views) - 1

    def push_accessor(self, data, fmt, target, comp_type, count, type_name,
                      mins=None, maxs=None):
        view = self._push(struct.pack("<%d%s" % (len(data), fmt), *data), target)
        acc = {"bufferView": view, "componentType": comp_type,
               "count": count, "type": type_name}
        if mins is not None:
            acc["min"], acc["max"] = mins, maxs
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def push_texture(self, tex):
        """Il PNG incorporato -> indice di texture, oppure None se illeggibile.

        Una texture rotta NON deve far fallire l'export: si perde la texture e
        resta la tinta media, che e' esattamente il degrado previsto altrove per
        un materiale orfano.
        """
        try:
            buf, w, h = pngmod.from_data_url(tex["data"])
            data = pngmod.encode_png(buf, w, h)
        except Exception:                                    # noqa: BLE001
            return None
        # Niente `target` sul bufferView di un'immagine: quel campo dichiara un
        # binding di vertici o indici, e alcuni validatori lo segnalano.
        view = self._push(data)
        self.images.append({"bufferView": view, "mimeType": "image/png"})
        if not self.samplers:
            # NEAREST nei due versi: la pixel art interpolata si sfoca, e
            # l'intero punto di questi materiali sono i bordi netti.
            self.samplers.append({"magFilter": 9728, "minFilter": 9728,
                                  "wrapS": 10497, "wrapT": 10497})
        self.textures.append({"source": len(self.images) - 1, "sampler": 0})
        return len(self.textures) - 1

    def material_for(self, doc, token):
        """Indice del materiale per un token, creandolo la prima volta."""
        if token in self.mat_index:
            return self.mat_index[token]
        entry = {"doubleSided": False}
        mat = doc.material_by_id(token[1:]) if token.startswith("@") else None
        if mat is None:
            # Token di colore, oppure id ORFANO: in entrambi i casi tinta unita.
            # E' lo stesso degrado del resto dell'app, ottenuto senza un ramo
            # dedicato a "il materiale non c'e' piu'".
            r, g, b = hex_to_rgb(token if not token.startswith("@") else "#CCCCCC")
            entry["pbrMetallicRoughness"] = {
                "baseColorFactor": [_srgb(r), _srgb(g), _srgb(b), 1.0],
                "metallicFactor": 0.0, "roughnessFactor": 0.9}
            entry["name"] = _mat_name(token)
        else:
            mode, alpha_cutoff, opacity = material_render_mode(mat)
            r, g, b = hex_to_rgb(mat.get("color"))
            pbr = {"baseColorFactor": [_srgb(r), _srgb(g), _srgb(b), opacity],
                   "metallicFactor": float(mat.get("metalness", 0.0)),
                   "roughnessFactor": float(mat.get("roughness", 0.6))}
            tex = (mat.get("texture")
                   or next(iter((mat.get("faces") or {}).values()), None))
            ti = self.push_texture(tex) if tex else None
            if ti is not None:
                pbr["baseColorTexture"] = {"index": ti}
                # Con una texture il fattore va a BIANCO: in glTF il colore
                # finale e' fattore * texel, quindi tenere anche la tinta media
                # la moltiplicherebbe per se stessa e il modello arriverebbe
                # scuro. E' lo stesso inganno dell'invariante 6 su COLOR_0.
                pbr["baseColorFactor"] = [1.0, 1.0, 1.0, opacity]
            entry["pbrMetallicRoughness"] = pbr
            entry["name"] = mat.get("name") or _mat_name(token)
            if mode == "mask":
                entry["alphaMode"] = "MASK"
                entry["alphaCutoff"] = alpha_cutoff
            elif mode == "blend":
                entry["alphaMode"] = "BLEND"
            if mat.get("emissive"):
                e = float(mat["emissive"])
                entry["emissiveFactor"] = [_srgb(r) * e, _srgb(g) * e,
                                           _srgb(b) * e]
        self.materials.append(entry)
        self.mat_index[token] = len(self.materials) - 1
        return self.mat_index[token]

    def blob(self):
        return b"".join(self.parts)


def build_gltf(doc, obj, scale=1.0, center=True):
    """glTF 2.0 come dizionario, piu' il blob binario a cui punta.

    Un modello STATICO: la mesh e' un guscio greedy, un primitivo per materiale.
    Il modello riggato passa da `rig.py`, che ha sei invarianti propri (vedi
    CLAUDE.md) e non si puo' ridurre a questo.
    """
    quads = greedy_mesh(obj.cells)
    ox, oy, oz = (0.0, 0.0, 0.0)
    if center:
        b = obj.bounds()
        if b:
            ox, oy, oz = ((b[0] + b[3] + 1) / 2.0, b[1], (b[2] + b[5] + 1) / 2.0)

    by_token = {}
    for q in quads:
        by_token.setdefault(q.token, []).append(q)

    gb = _GltfBuilder()
    primitives = []
    for token, group in sorted(by_token.items()):
        pos, nrm, uv, idx = [], [], [], []
        for q in group:
            base = len(pos) // 3
            n = q.normal
            for corner, tuv in zip(q.corners, quad_uvs(q)):
                pos += [(corner[0] - ox) * scale, (corner[1] - oy) * scale,
                        (corner[2] - oz) * scale]
                nrm += [float(n[0]), float(n[1]), float(n[2])]
                # V si capovolge: glTF ha l'origine UV in basso a sinistra,
                # le nostre texture in alto a sinistra (convenzione immagine).
                uv += [tuv[0], q.uh - tuv[1]]
            idx += [base, base + 1, base + 2, base, base + 2, base + 3]

        count = len(pos) // 3
        a_pos = gb.push_accessor(
            pos, "f", 34962, 5126, count, "VEC3",
            [min(pos[0::3]), min(pos[1::3]), min(pos[2::3])],
            [max(pos[0::3]), max(pos[1::3]), max(pos[2::3])])
        a_nrm = gb.push_accessor(nrm, "f", 34962, 5126, count, "VEC3")
        a_uv = gb.push_accessor(uv, "f", 34962, 5126, count, "VEC2")
        a_idx = gb.push_accessor(idx, "I", 34963, 5125, len(idx), "SCALAR")
        primitives.append({
            "attributes": {"POSITION": a_pos, "NORMAL": a_nrm,
                           "TEXCOORD_0": a_uv},
            "indices": a_idx,
            "material": gb.material_for(doc, token),
        })

    blob = gb.blob()
    gltf = {
        "asset": {"version": "2.0", "generator": "VoxelAIArtist MCP"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": obj.name}],
        "meshes": [{"name": obj.name, "primitives": primitives}],
        "bufferViews": gb.buffer_views,
        "accessors": gb.accessors,
        "materials": gb.materials or [{"pbrMetallicRoughness": {
            "baseColorFactor": [0.8, 0.8, 0.8, 1.0]}}],
    }
    # Un `buffers` con byteLength 0 e' invalido: su un oggetto vuoto si omette
    # tutto il blocco binario invece di dichiararne uno che non c'e'.
    if blob:
        gltf["buffers"] = [{"byteLength": len(blob)}]
    else:
        for key in ("bufferViews", "accessors"):
            gltf.pop(key, None)
    if gb.images:
        gltf["images"] = gb.images
        gltf["textures"] = gb.textures
        gltf["samplers"] = gb.samplers
    return gltf, blob


def _srgb(v):
    """sRGB 0..255 -> lineare 0..1. glTF vuole il LINEARE: passare il valore
    sRGB direttamente rende ogni colore visibilmente piu' chiaro, ed e' l'errore
    piu' comune in un esportatore scritto a mano."""
    c = v / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def pack_glb(gltf, blob):
    """Incornicia un glTF + il suo blob in un GLB.

    Sta a se' e non dentro `build_glb` perche' ha DUE chiamanti: il modello
    statico qui sotto e quello riggato in `rig.py`, che costruisce un glTF
    diverso (ossa, skin, animazioni) ma la stessa cornice. Duplicare queste
    dieci righe vorrebbe dire due punti dove sbagliare un allineamento a 4 byte
    o una lunghezza totale, e un GLB con l'intestazione sbagliata non si apre
    da nessuna parte senza dire perche'.
    """
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    blob += b"\x00" * ((-len(blob)) % 4)
    total = 12 + 8 + len(js) + (8 + len(blob) if blob else 0)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    if blob:
        out += struct.pack("<II", len(blob), 0x004E4942) + blob
    return bytes(out)


def build_glb(doc, obj, scale=1.0, center=True):
    """Il glTF impacchettato in un solo file binario."""
    gltf, blob = build_gltf(doc, obj, scale, center)
    return pack_glb(gltf, blob)


# --- MagicaVoxel .vox --------------------------------------------------------

VOX_MAX_SIDE = 256
VOX_MAX_COLORS = 255


def build_vox(doc, obj):
    """`.vox` di MagicaVoxel.

    Y e Z si SCAMBIANO (vedi docstring del modulo). La palette e' di 255 colori
    piu' l'indice 0 riservato al vuoto: oltre, si rimappa col piu' vicino invece
    di troncare, cosi' il modello resta riconoscibile.
    """
    b = obj.bounds()
    if not b:
        raise ValueError("l'oggetto e' vuoto")
    sx, sy, sz = (b[3] - b[0] + 1, b[4] - b[1] + 1, b[5] - b[2] + 1)
    if max(sx, sy, sz) > VOX_MAX_SIDE:
        raise ValueError(
            "MagicaVoxel non supporta lati oltre %d (questo modello e' %dx%dx%d). "
            "Riduci con lo strumento di scala o esporta in OBJ/GLB."
            % (VOX_MAX_SIDE, sx, sy, sz))

    counts = obj.color_counts()
    colors = list(counts.keys())
    remap = {}
    if len(colors) > VOX_MAX_COLORS:
        keep = colors[:VOX_MAX_COLORS]
        remap = enforce_palette(colors, keep)
        colors = keep
    index = {c: i + 1 for i, c in enumerate(colors)}

    voxels = bytearray()
    n = 0
    for (x, y, z), cell in obj.cells.items():
        c = remap.get(cell.color, cell.color)
        # x, z, y: la Y dell'app e' la Z di MagicaVoxel.
        voxels += bytes((x - b[0], z - b[2], y - b[1], index.get(c, 1)))
        n += 1

    palette = bytearray()
    for i in range(256):
        if i < len(colors):
            r, g, b_ = hex_to_rgb(colors[i])
            palette += bytes((r, g, b_, 255))
        else:
            palette += bytes((0, 0, 0, 255))

    def chunk(tag, content, children=b""):
        return (tag + struct.pack("<II", len(content), len(children))
                + content + children)

    size = chunk(b"SIZE", struct.pack("<III", sx, sz, sy))
    xyzi = chunk(b"XYZI", struct.pack("<I", n) + bytes(voxels))
    rgba = chunk(b"RGBA", bytes(palette))
    main = chunk(b"MAIN", b"", size + xyzi + rgba)
    return b"VOX " + struct.pack("<I", 150) + main


# --- PNG: sprite e fogli -----------------------------------------------------

def render_ortho(obj, view="front", scale=1, background=None):
    """Una proiezione ortografica del modello -> buffer RGBA.

    Non e' un render: e' una proiezione a pittore, il voxel piu' vicino vince,
    con un'ombreggiatura per faccia. Serve a due cose vere — un'anteprima che un
    client MCP puo' guardare senza aprire la GUI, e le sprite di uno sprite
    stack. Un raytracer darebbe un'immagine piu' bella e nessuna delle due.
    """
    b = obj.bounds()
    if not b:
        raise ValueError("l'oggetto e' vuoto")
    view = str(view or "front").lower()
    # (asse orizzontale, asse verticale, asse di profondita', verso)
    axes = {
        "front":  (0, 1, 2, +1),
        "back":   (0, 1, 2, -1),
        "right":  (2, 1, 0, +1),
        "left":   (2, 1, 0, -1),
        "top":    (0, 2, 1, +1),
        "bottom": (0, 2, 1, -1),
    }.get(view)
    if axes is None:
        raise ValueError("vista sconosciuta: %s (usa front/back/left/right/top/bottom)"
                         % view)
    ha, va, da, sign = axes
    lo = (b[0], b[1], b[2])
    hi = (b[3], b[4], b[5])
    w = hi[ha] - lo[ha] + 1
    h = hi[va] - lo[va] + 1

    best = {}
    for key, cell in obj.cells.items():
        u = key[ha] - lo[ha]
        v = key[va] - lo[va]
        depth = key[da] * sign
        cur = best.get((u, v))
        if cur is None or depth > cur[0]:
            best[(u, v)] = (depth, cell)

    buf = bytearray(w * h * 4)
    bg = normalize_hex(background, None)
    if bg:
        r, g, b_ = hex_to_rgb(bg)
        for i in range(0, len(buf), 4):
            buf[i:i + 4] = bytes((r, g, b_, 255))
    for (u, v), (_d, cell) in best.items():
        # La riga 0 dell'immagine e' in ALTO, la y del modello cresce verso
        # l'alto: senza il capovolgimento ogni anteprima esce a testa in giu'.
        row = (h - 1 - v) if va == 1 else v
        r, g, b_ = hex_to_rgb(cell.color)
        i = (row * w + u) * 4
        buf[i:i + 4] = bytes((r, g, b_, 255))
    if scale > 1:
        buf = pngmod.scale_nearest(buf, w, h, w * scale, h * scale)
        w, h = w * scale, h * scale
    return buf, w, h


def sprite_sheet(obj, views=None, scale=1, background=None):
    """Piu' viste affiancate in una sola immagine, tutte della STESSA cella.

    Le celle sono di dimensione uniforme (la piu' grande) e ogni vista e'
    centrata nella sua: un foglio con celle di dimensioni diverse non e'
    utilizzabile da un motore di gioco, che le indicizza per moltiplicazione.
    """
    views = views or ["front", "right", "back", "left"]
    rendered = [render_ortho(obj, v, 1, None) for v in views]
    cw = max(r[1] for r in rendered)
    ch = max(r[2] for r in rendered)
    total_w, total_h = cw * len(rendered), ch
    buf = bytearray(total_w * total_h * 4)
    bg = normalize_hex(background, None)
    if bg:
        r, g, b_ = hex_to_rgb(bg)
        for i in range(0, len(buf), 4):
            buf[i:i + 4] = bytes((r, g, b_, 255))
    for n, (sbuf, sw, sh) in enumerate(rendered):
        ox = n * cw + (cw - sw) // 2
        oy = (ch - sh) // 2
        for y in range(sh):
            di = ((oy + y) * total_w + ox) * 4
            si = y * sw * 4
            buf[di:di + sw * 4] = sbuf[si:si + sw * 4]
    if scale > 1:
        buf = pngmod.scale_nearest(buf, total_w, total_h,
                                   total_w * scale, total_h * scale)
        total_w, total_h = total_w * scale, total_h * scale
    return buf, total_w, total_h


def ascii_preview(obj, view="front", width=48):
    """Il modello come testo: e' l'anteprima che un client MCP puo' VEDERE.

    Un PNG in una risposta MCP e' base64 e costa migliaia di token; questa
    griglia costa poche centinaia e dice l'unica cosa che serve quasi sempre
    ("la forma e' quella giusta?"). I caratteri sono ordinati per densita', cosi'
    la luminosita' del colore diventa il peso del segno.
    """
    from .palette import luminance
    b = obj.bounds()
    if not b:
        return "(vuoto)"
    buf, w, h = render_ortho(obj, view, 1, None)
    step = max(1, (w + width - 1) // width)
    ramp = " .:-=+*#%@"
    lines = []
    for y in range(0, h, step):
        row = []
        for x in range(0, w, step):
            i = (y * w + x) * 4
            if buf[i + 3] < 8:
                row.append(" ")
                continue
            lum = luminance("#%02X%02X%02X" % (buf[i], buf[i + 1], buf[i + 2]))
            row.append(ramp[min(len(ramp) - 1, int(lum * (len(ramp) - 1)) + 1)])
        lines.append("".join(row))
    return "\n".join(lines)
