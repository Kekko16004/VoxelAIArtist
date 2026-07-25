# Team di agenti — VoxelAIArtist

L'orchestratore (sessione principale) delega ai seguenti ruoli. Ogni file `*.md` qui è un **brief riutilizzabile**: quando lanci un subagent, incolla il contenuto del ruolo pertinente + il task specifico dalla `task board` (`.claude/tasks/board.md`).

## Ruoli

| Ruolo | File | Ambito |
|-------|------|--------|
| 📖 Documenter | `documenter.md` | Mantiene CLAUDE.md, `.claude/reference/`, changelog. Aggiorna dopo ogni feature. |
| ⚙️ Backend/Core | `backend-core.md` | `main.py`, `src/parser.py`, server, AI proxy, formato dati, gerarchia oggetti (dati). |
| 🎨 Frontend/UX | `frontend-ux.md` | `ui/index.html` CSS/layout, tema, impostazioni, estetica "voxel", responsività. |
| 🧊 3D Engine | `3d-engine.md` | Motore editing Three.js: tool, estrusione, gerarchia oggetti (scena), gizmo. |
| 📦 Build/Packaging | `build-packaging.md` | venv, requirements, PyInstaller, alleggerimento build. |
| ✅ QA/Verifier | `qa-verifier.md` | Verifica ogni modifica (import Python, node --check, avvio app), regressioni. |

## Regole di collaborazione
1. Prima di iniziare, l'agente legge: `CLAUDE.md`, `.claude/reference/file-map.md`, `.claude/reference/conventions.md`, e il suo task in `board.md`.
2. Modifiche che toccano gli **op** richiedono coordinamento Backend ↔ 3D Engine (entrambe le implementazioni `expand_ops`/`expandOps`).
3. Ogni agente registra l'esito nel `.claude/logs/` e aggiorna lo stato del task in `board.md`.
4. QA gira dopo ogni task prima di marcarlo `done`.
5. Il Documenter aggiorna `CLAUDE.md` + `.claude/CHANGELOG.md` quando una feature è completata.
