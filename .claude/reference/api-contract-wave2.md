# Contratto API backend (Wave 2) — per agenti frontend

Route relative a `window.__API_BASE__`. Tutte JSON. Errori: `{"error":"..."}` con status 400/404/500/501.

## Preferenze (tema, keymap, locale, ecc.)
- `GET /api/prefs` → `{ "settings": {...prefs pubbliche...} }` (mai cookie/segreti)
- `POST /api/prefs` body `{ "settings": {k:v,...} }` (o dict nudo) → `{ "settings": {...merged...} }`. MERGE, non overwrite. Chiavi sensibili (cookie/token/secret) scartate.

## Progetto nativo .voxai
- `POST /api/project/save` body `{ "path"?, "data" }`
  - senza path → QFileDialog salva (`*.voxai`) → `{ "path" }` o `{ "cancelled": true }`
  - con path → scrive diretto → `{ "path" }`. `.voxai` aggiunto se assente.
  - File = `{ "format":"voxai", "version":1, "savedAt":iso, "data":{...} }`
  - `501` se GUI assente e serve dialog.
- `GET /api/project/open` → dialog (voxai/json/vox/schem):
  - json/voxai: `{ path, ext, encoding:"json", content:<obj> }`
  - vox/schem/bin: `{ path, ext, encoding:"base64", content:"<b64>" }`
  - `{ cancelled:true }` o `501`.

## Autosave + versioning (`%APPDATA%/VoxelAIArtist/autosaves/`)
- `POST /api/autosave` body `{ data, projectId? }` → `{ path, name }`. File `autosave_<projectId>_<epochMs>.voxai.json`, rotazione ultimi 20/progetto.
- `GET /api/autosave/list` → `{ autosaves:[{name,projectId,epoch,savedAt,size}] }` desc.
- `GET /api/autosave/get?name=<name>` → `{ name, content:<wrapper voxai> }` (404 se nome invalido).
- `GET /api/autosave/open-folder` → `{ ok:true, folder }`

## Progetti recenti (settings.json chiave `recentProjects`)
- `GET /api/recent` → `{ recent:[{path,name,lastOpened,thumbnail?}] }`
- `POST /api/recent` body `{ entry:{path,name?,thumbnail?} }` (o nudo) → `{ recent:[...] }`. Dedup per path, max 15, desc.
- `DELETE /api/recent?path=<path>` → `{ recent:[...] }`

## Note
- Parsing binario .vox/.schem NON nel backend: `/api/project/open` ritorna base64, il decode è frontend.
- `projectId` a discrezione frontend (default "default").
- Save con path esplicito = nessuna sandbox (validare lato frontend); via sicura = dialog GUI.
