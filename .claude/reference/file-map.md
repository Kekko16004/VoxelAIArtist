# File Map — dove cercare cosa (per non rileggere tutto ogni volta)

Consulta questo file PRIMA di aprire i sorgenti. Ti dice quale file toccare per ogni tipo di modifica.

## Struttura del progetto

```
VoxelAIArtist/
├── main.py                     # App desktop PyQt6 + server HTTP + proxy AI (ENTRY POINT)
├── VoxelAI.spec / build.bat    # Build PyInstaller (exe onefile)
├── CLAUDE.md                   # Architettura per Claude Code (leggere sempre)
├── src/
│   ├── parser.py               # expand_ops (compact→flat) + recovery JSON LLM + legacy OBJ/server
│   └── settings.py             # cookies/settings in %APPDATA%/VoxelAIArtist/
├── ui/
│   ├── index.html              # ~4300 righe: viewer Three.js + editor + rig (TUTTO inline)
│   └── settings.html           # pagina impostazioni (incolla cookie)
├── assets/prompts/
│   ├── prompt.txt              # template generazione
│   └── prompt-edit.txt         # template modifica modello
├── examples/*.json             # modelli di esempio (formato compact e flat)
└── .claude/                    # orchestrazione team, reference, task, log (questa cartella)
```

## Cosa modificare per...

| Obiettivo | File da toccare |
|-----------|-----------------|
| Nuovo op / cambio semantica op | `src/parser.py` `expand_ops()` **E** `ui/index.html` `expandOps()` (SEMPRE entrambi) |
| Prompt AI generazione/modifica | `assets/prompts/prompt.txt` / `prompt-edit.txt` |
| Routing API / server / finestra Qt | `main.py` |
| Percorsi cookie/settings | `src/settings.py` |
| Editor voxel (place/remove/pick, undo) | `ui/index.html` — cerca `currentTool`, `voxelMap`, `pushUndo` |
| Simmetria | `ui/index.html` — `symmetryAxis`, `mirrorCell`, `updateMirrorPlane` |
| Rotazione modello/camera | `ui/index.html` — `rotationMode`, `modelPivot` |
| Export OBJ/MTL | `ui/index.html` — `greedyMesh`, `buildObjText`, `buildMtlText` |
| Export GLB / rig / animazioni | `ui/index.html` — `exportGLB`, `buildAnimationClips`, `playClip`, `pickBone` |
| Stile / tema / CSS | `ui/index.html` — blocco `:root` (righe ~21-30) e regole sotto |
| Layout sidebar / tab | `ui/index.html` — `.tab-bar`, `.tab-panel`, `switchTab` |
| Costruzione mesh viewport | `ui/index.html` — `buildModel`, `InstancedMesh` |

## Modularizzazione `ui/src/` (W2-0)

> ⚠️ **`ui/index.html` è GENERATO. Non modificarlo a mano.** Modifica i moduli in
> `ui/src/**`, poi rilancia il build: `node ui/build.mjs`.

### Perché un build e non `<script src>` esterni
In desktop mode `main.py._load_html` usa `setHtml` (baseUrl file locale), dove il
caricamento di `<script src="...">` locali NON è affidabile (regole local-file di
QtWebEngine). Inoltre tutto il JS condivide **un unico scope** (const/let/function
che si vedono a vicenda). Perciò: NON si spezza in più `<script>`. Si tiene UN solo
`<script>` nel prodotto e i moduli vengono **ri-concatenati** al suo interno da un
passo di build. `main.py` resta INVARIATO e l'app carica identica in HTTP e desktop.

### Struttura
```
ui/
├── index.html                  # GENERATO (non editare) — output del build
├── build.mjs                   # build: template + moduli → index.html (solo `fs`, no deps)
└── src/
    ├── index.template.html     # index.html con il grande <script> sostituito da <!--BUNDLE-->
    ├── manifest.json           # ORDINE di concatenazione dei moduli (critico per lo scoping)
    ├── utils/
    │   └── expand-ops.js       # expandOps() + computeVisibility() (mirror di parser.py)
    └── lib/                     # frammenti dell'unico scope, in ordine:
        ├── 00-bootstrap-head.js   # apre `window.addEventListener('load', () => {`, defaultData, stato globale
        ├── 01-scene-setup.js      # renderer/scene/camera/controls, pivot, KEYMAP, luci, resize
        ├── 02-io-files.js         # dropzone/fileInput, handleFile, loadJSONString, resizer sidebar
        ├── 03-voxel-map.js        # rebuildVoxelMap / syncVoxelsFromMap
        ├── 04-objects.js          # T1 multi-oggetto: sceneObjects, outliner, rendering, modalità
        ├── 05-build-model.js      # buildModel (InstancedMesh) + greedyMesh
        ├── 06-export-obj.js       # matNameFor / buildMtlText / buildObjText / downloadFile
        ├── 07-save-payload.js     # buildObjectPayload / getSavePayload / getSceneSavePayload
        ├── 08-generate-ai.js      # UI genera, upload immagine, fetch /api/generate
        ├── 09-editing-engine.js   # currentTool, undo/redo state, preview mesh, drag state
        ├── 10-extrude-core.js     # T2: stato estrusione + collectExposedFace, drag preview
        ├── 11-symmetry-tools.js   # mirrorPlane, setTool, switchTab, setActiveColor
        ├── 12-extrude-logic.js    # T2: arm/cycle/cancel/commit extrude
        ├── 13-history.js          # undo/redo, snapshot, keydown handler, pickVoxel/updatePreview
        ├── 14-tools-actions.js    # brushCells, performAction, strokeApply, object-mode picking
        ├── 15-rig.js              # rigging/animazione + gizmo bone (TransformControls)
        ├── 16-export-glb.js       # CUBE_FACES, buildStaticExportMesh, exportGLB
        ├── 17-theme.js            # applyTheme (tema chiaro/scuro)
        └── 18-bootstrap-tail.js   # animate(), initScene(), chiude la closure `});`
```

I confini dei file sono tagli byte-esatti del blocco originale su bordi di linea:
la concatenazione dei moduli nell'ordine del manifest **riproduce esattamente** il
JS originale (verificabile con diff; l'unica differenza attesa è l'header generato).
La closure `window.addEventListener('load', ...)` **apre in `00-` e chiude in `18-`**:
i moduli NON sono programmi autonomi, sono frammenti di un unico scope. Niente
import/export ES. L'ordine del manifest è vincolante (const/let non sono hoisted).

### Build & verifica
- Build: `node ui/build.mjs` (rigenera `ui/index.html` dal template + manifest).
- Equivalenza: `diff <backup> ui/index.html` deve mostrare solo le 2 righe di header.
- Parse: estrai il `<script>` da `ui/index.html` e `node --check` (parse-only, THREE da CDN r128).

## Punti di ancoraggio nel codice (grep rapidi)

- Funzioni JS: `grep -nE "function [a-zA-Z0-9_]+" ui/index.html`
- Sezioni UI: `grep -nE "class=\"(tab|panel|sidebar|section)" ui/index.html`
- CSS vars: `grep -nE "^\s*--[a-z]|:root" ui/index.html`
- Funzioni Python: `grep -nE "def [a-zA-Z0-9_]+" src/parser.py`

## Verifica dopo modifiche

- Python: `python -c "import sys; sys.path.insert(0,'src'); from parser import expand_ops, extract_and_parse_json"`
- JS: estrai i blocchi `<script>` da `ui/index.html` e lancia `node --check` (parse-only, THREE è da CDN r128).
- App: `python main.py` (serve PyQt6 + PyQt6-WebEngine).
