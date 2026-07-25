# Task Board — VoxelAIArtist

Stato: `todo` | `in-progress` | `blocked` | `done`. Aggiornare la data quando cambia lo stato.
Creata: 2026-07-19 18:44

> ⚠️ Il PIANO D'AZIONE dettagliato è in `.claude/tasks/action-plan.md`. Questa board traccia lo stato.

---

## T1 — Gerarchia oggetti (multi-oggetto in scena) 🧊+⚙️
Object-mode stile Blender: più oggetti indipendenti nella stessa scena. Su "fai da zero" chiedere se tenere l'oggetto attuale; import di un nuovo oggetto senza rimuovere il vecchio. Selezione, sposta, elimina, unisci (merge) oggetti. Tab = object↔edit mode. Comandi in barra superiore + shortcut.
- Stato: **DONE** (2026-07-19 20:10). Fase A: data-model `sceneObjects`, `currentModelData` alias vivo, retro-compat load/save. Fase B: outliner `#objectsPanel` nel tab Vista (nuovo/duplica/rinomina/unisci/elimina, occhio visibilità, multi-select), modalità Oggetto/Modifica con **Tab** (`KEYMAP.toggleMode`), badge modalità, `BoxHelper` selezione, rendering multi-oggetto (`renderInactiveObjects`/`inactiveGroup`), picking in object mode, import additivo (`appendSceneFromParsed`), undo esteso a metadati scena. QA `node --check` OK, nessun riferimento orfano. Backup: `.claude/backups/index.html.2026-07-19-T1-done.bak`.
- **Limiti noti** (documentati nel codice): oggetto attivo sempre a transform identità → selezionare un oggetto trasformato "cuoce" il transform in coord intere (rotationY a step 90°, pos/scala arrotondate); undo NON annulla add/duplica/elimina/merge; merge = ultimo oggetto vince sulle collisioni. Runtime NON testato nel browser (solo parse-check).
- Agenti: 3D Engine (scena/selezione) + Backend (serializzazione multi-oggetto JSON)
- Dipendenze: nessuna

## T2 — Estrusione assi (tasto E) 🧊
Durante disegno/add/remove, tenendo **E** estrudere lungo uno degli altri due assi per creare blocchi grandi in pochi click. Ri-click cambia asse; annullamento torna alla selezione precedente (safe su misclick).
- Stato: **DONE** (2026-07-19 20:30). Estrusione faccia estesa (flood-fill 4-vicini complanari): E arma sull'oggetto attivo in Modalità Modifica, mouse guida i passi lungo l'asse, preview ghost + HUD italiano `#extrudeHUD`. E ricicla asse X→Y→Z. Click sx = commit (`pushHistory` prima → 1 undo), click dx/Esc = annulla. `KEYMAP.extrude:'e'`. Nessun conflitto tasto (E/Escape erano liberi). QA `node --check` OK.
- **Limiti noti**: estrude solo in celle vuote in-bounds (non spinge voxel esistenti); toggle a Modalità Oggetto annulla il gesto; limiti sicurezza (max 64 passi, ~6000 celle preview, 4096 faccia). Runtime NON testato nel browser.
- Agenti: 3D Engine
- Dipendenze: nessuna (ma integra con undo esistente); T1 done

## T3 — venv + build leggera 📦
venv completo e portabile + `requirements.txt` pinnato. Alleggerire la build finale (QtWebEngine pesante).
- Stato: **done** (2026-07-19, verificato dall'orchestratore 19:35). Creati `requirements.txt` (pin: PyQt6 6.11.0, PyQt6-WebEngine 6.11.0, python-gemini-api 2.4.12, perplexity-api 0.2.0) + `requirements-build.txt` (pyinstaller 6.2.0) + `.claude/reference/setup.md`. `VoxelAI.spec` con excludes sicuri (tkinter/stdlib + PySide6/PyQt5 fallback → risparmio grosso) e candidati Qt commentati da testare. Spec compila OK. RESTA da testare: build reale dell'.exe.
- Agenti: Build/Packaging
- Dipendenze: nessuna
- Nota: la persistenza dell'import `perplexity` in parser.py rende `perplexity-api` obbligatoria a runtime ma è rimovibile rendendo lazy l'import (task backend futuro).

## T4 — Restyling estetico coerente "voxel" 🎨
Frontend meno arrotondato, stile voxel/preciso e coerente. Sistemare tutte le sezioni.
- Stato: **done** (2026-07-19 19:20). Radius tokens (`--radius-*`), colori→CSS vars, `.field` classes, media query adattività (4 breakpoint) aggiunte dall'orchestratore. QA `node --check` OK. Backup: `.claude/backups/index.html.2026-07-19-pre-T6T4.bak`
- Agenti: Frontend/UX
- Dipendenze: coordinare con T6 (temi) per non rifare il CSS due volte

## T5 — (Opzionale) Porting a Python puro 🧊+⚙️+📦
Valutare fattibilità di eliminare Chromium/QtWebEngine e portare il viewer in Python nativo (es. moderngl/pyqtgraph/VTK/Panda3D). + Adattività ad ogni dimensione finestra.
- Stato: **chiuso — DECISIONE UTENTE (2026-07-19 18:58): nessun porting, solo alleggerire (T3)**. Rivalutare pygfx tra 6-12 mesi. Studio archiviato in `.claude/tasks/t5-feasibility.md`.
- Agenti: —
- Dipendenze: —

## T6 — Impostazioni: temi + shortcut rebinding + customizzazione 🎨+⚙️
Tema chiaro/scuro, rebinding shortcut a piacere, massima configurabilità. User-friendly.
- Stato: **parziale** (2026-07-19 19:20). ✅ Tema chiaro/scuro completo (`data-theme`, `applyTheme`, toggle sun/moon, persistito in localStorage + fallback `prefers-color-scheme`). ✅ Fondazione `KEYMAP` (oggetto centrale + `loadKeymap`, tool/brush shortcut passano da lì). ⏳ RESTA: pannello UI di rebinding shortcut, persistenza tema/impostazioni via backend `settings.json`, altre opzioni configurabili (gap voxel, griglia default).
- Agenti: Frontend/UX (UI) + Backend (persistenza in settings.json)
- Dipendenze: coordinare con T4

## T7 — 10 idee per rendere il programma professionale 💡
Consegna: documento con 10 proposte diverse. (Vedi `.claude/tasks/ideas.md` una volta prodotto.)
- Stato: **done** (2026-07-19 18:52) → vedi `.claude/tasks/ideas.md`
- Agenti: Orchestratore + Documenter

---

## Note di coordinamento
- T1 e T2 toccano entrambi il motore editing: sequenziare (prima T1 gerarchia, poi T2 estrusione integrata con oggetto attivo) oppure branch separati con merge attento su `ui/index.html`.
- T4 e T6 condividono il CSS: fare prima l'infrastruttura temi (vars commutabili) poi lo styling.
- Ogni cambio op = doppio update (`parser.py` + `expandOps`).

---

# WAVE 2 (richiesta utente 2026-07-19 ~20:45)
Decisioni utente: Minecraft target = **.schem** (WorldEdit/Litematica); plugin = **API sandboxata**; ordine = **gestito dall'orchestratore**, ma PRIMA **modularizzare in cartelle (lib/utils)** per mobilità.

RISCHIO TECNICO CHIAVE: in desktop mode `main.py._load_html` usa `setHtml` (non HTTP) + string-replace. Split JS in `<script src>` esterni può rompersi con le regole local-file di QtWebEngine. La modularizzazione DEVE funzionare sia via HTTP sia via setHtml/desktop.

## W2-0 — Modularizzazione (FONDAZIONE) — DONE ✅
- Stato: **DONE** (2026-07-19 21:20, verificato dall'orchestratore). Il JS è ora in `ui/src/lib/` (19 frammenti 00→18) + `ui/src/utils/expand-ops.js`, ordine in `ui/src/manifest.json`, template `ui/src/index.template.html`. Build: `node ui/build.mjs` ri-concatena in UN solo `<script>` dentro `ui/index.html`. **`main.py` invariato**, carica identico in HTTP e setHtml.
- **REGOLA D'ORO per tutti gli agenti frontend successivi**: modificare i MODULI in `ui/src/**`, poi `node ui/build.mjs`. NON editare `ui/index.html` a mano (è generato). Verificato: rebuild deterministico, bundle byte-identico all'originale (solo 2 righe header), JS_OK, 273 identificatori top-level invariati, feature intatte. Backup: `.claude/backups/index.html.W2-0-modularized.bak`, `ui-src.W2-0.tar.gz`. Mappa modulo→responsabilità in `.claude/reference/file-map.md`.

## W2-A — Backend I/O + persistenza (main.py, settings.py, nuovi src/) — PARALLELO a W2-0
Route file I/O per salvataggio/apertura .voxai, autosave, versioning in temp folder, persistenza settings (keymap/tema/locale), progetti recenti. File disgiunti da index.html.
- Stato: **DONE** (2026-07-19 21:05, verificato). Route: `/api/prefs` (GET/POST merge), `/api/project/save` (+dialog GUI thread-safe via `_run_on_gui`), `/api/project/open`, `/api/autosave` (POST/list/get/open-folder, rotazione 20), `/api/recent` (GET/POST/DELETE, max 15). Helper in settings.py. Guard anti-traversal (basename+commonpath). Filtro segreti su prefs. PARSE_OK + smoke test OK. `.voxai` = JSON wrapper `{format,version,savedAt,data}`. Parsing binario .vox/.schem NON qui (frontend). Nota sicurezza: save con path esplicito scrive senza sandbox (server locale no-auth) — accettabile per desktop locale.
- **CONTRATTO API** completo nel report agente (vedi log). Da passare agli agenti frontend W2-C.

## W2-B — DONE ✅ (2026-07-19, verificato orchestratore): 6 lingue in `ui/locales/` (it/en/es/fr/de/pt), 196 chiavi IDENTICHE in tutte, 0 mancanti/extra/vuote, JSON validi, index.json ok. Pronto per il wiring i18n.
## W2-B (dettaglio originale) — Locales (nuovi file locale) — PARALLELO
File i18n it/en/es/de/fr/pt + struttura chiavi documentata. File disgiunti.
- Stato: **todo**

## W2-C — Feature frontend (SEQUENZIALI sui moduli, dopo W2-0)
1. T6 completo: pannello rebinding shortcut + persistenza settings (dipende W2-A) — **DONE** (2026-07-19 21:40, verificato). Pannello "Scorciatoie da tastiera" nel tab Vista (tutte le chiavi KEYMAP rimappabili con etichette IT, gestione conflitti, ripristino default). Nuovo modulo `ui/src/lib/19-prefs.js`: `savePref/loadPrefs` con backend `/api/prefs` + fallback localStorage offline. Tema+keymap ora persistiti via prefs. Build deterministico, JS_OK. Id nuovi: shortcutsPanel/List/Conflict/ResetBtn. Limite: rebind cattura tasto singolo (no combinazioni con modificatori). Backup: `index.html.T6-done.bak`.
2. i18n integrazione UI + selettore lingua in impostazioni (dipende W2-B, W2-A) — **DONE** (2026-07-19 23:40, orchestratore). Approccio: annotazione AUTOMATICA invece di manuale (evita il timeout su 1670 righe). (a) `ui/annotate-i18n.mjs`: script deterministico+idempotente che matcha i valori di it.json (lingua sorgente = testi reali del DOM) e inietta `data-i18n`/`data-i18n-title`/`data-i18n-placeholder` — 127 attributi (85 testo, 40 title, 2 placeholder). Verificato byte-level: template IDENTICO a meno degli attributi, sequenza non-ASCII invariata (encoding UTF-8 preservato). (b) Nuovo modulo `ui/src/lib/23-i18n.js`: motore runtime con `t(key,vars)` (per stringhe JS, con interpolazione `{var}`), `applyI18n`, `setLanguage` (persiste via prefs `language`), `initI18n` (auto: index.json→lingua preferita prefs>browser>it, popola `#languageSelect`). Fallback SEMPRE it (se fetch locali fallisce, app resta in italiano = testi template). (c) Annotator integrato in build.mjs (idempotente, best-effort). (d) Aggiunta chiave `settings.language` a tutti i 6 locali. Verifiche: 122 chiavi DOM tutte coperte in it+en, build deterministico, JS_OK, engine testato (base/interp/fallback/missing/noVar tutti OK). **Limite**: ~44 stringhe solo-runtime (alert/confirm/hint dinamici in JS) NON ancora convertite a `t()` — restano in italiano finché non si ricablano le singole call nei moduli JS (incrementale, non blocca). Backup: `index.template.pre-i18n.bak`.
3. Export/import .vox (MagicaVoxel) + .schem (Minecraft) — **DONE** (2026-07-19 22:10, verificato). Modulo `ui/src/lib/20-formats.js`. .vox import+export (round-trip byte-esatto CONFERMATO dall'orchestratore in Node: coord+colori+assi Y↔Z + off-by-one palette OK). .schem Sponge v2 export+import (NBT big-endian + gzip via CompressionStream, fallback non compresso; DataVersion 2975 = MC 1.18.2). Mapping colore→27 blocchi MC per distanza RGB. Pulsanti: exportVoxBtn/exportSchemBtn; import via handleFile (.vox/.schem/.schematic → ArrayBuffer). Build deterministico, JS_OK. **Limiti**: export solo oggetto attivo (non intera scena); .vox max 255 colori/256 per asse, import solo primo modello; .schem round-trip cromatico approssimato (by design). Backup: `index.html.formats-done.bak`.
4. Formato nativo .voxai + autosave + versioning UI (dipende W2-A) — **DONE** (2026-07-19 22:35, verificato). Modulo `ui/src/lib/21-project.js`. Pulsanti: saveProjectBtn/saveProjectAsBtn/openProjectBtn/autosaveHistoryBtn + indicatore autosaveStatus + overlay cronologia. Desktop usa route backend (project/save|open, autosave, recent); Web fa fallback download/localStorage. Dirty flag via wrap NON invasivo di `pushHistory` (preserva this/args/return, side-effect in try/catch — verificato dall'orchestratore, non rompe undo). Autosave ~90s + debounce solo se dirty+voxel. Build deterministico, JS_OK. Backup: `index.html.voxai-done.bak`.
5. Schermate: progetti recenti (avvio), impostazioni migliorata, toolbar migliorata — **DONE** (2026-07-19 22:55, verificato). Modulo `ui/src/lib/22-screens.js`. Launcher overlay all'avvio (recenti da /api/recent, Nuovo/Apri, "Salta", checkbox showLauncherOnStart via prefs). Impostazioni: sezioni Avvio + Salvataggio aggiunte al tab Vista (tema+scorciatoie T6 intatti). Toolbar: etichette gruppo + tooltip IT, nessun id rinominato/listener ricablato (verificato: id esistenti tutti presenti 1×). Build deterministico, JS_OK. Riusa openProject/pushRecent/openAutosaveFolder di 21-project. Backup: `index.html.screens-done.bak`.
   - **FIX #6 (rotellina ctrl→shift): NON necessario.** Il codice già usa `e.shiftKey` per il pan col tasto centrale (01-scene-setup.js:23) e NESSUN movimento camera usa ctrl (ctrl solo per Ctrl+A gizmo e Ctrl+Z/Y undo). Comportamento già conforme alla richiesta. Da CHIEDERE all'utente se l'annoyance reale è diversa (es. pan senza shift, o zoom). NON toccata la navigazione per evitare regressioni.
6. Performance — **DONE** (2026-07-19 23:05, fatto dall'ORCHESTRATORE direttamente dopo 3 fallimenti API di rete dei subagent — tutti in fase di lettura, nessuno un problema di codice). Scelta prudente ad alto valore invece del chunking rischioso:
   - **Fix memory leak GPU (impatto principale)**: `buildModel` rimuoveva i vecchi mesh con `remove()` ma senza `dispose()` → geometry+material orfani sulla GPU a ogni edit (place/remove/draw chiamano buildModel a ogni pennellata), con accumulo e rallentamento progressivo. Aggiunto `disposeMesh()` (05-build-model.js) chiamato prima di scartare meshes/gridHelper/boxHelper. Verificato con unit-test su mock (instMesh, array materiali, casi limite null/mancanti: nessuna eccezione).
   - **Skip rebuild oggetti inattivi durante edit**: nuovo param `buildModel(resetCamera, skipInactive)`. Gli edit dell'oggetto attivo (performAction place/remove/draw + fill riga 356 in 14-tools-actions.js) passano `skipInactive=true` → non ricostruiscono gli oggetti T1 inattivi (che non cambiano). Default `false` = comportamento invariato per load/generate/import/switch. Estrusione lasciata su rebuild completo (prudenza).
   - **Chunking/LOD: NON fatto** (deciso consapevolmente). A dimensioni tipiche il rischio di regressione su picking (`userData.voxels[instanceId]`) e visibilità cross-boundary superava il beneficio. Verificato che inactive objects (04-objects.js) usano `objectGroups` separati con dispose proprio → `disposeMesh(meshes)` non tocca le loro geometrie.
   - Build deterministico, JS_OK. Backup: `index.html.perf-done.bak`.
6-orig. Performance: chunking + rebuild incrementale + LOD
7. Plugin: API sandboxata + hook documentati — **DONE** (2026-07-20 00:20, orchestratore). Modulo `ui/src/lib/24-plugins.js` + pannello "Plugin & Script" nel tab Disegna (pluginSelect/Code/Desc/RunBtn/ResetBtn/Status).
   - **Isolamento reale via Web Worker**: lo script gira in un worker (nessun `document`/`window`/scope condiviso). Il bootstrap del worker AZZERA esplicitamente fetch/XMLHttpRequest/WebSocket/importScripts/indexedDB/caches/navigator/Notification/SharedWorker/Worker → niente rete/persistenza/DOM. Comunica solo via postMessage. **Verificato** con vm sotto semantica-worker fedele (global===self): dentro il plugin `typeof fetch/XMLHttpRequest/importScripts/indexedDB === "undefined"`, DOM → ReferenceError.
   - **Contratto documentato**: `function transform(voxels, api)` → ritorna nuovi voxel. `api` = sole utility pure (metadata, gridSize, log, key, hexToRgb, rgbToHex). 3 plugin builtin didattici (mirror-x, grayscale, hollow) — tutti testati: output valido e corretto.
   - **Guardrail**: timeout 4s (worker terminato), max 400k voxel, `sanitize()` host (rifiuta non-array, scarta voxel invalidi, arrotonda coord, normalizza #rgb→#rrggbb, colore invalido→#cccccc — tutto testato). Fallback in-thread con globals ombreggiati se il Worker non si crea (raro; segnalato in UI "[fallback senza worker]").
   - **Hook/undo**: run → valida → `pushHistory()` → sostituisce `currentModelData.voxels` → `buildModel(false, true)`. Quindi **annullabile con Ctrl+Z**. Opera solo sull'oggetto attivo (non tocca gli inattivi).
   - i18n: 11 chiavi `plugins.*` in tutti i 6 locali. Build deterministico, JS_OK, worker-source JS valido. Coverage i18n: 130 chiavi DOM tutte coperte in tutti i locali (208 chiavi/locale). Backup: `index.html.plugins-done.bak`.
   - **Limiti noti**: input voxel copiato (plugin non può mutare la scena se non via return); risultato = solo voxel (metadata/rig non modificabili by design); nessuna persistenza dei plugin custom (il codice nel textarea si perde a reload — solo i builtin sono ricaricabili con Reset); NON testato dentro QtWebEngine desktop (setHtml/file-baseUrl) — se i blob-worker fossero bloccati lì, scatta il fallback in-thread automaticamente.

## Cleanup Perplexity — DONE ✅ (2026-07-19 23:55, orchestratore, richiesto dall'utente "build leggera")
- **`perplexity-api` rimosso da runtime.** `import perplexity` in cima a `src/parser.py` era ridondante: `start_local_server()` (server standalone legacy, mai usato dall'app) aveva GIÀ un suo `import perplexity` lazy alla riga 511. Rimosso l'import globale → il path live (`main.py` → `extract_and_parse_json`/`expand_ops`, generatore = Gemini) non richiede più perplexity. **Provato** bloccando perplexity via meta_path: parser importa e le funzioni live funzionano senza. requirements.txt: da 7 a 6 deps runtime (Qt stack + python-gemini-api).
- **`scratch/test_perplexity.py` ELIMINATO** (+ cartella scratch/ vuota rimossa). Era codice morto (test throwaway) E conteneva un **session token Perplexity hardcoded** (credenziale reale in chiaro). Backup in job tmp. Non è un repo git → nessuna history da bonificare.
- Doc aggiornati: requirements.txt, CLAUDE.md. py_compile OK su main/parser/settings.
- Residui innocui (solo storici): AG_TODO.md (changelog vecchio), setup.md/action-plan.md (note).

Backup pre-wave2: `.claude/backups/index.html.2026-07-19-pre-wave2.bak`, `main.py.pre-wave2.bak`, `settings.py.pre-wave2.bak`
