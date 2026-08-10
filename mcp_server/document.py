"""Il documento: un progetto VoxelAIArtist tenuto in memoria.

E' il modello che tutti gli strumenti MCP mutano. Riproduce il contratto dati
dell'app senza importare nulla dal browser:

  progetto  = { objects: [oggetto, ...] }            (o un oggetto solo, piatto)
  oggetto   = { name, transform, visible, metadata, palette, ops|parts, rig }
  metadata  = { name, grid_size, materials[], material_map[] }

COME SONO TENUTI I VOXEL. Nel file sono ops compatte; qui dentro sono un dict
`(x,y,z) -> (colore, materiale, parte)`, cioe' la stessa scelta di `voxelMap`
nella UI. E' l'unica forma in cui "dipingi questa cella" costa O(1): con una
lista di voxel ogni singola modifica sarebbe una scansione, e uno strumento MCP
ne fa migliaia di seguito. La conversione da e verso le ops avviene solo ai
bordi (apertura e salvataggio).

PERCHE' LA TUPLA E NON UN OGGETTO. Il valore di una cella e' immutabile, quindi
lo storico puo' tenerne un riferimento senza copiarlo: annullare mille pennellate
costa mille puntatori, non mille oggetti. E' cio' che rende praticabile lo
storico a DIFF descritto sotto.

LO STORICO E' A DIFF, NON A FOTOGRAFIE. Un modello vero sta sulle centinaia di
migliaia di celle: fotografarlo a ogni modifica esaurirebbe la memoria dopo una
manciata di passi. Ogni modifica registra quindi solo le celle TOCCATE, col loro
valore precedente. Le operazioni STRUTTURALI (aggiungere o togliere un oggetto,
aprire un file) non si esprimono come diff di celle e usano invece una
fotografia intera, che pero' e' rara per costruzione.

I MATERIALI SONO DI PROGETTO, NON DELL'OGGETTO — stessa scelta della UI, per lo
stesso motivo: un voxel cita un id, e se la lista vivesse nell'oggetto attivo
cambiare oggetto renderebbe orfani tutti i riferimenti degli altri. In salvataggio
la lista viene scritta nel metadata di OGNI oggetto (e' cosi' che la legge l'app)
e in apertura viene FUSA per id, non sostituita.
"""

import copy
import json
import os
import time

from .palette import build_palette, normalize_hex

# Valore sentinella per "questa cella non esisteva": None e' un valore legittimo
# per materiale e parte, quindi non puo' servire anche da "assente".
MISSING = object()

# Tetto allo storico. Le voci a diff sono minuscole; il costo vero sono le
# fotografie strutturali, ed e' per quelle che il tetto e' basso.
UNDO_MAX = 64
UNDO_MAX_SNAPSHOTS = 8

DEFAULT_GRID = [32, 32, 32]


class Cell(tuple):
    """(colore, materiale, parte). Tupla per l'immutabilita' (vedi modulo)."""

    __slots__ = ()

    def __new__(cls, color, material=None, part=None):
        return tuple.__new__(cls, (normalize_hex(color) or "#CCCCCC", material, part))

    @property
    def color(self):
        return self[0]

    @property
    def material(self):
        return self[1]

    @property
    def part(self):
        return self[2]

    def with_color(self, color):
        return Cell(color, self[1], self[2])

    def with_material(self, material):
        return Cell(self[0], material, self[2])

    def with_part(self, part):
        return Cell(self[0], self[1], part)


class VoxelObject(object):
    """Un oggetto della scena: le sue celle, il suo transform, il suo rig.

    Il rig e' PER OGGETTO (non per progetto): una scena "corpo + armatura" ha due
    scheletri, e tenerne uno solo ne farebbe perdere uno al salvataggio. E' la
    stessa ragione per cui `getSceneSavePayload` scrive `rig` dentro ogni voce di
    `objects` e lo duplica in radice solo quando di rig ce n'e' esattamente uno.
    """

    def __init__(self, name="Oggetto", cells=None, transform=None, visible=True,
                 rig=None, grid_size=None, extra_metadata=None):
        self.name = str(name or "Oggetto")
        self.cells = dict(cells or {})
        self.transform = transform or default_transform()
        self.visible = bool(visible)
        self.rig = rig
        self.grid_size = list(grid_size or DEFAULT_GRID)
        # Tutto cio' che un file portava nel metadata e che non abbiamo promosso a
        # campo: si conserva e si riscrive, cosi' aprire e risalvare non perde dati
        # che una versione futura dell'app potrebbe aggiungere.
        self.extra_metadata = dict(extra_metadata or {})

    # --- lettura ----------------------------------------------------------

    def __len__(self):
        return len(self.cells)

    def bounds(self):
        """(min_x, min_y, min_z, max_x, max_y, max_z), o None se vuoto."""
        if not self.cells:
            return None
        xs = [k[0] for k in self.cells]
        ys = [k[1] for k in self.cells]
        zs = [k[2] for k in self.cells]
        return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))

    def size(self):
        b = self.bounds()
        if not b:
            return (0, 0, 0)
        return (b[3] - b[0] + 1, b[4] - b[1] + 1, b[5] - b[2] + 1)

    def color_counts(self):
        out = {}
        for cell in self.cells.values():
            out[cell.color] = out.get(cell.color, 0) + 1
        return dict(sorted(out.items(), key=lambda kv: -kv[1]))

    def parts(self):
        seen = []
        for cell in self.cells.values():
            if cell.part and cell.part not in seen:
                seen.append(cell.part)
        return seen

    def voxel_list(self):
        """Lista piatta [{x,y,z,color,part?,material?}] — la forma che l'app
        chiama `voxels` e che ogni esportatore consuma."""
        out = []
        for (x, y, z), cell in self.cells.items():
            v = {"x": x, "y": y, "z": z, "color": cell.color}
            if cell.part:
                v["part"] = cell.part
            if cell.material:
                v["material"] = cell.material
            out.append(v)
        out.sort(key=lambda v: (v["y"], v["z"], v["x"]))
        return out

    def clone(self, name=None):
        obj = VoxelObject(name or self.name, dict(self.cells),
                          copy.deepcopy(self.transform), self.visible,
                          copy.deepcopy(self.rig), list(self.grid_size),
                          copy.deepcopy(self.extra_metadata))
        return obj


def default_transform():
    return {"position": {"x": 0, "y": 0, "z": 0}, "rotationY": 0, "scale": 1}


def _is_identity(t):
    if not isinstance(t, dict):
        return True
    p = t.get("position") or {}
    return (not p.get("x") and not p.get("y") and not p.get("z")
            and not t.get("rotationY")
            and (t.get("scale") in (None, 1)))


class Document(object):
    """Il progetto aperto: oggetti, materiali, storico."""

    def __init__(self, name="Progetto"):
        self.name = str(name or "Progetto")
        self.objects = []
        self.active_index = 0
        self.materials = []          # di PROGETTO (vedi docstring del modulo)
        self.path = None
        self.dirty = False
        self._undo = []
        self._redo = []
        self._pending = None         # diff in costruzione (vedi edit())

    # --- oggetti ----------------------------------------------------------

    @property
    def active(self):
        if not self.objects:
            obj = VoxelObject("Oggetto 1")
            self.objects.append(obj)
            self.active_index = 0
            return obj
        self.active_index = max(0, min(self.active_index, len(self.objects) - 1))
        return self.objects[self.active_index]

    def object_by_ref(self, ref=None):
        """Risolve un riferimento a oggetto: None/omesso = l'attivo, un intero =
        indice, una stringa = nome (primo che combacia, senza distinzione di
        maiuscole). Un riferimento che non esiste e' un errore parlante, non un
        ripiego silenzioso sull'attivo: sbagliare oggetto e non accorgersene e'
        peggio che ricevere un errore."""
        if ref is None or ref == "":
            return self.active
        if isinstance(ref, bool):
            raise ValueError("riferimento oggetto non valido: %r" % (ref,))
        if isinstance(ref, int):
            if 0 <= ref < len(self.objects):
                return self.objects[ref]
            raise ValueError("indice oggetto fuori intervallo: %d (oggetti: %d)"
                             % (ref, len(self.objects)))
        key = str(ref).strip()
        if key.lstrip("-").isdigit():
            return self.object_by_ref(int(key))
        low = key.lower()
        for obj in self.objects:
            if obj.name.lower() == low:
                return obj
        names = ", ".join(o.name for o in self.objects) or "(nessuno)"
        raise ValueError("oggetto '%s' non trovato. Disponibili: %s" % (key, names))

    def index_of(self, obj):
        for i, o in enumerate(self.objects):
            if o is obj:
                return i
        return -1

    def add_object(self, obj, activate=True):
        self.snapshot("aggiungi oggetto")
        obj.name = self.unique_name(obj.name)
        self.objects.append(obj)
        if activate:
            self.active_index = len(self.objects) - 1
        self.dirty = True
        return obj

    def remove_object(self, obj):
        idx = self.index_of(obj)
        if idx < 0:
            raise ValueError("oggetto non presente nella scena")
        if len(self.objects) <= 1:
            raise ValueError("non si puo' eliminare l'unico oggetto della scena")
        self.snapshot("elimina oggetto")
        self.objects.pop(idx)
        self.active_index = min(self.active_index, len(self.objects) - 1)
        self.dirty = True

    def unique_name(self, base):
        base = str(base or "Oggetto").strip() or "Oggetto"
        taken = {o.name for o in self.objects}
        if base not in taken:
            return base
        n = 2
        while "%s %d" % (base, n) in taken:
            n += 1
        return "%s %d" % (base, n)

    # --- storico ----------------------------------------------------------
    #
    # Due forme di voce, come spiega la docstring del modulo: `cells` (diff) per
    # le modifiche ai voxel, `snapshot` (fotografia) per quelle strutturali.

    def edit(self, label, obj=None):
        """Context manager: raccoglie in un'unica voce di storico tutte le celle
        toccate. Usarlo per OGNI mutazione dei voxel, cosi' un'operazione grande
        (riempi una scatola) si annulla in un colpo solo e non cella per cella.

        Le sessioni si possono annidare: solo la piu' esterna chiude la voce.
        Serve agli strumenti composti (es. "specchia e poi salda"), che chiamano
        primitive gia' dotate del proprio `edit`.
        """
        return _EditSession(self, label, obj if obj is not None else self.active)

    def _record(self, obj, key, old):
        if self._pending is None:
            return
        diffs = self._pending["diffs"].setdefault(id(obj), (obj, {}))[1]
        if key not in diffs:
            diffs[key] = old

    def set_cell(self, obj, key, cell):
        old = obj.cells.get(key, MISSING)
        if old is not MISSING and old == cell:
            return False
        self._record(obj, key, old)
        obj.cells[key] = cell
        self.dirty = True
        return True

    def del_cell(self, obj, key):
        old = obj.cells.pop(key, MISSING)
        if old is MISSING:
            return False
        self._record(obj, key, old)
        self.dirty = True
        return True

    def snapshot(self, label):
        """Fotografa il documento intero: per le modifiche strutturali."""
        entry = {"kind": "snapshot", "label": label, "state": self._capture()}
        self._push(entry)

    def _capture(self):
        return {
            "name": self.name,
            "active": self.active_index,
            "materials": copy.deepcopy(self.materials),
            "objects": [{
                "name": o.name,
                "cells": dict(o.cells),
                "transform": copy.deepcopy(o.transform),
                "visible": o.visible,
                "rig": copy.deepcopy(o.rig),
                "grid_size": list(o.grid_size),
                "extra": copy.deepcopy(o.extra_metadata),
            } for o in self.objects],
        }

    def _restore(self, state):
        before = self._capture()
        self.name = state["name"]
        self.materials = copy.deepcopy(state["materials"])
        self.objects = []
        for od in state["objects"]:
            obj = VoxelObject(od["name"], dict(od["cells"]),
                              copy.deepcopy(od["transform"]), od["visible"],
                              copy.deepcopy(od["rig"]), list(od["grid_size"]),
                              copy.deepcopy(od["extra"]))
            self.objects.append(obj)
        self.active_index = state["active"]
        return before

    def _push(self, entry):
        self._undo.append(entry)
        # Le fotografie sono la voce costosa: si potano per prime e a parte,
        # altrimenti un tetto unico lascerebbe passare otto fotografie di fila.
        snaps = [e for e in self._undo if e["kind"] == "snapshot"]
        if len(snaps) > UNDO_MAX_SNAPSHOTS:
            drop = set(id(e) for e in snaps[:-UNDO_MAX_SNAPSHOTS])
            self._undo = [e for e in self._undo if id(e) not in drop]
        if len(self._undo) > UNDO_MAX:
            self._undo = self._undo[-UNDO_MAX:]
        self._redo = []
        self.dirty = True

    def _invert(self, entry):
        """Applica una voce e ritorna la voce che la annulla a sua volta."""
        if entry["kind"] == "snapshot":
            before = self._restore(entry["state"])
            return {"kind": "snapshot", "label": entry["label"], "state": before}
        inverse = {}
        for obj, diffs in entry["diffs"].values():
            back = {}
            for key, old in diffs.items():
                back[key] = obj.cells.get(key, MISSING)
                if old is MISSING:
                    obj.cells.pop(key, None)
                else:
                    obj.cells[key] = old
            inverse[id(obj)] = (obj, back)
        return {"kind": "cells", "label": entry["label"], "diffs": inverse}

    def undo(self):
        if not self._undo:
            return None
        entry = self._undo.pop()
        self._redo.append(self._invert(entry))
        self.dirty = True
        return entry["label"]

    def redo(self):
        if not self._redo:
            return None
        entry = self._redo.pop()
        self._undo.append(self._invert(entry))
        self.dirty = True
        return entry["label"]

    def history(self):
        return {
            "undo": [e["label"] for e in self._undo][-20:],
            "redo": [e["label"] for e in self._redo][-20:],
        }

    # --- materiali --------------------------------------------------------

    def material_by_id(self, mid):
        for m in self.materials:
            if m.get("id") == mid:
                return m
        return None

    def next_material_id(self):
        n = 1
        taken = {m.get("id") for m in self.materials}
        while ("m%d" % n) in taken:
            n += 1
        return "m%d" % n

    # --- serializzazione --------------------------------------------------

    def to_payload(self, materials=True):
        """Il progetto nella forma che l'app apre.

        Un solo oggetto -> formato piatto (identico a quello storico, cosi' un
        file prodotto qui si apre anche con versioni che non conoscono le scene
        multi-oggetto). Piu' oggetti -> { objects: [...] }.
        """
        payloads = [self._object_payload(o, materials) for o in self.objects]
        if len(payloads) == 1:
            out = payloads[0]
            if self.objects[0].rig:
                out["rig"] = copy.deepcopy(self.objects[0].rig)
            return out
        out = {"objects": []}
        rigs = []
        for obj, p in zip(self.objects, payloads):
            entry = {
                "name": obj.name,
                "transform": copy.deepcopy(obj.transform),
                "visible": obj.visible,
                "metadata": p["metadata"],
                "palette": p["palette"],
            }
            if "parts" in p:
                entry["parts"] = p["parts"]
            if "ops" in p:
                entry["ops"] = p["ops"]
            if obj.rig:
                entry["rig"] = copy.deepcopy(obj.rig)
                rigs.append(entry["rig"])
            out["objects"].append(entry)
        # Compatibilita' con le versioni che leggono solo il rig di radice: si
        # duplica SOLO se un unico oggetto e' riggato. Con due rig non esiste
        # "il" rig, e duplicarne uno raddoppierebbe i pesi salvati.
        if len(rigs) == 1:
            out["rig"] = rigs[0]
        return out

    def _object_payload(self, obj, materials=True):
        voxels = obj.voxel_list()
        palette, colour_key = build_palette(c["color"] for c in voxels)
        meta = {
            "name": obj.name,
            "grid_size": list(obj.grid_size),
        }
        meta.update({k: v for k, v in obj.extra_metadata.items()
                     if k not in ("name", "grid_size", "materials", "material_map")})
        if materials and self.materials:
            used = {v.get("material") for v in voxels if v.get("material")}
            defs = [copy.deepcopy(m) for m in self.materials]
            if defs:
                meta["materials"] = defs
            mmap = _material_map(voxels)
            if mmap and used:
                meta["material_map"] = mmap

        has_parts = any(v.get("part") for v in voxels)
        if has_parts:
            groups = {}
            fallback = next((v["part"] for v in voxels if v.get("part")), "main")
            for v in voxels:
                p = v.get("part") or fallback
                groups.setdefault(p, {}).setdefault(v["color"], []).extend(
                    (v["x"], v["y"], v["z"]))
            parts = {}
            for pname, by_colour in groups.items():
                parts[pname] = [["set", colour_key[c]] + coords
                                for c, coords in by_colour.items()]
            return {"metadata": meta, "palette": palette, "parts": parts}

        groups = {}
        for v in voxels:
            groups.setdefault(v["color"], []).extend((v["x"], v["y"], v["z"]))
        ops = [["set", colour_key[c]] + coords for c, coords in groups.items()]
        return {"metadata": meta, "palette": palette, "ops": ops}

    @classmethod
    def from_payload(cls, data, name=None, path=None):
        """Costruisce un documento da un payload di progetto.

        Accetta tutte le forme che l'app scrive o riceve: la busta `.voxai`
        ({format,version,data}), la scena multi-oggetto, il modello singolo
        compatto (ops/parts), e quello gia' piatto (voxels). Le ops si espandono
        con `expand_ops` di `src/parser.py`, cioe' ESATTAMENTE lo stesso codice
        del resto dell'app: una seconda implementazione qui sarebbe una terza
        semantica da tenere allineata (ce ne sono gia' due, ed e' costato tre
        difetti veri — vedi tests/ops_parity_cases.json).
        """
        data = unwrap_project(data)
        doc = cls(name or "Progetto")
        doc.path = path

        entries = data.get("objects") if isinstance(data, dict) else None
        if not isinstance(entries, list) or not entries:
            entries = [data]

        root_rig = data.get("rig") if isinstance(data, dict) else None
        for i, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue
            obj = _object_from_payload(entry, i, doc)
            if obj.rig is None and root_rig and len(entries) == 1:
                obj.rig = copy.deepcopy(root_rig)
            doc.objects.append(obj)

        if not doc.objects:
            doc.objects.append(VoxelObject("Oggetto 1"))
        if len(doc.objects) == 1 and doc.objects[0].name:
            doc.name = name or doc.objects[0].name
        doc.dirty = False
        return doc


def _object_from_payload(entry, index, doc):
    from .compat import expand_ops

    expanded = expand_ops(copy.deepcopy(entry))
    meta = expanded.get("metadata") if isinstance(expanded.get("metadata"), dict) else {}

    # I materiali si FONDONO per id nella lista di progetto (vedi docstring del
    # modulo): sostituirla farebbe sparire quelli degli oggetti gia' caricati.
    for mdef in (meta.get("materials") or []):
        if isinstance(mdef, dict) and mdef.get("id") and not doc.material_by_id(mdef["id"]):
            from .materials import normalize_material
            doc.materials.append(normalize_material(mdef, mdef["id"]))

    voxels = expanded.get("voxels") or []
    # La mappa dei materiali si riversa sui voxel DOPO l'espansione: le ops
    # sanno esprimere solo colori e non devono impararne altri (stessa scelta di
    # applyMaterialMap in 07-save-payload.js). Un id senza definizione NON si
    # applica: il voxel resta a tinta unita, che e' il "materiale neutro" dei
    # file importati senza texture, ottenuto senza un ramo dedicato.
    known = {m.get("id") for m in doc.materials}
    by_key = {}
    for row in (meta.get("material_map") or []):
        if not isinstance(row, (list, tuple)) or len(row) < 4:
            continue
        mid = row[0]
        if mid not in known:
            continue
        for i in range(1, len(row) - 2, 3):
            by_key[(int(row[i]), int(row[i + 1]), int(row[i + 2]))] = mid

    cells = {}
    for v in voxels:
        try:
            key = (int(v["x"]), int(v["y"]), int(v["z"]))
        except (KeyError, TypeError, ValueError):
            continue
        cells[key] = Cell(v.get("color"), v.get("material") or by_key.get(key),
                          v.get("part"))

    grid = meta.get("grid_size")
    if not (isinstance(grid, (list, tuple)) and len(grid) == 3):
        grid = _grid_for(cells)

    name = entry.get("name") or meta.get("name") or ("Oggetto %d" % (index + 1))
    obj = VoxelObject(
        name=name,
        cells=cells,
        transform=entry.get("transform") or default_transform(),
        visible=entry.get("visible", True),
        rig=copy.deepcopy(entry.get("rig")),
        grid_size=[int(g) for g in grid],
        extra_metadata={k: v for k, v in meta.items()
                        if k not in ("name", "grid_size", "materials", "material_map")},
    )
    return obj


def _grid_for(cells):
    """Griglia deducibile da un modello che non la dichiara: la potenza di due
    che lo contiene, con un minimo di 16. Meglio di un default fisso, perche' un
    modello 200^3 dentro una griglia 32 avrebbe meta' fuori dai bordi."""
    if not cells:
        return list(DEFAULT_GRID)
    need = max(max(k[i] for k in cells) for i in range(3)) + 1
    side = 16
    while side < need and side < 512:
        side *= 2
    return [side, side, side]


def _material_map(voxels):
    """metadata.material_map: [[id, x,y,z, x,y,z, ...], ...] — la stessa forma
    di una op `set`, che e' il motivo per cui l'app la sa gia' leggere."""
    by_id = {}
    for v in voxels:
        mid = v.get("material")
        if not mid:
            continue
        by_id.setdefault(mid, []).extend((v["x"], v["y"], v["z"]))
    return [[mid] + coords for mid, coords in by_id.items()]


def unwrap_project(data):
    """Toglie la busta `.voxai` ({format:"voxai", version, savedAt, data}).

    Un `.voxai` salvato dall'app e' una busta; un `.json`/`.voxelai` e' la scena
    diretta. Dimenticare di scartarla ha gia' prodotto un difetto vero (un file
    salvato non si riapriva), quindi si controlla la forma invece del nome.
    """
    if isinstance(data, dict) and isinstance(data.get("data"), dict) and (
            data.get("format") == "voxai" or "version" in data):
        return data["data"]
    return data


class _EditSession(object):
    def __init__(self, doc, label, obj):
        self.doc = doc
        self.label = label
        self.obj = obj
        self.outer = False

    def __enter__(self):
        if self.doc._pending is None:
            self.doc._pending = {"label": self.label, "diffs": {}}
            self.outer = True
        return self.obj

    def __exit__(self, exc_type, exc, tb):
        if not self.outer:
            return False
        pending = self.doc._pending
        self.doc._pending = None
        # Un'operazione che non ha cambiato nulla non lascia una voce nello
        # storico: altrimenti annullare richiederebbe un Ctrl+Z per ogni tentativo
        # a vuoto, che e' esattamente il modo in cui uno storico diventa inutile.
        #
        # Ma se e' fallita a META', la voce va registrata lo stesso: le celle
        # gia' toccate sono la' e senza il diff diventano PERMANENTI, cioe' un
        # errore lascerebbe il modello alterato e non annullabile. La condizione
        # e' quindi "ha cambiato qualcosa", non "e' andata a buon fine".
        if any(d for _, d in pending["diffs"].values()):
            self.doc._push({"kind": "cells", "label": pending["label"],
                            "diffs": pending["diffs"]})
        return False


# --- lettura/scrittura su disco --------------------------------------------

def read_project_file(path):
    """Legge .voxai / .voxai.json / .json / .voxelai (base64) -> payload dict."""
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8", errors="replace").strip()
    if text[:1] not in ("{", "["):
        # `.voxelai` e' il JSON in base64 (btoa(unescape(encodeURIComponent(...)))).
        # Non e' cifratura: e' solo per non invogliare a modificarlo a mano.
        import base64
        try:
            text = base64.b64decode(raw, validate=False).decode("utf-8")
        except Exception as e:                                  # noqa: BLE001
            raise ValueError("file di progetto non leggibile: %s" % e)
    return json.loads(text)


def write_project_file(path, payload, project_id=None):
    """Scrive un progetto. `.voxelai` -> base64, tutto il resto -> JSON.

    Il `.voxai` viene scritto CON la busta, perche' e' quello che l'app si
    aspetta di ritrovare; il `.json` senza, perche' li' e' la scena diretta.
    """
    ext = os.path.splitext(path)[1].lower()
    if ext == ".voxelai":
        import base64
        blob = base64.b64encode(json.dumps(payload, separators=(",", ":"))
                                .encode("utf-8"))
        with open(path, "wb") as f:
            f.write(blob)
        return path
    body = payload
    if ext in (".voxai",) or path.lower().endswith(".voxai.json"):
        body = {
            "format": "voxai",
            "version": 1,
            "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            "data": payload,
        }
        if project_id:
            body["projectId"] = project_id
    with open(path, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    return path
