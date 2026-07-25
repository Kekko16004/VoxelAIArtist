# .claude/ — Centro di controllo & handoff sessione

> **Nuova sessione? Leggi questo file per primo, poi `CLAUDE.md` (root).**
> Ti dice cosa è il progetto, com'è strutturato, a che punto è il lavoro, e cosa fare dopo — senza rileggere tutto il codice.

Ultimo aggiornamento: **2026-07-19 18:44**

---

## 1. Cos'è il progetto (in 3 righe)
VoxelAIArtist: app desktop di modellazione 3D voxel con generazione AI integrata. Shell **PyQt6** (`main.py`) che embedda un `QWebEngineView` con il viewer/editor **Three.js** (`ui/index.html`). Un server HTTP locale serve i file e fa da proxy AI (client web Gemini via cookie). UI in italiano.

## 2. Come orientarsi (leggi in quest'ordine)
1. `.claude/README.md` (questo) — stato & handoff.
2. `CLAUDE.md` (root) — architettura.
3. `.claude/reference/file-map.md` — **dove toccare cosa** (evita di rileggere i sorgenti).
4. `.claude/reference/conventions.md` — regole tassative (op paritari, r128, segreti...).
5. `.claude/tasks/board.md` + `action-plan.md` — cosa fare e in che ordine.

## 3. Il team (`.claude/agents/`)
Orchestratore (sessione principale) + 6 ruoli riutilizzabili: 📖 Documenter, ⚙️ Backend/Core, 🎨 Frontend/UX, 🧊 3D Engine, 📦 Build/Packaging, ✅ QA/Verifier. Per delegare: incolla il brief del ruolo + il task dalla board a un subagent.

## 4. Stato attuale del lavoro
- ✅ Scaffolding orchestrazione `.claude/` completato.
- ✅ `CLAUDE.md` e memoria aggiornati (progetto ora è desktop PyQt6, con tab `rig`).
- ⏳ **In attesa di conferma utente sul piano d'azione** per le 7 task, poi si esegue.

## 5. Prossimi passi (ordine consigliato)
1. **T3** venv + build leggera (indipendente, veloce)
2. **T6 temi** + **T4 restyling** (condividono il CSS)
3. **T1** gerarchia oggetti (feature portante)
4. **T2** estrusione tasto E (sopra T1)
5. **T7** 10 idee (parallelo)
6. **T5** porting Python — solo dopo studio fattibilità + OK utente
Dettagli in `.claude/tasks/action-plan.md`.

## 6. Regole che NON si violano mai
- Cambi op → aggiornare **sia** `src/parser.py` (`expand_ops`) **sia** `ui/index.html` (`expandOps`).
- Three.js **r128** (CDN): niente API moderne.
- UI in **italiano**.
- `token.txt` / `cookies.json` = segreti: mai committare/stampare.
- Non è un repo git: **backup manuale** prima di refactor grossi su `ui/index.html`.

## 7. Convenzioni di tracciamento
- Progressi giornalieri → `.claude/logs/AAAA-MM-GG.md`.
- Feature completate → `.claude/CHANGELOG.md` (una riga, con data).
- Stato task → `.claude/tasks/board.md`.
- Quando finisci una sessione: aggiorna la sezione 4-5 di questo README.
