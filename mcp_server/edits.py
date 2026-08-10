"""Il motore di modifica: forme, trasformazioni, selezioni.

Tutto passa da `Document.edit()`, cosi' un'operazione grande (riempi una
scatola di 40.000 celle) resta UN passo di annullamento. Le funzioni qui non
aprono mai una sessione da sole: la aprono i loro chiamanti, e le sessioni si
annidano. Serve agli strumenti composti — "specchia e salda" e' due primitive
ma un solo Ctrl+Z.

TETTO AI VOXEL. `voxel_budget_for(grid)` e' la stessa funzione dell'app (meta'
del volume della griglia, fra 4M e 8M). Non e' prudenza astratta: senza, una
sola op malformata (`fill 0 0 0 299 299 299` = 27M celle) congelava l'app senza
un errore, e in JS una Map da 24M celle costa ~2.2 GB e uccide la scheda. Un
client MCP puo' generare la stessa op per sbaglio con altrettanta facilita'.

LA ROTAZIONE E' A PASSI DI 90 GRADI. Un angolo qualunque richiederebbe di
ricampionare la griglia, e ricampionare voxel significa perdere celle (due che
finiscono nella stessa) e crearne di vuote: il modello si buca. A 90 gradi la
trasformazione e' una permutazione di coordinate, cioe' esatta e reversibile.
Chi vuole un angolo qualunque lo ottiene col `transform.rotationY` dell'oggetto,
che ruota la RESA e non i dati.
"""

import math

from .compat import voxel_budget_for
from .document import Cell
from .palette import normalize_hex, shade


class EditLimit(RuntimeError):
    """L'operazione supererebbe il tetto dei voxel."""


def check_budget(doc, obj, extra):
    grid = max(obj.grid_size) if obj.grid_size else 32
    budget = voxel_budget_for(grid)
    total = len(obj.cells) + max(0, extra)
    if total > budget:
        raise EditLimit(
            "L'operazione porterebbe a %d voxel, oltre il tetto di %d per una "
            "griglia %d. Riduci la regione o aumenta la griglia."
            % (total, budget, grid))


# --- generatori di regioni ---------------------------------------------------
# Ognuno RITORNA le coordinate invece di scrivere: cosi' la stessa forma serve a
# dipingere, a cancellare e a selezionare senza tre implementazioni.

def region_box(x0, y0, z0, x1, y1, z1, hollow=False, thickness=1):
    x0, x1 = sorted((int(x0), int(x1)))
    y0, y1 = sorted((int(y0), int(y1)))
    z0, z1 = sorted((int(z0), int(z1)))
    t = max(1, int(thickness))
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            for z in range(z0, z1 + 1):
                if hollow:
                    on_shell = (x - x0 < t or x1 - x < t
                                or y - y0 < t or y1 - y < t
                                or z - z0 < t or z1 - z < t)
                    if not on_shell:
                        continue
                yield (x, y, z)


def region_line(x0, y0, z0, x1, y1, z1):
    """Linea 3D a passi sull'asse dominante — la stessa semantica dell'op `line`
    di `expand_ops`. Non Bresenham 3D: la parita' con l'espansore e' piu'
    importante dell'eleganza, e li' e' cosi'."""
    dx, dy, dz = int(x1) - int(x0), int(y1) - int(y0), int(z1) - int(z0)
    steps = max(abs(dx), abs(dy), abs(dz))
    if steps == 0:
        yield (int(x0), int(y0), int(z0))
        return
    for i in range(steps + 1):
        t = i / steps
        yield (_round_half_up(x0 + dx * t),
               _round_half_up(y0 + dy * t),
               _round_half_up(z0 + dz * t))


def _round_half_up(v):
    """Arrotondamento a meta' verso l'alto, come `Math.round` di JS.

    `round()` di Python usa l'arrotondamento del banchiere e su questa stessa
    funzione ha gia' prodotto una divergenza vera fra `expand_ops` e `expandOps`
    (vedi `tests/ops_parity_cases.json`). Qui si mantiene la convenzione JS
    perche' e' quella che l'espansore usa.
    """
    return int(math.floor(float(v) + 0.5))


def region_sphere(cx, cy, cz, radius, hollow=False, thickness=1):
    r = float(radius)
    inner = r - max(1.0, float(thickness))
    r2, i2 = r * r, inner * inner
    lo, hi = int(math.floor(-r)), int(math.ceil(r))
    for dx in range(lo, hi + 1):
        for dy in range(lo, hi + 1):
            for dz in range(lo, hi + 1):
                d2 = dx * dx + dy * dy + dz * dz
                if d2 > r2:
                    continue
                if hollow and inner > 0 and d2 < i2:
                    continue
                yield (int(cx) + dx, int(cy) + dy, int(cz) + dz)


def region_cylinder(cx, cy, cz, radius, height, axis="y", hollow=False):
    r = float(radius)
    r2 = r * r
    inner2 = max(0.0, r - 1.0) ** 2
    lo, hi = int(math.floor(-r)), int(math.ceil(r))
    axis = str(axis or "y").lower()
    for da in range(lo, hi + 1):
        for db in range(lo, hi + 1):
            d2 = da * da + db * db
            if d2 > r2 or (hollow and d2 < inner2):
                continue
            for k in range(int(height)):
                if axis == "x":
                    yield (int(cx) + k, int(cy) + da, int(cz) + db)
                elif axis == "z":
                    yield (int(cx) + da, int(cy) + db, int(cz) + k)
                else:
                    yield (int(cx) + da, int(cy) + k, int(cz) + db)


def region_cone(cx, cy, cz, radius, height, axis="y", invert=False):
    h = max(1, int(height))
    for k in range(h):
        t = (1.0 - k / float(h)) if not invert else (k / float(h))
        r = float(radius) * t
        r2 = r * r
        lo, hi = int(math.floor(-r)), int(math.ceil(r))
        for da in range(lo, hi + 1):
            for db in range(lo, hi + 1):
                if da * da + db * db > r2:
                    continue
                if axis == "x":
                    yield (int(cx) + k, int(cy) + da, int(cz) + db)
                elif axis == "z":
                    yield (int(cx) + da, int(cy) + db, int(cz) + k)
                else:
                    yield (int(cx) + da, int(cy) + k, int(cz) + db)


def region_plane(axis, level, a0, b0, a1, b1):
    """Piano allineato agli assi — la stessa semantica dell'op `rect`."""
    a0, a1 = sorted((int(a0), int(a1)))
    b0, b1 = sorted((int(b0), int(b1)))
    lv = int(level)
    ax = str(axis or "y").lower()
    for a in range(a0, a1 + 1):
        for b in range(b0, b1 + 1):
            if ax == "x":
                yield (lv, a, b)
            elif ax == "z":
                yield (a, b, lv)
            else:
                yield (a, lv, b)


SHAPES = {
    "box": region_box,
    "sphere": region_sphere,
    "cylinder": region_cylinder,
    "cone": region_cone,
    "line": region_line,
    "plane": region_plane,
}


# --- scrittura ---------------------------------------------------------------

def mirror_keys(keys, axis, grid_size, center=None):
    """Riflette una lista di coordinate.

    Il piano di riflessione e' il CENTRO DELLA GRIGLIA, non il centro del
    modello, salvo `center` esplicito. E' la stessa scelta di `symmetryAxis`
    nella UI, e la ragione e' che un modello costruito a meta' deve completarsi
    nella posizione giusta della griglia: riflettere sul proprio centro
    ricadrebbe su se stesso.
    """
    idx = {"x": 0, "y": 1, "z": 2}.get(str(axis or "x").lower(), 0)
    if center is None:
        c2 = (grid_size[idx] - 1)
    else:
        c2 = 2 * float(center)
    out = []
    for k in keys:
        m = list(k)
        m[idx] = int(round(c2 - k[idx]))
        out.append(tuple(m))
    return out


def paint(doc, obj, keys, color=None, material=None, part=None,
          only_existing=False, symmetry=None):
    """Dipinge una regione. Ritorna il numero di celle cambiate.

    `only_existing` limita la scrittura alle celle che gia' esistono: e' il
    "colora quello che c'e'" senza dover prima calcolare l'intersezione, e
    serve a ricolorare una parte senza gonfiare il modello.
    """
    keys = list(keys)
    if symmetry:
        keys = keys + mirror_keys(keys, symmetry, obj.grid_size)
    if not only_existing:
        new = sum(1 for k in keys if k not in obj.cells)
        check_budget(doc, obj, new)
    color = normalize_hex(color, None)
    n = 0
    with doc.edit("Riempimento", obj):
        for k in keys:
            old = obj.cells.get(k)
            if only_existing and old is None:
                continue
            cell = Cell(
                color if color else (old.color if old else "#CCCCCC"),
                material if material is not None else (old.material if old else None),
                part if part is not None else (old.part if old else None),
            )
            if doc.set_cell(obj, k, cell):
                n += 1
    return n


def erase(doc, obj, keys, symmetry=None):
    keys = list(keys)
    if symmetry:
        keys = keys + mirror_keys(keys, symmetry, obj.grid_size)
    with doc.edit("Cancellazione", obj):
        return sum(1 for k in keys if doc.del_cell(obj, k))


def translate(doc, obj, dx, dy, dz, keys=None):
    """Sposta il modello (o le sole celle indicate).

    Si RICOSTRUISCE la mappa invece di spostare cella per cella: spostando in
    ordine, una cella scritta prima verrebbe letta dopo come sorgente e il
    modello si trascinerebbe dietro copie di se stesso — il classico difetto del
    memmove sovrapposto.
    """
    dx, dy, dz = int(dx), int(dy), int(dz)
    if not (dx or dy or dz):
        return 0
    moving = list(keys) if keys is not None else list(obj.cells.keys())
    snapshot = {k: obj.cells[k] for k in moving if k in obj.cells}
    with doc.edit("Spostamento", obj):
        for k in snapshot:
            doc.del_cell(obj, k)
        for (x, y, z), cell in snapshot.items():
            doc.set_cell(obj, (x + dx, y + dy, z + dz), cell)
    return len(snapshot)


def rotate(doc, obj, axis="y", steps=1, keys=None):
    """Ruota di `steps` quarti di giro attorno al centro del modello.

    A 90 gradi la rotazione e' una permutazione di coordinate: esatta e
    reversibile (vedi docstring del modulo). Il perno e' il centro dei DATI, non
    della griglia: ruotare attorno all'origine porterebbe il modello fuori dalla
    griglia nei tre quarti dei casi.
    """
    steps = int(steps) % 4
    if steps == 0 or not obj.cells:
        return 0
    axis = str(axis or "y").lower()
    moving = list(keys) if keys is not None else list(obj.cells.keys())
    snapshot = {k: obj.cells[k] for k in moving if k in obj.cells}
    if not snapshot:
        return 0
    xs = [k[0] for k in snapshot]
    ys = [k[1] for k in snapshot]
    zs = [k[2] for k in snapshot]
    cx = (min(xs) + max(xs)) / 2.0
    cy = (min(ys) + max(ys)) / 2.0
    cz = (min(zs) + max(zs)) / 2.0

    def rot(k):
        x, y, z = k[0] - cx, k[1] - cy, k[2] - cz
        for _ in range(steps):
            if axis == "x":
                y, z = -z, y
            elif axis == "z":
                x, y = -y, x
            else:
                x, z = z, -x
        return (_round_half_up(x + cx), _round_half_up(y + cy),
                _round_half_up(z + cz))

    with doc.edit("Rotazione", obj):
        for k in snapshot:
            doc.del_cell(obj, k)
        for k, cell in snapshot.items():
            doc.set_cell(obj, rot(k), cell)
    return len(snapshot)


def scale(doc, obj, factor, keys=None):
    """Scala INTERA per ingrandire (ogni voxel diventa n^3 voxel), decimazione
    per rimpicciolire.

    Un fattore frazionario in ingrandimento darebbe righe di spessore diverso —
    lo stesso motivo per cui lo zoom della tela di pixel art e' intero. In
    riduzione si campiona invece di mediare: mediare i colori inventerebbe tinte
    che non stanno nella palette, e la palette e' cio' che tiene coerente un
    pack.
    """
    moving = list(keys) if keys is not None else list(obj.cells.keys())
    snapshot = {k: obj.cells[k] for k in moving if k in obj.cells}
    if not snapshot:
        return 0
    try:
        f = float(factor)
    except (TypeError, ValueError):
        raise ValueError("fattore di scala non valido: %r" % (factor,))
    if f <= 0:
        raise ValueError("il fattore di scala deve essere positivo")

    if f >= 1:
        n = int(round(f))
        if abs(f - n) > 1e-9:
            raise ValueError(
                "in ingrandimento il fattore deve essere intero (dato: %s). "
                "Un fattore frazionario darebbe spessori diversi da voxel a "
                "voxel." % factor)
        if n == 1:
            return 0
        check_budget(doc, obj, len(snapshot) * (n ** 3) - len(snapshot))
        with doc.edit("Ingrandimento", obj):
            for k in snapshot:
                doc.del_cell(obj, k)
            for (x, y, z), cell in snapshot.items():
                for i in range(n):
                    for j in range(n):
                        for m in range(n):
                            doc.set_cell(obj, (x * n + i, y * n + j, z * n + m), cell)
        return len(snapshot) * (n ** 3)

    with doc.edit("Riduzione", obj):
        for k in snapshot:
            doc.del_cell(obj, k)
        seen = {}
        for (x, y, z), cell in sorted(snapshot.items()):
            key = (int(math.floor(x * f)), int(math.floor(y * f)),
                   int(math.floor(z * f)))
            seen.setdefault(key, cell)
        for k, cell in seen.items():
            doc.set_cell(obj, k, cell)
    return len(seen)


def center_on_ground(doc, obj):
    """Centra su XZ e appoggia a y=0 — la stessa normalizzazione di
    `normalize_asset` nella coda dei pack, cosi' un modello prodotto da MCP si
    allinea a uno prodotto da un pack invece di fluttuare accanto."""
    b = obj.bounds()
    if not b:
        return 0
    cx = (b[0] + b[3]) // 2
    cz = (b[2] + b[5]) // 2
    # La sessione esterna e' qui: `translate` ha la sua, ma le sessioni si
    # annidano e solo la piu' esterna chiude la voce, quindi lo storico registra
    # "Appoggia a terra" e non "Spostamento".
    with doc.edit("Appoggia a terra", obj):
        return translate(doc, obj, -cx, -b[1], -cz)


def replace_color(doc, obj, src, dst, tolerance=0):
    """Sostituisce un colore. Con tolleranza > 0 prende anche i vicini
    percettivi, cosi' "togli tutti i verdi" non richiede di elencarli."""
    from .palette import color_distance
    src = normalize_hex(src, "#CCCCCC")
    dst = normalize_hex(dst, "#CCCCCC")
    n = 0
    with doc.edit("Sostituzione colore", obj):
        for k, cell in list(obj.cells.items()):
            if cell.color == src or (tolerance > 0
                                     and color_distance(cell.color, src) <= tolerance):
                if doc.set_cell(obj, k, cell.with_color(dst)):
                    n += 1
    return n


def select(obj, color=None, part=None, material=None, region=None,
           invert=False):
    """Le chiavi che soddisfano i criteri. Una selezione e' una LISTA DI CHIAVI,
    non uno stato del documento: cosi' un client MCP puo' tenerne quante ne
    vuole e combinarle, e non c'e' una "selezione corrente" da invalidare a ogni
    modifica (che e' il posto in cui questi editor si rompono)."""
    color = normalize_hex(color, None) if color else None
    box = None
    if region:
        box = (min(region[0], region[3]), min(region[1], region[4]),
               min(region[2], region[5]), max(region[0], region[3]),
               max(region[1], region[4]), max(region[2], region[5]))
    out = []
    for k, cell in obj.cells.items():
        ok = True
        if color and cell.color != color:
            ok = False
        if ok and part is not None and cell.part != part:
            ok = False
        if ok and material is not None and cell.material != material:
            ok = False
        if ok and box:
            if not (box[0] <= k[0] <= box[3] and box[1] <= k[1] <= box[4]
                    and box[2] <= k[2] <= box[5]):
                ok = False
        if ok != invert:
            out.append(k)
    return out


def connected(obj, start, same_color=True):
    """Componente connessa a 6 vicini da `start`. Serve a "prendi questo pezzo"
    senza descriverne la forma, che e' l'operazione piu' comune su un modello
    generato dall'AI e la piu' scomoda da esprimere a coordinate."""
    start = tuple(int(v) for v in start)
    if start not in obj.cells:
        return []
    target = obj.cells[start].color
    seen = {start}
    stack = [start]
    out = []
    while stack:
        k = stack.pop()
        out.append(k)
        x, y, z = k
        for nb in ((x + 1, y, z), (x - 1, y, z), (x, y + 1, z),
                   (x, y - 1, z), (x, y, z + 1), (x, y, z - 1)):
            if nb in seen or nb not in obj.cells:
                continue
            if same_color and obj.cells[nb].color != target:
                continue
            seen.add(nb)
            stack.append(nb)
    return out


def hollow(doc, obj, keep_shell=1):
    """Svuota l'interno: toglie le celle circondate da 6 vicini.

    Su un modello generato dall'AI l'interno e' quasi sempre pieno e non si
    vede mai. Toglierlo dimezza abbondantemente il conteggio e non cambia una
    riga di quello che si guarda — ma va fatto DOPO, non durante la generazione,
    perche' un modello cavo non si puo' piu' tagliare.
    """
    del_keys = []
    for (x, y, z) in obj.cells:
        buried = all(((x + dx, y + dy, z + dz) in obj.cells)
                     for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0),
                                        (0, -1, 0), (0, 0, 1), (0, 0, -1)))
        if buried:
            del_keys.append((x, y, z))
    if keep_shell > 1:
        # Conservare piu' di un guscio richiede la distanza dal bordo: si
        # ricalcola per erosione, ripetendo lo stesso passo.
        for _ in range(int(keep_shell) - 1):
            shell = set(obj.cells) - set(del_keys)
            deeper = []
            for k in del_keys:
                x, y, z = k
                if any((x + dx, y + dy, z + dz) in shell
                       for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0),
                                          (0, -1, 0), (0, 0, 1), (0, 0, -1))):
                    continue
                deeper.append(k)
            del_keys = deeper
    with doc.edit("Svuotamento", obj):
        return sum(1 for k in del_keys if doc.del_cell(obj, k))


def shade_by_height(doc, obj, top=1.12, bottom=0.82):
    """Ombreggia verticalmente: schiarisce in alto, scurisce in basso.

    E' l'unico ritocco che rende leggibile un modello a tinte piatte senza
    toccarne la forma, ed e' quello che un modello generato dall'AI quasi sempre
    non ha. Introduce colori nuovi, quindi si applica DOPO `enforce_palette` di
    un pack, mai prima.
    """
    b = obj.bounds()
    if not b:
        return 0
    y0, y1 = b[1], b[4]
    span = max(1, y1 - y0)
    n = 0
    with doc.edit("Ombreggiatura", obj):
        for k, cell in list(obj.cells.items()):
            t = (k[1] - y0) / float(span)
            factor = bottom + (top - bottom) * t
            if doc.set_cell(obj, k, cell.with_color(shade(cell.color, factor))):
                n += 1
    return n


def assign_part(doc, obj, keys, name):
    """Battezza una regione come parte. Le parti sono cio' che rende riggabile
    un modello: `buildHumanoidSkeleton` le usa per capire dove finisce il
    braccio, e senza di esse deve indovinarlo dalla forma."""
    n = 0
    with doc.edit("Assegnazione parte", obj):
        for k in keys:
            cell = obj.cells.get(k)
            if cell is None:
                continue
            if doc.set_cell(obj, k, cell.with_part(name)):
                n += 1
    return n
