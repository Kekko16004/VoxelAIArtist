# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VoxelAIArtist is a desktop voxel modeling app with integrated AI generation. A PyQt6 window (`main.py`) embeds a Chromium `QWebEngineView` that loads `ui/index.html` — a Three.js viewer/editor. A background Python HTTP server (started in `main.py`) serves the local files and proxies `/api/generate` to an AI backend. The UI is in Italian; keep new user-facing strings in Italian.

## Run & build

```bash
python main.py                 # launch desktop app (needs PyQt6 + PyQt6-WebEngine)
pyinstaller --clean VoxelAI.spec   # build dist/VoxelAIArtist.exe (or run build.bat on Windows)
```

- If no Qt binding is importable, `main.py` falls back to opening `ui/index.html` in the system browser.
- Qt binding is auto-detected in priority order PyQt6 → PySide6 → PyQt5 (`GUI_LIBRARY`).
- `PORT = 0` lets the OS pick a free port; the main thread spin-waits until the server thread sets it.

## Verifying changes

There is no test suite. Verify by:
- Python: `python -c "import sys; sys.path.insert(0,'src'); from parser import expand_ops, extract_and_parse_json"` and exercise with a sample compact model (see the pattern in `.claude/settings.local.json` allow-list).
- JS: extract the `<script>` bodies from `ui/index.html` and run `node --check`. Three.js / OrbitControls / TransformControls / GLTFExporter are loaded from CDN (`r128` / `0.128.0`), so a local parse is parse-only — it won't resolve `THREE`.

## Architecture

### Backend (`main.py` + `src/`)
- `main.py` — `VoxelAIRequestHandler` (subclass of `SimpleHTTPRequestHandler`) with CORS headers. Routes: `GET /api/settings`, `GET /api/settings/open-folder`, `DELETE /api/settings/cookies`, `POST /api/settings/cookies`, `POST /api/generate`. `translate_path` rebases all file requests onto `BASE_DIR` so it works both from source and from a PyInstaller bundle.
- `MainWindow._load_html()` rewrites `fetch('/api/generate'` to the absolute `http://127.0.0.1:{PORT}` URL and injects `window.__API_BASE__` / `window.__IS_DESKTOP__` before serving HTML into the web view.
- **AI generation** (`POST /api/generate`): loads a prompt template from `assets/prompts/`, substitutes the user request, and calls the `gemini` package's `Gemini` client (a reverse-engineered Google Gemini web client, authenticated via browser cookies — **not** the official API). Two modes:
  - `generate` → `prompt.txt`, replaces `[INSERISCI QUI IL MODELLO DESIDERATO]`.
  - `modify` → `prompt-edit.txt`, injects the current model JSON + the edit request.
  The AI answer is run through `extract_and_parse_json()` before being returned as JSON.
- `src/settings.py` — cookies and settings live in `%APPDATA%/VoxelAIArtist/` (`cookies.json`, `settings.json`), **not** in the repo. On first launch with no cookies, the settings page (`ui/settings.html`) opens so the user can paste them.
- `src/parser.py` — contains a legacy standalone `start_local_server()` / `__main__` block; the live app path is `main.py`, which only uses `expand_ops` and `extract_and_parse_json` from this module. The rest (OBJ export, standalone server) is legacy/CLI. NOTE (2026-07-19): the top-level `import perplexity` was removed — it's now a lazy import inside `start_local_server()` only, so `perplexity-api` is no longer a runtime dependency (Gemini is the live generator). The old `scratch/test_perplexity.py` (contained a hardcoded session token) was deleted.

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
- This repo is **not** a git repository (as of writing).
