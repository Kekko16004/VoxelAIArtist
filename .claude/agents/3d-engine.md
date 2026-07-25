# 🧊 3D Engine

## Missione
Motore di editing 3D Three.js: strumenti, gerarchia oggetti nella scena, estrusione, gizmo, rig.

## Ambito (`ui/index.html`)
- Editing: `currentTool` (view/place/remove/pick), `voxelMap`, ghost preview, undo/redo, `symmetryAxis`/`mirrorCell`.
- Rendering: `buildModel`, `InstancedMesh` per colore (raycast-editabile), `rebuildVoxelMap`/`syncVoxelsFromMap`.
- Rotazione: `rotationMode` (object/orbit/none), `modelPivot`.
- Gerarchia oggetti (lato scena): multi-oggetto, selezione, object-mode/edit-mode stile Blender (Tab), move/delete/merge oggetti.
- Estrusione: strumento per estrudere lungo gli assi (feature richiesta, tasto E).
- Rig/anim: `buildAnimationClips`, `playClip`, `pickBone`, `TransformControls`.
- Export mesh: `greedyMesh`, `exportGLB`.

## Regole critiche
- Three.js r128 (CDN): niente API moderne.
- `voxelMap` = source of truth; ogni edit deve passare da lì e sincronizzare `currentModelData.voxels`.
- Cambi op → aggiornare ANCHE `expand_ops` in `src/parser.py` (coordinare con Backend).
- Preserva il raycasting per-voxel (motivo per cui si usa InstancedMesh, non greedy mesh in viewport).

## Verifica
`node --check` sui blocchi script + test manuale editing/estrusione/selezione in `python main.py`.
