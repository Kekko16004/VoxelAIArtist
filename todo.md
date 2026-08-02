# VoxelAIArtist - Piano migrazione WebView -> PyQt6 nativo + bug aperti

Ultimo aggiornamento: 2026-07-28. Questo file e' pensato per essere ripreso in una
chat nuova: contiene contesto, vincoli, strategia e task ordinate.

## Obiettivo dell'utente (testuale)
"Iniziamo piano piano a dipendere meno da webview e ricrea lo stile in python
(pyqt6). Cosi' poi lo toglieremo successivamente." -> ridurre in modo INCREMENTALE
la dipendenza dalla QWebEngineView, ricostruendo la UI (chrome + stile) in widget
PyQt6 nativi, con l'idea di eliminare del tutto la webview in futuro.

## VINCOLO ARCHITETTURALE FONDAMENTALE (leggere prima di tutto)
Il viewport 3D (voxel, editing, gizmo del rig, export GLB/OBJ) e' costruito con
**Three.js = WebGL**. WebGL gira SOLO dentro un contesto Chromium/browser. Quindi:
- La CHROME (pannelli, pulsanti, menu, tab, dialog, launcher, impostazioni) PUO'
  diventare widget PyQt6 nativi.
- Il RENDER 3D NON puo' uscire dalla webview senza riscrivere l'intero motore di
  rendering/editing in un renderer nativo (Qt3D / QOpenGLWidget / QRhi). E' un
  lavoro enorme, da rimandare a una fase finale a se stante.

Conclusione: la strada "piano piano" e' **IBRIDA** -> chrome nativa + un canvas
WebGL minimale ancora nella webview.

## Strategia scelta: IBRIDO (chrome nativa + canvas WebGL)
1. Si tiene la webview ma si riduce a UN SOLO scopo: mostrare il `<canvas>` di
   Three.js, senza pannelli/pulsanti HTML.
2. Tutta la chrome (sidebar, top-bar, pannello destro, impostazioni, launcher)
   viene ricreata in PyQt6 e messa ATTORNO alla webview nel layout della finestra.
3. Nativo <-> JS comunicano via **QWebChannel** (bridge bidirezionale):
   - Nativo -> JS: `self.web.page().runJavaScript("bridgeApi.setTool('place')")`.
   - JS -> Nativo: un `QObject` esposto con `@pyqtSlot`, JS chiama
     `window.qtBridge.onToolChanged('place')`; segnali Qt aggiornano i widget.
4. Si migra UN pannello alla volta: ad ogni pannello spostato la webview perde
   pezzi di HTML -> "dipendenza minore" misurabile.

## Mappa dello stato attuale (dove sta cosa)
- `main.py`: finestra PyQt6 con UNA QWebEngineView a tutto schermo. Serve
  `ui/index.html` via HTTP locale, inietta `window.__API_BASE__`/`__IS_DESKTOP__`.
- `ui/index.html`: GENERATO da `ui/src/lib/*.js` + `ui/src/index.template.html`
  via `node ui/build.mjs`. NON editare index.html a mano. Sorgenti in latin1
  (niente emoji/smart quote).
- Chrome UI attuale (tutta HTML/CSS/JS dentro la webview):
  - Top-bar + menu: vedi `ui/src/lib` (menu/topbar) e template.
  - Sidebar tab: Genera / Vista / Disegna / Rig (`switchTab`).
  - Pannello destro (proprieta'/scene objects).
  - Impostazioni: `ui/src/lib/22-screens.js` (+ `ui/settings.html`).
  - Viewport 3D: `01-scene-setup.js`, `28-incremental.js`, ecc.
- Dialog gia' NATIVI (QFileDialog): Apri / Salva / Scegli cartella (in `main.py`).

## Design tokens (per ricreare lo stile in QSS PyQt6)
Tema scuro (`:root` in `ui/src/index.template.html`):
- bg gradient: `#09070f -> #120d24 -> #05030b` (135deg)
- testo: primary `#f3f4f6`, secondary `#9ca3af`
- accento: primary `#475569`, secondary `#64748b`, deep `#334155`, cyan `#0ea5e9`
- danger `#ef4444`
- glass-bg `rgba(255,255,255,0.03)`, glass-border `rgba(255,255,255,0.07)`
- input-bg `rgba(0,0,0,0.3)`, hover `rgba(255,255,255,0.05)`
- raggi: quasi squadrati (radius 0/2/3px) -> estetica voxel
- layout: sidebar 340px, rightpanel 340px, topbar 46px
- font: 'Plus Jakarta Sans', 13px
Tema chiaro: vedi `:root[data-theme="light"]` nello stesso file.
NOTA QSS: `backdrop-filter: blur()` NON esiste in Qt Style Sheets. Il "glass" va
approssimato con sfondi semi-trasparenti (o QGraphicsBlurEffect, pesante). Va bene
rinunciare al blur nativo: l'effetto vetro reale resta solo sul canvas.

## FASI E TASK (in ordine)

### FASE 0 - Fatto in questa sessione (2026-07-28)
- [x] Rig orientamento (DECISIONE DEFINITIVA): il rig NON deve girare la mesh. Deve
      restare "dritto", ESATTAMENTE come la vista normale (non-rig). Tentativo
      precedente di ruotare 180 gradi attorno al centro -> mesh di spalle: SCARTATO.
      `ui/src/lib/15-rig.js`: `rigGroup` senza rotazione/position (solo
      `rigGroup.add(skinnedMesh)`); `onGizmoDragEnd()` usa il delta grezzo (nessuna
      compensazione `applyQuaternion`, il rigGroup non ha rotazione).
- [x] Rig camminata "al contrario": risolta NELL'ANIMAZIONE, non nella mesh.
      In `buildAnimationClips()` (clip walk + run) invertito il segno dello swing
      avanti/indietro su `upperLeg_L/R` e `upperArm_L/R` (e lean anche dei fianchi
      nella run); `lowerLeg`/`forearm` (ginocchia/gomiti) invariati perche' la
      piega e' indipendente dal verso. DA VERIFICARE a runtime.
- [x] Flicker: `AA_ShareOpenGLContexts` prima di creare QApplication (`main.py`).
- [x] Sfoglia: dialog nativo + `raise_()/activateWindow()` per portarlo in
      primo piano (`choose_dir_dialog` in `main.py`).

### FASE 1 - Bridge QWebChannel (prerequisito di tutto)
- [ ] Aggiungere `QWebChannel` + un `QObject` "Bridge" in `main.py` con slot
      `@pyqtSlot(str)` per gli eventi JS->nativo e segnali per nativo->JS.
- [ ] Iniettare `qwebchannel.js` e creare `window.qtBridge` nel template.
- [ ] Esporre dal JS un `window.bridgeApi` con le azioni gia' esistenti
      (setTool, switchTab, undo/redo, setColor, generate, ecc.) da chiamare via
      `runJavaScript`. NON duplicare logica: sono wrapper sulle funzioni esistenti.
- [ ] Test ping/pong: pulsante nativo -> cambia tool nel canvas; azione nel canvas
      -> aggiorna un QLabel nativo.

### FASE 2 - Guscio finestra nativo
- [ ] Finestra PyQt6 con layout: [top-bar nativa][ sidebar | webview(canvas) | pannello destro ].
- [ ] Foglio di stile QSS globale con i token qui sopra (tema scuro + chiaro).
- [ ] La webview NON e' piu' a tutto schermo: occupa solo l'area centrale.
- [ ] La chrome HTML resta ANCORA attiva sotto, ma si inizia a nasconderla man
      mano che i pannelli nativi la rimpiazzano (flag/CSS class "native-chrome").

### FASE 3 - Migrazione pannelli (uno alla volta, dal meno accoppiato)
Ordine consigliato (dal piu' facile):
- [~] 3a. Impostazioni -> QDialog nativo. IN CORSO (2026-07-28): creato package
      `native/` (`theme.py` = `dark_qss()` mirror dei token; `settings_dialog.py`
      = `SettingsDialog(QDialog)` con "Sfoglia" QFileDialog nativo + apri autosave +
      link alle impostazioni avanzate HTML). Agganciato in `main.py::open_settings()`
      con import lazy e fallback a `open_settings_web()` se l'import fallisce.
      Verificato: ast/import OK (binding PyQt6). DA VERIFICARE a runtime. Risolve B1
      alla radice per questo percorso (QDialog nativo, niente compositing webview).
      TODO 3a: migrare anche cookie/tema al nativo cosi' si elimina `ui/settings.html`.
- [ ] 3b. Top-bar / menu -> QMenuBar/QToolBar nativi.
- [ ] 3c. Tab "Vista" (opzioni camera/rotazione/griglia) -> pannello nativo.
- [ ] 3d. Tab "Disegna" (strumenti, brush, palette) -> pannello nativo + palette
      widget (QColor). Attenzione: palette e strumenti sono molto accoppiati al JS.
- [ ] 3e. Tab "Genera" (prompt AI, grid size, big-structure) -> form nativo che
      POSTa a `/api/generate` (gia' HTTP: nessun bridge necessario per la rete).
- [ ] 3f. Tab "Rig" -> pannello nativo (liste ossa, slider posa, animazioni AI).
- [ ] 3g. Pannello destro (scene objects / proprieta').

### FASE 4 - Ridurre l'HTML al solo canvas
- [ ] Rimuovere dal template tutta la chrome HTML ormai nativa.
- [ ] La pagina servita diventa un canvas Three.js + il minimo indispensabile.

### FASE 5 - (Lungo termine, opzionale) rimozione TOTALE webview
- [ ] Valutare renderer nativo (QOpenGLWidget custom / Qt3D / QRhi) che replichi:
      InstancedMesh per colore, raycasting per editing, greedy mesh export, gizmo
      TransformControls, SkinnedMesh per il rig. E' una riscrittura del motore:
      farla solo se davvero necessario e in un branch dedicato.

## BUG APERTI (da sistemare, con diagnosi)

### B1 - "Sfoglia" non apre (Impostazioni -> cartella default)
- Endpoint GET `/api/settings/choose-dir` -> `choose_dir_dialog()` (native).
- Diagnosi: dialog nativo puo' comparire DIETRO la surface GPU della webview se la
  finestra non ha focus. Mitigato in FASE 0 con `raise_()/activateWindow()` +
  `AA_ShareOpenGLContexts`. DA VERIFICARE a runtime dopo `python main.py`.
- Se persiste: provare `QFileDialog(None, ...)` (parent None -> top-level), oppure
  passare `QFileDialog.Option.DontUseNativeDialog=False` esplicito, o spostare la
  scelta cartella in un QDialog nativo (FASE 3a la risolve alla radice).
- Nota: richiede RIAVVIO dell'app (modifica in main.py, non nel bundle JS).

### B2 - Ctrl+Z rimuove parti del modello (es. "armatura") in scene multi-oggetto
- Causa NOTA e documentata in `ui/src/lib/13-history.js` (righe 6-10):
  `captureSnapshot()` salva SOLO i voxel dell'oggetto ATTIVO + rig + metadati scena.
  NON salva i voxel degli oggetti NON attivi, ne' ripristina add/delete di oggetti.
- Effetto: se armatura e corpo sono oggetti separati, un undo puo' non ripristinare
  i voxel dell'oggetto non attivo -> "me la toglie".
- Fix proposto (task): rendere lo snapshot multi-oggetto (salvare i voxel di TUTTI
  gli oggetti, o uno stack undo per-oggetto). Tradeoff: snapshot piu' pesanti ->
  valutare compressione o diff. Decidere prima di implementare.

### B3 - Flicker (UI sparisce/riappare)
- Applicato `AA_ShareOpenGLContexts` (fix canonico) + i 4 fix precedenti (sfondo
  pagina opaco, show-after-loadFinished, HTTP invece di setHtml, blur ridotto).
- DA VERIFICARE a runtime. Fallback se persiste: `QTWEBENGINE_CHROMIUM_FLAGS` con
  backend ANGLE (`--use-angle=d3d11`) — NON applicato per non rischiare le
  prestazioni WebGL/Three.js senza conferma.

## Come verificare (promemoria)
- Build UI: `node ui/build.mjs` (rifiuta non-latin1); poi `node --check` sul bundle.
- Python: `python -c "import ast; ast.parse(open('main.py',encoding='utf-8').read())"`.
- Suite: `bash tests/run_all.sh` (nota: pre-esiste un fallimento i18n non correlato
  su `de.json` 53/65 chiavi pack).
- Runtime: `python main.py` (i fix Qt su flicker/dialog si vedono solo live).

