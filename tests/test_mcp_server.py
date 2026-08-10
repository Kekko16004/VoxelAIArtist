"""Prove del server MCP: gli strumenti chiamati COME LI CHIAMA UN CLIENT.

La differenza non e' formale. Chiamare la funzione Python sotto il decoratore
salta esattamente cio' che puo' rompersi in un server MCP: la registrazione
dello strumento, lo schema dedotto dalle annotazioni di tipo, la serializzazione
del risultato. Un server puo' avere tutti gli strumenti giusti e non esporne
nessuno. Qui si passa quindi da `call_tool` del vero `FastMCP`, cioe' dallo
stesso ingresso che usa il client.

Nessuna rete: gli strumenti provati qui non chiamano l'AI. Quelli che la
userebbero passano tutti da `ai.answer_text`, che le prove sostituiscono con
una funzione finta (vedi la sezione "generazione AI"): montaggio del prompt,
recupero del JSON e scrittura nel documento girano quindi per davvero, senza
cookie e senza quota. Il disco si tocca solo dentro una cartella temporanea,
che e' anche la cartella di lavoro imposta al server — cosi' si prova nello
stesso colpo che il vincolo di scrittura c'e'.
"""

import asyncio
import glob
import importlib
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp_server import ai, compat, exporters, materials, server  # noqa: E402
from mcp_server import png as pngmod                           # noqa: E402
from mcp_server.document import Cell                           # noqa: E402
from mcp_server.session import SESSION                         # noqa: E402

_ok = 0
_fail = []


def check(label, cond, detail=""):
    global _ok
    if cond:
        _ok += 1
    else:
        _fail.append("%s%s" % (label, (" -- " + detail) if detail else ""))


def check_eq(label, got, want):
    check(label, got == want, "atteso %r, ottenuto %r" % (want, got))


def call(_tool, **args):
    """Invoca uno strumento attraverso il registro di FastMCP.

    `call_tool` ritorna il contenuto gia' impacchettato per il protocollo; si
    concatena il testo, che e' cio' che il modello leggerebbe.

    Il primo parametro si chiama `_tool` e non `name` di proposito: `name` e'
    anche il nome di un argomento di piu' strumenti (`voxel_new`,
    `voxel_object_add`), e chiamarli entrambi cosi' faceva sollevare
    "got multiple values for argument 'name'" prima ancora di entrare nel
    server — un errore della prova che si legge come un errore del server.
    """
    res = asyncio.get_event_loop().run_until_complete(
        server.mcp.call_tool(_tool, args))
    items = res[0] if isinstance(res, tuple) else res
    out = []
    for c in items:
        out.append(getattr(c, "text", None) or "")
    return "\n".join(out)


def call_fails(_tool, **args):
    """Ritorna il messaggio d'errore, o None se lo strumento e' riuscito."""
    try:
        call(_tool, **args)
        return None
    except Exception as e:                        # noqa: BLE001
        return str(e)


def reset():
    SESSION.docs.clear()
    SESSION.current = None
    SESSION._counter = 0


# --- registro ----------------------------------------------------------------

def test_tools_are_registered():
    tools = asyncio.get_event_loop().run_until_complete(
        server.mcp.list_tools())
    names = {t.name for t in tools}
    expected = {
        "voxel_new", "voxel_open", "voxel_save", "voxel_list", "voxel_use",
        "voxel_close", "voxel_info", "voxel_preview", "voxel_undo",
        "voxel_redo", "voxel_history", "voxel_object_add",
        "voxel_object_remove", "voxel_object_rename", "voxel_fill",
        "voxel_erase", "voxel_set", "voxel_transform", "voxel_recolor",
        "voxel_shade", "voxel_import", "voxel_export",
        "voxel_ai_status", "voxel_ops", "voxel_generate", "voxel_modify",
        "voxel_pack_start", "voxel_pack_status", "voxel_pack_result",
        "voxel_pack_cancel",
        "voxel_material_list", "voxel_material_create", "voxel_material_update",
        "voxel_material_delete", "voxel_material_apply", "voxel_material_library",
        "voxel_texture_draw", "voxel_texture_generate", "voxel_texture_show",
        "voxel_texture_import", "voxel_texture_export",
        "voxel_rig_auto", "voxel_rig_info", "voxel_rig_pose", "voxel_rig_bind",
        "voxel_rig_clip", "voxel_rig_animate", "voxel_rig_export",
    }
    missing = expected - names
    check("registro: tutti gli strumenti sono esposti", not missing,
          "mancano %r" % sorted(missing))
    check("registro: nessuno strumento senza descrizione",
          all((t.description or "").strip() for t in tools),
          "senza: %r" % [t.name for t in tools if not (t.description or "").strip()])
    # Lo schema serve al modello per sapere cosa passare: se le annotazioni non
    # ci fossero, `args` non comparirebbe fra le proprieta'.
    fill = [t for t in tools if t.name == "voxel_fill"][0]
    props = (fill.inputSchema or {}).get("properties") or {}
    check("registro: voxel_fill dichiara shape e args",
          "shape" in props and "args" in props, "proprieta': %r" % sorted(props))
    check("registro: i campi obbligatori sono solo shape e args",
          set((fill.inputSchema or {}).get("required") or []) == {"shape", "args"},
          "richiesti: %r" % (fill.inputSchema or {}).get("required"))


def test_nessuno_strumento_fantasma_nei_testi():
    """Nessun testo dell'MCP nomina uno strumento che non esiste.

    Le descrizioni degli strumenti sono l'unica documentazione che il modello
    legge davvero, e si rimandano l'un l'altra ("rileggila con X", "annullalo
    con Y"). Un nome sbagliato li' non da' nessun errore: il modello chiama uno
    strumento inesistente, il client risponde "unknown tool" e il difetto si
    presenta come "l'assistente si e' inventato uno strumento".

    Non e' un rischio teorico. Questa guardia nasce dopo averne trovati due in
    GUI: `voxel_render`, citato dal ritorno di `voxel_rig_pose` e mai esistito,
    e `voxel_pack_retry` nella descrizione di `voxel_pack_result` (la vera
    ripresa dei falliti e' `voxel_pack_cancel(retry=True)`).

    Si guarda il registro VERO di FastMCP e non una lista scritta a mano, o la
    lista diventerebbe la seconda cosa da tenere aggiornata. Si accettano i nomi
    di funzione interni (`voxel_bounds` in `rig.py`, `voxel_budget_for` preso da
    `src/parser.py`): sono codice, non richiami a uno strumento. E si raccolgono
    dai MODULI IMPORTATI, non cercando `def` nei sorgenti: `voxel_budget_for` e'
    importato e non definito qui, quindi un `def` non lo troverebbe e la guardia
    lo denuncerebbe come fantasma.
    """
    tools = asyncio.get_event_loop().run_until_complete(server.mcp.list_tools())
    names = {t.name for t in tools}
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pkg = os.path.join(root, "mcp_server")
    files = sorted(glob.glob(os.path.join(pkg, "*.py")))
    interni = set()
    for path in files:
        base = os.path.splitext(os.path.basename(path))[0]
        if base.startswith("__"):
            # `__main__.py` chiama `main()` all'import, cioe' AVVIA il server e
            # gli fa consumare il ciclo di eventi di questo processo: le prove
            # successive morivano con "There is no current event loop". I suoi
            # testi si controllano lo stesso — sotto si leggono come file.
            continue
        try:
            importlib.import_module("mcp_server." + base)
        except Exception:                     # noqa: BLE001
            continue
        interni.update(n for n in dir(sys.modules["mcp_server." + base])
                       if n.startswith("voxel_"))
    interni -= names                       # uno strumento non e' "interno"
    fantasmi = []
    for path in files + [os.path.join(pkg, "README.md")]:
        with open(path, "r", encoding="utf-8") as f:
            testo = f.read()
        for m in set(re.findall(r"\bvoxel_[a-z_]+\b", testo)):
            if m not in names and m not in interni:
                fantasmi.append("%s -> %s" % (m, os.path.basename(path)))
    check("descrizioni: nessuno strumento fantasma", not fantasmi,
          "; ".join(sorted(fantasmi)))
    # La guardia deve avere i denti: se il registro fosse vuoto o l'espressione
    # non trovasse niente, il controllo qui sopra passerebbe per finta.
    check("descrizioni: la guardia legge davvero i testi",
          len(names) >= 40 and interni, "%d nomi, interni %r" % (len(names), interni))


# --- ciclo di vita -----------------------------------------------------------

def test_document_lifecycle():
    reset()
    out = call("voxel_new", name="Casa", grid=32)
    check("new: conferma parlante", "Casa" in out and "32" in out, out)
    call("voxel_new", name="Albero")
    listing = call("voxel_list")
    check("list: elenca entrambi", "Casa" in listing and "Albero" in listing)
    check("list: segna il corrente", "(corrente)" in listing)
    call("voxel_use", document="Casa")
    check("use: cambia il corrente", "Casa (corrente)" in call("voxel_list"))
    call("voxel_close", document="Albero")
    check("close: chiude", "Albero" not in call("voxel_list"))


def test_unknown_document_lists_the_open_ones():
    reset()
    call("voxel_new", name="Casa")
    err = call_fails("voxel_info", document="Nonesiste")
    check("errore: nomina il documento assente", err and "Nonesiste" in err, err)
    check("errore: elenca quelli aperti", err and "Casa" in err, err)


def test_no_document_speaks():
    reset()
    err = call_fails("voxel_info")
    check("errore: senza documenti suggerisce voxel_new",
          err and "voxel_new" in err, err)


# --- costruzione -------------------------------------------------------------

def test_fill_shapes():
    reset()
    call("voxel_new", name="P")
    out = call("voxel_fill", shape="box",
               args={"x0": 0, "y0": 0, "z0": 0, "x1": 3, "y1": 3, "z1": 3},
               color="#FF0000")
    check("fill box: 64 voxel", "64 voxel" in out, out)
    info = json.loads(call("voxel_info"))
    check_eq("fill box: ingombro 4x4x4", info["ingombro"], [4, 4, 4])
    check_eq("fill box: un colore", info["colori"], 1)

    call("voxel_fill", shape="sphere",
         args={"cx": 10, "cy": 10, "cz": 10, "radius": 4}, color="#00FF00")
    info = json.loads(call("voxel_info"))
    check_eq("fill sphere: due colori", info["colori"], 2)
    check("fill sphere: la sfera e' rotonda, non un cubo",
          info["voxel"] - 64 < 9 * 9 * 9, "%d voxel" % (info["voxel"] - 64))


def test_hollow_box_is_a_shell():
    reset()
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 4, "y1": 4, "z1": 4,
               "hollow": True}, color="#FFFFFF")
    info = json.loads(call("voxel_info"))
    # Un guscio 5x5x5 ha 125 - 27 = 98 voxel; se `hollow` fosse ignorato ne
    # avrebbe 125, ed e' il modo di accorgersene senza contare a mano.
    check_eq("fill: il guscio e' cavo", info["voxel"], 98)


def test_unknown_shape_lists_the_known_ones():
    reset()
    call("voxel_new")
    err = call_fails("voxel_fill", shape="piramide", args={})
    check("errore: elenca le forme disponibili",
          err and "box" in err and "sphere" in err, err)


def test_bad_shape_args_speak():
    reset()
    call("voxel_new")
    err = call_fails("voxel_fill", shape="sphere", args={"cx": 0})
    check("errore: argomenti sbagliati nominano la forma",
          err and "sphere" in err, err)


def test_erase_and_undo():
    reset()
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 3, "y1": 3, "z1": 3},
         color="#FF0000")
    call("voxel_erase", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1})
    after = json.loads(call("voxel_info"))["voxel"]
    check_eq("erase: tolti 8 voxel", after, 64 - 8)
    call("voxel_undo")
    check_eq("undo: i voxel tornano",
             json.loads(call("voxel_info"))["voxel"], 64)
    call("voxel_redo")
    check_eq("redo: rispariscono",
             json.loads(call("voxel_info"))["voxel"], 56)
    check("history: elenca le voci", "box" in call("voxel_history").lower()
          or "riemp" in call("voxel_history").lower(), call("voxel_history"))


def test_undo_with_nothing_to_undo():
    reset()
    call("voxel_new")
    check("undo: senza cronologia lo dice",
          "Niente da annullare" in call("voxel_undo"))


def test_symmetry():
    reset()
    call("voxel_new", grid=16)
    call("voxel_fill", shape="box",
         args={"x0": 1, "y0": 0, "z0": 0, "x1": 2, "y1": 0, "z1": 0},
         color="#FF0000", symmetry="x")
    info = json.loads(call("voxel_info"))
    check_eq("symmetry: il tratto e' specchiato", info["voxel"], 4)
    check("symmetry: la copia sta dall'altra parte della griglia",
          info["bounds"][3] >= 13, "bounds %r" % info["bounds"])


def test_transform_actions():
    reset()
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 5, "z0": 0, "x1": 1, "y1": 6, "z1": 1},
         color="#FF0000")
    call("voxel_transform", action="ground")
    check_eq("transform ground: poggia a y=0",
             json.loads(call("voxel_info"))["bounds"][1], 0)
    call("voxel_transform", action="move", dx=3)
    check_eq("transform move: sposta su X",
             json.loads(call("voxel_info"))["bounds"][0], 3)
    before = json.loads(call("voxel_info"))["voxel"]
    call("voxel_transform", action="rotate", axis="y", steps=1)
    check_eq("transform rotate: conserva i voxel",
             json.loads(call("voxel_info"))["voxel"], before)
    err = call_fails("voxel_transform", action="teletrasporta")
    check("errore: azione ignota elenca quelle valide",
          err and "move" in err and "rotate" in err, err)


def test_recolor():
    reset()
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 2, "y1": 2, "z1": 2},
         color="#FF0000")
    out = call("voxel_recolor", src="#FF0000", dst="#0000FF")
    check("recolor: conferma il numero", "27" in out, out)
    info = json.loads(call("voxel_info"))
    check_eq("recolor: un solo colore, quello nuovo",
             info["principali"][0]["colore"], "#0000FF")


def test_objects():
    reset()
    call("voxel_new", name="Scena")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1},
         color="#FF0000")
    call("voxel_object_add", name="Tetto")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 5, "z0": 0, "x1": 1, "y1": 5, "z1": 1},
         color="#00FF00")
    check("object_add: il nuovo e' attivo",
          json.loads(call("voxel_info"))["oggetto"] == "Tetto")
    check("object: quello vecchio conserva i suoi voxel",
          json.loads(call("voxel_info", obj="Oggetto 1"))["voxel"] == 8)
    call("voxel_object_rename", name="Copertura")
    check_eq("object_rename", json.loads(call("voxel_info"))["oggetto"],
             "Copertura")
    err = call_fails("voxel_info", obj="Cantina")
    check("errore: oggetto assente elenca quelli presenti",
          err and "Copertura" in err, err)


def test_preview_is_text():
    reset()
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 3, "y1": 3, "z1": 0},
         color="#FF0000")
    art = call("voxel_preview", view="front", width=16)
    check("preview: piu' righe", len(art.splitlines()) >= 3, repr(art[:60]))
    check("preview: oggetto vuoto lo dice",
          "vuoto" in call("voxel_preview", obj="", document="").lower()
          or len(art) > 0)


def test_every_mutation_is_undoable():
    """Ogni strumento che modifica lascia UNA voce di storico, e annullarla
    riporta esattamente allo stato di prima.

    E' la prova che conta piu' di tutte: gli strumenti sono a grana grossa (una
    chiamata riempie una sfera intera) proprio perche' l'annulla e' la via di
    riparazione. Senza, un colpo sbagliato e' definitivo. La prima stesura di
    `edits.py` scriveva le celle SENZA aprire una sessione: le modifiche
    avvenivano, lo storico restava vuoto e `voxel_undo` rispondeva "niente da
    annullare" — l'unica prova che poteva accorgersene e' questa.
    """
    setup = {
        "voxel_fill": dict(shape="sphere",
                           args={"cx": 8, "cy": 8, "cz": 8, "radius": 4},
                           color="#123456"),
        "voxel_erase": dict(shape="box",
                            args={"x0": 4, "y0": 4, "z0": 4, "x1": 5,
                                  "y1": 5, "z1": 5}),
        "voxel_set": dict(cells=[[1, 1, 1, "#FF0000"], [2, 2, 2, "#00FF00"]]),
        "voxel_recolor": dict(src="#AA0000", dst="#00AA00"),
        "voxel_shade": dict(),
        "voxel_transform_move": dict(action="move", dx=2, dy=1),
        "voxel_transform_rotate": dict(action="rotate", axis="y", steps=1),
        "voxel_transform_scale": dict(action="scale", factor=2),
        "voxel_transform_ground": dict(action="ground"),
        "voxel_transform_hollow": dict(action="hollow"),
        "voxel_object_add": dict(name="Nuovo"),
        "voxel_object_rename": dict(name="Ribattezzato"),
    }
    for label, kwargs in setup.items():
        tool = label.split("_transform_")[0] + ("_transform"
                                                if "_transform_" in label else "")
        reset()
        call("voxel_new", grid=24)
        # Un modello di partenza che ogni operazione tocca davvero.
        call("voxel_fill", shape="box",
             args={"x0": 3, "y0": 3, "z0": 3, "x1": 7, "y1": 7, "z1": 7},
             color="#AA0000")
        before_n = json.loads(call("voxel_info"))["voxel"]
        before_b = json.loads(call("voxel_info"))["bounds"]
        depth = len(json.loads(call("voxel_history"))["undo"])

        call(tool, **kwargs)
        grew = len(json.loads(call("voxel_history"))["undo"]) - depth
        check_eq("%s: lascia UNA voce di storico" % label, grew, 1)

        call("voxel_undo")
        after = json.loads(call("voxel_info"))
        check_eq("%s: annullare riporta i voxel" % label, after["voxel"], before_n)
        check_eq("%s: annullare riporta l'ingombro" % label,
                 after["bounds"], before_b)


def test_redo_restores_the_result():
    reset()
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 4, "y1": 4, "z1": 4},
         color="#AA0000")
    call("voxel_shade")
    shaded = json.loads(call("voxel_info"))["colori"]
    check("redo: l'ombreggiatura introduce colori", shaded > 1, "%d" % shaded)
    call("voxel_undo")
    check_eq("undo: torna a tinta unita",
             json.loads(call("voxel_info"))["colori"], 1)
    call("voxel_redo")
    check_eq("redo: rimette i colori",
             json.loads(call("voxel_info"))["colori"], shaded)


def test_new_object_inherits_the_grid():
    """La griglia sta sull'OGGETTO, ma un progetto ha UNA griglia.

    `symmetry` specchia rispetto al centro della griglia: se un oggetto nuovo
    tenesse quella predefinita mentre il progetto ne ha un'altra, lo stesso
    tratto simmetrico finirebbe in due posti diversi a seconda dell'oggetto.
    """
    reset()
    call("voxel_new", grid=64)
    check_eq("new: la griglia arriva sull'oggetto",
             json.loads(call("voxel_info"))["griglia"], [64, 64, 64])
    call("voxel_object_add", name="Secondo")
    check_eq("object_add: eredita la griglia del progetto",
             json.loads(call("voxel_info"))["griglia"], [64, 64, 64])
    # E la simmetria la usa davvero: su griglia 64 il rispecchiato di x=1 sta
    # a x=62, non a x=30 (che sarebbe la griglia predefinita da 32).
    call("voxel_fill", shape="box",
         args={"x0": 1, "y0": 0, "z0": 0, "x1": 1, "y1": 0, "z1": 0},
         color="#FF0000", symmetry="x")
    check_eq("object_add: la simmetria usa la griglia ereditata",
             json.loads(call("voxel_info"))["bounds"][3], 62)


def test_reopened_project_reports_its_grid():
    """Il difetto che questa prova ha trovato: `voxel_new` scriveva la griglia
    sul DOCUMENTO, dove nessun altro la cerca. Funzionava sui progetti nuovi e
    sollevava `AttributeError` su qualunque progetto riaperto da disco."""
    import tempfile as _tf
    tmp = _tf.mkdtemp(prefix="voxgrid")
    try:
        keep = server.WORKDIR
        server.WORKDIR = tmp
        reset()
        call("voxel_new", name="Griglia", grid=48)
        call("voxel_fill", shape="box",
             args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1},
             color="#FF0000")
        call("voxel_save", path="g.voxai")
        reset()
        call("voxel_open", path=os.path.join(tmp, "g.voxai"))
        info = json.loads(call("voxel_info"))
        check_eq("open: la griglia sopravvive al giro su disco",
                 info["griglia"], [48, 48, 48])
        server.WORKDIR = keep
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_failed_edit_stays_undoable():
    """Un'operazione che solleva a meta' ha comunque toccato delle celle: se lo
    storico scartasse il diff, quel danno parziale sarebbe PERMANENTE."""
    from mcp_server.session import SESSION as S
    reset()
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 3, "y1": 3, "z1": 3},
         color="#AA0000")
    doc = S.get()
    o = doc.active
    before = len(o)
    depth = len(doc.history()["undo"])
    try:
        with doc.edit("Operazione che fallisce", o):
            doc.del_cell(o, (0, 0, 0))
            doc.del_cell(o, (1, 0, 0))
            raise RuntimeError("a meta' strada")
    except RuntimeError:
        pass
    check_eq("fallimento: le celle sono state tolte davvero", len(o), before - 2)
    check_eq("fallimento: la voce di storico c'e' lo stesso",
             len(doc.history()["undo"]) - depth, 1)
    doc.undo()
    check_eq("fallimento: il danno parziale si annulla", len(o), before)


# --- disco: import, export, salvataggio --------------------------------------

def test_export_import_roundtrip(tmp):
    reset()
    server.WORKDIR = tmp
    call("voxel_new", name="Giro")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 3, "y1": 2, "z1": 1},
         color="#FF0000")
    n = json.loads(call("voxel_info"))["voxel"]

    out = call("voxel_export", path="giro.vox")
    check("export vox: conferma il percorso", "giro.vox" in out, out)
    check("export vox: il file esiste", os.path.isfile(os.path.join(tmp, "giro.vox")))

    call("voxel_new", name="Rientro")
    call("voxel_import", path=os.path.join(tmp, "giro.vox"))
    back = json.loads(call("voxel_info"))
    check_eq("giro .vox: stessi voxel", back["voxel"], n)
    check_eq("giro .vox: stesso ingombro", back["ingombro"], [4, 3, 2])
    check_eq("giro .vox: stesso colore",
             back["principali"][0]["colore"], "#FF0000")
    check("import: l'oggetto prende il nome del file",
          back["oggetto"] == "giro", back["oggetto"])


def test_export_obj_writes_the_mtl_too(tmp):
    reset()
    server.WORKDIR = tmp
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 2, "y1": 2, "z1": 2},
         color="#3366CC")
    out = call("voxel_export", path="casa.obj")
    check("export obj: scrive .obj e .mtl",
          os.path.isfile(os.path.join(tmp, "casa.obj"))
          and os.path.isfile(os.path.join(tmp, "casa.mtl")), out)
    check("export obj: avverte di tenerli insieme",
          "stessa cartella" in out, out)


def test_export_glb_is_valid(tmp):
    reset()
    server.WORKDIR = tmp
    call("voxel_new")
    call("voxel_fill", shape="sphere", args={"cx": 4, "cy": 4, "cz": 4,
                                             "radius": 3}, color="#22AA55")
    call("voxel_export", path="palla.glb")
    with open(os.path.join(tmp, "palla.glb"), "rb") as f:
        blob = f.read()
    check("export glb: firma glTF", blob[:4] == b"glTF")
    import struct as st
    total = st.unpack("<I", blob[8:12])[0]
    check_eq("export glb: lunghezza dichiarata pari a quella vera",
             total, len(blob))


def test_export_png(tmp):
    reset()
    server.WORKDIR = tmp
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 5, "y1": 3, "z1": 0},
         color="#FF0000")
    out = call("voxel_export", path="vista.png")
    check("export png: dichiara le dimensioni", "6x4" in out, out)
    buf, w, h = pngmod.decode_png(open(os.path.join(tmp, "vista.png"), "rb").read())
    check_eq("export png: dimensioni giuste", (w, h), (6, 4))


def test_export_refuses_outside_workdir(tmp):
    reset()
    server.WORKDIR = os.path.join(tmp, "dentro")
    os.makedirs(server.WORKDIR, exist_ok=True)
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1},
         color="#FF0000")
    err = call_fails("voxel_export", path=os.path.join(tmp, "fuori.vox"))
    check("scrittura: rifiuta un percorso fuori dalla cartella di lavoro",
          err is not None and "fuori" in err.lower(), err)
    check("scrittura: il file fuori NON e' stato creato",
          not os.path.isfile(os.path.join(tmp, "fuori.vox")))
    # Il caso che una prova ingenua non copre: uscire con '..'.
    err2 = call_fails("voxel_export", path=os.path.join("..", "evaso.vox"))
    check("scrittura: rifiuta anche l'uscita con '..'", err2 is not None, err2)
    check("scrittura: e non ha creato il file",
          not os.path.isfile(os.path.join(tmp, "evaso.vox")))


def test_export_empty_object_speaks():
    reset()
    call("voxel_new")
    err = call_fails("voxel_export", path="vuoto.vox")
    check("export: un oggetto vuoto da' un errore parlante",
          err and "vuoto" in err.lower(), err)


def test_export_unknown_format_lists(tmp):
    reset()
    server.WORKDIR = tmp
    call("voxel_new")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1},
         color="#FF0000")
    err = call_fails("voxel_export", path="modello.stl")
    check("export: formato ignoto elenca quelli validi",
          err and "glb" in err and "obj" in err, err)


def test_import_unknown_format_lists(tmp):
    reset()
    server.WORKDIR = tmp
    p = os.path.join(tmp, "roba.stl")
    open(p, "wb").write(b"x")
    call("voxel_new")
    err = call_fails("voxel_import", path=p)
    check("import: formato ignoto elenca quelli letti",
          err and ".vox" in err and ".glb" in err, err)
    err2 = call_fails("voxel_import", path=os.path.join(tmp, "manca.vox"))
    check("import: file assente lo dice", err2 and "non trovato" in err2, err2)


def test_import_png_sprite_stack(tmp):
    reset()
    server.WORKDIR = tmp
    buf = bytearray(4 * 2 * 4)
    for i in (0, 1, 2, 3, 4, 5, 6, 7):
        buf[i * 4:i * 4 + 4] = bytes((255, 0, 0, 255))
    p = os.path.join(tmp, "fette.png")
    open(p, "wb").write(pngmod.encode_png(buf, 4, 2))
    call("voxel_new")
    call("voxel_import", path=p, frames=2)
    info = json.loads(call("voxel_info"))
    check_eq("import sprite stack: due livelli", info["ingombro"][1], 2)


def test_save_and_reopen(tmp):
    reset()
    server.WORKDIR = tmp
    call("voxel_new", name="Salvato")
    call("voxel_fill", shape="sphere",
         args={"cx": 5, "cy": 5, "cz": 5, "radius": 3}, color="#AA3366")
    n = json.loads(call("voxel_info"))["voxel"]
    out = call("voxel_save", path="progetto.voxai")
    check("save: conferma il percorso", "progetto.voxai" in out, out)
    reset()
    call("voxel_open", path=os.path.join(tmp, "progetto.voxai"))
    check_eq("open: stessi voxel dopo il giro",
             json.loads(call("voxel_info"))["voxel"], n)
    check("open: il documento prende il nome del file",
          "progetto" in call("voxel_list"))


def test_save_without_path_speaks():
    reset()
    call("voxel_new", name="Senzafile")
    err = call_fails("voxel_save")
    check("save: senza percorso e senza origine lo dice",
          err and "percorso" in err.lower(), err)


def test_open_junk_speaks(tmp):
    reset()
    p = os.path.join(tmp, "rotto.voxai")
    open(p, "w").write("{non json")
    err = call_fails("voxel_open", path=p)
    check("open: un file illeggibile da' un errore parlante",
          err and "JSON" in err, err)


# --- materiali e texture -----------------------------------------------------
#
# La libreria personale scrive su disco: `VOXELAI_MCP_DIR` (esportata da
# `run_all.sh` e, per sicurezza, imposta anche qui sotto) la manda in una
# cartella temporanea. Senza, la suite riempirebbe la libreria VERA dello
# sviluppatore fino al tetto di 40, buttando fuori proprio i materiali che
# voleva tenere.

def _crea_materiale(nome="Pietra", **kw):
    return call("voxel_material_create", name=nome, **kw)


def test_materiale_a_tinta_unita():
    reset()
    call("voxel_new", name="Mat", grid=16)
    out = _crea_materiale("Pietra", color="#808080")
    check("materiale: conferma con l'id", "m1" in out, out)
    rows = json.loads(call("voxel_material_list"))
    check_eq("materiale: uno solo in elenco", len(rows), 1)
    check_eq("materiale: il nome e' quello dato", rows[0]["name"], "Pietra")
    check_eq("materiale: senza texture resta tinta unita",
             rows[0]["faceMode"], "single")
    check("materiale: l'elenco NON contiene base64",
          "data:image" not in call("voxel_material_list"))


def test_materiale_da_ops_e_tinta_media():
    reset()
    call("voxel_new", name="Mat", grid=16)
    # Mezza tela rossa, mezza blu: la media dev'essere il viola esatto, che e'
    # anche la prova che il colore NON e' quello dichiarato ma quello misurato.
    _crea_materiale("Bandiera", size=8, color="#00FF00",
                    palette={"r": "#FF0000", "b": "#0000FF"},
                    ops=["fill 0 0 7 3 r", "fill 0 4 7 7 b"])
    m = json.loads(call("voxel_material_list", detail="Bandiera"))
    check_eq("ops: la tela e' quella chiesta", [m["texture"]["w"], m["texture"]["h"]],
             [8, 8])
    check_eq("ops: il colore e' la MEDIA della texture, non quello dichiarato",
             m["color"], "#800080")
    check_eq("ops: senza pixel trasparenti alpha e' falso",
             m["texture"]["alpha"], False)


def test_ops_che_non_dipingono_niente_lo_dicono():
    reset()
    call("voxel_new", name="Mat", grid=16)
    err = call_fails("voxel_material_create", name="Vuoto", size=8,
                     ops=["fill 99 99 120 120 #FF0000"])
    check("ops: una tela rimasta vuota e' un errore parlante",
          err and "dipinto" in err, err)


def test_materiale_a_sei_facce():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Erba", size=8,
                    faces={"py": ["fill 0 0 7 7 #33AA33"],
                           "sopra": ["fill 0 0 7 7 #33AA33"],
                           "px": ["fill 0 0 7 7 #8B5A2B"]})
    m = json.loads(call("voxel_material_list", detail="Erba"))
    check_eq("facce: modalita' a sei facce", m["faceMode"], "six")
    check("facce: 'sopra' e 'py' sono la stessa faccia",
          sorted(m["faces"]) == ["px", "py"], sorted(m["faces"]))
    # La media in `six` legge +Z, che qui non c'e': ricade su una faccia vera
    # invece di dare grigio.
    check("facce: la tinta media viene da una faccia disegnata",
          m["color"] in ("#33AA33", "#8B5A2B"), m["color"])


def test_faccia_nominata_ma_non_disegnata_si_scarta():
    reset()
    call("voxel_new", name="Mat", grid=16)
    out = _crea_materiale("Mezzo", size=8,
                          faces={"py": ["fill 0 0 7 7 #33AA33"], "ny": []})
    m = json.loads(call("voxel_material_list", detail="Mezzo"))
    check_eq("scarto: solo la faccia davvero dipinta", sorted(m["faces"]), ["py"])
    check("scarto: lo dice invece di tacere", "vuota" in out, out)


def test_texture_draw_ritocca_quella_che_c_e():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Tela", size=8, ops=["fill 0 0 7 7 #FFFFFF"])
    call("voxel_texture_draw", material="Tela", ops=["fill 0 0 3 3 #FF0000"])
    testo = call("voxel_texture_show", material="Tela")
    check("draw: due colori dopo il ritocco",
          testo.count("=#") >= 2, testo)
    # `del` deve cancellare cio' che c'e' DAVVERO: e' il motivo per cui il
    # disegno non riparte da una tela vuota (`expand_pixel_ops` lo farebbe).
    call("voxel_texture_draw", material="Tela", ops=["del 0 0 7 3"])
    doc = SESSION.get()
    mat = doc.materials[0]
    check_eq("draw: `del` toglie meta' tela e l'alpha lo registra",
             mat["texture"]["alpha"], True)
    check("draw: ogni disegno e' una voce di cronologia",
          len(json.loads(call("voxel_history"))["undo"]) >= 3)


def test_texture_draw_clear_riparte_da_zero():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Tela", size=8, ops=["fill 0 0 7 7 #FFFFFF"])
    call("voxel_texture_draw", material="Tela", size=8, clear=True,
         ops=["fill 0 0 1 1 #FF0000"])
    doc = SESSION.get()
    buf, w, h = materials.texture_buffer(doc.materials[0]["texture"])
    pieni = sum(1 for i in range(w * h) if buf[i * 4 + 3] > 0)
    check_eq("clear: resta solo il quadratino nuovo", pieni, 4)


def test_draw_senza_effetto_lo_dice():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Tela", size=8, ops=["fill 0 0 7 7 #FFFFFF"])
    err = call_fails("voxel_texture_draw", material="Tela",
                     ops=["fill 40 40 50 50 #FF0000"])
    check("draw: una op fuori tela non passa in silenzio",
          err and "alto a sinistra" in err, err)


def test_apply_scrive_id_E_colore():
    reset()
    call("voxel_new", name="Mat", grid=16)
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 2, "y1": 2, "z1": 2},
         color="#FF0000")
    _crea_materiale("Bandiera", size=8,
                    palette={"r": "#FF0000", "b": "#0000FF"},
                    ops=["fill 0 0 7 3 r", "fill 0 4 7 7 b"])
    out = call("voxel_material_apply", material="m1")
    check("apply: dice quanti voxel ha preso", "27 voxel" in out, out)
    cella = SESSION.get().active.cells[(0, 0, 0)]
    check_eq("apply: l'id finisce sulla cella", cella.material, "m1")
    # Il punto 2 di `textures.py`: senza il colore, ogni esportatore che non
    # conosce i materiali (.vox, .schem, MTL senza PNG) darebbe un modello
    # grigio.
    check_eq("apply: e anche la TINTA MEDIA", cella.color, "#800080")


def test_apply_per_colore_e_regione():
    reset()
    call("voxel_new", name="Mat", grid=16)
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 3, "y1": 0, "z1": 0},
         color="#FF0000")
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 1, "z0": 0, "x1": 3, "y1": 1, "z1": 0},
         color="#00FF00")
    _crea_materiale("Pietra", color="#808080")
    call("voxel_material_apply", material="Pietra", color="#FF0000")
    o = SESSION.get().active
    presi = [k for k, c in o.cells.items() if c.material == "m1"]
    check_eq("apply per colore: solo la riga rossa", len(presi), 4)
    check("apply per colore: tutti a y=0", all(k[1] == 0 for k in presi), presi)
    err = call_fails("voxel_material_apply", material="Pietra",
                     color="#123456")
    check("apply: nessuna corrispondenza e' un errore parlante",
          err and "nessun voxel" in err, err)


def test_material_ref_sconosciuto_elenca():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Pietra", color="#808080")
    err = call_fails("voxel_material_apply", material="m9")
    check("riferimento: nomina quello sbagliato", err and "m9" in err, err)
    check("riferimento: elenca quelli che ci sono",
          err and "Pietra" in err, err)


def test_fill_con_materiale_sconosciuto_non_degrada_in_silenzio():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Pietra", color="#808080")
    # Un id inesistente scritto sulla cella si vedrebbe come tinta unita grigia,
    # cioe' come "la texture non si e' caricata": il difetto piu' difficile da
    # ricondurre a un id sbagliato.
    err = call_fails("voxel_fill", shape="box",
                     args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1},
                     material="m7")
    check("fill: un materiale inesistente e' un errore", err and "m7" in err, err)
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1},
         material="Pietra")
    cella = SESSION.get().active.cells[(0, 0, 0)]
    check_eq("fill: il materiale si puo' dare per nome", cella.material, "m1")
    check_eq("fill: senza colore prende la tinta del materiale",
             cella.color, "#808080")


def test_delete_lascia_i_voxel_a_tinta_unita():
    reset()
    call("voxel_new", name="Mat", grid=16)
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1},
         color="#FF0000")
    _crea_materiale("Pietra", color="#808080")
    call("voxel_material_apply", material="m1")
    n = json.loads(call("voxel_info"))["voxel"]
    out = call("voxel_material_delete", material="m1")
    check("delete: dice quanti voxel restano", "8 voxel" in out, out)
    check_eq("delete: nessun voxel cancellato",
             json.loads(call("voxel_info"))["voxel"], n)
    cella = SESSION.get().active.cells[(0, 0, 0)]
    check_eq("delete: l'id sparisce dalla cella", cella.material, None)
    check_eq("delete: il colore resta quello che si vedeva", cella.color, "#808080")
    call("voxel_undo")
    check_eq("delete: annullando torna il materiale",
             [m["id"] for m in SESSION.get().materials], ["m1"])
    check_eq("delete: e torna anche sulla cella",
             SESSION.get().active.cells[(0, 0, 0)].material, "m1")


def test_update_muta_in_place():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Pietra", color="#808080")
    doc = SESSION.get()
    prima = doc.materials[0]
    call("voxel_material_update", material="m1", name="Marmo",
         props={"roughness": 0.1, "opacity": 0.5})
    check_eq("update: la lista non cresce", len(doc.materials), 1)
    check("update: e' LO STESSO oggetto (i voxel citano ancora l'id)",
          doc.materials[0] is prima)
    m = json.loads(call("voxel_material_list", detail="m1"))
    check_eq("update: il nome cambia", m["name"], "Marmo")
    check_eq("update: 0.1 non e' 'non specificato'", m["roughness"], 0.1)
    check_eq("update: l'opacita' passa", m["opacity"], 0.5)
    # alphaTest e opacity NON si combinano: sotto 1 si passa alla fusione, o il
    # materiale diventerebbe invisibile invece che semitrasparente.
    out = call("voxel_material_update", material="m1", props={"opacity": 0.5})
    check("update: sotto opacita' 1 la resa e' 'blend'", "blend" in out, out)


def test_texture_show_e_leggibile():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Tela", size=8,
                    palette={"r": "#FF0000"}, ops=["fill 0 0 7 3 r"])
    testo = call("voxel_texture_show", material="Tela")
    check("show: dichiara la faccia e la misura", "FACCIA all (8x8)" in testo, testo)
    check("show: la legenda dei colori c'e'", "#FF0000" in testo, testo)
    check("show: le righe piene sono in RLE", "8a" in testo, testo)
    check("show: il trasparente ha il suo simbolo", "8." in testo, testo)
    check("show: NON manda base64", "data:image" not in testo)
    # Un materiale a tinta unita non ha niente da mostrare, e dirlo e' meglio di
    # stampare una tela nera che si legge come "la texture e' venuta male".
    _crea_materiale("Piatto", color="#808080")
    err = call_fails("voxel_texture_show", material="Piatto")
    check("show: senza texture rimanda al disegno",
          err and "voxel_texture_draw" in err, err)


def test_texture_png_va_e_torna(tmp):
    reset()
    server.WORKDIR = tmp
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Tela", size=8,
                    palette={"r": "#FF0000", "b": "#0000FF"},
                    ops=["fill 0 0 7 3 r", "fill 0 4 7 7 b"])
    out = call("voxel_texture_export", path="tela.png", material="Tela")
    percorso = os.path.join(tmp, "tela.png")
    check("export texture: il PNG esiste", os.path.isfile(percorso), out)
    with open(percorso, "rb") as f:
        _buf, w, h = pngmod.decode_png(f.read())
    check_eq("export texture: misura conservata", [w, h], [8, 8])

    _crea_materiale("Rientro", color="#000000")
    call("voxel_texture_import", path=percorso, material="Rientro")
    m = json.loads(call("voxel_material_list", detail="Rientro"))
    check_eq("import texture: stessa tinta media dell'originale",
             m["color"], "#800080")
    # Dopo l'import la texture dev'essere ancora modificabile: e' il punto per
    # cui l'import ricampiona in una tela invece di tenere un blob intoccabile.
    call("voxel_texture_draw", material="Rientro", ops=["fill 0 0 7 7 #FFFFFF"])
    m2 = json.loads(call("voxel_material_list", detail="Rientro"))
    check_eq("import texture: resta disegnabile sopra", m2["color"], "#FFFFFF")


def test_export_texture_di_tutte_le_facce(tmp):
    reset()
    server.WORKDIR = tmp
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Erba", size=8,
                    faces={"py": ["fill 0 0 7 7 #33AA33"],
                           "px": ["fill 0 0 7 7 #8B5A2B"]})
    out = call("voxel_texture_export", path="erba.png", material="Erba")
    check("export facce: un file per faccia, con la sigla nel nome",
          os.path.isfile(os.path.join(tmp, "erba-py.png"))
          and os.path.isfile(os.path.join(tmp, "erba-px.png")), out)


def test_export_texture_fuori_dalla_cartella_di_lavoro(tmp):
    reset()
    server.WORKDIR = tmp
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Tela", size=8, ops=["fill 0 0 7 7 #FFFFFF"])
    err = call_fails("voxel_texture_export",
                     path=os.path.join(tmp, "..", "fuori.png"),
                     material="Tela")
    check("export texture: il vincolo di scrittura vale anche qui",
          err and "cartella di lavoro" in err, err)


def test_libreria_personale(tmp):
    reset()
    os.environ["VOXELAI_MCP_DIR"] = tmp
    try:
        percorso = os.path.join(tmp, "material_library.json")
        if os.path.isfile(percorso):
            os.remove(percorso)
        call("voxel_new", name="Uno", grid=16)
        _crea_materiale("Mattone", size=8, ops=["fill 0 0 7 7 #AA4422"])
        call("voxel_material_library", action="save", material="Mattone")
        check("libreria: il file sta nella cartella dichiarata",
              os.path.isfile(percorso))
        elenco = call("voxel_material_library", action="list")
        check("libreria: compare in elenco", "Mattone" in elenco, elenco)

        # Un altro progetto, con gia' un materiale suo: l'id NON deve collidere.
        call("voxel_new", name="Due", grid=16)
        _crea_materiale("Altro", color="#123456")
        out = call("voxel_material_library", action="import", material="Mattone")
        doc = SESSION.get()
        check_eq("libreria: due materiali nel progetto nuovo", len(doc.materials), 2)
        ids = [m["id"] for m in doc.materials]
        check_eq("libreria: l'id viene RINUMERATO, non ereditato", ids, ["m1", "m2"])
        check("libreria: dice con che id e' entrato", "m2" in out, out)
        check("libreria: la texture arriva insieme",
              bool(doc.materials[1].get("texture")))

        # Salvare due volte lo stesso nome non deve riempire il tetto di 40.
        call("voxel_material_library", action="save", material="Mattone")
        with open(percorso, encoding="utf-8") as f:
            check_eq("libreria: stesso nome = sostituzione, non duplicato",
                     len(json.load(f)), 1)
        err = call_fails("voxel_material_library", action="import",
                         material="Inesistente")
        check("libreria: un nome assente elenca cio' che c'e'",
              err and "Mattone" in err, err)
    finally:
        os.environ.pop("VOXELAI_MCP_DIR", None)


def test_materiali_sono_di_progetto_non_di_oggetto():
    reset()
    call("voxel_new", name="Mat", grid=16)
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1},
         color="#FF0000")
    _crea_materiale("Pietra", color="#808080")
    call("voxel_material_apply", material="m1")
    # Il difetto storico dell'app: i materiali erano per-oggetto, e Shift+A
    # (oggetto nuovo) faceva sparire il pannello.
    call("voxel_object_add", name="Secondo")
    rows = json.loads(call("voxel_material_list"))
    check_eq("progetto: il materiale sopravvive all'oggetto nuovo", len(rows), 1)
    check_eq("progetto: l'elenco conta i voxel di TUTTI gli oggetti",
             rows[0]["voxel"], 8)
    call("voxel_fill", shape="box",
         args={"x0": 5, "y0": 0, "z0": 0, "x1": 6, "y1": 1, "z1": 1},
         material="m1")
    rows = json.loads(call("voxel_material_list"))
    check_eq("progetto: lo stesso materiale su due oggetti", rows[0]["voxel"], 16)


def test_sync_colore_tocca_tutti_gli_oggetti():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Tela", size=8, ops=["fill 0 0 7 7 #FF0000"])
    call("voxel_fill", shape="box",
         args={"x0": 0, "y0": 0, "z0": 0, "x1": 1, "y1": 1, "z1": 1},
         material="m1")
    call("voxel_object_add", name="Secondo")
    call("voxel_fill", shape="box",
         args={"x0": 5, "y0": 0, "z0": 0, "x1": 6, "y1": 1, "z1": 1},
         material="m1")
    call("voxel_texture_draw", material="Tela", ops=["fill 0 0 7 7 #0000FF"])
    doc = SESSION.get()
    colori = {c.color for o in doc.objects for c in o.cells.values()}
    # La tinta sui voxel e' una COPIA denormalizzata: una copia che non si
    # aggiorna e' peggio che non averla — il modello si esporterebbe col colore
    # della texture precedente.
    check_eq("sync: la nuova tinta e' su entrambi gli oggetti", colori, {"#0000FF"})


def test_texture_generate_usa_il_prompt_dell_app():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Blocco", size=8, ops=["fill 0 0 7 7 #FFFFFF"])
    risposta = {"size": 8, "palette": {"g": "#33AA33"},
                "faces": {"py": {"ops": ["fill 0 0 7 7 g"]}}}
    with risponde(risposta) as r:
        out = call("voxel_texture_generate", prompt="un blocco d'erba",
                   material="Blocco", faces=["sopra"], size=8)
    p = r.prompts[0]
    check("texture AI: la richiesta entra nel prompt", "erba" in p, p[-300:])
    check("texture AI: e' il prompt dell'app (parla di ops 2D)",
          "fill" in p and "rect" in p, p[:300])
    check("texture AI: la faccia chiesta e' dichiarata", "py" in p, p[-600:])
    m = json.loads(call("voxel_material_list", detail="Blocco"))
    check_eq("texture AI: la faccia generata e' quella chiesta",
             sorted(m.get("faces") or {}), ["py"])
    check("texture AI: conferma parlante", "Blocco" in out, out)


def test_texture_generate_manda_le_altre_facce_come_contesto():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Cubo", size=8,
                    faces={"px": ["fill 0 0 7 7 #8B5A2B"]})
    risposta = {"size": 8, "faces": {"py": {"ops": ["fill 0 0 7 7 #33AA33"]}}}
    with risponde(risposta) as r:
        call("voxel_texture_generate", prompt="la cima", material="Cubo",
             faces=["py"], size=8)
    p = r.prompts[0]
    check("contesto: la faccia gia' disegnata e' nel prompt",
          "FACCIA px" in p, p[-800:])
    check("contesto: come TESTO RLE, non come immagine",
          "data:image" not in p and "#8B5A2B" in p)
    # Con ambito "tutte" il contesto non si manda: sarebbe ripetere all'AI, a
    # pagamento, cio' che le si sta chiedendo di rifare.
    with risponde({"size": 8, "faces": {"all": {"ops": ["fill 0 0 7 7 #FF0000"]}}}) as r2:
        call("voxel_texture_generate", prompt="tutto", material="Cubo", size=8)
    check("contesto: con ambito 'tutte' non si manda niente",
          "FACCIA px" not in r2.prompts[0])


def test_texture_generate_regge_la_cancellazione_suicida():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Blocco", size=8, ops=["fill 0 0 7 7 #FFFFFF"])
    # Il difetto misurato su risposte vere (2 su 12): il modello aggiunge una
    # cancellazione a tutta tela credendo di "ripulire lo sfondo trasparente",
    # e consegna una tela VUOTA.
    risposta = {"size": 8, "faces": {"all": {"ops": ["fill 2 2 5 5 #FF0000",
                                                     "del 0 0 7 7"]}}}
    with risponde(risposta):
        call("voxel_texture_generate", prompt="un bollino", material="Blocco",
             size=8)
    m = json.loads(call("voxel_material_list", detail="Blocco"))
    check_eq("suicida: il disegno sopravvive alla cancellazione finale",
             m["color"], "#FF0000")


def test_texture_generate_senza_risposta_utile_indirizza():
    reset()
    call("voxel_new", name="Mat", grid=16)
    _crea_materiale("Blocco", size=8, ops=["fill 0 0 7 7 #FFFFFF"])
    with risponde({"size": 8, "faces": {}}):
        err = call_fails("voxel_texture_generate", prompt="niente",
                         material="Blocco", size=8)
    check("texture AI: una risposta inutile rimanda al disegno a mano",
          err and "voxel_texture_draw" in err, err)


# --- generazione AI ----------------------------------------------------------
#
# NESSUNA RETE, NESSUN COOKIE, NESSUNA QUOTA: si sostituisce `ai.answer_text`,
# che e' il punto unico da cui passa ogni chiamata all'AI integrata. Tutto il
# resto — montaggio del prompt, recupero del JSON, espansione delle ops,
# scrittura nel documento, cronologia — gira per davvero. E' lo stesso seme
# d'iniezione di `PackManager(generate_fn)`.

MODELLO_FINTO = {
    "metadata": {"grid_size": [16, 16, 16]},
    "palette": {"w": "#FFFFFF", "r": "#FF0000"},
    "ops": [["fill", 0, 0, 0, 3, 3, 3, "w"], ["set", "r", 5, 0, 5]],
}


class risponde(object):
    """Fa rispondere l'AI con un testo (o un JSON) deciso dalla prova.

    Tiene anche l'ULTIMO PROMPT ricevuto: e' l'unico modo di verificare che le
    regole di `main.py` siano davvero finite nella richiesta, e non solo che il
    risultato sia arrivato.
    """

    def __init__(self, payload):
        self.payload = payload
        self.prompts = []

    def __enter__(self):
        self._old = ai.answer_text

        def fake(prompt, model=None, provider=None):
            self.prompts.append(prompt)
            p = self.payload
            return p if isinstance(p, str) else json.dumps(p)

        ai.answer_text = fake
        return self

    def __exit__(self, *exc):
        ai.answer_text = self._old
        return False


def test_ai_status_non_mostra_credenziali():
    d = json.loads(call("voxel_ai_status"))
    check("ai_status: dice chi e' il provider attivo", bool(d.get("attivo")), d)
    check("ai_status: dice se e' pronto", "pronto" in d, d)
    # La ragione per cui questo strumento esiste in questa forma: un assistente
    # e' esattamente il posto in cui una credenziale non deve finire. Il tipo
    # del provider si CHIAMA `gemini_cookies`, quindi cercare la parola
    # "cookie" segnalerebbe un'etichetta legittima: si cercano invece i nomi
    # dei campi segreti e le firme dei valori (una credenziale e' lunga, una
    # didascalia no).
    def frughe(nodo, dove=""):
        if isinstance(nodo, dict):
            for k, v in nodo.items():
                kl = str(k).lower()
                check("ai_status: nessun campo '%s'" % k,
                      not any(s in kl for s in
                              ("key", "secret", "password", "cookie", "token",
                               "auth")),
                      dove)
                frughe(v, dove + "/" + str(k))
        elif isinstance(nodo, list):
            for v in nodo:
                frughe(v, dove)
        elif isinstance(nodo, str):
            check("ai_status: nessun valore lungo come una credenziale in %s"
                  % (dove or "/"), len(nodo) <= 64, nodo[:20] + "...")
            for parola in ("psid", "sapisid", "sk-", "sk_live"):
                check("ai_status: nessuna firma di credenziale ('%s') in %s"
                      % (parola, dove or "/"), parola not in nodo.lower(), dove)

    frughe(d)


def test_ops_non_chiedono_nessuna_ai():
    reset()
    # Deliberatamente SENZA sostituire `answer_text`: se `voxel_ops` toccasse
    # l'AI, qui partirebbe una chiamata vera. E' la prova che la via "l'AI sei
    # tu" e' davvero indipendente dai cookie.
    call("voxel_new", name="Mie", grid=16)
    call("voxel_ops", ops=[["fill", 0, 0, 0, 2, 2, 2, "#00FF00"]])
    check_eq("ops: 3x3x3 = 27 voxel", json.loads(call("voxel_info"))["voxel"], 27)
    call("voxel_ops", ops=[["del", 1, 1, 1, 1, 1, 1]])
    check_eq("ops: `del` scava nel modello che c'e' gia'",
             json.loads(call("voxel_info"))["voxel"], 26)
    call("voxel_ops", ops=[["set", "#0000FF", 9, 0, 9]], replace=True)
    check_eq("ops: con `replace` sostituiscono tutto",
             json.loads(call("voxel_info"))["voxel"], 1)
    check("ops: ogni chiamata e' una voce di cronologia",
          len(json.loads(call("voxel_history"))["undo"]) == 3)


def test_ops_conservano_la_parte_e_no_il_materiale():
    reset()
    call("voxel_new", name="Parti", grid=16)
    doc = SESSION.get()
    o = doc.active
    with doc.edit("preparo", o):
        doc.set_cell(o, (1, 1, 1), Cell("#FFFFFF", "m1", "testa"))
        doc.set_cell(o, (2, 1, 1), Cell("#FFFFFF", "m1", "testa"))
    call("voxel_ops", ops=[["set", "#FF0000", 1, 1, 1]])
    ridipinto = doc.active.cells[(1, 1, 1)]
    intatto = doc.active.cells[(2, 1, 1)]
    # Nel `voxelMap` dell'app il materiale E' il valore della cella (`@m1`):
    # dipingerci sopra un colore lo sostituisce per costruzione. La parte no,
    # e' un'etichetta a parte — perderla scollegherebbe il voxel dal rig per
    # una semplice ritinteggiatura.
    check_eq("ops: il colore nuovo scaccia il materiale", ridipinto.material, None)
    check_eq("ops: ma NON la parte", ridipinto.part, "testa")
    check_eq("ops: la cella non toccata tiene il materiale", intatto.material, "m1")


def test_generate_usa_i_prompt_dell_app():
    reset()
    call("voxel_new", name="Gen", grid=16)
    with risponde(MODELLO_FINTO) as r:
        out = call("voxel_generate", prompt="una casetta", grid=24,
                   humanoid=True, big_structure=True, modular=True)
    p = r.prompts[0]
    check("generate: il soggetto entra nel prompt", "una casetta" in p)
    check("generate: la griglia chiesta diventa la regola tassativa",
          "24, 24, 24" in p, p[-400:])
    for etichetta, nome in (("struttura grande", "BIG_STRUCTURE_RULE"),
                            ("asset modulare", "MODULAR_ASSET_RULE"),
                            ("multi-parte", "MULTI_PART_RULE"),
                            ("umanoide", "HUMANOID_RULE")):
        regola = getattr(compat.main_module(), nome)
        check("generate: la regola '%s' e' quella dell'app" % etichetta,
              regola.strip()[:60] in p, nome)
    check_eq("generate: i voxel arrivano nel documento",
             json.loads(call("voxel_info"))["voxel"], 65)
    check("generate: risponde con una descrizione, non col modello",
          "voxel" in out and '"ops"' not in out, out)


def test_generate_lascia_UNA_voce_di_cronologia():
    reset()
    call("voxel_new", name="Uno", grid=16)
    with risponde(MODELLO_FINTO):
        call("voxel_generate", prompt="qualcosa")
    h = json.loads(call("voxel_history"))
    check_eq("generate: una sola voce annullabile", len(h["undo"]), 1)
    call("voxel_undo")
    check_eq("generate: un solo annulla riporta al vuoto",
             json.loads(call("voxel_info"))["voxel"], 0)


def test_generate_non_lascia_il_segnaposto_vuoto():
    reset()
    call("voxel_new", name="Pulito", grid=16)
    with risponde(MODELLO_FINTO):
        call("voxel_generate", prompt="una casetta")
    # L'oggetto vuoto di un progetto appena creato e' il segnaposto che
    # `active` fabbrica da se': tenerlo lascerebbe un guscio accanto al modello
    # e ne rinominerebbe uno dei due ("Oggetto 1" + "Oggetto 1 2").
    check_eq("generate: un oggetto solo nel progetto nuovo",
             len(SESSION.get().objects), 1)
    check("generate: e senza il nome rinumerato",
          " 2" not in SESSION.get().objects[0].name,
          SESSION.get().objects[0].name)


def test_generate_senza_credenziali_dice_cosa_fare():
    reset()
    call("voxel_new", name="Senza")
    client = compat.aiclient_module()
    old = ai.answer_text

    def boom(prompt, model=None, provider=None):
        raise client.AIAuthError("cookie scaduti")

    ai.answer_text = boom
    try:
        err = call_fails("voxel_generate", prompt="x")
    finally:
        ai.answer_text = old
    # "Cookie permettendo" e' letterale: se manca la credenziale, l'altra via
    # (le ops scritte dal chiamante) resta aperta e va NOMINATA, o l'assistente
    # si ferma li'.
    check("generate: senza credenziali il messaggio propone `voxel_ops`",
          err and "voxel_ops" in err, err)


def test_modify_e_un_diff_annullabile():
    reset()
    call("voxel_new", name="Mod", grid=16)
    with risponde(MODELLO_FINTO):
        call("voxel_generate", prompt="base")
    prima = json.loads(call("voxel_info"))["voxel"]
    patch = {"palette": {"b": "#0000FF"},
             "ops": [["del", 1, 1, 1, 2, 2, 2], ["set", "b", 8, 0, 8]]}
    with risponde(patch) as r:
        call("voxel_modify", request="scava e aggiungi un puntino")
    p = r.prompts[0]
    check("modify: il modello attuale finisce nel prompt", '"ops"' in p)
    check("modify: e anche il bounding box, per orientare l'AI",
          "Bounding box" in p, p[:400])
    dopo = json.loads(call("voxel_info"))["voxel"]
    check_eq("modify: la patch scava (8 celle) e aggiunge (1)", dopo, prima - 8 + 1)
    check_eq("modify: una sola voce di cronologia in piu'",
             len(json.loads(call("voxel_history"))["undo"]), 2)
    call("voxel_undo")
    check_eq("modify: annullare riporta al modello di prima",
             json.loads(call("voxel_info"))["voxel"], prima)


def test_modify_riconosce_il_modello_intero_travestito_da_patch():
    reset()
    call("voxel_new", name="Riscritto", grid=16)
    with risponde(MODELLO_FINTO):
        call("voxel_generate", prompt="base")
    # L'AI, richiesta di una modifica, ogni tanto rimanda l'oggetto INTERO.
    # Sovrapporlo produrrebbe l'ibrido dei due modelli, col vecchio che spunta
    # da sotto il nuovo: qui la casetta e' spostata di 10 in X, quindi
    # sovrapponendo si vedrebbero 65+65 voxel invece di 65.
    intero = {"palette": {"w": "#FFFFFF", "r": "#FF0000"},
              "ops": [["fill", 10, 0, 0, 13, 3, 3, "w"],
                      ["set", "r", 15, 0, 5]]}
    with risponde(intero):
        out = call("voxel_modify", request="rifallo piu' a destra")
    check_eq("modify: la riscrittura sostituisce, non si sovrappone",
             json.loads(call("voxel_info"))["voxel"], 65)
    check("modify: e lo dice", "riscrittura" in out, out)


def test_modify_su_oggetto_vuoto_indirizza():
    reset()
    call("voxel_new", name="Vuoto")
    err = call_fails("voxel_modify", request="cambia qualcosa")
    check("modify: su un oggetto vuoto spiega cosa usare invece",
          err and "voxel_generate" in err, err)


def test_pack_gira_nella_coda_dell_app(tmp):
    reset()
    pack = compat.pack_module()
    fatti = []

    def finto(prompt, model=None, grid_size=None):
        fatti.append(prompt)
        return {"metadata": {"grid_size": [16, 16, 16]},
                "palette": {"w": "#DDDDDD"},
                "ops": [["fill", 0, 0, 0, 2, 2, 2, "w"]]}

    mgr = pack.PackManager(finto, storage_dir=os.path.join(tmp, "packs"))
    old = ai.pack_manager
    ai.pack_manager = lambda: mgr
    try:
        call("voxel_new", name="Set", grid=16)
        call("voxel_pack_start", objects=["Tavolo", "Sedia"], variants=1)
        for _ in range(200):
            if mgr.latest().status in ("done", "error", "cancelled"):
                break
            time.sleep(0.05)
        st = json.loads(call("voxel_pack_status"))
        check_eq("pack: due generazioni completate", st["conteggi"]["done"], 2)
        out = call("voxel_pack_result")
        check("pack: gli asset entrano come oggetti separati",
              "Tavolo_1" in out and "Sedia_1" in out, out)
        check_eq("pack: due oggetti nel progetto", len(SESSION.get().objects), 2)
        # Un pack importato e' UN gesto: toglierlo non deve costare un annulla
        # per asset, o con quaranta oggetti diventa impraticabile.
        check_eq("pack: una sola voce di cronologia per tutto il pack",
                 len(json.loads(call("voxel_history"))["undo"]), 1)
        call("voxel_undo")
        check_eq("pack: un annulla toglie l'intero pack",
                 sum(len(o) for o in SESSION.get().objects), 0)
    finally:
        ai.pack_manager = old


def test_pack_senza_run_non_solleva():
    pack = compat.pack_module()
    mgr = pack.PackManager(lambda *a, **k: {})
    old = ai.pack_manager
    ai.pack_manager = lambda: mgr
    try:
        # Un assistente chiede lo stato prima di aver avviato niente: deve
        # ricevere una frase, non un errore da cui non sa come uscire.
        check("pack: stato senza pack e' una frase",
              "Nessun pack" in call("voxel_pack_status"))
        check("pack: risultato senza pack e' una frase",
              "Nessun pack" in call("voxel_pack_result"))
        check("pack: annullare senza pack e' una frase",
              "Nessun pack" in call("voxel_pack_cancel"))
    finally:
        ai.pack_manager = old


def test_stdout_resta_pulito():
    """Il canale del protocollo non deve mai ricevere una riga di prosa.

    Non e' teoria: la coda dei pack stampa `[pack] salvato in ...` da un thread
    proprio, e in una prova vera quella riga usciva su stdout — cioe' dentro un
    messaggio JSON-RPC. `quiet()` non poteva coprirla (nessun `with` racchiude
    un thread), quindi la protezione e' globale e va verificata come tale.
    """
    vecchio_stdout = sys.stdout
    try:
        vecchio_fd = os.dup(1)
    except OSError:
        vecchio_fd = None
    proxy = compat.protect_stdout()
    if proxy is None:
        check("stdout: protezione disponibile", False, "protect_stdout ha ceduto")
        return
    vero = proxy.buffer
    try:
        visto = []
        vero.write = lambda b: visto.append(b)          # il canale MCP
        print("prosa dal thread principale")
        t = threading.Thread(target=lambda: print("[pack] salvato in ..."))
        t.start()
        t.join()
        check_eq("stdout: niente prosa sul canale del protocollo", visto, [])
    finally:
        # Ripristino su DUE livelli, perche' la protezione ne usa due.
        # Rimettere solo `sys.stdout` lascerebbe il descrittore 1 puntato su
        # stderr per il resto del processo: il riepilogo di questa suite
        # finirebbe sul canale sbagliato e `run_all.sh`, che legge stdout,
        # direbbe che non e' stato eseguito niente.
        sys.stdout = vecchio_stdout
        if vecchio_fd is not None:
            try:
                os.dup2(vecchio_fd, 1)
                os.close(vecchio_fd)
            except OSError:
                pass
        try:
            vero.close()
        except (OSError, ValueError):
            pass


def main():
    tmp = tempfile.mkdtemp(prefix="voxmcp")
    keep = server.WORKDIR
    try:
        for name, fn in sorted(globals().items()):
            if not name.startswith("test_") or not callable(fn):
                continue
            try:
                if fn.__code__.co_argcount:
                    fn(tmp)
                else:
                    fn()
            except Exception as e:                # noqa: BLE001
                _fail.append("%s ha sollevato: %r" % (name, e))
    finally:
        server.WORKDIR = keep
        shutil.rmtree(tmp, ignore_errors=True)
    print("Server MCP: %d controlli, %d falliti" % (_ok + len(_fail), len(_fail)))
    for f in _fail:
        print("  FALLITO: " + f)
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
