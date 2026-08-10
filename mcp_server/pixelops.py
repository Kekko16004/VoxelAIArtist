"""Ops compatte 2D (pixel art) — porto Python di `ui/src/lib/37-pixel-ops.js`.

ATTENZIONE: prima di questo modulo le ops 2D avevano UN SOLO consumatore, il
browser. Questo e' il secondo, quindi introduce anche la parita': **una modifica
alla semantica qui va fatta anche li', e viceversa**. E' la stessa situazione
delle ops dei voxel (`expand_ops` / `expandOps`), dove la divergenza e' costata
tre difetti veri. La rete di sicurezza e' `bash tests/pixel_parity_check.sh`
(che lancia `tests/pixel_parity_js.mjs` per il lato JS e confronta i due lati
pixel per pixel sui casi di `tests/pixel_ops_parity_cases.json`). Scriverla ha
trovato tre divergenze gia' presenti, tutte col lato JS piu' permissivo: le
parole del trasparente in palette, `forceSize` che la' ignorava `height`, e
`faces` non-dizionario. Sono state allineate a QUESTO lato.

Le due trappole della porta, entrambe gia' viste sulle ops dei voxel:

1. `Math.round` di JS NON e' `round` di Python. JS arrotonda sempre verso
   +infinito a meta' strada (`Math.round(2.5) === 3`, `Math.round(-2.5) === -2`),
   Python usa l'arrotondamento del banchiere (`round(2.5) == 2`, `round(0.5) == 0`).
   Su coordinate frazionarie prodotte da un LLM la differenza si vede: un pixel
   di scarto sul bordo di ogni rettangolo. Da qui `js_round`.

2. Il generatore del rumore PERDE PRECISIONE in JS, e va perso anche qui.
   `s * 1103515245` con s fino a 2^31 sfiora 2.4e18, cioe' oltre i 2^53 esatti di
   un double: JS arrotonda il prodotto PRIMA di troncarlo a int32. Python, che ha
   interi esatti, darebbe una sequenza DIVERSA — e quindi una texture diversa a
   parita' di seme, che e' esattamente cio' che il seme esplicito doveva
   impedire. `_lcg_next` riproduce di proposito l'aritmetica in virgola mobile.

ORIGINE: (0,0) in ALTO A SINISTRA, x verso destra, y verso il BASSO — come
ImageData e come uno sprite. Non come i voxel.
"""

import math

PIXEL_OPS_MAX_SIDE = 128
PIXEL_OPS_MIN_SIDE = 4
PIXEL_OPS_MAX = 20000

PIXEL_RLE_ALPHABET = ("abcdefghijklmnopqrstuvwxyz"
                      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+*")
PIXEL_RLE_TRANSPARENT = "."

_TRANSPARENT_WORDS = ("-", ".", "none", "trasparente", "transparent")
_PAINT_COMMANDS = ("fill", "rect", "line", "set", "noise")


# --- aritmetica compatibile con JS ------------------------------------------

def js_number(value):
    """`Number(v)` di JS -> float, oppure None per NaN.

    Non e' `float(v)`: JS accetta la stringa vuota come 0 e i prefissi 0x/0o/0b,
    e non accetta gli underscore che Python accetta (`1_0` vale 10 in Python e
    NaN in JS). Le coordinate arrivano da un LLM, quindi le forme strane si
    presentano davvero.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        v = float(value)
        return None if math.isnan(v) else v
    s = str(value).strip()
    if s == "":
        return 0.0
    if "_" in s:
        return None
    try:
        low = s.lower()
        if low.startswith(("0x", "-0x", "+0x")):
            return float(int(s, 16))
        if low.startswith(("0o", "-0o", "+0o")):
            return float(int(s, 8))
        if low.startswith(("0b", "-0b", "+0b")):
            return float(int(s, 2))
        v = float(s)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) else v


def js_round(value):
    """`Math.round` -> int, oppure None se il valore non e' finito.

    Meta' strada verso +infinito, SEMPRE (vedi docstring del modulo).
    """
    v = js_number(value)
    if v is None or math.isinf(v):
        return None
    return int(math.floor(v + 0.5))


def _to_int32(x):
    """`ToInt32` di ECMAScript su un double."""
    if x != x or math.isinf(x):
        return 0
    n = int(math.floor(abs(x))) * (1 if x >= 0 else -1)
    n &= 0xFFFFFFFF
    return n - 0x100000000 if n >= 0x80000000 else n


def _lcg_next(state):
    """Un passo dell'LCG, con la PERDITA DI PRECISIONE di JS (vedi modulo)."""
    prod = float(state) * 1103515245.0 + 12345.0
    s = _to_int32(prod) & 0x7FFFFFFF
    return s, s / float(0x7FFFFFFF)


def clamp_side(n, default):
    v = js_round(n)
    if v is None:
        return default
    return min(PIXEL_OPS_MAX_SIDE, max(PIXEL_OPS_MIN_SIDE, v))


# --- colori ------------------------------------------------------------------

def pixel_color_to_rgba(token, palette=None):
    """Colore di una op -> [r,g,b,a], oppure None se non e' un colore.

    Il trasparente NON e' un colore ma non e' nemmeno un errore: e' il pixel
    vuoto, valore possibile di QUALUNQUE op. Cosi' `set - 3 4` fa un foro senza
    che debba esistere un'op "buca".
    """
    if token is None:
        return None
    s = str(token).strip()
    if not s:
        return None
    if s == "-" or s == PIXEL_RLE_TRANSPARENT or s.lower() in _TRANSPARENT_WORDS:
        return [0, 0, 0, 0]
    # La chiave di palette si risolve PRIMA del letterale: una palette che mappa
    # 'a' su un colore deve vincere su qualunque interpretazione fantasiosa.
    if isinstance(palette, dict) and s in palette:
        mapped = palette[s]
        if mapped is None:
            return [0, 0, 0, 0]
        s = str(mapped).strip()
        if s == "-" or s.lower() in ("none", "trasparente", "transparent"):
            return [0, 0, 0, 0]
    if not s.startswith("#"):
        return None
    hexs = s[1:]
    if not hexs or not all(c in "0123456789abcdefABCDEF" for c in hexs):
        return None
    if len(hexs) == 3:
        return [int(c * 2, 16) for c in hexs] + [255]
    if len(hexs) == 6:
        return [int(hexs[0:2], 16), int(hexs[2:4], 16), int(hexs[4:6], 16), 255]
    if len(hexs) == 8:
        return [int(hexs[0:2], 16), int(hexs[2:4], 16), int(hexs[4:6], 16),
                int(hexs[6:8], 16)]
    return None


# --- disegno -----------------------------------------------------------------

def pixel_put(buf, w, h, x, y, rgba):
    """Scrive un pixel SOSTITUENDO l'alpha invece di fondere: due ops sovrapposte
    si comportano come due ops di voxel (l'ultima vince), e un colore pieno sopra
    un pixel semitrasparente non lascia una tinta mista."""
    if x < 0 or y < 0 or x >= w or y >= h:
        return 0
    i = (y * w + x) * 4
    buf[i] = rgba[0]
    buf[i + 1] = rgba[1]
    buf[i + 2] = rgba[2]
    buf[i + 3] = rgba[3]
    return 1


def _span(buf, w, h, x0, x1, y, rgba):
    n = 0
    for x in range(x0, x1 + 1):
        n += pixel_put(buf, w, h, x, y, rgba)
    return n


def pixel_line(buf, w, h, x0, y0, x1, y1, rgba):
    """Bresenham. In 2D e' esatto, quindi non c'e' la semantica "asse dominante"
    delle ops dei voxel da tenere allineata."""
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    n = 0
    guard = (dx + dy + 2) * 2
    x, y = x0, y0
    while guard > 0:
        guard -= 1
        n += pixel_put(buf, w, h, x, y, rgba)
        if x == x1 and y == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x += sx
        if e2 < dx:
            err += dx
            y += sy
    return n


def pixel_rect_args(a, b, c, d, w, h):
    """Rettangolo normalizzato e ritagliato alla tela, o None se e' tutto fuori.

    Le coordinate arrivano da un LLM: float, invertite o fuori tela. Si
    normalizzano invece di scartare l'op, perche' un rettangolo con gli angoli
    scambiati e' chiaramente inteso e scartarlo lascerebbe un buco nella texture
    senza dire perche'.
    """
    vals = [js_round(a), js_round(b), js_round(c), js_round(d)]
    if any(v is None for v in vals):
        return None
    x0, y0, x1, y1 = vals
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    if x1 < 0 or y1 < 0 or x0 >= w or y0 >= h:
        return None
    return (max(0, x0), max(0, y0), min(w - 1, x1), min(h - 1, y1))


def _split(op):
    out = []
    for chunk in str(op).strip().replace(",", " ").split():
        if chunk:
            out.append(chunk)
    return out


def _at(parts, i):
    return parts[i] if i < len(parts) else None


def apply_pixel_op(op, buf, w, h, palette, warnings):
    """Applica UNA op. Ritorna il numero di pixel scritti.

    Gli avvisi sono CODICI, non frasi: questo modulo non sa che lingua parla
    l'utente, e una frase italiana qui sarebbe testo per l'utente nel posto
    sbagliato. Il codice e' la prima parola; cio' che segue e' il dato grezzo.
    """
    if not isinstance(op, str):
        return 0
    parts = _split(op)
    if not parts:
        return 0
    cmd = parts[0].lower()

    def bad(msg):
        if warnings is not None and len(warnings) < 20:
            warnings.append(msg)
        return 0

    if cmd == "del":
        r = pixel_rect_args(_at(parts, 1), _at(parts, 2), _at(parts, 3),
                            _at(parts, 4), w, h)
        if not r:
            return bad("badCoords " + op)
        n = 0
        for y in range(r[1], r[3] + 1):
            n += _span(buf, w, h, r[0], r[2], y, [0, 0, 0, 0])
        return n

    if cmd == "set":
        rgba = pixel_color_to_rgba(_at(parts, 1), palette)
        if not rgba:
            return bad("badColor set " + str(_at(parts, 1)))
        n = 0
        # Coppie x y. Un numero spaiato in coda si ignora: e' l'errore tipico di
        # una risposta troncata, e scartare tutta l'op perderebbe le coppie buone
        # che la precedono.
        i = 2
        while i + 1 < len(parts):
            x, y = js_round(parts[i]), js_round(parts[i + 1])
            if x is not None and y is not None:
                n += pixel_put(buf, w, h, x, y, rgba)
            i += 2
        return n

    if cmd in ("fill", "rect", "line"):
        rgba = pixel_color_to_rgba(_at(parts, 5), palette)
        if not rgba:
            return bad("badColor " + cmd + " " + str(_at(parts, 5)))

        if cmd == "fill":
            r = pixel_rect_args(_at(parts, 1), _at(parts, 2), _at(parts, 3),
                                _at(parts, 4), w, h)
            if not r:
                return bad("badCoords " + op)
            n = 0
            for y in range(r[1], r[3] + 1):
                n += _span(buf, w, h, r[0], r[2], y, rgba)
            return n

        vals = [js_round(_at(parts, i)) for i in (1, 2, 3, 4)]
        if any(v is None for v in vals):
            return bad("badCoords " + op)
        x0, y0, x1, y1 = vals

        if cmd == "rect":
            # Il contorno si ricava dai bordi RICHIESTI, non da quelli ritagliati:
            # un rettangolo che esce dalla tela deve perdere il lato fuori, non
            # disegnarlo appiccicato al bordo (sarebbe una cornice inventata).
            if x1 < x0:
                x0, x1 = x1, x0
            if y1 < y0:
                y0, y1 = y1, y0
            n = 0
            for x in range(x0, x1 + 1):
                n += pixel_put(buf, w, h, x, y0, rgba)
                n += pixel_put(buf, w, h, x, y1, rgba)
            for y in range(y0 + 1, y1):
                n += pixel_put(buf, w, h, x0, y, rgba)
                n += pixel_put(buf, w, h, x1, y, rgba)
            return n

        return pixel_line(buf, w, h, x0, y0, x1, y1, rgba)

    if cmd == "mirror":
        return apply_pixel_mirror(_at(parts, 1), buf, w, h)
    if cmd == "noise":
        return apply_pixel_noise(parts, buf, w, h, palette, warnings)
    return bad("unknownCmd " + cmd)


def apply_pixel_mirror(axis, buf, w, h):
    """`mirror x` ribalta la META' SINISTRA sulla destra, `mirror y` l'alta sulla
    bassa. Opera sul BUFFER, non sulla lista di ops, quindi vede tutto cio' che
    la precede — ed e' per questo che va messa dopo aver disegnato la meta'
    sorgente. Con lato dispari la riga/colonna centrale resta com'e'.

    ATTENZIONE (misurato con l'AI vera): ribalta sulla colonna centrale DELLA
    TELA, non sul centro del soggetto. Un disegno tutto a sinistra diventa due
    copie affiancate.
    """
    a = str(axis or "x").lower()
    n = 0
    if a == "x":
        for y in range(h):
            for x in range(w // 2):
                s = (y * w + x) * 4
                d = (y * w + (w - 1 - x)) * 4
                buf[d:d + 4] = buf[s:s + 4]
                n += 1
    elif a == "y":
        for y in range(h // 2):
            for x in range(w):
                s = (y * w + x) * 4
                d = ((h - 1 - y) * w + x) * 4
                buf[d:d + 4] = buf[s:s + 4]
                n += 1
    return n


def apply_pixel_noise(parts, buf, w, h, palette, warnings):
    """`noise x0 y0 x1 y1 colore densita [seme]`.

    Il generatore ha un seme ESPLICITO, non un random vero: la stessa risposta
    dell'AI deve ridare la stessa texture, o riaprire il materiale darebbe
    un'immagine diversa da quella che l'utente ha approvato.
    """
    r = pixel_rect_args(_at(parts, 1), _at(parts, 2), _at(parts, 3),
                        _at(parts, 4), w, h)
    if not r:
        if warnings is not None and len(warnings) < 20:
            warnings.append("badCoords noise")
        return 0
    rgba = pixel_color_to_rgba(_at(parts, 5), palette)
    if not rgba:
        if warnings is not None and len(warnings) < 20:
            warnings.append("badColor noise " + str(_at(parts, 5)))
        return 0
    d = js_number(_at(parts, 6))
    if d is None or math.isinf(d):
        d = 0.25
    if d > 1:
        d = d / 100.0                       # "30" inteso come 30%
    d = min(1.0, max(0.0, d))
    seed = js_round(_at(parts, 7))
    if seed is None:
        seed = 1
    # Il seme entra nello stato: con un LCG puro il seme 0 resterebbe 0.
    state = _to_int32(float(seed) * 1103515245.0 + 12345.0) & 0x7FFFFFFF
    n = 0
    for y in range(r[1], r[3] + 1):
        for x in range(r[0], r[2] + 1):
            state, v = _lcg_next(state)
            if v < d:
                n += pixel_put(buf, w, h, x, y, rgba)
    return n


# --- difesa contro la cancellazione suicida ---------------------------------

def pixel_is_wipe_op(op, w, h, palette):
    """Una op che rende trasparente l'INTERA faccia. Riconoscimento volutamente
    stretto (deve coprire tutto): una `del` parziale e' un intaglio legittimo del
    profilo, e scartarla toglierebbe all'AI il suo unico modo di sottrarre."""
    if not isinstance(op, str):
        return False
    p = _split(op)
    cmd = (p[0] if p else "").lower()
    if cmd not in ("del", "fill"):
        return False
    if cmd == "fill":
        rgba = pixel_color_to_rgba(_at(p, 5), palette)
        if not rgba or rgba[3] != 0:
            return False
    vals = [js_round(_at(p, i)) for i in (1, 2, 3, 4)]
    if any(v is None for v in vals):
        return False
    x0, y0, x1, y1 = vals
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return x0 <= 0 and y0 <= 0 and x1 >= w - 1 and y1 >= h - 1


def pixel_op_paints(op, palette):
    """L'op AGGIUNGE colore? Solo i comandi che dipingono e solo con un colore
    opaco: `fill ... -` toglie invece di aggiungere, `mirror` copia cio' che c'e'."""
    if not isinstance(op, str):
        return False
    p = _split(op)
    cmd = (p[0] if p else "").lower()
    if cmd not in _PAINT_COMMANDS:
        return False
    rgba = pixel_color_to_rgba(_at(p, 1) if cmd == "set" else _at(p, 5), palette)
    return bool(rgba) and rgba[3] != 0


def pixel_drop_suicidal_ops(ops, w, h, palette, warnings):
    """Scarta le cancellazioni totali che NESSUNA pennellata segue.

    L'AI chiude spesso con `del 0 0 W-1 H-1` credendo di "ripulire lo sfondo
    trasparente": ma le ops si applicano in ordine su un buffer, quindi quella
    cancella il disegno appena fatto e la faccia torna VUOTA. Misurato con l'AI
    vera, due risposte su dodici. E' il difetto peggiore perche' una faccia vuota
    non si distingue da "non ha generato niente".

    Una `del` totale con un vero disegno DOPO non si tocca: li' e' un "riparti da
    capo" legittimo, ed e' la ragione per cui la regola non puo' essere
    "vietato cancellare tutto".
    """
    ops = list(ops)
    paints_after = [False] * len(ops)
    seen = False
    for i in range(len(ops) - 1, -1, -1):
        paints_after[i] = seen
        if pixel_op_paints(ops[i], palette):
            seen = True
    kept = [op for i, op in enumerate(ops)
            if not (pixel_is_wipe_op(op, w, h, palette) and not paints_after[i])]
    if len(kept) != len(ops) and warnings is not None and len(warnings) < 20:
        warnings.append("wipeDropped")
    return kept


# --- espansione --------------------------------------------------------------

def expand_pixel_ops(data, opts=None):
    """La risposta dell'AI -> un buffer RGBA per faccia.

    Forme accettate (un LLM ne produce piu' di una, e rifiutarne una costerebbe
    all'utente una rigenerazione per una virgola):
      {size, palette, faces: {px: ["fill ..."]}}
      {size, palette, faces: {px: {ops: [...], palette: {...}}}}
      {size, palette, ops: [...]}              -> texture unica ('all')

    Ritorna {w, h, faces: {chiave: bytearray}, painted: {...}, warnings: [...]}.
    `painted` serve a chi chiama per NON sovrascrivere un disegno con una tela
    vuota: una risposta che nomina una faccia e poi non ci disegna niente
    cancellerebbe cio' che c'era, che e' peggio di non aver generato.
    """
    o = opts or {}
    warnings = []
    if not isinstance(data, dict):
        return {"w": 0, "h": 0, "faces": {}, "painted": {},
                "warnings": ["emptyAnswer"]}

    dflt = clamp_side(o.get("size"), 16)
    w = clamp_side(data.get("w") or data.get("width") or data.get("size"), dflt)
    h = clamp_side(data.get("h") or data.get("height") or data.get("size"), dflt)
    # Se chi chiama impone la dimensione (la tela esiste gia' e le altre facce
    # sono di quel lato) si ignora quella dichiarata dall'AI: facce di lati
    # diversi sullo stesso cubo si vedono come una texture "non caricata".
    if o.get("forceSize"):
        w = clamp_side(o.get("size"), dflt)
        h = clamp_side(o.get("height"), w) if o.get("height") else w

    palette = {}
    raw_pal = data.get("palette") or data.get("colors") or data.get("colori")
    if isinstance(raw_pal, dict):
        palette.update(raw_pal)

    raw_faces = data.get("faces") or data.get("facce")
    if not isinstance(raw_faces, dict):
        ops = data.get("ops") or data.get("comandi")
        raw_faces = {"all": ops} if ops else {}

    faces, painted = {}, {}
    budget = PIXEL_OPS_MAX
    for raw_key, entry in raw_faces.items():
        key = str(raw_key).strip().lower()
        # Una faccia puo' dichiarare una palette PROPRIA, che si somma a quella
        # comune (la faccia vince sulle chiavi omonime). Non e' nel prompt, ma e'
        # fra le forme che un LLM produce da se': senza questo ramo le sue chiavi
        # non risolvono, le ops non dipingono e la faccia torna VUOTA — che si
        # legge come "non ha generato niente" invece che come "ha risposto in un
        # altro modo". Trovato in GUI reale.
        face_pal = palette
        if isinstance(entry, dict):
            rp = entry.get("palette") or entry.get("colors") or entry.get("colori")
            if isinstance(rp, dict):
                face_pal = dict(palette)
                face_pal.update(rp)
            entry = entry.get("ops") or entry.get("comandi") or entry.get("list")
        if isinstance(entry, str):
            entry = entry.split("\n")
        if not isinstance(entry, (list, tuple)):
            warnings.append("noOps " + key)
            continue
        buf = bytearray(w * h * 4)              # tutto trasparente
        oplist = pixel_drop_suicidal_ops(entry, w, h, face_pal, warnings)
        n = 0
        for op in oplist:
            if budget <= 0:
                warnings.append("truncated")
                break
            budget -= 1
            n += apply_pixel_op(op, buf, w, h, face_pal, warnings)
        faces[key] = buf
        painted[key] = n

    return {"w": w, "h": h, "faces": faces, "painted": painted,
            "warnings": warnings}


# --- il verso opposto: dai pixel a un testo che l'AI possa leggere ----------

def pixels_to_rle_rows(px, w, h, max_colors=48):
    """Una faccia esistente -> righe RLE + palette, per darla come CONTESTO.

    Formato: una riga per riga di pixel, `<n><chiave>` con n omesso quando e' 1.
    Su una riga uniforme costa 3 caratteri invece di 32; su una riga irregolare
    degrada esattamente nella griglia di caratteri, che e' cio' che un modello
    legge meglio. Un solo formato che si adatta da se'.
    """
    max_keys = min(len(PIXEL_RLE_ALPHABET), max_colors)
    by_hex = {}
    palette = {}

    def nearest(r, g, b):
        best, best_d = None, None
        for hexv, ch in by_hex.items():
            rr = int(hexv[1:3], 16)
            gg = int(hexv[3:5], 16)
            bb = int(hexv[5:7], 16)
            d = (rr - r) ** 2 + (gg - g) ** 2 + (bb - b) ** 2
            if best_d is None or d < best_d:
                best, best_d = ch, d
        return best

    def key_for(r, g, b, a):
        if a < 8:
            return PIXEL_RLE_TRANSPARENT
        hexv = "#%02X%02X%02X" % (r, g, b)
        known = by_hex.get(hexv)
        if known:
            return known
        if len(by_hex) >= max_keys:
            # Una foto importata ha centinaia di tinte e l'alfabeto ne regge
            # poche decine. Approssimare e' giusto: questo testo e' CONTESTO, non
            # la texture — serve a far capire com'e' fatta la faccia accanto.
            return nearest(r, g, b) or PIXEL_RLE_TRANSPARENT
        ch = PIXEL_RLE_ALPHABET[len(by_hex)]
        by_hex[hexv] = ch
        palette[ch] = hexv
        return ch

    rows = []
    for y in range(h):
        out = []
        run_ch, run_n = None, 0
        for x in range(w):
            i = (y * w + x) * 4
            ch = key_for(px[i], px[i + 1], px[i + 2], px[i + 3])
            if ch == run_ch:
                run_n += 1
                continue
            if run_ch is not None:
                out.append((str(run_n) if run_n > 1 else "") + run_ch)
            run_ch, run_n = ch, 1
        if run_ch is not None:
            out.append((str(run_n) if run_n > 1 else "") + run_ch)
        rows.append("".join(out))
    return {"w": w, "h": h, "palette": palette, "rows": rows}


def pixel_context_block(label, grid):
    """Il testo che finisce nel prompt per UNA faccia di contesto."""
    lines = ["FACCIA %s (%dx%d):" % (label, grid["w"], grid["h"])]
    pal = " ".join("%s=%s" % (k, v) for k, v in grid["palette"].items())
    lines.append("  colori: %s  %s=trasparente"
                 % (pal or "(vuota)", PIXEL_RLE_TRANSPARENT))
    for r in grid["rows"]:
        lines.append("  " + r)
    return "\n".join(lines)


def buffer_average_color(buf, w, h):
    """Rimandi a `png.buffer_average_color`. Vivevano qui, ma operano su un
    buffer RGBA e non sulle ops: stanno in `png.py` insieme al resto. Restano
    esposti perche' chi espande delle ops di solito vuole subito la tinta media
    del risultato."""
    from .png import buffer_average_color as impl
    return impl(buf, w, h)


def buffer_has_alpha(buf):
    from .png import buffer_has_alpha as impl
    return impl(buf)
