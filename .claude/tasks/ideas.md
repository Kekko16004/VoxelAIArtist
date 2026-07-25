# T7 — 10 idee per rendere VoxelAIArtist professionale e serio

Prodotto: 2026-07-19. Ognuna con: cosa, perché conta, dove si innesta, effort stimato.

## 1. Sistema a layer + palette avanzata
Layer nascondibili/bloccabili (come Photoshop) e una palette editabile con salvataggio/caricamento di set di colori (import da `.hex`, `.gpl`, immagine). **Perché**: workflow serio su modelli complessi. **Dove**: `ui/index.html` (voxelMap per-layer, UI palette), `src/parser.py` (formato con layer). **Effort**: medio-alto.

## 2. Export/import multi-formato standard
Oltre a OBJ/GLB: `.vox` (MagicaVoxel, lo standard de-facto del mondo voxel), `.ply`, PNG spritesheet/render, e import da `.vox`/immagine (image-to-voxel). **Perché**: interoperabilità = credibilità professionale; MagicaVoxel è il riferimento. **Dove**: `src/parser.py` (parser/writer `.vox`), `ui/index.html` (UI export). **Effort**: medio (il formato `.vox` è documentato).

## 3. Editor di materiali: emissione, metallico, trasparenza, texture
Ogni colore/materiale con proprietà PBR (emissive, roughness, metalness, alpha) esportabili in GLB. Anteprima con luci. **Perché**: porta i modelli da "cubi colorati" ad asset usabili in engine (Unity/Unreal/Godot). **Dove**: `ui/index.html` (materiali Three.js, GLTFExporter già presente). **Effort**: medio.

## 4. Onboarding, tutorial e libreria template
Primo avvio con tour guidato, scene di esempio caricabili (già ci sono in `examples/`), e template di partenza (personaggio, arma, edificio). **Perché**: abbassa la barriera d'ingresso, requisito per "serio per tutti". **Dove**: `ui/index.html`, `examples/`. **Effort**: basso-medio.

## 5. Prompt AI strutturato + cronologia generazioni
UI per la generazione con campi guidati (soggetto, stile, dimensione, palette), cronologia dei prompt/risultati con possibilità di ripristinare, e "varianti" (rigenera N versioni). **Perché**: rende l'AI un vero co-pilota riproducibile, non un tiro al buio. **Dove**: `main.py` (endpoint), `ui/index.html`, `assets/prompts/`. **Effort**: medio.

## 6. Griglia/scultura non distruttiva con simmetria radiale e mirror multipli
Estendere la simmetria attuale (x/y/z) con simmetria radiale (4/8 vie) e mirror combinati, più snapping e misure. **Perché**: modellazione precisa e veloce = standard degli editor pro. **Dove**: `ui/index.html` (motore edit/simmetria). **Effort**: medio.

## 7. Camera pro: viste ortografiche, preset e turntable render
Viste front/top/side/iso con un tasto, camera ortografica per pixel-precision, e export di un turntable video/GIF del modello. **Perché**: presentazione e workflow tecnico. **Dove**: `ui/index.html` (camera, rotazione già presente). **Effort**: basso-medio (il turntable riusa `rotationMode`).

## 8. Performance su modelli grandi: chunking + LOD + occlusion
Suddividere la scena in chunk, rebuild incrementale (non ricostruire tutto ad ogni edit), e culling più aggressivo. **Perché**: oggi `buildModel` ricostruisce l'intero InstancedMesh; su modelli grandi diventa lento. Scalabilità = serietà. **Dove**: `ui/index.html` (`buildModel`, voxelMap). **Effort**: alto.

## 9. Progetti salvabili nativi + autosave + versioning
Formato progetto `.voxai` (zip con modello multi-oggetto, palette, layer, camera, metadata), autosave periodico e cronologia versioni locale. **Perché**: perdere il lavoro è il killer #1 della fiducia; un formato progetto è ciò che distingue un tool serio da un giocattolo. **Dove**: `src/` (I/O progetto), `main.py` (dialog file già presente), `ui/index.html`. **Effort**: medio.

## 10. Estendibilità: plugin/script + CLI headless
API JS per script utente (generatori procedurali, filtri) e una CLI headless (`main.py --headless input.voxai --export glb`) per pipeline/batch. **Perché**: gli strumenti pro vivono grazie alla community e all'automazione. **Dove**: `main.py` (CLI, già c'è un `__main__` in parser.py da consolidare), `ui/index.html` (sandbox script). **Effort**: alto.

---

## Quick wins consigliati (alto valore / basso costo)
- **#2 export `.vox`** — sblocca l'intero ecosistema voxel.
- **#4 template/onboarding** — grande impatto percepito, poco codice.
- **#7 viste camera preset** — riusa la rotazione esistente.
- **#9 formato progetto + autosave** — protegge il lavoro dell'utente (fondamentale).
