"""Gli esportatori dell'MCP, verificati RILEGGENDO cio' che scrivono.

Non basta che una funzione ritorni dei byte senza sollevare: un GLB con gli
offset sbagliati si apre, si valida come JSON e mostra spazzatura. Quindi qui
ogni formato viene riaperto e confrontato con il modello di partenza:

- il GLB si smonta a mano (intestazione, chunk, bufferView) e i float si
  rileggono dal blob: e' l'unico modo di accorgersi di un offset spostato;
- lo `.vox` si ripercorre chunk per chunk e i voxel si riconvertono in
  coordinate dell'app, cosi' uno scambio Y/Z mancato si vede;
- l'OBJ si riconta faccia per faccia contro il mesher.

Niente rete, niente Pillow obbligatorio, niente cookie.
"""

import json
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp_server import png as pngmod                              # noqa: E402
from mcp_server.document import Cell, Document                    # noqa: E402
from mcp_server.exporters import (ascii_preview, build_glb, build_gltf,  # noqa: E402
                                  build_obj, build_vox, export_obj_bundle,
                                  render_ortho, sprite_sheet)
from mcp_server.materials import texture_from_buffer              # noqa: E402
from mcp_server.meshing import greedy_mesh, mesh_stats            # noqa: E402
from mcp_server.zipfile_min import build_zip                      # noqa: E402

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if not cond:
        FAILURES.append("%s%s" % (label, (" -- " + detail) if detail else ""))
        print("  FAIL  %s %s" % (label, detail))
    else:
        print("  ok    %s" % label)


def sample_doc():
    """Un modello piccolo ma non banale: due colori, un materiale con texture,
    un buco (per avere facce interne) e una forma asimmetrica su tutti e tre gli
    assi, cosi' un asse scambiato si nota."""
    doc = Document()
    obj = doc.active
    obj.grid_size = (16, 16, 16)
    with doc.edit("costruisci"):
        for x in range(4):
            for y in range(3):
                for z in range(2):
                    doc.set_cell(obj, (x, y, z), Cell("#FF0000", None, None))
        # Un pilastro di un altro colore, spostato: rompe la simmetria su Y.
        for y in range(3, 6):
            doc.set_cell(obj, (0, y, 0), Cell("#00FF00", None, None))
        # Una cella texturizzata isolata.
        doc.set_cell(obj, (3, 0, 3), Cell("#3366CC", "m1", None))

    buf = bytearray()
    for i in range(4 * 4):
        buf += bytes((0x33, 0x66, 0xCC, 255 if i % 3 else 0))
    doc.materials.append({
        "id": "m1", "name": "Pietra", "faceMode": "single",
        "color": "#3366CC", "roughness": 0.6, "metalness": 0.0,
        "emissive": 0.0, "opacity": 1.0,
        "uv": {"repeat": 1, "offsetU": 0, "offsetV": 0, "rotation": 0},
        "texture": texture_from_buffer(buf, 4, 4),
    })
    return doc, obj


# --- OBJ / MTL ---------------------------------------------------------------

def test_obj(doc, obj):
    files = dict(export_obj_bundle(doc, obj, "prova"))
    check("OBJ: i tre file previsti",
          set(files) == {"prova.obj", "prova.mtl", "prova_m1.png"},
          repr(sorted(files)))

    text = files["prova.obj"].decode("utf-8")
    quads = greedy_mesh(obj.cells)
    f_lines = [l for l in text.splitlines() if l.startswith("f ")]
    check("OBJ: una faccia per quad", len(f_lines) == len(quads),
          "%d facce, %d quad" % (len(f_lines), len(quads)))
    check("OBJ: dichiara mtllib", "mtllib prova.mtl" in text)

    v_lines = [l for l in text.splitlines() if l.startswith("v ")]
    vt_lines = [l for l in text.splitlines() if l.startswith("vt ")]
    # Ogni indice citato da una faccia deve esistere: un fuori-range e' il modo
    # in cui un OBJ scritto a mano si apre vuoto invece di dare errore.
    max_v = max_vt = 0
    for line in f_lines:
        for pair in line.split()[1:]:
            vi, ui = pair.split("/")
            max_v = max(max_v, int(vi))
            max_vt = max(max_vt, int(ui))
    check("OBJ: indici dei vertici entro il range",
          1 <= max_v <= len(v_lines), "max %d su %d" % (max_v, len(v_lines)))
    check("OBJ: indici UV entro il range",
          1 <= max_vt <= len(vt_lines), "max %d su %d" % (max_vt, len(vt_lines)))
    check("OBJ: gli indici partono da 1, non da 0", " 0/" not in text)

    mtl = files["prova.mtl"].decode("utf-8")
    check("MTL: un newmtl per token",
          mtl.count("newmtl ") == len({(("@" + c.material) if c.material else c.color)
                                       for c in obj.cells.values()}))
    check("MTL: il materiale texturizzato punta al PNG",
          "map_Kd prova_m1.png" in mtl)
    check("MTL: nessun '#' in un nome di materiale (li' e' un commento)",
          not any(l.startswith("newmtl") and "#" in l for l in mtl.splitlines()))
    # La texture ha texel a alpha 0 -> modalita' 'mask' -> map_d.
    check("MTL: alpha nella texture -> map_d", "map_d prova_m1.png" in mtl)

    png = files["prova_m1.png"]
    buf, w, h = pngmod.decode_png(png)
    check("MTL: il PNG accanto e' quello del materiale", (w, h) == (4, 4),
          "%dx%d" % (w, h))


# --- glTF / GLB --------------------------------------------------------------

def test_gltf(doc, obj):
    gltf, blob = build_gltf(doc, obj, scale=1.0, center=True)

    check("glTF: dichiara la lunghezza vera del buffer",
          gltf["buffers"][0]["byteLength"] == len(blob),
          "%d vs %d" % (gltf["buffers"][0]["byteLength"], len(blob)))

    # LA VERIFICA CHE CONTA: ogni bufferView deve stare DENTRO il blob e i
    # segmenti non devono sovrapporsi. Un offset spostato di quattro byte
    # produce un file che si valida e si vede rotto.
    spans = []
    for i, view in enumerate(gltf["bufferViews"]):
        start = view["byteOffset"]
        end = start + view["byteLength"]
        check("glTF: bufferView %d dentro il buffer" % i, end <= len(blob),
              "%d..%d su %d" % (start, end, len(blob)))
        check("glTF: bufferView %d allineato a 4" % i, start % 4 == 0,
              "offset %d" % start)
        spans.append((start, end, i))
    spans.sort()
    overlap = [(a, b) for (s0, e0, a), (s1, _e1, b) in zip(spans, spans[1:])
               if e0 > s1]
    check("glTF: nessuna sovrapposizione fra bufferView", not overlap,
          repr(overlap))

    # I dati riletti dal blob devono essere i vertici veri.
    prim = gltf["meshes"][0]["primitives"][0]
    acc = gltf["accessors"][prim["attributes"]["POSITION"]]
    view = gltf["bufferViews"][acc["bufferView"]]
    raw = blob[view["byteOffset"]:view["byteOffset"] + view["byteLength"]]
    floats = struct.unpack("<%df" % (len(raw) // 4), raw)
    check("glTF: POSITION ha count * 3 float",
          len(floats) == acc["count"] * 3,
          "%d float, count %d" % (len(floats), acc["count"]))
    xs = floats[0::3]
    ys = floats[1::3]
    zs = floats[2::3]
    check("glTF: min/max dichiarati corrispondono ai dati",
          [round(v, 5) for v in acc["min"]] ==
          [round(min(xs), 5), round(min(ys), 5), round(min(zs), 5)],
          "%r vs %r" % (acc["min"], (min(xs), min(ys), min(zs))))

    # Il centraggio si misura sul MODELLO INTERO, non su un primitivo: i
    # primitivi sono uno per token e ordinati per token, quindi il primo e' il
    # pilastro verde, che comincia legittimamente a mezz'aria.
    all_min = [min(gltf["accessors"][p["attributes"]["POSITION"]]["min"][i]
                   for p in gltf["meshes"][0]["primitives"]) for i in range(3)]
    all_max = [max(gltf["accessors"][p["attributes"]["POSITION"]]["max"][i]
                   for p in gltf["meshes"][0]["primitives"]) for i in range(3)]
    check("glTF: con center=True il modello poggia a y=0",
          abs(all_min[1]) < 1e-6, "min y = %r" % all_min[1])
    check("glTF: con center=True il modello e' centrato su X",
          abs(all_min[0] + all_max[0]) < 1e-6,
          "x da %r a %r" % (all_min[0], all_max[0]))
    check("glTF: con center=True il modello e' centrato su Z",
          abs(all_min[2] + all_max[2]) < 1e-6,
          "z da %r a %r" % (all_min[2], all_max[2]))

    # Gli indici devono puntare a vertici che esistono.
    iacc = gltf["accessors"][prim["indices"]]
    iview = gltf["bufferViews"][iacc["bufferView"]]
    iraw = blob[iview["byteOffset"]:iview["byteOffset"] + iview["byteLength"]]
    indices = struct.unpack("<%dI" % (len(iraw) // 4), iraw)
    pos_count = gltf["accessors"][prim["attributes"]["POSITION"]]["count"]
    check("glTF: ogni indice punta a un vertice esistente",
          max(indices) < pos_count,
          "max %d su %d vertici" % (max(indices), pos_count))
    check("glTF: due triangoli per quad",
          len(indices) % 6 == 0 and iacc["count"] == len(indices))

    # Il PNG incorporato deve essere rileggibile ESATTAMENTE all'offset
    # dichiarato: e' il punto in cui l'offset condiviso fra mesh e texture
    # sbagliava, e il sintomo sarebbe una texture invisibile in Blender.
    check("glTF: c'e' una immagine incorporata", len(gltf.get("images", [])) == 1)
    img_view = gltf["bufferViews"][gltf["images"][0]["bufferView"]]
    img_raw = bytes(blob[img_view["byteOffset"]:
                         img_view["byteOffset"] + img_view["byteLength"]])
    check("glTF: l'offset dell'immagine punta a un PNG vero",
          img_raw.startswith(b"\x89PNG\r\n\x1a\n"), repr(img_raw[:8]))
    ibuf, iw, ih = pngmod.decode_png(img_raw)
    check("glTF: il PNG incorporato ha le dimensioni giuste", (iw, ih) == (4, 4))
    check("glTF: bufferView di un'immagine senza 'target'",
          "target" not in img_view)

    # Invarianti di materiale.
    mats = gltf["materials"]
    check("glTF: nessun materiale doubleSided (vedi invariante 5)",
          all(m.get("doubleSided") is False for m in mats))
    tex_mat = [m for m in mats
               if "baseColorTexture" in m.get("pbrMetallicRoughness", {})]
    check("glTF: un materiale con texture", len(tex_mat) == 1)
    check("glTF: col texture il baseColorFactor e' BIANCO (niente colore^2)",
          tex_mat[0]["pbrMetallicRoughness"]["baseColorFactor"][:3]
          == [1.0, 1.0, 1.0],
          repr(tex_mat[0]["pbrMetallicRoughness"]["baseColorFactor"]))
    check("glTF: texture con alpha -> alphaMode MASK",
          tex_mat[0].get("alphaMode") == "MASK",
          repr(tex_mat[0].get("alphaMode")))
    check("glTF: il campionatore e' NEAREST nei due versi",
          gltf["samplers"][0]["magFilter"] == 9728
          and gltf["samplers"][0]["minFilter"] == 9728)

    # Il rosso puro in lineare non e' 1.0 sul canale rosso? lo e'; ma il verde
    # di #00FF00 deve stare a 0 sui canali r,b. Il controllo vero e' che un
    # grigio medio NON sia passato attraverso: sRGB 0x80 -> ~0.216 lineare.
    from mcp_server.exporters import _srgb
    check("glTF: la conversione sRGB->lineare e' applicata",
          abs(_srgb(128) - 0.2158) < 0.001, "%r" % _srgb(128))


def test_glb(doc, obj):
    data = build_glb(doc, obj)
    magic, version, total = struct.unpack("<III", data[:12])
    check("GLB: magic 'glTF'", magic == 0x46546C67)
    check("GLB: versione 2", version == 2)
    check("GLB: la lunghezza dichiarata e' quella vera",
          total == len(data), "%d vs %d" % (total, len(data)))

    pos = 12
    chunks = []
    while pos < len(data):
        clen, ctype = struct.unpack("<II", data[pos:pos + 8])
        chunks.append((ctype, data[pos + 8:pos + 8 + clen]))
        check("GLB: chunk allineato a 4", clen % 4 == 0, "len %d" % clen)
        pos += 8 + clen
    check("GLB: consumato esattamente fino alla fine", pos == len(data),
          "%d vs %d" % (pos, len(data)))
    check("GLB: due chunk (JSON + BIN)", len(chunks) == 2)
    check("GLB: il primo chunk e' JSON", chunks[0][0] == 0x4E4F534A)
    check("GLB: il secondo chunk e' BIN", chunks[1][0] == 0x004E4942)

    gltf = json.loads(chunks[0][1].decode("utf-8"))
    blob = chunks[1][1]
    check("GLB: il JSON si rilegge", gltf["asset"]["version"] == "2.0")
    # Il chunk BIN e' riempito a 4: il buffer dichiarato puo' essere piu' corto,
    # mai piu' lungo.
    declared = gltf["buffers"][0]["byteLength"]
    check("GLB: il buffer dichiarato sta nel chunk BIN",
          declared <= len(blob) and len(blob) - declared < 4,
          "%d dichiarati, %d nel chunk" % (declared, len(blob)))
    for view in gltf["bufferViews"]:
        end = view["byteOffset"] + view["byteLength"]
        check("GLB: bufferView entro il chunk BIN", end <= len(blob),
              "%d su %d" % (end, len(blob)))


def part_doc():
    """Due cubi adiacenti, due parti: il caso pressure-plate / leva.

    Se il mesher vede TUTTO insieme, la faccia di contatto sparisce e in
    Unity i due pezzi sono saldati. Meshando per parte, quella faccia resta.
    """
    doc = Document()
    obj = doc.active
    obj.name = "Leva"
    obj.grid_size = (16, 16, 16)
    with doc.edit("parti"):
        for x in range(3):
            for z in range(3):
                doc.set_cell(obj, (x, 0, z), Cell("#886644", None, "base"))
        for y in range(1, 4):
            doc.set_cell(obj, (1, y, 1), Cell("#CCCCCC", None, "leva"))
    return doc, obj


def test_obj_parts():
    doc, obj = part_doc()
    text = build_obj(doc, obj, "leva.mtl")
    names = [l[2:] for l in text.splitlines() if l.startswith("o ")]
    check("OBJ parti: due oggetti nominati",
          set(names) == {"base", "leva"}, repr(names))
    base_cells = {k: c for k, c in obj.cells.items() if c.part == "base"}
    leva_cells = {k: c for k, c in obj.cells.items() if c.part == "leva"}
    together = greedy_mesh(obj.cells)
    split_quads = greedy_mesh(base_cells) + greedy_mesh(leva_cells)
    # Area del tetto della base (y=1). Da sola e' 3x3=9; fusa con la leva
    # il centro e' sepolto e restano 8. Quelle 9 celle sono la faccia di
    # contatto: senza, in Unity la leva e' saldata al basamento.
    def top_area(quads):
        return sum(q.uw * q.uh for q in quads if q.face == "py"
                   and all(abs(c[1] - 1) < 1e-9 for c in q.corners))
    check("OBJ parti: la base tiene il tetto intero (contatto con la leva)",
          top_area(greedy_mesh(base_cells)) == 9,
          "area tetto = %s (fusa sarebbe %s)"
          % (top_area(greedy_mesh(base_cells)), top_area(together)))
    f_lines = [l for l in text.splitlines() if l.startswith("f ")]
    check("OBJ parti: le facce sono quelle separate, non le fuse",
          len(f_lines) == len(split_quads),
          "%d facce, attese %d (fuse sarebbero %d)"
          % (len(f_lines), len(split_quads), len(together)))


def test_gltf_parts():
    doc, obj = part_doc()
    gltf, _blob = build_gltf(doc, obj, scale=1.0, center=True)
    mesh_names = [m["name"] for m in gltf["meshes"]]
    check("glTF parti: una mesh per parte",
          set(mesh_names) == {"base", "leva"}, repr(mesh_names))
    check("glTF parti: un nodo radice tiene i figli",
          "children" in gltf["nodes"][0], repr(gltf["nodes"][0]))
    child_names = [gltf["nodes"][i]["name"] for i in gltf["nodes"][0]["children"]]
    check("glTF parti: i figli si chiamano come le parti",
          set(child_names) == {"base", "leva"}, repr(child_names))
    # Il centraggio si misura sull'UNIONE: ogni mesh e' un pezzo, il primo
    # da solo non poggia a terra al centro.
    mins = []
    maxs = []
    for mesh in gltf["meshes"]:
        for p in mesh["primitives"]:
            acc = gltf["accessors"][p["attributes"]["POSITION"]]
            mins.append(acc["min"])
            maxs.append(acc["max"])
    all_min = [min(m[i] for m in mins) for i in range(3)]
    all_max = [max(m[i] for m in maxs) for i in range(3)]
    check("glTF parti: il modello intero poggia a y=0",
          abs(all_min[1]) < 1e-6, "min y = %r" % all_min[1])
    check("glTF parti: centrato su X",
          abs(all_min[0] + all_max[0]) < 1e-6,
          "x da %r a %r" % (all_min[0], all_max[0]))


def test_gltf_untextured():
    """Un modello senza materiali: il percorso in cui non si scrive nessuna
    immagine. Serve a controllare che l'offset non si sposti comunque."""
    doc = Document()
    obj = doc.active
    with doc.edit("cubo"):
        doc.set_cell(obj, (0, 0, 0), Cell("#FFFFFF", None, None))
    gltf, blob = build_gltf(doc, obj)
    check("glTF senza texture: nessuna immagine", "images" not in gltf)
    check("glTF senza texture: un cubo = 6 quad",
          len(gltf["meshes"][0]["primitives"]) == 1)
    acc = gltf["accessors"][
        gltf["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    check("glTF senza texture: 24 vertici (4 per faccia)", acc["count"] == 24,
          "%d" % acc["count"])
    end = max(v["byteOffset"] + v["byteLength"] for v in gltf["bufferViews"])
    check("glTF senza texture: il blob copre tutte le viste", end <= len(blob))


def test_gltf_orphan_material():
    """Un id di materiale che non esiste piu'. Deve degradare a tinta unita,
    non sollevare: e' lo stesso degrado del resto dell'app."""
    doc = Document()
    obj = doc.active
    with doc.edit("orfano"):
        doc.set_cell(obj, (0, 0, 0), Cell("#123456", "sparito", None))
    gltf, _blob = build_gltf(doc, obj)
    check("glTF: id orfano -> nessuna texture", "images" not in gltf)
    factor = gltf["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"]
    check("glTF: id orfano -> tinta grigia di riserva",
          abs(factor[0] - factor[1]) < 1e-9 and abs(factor[1] - factor[2]) < 1e-9,
          repr(factor))


# --- MagicaVoxel -------------------------------------------------------------

def test_vox(doc, obj):
    data = build_vox(doc, obj)
    check("VOX: firma", data[:4] == b"VOX ")
    check("VOX: versione 150", struct.unpack("<I", data[4:8])[0] == 150)

    # Si ripercorrono i chunk figli di MAIN.
    pos = 8
    tag = data[pos:pos + 4]
    clen, chlen = struct.unpack("<II", data[pos + 4:pos + 12])
    check("VOX: il primo chunk e' MAIN", tag == b"MAIN")
    check("VOX: MAIN ha contenuto vuoto e figli", clen == 0 and chlen > 0)
    pos += 12
    end = pos + chlen
    found = {}
    while pos < end:
        tag = data[pos:pos + 4]
        clen, chlen = struct.unpack("<II", data[pos + 4:pos + 12])
        found[tag] = data[pos + 12:pos + 12 + clen]
        pos += 12 + clen + chlen
    check("VOX: SIZE, XYZI e RGBA presenti",
          set(found) == {b"SIZE", b"XYZI", b"RGBA"}, repr(sorted(found)))

    b = obj.bounds()
    sx, sy, sz = (b[3] - b[0] + 1, b[4] - b[1] + 1, b[5] - b[2] + 1)
    vsx, vsy, vsz = struct.unpack("<III", found[b"SIZE"])
    # LA VERIFICA DELLO SCAMBIO: la Y dell'app e' la Z di MagicaVoxel.
    check("VOX: SIZE con Y e Z scambiati", (vsx, vsy, vsz) == (sx, sz, sy),
          "vox %r, modello %r" % ((vsx, vsy, vsz), (sx, sy, sz)))

    n = struct.unpack("<I", found[b"XYZI"][:4])[0]
    check("VOX: un voxel per cella", n == len(obj.cells),
          "%d vs %d" % (n, len(obj.cells)))
    body = found[b"XYZI"][4:]
    check("VOX: quattro byte per voxel", len(body) == n * 4)

    palette = found[b"RGBA"]
    check("VOX: la palette e' di 256 voci", len(palette) == 1024)

    # Si riconvertono i voxel in coordinate dell'app e si confronta il colore.
    rebuilt = {}
    for i in range(n):
        vx, vz, vy, idx = body[i * 4:i * 4 + 4]
        key = (vx + b[0], vy + b[1], vz + b[2])
        pi = (idx - 1) * 4
        rebuilt[key] = "#%02X%02X%02X" % (palette[pi], palette[pi + 1],
                                          palette[pi + 2])
    check("VOX: le coordinate si riconvertono esattamente",
          set(rebuilt) == set(obj.cells),
          "%d ricostruiti, %d originali" % (len(rebuilt), len(obj.cells)))
    wrong = [k for k, c in rebuilt.items() if obj.cells[k].color != c]
    check("VOX: ogni voxel riporta il suo colore", not wrong,
          "%d sbagliati" % len(wrong))
    check("VOX: l'indice 0 resta riservato al vuoto",
          all(body[i * 4 + 3] >= 1 for i in range(n)))


def test_vox_limits():
    doc = Document()
    obj = doc.active
    obj.grid_size = (512, 512, 512)
    with doc.edit("lungo"):
        doc.set_cell(obj, (0, 0, 0), Cell("#FFFFFF", None, None))
        doc.set_cell(obj, (300, 0, 0), Cell("#FFFFFF", None, None))
    try:
        build_vox(doc, obj)
        check("VOX: oltre 256 di lato solleva con un messaggio", False,
              "non ha sollevato")
    except ValueError as exc:
        check("VOX: oltre 256 di lato solleva con un messaggio",
              "256" in str(exc), str(exc))


# --- immagini ----------------------------------------------------------------

def test_render(obj):
    b = obj.bounds()
    buf, w, h = render_ortho(obj, "front")
    check("render: larghezza e altezza dal bounding box",
          (w, h) == (b[3] - b[0] + 1, b[4] - b[1] + 1), "%dx%d" % (w, h))

    def px(x, y):
        i = (y * w + x) * 4
        return tuple(buf[i:i + 4])

    # Il pilastro verde e' a x=0 e arriva fino a y=5, cioe' la RIGA 0 (in alto).
    check("render: la riga 0 e' la cima del modello (non capovolto)",
          px(0, 0)[:3] == (0x00, 0xFF, 0x00), repr(px(0, 0)))
    check("render: la base e' rossa", px(1, h - 1)[:3] == (0xFF, 0x00, 0x00),
          repr(px(1, h - 1)))
    # Dove non c'e' modello resta trasparente, non nero.
    check("render: il vuoto e' trasparente, non nero", px(3, 0)[3] == 0,
          repr(px(3, 0)))

    buf2, w2, h2 = render_ortho(obj, "front", scale=3)
    check("render: scala intera moltiplica le dimensioni",
          (w2, h2) == (w * 3, h * 3))

    try:
        render_ortho(obj, "diagonale")
        check("render: una vista sconosciuta solleva", False)
    except ValueError as exc:
        check("render: una vista sconosciuta solleva", "diagonale" in str(exc))

    sbuf, sw, sh = sprite_sheet(obj, ["front", "right", "back", "left"])
    check("sprite sheet: celle uniformi e larghezza multipla",
          sw % 4 == 0 and len(sbuf) == sw * sh * 4,
          "%dx%d" % (sw, sh))
    cell_w = sw // 4
    check("sprite sheet: la cella e' larga quanto la vista piu' larga",
          cell_w >= w, "cella %d, vista %d" % (cell_w, w))

    art = ascii_preview(obj, "front", 40)
    check("ascii: una riga per riga di modello",
          len(art.splitlines()) == h, "%d righe, h=%d" % (len(art.splitlines()), h))
    check("ascii: non e' tutto vuoto", art.strip() != "")


def test_empty_object():
    doc = Document()
    obj = doc.active
    check("vuoto: ascii_preview non solleva", ascii_preview(obj) == "(vuoto)")
    for fn, name in ((build_vox, "build_vox"), (render_ortho, "render_ortho")):
        try:
            fn(doc, obj) if fn is build_vox else fn(obj)
            check("vuoto: %s solleva invece di dare byte insensati" % name, False)
        except ValueError:
            check("vuoto: %s solleva invece di dare byte insensati" % name, True)


# --- ZIP ---------------------------------------------------------------------

def test_zip(doc, obj):
    files = export_obj_bundle(doc, obj, "prova")
    data = build_zip(files)
    check("ZIP: firma locale", data[:4] == b"PK\x03\x04")
    check("ZIP: fine dell'archivio centrale", b"PK\x05\x06" in data)

    # Si rilegge con la stdlib: e' la prova che un estrattore vero lo apre.
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        bad = zf.testzip()
        check("ZIP: nessun CRC sbagliato", bad is None, repr(bad))
        names = zf.namelist()
        check("ZIP: gli stessi nomi", names == [n for n, _ in files], repr(names))
        for name, payload in files:
            check("ZIP: %s identico all'originale" % name,
                  zf.read(name) == bytes(payload))
        for info in zf.infolist():
            check("ZIP: %s in modalita' store" % info.filename,
                  info.compress_type == zipfile.ZIP_STORED)
            check("ZIP: %s dichiara il nome in UTF-8" % info.filename,
                  info.flag_bits & 0x800)

    # Riproducibilita': senza timestamp due archivi devono essere identici.
    check("ZIP: senza timestamp l'output e' riproducibile",
          build_zip(files) == data)
    check("ZIP: le barre rovesciate diventano '/'",
          b"cartella/f.txt" in build_zip([("cartella\\f.txt", b"x")]))


def test_stats(obj):
    st = mesh_stats(obj.cells)
    check("stats: conta i voxel", st["voxels"] == len(obj.cells))
    check("stats: i visibili non superano il totale",
          st["visible"] <= st["voxels"])
    check("stats: due triangoli per quad", st["triangles"] == st["quads"] * 2)
    check("stats: il greedy unisce davvero (meno quad delle facce singole)",
          st["quads"] < st["voxels"] * 6,
          "%d quad, %d voxel" % (st["quads"], st["voxels"]))


def main():
    print("== Esportatori MCP ==")
    doc, obj = sample_doc()
    test_obj(doc, obj)
    test_gltf(doc, obj)
    test_glb(doc, obj)
    test_obj_parts()
    test_gltf_parts()
    test_gltf_untextured()
    test_gltf_orphan_material()
    test_vox(doc, obj)
    test_vox_limits()
    test_render(obj)
    test_empty_object()
    test_zip(doc, obj)
    test_stats(obj)

    print("\n%d controlli, %d falliti" % (CHECKS[0], len(FAILURES)))
    if FAILURES:
        for f in FAILURES:
            print("  - " + f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
