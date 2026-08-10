"""Materiali con texture: creazione, generazione AI, applicazione ai voxel.

Tiene insieme quattro pezzi che esistono gia' e non vanno riscritti:
`pixelops` (le ops 2D), `materials` (il contratto del materiale), `png` (codifica
e decodifica) e i prompt dell'app (`compat.main_module()`).

QUATTRO COSE CHE NON SI VEDONO LEGGENDO LE FIRME.

1. **La texture si fa con le OPS, non con un PNG.** E' la stessa scelta della UI
   (`37-pixel-ops.js`): un PNG 128x128 in base64 sono decine di kilobyte che un
   modello linguistico non sa ne' scrivere ne' rileggere, mentre venti ops le
   scrive e le corregge. Il PNG resta la via d'INTEROPERABILITA' (importalo,
   esportalo), non la via di creazione.

2. **Un materiale porta la sua TINTA MEDIA in `color`.** Non e' ridondanza: ogni
   percorso che pretende un hex (`.vox`, `.schem`, le swatch, l'MTL senza PNG)
   funziona senza sapere che i materiali esistono, e un id orfano degrada da se'
   a tinta unita. Quindi applicare un materiale a un voxel scrive DUE cose,
   l'id e il colore medio; scriverne una sola darebbe un modello grigio in
   meta' degli esportatori.

3. **Il contesto per l'AI e' TESTO RLE, non un'immagine.** Le facce gia'
   disegnate si mandano come griglia di caratteri (`pixels_to_rle_rows`), che
   costa due ordini di grandezza in meno di un base64 e che un modello legge
   davvero. E con ambito "tutte" **non si manda niente**: sarebbe ripetere
   all'AI, a pagamento, cio' che le si sta chiedendo di rifare.

4. **Una faccia nominata e non disegnata si SCARTA** (`painted`). Una risposta
   che dichiara `nx` e poi non ci mette una op cancellerebbe cio' che c'era, ed
   e' peggio di non aver generato: l'utente vede una faccia vuota e non sa se
   ha sbagliato lui o l'AI.
"""

import copy
import json
import os

from . import ai, compat, materials, pixelops
from . import png as pngmod
from .session import SessionError

# Tutte le facce piu' la tela unica. `all` non e' una faccia del cubo: e' il
# materiale a texture singola, cioe' il caso normale di un blocco.
FACE_KEYS = materials.FACE_KEYS
ALL_KEY = "all"

LIBRARY_FILE = "material_library.json"


def face_key(name):
    """Sigla canonica di una faccia, o None.

    Passa dalla tabella di alias di `src/pixelprompt.py` invece di averne una
    propria: due tabelle accetterebbero due insiemi di grafie diverse, e
    l'utente che scrive "sopra" otterrebbe una faccia dall'app e un errore da
    qui. E' un nome privato di quel modulo, ma e' lo stesso che importa
    `main.py` — l'alternativa vera non e' un nome pubblico, e' una copia.
    """
    s = str(name or "").strip().lower()
    if s in (ALL_KEY, "tutte", "unica", "single"):
        return ALL_KEY
    return compat.pixelprompt_module()._pixel_face_key(s)


def face_keys(names, default=None):
    """Lista di sigle, senza duplicati e nell'ordine dato."""
    out = []
    for n in (names or []):
        k = face_key(n)
        if k and k not in out:
            out.append(k)
    return out or list(default or [])


def _side(value, default=16):
    return pixelops.clamp_side(value, default)


# Nome pubblico: `server.py` ne ha bisogno per allocare una tela, e un
# sottolineato attraverserebbe il confine fra moduli senza dirlo.
side = _side


def op_to_text(op):
    """Una op 2D nella forma che `apply_pixel_op` sa leggere: una STRINGA.

    Esiste perche' l'MCP ha due formati vicini e diversi, e chi scrive le ops
    scivola dall'uno all'altro senza accorgersene: le ops dei VOXEL
    (`voxel_ops`) sono liste (`["fill", 0,0,0, 7,3,7, "#8844AA"]`), quelle dei
    PIXEL sono righe di testo (`"fill 0 0 15 15 a"`). E' la stessa parola
    "ops" per due cose, quindi la lista arriva qui regolarmente.

    Senza questa conversione l'op non e' una stringa, `apply_pixel_op` ritorna 0
    SENZA un avviso (li' e' giusto: un elemento non-stringa e' spazzatura), la
    faccia risulta non dipinta e viene scartata. Il messaggio che ne usciva era
    "le ops non hanno dipinto niente", che manda a cercare un errore nei colori
    o nelle coordinate invece che nella forma. Misurato con un client MCP vero.

    Si converte QUI e non in `pixelops.py` di proposito: quel modulo ha un
    gemello in JS (`ui/src/lib/37-pixel-ops.js`) e la parita' fra i due e'
    verificata op per op da `tests/pixel_parity_check.sh`. Allargare li' cio'
    che si accetta significherebbe allargarlo anche di la', o la parita' si
    rompe; ed e' una comodita' del confine MCP, non una regola del formato.
    """
    if isinstance(op, str):
        return op
    if isinstance(op, (list, tuple)):
        return " ".join("" if x is None else str(x) for x in op)
    return str(op)


def ops_to_text(ops):
    """Come `op_to_text`, su una lista. Una stringa multiriga si spezza in righe,
    che e' l'altra forma che un modello produce da se'."""
    if isinstance(ops, str):
        ops = ops.split("\n")
    return [op_to_text(o) for o in (ops or [])]


def _faces_to_text(faces):
    """Le ops di ogni faccia, normalizzate. Le forme annidate che
    `expand_pixel_ops` accetta (`{ops: [...], palette: {...}}`) si attraversano
    invece di appiattirle: la palette per-faccia deve sopravvivere."""
    if not isinstance(faces, dict):
        return faces
    out = {}
    for k, entry in faces.items():
        if isinstance(entry, dict):
            entry = dict(entry)
            for f in ("ops", "comandi", "list"):
                if f in entry:
                    entry[f] = ops_to_text(entry[f])
            out[k] = entry
        else:
            out[k] = ops_to_text(entry)
    return out


def faces_from_ops(data, size=16, height=None, force=True):
    """Ops 2D -> {sigla: texture}, piu' avvisi.

    `force` impone la dimensione di chi chiama: la tela di un materiale esiste
    gia' e le altre facce sono di quel lato, quindi una dimensione diversa
    dichiarata dall'AI si ignora. Facce di lati diversi sullo stesso cubo si
    vedono come una texture "non caricata", che e' un difetto difficile da
    ricondurre alla sua causa.
    """
    w = _side(size)
    h = _side(height, w) if height else w
    # Le ops si normalizzano PRIMA (vedi `op_to_text`): la lista invece della
    # riga di testo e' lo scivolone piu' comune, e senza questo passaggio la
    # faccia esce vuota senza un avviso che dica perche'.
    if isinstance(data, dict):
        data = dict(data)
        if data.get("faces") is not None:
            data["faces"] = _faces_to_text(data["faces"])
        if data.get("facce") is not None:
            data["facce"] = _faces_to_text(data["facce"])
        for f in ("ops", "comandi"):
            if data.get(f) is not None:
                data[f] = ops_to_text(data[f])
    out = pixelops.expand_pixel_ops(data, {"size": w, "height": h if h != w else None,
                                           "forceSize": bool(force)})
    faces, skipped = {}, []
    for key, buf in (out.get("faces") or {}).items():
        k = face_key(key)
        if not k:
            skipped.append(str(key)[:16])
            continue
        if not (out.get("painted") or {}).get(key):
            # Vedi il punto 4 del modulo: una tela vuota non sovrascrive.
            skipped.append(k + " (vuota)")
            continue
        faces[k] = materials.texture_from_buffer(buf, out["w"], out["h"])
    return {"faces": faces, "w": out["w"], "h": out["h"],
            "warnings": list(out.get("warnings") or []), "skipped": skipped}


def draw_ops_on(buf, w, h, ops, palette=None, guard=False):
    """Applica ops 2D SOPRA un buffer esistente. Ritorna (pixel, avvisi).

    `expand_pixel_ops` parte sempre da una tela vuota — giusto per una
    generazione, sbagliato per un ritocco: un `del` deve cancellare cio' che c'e'
    davvero, non un buffer trasparente appena allocato. Quindi qui si riusano le
    STESSE funzioni op per op (`apply_pixel_op`) invece di scriverne una seconda
    versione: la semantica delle ops 2D ha gia' due implementazioni da tenere
    allineate (Python e JS), e una terza sarebbe la stessa trappola che sulle ops
    dei voxel e' costata tre difetti veri.

    `guard` (la difesa contro la cancellazione totale) e' SPENTO per difetto, e
    la ragione e' che dipende da chi scrive le ops. Un assistente che chiama
    `voxel_texture_draw` con `del 0 0 15 15` sta chiedendo di svuotare la tela e
    va obbedito. L'AI integrata invece aggiunge quella riga da se', credendo di
    "ripulire lo sfondo trasparente", e cancella il disegno che ha appena fatto
    (misurato: due risposte su dodici). Quindi il guard si accende solo sul ramo
    dell'AI.
    """
    ops = ops_to_text(ops)
    warnings = []
    if guard:
        ops = pixelops.pixel_drop_suicidal_ops(ops, w, h, palette, warnings)
    n = 0
    for op in ops[:pixelops.PIXEL_OPS_MAX]:
        n += pixelops.apply_pixel_op(op, buf, w, h, palette, warnings)
    return n, warnings


# --- il materiale -------------------------------------------------------------

def material_ref(doc, ref, required=True):
    """Un materiale per id o per nome. Il nome perche' un assistente lo ha
    appena scritto e se lo ricorda, l'id perche' e' cio' che sta sui voxel."""
    s = str(ref or "").strip()
    if not s:
        if not doc.materials:
            if required:
                raise SessionError(
                    "questo progetto non ha materiali: creane uno con "
                    "`voxel_material_create`")
            return None
        return doc.materials[-1]
    found = doc.material_by_id(s)
    if found is not None:
        return found
    low = s.lower()
    for m in doc.materials:
        if str(m.get("name", "")).strip().lower() == low:
            return m
    if not required:
        return None
    raise SessionError("materiale '%s' sconosciuto. Disponibili: %s"
                       % (s, ", ".join("%s (%s)" % (m.get("id"), m.get("name"))
                                       for m in doc.materials) or "nessuno"))


def texture_of(mat, key):
    """La texture di una faccia, o None. `all` legge la texture unica."""
    if key == ALL_KEY:
        return mat.get("texture")
    return (mat.get("faces") or {}).get(key)


def buffer_of(mat, key, size=None):
    """(buffer, w, h) della faccia: quella che c'e', o una tela vuota.

    Una texture illeggibile NON solleva: si riparte da una tela vuota della
    dimensione chiesta. Un materiale con la texture rotta deve poter essere
    ridisegnato, non diventare inutilizzabile.
    """
    tex = texture_of(mat, key)
    if tex:
        try:
            return materials.texture_buffer(tex)
        except Exception:                                    # noqa: BLE001
            pass
    w = _side(size or (tex or {}).get("w") or 16)
    return bytearray(w * w * 4), w, w


def set_face(mat, key, tex):
    """Scrive una texture nella faccia giusta, tenendo `faceMode` coerente.

    Una modalita' "sei facce" senza facce, o una faccia messa su un materiale a
    texture unica, sono stati che nessun percorso di disegno sa rendere: si
    vedrebbe un cubo grigio. Quindi la modalita' la decide DOVE si e' scritto,
    non un campo che l'utente deve ricordarsi di cambiare.
    """
    if key == ALL_KEY:
        mat["texture"] = tex
        if not mat.get("faces"):
            mat["faceMode"] = "single"
        return
    faces = dict(mat.get("faces") or {})
    faces[key] = tex
    mat["faces"] = faces
    mat["faceMode"] = "six"


def existing_faces(mat):
    """Le sigle che hanno davvero una texture, nell'ordine del cubo."""
    if mat.get("faceMode") == "six":
        return [k for k in FACE_KEYS if (mat.get("faces") or {}).get(k)]
    return [ALL_KEY] if mat.get("texture") else []


def sync_material_color(doc, mat, obj=None):
    """Riallinea `color` del materiale e dei voxel che lo usano alla tinta media.

    Va chiamata dopo OGNI modifica alla texture: il colore e' una copia
    denormalizzata (vedi il punto 2 del modulo), e una copia che non si aggiorna
    e' peggio di non averla — il modello si esporterebbe col colore della
    texture precedente. Aggiorna TUTTI gli oggetti, perche' i materiali sono di
    progetto e lo stesso id puo' stare su piu' oggetti.
    """
    mid = mat.get("id")
    mat["color"] = materials.material_average_color(mat)
    touched = 0
    targets = [obj] if obj is not None else list(doc.objects)
    for o in targets:
        for key, cell in list(o.cells.items()):
            if cell.material == mid and cell.color != mat["color"]:
                doc.set_cell(o, key, cell.with_color(mat["color"]))
                touched += 1
    return touched


# --- generazione con l'AI integrata ------------------------------------------

def context_blocks(mat, wanted):
    """Le facce GIA' disegnate come testo RLE, per tenere coerente il resto.

    Si escludono quelle che si sta per rifare: darle come contesto vorrebbe dire
    chiedere all'AI di copiare cio' che stiamo buttando. E se non ne resta
    nessuna non si manda niente — che e' anche il caso dell'ambito "tutte".
    """
    out = []
    for key in existing_faces(mat):
        if key in wanted:
            continue
        try:
            buf, w, h = materials.texture_buffer(texture_of(mat, key))
        except Exception:                                    # noqa: BLE001
            continue
        grid = pixelops.pixels_to_rle_rows(buf, w, h)
        out.append(pixelops.pixel_context_block(key, grid))
    return "\n".join(out)


def generate_faces(prompt, wanted, size=16, height=None, context="",
                   model=None, provider=None):
    """Prompt -> {sigla: texture}. Passa dai PROMPT DELL'APP, non da una copia.

    `build_pixel_prompt` di `main.py` legge `assets/prompts/prompt-pixel.txt`,
    cioe' lo stesso file del pulsante "Genera" del creatore di materiali:
    riscrivere qui l'assemblaggio darebbe due texture diverse per la stessa
    richiesta a seconda di come si e' entrati.

    La normalizzazione e' quella del server HTTP (`normalize_pixel_data`), quindi
    le forme che un LLM produce da se' (ops alla radice, sinonimi, palette dentro
    la faccia) sono accettate qui come li'.
    """
    app = compat.main_module()
    pp = compat.pixelprompt_module()
    wanted = wanted or [ALL_KEY]
    w = _side(size)
    h = _side(height, w) if height else None

    with compat.quiet():
        final = app.build_pixel_prompt(prompt, wanted, context=context or None,
                                       size=w, height=h)
    data = ai.ask_json(final, model=model, provider=provider)
    norm = pp.normalize_pixel_data(data, wanted)
    if not norm.get("faces"):
        raise SessionError(
            "l'AI non ha prodotto nessuna faccia disegnabile.%s\nRiprova, "
            "oppure disegna le ops a mano con `voxel_texture_draw`."
            % ("" if not norm.get("warnings")
               else " Avvisi: " + "; ".join(norm["warnings"][:4])))
    built = faces_from_ops({"palette": norm.get("palette") or {},
                            "faces": norm["faces"]},
                           size=w, height=h, force=True)
    built["warnings"] = list(norm.get("warnings") or []) + built["warnings"]
    built["prompt_chars"] = len(final)
    return built


# --- libreria personale -------------------------------------------------------

def library_path():
    """Il file della libreria dell'MCP.

    NON e' la libreria della UI, e non puo' esserlo: quella vive in
    `localStorage` del browser (`voxelai-material-library`), che un processo
    Python non raggiunge in nessun modo. Finge di condividerla sarebbe peggio
    che tenerle separate — un materiale "salvato" che nell'app non compare si
    legge come un difetto. Il ponte fra le due resta il PNG (import/export) e il
    progetto salvato, che entrambe leggono.

    `VOXELAI_MCP_DIR` la sposta, e serve ALLE PROVE: senza, la suite
    scriverebbe nella libreria VERA dello sviluppatore — cioe' la
    riempirebbe di materiali usa-e-getta fino al tetto, buttando fuori quelli
    che voleva tenere. E' lo stesso rimedio di `VOXELAI_PROVIDERS_DIR`.
    """
    folder = os.environ.get("VOXELAI_MCP_DIR")
    if not folder:
        folder = compat.settings_module().get_appdata_dir()
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError:
        pass
    return os.path.join(folder, LIBRARY_FILE)


def library_load():
    try:
        with open(library_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    return [m for m in data if isinstance(m, dict)] if isinstance(data, list) else []


def library_save(items):
    with open(library_path(), "w", encoding="utf-8") as f:
        json.dump(items[:materials.LIBRARY_MAX], f, ensure_ascii=False)


def library_add(mat):
    """Aggiunge una copia al fondo, per NOME e non per id.

    L'id (`m1`) e' relativo al progetto: due progetti lo usano per materiali
    diversi. In libreria conta il nome, ed e' anche cio' che l'utente scrivera'
    per riprenderlo. Un nome che c'e' gia' viene SOSTITUITO invece di duplicato:
    la libreria ha un tetto (40) e riempirla di quasi-copie farebbe rifiutare
    proprio i materiali che si volevano tenere.
    """
    items = library_load()
    entry = copy.deepcopy(mat)
    name = str(entry.get("name") or "Materiale").strip()
    entry["name"] = name
    items = [m for m in items if str(m.get("name", "")).strip() != name]
    items.append(entry)
    if len(items) > materials.LIBRARY_MAX:
        items = items[-materials.LIBRARY_MAX:]
    library_save(items)
    return len(items)


def library_find(ref):
    items = library_load()
    s = str(ref or "").strip()
    if not s:
        raise SessionError("serve il nome del materiale da riprendere")
    low = s.lower()
    for m in items:
        if str(m.get("name", "")).strip().lower() == low:
            return m
    if s.isdigit() and 1 <= int(s) <= len(items):
        return items[int(s) - 1]
    raise SessionError("nella libreria non c'e' '%s'. Ci sono: %s"
                       % (s, ", ".join(str(m.get("name")) for m in items)
                          or "niente"))


