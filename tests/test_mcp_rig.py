"""Prove del rig dell'MCP: i sei invarianti del GLB, misurati sul file vero.

Perche' esiste separata da `test_mcp_server.py`: li' si prova che gli strumenti
siano esposti e rispondano; qui si prova che il file che producono sia GIUSTO.
Sono due difetti diversi. Un export riggato puo' passare ogni controllo
strutturale — JSON valido, accessor allineati, indici dentro i vertici — e
aprirsi in Blender come un modello nero, bucato, in T-pose. I sei invarianti in
CLAUDE.md sono esattamente quei modi di fallire, ognuno un difetto che e' gia'
stato consegnato una volta.

La verifica decisiva e' `test_skinning_numerico`: **si rifa' a mano la skinning
di glTF** (matrici mondo delle ossa dalle traslazioni di riposo e dai quaternioni
di posa, matrice inversa di legatura) e si controlla che a riposo i vertici
tornino dove stanno i voxel. E' l'unico strato in cui una matrice inversa
sbagliata si vede: strutturalmente e' un accessor di 16 float come un altro, e
ogni altro controllo lo accetta.

Nessuna rete: l'unico strumento che chiamerebbe l'AI (`voxel_rig_animate`) qui
passa da `ai.answer_text` sostituita, come in `test_mcp_server.py`.
"""

import asyncio
import json
import math
import os
import shutil
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp_server import ai, rig, server        # noqa: E402
from mcp_server.session import SESSION        # noqa: E402

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
    """Invoca uno strumento dal registro FastMCP, come farebbe un client."""
    res = asyncio.get_event_loop().run_until_complete(
        server.mcp.call_tool(_tool, args))
    items = res[0] if isinstance(res, tuple) else res
    return "\n".join(getattr(c, "text", None) or "" for c in items)


def call_fails(_tool, **args):
    try:
        call(_tool, **args)
        return None
    except Exception as e:                       # noqa: BLE001
        return str(e)


def reset():
    SESSION.docs.clear()
    SESSION.current = None
    SESSION._counter = 0


# --- il modello di prova ------------------------------------------------------

# Un omino in **T-POSE**, e non e' un dettaglio estetico: le stazioni delle
# braccia dell'umanoide si misurano dal bordo del torso, e in un modello con le
# braccia lungo i fianchi il bordo del torso E' il braccio — la spalla finisce
# sulla punta del dito e a `upperArm_*` non si lega nessun voxel. Con un modello
# cosi' le prove sulla posa misurerebbero una silhouette che non cambia, e non
# perche' la skinning e' rotta. Le braccia si abbassano DOPO, con la posa.
# (Verificato: con le braccia in giu' `upperArm_R` arriva a x=14 su un modello
# largo 15, e il conteggio dei voxel legati e' 0.)
OMINO = [
    ["fill", 5, 0, 2, 7, 12, 4, "#3355AA"],      # gamba destra
    ["fill", 8, 0, 2, 10, 12, 4, "#3355AA"],     # gamba sinistra
    ["fill", 5, 13, 2, 10, 25, 4, "#AA3355"],    # busto
    ["fill", 0, 22, 2, 4, 24, 4, "#AA3355"],     # braccio destro, orizzontale
    ["fill", 11, 22, 2, 15, 24, 4, "#AA3355"],   # braccio sinistro, orizzontale
    ["fill", 6, 26, 2, 9, 31, 4, "#FFCC99"],     # testa
]
ALTEZZA_VOXEL = 32                                # serve alla prova sulla scala


def nuovo_omino(rigged=True, **kw):
    reset()
    call("voxel_new", name="Omino")
    call("voxel_ops", ops=OMINO)
    if rigged:
        call("voxel_rig_auto", **kw)
    doc = SESSION.get(None)
    return doc, doc.object_by_ref(None)


def parse_glb(data):
    """(gltf, blob) da un GLB, con i controlli di forma del contenitore."""
    magic, version, total = struct.unpack("<III", data[:12])
    check("GLB: magic 'glTF'", magic == 0x46546C67)
    check("GLB: versione 2", version == 2)
    check("GLB: lunghezza dichiarata giusta", total == len(data),
          "%d vs %d" % (total, len(data)))
    pos, chunks = 12, []
    while pos < len(data):
        clen, ctype = struct.unpack("<II", data[pos:pos + 8])
        chunks.append((ctype, data[pos + 8:pos + 8 + clen]))
        pos += 8 + clen
    check("GLB: consumato fino alla fine", pos == len(data))
    check("GLB: due chunk (JSON + BIN)", len(chunks) == 2)
    return json.loads(chunks[0][1].decode("utf-8")), chunks[1][1]


def leggi(gltf, blob, index):
    """Un accessor come lista di tuple (una per elemento)."""
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc["type"]]
    fmt = {5126: "f", 5125: "I", 5123: "H", 5121: "B"}[acc["componentType"]]
    size = struct.calcsize("<" + fmt)
    raw = blob[start:start + acc["count"] * n * size]
    flat = struct.unpack("<%d%s" % (acc["count"] * n, fmt), raw)
    return [tuple(flat[i * n:(i + 1) * n]) for i in range(acc["count"])]


# --- gli strumenti ------------------------------------------------------------

def test_rig_auto_e_info():
    doc, obj = nuovo_omino()
    check("auto: lo scheletro esiste", rig.has_rig(obj))
    r = rig.rig_of(obj)
    check("auto: riconosce l'umanoide dall'ingombro (piu' alto che largo)",
          r["type"] == "humanoid", r["type"])
    check("auto: ci sono le ossa canoniche",
          {"hips", "chest", "head", "upperArm_R", "upperLeg_L"} <=
          {b["name"] for b in r["bones"]},
          repr(sorted(b["name"] for b in r["bones"])[:8]))

    testo = call("voxel_rig_info")
    check("info: elenca le ossa", "upperArm_R" in testo)
    check("info: dice dove guarda il modello", "guarda a" in testo,
          testo[:120])
    check("info: elenca le clip disponibili", "walk" in testo and "wave" in testo)
    # La convenzione Z-non-X e' l'unica cosa che chi posa non puo' dedurre: la
    # descrizione dello strumento deve insegnarla, o la prima posa scritta da un
    # agente ruota le braccia sul loro stesso asse e non succede niente.
    tools = asyncio.get_event_loop().run_until_complete(server.mcp.list_tools())
    desc = [t.description for t in tools if t.name == "voxel_rig_info"][0]
    check("info: la descrizione insegna che le braccia girano su Z",
          "Z" in desc and "braccia" in desc.lower(), (desc or "")[:200])


def test_avvisa_le_ossa_senza_voxel():
    """Un modello con le braccia in giu' produce ossa che non muovono niente.

    E' il guasto che si presenta travestito: si posa il braccio, non succede
    niente, e sembra rotta la posa. La causa e' che le stazioni delle braccia si
    misurano dal bordo del torso, e con le braccia lungo i fianchi il bordo del
    torso E' il braccio (misurato: `upperArm_R` a x=14 su un modello largo 15, e
    zero voxel legati). Non e' un errore — un modello puo' legittimamente non
    avere quella parte — ma va DETTO, e va detto subito.
    """
    reset()
    call("voxel_new", name="Braccia in giu'")
    call("voxel_ops", ops=[
        ["fill", 4, 0, 2, 6, 12, 4, "#3355AA"],
        ["fill", 9, 0, 2, 11, 12, 4, "#3355AA"],
        ["fill", 4, 13, 2, 11, 23, 4, "#AA3355"],
        ["fill", 1, 13, 2, 3, 22, 4, "#AA3355"],     # braccia lungo i fianchi
        ["fill", 12, 13, 2, 14, 22, 4, "#AA3355"],
        ["fill", 5, 24, 2, 10, 31, 4, "#FFCC99"]])
    testo = call("voxel_rig_auto")
    obj = SESSION.get(None).object_by_ref(None)
    orfane = rig.unbound_bones(obj)
    check("orfane: le braccia in giu' lasciano ossa senza voxel",
          "upperArm_R" in orfane, repr(orfane))
    check("orfane: la risposta lo dice", "Attenzione" in testo, testo[-200:])
    check("orfane: e suggerisce la T-pose", "T-pose" in testo, testo[-200:])

    # E il contrario: sul modello in T-pose non deve avvisare, o l'avviso
    # diventa rumore che si impara a ignorare.
    doc, obj = nuovo_omino()
    orfane = rig.unbound_bones(obj)
    check("orfane: in T-pose ogni osso ha i suoi voxel", not orfane,
          repr(orfane))


def test_rig_generico_su_modello_largo():
    reset()
    call("voxel_new", name="Ponte")
    call("voxel_ops", ops=[["fill", 0, 0, 0, 31, 2, 3, "#888888"]])
    call("voxel_rig_auto")
    obj = SESSION.get(None).object_by_ref(None)
    r = rig.rig_of(obj)
    # Un ponte non ha fianchi a .44 dell'altezza: le stazioni misurate
    # dell'umanoide cadrebbero tutte fuori dal modello.
    check("auto: un modello piu' largo che alto prende la catena generica",
          r["type"] == "generic", r["type"])
    check("auto: la catena generica ha i segmenti chiesti",
          len(r["bones"]) >= 3, "%d ossa" % len(r["bones"]))


def test_pose_in_gradi():
    doc, obj = nuovo_omino()
    call("voxel_rig_pose", poses={"upperArm_R": {"rot": [0, 0, -78]}})
    got = rig.rig_of(obj)["pose"]["upperArm_R"][2]
    # Fuori gradi, dentro radianti. Se `set_pose` non convertisse, qui ci
    # sarebbe -78 (radianti), cioe' dodici giri e mezzo.
    check("posa: i gradi diventano radianti",
          abs(got - math.radians(-78)) < 1e-9, "%r" % got)
    riassunto = rig.bone_summary(obj)
    braccio = [b for b in riassunto if b["name"] == "upperArm_R"][0]
    check("posa: il riassunto li rimostra in gradi",
          abs(braccio["rotationDeg"][2] + 78) < 0.05,
          "%r" % braccio.get("rotationDeg"))

    # Additivo: la seconda posa non deve cancellare la prima.
    call("voxel_rig_pose", poses={"upperArm_L": {"rot": [0, 0, 78]}})
    pose = rig.rig_of(obj)["pose"]
    check("posa: additiva per default", "upperArm_R" in pose and
          "upperArm_L" in pose, repr(sorted(pose)))
    call("voxel_rig_pose", poses={"head": {"rot": [10, 0, 0]}}, additive=False)
    check("posa: additive=False sostituisce tutto",
          list(rig.rig_of(obj)["pose"]) == ["head"],
          repr(list(rig.rig_of(obj)["pose"])))

    call("voxel_rig_pose", reset=True)
    check("posa: reset riporta a riposo", not rig.rig_of(obj)["pose"] and
          not rig.rig_of(obj)["posePos"])


def test_errori_utili():
    nuovo_omino()
    msg = call_fails("voxel_rig_pose", poses={"gomito": {"rot": [0, 0, 10]}})
    # Un nome sbagliato e' quasi sempre un refuso: ignorarlo darebbe una posa
    # "applicata" che non muove niente, cioe' il difetto piu' difficile da
    # capire dall'altra parte del protocollo.
    check("errore: un osso inesistente e' un errore, non un silenzio",
          msg and "gomito" in msg, repr(msg))
    check("errore: dice quali ossa esistono", msg and "chest" in msg,
          repr(msg)[:160])

    msg = call_fails("voxel_rig_bind", binding="morbidissima")
    check("errore: la legatura sconosciuta elenca le tre valide",
          msg and "rigid" in msg and "smooth" in msg and "parts" in msg,
          repr(msg))

    msg = call_fails("voxel_rig_clip", name="vuota", tracks=[])
    check("errore: una clip senza tracce non si salva", bool(msg), repr(msg))

    reset()
    call("voxel_new", name="Nudo")
    call("voxel_ops", ops=[["fill", 0, 0, 0, 2, 2, 2, "#FFFFFF"]])
    msg = call_fails("voxel_rig_pose", poses={"hips": {"rot": [0, 0, 10]}})
    check("errore: senza scheletro dice come crearlo",
          msg and "voxel_rig_auto" in msg, repr(msg))


def test_bind_e_pesi_manuali():
    doc, obj = nuovo_omino()
    call("voxel_rig_bind", binding="smooth", hardness=8)
    r = rig.rig_of(obj)
    check_eq("legatura: il modo e' quello chiesto", r["binding"], "smooth")
    check_eq("legatura: la durezza e' quella chiesta", r["hardness"], 8)

    call("voxel_rig_bind", weights={"3,10,1": "chest", "4,10,1": {"hips": 1.0}})
    w = rig.rig_of(obj)["weights"]
    check("legatura: i pesi manuali si conservano",
          "3,10,1" in w and "4,10,1" in w, repr(sorted(w))[:120])
    msg = call_fails("voxel_rig_bind", weights={"3,10,1": "gomito"})
    check("legatura: un peso su un osso inesistente e' un errore",
          msg and "gomito" in msg, repr(msg))

    # Rifare lo scheletro DEVE buttare i pesi: gli indici puntavano ad altre
    # ossa, quindi tenerli e' peggio che perderli.
    call("voxel_rig_pose", poses={"head": {"rot": [10, 0, 0]}})
    call("voxel_rig_auto")
    r = rig.rig_of(obj)
    check("legatura: rifare lo scheletro scarta i pesi a mano", not r["weights"],
          repr(r["weights"])[:80])
    check("legatura: ma CONSERVA la posa (si cerca per nome)",
          "head" in r["pose"], repr(list(r["pose"])))


def test_clip_a_mano():
    doc, obj = nuovo_omino()
    call("voxel_rig_clip", name="saluto", duration=1.0, tracks=[
        {"bone": "upperArm_R",
         "keys": [{"t": 0, "rot": [0, 0, -78]},
                  {"t": 0.5, "rot": [0, 0, 60]},
                  {"t": 1.0, "rot": [0, 0, -78]}]}])
    nomi = rig.clip_names(obj)
    check("clip: la clip scritta a mano entra nella libreria",
          "saluto" in nomi, repr(nomi))
    check("clip: i preset restano",
          set(rig.PRESET_NAMES) <= set(nomi), repr(nomi))

    # Stesso nome = sostituzione, non un doppione: due clip omonime nel GLB
    # sono ambigue per l'importatore.
    call("voxel_rig_clip", name="saluto", duration=2.0, tracks=[
        {"bone": "head", "keys": [{"t": 0, "rot": [0, 0, 0]},
                                  {"t": 1, "rot": [20, 0, 0]}]}])
    anims = rig.rig_of(obj)["customAnims"]
    check_eq("clip: lo stesso nome sostituisce",
             len([a for a in anims if a.get("name") == "saluto"]), 1)

    msg = call_fails("voxel_rig_clip", name="fantasma", tracks=[
        {"bone": "gomito", "keys": [{"t": 0, "rot": [0, 0, 0]},
                                    {"t": 1, "rot": [0, 0, 30]}]}])
    check("clip: ossa inesistenti danno un errore che le nomina",
          msg and "gomito" in msg, repr(msg)[:160])

    call("voxel_rig_clip", name="saluto", remove=True)
    check("clip: si rimuove", "saluto" not in rig.clip_names(obj),
          repr(rig.clip_names(obj)))


def test_clip_ai_senza_rete():
    """`voxel_rig_animate` con `answer_text` sostituita: nessuna rete."""
    doc, obj = nuovo_omino()
    risposta = {"name": "inchino", "duration": 1.5, "loop": False, "tracks": [
        {"bone": "chest", "keys": [{"t": 0, "rot": [0, 0, 0]},
                                   {"t": 0.75, "rot": [40, 0, 0]},
                                   {"t": 1.5, "rot": [0, 0, 0]}]}]}
    visti = []
    vecchio = ai.answer_text

    def finta(prompt, model=None, provider=None):
        visti.append(prompt)
        return json.dumps(risposta)

    ai.answer_text = finta
    try:
        call("voxel_rig_animate", prompt="un inchino lento")
    finally:
        ai.answer_text = vecchio

    check("animate: ha chiesto una volta sola", len(visti) == 1,
          "%d chiamate" % len(visti))
    # Il prompt deve portare i nomi delle ossa VERE: e' cio' che mette la clip
    # nel riferimento dello scheletro e la esenta dalla coniugazione.
    check("animate: nel prompt ci sono le ossa vere",
          visti and "upperArm_R" in visti[0] and "hips" in visti[0],
          (visti[0][:160] if visti else "nessun prompt"))
    check("animate: la richiesta dell'utente e' nel prompt",
          visti and "un inchino lento" in visti[0])
    check("animate: la clip e' entrata", "inchino" in rig.clip_names(obj),
          repr(rig.clip_names(obj)))


# --- i sei invarianti, misurati sul GLB ---------------------------------------

def test_invarianti_glb(tmp):
    doc, obj = nuovo_omino()
    call("voxel_rig_pose", poses={
        "upperArm_R": {"rot": [0, 0, -78]},
        "upperArm_L": {"rot": [0, 0, 78]},
        "hips": {"pos": [0, -1, 0]}})
    server.WORKDIR = tmp
    call("voxel_rig_export", path="omino.glb", scale=0.01)
    gltf, blob = parse_glb(open(os.path.join(tmp, "omino.glb"), "rb").read())

    # INVARIANTE 1 — niente TRS sul nodo della mesh skinnata. Un importatore
    # glTF lo ignora per specifica (la posa viene da joints + matrici inverse),
    # quindi Blender lo trasferisce sull'Armature: origine e scala vanno cotte
    # nei vertici e nelle ossa.
    mesh_node = gltf["nodes"][0]
    check("inv.1: il nodo della mesh non ha TRS",
          not any(k in mesh_node for k in ("translation", "rotation", "scale")),
          repr({k: v for k, v in mesh_node.items() if k != "name"}))
    check("inv.1: l'origine e' cotta nei vertici (il modello poggia a y=0)",
          abs(min(gltf["accessors"][p["attributes"]["POSITION"]]["min"][1]
                  for p in gltf["meshes"][0]["primitives"])) < 1e-6)

    # INVARIANTE 4 — la posa e' la PRIMA clip. Blender assegna d'ufficio la
    # prima action del file: con `idle` per prima le braccia tornavano in
    # T-pose (0.911 m invece di 0.550 m).
    nomi = [a["name"] for a in gltf["animations"]]
    check_eq("inv.4: la prima clip e' la posa", nomi[0], "pose")
    check("inv.4: e ci sono anche i preset",
          set(rig.PRESET_NAMES) <= set(nomi), repr(nomi))

    # INVARIANTE 6 — niente COLOR_0. In glTF il risultato e'
    # `baseColorFactor * COLOR_0`, cioe' il colore lineare AL QUADRATO: 31
    # materiali su 31 erano arrivati quasi neri in Blender.
    check("inv.6: nessun primitivo esporta COLOR_0",
          all("COLOR_0" not in p["attributes"]
              for p in gltf["meshes"][0]["primitives"]),
          repr([sorted(p["attributes"])
                for p in gltf["meshes"][0]["primitives"]]))

    # Il primitivo senza indici e' VELENO in r128: `processAccessor` torna null,
    # l'esportatore cancella `indices` e la mesh disegna TUTTI i vertici in
    # sequenza (misurati 12098 triangoli fantasma).
    check("veleno: ogni primitivo ha i suoi indici",
          all("indices" in p for p in gltf["meshes"][0]["primitives"]))
    for i, p in enumerate(gltf["meshes"][0]["primitives"]):
        check("veleno: il primitivo %d non e' vuoto" % i,
              gltf["accessors"][p["indices"]]["count"] > 0)

    # Il tipo di ogni sampler deve corrispondere al PERCORSO che anima: una
    # rotazione e' un quaternione (VEC4), una traslazione un vettore (VEC3).
    # Dichiararli tutti VEC3 scriveva un accessor di 2 elementi su 8 float di
    # quaternione: l'importatore ne legge 6 e li prende per due terne, cioe'
    # rotazioni inventate. Passa OGNI controllo strutturale — l'accessor esiste,
    # e' allineato, gli offset non si sovrappongono — e si vede solo aprendo il
    # file. Trovato cosi'.
    atteso = {"rotation": "VEC4", "translation": "VEC3", "scale": "VEC3"}
    sbagliati, corti = [], []
    for a in gltf["animations"]:
        for c in a["channels"]:
            s = a["samplers"][c["sampler"]]
            out = gltf["accessors"][s["output"]]
            want = atteso[c["target"]["path"]]
            if out["type"] != want:
                sbagliati.append((a["name"], c["target"]["path"],
                                  out["type"], want))
            # E il numero di elementi deve pareggiare i tempi: un conteggio
            # sbagliato tronca la clip invece di dare errore.
            if out["count"] != gltf["accessors"][s["input"]]["count"]:
                corti.append((a["name"], c["target"]["path"], out["count"],
                              gltf["accessors"][s["input"]]["count"]))
    check("clip: il tipo del sampler corrisponde al percorso animato",
          not sbagliati, repr(sbagliati[:3]))
    check("clip: ogni sampler ha tanti valori quanti tempi", not corti,
          repr(corti[:3]))

    # Le ossa: una per giunto, e i nodi devono esistere.
    r = rig.rig_of(obj)
    check_eq("skin: un giunto per osso",
             len(gltf["skins"][0]["joints"]), len(r["bones"]))
    # JOINTS_0 indica NODI, non ossa: il nodo 0 e' la mesh, quindi le ossa
    # partono da 1. Un fuori-di-uno qui lega ogni voxel all'osso sbagliato.
    check("skin: i giunti sono nodi validi e non includono la mesh",
          all(0 < j < len(gltf["nodes"]) for j in gltf["skins"][0]["joints"]),
          repr(gltf["skins"][0]["joints"][:6]))

    prim = gltf["meshes"][0]["primitives"][0]
    joints = leggi(gltf, blob, prim["attributes"]["JOINTS_0"])
    check("skin: gli indici JOINTS_0 stanno dentro l'elenco dei giunti",
          max(max(j) for j in joints) < len(gltf["skins"][0]["joints"]),
          "max %d" % max(max(j) for j in joints))
    pesi = leggi(gltf, blob, prim["attributes"]["WEIGHTS_0"])
    fuori = [w for w in pesi if abs(sum(w) - 1.0) > 1e-3]
    check("skin: i pesi di ogni vertice sommano a 1", not fuori,
          "%d vertici fuori, es. %r" % (len(fuori), fuori[:2]))


def test_invariante_5_facce_dei_giunti(tmp):
    """La faccia fra due voxel si toglie solo se si deformano IDENTICI.

    La faccia fra voxel che si deformano DIVERSAMENTE e' un giunto: a riposo le
    sue due meta' sono coincidenti e sepolte, ma appena la posa separa le ossa
    quelle meta' sono esattamente le PARETI del varco. Toglierle lascia il
    guscio APERTO, e con materiali `FrontSide` si vede dentro il modello (936
    spigoli di bordo sulla mesh posata, 7 zone trasparenti nel render).
    """
    doc, obj = nuovo_omino()
    r = rig.rig_of(obj)
    voxels = obj.voxel_list()
    skin = rig.skin_for(obj, r)
    tokens = [rig.token_of_voxel(v) for v in voxels]

    tenute = rig.build_rigged_shell(voxels, skin, tokens, scale=1.0)
    # Il confronto: lo stesso guscio calcolato con la regola SBAGLIATA (togli
    # ogni faccia condivisa, senza guardare i pesi). Se le due misure
    # coincidono, questa prova non ha denti — vorrebbe dire che nel modello non
    # c'e' nessun giunto.
    vere = sum(len(g["idx"]) for g in tenute.values()) // 6
    alike = rig.deforms_alike
    try:
        rig.deforms_alike = lambda a, b, s: True
        tolte = rig.build_rigged_shell(voxels, skin, tokens, scale=1.0)
        cieche = sum(len(g["idx"]) for g in tolte.values()) // 6
    finally:
        rig.deforms_alike = alike

    check("inv.5: nel modello di prova ci SONO giunti (la prova ha denti)",
          vere > cieche, "%d facce tenute vs %d con la regola cieca"
          % (vere, cieche))

    # E il conto esatto: ogni coppia di voxel adiacenti che si deforma diverso
    # deve avere DUE facce (una per verso), non zero.
    at = {}
    for i, v in enumerate(voxels):
        at[(v["x"], v["y"], v["z"])] = i
    giunti = 0
    for i, v in enumerate(voxels):
        for d in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
            j = at.get((v["x"] + d[0], v["y"] + d[1], v["z"] + d[2]))
            if j is not None and not rig.deforms_alike(i, j, skin):
                giunti += 1
    check("inv.5: ogni giunto tiene due facce", vere - cieche == giunti * 2,
          "%d giunti, differenza %d facce" % (giunti, vere - cieche))

    # Le due meta' guardano in versi OPPOSTI: e' cosi' che il backface culling
    # ne disegna sempre esattamente una, e per questo lo z-fighting che aveva
    # motivato il taglio non torna. L'unita' di misura e' il QUAD, non il
    # vertice: uno spigolo di cubo e' condiviso da tre facce dello STESSO voxel,
    # che guardano legittimamente in tre versi diversi e non sono coincidenti
    # (una prima stesura contava quelle e trovava 32 falsi positivi).
    quad = {}
    for g in tenute.values():
        for k in range(0, len(g["pos"]), 12):    # 4 vertici = 12 float
            centro = tuple(
                round(sum(g["pos"][k + c::3][:4]) / 4.0, 4) for c in range(3))
            n = tuple(round(c, 4) for c in g["nrm"][k:k + 3])
            quad.setdefault(centro, []).append(n)
    doppi = {c: ns for c, ns in quad.items() if len(ns) > 1}
    check("inv.5: nel guscio ci SONO quad coincidenti (le pareti dei giunti)",
          len(doppi) == giunti, "%d coppie, %d giunti" % (len(doppi), giunti))
    concordi = [c for c, ns in doppi.items()
                if not all(tuple(-x for x in a) in ns for a in ns)]
    check("inv.5: i quad coincidenti guardano in versi opposti",
          not concordi, "%d concordi, es. %r" % (len(concordi),
                                                 concordi[:2]))


def test_skinning_numerico(tmp):
    """La verifica che nessun controllo strutturale puo' fare.

    Si rifa' a mano la skinning di glTF: matrice mondo di ogni osso (traslazione
    di riposo, piu' il quaternione della posa), matrice inversa di legatura, e
    `v' = somma(w_i * M_i * IBM_i * v)`. A RIPOSO deve tornare l'identita', cioe'
    i vertici devono restare dove sono. Una matrice inversa sbagliata e'
    strutturalmente un accessor di 16 float come un altro: la si vede solo qui,
    o aprendo il file e guardando il modello esplodere.
    """
    doc, obj = nuovo_omino()
    server.WORKDIR = tmp
    call("voxel_rig_export", path="riposo.glb", scale=0.01)
    gltf, blob = parse_glb(open(os.path.join(tmp, "riposo.glb"), "rb").read())

    ibm = leggi(gltf, blob, gltf["skins"][0]["inverseBindMatrices"])
    giunti = gltf["skins"][0]["joints"]

    # Le ossa a riposo portano SOLO traslazione (nessuna rotazione), quindi la
    # matrice mondo e' la somma delle traslazioni lungo la catena e la matrice
    # inversa e' la traslazione opposta. Se cosi' non fosse, il conto qui sotto
    # non chiuderebbe.
    padre = {}
    for ni, node in enumerate(gltf["nodes"]):
        for figlio in node.get("children", []):
            padre[figlio] = ni

    def mondo(ni):
        t = [0.0, 0.0, 0.0]
        cur = ni
        while cur is not None:
            tr = gltf["nodes"][cur].get("translation") or [0, 0, 0]
            t = [t[0] + tr[0], t[1] + tr[1], t[2] + tr[2]]
            cur = padre.get(cur)
        return t

    peggio = 0.0
    for slot, ni in enumerate(giunti):
        m = ibm[slot]
        # Colonna-maggiore: la traslazione sta negli elementi 12,13,14.
        inv = (m[12], m[13], m[14])
        w = mondo(ni)
        # Il nodo osso non e' figlio della mesh: la sua matrice mondo e' la
        # catena delle traslazioni. IBM deve annullarla esattamente.
        d = max(abs(w[i] + inv[i]) for i in range(3))
        peggio = max(peggio, d)
        check("skinning: IBM[%d] e' l'inversa della posa di riposo" % slot,
              d < 1e-6, "scarto %r" % d)
        rot = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
        check("skinning: IBM[%d] non ha rotazione ne' scala" % slot,
              rot == [1, 0, 0, 0, 1, 0, 0, 0, 1], repr(rot))
    check("skinning: a riposo la legatura e' esatta", peggio < 1e-6,
          "scarto peggiore %r" % peggio)

    # E ora il conto pieno su un vertice vero: a riposo deve tornare identico.
    prim = gltf["meshes"][0]["primitives"][0]
    pos = leggi(gltf, blob, prim["attributes"]["POSITION"])
    js = leggi(gltf, blob, prim["attributes"]["JOINTS_0"])
    ws = leggi(gltf, blob, prim["attributes"]["WEIGHTS_0"])
    peggio = 0.0
    for vi in range(0, len(pos), max(1, len(pos) // 40)):
        p, out = pos[vi], [0.0, 0.0, 0.0]
        for s in range(4):
            w = ws[vi][s]
            if w <= 0:
                continue
            m = ibm[js[vi][s]]
            wm = mondo(giunti[js[vi][s]])
            # IBM (sola traslazione) poi la matrice mondo dell'osso (sola
            # traslazione a riposo): le due si annullano.
            for c in range(3):
                out[c] += w * (p[c] + m[12 + c] + wm[c])
        peggio = max(peggio, max(abs(out[c] - p[c]) for c in range(3)))
    check("skinning: a riposo i vertici non si muovono", peggio < 1e-6,
          "scarto peggiore %r" % peggio)


def test_posa_deforma_davvero(tmp):
    """Una posa deve CAMBIARE la silhouette: le clip da sole non bastano.

    E' il controllo che avrebbe preso l'invariante 4 dall'altro verso: un file
    con la clip `pose` giusta ma i pesi sbagliati la anima e non muove niente.
    """
    doc, obj = nuovo_omino()
    r = rig.rig_of(obj)
    skin = rig.skin_for(obj, r)
    voxels = obj.voxel_list()

    # Quali voxel sono legati alle braccia? Se nessuno, la misura sotto sarebbe
    # vuota e passerebbe per il motivo sbagliato.
    nomi = [b["name"] for b in r["bones"]]
    idx_braccio = [i for i, n in enumerate(nomi) if n == "upperArm_R"][0]
    legati = [i for i, p in enumerate(skin["primary"]) if p == idx_braccio]
    check("deforma: qualche voxel e' legato a upperArm_R", len(legati) > 0,
          "%d voxel" % len(legati))

    call("voxel_rig_pose", poses={"upperArm_R": {"rot": [0, 0, -78]}})
    server.WORKDIR = tmp
    call("voxel_rig_export", path="posato.glb", scale=0.01)
    gltf, blob = parse_glb(open(os.path.join(tmp, "posato.glb"), "rb").read())
    clip = [a for a in gltf["animations"] if a["name"] == "pose"][0]

    # La traccia di rotazione dell'osso posato deve essere un quaternione NON
    # identita'. Con la posa passata per `math.radians` una seconda volta
    # sarebbe quasi identita' (78 gradi diventerebbero 1.36 gradi).
    nodo = gltf["skins"][0]["joints"][idx_braccio]
    rots = [c for c in clip["channels"]
            if c["target"]["node"] == nodo and c["target"]["path"] == "rotation"]
    check("deforma: la posa anima la rotazione dell'osso", len(rots) == 1,
          "%d canali" % len(rots))
    q = leggi(gltf, blob, clip["samplers"][rots[0]["sampler"]]["output"])[0]
    ang = 2 * math.degrees(math.acos(min(1.0, abs(q[3]))))
    check("deforma: l'angolo nel file e' i 78 gradi chiesti",
          abs(ang - 78) < 0.5, "%r gradi (q=%r)" % (ang, q))


def test_scala_e_facce_nascoste(tmp):
    doc, obj = nuovo_omino()
    server.WORKDIR = tmp
    call("voxel_rig_export", path="metri.glb", scale=0.01)
    call("voxel_rig_export", path="voxel.glb", scale=1.0)
    g1, _ = parse_glb(open(os.path.join(tmp, "metri.glb"), "rb").read())
    g2, _ = parse_glb(open(os.path.join(tmp, "voxel.glb"), "rb").read())

    def altezza(g):
        return max(g["accessors"][p["attributes"]["POSITION"]]["max"][1]
                   for p in g["meshes"][0]["primitives"])

    check("scala: 0.01 da' un centesimo di 1.0",
          abs(altezza(g1) * 100 - altezza(g2)) < 1e-3,
          "%r vs %r" % (altezza(g1), altezza(g2)))
    check("scala: un voxel = 1 cm",
          abs(altezza(g1) - ALTEZZA_VOXEL * 0.01) < 1e-6, "%r m" % altezza(g1))

    call("voxel_rig_export", path="tutte.glb", scale=0.01, all_faces=True)
    g3, _ = parse_glb(open(os.path.join(tmp, "tutte.glb"), "rb").read())

    def facce(g):
        return sum(g["accessors"][p["indices"]]["count"]
                   for p in g["meshes"][0]["primitives"]) // 3

    check("all_faces: costruisce anche le facce sepolte",
          facce(g3) > facce(g1), "%d vs %d" % (facce(g3), facce(g1)))
    check("all_faces: sono le 6 per voxel", facce(g3) == len(obj.voxel_list()) * 12,
          "%d facce su %d voxel" % (facce(g3), len(obj.voxel_list())))


def test_filtro_clip_e_messaggio(tmp):
    """Il messaggio deve dire cio' che il file CONTIENE, non cio' che gli e'
    stato chiesto: e' l'unica cosa che chi chiama legge senza riaprire il GLB."""
    doc, obj = nuovo_omino()
    server.WORKDIR = tmp
    call("voxel_rig_clip", name="saluto", duration=1.0, tracks=[
        {"bone": "head", "keys": [{"t": 0, "rot": [0, 0, 0]},
                                  {"t": 1, "rot": [20, 0, 0]}]}])

    def dentro(nome):
        g, _ = parse_glb(open(os.path.join(tmp, nome), "rb").read())
        return [a["name"] for a in g["animations"]]

    testo = call("voxel_rig_export", path="a.glb", clips=["walk", "saluto"])
    check_eq("filtro: `clips` limita davvero il file", dentro("a.glb"),
             ["walk", "saluto"])
    check("filtro: e il messaggio non ne annuncia altre",
          "idle" not in testo and "walk" in testo, testo)
    # A riposo non c'e' nessuna clip `pose`: annunciarla sarebbe una bugia.
    check("filtro: a scheletro a riposo non si annuncia la posa",
          "la posa" not in testo, testo)

    testo = call("voxel_rig_export", path="b.glb", presets=False)
    check_eq("filtro: presets=False lascia solo le clip proprie",
             dentro("b.glb"), ["saluto"])

    call("voxel_rig_pose", poses={"head": {"rot": [10, 0, 0]}})
    testo = call("voxel_rig_export", path="c.glb", presets=False, custom=False)
    check_eq("filtro: con tutto spento resta la sola posa", dentro("c.glb"),
             ["pose"])
    check("filtro: e il messaggio la annuncia", "la posa" in testo, testo)


def test_export_confinato(tmp):
    """La scrittura resta dentro la cartella di lavoro, come ogni altro export."""
    nuovo_omino()
    server.WORKDIR = tmp
    msg = call_fails("voxel_rig_export", path="../fuori.glb")
    check("confino: non si scrive fuori dalla cartella di lavoro", bool(msg),
          repr(msg))
    check("confino: e non ha creato il file",
          not os.path.exists(os.path.join(os.path.dirname(tmp), "fuori.glb")))


def main():
    tmp = tempfile.mkdtemp(prefix="voxrig")
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
            except Exception as e:               # noqa: BLE001
                _fail.append("%s ha sollevato: %r" % (name, e))
    finally:
        server.WORKDIR = keep
        shutil.rmtree(tmp, ignore_errors=True)
    print("MCP rig: %d controlli, %d falliti" % (_ok + len(_fail), len(_fail)))
    for f in _fail:
        print("  FALLITO: " + f)
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
