"""Materiali: definizione, normalizzazione, applicazione ai voxel.

Il contratto e' quello di `36-materials.js`, replicato qui perche' il server MCP
deve poter creare un materiale che la GUI apre senza conversioni. In particolare:

- un voxel ha SEMPRE `color` e FACOLTATIVAMENTE `material` (un id). Il colore di
  un voxel texturizzato e' la TINTA MEDIA della texture, cosi' ogni percorso che
  pretende un hex (.vox, .schem, le swatch, l'MTL senza PNG) funziona senza
  sapere che i materiali esistono, e un id orfano degrada da solo a tinta unita
  — che e' il "materiale neutro" dei file importati senza texture, ottenuto
  senza un ramo dedicato;
- `faceMode` e' `'single'` o `'six'`; in `six` le facce sono px/nx/py/ny/pz/nz;
- la texture e' `{data: dataURL, w, h, alpha}`. `alpha` si misura UNA volta
  all'import e si porta appresso, per non ridecodificare il PNG a ogni uso.

TRASPARENZA — la trappola. `alphaTest` e `opacity` NON si combinano: alphaTest
confronta l'alpha FINALE, cioe' `opacity * alphaDelTexel`, quindi con opacita'
0.4 e soglia 0.5 spariscono anche i pixel pieni e il materiale diventa
INVISIBILE invece che semitrasparente. Quindi il taglio secco (bordi netti, che
e' cio' che si vuole per la pixel art) vale solo a opacita' piena, e sotto 1 si
passa alla fusione. `material_render_mode` qui sotto e' la stessa decisione,
presa una volta sola e riusata da OBJ/MTL e GLB.
"""

import copy

from . import png as pngmod
from .palette import normalize_hex

FACE_KEYS = ("px", "nx", "py", "ny", "pz", "nz")
TEXTURE_MAX = 128
LIBRARY_MAX = 40


def normalize_material(definition, mid=None):
    """Una definizione qualunque -> la forma canonica.

    Tollerante di proposito: un materiale puo' arrivare da un file salvato da una
    versione diversa, dalla libreria personale o da un client MCP che lo scrive a
    mano. I campi mancanti prendono il default della UI, cosi' un materiale
    minimale (`{name, color}`) e' valido e si vede subito.
    """
    d = definition if isinstance(definition, dict) else {}
    out = {
        "id": str(mid or d.get("id") or "m1"),
        "name": str(d.get("name") or "Materiale"),
        "faceMode": "six" if d.get("faceMode") == "six" else "single",
        "color": normalize_hex(d.get("color"), "#CCCCCC"),
        "roughness": _clamp01(d.get("roughness"), 0.6),
        "metalness": _clamp01(d.get("metalness"), 0.0),
        "emissive": _clamp01(d.get("emissive"), 0.0),
        "opacity": _clamp01(d.get("opacity"), 1.0),
        "uv": normalize_uv(d.get("uv")),
    }
    tex = normalize_texture(d.get("texture"))
    if tex:
        out["texture"] = tex
    faces = {}
    for key in FACE_KEYS:
        ftex = normalize_texture((d.get("faces") or {}).get(key))
        if ftex:
            faces[key] = ftex
    if faces:
        out["faces"] = faces
    elif out["faceMode"] == "six":
        # Una modalita' "sei facce" senza facce non ha senso e si vedrebbe come
        # un cubo grigio: si degrada a texture unica invece di lasciare uno stato
        # che nessun percorso sa disegnare.
        out["faceMode"] = "single"
    return out


def _clamp01(value, default):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:
        return default
    return max(0.0, min(1.0, v))


def normalize_uv(uv):
    """`repeat` non puo' essere 0: azzererebbe la matrice UV e la faccia
    mostrerebbe un solo texel stirato, che si legge come "la texture non si e'
    caricata". La rotazione e' QUANTIZZATA a 90 gradi perche' un angolo qualunque
    interpola una texture ai pixel netti e la sfoca — e NearestFilter non basta,
    e' il campionamento ruotato a cadere fra i texel."""
    u = uv if isinstance(uv, dict) else {}

    def num(key, default):
        try:
            v = float(u.get(key, default))
        except (TypeError, ValueError):
            return default
        return default if v != v else v

    repeat = num("repeat", 1.0)
    if repeat <= 0:
        repeat = 1.0
    rot = int(round(num("rotation", 0.0) / 90.0)) * 90 % 360
    return {
        "repeat": repeat,
        "offsetU": num("offsetU", 0.0),
        "offsetV": num("offsetV", 0.0),
        "rotation": rot,
    }


def normalize_texture(tex):
    """{data, w, h, alpha} oppure None. Un data URL illeggibile diventa None e
    non un'eccezione: un materiale con una texture rotta deve degradare a tinta
    unita, non impedire di aprire il progetto."""
    if not isinstance(tex, dict):
        return None
    data = tex.get("data")
    if not data:
        return None
    out = {"data": str(data)}
    for key in ("w", "h"):
        try:
            out[key] = max(1, int(tex[key]))
        except (KeyError, TypeError, ValueError):
            out[key] = None
    if out["w"] is None or out["h"] is None:
        try:
            _buf, w, h = pngmod.from_data_url(out["data"])
            out["w"], out["h"] = w, h
        except Exception:                                    # noqa: BLE001
            return None
    out["alpha"] = bool(tex.get("alpha"))
    return out


def texture_from_buffer(buf, w, h):
    """Buffer RGBA -> texture di materiale, misurando l'alpha una volta sola."""
    return {
        "data": pngmod.to_data_url(buf, w, h),
        "w": w,
        "h": h,
        "alpha": pngmod.buffer_has_alpha(buf),
    }


def texture_buffer(tex):
    """Texture -> (buffer, w, h). Solleva se non e' decodificabile."""
    buf, w, h = pngmod.from_data_url(tex["data"])
    return buf, w, h


def material_average_color(mat):
    """La tinta che un voxel con questo materiale porta in `color`.

    In `six` si media la faccia +Z: e' quella che si guarda per prima e che
    determina come il blocco viene percepito. Mediare tutte e sei darebbe un
    grigio che non somiglia a nessuna faccia — un cubo con lati rossi e cima
    verde diventerebbe marrone.
    """
    tex = mat.get("texture")
    if mat.get("faceMode") == "six":
        faces = mat.get("faces") or {}
        tex = faces.get("pz") or faces.get("px") or next(iter(faces.values()), None)
    if tex:
        try:
            buf, w, h = texture_buffer(tex)
            return pngmod.buffer_average_color(buf, w, h)
        except Exception:                                    # noqa: BLE001
            pass
    return normalize_hex(mat.get("color"), "#CCCCCC")


def material_render_mode(mat):
    """('opaque'|'mask'|'blend', alphaTest, opacity) — la decisione presa UNA
    volta e riusata da tutti gli esportatori (vedi la trappola nel modulo)."""
    opacity = _clamp01(mat.get("opacity"), 1.0)
    tex = mat.get("texture") or next(iter((mat.get("faces") or {}).values()), None)
    has_alpha = bool(tex and tex.get("alpha"))
    if opacity < 1.0:
        return ("blend", 0.0, opacity)
    if has_alpha:
        return ("mask", 0.5, 1.0)
    return ("opaque", 0.0, 1.0)


def resize_texture(tex, w, h):
    """Ricampiona al vicino piu' prossimo (l'unico corretto per la pixel art)."""
    buf, ow, oh = texture_buffer(tex)
    w = max(1, min(TEXTURE_MAX, int(w)))
    h = max(1, min(TEXTURE_MAX, int(h)))
    return texture_from_buffer(pngmod.scale_nearest(buf, ow, oh, w, h), w, h)


def clone_for_library(mat, new_id):
    """Copia per la libreria personale, con id RINUMERATO.

    Due progetti possono aver usato `m1` per materiali diversi: tenere l'id
    d'origine legherebbe la copia al materiale gia' presente invece di
    aggiungerne uno.
    """
    out = copy.deepcopy(mat)
    out["id"] = new_id
    return out


def summarize(mat):
    """Riassunto per un client MCP: la texture in base64 NON entra in una
    risposta (una 128x128 sono decine di kilobyte per materiale, e una lista di
    venti materiali sfonderebbe da sola la finestra di contesto). Chi la vuole la
    chiede per id con lo strumento dedicato."""
    tex = mat.get("texture")
    out = {
        "id": mat.get("id"),
        "name": mat.get("name"),
        "faceMode": mat.get("faceMode"),
        "color": mat.get("color"),
        "roughness": mat.get("roughness"),
        "metalness": mat.get("metalness"),
        "emissive": mat.get("emissive"),
        "opacity": mat.get("opacity"),
        "uv": mat.get("uv"),
    }
    if tex:
        out["texture"] = {"w": tex.get("w"), "h": tex.get("h"),
                          "alpha": tex.get("alpha")}
    if mat.get("faces"):
        out["faces"] = {k: {"w": v.get("w"), "h": v.get("h")}
                        for k, v in mat["faces"].items()}
    return out
