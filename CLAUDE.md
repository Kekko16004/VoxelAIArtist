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

### Provider AI multipli (`src/providers.py` + `ui/src/lib/26-settings-modal.js`)
Gemini-coi-cookie resta il **predefinito a configurazione zero**: senza niente su
disco c'e' una voce sintetica `gemini` (`GEMINI_ID`, `builtin`, non eliminabile e
non modificabile) che *non* sta in nessun file. Accanto si aggiungono provider
propri: `anthropic` (chiave + modello), `openai_compatible` (base_url + chiave +
modello: copre OpenAI, OpenRouter, Groq, Together, LM Studio, Ollama, vLLM — e'
lo stesso contratto) e `custom` (percorsi puntati per prompt e risposta, header e
prefisso di autenticazione, corpo JSON di partenza).

- **`ai_answer_text` / `ai_answer_text_retrying` NON cambiano firma.** Tutto
  (voxel, coda pack, texture AI, animazioni, PixelAIEditor, il server MCP) passa
  di li'. C'e' un `provider=None` in coda per l'override per-chiamata, ma nessun
  chiamante esistente deve passare niente. `main.py` continua a riesportare i
  dieci nomi storici, e le tre classi d'errore ora **nascono in `providers.py`**:
  `aiclient` le importa, quindi sono gli **stessi oggetti** ovunque e un
  `except AIAuthError` scritto anni fa continua a prendere l'errore di Anthropic.
- **Le due directory: registro e chiavi stanno ENTRAMBI in `get_cookies_dir()`**,
  cioe' la cartella FISSA condivisa fra le app, non quella spostata da
  `set_app_name()`. Non e' pigrizia: chi configura la sua chiave Anthropic in
  VoxelAIArtist la vuole anche in PixelAIEditor (stessa persona, stesso account,
  e le due app girano una dentro l'altra). Ma la ragione decisiva e' un'altra:
  registro per-app + chiavi condivise significherebbe che `p1` nel figlio e' un
  provider **diverso** da `p1` nel padre mentre leggono lo stesso file di chiavi
  — cioe' **la chiave sbagliata mandata al provider sbagliato**. O tutti e due
  condivisi, o tutti e due separati; condivisi e' quello che l'utente vuole.
- **Due file, non uno**: `providers.json` (registro) e `provider_keys.json`
  (chiavi). Cosi' il mascheramento e' **strutturale** e non una disciplina:
  `list_providers()` legge solo il registro, che una chiave non puo' contenere.
  Nei payload pubblici esce `hasKey` + `keyMask` (`****WXYZ`), mai il valore —
  e le chiavi non entrano MAI in `settings.json` (`_SENSITIVE_KEYS`).
- **La classificazione degli errori non e' comune: e' per tipo.** Su un'API vera
  ci sono i codici (`classify_http_status`: 401/403 -> auth, 429 e >=5xx ->
  transient, il resto -> format), e le euristiche testuali di Gemini
  (`_AI_AUTH_HINTS`) **non vanno applicate**: leggerebbero "quota" dentro il
  messaggio di un 400 e lo declasserebbero a ritentabile. Per questo
  `_classify_ai_error` come **prima cosa** restituisce l'eccezione invariata se
  e' gia' una delle tre.
- **Zero dipendenze nuove.** Anthropic e i compatibili OpenAI si chiamano con
  `urllib` della libreria standard: sono HTTP + JSON. `anthropic` e `openai` non
  vanno aggiunti a `requirements.txt` — un import mancante all'avvio spegnerebbe
  l'app anche a chi usa solo Gemini.
- **Il corpo di Anthropic resta minimo** (`model`, `max_tokens`, `messages`):
  `temperature`, `top_p`, `top_k` e `thinking.budget_tokens` sono **rifiutati con
  400** dai modelli recenti, e il campo modello e' testo libero (l'utente puo'
  configurarne uno vecchio o nuovo), quindi solo il corpo minimo vale per tutti.
  La risposta e' una **lista di blocchi tipizzati**: si filtra `type == "text"`,
  perche' un blocco `thinking` puo' precederlo.
- **Il `model=` della UI non scavalca il provider.** La tendina manda un nome
  dell'era Gemini; inoltrarlo ad Anthropic darebbe un 400. Vale solo come ripiego
  quando la voce non dichiara nessun modello.
- `POST /api/providers/test` risponde **200 anche quando fallisce**: l'esito sta
  in `ok`/`kind`, cosi' un 401 del provider diventa un messaggio che dice cosa
  fare invece di un errore di rete generico.
- La sezione UI sta **dopo** i cookie e non li tocca: Gemini e' il predefinito e
  deve restare a un clic. Le righe dell'elenco sono costruite da JS, quindi
  `window.renderProviderList` e' chiamata da `setLanguage` (23-i18n.js) come
  `renderObjectsList` e compagni — senza, al cambio lingua si leggerebbe per
  sempre `settings.prov.useBtn`.
- Guardie: `tests/test_providers.py` (offline, `_http_post_json` finto,
  `VOXELAI_PROVIDERS_DIR` su una cartella temporanea esportata da
  `run_all.sh` — senza, la suite leggerebbe il registro VERO dello sviluppatore e
  "niente rete" diventerebbe falso) e `.superpowers/check_providers.py` (46
  controlli in GUI reale, `/api/providers*` intercettata con `page.route`).

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

### Texture AI (`#materialAiSection` + `#materialPngSection`)
La texture si fa generare come i voxel: **ops compatte**, non un PNG. Il formato
2D vive in `ui/src/lib/37-pixel-ops.js` (`fill` / `rect` / `line` / `set` / `del` /
`mirror` / `noise`), il prompt in `assets/prompts/prompt-pixel.txt`, l'endpoint e'
`POST /api/texture`. Un colore puo' essere `-` (trasparente): le parti invisibili
sono normali in una texture, e tenerle come valore di QUALUNQUE op evita un'op
"buca" dedicata. L'origine e' **in alto a sinistra** come un'immagine, non in
basso come i voxel.
- `expandPixelOps` accetta di proposito **piu' forme** (`faces` con lista, con
  `{ops}`, con stringa multiriga, `ops` alla radice, sinonimi `facce`/`comandi`/
  `w`/`h`, e una **palette dichiarata dentro la faccia** che si somma a quella
  comune). Rifiutarne una costerebbe all'utente una rigenerazione per una virgola.
  La palette per-faccia e' stata trovata **in GUI reale**: era ignorata in
  silenzio, le chiavi non risolvevano e la faccia tornava vuota — che si legge
  come "non ha generato niente", non come "ha risposto in un altro modo".
- **Gli avvisi sono CODICI, non frasi** (`badCoords`, `badColor`, `unknownCmd`,
  `truncated`, `noOps`, `emptyAnswer`): il modulo non ha DOM e non sa che lingua
  parla l'utente. Traduce chi chiama (`matai.warnIgnored`). La guardia i18n li
  contava, e aveva ragione.
- `painted` per faccia esiste perche' chi chiama **non sovrascriva un disegno con
  una tela vuota**: una faccia nominata e non disegnata va scartata, o cancella
  cio' che c'era.
- Con ambito "tutte" il **contesto non si manda**: sarebbe ripetere all'AI cio'
  che le si sta chiedendo di rifare, a pagamento.
- Generazione e import PNG prendono uno **snapshot di annullamento**, e nell'import
  va preso PRIMA di `ensureArtCtx`: assegnare `width`/`height` azzera il canvas,
  quindi uno snapshot dopo sarebbe una tela vuota.
- Nel **pannello** l'annulla e' il bottone: la scorciatoia Ctrl+Z della tela e'
  agganciata solo a **finestra grande aperta**. E un clic sulla tela per "darle il
  fuoco" **dipinge** — in una prova automatica falsa il conteggio dei pixel.
- Gli interruttori sono `.switch` con l'`<input>` a `opacity:0; width:0; height:0`
  (tutti e 15 dell'app): in Playwright si clicca la `.slider`, o si aspetta la
  visibilita' fino allo scadere del tempo.
`.superpowers/check_texture_ai.py` prova le due sezioni in GUI reale (49 controlli)
intercettando `/api/texture` con `page.route`: niente rete, niente cookie, niente
quota. E' li' che sono emersi i tre punti qui sopra.

### Robust JSON recovery
LLM output is unreliable, so `extract_and_parse_json()` → `extract_json_candidate()` → `parse_with_recovery()` handle: fenced ```json blocks (including unterminated ones), brace/bracket balancing, unescaped inner quotes (`repair_unescaped_quotes`), and control-char cleanup.

**2D pixel-art generation (`POST /api/texture2d`)** — PixelAIEditor and the parent's material texture AI — uses the same robust parsing (via `extract_and_parse_json`) plus a structural defense against a common AI failure: the model habitually appends `del 0 0 W-1 H-1` (or `fill 0 0 W-1 H-1 -`) believing it "cleans the transparent background", leaving the canvas EMPTY. Measured 2/12 live responses in a real campaign. Prompt prose alone was insufficient (happened twice in two rounds), so `pixelDropSuicidalOps` in both `ui/src/lib/37-pixel-ops.js` (parent) and `PixelAIEditor/ui/src/lib/14-pixel-ops.js` (child) drops a full-canvas wipe op WITH no drawing after it; a wipe followed by real ops is a legitimate restart and is preserved. The guard emits the `wipeDropped` warning code. Validated by `tests/test_pixel_ops.mjs` (9 checks including the cross-check that the child has the same defense).

Preserve this pipeline when touching parsing or pixel-ops expansion.

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

## SimpleAIModeller (`SimpleAIModeller/`, app separata)

Asset 3D parametrici da prompt (mesh vere, non voxel). App sorella autonoma:
`python SimpleAIModeller/main.py` o `SimpleAIModeller/run.bat`. Stesso schema
di PixelAIEditor (server HTTP locale, UI nel browser, riuso di `../src` per
cookie/provider/parser). L'AI **non scrive codice**: produce una spec JSON
compatta (`nodes` + `params` + `mats`); il motore JS la interpreta.

- **Una sola implementazione del motore, in JS** (`ui/src/lib/01`–`06`). Python
  (`src/spec.py`) normalizza e valida solo lo SCHEMA e applica le patch per
  NOME. Niente parita' Python/JS da mantenere.
- **`geom/*` non conosce THREE**: primitive e CSG ritornano array piatti, quindi
  girano in Node dentro `tests/test_geom.mjs` senza browser.
- **CSG in casa** (`04-csg.js`, BSP). Se dopo una booleana il guscio non e'
  chiuso si tiene la mesh non tagliata e si emette un avviso.
- **Tre stili** (`lowpoly` / `pbr` / `toon`), scelti dal campo `style`. In
  anteprima il rumore e' uno shader object-space; in export GLB viene
  quantizzato in tinte piatte (un GLB non porta shader). **Niente attributo
  `color`** nel GLB (invariante 6 del padre).
- **Critica a cascata**: validatori locali deterministici (`06-validators.js`)
  poi, se la spunta e' accesa e la sonda (`POST /api/vision/probe`) ha detto
  che il provider vede le immagini, una passata di critica AI sul contact
  sheet. Se la vista non c'e', il critico e' l'utente (prompt di testo).
- **`images=` in coda** su `ai_answer_text` / `complete`: retrocompatibile,
  nessun chiamante storico cambia. Gemini accetta 1 immagine, Anthropic/OpenAI
  fino a 8, `custom` zero.
- Build: `node SimpleAIModeller/ui/build.mjs`. Suite:
  `bash SimpleAIModeller/tests/run_all.sh` (offline). GUI reale:
  `.superpowers/check_sam_gui.py` (gitignored, 36 controlli con clic veri).

### Deformatori (`ui/src/lib/03b-deform.js`) — perche' non basta piazzare volumi
Un motore che sa solo POSIZIONARE primitive produce oggetti fatti di mattoni: si
vede subito, ed e' il limite che si nota per primo su una spada o un veicolo.
Le forme reali sono primitive DEFORMATE, non primitive nuove — aggiungerne una al
catalogo per ogni forma sarebbe un catalogo infinito. Quindi:

- `taperTo` / `taper0` scalano la SEZIONE lungo l'asse, **per-asse**
  (`{"x":0.15,"z":1}` stringe solo X e lascia lo spessore: e' il filo di una
  lama, un'ala, una pala); `squash` schiaccia **un solo lato**; `shear` inclina;
  `twist` torce; `bendA` piega; `warp` sposta i vertici lungo la normale con
  value-noise (rocce, corteccia, metallo martellato).
- `bevel` su `box` costruisce una **rounded box vera** (`primRoundBox`): si
  proietta una griglia sulla superficie della scatola arrotondata, quindi i
  vertici condivisi fra due facce cadono nello stesso punto e il guscio resta
  chiuso senza cuciture. **Prima il campo era accettato e IGNORATO in silenzio.**
- `loft` ha una `shape` (`lens` / `rect` / `hex` / `tri` / `ellipse`): `lens` e'
  la sezione di una LAMA, e senza quella ogni lama e' un parallelepipedo.
- **In un `loft` le `secs.at` sono coordinate ASSOLUTE** sull'asse, e la mesh NON
  viene ricentrata: il costruttore le prende dal piano (`lama_a`, `lama_b`) senza
  calcolare un centro. Ricentrare sposterebbe ogni loft di mezza lunghezza.
- L'ordine e' fisso: primitiva → deformatori (in spazio LOCALE) → rot → at →
  `arr` → `mir`. Deformare dopo la rotazione darebbe una rastremazione obliqua
  rispetto al pezzo.
- I campi dei deformatori si risolvono in `resolveNode` (possono essere
  espressioni); `03b-deform.js` vede solo numeri e resta testabile in Node.

### Editor (`09d-editor.js`)
Selezione per raycast + outliner, gizmo (`TransformControls`), undo/redo,
duplica/elimina, wireframe, scorciatoie G/R/S/W/F/1-6/Del/Ctrl+Z/Ctrl+D.

- **Il gizmo scrive NELLA SPEC**, non sulla scena: muovere una mesh e lasciare la
  spec com'era darebbe un modello che al primo rebuild torna dov'era e un export
  che non corrisponde a cio' che si vede. Le misure sono espressioni, quindi il
  delta si SOMMA all'espressione (`(lama_a+lama_b)/2+0.03`) invece di
  sostituirla: il nodo resta legato alla catena del piano.
- Un nodo mosso a mano diventa `locked`, viaggia in `measuredFor(...).locked` e
  **l'audit lo salta**. Senza, il ratchet "correggerebbe" ogni modifica manuale
  al giro dopo e l'editor sarebbe inutilizzabile.
- **`pushHistory` registra lo stato PRIMA della modifica**, quindi lo stato
  attuale non e' nello stack: `undo()` deposita prima il presente in cima, poi
  scende. Senza, il primo undo salta indietro di DUE passi — difetto trovato coi
  clic veri (duplica, elimina, undo restituiva 5 nodi invece di 6).

### Import / export
- `.sam.json` si RIAPRE (passa da `/api/asset/normalize`, non da un parser
  duplicato nel browser). Un GLB/OBJ entra come **riferimento** semitrasparente:
  una mesh non e' convertibile in spec parametrica, e fingere di importarla come
  nodi darebbe un asset non piu' modificabile che sembra modificabile.
- Il bundle e' **un solo ZIP** (`09b-zip.js`, store mode scritto a mano) perche' i
  browser bloccano i download multipli: GLB + spec + piano + collider + LEGGIMI.
  Data fissa nell'header, cosi' due export dello stesso asset sono binariamente
  identici e si possono confrontare. CRC32 verificato contro `zlib.crc32`.

### Rendering
Tone mapping ACES + ombre PCF morbide + tre luci e un rimbalzo da terra (senza il
rimbalzo il sotto degli oggetti e' nero e la forma non si legge). `pbr` usa
`MeshPhysicalMaterial` col **clearcoat**: e' cio' che fa leggere una vernice come
vernice, e su `MeshStandard` non esiste — il risultato sarebbe "plastica opaca"
qualunque valore si metta. Il rumore procedurale modula anche la RUVIDITA'
(`samRoughAmp`), che e' cio' che distingue una superficie usata da una verniciata
a spruzzo. L'envMap e' un CubeTexture a gradiente con una macchia speculare: un
metallo senza orizzonte da riflettere resta una tinta piatta.

### Solidi di rivoluzione (`primLathe2` in `03b-deform.js`)
Un vaso chiesto al programma usciva come un guscio senza fondo, con la silhouette
a spezzata e visibile all'interno — provato in GUI, non dedotto. Tre difetti in
uno, tutti nel vecchio `lathe`:
- **nessun fondo e nessuna parete**: si guardava DENTRO l'oggetto. Ora con `wall`
  si costruiscono parete esterna, parete interna, fondo e LABBRO; senza, un
  solido pieno. In entrambi i casi chiuso.
- **profilo a spezzata**: gli spigoli fra i punti su una ceramica si leggono come
  difetti. Ora il profilo si interpola (Catmull-Rom, `smoothProfile`) con gli
  estremi duplicati, cosi' la curva parte e finisce ESATTAMENTE sul primo e
  sull'ultimo punto — su un profilo il fondo e il labbro non si spostano.
- **nessun modo di chiedere "un vaso"**: 12 silhouette note (`vase`, `amphora`,
  `bottle`, `goblet`, `bowl`, `pot`, `urn`, `column`, `baluster`, `plate`,
  `dome`, `barrel`) normalizzate 0..1 e scalate su `r`/`len`, con alias italiani.
Il vecchio `primLathe` e' stato RIMOSSO invece di lasciato accanto: due
implementazioni della stessa cosa divergono, ed e' la prima avvertenza di questo
repo.

### `arr` con `rot` e' un array POLARE
L'ordine in `transformInstance` e': `rot` del pezzo → `at` → scostamento
dell'array. Prima la rotazione dell'array veniva applicata mentre il pezzo era
ancora sull'origine, quindi lo girava su se' stesso e **le dodici copie finivano
tutte nello stesso punto** — si vedeva una decorazione sola. Ora il pezzo va alla
sua distanza dall'asse e poi gira: bulloni su una flangia, colonne di una
rotonda, raggi, greche su un vaso, denti di un ingranaggio.

### `tests/test_modules.mjs` — la guardia che mancava
I moduli sono frammenti di UNA closure: un errore di sintassi in uno rende la
pagina **dipinta e completamente morta**, senza messaggi. I test di geometria
caricano solo i moduli puri (01-06), quindi un backtick di troppo dentro il
template GLSL di `07-materials.js` e' passato inosservato fino a una prova in
GUI. La guardia compila (senza eseguire) ogni modulo, il bundle concatenato — che
e' dove si vedono i `const` duplicati — e il blocco dentro `index.html`, e conta
i backtick per parita'.

### `amp` del rumore e' un CONTRASTO
`t = clamp(0.5 + (n - 0.5) * amp * 3)`. La vecchia formula (`n * amp * 2`) su un
fbm — che sta quasi sempre fra 0.25 e 0.75 — dava una banda strettissima: a
valori bassi la variazione era invisibile e sembrava che il rumore non
funzionasse. Verificato con due box affiancati, uno con `stripe` amp 1.0: le
strisce sono nette, quindi lo shader arriva a destinazione.

### `underDetailed`: il bersaglio e' il PIANO, non il budget
Prima pretendeva una frazione del budget (44 pezzi a dettaglio 3), e su un vaso —
che e' un solido di rivoluzione e sta in due pezzi — avrebbe spinto il ratchet a
imbullonargli addosso trentotto pezzi inutili. Ora il bersaglio e'
`chain + extras` del piano meno uno, ed e' `high` solo quando un piano esiste;
senza piano resta un avviso con una soglia prudente. **Il budget e' un tetto, non
una quota da riempire.** Stessa logica per `validateSize`: senza un `size`
dichiarato non c'e' bersaglio, e resta solo il controllo di plausibilita'
assoluta (un oggetto di 2 mm o di 60 m e' sbagliato comunque).

### Il ratchet TIENE IL MIGLIORE, non l'ultimo
Difetto riportato dall'utente: *"al primo passaggio lo aveva fatto unito, poi ha
deciso di staccarlo"*. Il ciclo adottava sempre il risultato della patch, quindi
un asset corretto al primo colpo poteva essere PEGGIORATO dal giro di correzione
— e il peggioramento restava. Un ratchet che torna indietro non e' un ratchet.

- `defectScore` pesa i difetti (high 10, medium 3, low 1). Contare i soli gravi
  non basta: una patch che ne risolve uno e introduce due medi lascerebbe il
  conteggio dei gravi invariato e passerebbe per innocua.
- `fixRound` NON tocca `appState`: ritorna lo stato prodotto, e il chiamante
  decide. Ogni giro parte dal MIGLIORE visto, non dall'ultimo.
- Se un giro peggiora o non cambia niente, si scarta e si smette: insistere da
  una base peggiore allontana. Alla fine si adotta il migliore (`adoptState`).
- Una patch chiesta a mano si adotta comunque (e' una richiesta esplicita), ma
  se peggiora lo dice e `pushHistory` garantisce che Ctrl+Z la annulli.

### `detachedParts` dice QUALE pezzo e DI QUANTO
"2 componenti connesse" non e' un'istruzione: il correttore tirava a indovinare e
spesso peggiorava. `componentReport` etichetta le celle occupate, assegna ogni
PARTE alla sua componente, e per le parti isolate misura la distanza dal pezzo
piu' vicino, su quale asse, e verso chi. Il difetto diventa "il pezzo X dista
42 mm da Y sull'asse Z", che una patch puo' eseguire.

E il caso facile non costa una chiamata AI: `autoRepair` **aggancia** i pezzi
quasi attaccati (`snap:`), aggiungendo 1 mm di sovrapposizione — due superfici
che si sfiorano lasciano una cucitura visibile. La soglia si misura
sull'**ingombro dell'asset** (25%, con un tetto di 3x il pezzo), non sul pezzo:
una pila di dischi separati ognuno di quanto e' alto lui va agganciata, mentre un
pezzo a mezzo asset di distanza va DETTO invece di trascinato di nascosto. Un
nodo `locked` non si tocca mai. Lo spostamento passa da `offsetField`, che somma
il delta all'espressione invece di sostituirla, cosi' il nodo resta legato alla
catena del piano.

### Costruzione A PEZZI (`plan_tasks` + `/api/asset/part`)
Un modello che deve emettere sessanta nodi in una sola risposta sbaglia una
misura qui e dimentica un dettaglio la': e' il limite che si vedeva sui vasi e
sulle spade a dettaglio alto. Sei chiamate da cinque nodi ognuna, con davanti UN
pezzo e le sue quote, non hanno quel problema — ed e' l'unico modo di chiedere
davvero "il massimo dettaglio su questo pezzo".

Il flusso e' `piano -> un pezzo per volta -> audit delle misure`, ed e' il
DEFAULT (spunta "Costruzione a pezzi").

- **La decomposizione non costa una chiamata AI**: il piano la contiene gia'. Un
  compito per segmento della catena, con gli `extras` che lo indicano come
  ospite (`of`). Un extra orfano si assegna al segmento che lo CONTIENE per
  quota, invece di essere scartato.
- **La coerenza fra pezzi costruiti in conversazioni diverse** e tenuta da tre
  cose, tutte nel piano: i params condivisi (le quote), la palette dei materiali
  (nessun pezzo inventa colori), e le **interfacce** — ogni compito porta il
  pezzo sotto e sopra con la loro quota di confine e la loro sezione, cosi' chi
  fa la guardia sa che sotto di lei l'impugnatura finisce a 0.230 con sezione
  0.034 e la sua base combacia invece di galleggiare.
- **`task_params` e' STRETTO**: solo i params del pezzo, dei suoi dettagli e dei
  due vicini. Passarli tutti invita a usarli, e un pezzo che cita le misure di
  uno lontano e' il modo in cui un oggetto costruito a pezzi torna incoerente.
- **I params del piano VINCONO** su quelli che un pezzo dichiara: un pezzo che
  ridefinisce una quota della catena la sposterebbe per tutti.
- **Un pezzo che non esce non ferma gli altri**: si segnala e si tira avanti.
  Fermarsi butterebbe via anche i pezzi gia' riusciti.
- **I nomi dei nodi si prefissano col pezzo** (`impugnatura_collare`), e in caso
  di collisione fra pezzi si prefissa di nuovo invece di sovrascrivere: un nodo
  perso e' un dettaglio perso.
- L'asset si mostra DOPO OGNI PEZZO: si vede crescere, e se un pezzo esce male si
  vede subito quale.
- La validazione di un pezzo riusa `normalize_spec` come mini-spec. Un secondo
  validatore per i pezzi sarebbe un secondo validatore che divergono.

### La STRATEGIA di costruzione — la decisione che conta piu' di tutte
Difetto riportato: un vaso usciva come una **pila di dischi torniti**. La causa
non era il prompt, era la DECOMPOSIZIONE. Un vaso e' UNA superficie di
rivoluzione — un profilo, uno spin, una parete, un labbro, un solo oggetto — e
tagliarlo in cinque segmenti costruiti da cinque chiamate indipendenti non poteva
dare altro. La catena di segmenti e' giusta per una spada (pomolo, impugnatura,
guardia e lama SONO solidi distinti) e sbagliata per un vaso.

`plan["strategy"]` vale `revolve` / `chain` / `shell` / `limbs`, dichiarata
dall'architetto e **indovinata** (`_infer_strategy`) se manca: prima dal nome
dell'oggetto (`_REVOLVE_HINTS`), poi dalla geometria — se ogni segmento ha
larghezza e profondita' quasi uguali, l'oggetto e' tondo per costruzione.

In `revolve` `plan_tasks` produce **UN compito per tutto il corpo**, e i segmenti
della catena diventano le **stazioni del profilo** (i diametri a quelle quote).
Gli extras si dividono: quelli concentrici e larghi restano al corpo come
modanature del profilo, quelli che sporgono (anse, becchi, piedini) sono compiti
a se', perche' non sono solidi di rivoluzione. Un vaso passa da 6 compiti a 2.

### `tube` con `path`: la sezione trascinata lungo una curva
Terza della famiglia "accettato e ignorato", dopo `bevel` su `box` e su `extr`.
Il sintomo: un'ansa chiesta come tubo piegato usciva come una **lamella piatta**,
perche' si cadeva sul tubo retto e poi la si piegava con `bendA`.
`primTubePath` trascina la sezione lungo una Catmull-Rom con **trasporto
parallelo** delle terne: con un "su" fisso la sezione si capovolge dove la curva
diventa verticale e il tubo si strozza. Quattro punti bastano per un'ansa vera.
E' il primitivo di anse, manici, becchi, cavi, corrimano, tubature, tentacoli.

### Il mestiere nei prompt
`prompt-part.txt` apre spiegando **come ragiona un modellatore**: si scegle il
METODO in base alla forma (tondo -> tornio, scatolato -> box+booleane, sezione
variabile -> loft), la silhouette viene prima dei dettagli, e ci sono gli errori
da principiante che l'audit rifiuta (impilare cilindri per fare una forma tonda,
pezzi che si sfiorano, anelli appiccicati addosso invece di modanature nel
profilo). Per i corpi torniti c'e' la ricetta del profilo — piede, gola, ventre al
35-50% dell'altezza, rientro, collo al 40-60% del diametro massimo, labbro
svasato — con un profilo di riferimento a 12 punti.
`prompt-plan.txt` chiede la strategia come PRIMA decisione, e impone proporzioni
credibili (un vaso e' alto 1.5-2.5 volte il diametro massimo) e **al massimo 4
materiali**: piu' di quattro fanno sembrare l'asset un collage.

### Auto smooth: normali, non geometria
E' lo "Shade Auto Smooth" di Blender — gli spigoli piu' APERTI di una soglia
restano vivi, gli altri si smussano. Su un low-poly e' cio' che lo fa sembrare
tondeggiante **senza aggiungere un triangolo**: misurato, un vaso a 12 lati passa
da sfaccettato a tondo restando a 2280 triangoli.

- `meshSmoothNormals` SALDA per posizione prima di mediare. Le primitive di
  questo motore hanno vertici duplicati sui bordi di faccia (una scatola ne ha
  24, non 8) per tenere le normali piatte: mediare senza saldare non troverebbe
  nessun vicino e il pulsante non farebbe nulla.
- Ritorna una mesh ESPANSA (una normale per angolo): e' l'unico modo di avere
  spigoli vivi e superfici lisce nello stesso oggetto. Verificato che il cubo
  resta a spigoli vivi a soglia 40 gradi e il volume non cambia di un epsilon.
- **`spec.smooth = {on, angle}` sta nella SPEC, non nella vista**: sopravvive al
  rebuild, finisce nell'export GLB, si salva col progetto ed e' annullabile con
  Ctrl+Z. Un interruttore di sola vista sarebbe sparito al primo rebuild e
  l'export non l'avrebbe rispettato.
- `flatShading` del materiale si spegne quando lo smooth e' acceso, altrimenti
  Three butta via le normali calcolate e il pulsante sembra inerte.
- **`normalize_spec` deve PORTARLO ATTRAVERSO**: dimenticarlo la' e' esattamente
  cio' che rendeva il pulsante apparentemente inerte quando si riapriva una spec
  (il campo veniva scartato in silenzio). Provato con due screenshot identici
  prima della correzione.

### Il profilo 2D si vede (pannello + validatori)
In un solido di rivoluzione TUTTA la forma sta nel profilo: la mezza sezione
tagliata verticalmente, `[raggio, quota]`. E' lo stesso disegno che si fa prima di
uno spin, e **giudicarlo in 2D e' molto piu' facile che giudicare il render** — un
gradino nel profilo si vede subito nel disegno e si confonde con un'ombra nel
rendering. Il pannello lo disegna con la meta' specchiata (la silhouette vera) e
i punti visibili.
`validateProfiles` prende deterministicamente: raggi negativi, quote che tornano
indietro (il profilo si autointerseca e la rivoluzione si ripiega),
**`profileStep`** — raggio che salta a quota ferma, che e' la firma della "pila di
dischi" — e profili troppo grossolani.

### `repairAgainstPlan`: il plinto da un metro
Un plinto che il piano dava largo 0.21 m veniva costruito largo 1.00 m: e' un
errore di UNITA' (misure scritte come "relative" invece che in metri), e
correggerlo e' una divisione, non un giudizio. Si riscala il nodo contro il piano
senza chiamare l'AI, solo quando lo scarto e' grossolano (oltre il 60%): entro
quella soglia la differenza puo' essere una scelta di modellazione, e
sovrascriverla sarebbe cancellare il lavoro di chi ha costruito. I nodi `locked`
non si toccano, e la moltiplicazione passa da `offsetScale`, che conserva
l'espressione.

- Fase 1 = core di generazione + visore + editor. Gauntlet Loop multi-agente e
  skinning vero restano fuori.

### Il piano dell'architetto (`src/plan.py`) — cio' che rende precise le misure
Il difetto piu' costoso NON e' estetico, e' aritmetico: il modello piazza i pezzi
indovinando i centri e dichiara un ingombro che non c'entra con cio' che
costruisce (misurato in GUI il 2026-08-16: una spada con la punta alta 0.45 m in
FONDO, `size` dichiarato 4.04 m contro 1.13 misurato, 30 "frammenti"). Nessun
prompt piu' lungo lo risolve, perche' il modello non fa la somma — quindi si
cambia la **rappresentazione**:

1. **`POST /api/asset/plan`** (`prompt-plan.txt`) chiede una CATENA di segmenti
   contigui lungo l'asse principale: `{n, from, to, w, d}` in metri. Da
   `from`/`to` il centro e' `(from+to)/2` e la lunghezza `to-from`: due numeri
   che si **controllano**, non si indovinano.
2. **`normalize_plan`** verifica e RIPARA: contiguita' (`chain[i].to ==
   chain[i+1].from`, chiusa conservando la lunghezza del pezzo successivo),
   somma totale, extras dentro il loro ospite, e **ricalcola i totali
   trasversali dal massimo delle sezioni** — un `total` dichiarato piu' piccolo
   dei suoi pezzi viene scartato.
3. **`plan_params`** consegna `<pezzo>_a/_b/_w/_d` gia' pronti, e il prompt
   impone di usarli come espressioni invece di ricopiare numeri a mano.
4. **`audit_built`** (nessuna AI: e' una somma) confronta la mesh col piano pezzo
   per pezzo — lunghezza, POSIZIONE, sezioni, pezzi mancanti, pezzi estranei
   grandi — e ogni difetto porta il numero giusto nel campo `fix`.
5. La UI cicla: genera → audit → patch → riaudit (`MAX_FIX_ROUNDS = 2`), e si
   ferma quando **i numeri tornano** — non quando il modello dice che va bene —
   o quando un giro non migliora niente.

Da non rompere:
- **Il piano e' il DEFAULT** (`planFirst` assente = true). Disattivarlo riporta
  al comportamento vecchio, cioe' al difetto.
- **Con un piano l'ingombro non si dichiara**: `normalize_spec(..., hasPlan=True)`
  tace su `sizeMissing` e `main.py` sovrascrive `spec["size"]` col totale del
  piano. Il valore finale e' quello MISURATO sulla mesh; l'audit confronta i due.
- **`validateSize` si spegne con un piano** (`validateAll(spec, built, {hasPlan})`):
  l'audit giudica lo stesso fatto con numeri verificati, e due giudizi sulla
  stessa causa darebbero due difetti.
- **L'audit vive SOLO in Python.** Il JS misura (`measuredFor`, `partMetrics`) e
  chiama `/api/asset/audit`. Duplicarlo sarebbe la trappola della doppia
  implementazione che questo progetto evita per costruzione.
- Tolleranza `max(6 mm, 18%)`: una sfera di diametro `w` non riempie un segmento
  piu' lungo di `w`, e pretendere l'uguaglianza esatta darebbe difetti su
  geometria corretta.

Due falsi positivi trovati in GUI reale, invisibili ai test unitari:
- **voxelizzazione**: campionare vertici e baricentri lasciava buchi sulle facce
  grandi e le componenti connesse dicevano "30 frammenti, 5 parti staccate" su
  una spada tutta attaccata. Ora si rasterizzano i triangoli a passo mezza cella
  e si contano i **26 vicini** (due pezzi che si toccano di spigolo sono saldati).
- **`flat_top`**: il modello scrive quella bandiera anche su una spada, perche' la
  regola delle piattaforme sta fra quelle generali del prompt. Adesso serve anche
  un'impronta larga e bassa (o un nome che lo dica), altrimenti il validatore
  chiedeva di appiattire la punta di una lama.

## PixelAIEditor (`PixelAIEditor/`, app separata)

Editor di pixel art 2D / ritocco foto con generazione AI, con lo **stesso modus
operandi** di VoxelAIArtist: `main.py` avvia un `ThreadingHTTPServer` locale, apre
la UI nel browser di sistema (solo modalita' web: non c'e' il ramo Qt), e la
generazione passa dal client web `gemini` autenticato coi cookie. Si avvia da solo
con `run.bat` o `python PixelAIEditor/main.py`, e vive **dentro** VoxelAIArtist
quando si allarga il creatore di materiali.

- **I cookie sono CONDIVISI, le impostazioni no.** `src/settings.py` (del padre)
  ha ora `COOKIES_APP_NAME` fisso e `set_app_name()` che sposta solo la cartella
  delle preferenze. Un cookie e' una sessione Google, non una preferenza:
  legandolo ad `APP_NAME` lo stesso codice vedrebbe `has_cookies: true` servito
  dal padre e `false` avviato da solo. Gli autosalvataggi invece si separano,
  perche' la rotazione conta i file **per cartella** e mescolarli farebbe
  cancellare gli uni per far posto agli altri.
- **La rotta AI e' `/api/texture2d`, sempre.** Dentro VoxelAIArtist la pagina e'
  servita dal server del PADRE, dove `/api/texture` esiste gia' **ed e' un'altra
  cosa** (le facce di un materiale: altro prompt, altro contratto). Chiedere
  quel nome non darebbe un errore, darebbe una risposta plausibile e sbagliata.
  Scegliere la rotta in base allo stato del ponte sarebbe peggio: la stretta di
  mano e' asincrona, quindi una generazione lanciata subito la troverebbe ancora
  spenta. Il server autonomo accetta **entrambi** i nomi, cosi' il client non
  deve decidere niente.
- **Il ponte e' un iframe di pari origine + `postMessage`** (`23-bridge.js` nel
  figlio, `ui/src/lib/38-pixel-bridge.js` nel padre). Messaggi:
  `hello` / `load` / `apply` / `applied` / `close`; le facce viaggiano come
  `{key, dataUrl, w, h}` **nei due versi**, piu' `faceMode`, `active`,
  `material`. Il ragionamento e' a cubo: si scelgono le facce da dare come
  contesto all'AI.
- **Il prompt di generazione (`assets/prompts/prompt-pixel2d.txt`) e' stato
  riscritto misurando, non a intuito.** Gli arnesi stanno in `.superpowers/`
  (gitignored): `gen_pixel.py` genera davvero (passa da `ai_answer_text_retrying`,
  la stessa via dell'app), `render_pixel.mjs` espande col **modulo vero** e stampa
  metriche oggettive (buchi per flood-fill dal bordo, pixel-filamento, componenti
  connesse, uso della tela) piu' un PNG da guardare, `ab_pixel.py` fa una campagna
  A/B alternando vecchio e nuovo **per caso** (il servizio deriva nel tempo: due
  blocchi separati misurerebbero il momento, non il prompt).
  Cosa e' emerso, e che non si vede leggendo il codice:
  - **"invalid json" NON e' una debolezza del parser**: e' il client web di Gemini
    che instrada la richiesta al suo **generatore di IMMAGINI** e risponde in
    prosa. Il tempo di risposta e' la spia: **~2-3 s = immagine (fallimento),
    ~7-19 s = risposta testuale vera**. Si cura inquadrando il compito come dati
    ("sei un COMPILATORE di pixel art... NON generare un'immagine"): 6/6 JSON
    validi contro 4/6.
  - `line` produce un **filamento di 1 px**: una spada disegnata con `line` esce
    come un graffio (era esattamente il difetto riportato). I corpi vanno con
    `fill` di spessore >= 3.
  - **`mirror x` ribalta sulla COLONNA CENTRALE DELLA TELA, non sul centro del
    soggetto.** Un soggetto disegnato tutto a sinistra diventa DUE copie
    affiancate; uno disegnato a tutta larghezza esce doppio e spaccato in mezzo
    (misurato: 72 buchi, 2 pezzi). La regola nel prompt e' quindi condizionata, e
    dice di non usarlo nel dubbio.
  - Le metriche `pieces` / `strayPct` vanno lette **insieme**: una punta a scaletta
    stacca 1-2 pixel in diagonale (4-vicini), quindi `pieces=3` con `strayPct=0.5%`
    e' una punta affilata, non un disegno rotto.
  - **La richiesta dell'utente deve restare l'ULTIMA riga del template**
    (`tests/test_pixelai_server.py` lo pretende): un promemoria messo *dopo* la
    seppellisce. Il promemoria anti-immagine va quindi *prima* del segnaposto.
- **Il bundle si costruisce come quello del padre** (`node PixelAIEditor/ui/build.mjs`:
  `annotate-i18n.mjs` -> concatena i moduli di `manifest.json` -> sostituisce
  `<!--BUNDLE-->`), ma qui il segnaposto e' a **colonna 0**, quindi i moduli si
  rientrano di **4 spazi** e non di 12.
- I moduli `lib/NN-*.js` sono frammenti di **una sola closure**: niente
  import/export, niente IIFE. Quindi un `const` di primo livello **ripetuto in
  due moduli e' un SyntaxError al caricamento** e la pagina resta dipinta e
  completamente morta, senza un messaggio. `PixelAIEditor/.check_modules.mjs` e'
  la guardia.
- Vale la stessa regola i18n del padre, **compresi i nomi costruiti da JS**: i
  livelli ricordano da dove viene il loro nome (`autoKey` / `autoArgs`) invece di
  tenere la stringa risolta. Serve a due cose: il primo livello nasce **prima**
  di `bootI18n`, dove `t()` ritorna la chiave nuda per contratto (e infatti in
  GUI si presentava come `pix.layer.itemName`), e un nome che l'utente non ha
  scritto e' una didascalia, che cambiando lingua deve cambiare. Tre trappole,
  tutte trovate coi clic veri:
  - `autoKey`/`autoArgs` **viaggiano nello snapshot** della cronologia: un
    annulla che li perdesse congelerebbe "Livello 2" in italiano per sempre.
  - Gli argomenti possono essere a loro volta nomi automatici
    (`resolveAutoArgs`): l'etichetta di una copia ha **due** parti traducibili,
    e trattandone una sola l'elenco restava scritto in due lingue insieme
    ("Livello 3 copia" accanto a "Layer 3"). Un argomento che non e' automatico
    passa intatto — ed e' cosi' che "Cielo copia" diventa "Cielo copy".
  - `relabelAutoLayers` sta **prima** di `refreshLayerList` in `I18N_REDRAW`:
    prima si riderivano i nomi, poi si ridisegnano le righe.
- Il caso che ha motivato l'app — "rendere trasparente" un'immagine — e'
  `filtRemoveBg()` in `13-filters.js`: riempimento dai bordi con tolleranza,
  solo-bordi e sfumatura, con default il pixel in alto a sinistra del composito.

### Trasformazione della selezione (`PixelAIEditor/ui/src/lib/09b-transform.js`)
Con lo strumento **Sposta** il primo trascinamento apre una **sessione**: scatola
orientata con 8 maniglie, che sposta, ridimensiona e ruota. Non e' uno strumento
a parte — e' lo stesso Sposta di prima, che ora tiene uno stato (`_xf`) fra un
gesto e l'altro invece di applicare e dimenticare.
- **Il modificatore e' Shift, e ce n'e' uno solo.** Alt e' **globalmente il
  contagocce** (`strokeBegin`: `const tool = ev.altKey ? 'picker' : currentTool`),
  quindi tenerlo premuto non arriverebbe mai qui. Shift ha **un** significato,
  LIBERA: libera le proporzioni sul ridimensionamento e lo scatto di 15 gradi
  sulla rotazione. Il difetto da evitare e' dargli due significati diversi nei due
  gesti — chi lo tiene premuto non sa quale dei due sta facendo, e non c'e' un
  secondo modificatore per distinguerli.
- **Il default e' vincolato**, non libero: proporzioni mantenute e angolo a
  scatti. E' il verso giusto perche' il vincolo e' quello che si vuole quasi
  sempre e liberarlo e' l'eccezione (ed e' cio' che fa paint.net).
- **La scatola non si arrotonda**: `screenToPixelF` (05-render.js) da' coordinate
  frazionarie. Arrotondando i punti del puntatore, a zoom 1 la rotazione
  scatterebbe di parecchi gradi fra un pixel e l'altro. Si arrotonda alla FINE,
  quando si stampa.
- **Ogni gesto ricampiona la sorgente ORIGINALE (`src`), non il risultato
  precedente.** Ridimensionare tre volte non deve accumulare tre
  ricampionamenti: una pixel art passata due volte da un nearest a fattori non
  interi diventa un reticolo irregolare, e non si torna indietro.
- **La soglia di presa segue lo ZOOM** (`xformHitTol` = `max(9/zoom, ...)`): e' una
  distanza in pixel di SCHERMO. Fissarla in pixel di documento la renderebbe
  gigante a zoom 1 e irraggiungibile a zoom 32. L'anello di rotazione sta **fuori**
  dalla scatola, fra `tol` e `3*tol` da uno spigolo: dentro la scatola lo stesso
  punto e' una maniglia di scala, e sono le due prese piu' vicine fra loro.
- **`overlayNow` disegna le formiche PRIMA di `drawToolOverlay`.** Le maniglie
  stanno sul bordo della selezione, cioe' esattamente dove passano le formiche:
  disegnandole prima le si copre. In GUI reale l'angolo alto-sinistro non si
  vedeva **mai** — e' l'unico dei quattro che cade su un pixel *selezionato* (la
  scatola stringe la selezione, quindi gli altri tre cadono appena fuori) e quindi
  l'unico su cui passa una formica. Invisibile ai test unitari, invisibile
  leggendo il codice.
- Le formiche si spengono **solo durante un trascinamento**
  (`xformSuppressAnts`): a riposo servono a dire che la selezione c'e' ancora.
- La cronologia e' agganciata dall'esterno: `pushHistory()` chiama per prima cosa
  `xformBeforeExternalEdit()` (funzione **issata**, quindi 06-history.js puo'
  chiamarla pur venendo prima), e `undo`/`redo`/`resetHistory` chiudono la
  sessione. Un gesto = un annullamento: Ctrl+Z toglie l'ultimo ridimensionamento,
  non la sessione intera.
- `.superpowers/check_transform.py` (gitignored) la prova in **GUI reale**, 44
  controlli. Tre trappole di misura, tutte costate una tornata di falsi negativi:
  lo zoom non e' quello dei sorgenti (`let zoom = 8`) ma quello **adattato alla
  finestra** (misurato 12 su 64x64), quindi ogni soglia si ricalcola dal riquadro
  vero; le formiche **lampeggiano** a 120 ms, quindi un pixel letto due volte da'
  due colori e si misura **una** fotografia sola; le maniglie sono blocchi 3x3 di
  pixel di documento. La cura: si conta il **rosso** (`#FF0000` non compare
  altrove) e si misura a **overlay spento** (`visibility: hidden` su
  `#pixOverlay`), legittimo perche' l'overlay non e' il disegno e non finisce in
  un export. Le maniglie si controllano a parte con `grab(overlay=True)` — che e'
  anche l'unico modo di distinguere "la maniglia non c'e'" da "c'e' ma qualcuno le
  sta sopra". Prevedere quali colonne l'overlay eroda **non funziona**: i valori
  attesi cambiano a ogni ritocco di geometria.

## Server MCP (`mcp_server/`)

Espone VoxelAIArtist come 48 strumenti a un assistente
(`python -m mcp_server --workdir CARTELLA`, canale stdio). Non avvia la GUI e non
parla col server HTTP: importa `main.py` e i moduli di `src/` in **questo**
processo e tiene il documento in memoria. La documentazione per l'utente e'
`mcp_server/README.md`; qui stanno solo le cose che si sbagliano riscrivendole.

- **Gli strumenti ritornano TESTO, non oggetti.** Un JSON di quattromila voxel
  dice a un modello meno di "42 voxel, 3 colori, ingombro 7x7x5". L'elenco dei
  voxel non gli arriva mai: e' grande, illeggibile, e lo si otterrebbe solo per
  riscriverlo. Dove il dato strutturato serve (elenchi, statistiche) esce un JSON
  breve.
- **Ogni modifica passa da `doc.edit(...)`**, cioe' dalla cronologia: la
  riparazione di un errore dev'essere `voxel_undo`, non "rifai il modello".
  Scrivere su disco e' l'unica cosa irreversibile, quindi l'unica con un vincolo:
  `_resolve_out()` confina le scritture in `WORKDIR` confrontando i percorsi
  REALI (quindi `..` e i collegamenti simbolici non lo aggirano) con un
  separatore in coda (o `/lavoro2` passerebbe per dentro `/lavoro`). **Leggere non
  ha limiti ed e' voluto**: aprire un file che l'utente ha nominato e' cio' che
  gli e' stato chiesto.
- **`src/` si importa PIATTO, mai come pacchetto**: `compat.py` aggiunge `src/` a
  `sys.path` **in coda** (`parser` collide con quello della libreria standard).
  `from src import settings` solleva `ValueError: source code string cannot
  contain null bytes` — `src/__init__.py` sono 6 byte di BOM UTF-16.
- **Solo 7 strumenti su 48 chiamano un modello esterno** (`voxel_generate`,
  `voxel_modify`, `voxel_texture_generate`, `voxel_rig_animate`,
  `voxel_pack_start` + i due che ne leggono l'esito). Tutto il resto gira in
  locale senza credenziali, e `voxel_ops` prende le stesse ops compatte che
  produce l'AI: un assistente disegna da se', senza cookie.
- **Due formati di ops, una sola parola.** Le ops dei VOXEL sono **liste**
  (`["fill",0,0,0,7,3,7,"#8844AA"]`), quelle dei PIXEL sono **stringhe**
  (`"fill 0 0 15 15 a"`). `apply_pixel_op` ritorna 0 su un non-stringa **senza un
  avviso**, quindi la lista dava una texture vuota e il messaggio "le ops non
  hanno dipinto niente", che manda a cercare l'errore nei colori. La conversione
  sta in `textures.op_to_text`/`ops_to_text`, cioe' **al confine MCP e non in
  `pixelops.py`**: quel modulo ha un gemello in JS e `tests/pixel_parity_check.sh`
  li confronta op per op — allargare li' cio' che si accetta romperebbe la parita'.
- **La coda dei pack gira in QUESTO processo**, non in quello dell'app: e' la
  stessa classe con la stessa cartella, non la stessa istanza. I worker di
  `src/pack.py` sono thread `daemon`, quindi un pack in corso muore col server;
  uno ARRIVATO IN FONDO si rivede anche dalla GUI, perche' la persistenza passa
  dal disco.
- **stdout e' il canale del protocollo.** Il saluto d'avvio va su stderr e
  `compat.protect_stdout()` dirotta ogni `print` del processo **prima** di
  `mcp.run()`: la coda dei pack stampa dai suoi thread, che nessun `quiet()` a
  blocco potrebbe coprire. Una riga di troppo su stdout chiude il client senza
  spiegazioni.
- **`__main__.py` regge anche `python percorso/a/mcp_server`** (la cartella come
  argomento), che e' la forma per i client che non sanno impostare una directory
  di lavoro — Claude Desktop fra questi. Senza la guardia su `__package__`,
  `ImportError: attempted relative import with no known parent package`. Da qui
  discende che **non va importato nelle prove**: chiama `main()` all'import, cioe'
  avvia il server e gli fa consumare il ciclo di eventi del processo.
- **Un modello umanoide va costruito in T-POSE.** Le stazioni delle braccia si
  misurano dal bordo del torso, e con le braccia lungo i fianchi quel bordo *e'*
  il braccio: la spalla finisce sulla punta del dito e a `upperArm_*` non si lega
  nessun voxel. Le braccia si abbassano dopo, con `voxel_rig_pose` (Z −78 a
  destra, +78 a sinistra).
- Guardie: `tests/test_mcp_server.py` (268 controlli, dal registro VERO di
  FastMCP: uno strumento puo' esistere e non essere esposto),
  `test_mcp_rig.py` / `test_mcp_export.py` / `test_mcp_import.py`. Il punto di
  sostituzione e' `ai.answer_text`, risolto dai globali a ogni chiamata: le prove
  gli assegnano una funzione finta e prompt, recupero del JSON ed espansione
  girano per davvero senza rete.
  Fra queste c'e' **la guardia contro gli strumenti fantasma**: le descrizioni si
  rimandano l'un l'altra ("rileggila con X") e un nome sbagliato li' non da'
  nessun errore — il modello chiama uno strumento inesistente e sembra che se lo
  sia inventato. Ne sono stati trovati due in GUI (`voxel_render`,
  `voxel_pack_retry`), quindi ora ogni `voxel_*` citato in `mcp_server/` deve
  esistere nel registro o essere una funzione interna.

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
