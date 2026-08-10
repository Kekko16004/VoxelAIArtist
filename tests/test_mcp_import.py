"""Prove degli importatori: `.vox`, OBJ, PNG, sprite stack, glTF/GLB.

Il criterio e' il GIRO COMPLETO, non "la funzione ritorna qualcosa". Gli
esportatori sono gia' verificati byte per byte da `test_mcp_export.py`, quindi
si possono usare come sorgente di file veri: si esporta un modello noto, lo si
rilegge e si pretende **lo stesso insieme di celle e gli stessi colori**. Un
errore di assi, un indice di palette fuori di uno o una conversione di colore
sbagliata non sopravvivono a un giro; sopravvivono benissimo a un controllo che
guarda solo se il risultato e' non vuoto.

Per i formati che NON sono voxel (OBJ triangolato, glTF) il giro non puo' essere
esatto — si campiona un guscio a una risoluzione scelta — quindi li' si misura
cio' che deve valere comunque: il numero di pezzi, l'ingombro, i colori
presenti, il verso degli assi.
"""

import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp_server import exporters, importers          # noqa: E402
from mcp_server import png as pngmod                 # noqa: E402
from mcp_server.document import Cell, Document, VoxelObject   # noqa: E402

_ok = 0
_fail = []


def check(label, cond, detail=""):
    global _ok
    if cond:
        _ok += 1
    else:
        _fail.append("%s%s" % (label, (" -- " + detail) if detail else ""))


def check_eq(label, got, want):
    check(label, got == want, "atteso %r, ottenuto %r" % (want, got))


def sample_doc():
    """Modello asimmetrico sui tre assi: una simmetria nasconderebbe uno scambio.

    Il blocco rosso e' 4x3x2 (tre lati diversi), il pilastro verde sta in ALTO
    (y 3..6) e ARRETRATO (z=4), il dado blu e' solo a X massimo. Ognuna delle tre
    coordinate ha quindi una firma diversa, e scambiarne due si vede.
    """
    cells = {}
    for x in range(4):
        for y in range(3):
            for z in range(2):
                cells[(x, y, z)] = Cell("#FF0000")
    for y in range(3, 7):
        cells[(1, y, 4)] = Cell("#00FF00")
    cells[(6, 0, 0)] = Cell("#0000FF")
    doc = Document("Prova")
    obj = VoxelObject("Base", cells)
    doc.objects = [obj]
    doc.active_index = 0
    return doc, obj


# --- .vox --------------------------------------------------------------------

def test_vox_roundtrip():
    doc, obj = sample_doc()
    blob = exporters.build_vox(doc, obj)
    models = importers.read_vox(blob)
    check_eq(".vox: un modello", len(models), 1)
    cells = models[0]["cells"]
    check_eq(".vox: stesse celle", set(cells), set(obj.cells))
    same = all(cells[k].color == obj.cells[k].color for k in obj.cells)
    check(".vox: stessi colori", same)
    # La firma degli assi: se X e Z si scambiassero, il dado blu finirebbe a
    # z=6 invece che a x=6 e questo controllo cadrebbe.
    check(".vox: il dado blu resta a x massimo",
          max(k[0] for k in cells) == 6 and cells[(6, 0, 0)].color == "#0000FF")
    check(".vox: il pilastro verde resta in alto",
          max(k[1] for k in cells) == 6 and cells[(1, 6, 4)].color == "#00FF00")
    size = models[0]["size"]
    check(".vox: dimensione riordinata in coordinate app", size == (7, 7, 5),
          "ottenuto %r" % (size,))


def test_vox_default_palette():
    """La palette predefinita, confrontata con la specifica di ephtracy.

    I valori attesi sono TRASCRITTI dalla specifica, non ricalcolati con la
    stessa formula del codice: un controllo che rigenera la tabella con la
    logica che deve verificare passa qualunque cosa faccia quella logica.

    Il punto che conta e' il confine fra il cubo e le rampe. Il cubo da' 215
    colori (il nero non c'e': la posizione 0 e' il vuoto), e generarne 216
    sposta di uno tutte le rampe — che e' l'errore che questa prova ha trovato.
    """
    pal = importers.VOX_DEFAULT_PALETTE
    check_eq("palette: 256 posizioni", len(pal), 256)
    # Voci prese dalla specifica: default_palette[1..4], cioe' pal[0..3].
    check_eq("palette: le prime voci sono quelle della specifica", pal[:4],
             [(255, 255, 255), (255, 255, 204), (255, 255, 153), (255, 255, 102)])
    # Il confine: default_palette[216] e' l'ultimo del cubo, [217] il primo
    # della rampa rossa. Con 216 colori di cubo qui ci sarebbe un nero.
    check_eq("palette: l'ultimo del cubo (indice 215) e' blu scuro",
             pal[214], (0, 0, 51))
    check_eq("palette: la rampa rossa comincia all'indice 216", pal[215],
             (238, 0, 0))
    # E la coda: default_palette[255] = 0xff111111.
    check_eq("palette: l'ultimo colore vero e' il grigio 0x11", pal[254],
             (17, 17, 17))
    check_eq("palette: 215 colori distinti nel cubo", len(set(pal[:215])), 215)
    check("palette: il nero non e' nel cubo", (0, 0, 0) not in pal[:215])
    check("palette: nessuna voce fuori 0..255",
          all(0 <= c <= 255 for v in pal for c in v))

    # Fabbrico un .vox a mano SENZA RGBA e verifico che il colore venga dalla
    # tabella, non da un grigio di ripiego.
    def chunk(tag, content, children=b""):
        return (tag + struct.pack("<ii", len(content), len(children))
                + content + children)
    body = chunk(b"SIZE", struct.pack("<iii", 2, 2, 2))
    body += chunk(b"XYZI", struct.pack("<i", 2)
                  + bytes((0, 0, 0, 1)) + bytes((1, 0, 0, 216)))
    blob = b"VOX " + struct.pack("<i", 150) + chunk(b"MAIN", b"", body)
    got = importers.read_vox(blob)[0]["cells"]
    check_eq("vox senza RGBA: l'indice 1 e' bianco",
             got[(0, 0, 0)].color, "#FFFFFF")
    check_eq("vox senza RGBA: l'indice 216 e' il primo rosso della rampa",
             got[(1, 0, 0)].color, "#EE0000")


def test_vox_multi_model():
    """Un .vox multi-modello si legge TUTTO, non solo il primo."""
    def chunk(tag, content, children=b""):
        return (tag + struct.pack("<ii", len(content), len(children))
                + content + children)
    body = b""
    for n in range(3):
        body += chunk(b"SIZE", struct.pack("<iii", 2, 2, 2))
        body += chunk(b"XYZI", struct.pack("<i", 1) + bytes((n, 0, 0, n + 1)))
    blob = b"VOX " + struct.pack("<i", 150) + chunk(b"MAIN", b"", body)
    models = importers.read_vox(blob)
    check_eq("vox multi: tre modelli", len(models), 3)
    check("vox multi: ognuno col suo voxel",
          [list(m["cells"])[0] for m in models] == [(0, 0, 0), (1, 0, 0), (2, 0, 0)])
    check("vox multi: nomi distinti",
          len({m["name"] for m in models}) == 3)


def test_vox_rejects_junk():
    for label, blob in (("vuoto", b""), ("firma sbagliata", b"NOPE" + b"\x00" * 40)):
        try:
            importers.read_vox(blob)
            check("vox: rifiuta %s" % label, False, "non ha sollevato")
        except ValueError:
            check("vox: rifiuta %s" % label, True)


# --- OBJ ---------------------------------------------------------------------

def test_obj_roundtrip():
    """OBJ non e' un formato voxel: il giro e' approssimato per costruzione.

    Si misura quindi l'ingombro e i colori, non l'insieme esatto delle celle. La
    risoluzione si sceglie pari al lato piu' lungo del modello, cosi' un voxel
    esportato torna circa un voxel.
    """
    doc, obj = sample_doc()
    files = exporters.export_obj_bundle(doc, obj, "prova", center=False)
    names = {n for n, _ in files}
    check("obj: il pacchetto ha .obj e .mtl",
          any(n.endswith(".obj") for n in names)
          and any(n.endswith(".mtl") for n in names))
    text = [b for n, b in files if n.endswith(".obj")][0].decode("utf-8")
    mtl = [b for n, b in files if n.endswith(".mtl")][0].decode("utf-8")

    cells = importers.read_obj(text, mtl, resolution=8)
    check("obj: qualcosa e' stato importato", len(cells) > 0)
    xs = [k[0] for k in cells]
    ys = [k[1] for k in cells]
    zs = [k[2] for k in cells]
    # Il modello e' 7x7x5 voxel; a risoluzione 8 il lato piu' lungo diventa
    # 0..7, e gli altri due si accorciano in proporzione. Il controllo utile e'
    # che le PROPORZIONI si conservino: uno scambio di assi le altererebbe.
    check("obj: la X resta il lato piu' lungo",
          max(xs) - min(xs) >= max(zs) - min(zs))
    check("obj: l'ingombro Y e' quasi pari a quello X",
          abs((max(ys) - min(ys)) - (max(xs) - min(xs))) <= 1,
          "x=%d y=%d" % (max(xs) - min(xs), max(ys) - min(ys)))
    got = {c.color for c in cells.values()}
    check("obj: i tre colori sopravvivono", {"#FF0000", "#00FF00", "#0000FF"} <= got,
          "ottenuti %r" % sorted(got))


def test_obj_negative_indices():
    """Gli indici negativi contano dalla fine: sono nello standard."""
    text = ("v 0 0 0\nv 1 0 0\nv 0 1 0\n"
            "f -3 -2 -1\n")
    cells = importers.read_obj(text, resolution=4)
    check("obj: indici negativi letti", len(cells) > 0)


def test_obj_fill():
    """`fill=True` riempie un guscio CHIUSO e lascia stare uno APERTO."""
    # Un cubo chiuso 1x1x1 in unita' OBJ, sei facce.
    v = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
         (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    faces = [(1, 2, 3, 4), (5, 6, 7, 8), (1, 2, 6, 5),
             (2, 3, 7, 6), (3, 4, 8, 7), (4, 1, 5, 8)]
    text = "".join("v %d %d %d\n" % p for p in v)
    closed = text + "".join("f %d %d %d %d\n" % f for f in faces)
    hollow = importers.read_obj(closed, resolution=9, fill=False)
    solid = importers.read_obj(closed, resolution=9, fill=True)
    check("obj fill: il pieno ha piu' celle del guscio",
          len(solid) > len(hollow), "%d vs %d" % (len(solid), len(hollow)))
    check("obj fill: il centro si riempie", (4, 4, 4) in solid)
    check("obj fill: il guscio cavo NON ha il centro", (4, 4, 4) not in hollow)
    check("obj fill: il colore dell'interno viene dal guscio",
          solid[(4, 4, 4)].color == "#CCCCCC")

    # Lo stesso cubo senza il coperchio: il riempimento cola fuori e non riempie.
    opened = text + "".join("f %d %d %d %d\n" % f for f in faces[1:])
    leaked = importers.read_obj(opened, resolution=9, fill=True)
    check("obj fill: su un guscio aperto non riempie", (4, 4, 4) not in leaked)


def test_obj_rejects_junk():
    for label, text in (("vuoto", ""), ("senza facce", "v 0 0 0\nv 1 1 1\n")):
        try:
            importers.read_obj(text)
            check("obj: rifiuta %s" % label, False, "non ha sollevato")
        except ValueError:
            check("obj: rifiuta %s" % label, True)
    try:
        importers.read_obj("v 1 1 1\nv 1 1 1\nv 1 1 1\nf 1 2 3\n")
        check("obj: rifiuta il degenere", False, "non ha sollevato")
    except ValueError:
        check("obj: rifiuta il degenere", True)


# --- PNG ---------------------------------------------------------------------

def _png(pixels, w, h):
    buf = bytearray(w * h * 4)
    for (x, y), rgba in pixels.items():
        i = (y * w + x) * 4
        buf[i:i + 4] = bytes(rgba)
    return pngmod.encode_png(buf, w, h)


def test_png_flat():
    """Riga 0 in ALTO nell'immagine, y massima nel modello."""
    blob = _png({(0, 0): (255, 0, 0, 255),        # in alto a sinistra
                 (2, 3): (0, 0, 255, 255)},       # in basso a destra
                4, 4)
    cells = importers.read_png_flat(blob)
    check_eq("png: due celle", len(cells), 2)
    check("png: il pixel in alto diventa y massima",
          cells.get((0, 3, 0)) is not None and cells[(0, 3, 0)].color == "#FF0000",
          "celle: %r" % sorted(cells))
    check("png: il pixel in basso diventa y=0",
          cells.get((2, 0, 0)) is not None and cells[(2, 0, 0)].color == "#0000FF")
    check("png: i trasparenti non diventano voxel", (1, 1, 0) not in cells)


def test_png_thickness_and_plane():
    blob = _png({(0, 0): (255, 255, 255, 255)}, 2, 2)
    cells = importers.read_png_flat(blob, thickness=3)
    check_eq("png: spessore 3", len(cells), 3)
    check("png: lo spessore va lungo Z",
          {k[2] for k in cells} == {0, 1, 2})
    flat = importers.read_png_flat(blob, thickness=2, plane="xz")
    check("png: piano xz, lo spessore va lungo Y",
          {k[1] for k in flat} == {0, 1})


def test_png_alpha_threshold():
    """Alfa 1..7 e' trasparenza mancata di un editor, non un pixel da tenere."""
    blob = _png({(0, 0): (255, 0, 0, 4), (1, 0): (255, 0, 0, 9)}, 2, 1)
    cells = importers.read_png_flat(blob)
    check_eq("png: alfa sotto 8 scartato", len(cells), 1)


def test_png_all_transparent():
    blob = _png({}, 3, 3)
    try:
        importers.read_png_flat(blob)
        check("png: rifiuta l'immagine vuota", False, "non ha sollevato")
    except ValueError:
        check("png: rifiuta l'immagine vuota", True)


def test_sprite_stack():
    """Tre fette affiancate -> tre livelli di altezza."""
    # Foglio 6x2: tre fotogrammi 2x2 in riga. Ogni fetta ha un solo pixel, in
    # una posizione diversa, cosi' si vede se l'ordine o l'origine sbagliano.
    px = {(0, 0): (255, 0, 0, 255),               # fotogramma 0, angolo alto-sx
          (2, 1): (0, 255, 0, 255),               # fotogramma 1, angolo basso-sx
          (5, 0): (0, 0, 255, 255)}               # fotogramma 2, angolo alto-dx
    blob = _png(px, 6, 2)
    cells = importers.read_png_stack(blob, frames=3)
    check_eq("stack: tre celle", len(cells), 3)
    check("stack: il primo fotogramma e' in basso",
          cells.get((0, 0, 0)) is not None and cells[(0, 0, 0)].color == "#FF0000",
          "celle: %r" % sorted(cells))
    check("stack: il secondo e' a y=1 e z=1",
          cells.get((0, 1, 1)) is not None and cells[(0, 1, 1)].color == "#00FF00")
    check("stack: il terzo e' a y=2 e x=1",
          cells.get((1, 2, 0)) is not None and cells[(1, 2, 0)].color == "#0000FF")

    top = importers.read_png_stack(blob, frames=3, bottom_first=False)
    check("stack: bottom_first=False capovolge",
          top.get((0, 2, 0)) is not None and top[(0, 2, 0)].color == "#FF0000")


def test_sprite_stack_grid():
    """Un foglio a griglia si legge per righe."""
    blob = _png({(0, 0): (255, 0, 0, 255), (2, 0): (0, 255, 0, 255),
                 (0, 2): (0, 0, 255, 255), (2, 2): (255, 255, 0, 255)}, 4, 4)
    cells = importers.read_png_stack(blob, frames=4, cols=2)
    check_eq("stack griglia: quattro celle", len(cells), 4)
    check("stack griglia: quattro altezze", {k[1] for k in cells} == {0, 1, 2, 3})
    colors = [cells[k].color for k in sorted(cells, key=lambda c: c[1])]
    check("stack griglia: ordine di lettura per righe",
          colors == ["#FF0000", "#00FF00", "#0000FF", "#FFFF00"],
          "ottenuto %r" % colors)


def test_sprite_stack_bad_division():
    blob = _png({(0, 0): (255, 0, 0, 255)}, 5, 2)
    try:
        importers.read_png_stack(blob, frames=3)
        check("stack: rifiuta un foglio non divisibile", False, "non ha sollevato")
    except ValueError as e:
        check("stack: rifiuta un foglio non divisibile", True)
        check("stack: l'errore dice le misure", "5x2" in str(e), str(e))


# --- glTF / GLB --------------------------------------------------------------

def test_glb_roundtrip():
    doc, obj = sample_doc()
    blob = exporters.build_glb(doc, obj, center=False)
    cells = importers.read_gltf(blob, resolution=8)
    check("glb: qualcosa e' stato importato", len(cells) > 0)
    got = {c.color for c in cells.values()}
    # Il giro completo sul COLORE e' il controllo che vale: passa solo se
    # `_srgb` e `_unsrgb` sono davvero l'una l'inversa dell'altra. Con la sola
    # andata i rossi tornerebbero #FF0000 (1.0 resta 1.0) ma un colore medio no.
    check("glb: i colori tornano esatti", {"#FF0000", "#00FF00", "#0000FF"} <= got,
          "ottenuti %r" % sorted(got))
    ys = [k[1] for k in cells]
    xs = [k[0] for k in cells]
    check("glb: la X resta il lato piu' lungo",
          max(xs) - min(xs) >= max(k[2] for k in cells) - min(k[2] for k in cells))
    check("glb: il verde e' in alto",
          cells[max(cells, key=lambda k: k[1])].color == "#00FF00")
    check("glb: il blu e' a X massima",
          cells[max(cells, key=lambda k: k[0])].color == "#0000FF")


def test_srgb_inverse():
    """`_unsrgb` e' l'inversa di `_srgb` su tutti i 256 livelli.

    E' il controllo che tiene onesto il giro dei colori: un'approssimazione che
    sbaglia di uno si accumula a ogni export-import, e dopo tre giri un grigio
    medio e' visibilmente diverso.
    """
    worst = 0
    for v in range(256):
        back = importers._unsrgb(exporters._srgb(v))
        worst = max(worst, abs(back - v))
    check_eq("srgb: andata e ritorno esatti su 256 livelli", worst, 0)


def test_gltf_node_transform():
    """La trasformazione dei nodi si applica: senza, tutto si accatasta."""
    import base64 as b64
    import json as js
    # Un solo triangolo, spostato di 10 sulla X da un nodo.
    pts = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    doc = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "translation": [10, 0, 0]}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3,
                       "type": "VEC3"}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pts)}],
        "buffers": [{"byteLength": len(pts),
                     "uri": "data:application/octet-stream;base64,"
                            + b64.b64encode(pts).decode("ascii")}],
    }
    cells = importers.read_gltf(js.dumps(doc).encode("utf-8"), resolution=8)
    check("gltf: il .gltf testuale con buffer incorporato si legge", len(cells) > 0)

    # Stesso triangolo, due nodi a distanza: se la traslazione fosse ignorata i
    # due si sovrapporrebbero e l'ingombro sarebbe quello di uno solo.
    doc2 = dict(doc)
    doc2["nodes"] = [{"mesh": 0}, {"mesh": 0, "translation": [10, 0, 0]}]
    doc2["scenes"] = [{"nodes": [0, 1]}]
    wide = importers.read_gltf(js.dumps(doc2).encode("utf-8"), resolution=16)
    check("gltf: due nodi distanti hanno un ingombro doppio",
          max(k[0] for k in wide) - min(k[0] for k in wide) >= 10,
          "ingombro %d" % (max(k[0] for k in wide) - min(k[0] for k in wide)))


def test_gltf_matrix_column_major():
    """Una `matrix` di nodo e' per COLONNE: trasporla o no sposta il modello."""
    import base64 as b64
    import json as js
    pts = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    m = [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 5, 0, 1]   # traslazione y=5
    doc = {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}], "scene": 0,
        "nodes": [{"mesh": 0, "matrix": m}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3,
                       "type": "VEC3"}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pts)}],
        "buffers": [{"byteLength": len(pts),
                     "uri": "data:application/octet-stream;base64,"
                            + b64.b64encode(pts).decode("ascii")}],
    }
    mat = importers._node_matrix(doc["nodes"][0])
    check("gltf: la matrice per colonne si traspone",
          [mat[r][3] for r in range(3)] == [0.0, 5.0, 0.0],
          "colonna traslazione: %r" % [mat[r][3] for r in range(3)])


def test_gltf_external_buffer_speaks():
    import json as js
    doc = {"asset": {"version": "2.0"},
           "buffers": [{"byteLength": 4, "uri": "data.bin"}]}
    try:
        importers.read_gltf(js.dumps(doc).encode("utf-8"))
        check("gltf: l'errore sul buffer esterno e' parlante", False,
              "non ha sollevato")
    except ValueError as e:
        check("gltf: l'errore sul buffer esterno e' parlante",
              "data.bin" in str(e) and "GLB" in str(e), str(e))


def test_gltf_rejects_empty():
    import json as js
    try:
        importers.read_gltf(js.dumps({"asset": {"version": "2.0"}}).encode("utf-8"))
        check("gltf: rifiuta un documento senza triangoli", False,
              "non ha sollevato")
    except ValueError:
        check("gltf: rifiuta un documento senza triangoli", True)


def test_gltf_byte_stride():
    """Un accessor INTERLACCIATO si legge a passo `byteStride`.

    Leggerlo a passo compatto darebbe vertici composti da meta' di un attributo
    e meta' di un altro: geometria plausibile, completamente sbagliata, e
    nessun errore.
    """
    import base64 as b64
    import json as js
    # POSITION e un finto NORMAL interlacciati: 6 float per vertice.
    data = b""
    for p in ((0, 0, 0), (1, 0, 0), (0, 1, 0)):
        data += struct.pack("<3f", *p) + struct.pack("<3f", 9, 9, 9)
    doc = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3,
                       "type": "VEC3"}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(data),
                         "byteStride": 24}],
        "buffers": [{"byteLength": len(data),
                     "uri": "data:application/octet-stream;base64,"
                            + b64.b64encode(data).decode("ascii")}],
    }
    doc_obj, bins = importers._gltf_chunks(js.dumps(doc).encode("utf-8"))
    pos = importers._accessor(doc_obj, bins, 0)
    check("gltf: accessor interlacciato letto a passo giusto",
          pos == [(0, 0, 0), (1, 0, 0), (0, 1, 0)], "ottenuto %r" % (pos,))


def test_glb_chunk_walk():
    """Il lettore GLB salta i blocchi sconosciuti invece di fermarsi."""
    doc, obj = sample_doc()
    blob = exporters.build_glb(doc, obj)
    magic, ver, total = struct.unpack("<III", blob[:12])
    check_eq("glb: firma", magic, 0x46546C67)
    check_eq("glb: lunghezza dichiarata pari a quella vera", total, len(blob))
    parsed, bins = importers._gltf_chunks(blob)
    check("glb: JSON estratto", "meshes" in parsed)
    check("glb: blocco binario estratto", bins.get(0) is not None and len(bins[0]) > 0)


# --- interoperabilita' fra gli import ----------------------------------------

def test_vox_then_export_again():
    """Import e riesporto danno gli stessi byte: nessuna deriva."""
    doc, obj = sample_doc()
    first = exporters.build_vox(doc, obj)
    cells = importers.read_vox(first)[0]["cells"]
    doc2 = Document("Rientro")
    obj2 = VoxelObject("Base", cells)
    doc2.objects = [obj2]
    doc2.active_index = 0
    second = exporters.build_vox(doc2, obj2)
    check("vox: export -> import -> export e' stabile", first == second,
          "%d vs %d byte" % (len(first), len(second)))


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
            except Exception as e:                # noqa: BLE001
                _fail.append("%s ha sollevato: %r" % (name, e))
    print("Import MCP: %d controlli, %d falliti" % (_ok + len(_fail), len(_fail)))
    for f in _fail:
        print("  FALLITO: " + f)
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
