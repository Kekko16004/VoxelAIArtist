"""Generazione AI: quella integrata nell'app e quella di chi sta chiamando.

DUE AI, NON UNA — ed e' la ragione per cui questo modulo esiste.

1. **L'AI di chi chiama.** Un client MCP *e'* un modello linguistico. Puo'
   scrivere lui stesso le ops compatte e passarle a `overlay_ops`: non serve
   nessun cookie, nessuna chiave, nessuna rete. E' la via piu' diretta a
   "genera un modello con la propria AI", e per un assistente e' anche la piu'
   controllabile — puo' correggersi op per op invece di rigenerare tutto.
2. **L'AI integrata.** `answer_text` passa dal registro dei provider di `src/`:
   Gemini a cookie (come nell'app), oppure una chiave Anthropic / un endpoint
   OpenAI-compatibile / un provider su misura. "Cookie permettendo" e' letterale:
   senza credenziali il primo ramo continua a funzionare e il secondo dice
   chiaramente cosa manca, invece di fallire con un errore di rete.

I PROMPT NON SI RISCRIVONO QUI. Le regole (struttura grande, asset modulare,
multi-parte, umanoide) e l'assemblaggio dei prompt vivono in `main.py`, e si
prendono da li' con `compat.main_module()`. Duplicarle darebbe due prompt
diversi per lo stesso pulsante: l'app genererebbe una cosa e l'MCP un'altra, e
la differenza si vedrebbe soltanto nei risultati — cioe' troppo tardi.

IL PUNTO DI PROVA E' `answer_text`. Le prove lo sostituiscono nel modulo
(`ai.answer_text = finto`) e tutto il resto — costruzione del prompt, recupero
del JSON, espansione delle ops, scrittura nel documento — gira per davvero
senza rete, senza cookie e senza consumare quota. E' lo stesso trucco con cui
`PackManager` riceve `generate_fn` dall'esterno.
"""

import copy
import json

from . import compat
from .document import Cell, Document
from .session import SessionError

# Sopra questa soglia il modello inviato all'AI in modalita' "modifica" si
# accorcia: un modello grande e' decine di migliaia di ops e le si pagherebbe
# per farle riscrivere quasi identiche. Sotto, si manda intero perche' e' li'
# che l'AI lavora meglio (vede davvero cosa sta modificando).
MODIFY_MAX_OPS = 4000


# --- provider ----------------------------------------------------------------

def provider_status():
    """Chi genererebbe adesso, e se e' in grado di farlo.

    NON contiene mai una chiave ne' un cookie: `list_providers()` legge un
    registro che per costruzione non ne contiene, e le chiavi vivono in un file
    a parte da cui esce solo una maschera. Vale anche qui: un assistente MCP
    e' esattamente il genere di posto in cui una credenziale non deve finire.
    """
    prov = compat.providers_module()
    info = prov.list_providers()
    active_id = info.get("active")
    active = next((p for p in info["providers"] if p.get("id") == active_id), None)
    active = active or {}
    ready = bool(active.get("hasKey"))
    if active.get("type") == prov.TYPE_GEMINI:
        # La voce Gemini dichiara `hasKey: True` per costruzione — la sua
        # autenticazione non e' una chiave, sono i cookie del browser. Leggerla
        # come "pronto" direbbe sempre di si', che e' il contrario di cio' che
        # serve sapere qui ("cookie permettendo").
        ready = bool(compat.settings_module().has_cookies())
    return {
        "attivo": active_id,
        "tipo": active.get("type"),
        "etichetta": active.get("label"),
        "pronto": ready,
        "modello": active.get("model") or None,
        "provider": [{"id": p.get("id"), "tipo": p.get("type"),
                      "etichetta": p.get("label"),
                      "credenziale": bool(p.get("hasKey"))}
                     for p in info["providers"]],
    }


def answer_text(prompt, model=None, provider=None):
    """UNA chiamata all'AI integrata -> il testo grezzo della risposta.

    Ritenta solo gli errori transitori e con un budget di 30 secondi (vedi
    `ai_answer_text_retrying`): una chiamata di strumento ha un umano che
    aspetta dall'altra parte, quindi la scala di attesa della coda dei pack —
    pensata per un lavoro di quaranta minuti — qui sarebbe fuori posto.

    **Questa e' la funzione che le prove sostituiscono.** I chiamanti la
    risolvono dai globali del modulo a ogni chiamata, quindi assegnarle una
    funzione finta intercetta tutto senza toccare il resto.
    """
    client = compat.aiclient_module()
    with compat.quiet():
        return client.ai_answer_text_retrying(prompt, model=model, provider=provider)


def ask_json(prompt, model=None, provider=None):
    """Chiama l'AI e ne ricava il JSON, con gli errori tradotti in consigli.

    Le tre classi di errore di `src/aiclient.py` non sono decorative: dicono
    all'utente COSA fare. Lasciarle passare come eccezioni generiche
    ridurrebbe tutto a "generazione fallita", che e' il messaggio meno utile
    possibile quando la causa e' un cookie scaduto.
    """
    client = compat.aiclient_module()
    try:
        text = answer_text(prompt, model=model, provider=provider)
        looks_json = getattr(client, "_looks_like_json_payload", None)
        looks_ref = getattr(client, "looks_like_refusal", None)
        nudge = getattr(client, "_JSON_RETRY_NUDGE",
                        "\n\nOUTPUT JSON ONLY. No prose, no refusal.")
        bad = False
        if callable(looks_ref) and looks_ref(text):
            bad = True
        elif callable(looks_json) and not looks_json(text):
            bad = True
        if bad:
            text = answer_text(str(prompt) + nudge, model=model, provider=provider)
    except client.AIAuthError as e:
        raise SessionError(
            "L'AI integrata non e' autenticata: %s\nControlla il provider attivo "
            "con `voxel_ai_status`. Nel frattempo puoi costruire lo stesso "
            "modello con `voxel_ops`, che non usa nessuna AI esterna." % e)
    except client.AITransientError as e:
        raise SessionError(
            "L'AI integrata non ha risposto (errore temporaneo): %s\nRiprova fra "
            "poco, oppure usa `voxel_ops`." % e)
    except client.AIFormatError as e:
        raise SessionError("Risposta dell'AI non utilizzabile: %s" % e)
    if not str(text or "").strip():
        raise SessionError("L'AI ha risposto con un testo vuoto.")
    data = compat.extract_and_parse_json(text)
    if not isinstance(data, dict):
        raise SessionError(
            "L'AI non ha prodotto un oggetto JSON (ha risposto con %s). "
            "Riprova, magari con una richiesta piu' specifica."
            % type(data).__name__)
    return data


# --- prompt ------------------------------------------------------------------

def _grid_token(grid):
    """"64" o 64 -> "64x64x64"; 0/None -> "auto".

    `_apply_grid_rule` di `main.py` si aspetta la forma `AxBxC` e ignora in
    silenzio tutto il resto: passargli un numero nudo significherebbe chiedere
    una griglia e non ottenerla, senza un errore.
    """
    if not grid:
        return "auto"
    s = str(grid).strip().lower()
    if s in ("auto", ""):
        return "auto"
    if "x" in s:
        return s
    try:
        n = max(2, int(float(s)))
    except (TypeError, ValueError):
        return "auto"
    return "%dx%dx%d" % (n, n, n)


grid_token = _grid_token


def build_generate_prompt(subject, grid=0, big_structure=False, modular=False,
                          single_object=True, humanoid=False):
    """Il prompt di generazione, montato con gli stessi pezzi del pulsante
    "Crea" dell'app e nello stesso ORDINE.

    L'ordine conta davvero: le regole piu' vincolanti stanno alla fine, dove i
    modelli linguistici le seguono meglio. La regola umanoide specializza il
    formato multi-parte, quindi il multi-parte va aggiunto anche quando
    l'utente ha lasciato "oggetto unico" — altrimenti i nomi degli arti non
    avrebbero dove stare, ed e' esattamente cio' che fa la rotta HTTP.
    """
    app = compat.main_module()
    subject = str(subject or "").strip()
    if not subject:
        raise SessionError("serve una descrizione di cosa generare")

    return app.build_generate_prompt(
        subject,
        grid_size=_grid_token(grid),
        big_structure=big_structure,
        modular=modular,
        single_object=single_object,
        humanoid=humanoid)


def build_modify_prompt(request, current_model):
    """Il prompt di modifica: contesto compatto + modello attuale + richiesta.

    Il contesto (griglia, palette, ingombro) c'e' perche' la modifica e' un
    DIFF: senza sapere DOVE stanno le parti, l'AI riscrive il modello invece di
    ritoccarlo. Si ricava espandendo le ops con lo stesso `expand_ops` del
    resto dell'app, non ricontando i voxel a mano.
    """
    request = str(request or "").strip()
    if not request:
        raise SessionError("serve una descrizione della modifica")

    lines = []
    meta = current_model.get("metadata") if isinstance(current_model, dict) else None
    meta = meta if isinstance(meta, dict) else {}
    if meta.get("grid_size"):
        lines.append("Griglia (grid_size): %s" % (meta["grid_size"],))
    pal = current_model.get("palette") if isinstance(current_model, dict) else None
    if isinstance(pal, dict) and pal:
        lines.append("Palette attuale (chiave -> colore): "
                     + json.dumps(pal, ensure_ascii=False))
    try:
        expanded = compat.expand_ops(copy.deepcopy(current_model))
        vox = (expanded or {}).get("voxels") or []
    except Exception:                                        # noqa: BLE001
        vox = []
    if vox:
        xs = [v["x"] for v in vox]
        ys = [v["y"] for v in vox]
        zs = [v["z"] for v in vox]
        lines.append("Bounding box occupato: X[%d..%d] Y[%d..%d] Z[%d..%d] "
                     "(%d voxel totali)"
                     % (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs),
                        len(vox)))
    context = "\n".join(lines) if lines else "(nessun dato aggiuntivo)"

    template = compat.read_prompt("prompt-edit.txt", (
        "Sei un Voxel Artist AI esperto. Restituisci SOLO una patch JSON "
        "{ \"palette\": {...}, \"ops\": [...] } che modifica il modello.\n\n"
        "Contesto:\n[INSERISCI QUI IL CONTESTO]\n\n"
        "Modello attuale:\n[INSERISCI QUI IL MODELLO ATTUALE]\n\n"
        "Richiesta:\n[INSERISCI QUI LA RICHIESTA DI MODIFICA]"))
    out = template.replace("[INSERISCI QUI IL CONTESTO]", context)
    out = out.replace("[INSERISCI QUI IL MODELLO ATTUALE]",
                      json.dumps(current_model, separators=(',', ':')))
    return out.replace("[INSERISCI QUI LA RICHIESTA DI MODIFICA]", request)


def object_payload(doc, obj):
    """Il modello compatto di un oggetto, come lo manda la UI in modifica.

    Senza materiali di proposito: una texture in base64 costerebbe piu' del
    modello intero e all'AI non serve per spostare un braccio. Cio' che
    l'oggetto ha continua a esistere — non viene mandato, non viene chiesto
    indietro, e `overlay_ops` lo conserva sui voxel che l'AI non tocca.
    """
    payload = doc._object_payload(obj, materials=False)
    ops = payload.get("ops") or []
    if len(ops) > MODIFY_MAX_OPS:
        payload = dict(payload)
        payload["ops"] = ops[:MODIFY_MAX_OPS]
        payload["_troncato"] = ("modello troppo grande: mandate le prime %d ops "
                                "su %d" % (MODIFY_MAX_OPS, len(ops)))
    return payload


# --- scrittura nel documento --------------------------------------------------

def _op_name(op):
    if isinstance(op, (list, tuple)) and op:
        return str(op[0]).lower()
    if isinstance(op, str):
        return op.strip().split(" ", 1)[0].lower()
    return ""


def _cells_as_set_ops(obj):
    """Le celle attuali riscritte come ops `set`, una per colore.

    Serve a far applicare una patch DALL'ESPANSORE VERO invece che da una
    seconda implementazione: si antepongono queste ops a quelle della patch e
    si espande una volta sola. Cosi' `del` cancella davvero (toglie da cio' che
    c'era) e l'ordine di sovrascrittura e' quello canonico, senza che questo
    modulo sappia una riga di semantica delle ops. Una `applyOps` scritta qui
    sarebbe la TERZA semantica da tenere allineata alle altre due, e le prime
    due sono gia' costate tre difetti veri (`tests/ops_parity_cases.json`).
    """
    by_color = {}
    for (x, y, z), cell in obj.cells.items():
        by_color.setdefault(cell.color, []).extend((x, y, z))
    return [["set", color] + coords for color, coords in by_color.items()]


def overlay_ops(doc, obj, ops, palette=None, label="Ops AI", replace=False):
    """Applica ops compatte SOPRA l'oggetto (o al posto suo). Annullabile.

    Il colore che cambia porta via il MATERIALE di quel voxel ma non la sua
    PARTE. E' la stessa regola della UI, e ha una ragione: nel `voxelMap` il
    materiale *e'* il valore della cella (`@m1`), quindi dipingerci sopra un
    colore lo sostituisce per costruzione; la parte invece e' un'etichetta
    separata, e perderla scollegherebbe il voxel dal rig per una ritinteggiatura.
    """
    ops = list(ops or [])
    if not ops and not replace:
        return 0, 0
    payload = {
        "metadata": {"grid_size": list(obj.grid_size)},
        "palette": dict(palette or {}),
        "ops": (([] if replace else _cells_as_set_ops(obj)) + ops),
    }
    expanded = compat.expand_ops(payload)
    voxels = (expanded or {}).get("voxels") or []

    wanted = {}
    for v in voxels:
        try:
            key = (int(v["x"]), int(v["y"]), int(v["z"]))
        except (KeyError, TypeError, ValueError):
            continue
        wanted[key] = v.get("color") or "#CCCCCC"

    added = removed = 0
    with doc.edit(label, obj):
        for key in [k for k in obj.cells if k not in wanted]:
            if doc.del_cell(obj, key):
                removed += 1
        for key, color in wanted.items():
            old = obj.cells.get(key)
            if old is not None and old.color == color:
                continue                      # intatta: materiale e parte restano
            cell = Cell(color, None, old.part if old is not None else None)
            if doc.set_cell(obj, key, cell):
                added += 1
    return added, removed


def overlay_parts(doc, obj, parts, palette=None, label="Parti", replace=False):
    """Come `overlay_ops`, ma ogni voxel tiene il nome della parte.

    Serve a leve, pulsanti, pressure plate: senza l'etichetta l'export
    fonderebbe tutto in una mesh e i pezzi non si muoverebbero da soli.
    """
    parts = dict(parts or {})
    if not parts and not replace:
        return 0, 0
    payload = {
        "metadata": {"grid_size": list(obj.grid_size)},
        "palette": dict(palette or {}),
        "parts": parts,
    }
    expanded = compat.expand_ops(payload)
    voxels = (expanded or {}).get("voxels") or []

    wanted = {}
    for v in voxels:
        try:
            key = (int(v["x"]), int(v["y"]), int(v["z"]))
        except (KeyError, TypeError, ValueError):
            continue
        wanted[key] = (v.get("color") or "#CCCCCC", v.get("part") or None)

    added = removed = 0
    with doc.edit(label, obj):
        if replace:
            for key in [k for k in obj.cells if k not in wanted]:
                if doc.del_cell(obj, key):
                    removed += 1
        for key, (color, part) in wanted.items():
            old = obj.cells.get(key)
            if old is not None and old.color == color and old.part == part:
                continue
            material = None
            if old is not None and old.color == color:
                material = old.material
            keep_part = part if part is not None else (old.part if old else None)
            if doc.set_cell(obj, key, Cell(color, material, keep_part)):
                added += 1
    return added, removed


def looks_like_rewrite(patch_ops, current_count, palette, grid):
    """La patch e' in realta' un modello intero riscritto?

    L'AI, richiesta di una modifica, ogni tanto rimanda l'oggetto completo
    invece del diff. Sovrapporlo a cio' che c'e' produce un ibrido dei due —
    il vecchio modello che spunta da sotto il nuovo. Il segnale e': nessun
    `del` (un diff vero ne ha quasi sempre) e le sole ops della patch
    ricostruiscono un numero di voxel paragonabile all'attuale. E' l'euristica
    della UI, con la stessa soglia.
    """
    if not patch_ops or current_count <= 0:
        return False
    if any(_op_name(o) == "del" for o in patch_ops):
        return False
    try:
        produced = compat.expand_ops({
            "metadata": {"grid_size": list(grid)},
            "palette": dict(palette or {}),
            "ops": list(patch_ops),
        })
        n = len((produced or {}).get("voxels") or [])
    except Exception:                                        # noqa: BLE001
        return False
    return n >= current_count * 0.8


def load_model(doc, data, as_object=True, name=None, label="Generazione AI"):
    """Carica un modello generato (compatto, a parti o piatto) nel documento.

    Passa da `Document.from_payload`, cioe' dallo stesso codice con cui si apre
    un file: ops, `parts`, materiali e mappa dei materiali si comportano
    esattamente come li' invece che "quasi".

    UNA sola fotografia per l'intera importazione, presa qui e non da
    `add_object`: caricare un pack da otto oggetti costerebbe altrimenti otto
    annullamenti per un gesto solo. E' anche il motivo per cui gli oggetti si
    accodano a mano — `add_object` fotografa da se'.

    `label=None` NON fotografa: serve a chi ne sta gia' tenendo una piu' larga
    (l'importazione di un pack e' un gesto solo, non uno per asset).
    """
    tmp = Document.from_payload(copy.deepcopy(data), name="temporaneo")
    if label is not None:
        doc.snapshot(label)
    for mdef in tmp.materials:
        if mdef.get("id") and not doc.material_by_id(mdef["id"]):
            doc.materials.append(mdef)
    if not as_object:
        doc.objects = []
    elif len(doc.objects) == 1 and not len(doc.objects[0]):
        # Il segnaposto di un progetto appena creato: e' l'oggetto che `active`
        # fabbrica alla prima lettura, non qualcosa che l'utente ha disegnato.
        # Tenerlo lascerebbe accanto al modello un guscio vuoto e ne
        # rinominerebbe uno dei due ("Oggetto 1" + "Oggetto 1 2"). Un solo
        # oggetto e vuoto: se ce ne sono di piu' e' un'impalcatura voluta e non
        # si tocca. La fotografia e' gia' presa, quindi si annulla comunque.
        doc.objects = []
    added = []
    for obj in tmp.objects:
        if not len(obj) and len(tmp.objects) > 1:
            continue                          # un oggetto vuoto in piu' non serve
        obj.name = doc.unique_name(name or obj.name)
        doc.objects.append(obj)
        added.append(obj)
    if not doc.objects:
        doc.objects = tmp.objects
        added = list(tmp.objects)
    doc.active_index = len(doc.objects) - 1
    doc.dirty = True
    return added


# --- pack --------------------------------------------------------------------

def pack_manager():
    """La coda dei pack di `main.py`, non una riscritta qui.

    E' la stessa CLASSE con la stessa cartella di salvataggio della GUI, ma non
    la stessa istanza: `main.py` viene importato in QUESTO processo, quindi i
    worker sono thread nostri. La differenza si vede in due punti, e vale la
    pena saperla prima di descriverla a un utente: un pack ancora in corso qui
    non compare in `/api/pack/status` dell'app in esecuzione (sono due code in
    due processi), mentre un pack ARRIVATO IN FONDO si', perche' la persistenza
    passa dal disco. Le prove sostituiscono questa funzione con una coda che ha
    un generatore finto — che e' il motivo per cui e' una funzione e non una
    costante.
    """
    return compat.main_module().PACK_MANAGER


def pack_summary(run, verbose=False):
    d = run.to_dict()
    out = {
        "id": d["id"],
        "stato": d["status"],
        "totale": d["total"],
        "conteggi": d["counts"],
        "etaSecondi": d.get("etaSeconds"),
        "paletteBloccata": d.get("paletteLocked"),
    }
    if verbose:
        out["job"] = [{"id": j["id"], "oggetto": j["objectName"],
                       "variante": j["variant"], "stato": j["status"],
                       "errore": j["error"]} for j in d["jobs"]]
    else:
        errs = [j for j in d["jobs"] if j["status"] == "error"]
        if errs:
            out["errori"] = [{"oggetto": j["objectName"], "errore": j["error"]}
                             for j in errs[:8]]
    return out
