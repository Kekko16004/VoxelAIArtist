# T5 — Studio di fattibilità: eliminare Chromium/QtWebEngine e portare tutto in Python nativo

Creato: 2026-07-19 — Agente "3D Engine + Build". Documento di sola analisi. **Nessun codice dell'app è stato toccato.**

## TL;DR (per chi non conosce le opzioni tecniche)

Oggi l'app è un **editor voxel 3D completo scritto in JavaScript + Three.js** (viewer, editing per-voxel, undo, simmetria, gizmo, rig+animazioni, export OBJ e GLB), incapsulato in una finestra PyQt6 che usa Chromium (QtWebEngine). "Portare tutto in Python nativo" significa **riscrivere da zero quel motore JS** usando una libreria grafica Python — è un lavoro grosso (stimato **10-16 settimane/uomo** per parità completa) e si perde l'intero ecosistema Three.js (GLTFExporter, OrbitControls, TransformControls, SkinnedMesh) che oggi funziona gratis.

La strada che consiglio **non** è il porting: è (1) alleggerire la build attuale e/o (2) sostituire QtWebEngine con **pywebview** SOLO se accettiamo di dipendere dal WebView2 di sistema. Dettagli e alternative sotto.

---

## 1. Cosa c'è oggi da riscrivere (inventario concreto)

Fonte: ispezione di `ui/index.html` (**4330 righe totali**, di cui **~2995 righe di `<script>` JS** e **~785 righe di CSS**), **68 funzioni JS**, **71 `addEventListener`**, **68 controlli UI** (`button`/`input`/`select`/`textarea`). Dipendenze da CDN (Three.js **r128** + tre addon).

### Capacità del frontend da reimplementare

| Capacità | Dove (funzioni chiave) | Cosa fa | Difficoltà di porting |
|---|---|---|---|
| **Rendering instanced** | `buildModel()` (righe ~1880-2020) | Una `InstancedMesh` per colore = 1 draw call/colore, mantenendo il picking per-voxel | Media — serve instancing GPU + gestione materiali per colore |
| **Raycasting / picking per-voxel** | `pickVoxel()`, `updatePreview()`, `raycaster` | Click su faccia voxel → coordinate cella; ghost verde (add) / outline rosso (remove) | **Alta** — Three.js dà `Raycaster` gratis; in Python va fatto a mano o con la lib |
| **Strumenti editing** | `setTool()`, `performAction()`, `strokeApply()`, `brushCells()` | `view`/`place`/`remove`/`pick` (eyedropper), pennello, stroke drag | Media |
| **Undo/redo** | `pushHistory()`, `undo()`, `redo()`, `restoreSnapshot()` | Stack cronologico unificato, snapshot | Bassa (logica pura, riusabile) |
| **Simmetria** | `mirrorCell()`, `withMirrors()`, `updateMirrorPlane()` | Specchia edit su asse x/y/z + piano traslucido | Bassa-media |
| **Gizmo trasformazioni** | `globalTransformControls` (=`THREE.TransformControls`), `onGizmoDragStart/Change/End` | Frecce 3D per spostare modello/giunti | **Alta** — TransformControls è ~1500 righe di Three; nessun equivalente Python pronto |
| **Piani di vincolo / drag preview** | `recomputeActivePlane()`, `projectPointerToPlane()`, `updateDragPreview()`, `updateConstraintHUD()` | Proietta il puntatore su un piano per disegnare box/rect | Media-alta (geometria manuale) |
| **Rig scheletro** | `buildHumanoidSkeleton()`, `buildGenericSkeleton()`, `bindVoxels()`, `buildSkinnedMesh()`, `applyRig()` | Scheletro a ossa, skinning (`skinIndex`/`skinWeight`), `SkinnedMesh` | **Molto alta** — skinning GPU + `Skeleton`/`Bone` sono infrastruttura Three pesante |
| **Animazioni** | `buildAnimationClips()`, `playClip()`, `AnimationMixer`, `QuaternionKeyframeTrack`, `VectorKeyframeTrack` | Clip preset, mixer, keyframe track | **Molto alta** — nessuna lib Python offre un `AnimationMixer` equivalente |
| **Export OBJ/MTL greedy mesh** | `greedyMesh()`, `buildObjText()`, `buildMtlText()`, `matNameFor()` | Sweep-plane che fonde facce coplanari stesso colore in quad massimali | Bassa — algoritmo puro, **già esiste anche in `src/parser.py`** (`export_voxels_to_obj`, righe 407-456) |
| **Export GLB** | `exportGLB()`, `buildStaticExportMesh()` (`THREE.GLTFExporter`) | Esporta mesh riggata+animata in .glb | **Alta** — dipende interamente da GLTFExporter |
| **Drag & drop file** | `handleFile()`, `loadJSONString()`, `expandOps()` | Carica JSON/compact, espande op client-side | Bassa |
| **UI a tab** | `switchTab()`, blocco CSS ~785 righe, 68 controlli | Sidebar `Genera`/`Vista`/`Disegna`/`Rig`, footer export | **Alta come volume** — tutta la UI HTML/CSS va ricostruita in un toolkit nativo |
| **Rotazione modello/camera** | `OrbitControls`, `modelPivot`, `autoRotate`, `animate()` | Orbit camera + turntable oggetto | Media (OrbitControls da reimplementare) |

### Stima grezza del "peso da riscrivere"
- **Logica pura riusabile** (op expander, greedy mesh, undo, simmetria, serializzazione): ~600-800 righe → **riportabili con effort basso**.
- **Motore grafico + interazione** (render, picking, gizmo, controlli camera, preview): ~1000-1200 righe JS che dipendono da API Three → **da riscrivere quasi interamente**.
- **Rig + animazioni + export GLB**: ~700-900 righe fortemente accoppiate a Three (`Skeleton`, `SkinnedMesh`, `AnimationMixer`, `GLTFExporter`) → **la parte più costosa e rischiosa**.
- **UI/CSS**: 785 righe CSS + 68 controlli → in nativo diventa codice imperativo in un toolkit (Qt Widgets / Dear ImGui), volume comparabile.

---

## 2. Opzioni tecniche Python (pro/contro per questo caso d'uso)

Caso d'uso specifico: **editor voxel 3D interattivo** con picking per-voxel, gizmo, UI ricca e export mesh/GLB. Non è una semplice visualizzazione: serve interazione fine + UI + I/O 3D.

### a) moderngl
- **Cos'è**: wrapper Python moderno e sottile su OpenGL 3.3+. Solo rendering, nient'altro.
- **Maturità**: buona, stabile, mantenuta.
- **Picking/raycasting**: **da fare a mano al 100%** (matematica raggio-AABB per voxel, o color-picking via framebuffer). Fattibile ma è tutto lavoro tuo.
- **UI**: nessuna. Va abbinata a un toolkit (Qt) o a Dear ImGui (`imgui-bundle`).
- **Peso**: leggero (~pochi MB).
- **Export mesh/GLB**: nessuno nativo; useresti `trimesh`/`pygltflib` a parte.
- **Verdetto**: massimo controllo, ma **stai costruendo un engine da zero**. Adatto solo se vuoi il pieno controllo e hai tempo.

### b) PyOpenGL
- **Cos'è**: binding OpenGL classico, molto low-level e datato come stile API.
- **Maturità**: storicamente stabile ma verboso; moderngl è preferibile quasi sempre.
- **Picking/UI/export**: come moderngl ma con più boilerplate e meno ergonomia.
- **Verdetto**: **sconsigliato** rispetto a moderngl per un progetto nuovo. Nessun vantaggio qui.

### c) pygfx (su wgpu/WebGPU) — [PyPI](https://pypi.org/project/pygfx/), [GitHub](https://github.com/pygfx/pygfx), [sito](https://pygfx.com/)
- **Cos'è**: render engine Python moderno stile scene-graph (concetti Scene/Camera/Mesh/Material molto vicini a Three.js), su WebGPU via `wgpu-py`.
- **Maturità**: **in avvicinamento a 1.0 previsto ~luglio 2026** (proprio adesso). Fino a 1.0 **l'API può cambiare a ogni versione** — rischio di rotture. Fonte: [PyPI pygfx](https://pypi.org/project/pygfx/).
- **Picking/raycasting**: supporta **picking via id/coordinate** (leggendo buffer) — più pronto di moderngl grezzo, ma diverso dal Raycaster geometrico di Three.
- **UI**: nessuna integrata; si abbina a Qt/glfw/wx per la finestra e a ImGui/Qt per i widget.
- **Peso**: medio (porta con sé lo stack wgpu).
- **Export mesh/GLB**: non è il suo scopo; export via lib esterne.
- **Verdetto**: **la scelta concettualmente più vicina a Three.js** e la più promettente per un porting, ma **arriva a stabilità proprio ora** — adottarla significa accettare il rischio di un'API ancora giovane e la mancanza di equivalenti diretti per gizmo/animazioni.

### d) VTK
- **Cos'è**: toolkit di visualizzazione scientifica maturissimo (rendering, picking, mesh I/O).
- **Maturità**: altissima, decenni di sviluppo. Picking robusto integrato.
- **Picking/raycasting**: **eccellente** (`vtkCellPicker`, `vtkPointPicker`) — pronto all'uso.
- **UI**: si integra con Qt (`QVTKRenderWindowInteractor`).
- **Peso**: **pesante** (VTK è grande, decine/centinaia di MB nel bundle; peggiora, non migliora, l'obiettivo "app più leggera").
- **Export mesh/GLB**: buon supporto import/export mesh, incluso glTF di base.
- **Gizmo/animazioni skinned**: orientato a dati scientifici, non a rig/skinning stile game engine → il rig+animazioni sarebbe comunque da inventare.
- **Verdetto**: ottimo per picking e robustezza, ma **contraddice l'obiettivo leggerezza** e non risolve rig/animazioni.

### e) Panda3D
- **Cos'è**: game engine completo con scene graph, skinning, animazioni, caricamento modelli.
- **Maturità**: molto matura, usata in produzione.
- **Picking/raycasting**: sistema di collisione integrato utilizzabile per picking.
- **UI**: DirectGUI integrata (spartana) o abbinabile a Qt/ImGui.
- **Peso**: **pesante** nel bundle.
- **Export mesh/GLB**: import/export via `panda3d-gltf`; l'animazione skinned è supportata nativamente (vantaggio unico vs le altre).
- **Verdetto**: **l'unica opzione che copre nativamente rig+skinning+animazioni**, ma è pesante e ha una curva d'apprendimento da engine completo.

### f) Ursina — [PyPI](https://pypi.org/project/ursina/), [GitHub](https://github.com/pokepetter/ursina)
- **Cos'è**: wrapper "facile" sopra Panda3D, **pensato proprio per voxel/Minecraft-like** (esistono progetti voxel dimostrativi: [ursina-voxel-projects](https://github.com/nurse-the-code/ursina-voxel-projects)).
- **Maturità**: attiva (ultima release **dic 2025**, richiede **Python >=3.12**), ma API in evoluzione e orientata a prototipi/giochi più che a tool di produzione.
- **Picking/raycasting**: **`raycast()` e `mouse.hovered_entity` pronti** — ottimo per l'editing voxel.
- **UI**: sistema UI integrato semplice (Button, Text, InputField) — sufficiente per UI base, non per una sidebar ricca come l'attuale.
- **Peso**: eredita il peso di Panda3D (**pesante nel bundle**); packaging con PyInstaller documentato ma con accorgimenti (aggiungere i path di `panda3d`). Fonte: [Ursina building](https://www.ursinaengine.org/building.html).
- **Export mesh/GLB**: via Panda3D; rig/animazioni possibili ma da costruire.
- **Verdetto**: **il più rapido per prototipare un editor voxel** con picking pronto, ma UI limitata e bundle pesante; adatto a un porting parziale/prototipo, meno a replicare 1:1 l'attuale UI+rig+export.

### g) "pywebview al posto di QtWebEngine" (mantiene il JS, toglie Chromium?) — [doc renderer](https://pywebview.flowrl.com/3.7/guide/renderer)
- **Punto chiave (verificato)**: pywebview **non porta un browser proprio**: usa il **webview di sistema**. Su Windows l'ordine è `edgechromium` (WebView2, basato su Chromium Edge) → `edgehtml` → `mshtml`. Fonte: [pywebview - Web engine](https://pywebview.flowrl.com/3.7/guide/renderer).
- **Conseguenza onesta**: **non elimini Chromium**, lo sposti dall'app al sistema. Con WebView2 il motore è comunque Chromium (di Edge), non impacchettato nel tuo exe → **exe molto più leggero** (niente ~150 MB di QtWebEngine), MA dipendi dal **runtime WebView2 installato sulla macchina** (presente di default su Win11 e Win10 aggiornati; se assente, va installato). Fonte: [Microsoft - WebView missing runtime](https://learn.microsoft.com/en-us/answers/questions/5668034/webview-does-not-load-on-windows).
- **Vantaggio enorme**: **il codice JS/Three.js resta identico**. Niente riscrittura del motore. Cambia solo il "guscio" Python (`webview.create_window` + bridge `js_api` invece di `QWebEngineView`).
- **Contro**: dipendenza dal runtime di sistema; su vecchie macchine senza WebView2 fallback a `mshtml` (IE-legacy) che **non regge WebGL/Three.js moderno** → in pratica WebView2 è un requisito.
- **Verdetto**: **è la leva più efficace** per "app più leggera senza Chromium embedded" con **effort minimo** e **zero perdita di funzionalità**. Non è porting nativo, ma centra l'obiettivo pratico (exe leggero, avvio senza browser embedded impacchettato).

---

## 3. Stima effort realistica

Assunzioni: 1 sviluppatore competente, parità funzionale con l'attuale editor.

| Scenario | Descrizione | Effort |
|---|---|---|
| **Porting completo nativo** (es. pygfx o Panda3D + Qt/ImGui) | Riscrivere render, picking, tutti gli strumenti, gizmo, UI a tab, rig, animazioni, export OBJ+GLB in Python | **10-16 settimane/uomo** (il rig+animazioni+gizmo+export GLB da soli valgono 5-8 settimane e sono ad alto rischio) |
| **Porting parziale** (solo viewer + editing voxel base, senza rig/animazioni, export OBJ ma non GLB) | Editor voxel funzionante nativo, si rinuncia a rig/anim/GLB | **4-7 settimane/uomo** |
| **Prototipo Ursina** (verifica di concetto editing voxel) | Solo per capire se la strada regge, non prod-ready | **1-2 settimane/uomo** |
| **pywebview** (sostituzione guscio, JS invariato) | Cambiare `main.py`, bridge JS↔Python, gestire dipendenza WebView2, QA | **3-6 giorni/uomo** |
| **Alleggerire QtWebEngine attuale** (= task T3) | `excludes` nella .spec, onedir vs onefile, misure peso | **1-3 giorni/uomo** |

---

## 4. Cosa si perde / rischi del porting nativo

- **Tutto l'ecosistema Three.js sparisce e va reimplementato**:
  - `OrbitControls` → riscrivere controlli camera (orbit/pan/zoom con inerzia).
  - `TransformControls` (gizmo frecce) → **nessun equivalente Python pronto**; è ~1500 righe di Three da rifare.
  - `GLTFExporter` → sostituibile con `trimesh.export_glb()` / `pygltflib`, **ma** l'export di **mesh riggata + animazioni** (skinIndex/skinWeight/keyframe) è molto più complicato del semplice export statico. Fonti: [trimesh gltf](https://trimesh.org/trimesh.exchange.gltf.html), [pygltflib](https://pypi.org/project/pygltflib/), [gltflib](https://github.com/lukas-shawford/gltflib). Nota: **il GLB statico è fattibile**, il GLB **animato** è il vero punto dolente.
  - `Skeleton`/`Bone`/`SkinnedMesh`/`AnimationMixer` → skinning e mixer di animazione: **solo Panda3D li offre nativamente**; con pygfx/moderngl vanno costruiti a mano.
- **Librerie voxel Python mature? Cercate: praticamente no.** Le voci trovate sono o didattiche/raycasting 2.5D stile Wolfenstein ([lewisc64/pyray](https://github.com/lewisc64/pyray), [idJoca/raycasting](https://github.com/idJoca/raycasting)), o ray-tracing tutorial ([pyray di ryu577](https://github.com/ryu577/pyray)) — **nessun editor voxel Python di riferimento** con instancing+picking+rig. Esistono demo voxel su Ursina ([ursina-voxel-projects](https://github.com/nurse-the-code/ursina-voxel-projects)) ma sono giochi Minecraft-like, non editor. **Conclusione: non c'è una base pronta da riusare; il grosso è codice nuovo.**
- **Regressione WebGL→OpenGL/WebGPU**: la resa visiva (glassmorphism della UI, blur, ombre, anti-alias) e le performance vanno riottenute e ritarate.
- **Rischio pygfx pre-1.0**: API instabile fino a ~luglio 2026 → possibili rotture durante lo sviluppo. Fonte: [PyPI pygfx](https://pypi.org/project/pygfx/).
- **Doppio-mantenimento op**: oggi la semantica op è duplicata (`expand_ops` in `parser.py` + `expandOps` in `index.html`). Un porting nativo **eliminerebbe la duplicazione** (un solo Python) — questo è l'**unico vantaggio architetturale reale** del porting.
- **UI da ricostruire**: 785 righe CSS + 68 controlli → tutta imperativa in Qt/ImGui, con perdita dell'estetica web attuale.

---

## 5. Alternative più leggere del porting totale

### (a) Restare su QtWebEngine ma alleggerire (= T3)
- `excludes` nella `.spec` per moduli Qt/tkinter/test non usati; valutare onedir vs onefile; UPX già attivo; misurare peso prima/dopo.
- **Non elimina Chromium**, ma riduce il bundle con rischio quasi nullo e zero perdita di funzionalità.
- **Effort minimo, rischio minimo.** Da fare comunque.

### (b) pywebview
- Toglie **QtWebEngine impacchettato** (exe molto più leggero) mantenendo **JS/Three.js invariato**.
- Usa **WebView2 di sistema** (comunque Chromium di Edge) → dipendenza runtime, non porti tu il motore.
- Centra l'obiettivo pratico "app leggera, avvio senza browser embedded impacchettato" con **effort di giorni**, non settimane.
- **Rischio principale**: macchine senza WebView2 (raro su Win10/11 aggiornati). Va gestito con un check/installer del runtime.

### (c) Porting incrementale
- Tenere il guscio web e portare in Python **solo la logica pura** (op expander per eliminare la duplicazione, greedy mesh già in `parser.py`, export server-side) via endpoint del server HTTP locale già presente in `main.py`.
- La UI/3D resta JS; il backend Python guadagna responsabilità.
- Riduce il debito (duplicazione op) senza riscrivere il motore. **Effort modulare, rischio basso.**

---

## 6. Raccomandazione finale

### Tabella riassuntiva

| Opzione | Elimina Chromium davvero? | App più leggera? | Perdita funzionalità | Effort | Rischio | Consigliata? |
|---|---|---|---|---|---|---|
| Alleggerire QtWebEngine (T3) | No | Parziale (bundle ridotto) | Nessuna | 1-3 gg | Molto basso | **Sì (subito)** |
| **pywebview** | No (usa WebView2 di sistema) | **Sì (exe molto più leggero)** | Nessuna (JS invariato) | 3-6 gg | Basso-medio (dip. WebView2) | **Sì (miglior rapporto valore/rischio)** |
| Porting incrementale (logica in Python) | No | Marginale | Nessuna | Modulare | Basso | Sì (in parallelo, toglie duplicazione op) |
| Porting nativo pygfx | Sì | Dipende (stack wgpu) | Alta (Three ecosystem) | 10-16 sett | **Alto** (pre-1.0, tutto da rifare) | No (per ora) |
| Porting nativo Panda3D/Ursina | Sì | No (bundle pesante) | Media-alta | 8-16 sett | Alto | No |
| Porting nativo VTK | Sì | **No (più pesante)** | Alta (no rig/anim) | 10-16 sett | Alto | No |
| moderngl/PyOpenGL from scratch | Sì | Sì | Altissima (engine da zero) | 14-20 sett | Molto alto | No |

### Risposta netta: conviene o no?

**No, il porting completo in Python nativo non conviene** in questo momento. Il motivo è semplice: l'app oggi ottiene "gratis" da Three.js una montagna di funzionalità difficili (gizmo TransformControls, OrbitControls, SkinnedMesh+AnimationMixer, GLTFExporter). Riscriverle in Python significa 10-16 settimane di lavoro ad alto rischio, e **non esiste una libreria voxel Python matura** da cui partire. L'unica opzione che coprirebbe nativamente il rig+animazioni (Panda3D) è anche pesante, quindi contraddirebbe l'obiettivo "app più leggera". La più elegante concettualmente (pygfx) arriva alla stabilità 1.0 proprio ora e resta priva di equivalenti per gizmo e animazioni.

### Cosa farei al posto dell'utente

1. **Subito**: eseguire T3 (alleggerire la build QtWebEngine) — guadagno immediato, rischio nullo.
2. **Poi, se l'obiettivo primario è "exe leggero senza Chromium impacchettato"**: fare un **spike di 1 giorno con pywebview** su una copia, verificando che Three.js r128/WebGL giri bene su WebView2 e che il bridge JS↔Python sostituisca l'attuale iniezione di `__API_BASE__`. Se il runtime WebView2 è presente sui target (quasi certo su Win10/11 aggiornati), **migrare a pywebview**: si ottiene un exe molto più leggero mantenendo intatto tutto il lavoro JS.
3. **In parallelo, opzionale**: portare in Python la sola logica pura (op expander, greedy mesh) via server locale, per **eliminare la duplicazione** `expand_ops`/`expandOps` — l'unico debito architetturale che il porting risolverebbe, ottenuto senza riscrivere il motore.
4. **Rivalutare il porting nativo (pygfx) tra 6-12 mesi**, quando pygfx sarà stabilmente ≥1.0, e solo se emerge un vincolo forte (es. distribuzione totalmente offline senza WebView2, o esigenza di performance non ottenibili in WebGL).

---

## Fonti
- pygfx: [PyPI](https://pypi.org/project/pygfx/), [GitHub](https://github.com/pygfx/pygfx), [sito](https://pygfx.com/), [wgpu-py](https://github.com/pygfx/wgpu-py)
- pywebview renderer/WebView2: [pywebview doc](https://pywebview.flowrl.com/3.7/guide/renderer), [Microsoft WebView2 runtime](https://learn.microsoft.com/en-us/answers/questions/5668034/webview-does-not-load-on-windows), [Playwright WebView2](https://playwright.dev/python/docs/webview2)
- Ursina: [PyPI](https://pypi.org/project/ursina/), [GitHub](https://github.com/pokepetter/ursina), [building](https://www.ursinaengine.org/building.html), [demo voxel](https://github.com/nurse-the-code/ursina-voxel-projects)
- Export GLB Python: [trimesh gltf](https://trimesh.org/trimesh.exchange.gltf.html), [trimesh PyPI](https://pypi.python.org/pypi/trimesh), [pygltflib](https://pypi.org/project/pygltflib/), [gltflib](https://github.com/lukas-shawford/gltflib)
- "Librerie voxel/raycasting Python" (didattiche, non editor): [lewisc64/pyray](https://github.com/lewisc64/pyray), [idJoca/raycasting](https://github.com/idJoca/raycasting), [ryu577/pyray](https://github.com/ryu577/pyray)
