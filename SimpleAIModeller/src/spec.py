"""Spec SAM v1: normalizzazione, validazione dello SCHEMA, patch.

Cosa fa e cosa NON fa
---------------------
Qui si valida la FORMA della spec, non la geometria. Nessuna primitiva viene
costruita, nessun vertice calcolato: quello vive in un solo posto, `ui/src/lib`
(JS), e ci vive da solo di proposito. Il repo ha gia' pagato il prezzo della
doppia implementazione — `expand_ops` in Python e `expandOps` in JS, con un test
di parita' dedicato perche' tre divergenze reali (box con float che dava ZERO
voxel, `int()` contro `Math.round()`, l'arrotondamento bancario di Python) erano
sfuggite a tutto il resto. Non si ripete: il server controlla nomi, riferimenti,
intervalli e campi mancanti; il browser costruisce.

Perche' la normalizzazione e' cosi' permissiva
----------------------------------------------
L'ingresso e' la risposta di un modello linguistico, e rifiutare una spec per una
chiave scritta al plurale costa all'utente una rigenerazione intera (decine di
secondi e un pezzo di quota). Quindi si accettano gli alias — compresa la forma
ANNIDATA della specifica originale (`geometry.base_mesh`, `sub_modules`,
`procedural_shader`, `assembly_logic`), che e' quella che un modello produce se
gli si mostra quell'esempio. Tutto cio' che viene ricondotto lascia un AVVISO.

Gli avvisi sono CODICI, non frasi
--------------------------------
Questo modulo non ha DOM e non sa in che lingua parla l'utente: emette
`{"code": "...", "at": "..."}`. Traduce chi mostra. E' la stessa regola delle
ops 2D di PixelAIEditor, dove scriverci le frasi dentro ha significato tradurre
il modulo invece del messaggio.
"""

import json
import re

SPEC_VERSION = 1

# --- Tabelle condivise col prompt -------------------------------------------
# Sono qui e non nel template dei prompt perche' il prompt le CITA: se le due
# liste divergessero, il modello userebbe una primitiva che il motore non ha.

CATEGORIES = ("char", "vehicle", "prop", "struct")

CATEGORY_ALIASES = {
    "character": "char", "personaggio": "char", "humanoid": "char",
    "umanoide": "char", "creature": "char", "creatura": "char", "npc": "char",
    "veicolo": "vehicle", "car": "vehicle", "auto": "vehicle", "ship": "vehicle",
    "navicella": "vehicle", "mech": "vehicle", "tank": "vehicle",
    "oggetto": "prop", "item": "prop", "props": "prop", "arredo": "prop",
    "weapon": "prop", "arma": "prop", "tool": "prop", "platform": "prop",
    "piattaforma": "prop", "furniture": "prop",
    "struttura": "struct", "building": "struct", "edificio": "struct",
    "architecture": "struct", "architettura": "struct", "level": "struct",
    "environment": "struct", "scenario": "struct", "modular": "struct",
}

STYLES = ("lowpoly", "pbr", "toon")

STYLE_ALIASES = {
    "low_poly": "lowpoly", "low-poly": "lowpoly", "stylized": "lowpoly",
    "stilizzato": "lowpoly", "flat": "lowpoly", "faceted": "lowpoly",
    # `voxel_art` compare nell'esempio della specifica originale. Qui non ci sono
    # voxel: si ricade su lowpoly, che e' il preset con lo stesso spirito
    # (palette limitata, facce piatte), e lo si DICE con un avviso.
    "voxel_art": "lowpoly", "voxel": "lowpoly", "blocky": "lowpoly",
    "realistic": "pbr", "realistico": "pbr", "pbr_procedural": "pbr",
    "semi_realistic": "pbr", "metallic": "pbr",
    "cartoon": "toon", "cel": "toon", "cel_shaded": "toon", "anime": "toon",
    "fumetto": "toon",
}

# Primitive. Il valore e' l'elenco dei campi che quella primitiva LEGGE: serve
# alla validazione (un campo ignorato e' un avviso, non un silenzio) e al prompt.
PRIMITIVES = {
    "box":    ("s", "bevel"),
    "plane":  ("s", "axis"),
    "sphere": ("r", "s"),
    "cyl":    ("r", "len", "axis", "taper", "cap"),
    "caps":   ("r", "len", "axis"),
    "torus":  ("r", "r2", "axis", "arc"),
    "wedge":  ("s", "axis"),
    "pyr":    ("s", "axis"),
    "tube":   ("r", "len", "axis", "path", "wall"),
    "extr":   ("prof", "len", "axis", "s", "bevel", "sides", "inner"),
    "lathe":  ("prof", "axis", "arc", "sides"),
    "loft":   ("secs", "axis", "closed", "shape"),
    "helix":  ("r", "r2", "len", "axis", "turns"),
    "field":  ("s", "seed", "amp", "freq", "axis"),
    "stairs": ("s", "steps", "axis"),
    "arch":   ("s", "r", "axis", "wall"),
}

# Sezioni trasversali del loft. `lens` e' la sezione di una LAMA (due archi che
# si incontrano in due punte laterali): senza, ogni lama e' un parallelepipedo.
LOFT_SHAPES = ("ellipse", "rect", "lens", "hex", "tri")

LOFT_SHAPE_ALIASES = {
    "circle": "ellipse", "round": "ellipse", "cerchio": "ellipse",
    "box": "rect", "square": "rect", "rettangolo": "rect", "quad": "rect",
    "blade": "lens", "lente": "lens", "lenticular": "lens", "diamond": "lens",
    "hexagon": "hex", "esagono": "hex",
    "triangle": "tri", "triangolo": "tri",
}

PRIM_ALIASES = {
    "primitive_box": "box", "cube": "box", "cubo": "box", "block": "box",
    "boxe": "box", "rect": "box", "cuboid": "box", "brick": "box",
    "primitive_plane": "plane", "quad": "plane", "piano": "plane",
    "primitive_sphere": "sphere", "ball": "sphere", "sfera": "sphere",
    "ico": "sphere", "icosphere": "sphere", "uvsphere": "sphere",
    "cylinder": "cyl", "cilindro": "cyl", "disc": "cyl", "disk": "cyl",
    "rod": "cyl", "pipe": "tube", "tubo": "tube", "cylinder_hollow": "tube",
    "capsule": "caps", "capsula": "caps", "pill": "caps",
    "cone": "cone", "cono": "cone",                       # gestito a parte
    "toro": "torus", "ring": "torus", "anello": "torus", "donut": "torus",
    "prism": "wedge", "ramp": "wedge", "rampa": "wedge", "cuneo": "wedge",
    "pyramid": "pyr", "piramide": "pyr", "spike": "pyr",
    "extrude": "extr", "extrusion": "extr", "estrusione": "extr",
    "profile": "extr", "polygon": "extr", "ngon": "extr",
    "revolve": "lathe", "rivoluzione": "lathe", "spin": "lathe",
    "sweep": "loft", "sezioni": "loft", "hull": "loft",
    "spiral": "helix", "spring": "helix", "molla": "helix", "elica": "helix",
    "heightfield": "field", "terrain": "field", "terreno": "field",
    "noise": "field", "rock": "field", "roccia": "field",
    "scale": "stairs", "scala": "stairs", "steps": "stairs", "gradini": "stairs",
    "arco": "arch", "archway": "arch", "vault": "arch",
}

BOOL_OPS = ("sub", "int", "uni")

BOOL_ALIASES = {
    "subtract": "sub", "difference": "sub", "diff": "sub", "cut": "sub",
    "sottrai": "sub", "minus": "sub", "carve": "sub", "hole": "sub",
    "intersect": "int", "intersection": "int", "and": "int",
    "interseca": "int", "common": "int",
    "union": "uni", "add": "uni", "join": "uni", "unisci": "uni",
    "merge": "uni", "weld": "uni",
}

# `detail` non e' decorativo: decide i segmenti delle primitive tonde, i passi
# del bevel e quanti nodi ha senso chiedere. Il motore JS legge la STESSA
# tabella (`08-spec.js` -> DETAIL_LEVELS): duplicarne i valori a mano nei due
# posti li farebbe divergere, quindi il prompt cita questa e il JS ha la sua
# copia coperta da un test che confronta i due file.
DETAIL_LEVELS = (
    {"seg": 8,  "bevel": 1, "nodes": 12,  "label": "bozza"},
    {"seg": 12, "bevel": 1, "nodes": 30,  "label": "basso"},
    {"seg": 20, "bevel": 2, "nodes": 80,  "label": "medio"},
    {"seg": 32, "bevel": 3, "nodes": 200, "label": "alto"},
)

# Bandiere di assemblaggio: la specifica originale le passa come UNA stringa
# (`"assembly_logic": "flatten_top_surface_and_exclude_center_pivot"`), quindi si
# accetta sia la stringa che una lista. Ogni bandiera accende un validatore.
FLAGS = (
    "flat_top",         # faccia superiore rigorosamente piatta
    "no_center_pivot",  # niente geometria al centro sopra il piano
    "symmetric_x",      # simmetria sinistra/destra pretesa
    "hollow",           # interni cavi, non un blocco pieno
    "big_cabin",        # cabina maggiorata (veicoli)
    "arms_down",        # braccia in basso a riposo (umanoidi)
    "modular",          # si incastra con altri pezzi sulla griglia
)

FLAG_HINTS = {
    "flatten_top_surface": "flat_top", "flat_top_surface": "flat_top",
    "flatten_top": "flat_top", "superficie_piatta": "flat_top",
    "exclude_center_pivot": "no_center_pivot", "no_center_bar": "no_center_pivot",
    "exclude_center": "no_center_pivot", "centro_libero": "no_center_pivot",
    "symmetric": "symmetric_x", "mirror_x": "symmetric_x",
    "simmetrico": "symmetric_x", "bilateral": "symmetric_x",
    "hollow_interior": "hollow", "interiors": "hollow", "cavo": "hollow",
    "oversized_cabin": "big_cabin", "large_cockpit": "big_cabin",
    "big_cockpit": "big_cabin", "cabina_grande": "big_cabin",
    "arms_at_rest": "arms_down", "arms_lowered": "arms_down",
    "braccia_in_basso": "arms_down",
    "modular_kit": "modular", "tileable": "modular", "modulare": "modular",
}

# Funzioni e costanti ammesse nelle espressioni. Serve solo a distinguere un
# IDENTIFICATORE ignoto (parametro inesistente: avviso) da una funzione nota.
# La valutazione vera sta nel JS: qui non si calcola nulla.
EXPR_FUNCS = ("min", "max", "abs", "sqrt", "sin", "cos", "tan", "clamp",
              "floor", "ceil", "round", "pow", "sign", "lerp", "mod")
EXPR_CONSTS = ("PI", "TAU", "E", "SQRT2")

_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$")
_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

MAX_NODES = 400
MAX_PARAMS = 80
MAX_MATS = 40


# --- Utilita' ---------------------------------------------------------------

def _warn(out, code, at=None, extra=None):
    """Un avviso e' un codice + dove. Duplicati compressi: la stessa causa
    ripetuta su 200 nodi riempirebbe il pannello e nasconderebbe il resto."""
    item = {"code": code}
    if at:
        item["at"] = str(at)[:80]
    if extra is not None:
        item["v"] = str(extra)[:60]
    for w in out:
        if w.get("code") == code and w.get("at") == item.get("at"):
            w["n"] = w.get("n", 1) + 1
            return
    out.append(item)


def _first(d, *names, **kw):
    """Primo campo presente fra piu' alias. `default` come keyword."""
    default = kw.get("default")
    if not isinstance(d, dict):
        return default
    for n in names:
        if n in d and d[n] is not None:
            return d[n]
    return default


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return list(v)
    return [v]


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float("inf"), float("-inf")):     # NaN / inf
        return default
    return f


def _clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def _slug(v, fallback="asset"):
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", str(v or "")).strip("_")
    return (s or fallback)[:64]


# --- Valori scalari o espressioni -------------------------------------------

def _scalar(v, warns, at, params):
    """Un numero, oppure una stringa-espressione lasciata intatta.

    Non si valuta: si controlla soltanto che gli identificatori citati esistano
    fra i parametri o fra le funzioni note. Un'espressione che cita `hh` invece
    di `h` altrimenti diventerebbe zero in silenzio nel browser, e il difetto
    apparirebbe come "il nodo non c'e'" a chi guarda il render.
    """
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return _num(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            _warn(warns, "emptyExpr", at)
            return 0.0
        # Una stringa che e' solo un numero ("0.5") si normalizza a numero: e'
        # piu' piccola da riscrivere in una patch e non passa dal parser.
        try:
            return float(s)
        except ValueError:
            pass
        for ident in set(_IDENT_RE.findall(s)):
            if ident in EXPR_FUNCS or ident in EXPR_CONSTS:
                continue
            if ident in params:
                continue
            _warn(warns, "unknownParam", at, ident)
        return s
    _warn(warns, "badScalar", at, type(v).__name__)
    return 0.0


def _vec3(v, warns, at, params, default=(0.0, 0.0, 0.0)):
    """Tre scalari. Un numero singolo si espande (una scala uniforme e' comune),
    due si completano col terzo a 1 solo per le scale — qui si e' conservativi e
    si riempie con il default, segnalando."""
    if v is None:
        return list(default)
    if isinstance(v, (int, float, str)):
        s = _scalar(v, warns, at, params)
        return [s, s, s]
    if isinstance(v, dict):
        v = [_first(v, "x", "w", "0", default=default[0]),
             _first(v, "y", "h", "1", default=default[1]),
             _first(v, "z", "d", "2", default=default[2])]
    if not isinstance(v, (list, tuple)):
        _warn(warns, "badVec3", at, type(v).__name__)
        return list(default)
    items = list(v)
    if len(items) != 3:
        _warn(warns, "vec3Length", at, len(items))
        while len(items) < 3:
            items.append(default[len(items)] if len(items) < 3 else 0.0)
        items = items[:3]
    return [_scalar(x, warns, at, params) for x in items]


# --- Materiali ---------------------------------------------------------------

NOISE_TYPES = ("none", "fbm", "cell", "scratch", "stripe", "spot", "grain")

NOISE_ALIASES = {
    "simplex": "fbm", "perlin": "fbm", "noise": "fbm", "wood": "fbm",
    "legno": "fbm", "marble": "fbm", "clouds": "fbm", "turbulence": "fbm",
    "voronoi": "cell", "cellular": "cell", "stone": "cell", "pietra": "cell",
    "rock": "cell", "crackle": "cell",
    "scratches": "scratch", "brushed": "scratch", "metal": "scratch",
    "graffi": "scratch", "worn": "scratch",
    "stripes": "stripe", "bands": "stripe", "strisce": "stripe",
    "planks": "stripe", "tiles": "stripe",
    "spots": "spot", "dots": "spot", "rust": "spot", "ruggine": "spot",
    "speckle": "grain", "noise_fine": "grain", "dither": "grain",
}


def _color(v, warns, at, default="#CCCCCC"):
    s = str(v or "").strip()
    if not s:
        return default
    if not s.startswith("#"):
        s = "#" + s
    if len(s) == 4:                                     # #abc -> #aabbcc
        s = "#" + s[1] * 2 + s[2] * 2 + s[3] * 2
    if not _HEX_RE.match(s):
        _warn(warns, "badColor", at, v)
        return default
    return s.upper()


def _material(raw, warns, at):
    if not isinstance(raw, dict):
        # `"legno": "#5C4033"` e' una forma che un modello produce spesso: e'
        # inequivocabile, quindi si accetta invece di scartare il materiale.
        raw = {"col": raw}
    out = {
        "col": _color(_first(raw, "col", "color", "base_color", "baseColor",
                             "hex", "tint"), warns, at),
        "rough": _clamp(_num(_first(raw, "rough", "roughness", default=0.7), 0.7), 0.0, 1.0),
        "metal": _clamp(_num(_first(raw, "metal", "metalness", "metallic",
                                    default=0.0), 0.0), 0.0, 1.0),
        "emit": _clamp(_num(_first(raw, "emit", "emissive", "emission",
                                   default=0.0), 0.0), 0.0, 4.0),
        "opacity": _clamp(_num(_first(raw, "opacity", "alpha", default=1.0), 1.0), 0.05, 1.0),
    }
    emit_col = _first(raw, "emitCol", "emissive_color", "emissiveColor")
    if emit_col:
        out["emitCol"] = _color(emit_col, warns, at)
    noise = _first(raw, "noise", "procedural", "procedural_shader", "pattern")
    if noise is not None:
        if not isinstance(noise, dict):
            noise = {"t": noise}
        nt = str(_first(noise, "t", "type", "kind", default="fbm") or "fbm").strip().lower()
        nt = NOISE_ALIASES.get(nt, nt)
        if nt not in NOISE_TYPES:
            _warn(warns, "unknownNoise", at, nt)
            nt = "fbm"
        if nt != "none":
            n = {
                "t": nt,
                # `noise_scale` della specifica originale e' la stessa cosa di
                # `scale`: la frequenza del rumore in unita' di mondo.
                "scale": _clamp(_num(_first(noise, "scale", "noise_scale", "freq",
                                            "frequency", default=12.0), 12.0), 0.05, 400.0),
                "amp": _clamp(_num(_first(noise, "amp", "amount", "strength",
                                          "intensity", default=0.18), 0.18), 0.0, 1.0),
            }
            col2 = _first(noise, "col2", "color2", "secondary", "dark", "tint2")
            if col2:
                n["col2"] = _color(col2, warns, at)
            warp = _num(_first(noise, "warp", "distort", default=0.0), 0.0)
            if warp:
                n["warp"] = _clamp(warp, 0.0, 2.0)
            bands = _first(noise, "bands", "steps", "levels")
            if bands is not None:
                n["bands"] = int(_clamp(_num(bands, 0), 0, 16))
            rough_amp = _first(noise, "roughAmp", "rough_amp")
            if rough_amp is not None:
                n["roughAmp"] = _clamp(_num(rough_amp, 0.0), 0.0, 1.0)
            n["seed"] = int(_clamp(_num(_first(noise, "seed", default=0), 0), 0, 99999))
            out["noise"] = n
    return out


# --- Nodi -------------------------------------------------------------------

def _profile(raw, warns, at, params):
    """Profilo 2D per `extr` / `lathe`: nome noto o lista di punti."""
    if isinstance(raw, str):
        s = raw.strip().lower()
        known = ("rect", "rrect", "ngon", "star", "l", "t", "cross", "arc",
                 "tri", "trapz", "teardrop")
        if s not in known:
            _warn(warns, "unknownProfile", at, s)
            return "rect"
        return s
    if isinstance(raw, dict):
        # `{"t":"ngon","sides":6}` — i parametri restano sul nodo, qui solo il tipo.
        return _profile(_first(raw, "t", "type", "shape", default="rect"),
                        warns, at, params)
    pts = _as_list(raw)
    if not pts:
        return "rect"
    out = []
    for p in pts:
        if isinstance(p, dict):
            p = [_first(p, "x", "u", "0", default=0), _first(p, "y", "v", "1", default=0)]
        pair = _as_list(p)
        if len(pair) < 2:
            _warn(warns, "badProfilePoint", at)
            continue
        out.append([_scalar(pair[0], warns, at, params),
                    _scalar(pair[1], warns, at, params)])
    if len(out) < 3:
        _warn(warns, "profileTooShort", at, len(out))
        return "rect"
    return out


def _node(raw, warns, params, index):
    if not isinstance(raw, dict):
        _warn(warns, "badNode", "nodes[%d]" % index, type(raw).__name__)
        return None

    name = _first(raw, "n", "name", "id", "label", default="")
    name = _slug(name, "n%d" % (index + 1))
    at = "nodes.%s" % name

    prim = str(_first(raw, "p", "prim", "primitive", "shape", "base_mesh",
                      "mesh", "type", default="box") or "box").strip().lower()
    prim = PRIM_ALIASES.get(prim, prim)
    node = {"n": name}

    # `cone` non e' una primitiva a se': e' un cilindro con la punta. Tenerlo
    # come alias con `taper` implicito evita una primitiva in piu' che si
    # comporterebbe come un caso particolare di quella che c'e' gia'.
    implicit_taper = None
    if prim == "cone":
        prim, implicit_taper = "cyl", 0.0
    if prim not in PRIMITIVES:
        _warn(warns, "unknownPrimitive", at, prim)
        prim = "box"
    node["p"] = prim

    node["at"] = _vec3(_first(raw, "at", "pos", "position", "relative_position",
                              "offset", "loc"), warns, at, params)
    rot = _first(raw, "rot", "rotation", "rotate", "euler")
    if rot is not None:
        node["rot"] = _vec3(rot, warns, at, params)

    size = _first(raw, "s", "size", "scale", "dim", "dimensions", "extent")
    if size is not None:
        node["s"] = _vec3(size, warns, at, params, default=(1.0, 1.0, 1.0))

    for key, aliases in (("r", ("r", "radius", "rad", "r1")),
                         ("r2", ("r2", "radius2", "inner", "innerRadius", "minor")),
                         ("len", ("len", "length", "height", "h", "depth")),
                         ("taper", ("taper", "tip", "topScale")),
                         ("arc", ("arc", "angle", "sweep")),
                         ("wall", ("wall", "thickness", "t")),
                         ("amp", ("amp", "amplitude")),
                         ("freq", ("freq", "frequency")),
                         ("turns", ("turns", "coils")),
                         ("bevel", ("bevel", "round", "fillet", "chamfer")),
                         ("inner", ("inner", "hole"))):
        v = _first(raw, *aliases)
        if v is not None:
            node[key] = _scalar(v, warns, at, params)
    if implicit_taper is not None and "taper" not in node:
        node["taper"] = implicit_taper

    for key, aliases, lo, hi in (("sides", ("sides", "segments", "seg", "n"), 3, 128),
                                 ("steps", ("steps", "count"), 1, 64),
                                 ("seed", ("seed",), 0, 99999)):
        v = _first(raw, *aliases)
        if v is not None:
            node[key] = int(_clamp(_num(v, lo), lo, hi))

    axis = _first(raw, "axis", "along", "dir", "orientation")
    if axis is not None:
        a = str(axis).strip().lower()[:1]
        if a not in ("x", "y", "z"):
            _warn(warns, "badAxis", at, axis)
            a = "y"
        node["axis"] = a

    if _first(raw, "cap", "capped") is not None:
        node["cap"] = bool(_first(raw, "cap", "capped"))
    if _first(raw, "closed") is not None:
        node["closed"] = bool(_first(raw, "closed"))

    prof = _first(raw, "prof", "profile", "section", "shape2d", "points", "pts")
    if prof is not None:
        node["prof"] = _profile(prof, warns, at, params)

    secs = _first(raw, "secs", "sections", "rings")
    if secs is not None:
        out_secs = []
        for s in _as_list(secs):
            if not isinstance(s, dict):
                _warn(warns, "badSection", at)
                continue
            out_secs.append({
                "at": _scalar(_first(s, "at", "t", "pos", default=0), warns, at, params),
                "s": _vec3(_first(s, "s", "size", "scale", default=[1, 1, 1]),
                           warns, at, params, default=(1.0, 1.0, 1.0)),
            })
        if len(out_secs) >= 2:
            node["secs"] = out_secs
        else:
            _warn(warns, "loftTooFewSections", at, len(out_secs))

    path = _first(raw, "path", "curve", "spline")
    if path is not None:
        pts = []
        for p in _as_list(path):
            pts.append(_vec3(p, warns, at, params))
        if len(pts) >= 2:
            node["path"] = pts
        else:
            _warn(warns, "pathTooShort", at, len(pts))

    mat = _first(raw, "mat", "material", "mats", "surface")
    if mat is not None:
        node["mat"] = _slug(mat, "m1")

    op = _first(raw, "op", "operation", "boolean", "bool", "csg")
    if op is not None:
        o = str(op).strip().lower()
        o = BOOL_ALIASES.get(o, o)
        if o not in BOOL_OPS:
            _warn(warns, "unknownOp", at, op)
        else:
            node["op"] = o
            target = _first(raw, "of", "target", "on", "against", "parent")
            if target:
                node["of"] = _slug(target, "")
            else:
                _warn(warns, "opWithoutTarget", at)
                node.pop("op", None)

    arr = _first(raw, "arr", "array", "repeat", "instances")
    if isinstance(arr, dict):
        n = int(_clamp(_num(_first(arr, "n", "count", "num", default=2), 2), 1, 64))
        step = _vec3(_first(arr, "step", "offset", "spacing", "delta"),
                     warns, at, params)
        if n > 1:
            node["arr"] = {"n": n, "step": step}
            rot_step = _first(arr, "rot", "rotStep", "spin")
            if rot_step is not None:
                node["arr"]["rot"] = _vec3(rot_step, warns, at, params)
    elif arr is not None:
        _warn(warns, "badArray", at)

    mir = _first(raw, "mir", "mirror", "symmetry")
    if mir is not None:
        m = str(mir).strip().lower()
        if m in ("true", "1", "yes"):
            m = "x"
        m = m[:1]
        if m in ("x", "y", "z"):
            node["mir"] = m
        elif m:
            _warn(warns, "badMirror", at, mir)

    bend = _first(raw, "bend", "twist", "curve_deform")
    if isinstance(bend, dict):
        node["bend"] = {"a": _scalar(_first(bend, "a", "angle", default=0),
                                     warns, at, params),
                        "axis": str(_first(bend, "axis", default="y"))[:1].lower()}

    # --- Deformatori -------------------------------------------------------
    # Un motore che sa solo piazzare volumi produce oggetti fatti di mattoni.
    # Questi campi sono cio' che rende una lama una lama: si accettano in
    # diverse forme (numero, [a,b], {x,z}) perche' il generatore le usa tutte.
    def _pair(v):
        if isinstance(v, dict):
            out = {}
            for src, dst in (("a", "a"), ("x", "a"), ("w", "a"),
                             ("b", "b"), ("z", "b"), ("d", "b")):
                if src in v and v[src] is not None and dst not in out:
                    out[dst] = _scalar(v[src], warns, at, params)
            if "a" not in out:
                out["a"] = 1.0
            if "b" not in out:
                out["b"] = out["a"]
            return out
        if isinstance(v, (list, tuple)) and v:
            a = _scalar(v[0], warns, at, params)
            b = _scalar(v[1], warns, at, params) if len(v) > 1 else a
            return {"a": a, "b": b}
        s = _scalar(v, warns, at, params)
        return {"a": s, "b": s}

    taper_to = _first(raw, "taperTo", "taper_to", "taperEnd", "narrowTo",
                      "tipScale", "endScale")
    if taper_to is not None:
        node["taperTo"] = _pair(taper_to)
    taper_from = _first(raw, "taper0", "taperFrom", "taper_from", "startScale",
                        "baseScale")
    if taper_from is not None:
        node["taper0"] = _pair(taper_from)

    squash = _first(raw, "squash", "flatten", "oneSide")
    if isinstance(squash, dict):
        node["squash"] = {
            "axis": str(_first(squash, "axis", default="z"))[:1].lower(),
            "side": ("min" if str(_first(squash, "side", default="max")).lower()
                     .startswith("min") else "max"),
            "f": _clamp(_num(_first(squash, "f", "factor", "amount", default=0.5), 0.5),
                        0.0, 1.0),
        }

    shear = _first(raw, "shear", "slant", "lean")
    if isinstance(shear, dict):
        node["shear"] = {
            "by": str(_first(shear, "by", "towards", "axis", default="z"))[:1].lower(),
            "amount": _scalar(_first(shear, "amount", "a", "offset", default=0),
                              warns, at, params),
        }
    elif shear is not None:
        node["shear"] = {"by": "z", "amount": _scalar(shear, warns, at, params)}

    twist = _first(raw, "twist", "twistDeg")
    if twist is not None and not isinstance(twist, dict):
        node["twist"] = _scalar(twist, warns, at, params)

    bend_a = _first(raw, "bendA", "bendDeg", "curve")
    if bend_a is not None:
        node["bendA"] = _scalar(bend_a, warns, at, params)
        bend_to = _first(raw, "bendTo", "bendTowards")
        if bend_to:
            node["bendTo"] = str(bend_to)[:1].lower()
    elif isinstance(bend, dict) and bend.get("a"):
        # `bend: {a, axis}` e' la forma storica: si traduce nei campi nuovi
        # invece di tenere due strade che fanno la stessa cosa.
        node["bendA"] = node["bend"]["a"]
        node["bendTo"] = node["bend"].get("axis") or "z"
        node.pop("bend", None)

    warp = _first(raw, "warp", "roughness_deform", "irregular", "bumpy")
    if isinstance(warp, dict):
        node["warp"] = {
            "amp": _scalar(_first(warp, "amp", "amount", "a", default=0),
                           warns, at, params),
            "freq": _scalar(_first(warp, "freq", "frequency", "f", default=4),
                            warns, at, params),
            "seed": int(_clamp(_num(_first(warp, "seed", default=0), 0), 0, 99999)),
        }
    elif warp is not None:
        node["warp"] = {"amp": _scalar(warp, warns, at, params), "freq": 4, "seed": 0}

    shape = _first(raw, "shape", "section", "crossSection", "sezione")
    if shape is not None and not isinstance(shape, (list, tuple, dict)):
        sh = str(shape).strip().lower()
        sh = LOFT_SHAPE_ALIASES.get(sh, sh)
        if sh in LOFT_SHAPES:
            node["shape"] = sh
        else:
            _warn(warns, "unknownShape", at, shape)

    if _first(raw, "locked", "manual") is not None:
        node["locked"] = bool(_first(raw, "locked", "manual"))

    bone = _first(raw, "bone", "armature_bone", "attach", "joint")
    if bone:
        node["bone"] = _slug(bone, "")

    if _first(raw, "interactive", "trigger", "movable") is not None:
        node["interactive"] = bool(_first(raw, "interactive", "trigger", "movable"))
    if _first(raw, "collider", "col", "collision") is not None:
        node["collider"] = bool(_first(raw, "collider", "col", "collision"))
    if _first(raw, "hidden", "invisible") is not None:
        node["hidden"] = bool(_first(raw, "hidden", "invisible"))

    role = _first(raw, "role", "part", "kind", "semantic")
    if role:
        node["role"] = _slug(role, "")

    return node


# --- Rig, clip, logica, collider --------------------------------------------

def _bone(raw, warns, params, index):
    if not isinstance(raw, dict):
        _warn(warns, "badBone", "rig[%d]" % index)
        return None
    name = _slug(_first(raw, "b", "bone", "n", "name", "id", default=""),
                 "b%d" % (index + 1))
    at = "rig.%s" % name
    out = {"b": name,
           "piv": _vec3(_first(raw, "piv", "pivot", "at", "pos", "position",
                               "relative_position", "origin"),
                        warns, at, params)}
    parent = _first(raw, "parent", "of", "up")
    if parent:
        out["parent"] = _slug(parent, "")
    axis = _first(raw, "axis", "hinge")
    if axis:
        a = str(axis).strip().lower()[:1]
        if a in ("x", "y", "z"):
            out["axis"] = a
        else:
            _warn(warns, "badAxis", at, axis)
    lim = _first(raw, "lim", "limits", "range")
    if isinstance(lim, (list, tuple)) and len(lim) >= 2:
        out["lim"] = [_num(lim[0]), _num(lim[1])]
    return out


def _clips(raw, warns, bones):
    """Clip di animazione. Due forme accettate:

      "clips": {"apri": {"dur":0.6, "keys":[[0,{"lid":[0,0,0]}], ...]}}
      "rotation_keyframes": {"idle":[0,0,0], "walk_cycle":[-45,0,45]}

    La seconda e' quella della specifica originale, dove i gradi sono per UN
    osso: si accetta e si espande in una clip di due chiavi sull'osso a cui la
    voce era appesa. Rifiutarla vorrebbe dire buttare via l'animazione che il
    modello ha davvero prodotto.
    """
    out = {}
    if not isinstance(raw, dict):
        if raw is not None:
            _warn(warns, "badClips", "clips")
        return out
    known = set(bones)
    for name, body in raw.items():
        cname = _slug(name, "clip")
        at = "clips.%s" % cname
        if isinstance(body, (list, tuple)) and body and not isinstance(body[0], (list, tuple, dict)):
            # forma [gx,gy,gz]: una posa, non una clip. Serve un osso: se ce n'e'
            # uno solo e' inequivocabile, altrimenti si segnala e si salta.
            if len(known) == 1:
                only = list(known)[0]
                out[cname] = {"dur": 0.8, "loop": True, "keys": [
                    [0.0, {only: [0.0, 0.0, 0.0]}],
                    [0.8, {only: [_num(body[0]), _num(body[1] if len(body) > 1 else 0),
                                  _num(body[2] if len(body) > 2 else 0)]}]]}
            else:
                _warn(warns, "poseWithoutBone", at)
            continue
        if not isinstance(body, dict):
            _warn(warns, "badClip", at)
            continue
        keys = []
        for k in _as_list(_first(body, "keys", "keyframes", "frames", default=[])):
            if isinstance(k, dict):
                t = _num(_first(k, "t", "time", "at", default=0))
                poses = _first(k, "pose", "bones", "rot", default={}) or {}
            elif isinstance(k, (list, tuple)) and len(k) >= 2:
                t, poses = _num(k[0]), k[1]
            else:
                _warn(warns, "badKey", at)
                continue
            if not isinstance(poses, dict):
                _warn(warns, "badKeyPose", at)
                continue
            clean = {}
            for bname, val in poses.items():
                bn = _slug(bname, "")
                if bn not in known:
                    _warn(warns, "clipUnknownBone", at, bn)
                    continue
                if isinstance(val, dict):
                    entry = {}
                    if _first(val, "rot", "r") is not None:
                        entry["rot"] = [_num(x) for x in _as_list(_first(val, "rot", "r"))[:3]]
                    if _first(val, "pos", "p") is not None:
                        entry["pos"] = [_num(x) for x in _as_list(_first(val, "pos", "p"))[:3]]
                    if entry:
                        clean[bn] = entry
                else:
                    vals = [_num(x) for x in _as_list(val)[:3]]
                    while len(vals) < 3:
                        vals.append(0.0)
                    clean[bn] = vals
            if clean:
                keys.append([max(0.0, t), clean])
        if not keys:
            _warn(warns, "clipWithoutKeys", at)
            continue
        keys.sort(key=lambda kv: kv[0])
        dur = _num(_first(body, "dur", "duration", "length",
                          default=keys[-1][0] or 1.0), 1.0)
        out[cname] = {"dur": max(0.05, dur),
                      "loop": bool(_first(body, "loop", "cycle", default=True)),
                      "keys": keys}
    return out


def _logic(raw, warns, node_names, clip_names):
    out = []
    for i, item in enumerate(_as_list(raw)):
        at = "logic[%d]" % i
        if isinstance(item, str):
            # `"assembly_logic": "flatten_top..."` non e' un binding: e' una
            # bandiera, gestita altrove. Qui si ignora senza rumore.
            continue
        if not isinstance(item, dict):
            _warn(warns, "badLogic", at)
            continue
        target = _slug(_first(item, "on", "node", "target", "element", default=""), "")
        if target and target not in node_names:
            _warn(warns, "logicUnknownNode", at, target)
        entry = {"on": target,
                 "var": _slug(_first(item, "var", "variable", "state", "flag",
                                     default="state"), "state"),
                 "trig": str(_first(item, "trig", "trigger", "on_event", "event",
                                    default="interact") or "interact")[:32]}
        clip = _first(item, "clip", "anim", "animation", "play")
        if clip:
            c = _slug(clip, "")
            if c not in clip_names:
                _warn(warns, "logicUnknownClip", at, c)
            else:
                entry["clip"] = c
        rng = _first(item, "range", "values")
        if isinstance(rng, (list, tuple)) and len(rng) >= 2:
            entry["range"] = [_num(rng[0]), _num(rng[1])]
        out.append(entry)
    return out


COLLIDER_TYPES = ("box", "sphere", "caps", "mesh")


def _colliders(raw, warns, params):
    out = []
    for i, item in enumerate(_as_list(raw)):
        at = "col[%d]" % i
        if isinstance(item, str):
            out.append({"t": "mesh", "of": _slug(item, "")})
            continue
        if not isinstance(item, dict):
            _warn(warns, "badCollider", at)
            continue
        t = str(_first(item, "t", "type", "shape", default="box") or "box").strip().lower()
        if t in ("capsule", "capsula"):
            t = "caps"
        if t not in COLLIDER_TYPES:
            _warn(warns, "unknownColliderType", at, t)
            t = "box"
        c = {"t": t,
             "at": _vec3(_first(item, "at", "pos", "center"), warns, at, params)}
        if t == "box":
            c["s"] = _vec3(_first(item, "s", "size", "extent", default=[1, 1, 1]),
                           warns, at, params, default=(1.0, 1.0, 1.0))
        elif t in ("sphere", "caps"):
            c["r"] = _scalar(_first(item, "r", "radius", default=0.5), warns, at, params)
            if t == "caps":
                c["len"] = _scalar(_first(item, "len", "height", default=1.0),
                                   warns, at, params)
                c["axis"] = str(_first(item, "axis", default="y"))[:1].lower()
        else:
            of = _first(item, "of", "node", "from")
            if of:
                c["of"] = _slug(of, "")
        if _first(item, "walkable", "floor") is not None:
            c["walkable"] = bool(_first(item, "walkable", "floor"))
        out.append(c)
    return out


# --- Forma annidata della specifica originale -------------------------------

def _unwrap_legacy(raw, warns):
    """Riconduce la forma annidata dell'esempio della specifica.

        {"asset_id":..., "geometry":{"base_mesh":"primitive_box","scale":[..],
          "sub_modules":[{"type":"armature_bone","relative_position":[..],
                          "rotation_keyframes":{...}}]},
         "procedural_shader":{...}, "assembly_logic":"..."}

    Esiste perche' quell'esempio e' cio' che un modello imita se gli si mostra:
    e' letteralmente il testo della specifica. Ricondurla costa venti righe qui e
    risparmia una rigenerazione ogni volta che accade.
    """
    if not isinstance(raw, dict):
        return raw
    geo = raw.get("geometry")
    shader = raw.get("procedural_shader")
    if not isinstance(geo, dict) and not isinstance(shader, dict):
        return raw

    out = dict(raw)
    if isinstance(geo, dict):
        _warn(warns, "legacyGeometryShape", "geometry")
        nodes = list(_as_list(_first(out, "nodes", "parts", default=[])))
        base = _first(geo, "base_mesh", "mesh", "primitive")
        mods = [m for m in _as_list(_first(geo, "sub_modules", "modules",
                                          "children", default=[]))
                if isinstance(m, dict)]
        bones, clips = [], {}
        for i, m in enumerate(mods):
            mtype = str(_first(m, "type", "kind", default="") or "").strip().lower()
            if "bone" in mtype or "armature" in mtype or "joint" in mtype:
                bname = _slug(_first(m, "name", "id", "bone", default=""),
                              "bone%d" % (i + 1))
                bones.append({"b": bname,
                              "piv": _first(m, "relative_position", "pivot",
                                            "position", default=[0, 0, 0])})
                kf = _first(m, "rotation_keyframes", "keyframes", "clips")
                if isinstance(kf, dict):
                    for cname, rot in kf.items():
                        vals = [_num(x) for x in _as_list(rot)[:3]]
                        while len(vals) < 3:
                            vals.append(0.0)
                        clip = clips.setdefault(
                            cname, {"dur": 0.8, "keys": [[0.0, {}], [0.8, {}]]})
                        clip["keys"][0][1][bname] = [0.0, 0.0, 0.0]
                        clip["keys"][1][1][bname] = vals
            else:
                nodes.append(m)
        if base is not None and not nodes:
            nodes.insert(0, {"n": "base", "p": base,
                             "s": _first(geo, "scale", "size", default=[1, 1, 1])})
        elif base is not None:
            nodes.insert(0, {"n": "base", "p": base,
                             "s": _first(geo, "scale", "size", default=[1, 1, 1])})
        if nodes:
            out["nodes"] = nodes
        if bones and not out.get("rig"):
            out["rig"] = bones
        if clips and not out.get("clips"):
            out["clips"] = clips
        if geo.get("scale") is not None and out.get("size") is None:
            out["size"] = geo["scale"]
    if isinstance(shader, dict):
        _warn(warns, "legacyShaderShape", "procedural_shader")
        mats = dict(out.get("mats") or out.get("materials") or {})
        if "base" not in mats:
            mats["base"] = shader
        out["mats"] = mats
        stype = str(_first(shader, "type", default="") or "").lower()
        if stype and out.get("style") is None and stype in STYLE_ALIASES:
            out["style"] = stype
    return out


def _flags(raw, warns):
    """Bandiere da stringa, lista o dict. `assembly_logic` e' una stringa sola
    con piu' bandiere incollate: si cerca ogni suggerimento dentro il testo.

    Le liste si APPIATTISCONO: il chiamante passa `[flags, assembly_logic]` e
    ognuno dei due puo' essere a sua volta una lista. Senza appiattire, una lista
    vuota diventava la stringa "[]" e usciva un avviso `unknownFlag` per una
    bandiera che nessuno aveva scritto.
    """
    flags = set()
    items = []

    def collect(src):
        if src is None:
            return
        if isinstance(src, dict):
            for k, v in src.items():
                if v:
                    items.append(k)
            return
        if isinstance(src, (list, tuple)):
            for x in src:
                collect(x)
            return
        s = str(src).strip()
        if s:
            items.append(s)

    collect(raw)
    for item in items:
        low = str(item).strip().lower()
        if not low:
            continue
        if low in FLAGS:
            flags.add(low)
            continue
        hit = False
        for hint, flag in FLAG_HINTS.items():
            if hint in low:
                flags.add(flag)
                hit = True
        if not hit:
            for flag in FLAGS:
                if flag in low:
                    flags.add(flag)
                    hit = True
            if not hit:
                _warn(warns, "unknownFlag", "flags", low[:40])
    return sorted(flags)


# --- Normalizzazione --------------------------------------------------------

def normalize_spec(raw, request=None):
    """Spec grezza (dall'AI o da un file) -> spec canonica + avvisi.

    Solleva `ValueError` solo se non c'e' NIENTE da costruire: un JSON valido con
    zero nodi non e' un asset e mostrarlo come scena vuota farebbe cercare il
    difetto nel visore.
    """
    warns = []
    if isinstance(raw, str):
        raw = json.loads(raw)
    if not isinstance(raw, dict):
        raise ValueError("La spec deve essere un oggetto JSON.")

    # `{"asset": {...}}` / `{"spec": {...}}`: incarti che i modelli aggiungono.
    for wrapper in ("asset", "spec", "model", "data", "result", "output"):
        inner = raw.get(wrapper)
        if isinstance(inner, dict) and (
                "nodes" in inner or "geometry" in inner or "parts" in inner):
            _warn(warns, "unwrapped", wrapper)
            raw = inner
            break

    raw = _unwrap_legacy(raw, warns)
    req = request or {}

    spec = {"v": SPEC_VERSION}
    spec["id"] = _slug(_first(raw, "id", "asset_id", "name", "title",
                              default=req.get("id") or "asset"), "asset")

    cat = str(_first(raw, "cat", "category", "kind", "asset_type",
                     default=req.get("cat") or "prop") or "prop").strip().lower()
    cat = CATEGORY_ALIASES.get(cat, cat)
    if cat not in CATEGORIES:
        _warn(warns, "unknownCategory", "cat", cat)
        cat = req.get("cat") if req.get("cat") in CATEGORIES else "prop"
    spec["cat"] = cat

    style = str(_first(raw, "style", "shading", "look",
                       default=req.get("style") or "lowpoly") or "lowpoly").strip().lower()
    mapped = STYLE_ALIASES.get(style, style)
    if mapped != style:
        _warn(warns, "styleMapped", "style", style)
    if mapped not in STYLES:
        _warn(warns, "unknownStyle", "style", style)
        mapped = req.get("style") if req.get("style") in STYLES else "lowpoly"
    spec["style"] = mapped

    detail = _first(raw, "detail", "lod", "detail_level", "quality",
                    default=req.get("detail"))
    if isinstance(detail, str):
        table = {"bozza": 0, "draft": 0, "low": 1, "basso": 1, "medium": 2,
                 "medio": 2, "high": 3, "alto": 3, "ultra": 3}
        detail = table.get(detail.strip().lower(), 2)
    spec["detail"] = int(_clamp(_num(detail, 2), 0, len(DETAIL_LEVELS) - 1))

    size = _first(raw, "size", "dimensions", "bbox", "target_size", "extent")
    spec["size"] = [max(0.01, abs(_num(x, 1.0)))
                    for x in (_as_list(size) + [1.0, 1.0, 1.0])[:3]] if size is not None \
        else [1.0, 1.0, 1.0]
    # Con un piano l'ingombro NON deve essere dichiarato dalla spec: lo scrive il
    # chiamante col totale verificato. Avvisare che manca sarebbe rumore su un
    # comportamento voluto (e il prompt lo chiede esplicitamente).
    if size is None and not req.get("hasPlan"):
        _warn(warns, "sizeMissing", "size")

    ground = _first(raw, "ground", "grounded", "on_floor", "sits_on_ground")
    if ground is None:
        flying = _first(raw, "flying", "floating", "volante")
        ground = (not bool(flying)) if flying is not None else True
    spec["ground"] = bool(ground)

    params = {}
    raw_params = _first(raw, "params", "parameters", "vars", "variables", default={})
    if isinstance(raw_params, dict):
        for k, v in list(raw_params.items())[:MAX_PARAMS]:
            key = _slug(k, "")
            if not key or not _NAME_RE.match(key):
                _warn(warns, "badParamName", "params", k)
                continue
            if key in EXPR_FUNCS or key in EXPR_CONSTS:
                _warn(warns, "paramShadowsFunc", "params", key)
                continue
            params[key] = _num(v, 0.0)
    elif raw_params:
        _warn(warns, "badParams", "params")
    spec["params"] = params

    mats = {}
    raw_mats = _first(raw, "mats", "materials", "surfaces", default={})
    if isinstance(raw_mats, list):
        # lista di materiali con un `name` dentro: forma frequente.
        conv = {}
        for i, m in enumerate(raw_mats):
            if isinstance(m, dict):
                conv[_slug(_first(m, "name", "id", default="m%d" % (i + 1)),
                           "m%d" % (i + 1))] = m
        raw_mats = conv
    if isinstance(raw_mats, dict):
        for k, v in list(raw_mats.items())[:MAX_MATS]:
            key = _slug(k, "m1")
            mats[key] = _material(v, warns, "mats.%s" % key)
    elif raw_mats:
        _warn(warns, "badMats", "mats")
    spec["mats"] = mats

    raw_nodes = _first(raw, "nodes", "parts", "objects", "modules", "pieces",
                       "sub_modules", default=[])
    if isinstance(raw_nodes, dict):
        conv = []
        for k, v in raw_nodes.items():
            if isinstance(v, dict):
                item = dict(v)
                item.setdefault("n", k)
                conv.append(item)
        raw_nodes = conv
    nodes, seen = [], {}
    for i, rn in enumerate(_as_list(raw_nodes)[:MAX_NODES]):
        node = _node(rn, warns, params, i)
        if node is None:
            continue
        base = node["n"]
        if base in seen:
            seen[base] += 1
            node["n"] = "%s_%d" % (base, seen[base])
            _warn(warns, "duplicateNodeName", "nodes.%s" % base)
        else:
            seen[base] = 1
        nodes.append(node)
    if len(_as_list(raw_nodes)) > MAX_NODES:
        _warn(warns, "tooManyNodes", "nodes", len(_as_list(raw_nodes)))
    if not nodes:
        raise ValueError("La spec non contiene nodi: niente da costruire.")
    spec["nodes"] = nodes

    names = {n["n"] for n in nodes}
    for n in nodes:
        if n.get("mat") and n["mat"] not in mats:
            _warn(warns, "unknownMaterial", "nodes.%s" % n["n"], n["mat"])
            # NON si azzera: un id orfano degrada da solo a tinta neutra nel
            # motore, mentre cancellarlo perderebbe l'intenzione dell'autore e
            # renderebbe la perdita definitiva al primo salvataggio.
        if n.get("op"):
            if n.get("of") not in names:
                _warn(warns, "opTargetMissing", "nodes.%s" % n["n"], n.get("of"))
                n.pop("op", None)
                n.pop("of", None)
            elif n["of"] == n["n"]:
                _warn(warns, "opTargetSelf", "nodes.%s" % n["n"])
                n.pop("op", None)
                n.pop("of", None)
        ignored = [k for k in ("r", "r2", "len", "prof", "secs", "taper", "arc")
                   if k in n and k not in PRIMITIVES[n["p"]]]
        for k in ignored:
            _warn(warns, "fieldIgnored", "nodes.%s" % n["n"], k)

    rig, bseen = [], set()
    for i, rb in enumerate(_as_list(_first(raw, "rig", "bones", "armature",
                                           "skeleton", default=[]))):
        bone = _bone(rb, warns, params, i)
        if bone is None:
            continue
        if bone["b"] in bseen:
            _warn(warns, "duplicateBone", "rig.%s" % bone["b"])
            continue
        bseen.add(bone["b"])
        rig.append(bone)
    for b in rig:
        if b.get("parent") and b["parent"] not in bseen:
            _warn(warns, "boneParentMissing", "rig.%s" % b["b"], b["parent"])
            b.pop("parent", None)
    spec["rig"] = rig

    for n in nodes:
        if n.get("bone") and n["bone"] not in bseen:
            _warn(warns, "nodeBoneMissing", "nodes.%s" % n["n"], n["bone"])
            n.pop("bone", None)

    spec["clips"] = _clips(_first(raw, "clips", "animations", "anims",
                                  "rotation_keyframes", default={}),
                           warns, bseen)
    spec["logic"] = _logic(_first(raw, "logic", "bindings", "interactions",
                                  default=[]),
                           warns, names, set(spec["clips"]))
    spec["col"] = _colliders(_first(raw, "col", "colliders", "collision",
                                    "collision_shapes", default=[]),
                             warns, params)

    flags = _flags([_first(raw, "flags", "rules", "constraints", default=[]),
                    _first(raw, "assembly_logic", "assembly", default=[])], warns)
    # Bandiere implicite dalla categoria: sono le regole della specifica, e non
    # dipendono dal fatto che il modello si ricordi di scriverle.
    if spec["cat"] == "char":
        for f in ("arms_down", "symmetric_x"):
            if f not in flags:
                flags.append(f)
    if spec["cat"] == "vehicle":
        for f in ("big_cabin", "symmetric_x"):
            if f not in flags:
                flags.append(f)
    spec["flags"] = sorted(set(flags))

    notes = _first(raw, "notes", "note", "intent", "description", "desc")
    if notes:
        spec["notes"] = str(notes)[:400]

    return spec, warns


# --- Patch ------------------------------------------------------------------

PATCH_OPS = ("set", "del", "add", "mat", "param", "bone", "clip", "flag")


def apply_patch(spec, patch, request=None):
    """Applica una lista di operazioni e RINORMALIZZA il risultato.

    Indirizzamento per NOME, mai per indice: un indice cambia appena si aggiunge
    un nodo, e una patch che colpisce il nodo sbagliato e' peggio di una patch
    mancata (il difetto si sposta invece di sparire, e il giro successivo del
    critico lo rivede altrove).

    Rinormalizzare alla fine non e' una cortesia: una patch puo' introdurre un
    riferimento rotto (un `mat` che non esiste, un `of` verso un nodo appena
    cancellato) e senza un secondo passaggio arriverebbe intatta al motore.
    """
    warns = []
    if isinstance(patch, str):
        patch = json.loads(patch)
    if isinstance(patch, dict):
        patch = _first(patch, "patch", "ops", "changes", "edits", default=[])
    ops = _as_list(patch)
    doc = json.loads(json.dumps(spec))     # copia: la spec in ingresso non si muta
    applied = 0

    def find_node(name):
        for n in doc.get("nodes", []):
            if n.get("n") == name:
                return n
        return None

    for i, op in enumerate(ops):
        at = "patch[%d]" % i
        if isinstance(op, dict):
            kind = str(_first(op, "op", "action", "kind", default="") or "").lower()
            args = _first(op, "args", "value", "v", default=None)
            path = _first(op, "path", "target", "at", default=None)
            op = [kind] + ([path] if path is not None else []) + \
                 ([args] if args is not None else [])
        if not isinstance(op, (list, tuple)) or not op:
            _warn(warns, "badPatchOp", at)
            continue
        kind = str(op[0] or "").strip().lower()
        rest = list(op[1:])

        if kind in ("set", "param") and len(rest) >= 2:
            path, value = str(rest[0] or ""), rest[1]
            parts = path.split(".")
            if kind == "param" or (len(parts) == 2 and parts[0] == "params"):
                key = _slug(parts[-1], "")
                if key:
                    doc.setdefault("params", {})[key] = _num(value, 0.0)
                    applied += 1
                else:
                    _warn(warns, "badPatchPath", at, path)
                continue
            if len(parts) >= 3 and parts[0] == "nodes":
                node = find_node(_slug(parts[1], ""))
                if node is None:
                    _warn(warns, "patchNodeMissing", at, parts[1])
                    continue
                node[parts[2]] = value
                applied += 1
                continue
            if len(parts) >= 3 and parts[0] == "mats":
                mat = doc.setdefault("mats", {}).setdefault(_slug(parts[1], "m1"), {})
                mat[parts[2]] = value
                applied += 1
                continue
            if len(parts) == 1 and parts[0] in ("size", "detail", "style", "ground",
                                                "cat", "id", "notes"):
                doc[parts[0]] = value
                applied += 1
                continue
            _warn(warns, "badPatchPath", at, path)
            continue

        if kind == "del" and rest:
            target = _slug(rest[0], "")
            before = len(doc.get("nodes", []))
            doc["nodes"] = [n for n in doc.get("nodes", []) if n.get("n") != target]
            if len(doc["nodes"]) != before:
                applied += 1
                # Un nodo cancellato lascia orfane le booleane che lo puntavano.
                for n in doc["nodes"]:
                    if n.get("of") == target:
                        n.pop("op", None)
                        n.pop("of", None)
                        _warn(warns, "patchOrphanedOp", at, n.get("n"))
            elif target in (doc.get("mats") or {}):
                doc["mats"].pop(target, None)
                applied += 1
            else:
                _warn(warns, "patchNodeMissing", at, target)
            continue

        if kind == "add" and rest:
            body = rest[0]
            if isinstance(body, dict) and (_first(body, "b", "bone") and
                                           not _first(body, "p", "prim", "primitive")):
                doc.setdefault("rig", []).append(body)
            elif isinstance(body, dict):
                doc.setdefault("nodes", []).append(body)
            else:
                _warn(warns, "badPatchOp", at)
                continue
            applied += 1
            continue

        if kind == "mat" and len(rest) >= 2:
            name = _slug(rest[0], "m1")
            body = rest[1]
            if not isinstance(body, dict):
                body = {"col": body}
            cur = doc.setdefault("mats", {}).setdefault(name, {})
            cur.update(body)
            applied += 1
            continue

        if kind == "bone" and len(rest) >= 2:
            name = _slug(rest[0], "")
            body = rest[1] if isinstance(rest[1], dict) else {}
            for b in doc.setdefault("rig", []):
                if b.get("b") == name:
                    b.update(body)
                    break
            else:
                body = dict(body)
                body["b"] = name
                doc["rig"].append(body)
            applied += 1
            continue

        if kind == "clip" and len(rest) >= 2:
            doc.setdefault("clips", {})[_slug(rest[0], "clip")] = rest[1]
            applied += 1
            continue

        if kind == "flag" and rest:
            flags = set(doc.get("flags") or [])
            for f in _as_list(rest[0]):
                s = str(f)
                if s.startswith("-"):
                    flags.discard(s[1:])
                else:
                    flags.add(s)
            doc["flags"] = sorted(flags)
            applied += 1
            continue

        _warn(warns, "unknownPatchOp", at, kind)

    out, nwarns = normalize_spec(doc, request)
    return out, warns + nwarns, applied


# --- Riassunto per i prompt -------------------------------------------------

def _fmt(v):
    if isinstance(v, float):
        s = ("%.4f" % v).rstrip("0").rstrip(".")
        return s or "0"
    if isinstance(v, list):
        return "[" + ",".join(_fmt(x) for x in v) + "]"
    return str(v)


def spec_digest(spec, max_nodes=60):
    """Riassunto TESTUALE e compatto della spec, per il critico e per la patch.

    Mandare il JSON intero a ogni giro e' esattamente il token-burn che questa
    architettura esiste per evitare: qui si tengono i nomi (senza cui una patch
    non puo' indirizzare nulla) e i campi che decidono la forma, e si buttano
    profili, path e sezioni, che sono lunghi e che il critico non deve toccare.
    """
    L = []
    L.append("id=%s cat=%s style=%s detail=%d size=%s ground=%d"
             % (spec.get("id"), spec.get("cat"), spec.get("style"),
                spec.get("detail", 2), "x".join(_fmt(x) for x in spec.get("size", [])),
                1 if spec.get("ground") else 0))
    if spec.get("flags"):
        L.append("flags: " + " ".join(spec["flags"]))
    if spec.get("params"):
        L.append("params: " + " ".join("%s=%s" % (k, _fmt(v))
                                       for k, v in spec["params"].items()))
    if spec.get("mats"):
        parts = []
        for k, m in spec["mats"].items():
            bits = [m.get("col", "")]
            if m.get("rough") is not None:
                bits.append("r%s" % _fmt(m["rough"]))
            if m.get("metal"):
                bits.append("m%s" % _fmt(m["metal"]))
            if m.get("noise"):
                bits.append("noise=%s/%s" % (m["noise"].get("t"),
                                             _fmt(m["noise"].get("scale"))))
            parts.append("%s(%s)" % (k, " ".join(str(b) for b in bits if b)))
        L.append("mats: " + " ".join(parts))
    nodes = spec.get("nodes", [])
    L.append("nodes(%d):" % len(nodes))
    for n in nodes[:max_nodes]:
        bits = ["  %s %s" % (n["n"], n["p"])]
        for k in ("s", "at", "rot", "r", "r2", "len", "axis", "taper", "bevel",
                  "sides", "steps", "wall", "arc"):
            if k in n:
                bits.append("%s=%s" % (k, _fmt(n[k])))
        if n.get("op"):
            bits.append("%s-of=%s" % (n["op"], n.get("of")))
        if n.get("arr"):
            bits.append("arr=%dx%s" % (n["arr"]["n"], _fmt(n["arr"]["step"])))
        if n.get("mir"):
            bits.append("mir=%s" % n["mir"])
        if n.get("mat"):
            bits.append("mat=%s" % n["mat"])
        if n.get("bone"):
            bits.append("bone=%s" % n["bone"])
        if n.get("role"):
            bits.append("role=%s" % n["role"])
        if n.get("prof"):
            bits.append("prof=%s" % (n["prof"] if isinstance(n["prof"], str)
                                     else "pts%d" % len(n["prof"])))
        if n.get("secs"):
            bits.append("secs=%d" % len(n["secs"]))
        if n.get("shape"):
            bits.append("shape=%s" % n["shape"])
        # I deformatori nel digest: senza, il correttore non sa che una lama e'
        # gia' rastremata e la "aggiusta" cambiando le misure invece dei coni.
        if n.get("taperTo"):
            bits.append("taperTo=%s/%s" % (_fmt(n["taperTo"]["a"]), _fmt(n["taperTo"]["b"])))
        if n.get("taper0"):
            bits.append("taper0=%s/%s" % (_fmt(n["taper0"]["a"]), _fmt(n["taper0"]["b"])))
        if n.get("twist"):
            bits.append("twist=%s" % _fmt(n["twist"]))
        if n.get("bendA"):
            bits.append("bend=%s>%s" % (_fmt(n["bendA"]), n.get("bendTo") or "z"))
        if n.get("shear"):
            bits.append("shear=%s>%s" % (_fmt(n["shear"]["amount"]), n["shear"]["by"]))
        if n.get("squash"):
            bits.append("squash=%s%s/%s" % (n["squash"]["axis"], n["squash"]["side"],
                                            _fmt(n["squash"]["f"])))
        if n.get("warp"):
            bits.append("warp=%s" % _fmt(n["warp"]["amp"]))
        L.append(" ".join(bits))
    if len(nodes) > max_nodes:
        L.append("  ... e altri %d nodi" % (len(nodes) - max_nodes))
    if spec.get("rig"):
        L.append("rig: " + " ".join(
            "%s@%s%s" % (b["b"], _fmt(b.get("piv")),
                         ("<-" + b["parent"]) if b.get("parent") else "")
            for b in spec["rig"]))
    if spec.get("clips"):
        L.append("clips: " + " ".join("%s(%ss,%dk)"
                                      % (k, _fmt(c.get("dur")), len(c.get("keys", [])))
                                      for k, c in spec["clips"].items()))
    if spec.get("logic"):
        L.append("logic: " + " ".join("%s->%s" % (l.get("on"), l.get("var"))
                                      for l in spec["logic"]))
    if spec.get("notes"):
        L.append("notes: " + spec["notes"])
    return "\n".join(L)


def spec_for_prompt(spec, budget=2600):
    """Il JSON intero se e' piccolo, il riassunto se no.

    La soglia esiste perche' su un asset semplice il JSON compatto e' piu' utile
    del riassunto (l'AI puo' riscrivere un campo che il riassunto omette), mentre
    su uno da 200 nodi sarebbe la voce piu' costosa dell'intera chiamata.
    """
    compact = json.dumps(spec, separators=(",", ":"), ensure_ascii=False)
    if len(compact) <= budget:
        return compact
    return spec_digest(spec)


def spec_stats(spec):
    """Numeri per la UI e per i log: quanto e' grande questa spec."""
    nodes = spec.get("nodes", [])
    return {
        "nodes": len(nodes),
        "bools": sum(1 for n in nodes if n.get("op")),
        "mats": len(spec.get("mats") or {}),
        "bones": len(spec.get("rig") or []),
        "clips": len(spec.get("clips") or {}),
        "params": len(spec.get("params") or {}),
        "bytes": len(json.dumps(spec, separators=(",", ":"), ensure_ascii=False)),
        "budget": DETAIL_LEVELS[int(_clamp(spec.get("detail", 2), 0, 3))]["nodes"],
    }
