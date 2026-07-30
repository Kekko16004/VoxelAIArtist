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

# 2b. Normalizzazione delle animazioni AI: il client (15-rig.js) accetta UNA sola
#     forma, il modello ne produce molte. normalize_anim_data deve ricondurle
#     tutte al contratto, altrimenti "Aggiungi animazione" fallisce sempre.
run "Animazioni AI: normalizzazione (Python)" python3 tests/test_animate.py

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

# 4b-bis. Blocchi modulari per level builder + palette non invasiva.
#         Un blocco di ferro non deve prendere i colori della terra, e i tile
#         devono riempire la griglia o nel level builder restano fessure.
# NOTA: test_modular.py richiede il codice palette della PR #3 (ancora aperta).
# Su questo branch non e' presente, quindi il test viene saltato se manca.
run "Blocchi modulari e palette" bash -c '
  python3 -c "import sys; sys.path.insert(0,\"src\"); import pack; sys.exit(0 if hasattr(pack,\"_same_material\") else 42)" 2>/dev/null
  if [ $? -eq 42 ]; then
    echo "SALTATO: richiede il codice palette della PR #3 (non ancora su questo branch)"
    exit 0
  fi
  python3 tests/test_modular.py'


# 4c. Renderer incrementale: deve produrre lo STESSO stato del rebuild completo.
run "Rendering incrementale (Node)" node tests/test_incremental.mjs

# 4c-bis. REGRESSIONE EDITING: la geometria condivisa non va distrutta, il frame
#         va richiesto, e il costo per pennellata non deve dipendere dal modello.
#         Questi tre difetti rendevano l'editing bloccante: test obbligatorio.
run "Editing non si blocca (Node)" node tests/test_editing_freeze.mjs

# 4c-ter. Loop di render: il budget deve ricaricarsi a ogni input, altrimenti
#         un percorso che dimentica requestRender congela lo schermo.
run "Loop di render (Node)" node tests/test_render_loop.mjs

# 4c-quater. Binding del rig: scheletro semplificato (niente pelvis/upperChest), le
#            ossa-punta non rubano voxel, coerenza spaziale, e le sovrascritture del
#            weight paint. Sono i difetti che si vedevano come strappi in Blender.
run "Binding rig e weight paint (Node)" node tests/test_rig_weights.mjs

# 4c-quinquies. Strumenti rig: specchio posa/pesi su X, simmetrizzazione dello
#            scheletro, editing delle ossa (il nome e' l'identita', `parent` e' un
#            INDICE da rimappare), geometria dell'IK a due ossa e libreria di pose.
run "Strumenti rig: specchio, IK, pose (Node)" node tests/test_rig_tools.mjs

# 4c-sexies. Capacita' del backend: "desktop" NON vuol dire "c'e' un backend". In
#            modalita' web (il default) il server Python c'e' e autosave/cronologia
#            devono andare su disco; mancano solo i dialog nativi Qt.
run "Capacita' backend: web vs desktop (Node)" node tests/test_backend_caps.mjs

# 4c-septies. "Ruota modello": ruotare lo scheletro di 180 gradi lasciava le
#            animazioni fuori asse (il personaggio camminava di lato). Ora si
#            ruotano i VOXEL a passi esatti di 90 gradi, si rimappano i pesi
#            dipinti e le clip tengono conto dell'orientamento delle ossa.
run "Rotazione modello e clip orientate (Node)" node tests/test_rig_rotate.mjs

# 4c-septies-bis. bakeTransform (Proprieta' > Rotazione Y) usava i segni OPPOSTI
#            a THREE: l'anteprima girava in un verso e al commit l'oggetto
#            girava nell'altro. Il bake deve essere identico a Ry(+a) di THREE,
#            che e' cio' che mostrano modelPivot e i Group degli oggetti inattivi.
run "Bake del transform = anteprima (Node)" node tests/test_object_transform.mjs

# 4c-octies. Timeline: i keyframe delle clip predefinite (camminata, salto...)
#            non erano disegnati perche' si leggevano solo da rig.customAnims:
#            ora si ricavano dalla clip vera e restano in sola lettura.
run "Timeline: keyframe clip predefinite (Node)" node tests/test_timeline_preset.mjs

# 4c-nonies. Sezioni richiudibili della sidebar: le sezioni iniettate a runtime
#            vanno promosse a <details>, lo stato va ricordato in localStorage e
#            un JSON corrotto non deve lasciare la sidebar vuota.
run "Sezioni sidebar richiudibili (Node)" node tests/test_sections.mjs

# 4d-bis. Voxelizzazione GLB: i voxel DEVONO stare dentro la griglia. La
#         versione a raggi ne produceva 0% dentro (vista vuota).
run "Voxelizzazione GLB (Node)" node tests/test_import_glb.mjs

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

# 6. Ogni lingua ha esattamente le chiavi della lingua di riferimento (it).
#    Prima qui c'era un numero fisso (65) che non ha mai corrisposto alla
#    realta' (le lingue hanno sempre avuto 53 chiavi pack/genMode): il
#    confronto con it.json non va aggiornato a mano e copre TUTTE le chiavi,
#    non solo quelle del pack.
run "Chiavi i18n complete" python3 -c "
import json, glob, os
ref = json.load(open('ui/locales/it.json', encoding='utf-8'))
langs = 0
for f in sorted(glob.glob('ui/locales/*.json')):
    if os.path.basename(f) == 'index.json':
        continue
    d = json.load(open(f, encoding='utf-8'))
    missing = sorted(set(ref) - set(d))
    extra = sorted(set(d) - set(ref))
    assert not missing, '%s: %d chiavi mancanti, es. %s' % (f, len(missing), missing[:5])
    assert not extra, '%s: %d chiavi non presenti in it.json, es. %s' % (f, len(extra), extra[:5])
    empty = sorted(k for k, v in d.items() if isinstance(v, str) and not v.strip())
    assert not empty, '%s: chiavi vuote %s' % (f, empty[:5])
    langs += 1
print('%d lingue, %d chiavi ciascuna (riferimento it.json)' % (langs, len(ref)))
"

# 6b. Ogni chiave citata dal codice esiste davvero in it.json.
#     Il test 6 confronta i locali FRA LORO: una `t('chiave.inventata')` passava
#     inosservata e in UI compariva la chiave al posto del testo (succedeva con
#     t('rig.anim.errGeneric'), mai esistita).
run "Chiavi i18n usate dal codice" python3 tests/test_i18n_keys_used.py

# 6c. Nessun messaggio italiano scritto a mano: la direzione opposta del 6b.
#     Serviva: 89 alert/confirm/prompt/title erano rimasti hardcoded mentre la
#     chiave giusta esisteva gia' in tutti e 6 i locali.
run "Nessuna stringa italiana hardcoded" python3 tests/test_i18n_no_hardcoded.py

# 6d. Nessun testo italiano non annotato nel MARKUP: il 6c guarda solo il JS,
#     percio' le sezioni del rig, i tooltip della barra progetto e "Sposta"
#     restavano in italiano in qualsiasi lingua (61 voci fra testi e title=).
run "Template i18n: niente italiano nel markup" python3 tests/test_i18n_template.py

echo ""
echo "=============================================="
if [ "$fails" -eq 0 ]; then
  echo " TUTTI I CONTROLLI SUPERATI"
else
  echo " CONTROLLI FALLITI: $fails"
fi
echo "=============================================="
exit "$fails"
