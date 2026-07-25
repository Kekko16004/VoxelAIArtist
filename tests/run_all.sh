#!/usr/bin/env bash
# Esegue tutta la suite di verifica di VoxelAIArtist.
# Uso:  bash tests/run_all.sh
#
# Non serve rete ne' cookie: il client Gemini e' sostituito da un generatore
# finto in ogni test. Nessun test consuma quota AI.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 1

fails=0
run() {
  local label="$1"; shift
  echo ""
  echo "=============================================="
  echo " $label"
  echo "=============================================="
  if "$@"; then
    echo "--> OK: $label"
  else
    echo "--> FALLITO: $label"
    fails=$((fails + 1))
  fi
}

# 1. Coda pack + distillatore di stile + vincolo cromatico (generatore finto).
run "Coda pack e stile (Python)" python3 tests/test_pack.py

# 2. Endpoint HTTP /api/pack/* sul vero ThreadingHTTPServer.
run "API end-to-end (Python)" python3 tests/test_api_e2e.py

# 3. Parita' expand_ops (Python) <-> expandOps (JS).
#    CLAUDE.md impone che le due implementazioni restino identiche: questo test
#    e' la rete di sicurezza che lo verifica op per op.
run "Parita' ops Python <-> JS" bash -c '
  node tests/ops_parity_js.mjs >/dev/null || exit 1
  python3 - <<PY
import json, os, sys
ROOT = os.getcwd()
sys.path.insert(0, os.path.join(ROOT, "src"))
from parser import expand_ops
cases = json.load(open(os.path.join(ROOT, "tests/ops_parity_cases.json")))
js = json.load(open(os.path.join(ROOT, "tests/.js_out.json")))
bad = []
for name, data in cases.items():
    r = expand_ops(json.loads(json.dumps(data)))
    py = sorted("%s,%s,%s,%s" % (v["x"], v["y"], v["z"], (v.get("color") or "").upper())
                for v in r.get("voxels", []))
    if py != js[name]:
        bad.append(name)
print("parita: %d/%d casi identici" % (len(cases) - len(bad), len(cases)))
if bad:
    print("DIVERGENTI:", bad)
    sys.exit(1)
PY
'

# 4. Logica UI del pannello pack (DOM finto + fetch finto).
run "UI modalita' pack (Node)" node tests/test_pack_ui.mjs

# 4b. Funzionalita' del secondo round: ancoraggio/scala (#4), persistenza (#9),
#     budget adattivo per le griglie grandi.
run "Pack: ancoraggio, report, persistenza" python3 tests/test_pack_extras.py

# 4c. Renderer incrementale: deve produrre lo STESSO stato del rebuild completo.
run "Rendering incrementale (Node)" node tests/test_incremental.mjs

# 4d. Scrittore ZIP: archivio valido, verificato anche da Python zipfile.
run "Export ZIP" bash -c 'node tests/test_zip.mjs && python3 tests/verify_zip.py'

# 5. La build rigenera ui/index.html e il bundle e' sintatticamente valido.
run "Build UI e sintassi bundle" bash -c '
  node ui/build.mjs >/dev/null || exit 1
  python3 - <<PY
lines = open("ui/index.html", encoding="latin1").read().split("\n")
s = max(i for i, l in enumerate(lines) if l.strip() == "<script>")
e = next(j for j in range(s, len(lines)) if lines[j].strip() == "</script>")
open("tests/.bundle_check.js", "w", encoding="utf-8").write("\n".join(lines[s+1:e]))
PY
  node --check tests/.bundle_check.js || exit 1
  rm -f tests/.bundle_check.js
  echo "bundle: sintassi valida"
'

# 6. Le chiavi i18n del pack esistono in tutte le lingue.
run "Chiavi i18n complete" python3 -c "
import json, glob, os
langs = 0
for f in sorted(glob.glob('ui/locales/*.json')):
    if os.path.basename(f) == 'index.json':
        continue
    d = json.load(open(f, encoding='utf-8'))
    n = len([k for k in d if k.startswith(('pack.', 'genMode.'))])
    assert n == 53, '%s ha %d chiavi pack/genMode invece di 53' % (f, n)
    langs += 1
print('%d lingue, 53 chiavi pack/genMode ciascuna' % langs)
"

echo ""
echo "=============================================="
if [ "$fails" -eq 0 ]; then
  echo " TUTTI I CONTROLLI SUPERATI"
else
  echo " CONTROLLI FALLITI: $fails"
fi
echo "=============================================="
exit "$fails"
