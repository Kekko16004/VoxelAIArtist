"""
Scritture su disco: atomiche, sotto lock, senza perdere i file dell'utente.

Ogni caso qui sotto e' un difetto RIPRODOTTO nell'audit del 2026-10-26:
  1. `open("w")` + `json.dump` troncava il file PRIMA di serializzare: un errore
     a meta' lasciava un .voxai / settings.json distrutto (src/atomicio.py);
  2. due `set_setting` / `add_provider` paralleli (il server HTTP e'
     multi-thread) si cancellavano a vicenda: 9 provider sopravvissuti su 122;
  3. un settings.json illeggibile veniva sovrascritto con `{}` + una chiave,
     cancellando in silenzio tutte le altre preferenze;
  4. il `.voxai` dell'MCP usava la busta "voxai-project", che la GUI non
     riconosce (trascinato nella finestra si apriva vuoto).

Tutto in cartelle usa-e-getta: APPDATA, VOXELAI_PROVIDERS_DIR e VOXELAI_MCP_DIR
puntano a temp PRIMA di qualunque import, quindi niente tocca i file veri.
"""
import os as _os
_HERE = _os.path.dirname(_os.path.abspath(__file__))
REPO_ROOT = _os.path.dirname(_HERE)
import json, os, shutil, sys, tempfile, threading

_TMP = tempfile.mkdtemp(prefix="voxai_storage_")
os.environ["APPDATA"] = os.path.join(_TMP, "appdata")
os.environ["VOXELAI_PROVIDERS_DIR"] = os.path.join(_TMP, "providers")
os.environ["VOXELAI_MCP_DIR"] = os.path.join(_TMP, "mcp")
os.makedirs(os.environ["APPDATA"], exist_ok=True)

sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
sys.path.insert(0, REPO_ROOT)

import atomicio                                   # noqa: E402
import settings as app_settings                   # noqa: E402
import providers                                  # noqa: E402

fails = []


def check(cond, msg):
    print(("  OK  " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def leftovers(folder):
    return [n for n in os.listdir(folder) if n.endswith(".tmp")]


try:
    print("=== 1. scrittura atomica ===")
    d = os.path.join(_TMP, "atom")
    os.makedirs(d)
    p = os.path.join(d, "progetto.voxai")
    atomicio.atomic_write_json(p, {"versione": 1})
    try:
        # Un valore non serializzabile a meta' del documento: con open("w") il
        # file era gia' vuoto quando json.dump sollevava.
        atomicio.atomic_write_json(p, {"versione": 2, "rotto": object()})
        check(False, "un oggetto non serializzabile deve sollevare")
    except TypeError:
        pass
    with open(p, encoding="utf-8") as f:
        check(json.load(f) == {"versione": 1},
              "errore di serializzazione: il file vecchio resta intatto")
    check(not leftovers(d), "nessun .tmp lasciato dopo l'errore")

    # Un errore DURANTE la sostituzione (disco, permessi): idem.
    real_replace = os.replace
    def boom(a, b):
        raise OSError("disco pieno (finto)")
    os.replace = boom
    try:
        try:
            atomicio.atomic_write_json(p, {"versione": 3})
            check(False, "l'errore di os.replace deve risalire")
        except OSError:
            pass
    finally:
        os.replace = real_replace
    with open(p, encoding="utf-8") as f:
        check(json.load(f) == {"versione": 1},
              "errore in sostituzione: il file vecchio resta intatto")
    check(not leftovers(d), "nessun .tmp lasciato dopo l'errore di sostituzione")

    # Windows: os.replace fallisce se un lettore ha il file aperto in quel
    # momento. Si ritenta invece di arrendersi al primo colpo.
    calls = {"n": 0}
    def busy(a, b):
        calls["n"] += 1
        if calls["n"] < 3:
            raise PermissionError("file in uso (finto)")
        return real_replace(a, b)
    os.replace = busy
    try:
        atomicio.atomic_write_json(p, {"versione": 4})
    finally:
        os.replace = real_replace
    with open(p, encoding="utf-8") as f:
        check(json.load(f) == {"versione": 4} and calls["n"] == 3,
              "PermissionError transitorio: ritenta e scrive (%d tentativi)" % calls["n"])

    print("=== 2. preferenze: aggiornamenti paralleli ===")
    app_settings.save_settings({"tema": "scuro"})
    def scrivi(i):
        app_settings.set_setting("chiave_%02d" % i, i)
    ths = [threading.Thread(target=scrivi, args=(i,)) for i in range(40)]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    data = app_settings.load_settings()
    persi = [i for i in range(40) if data.get("chiave_%02d" % i) != i]
    check(not persi and data.get("tema") == "scuro",
          "40 set_setting paralleli: nessuno perso (persi: %r)" % persi[:5])

    print("=== 3. preferenze: un file illeggibile non si sovrascrive ===")
    sp = app_settings.get_settings_path()
    with open(sp, "w", encoding="utf-8") as f:
        f.write('{"tema": "scuro", "lingua": "it", ')      # troncato
    app_settings.set_setting("nuova", True)
    folder = os.path.dirname(sp)
    backups = [n for n in os.listdir(folder) if n.startswith("settings.json.corrotto-")]
    check(len(backups) == 1, "il file illeggibile e' messo da parte (%r)" % backups)
    if backups:
        with open(os.path.join(folder, backups[0]), encoding="utf-8") as f:
            check('"lingua": "it"' in f.read(), "la copia contiene il testo originale")
    check(app_settings.load_settings() == {"nuova": True},
          "il nuovo settings.json e' valido")

    print("=== 4. provider: aggiunte parallele ===")
    errs = []
    def aggiungi(i):
        try:
            providers.add_provider({"id": "prova_%02d" % i, "type": "openai_compatible",
                                    "base_url": "http://127.0.0.1:9/v1",
                                    "model": "m", "api_key": "k-%02d" % i})
        except Exception as e:                    # noqa: BLE001
            errs.append(repr(e))
    ths = [threading.Thread(target=aggiungi, args=(i,)) for i in range(30)]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    ids = {p.get("id") for p in providers.list_providers()["providers"]}
    persi = [i for i in range(30) if "prova_%02d" % i not in ids]
    check(not errs and not persi,
          "30 add_provider paralleli: nessuno perso (persi %r, errori %r)"
          % (persi[:5], errs[:2]))
    chiavi = [providers.get_api_key("prova_%02d" % i) for i in range(30)]
    check(chiavi == ["k-%02d" % i for i in range(30)],
          "e nessuna chiave API persa")

    print("=== 5. il .voxai dell'MCP e' quello dell'app ===")
    from mcp_server.session import SESSION
    from mcp_server.document import Document, VoxelObject, Cell
    doc = Document()
    o = VoxelObject("Cubo", {(0, 0, 0): Cell("#FF0000")})
    doc.add_object(o)
    SESSION.put(doc, "prova")
    vp = os.path.join(_TMP, "cubo.voxai")
    SESSION.save_path(doc, vp)
    with open(vp, encoding="utf-8") as f:
        env = json.load(f)
    check(env.get("format") == "voxai" and env.get("version") == 1
          and isinstance(env.get("data"), dict) and env.get("savedAt"),
          "busta {format:'voxai', version, savedAt, data} (era 'voxai-project')")
    # La GUI (02-io-files.js / 21-project.js) scarta la busta SOLO con
    # format === 'voxai': si controlla la stessa condizione.
    for js in ("ui/src/lib/02-io-files.js", "ui/src/lib/21-project.js"):
        with open(os.path.join(REPO_ROOT, js), encoding="utf-8") as f:
            check("format === 'voxai'" in f.read(),
                  "%s riconosce format === 'voxai'" % js)
    again = SESSION.get(SESSION.open_path(vp, "riaperto"))
    check(len(again.objects) == 1 and len(again.objects[0]) == 1,
          "e l'MCP lo riapre")
finally:
    shutil.rmtree(_TMP, ignore_errors=True)

if fails:
    print("\n%d CHECK FALLITI" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("\nTUTTI I CHECK DI STORAGE OK")
