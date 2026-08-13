"""Greedy mesher: le facce visibili unite in quad massimali.

E' SOLO per l'export. La scena a schermo usa un InstancedMesh per colore, che
mantiene il raycasting per voxel (serve a editare); qui invece si vuole il minor
numero di triangoli possibile, e per un modello di 50.000 voxel la differenza e'
fra ~600.000 triangoli e qualche migliaio.

L'algoritmo e' a piano spazzato: per ogni asse e per ogni livello si costruisce
la maschera delle facce esposte su quel piano e si estraggono i rettangoli
massimali di colore uniforme. Il risultato non e' il minimo assoluto (trovarlo e'
NP-difficile) ma e' a una passata sui dati.

DUE FACCE COINCIDENTI, MAI UNA. La faccia fra due voxel si salta solo se
entrambi appartengono allo stesso materiale/colore E il vicino esiste: cosi' cio'
che resta e' esattamente il guscio. Sul modello riggato la regola e' piu' severa
(vedi l'invariante 5 in CLAUDE.md: si salta solo se i due voxel si deformano
IDENTICAMENTE, altrimenti a modello in posa il guscio si apre), ed e' `rig.py`
a occuparsene — qui il modello e' statico e la deformazione non esiste.

GLI UV LI EMETTE IL MESHER, non chi lo chiama. La faccia `back` ha l'ordine dei
vertici invertito, quindi una lista fissa di UV sarebbe trasposta per uno dei due
versi: si vedrebbe come una texture ruotata di 90 gradi su meta' del modello. Gli
UV sono `0..larghezza / 0..altezza` del quad con `RepeatWrapping`, cosi' la
texture si ripete UNA VOLTA PER VOXEL invece di stirarsi sul quad unito.
"""

# (asse, verso) -> (normale, i due assi del piano)
_FACES = (
    ("px", (1, 0, 0), 0, 1, 2),
    ("nx", (-1, 0, 0), 0, 1, 2),
    ("py", (0, 1, 0), 1, 0, 2),
    ("ny", (0, -1, 0), 1, 0, 2),
    ("pz", (0, 0, 1), 2, 0, 1),
    ("nz", (0, 0, -1), 2, 0, 1),
)


class Quad(object):
    """Un quad del guscio. `corners` in ordine antiorario visto da fuori, cosi'
    la normale esce dal modello senza doverla dichiarare."""

    __slots__ = ("face", "normal", "token", "corners", "uw", "uh")

    def __init__(self, face, normal, token, corners, uw, uh):
        self.face = face
        self.normal = normal
        self.token = token
        self.corners = corners
        self.uw = uw
        self.uh = uh


def token_of(cell):
    """Il valore su cui si RAGGRUPPA: `#RRGGBB` per un colore, `@m1` per un
    materiale. E' la stessa convenzione di `tokenOf` in 36-materials.js, ed e' il
    motivo per cui i confronti sparsi lo trattano come stringa opaca."""
    if cell.material:
        return "@" + cell.material
    return cell.color


def cells_by_part(cells, fallback="Object"):
    """{(x,y,z): Cell} -> {nome_parte: {key: Cell}}.

    Senza etichette torna un solo gruppo. Con le parti, ogni gruppo e' un
    volume A SE': il mesher non vede i vicini dell'altra parte, quindi le
    facce di contatto restano (leva, pulsante, plate devono staccarsi).
    """
    names = []
    for cell in cells.values():
        if cell.part and cell.part not in names:
            names.append(cell.part)
    fb = names[0] if names else fallback
    groups = {}
    for key, cell in cells.items():
        groups.setdefault(cell.part or fb, {})[key] = cell
    return groups


def greedy_mesh(cells):
    """{(x,y,z): Cell} -> lista di Quad.

    Le celle si raggruppano per token: due voxel dello stesso colore ma con
    materiali diversi NON si uniscono, o il quad unito porterebbe una sola
    texture e l'altra sparirebbe.
    """
    quads = []
    for face, normal, axis, ua, va in _FACES:
        # Le facce esposte su questo verso, indicizzate per livello.
        planes = {}
        d = normal[axis]
        for key, cell in cells.items():
            nb = list(key)
            nb[axis] += d
            if tuple(nb) in cells:
                continue                       # sepolta: non e' guscio
            level = key[axis]
            planes.setdefault(level, {})[(key[ua], key[va])] = token_of(cell)
        for level, mask in planes.items():
            quads.extend(_sweep(mask, face, normal, axis, ua, va, level))
    return quads


def _sweep(mask, face, normal, axis, ua, va, level):
    """Rettangoli massimali di token uniforme su un piano."""
    out = []
    if not mask:
        return out
    us = [k[0] for k in mask]
    vs = [k[1] for k in mask]
    u0, u1 = min(us), max(us)
    v0, v1 = min(vs), max(vs)
    done = set()
    for v in range(v0, v1 + 1):
        for u in range(u0, u1 + 1):
            if (u, v) in done or (u, v) not in mask:
                continue
            token = mask[(u, v)]
            # Si allarga prima in u, poi in v per tutta la larghezza trovata:
            # l'ordine e' arbitrario ma deve essere FISSO, o due esecuzioni
            # sullo stesso modello darebbero mesh diverse e un diff fra due
            # export sarebbe illeggibile.
            w = 1
            while (u + w, v) in mask and (u + w, v) not in done \
                    and mask[(u + w, v)] == token:
                w += 1
            hgt = 1
            while True:
                row = v + hgt
                if any((u + i, row) not in mask or (u + i, row) in done
                       or mask[(u + i, row)] != token for i in range(w)):
                    break
                hgt += 1
            for j in range(hgt):
                for i in range(w):
                    done.add((u + i, v + j))
            out.append(_quad(face, normal, token, axis, ua, va, level,
                             u, v, w, hgt))
    return out


def _quad(face, normal, token, axis, ua, va, level, u, v, w, h):
    """I quattro angoli del quad in coordinate di mondo.

    Un voxel a (x,y,z) occupa il cubo [x, x+1]. La faccia positiva sta a
    `level+1`, la negativa a `level`: e' il motivo per cui i due versi non
    condividono la formula.
    """
    base = level + (1 if normal[axis] > 0 else 0)

    def pt(du, dv):
        p = [0, 0, 0]
        p[axis] = base
        p[ua] = u + du
        p[va] = v + dv
        return tuple(p)

    corners = [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)]
    # Ordine antiorario visto da FUORI: la normale del triangolo 0-1-2 deve
    # avere lo stesso segno di `normal`. La vecchia regola "inverti se
    # normal[axis] < 0" sbagliava su +Y/-Y (py/ny uscivano FLIPPED): Unity e
    # glTF con backface culling (FrontSide / doubleSided=false) buttavano via
    # il tetto e la base, e il guscio sembrava bucato anche se in VoxelAI si
    # vedeva pieno (li' ogni voxel e' un cubo istanced, non il greedy mesh).
    c0, c1, c2 = corners[0], corners[1], corners[2]
    ax, ay, az = c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]
    bx, by, bz = c2[0] - c0[0], c2[1] - c0[1], c2[2] - c0[2]
    cx = ay * bz - az * by
    cy = az * bx - ax * bz
    cz = ax * by - ay * bx
    if cx * normal[0] + cy * normal[1] + cz * normal[2] < 0:
        corners = [corners[0], corners[3], corners[2], corners[1]]
    return Quad(face, normal, token, corners, w, h)


def quad_uvs(q):
    """Gli UV dei quattro angoli, nello stesso ordine di `q.corners`."""
    uvs = [(0.0, 0.0), (q.uw, 0.0), (q.uw, q.uh), (0.0, q.uh)]
    if q.normal[0] < 0 or q.normal[1] < 0 or q.normal[2] < 0:
        uvs = [uvs[0], uvs[3], uvs[2], uvs[1]]
    return uvs


def visible_cells(cells):
    """Le celle con almeno una faccia esposta. Serve a chi conta ("quanti voxel
    si vedono?") e ai formati che scrivono voxel invece di triangoli: l'interno
    di un modello pieno non e' mai visibile e occupa la maggior parte del file."""
    out = {}
    for key, cell in cells.items():
        x, y, z = key
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0),
                           (0, 0, 1), (0, 0, -1)):
            if (x + dx, y + dy, z + dz) not in cells:
                out[key] = cell
                break
    return out


def mesh_stats(cells):
    quads = greedy_mesh(cells)
    return {
        "voxels": len(cells),
        "visible": len(visible_cells(cells)),
        "quads": len(quads),
        "triangles": len(quads) * 2,
    }
