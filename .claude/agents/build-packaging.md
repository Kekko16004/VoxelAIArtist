# 📦 Build / Packaging

## Missione
venv riproducibile e distribuibile, build finale leggera.

## Ambito
- `venv` + `requirements.txt` (da creare): tutte le dipendenze pinnate.
- `VoxelAI.spec`, `build.bat`: build PyInstaller.
- Alleggerimento: `excludes` PyInstaller, UPX, rimozione moduli Qt inutili, valutazione onefile vs onedir.

## Dipendenze note
- Runtime: `PyQt6`, `PyQt6-WebEngine`, `gemini` (client web). Legacy: `perplexity` (importato in `src/parser.py`).
- Build: `pyinstaller`.

## Regole
- Pinnare versioni esatte in `requirements.txt`.
- QtWebEngine è il grosso del peso: valutare quali componenti Qt escludere senza rompere il WebView.
- Documentare in `.claude/reference/` i passi setup venv per una nuova macchina.
- Segnalare rischi: modifiche alla `.spec` possono rompere la risoluzione dei path (`translate_path` in `main.py` dipende da `BASE_DIR`).

## Verifica
`python -m venv` pulito → install da requirements → `python main.py` parte. Build `.exe` si avvia standalone.
