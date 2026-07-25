# Setup ambiente — VoxelAIArtist

Come ricreare da zero un ambiente riproducibile (venv) su una macchina nuova, lanciare l'app e buildare l'exe. Comandi per **Windows / PowerShell**.

## Requisiti

- **Python 3.10.x** (consigliato 3.10.11). I `.pyc` del progetto sono compilati per cpython-310; usare una minor diversa (3.11/3.12) puo' funzionare ma non e' l'ambiente verificato.
  - Verifica: `python --version`
- Connessione internet al primo `pip install`.
- Il viewer 3D (`ui/index.html`) carica Three.js r128 da CDN: serve internet anche a runtime per la prima render.

## 1. Creare e attivare il venv

```powershell
cd "percorso\a\VoxelAIArtist"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

Se PowerShell blocca l'attivazione (execution policy):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Aggiorna pip:

```powershell
python -m pip install --upgrade pip
```

## 2. Installare le dipendenze runtime

```powershell
pip install -r requirements.txt
```

Nota sui nomi dei pacchetti (facile sbagliare):

- il modulo `gemini` importato in `main.py` viene da **`python-gemini-api`** (2.4.12), NON da `gemini-api` (che installa un modulo diverso `gemini_api`). Il vecchio `build.bat` installava per errore `gemini-api`.
- il modulo `perplexity` importato in `src/parser.py` viene da **`perplexity-api`** (0.2.0).

Verifica che gli import chiave funzionino:

```powershell
python -c "from gemini import Gemini; print('gemini OK')"
python -c "import sys; sys.path.insert(0,'src'); from parser import expand_ops, extract_and_parse_json; print('parser OK')"
```

## 3. Lanciare l'app

```powershell
python main.py
```

- Serve `PyQt6` + `PyQt6-WebEngine`. Se nessun binding Qt e' importabile, `main.py` apre `ui/index.html` nel browser di sistema come fallback.
- Al primo avvio senza cookie salvati si apre la pagina impostazioni (`ui/settings.html`) per incollare i cookie di sessione Gemini.
- Cookie e settings vivono in `%APPDATA%\VoxelAIArtist\` (`cookies.json`, `settings.json`), **non** nel repo. Non committarli.
- Le console log JS del WebView compaiono in stdout come `[JS Console] ...`.

## 4. Buildare l'exe (PyInstaller)

```powershell
pip install -r requirements-build.txt
pyinstaller --clean VoxelAI.spec
```

Oppure `build.bat` (Windows). Output: `dist\VoxelAIArtist.exe` (onefile, `console=False`, UPX attivo).

La `.spec` include una lista `excludes` per snellire il bundle (vedi commenti nel file). QtWebEngine e' il grosso del peso e le sue dipendenze (QtQuick, QtQml, QtWebChannel, QtPositioning) NON sono escludibili.

Dopo la build, testare l'exe **standalone** (da un'altra cartella / macchina senza Python) per confermare che gli `excludes` non abbiano rotto il WebView.

## Snellire le dipendenze (nota per manutenzione)

`perplexity-api` e' oggi obbligatorio SOLO perche' `src/parser.py` fa `import perplexity` a livello di modulo (riga 3), e `main.py` importa `parser` per `extract_and_parse_json`. Il path live non usa mai il client Perplexity.

Rendendo quell'import **lazy** (spostandolo dentro le funzioni legacy che lo usano, ~riga 511) si potra' rimuovere `perplexity-api` dai requirements. Questa modifica a `parser.py` NON e' parte del task di build/packaging: va coordinata con l'agente responsabile del parser.
