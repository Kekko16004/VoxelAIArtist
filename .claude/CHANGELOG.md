# Changelog — VoxelAIArtist

Una riga per ogni feature/fix completato. Aggiornato dal Documenter.

## 2026-07-19
- T2: estrusione facce con tasto E. Punta una faccia in Modalità Modifica, E arma l'estrusione della faccia contigua (flood-fill complanare), il mouse guida i passi lungo l'asse; E ricicla asse X/Y/Z, preview ghost + HUD. Commit con click (1 voce undo), annulla con Esc/click destro. Estrude sull'oggetto attivo (integrato con T1). Limiti: solo celle vuote, safety cap. Da testare a runtime.
- T1: gerarchia multi-oggetto (stile Blender). Data-model `sceneObjects` + outliner nel tab Vista (nuovo/duplica/rinomina/unisci/elimina/visibilità), modalità Oggetto/Modifica con Tab, selezione con bounding box, rendering di tutti gli oggetti, import additivo, retro-compat load/save (legacy + `{objects:[]}`). Limiti noti documentati (transform "cotto" in coord intere; undo non copre le op oggetto). Da testare a runtime nel browser.
- T3: venv riproducibile — `requirements.txt` + `requirements-build.txt` pinnati, `.claude/reference/setup.md`; `VoxelAI.spec` alleggerita (excludes tkinter/stdlib + PySide6/PyQt5 fallback). Spec compila OK. Da testare: build .exe reale.
- T4: restyling "voxel" — design token per radius (`--radius-*`), colori spostati su CSS vars, classi `.field`, spigoli più netti; media query per adattività finestra (4 breakpoint) → fix layout su finestre piccole.
- T6 (parziale): tema chiaro/scuro commutabile (`data-theme` + toggle sun/moon, persistito in localStorage con fallback `prefers-color-scheme`); fondazione `KEYMAP` per rebinding shortcut futuro. Resta: pannello rebinding UI + persistenza backend.
- T7: prodotte 10 idee per rendere il programma professionale (`.claude/tasks/ideas.md`).
- T5: studio di fattibilità porting Python completato (`.claude/tasks/t5-feasibility.md`) — porting completo sconsigliato. **Decisione utente: nessun porting, solo alleggerire la build.**
- Setup orchestrazione team in `.claude/` (agenti, reference, task board, log, README di handoff).
- Creato `CLAUDE.md` con architettura aggiornata (app PyQt6 desktop, non più solo server browser).
