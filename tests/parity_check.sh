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
diff = []
for g, atteso in zip(bud["grids"], bud["values"]):
    got = voxel_budget_for(g)
    if got != atteso:
        diff.append("%r: js=%r py=%r" % (g, atteso, got))
print("parita tetto: %d/%d griglie identiche" % (len(bud["grids"]) - len(diff), len(bud["grids"])))
for d in diff:
    print("    TETTO DIVERGENTE", d)

sys.exit(1 if (bad or diff) else 0)
PY
