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
run "Export GLB: posa dell'editor (Node)" node tests/test_glb_pose_export.mjs

# 4c-decies. Artefatti dell'export RIGGATO, che gli export statici non avevano:
#            (1) la faccia fra due voxel di ossa DIVERSE serve a schermo (bordo
#            del weight paint) ma in export sono due quad coplanari a distanza
#            zero -> z-fighting, i "triangoli a ombreggiatura alternata" e le
#            schegge che attraversano la mesh quando la posa muove le ossa;
#            (2) la geometria riggata porta un attributo `color` e il
#            GLTFExporter r128 lo scrive in COLOR_0 guardando la GEOMETRIA, non
#            material.vertexColors: in glTF vale baseColorFactor * COLOR_0,
#            quindi il colore veniva applicato due volte e il modello usciva
#            quasi nero.
run "Export GLB: artefatti del riggato (Node)" node tests/test_glb_rigged_artifacts.mjs

# 4c-septies. Separazione delle gambe nel binding "Pezzi": con parti PER ARTO ogni
#            catena riceve i suoi voxel e nessuno finisce sull'osso del lato
#            opposto (era la saldatura che strappava la camminata). Una parte
#            simmetrica su entrambe le gambe non puo' alimentarle tutte e due
#            senza incrociare: deve salire sull'antenato comune (`hips`), non
#            fare coin flip su una gamba sola.
run "Separazione gambe nel binding Pezzi (Node)" node tests/test_rig_parts_legs.mjs

# 4c-octies. Focus "appiccicoso" dei pannelli di sinistra: dopo aver usato un
#            <select>/checkbox/bottone l'elemento CONSERVA il focus, e le
#            scorciatoie globali si spegnevano per qualunque elemento
#            focalizzato (Tab, Ctrl+A, Ctrl+Z morti finche' non si cliccava
#            altrove). Il test controlla entrambi i livelli del rimedio: il
#            filtro consapevole del TASTO e il rilascio del focus dopo il
#            mouse, che pero' NON deve scattare sul click sintetico di
#            Invio/Spazio (altrimenti si spezza la navigazione da tastiera).
run "Focus e scorciatoie da tastiera (Node)" node tests/test_focus_shortcuts.mjs

# 4c-nonies. Canali dei keyframe (stile Unity): con I si sceglie Location,
#            Rotation o tutti e due. Il test tiene fermi tre invarianti che
#            si rompono facilmente: un canale NON richiesto non va perso
#            re-chiavando l'altro sullo stesso frame; il canale Location fa
#            il giro completo (rig.posePos -> chiave -> campionamento ->
#            rig.posePos), cosi' chiavare durante lo scrub salva il valore
#            che si vede e non zero; e una chiave di sola Location non deve
#            inventarsi una rotazione. Copre anche la tastiera del menu
#            (frecce, Invio, L/R/B, Esc).
run "Canali dei keyframe: Location/Rotation (Node)" node tests/test_channel_keys.mjs

# 4c-sexies. Capacita' del backend: "desktop" NON vuol dire "c'e' un backend". In
#            modalita' web (il default) il server Python c'e' e autosave/cronologia
#            devono andare su disco; mancano solo i dialog nativi Qt.
run "Capacita' backend: web vs desktop (Node)" node tests/test_backend_caps.mjs

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

# 5b. Il bundle non deve solo COMPILARE: deve anche arrivare in fondo al
#     bootstrap. Il 2026-08-01 una funzione in 19-prefs.js ha chiamato t()
#     durante l'init, ma `i18nDict` (23-i18n.js, piu' avanti nel manifest) era
#     ancora in temporal dead zone: ReferenceError, tutto cio' che veniva dopo
#     non e' mai partito e l'app si apriva con viewport nera e bottoni morti.
#     `node --check` non vedeva nulla perche' la sintassi era valida.
run "Bootstrap del bundle (DOM finto)" node tests/test_bootstrap.mjs

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

echo ""
echo "=============================================="
if [ "$fails" -eq 0 ]; then
  echo " TUTTI I CONTROLLI SUPERATI"
else
  echo " CONTROLLI FALLITI: $fails"
fi
echo "=============================================="
exit "$fails"
