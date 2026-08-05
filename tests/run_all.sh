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

# 3. Parita' expand_ops (Python) <-> expandOps (JS), e voxel_budget_for <->
#    voxelBudgetFor. CLAUDE.md impone che entrambe le coppie restino identiche:
#    questo test e' la rete di sicurezza che lo verifica op per op e griglia per
#    griglia.
run "Parita' ops e tetto Python <-> JS" bash tests/parity_check.sh

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

# 4c-quinquies-bis. Primo drag del gizmo: in r128 TransformControls fotografa
#            _quaternionStart PRIMA di emettere 'dragging-changed', quindi
#            onGizmoDragStart non fa in tempo a correggere un proxy stantio e
#            onGizmoChange (che scrive la posa in ASSOLUTO) portava la posa
#            all'orientamento del proxy: la "posa che non c'entra nulla" al primo
#            movimento, poi Ctrl+Z e da li' tutto bene.
run "Primo drag del gizmo (Node)" node tests/test_gizmo_first_drag.mjs
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

# 4c-decies-bis. Export GLB con le texture. Il raggruppamento passa da v.color al
#            TOKEN e la geometria guadagna l'attributo `uv`. Due trappole
#            misurate: il GLTFExporter r128 dimensiona il canvas su image.width,
#            quindi senza attendere il decode incorpora un'immagine 0x0; e
#            l'attributo `color` va cancellato ANCHE con la texture, perche' map
#            per COLOR_0 rida' lo stesso modello quasi nero dell'invariante 6.
run "Export GLB: materiali con texture (Node)" node tests/test_glb_materials.mjs

# 4c-undecies. Preset di animazione (idle/walk/run/jump/wave). Due invarianti:
#            (1) le BRACCIA devono uscire dalla T-pose. A riposo il braccio e'
#            allineato all'asse X, quindi ruotarlo su X non lo muove di un
#            millimetro: le clip vecchie facevano esattamente quello e le
#            braccia restavano spalancate in ogni animazione. Il test misura in
#            cinematica diretta dove finisce la punta del braccio e pretende uno
#            spostamento reale ad ogni chiave.
#            (2) la `walk` deve riprodurre ESATTAMENTE la clip di riferimento
#            validata a mano, e i preset devono specchiarsi sull'imbardata
#            (faceYaw) senza specchiare la Z delle braccia, che non dipende da
#            dove guarda il personaggio. Le clip AI invece NON vanno coniugate:
#            sono gia' scritte nel frame delle ossa vere.
run "Preset di animazione (Node)" node tests/test_anim_presets.mjs

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

# 4d-ter. Primitive voxel (Shift+A). Le trappole sono tre e tutte gia' viste in
#         questo progetto: una forma che produce ZERO voxel (a 'box' con i float
#         e' successo davvero), l'errore di mezzo voxel che rende sbilenca una
#         sfera di diametro pari, e il guscio esterno mangiato di un voxel da un
#         test sul raggio troppo severo. Il test controlla anche che la forma piu'
#         costosa venga RIFIUTATA a monte invece di essere troncata.
run "Primitive voxel (Node)" node tests/test_primitives.mjs

# 4d-ter-bis. La META' CON IL DOM delle primitive: la scorciatoia Shift+A, i due
#         passi del dialogo, il rifiuto per budget e il centraggio dell'oggetto
#         creato. Il test qui sopra si ferma al marcatore "UI" e prova solo la
#         matematica; il bootstrap con DOM finto fa girare initPrimitives contro
#         un proxy dove ogni id esiste, quindi prova che il codice non solleva,
#         NON che decida bene (e non puo' accorgersi di un id sbagliato).
#         Qui il DOM finto e' severo: un id sconosciuto torna undefined.
run "Primitive: dialogo e scorciatoia (Node)" node tests/test_primitives_ui.mjs

# 4d-ter-ter. Ctrl+Z quando l'oggetto attivo e' cambiato dopo lo scatto. Uno scatto
#         porta i voxel del SOLO oggetto attivo, quindi ripristinarli mentre e'
#         attivo un altro oggetto lo svuota in silenzio: misurato su Shift+A (la
#         primitiva nuova scendeva a 2 voxel) e su Elimina (l'oggetto superstite
#         ereditava i 50 voxel di quello eliminato). Il test fissa anche l'ORDINE
#         buildModel -> ripristino del rig: invertirlo spegne il rig a ogni Ctrl+Z,
#         ed e' la fix "ovvia" e sbagliata.
run "Undo con cambio oggetto (Node)" node tests/test_undo_object_switch.mjs

# 4d-ter-quater. Ctrl+X = taglia l'oggetto attivo (la X di Blender). Il blocco
#         `if (e.ctrlKey || e.metaKey)` di 13-history.js esce con un `return`
#         incondizionato, quindi una gestione scritta piu' in basso nello stesso
#         handler non verrebbe MAI eseguita e il tasto sembrerebbe morto. Il test
#         esegue il vero blocco e la vera objDelete, e tiene ferme le guardie:
#         niente taglio in un campo di testo, sotto una modale o sopra la
#         timeline (dove la X elimina gia' i keyframe). Verifica anche che il
#         confronto `opts.conferma === false` resti ESPLICITO: objDelete e'
#         agganciata anche come listener del pulsante, quindi un controllo di
#         verita' farebbe sparire l'oggetto senza chiedere nulla.
run "Ctrl+X taglia l'oggetto (Node)" node tests/test_object_cut.mjs

# 4d-quater. Ctrl+A nella timeline = seleziona tutti i keyframe. La scorciatoia era
#         rivendicata da TRE punti (timeline, gizmo globale, rig) e la timeline la
#         scartava a monte con `if (ev.ctrlKey ...) return`, quindi non ci arrivava
#         mai. Il test verifica sia la selezione (tutte le tracce, conteggi diversi,
#         toggle) sia lo scoping: dentro l'area consuma l'evento, fuori lo lascia
#         passare al gizmo, e Ctrl+Shift+A resta del rig.
run "Ctrl+A sui keyframe (Node)" node tests/test_timeline_select_all.mjs

# 4d-quater-bis. Afferrare la riga Summary per SPOSTARE i keyframe. Ctrl+A li
#         evidenziava ma non si muovevano: i diamanti del Summary hanno
#         dataset.bone VUOTO (tlAppendRow: `boneName || ''`) e la guardia del ramo
#         di trascinamento pretendeva `&& el.dataset.bone`, cosi' il Summary - la
#         riga che si afferra per prima - cadeva nel ramo "clic nel vuoto", che
#         azzera la selezione e fa scrubbing. Il test ESEGUE il vero handler su un
#         DOM finto e guarda le posizioni delle chiavi, non il testo del sorgente.
run "Trascinamento dal Summary (Node)" node tests/test_timeline_summary_drag.mjs

# 4d-quater-ter. L'altra meta' di Ctrl+A: premuto nella VISTA (col personaggio in
#         posa, non sopra la timeline) deve selezionare tutte le chiavi ma del SOLO
#         frame dove sta il playhead - la colonna sotto l'indicatore. Le trappole
#         sono la conversione frame->secondi (al frame 0 i due valori coincidono
#         per caso, quindi un confronto sbagliato sembra funzionare), il playhead
#         frazionario durante la riproduzione, e il frame senza chiavi: li' deve
#         riportare false, altrimenti consuma il tasto senza fare nulla e spegne
#         anche il gizmo globale.
run "Ctrl+A nella vista: colonna del frame (Node)" node tests/test_timeline_select_frame.mjs

# 4d-septies. Materiali con texture: store nel progetto, id riusabili e i token
#         '#RRGGBB' / '@m1' che viaggiano nella voxelMap. Le trappole coperte
#         sono tre: l'id deve riempire i buchi (primo intero LIBERO) o dopo
#         qualche cancellazione i numeri crescono all'infinito; un token
#         materiale ORFANO (file importato senza le sue definizioni) deve
#         degradare da solo a tinta unita neutra invece di rompere il render;
#         e la tinta media di una texture deve SALTARE i pixel trasparenti,
#         altrimenti ogni texture con bordo trasparente diventa scura.
run "Materiali (store, token, tinta media)" node tests/test_materials.mjs

# 4d-septies-bis. Export OBJ/MTL coi materiali: il greedy mesher unisce per TOKEN (due
#         voxel dello stesso colore con materiali diversi NON si fondono, o la texture
#         del primo si spalma sul secondo), gli UV valgono 0..uw/0..uh cosi' la texture
#         si ripete una volta per VOXEL invece di stirarsi sul quad merged, il .mtl
#         scrive map_Kd + un Kd che resta la tinta vera anche sugli id orfani, e con le
#         texture l'export diventa un solo ZIP col PNG in byte grezzi.
#         Il quad `back` ha l'ordine dei vertici INVERTITO (pre-esistente), quindi una
#         lista fissa di UV e' giusta per lui e trasposta per l'altro verso: su un quad
#         3x1 la texture si ripeteva 3 volte lungo il lato da 1 voxel. Il controllo che
#         lo prende e' quello di isometria, non l'insieme dei `vt` (identico nei due casi).
run "Export OBJ/MTL con texture" node tests/test_obj_materials.mjs

# 4d-quinquies. Persistenza dei pannelli del pannello destro: i quattro <details
#         class="rp-section"> (Outliner, Proprieta', Palette, Vista) devono
#         ricordare il loro stato aperto/chiuso tra una sessione e l'altra.
run "Persistenza pannelli destro (Node)" node tests/test_panel_persist.mjs

# 4d-sexies. F1 dell'Aiuto. helpOverlay ha z-index 70, primOverlay 95 e
#         importOverlay 90: senza guardia F1 costruiva l'Aiuto INVISIBILE dietro
#         al dialogo aperto, e quello ricompariva dal nulla appena il dialogo si
#         chiudeva. Il test tiene ferme entrambe le direzioni: non si apre sotto
#         un'altra modale, e la guardia non intrappola l'Aiuto gia' aperto.
run "F1 dell'Aiuto e le altre modali (Node)" node tests/test_help_modal_f1.mjs

# 4d-sexies-bis. La guida si costruisce DAL DIZIONARIO. Il testo italiano non vive
#         piu' in 31-help.js (erano 85 stringhe duplicate come "fallback", mai lette
#         perche' le chiavi esistono in tutte e 6 le lingue: una copia che nessuno
#         legge puo' solo divergere, e divergeva gia'). Tolto il fallback, la
#         regressione tipica e' una guida che si apre VUOTA o che mostra le chiavi
#         nude: il test pretende che i 13 titoli compaiano davvero nel corpo reso e
#         che cambiando lingua il testo cambi.
run "Guida i18n: testo dal dizionario (Node)" node tests/test_help_i18n.mjs

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

# 5c. Nessun testo per l'utente hardcoded nel frontend. Il test 6 qui sotto
#     controlla che le lingue siano allineate FRA LORO, ma non si accorge di una
#     stringa italiana che non e' mai diventata una chiave: quella non manca da
#     nessun file, semplicemente non esiste. Questa guardia copre l'altro lato,
#     con una BASELINE che lo sweep abbassa fino a zero: e' verde finche' il
#     debito non cresce, rossa appena qualcuno ne aggiunge.
run "Guardia i18n (niente testi hardcoded)" node tests/test_i18n_hardcoded.mjs

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
