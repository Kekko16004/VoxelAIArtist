# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VoxelAIArtist is a desktop voxel modeling app with integrated AI generation. A PyQt6 window (`main.py`) embeds a Chromium `QWebEngineView` that loads `ui/index.html` — a Three.js viewer/editor. A background Python HTTP server (started in `main.py`) serves the local files and proxies `/api/generate` to an AI backend. The UI is in Italian; keep new user-facing strings in Italian.

## Run & build

```bash
python main.py                 # launch (default: WEB mode, see APP_MODE below)
python main.py --py            # launch the PyQt6 desktop window instead
VOXELAI_MODE=web python main.py    # same as --web
pyinstaller --clean VoxelAI.spec   # build dist/VoxelAIArtist.exe (or run build.bat on Windows)
```

- **`APP_MODE` (top of `main.py`) picks the launch mode** and defaults to `"web"`:
  no Qt window at all — only the local HTTP server starts and the UI opens in the
  system browser (`webbrowser.open`), which removes the QWebEngineView flicker
  entirely. `"py"` is the classic embedded webview. Override order: CLI
  (`--web` / `--py` / `--mode=web`) > env `VOXELAI_MODE` > the constant. An
  unknown value prints a warning and falls back to `"py"`.
- In web mode the Qt import block is **skipped**, so `window.__IS_DESKTOP__` /
  `window.__API_BASE__` are NOT injected (relative `fetch('/api/...')` still works:
  same origin) and the native dialogs (`/api/project/open`, `/api/settings/choose-dir`)
  answer `501` — the UI already degrades to browser download/file input.
- Startup never opens `ui/settings.html` any more: `GET /api/settings` exposes
  `needsCookies` (plus `app_mode` / `is_desktop`) and the in-app settings modal
  decides. Missing cookies only print a console hint.
- If no Qt binding is importable in `"py"` mode, `main.py` degrades to web mode.
- Qt binding is auto-detected in priority order PyQt6 → PySide6 → PyQt5 (`GUI_LIBRARY`).
- `PORT = 0` lets the OS pick a free port; the main thread spin-waits until the server thread sets it.

## Verifying changes

**La GUI si puo' provare DAVVERO in questo ambiente**, e piu' sessioni di fila si
erano fermate credendo di no. `python -m playwright` con Chromium e WebGL via
SwiftShader (`--enable-unsafe-swiftshader`), piu' Pillow per misurare i pixel.
Gli arnesi stanno in `.superpowers/` (gitignored), non nella suite.
Il 2026-08-05 questa prova ha trovato **quattro difetti che la suite verde non
vedeva**: i materiali erano per-oggetto invece che per-progetto (Shift+A e il
pannello tornava vuoto), `activeColorRow`/`activeMaterialName` non esistevano nel
template (meta' della mutua esclusione era invisibile), un `.voxai` salvato non si
riapriva perche' nessuno scartava la busta, e gli oggetti inattivi perdevano le
texture. Nessuno di questi e' visibile leggendo il codice o dai test unitari.
Lo stesso giorno `.superpowers/check_creator.py` (55 controlli sul Creatore di
materiali) ne ha trovato un **quinto della stessa famiglia**: il CSS del pixel
editor puntava a `#pixelArtCanvas` mentre il template dichiara
`#materialArtCanvas`, quindi nessuna regola si applicava — la tela restava larga
16 px, la griglia scivolava accanto invece che sopra e i clic della gomma cadevano
su un'altra cella. Sintomo: "la gomma non cancella". Causa: un selettore.
Regole apprese:
- Un pannello nuovo va provato **con clic veri**, e le asserzioni sui pixel del
  canvas 2D (`getImageData`) sono affidabili: e' il canvas WebGL a non esserlo.
- Sul CSS non si asserisce "non deve essere bianco": in tema chiaro
  `--input-bg-strong` *e'* `#ffffff` e `--radius-sm` *e'* `0px` per scelta
  estetica. Si asserisce che il campo sia **identico a un campo noto**, in
  **entrambi** i temi.
- Il gestore dei dialoghi (`page.on('dialog', ...)`) va registrato **prima** di
  qualunque clic che possa aprirne uno: Playwright per difetto li RIFIUTA, e un
  `confirm()` rifiutato fa saltare l'azione senza dirlo (una prima stesura
  contava 256 pixel "dipinti" che erano lo sfondo di una tela mai rifatta).
- Misurare i pixel con `page.screenshot(clip=...)` + PIL, **mai** con
  `canvas.toDataURL()`: il `WebGLRenderer` non chiede `preserveDrawingBuffer`,
  quindi il buffer e' gia' scartato e si ottengono immagini bianche.
- Il bundle vive in una closure `window.addEventListener('load', ...)`: `scene`,
  `rig`, `activeColorHex` non sono raggiungibili da `page.evaluate`. Si verifica a
  scatola chiusa (tasti e clic veri, poi DOM e pixel).
- All'avvio c'e' il **launcher** (`#launcherOverlay`) che intercetta i clic: va
  chiuso con `#launcherSkipBtn`. Il salvataggio sta nel menu File, che va aperto
  (`#menuFile`) prima di cliccare `#saveProjectBtn`.
- La console di Windows e' cp1252: serve
  `sys.stdout.reconfigure(encoding='utf-8', errors='replace')`.

**Run the suite: `bash tests/run_all.sh`** (no network, no cookies, no AI quota —
the Gemini client is replaced by a fake generator in every test). It covers: the
pack queue + style distiller, the `/api/pack/*` HTTP endpoints on a real
`ThreadingHTTPServer`, **the Python↔JS ops parity** (see below), the pack UI logic
against a fake DOM, the UI build + bundle syntax, and i18n key completeness.

`tests/ops_parity_cases.json` is the safety net for the invariant below: it runs
the same 20 op payloads through `expand_ops` (Python) and `expandOps` (JS) and
fails if a single voxel differs. Three real divergences were found and fixed this
way in 2026-07-25 (float `box` produced **zero** voxels in JS; `int()` truncation
vs `Math.round()`; Python's banker's rounding in `line`). **If you touch op
semantics in one implementation, run this test.**

Additionally verify by:
- Python: `python -c "import sys; sys.path.insert(0,'src'); from parser import expand_ops, extract_and_parse_json"` and exercise with a sample compact model (see the pattern in `.claude/settings.local.json` allow-list).
- The build (`node ui/build.mjs`) now rejects non-latin1 characters and empty
  modules: the source files are read/written as latin1, so a stray bullet or
  smart quote would silently corrupt the bundle.
- JS: extract the `<script>` bodies from `ui/index.html` and run `node --check`. Three.js / OrbitControls / TransformControls / GLTFExporter are loaded from CDN (`r128` / `0.128.0`), so a local parse is parse-only — it won't resolve `THREE`.

## Architecture

### Backend (`main.py` + `src/`)
- `main.py` — `VoxelAIRequestHandler` (subclass of `SimpleHTTPRequestHandler`) with CORS headers. Routes: `GET /api/settings`, `GET /api/settings/open-folder`, `DELETE /api/settings/cookies`, `POST /api/settings/cookies`, `POST /api/generate`. `translate_path` rebases all file requests onto `BASE_DIR` so it works both from source and from a PyInstaller bundle.
- `MainWindow._load_html()` rewrites `fetch('/api/generate'` to the absolute `http://127.0.0.1:{PORT}` URL and injects `window.__API_BASE__` / `window.__IS_DESKTOP__` before serving HTML into the web view.
- **AI generation** (`POST /api/generate`): loads a prompt template from `assets/prompts/`, substitutes the user request, and calls the `gemini` package's `Gemini` client (a reverse-engineered Google Gemini web client, authenticated via browser cookies — **not** the official API). Two modes:
  - `generate` → `prompt.txt`, replaces `[INSERISCI QUI IL MODELLO DESIDERATO]`.
  - `modify` → `prompt-edit.txt`, injects the current model JSON + the edit request.
  The AI answer is run through `extract_and_parse_json()` before being returned as JSON.
- `src/settings.py` — cookies and settings live in `%APPDATA%/VoxelAIArtist/` (`cookies.json`, `settings.json`), **not** in the repo. With no cookies nothing is opened automatically: `main.py` prints a console hint and `GET /api/settings` returns `needsCookies: true` so the in-app settings modal can open itself. `ui/settings.html` and its `/settings.html` route survive as a manual fallback only.
- `src/parser.py` — contains a legacy standalone `start_local_server()` / `__main__` block; the live app path is `main.py`, which only uses `expand_ops` and `extract_and_parse_json` from this module. The rest (OBJ export, standalone server) is legacy/CLI. NOTE (2026-07-19): the top-level `import perplexity` was removed — it's now a lazy import inside `start_local_server()` only, so `perplexity-api` is no longer a runtime dependency (Gemini is the live generator). The old `scratch/test_perplexity.py` (contained a hardcoded session token) was deleted.

### Asset Pack / multi-generation (`src/pack.py` + `ui/src/lib/27-pack.js`)
Beyond the palette contract below, finished assets are also **anchored**
(`normalize_asset`: centred on XZ, sitting at y=0) and can carry a declared
relative size (`"Armadio :grande"` -> `parse_size_hint`). `pack_coherence_report`
flags assets whose size deviates >2x from the pack median. Completed packs are
**persisted** to `%APPDATA%/VoxelAIArtist/packs/` with a manifest (palette, grid,
objects, model) — `PackManager(storage_dir=...)` lets tests isolate that. Export
produces a single ZIP via `ui/src/lib/29-zip.js` (hand-written, store mode, no
external dependency).
A **server-side queue** generates N objects x M variants in one run. It lives in
the Python process (not the browser) so a webview reload doesn't lose a 40-minute
run — the UI polls `/api/pack/status` and `packResume()` re-attaches on load.

- **Concurrency is deliberately 1** (`DEFAULT_CONCURRENCY`, max 2). The `gemini`
  client is a cookie-authenticated *web* client, not the official API: firing N
  parallel requests gets the session rate-limited or burned. Retries use
  exponential backoff and only fire on errors that look transient — a malformed
  JSON is not retried.
- **Style coherence is enforced, not requested.** `distill_style()` extracts a
  shared palette + grid + density from optional reference JSONs (it never pastes
  whole files into the prompt — examples are ~12 KB each and would blow the token
  budget). `build_style_contract()` renders that as prompt text, and
  **`enforce_palette()` remaps every colour of the finished model to the nearest
  palette entry**. The prompt is a wish; `enforce_palette` is a guarantee.
- **Style anchor**: with no references, the first successful asset becomes the
  anchor and its palette constrains the rest of the run.
- Endpoints: `POST /api/pack/{start,cancel,retry}`, `GET /api/pack/{status,result,all}`.
  `status` deliberately omits model payloads (it's polled every 2.5 s).
- Prompt assembly is `build_pack_prompt()` in `main.py`, which **reuses**
  `assets/prompts/prompt.txt` for the format schema and adds
  `assets/prompts/prompt-pack.txt` for the pack rules — the schema is never
  duplicated, so it can't drift.

### Incremental rendering (`ui/src/lib/28-incremental.js`)
`buildModel()` is a FULL rebuild (voxelMap, visibility over every voxel, all
InstancedMeshes, palette DOM) and used to run on **every brush stroke**. Measured
`computeVisibility`: 24k voxels 0.04s / 98k 0.18s / 393k 0.80s (Python; JS is
3-5x faster but still a visible hitch at 128^3). That made large grids unusable.

The edit path (`performAction` in 14-tools-actions.js) now calls
`applyVoxelEdits(cells)`, which: updates the voxel array in O(1) per cell (key ->
index map + swap-with-last), recomputes visibility **only for touched cells and
their 6 neighbours**, rebuilds **only the InstancedMeshes of affected colours**,
and redraws the palette only when the colour set actually changes.

- `buildModel()` stays the authoritative path for load/generate/import/undo and
  calls `primeIncrementalState()` at the end to arm the fast path.
- Anything that swaps `currentModelData` (object switch, undo) must call
  `invalidateIncremental()` — otherwise the index points at the wrong voxels.
- `visibleVoxels` is kept in sync because 16-export-glb.js reads it; a stale
  value would export an old model.
- `applyVoxelEdits` returns **false** on any doubt (batch > 4000 cells, internal
  error); callers must fall back to `buildModel()`. Verified equivalent to the
  full rebuild across 19 checks including 100 random edits (`tests/test_incremental.mjs`).

### Rendering is on-demand
`animate()` no longer renders every frame. Call `requestRender()` after anything
that changes the scene. Continuous motion (auto-rotation, rig clips, OrbitControls
damping) keeps the loop alive on its own.

### Startup flash and flicker
The JS bundle sits at the END of `<body>`, so the page used to paint with the CSS
defaults and only then apply saved theme/accent/font. A **synchronous inline
script in `<head>`** (in `index.template.html`) now applies them before first
paint — it reads localStorage only; adding a fetch there would reintroduce the
flash. Related: `initPrefs()` reapplies theme/accent only when the backend value
actually differs; the pack panel updates **differentially** instead of rebuilding
its list every 2.5s poll; autosave runs inside `requestIdleCallback`.

### Large grids
Grid options go up to 512^3, plus a "big structure" toggle that appends
`BIG_STRUCTURE_RULE` (main.py) instructing the AI to use the whole grid with
facades, interiors, roofs and stairs. The voxel cap is **adaptive**:
`voxel_budget_for(grid_size)` in `src/parser.py` and the identical logic in
`expand-ops.js` — half the grid volume, clamped between 4M and **8M**. The 8M
ceiling is empirical: a JS Map cell costs ~98 bytes, so 24M cells = ~2.2GB and
kills the tab (reproduced as a Node OOM).

### Compact model format (the core data contract)
To save AI tokens, models are authored as `palette` + `ops` instead of one entry per voxel. `expand_ops()` (in `src/parser.py`) expands compact → flat `{voxels:[{x,y,z,color}]}`. A **mirror `expandOps()` exists in `ui/index.html`** so drag-dropped compact files expand client-side. **Any change to op semantics must be made in both places.** Both pass through untouched if the data already has flat `voxels` and no `ops`.

Ops apply in order; later ops overwrite earlier cells:
- `fill x0 y0 z0 x1 y1 z1 color` — solid box
- `box  x0 y0 z0 x1 y1 z1 color` — hollow shell
- `line x0 y0 z0 x1 y1 z1 color` — 3D line (steps along dominant axis)
- `rect axis level a0 b0 a1 b1 color` — axis-aligned plane at `level`
- `set  color x y z x y z ...` — individual voxels of one color
- `del  x0 y0 z0 x1 y1 z1` — carve/remove
Color is a palette key or a literal `#RRGGBB`; unknown keys fall back to `#CCCCCC`.

### Materiali con texture

Un voxel ha **sempre** `color` e **facoltativamente** `material` (l'id di una voce
di `metadata.materials`). Il colore di un voxel texturizzato e' la tinta media
della texture, quindi ogni percorso che pretende un hex (`.vox`, `.schem`, le
swatch, l'MTL senza PNG) funziona senza sapere che i materiali esistono, e un id
**orfano degrada da solo a tinta unita** — che e' il "materiale neutro" richiesto
per i file importati senza texture, ottenuto senza un ramo dedicato.

Le ops compatte sanno esprimere solo colori, e i materiali **non vi entrano**:
viaggiano in `metadata.material_map` (`[["m1", x,y,z, x,y,z, ...], ...]`, la stessa
forma di una op `set`) e vengono riversati sui voxel **dopo** l'espansione, da
`applyMaterialMap()` in `07-save-payload.js`. Quindi `expand_ops` (Python) e
`expandOps` (JS) **restano intatti**: nessuna modifica accoppiata, la parita' ops
non e' in gioco, e il generatore AI continua a produrre ops di soli colori.
`applyMaterialMap` va chiamata su **ogni** via d'ingresso (ce ne sono quattro in
`04-objects.js`): `expandOps` non sa nulla di materiali e non deve impararlo.

Internamente il raggruppamento passa da un **token**: `#RRGGBB` per un colore,
`@m1` per un materiale. E' il valore dentro `voxelMap`, ed e' cosi' che i confronti
sparsi per l'editor (che lo trattano come stringa opaca) sono rimasti invariati.
`tokenOf(v)` e `decodeToken(tok, fallbackColor)` in `36-materials.js` sono l'unico
punto di conversione. Tre trappole, tutte gia' costate un difetto:

- **`decodeToken` ha il secondo argomento OPZIONALE**, e ometterlo degrada in
  silenzio al grigio `#CCCCCC`. Passare sempre il colore vero del voxel. In
  `syncVoxelsFromMap` e' distruttivo: il token butta via l'hex, quindi su un id
  orfano non resta nulla su cui ricadere, e quella funzione riscrive
  `currentModelData.voxels`, cioe' il disco.
- **`result.material` NON prova che il materiale esista**: sull'orfano l'id viene
  conservato di proposito (azzerarlo renderebbe definitiva via `syncVoxelsFromMap`
  una perdita transitoria). L'esistenza si verifica con `materialById(id)`.
- **`threeMaterialFor` ritorna un'istanza CONDIVISA e cachata**, marcata
  `userData.shared = true`: `disposeMesh` la salta e solo `clearMaterialCache()`
  la libera. Chi la vuole diversa (l'anteprima semitrasparente degli oggetti
  inattivi) la **clona**; disporla spegnerebbe la texture di tutto il resto.
  `clearMaterialCache()` va chiamata dopo ogni modifica o eliminazione di un
  materiale e a ogni cambio di oggetto/progetto.

I materiali sono di **progetto**, non del singolo oggetto: `currentModelData` e'
l'oggetto ATTIVO (`04-objects.js`: `currentModelData = obj.data`), quindi la lista
vive a livello di scena (`sceneMaterials`) e ogni oggetto ci fa da **alias**. Cosi'
il salvataggio per-oggetto la scrive senza sapere che e' condivisa e il caricamento
la **fonde per id** invece di sostituirla. `loadSceneFromParsed` chiama
`resetSceneMaterials()`, o un progetto erediterebbe i materiali del precedente.
Tenerli solo dentro l'oggetto attivo li faceva sparire premendo Shift+A.

Oltre alla libreria di progetto c'e' una **libreria personale** in `localStorage`
(`voxelai-material-library`, max 40) per riusare un materiale fra progetti diversi.
Importarne uno **rinumera** l'id: due progetti possono aver usato `m1` per
materiali diversi, e tenere l'id d'origine legherebbe la copia al materiale
gia' presente invece di aggiungerne uno. **Ci si scrive SOLO col bottone
"+ Libreria"**: prima ogni creazione la riempiva da sola e in una sessione di
prove si intasava di materiali usa-e-getta, arrivando a rifiutare (max 40) quelli
che si volevano tenere davvero.

### Creatore di materiali (`#materialCreatorPanel`)
La **creazione** vive in una sezione propria, sopra `#materialsPanel` (che resta
l'elenco: scelta, modifica, eliminazione). Il form ha tre sorgenti
(`_formState.source`): `flat` (tinta unita), `draw`, `image`. Nei due casi
non-flat la texture ha **una sola sorgente: la tela** (`#materialArtCanvas`), un
canvas di w x h pixel VERI (8..128) che il CSS ingrandisce con
`image-rendering: pixelated`. Un'immagine importata viene **ricampionata nella
stessa tela** dopo il ritaglio, quindi resta modificabile pixel per pixel invece
di essere un blocco intoccabile. Il canvas visibile *e'* il buffer: non c'e' un
secondo buffer da tenere in sincronia, che e' il posto dove questi editor
divergono. La griglia e' un **gradiente CSS** sopra la tela (`.pixel-grid`, passo
nella variabile `--cell`), non un canvas: resta netta a ogni zoom senza
ridisegnarsi e senza allocare un buffer che a 64x sarebbe da decine di megabyte.
Disegnarla *dentro* il canvas dei pixel la farebbe finire nella texture.
Tela e griglia stanno in uno **stage** (`#materialArtStage`) e lo riempiono al
100%: la dimensione dello stage e' l'unico punto che decide quanto grande si vede
il disegno (`layoutArtStage`), quindi i due restano allineati al pixel a
qualunque zoom senza doversi accordare fra loro.
- Gli **id nel CSS devono essere quelli del template**. Con selettori sbagliati
  (`#pixelArtCanvas` invece di `#materialArtCanvas`) il canvas resta alla sua
  dimensione nativa di 16 px, la griglia scivola *accanto* invece che sopra, e le
  coordinate dei clic cadono altrove: la gomma sembrava non cancellare.
  Trovato in GUI reale, invisibile ai test unitari.
- `.pixel-grid` vuole `pointer-events: none`: sta SOPRA la tela.
- La **storia** e' una pila di `ImageData` (max 40). Lo snapshot si prende una
  volta **per tratto**, non per cella, o annullare una pennellata di trenta celle
  richiederebbe trenta annullamenti. Una modifica nuova azzera il redo.
- `commitArtToTexture()` (che fa un `toDataURL`) si chiama alla **fine** del
  tratto: a ogni cella comprimerebbe un PNG per movimento del puntatore.
- Cambiare la dimensione **RICAMPIONA** il disegno (`resizeArtCanvas`) invece di
  buttarlo; per ripartire da zero c'e' "Nuova tela". Il ricampionamento passa da
  un canvas d'appoggio perche' assegnare `width`/`height` a un canvas lo
  **azzera**: leggere i pixel dopo il resize darebbe una tela vuota.
- `artPaintCell` fa `clearRect` prima di `fillRect`: `fillRect` **fonde** col
  pixel esistente, quindi dipingere un colore opaco sopra un pixel
  semitrasparente darebbe una tinta mista.
- Il riempimento confronta anche l'**alpha**, cosi' riempire una zona trasparente
  funziona invece di essere un no-op — ed e' il caso piu' comune (dare uno sfondo
  a un disegno cominciato su tela vuota).
- Lo sfondo "trasparente" **non e' un colore**: `artBackgroundColor()` ritorna
  `null` e la tela resta vuota, non nera.

**Finestra grande** (`#materialEditorOverlay`, z-index 96): non duplica niente —
alla tela (`#materialArtWrap`), ai suoi comandi (`#materialArtTools`) e alla
scelta della dimensione (`#materialCanvasSetup`) si cambia **genitore**, e alla
chiusura tornano dov'erano. Spostare un `<canvas>` nel DOM **ne conserva il
contenuto**, quindi il disegno non passa da un'immagine intermedia e non esiste
un secondo editor da tenere allineato al primo — che sarebbe il modo ovvio di
farlo e anche quello che diverge alla prima modifica. La posizione di partenza si
ricorda sul nodo (`_artHome` = parent + fratello successivo), e al ritorno si
ricade in fondo al genitore se quel fratello si e' mosso a sua volta
(`insertBefore` solleverebbe).
- `closeMaterialForm` chiude **prima** la finestra: lasciarla aperta terrebbe
  nodi del form agganciati all'overlay, e riaprendo il form la tela non ci
  sarebbe piu'.
- `refreshSourceUI` non nasconde `#materialCanvasSetup` mentre la finestra e'
  aperta: li' dentro e' l'unico modo di ridimensionare il disegno.
- **Lo zoom e' un fattore INTERO** (`ART_ZOOMS`). Un fattore frazionario
  spalmerebbe un texel su un numero non intero di pixel e, con
  `image-rendering: pixelated`, le colonne uscirebbero di larghezza diversa — un
  reticolo irregolare che si legge come un difetto del disegno. Per lo stesso
  motivo la griglia in gradiente resta esatta: il passo e' sempre un intero.
- `setArtZoom` **ancora il punto sotto il puntatore**: senza, ingrandire porta
  via da sotto il mouse la zona che si stava guardando. Nel conto va incluso
  l'offset di `margin: auto`, che centra lo stage finche' ci sta.
- Nel viewport lo stage si centra con **`margin: auto`, non con `align-items`**:
  dentro un flex con overflow, centrare col contenitore taglia il bordo
  alto/sinistro quando il contenuto e' piu' grande, e la parte tagliata non e'
  raggiungibile nemmeno scorrendo.
- `artZoomToFit` va chiamata **dopo** aver mostrato l'overlay: a `display:none`
  il viewport misura 0 e "adatta" darebbe sempre il minimo.
- La tastiera e' agganciata in **cattura con `stopPropagation`**: la finestra si
  sovrappone a scorciatoie globali, e Ctrl+Z qui deve annullare la *pennellata*,
  non l'ultima modifica ai voxel. Si esce subito se il bersaglio e' un campo di
  testo, dove Ctrl+Z e' l'annulla del campo.
- Il disegno parte solo col tasto **sinistro** e solo se la barra spaziatrice non
  e' premuta: il centrale e lo spazio spostano la tela, e senza il filtro
  spostarsi a zoom alto sporcherebbe il disegno a ogni trascinamento.

**Ritaglio** (`#materialCropSection`): otto maniglie, piu' sposta-dentro e
disegna-fuori. Le maniglie hanno `pointer-events: none` di proposito — il
trascinamento lo gestisce il canvas, che decide quale maniglia hai preso dalla
**distanza in pixel di schermo** (una soglia in pixel immagine sarebbe enorme su
una foto piccola e invisibile su una grande). `cropResize` normalizza i bordi, o
trascinare il sinistro oltre il destro darebbe una larghezza negativa. Il tetto
`MATERIAL_TEXTURE_MAX` si applica al **ritaglio**, non all'immagine intera, e il
lato corto segue la **proporzione** del ritaglio: forzare il quadrato
schiaccerebbe una selezione larga, ed e' uno dei motivi per cui una texture
"sembra sbagliata" pur essendo mappata bene.

**Mappatura UV** (`normalizeUv` / `applyUvToTexture`): `repeat` (ripetizioni per
faccia), `offsetU/V`, `rotation`. `repeat` non puo' essere 0 — azzererebbe la
matrice UV e la faccia mostrerebbe un solo texel stirato, che si legge come "la
texture non si e' caricata". La rotazione e' **quantizzata a 90 gradi**: un
angolo qualunque interpola una texture ai pixel netti e la sfoca, e NearestFilter
non basta (e' il campionamento ruotato a cadere fra i texel). `center` va a
(0.5, 0.5) **prima** di ruotare, o l'immagine gira attorno all'angolo (0,0) e
esce dal quadrato UV. Le stesse UV si applicano in export GLB, o la texture
uscirebbe mappata diversamente da come si vede nel visore.

**Trasparenza** (`applyTransparency`): due sorgenti indipendenti, `opacity` del
materiale e pixel non opachi della texture (`texture.alpha`, misurato all'import
da `pixelsHaveAlpha` e portato appresso, per non ridecodificare il PNG a ogni
costruzione del materiale). **alphaTest e opacity NON si combinano**: alphaTest
confronta l'alpha FINALE, cioe' `opacity * alphaDelTexel`, quindi con opacity 0.4
e soglia 0.5 spariscono anche i pixel pieni e il materiale diventa **invisibile**
invece che semitrasparente. Quindi il taglio secco (`alphaTest = 0.5`, bordi
netti per la pixel art) si usa solo a opacita' piena, e sotto 1 si passa alla
fusione. `depthWrite` resta **true**: la scena e' fatta di InstancedMesh per
colore, che non si possono ordinare per voxel. Nel MTL diventa `d` (+ `illum 2`)
e non `Tr`, che e' la stessa cosa invertita e i loader la risolvono in modo
diverso; nel GLB diventa `alphaMode` BLEND o MASK.

**L'anteprima** e' un **CUBO** per difetto, non una sfera: su una sfera la
texture si avvolge una volta e si stringe ai poli, quindi sembra sbagliata anche
quando la mappatura e' giusta — ed e' proprio l'immagine che fa dubitare che le
UV non funzionino. La sfera resta a scelta perche' ruvidita' e metallicita' si
leggono meglio su una curva continua. Il renderer e' **proprio** (quello della
scena e' legato al canvas del viewport), costruito una volta e tenuto: i browser
concedono una manciata di contesti GL per pagina prima di buttare via i piu'
vecchi, cioe' quello del viewport. `metalness` senza `envMap` rende **nero** (e'
fisicamente giusto: niente da riflettere), quindi c'e' un CubeTexture a gradiente
generato su canvas — su r128 va diretto in `envMap`, senza PMREMGenerator. La
rotazione gira **solo a form aperto**.

**Gli handler del form si agganciano UNA VOLTA sola** (`initMaterialsPanel`) e
leggono `_formState` / `_art`, che l'apertura riempie. Tenerli dentro la funzione
d'apertura li accumulava, perche' `addEventListener` aggiunge e non sostituisce:
alla terza apertura uno slider aggiornava l'anteprima tre volte per movimento e
"Salva" creava tre materiali. In modifica il salvataggio passa da
`updateMaterial`, che muta **in place**: la lista non cresce e i voxel che
citavano l'id continuano a citarlo. Mutare invece di sostituire la voce
nell'array e' obbligatorio perche' le liste per-oggetto sono **alias** della
stessa lista di scena.

**I campi del form usano le classi del tema**: `.field-strong` per testo e
select, `.field-file` per l'input file. Una classe che non esiste in CSS
(c'era un `.text-input`) lascia il campo col **bianco di sistema** e non si nota
in tema chiaro, dove `--input-bg-strong` *e'* `#ffffff`: la verifica giusta e'
che il campo sia identico agli altri **in entrambi i temi**. Il bottone "Scegli
file" e' uno pseudo-elemento del browser e si raggiunge solo con
`::file-selector-button`.

Export: OBJ/MTL emette gli UV `0..uw / 0..uh` con `RepeatWrapping`, cosi' la
texture si ripete **una volta per voxel** invece di stirarsi sul quad unito dal
greedy mesher — e gli UV li emette il mesher accanto ai vertici, perche' la faccia
`back` ha l'ordine dei vertici invertito e una lista fissa sarebbe trasposta per
l'altro verso. Con le texture l'export diventa un solo **ZIP** (OBJ + MTL + PNG),
perche' i browser bloccano i download multipli. Nel GLB la texture e' incorporata,
e l'attesa del decode e' obbligatoria: il `GLTFExporter` r128 dimensiona il canvas
su `image.width`, quindi chiamato prima incorpora un'immagine **0x0**. Una texture
illeggibile viene staccata prima della parse (altrimenti l'exporter solleva dentro
una promise e l'export sparisce in silenzio, senza download e senza `restore()`).
**L'invariante 6 resta valido anche con la texture**: `map` moltiplicato per COLOR_0
rida' lo stesso modello quasi nero.

### Robust JSON recovery
LLM output is unreliable, so `extract_and_parse_json()` → `extract_json_candidate()` → `parse_with_recovery()` handle: fenced ```json blocks (including unterminated ones), brace/bracket balancing, unescaped inner quotes (`repair_unescaped_quotes`), and control-char cleanup. Preserve this pipeline when touching parsing.

### Frontend (`ui/index.html`, ~4300 lines, single file)
Everything is inline in one HTML file. Major systems:
- **Rendering**: `buildModel()` builds an `InstancedMesh` per color (one draw call per color) which preserves per-voxel raycasting for editing. `voxelMap` (`"x,y,z" -> color` Map) is the edit source of truth; `rebuildVoxelMap()` / `syncVoxelsFromMap()` keep it and `currentModelData.voxels` in sync.
- **Editing tools** (`currentTool`): `view` / `place` / `remove` / `pick` (eyedropper). Green ghost preview for add, red outline for remove. Undo/redo is a unified chronological stack (Ctrl+Z / Ctrl+Y). `symmetryAxis` (`none`/`x`/`y`/`z`) mirrors edits across the grid center; a translucent `mirrorPlane` visualizes it (`updateMirrorPlane()`).
- **Rotation**: segmented control — `object` (turntable, spins `modelPivot` Group; meshes live under it to avoid wobble), `orbit` (camera `OrbitControls.autoRotate`), `none`.
- **Export**:
  - OBJ/MTL via `greedyMesh()` (sweep-plane, merges coplanar same-color faces into maximal quads) — export-only, far smaller than per-voxel. `buildObjText()`/`buildMtlText()` share `matNameFor()`; the export button downloads **both** `.obj` and `.mtl` (staggered ~150ms) — Blender shows white materials unless the `.mtl` sits beside the `.obj` with a matching `mtllib` name.
  - GLB via `GLTFExporter` (`exportGLB()`), used for rigged/animated exports.
    Four invariants, each one a bug that shipped — see `tests/test_glb_pose_export.mjs`:
    1. **Never put translation/scale on the skinned mesh node.** A glTF importer
       ignores it by spec (the pose comes from joints + inverse bind matrices), so
       Blender relocates it onto the Armature. Origin and scale are baked into
       vertices and bones instead (`buildFullSkinnedMesh({bake:{origin,scale}})`).
    2. **The mesh is built at rest, the pose rides on the bone nodes.** `bind()`
       computes the inverse bind matrices at rest; baking the pose into the vertices
       too would apply it twice. Never zero `rig.pose`/`rig.posePos` to "export at
       rest" — that throws the user's pose away and exports a T-pose.
    3. **Clip `.position` tracks are ABSOLUTE voxel coordinates** (rest + delta, see
       `bob()`), so on baked bones they must be rebased, not just scaled:
       `(v - oldRest) * K + newRest`. Scaling alone snapped the root back to its
       voxel coordinate (+0.62 m on X).
    4. **The pose must be the FIRST clip** (`buildPoseClip`). Blender auto-assigns
       the first action on import and its tracks override the node pose on every
       bone they animate — with `idle` first the arms snapped back to T-pose while
       the legs, which `idle` doesn't touch, stayed posed. Re-measured 2026-08-02:
       dropping the pose clip makes Blender assign `idle` and the silhouette goes
       back to 0.911 m wide (T-pose) instead of 0.550 m. **Do not remove it.**
    5. **In export, cull the face between two voxels only if they deform
       IDENTICALLY** — same 4 weights on the same bones (`deformsAlike` in
       `buildSkinnedMesh`). Only that face stays internal in every pose. The face
       between voxels that deform *differently* is a JOINT: at rest its two halves
       are coincident and buried, but as soon as the pose separates the bones those
       halves are exactly the WALLS of the gap. Culling them leaves the shell OPEN,
       and since export materials are `THREE.FrontSide` (= backface culling in
       Blender) you see straight into the hollow model.
       Measured on the user's model (24 bones, `parts` binding): 1268 joints, which
       in the saved pose open by 5.3 mm on average and up to **55 mm** (5.5 voxel);
       Blender counted 0 boundary edges at rest and **936 on the POSED mesh**, and
       the render showed 7 see-through regions. Keeping both halves: 936 → 0, and
       the silhouette is unchanged. Cost on that model: +28% faces.
       **The z-fighting that originally motivated the cull is solved by FrontSide,
       not by culling**: the two coincident quads face OPPOSITE ways (one +X, one
       −X), so backface culling always draws exactly one. Verified in all three
       binding modes — parts 1268/1268, smooth 41605/41605, rigid 2144/2144
       opposite, **zero same-winding pairs**. So: export materials are
       `THREE.FrontSide`, never `DoubleSide`. On screen the rule is different and
       looser (keep the face when the dominant BONE differs, drop the rest): the
       preview is `DoubleSide`, so a gap still shows its far wall, and the per-bone
       border is what makes weight painting readable.
    6. **Delete the `color` attribute before exporting the rigged mesh.** The
       rigged geometry always carries one (preview needs it for per-bone colours
       and the weight ramp), and `GLTFExporter` r128 writes it to COLOR_0 by
       looking at the GEOMETRY, not `material.vertexColors` (the upstream source
       still has the `@QUESTION Detect if .vertexColors = true?` TODO). In glTF the
       result is `baseColorFactor * COLOR_0`, so the same colour on both gives the
       linear colour SQUARED — the model imported almost black. Confirmed in
       Blender: 31 of 31 materials had Base Color driven by a vertex-colour node
       (`#0A0A0C` rendered as `#E7E7E7` multiplied); after the fix all 31 match
       their hex exactly. The tell-tale was `#FFFFFF` being the only correct
       colour, because for white the exporter omits `baseColorFactor`.
    Invariants 5 and 6 are guarded by `tests/test_glb_rigged_artifacts.mjs`. It
    checks the exact rule face by face (2 quads on every joint, 0 on the
    forever-internal faces), that every coincident pair is front/back, and that the
    shell has **no boundary edges once welded by deformation** — vertices are welded
    by position AND weights, because welding by position alone would make an open
    shell look closed at rest, which is the whole trap. It also asserts the PREVIEW
    keeps the per-bone border (so the fix can't degrade into an indiscriminate cull)
    and that the preview shell *is* open by that measure (so the check has teeth).
    Verified against real Blender by `tests/.glb_export_harness.mjs` (writes the GLB
    plus a `.expect.json` silhouette measured with the real skinning) and
    `tests/.blender_verify_glb.py` (imports it and compares). Both are gitignored
    dev tools, not part of `run_all.sh` — they need Blender installed.
  - Save JSON exports flat `voxels` for reload.
- **Rigging/animation** (the `rig` tab): a bone skeleton with pose sliders, animation clips (`buildAnimationClips`, `playClip`), and a `TransformControls` gizmo to move joints (`updateGizmo`, `pickBone`).
  Preset clips (`idle`/`walk`/`run`/`jump`/`wave`) are authored as Euler XYZ **degrees**
  in `buildAnimationClips`; `pos` is an offset in **voxel units** from the bone's rest
  position. Two conventions, both **measured** (`tests/.diag_signs.mjs` rotates one bone
  and prints where its tip lands in world space) — not deduced, because deducing them is
  what produced the bugs below:
  1. **Arms must be rotated on Z, not X.** At rest the arm bone is *aligned with the X
     axis*, so `rot(30,0,0)` on `upperArm_R` moves its tip by exactly (0,0,0) — a
     rotation about a bone's own axis is a no-op. Every old preset swung the arms on X
     only, which is why the arms stayed in T-pose in nearly every clip. Only Z brings
     them down: **`-78` on `_R` / `+78` on `_L`** is the "alongside the body" baseline
     every preset starts from. **Z positive on the right arm = arm UP**, negative = down.
     Z does *not* depend on facing: the `_R` bone is always at greater X, so "toward the
     body" is always `-X`.
  2. **X is the forward/back swing and DOES depend on facing.** For a bone pointing down
     at rest, `X > 0` moves the tip toward `-Z`, so `X > 0` is *forward* only when the
     character faces `-Z`. The presets are written in the frame of the hand-validated
     reference walk (`faceYaw === 180`, where `X > 0` = forward) and `S` rebases them
     onto the real facing: `const S = (faceYaw === 180) ? 1 : -1`. The old `legSign` had
     the **opposite** sign and produced a mirrored walk that pushed backwards.
  At 90°/270° signs aren't enough (the legs would swing sideways), so the rotation is
  conjugated instead: `faceRotate(q, qFace)` with `qFace` threaded into
  `buildClipFromAnimData`. **Presets get `qFace`; AI custom clips must NOT** — the AI sees
  the real bones and already writes in the correct frame, so conjugating would apply the
  facing twice. Guarded by `tests/test_anim_presets.mjs`, which asserts the arm tips
  actually *move* (>40% of arm length, so an arbitrary rotation can't satisfy it) and that
  `walk` reproduces the reference clip key-for-key.
- **UI shell**: tabbed sidebar (`Genera` / `Vista` / `Disegna` / `Rig`), `.tab-content` scrolls, `.sidebar-footer` pins export/save. `switchTab()` drops back to the `view` tool when leaving `Disegna`. Styling is a dark glassmorphism theme via `:root` CSS custom properties (`--accent-primary`, `--glass-bg`, etc.) with `backdrop-filter` blur and rounded corners.

## Conventions & gotchas
- **`ui/index.html` is generated, but it is NOT disposable.** `node ui/build.mjs`
  overwrites it from `ui/src/` with no backup. On 2026-08-02 the sources in
  `ui/src/lib/15-rig.js` had been overwritten by an older branch revision while the
  **committed bundle still held the only copy** of ~500 lines of rigging engine
  (`bindContext`, `deformsAlike`, `posePosOf`, `buildPoseClip`, `buildFullSkinnedMesh`,
  `restrictToParts`, the "three binding modes" work). Rebuilding destroyed it, and the
  rigged model went back to see-through holes and exploding parts in both the viewer and
  Blender. **Before running the build, check that the bundle isn't ahead of the sources:**
  `grep -c deformsAlike ui/index.html ui/src/lib/15-rig.js` — if the bundle has symbols
  the sources don't, stop and reconcile first. The recovery path, if it happens again:
  the bundle is a plain concatenation of the manifest modules, so a module can be cut
  back out of it by locating its first line (`sed -n 'A,Bp'`) and re-indenting by 12
  spaces; `git fsck --dangling` may also surface a dropped stash of the same lineage.
- The five tests `test_glb_rigged_artifacts`, `test_rig_weights`, `test_channel_keys`,
  `test_glb_pose_export`, `test_rig_parts_legs` are the tripwire for exactly that loss.
  A `ReferenceError: <symbol> is not defined` from them means engine code is **missing
  from the sources**, not that the test is stale. Do not dismiss it as pre-existing
  because it also fails at HEAD — HEAD can be broken too.
- **Nessun testo per l'utente e' hardcoded — mai, in nessun punto del frontend.**
  Nel template si annota con `data-i18n` / `data-i18n-title` / `data-i18n-placeholder`;
  nel JS si passa da `t('chiave')`. La regola copre anche **guide, hint, conferme,
  messaggi d'errore e testi costruiti a runtime**: nei template literal si usano i
  segnaposto `{nome}` di `t()`, non la concatenazione.
  La lingua sorgente e' `ui/locales/it.json` — i suoi valori SONO i testi italiani
  reali, ed e' da li' che `ui/annotate-i18n.mjs` annota il template per valore. Una
  stringa nuova si aggiunge prima in `it.json`, poi nelle altre 5 lingue (il test
  "Chiavi i18n complete" pretende parita' esatta).
  `t()` e' chiamabile prima di `bootI18n` e in quel caso ritorna la chiave nuda:
  non e' un bug da aggirare con un fallback italiano hardcoded.
  `tests/test_i18n_hardcoded.mjs` e' la guardia. Se fallisce, la stringa va
  estratta, non aggiunta all'allow-list — che infatti e' VUOTA di proposito.
  La sua `BASELINE` (misurata alla nascita della guardia: `template: 74`,
  `js: 295`) va solo **abbassata**, mai alzata: a zero il meccanismo si rimuove.
  La guardia copre `ui/src/lib/*.js`, `ui/src/utils/*.js` e i `<script>` inline
  del template, cioe' tutte le sorgenti che finiscono nel bundle: spostare una
  stringa non e' un modo per farla sparire dal conteggio.
- Editing op semantics requires a **paired edit** in `src/parser.py` (`expand_ops`) and `ui/index.html` (`expandOps`).
- `token.txt` and any `cookies.json` hold session credentials — never commit or echo their contents.
- The Three.js version is pinned to r128 via CDN; APIs differ in newer versions, so don't assume modern Three.js when editing viewer code.
- The voxel cap lives in **both** `src/parser.py` (`voxel_budget_for`) and
  `ui/src/utils/expand-ops.js` — keep the two implementations identical. Without it a single
  malformed AI op (`fill 0 0 0 299 299 299` = 27M cells) froze the app with no error.
- `.gitignore` now excludes credentials (`token.txt`, `cookies.json`), bytecode,
  `build/`, and `.claude/backups/`. Never re-add them to the index.
