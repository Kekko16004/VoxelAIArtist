"""
Test delle funzionalita' aggiunte nel secondo round:
  #4 ancoraggio, taglie relative, report di coerenza
  #9 persistenza dei pack su disco
  budget adattivo di espansione
Nessuna rete, nessun cookie, nessuna quota AI.
"""
import json, os, shutil, sys, tempfile, time

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(REPO_ROOT, 'src'))

import pack
from parser import voxel_budget_for, MAX_VOXELS, MAX_VOXELS_ABSOLUTE, expand_ops

ok = lambda m: print("  OK  " + m)
def check(c, m):
    if not c:
        print("  FAIL " + m); sys.exit(1)
    ok(m)

print("=== 1. model_bounds ===")
m = {"voxels": [{"x": 5, "y": 3, "z": 7, "color": "#FFF000"},
                {"x": 9, "y": 1, "z": 2, "color": "#FFF000"}]}
check(pack.model_bounds(m) == (5, 1, 2, 9, 3, 7), "bounds da voxel flat")
m2 = {"palette": {"a": "#FF0000"}, "ops": [["fill", 2, 0, 2, 6, 4, 6, "a"]]}
check(pack.model_bounds(m2) == (2, 0, 2, 6, 4, 6), "bounds da ops senza espandere")
check(pack.model_bounds({}) is None, "modello vuoto -> None")
check(pack.model_bounds(None) is None, "input invalido -> None")
check(pack.model_bounds({"ops": [["boh"], []]}) is None, "ops spazzatura -> None")

print("=== 2. normalize_asset: centrato su XZ e appoggiato a y=0 ===")
mm = {"metadata": {"grid_size": [32, 32, 32]},
      "voxels": [{"x": 20, "y": 5, "z": 20, "color": "#FF0000"},
                 {"x": 23, "y": 9, "z": 23, "color": "#FF0000"}]}
out, rep = pack.normalize_asset(mm)
b = pack.model_bounds(out)
check(b[1] == 0, "appoggiato a y=0 (miny=%d)" % b[1])
sx = b[3] - b[0] + 1; sz = b[5] - b[2] + 1
check(b[0] == (32 - sx) // 2, "centrato su X (minx=%d, atteso %d)" % (b[0], (32 - sx) // 2))
check(b[2] == (32 - sz) // 2, "centrato su Z")
check(rep["size"] == (4, 5, 4), "dimensioni riportate %s" % (rep["size"],))

print("=== 3. normalize_asset preserva la forma (traslazione rigida) ===")
before = {"metadata": {"grid_size": [64, 64, 64]},
          "palette": {"a": "#FF0000"},
          "ops": [["fill", 10, 4, 10, 14, 8, 12, "a"], ["box", 11, 9, 11, 13, 12, 12, "a"]]}
b0 = pack.model_bounds(before)
size0 = (b0[3]-b0[0], b0[4]-b0[1], b0[5]-b0[2])
n_before = len(expand_ops(json.loads(json.dumps(before)))["voxels"])
after, _ = pack.normalize_asset(json.loads(json.dumps(before)))
b1 = pack.model_bounds(after)
size1 = (b1[3]-b1[0], b1[4]-b1[1], b1[5]-b1[2])
n_after = len(expand_ops(json.loads(json.dumps(after)))["voxels"])
check(size0 == size1, "dimensioni invariate %s == %s" % (size0, size1))
check(n_before == n_after, "conteggio voxel invariato (%d)" % n_after)
check(b1[1] == 0, "appoggiato a y=0 anche con le ops")

print("=== 4. normalize_asset su casi degeneri ===")
for bad in ({}, {"voxels": []}, {"ops": []}, None, "x"):
    r, _rep = pack.normalize_asset(bad if isinstance(bad, dict) else {})
    check(isinstance(r, dict), "input degenere gestito: %.20s" % str(bad))

print("=== 5. taglie relative dichiarate ===")
check(pack.parse_size_hint("Armadio :grande") == ("Armadio", "grande"), "suffisso riconosciuto")
check(pack.parse_size_hint("Vaso fiori") == ("Vaso fiori", None), "senza suffisso -> None")
check(pack.parse_size_hint("Robot :inesistente")[1] is None, "taglia sconosciuta ignorata")
check(pack.parse_size_hint("Casa:enorme") == ("Casa", "enorme"), "senza spazio prima dei due punti")
check(all(0 < v <= 1 for v in pack.SIZE_HINTS.values()), "frazioni valide")

print("=== 6. report di coerenza: trova gli outlier ===")
def cube(n):
    return {"voxels": [{"x": x, "y": y, "z": z, "color": "#FF0000"}
                       for x in range(n) for y in range(n) for z in range(n)]}
assets = [{"label": "Spada_1", "model": cube(10)},
          {"label": "Scudo_1", "model": cube(11)},
          {"label": "Torre_1", "model": cube(40)}]   # chiaramente fuori scala
rep = pack.pack_coherence_report(assets)
check(rep["median"] == 11, "mediana = 11 (ottenuto %s)" % rep["median"])
labels = [o["label"] for o in rep["outliers"]]
check("Torre_1" in labels, "Torre_1 segnalata come outlier")
check("Spada_1" not in labels, "Spada_1 NON segnalata (e' nella norma)")
check(pack.pack_coherence_report([])["outliers"] == [], "lista vuota gestita")

print("=== 7. budget adattivo per griglia ===")
check(voxel_budget_for([32, 32, 32]) == MAX_VOXELS, "griglia piccola -> default")
check(voxel_budget_for([256, 256, 256]) > MAX_VOXELS, "griglia grande -> budget maggiore")
check(voxel_budget_for([512, 512, 512]) == MAX_VOXELS_ABSOLUTE, "tetto assoluto rispettato")
check(voxel_budget_for(None) == MAX_VOXELS, "griglia assente -> default")
check(voxel_budget_for("boh") == MAX_VOXELS, "griglia invalida -> default")
check(MAX_VOXELS_ABSOLUTE * 98 / 1024**3 < 1.0,
      "tetto assoluto sotto 1 GB nel browser (~%.2f GB)" % (MAX_VOXELS_ABSOLUTE * 98 / 1024**3))

print("=== 8. persistenza dei pack su disco (#9) ===")
tmp = tempfile.mkdtemp(prefix="voxelpack_test_")
try:
    gen = lambda p, m, g: {"metadata": {"grid_size": [32, 32, 32]},
                           "palette": {"a": "#123456"},
                           "ops": [["fill", 0, 0, 0, 3, 3, 3, "a"]]}
    mgr = pack.PackManager(gen, storage_dir=tmp)
    run = mgr.create_run(["Vaso fiori", "Televisore"], 2, options={"grid_size": "32x32x32"})
    for _ in range(300):
        if run.status == 'done':
            break
        time.sleep(0.05)
    check(run.status == 'done', "pack completato")

    folder = pack.save_pack_to_disk(run, base_dir=tmp)
    check(folder and os.path.isdir(folder), "cartella creata")
    mpath = os.path.join(folder, "manifest.json")
    check(os.path.exists(mpath), "manifest scritto")
    with open(mpath, encoding="utf-8") as f:
        man = json.load(f)
    check(len(man["assets"]) == 4, "4 asset nel manifest")
    check(man["palette"], "palette salvata (riproducibilita')")
    check(sorted(man["objects"]) == ["Televisore", "Vaso fiori"], "oggetti registrati")
    for a in man["assets"]:
        check(os.path.exists(os.path.join(folder, a["file"])), "file presente: %s" % a["file"])

    listed = pack.list_saved_packs(base_dir=tmp)
    check(len(listed) == 1 and listed[0]["assetCount"] == 4, "elenco pack salvati")

    loaded = pack.load_saved_pack(os.path.basename(folder), base_dir=tmp)
    check(loaded and len(loaded["assets"]) == 4, "pack ricaricato")
    check(all(a.get("model") for a in loaded["assets"]), "modelli ricaricati")

    check(pack.load_saved_pack("../../etc", base_dir=tmp) is None, "path traversal respinto")
    check(pack.load_saved_pack("inesistente", base_dir=tmp) is None, "cartella ignota -> None")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("=== 9. ancoraggio integrato nel worker ===")
mgr2 = pack.PackManager(storage_dir=tempfile.mkdtemp(prefix="voxelpack_t2_"), generate_fn=lambda p, m, g: {
    "metadata": {"grid_size": [32, 32, 32]},
    "palette": {"a": "#AABBCC"},
    # deliberatamente spostato e sollevato: il worker deve ancorarlo
    "ops": [["fill", 20, 7, 20, 24, 11, 24, "a"]]})
r2 = mgr2.create_run(["Oggetto"], 1, options={"grid_size": "32x32x32"})
for _ in range(200):
    if r2.status == 'done':
        break
    time.sleep(0.05)
check(r2.counts()['done'] == 1, "job completato")
bb = pack.model_bounds(r2.jobs[0].result)
check(bb[1] == 0, "asset ancorato a y=0 dal worker (miny=%d)" % bb[1])

print("\nTUTTI I TEST EXTRA PASSATI")
