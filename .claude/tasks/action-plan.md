# Piano d'azione dettagliato

Creato: 2026-07-19 18:44 — in attesa di conferma utente.

## Ordine consigliato di esecuzione
1. **T3 (venv + build)** — indipendente, sblocca la distribuzione. Veloce.
2. **T6 infrastruttura temi** + **T4 restyling** — insieme, per non rifare il CSS.
3. **T1 gerarchia oggetti** — feature portante, base per il resto dell'editing.
4. **T2 estrusione** — costruita sopra T1 (agisce sull'oggetto attivo).
5. **T7 idee** — in parallelo, a basso costo.
6. **T5 porting Python** — solo dopo studio di fattibilità e OK utente (grande impatto).

---

## T1 — Gerarchia oggetti
**Approccio proposto**
- Modello dati: passare da un singolo `currentModelData.voxels` a una lista di oggetti `{ id, name, voxels/voxelMap, transform:{pos,rot,scale}, visible }`. Mantenere retro-compatibilità: un JSON flat legacy = un oggetto.
- Scena: ogni oggetto = proprio `Group` con `InstancedMesh` per colore, sotto `modelPivot`.
- Object mode: click seleziona oggetto (outline/bounding box, vedi screenshot utente con box magenta/verde). `Tab` entra in edit mode sull'oggetto selezionato (gli strumenti place/remove agiscono solo su quello).
- Operazioni: sposta (gizmo translate esistente `globalTransformControls`), elimina oggetto, duplica, **unisci (merge)** più oggetti in uno, rinomina.
- Su "Nuovo/fai da zero": dialog "Tenere l'oggetto attuale?" → se sì, il nuovo nasce come oggetto separato.
- Import: aggiunge un oggetto senza rimuovere gli altri.
- UI: pannello "Oggetti" (outliner) in sidebar + comandi barra superiore (menu Qt in `main.py`) + shortcut.
**File**: `ui/index.html` (scena, outliner, edit/object mode); `main.py` (voci menu); `src/parser.py` (serializzazione multi-oggetto se il formato salvato cambia).
**Rischi**: refactor ampio del source of truth (`voxelMap`). Fare backup di `index.html`. Coordinare Backend↔3D Engine.

## T2 — Estrusione (tasto E)
**Approccio proposto**
- In edit mode, con un voxel/faccia sotto il cursore, tenendo **E** si entra in "modalità estrusione": il movimento del mouse lungo un asse ortogonale genera una preview di riempimento (ghost) tra il punto iniziale e quello corrente.
- Ri-click/ri-premuta E cicla l'asse di estrusione tra i due ortogonali.
- Conferma (click) applica come singola azione undo. Esc/misclick annulla e torna allo strumento precedente (nessuna modifica).
- Integrare con `pushUndo` esistente (una sola voce nello stack).
**File**: `ui/index.html` (gestione tasti in `keydown`, preview, logica estrusione, undo).
**Rischi**: interazione con OrbitControls (bloccare la rotazione mentre E è premuto).

## T3 — venv + build leggera
**Approccio proposto**
- Creare `requirements.txt` pinnato (PyQt6, PyQt6-WebEngine, gemini; valutare rimozione di `perplexity` legacy da `parser.py`).
- Script setup venv documentato in `.claude/reference/setup.md`.
- Build: aggiungere `excludes` alla `.spec` (moduli Qt/tkinter/test non usati), valutare onedir vs onefile, UPX già attivo. Misurare peso prima/dopo.
**File**: `requirements.txt` (nuovo), `VoxelAI.spec`, `build.bat`, doc.
**Rischi**: escludere moduli Qt sbagliati rompe il WebEngine → QA su exe.

## T4 — Restyling "voxel"
**Approccio proposto**
- Ridurre `border-radius` (attualmente fino a 24px) verso 0-4px per look preciso; bordi netti; eventuale font monospace/pixel per titoli.
- Uniformare spacing, allineamenti, stati hover/active di ogni sezione (Genera/Vista/Disegna/Rig).
- Mantenere leggibilità e contrasto.
**File**: `ui/index.html` CSS.
**Dipendenza**: farlo dopo aver introdotto le vars-tema di T6.

## T5 — Porting Python (studio prima)
**Deliverable prima del codice**: `.claude/tasks/t5-feasibility.md` con confronto opzioni (moderngl, PyOpenGL, VTK, Panda3D, pygfx), stima effort, cosa si perde (l'intero editor JS andrebbe riscritto), e raccomandazione. NIENTE codice finché l'utente non decide.
**Adattività finestra**: fixabile SUBITO nell'attuale stack (bug `resizeCanvas`/`ResizeObserver`) senza aspettare il porting — spostabile in un mini-task dentro T4/T6.

## T6 — Impostazioni avanzate
**Approccio proposto**
- Tema: set di CSS vars per `light`/`dark`, toggle via `data-theme` sul root, persistito in `settings.json` (via endpoint esistente `/api/settings` — estendere `main.py`/`settings.py` per salvare preferenze UI).
- Shortcut: mappa configurabile azione→tasto, editor di rebinding, persistita. Refactor del gestore `keydown` per leggere dalla mappa invece che tasti hardcoded.
- Pannello impostazioni esteso (`ui/settings.html` o sezione in-app): tema, shortcut, opzioni varie (gap voxel, dimensione griglia default, ecc.).
**File**: `ui/index.html`, `ui/settings.html`, `main.py`, `src/settings.py`.

## T7 — 10 idee
Prodotte come lista ragionata (vedi risposta orchestratore / `.claude/tasks/ideas.md`).
