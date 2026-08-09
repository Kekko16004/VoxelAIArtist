"""Prompt e normalizzazione per la generazione AI di PIXEL ART 2D.

Modulo CONDIVISO fra VoxelAIArtist (texture delle facce di un cubo) e
PixelAIEditor (una tela 2D qualunque). Vive in `src/` perche' e' l'unica cosa
che le due app si scambiano su questo fronte: importare `main.py` del padre
significherebbe importare Gemini, la coda dei pack e la risoluzione della
modalita' d'avvio da `sys.argv`.

Qui NON si disegna e NON si interpretano le coordinate: l'espansione delle ops
vive nel browser (`expandPixelOps` in 37-pixel-ops.js / 13-pixel-ops.js), dove
sta la tela. Il server si limita a ricondurre la risposta dell'AI al contratto,
cosi' un errore di formato diventa un 400 spiegato invece di una tela che resta
misteriosamente vuota.

Non c'e' nessuna parita' Python<->JS da mantenere (a differenza delle ops dei
voxel, `expand_ops`): l'unico consumatore delle ops 2D e' il client.
"""

PIXEL_FACE_KEYS = ("px", "nx", "py", "ny", "pz", "nz")
PIXEL_MIN_SIDE = 4
PIXEL_MAX_SIDE = 128
PIXEL_DEFAULT_SIDE = 16
PIXEL_MAX_OPS = 400          # per faccia: oltre, l'AI sta elencando pixel
PIXEL_MAX_PALETTE = 64
PIXEL_COMMANDS = ("fill", "rect", "line", "set", "del", "mirror", "noise")

# Etichette per il prompt. Il cubo di r128 ordina i gruppi +X,-X,+Y,-Y,+Z,-Z:
# le sigle sono quelle di MATERIAL_FACE_KEYS lato UI, qui servono solo a
# spiegare all'AI quale faccia sta disegnando.
PIXEL_FACE_LABELS = {
    "px": "laterale destra (+X)",
    "nx": "laterale sinistra (-X)",
    "py": "vista dall'alto (+Y)",
    "ny": "vista da sotto (-Y)",
    "pz": "laterale davanti (+Z)",
    "nz": "laterale dietro (-Z)",
    "all": "texture unica, usata su tutte le facce",
}

# Un LLM scrive "top" o "sopra" molto piu' spesso di "py". Ricondurli e' meno
# costoso che rifiutare la risposta e rigenerare.
_PIXEL_FACE_ALIASES = {
    "px": "px", "x+": "px", "+x": "px", "right": "px", "destra": "px", "east": "px",
    "nx": "nx", "x-": "nx", "-x": "nx", "left": "nx", "sinistra": "nx", "west": "nx",
    "py": "py", "y+": "py", "+y": "py", "top": "py", "up": "py", "alto": "py",
    "sopra": "py", "cima": "py",
    "ny": "ny", "y-": "ny", "-y": "ny", "bottom": "ny", "down": "ny", "basso": "ny",
    "sotto": "ny", "fondo": "ny",
    "pz": "pz", "z+": "pz", "+z": "pz", "front": "pz", "fronte": "pz",
    "davanti": "pz", "south": "pz",
    "nz": "nz", "z-": "nz", "-z": "nz", "back": "nz", "dietro": "nz",
    "retro": "nz", "north": "nz",
    "all": "all", "tutte": "all", "tutto": "all", "unica": "all", "single": "all",
    "base": "all", "texture": "all", "default": "all", "side": "all",
    "lato": "all", "laterale": "all",
    # PixelAIEditor lavora su UNA tela: sono i nomi che un LLM usa quando gli si
    # chiede un'immagine invece di un cubo. Senza questi alias la risposta
    # finirebbe fra le `unknownFaces` e la tela resterebbe vuota.
    "canvas": "all", "tela": "all", "image": "all", "immagine": "all",
    "sprite": "all", "layer": "all", "livello": "all", "main": "all",
    "result": "all", "risultato": "all", "output": "all", "art": "all",
}


def _pixel_face_key(name):
    """Sigla di faccia canonica, o None se non riconosciuta."""
    key = str(name or "").strip().lower().replace(" ", "").replace("_", "")
    return _PIXEL_FACE_ALIASES.get(key)


PIXEL_PROMPT_FALLBACK = (
    "Sei un pixel artist esperto di texture per giochi voxel.\n"
    "Disegna le TEXTURE richieste con COMANDI COMPATTI, non pixel per pixel.\n\n"
    "### TELA\n"
    "Ogni faccia e' una griglia di [INSERISCI QUI LA DIMENSIONE] pixel.\n"
    "Origine (0,0) in ALTO A SINISTRA: x verso destra, y verso il basso.\n"
    "Coordinate INCLUSIVE.\n\n"
    "### FACCE DA DISEGNARE\n[INSERISCI QUI LE FACCE]\n\n"
    "### FACCE GIA' DISEGNATE (contesto)\n[INSERISCI QUI IL CONTESTO]\n\n"
    "### FORMATO OUTPUT (obbligatorio)\n"
    "Rispondi SOLO con il JSON dentro un blocco markdown (```json ... ```).\n"
    "{\"size\":16,\"palette\":{\"s\":\"#6E6E73\",\"d\":\"#4A4A4F\"},"
    "\"faces\":{\"px\":[\"fill 0 0 15 15 s\",\"noise 0 0 15 15 d 0.18 7\"]}}\n\n"
    "### COMANDI DISPONIBILI\n"
    "fill x0 y0 x1 y1 colore | rect x0 y0 x1 y1 colore | line x0 y0 x1 y1 colore\n"
    "set colore x y x y ... | del x0 y0 x1 y1 | mirror x | mirror y\n"
    "noise x0 y0 x1 y1 colore densita seme\n"
    "Il colore `-` e' TRASPARENTE. Una tela parte trasparente: una faccia opaca\n"
    "deve iniziare con un `fill` che la copre tutta.\n\n"
    "### RICHIESTA DELL'UTENTE\n[INSERISCI QUI LA RICHIESTA]\n"
)


def _clamp_side(value, default):
    try:
        return max(PIXEL_MIN_SIDE, min(PIXEL_MAX_SIDE, int(round(float(value)))))
    except (TypeError, ValueError):
        return default


def build_pixel_prompt(prompt, faces, context=None, size=None, height=None,
                       template=None):
    """Prompt per generare una o piu' facce/tele di pixel art.

    `faces`    sigle da disegnare (px/nx/py/ny/pz/nz, o 'all' per tela unica).
    `context`  facce GIA' disegnate, come testo o {sigla: righe RLE}: il client
               le rende con `pixelContextBlock` perche' e' li' che vive la tela.
               Il server le inoltra e non le interpreta.
    `size`     larghezza della tela. E' l'UNICA fonte: la tela esiste gia' e una
               dimensione diversa costringerebbe a ricampionare il disegno.
    `height`   altezza, se diversa dalla larghezza. La tela di un cubo e'
               quadrata, quella di uno sprite no: omettendola si ricade sul
               quadrato, che e' il caso di VoxelAIArtist.
    `template` testo del prompt. Assente -> PIXEL_PROMPT_FALLBACK. E' un
               parametro e non una lettura da disco perche' le due app hanno
               cartelle `assets/prompts/` diverse e ognuna sa qual e' la sua.
    """
    template = template or PIXEL_PROMPT_FALLBACK

    w = _clamp_side(size, PIXEL_DEFAULT_SIDE)
    h = _clamp_side(height, w) if height is not None else w

    wanted = []
    for f in (faces or []):
        key = _pixel_face_key(f)
        if key and key not in wanted:
            wanted.append(key)
    if not wanted:
        wanted = ["all"]
    faces_str = "\n".join(
        "- `%s`: %s" % (k, PIXEL_FACE_LABELS.get(k, k)) for k in wanted)

    if isinstance(context, str):
        ctx_str = context.strip()
    elif isinstance(context, dict) and context:
        ctx_str = "\n".join(str(v) for v in context.values() if str(v).strip())
    elif isinstance(context, (list, tuple)) and context:
        ctx_str = "\n".join(str(v) for v in context if str(v).strip())
    else:
        ctx_str = ""
    if not ctx_str:
        ctx_str = ("(nessuna faccia disegnata: sei libero, ma resta coerente "
                   "fra le facce che stai creando adesso)")

    out = template.replace("[INSERISCI QUI LA DIMENSIONE]", "%dx%d" % (w, h))
    out = out.replace("[INSERISCI QUI LE FACCE]", faces_str)
    out = out.replace("[INSERISCI QUI IL CONTESTO]", ctx_str)
    # I template finiscono con l'intestazione della richiesta e nessun
    # segnaposto (stesso schema di prompt.txt): se il segnaposto non c'e', la
    # richiesta va APPESA, altrimenti l'AI riceve un prompt senza domanda.
    if "[INSERISCI QUI LA RICHIESTA]" in out:
        return out.replace("[INSERISCI QUI LA RICHIESTA]", prompt)
    return out.rstrip("\n") + "\n" + prompt + "\n"


def _pixel_hex(value):
    """Colore normalizzato a '#RRGGBB', oppure '-' per il trasparente, oppure
    None se non e' un colore. `#RGB` viene espanso: e' una forma che gli LLM
    producono spesso e scartarla costerebbe una rigenerazione."""
    if value is None:
        return None
    s = str(value).strip()
    if s.lower() in ("-", ".", "none", "null", "trasparente", "transparent"):
        return "-"
    if not s:
        return None
    if not s.startswith("#"):
        s = "#" + s
    body = s[1:]
    if not all(c in "0123456789abcdefABCDEF" for c in body):
        return None
    if len(body) == 3:
        body = "".join(c * 2 for c in body)
    if len(body) == 8:          # #RRGGBBAA: l'alpha vive nelle ops, non qui
        body = body[:6]
    if len(body) != 6:
        return None
    return "#" + body.upper()


def normalize_pixel_data(raw, requested_faces=None):
    """Riconduce la risposta dell'AI al contratto di `expandPixelOps`.

    NON disegna e NON interpreta le coordinate: quello lo fa il client, dove
    sta la tela. Qui si controlla solo che esista almeno una faccia con almeno
    un comando riconoscibile, cosi' un errore di formato diventa un 400 chiaro
    invece di una tela che resta misteriosamente vuota.
    """
    warnings = []
    if not isinstance(raw, dict):
        return {"faces": {}, "warnings": ["La risposta non e' un oggetto JSON."]}

    wanted = []
    for f in (requested_faces or []):
        key = _pixel_face_key(f)
        if key and key not in wanted:
            wanted.append(key)

    side = None
    for k in ("size", "side", "w", "width", "lato", "dimensione"):
        if raw.get(k) is not None:
            try:
                side = int(round(float(raw[k])))
            except (TypeError, ValueError):
                continue
            break
    if side is not None:
        clamped = max(PIXEL_MIN_SIDE, min(PIXEL_MAX_SIDE, side))
        if clamped != side:
            warnings.append("dimensione %s fuori range, riportata a %d"
                            % (side, clamped))
        side = clamped

    palette = {}
    raw_palette = None
    for k in ("palette", "colors", "colori", "colours"):
        if isinstance(raw.get(k), dict):
            raw_palette = raw[k]
            break
    for key, value in (raw_palette or {}).items():
        name = str(key).strip()
        if not name or len(palette) >= PIXEL_MAX_PALETTE:
            continue
        hexed = _pixel_hex(value)
        if hexed is None:
            warnings.append("colore '%s' non valido, ignorato" % name)
            continue
        palette[name] = hexed

    raw_faces = None
    for k in ("faces", "facce", "textures", "faccia"):
        if isinstance(raw.get(k), dict):
            raw_faces = raw[k]
            break
    if raw_faces is None:
        # Risposta a faccia singola: le ops stanno alla radice. E' la forma che
        # esce quasi sempre quando si chiede UNA faccia sola.
        for k in ("ops", "comandi", "commands", "list", "draw"):
            if isinstance(raw.get(k), (list, tuple, str)):
                raw_faces = {wanted[0] if len(wanted) == 1 else "all": raw[k]}
                break
    if not isinstance(raw_faces, dict):
        return {"size": side, "palette": palette, "faces": {},
                "warnings": warnings + ["Nessuna faccia nella risposta."]}

    faces = {}
    unknown = []
    for key, value in raw_faces.items():
        fkey = _pixel_face_key(key)
        if not fkey:
            unknown.append(str(key)[:24])
            continue
        if isinstance(value, dict):
            for k in ("ops", "comandi", "commands", "list", "draw"):
                if value.get(k) is not None:
                    value = value[k]
                    break
        if isinstance(value, str):
            value = value.split("\n")
        if not isinstance(value, (list, tuple)):
            warnings.append("faccia '%s': comandi non in lista, ignorata" % fkey)
            continue
        ops = []
        for entry in value:
            if isinstance(entry, (list, tuple)):
                entry = " ".join(str(x) for x in entry)
            line = str(entry).strip().strip(",").strip()
            if not line or line.startswith("#") or line.startswith("//"):
                continue
            head = line.split()[0].lower()
            if head not in PIXEL_COMMANDS:
                warnings.append("faccia '%s': comando '%s' sconosciuto"
                                % (fkey, head[:16]))
                continue
            ops.append(line)
            if len(ops) >= PIXEL_MAX_OPS:
                warnings.append("faccia '%s': troppi comandi, troncata a %d"
                                % (fkey, PIXEL_MAX_OPS))
                break
        if ops:
            faces[fkey] = ops
        else:
            warnings.append("faccia '%s': nessun comando valido" % fkey)

    # Una faccia in piu' non e' un errore da rifiutare: il client applica solo
    # quelle che ha chiesto. Va solo detto, perche' spiega una faccia mancante.
    if wanted:
        extra = [k for k in faces if k not in wanted and k != "all"]
        if extra:
            warnings.append("facce non richieste: %s" % ", ".join(extra))
        missing = [k for k in wanted if k not in faces]
        if missing and "all" not in faces:
            warnings.append("facce richieste ma non disegnate: %s"
                            % ", ".join(missing))

    result = {"size": side, "palette": palette, "faces": faces}
    if unknown:
        result["unknownFaces"] = unknown[:12]
    if warnings:
        result["warnings"] = warnings[:20]
    return result
