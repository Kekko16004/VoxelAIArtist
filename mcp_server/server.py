"""Server MCP di VoxelAIArtist: il programma intero, per un assistente.

Si avvia con `python -m mcp_server` e parla su stdio.

TRE SCELTE DI FONDO.

1. **Gli strumenti ritornano TESTO, non oggetti.** Un client MCP mostra la
   risposta a un modello linguistico, e un JSON di quattromila voxel non gli
   dice quanto una frase come "42 voxel, 3 colori, ingombro 7x7x5". Dove il dato
   strutturato serve davvero (elenchi, statistiche) si ritorna un JSON breve.
   Il modello non deve MAI ricevere l'elenco dei voxel: e' grande, inutile da
   leggere e lo si otterrebbe comunque solo per riscriverlo.

2. **Ogni modifica passa da `doc.edit(...)`**, cioe' finisce nella cronologia.
   Un assistente sbaglia, e la riparazione dev'essere `voxel_undo`, non "rifai
   il modello da capo". E' anche il motivo per cui gli strumenti di modifica
   sono a grana grossa (riempi una sfera) e non a grana fine (metti un voxel):
   mille chiamate per una sfera sarebbero mille voci di cronologia e mille
   passaggi di rete.

3. **Scrivere su disco e' l'unica cosa irreversibile qui**, quindi e' l'unica
   con un vincolo: si scrive solo dentro la cartella di lavoro dichiarata
   (`--workdir`, per difetto la cartella di esportazione dell'app). Un modello
   che sbaglia un percorso deve sbattere contro un errore, non sovrascrivere un
   file dell'utente da un'altra parte. Leggere non ha questo limite: aprire un
   file che l'utente ha nominato e' cio' che gli e' stato chiesto.
"""

import json
import os
import sys

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp.server.fastmcp import FastMCP                       # noqa: E402

from mcp_server import ai, compat, edits, exporters, importers  # noqa: E402
from mcp_server import materials, patch, pixelops, rig, textures  # noqa: E402
from mcp_server import png as pngmod, streamable             # noqa: E402
from mcp_server.document import Cell, Document, VoxelObject  # noqa: E402
from mcp_server.session import SESSION, SessionError         # noqa: E402

mcp = FastMCP("voxelai")


# NIENTE rotta POST su /sse. Nel trasporto SSE il client fa GET /sse per aprire
# lo stream e poi POSTA su /messages/?session_id=..., che e' l'indirizzo annunciato
# dall'evento `endpoint`: lo monta il trasporto del SDK. Una rotta POST /sse che
# ripiega su `Response(202)` e' peggio di non averla, perche' un 202 dice "preso
# in carico" a una richiesta che nessuno ha processato: il client resta ad
# aspettare una risposta che non arrivera' sullo stream, e il terminale non
# stampa niente perche' non c'e' stato nessun errore da stampare.


# La cartella di lavoro: si stabilisce all'avvio (vedi main()) e non cambia
# durante la sessione. Metterla in una variabile che uno strumento puo'
# riscrivere renderebbe il vincolo del punto 3 aggirabile dall'interno.
WORKDIR = os.getcwd()
UNRESTRICTED = False


def _resolve_out(path):
    raw = os.path.expanduser(str(path or "").strip())
    if not raw:
        raise SessionError("percorso vuoto")
    full = raw if os.path.isabs(raw) else os.path.join(WORKDIR, raw)
    full = os.path.realpath(full)
    root = os.path.realpath(WORKDIR)
    if not UNRESTRICTED and full != root and not full.startswith(root + os.sep):
        raise SessionError(
            "posso scrivere solo dentro la cartella di lavoro (%s): "
            "'%s' e' fuori" % (root, path))
    folder = os.path.dirname(full)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)
    return full



def _write(path, data):
    full = _resolve_out(path)
    mode = "wb" if isinstance(data, (bytes, bytearray)) else "w"
    kwargs = {} if "b" in mode else {"encoding": "utf-8"}
    with open(full, mode, **kwargs) as f:
        f.write(data)
    return full


# I due convertitori qui sotto esistono perche' lo SCHEMA e il CORPO hanno due
# pubblici diversi. Lo schema dichiara `float` / `bool` perche' e' quello che il
# modello legge per decidere cosa scrivere: dichiarare `string` gli fa mandare
# "1.0", e un client che valida gli argomenti PRIMA di spedirli (Kilo Code lo fa)
# rifiuta `1.0` da solo — l'errore compare nel pannello e il server non vede mai
# la richiesta, quindi il terminale resta muto. Ma alcuni client mandano ogni
# cosa come testo, e li' un `float` dichiarato non basta: percio' il corpo
# accetta comunque la stringa. Dichiarare stretto e accettare largo copre
# entrambi; il contrario non copre nessuno dei due.
def _as_float(v, default=0.0):
    if isinstance(v, bool) or v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        raise SessionError("mi aspettavo un numero, ho ricevuto %r" % (v,))


def _as_bool(v, default=False):
    if v is None or v == "":
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    return str(v).strip().lower() in ("true", "1", "yes", "y", "t", "si", "sì", "on")


def _describe(doc, obj):
    b = obj.bounds()
    size = obj.size() if b else (0, 0, 0)
    return ("'%s' in '%s': %d voxel, %d colori, ingombro %dx%dx%d"
            % (obj.name, SESSION.name_of(doc), len(obj), len(obj.color_counts()),
               size[0], size[1], size[2]))


def _keys_from_shape(shape, args, obj):
    """Traduce una forma nominata nell'insieme di celle che occupa."""
    fn = edits.SHAPES.get(str(shape or "").lower())
    if fn is None:
        raise SessionError("forma sconosciuta: '%s'. Disponibili: %s"
                           % (shape, ", ".join(sorted(edits.SHAPES))))
    try:
        return fn(**args)
    except TypeError as e:
        raise SessionError("argomenti sbagliati per la forma '%s': %s"
                           % (shape, e))


# --- documenti ---------------------------------------------------------------

@mcp.tool()
def voxel_new(name: str = "", grid: int = 32) -> str:
    """Crea un progetto voxel vuoto e lo rende quello corrente.

    `grid` e' la dimensione suggerita della griglia (non un vincolo rigido:
    i voxel possono stare ovunque, serve a generazione ed esportazione).
    """
    key = SESSION.new(name or None)
    doc = SESSION.get(key)
    # La griglia sta sull'OGGETTO, non sul documento: e' li' che la mettono
    # `VoxelObject`, il salvataggio e `from_payload`. Scriverla sul documento
    # creava un attributo che esiste solo sui progetti nuovi, quindi
    # `voxel_info` sollevava su qualunque progetto RIAPERTO da disco.
    #
    # Si passa da `doc.active` e non da `doc.objects`: un documento nuovo ha la
    # lista VUOTA e il primo oggetto lo crea la proprieta' `active` alla prima
    # lettura. Ciclare sulla lista non toccherebbe niente, in silenzio.
    g = max(2, int(grid))
    doc.active.grid_size = [g, g, g]
    return "Creato il progetto '%s' (griglia %d)." % (key, g)


@mcp.tool()
def voxel_open(path: str, name: str = "") -> str:
    """Apre un progetto .voxai o .json e lo rende quello corrente.

    Per i formati di altri programmi (.vox, .obj, .glb, .png) usa
    `voxel_import`: aprire rimpiazza, importare aggiunge.
    """
    key = SESSION.open_path(path, name or None)
    doc = SESSION.get(key)
    return ("Aperto '%s': %d oggetti, %d voxel in totale."
            % (key, len(doc.objects), sum(len(o) for o in doc.objects)))


@mcp.tool()
def voxel_save(path: str = "", document: str = "") -> str:
    """Salva il progetto come .voxai. Senza `path` riusa quello di apertura."""
    doc = SESSION.get(document or None)
    target = _resolve_out(path) if path else None
    saved = SESSION.save_path(doc, target)
    return "Salvato in %s." % saved


@mcp.tool()
def voxel_list() -> str:
    """Elenca i progetti aperti, i loro oggetti e le dimensioni."""
    if not SESSION.docs:
        return "Nessun progetto aperto."
    out = []
    for key in sorted(SESSION.docs):
        doc = SESSION.docs[key]
        mark = " (corrente)" if key == SESSION.current else ""
        objs = ", ".join("%s[%d]" % (o.name, len(o)) for o in doc.objects)
        out.append("%s%s: %s" % (key, mark, objs or "(vuoto)"))
    return "\n".join(out)


@mcp.tool()
def voxel_use(document: str) -> str:
    """Rende corrente un progetto gia' aperto."""
    doc = SESSION.use(document)
    return "Progetto corrente: '%s'." % SESSION.name_of(doc)


@mcp.tool()
def voxel_close(document: str = "") -> str:
    """Chiude un progetto SENZA salvarlo."""
    return "Chiuso '%s'." % SESSION.close(document or None)


@mcp.tool()
def voxel_info(document: str = "", obj: str = "") -> str:
    """Statistiche di un oggetto: voxel, colori, ingombro, parti, materiali."""
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    counts = o.color_counts()
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:12]
    b = o.bounds()
    return json.dumps({
        "documento": SESSION.name_of(doc),
        "oggetto": o.name,
        "voxel": len(o),
        "ingombro": list(o.size()) if b else [0, 0, 0],
        "bounds": list(b) if b else None,
        "colori": len(counts),
        "principali": [{"colore": c, "voxel": n} for c, n in top],
        "parti": sorted(o.parts()),
        "materiali": [m.get("id") for m in doc.materials],
        "griglia": list(o.grid_size),
    }, ensure_ascii=False, indent=1)


@mcp.tool()
def voxel_preview(document: str = "", obj: str = "", view: str = "front",
                  width: int = 48) -> str:
    """Anteprima ASCII di un oggetto, per capire com'e' fatto senza esportare.

    Viste: front, back, left, right, top, bottom. E' volutamente testuale: un
    PNG costerebbe molti token e per giudicare una silhouette bastano i
    caratteri.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    if not len(o):
        return "L'oggetto '%s' e' vuoto." % o.name
    return exporters.ascii_preview(o, view=view, width=max(8, int(width)))


@mcp.tool()
def voxel_undo(document: str = "", steps: int = 1) -> str:
    """Annulla le ultime modifiche."""
    doc = SESSION.get(document or None)
    done = []
    for _ in range(max(1, int(steps))):
        label = doc.undo()
        if not label:
            break
        done.append(label)
    if not done:
        return "Niente da annullare."
    return "Annullato: %s." % ", ".join(done)


@mcp.tool()
def voxel_redo(document: str = "", steps: int = 1) -> str:
    """Rifa' le modifiche annullate."""
    doc = SESSION.get(document or None)
    done = []
    for _ in range(max(1, int(steps))):
        label = doc.redo()
        if not label:
            break
        done.append(label)
    if not done:
        return "Niente da rifare."
    return "Rifatto: %s." % ", ".join(done)


@mcp.tool()
def voxel_history(document: str = "") -> str:
    """La cronologia delle modifiche del progetto."""
    doc = SESSION.get(document or None)
    h = doc.history()
    return json.dumps(h, ensure_ascii=False, indent=1) if h else "Cronologia vuota."


# --- oggetti -----------------------------------------------------------------

@mcp.tool()
def voxel_object_add(name: str = "", document: str = "") -> str:
    """Aggiunge un oggetto vuoto al progetto e lo rende attivo."""
    doc = SESSION.get(document or None)
    o = VoxelObject(doc.unique_name(name or "Oggetto"))
    # La griglia si eredita dall'oggetto attivo, non dal valore predefinito:
    # `symmetry` specchia rispetto al CENTRO della griglia, quindi un oggetto
    # nuovo con una griglia diversa dagli altri specchierebbe altrove — e la
    # differenza si vede solo dopo, come un pezzo fuori posto.
    if doc.objects:
        o.grid_size = list(doc.active.grid_size)
    # `add_object` fotografa gia' da se': una seconda fotografia qui
    # richiederebbe due annullamenti per un solo gesto.
    doc.add_object(o)
    return "Aggiunto l'oggetto '%s' (attivo)." % o.name


@mcp.tool()
def voxel_object_remove(obj: str, document: str = "") -> str:
    """Rimuove un oggetto dal progetto."""
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj)
    doc.remove_object(o)          # fotografa gia' da se'
    return "Rimosso l'oggetto '%s'." % o.name


@mcp.tool()
def voxel_object_rename(name: str, obj: str = "", document: str = "") -> str:
    """Rinomina un oggetto."""
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    old = o.name
    # Questa invece non passa da un metodo che fotografa: la rinomina tocca il
    # documento direttamente, quindi la fotografia va presa qui — e PRIMA, che
    # `snapshot` registra lo stato a cui tornare.
    doc.snapshot("Rinomina oggetto")
    o.name = doc.unique_name(name)
    return "'%s' si chiama ora '%s'." % (old, o.name)


# --- modifica ----------------------------------------------------------------

@mcp.tool()
def voxel_fill(shape: str, args: dict, color: str = "#CCCCCC",
               material: str = "", part: str = "", symmetry: str = "",
               obj: str = "", document: str = "") -> str:
    """Riempie una forma di voxel. E' lo strumento principale per costruire.

    Forme e argomenti:
      box       x0,y0,z0,x1,y1,z1, hollow=false, thickness=1
      sphere    cx,cy,cz,radius, hollow=false, thickness=1
      cylinder  cx,cy,cz,radius,height, axis='y', hollow=false
      cone      cx,cy,cz,radius,height, axis='y', invert=false
      line      x0,y0,z0,x1,y1,z1
      plane     axis,level,a0,b0,a1,b1

    `symmetry` ('x','y','z') specchia il tratto rispetto al centro della
    griglia: e' il modo di costruire qualcosa di simmetrico senza scriverne due
    volte le coordinate.

    `material` e' l'id (o il nome) di un materiale del progetto: il voxel prende
    la texture, e il colore diventa la sua tinta media a meno che tu non ne
    imponga uno.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    keys = _keys_from_shape(shape, args or {}, o)
    mid = None
    if material:
        # Un id inesistente NON degrada in silenzio: `edits.paint` lo scriverebbe
        # sulla cella, e un materiale orfano si vede come tinta unita grigia —
        # cioe' come "la texture non si e' caricata", che e' il difetto piu'
        # difficile da ricondurre a un id sbagliato. Meglio un errore che dice
        # quali materiali esistono.
        mat = textures.material_ref(doc, material)
        mid = mat["id"]
        if not color or color == "#CCCCCC":
            color = mat["color"]
    n = edits.paint(doc, o, keys, color=color or None,
                    material=mid, part=part or None,
                    symmetry=symmetry or None)
    return "Riempita la forma %s: %d voxel. %s" % (shape, n, _describe(doc, o))


@mcp.tool()
def voxel_erase(shape: str, args: dict, symmetry: str = "", obj: str = "",
                document: str = "") -> str:
    """Cancella i voxel dentro una forma (stesse forme di voxel_fill)."""
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    keys = _keys_from_shape(shape, args or {}, o)
    n = edits.erase(doc, o, keys, symmetry=symmetry or None)
    return "Cancellati %d voxel. %s" % (n, _describe(doc, o))


@mcp.tool()
def voxel_set(cells: list, obj: str = "", document: str = "") -> str:
    """Mette voxel singoli: `cells` e' una lista [x, y, z, "#RRGGBB"].

    Per volumi grandi usa `voxel_fill`: e' piu' corto da scrivere, piu' veloce e
    lascia una sola voce in cronologia.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    n = 0
    with doc.edit("Voxel singoli", o):
        for c in cells or []:
            if len(c) < 3:
                continue
            key = (int(c[0]), int(c[1]), int(c[2]))
            color = c[3] if len(c) > 3 else "#CCCCCC"
            doc.set_cell(o, key, Cell(color))
            n += 1
    return "Messi %d voxel. %s" % (n, _describe(doc, o))


@mcp.tool()
def voxel_transform(action: str, obj: str = "", document: str = "",
                    dx: int = 0, dy: int = 0, dz: int = 0,
                    axis: str = "y", steps: int = 1, factor: float = 1.0,
                    keep_shell: int = 1) -> str:
    """Trasforma un oggetto intero.

    `action`: move (dx,dy,dz) | rotate (axis,steps di 90 gradi) |
              scale (factor) | ground (poggia a y=0) | hollow (svuota,
              keep_shell = spessore del guscio)
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    act = str(action or "").lower()
    if act in ("move", "translate", "sposta"):
        edits.translate(doc, o, int(dx), int(dy), int(dz))
    elif act in ("rotate", "ruota"):
        edits.rotate(doc, o, axis=axis, steps=int(steps))
    elif act in ("scale", "scala"):
        edits.scale(doc, o, float(factor))
    elif act in ("ground", "poggia"):
        edits.center_on_ground(doc, o)
    elif act in ("hollow", "svuota"):
        edits.hollow(doc, o, keep_shell=int(keep_shell))
    else:
        raise SessionError(
            "azione sconosciuta: '%s'. Usa move, rotate, scale, ground, hollow"
            % action)
    return "%s applicato. %s" % (act, _describe(doc, o))


@mcp.tool()
def voxel_recolor(src: str, dst: str, tolerance: int = 0, obj: str = "",
                  document: str = "") -> str:
    """Sostituisce un colore con un altro, con tolleranza opzionale."""
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    n = edits.replace_color(doc, o, src, dst, tolerance=int(tolerance))
    return "Ricolorati %d voxel da %s a %s." % (n, src, dst)


@mcp.tool()
def voxel_shade(top: float = 1.12, bottom: float = 0.82, obj: str = "",
                document: str = "") -> str:
    """Sfuma i colori dall'alto in basso: da' volume a un modello piatto."""
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    n = edits.shade_by_height(doc, o, top=float(top), bottom=float(bottom))
    return "Sfumati %d voxel." % n


# --- generazione AI ----------------------------------------------------------

@mcp.tool()
def voxel_ai_status() -> str:
    """Chi genera i modelli adesso: provider attivo, tipo, se e' autenticato.

    Da guardare PRIMA di `voxel_generate` se non si e' sicuri: senza
    credenziali quello fallisce, mentre `voxel_ops` funziona sempre perche' le
    ops le scrivi tu.

    Non mostra mai una chiave ne' un cookie, solo se ci sono.
    """
    return json.dumps(ai.provider_status(), ensure_ascii=False, indent=1)


@mcp.tool()
def voxel_ops(ops: list = None, palette: dict = None, obj: str = "",
              document: str = "", replace: bool = False,
              label: str = "", parts: dict = None) -> str:
    """Costruisci tu il modello, con le ops compatte. NESSUNA AI esterna.

    E' la via piu' diretta: sei tu il modello che disegna, e queste sono le
    stesse ops che l'app usa per salvare e che l'AI integrata produce. Nessun
    cookie, nessuna chiave, nessuna attesa. Ed e' anche la piu' precisa, perche'
    puoi correggere una op alla volta invece di rigenerare tutto.

    Due forme, a scelta:

    1. `ops` — un solo blocco, UNA mesh in export. Ogni op e' una lista;
       il colore e' una chiave di `palette` oppure `#RRGGBB`:

         ["fill", x0,y0,z0, x1,y1,z1, colore]   scatola piena
         ["box",  x0,y0,z0, x1,y1,z1, colore]   scatola vuota (solo il guscio)
         ["line", x0,y0,z0, x1,y1,z1, colore]   segmento 3D
         ["rect", asse, livello, a0,b0, a1,b1, colore]   piano ("x"/"y"/"z")
         ["set",  colore, x,y,z, x,y,z, ...]    voxel sparsi dello stesso colore
         ["del",  x0,y0,z0, x1,y1,z1]           scava (toglie)

    2. `parts` — {nome: [ops, ...]}. Ogni chiave e' un pezzo (es. "base",
       "leva", "plate") e diventa una MESH SEPARATA in `.glb`/`.obj`.
       Obbligatorio per leve, pulsanti, pressure plate, coperchi, ruote:
       senza, Unity/Blender vedono un blocco solo e non si anima niente.

    Y e' l'ALTEZZA e il modello poggia su y=0. Per difetto le ops si
    SOVRAPPONGONO a cio' che c'e' gia' (`del` scava davvero nel modello
    esistente); con `replace=True` sostituiscono tutto l'oggetto.

    Un voxel che cambia colore perde il materiale ma non la parte del rig.
    Se passi sia `parts` che `ops`, vince `parts`.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    if parts:
        added, removed = ai.overlay_parts(
            doc, o, parts, palette=palette,
            label=label or "Parti", replace=bool(replace))
    else:
        added, removed = ai.overlay_ops(
            doc, o, ops or [], palette=palette,
            label=label or "Ops", replace=bool(replace))
    named = sorted(o.parts())
    extra = (" Parti: %s." % ", ".join(named)) if named else ""
    return "%s (+%d, -%d).%s" % (_describe(doc, o), added, removed, extra)


@mcp.tool()
def voxel_generate(prompt: str, document: str = "", grid: int = 0,
                   humanoid: bool = False, big_structure: bool = False,
                   modular: bool = False, multi_part: bool = False,
                   as_object: bool = True, name: str = "",
                   model: str = "", provider: str = "") -> str:
    """Genera un modello con l'AI INTEGRATA (cookie o chiave configurati).

    Usa gli stessi prompt del pulsante "Crea" dell'app, quindi da' gli stessi
    risultati. Se preferisci disegnare tu, `voxel_ops` non richiede credenziali.

    MESH UNICA o PEZZI SEPARATI (scegli, non e' automatico):
    - `multi_part=false` (default): UN oggetto, UNA mesh in export. Va bene
      per statue, casse, muri, alberi — cose che non si muovono a pezzi.
    - `multi_part=true`: l'AI scrive `parts` (base, leva, plate, ...).
      In `.glb`/`.obj` ogni parte e' una mesh a se'. OBBLIGATORIO per
      pressure plate, leve, pulsanti, porte, coperchi, ruote: senza, Unity
      importa un blocco solo e i pezzi non si animano.
    - `humanoid`: come `multi_part`, ma con i nomi degli arti per il rig
      (testa, braccio_R, gamba_L, ...).

    Altri flag:
    - `big_structure`: edifici/scenari che devono riempire tutta la griglia,
      con interni, tetti e scale invece di un blocco pieno.
    - `modular`: pezzo di un set che deve incastrarsi con altri.
    - `as_object=False`: sostituisce il progetto invece di aggiungere un oggetto.
    """
    doc = SESSION.get(document or None)
    final = ai.build_generate_prompt(
        prompt, grid=grid, big_structure=bool(big_structure),
        modular=bool(modular), single_object=not bool(multi_part),
        humanoid=bool(humanoid))
    data = ai.ask_json(final, model=model or None, provider=provider or None)
    added = ai.load_model(doc, data, as_object=bool(as_object),
                          name=name or None,
                          label="Genera: %s" % prompt[:40])
    parts = sorted({p for o in added for p in o.parts()})
    is_humanoid = bool(humanoid) or any(
        p.lower().strip() in ("testa", "head", "torso", "bacino", "braccio_r", "braccio_l", "gamba_r", "gamba_l")
        for p in parts
    )
    if is_humanoid:
        for o in added:
            try:
                rig.auto_rig(o, "humanoid")
            except Exception:
                pass
    out = "Generato: " + ", ".join(_describe(doc, o) for o in added)
    if parts:
        out += "\nParti nominate: %s." % ", ".join(parts)
    if is_humanoid and any(o.rig for o in added):
        out += "\nAuto-rig applicato con successo."
    return out


@mcp.tool()
def voxel_modify(request: str, obj: str = "", document: str = "",
                 model: str = "", provider: str = "") -> str:
    """Chiede all'AI integrata di MODIFICARE l'oggetto corrente.

    L'AI riceve il modello attuale e risponde con una patch, non con un modello
    nuovo: "aggiungi una finestra sul lato sud" tocca solo quella zona. Se pero'
    risponde con l'oggetto intero (capita), la patch viene applicata come
    sostituzione invece di sovrapporsi al vecchio — altrimenti si vedrebbero i
    due modelli uno dentro l'altro.

    E' annullabile con `voxel_undo` come qualunque altra modifica.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    if not len(o):
        raise SessionError(
            "l'oggetto '%s' e' vuoto: non c'e' niente da modificare. Usa "
            "`voxel_generate` o `voxel_ops` per crearlo." % o.name)
    payload = ai.object_payload(doc, o)
    data = ai.ask_json(ai.build_modify_prompt(request, payload),
                       model=model or None, provider=provider or None)
    ops = data.get("ops") or []
    palette = data.get("palette") if isinstance(data.get("palette"), dict) else {}
    if not ops and not data.get("parts") and not data.get("voxels"):
        raise SessionError("l'AI non ha restituito nessuna modifica.")
    if not ops:
        # Ha rimandato parti o voxel piatti: e' un modello, non una patch.
        added = ai.load_model(doc, data, as_object=False, name=o.name,
                              label="Modifica: %s" % request[:40])
        return "Riscritto: " + ", ".join(_describe(doc, x) for x in added)
    rewrite = ai.looks_like_rewrite(ops, len(o), palette, o.grid_size)
    added, removed = ai.overlay_ops(doc, o, ops, palette=palette,
                                    label="Modifica: %s" % request[:40],
                                    replace=rewrite)
    note = " (riscrittura completa)" if rewrite else ""
    return "%s (+%d, -%d)%s." % (_describe(doc, o), added, removed, note)


@mcp.tool()
def voxel_pack_start(objects: list, variants: int = 1, grid: int = 0,
                     modular: bool = False, notes: str = "",
                     model: str = "") -> str:
    """Mette in coda un PACK: piu' oggetti, con lo stesso stile fra loro.

    Serve a fare un set coerente ("tavolo, sedia, armadio, lampada") invece di
    quattro modelli scollegati: la palette del primo asset riuscito vincola
    tutti gli altri, e viene applicata sul risultato, non solo chiesta nel
    prompt.

    Gira in thread di QUESTO processo e non aspetta: la coda va avanti fra una
    chiamata e l'altra, e continua anche se la conversazione finisce, ma muore
    con il server MCP (i worker sono thread daemon). Controlla con
    `voxel_pack_status` e prendi i modelli con `voxel_pack_result`. Un pack
    ARRIVATO IN FONDO viene salvato su disco nella stessa cartella dell'app,
    quindi quello lo rivedi anche dalla GUI e dopo un riavvio.

    Un nome puo' dichiarare la taglia relativa: "Armadio :grande".
    """
    opts = {"model": model or None, "modular": bool(modular),
            "notes": notes or None}
    if grid:
        opts["grid_size"] = ai.grid_token(grid)
    try:
        run = ai.pack_manager().create_run(list(objects or []), int(variants or 1),
                                           references=None, options=opts)
    except ValueError as e:
        raise SessionError(str(e))
    return ("Pack '%s' avviato: %d generazioni in coda. Controlla con "
            "`voxel_pack_status`." % (run.id, len(run.jobs)))


@mcp.tool()
def voxel_pack_status(run: str = "", verbose: bool = False) -> str:
    """Stato di un pack in corso. Senza `run` guarda l'ultimo avviato."""
    r = ai.pack_manager().get(run) if run else ai.pack_manager().latest()
    if r is None:
        return "Nessun pack avviato."
    return json.dumps(ai.pack_summary(r, verbose=bool(verbose)),
                      ensure_ascii=False, indent=1)


@mcp.tool()
def voxel_pack_result(run: str = "", document: str = "", job: str = "") -> str:
    """Porta i modelli di un pack finito nel progetto corrente.

    Entrano come oggetti separati, tutti in una sola voce di cronologia: un
    `voxel_undo` toglie l'intero pack, che e' il gesto che hai fatto.
    I job ancora in coda o falliti vengono saltati (li rimetti in coda con
    `voxel_pack_cancel(retry=True)`).
    """
    r = ai.pack_manager().get(run) if run else ai.pack_manager().latest()
    if r is None:
        return "Nessun pack da importare."
    doc = SESSION.get(document or None)
    jobs = [j for j in r.jobs if j.status == "done" and j.result]
    if job:
        jobs = [j for j in jobs if j.id == job or j.label == job]
    if not jobs:
        return ("Nessun asset pronto nel pack '%s' (stato: %s)."
                % (r.id, r.status))
    # Una fotografia sola per tutto il pack: si annulla come un gesto solo.
    doc.snapshot("Importa pack %s" % r.id)
    names = []
    for j in jobs:
        for o in ai.load_model(doc, j.result, as_object=True, name=j.label,
                               label=None):
            names.append("%s[%d]" % (o.name, len(o)))
    return "Importati dal pack '%s': %s." % (r.id, ", ".join(names))


@mcp.tool()
def voxel_pack_cancel(run: str = "", retry: bool = False) -> str:
    """Annulla un pack in corso, o (con `retry`) rimette in coda i falliti."""
    mgr = ai.pack_manager()
    r = mgr.get(run) if run else mgr.latest()
    if r is None:
        return "Nessun pack da fermare."
    if retry:
        mgr.retry(r.id, None)
        return "Rimessi in coda i job falliti del pack '%s'." % r.id
    mgr.cancel(r.id)
    return ("Pack '%s' annullato (il job gia' in volo si conclude da se')."
            % r.id)


# --- materiali e texture ------------------------------------------------------

@mcp.tool()
def voxel_material_list(document: str = "", detail: str = "") -> str:
    """I materiali del progetto. Con `detail` (id o nome) mostra anche il disegno.

    La texture in base64 NON entra mai in una risposta: una 128x128 sono decine
    di kilobyte per materiale, e venti materiali sfonderebbero da soli la
    finestra di contesto. Per VEDERE i pixel c'e' `voxel_texture_show`, che li
    manda come testo.
    """
    doc = SESSION.get(document or None)
    if detail:
        mat = textures.material_ref(doc, detail)
        return json.dumps(materials.summarize(mat), ensure_ascii=False, indent=1)
    if not doc.materials:
        return ("Nessun materiale in '%s'. Creane uno con "
                "`voxel_material_create`." % SESSION.name_of(doc))
    used = {}
    for o in doc.objects:
        for cell in o.cells.values():
            if cell.material:
                used[cell.material] = used.get(cell.material, 0) + 1
    rows = []
    for m in doc.materials:
        s = materials.summarize(m)
        s["voxel"] = used.get(m.get("id"), 0)
        rows.append(s)
    return json.dumps(rows, ensure_ascii=False, indent=1)


@mcp.tool()
def voxel_material_create(name: str = "", color: str = "", size: int = 16,
                          ops: list = None, palette: dict = None,
                          faces: dict = None, png: str = "",
                          props: dict = None, document: str = "") -> str:
    """Crea un materiale (un "blocco"): tinta unita, ops di pixel art, o un PNG.

    Tre sorgenti, in ordine di precedenza:
      - `faces`: {"py": [ops...], "px": [ops...]} -> materiale a SEI facce.
      - `ops`: una lista di ops 2D -> texture unica.
      - `png`: un file PNG dalla cartella di lavoro -> texture unica.
      - niente: tinta unita `color`.

    Le ops 2D sono le stesse del formato del progetto (origine in ALTO A
    SINISTRA, come un'immagine):
      fill x0 y0 x1 y1 col | rect x0 y0 x1 y1 col | line x0 y0 x1 y1 col
      set col x y x y ... | del x0 y0 x1 y1 | mirror x|y | noise col n seed
    Un colore puo' essere `-` per TRASPARENTE. `palette` mappa chiavi corte
    ("k": "#101014") cosi' le ops restano brevi.

    `props` regola l'aspetto: roughness, metalness, emissive, opacity, e
    `uv` {repeat, offsetU, offsetV, rotation}. Il `color` del materiale viene
    riallineato da se' alla tinta media della texture.
    """
    doc = SESSION.get(document or None)
    side = textures.side(size)
    definition = dict(props or {})
    definition["name"] = name or "Materiale"
    if color:
        definition["color"] = color

    built = None
    if faces:
        built = textures.faces_from_ops({"palette": palette or {}, "faces": faces},
                                        size=side, force=True)
        if not built["faces"]:
            raise SessionError(
                "nessuna faccia disegnata: le ops non hanno dipinto niente.%s"
                % (" Avvisi: " + ", ".join(built["warnings"][:4])
                   if built["warnings"] else ""))
        definition["faceMode"] = "six"
        definition["faces"] = built["faces"]
    elif ops:
        built = textures.faces_from_ops({"palette": palette or {},
                                         "faces": {textures.ALL_KEY: ops}},
                                        size=side, force=True)
        tex = built["faces"].get(textures.ALL_KEY)
        if tex is None:
            raise SessionError(
                "le ops non hanno dipinto niente.%s"
                % (" Avvisi: " + ", ".join(built["warnings"][:4])
                   if built["warnings"] else ""))
        definition["texture"] = tex
    elif png:
        definition["texture"] = _texture_from_png(png, side)

    mid = doc.next_material_id()
    mat = materials.normalize_material(definition, mid)
    doc.snapshot("Materiale nuovo")
    doc.materials.append(mat)
    textures.sync_material_color(doc, mat)
    doc.dirty = True
    msg = "Creato il materiale '%s' (%s), tinta media %s." % (
        mat["name"], mid, mat["color"])
    if built and built["warnings"]:
        msg += " Avvisi: " + ", ".join(built["warnings"][:4]) + "."
    if built and built["skipped"]:
        msg += " Facce scartate: " + ", ".join(built["skipped"]) + "."
    return msg + "\nApplicalo con `voxel_material_apply` o passa material='%s' a `voxel_fill`." % mid


def _texture_from_png(path, side=None):
    """Un PNG dal disco -> texture di materiale, ridimensionata se serve.

    Il tetto (`materials.TEXTURE_MAX`) si applica qui e non a valle: una foto da
    4000 pixel diventerebbe un data URL da megabyte dentro il progetto, e la
    pixel art non ci guadagna niente.
    """
    full = _resolve_out(path)
    with open(full, "rb") as f:
        buf, w, h = pngmod.decode_png(f.read())
    top = materials.TEXTURE_MAX
    tw = min(top, int(side) if side else w)
    if side:
        th = tw
    else:
        th = min(top, h)
        tw = min(top, w)
    if (tw, th) != (w, h):
        buf = pngmod.scale_nearest(buf, w, h, tw, th)
    return materials.texture_from_buffer(buf, tw, th)


@mcp.tool()
def voxel_material_update(material: str = "", name: str = "", color: str = "",
                          props: dict = None, document: str = "") -> str:
    """Cambia nome, colore o aspetto di un materiale esistente.

    `props` e' un dizionario (roughness, metalness, emissive, opacity, uv):
    non sono parametri separati perche' 0.0 e' un valore VOLUTO e non si
    distinguerebbe da "non specificato". Chi non appare resta com'era.

    Il materiale si modifica IN PLACE: i voxel che citano il suo id continuano a
    citarlo, e la lista non cresce.
    """
    doc = SESSION.get(document or None)
    mat = textures.material_ref(doc, material)
    merged = dict(mat)
    if name:
        merged["name"] = name
    if color:
        merged["color"] = color
    for key, value in (props or {}).items():
        merged[key] = value
    fresh = materials.normalize_material(merged, mat.get("id"))
    doc.snapshot("Materiale modificato")
    mat.clear()
    mat.update(fresh)
    touched = textures.sync_material_color(doc, mat)
    doc.dirty = True
    return ("Materiale '%s' (%s) aggiornato: tinta %s, opacita' %.2f, "
            "resa '%s'.%s"
            % (mat["name"], mat["id"], mat["color"], mat["opacity"],
               materials.material_render_mode(mat)[0],
               " Riallineati %d voxel." % touched if touched else ""))


@mcp.tool()
def voxel_material_delete(material: str, document: str = "") -> str:
    """Elimina un materiale. I voxel che lo usavano restano, a tinta unita.

    Non si cancellano i voxel: perderebbero una forma che l'utente ha costruito
    per una decisione che riguarda solo il loro aspetto. Tengono il colore
    (la tinta media che portavano gia'), quindi il modello resta identico a come
    si vedeva da lontano.
    """
    doc = SESSION.get(document or None)
    mat = textures.material_ref(doc, material)
    mid = mat.get("id")
    doc.snapshot("Materiale eliminato")
    doc.materials = [m for m in doc.materials if m.get("id") != mid]
    freed = 0
    for o in doc.objects:
        for key, cell in list(o.cells.items()):
            if cell.material == mid:
                doc.set_cell(o, key, cell.with_material(None))
                freed += 1
    doc.dirty = True
    return ("Eliminato il materiale '%s' (%s). %d voxel restano a tinta unita."
            % (mat.get("name"), mid, freed))


@mcp.tool()
def voxel_material_apply(material: str, color: str = "", part: str = "",
                         region: list = None, invert: bool = False,
                         obj: str = "", document: str = "") -> str:
    """Applica un materiale ai voxel scelti: per colore, per parte, per regione.

    Senza criteri prende TUTTI i voxel dell'oggetto. `region` e'
    [x0,y0,z0,x1,y1,z1]; `invert` prende il complemento della selezione.

    Scrive DUE cose su ogni voxel, l'id del materiale e la sua tinta media:
    ogni percorso che pretende un hex (.vox, .schem, l'MTL senza PNG) funziona
    senza sapere che i materiali esistono, e un id orfano degrada da se' a tinta
    unita invece di dare un modello grigio.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    mat = textures.material_ref(doc, material)
    keys = edits.select(o, color=color or None, part=part or None,
                        region=region or None, invert=bool(invert))
    if not keys:
        raise SessionError(
            "nessun voxel corrisponde ai criteri (l'oggetto ne ha %d). "
            "Controlla colore e parte con `voxel_info`." % len(o))
    n = edits.paint(doc, o, keys, color=mat["color"], material=mat["id"],
                    only_existing=True)
    return ("Applicato '%s' (%s) a %d voxel di '%s', tinta %s."
            % (mat["name"], mat["id"], n, o.name, mat["color"]))


@mcp.tool()
def voxel_texture_draw(ops: list, material: str = "", face: str = "all",
                       palette: dict = None, size: int = 16,
                       clear: bool = False, document: str = "") -> str:
    """Disegna ops di pixel art SOPRA la texture di una faccia. Sei tu a scrivere
    le ops: nessuna AI esterna, nessun cookie, nessuna quota.

    `face`: `all` (texture unica) oppure px, nx, py, ny, pz, nz — e anche i nomi
    italiani (destra, sinistra, sopra, sotto, davanti, dietro).
    `clear` riparte da una tela vuota invece di ritoccare quella che c'e'.

    Le ops si applicano in ordine sul disegno ESISTENTE, quindi `del` cancella
    davvero cio' che c'e' sotto: e' cosi' che si corregge un dettaglio senza
    ridisegnare la faccia. Guarda il risultato con `voxel_texture_show`.
    """
    doc = SESSION.get(document or None)
    mat = textures.material_ref(doc, material)
    key = textures.face_key(face)
    if not key:
        raise SessionError("faccia sconosciuta: '%s'. Usa all, px, nx, py, ny, "
                           "pz, nz." % face)
    if clear:
        w = textures.side(size)
        buf, h = bytearray(w * w * 4), w
    else:
        buf, w, h = textures.buffer_of(mat, key, size)
    n, warnings = textures.draw_ops_on(buf, w, h, ops, palette)
    if not n:
        raise SessionError(
            "nessuna op ha dipinto qualcosa.%s\nControlla le coordinate (0..%d, "
            "origine in alto a sinistra) e i colori."
            % (" Avvisi: " + ", ".join(sorted(set(warnings))[:4])
               if warnings else "", w - 1))
    doc.snapshot("Texture disegnata")
    textures.set_face(mat, key, materials.texture_from_buffer(buf, w, h))
    touched = textures.sync_material_color(doc, mat)
    doc.dirty = True
    return ("Disegnate %d op sulla faccia '%s' di '%s' (%dx%d), tinta media %s."
            "%s%s"
            % (n, key, mat["name"], w, h, mat["color"],
               " Avvisi: " + ", ".join(sorted(set(warnings))[:4]) + "."
               if warnings else "",
               " Riallineati %d voxel." % touched if touched else ""))


@mcp.tool()
def voxel_texture_generate(prompt: str, material: str = "", faces: list = None,
                           size: int = 16, context: bool = True,
                           model: str = "", provider: str = "",
                           document: str = "") -> str:
    """Fa disegnare la texture all'AI INTEGRATA (cookie o chiave permettendo).

    `faces` sono le facce da rifare: vuoto = la texture unica. Le facce GIA'
    disegnate che non stai rifacendo si mandano come contesto (`context`) in
    forma di testo, non di immagine — costa due ordini di grandezza in meno e un
    modello lo legge davvero, cosi' le sei facce restano coerenti fra loro.

    Se non c'e' un provider pronto (`voxel_ai_status`), scrivi tu le ops con
    `voxel_texture_draw`: e' la stessa strada, senza intermediari.
    """
    doc = SESSION.get(document or None)
    mat = textures.material_ref(doc, material)
    wanted = textures.face_keys(faces, [textures.ALL_KEY])
    side = textures.side(size)
    ctx = ""
    if context and textures.ALL_KEY not in wanted:
        ctx = textures.context_blocks(mat, wanted)
    built = textures.generate_faces(prompt, wanted, size=side, context=ctx,
                                    model=model or None,
                                    provider=provider or None)
    doc.snapshot("Texture generata")
    for key, tex in built["faces"].items():
        textures.set_face(mat, key, tex)
    touched = textures.sync_material_color(doc, mat)
    doc.dirty = True
    msg = ("Generate %d facce di '%s' (%s), %dx%d, tinta media %s."
           % (len(built["faces"]), mat["name"],
              ", ".join(sorted(built["faces"])), built["w"], built["h"],
              mat["color"]))
    if built["skipped"]:
        msg += " Scartate (nominate ma non disegnate): %s." % ", ".join(
            built["skipped"])
    if built["warnings"]:
        msg += " Avvisi: %s." % ", ".join(sorted(set(built["warnings"]))[:5])
    if touched:
        msg += " Riallineati %d voxel." % touched
    return msg + "\nGuardala con `voxel_texture_show`, correggila con `voxel_texture_draw`."


@mcp.tool()
def voxel_texture_show(material: str = "", face: str = "", document: str = "") -> str:
    """Mostra la texture come TESTO, cosi' la puoi leggere e correggere.

    Una riga per riga di pixel, in RLE (`4a` = quattro pixel del colore `a`),
    piu' la legenda dei colori; `.` e' trasparente. E' la stessa forma che si da'
    all'AI come contesto, ed e' l'unico modo di "vedere" un disegno da qui: un
    PNG in base64 non e' leggibile e costerebbe decine di kilobyte.
    """
    doc = SESSION.get(document or None)
    mat = textures.material_ref(doc, material)
    keys = ([textures.face_key(face)] if face
            else textures.existing_faces(mat))
    if not keys or keys == [None]:
        raise SessionError(
            "il materiale '%s' non ha texture da mostrare (e' a tinta unita %s). "
            "Disegnane una con `voxel_texture_draw`."
            % (mat.get("name"), mat.get("color")))
    out = []
    for key in keys:
        try:
            buf, w, h = materials.texture_buffer(textures.texture_of(mat, key))
        except Exception:                                    # noqa: BLE001
            out.append("FACCIA %s: texture illeggibile." % key)
            continue
        grid = pixelops.pixels_to_rle_rows(buf, w, h)
        out.append(pixelops.pixel_context_block(key, grid))
    return "\n".join(out)


@mcp.tool()
def voxel_texture_import(path: str, material: str = "", face: str = "all",
                         size: int = 0, document: str = "") -> str:
    """Importa un PNG dentro una faccia: e' il ponte con gli altri editor.

    Il PNG viene ricampionato al vicino piu' prossimo (l'unico corretto per la
    pixel art) e non oltre 128 pixel di lato (`materials.TEXTURE_MAX`). Dopo
    l'import la texture e' modificabile con `voxel_texture_draw` come se
    l'avessi disegnata qui.
    """
    doc = SESSION.get(document or None)
    mat = textures.material_ref(doc, material)
    key = textures.face_key(face)
    if not key:
        raise SessionError("faccia sconosciuta: '%s'." % face)
    tex = _texture_from_png(path, size or None)
    doc.snapshot("Texture importata")
    textures.set_face(mat, key, tex)
    touched = textures.sync_material_color(doc, mat)
    doc.dirty = True
    return ("Importato %s nella faccia '%s' di '%s' (%dx%d), tinta media %s.%s"
            % (os.path.basename(path), key, mat["name"], tex["w"], tex["h"],
               mat["color"],
               " Riallineati %d voxel." % touched if touched else ""))


@mcp.tool()
def voxel_texture_export(path: str, material: str = "", face: str = "",
                         document: str = "") -> str:
    """Salva le texture come PNG, per aprirle in un altro editor.

    Con `face` esporta una faccia sola in `path`; senza, esporta TUTTE quelle
    che esistono aggiungendo la sigla al nome (`blocco-py.png`).
    """
    doc = SESSION.get(document or None)
    mat = textures.material_ref(doc, material)
    keys = ([textures.face_key(face)] if face
            else textures.existing_faces(mat))
    if not keys or keys == [None]:
        raise SessionError("il materiale '%s' non ha texture da esportare."
                           % mat.get("name"))
    base, ext = os.path.splitext(str(path))
    ext = ext or ".png"
    written = []
    for key in keys:
        try:
            buf, w, h = materials.texture_buffer(textures.texture_of(mat, key))
        except Exception:                                    # noqa: BLE001
            continue
        out = path if len(keys) == 1 else "%s-%s%s" % (base, key, ext)
        written.append(_write(out, pngmod.encode_png(buf, w, h)))
    if not written:
        raise SessionError("nessuna texture decodificabile in '%s'."
                           % mat.get("name"))
    return "Scritti %d PNG:\n%s" % (len(written), "\n".join(written))


@mcp.tool()
def voxel_material_library(action: str = "list", material: str = "",
                           document: str = "") -> str:
    """La libreria personale: riusa un materiale fra progetti diversi.

    `action`: list | save (mette in libreria il materiale del progetto) |
              import (lo riprende, per nome o per numero).

    NON e' la libreria dell'app: quella vive nel `localStorage` del browser, che
    un processo Python non raggiunge. Questa e' un file nella cartella delle
    impostazioni (max 40 materiali, `materials.LIBRARY_MAX`). Il ponte fra le
    due resta il PNG e il progetto salvato, che entrambe leggono.
    """
    act = str(action or "list").strip().lower()
    if act in ("list", "elenco", ""):
        items = textures.library_load()
        if not items:
            return ("La libreria e' vuota. Riempila con action='save' su un "
                    "materiale che vuoi riusare.")
        return "\n".join(
            "%d. %s — %s, %s%s"
            % (i + 1, m.get("name"), m.get("color"),
               "sei facce" if m.get("faceMode") == "six" else "texture unica",
               "" if (m.get("texture") or m.get("faces")) else " (tinta unita)")
            for i, m in enumerate(items))

    doc = SESSION.get(document or None)
    if act in ("save", "salva", "add"):
        mat = textures.material_ref(doc, material)
        n = textures.library_add(mat)
        return ("'%s' e' in libreria (%d materiali su %d). Riprendilo in un "
                "altro progetto con action='import', material='%s'."
                % (mat.get("name"), n, materials.LIBRARY_MAX, mat.get("name")))
    if act in ("import", "importa", "use"):
        entry = textures.library_find(material)
        mid = doc.next_material_id()
        # L'id si RINUMERA: due progetti possono aver usato `m1` per materiali
        # diversi, e tenere quello d'origine legherebbe la copia al materiale
        # gia' presente invece di aggiungerne uno.
        mat = materials.normalize_material(
            materials.clone_for_library(entry, mid), mid)
        doc.snapshot("Materiale dalla libreria")
        doc.materials.append(mat)
        doc.dirty = True
        return ("Ripreso '%s' come %s in '%s'. Applicalo con "
                "`voxel_material_apply`."
                % (mat["name"], mid, SESSION.name_of(doc)))
    raise SessionError("azione sconosciuta: '%s'. Usa list, save, import."
                       % action)


# --- import / export ---------------------------------------------------------

@mcp.tool()
def voxel_import(path: str, as_object: bool = True, resolution: int = 64,
                 fill: bool = False, frames: int = 0, document: str = "") -> str:
    """Importa da un altro programma: .vox, .obj, .png, .gltf, .glb.

    - `.vox` (MagicaVoxel): esatto, un oggetto per modello contenuto.
    - `.obj` / `.gltf` / `.glb`: sono mesh di triangoli, quindi si VOXELIZZANO;
      `resolution` e' il lato piu' lungo del risultato e `fill` riempie
      l'interno dei gusci chiusi.
    - `.png`: con `frames` > 0 e' uno sprite stack (ogni fotogramma e' una
      fetta orizzontale), altrimenti diventa una lastra piatta.
    """
    doc = SESSION.get(document or None)
    p = os.path.expanduser(str(path))
    if not os.path.isfile(p):
        raise SessionError("file non trovato: %s" % p)
    ext = os.path.splitext(p)[1].lower()
    with open(p, "rb") as f:
        blob = f.read()
    base = os.path.splitext(os.path.basename(p))[0]
    groups = []
    if ext == ".vox":
        models = importers.read_vox(blob)
        # Un solo modello prende il nome del FILE; se ce ne sono piu' d'uno
        # tengono il loro, o si otterrebbero tre oggetti con lo stesso nome.
        if len(models) == 1:
            groups.append((base, models[0]["cells"]))
        else:
            groups = [(m["name"], m["cells"]) for m in models]
    elif ext == ".obj":
        mtl = None
        guess = os.path.splitext(p)[0] + ".mtl"
        if os.path.isfile(guess):
            with open(guess, "r", encoding="utf-8", errors="replace") as f:
                mtl = f.read()
        groups.append((base, importers.read_obj(
            blob.decode("utf-8", "replace"), mtl,
            resolution=int(resolution), fill=bool(fill))))
    elif ext in (".gltf", ".glb"):
        groups.append((base, importers.read_gltf(
            blob, resolution=int(resolution), fill=bool(fill))))
    elif ext == ".png":
        if int(frames) > 0:
            cells = importers.read_png_stack(blob, frames=int(frames))
        else:
            cells = importers.read_png_flat(blob)
        groups.append((base, cells))
    else:
        raise SessionError(
            "formato non riconosciuto: '%s'. Leggo .vox, .obj, .gltf, .glb, .png"
            % ext)

    added = []
    for name, cells in groups:
        if as_object or not doc.objects:
            o = VoxelObject(doc.unique_name(name), cells)
            doc.add_object(o)
        else:
            o = doc.active
            with doc.edit("Importa %s" % name, o):
                for k, c in cells.items():
                    doc.set_cell(o, k, c)
        added.append("%s[%d]" % (o.name, len(o)))
    return "Importato da %s: %s." % (os.path.basename(p), ", ".join(added))


@mcp.tool()
def voxel_export(path: str, fmt: str = "", obj: str = "", document: str = "",
                 scale: float = 1.0, center: bool = True) -> str:
    """Esporta per un altro programma. Il formato si deduce dall'estensione.

    - `.glb` / `.gltf`: per Blender, Unity, Godot, three.js. Le texture sono
      incorporate. Se l'oggetto ha PARTI nominate, ogni parte e' una mesh
      figlia (leva, plate, pulsante si selezionano e si animano da sole).
      Senza parti esce una mesh sola.
    - `.obj`: scrive ANCHE il .mtl e i PNG accanto, perche' senza il .mtl al
      suo fianco Blender mostra il modello bianco. Le parti diventano
      oggetti `o` distinti.
    - `.vox`: per MagicaVoxel (massimo 256 per lato).
    - `.png`: un rendering ortografico.
    - `.json`: i voxel piatti.
    """
    doc = SESSION.get(document or None)
    SESSION.auto_save(doc)
    o = doc.object_by_ref(obj or None)

    if not len(o):
        raise SessionError("l'oggetto '%s' e' vuoto: non c'e' niente da esportare"
                           % o.name)
    ext = (fmt or os.path.splitext(path)[1]).lower().lstrip(".")
    scale = _as_float(scale, 1.0)
    _center = _as_bool(center, True)

    def _done(msg):
        hist = SESSION.export_history(doc, o.name)
        if hist:
            return msg + " JSON in history: %s." % hist
        return msg

    if ext == "glb":
        return _done("Esportato in %s." % _write(path, exporters.build_glb(
            doc, o, scale, _center)))
    if ext == "gltf":
        gltf, blob = exporters.build_gltf(doc, o, scale, _center)
        if blob:
            import base64
            gltf["buffers"] = [{
                "byteLength": len(blob),
                "uri": "data:application/octet-stream;base64,"
                       + base64.b64encode(blob).decode("ascii")}]
        return _done("Esportato in %s." % _write(path, json.dumps(gltf)))
    if ext == "obj":
        base = os.path.splitext(os.path.basename(path))[0]
        folder = os.path.dirname(path)
        written = []
        for name, data in exporters.export_obj_bundle(
                doc, o, base, scale, _center):
            written.append(os.path.basename(
                _write(os.path.join(folder, name) if folder else name, data)))
        return _done("Esportati accanto: %s. Tienili nella stessa cartella, o i "
                     "materiali non si vedono." % ", ".join(written))
    if ext == "vox":
        return _done("Esportato in %s." % _write(path, exporters.build_vox(doc, o)))
    if ext == "png":
        buf, w, h = exporters.render_ortho(o, view="front", scale=max(1, int(scale)))
        return _done("Esportato in %s (%dx%d)." % (
            _write(path, pngmod.encode_png(buf, w, h)), w, h))
    if ext == "json":
        return _done("Esportato in %s." % _write(
            path, json.dumps(doc.to_payload(), ensure_ascii=False)))
    raise SessionError(
        "formato di esportazione sconosciuto: '%s'. Uso glb, gltf, obj, vox, "
        "png, json" % ext)


@mcp.tool()
def voxel_rig_auto(kind: str = "auto", binding: str = "", segments: int = 5,
                   hardness: float = 0.0, obj: str = "",
                   document: str = "") -> str:
    """Costruisce lo scheletro adattato all'ingombro del modello e lo lega ai voxel.

    `kind`: `humanoid` (24 ossa: bacino, colonna, torace, collo, testa, due
    braccia, due gambe), `generic` (una catena di `segments` ossa lungo l'asse
    piu' lungo — un ponte, un albero, un braccio meccanico), oppure `auto`, che
    sceglie umanoide solo se il modello e' piu' alto che largo e che profondo.

    `binding` decide come i voxel seguono le ossa:
    - `rigid` — un osso per voxel, peso pieno. Netto, senza deformazione ai
      giunti: e' quello giusto per la voxel art, dove i cubi devono restare cubi.
    - `smooth` — fino a 4 ossa per voxel, con sfumatura ai giunti. Piega meglio
      le curve e ammorbidisce i gomiti.
    - `parts` — le PARTI gia' dichiarate sui voxel comandano l'assegnazione, un
      osso ciascuna. Se il modello ha parti e' quasi sempre la scelta giusta,
      perche' rispetta i confini che hai gia' disegnato.
    Vuoto = `parts` se il modello ha parti, altrimenti la scelta del tipo.

    Rifare lo scheletro CONSERVA la posa (si ritrova per nome) ma BUTTA i pesi
    dipinti a mano: puntavano a ossa che non esistono piu'.

    Per l'umanoide il modello va costruito in **T-pose** (braccia orizzontali,
    aperte ai lati). Non e' un capriccio: le stazioni delle braccia si misurano
    dal bordo del torso, e con le braccia lungo i fianchi il bordo del torso E'
    il braccio, quindi la spalla finisce sulla punta del dito e nessun voxel si
    lega a `upperArm_*`. Il sintomo e' una posa che non muove niente. Le braccia
    si abbassano DOPO, con `voxel_rig_pose` (Z -78 a destra, +78 a sinistra).
    La risposta avvisa se qualche osso e' rimasto senza voxel.

    Poi: `voxel_rig_info` per l'elenco delle ossa, `voxel_rig_pose` per piegarlo,
    `voxel_rig_export` per il GLB animato.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    doc.snapshot("Scheletro automatico")
    r = rig.auto_rig(o, kind, binding or None, int(segments),
                     float(hardness) or None)
    doc.dirty = True
    msg = ("Scheletro %s su '%s': %d ossa, legatura '%s'. Le ossa si elencano "
           "con voxel_rig_info."
           % (r["type"], o.name, len(r["bones"]), r["binding"]))
    # Un osso senza voxel non e' un errore (a volte il modello non ha quella
    # parte), ma se non lo si dice qui lo si scopre molto dopo: si posa, non si
    # muove niente, e sembra rotta la posa invece che la legatura.
    orfane = rig.unbound_bones(o, r)
    if orfane:
        msg += (" Attenzione: %d ossa non hanno nessun voxel (%s): posarle non "
                "muovera' niente. Per un umanoide costruisci il modello in "
                "T-pose, con le braccia aperte ai lati."
                % (len(orfane), ", ".join(orfane[:6])))
    return msg


@mcp.tool()
def voxel_rig_info(obj: str = "", document: str = "") -> str:
    """Le ossa dello scheletro: nome, padre, estremi e posa attuale.

    I nomi sono quelli da usare in `voxel_rig_pose` e nelle clip. Le rotazioni
    escono in GRADI (dentro sono radianti) e gli spostamenti in unita' voxel.

    Le convenzioni che servono per posare un umanoide senza indovinare:
    - **Le braccia si ruotano su Z, non su X.** A riposo l'osso del braccio e'
      allineato all'asse X, quindi ruotarlo su X non muove niente. `-78` su `_R`
      e `+78` su `_L` e' "braccia lungo il corpo"; Z positivo sul destro = su.
    - **La X e' l'oscillazione avanti/indietro** e dipende da dove guarda il
      modello (vedi `facing` qui sotto).
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    r = rig.require_rig(o)
    rows = rig.bone_summary(o, r)
    lines = ["Scheletro %s di '%s' (legatura '%s'), guarda a %d gradi:"
             % (r["type"], o.name, r["binding"], rig.rig_facing_yaw(r["bones"]))]
    for e in rows:
        bits = ["%2d %-14s" % (e["index"], e["name"])]
        bits.append("padre %-14s" % (e["parent"] or "-"))
        bits.append("testa %s" % (e["head"],))
        if e.get("rotationDeg"):
            bits.append("rot %s" % (e["rotationDeg"],))
        if e.get("offsetVoxel"):
            bits.append("spost %s" % (e["offsetVoxel"],))
        lines.append("  " + "  ".join(bits))
    lines.append("Clip disponibili: %s." % ", ".join(rig.clip_names(o, rig_data=r)))
    return "\n".join(lines)


@mcp.tool()
def voxel_rig_pose(poses: dict = None, additive: bool = True, reset: bool = False,
                   obj: str = "", document: str = "") -> str:
    """Piega lo scheletro. `poses` e' `{osso: {"rot": [gx,gy,gz], "pos": [dx,dy,dz]}}`.

    `rot` sono GRADI (Euler XYZ), `pos` uno spostamento in unita' VOXEL rispetto
    al riposo. Entrambi facoltativi: si puo' dare solo l'uno o solo l'altro.

    `additive` (predefinito) tiene le ossa che non nomini come stanno; a `False`
    tutto il resto torna a riposo. `reset` riporta a riposo l'intero scheletro e
    ignora `poses`.

    Un nome d'osso sbagliato e' un ERRORE, non un silenzio: quasi sempre e' un
    refuso, e ignorarlo darebbe una posa "applicata" che non cambia niente.
    Ricorda che le braccia si piegano su **Z** (vedi `voxel_rig_info`).

    La posa e' quella con cui il modello viene esportato, ed e' anche la PRIMA
    clip del GLB, quindi e' cio' che si vede aprendo il file in Blender.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    rig.require_rig(o)
    doc.snapshot("Posa")
    if reset:
        rig.clear_pose(o)
        doc.dirty = True
        return "Scheletro di '%s' riportato a riposo." % o.name
    if not poses:
        raise SessionError("nessuna posa da applicare: passa `poses` oppure "
                           "`reset=true`")
    touched = rig.set_pose(o, poses, bool(additive))
    doc.dirty = True
    return ("Posate %d ossa di '%s': %s. Rileggila con voxel_rig_info o "
            "esportala con voxel_rig_export."
            % (len(touched), o.name, ", ".join(touched)))


@mcp.tool()
def voxel_rig_bind(binding: str = "", hardness: float = 0.0,
                   weights: dict = None, obj: str = "",
                   document: str = "") -> str:
    """Cambia come i voxel seguono le ossa, o dipinge i pesi a mano.

    `binding`: `rigid` / `smooth` / `parts` (vedi `voxel_rig_auto`).
    `hardness` (1..16, predefinito 6) vale solo per `smooth`: piu' alto = la
    sfumatura ai giunti si stringe e la deformazione somiglia a `rigid`.

    `weights` forza singoli voxel: `{"x,y,z": {"osso": peso, ...}}`, oppure
    `{"x,y,z": "osso"}` per assegnarne uno solo a peso pieno. I pesi si
    normalizzano da soli e si tengono le 4 ossa piu' pesanti — oltre, la GPU le
    scarterebbe in silenzio. Un voxel non nominato resta calcolato.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    r = rig.require_rig(o)
    doc.snapshot("Legatura")
    bind = (binding or r["binding"]).lower()
    if bind not in ("rigid", "smooth", "parts"):
        raise SessionError("legatura sconosciuta: '%s'. Uso rigid, smooth, parts"
                           % binding)
    o.rig["binding"] = bind
    if hardness:
        o.rig["hardness"] = max(1.0, min(16.0, float(hardness)))
    added = 0
    if weights:
        keep = dict(o.rig.get("weights") or {})
        names = set(bd["name"] for bd in r["bones"])
        for key, entry in weights.items():
            norm = rig.normalize_weight_entry(entry)
            if norm is None:
                keep.pop(str(key), None)
                continue
            unknown = [n for n in norm if n not in names]
            if unknown:
                raise SessionError(
                    "osso sconosciuto nei pesi di '%s': %s"
                    % (key, ", ".join(unknown)))
            keep[str(key)] = norm
            added += 1
        o.rig["weights"] = keep
    doc.dirty = True
    skin = rig.skin_for(o, rig.rig_of(o))
    used = len(set(skin["primary"])) if skin["primary"] else 0
    return ("Legatura di '%s': '%s'%s, %d ossa in uso su %d%s."
            % (o.name, bind,
               (", durezza %g" % o.rig["hardness"]) if o.rig.get("hardness") else "",
               used, len(r["bones"]),
               (", %d voxel forzati a mano" % added) if added else ""))


@mcp.tool()
def voxel_rig_clip(name: str = "", tracks: list = None, duration: float = 1.0,
                   loop: bool = True, remove: bool = False, obj: str = "",
                   document: str = "") -> str:
    """Scrive a mano una clip di animazione, o ne toglie una.

    `tracks` e' `[{"bone": "upperArm_R", "keys": [{"t": 0, "rot": [0,0,-78]},
    {"t": 0.5, "rot": [0,0,-40]}]}]`: `t` in secondi, `rot` in GRADI, `pos` in
    unita' voxel rispetto al riposo. Un osso puo' avere entrambi.

    Le clip scritte qui sono nel frame dello scheletro REALE (vedi le posizioni
    delle ossa con `voxel_rig_info`): non vengono ruotate sull'imbardata del
    modello, a differenza dei cinque preset, che sono scritti in un frame
    canonico e riportati sul tuo. Quindi guarda dove punta il modello e scrivi
    direttamente i valori giusti.

    Alle cinque predefinite (`idle`, `walk`, `run`, `jump`, `wave`) si aggiungono
    quelle scritte qui, e finiscono tutte nel GLB di `voxel_rig_export`.
    Un nome gia' usato viene sostituito. `remove=true` la cancella.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    rig.require_rig(o)
    if not str(name or "").strip():
        raise SessionError("la clip deve avere un nome")
    doc.snapshot("Clip")
    if remove:
        n = rig.remove_custom_clip(o, name)
        doc.dirty = True
        if not n:
            return "Nessuna clip '%s' su '%s'." % (name, o.name)
        return "Clip '%s' tolta da '%s'." % (name, o.name)
    if not tracks:
        raise SessionError("la clip non ha tracce: passa `tracks`")
    anim = rig.normalize_anim(
        {"name": name, "duration": duration, "loop": bool(loop),
         "tracks": tracks}, o.rig["bones"])
    rig.add_custom_clip(o, anim)
    doc.dirty = True
    note = ""
    if anim.get("unknownBones"):
        note = (" Ossa ignorate perche' non esistono: %s."
                % ", ".join(anim["unknownBones"]))
    return ("Clip '%s' su '%s': %d tracce, %.2f s%s.%s"
            % (anim["name"], o.name, len(anim["tracks"]), anim["duration"],
               ", in ciclo" if anim["loop"] else "", note))


@mcp.tool()
def voxel_rig_animate(prompt: str, name: str = "", model: str = "",
                      provider: str = "", obj: str = "",
                      document: str = "") -> str:
    """Fa scrivere una clip all'AI INTEGRATA, descrivendola a parole.

    All'AI si mandano i nomi e le posizioni delle ossa VERE di questo scheletro,
    quindi la clip torna gia' nel frame giusto e non va ruotata.

    Se nessun provider e' pronto (`voxel_ai_status`), la clip la puoi scrivere tu
    con `voxel_rig_clip`: e' esattamente la stessa strada, senza intermediari.
    """
    doc = SESSION.get(document or None)
    o = doc.object_by_ref(obj or None)
    rig.require_rig(o)
    anim = rig.generate_clip(prompt, o.rig["bones"], name=name or None,
                             model=model or None, provider=provider or None)
    doc.snapshot("Animazione AI")
    rig.add_custom_clip(o, anim)
    doc.dirty = True
    bones = sorted(set(t["bone"] for t in anim["tracks"]))
    note = ""
    if anim.get("unknownBones"):
        note = (" Ha citato ossa che non esistono (ignorate): %s."
                % ", ".join(anim["unknownBones"]))
    return ("Clip '%s' generata su '%s': %.2f s, %d ossa animate (%s).%s"
            % (anim["name"], o.name, anim["duration"], len(bones),
               ", ".join(bones[:8]) + ("..." if len(bones) > 8 else ""), note))


@mcp.tool()
def voxel_rig_export(path: str, scale: float = 0.01, presets: bool = True,
                     custom: bool = True, clips: list = None,
                     all_faces: bool = False, obj: str = "",
                     document: str = "") -> str:
    """Esporta il modello RIGGATO in GLB: ossa, pesi, posa e animazioni.

    Si apre in Blender, Unity, Godot e three.js. `scale=0.01` significa un voxel
    = 1 cm (un personaggio di 40 voxel arriva a 40 cm); `scale=1` esporta in
    unita' voxel.

    `presets` include le cinque clip predefinite, `custom` quelle scritte o
    generate; `clips` limita l'export ai nomi elencati. La POSA corrente e'
    sempre la prima clip del file, perche' Blender assegna da solo la prima
    action all'import: senza, il modello si aprirebbe nella prima animazione
    invece che nella posa che hai impostato.

    `all_faces` costruisce anche le facce sepolte fra voxel adiacenti: serve solo
    a chi deve tagliare o simulare il modello, e raddoppia abbondantemente il
    file.

    Per un modello STATICO (senza ossa) usa `voxel_export`: e' piu' leggero,
    perche' unisce le facce complanari in quad grandi.
    """
    doc = SESSION.get(document or None)
    SESSION.auto_save(doc)
    o = doc.object_by_ref(obj or None)

    rig.require_rig(o)
    # `clips` arriva come lista dai client che rispettano lo schema e come
    # stringa "walk,run" da quelli che appiattiscono tutto a testo.
    if isinstance(clips, str):
        only = [c.strip() for c in clips.split(",") if c.strip()] or None
    elif clips:
        only = [str(c).strip() for c in clips if str(c).strip()] or None
    else:
        only = None
    _scale = _as_float(scale, 0.01)
    _all = _as_bool(all_faces, False)
    _pre = _as_bool(presets, True)
    _cust = _as_bool(custom, True)
    data = rig.export_rigged_glb(doc, o, _scale, _all, _pre, _cust, only)
    full = _write(path, data)
    SESSION.export_history(doc, o.name)
    # I nomi vanno letti col filtro applicato, non dai valori di partenza: con
    # `clips=['walk']` il file ne contiene una sola, e annunciarle tutte e' un
    # messaggio che smentisce il file appena scritto.
    names = rig.clip_names(o, _pre, _cust, only)
    # E la posa si annuncia solo se c'e' davvero: a scheletro a riposo
    # `build_pose_clip` non ne emette nessuna (una clip di soli valori di riposo
    # comparirebbe nell'elenco senza fare niente).
    posed = rig.has_pose(o)
    parts = (["la posa"] if posed else []) + names
    return ("Esportato '%s' riggato in %s (%.0f kB). Clip nel file: %s."
            % (o.name, full, len(data) / 1024.0,
               ", ".join(parts) if parts else "nessuna"))


def main(argv=None):
    global WORKDIR, UNRESTRICTED
    argv = list(sys.argv[1:] if argv is None else argv)
    workdir = None
    transport = "stdio"
    host = None
    port = None
    debug = False
    for i, a in enumerate(argv):
        if a == "--workdir" and i + 1 < len(argv):
            workdir = argv[i + 1]
        elif a.startswith("--workdir="):
            workdir = a.split("=", 1)[1]
        elif a in ("--unrestricted", "--allow-any-path", "--unlimited"):
            UNRESTRICTED = True
        elif a in ("--debug", "-v", "--verbose"):
            debug = True
        elif a in ("--sse", "--http", "--mcp", "--streamable"):
            # Un solo processo HTTP: /sse (legacy) e /mcp (Streamable HTTP).
            transport = "sse"
        elif a == "--transport" and i + 1 < len(argv):
            transport = argv[i + 1]
        elif a.startswith("--transport="):
            transport = a.split("=", 1)[1]
        elif a == "--host" and i + 1 < len(argv):
            host = argv[i + 1]
        elif a.startswith("--host="):
            host = a.split("=", 1)[1]
        elif a == "--port" and i + 1 < len(argv):
            port = int(argv[i + 1])
        elif a.startswith("--port="):
            port = int(a.split("=", 1)[1])
    if workdir:
        WORKDIR = os.path.realpath(os.path.expanduser(workdir))
        os.makedirs(WORKDIR, exist_ok=True)
    else:
        WORKDIR = os.path.realpath(os.getcwd())
    if host:
        mcp.settings.host = host
    if port:
        mcp.settings.port = port
    import logging

    # Il rumore che si vuole zittire e' SOLO questo: due warning che il SDK
    # emette a ogni riconnessione di un client e che non descrivono un guasto.
    class SuppressWarningsFilter(logging.Filter):
        def filter(self, record):
            if record.levelno == logging.WARNING:
                msg = record.getMessage()
                if "Received request before initialization" in msg:
                    return False
                if "RequestResponder must be used" in msg:
                    return False
            return True

    logging.getLogger().addFilter(SuppressWarningsFilter())
    for name in logging.root.manager.loggerDict:
        if name.startswith("mcp") or name.startswith("uvicorn") or name.startswith("starlette"):
            logging.getLogger(name).addFilter(SuppressWarningsFilter())

    # `Failed to validate request:` NON va soppresso, ed e' il motivo per cui un
    # -32602 sembrava arrivare dal nulla: il SDK rifiuta la busta JSON-RPC dentro
    # `mcp/shared/session.py` PRIMA di chiamare qualunque strumento, quindi un
    # aggancio su `call_tool` non lo vede mai. Il messaggio esiste gia', ma senza
    # una configurazione del logging finisce nel gestore d'emergenza e a volte da
    # nessuna parte. Qui gli si da' una destinazione esplicita: stderr, perche'
    # su stdio quello e' il canale del protocollo e una riga di troppo su stdout
    # chiude il client senza spiegazioni.
    root = logging.getLogger()
    if not any(getattr(h, "_voxelai", False) for h in root.handlers):
        h = logging.StreamHandler(sys.stderr)
        h.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        h._voxelai = True
        h.addFilter(SuppressWarningsFilter())
        root.addHandler(h)
    if root.level == logging.NOTSET or root.level > logging.INFO:
        root.setLevel(logging.INFO)
    if debug:
        root.setLevel(logging.DEBUG)

    mode_str = "illimitata (qualsiasi cartella)" if UNRESTRICTED else WORKDIR
    sys.stderr.write("VoxelAI MCP — scrittura: %s (trasporto: %s)\n" % (mode_str, transport))

    if debug and transport == "sse":
        patch.install()

    if transport == "sse":
        streamable.mount(mcp)
        base = "http://%s:%s" % (mcp.settings.host, mcp.settings.port)
        sys.stderr.write(
            "Server HTTP attivo:\n"
            "  Streamable HTTP  %s/mcp   (Zcode, type=http)\n"
            "  SSE legacy       %s/sse   (Kilo/Claude type=sse)\n"
            % (base, base))
    proxy = compat.protect_stdout()
    mcp.run(transport=transport)

    if proxy is not None and not proxy.buffer_used:
        sys.stderr.write(
            "VoxelAI MCP: attenzione, il trasporto non ha usato stdout.buffer "
            "— la protezione dello stdout potrebbe non essere piu' valida.\n")


if __name__ == "__main__":
    main()

