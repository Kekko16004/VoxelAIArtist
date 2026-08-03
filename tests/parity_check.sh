#!/usr/bin/env bash
# Parita' Python <-> JS delle DUE regole che CLAUDE.md impone identiche nelle due
# lingue: l'espansione delle ops (expand_ops / expandOps) e il tetto dei voxel
# (voxel_budget_for / voxelBudgetFor).
#
# Vive in un file suo, e non inline in run_all.sh, per essere eseguibile da solo:
# la batteria di mutazioni lo lancia isolato invece di ripetere tutta la suite.
#
# Uso:  bash tests/parity_check.sh     (dalla radice del repo o da qualunque cwd)

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")" || exit 1

node tests/ops_parity_js.mjs >/dev/null || exit 1

python3 - <<'PY'
import json, os, sys
ROOT = os.getcwd()
sys.path.insert(0, os.path.join(ROOT, "src"))
from parser import expand_ops, voxel_budget_for

cases = json.load(open(os.path.join(ROOT, "tests/ops_parity_cases.json")))
js = json.load(open(os.path.join(ROOT, "tests/.js_out.json")))
# Stesso motivo del conteggio delle griglie piu' sotto: un file di casi vuoto
# metterebbe d'accordo i due lati su niente, e "0/0 identici" uscirebbe verde.
if len(cases) < 20 or len(js) != len(cases):
    print("COPERTURA PERSA: %d casi di ops (attesi almeno 20), %d dal lato JS"
          % (len(cases), len(js)))
    sys.exit(1)
bad = []
for name, data in cases.items():
    r = expand_ops(json.loads(json.dumps(data)))
    py = sorted("%s,%s,%s,%s" % (v["x"], v["y"], v["z"], (v.get("color") or "").upper())
                for v in r.get("voxels", []))
    if py != js[name]:
        bad.append(name)
print("parita ops: %d/%d casi identici" % (len(cases) - len(bad), len(cases)))
if bad:
    print("DIVERGENTI:", bad)

# Il TETTO dei voxel e' la seconda regola scritta due volte, e finora nessun test
# la ancorava: alzare MAX_VOXELS_ABSOLUTE nel SOLO lato JS passava l'intera
# suite. Ed e' un tetto MISURATO, non arbitrario: ~98 byte per cella di Map,
# quindi 24M celle = ~2,2 GB e la scheda del browser muore.
bud = json.load(open(os.path.join(ROOT, "tests/.js_budget.json")))
griglie, attesi = bud["grids"], bud["values"]

# La lista di griglie arriva dal lato JS, quindi il confronto si fida di quanto
# gli viene passato: con una lista vuota zip() non itera e "0/0 identiche" esce
# VERDE. Misurato con due mutazioni (lista troncata a 3, lista svuotata): en-
# trambe passavano. Il conteggio e i casi limite vanno quindi PRETESI qui, dal
# lato che non li produce.
ATTESE = 22
SONDE = [None, [16, 16, 16], [201, 201, 201], [512, 512, 512], ["128", "128", "128"]]
manca = [s for s in SONDE if s not in griglie]
if len(griglie) != ATTESE or manca or len(attesi) != len(griglie):
    print("COPERTURA PERSA: %d griglie su %d attese, %d valori, sonde assenti: %r"
          % (len(griglie), ATTESE, len(attesi), manca))
    print("    (se hai cambiato la lista in tests/ops_parity_js.mjs, aggiorna ATTESE qui)")
    sys.exit(1)
# I due rami interessanti devono essere entrambi ESERCITATI, non solo presenti:
# senza il pavimento a 4M e il tetto a 8M il confronto girerebbe a vuoto.
if 4000000 not in attesi or 8000000 not in attesi:
    print("COPERTURA PERSA: le griglie non toccano ne' il minimo ne' il tetto")
    sys.exit(1)

diff = []
for g, atteso in zip(griglie, attesi):
    got = voxel_budget_for(g)
    if got != atteso:
        diff.append("%r: js=%r py=%r" % (g, atteso, got))
print("parita tetto: %d/%d griglie identiche" % (len(griglie) - len(diff), len(griglie)))
for d in diff:
    print("    TETTO DIVERGENTE", d)

sys.exit(1 if (bad or diff) else 0)
PY
