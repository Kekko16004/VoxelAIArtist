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
  - Save JSON exports flat `voxels` for reload.
- **Rigging/animation** (the `rig` tab): a bone skeleton with pose sliders, animation clips (`buildAnimationClips`, `playClip`), and a `TransformControls` gizmo to move joints (`updateGizmo`, `pickBone`).
- **UI shell**: tabbed sidebar (`Genera` / `Vista` / `Disegna` / `Rig`), `.tab-content` scrolls, `.sidebar-footer` pins export/save. `switchTab()` drops back to the `view` tool when leaving `Disegna`. Styling is a dark glassmorphism theme via `:root` CSS custom properties (`--accent-primary`, `--glass-bg`, etc.) with `backdrop-filter` blur and rounded corners.

## Conventions & gotchas
- Editing op semantics requires a **paired edit** in `src/parser.py` (`expand_ops`) and `ui/index.html` (`expandOps`).
- `token.txt` and any `cookies.json` hold session credentials — never commit or echo their contents.
- The Three.js version is pinned to r128 via CDN; APIs differ in newer versions, so don't assume modern Three.js when editing viewer code.
- The voxel cap lives in **both** `src/parser.py` (`voxel_budget_for`) and
  `ui/src/utils/expand-ops.js` — keep the two implementations identical. Without it a single
  malformed AI op (`fill 0 0 0 299 299 299` = 27M cells) froze the app with no error.
- `.gitignore` now excludes credentials (`token.txt`, `cookies.json`), bytecode,
  `build/`, and `.claude/backups/`. Never re-add them to the index.
