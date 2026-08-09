import sys
import os
import re
import json
import time
import base64
import threading
import socketserver
import http.server
import subprocess
import webbrowser
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE_DIR, "src"))
import settings as app_settings
import pack as pack_engine

# ===== MODALITA' DI AVVIO =====================================================
# "web" -> DEFAULT: nessuna finestra Qt. Si avvia SOLO il server locale e la UI
#          si apre nel browser di sistema. E' il default perche' la finestra
#          QWebEngineView lampeggia: Chromium composita su una surface
#          OpenGL/ANGLE che Qt ricrea al primo passaggio in modalita' GPU (il
#          "sparisce e riappare"). Nel browser quel compositing e' gestito dal
#          browser stesso, quindi il flicker non esiste. Zero Chromium embedded.
# "py"  -> finestra desktop Qt (QWebEngineView): dialog nativi Apri/Salva e
#          selettore cartella funzionanti (/api/project/*, /api/settings/choose-dir)
#          e window.__IS_DESKTOP__ iniettato nella pagina.
#
# Cambia il valore qui sotto a mano per scegliere. Override, in ordine di
# priorita': argomento CLI (--web / --py / --mode=web) > variabile d'ambiente
# VOXELAI_MODE > questa costante.
APP_MODE = "web"   # <- scegli qui: "web" oppure "py"

VALID_APP_MODES = ("web", "py")

# Alias tollerati: se qualcuno scrive "qt" o "browser" e' ovvio cosa intende, e
# far fallire l'avvio per un sinonimo sarebbe solo fastidioso.
_APP_MODE_ALIASES = {
    "qt": "py", "pyqt": "py", "pyqt6": "py", "desktop": "py", "window": "py",
    "browser": "web", "http": "web", "server": "web", "headless": "web",
}


def _resolve_app_mode(default_mode="web", argv=None, env=None):
    """Risolve la modalita' di avvio: argomento CLI > VOXELAI_MODE > costante.

    Un valore sconosciuto non deve impedire l'avvio: stampiamo un avviso e
    ripieghiamo su "py" (la modalita' storica, con finestra e dialog nativi).
    argv/env sono parametri per poter testare la funzione senza toccare il
    processo reale.
    """
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    env = os.environ if env is None else env

    raw = str(default_mode)
    source = "costante APP_MODE"

    env_val = (env.get("VOXELAI_MODE") or "").strip()
    if env_val:
        raw, source = env_val, "variabile VOXELAI_MODE"

    cli_val = None
    for i, arg in enumerate(argv):
        a = str(arg).strip().lower()
        if a in ("--web", "-web", "web"):
            cli_val = "web"
        elif a in ("--py", "-py", "py"):
            cli_val = "py"
        elif a.startswith("--mode="):
            cli_val = a.split("=", 1)[1]
        elif a == "--mode" and i + 1 < len(argv):
            cli_val = str(argv[i + 1])
    if cli_val:
        raw, source = cli_val, "argomento CLI"

    mode = str(raw).strip().lower()
    mode = _APP_MODE_ALIASES.get(mode, mode)
    if mode not in VALID_APP_MODES:
        print("[avvio] modalita' '%s' non riconosciuta (%s): uso 'py'. "
              "Valori validi: web, py." % (raw, source))
        mode = "py"
    return mode


APP_MODE = _resolve_app_mode(APP_MODE)

GUI_AVAILABLE = False
GUI_LIBRARY = None

if APP_MODE == "py":
    # In modalita' "web" i binding Qt non vengono nemmeno importati: importare
    # QtWebEngine carica le DLL di Chromium/ANGLE (centinaia di ms e un bel po'
    # di RAM) per una finestra che non apriremo. Cosi' la modalita' web resta
    # anche l'unica avviabile su una macchina senza Qt, e main.py rimane
    # importabile nei test headless.
    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = "--no-sandbox"
    try:
        from PyQt6.QtWidgets import QApplication, QMainWindow, QVBoxLayout, QWidget, QFileDialog, QMenuBar, QMenu
        from PyQt6.QtWebEngineWidgets import QWebEngineView
        from PyQt6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
        from PyQt6.QtCore import QUrl, QTimer, Qt
        from PyQt6.QtGui import QKeySequence, QAction, QColor, QPalette
        GUI_AVAILABLE = True
        GUI_LIBRARY = 'PyQt6'
    except ImportError:
        try:
            from PySide6.QtWidgets import QApplication, QMainWindow, QVBoxLayout, QWidget, QFileDialog, QMenuBar, QMenu
            from PySide6.QtWebEngineWidgets import QWebEngineView
            from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
            from PySide6.QtCore import QUrl, QTimer, Qt
            from PySide6.QtGui import QKeySequence, QAction, QColor, QPalette
            GUI_AVAILABLE = True
            GUI_LIBRARY = 'PySide6'
        except ImportError:
            try:
                from PyQt5.QtWidgets import QApplication, QMainWindow, QVBoxLayout, QWidget, QFileDialog, QAction, QMenuBar, QMenu
                from PyQt5.QtWebEngineWidgets import QWebEngineView, QWebEnginePage, QWebEngineSettings
                from PyQt5.QtCore import QUrl, QTimer, Qt
                from PyQt5.QtGui import QKeySequence, QColor, QPalette
                GUI_AVAILABLE = True
                GUI_LIBRARY = 'PyQt5'
            except ImportError:
                pass

if GUI_AVAILABLE:
    class WebEnginePage(QWebEnginePage):
        def javaScriptConsoleMessage(self, level, message, lineNumber, sourceID):
            print(f"[JS Console] Riga {lineNumber}: {message}")
else:
    # Senza binding Qt (modalita' "web", oppure Qt non installato) la classe
    # MainWindow (definita a livello di modulo) non avrebbe una classe base
    # valida e il modulo esploderebbe con NameError ancora prima di arrivare
    # all'avvio in modalita' web, rendendolo codice morto. Questi alias tengono
    # il modulo IMPORTABILE: MainWindow diventa una classe inerte che non viene
    # mai istanziata (il `__main__` la salta quando GUI_AVAILABLE e' False).
    # Serve anche a poter importare main.py nei test headless.
    QMainWindow = object
    WebEnginePage = object

# Il client Gemini non si importa qui: lo importa `src/aiclient.py`, che e' l'unico
# punto che lo istanzia, e lo fa in modo PIGRO cosi' il modulo resta importabile
# (test headless compresi) anche senza il pacchetto installato.

PORT = 0

# Riferimento globale alla finestra principale (impostato in MainWindow.__init__).
# Serve per marshalare le operazioni con QFileDialog dal thread HTTP al thread GUI.
MAIN_WINDOW = None


def _run_on_gui(fn, timeout=300):
    """Esegue `fn(main_window)` sul thread GUI Qt e ne ritorna il risultato.

    Il server HTTP gira su un thread separato; toccare widget Qt (es. QFileDialog)
    da lì è vietato. Usiamo QTimer.singleShot(0, ...) per accodare la callable
    sull'event loop del thread GUI e un threading.Event per bloccare il thread
    HTTP finché il dialog non si chiude. Il valore/eccezione vengono riportati
    indietro tramite un box condiviso. Solleva RuntimeError se la GUI non è
    disponibile (es. modalità browser fallback senza Qt).
    """
    if not GUI_AVAILABLE or MAIN_WINDOW is None:
        raise RuntimeError("GUI non disponibile: dialog file non supportati in questa modalita")
    box = {}
    done = threading.Event()

    def _invoke():
        try:
            box["result"] = fn(MAIN_WINDOW)
        except Exception as e:  # noqa: BLE001 - riportiamo qualunque errore al chiamante
            box["error"] = e
        finally:
            done.set()

    QTimer.singleShot(0, _invoke)
    if not done.wait(timeout):
        raise RuntimeError("timeout in attesa del dialog GUI")
    if "error" in box:
        raise box["error"]
    return box.get("result")


def _write_voxai(path, data):
    """Scrive un progetto nel formato nativo .voxai (JSON wrappato). Ritorna il path.

    Se il path non ha estensione .voxai la aggiunge. Il wrapper e':
    { format:"voxai", version:1, savedAt:iso, data:{...} }.
    """
    if not path.lower().endswith(".voxai"):
        path = path + ".voxai"
    payload = {
        "format": "voxai",
        "version": 1,
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        "data": data,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


def _apply_dark_palette(app):
    """Applica una palette scura COMPLETA a QApplication + stile Fusion.

    Perche': i dialog NATIVI di Qt (QColorDialog aperto da <input type="color">,
    QMessageBox di confirm()/alert(), QFileDialog) NON sono HTML: non leggono il
    CSS della pagina, ma la palette di QApplication. Sul tema scuro di Windows
    ereditano un fondo scuro ma tengono testo/campi con i colori chiari di
    default -> testo nero su fondo nero, illeggibile (vedi screenshot "Select
    Color"). Definendo TUTTI i ruoli colore (non solo Window, come nel tentativo
    precedente che aveva rotto i dialog) i popup nativi diventano coerenti e
    leggibili. Lo stile "Fusion" rispetta la palette meglio dello stile nativo.
    Best-effort: se QPalette non e' disponibile si prosegue senza.
    """
    if not GUI_AVAILABLE:
        return
    try:
        try:
            app.setStyle("Fusion")
        except Exception:
            pass
        Role = getattr(QPalette, "ColorRole", QPalette)
        Group = getattr(QPalette, "ColorGroup", QPalette)
        pal = QPalette()

        def _set(role_name, color):
            role = getattr(Role, role_name, None)
            if role is not None:
                pal.setColor(role, QColor(color))

        # Superfici e testo
        _set("Window", "#141220")
        _set("WindowText", "#f3f4f6")
        _set("Base", "#1c1930")
        _set("AlternateBase", "#242038")
        _set("Text", "#f3f4f6")
        _set("Button", "#242038")
        _set("ButtonText", "#f3f4f6")
        _set("ToolTipBase", "#1c1930")
        _set("ToolTipText", "#f3f4f6")
        _set("PlaceholderText", "#9ca3af")
        _set("BrightText", "#ffffff")
        # Selezione (accent grafite, in tinta con la UI)
        _set("Highlight", "#475569")
        _set("HighlightedText", "#ffffff")
        _set("Link", "#64748b")

        # Testo disabilitato leggibile su fondo scuro.
        disabled = getattr(Group, "Disabled", None)
        if disabled is not None:
            for rn in ("WindowText", "Text", "ButtonText"):
                role = getattr(Role, rn, None)
                if role is not None:
                    pal.setColor(disabled, role, QColor("#6b7280"))

        app.setPalette(pal)
    except Exception as e:  # noqa: BLE001 - la palette e' un miglioramento, non critica
        print(f"[palette] impossibile applicare la palette scura: {e}")


# ---------------------------------------------------------------------------
# Generazione AI: funzioni condivise fra /api/generate e la coda pack.
# Estratte dall'handler HTTP perche' la coda pack (src/pack.py) gira su thread
# worker e non ha un oggetto request da cui attingere.
# ---------------------------------------------------------------------------

def _prompts_dir():
    return os.path.join(BASE_DIR, "assets", "prompts")


def _read_prompt_file(name, fallback=""):
    path = os.path.join(_prompts_dir(), name)
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()
        except OSError as e:
            print(f"[prompt] impossibile leggere {name}: {e}")
    return fallback


BIG_STRUCTURE_RULE = """

[MODALITA' STRUTTURA GRANDE - ISTRUZIONI PRIORITARIE]
L'utente sta generando una STRUTTURA GRANDE (casa, edificio, veicolo, scena o
ambiente), non un piccolo oggetto. Regole aggiuntive vincolanti:

1. SFRUTTA TUTTA LA GRIGLIA. Il modello deve occupare almeno il 70% delle
   dimensioni disponibili su ogni asse. Un edificio che usa un angolino della
   griglia e' un errore: la griglia grande e' stata scelta apposta.

2. DETTAGLIO ARCHITETTONICO OBBLIGATORIO. Non fermarti al volume esterno:
   - facciate con porte, finestre (con infissi e vetri di colore diverso),
     davanzali, cornici, insegne;
   - tetto con struttura vera (tegole, spioventi, comignoli, grondaie);
   - basamento/fondamenta, gradini, terrazze, balconi, ringhiere;
   - variazione dei materiali sulle pareti (mattoni, legno, intonaco).

3. INTERNI, se il soggetto li prevede. Pareti divisorie, pavimenti per piano,
   scale fra i piani, e arredi essenziali. Non fare un guscio vuoto.

4. USA MOLTI PIU' COMANDI. Una struttura grande richiede centinaia di ops:
   usa `fill` per le masse, `box` per le stanze cave, `rect` per pavimenti e
   solai, `line` per travi e ringhiere, `del` per scavare porte e finestre.
   Non essere pigro: la qualita' si misura sul dettaglio.

5. COERENZA STRUTTURALE. Il modello deve stare in piedi: niente parti
   fluttuanti, pareti di spessore >= 1 voxel, tetto appoggiato alle pareti,
   proporzioni credibili (una porta alta ~2/3 del piano terra).
"""

MODULAR_ASSET_RULE = """

[MODALITA' ASSET MODULARE / COMPONIBILE — ANALISI FORMA E SIMMETRIA INTELLIGENTE]

Prima di iniziare, IDENTIFICA il tipo di asset richiesto e applica le regole di simmetria appropriate per quella forma. NON applicare regole di simmetria "alla cieca" senza prima capire la geometria dell'oggetto.

━━━ ANALISI TIPO ASSET ━━━

▶ BLOCCO CUBICO UNIFORME (es: pietra, metallo, mattone, marmo, legno...)
  → Forma: piena, occupa tutta la griglia X*Y*Z.
  → Simmetria: Le 4 FACCE LATERALI (Nord/Sud/Est/Ovest) devono essere IDENTICHE o speculari tra loro.
  → Come farlo: progetta il pattern su una sola faccia (z=0), poi replicalo matematicamente su Sud (z=Z_MAX), Est (x=X_MAX, z←x) e Ovest (x=0, z←x).
  → Top (Y_MAX) e Bottom (Y=0): stesso stile dei lati.

▶ BLOCCO CUBICO CON DUE MATERIALI (es: terra con erba, neve sulla pietra, muschio su roccia...)
  → Riconosci questo tipo quando il nome contiene due materiali distinti (superiore + inferiore/corpo).
  → Costruzione OBBLIGATORIA stile Minecraft:
     • FACCIA SUPERIORE (y=Y_MAX): interamente del colore del materiale superiore (es. verde erba).
     • FACCIA INFERIORE (y=0): interamente del colore del materiale corpo (es. marrone terra).
     • FACCE LATERALI (Nord/Sud/Est/Ovest) — Divisione verticale in 3 zone:
         - ZONA ALTA (ultimi 1-2 voxel in Y, da Y_MAX-2 a Y_MAX): striscia del materiale superiore (es. verde erba),
           uguale su tutte e 4 le facce per permettere l'incastro visivo orizzontale.
         - ZONA CORPO (da y=3 a Y_MAX-3 circa): materiale corpo con eventuali variazioni texture (crepe, sfumature).
         - ZONA BASSA (primi 1-2 voxel, y=0..2): materiale corpo più scuro/compatto.
     • Le 4 facce laterali devono essere IDENTICHE tra loro (stessa distribuzione di zone).
  → NESSUNA macchia di erba a caso nel mezzo dei lati: la striscia verde deve essere una fascia CONTINUA e ORIZZONTALE in cima ai lati.

▶ COLONNA / PILASTRO (es: colonna dorica, pilastro, palo...)
  → Forma: asse verticale (Y), sezione trasversale uniforme su tutto l'asse Y.
  → Simmetria: la sezione XZ deve essere simmetrica. Texture LATERALE con linee verticali/scanalature.
  → La faccia superiore (capitello/base) può essere diversa dai lati.

▶ PARETE / SLAB ORIZZONTALE (es: pavimento, tetto, lastra, gradino...)
  → Forma: occupa tutta X e Z, con Y limitato.
  → La faccia superiore (Y_MAX) è la principale e dettagliata. Bordi laterali continui per l'incastro.

▶ ELEMENTO ARCHITETTONICO (es: arco, finestra, cornice, portale...)
  → Simmetria: solo l'asse di simmetria naturale (es. asse X per un arco).

▶ ELEMENTO DECORATIVO (es: cassa, barile, porta, lanterna...)
  → Applica simmetria dove ha senso visivo per quell'oggetto.

━━━ REGOLE SEMPRE VALIDE ━━━
- NESSUN puntino o macchia casuale senza logica: ogni dettaglio deve fare parte di un pattern intenzionale.
- I BORDI ESTERNI (x=0, x=X_MAX, z=0, z=Z_MAX) devono essere PIATTI e PIENI per l'incastro.
- Usa `fill` per il volume base, poi `set`/`line`/`rect` per i dettagli decorativi.
- I colori devono essere coerenti con il materiale richiesto.
"""

MULTI_PART_RULE = """
[MODALITA' MULTI-PARTE: SUDDIVISIONE IN SOTTO-OGGETTI]
L'utente ha disattivato l'oggetto unico. DEVI costruire l'oggetto formandolo da più parti separate (es. le ruote di un'auto separate dalla carrozzeria, il braccio di una catapulta separato dalla base).
INVECE DI usare la solita chiave "ops", DEVI USARE UNA CHIAVE "parts" alla radice del JSON.
La chiave "parts" è un oggetto JSON in cui ogni chiave è il nome descrittivo della parte (es. "base", "braccio") e il valore è l'array di comandi (fill, box, ecc) per costruirla.

ESEMPIO DI STRUTTURA JSON:
```json
{
  "metadata": { "name": "Catapulta", "grid_size": [128, 128, 128] },
  "palette": { "a": "#RRGGBB", "b": "#RRGGBB" },
  "parts": {
    "base": [
      ["fill", 0, 0, 0, 127, 20, 127, "a"]
    ],
    "braccio_mobile": [
      ["fill", 60, 20, 40, 68, 100, 48, "b"]
    ]
  }
}
```
Tutte le parti condividono la stessa griglia e la stessa palette (niente palette separate). 
Le parti non devono incrociarsi o fondersi male, ma essere adiacenti nei punti di articolazione. 
Ricorda: sostituisci l'array "ops" globale con l'oggetto "parts" contenente i vari array di comandi!
"""

# Regola umanoide. Va appesa DOPO MULTI_PART_RULE (le regole piu' vincolanti
# vicino alla fine del prompt), perche' ne specializza il formato "parts".
#
# Il motivo tecnico dei nomi imposti: il rig assegna ogni parte a UNA sola
# catena di ossa (restrictToParts in ui/src/lib/15-rig.js scende su un solo
# ramo). Una parte "pantaloni" che copre entrambe le gambe finisce quindi
# tutta sulla catena di una gamba sola e le due gambe risultano saldate --
# esattamente il bug visto sui modelli generati prima di questa regola.
# Un indumento va quindi SEMPRE spezzato per arto.
#
# Convenzione lato: nello scheletro dell'app `_R` sta a X MAGGIORE e `_L` a X
# minore (vedi legXR/legXL in 15-rig.js), cioe' destra/sinistra dello
# spettatore. Il suffisso qui sotto segue quella convenzione.
HUMANOID_RULE = """
[REGOLA TASSATIVA: SOGGETTO UMANO / UMANOIDE]
Il soggetto e' una figura umana o umanoide (persona, personaggio, robot antropomorfo, creatura bipede).
DEVE essere costruito in modo da poter essere riggato e animato senza correzioni manuali.

1) POSA: costruisci il personaggio in T-POSE. Braccia distese ORIZZONTALMENTE lungo l'asse X, palmi verso il basso, gambe dritte e PARALLELE, piedi appoggiati a terra (y minimo del modello) e rivolti verso +Z. Niente pose dinamiche, niente braccia lungo i fianchi.

2) SEPARAZIONE FRA LE GAMBE: fra la gamba destra e la gamba sinistra ci deve essere un VUOTO di almeno 2 voxel per tutta l'altezza, dall'inguine fino a terra. Le gambe non si toccano mai. Stesso discorso per le braccia rispetto al torso: almeno 1 voxel di stacco sotto l'ascella.

3) SUDDIVISIONE IN PARTI PER ARTO (la piu' importante).
Usa la chiave "parts" (vedi formato multi-parte) con una parte PER OGNI ARTO, mai una parte per indumento.
Nomi da usare, tutti in minuscolo, con il suffisso _R per il lato a X MAGGIORE e _L per il lato a X minore:

  testa, collo, torso, bacino,
  braccio_R, mano_R, braccio_L, mano_L,
  gamba_R, piede_R, gamba_L, piede_L

Ogni parte contiene TUTTO cio' che sta su quell'arto, vestiti compresi: i pantaloni della gamba destra stanno dentro "gamba_R", quelli della sinistra dentro "gamba_L", lo stivale destro dentro "piede_R". Capelli, cappelli, occhiali, caschi e visori vanno dentro "testa". Cinture, giacche e corazze del busto vanno dentro "torso" (o "bacino" se stanno sotto la vita).
VIETATO creare parti come "pantaloni", "stivali", "scarpe", "guanti", "maniche", "vestito": sono indumenti che coprono due arti e romperebbero il rig.
Se il personaggio ha accessori che NON seguono un arto (mantello, zaino, coda, ali) mettili in parti a se' con nome proprio ("mantello", "zaino", "coda", "ala_R", "ala_L").

4) COERENZA CON I NOMI: se un arto non esiste (es. un umanoide senza mani distinte) semplicemente ometti la parte, non rinominarla.

5) PROPORZIONI: testa circa 1/7 - 1/8 dell'altezza totale, spalle piu' larghe del bacino, gomiti a meta' braccio, ginocchia a meta' gamba, mani che arrivano a meta' coscia. Il modello deve poggiare a terra (y=0) e stare centrato sull'asse X della griglia.

6) SPESSORE: nessuna parte del corpo puo' essere spessa 1 voxel. Braccia e gambe almeno 3x3 di sezione, collo almeno 2x2, cosi' che il rig abbia volume da deformare.

Ricorda: la suddivisione per arto del punto 3 non e' un suggerimento, e' il requisito che rende il personaggio animabile.
"""


def _apply_grid_rule(prompt_text, grid_size):
    """Aggiunge la regola tassativa sulla griglia, se non e' 'auto'."""
    if not grid_size or grid_size == "auto":
        return prompt_text
    dims = str(grid_size).split('x')
    if len(dims) != 3:
        return prompt_text
    return prompt_text + (
        f"\n\n[REGOLA TASSATIVA: L'utente ha richiesto esplicitamente la griglia {grid_size}. "
        f"Nel metadata JSON imposta ASSOLUTAMENTE 'grid_size': [{dims[0]}, {dims[1]}, {dims[2]}]. "
        "Sfrutta tutta la griglia per aggiungere dettagli!]"
    )


# --- Client AI, errori parlanti e retry -------------------------------------
# Il corpo vive in `src/aiclient.py`, CONDIVISO con PixelAIEditor: e' la parte
# che si sbaglia se duplicata (il client `gemini` non espone codici di errore,
# solo messaggi, e distinguere "cookie scaduti" da "quota" si fa per indizi
# testuali). Qui restano i re-export, perche' rotte e test li cercano come
# attributi di `main`.

from aiclient import (                                       # noqa: E402
    AIAuthError,
    AITransientError,
    AIFormatError,
    _AI_AUTH_HINTS,
    _classify_ai_error,
    _gemini_client,
    ai_answer_text,
    INTERACTIVE_RETRY_BUDGET_SECONDS,
    _interactive_backoff,
    ai_answer_text_retrying,
)


def run_ai_generation(final_prompt, model=None):
    """
    Invia il prompt a Gemini e ritorna il modello JSON parsato.
    Solleva un'eccezione se la risposta non e' recuperabile: la coda pack la
    gestira' come errore del job, la modalita' singola come errore 500.

    NOTA: qui NON si ritenta. La coda pack ha il proprio loop di retry
    (cancel-aware) attorno a questa funzione: aggiungerne un secondo qui
    significherebbe moltiplicare i tentativi e i tempi di attesa.
    """
    answer = ai_answer_text(final_prompt, model)

    sys.path.insert(0, os.path.join(BASE_DIR, "src"))
    from parser import extract_and_parse_json
    return extract_and_parse_json(answer)


def build_pack_prompt(object_name, variant, style_contract, options):
    """
    Costruisce il prompt di UN asset del pack.

    Struttura (l'ordine conta: le regole piu' vincolanti vanno vicino alla fine,
    dove i modelli linguistici le seguono meglio):
      1. lo schema del formato compatto  -> prompt.txt (riusato, mai duplicato)
      2. le regole della modalita' pack  -> prompt-pack.txt
      3. il soggetto + l'etichetta asset
      4. la direttiva di variante (anti-cloni)
      5. il contratto di stile           -> palette/griglia/dettaglio vincolanti
    """
    # La taglia relativa e' dichiarabile nel nome ("Armadio :grande"): la
    # estraiamo per istruire l'AI sull'ingombro atteso, e usiamo il nome pulito
    # come soggetto ed etichetta.
    clean_name, size_hint = pack_engine.parse_size_hint(object_name)
    object_name = clean_name or object_name
    label = "%s_%d" % (pack_engine.slugify(object_name), variant)
    base = _read_prompt_file("prompt.txt", "Genera un modello voxel in JSON compatto.")
    # Il template singolo contiene un placeholder del soggetto: lo neutralizziamo
    # perche' in modalita' pack il soggetto viene dichiarato separatamente.
    base = base.replace("[INSERISCI QUI IL MODELLO DESIDERATO]", object_name)

    pack_rules = _read_prompt_file("prompt-pack.txt", "")

    parts = [base]
    if pack_rules:
        parts.append(pack_rules)

    parts.append(
        "### ASSET DA GENERARE ORA\n\n"
        f"SOGGETTO: {object_name}\n"
        f"ETICHETTA ASSET (usala come metadata.name): {label}\n\n"
        "Progetta le coordinate da zero per rappresentare fedelmente QUESTO "
        "soggetto. Non copiare la topologia degli esempi."
    )

    parts.append(pack_engine.variant_directive(
        object_name, variant, options.get("variants") if options else None))

    if size_hint:
        frac = pack_engine.SIZE_HINTS.get(size_hint)
        parts.append(
            "TAGLIA RELATIVA NEL PACK: '%s'. Questo oggetto deve occupare circa il "
            "%d%% della griglia sull'asse maggiore. Gli asset del pack finiranno "
            "nella stessa scena: le proporzioni fra loro devono essere credibili."
            % (size_hint, int((frac or 0.5) * 100))
        )

    if style_contract:
        parts.append(style_contract)

    if (options or {}).get("modular"):
        parts.append(MODULAR_ASSET_RULE)

    # La regola umanoide PRETENDE il formato "parts": se l'utente l'ha attivata
    # lasciando l'oggetto unico, il multi-parte va aggiunto comunque, altrimenti
    # i nomi degli arti non avrebbero dove stare.
    humanoid = bool((options or {}).get("humanoid"))
    if humanoid or (options or {}).get("single_object", True) is False:
        parts.append(MULTI_PART_RULE)
    if humanoid:
        parts.append(HUMANOID_RULE)

    prompt = "\n\n".join(p for p in parts if p)
    return _apply_grid_rule(prompt, (options or {}).get("grid_size"))


def _pack_generate(prompt, model, grid_size):
    """Adattatore passato a PackManager: firma (prompt, model, grid) -> dict."""
    return run_ai_generation(prompt, model)


# Istanza unica della coda pack. `daemon` implicito: i worker sono thread daemon,
# quindi non impediscono la chiusura dell'app.
PACK_MANAGER = pack_engine.PackManager(_pack_generate, prompt_builder=build_pack_prompt)


# ---------------------------------------------------------------------------
# ANIMAZIONI AI: prompt + normalizzazione della clip
#
# `buildClipFromAnimData` (ui/src/lib/15-rig.js) accetta UNA sola forma:
#   { name, duration, loop, tracks: [ { bone, keys: [ {t, rot:[x,y,z]?,
#                                                     pos:[dx,dy,dz]?} ] } ] }
# con rot in GRADI (Euler XYZ) e pos in voxel. Un LLM invece produce
# regolarmente varianti innocue (`keyframes` per `keys`, `rotation` per `rot`,
# `time` per `t`, `tracks` come oggetto, nomi di ossa con maiuscole diverse...):
# prima erano tutte "Errore animazione" lato client. Ora il server le riconduce
# al contratto, e se non resta nulla di valido risponde 400 spiegando cosa e'
# arrivato.
# ---------------------------------------------------------------------------

ANIM_PROMPT_FALLBACK = (
    "Sei un esperto di ANIMAZIONE di personaggi voxel (rigging a ossa).\n"
    "Crea UNA clip di animazione a keyframe per lo scheletro fornito.\n\n"
    "### OSSA DISPONIBILI (usa SOLO questi nomi, copiati IDENTICI)\n"
    "[INSERISCI QUI LE OSSA]\n\n"
    "### FORMATO OUTPUT (obbligatorio)\n"
    "Rispondi SOLO con il JSON racchiuso in un blocco markdown (```json ... ```).\n"
    "Non aggiungere testo prima o dopo, nessuna spiegazione.\n"
    "Le chiavi sono esattamente name, duration, loop, tracks, bone, keys, t, rot, pos.\n"
    "\"tracks\" e' un ARRAY. Rotazioni in GRADI, Euler [X, Y, Z].\n"
    "{\"name\":\"Nome\",\"duration\":2.0,\"loop\":true,\"tracks\":"
    "[{\"bone\":\"NOME_OSSO\",\"keys\":[{\"t\":0.0,\"rot\":[0,0,0]},"
    "{\"t\":2.0,\"rot\":[0,0,0]}]}]}\n\n"
    "### RICHIESTA DELL'UTENTE\n[INSERISCI QUI LA RICHIESTA]\n"
)

ANIM_MIN_DURATION = 0.1
ANIM_MAX_DURATION = 60.0
ANIM_DEFAULT_DURATION = 1.5
ANIM_MAX_KEYS = 400          # tetto di sicurezza per track
ANIM_MAX_TRACKS = 64

# Sinonimi accettati. L'ordine conta: il primo trovato vince.
_ANIM_TRACKS_KEYS = ("tracks", "track", "channels", "boneTracks", "bone_tracks",
                     "bones", "animation", "animations", "clip", "clips", "data")
_ANIM_KEYS_KEYS = ("keys", "keyframes", "keyFrames", "key_frames", "frames",
                   "poses", "steps", "values")
_ANIM_BONE_KEYS = ("bone", "boneName", "bone_name", "name", "target", "joint",
                   "node")
_ANIM_TIME_KEYS = ("t", "time", "at", "sec", "second", "seconds", "timestamp",
                   "frame", "f")
_ANIM_ROT_KEYS = ("rot", "rotation", "euler", "rotate", "rotationEuler",
                  "angles", "rotEuler", "r")
_ANIM_POS_KEYS = ("pos", "position", "translation", "translate", "offset",
                  "loc", "location", "p")
_ANIM_DURATION_KEYS = ("duration", "length", "durationSeconds", "dur", "time",
                       "totalTime")
_ANIM_LOOP_KEYS = ("loop", "looping", "isLoop", "repeat", "cycle")


def _anim_first(d, names):
    """Primo valore non-None fra `names` in un dict (case-insensitive)."""
    if not isinstance(d, dict):
        return None, None
    lowered = {str(k).lower(): k for k in d}
    for n in names:
        real = lowered.get(n.lower())
        if real is not None and d[real] is not None:
            return d[real], real
    return None, None


def _anim_bone_slug(name):
    """'Upper Arm-R' / 'upperArm_R' / 'upperarm r' -> 'upperarmr'."""
    return re.sub(r'[^a-z0-9]', '', str(name).lower())


def _anim_bone_slug_sides(name):
    """Come sopra ma con 'right'/'left'/'destro'/'sinistro' ridotti a r/l."""
    s = _anim_bone_slug(name)
    for word, short in (("right", "r"), ("left", "l"),
                        ("destro", "r"), ("destra", "r"),
                        ("sinistro", "l"), ("sinistra", "l")):
        s = s.replace(word, short)
    return s


def _anim_bone_index(bones):
    """slug -> nome REALE dell'osso. Il primo che occupa uno slug vince."""
    index = {}
    for b in bones or []:
        real = str(b)
        for slug in (_anim_bone_slug(real), _anim_bone_slug_sides(real)):
            if slug and slug not in index:
                index[slug] = real
    return index


def _anim_number(value, default=None):
    """Numero da int/float/str ('-90', '90 gradi', '1.5s'). None se impossibile."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        try:
            f = float(value)
        except (TypeError, ValueError, OverflowError):
            return default
        return f if f == f and abs(f) != float('inf') else default
    if isinstance(value, str):
        m = re.search(r'-?\d+(?:[.,]\d+)?', value.replace(' ', ''))
        if m:
            try:
                return float(m.group(0).replace(',', '.'))
            except ValueError:
                return default
    return default


def _anim_vec3(value):
    """Vettore a 3 componenti da lista, dict {x,y,z}, o stringa '0, 0, -90'."""
    if isinstance(value, str):
        nums = re.findall(r'-?\d+(?:\.\d+)?', value)
        value = nums if nums else None
    if isinstance(value, dict):
        out, found = [], False
        for axis in ("x", "y", "z"):
            v, _ = _anim_first(value, (axis, axis.upper(), "r" + axis, "d" + axis))
            n = _anim_number(v, None)
            out.append(0.0 if n is None else n)
            found = found or n is not None
        return out if found else None
    if isinstance(value, (list, tuple)):
        nums = [_anim_number(v, None) for v in value[:3]]
        nums = [0.0 if n is None else n for n in nums]
        if not nums:
            return None
        while len(nums) < 3:
            nums.append(0.0)
        return nums
    return None


def _anim_loose_vec3(key_dict, prefixes):
    """rot/pos scritti come componenti sciolte: {rx,ry,rz} oppure {x,y,z}."""
    for pfx in prefixes:
        out, found = [], False
        for axis in ("x", "y", "z"):
            v, _ = _anim_first(key_dict, (pfx + axis,))
            n = _anim_number(v, None)
            out.append(0.0 if n is None else n)
            found = found or n is not None
        if found:
            return out
    return None


def _anim_truthy(value, default=True):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    s = str(value).strip().lower()
    if s in ("true", "1", "yes", "y", "si", "sì", "on", "loop", "ciclico"):
        return True
    if s in ("false", "0", "no", "n", "off", "once", "oneshot"):
        return False
    return default


def _anim_raw_tracks(node, depth=0):
    """Estrae la lista grezza di (hint_nome_osso, dict_track) da qualunque forma.

    Gestisce: array al top level, `tracks` come array o come oggetto
    bone->keys, un singolo track non incapsulato, e clip annidate
    ({"animation": {...}}, {"animations": [ {...} ]}).
    """
    if depth > 5 or node is None:
        return []

    if isinstance(node, list):
        direct = [it for it in node
                  if isinstance(it, dict) and _anim_first(it, _ANIM_KEYS_KEYS)[0] is not None]
        if direct:
            return [(None, it) for it in direct]
        for it in node:
            got = _anim_raw_tracks(it, depth + 1)
            if got:
                return got
        return []

    if not isinstance(node, dict):
        return []

    # Un track singolo passato al posto della lista.
    if _anim_first(node, _ANIM_KEYS_KEYS)[0] is not None and \
            _anim_first(node, _ANIM_BONE_KEYS)[0] is not None:
        return [(None, node)]

    for key in _ANIM_TRACKS_KEYS:
        value, _ = _anim_first(node, (key,))
        if value is None:
            continue
        got = _anim_tracks_from_value(value, depth + 1)
        if got:
            return got

    # Ultima spiaggia: {"hips": [...], "spine": [...]} senza contenitore.
    mapped = _anim_tracks_from_mapping(node)
    if mapped:
        return mapped

    for value in node.values():
        got = _anim_raw_tracks(value, depth + 1)
        if got:
            return got
    return []


def _anim_tracks_from_value(value, depth):
    if isinstance(value, list):
        return _anim_raw_tracks(value, depth)
    if isinstance(value, dict):
        if _anim_first(value, _ANIM_KEYS_KEYS)[0] is not None:
            return [(None, value)]
        mapped = _anim_tracks_from_mapping(value)
        if mapped:
            return mapped
        return _anim_raw_tracks(value, depth)
    return []


def _anim_tracks_from_mapping(node):
    """{"hips": [keys...]} oppure {"hips": {"keys": [...]}} -> lista di track.

    Attenzione: una chiave contenitore ("tracks", "bones", "channels", ...) NON
    e' un nome di osso. Senza questo filtro {"animation": {"bones": [...]}}
    diventava un track chiamato "bones" e l'unico osso vero veniva perso.
    """
    container = {k.lower() for k in _ANIM_TRACKS_KEYS}
    out = []
    for name, value in node.items():
        if str(name).lower() in container:
            continue
        if isinstance(value, list) and value and all(isinstance(v, dict) for v in value):
            # Se gli elementi hanno a loro volta dei keyframe sono TRACK, non key.
            if any(_anim_first(v, _ANIM_KEYS_KEYS)[0] is not None for v in value):
                continue
            out.append((name, {"keys": value}))
        elif isinstance(value, dict) and _anim_first(value, _ANIM_KEYS_KEYS)[0] is not None:
            out.append((name, value))
    return out


def _anim_meta(node, depth=0):
    """Trova il dict che porta i metadati della clip (name/duration/loop)."""
    if depth > 5 or not isinstance(node, dict):
        return {}
    if _anim_first(node, _ANIM_DURATION_KEYS)[0] is not None or \
            _anim_first(node, _ANIM_LOOP_KEYS)[0] is not None:
        return node
    for value in node.values():
        if isinstance(value, dict):
            got = _anim_meta(value, depth + 1)
            if got:
                return got
        elif isinstance(value, list):
            for it in value:
                got = _anim_meta(it, depth + 1)
                if got:
                    return got
    return node


def _anim_parse_keys(raw_keys, fps=None):
    """Lista grezza di keyframe -> [(t, rot|None, pos|None)] ordinata."""
    parsed = []
    if isinstance(raw_keys, dict):
        # {"0": {...}, "1.0": {...}} : la chiave e' il tempo.
        raw_keys = [dict(v, **{"t": k}) if isinstance(v, dict) else v
                    for k, v in raw_keys.items()]
    if not isinstance(raw_keys, (list, tuple)):
        return parsed

    for i, k in enumerate(raw_keys[:ANIM_MAX_KEYS]):
        if isinstance(k, (list, tuple)):
            # [t, x, y, z] oppure [x, y, z]
            nums = [_anim_number(v, None) for v in k]
            nums = [n for n in nums if n is not None]
            if len(nums) >= 4:
                parsed.append((nums[0], nums[1:4], None))
            elif len(nums) == 3:
                parsed.append((float(i), nums, None))
            continue
        if not isinstance(k, dict):
            continue

        t_raw, t_key = _anim_first(k, _ANIM_TIME_KEYS)
        t = _anim_number(t_raw, None)
        if t is None:
            t = float(i)
        elif t_key and str(t_key).lower() in ("frame", "f") and fps:
            t = t / float(fps)

        rot_raw, _ = _anim_first(k, _ANIM_ROT_KEYS)
        rot = _anim_vec3(rot_raw)
        if rot is None:
            rot = _anim_loose_vec3(k, ("r", "rot", ""))

        pos_raw, _ = _anim_first(k, _ANIM_POS_KEYS)
        pos = _anim_vec3(pos_raw)
        if pos is None and rot is None:
            pos = _anim_loose_vec3(k, ("d", "p"))

        if rot is None and pos is None:
            continue
        parsed.append((max(0.0, t), rot, pos))

    parsed.sort(key=lambda e: e[0])
    return parsed


def normalize_anim_data(data, bones):
    """
    Riconduce la risposta dell'AI al contratto di `buildClipFromAnimData`.

    Ritorna SEMPRE {name, duration, loop, tracks:[{bone, keys:[{t, rot?, pos?}]}]}.
    Chiavi diagnostiche aggiuntive (presenti solo se non vuote, il client le
    ignora): `unknownBones` (nomi inventati dall'AI) e `warnings`.
    Se `tracks` risulta vuota, il chiamante deve rispondere 400.
    """
    bone_index = _anim_bone_index(bones)
    strict_bones = bool(bone_index)      # senza scheletro non possiamo validare
    unknown, warnings = [], []

    raw_tracks = _anim_raw_tracks(data)
    meta = _anim_meta(data if isinstance(data, dict) else {})

    fps = _anim_number(_anim_first(meta, ("fps", "frameRate", "frame_rate"))[0], None)

    # 1) Track: nome osso + keyframe.
    collected = []
    for hint, tr in raw_tracks[:ANIM_MAX_TRACKS]:
        if not isinstance(tr, dict):
            continue
        name_raw, _ = _anim_first(tr, _ANIM_BONE_KEYS)
        name = name_raw if name_raw is not None else hint
        if name is None:
            warnings.append("track senza nome osso, scartato")
            continue
        if strict_bones:
            real = bone_index.get(_anim_bone_slug(name)) or \
                bone_index.get(_anim_bone_slug_sides(name))
            if not real:
                if str(name) not in unknown:
                    unknown.append(str(name))
                continue
        else:
            real = str(name)

        keys_raw, _ = _anim_first(tr, _ANIM_KEYS_KEYS)
        if keys_raw is None:
            keys_raw = tr.get("keys")
        keys = _anim_parse_keys(keys_raw, fps)
        if not keys:
            warnings.append("track '%s' senza keyframe validi, scartato" % real)
            continue
        collected.append((real, keys))

    # 2) Durata: dichiarata se sensata, altrimenti dedotta dai keyframe. Mai
    #    inferiore al tempo dell'ultimo keyframe (perderemmo dei keyframe).
    max_t = max((k[0] for _, keys in collected for k in keys), default=0.0)
    declared = _anim_number(_anim_first(meta, _ANIM_DURATION_KEYS)[0], None)
    duration = declared if (declared and declared > 0) else None
    if duration is None:
        duration = max_t if max_t > 0 else ANIM_DEFAULT_DURATION
    if max_t > duration:
        duration = max_t
    duration = min(ANIM_MAX_DURATION, max(ANIM_MIN_DURATION, float(duration)))

    # 3) Keyframe -> contratto JS. Un solo keyframe non produce animazione:
    #    lo duplichiamo a t=0 e t=duration (posa statica, ma clip valida).
    tracks = []
    for real, keys in collected:
        rot_keys = [(min(duration, k[0]), k[1]) for k in keys if k[1] is not None]
        pos_keys = [(min(duration, k[0]), k[2]) for k in keys if k[2] is not None]
        if len(rot_keys) == 1:
            rot_keys = [(0.0, rot_keys[0][1]), (duration, rot_keys[0][1])]
            warnings.append("track '%s': un solo keyframe di rotazione, duplicato" % real)
        if len(pos_keys) == 1:
            pos_keys = [(0.0, pos_keys[0][1]), (duration, pos_keys[0][1])]
            warnings.append("track '%s': un solo keyframe di posizione, duplicato" % real)

        merged = {}
        for t, rot in rot_keys:
            merged.setdefault(round(t, 6), {})["rot"] = [float(v) for v in rot]
        for t, pos in pos_keys:
            merged.setdefault(round(t, 6), {})["pos"] = [float(v) for v in pos]
        if not merged:
            continue
        out_keys = []
        for t in sorted(merged):
            entry = {"t": t}
            entry.update(merged[t])
            out_keys.append(entry)
        tracks.append({"bone": real, "keys": out_keys})

    name = _anim_first(meta, ("name", "clipName", "title", "animationName"))[0]
    name = str(name).strip() if name is not None and str(name).strip() else "Animazione AI"

    result = {
        "name": name[:60],
        "duration": round(duration, 4),
        "loop": _anim_truthy(_anim_first(meta, _ANIM_LOOP_KEYS)[0], True),
        "tracks": tracks,
    }
    if unknown:
        result["unknownBones"] = unknown
    if warnings:
        result["warnings"] = warnings[:20]
    return result


def build_anim_prompt(prompt, bones):
    """Prompt di UNA clip di animazione. Il template su disco e' la fonte; il
    fallback inline serve solo se il file manca (bundle rotto) e ripete gli
    stessi vincoli di formato."""
    template = _read_prompt_file("prompt-anim.txt", ANIM_PROMPT_FALLBACK)
    bones_str = ", ".join(str(b) for b in bones) if bones else "(scheletro non disponibile)"
    out = template.replace("[INSERISCI QUI LE OSSA]", bones_str)
    return out.replace("[INSERISCI QUI LA RICHIESTA]", prompt)


# ---------------------------------------------------------------------------
# TEXTURE AI (pixel art): prompt + validazione della risposta
#
# Il corpo vive in `src/pixelprompt.py`, CONDIVISO con PixelAIEditor: le due app
# parlano lo stesso formato di ops 2D e duplicarlo lo farebbe divergere alla
# prima aggiunta di un comando. Qui restano i re-export (i test e le rotte HTTP
# li cercano come attributi di `main`) e l'unico pezzo che e' davvero locale: da
# quale cartella si legge il template del prompt.
#
# Le ops dei PIXEL hanno UNA sola implementazione lato disegno, `expandPixelOps`
# in ui/src/lib/37-pixel-ops.js: la tela vive nel browser e non esiste un
# consumatore server-side, a differenza delle ops dei voxel che la coda pack
# espande in Python (e quella parita' e' costata tre difetti veri). Qui il
# server NON disegna: valida solo la FORMA della risposta (lato, palette, una
# lista di comandi per faccia) e riconduce i sinonimi al contratto.
# ---------------------------------------------------------------------------

from pixelprompt import (                                    # noqa: E402
    PIXEL_FACE_KEYS,
    PIXEL_MIN_SIDE,
    PIXEL_MAX_SIDE,
    PIXEL_DEFAULT_SIDE,
    PIXEL_MAX_OPS,
    PIXEL_MAX_PALETTE,
    PIXEL_COMMANDS,
    PIXEL_FACE_LABELS,
    PIXEL_PROMPT_FALLBACK,
    _PIXEL_FACE_ALIASES,
    _pixel_face_key,
    _pixel_hex,
    normalize_pixel_data,
)
from pixelprompt import build_pixel_prompt as _build_pixel_prompt   # noqa: E402


def build_pixel_prompt(prompt, faces, context=None, size=None, height=None):
    """Come `pixelprompt.build_pixel_prompt`, col template preso da QUESTA app.

    Il modulo condiviso riceve il testo del prompt come parametro invece di
    leggerlo da disco: `assets/prompts/` e' diverso nelle due app (e in un
    bundle PyInstaller sta in un'altra cartella ancora), quindi chi conosce la
    propria e' il chiamante.
    """
    return _build_pixel_prompt(
        prompt, faces, context=context, size=size, height=height,
        template=_read_prompt_file("prompt-pixel.txt", PIXEL_PROMPT_FALLBACK))


# ---------------------------------------------------------------------------
# PONTE CON PixelAIEditor
# ---------------------------------------------------------------------------
# L'editor di pixel art 2D vive in `PixelAIEditor/` ed e' un'app autonoma, ma
# quando lo si apre DENTRO VoxelAIArtist (iframe della finestra dei materiali) la
# sua pagina e' servita da QUESTO server e il suo processo non parte affatto:
# `translate_path` ribasa ogni richiesta su BASE_DIR, quindi
# `GET /PixelAIEditor/ui/index.html` funziona senza aggiungere rotte. Le sue
# CHIAMATE AI no: la UI dell'editor usa percorsi assoluti (`/api/texture2d`), che
# nell'iframe arrivano qui. Senza questa rotta la generazione AI sarebbe morta
# appena aperta dal padre, e solo li' -- un difetto che l'app autonoma non mostra.
#
# Il template del prompt NON si duplica: si legge da quello dell'editor. Due copie
# divergerebbero al primo ritocco e lo stesso disegno verrebbe generato in modo
# diverso a seconda di come l'editor e' stato aperto.
def _pixel2d_prompt_text():
    """Testo di `prompt-pixel2d.txt` (cartella dei prompt di PixelAIEditor).

    Stesso spirito di `_prompts_dir()`: funziona da sorgente e congelato. Si
    prova prima la cartella dell'editor sotto BASE_DIR, poi la propria, perche'
    un bundle PyInstaller puo' appiattire i `datas` in un'unica cartella di
    prompt. Senza il file l'AI deve comunque poter essere chiamata, quindi in
    ultima istanza si ricade sul fallback del modulo condiviso.
    """
    for folder in (os.path.join(BASE_DIR, "PixelAIEditor", "assets", "prompts"),
                   _prompts_dir()):
        path = os.path.join(folder, "prompt-pixel2d.txt")
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    return f.read()
            except OSError as e:
                print(f"[prompt] impossibile leggere prompt-pixel2d.txt: {e}")
    return PIXEL_PROMPT_FALLBACK


def build_pixel2d_prompt(prompt, context=None, size=None, height=None):
    """Prompt per una TELA 2D, non per le sei facce di un cubo.

    Il motore e' lo stesso di `build_pixel_prompt` (`pixelprompt`, condiviso con
    PixelAIEditor): cambiano solo il template e il fatto che la faccia e' sempre
    una sola, `all`. Il modulo condiviso riceve il testo del template come
    parametro proprio perche' le due app hanno cartelle `assets/prompts/` diverse.
    """
    return _build_pixel_prompt(
        prompt, ["all"], context=context, size=size, height=height,
        template=_pixel2d_prompt_text())


class VoxelAIRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def translate_path(self, path):
        if path.startswith('/locales/'):
            path = '/ui' + path
        translated = super().translate_path(path)
        rel = os.path.relpath(translated, os.getcwd())
        return os.path.join(BASE_DIR, rel)

    def _send_json(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _log_ai_answer(label, answer, exc=None):
        """Log della risposta grezza del modello (mai i cookie: qui passa solo
        il testo della risposta)."""
        print("\n=== ERRORE %s ===" % label)
        if answer:
            preview = answer if len(answer) <= 4000 else answer[:4000] + "\n[...troncato]"
            print(preview)
        else:
            print("[Risposta non disponibile]")
        print("=" * (10 + len(label)))
        if exc is not None:
            import traceback
            traceback.print_exception(type(exc), exc, exc.__traceback__)

    def _send_ai_error(self, exc, label):
        """Mappa gli errori AI classificati su codici HTTP distinti.

        401 -> cookie da riconfigurare (il client puo' aprire le Impostazioni),
        503 -> rete/quota/rate-limit (riprovabile), 400 -> risposta non JSON.
        """
        self._log_ai_answer(label, getattr(exc, "answer", None), exc)
        if isinstance(exc, AIAuthError):
            self._send_json(401, {"error": str(exc), "needsCookies": True})
        elif isinstance(exc, AIFormatError):
            self._send_json(400, {"error": str(exc)})
        else:
            self._send_json(503, {"error": str(exc), "retryable": True})

    def _serve_html_injected(self, fs_path, desktop):
        """Serve una pagina HTML (index/settings) su HTTP normale, iniettando le
        variabili desktop se richiesto. Serviamo la UI via `setUrl(http://...)`
        invece di `setHtml(...)`: setHtml ricarica/riparsa il documento con un
        base file:// e provoca un lampeggio bianco a ogni load; una navigazione
        HTTP vera lascia a Chromium il compositing normale (niente flash) e
        `fetch('/api/...')` relativo funziona senza riscritture."""
        try:
            with open(fs_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except OSError:
            self.send_error(404)
            return
        if desktop:
            inject = (f"<script>window.__API_BASE__ = 'http://127.0.0.1:{PORT}';"
                      f" window.__IS_DESKTOP__ = true;</script>")
            content = content.replace("</head>", inject + "\n</head>", 1)
        body = content.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Le pagine principali passano da un handler dedicato che inietta le
        # variabili desktop (?desktop=1). Cosi' la MainWindow puo' caricarle con
        # setUrl(http://...) — vedi _serve_html_injected per il perche'.
        _pg = urlparse(self.path)
        if _pg.path in ('/', '/ui/', '/index.html', '/ui/index.html',
                        '/settings.html', '/ui/settings.html'):
            desktop = 'desktop=1' in (_pg.query or '')
            fname = 'settings.html' if _pg.path.endswith('settings.html') else 'index.html'
            self._serve_html_injected(os.path.join(BASE_DIR, 'ui', fname), desktop)
            return

        # ===== MULTIGENERAZIONE: stato e risultati =====
        # GET /api/pack/status?runId=...  -> stato leggero (senza i modelli)
        # GET /api/pack/result?runId=...&jobId=...  -> il modello di UN job
        if self.path.startswith('/api/pack/status'):
            try:
                qs = parse_qs(urlparse(self.path).query)
                run_id = (qs.get('runId') or [None])[0]
                run = PACK_MANAGER.get(run_id) if run_id else PACK_MANAGER.latest()
                if not run:
                    self._send_json(200, {"empty": True})
                    return
                # Deliberatamente NON include i payload dei modelli: lo status
                # viene interrogato in polling ogni pochi secondi e i modelli
                # pesano decine di KB l'uno.
                self._send_json(200, run.to_dict())
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if self.path.startswith('/api/pack/result'):
            try:
                qs = parse_qs(urlparse(self.path).query)
                run_id = (qs.get('runId') or [None])[0]
                job_id = (qs.get('jobId') or [None])[0]
                run = PACK_MANAGER.get(run_id) if run_id else PACK_MANAGER.latest()
                if not run:
                    self._send_json(404, {"error": "Pack non trovato."})
                    return
                if not job_id:
                    self._send_json(400, {"error": "jobId mancante."})
                    return
                job = run.find(job_id)
                if not job:
                    self._send_json(404, {"error": "Asset non trovato."})
                    return
                if job.status != 'done' or not job.result:
                    self._send_json(409, {"error": "Asset non ancora pronto.",
                                          "status": job.status})
                    return
                self._send_json(200, {"job": job.to_dict(), "model": job.result})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # GET /api/pack/saved -> elenco dei pack salvati su disco (#9)
        if self.path.startswith('/api/pack/saved'):
            try:
                qs = parse_qs(urlparse(self.path).query)
                folder = (qs.get('folder') or [None])[0]
                if folder:
                    data = pack_engine.load_saved_pack(folder)
                    if not data:
                        self._send_json(404, {"error": "Pack salvato non trovato."})
                        return
                    self._send_json(200, data)
                else:
                    self._send_json(200, {"packs": pack_engine.list_saved_packs()})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # GET /api/pack/report?runId=... -> report di coerenza dimensionale (#4)
        if self.path.startswith('/api/pack/report'):
            try:
                qs = parse_qs(urlparse(self.path).query)
                run_id = (qs.get('runId') or [None])[0]
                run = PACK_MANAGER.get(run_id) if run_id else PACK_MANAGER.latest()
                if not run:
                    self._send_json(404, {"error": "Pack non trovato."})
                    return
                assets = [{"label": j.label, "model": j.result}
                          for j in run.jobs if j.status == 'done' and j.result]
                self._send_json(200, pack_engine.pack_coherence_report(assets))
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # GET /api/pack/all?runId=... -> tutti i modelli pronti (export del pack)
        if self.path.startswith('/api/pack/all'):
            try:
                qs = parse_qs(urlparse(self.path).query)
                run_id = (qs.get('runId') or [None])[0]
                run = PACK_MANAGER.get(run_id) if run_id else PACK_MANAGER.latest()
                if not run:
                    self._send_json(404, {"error": "Pack non trovato."})
                    return
                assets = [{"label": j.label, "objectName": j.object_name,
                           "variant": j.variant, "model": j.result}
                          for j in run.jobs if j.status == 'done' and j.result]
                self._send_json(200, {"runId": run.id, "count": len(assets),
                                      "assets": assets})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if self.path == '/api/settings':
            _has_cookies = app_settings.has_cookies()
            self._send_json(200, {
                "has_cookies": _has_cookies,
                # needsCookies: la UI usa questo flag per aprire da se' il proprio
                # modale Impostazioni al primo avvio. Prima era main.py ad aprire
                # d'autorita' ui/settings.html: in modalita' web avrebbe dirottato
                # la pagina appena aperta dall'utente, quindi la decisione e' della
                # UI. E' la negazione di has_cookies, duplicata come nome esplicito
                # perche' il frontend non deve conoscere la semantica del backend.
                "needsCookies": (not _has_cookies),
                "cookie_count": len(app_settings.load_cookies()),
                "cookies_path": app_settings.get_cookies_path(),
                "appdata_dir": app_settings.get_appdata_dir(),
                # La UI puo' cambiare comportamento (dialog nativi vs download del
                # browser) sapendo in che modalita' gira il processo.
                "app_mode": APP_MODE,
                "is_desktop": bool(APP_MODE == "py" and GUI_AVAILABLE),
            })
            return
        if self.path == '/api/settings/open-folder':
            folder = app_settings.get_appdata_dir()
            subprocess.Popen(f'explorer "{folder}"')
            self._send_json(200, {"ok": True})
            return

        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)

        # --- Preferenze generiche (tema/keymap/locale/...) ---
        if route == '/api/prefs':
            try:
                self._send_json(200, {"settings": app_settings.get_public_settings()})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Apertura progetto via QFileDialog (marshal sul thread GUI) ---
        if route == '/api/project/open':
            try:
                result = _run_on_gui(lambda w: w.open_project_dialog())
                if result is None:
                    self._send_json(200, {"cancelled": True})
                else:
                    self._send_json(200, result)
            except RuntimeError as e:
                self._send_json(501, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Selettore cartella ---
        if route == '/api/settings/choose-dir':
            try:
                # Usiamo il dialog NATIVO di Windows (come "Apri"/"Salva", che gia'
                # funzionano): un dialog nativo e' una finestra a livello di OS e appare
                # SOPRA la surface GPU del QWebEngineView. Il dialog non-nativo disegnato
                # da Qt finiva invece COPERTO dalla webview composita ("Sfoglia" sembrava
                # non aprirsi). Con AA_ShareOpenGLContexts il compositing e' stabile.
                result = _run_on_gui(lambda w: w.choose_dir_dialog())
                if result:
                    self._send_json(200, {"folder": result})
                else:
                    self._send_json(200, {"cancelled": True})
            except RuntimeError as e:
                self._send_json(501, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Autosave: lista ---
        if route == '/api/autosave/list':
            try:
                self._send_json(200, {"autosaves": app_settings.list_autosaves()})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Autosave: contenuto singolo ---
        if route == '/api/autosave/get':
            try:
                name = (query.get('name') or [''])[0]
                if not name:
                    self._send_json(400, {"error": "parametro 'name' mancante"})
                    return
                content = app_settings.read_autosave(name)
                self._send_json(200, {"name": os.path.basename(name), "content": content})
            except (ValueError, FileNotFoundError) as e:
                self._send_json(404, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Autosave: apri cartella ---
        if route == '/api/autosave/open-folder':
            try:
                folder = app_settings.get_autosave_dir()
                subprocess.Popen(f'explorer "{folder}"')
                self._send_json(200, {"ok": True, "folder": folder})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Progetti recenti: lista ---
        if route == '/api/recent':
            try:
                self._send_json(200, {"recent": app_settings.get_recent_projects()})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        super().do_GET()

    def do_DELETE(self):
        if self.path == '/api/settings/cookies':
            p = app_settings.get_cookies_path()
            if os.path.exists(p):
                os.remove(p)
            self._send_json(200, {"ok": True})
            return

        parsed = urlparse(self.path)
        if parsed.path == '/api/recent':
            try:
                query = parse_qs(parsed.query)
                path = (query.get('path') or [''])[0]
                if not path:
                    self._send_json(400, {"error": "parametro 'path' mancante"})
                    return
                recent = app_settings.remove_recent_project(path)
                self._send_json(200, {"recent": recent})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        super().do_DELETE()

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode('utf-8'))

    def _handle_texture2d(self):
        """POST /api/texture2d — generazione AI della TELA di PixelAIEditor.

        Copia del `_handle_texture` di `PixelAIEditor/main.py`: stesso corpo
        accettato, stessa risposta, stessi codici. Esiste qui perche' dentro
        l'iframe la pagina dell'editor e' servita dal server del PADRE, quindi la
        sua fetch su percorso assoluto arriva a questo handler e non al suo.
        E' una rotta SEPARATA da `/api/texture` (le facce del creatore di
        materiali) di proposito: la' la tela e' la faccia quadrata di un cubo e le
        facce richieste sono fino a sei, qui la tela e' UNA e puo' non essere
        quadrata (`width` + `height`).

        Il server NON disegna: espandere le ops sulla tela e' compito di
        `expandPixelOps` nel browser, dove la tela vive. Qui si valida solo la
        FORMA della risposta, cosi' un errore diventa un messaggio invece di una
        tela che resta misteriosamente vuota.
        """
        try:
            content_length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            content_length = 0
        if content_length <= 0:
            self._send_json(400, {"error": "Corpo della richiesta mancante."})
            return
        try:
            payload = json.loads(self.rfile.read(content_length).decode('utf-8'))
        except Exception as e:                                  # noqa: BLE001
            self._send_json(400, {"error": "Richiesta non valida: %s" % e})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "Richiesta non valida: atteso un oggetto."})
            return

        # `str(...)` non e' decorativo: con un `prompt` non testuale (un numero,
        # una lista) lo `.strip()` solleva DENTRO l'handler, e un'eccezione qui
        # non diventa un 500 - chiude la connessione senza NESSUNA risposta HTTP,
        # e il client vede "connessione persa" invece di un messaggio.
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            self._send_json(400, {"error": "Descrizione del disegno mancante."})
            return

        answer = None
        try:
            final_prompt = build_pixel2d_prompt(
                prompt,
                payload.get("context"),
                payload.get("width", payload.get("size")),
                payload.get("height"))
            answer = ai_answer_text_retrying(final_prompt, payload.get("model"))
        except (AIAuthError, AITransientError) as e:
            self._send_ai_error(e, "PIXEL AI")
            return
        except Exception as e:                                  # noqa: BLE001
            self._send_ai_error(_classify_ai_error(e), "PIXEL AI")
            return

        sys.path.insert(0, os.path.join(BASE_DIR, "src"))
        from parser import extract_and_parse_json
        try:
            raw = extract_and_parse_json(answer)
        except Exception as e:                                  # noqa: BLE001
            self._log_ai_answer("PIXEL AI", answer, e)
            self._send_json(400, {
                "error": "Il modello non ha restituito JSON. Riprova, "
                         "eventualmente riformulando la descrizione. "
                         "Dettaglio: %s" % e,
                "rawPreview": (answer or "")[:400],
            })
            return

        # `faces=["all"]`: qualunque nome usi l'AI (`canvas`, `sprite`, `image`,
        # `px`...) viene ricondotto qui a un'unica tela dagli alias di
        # pixelprompt. Rifiutarlo costerebbe all'utente una rigenerazione per una
        # parola.
        tex = normalize_pixel_data(raw, ["all"])
        faces = tex.get("faces") or {}
        if not faces:
            self._log_ai_answer("PIXEL AI", answer, None)
            detail = ["Il modello ha risposto ma nessun comando e' utilizzabile."]
            if tex.get("unknownFaces"):
                detail.append("Nomi non riconosciuti: %s."
                              % ", ".join(tex["unknownFaces"][:12]))
            for w in (tex.get("warnings") or [])[:5]:
                detail.append(w + ".")
            detail.append("Riprova: spesso basta rigenerare.")
            self._send_json(400, {
                "error": " ".join(detail),
                "unknownFaces": tex.get("unknownFaces", []),
                "warnings": tex.get("warnings", []),
                "rawPreview": (answer or "")[:400],
            })
            return

        # La tela e' una sola: se l'AI ha comunque diviso in facce (capita quando
        # il prompt dell'utente parla di un cubo), si prende `all` se c'e',
        # altrimenti la PRIMA. Scartare il resto in silenzio sarebbe peggio che
        # dirlo, quindi finisce negli avvisi.
        if "all" in faces:
            ops = faces["all"]
        else:
            first = sorted(faces.keys())[0]
            ops = faces[first]
            if len(faces) > 1:
                tex.setdefault("warnings", []).append(
                    "piu' disegni nella risposta (%s): usato '%s'"
                    % (", ".join(sorted(faces)), first))

        if tex.get("warnings") or tex.get("unknownFaces"):
            print("[pixel2d] risposta normalizzata con avvisi: %s"
                  % json.dumps({"unknownFaces": tex.get("unknownFaces", []),
                                "warnings": tex.get("warnings", [])},
                               ensure_ascii=False))

        # `faces` resta nella risposta accanto a `ops`: il modulo che espande le
        # ops e' condiviso col padre e li' l'ingresso e' sempre un dizionario di
        # facce. Duplicare non costa nulla e evita un ramo dedicato nel client.
        self._send_json(200, {
            "size": tex.get("size"),
            "palette": tex.get("palette") or {},
            "ops": ops,
            "faces": {"all": ops},
            "unknownFaces": tex.get("unknownFaces", []),
            "warnings": tex.get("warnings", []),
        })

    def do_POST(self):
        # --- Preferenze generiche: merge senza perdere le altre chiavi ---
        if self.path == '/api/prefs':
            try:
                body = self._read_json_body()
                patch = body.get("settings", body) if isinstance(body, dict) else {}
                updated = app_settings.merge_settings(patch)
                self._send_json(200, {"settings": {
                    k: v for k, v in updated.items()
                    if k not in ("cookies", "cookie", "token", "secret", "password", "auth")
                }})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Salvataggio progetto nativo .voxai ---
        if self.path == '/api/project/save':
            try:
                body = self._read_json_body()
                path = body.get("path")
                data = body.get("data", {})
                if not path:
                    # nessun path → apri dialog "Salva con nome" sul thread GUI
                    try:
                        path = _run_on_gui(lambda w: w.save_project_dialog())
                    except RuntimeError as e:
                        self._send_json(501, {"error": str(e)})
                        return
                    if not path:
                        self._send_json(200, {"cancelled": True})
                        return
                saved_path = _write_voxai(path, data)
                self._send_json(200, {"path": saved_path})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Autosave: scrittura snapshot con rotazione ---
        if self.path == '/api/autosave':
            try:
                body = self._read_json_body()
                data = body.get("data", {})
                project_id = body.get("projectId")
                path = app_settings.write_autosave(data, project_id)
                self._send_json(200, {"path": path, "name": os.path.basename(path)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # --- Progetti recenti: aggiungi/aggiorna ---
        if self.path == '/api/recent':
            try:
                body = self._read_json_body()
                entry = body.get("entry", body) if isinstance(body, dict) else {}
                recent = app_settings.add_recent_project(entry)
                self._send_json(200, {"recent": recent})
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if self.path == '/api/settings/cookies':
            # Stessa insidia di /api/generate: header assente -> int(None) ->
            # TypeError non catturato -> nessuna risposta al client.
            try:
                length = int(self.headers.get('Content-Length') or 0)
                if length <= 0:
                    self._send_json(400, {"error": "Corpo della richiesta mancante."})
                    return
                data = json.loads(self.rfile.read(length).decode('utf-8'))
            except (TypeError, ValueError) as e:
                self._send_json(400, {"error": "Richiesta non valida: %s" % e})
                return
            try:
                app_settings.save_cookies(data)
                self._send_json(200, {"ok": True})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # ===== MULTIGENERAZIONE / ASSET PACK =====
        # Avvia un pack: N oggetti x M varianti, in coda serializzata lato server.
        if self.path == '/api/pack/start':
            try:
                body = self._read_json_body()
                objects = body.get("objects") or []
                variants = body.get("variants", 1)
                references = body.get("references") or []
                options = {
                    "model": body.get("model"),
                    "grid_size": body.get("gridSize"),
                    "concurrency": body.get("concurrency"),
                    "notes": body.get("notes"),
                    "variants": variants,
                    "enforce_palette": body.get("enforcePalette", True),
                    "normalize": body.get("normalize", True),
                    "single_object": body.get("single_object", True),
                    "humanoid": body.get("humanoid", False),
                }
                run = PACK_MANAGER.create_run(objects, variants, references, options)
                print(f"[pack] avviato {run.id}: {len(run.jobs)} job "
                      f"(stile da {run.style.get('sources', 0)} riferimenti)")
                self._send_json(200, run.to_dict())
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:
                import traceback
                traceback.print_exc()
                self._send_json(500, {"error": str(e)})
            return

        # Annulla un pack in corso (i job gia' partiti finiscono da soli).
        if self.path == '/api/pack/cancel':
            try:
                body = self._read_json_body()
                run = PACK_MANAGER.cancel(body.get("runId"))
                if not run:
                    self._send_json(404, {"error": "Pack non trovato."})
                    return
                self._send_json(200, run.to_dict())
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        # Rimette in coda un job fallito (o tutti se jobId manca).
        if self.path == '/api/pack/retry':
            try:
                body = self._read_json_body()
                run = PACK_MANAGER.retry(body.get("runId"), body.get("jobId"))
                if not run:
                    self._send_json(404, {"error": "Pack non trovato."})
                    return
                self._send_json(200, run.to_dict())
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if self.path == "/api/texture":
            # Genera una o piu' FACCE di texture in pixel art come liste di
            # comandi 2D. Il server non disegna: espandere le ops sulla tela e'
            # compito di `expandPixelOps` nel browser (vedi il blocco TEXTURE AI
            # qui sopra), qui si valida solo la forma della risposta.
            try:
                content_length = int(self.headers.get('Content-Length') or 0)
            except (TypeError, ValueError):
                content_length = 0
            if content_length <= 0:
                self._send_json(400, {"error": "Corpo della richiesta mancante."})
                return
            answer = None
            try:
                payload = json.loads(self.rfile.read(content_length).decode('utf-8'))
            except Exception as e:                              # noqa: BLE001
                self._send_json(400, {"error": "Richiesta non valida: %s" % e})
                return
            # Un corpo JSON che sia una LISTA fa sollevare `payload.get`, e un
            # `prompt` non testuale (un numero) fa sollevare `.strip()`.
            # Un'eccezione dentro l'handler non diventa un 500: socketserver
            # stampa il traceback e chiude il socket, quindi il client vede
            # "connessione persa" senza codice ne' messaggio. Modello della
            # guardia: PixelAIEditor/main.py:330-340.
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "Richiesta non valida: atteso un oggetto."})
                return
            prompt = str(payload.get("prompt") or "").strip()
            if not prompt:
                self._send_json(400, {"error": "Descrizione della texture mancante."})
                return
            faces = payload.get("faces") or []
            if not isinstance(faces, (list, tuple)):
                faces = [faces]

            try:
                final_prompt = build_pixel_prompt(prompt, faces,
                                                  payload.get("context"),
                                                  payload.get("size"))
                answer = ai_answer_text_retrying(final_prompt, payload.get("model"))
            except (AIAuthError, AITransientError) as e:
                self._send_ai_error(e, "TEXTURE AI")
                return
            except Exception as e:                              # noqa: BLE001
                self._send_ai_error(_classify_ai_error(e), "TEXTURE AI")
                return

            sys.path.insert(0, os.path.join(BASE_DIR, "src"))
            from parser import extract_and_parse_json
            try:
                raw = extract_and_parse_json(answer)
            except Exception as e:                              # noqa: BLE001
                self._log_ai_answer("TEXTURE AI", answer, e)
                self._send_json(400, {
                    "error": "Il modello non ha restituito JSON. Riprova, "
                             "eventualmente riformulando la descrizione. "
                             "Dettaglio: %s" % e,
                    "rawPreview": (answer or "")[:400],
                })
                return

            tex = normalize_pixel_data(raw, faces)
            if not tex.get("faces"):
                self._log_ai_answer("TEXTURE AI", answer, None)
                detail = ["Il modello ha risposto ma nessun comando e' utilizzabile."]
                if tex.get("unknownFaces"):
                    detail.append("Facce non riconosciute: %s."
                                  % ", ".join(tex["unknownFaces"][:12]))
                for w in (tex.get("warnings") or [])[:5]:
                    detail.append(w + ".")
                detail.append("Riprova: spesso basta rigenerare.")
                self._send_json(400, {
                    "error": " ".join(detail),
                    "unknownFaces": tex.get("unknownFaces", []),
                    "warnings": tex.get("warnings", []),
                    "rawPreview": (answer or "")[:400],
                })
                return

            if tex.get("warnings") or tex.get("unknownFaces"):
                print("[texture] risposta normalizzata con avvisi: %s"
                      % json.dumps({"unknownFaces": tex.get("unknownFaces", []),
                                    "warnings": tex.get("warnings", [])},
                                   ensure_ascii=False))
            self._send_json(200, tex)
            return

        # La tela 2D di PixelAIEditor aperto nell'iframe: rotta a se', vedi
        # _handle_texture2d. `/api/texture` qui sopra resta intatta.
        if self.path == "/api/texture2d":
            self._handle_texture2d()
            return

        if self.path == "/api/animate":
            # Genera UNA clip di animazione a keyframe per lo scheletro corrente,
            # a partire da un prompt in linguaggio naturale. Ritorna il JSON dei
            # track (bone/rot/pos): il frontend lo trasforma in AnimationClip.
            try:
                content_length = int(self.headers.get('Content-Length') or 0)
            except (TypeError, ValueError):
                content_length = 0
            if content_length <= 0:
                self._send_json(400, {"error": "Corpo della richiesta mancante."})
                return
            answer = None
            try:
                payload = json.loads(self.rfile.read(content_length).decode('utf-8'))
            except Exception as e:                              # noqa: BLE001
                self._send_json(400, {"error": "Richiesta non valida: %s" % e})
                return
            # Stessa guardia di /api/texture, per lo stesso motivo: un corpo non
            # dizionario fa sollevare `payload.get` e un `prompt` non testuale
            # `.strip()`, e un'eccezione qui non diventa un 500 - il socket si
            # chiude e il client non riceve NESSUNA risposta HTTP.
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "Richiesta non valida: atteso un oggetto."})
                return
            prompt = str(payload.get("prompt") or "").strip()
            bones = payload.get("bones") or []
            if not isinstance(bones, (list, tuple)):
                bones = []
            if not prompt:
                self._send_json(400, {"error": "Descrizione dell'animazione mancante."})
                return

            try:
                final_prompt = build_anim_prompt(prompt, bones)
                answer = ai_answer_text_retrying(final_prompt, payload.get("model"))
            except (AIAuthError, AITransientError) as e:
                self._send_ai_error(e, "ANIMAZIONE AI")
                return
            except Exception as e:                              # noqa: BLE001
                self._send_ai_error(_classify_ai_error(e), "ANIMAZIONE AI")
                return

            # Il modello ha risposto: da qui in poi il problema e' di FORMATO, e
            # va detto in chiaro (un 500 con str(e) faceva vedere all'utente solo
            # "Errore animazione: Expecting property name...").
            sys.path.insert(0, os.path.join(BASE_DIR, "src"))
            from parser import extract_and_parse_json
            try:
                raw = extract_and_parse_json(answer)
            except Exception as e:                              # noqa: BLE001
                self._log_ai_answer("ANIMAZIONE AI", answer, e)
                self._send_json(400, {
                    "error": "Il modello non ha restituito JSON. Riprova, "
                             "eventualmente riformulando la descrizione. "
                             "Dettaglio: %s" % e,
                    "rawPreview": (answer or "")[:400],
                })
                return

            anim = normalize_anim_data(raw, bones)
            if not anim.get("tracks"):
                self._log_ai_answer("ANIMAZIONE AI", answer, None)
                detail = ["Il modello ha risposto ma nessun track e' utilizzabile."]
                if anim.get("unknownBones"):
                    detail.append("Ossa inventate dall'AI: %s."
                                  % ", ".join(anim["unknownBones"][:12]))
                if bones:
                    detail.append("Ossa disponibili: %s."
                                  % ", ".join(str(b) for b in list(bones)[:20]))
                for w in (anim.get("warnings") or [])[:5]:
                    detail.append(w + ".")
                detail.append("Riprova: spesso basta rigenerare.")
                self._send_json(400, {
                    "error": " ".join(detail),
                    "unknownBones": anim.get("unknownBones", []),
                    "availableBones": [str(b) for b in bones],
                    "warnings": anim.get("warnings", []),
                    "rawPreview": (answer or "")[:400],
                })
                return

            if anim.get("warnings") or anim.get("unknownBones"):
                print("[animate] clip normalizzata con avvisi: %s"
                      % json.dumps({"unknownBones": anim.get("unknownBones", []),
                                    "warnings": anim.get("warnings", [])},
                                   ensure_ascii=False))
            self._send_json(200, anim)
            return

        if self.path == "/api/generate":
            # `self.headers['Content-Length']` e' None se l'header manca, e
            # int(None) solleva TypeError FUORI dal try: il thread muore e la
            # connessione si chiude senza alcuna risposta HTTP (il client vede
            # un errore di rete inspiegabile). Il default a 0 rende il caso un
            # 400 pulito gestito dal blocco except sotto.
            try:
                content_length = int(self.headers.get('Content-Length') or 0)
            except (TypeError, ValueError):
                content_length = 0
            if content_length <= 0:
                self._send_json(400, {"error": "Corpo della richiesta mancante o Content-Length assente."})
                return
            post_data = self.rfile.read(content_length)
            # Inizializzata prima del try: l'except finale la passa a
            # _log_ai_answer, e senza questa riga un errore sollevato PRIMA
            # della chiamata all'AI diventerebbe un NameError.
            answer = None
            try:
                payload = json.loads(post_data.decode('utf-8'))
                prompt = payload.get("prompt", "")
                grid_size = payload.get("gridSize", "auto")
                mode = payload.get("mode", "generate")
                single_object = payload.get("single_object", True)

                prompts_dir = os.path.join(BASE_DIR, "assets", "prompts")

                if mode == "modify":
                    current_model = payload.get("currentModel", {})
                    current_model_str = json.dumps(current_model, separators=(',', ':'))

                    # Contesto compatto: griglia, palette e bounding-box della forma
                    # attuale. Serve all'AI per capire DOVE stanno le parti senza
                    # doversi ricostruire tutto il modello (la modifica ora e' un
                    # DIFF: vedi prompt-edit.txt). Il bbox si ricava espandendo le
                    # ops in voxel (riusa expand_ops, lo stesso del resto dell'app).
                    ctx_lines = []
                    try:
                        meta = current_model.get("metadata", {}) if isinstance(current_model, dict) else {}
                        grid = meta.get("grid_size")
                        if grid:
                            ctx_lines.append(f"Griglia (grid_size): {grid}")
                        pal = current_model.get("palette") if isinstance(current_model, dict) else None
                        if isinstance(pal, dict) and pal:
                            ctx_lines.append("Palette attuale (chiave -> colore): " +
                                             json.dumps(pal, ensure_ascii=False))
                        sys.path.insert(0, os.path.join(BASE_DIR, "src"))
                        from parser import expand_ops as _expand_ops
                        expanded = _expand_ops(dict(current_model)) if isinstance(current_model, dict) else None
                        vox = (expanded or {}).get("voxels") or []
                        if vox:
                            xs = [v["x"] for v in vox]; ys = [v["y"] for v in vox]; zs = [v["z"] for v in vox]
                            ctx_lines.append(
                                f"Bounding box occupato: X[{min(xs)}..{max(xs)}] "
                                f"Y[{min(ys)}..{max(ys)}] Z[{min(zs)}..{max(zs)}] "
                                f"({len(vox)} voxel totali)")
                    except Exception:
                        pass
                    context_str = "\n".join(ctx_lines) if ctx_lines else "(nessun dato aggiuntivo)"

                    prompt_edit_path = os.path.join(prompts_dir, "prompt-edit.txt")
                    if os.path.exists(prompt_edit_path):
                        with open(prompt_edit_path, 'r', encoding='utf-8') as pef:
                            prompt_edit_template = pef.read()
                    else:
                        prompt_edit_template = (
                            "Sei un Voxel Artist AI esperto. Restituisci SOLO una patch "
                            "JSON { \"palette\": {...}, \"ops\": [...] } che modifica il modello.\n\n"
                            "Contesto:\n[INSERISCI QUI IL CONTESTO]\n\n"
                            "Modello attuale:\n[INSERISCI QUI IL MODELLO ATTUALE]\n\n"
                            "Richiesta:\n[INSERISCI QUI LA RICHIESTA DI MODIFICA]"
                        )
                    final_prompt = prompt_edit_template.replace("[INSERISCI QUI IL CONTESTO]", context_str)
                    final_prompt = final_prompt.replace("[INSERISCI QUI IL MODELLO ATTUALE]", current_model_str)
                    final_prompt = final_prompt.replace("[INSERISCI QUI LA RICHIESTA DI MODIFICA]", prompt)

                else:
                    prompt_template_path = os.path.join(prompts_dir, "prompt.txt")
                    if os.path.exists(prompt_template_path):
                        with open(prompt_template_path, 'r', encoding='utf-8') as pf:
                            prompt_template = pf.read()
                    else:
                        prompt_template = "Generate voxel model: [INSERISCI QUI IL MODELLO DESIDERATO]"

                    if "[INSERISCI QUI IL MODELLO DESIDERATO]" in prompt_template:
                        final_prompt = prompt_template.replace("[INSERISCI QUI IL MODELLO DESIDERATO]", prompt)
                    else:
                        final_prompt = prompt_template.strip() + " " + prompt

                    final_prompt = (
                        f"SOGGETTO DA GENERARE: {prompt}\n\n"
                        "IMPORTANTE: Progetta da zero le coordinate per rappresentare fedelmente questo soggetto. "
                        "Non copiare le coordinate o la topologia della torre dell'esempio.\n\n"
                        + final_prompt
                    )

                # Modalita' struttura grande: istruzioni esplicite, altrimenti l'AI
                # genera un oggetto piccolo anche su una griglia enorme.
                if payload.get("bigStructure"):
                    final_prompt += BIG_STRUCTURE_RULE

                if payload.get("modular"):
                    final_prompt += MODULAR_ASSET_RULE

                # La regola umanoide pretende il formato "parts" (una parte per
                # arto): se l'utente l'ha attivata lasciando "oggetto unico",
                # il multi-parte va aggiunto comunque, altrimenti i nomi degli
                # arti non avrebbero dove stare.
                humanoid = bool(payload.get("humanoid"))
                if humanoid or not single_object:
                    final_prompt += MULTI_PART_RULE
                if humanoid:
                    final_prompt += HUMANOID_RULE

                if grid_size != "auto":
                    dims = grid_size.split('x')
                    if len(dims) == 3:
                        final_prompt += (
                            f"\n\n[REGOLA TASSATIVA: L'utente ha richiesto esplicitamente la griglia {grid_size}. "
                            f"Nel metadata JSON imposta ASSOLUTAMENTE 'grid_size': [{dims[0]}, {dims[1]}, {dims[2]}]. "
                            "Sfrutta tutta la griglia per aggiungere dettagli!]"
                        )

                # Stessa creazione client / gestione cookie / classificazione
                # errori di /api/animate e della coda pack: nessuna duplicazione.
                answer = ai_answer_text_retrying(final_prompt, payload.get("model"))

                sys.path.insert(0, os.path.join(BASE_DIR, "src"))
                from parser import extract_and_parse_json
                try:
                    model_data = extract_and_parse_json(answer)
                except Exception as e:                          # noqa: BLE001
                    self._log_ai_answer("GENERAZIONE", answer, e)
                    self._send_json(400, {
                        "error": "Il modello non ha restituito JSON. Riprova. "
                                 "Dettaglio: %s" % e,
                        "rawPreview": (answer or "")[:400],
                    })
                    return

                self._send_json(200, model_data)

            except (AIAuthError, AITransientError) as e:
                self._send_ai_error(e, "GENERAZIONE")
            except Exception as e:                              # noqa: BLE001
                self._log_ai_answer("GENERAZIONE", answer, e)
                self._send_json(500, {"error": str(e)})
        else:
            super().do_POST()


def start_server():
    global PORT
    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer(("127.0.0.1", 0), VoxelAIRequestHandler)
    PORT = server.server_address[1]
    print(f"Server started on port {PORT}")
    server.serve_forever()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        global MAIN_WINDOW
        MAIN_WINDOW = self
        self.setWindowTitle("VoxelAI Artist - KFDev")
        self.resize(1280, 720)

        self.browser = QWebEngineView()
        self.browser.setPage(WebEnginePage(self.browser))

        # Anti-flicker: di default QWebEngineView dipinge la pagina su BIANCO.
        # Con WebGL (alpha:true) + i backdrop-filter blur, durante repaint/resize
        # il compositor di Qt mostra per un frame quel bianco -> lampeggio. Forzando
        # lo sfondo pagina su un colore scuro (in tinta col gradiente della UI) il
        # frame intermedio combacia e il flicker sparisce. Coloriamo solo la PAGINA
        # web e il widget del browser: NON la palette della finestra, altrimenti i
        # dialog nativi (confirm()/alert() di QtWebEngine) ereditano il fondo scuro
        # ma tengono il testo scuro -> nero-su-nero illeggibile.
        _bg = QColor("#09070f")
        self.browser.page().setBackgroundColor(_bg)
        self.browser.setStyleSheet("background:#09070f;")

        settings = self.browser.settings()
        try:
            settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        except AttributeError:
            try:
                settings.setAttribute(QWebEngineSettings.LocalContentCanAccessRemoteUrls, True)
            except Exception:
                pass

        self.browser.page().profile().downloadRequested.connect(self.on_downloadRequested)

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.browser)

        container = QWidget()
        container.setLayout(layout)
        self.setCentralWidget(container)

        # Anti-flicker all'avvio: NON mostriamo la finestra finche' la prima pagina
        # non ha finito di caricare, cosi' l'utente non vede il frame bianco/vuoto
        # iniziale. Un timer di sicurezza la mostra comunque se loadFinished non
        # arrivasse (es. errore di rete locale), per non lasciare l'app invisibile.
        self._shown = False
        self.browser.loadFinished.connect(self._reveal_when_ready)
        QTimer.singleShot(4000, self._force_reveal)

        self._build_menu()
        self.reload_page()

        reload_action = QAction(self)
        reload_action.setShortcuts([QKeySequence("F5"), QKeySequence("Ctrl+R")])
        reload_action.triggered.connect(self.reload_page)
        self.addAction(reload_action)

    def _reveal_when_ready(self, ok):
        if not self._shown:
            self._shown = True
            self.show()

    def _force_reveal(self):
        if not self._shown:
            self._shown = True
            self.show()


    def _build_menu(self):
        menubar = self.menuBar()
        file_menu = menubar.addMenu("File")

        new_action = QAction("Nuovo Progetto", self)
        new_action.triggered.connect(lambda: self.browser.page().runJavaScript("if(window.clearAll) clearAll();"))
        file_menu.addAction(new_action)

        file_menu.addSeparator()

        settings_action = QAction("⚙ Impostazioni...", self)
        settings_action.triggered.connect(self.open_settings)
        file_menu.addAction(settings_action)

    def _page_url(self, name):
        """URL HTTP della pagina desktop. Il flag ?desktop=1 dice al server di
        iniettare window.__IS_DESKTOP__/__API_BASE__ (vedi _serve_html_injected)."""
        rel = "ui/settings.html" if name == "settings" else "ui/index.html"
        return QUrl(f"http://127.0.0.1:{PORT}/{rel}?desktop=1")

    def reload_page(self):
        self.browser.setUrl(self._page_url("index"))

    def open_settings(self):
        """Impostazioni: apre il pannello NATIVO (FASE 3a migrazione). Il dialog
        nativo compare SOPRA il viewport 3D senza far navigare via la webview e usa
        uno "Sfoglia" nativo che funziona sempre. Se l'import fallisce, fallback
        alla vecchia pagina HTML."""
        try:
            from native.settings_dialog import SettingsDialog
            dlg = SettingsDialog(self, app_settings, open_web_settings=self.open_settings_web)
            dlg.exec()
        except Exception as e:
            print(f"[native] pannello impostazioni nativo non disponibile: {e}")
            self.open_settings_web()

    def open_settings_web(self):
        self.browser.setUrl(self._page_url("settings"))

    def save_project_dialog(self):
        """Apre 'Salva con nome' (filtro .voxai) sul thread GUI. Ritorna il path
        scelto oppure None se annullato. Chiamare SOLO via _run_on_gui."""
        default_dir = app_settings.get_setting("default_save_dir")
        if not default_dir or not os.path.exists(default_dir):
            default_dir = app_settings.get_appdata_dir()
        default_name = os.path.join(default_dir, "progetto.voxai")
        path, _ = QFileDialog.getSaveFileName(
            self, "Salva progetto", default_name, "Progetto VoxelAI (*.voxai)"
        )
        return path or None

    def choose_dir_dialog(self):
        """Apre il selettore cartella NATIVO sul thread GUI e ritorna il path
        scelto (o None se annullato). Chiamare SOLO via _run_on_gui."""
        start_dir = app_settings.get_setting("default_save_dir")
        if not start_dir or not os.path.exists(start_dir):
            start_dir = ""
        # Porta la finestra in primo piano: su Windows un dialog nativo puo'
        # comparire DIETRO la surface GPU della webview se la finestra non ha il
        # focus. raise_()/activateWindow() forzano il dialog in foreground.
        try:
            self.raise_()
            self.activateWindow()
        except Exception:
            pass
        path = QFileDialog.getExistingDirectory(self, "Seleziona cartella", start_dir)
        return path or None

    def open_project_dialog(self):
        """Apre 'Apri file' (voxai/json/vox/schem) sul thread GUI e ritorna il
        contenuto. Per .voxai/.json → JSON come oggetto; per binari .vox/.schem
        → base64 + estensione (il parsing binario lo fa il frontend/endpoint
        dedicato). Ritorna None se annullato. Chiamare SOLO via _run_on_gui."""
        filt = (
            "Tutti i formati supportati (*.voxai *.json *.vox *.schem);;"
            "Progetto VoxelAI (*.voxai);;JSON (*.json);;"
            "MagicaVoxel (*.vox);;Minecraft schematic (*.schem);;Tutti i file (*)"
        )
        default_dir = app_settings.get_setting("default_save_dir")
        if not default_dir or not os.path.exists(default_dir):
            default_dir = ""
        path, _ = QFileDialog.getOpenFileName(self, "Apri progetto", default_dir, filt)
        if not path:
            return None
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        if ext in ("voxai", "json"):
            with open(path, "r", encoding="utf-8") as f:
                content = json.load(f)
            return {"path": path, "ext": ext, "encoding": "json", "content": content}
        # binari (.vox/.schem o sconosciuti): ritorna i byte in base64
        with open(path, "rb") as f:
            raw = f.read()
        return {
            "path": path,
            "ext": ext,
            "encoding": "base64",
            "content": base64.b64encode(raw).decode("ascii"),
        }

    def on_downloadRequested(self, downloadItem):
        default_name = downloadItem.suggestedFileName()
        default_dir = app_settings.get_setting("default_save_dir")
        if default_dir and os.path.exists(default_dir):
            default_path = os.path.join(default_dir, default_name)
        else:
            default_path = default_name
            
        path, _ = QFileDialog.getSaveFileName(self, "Salva File", default_path)
        if path:
            if hasattr(downloadItem, 'setDownloadDirectory'):
                downloadItem.setDownloadDirectory(os.path.dirname(path))
                downloadItem.setDownloadFileName(os.path.basename(path))
            elif hasattr(downloadItem, 'setPath'):
                downloadItem.setPath(path)
            downloadItem.accept()


def _print_cookie_hint():
    """Avvisa a console se non ci sono cookie salvati.

    Prima qui si apriva d'autorita' la vecchia pagina ui/settings.html: in
    modalita' web avrebbe dirottato la pagina appena aperta e comunque la UI ha
    ora il suo modale Impostazioni interno, che si apre da se' leggendo
    `needsCookies` da GET /api/settings. Quindi: solo un avviso, niente
    navigazione forzata.
    """
    try:
        if app_settings.has_cookies():
            return
    except Exception as e:  # noqa: BLE001 - un errore qui non deve bloccare l'avvio
        print(f"[cookie] impossibile verificare i cookie: {e}")
        return
    print("-" * 78)
    print(" Nessun cookie salvato: la generazione AI non funzionera' finche' non")
    print(" li incolli in Impostazioni (dentro l'app).")
    try:
        print(f" Cartella dati: {app_settings.get_appdata_dir()}")
    except Exception:
        pass
    print("-" * 78)


def run_web_mode():
    """Modalita' "web": nessuna finestra Qt, la UI si apre nel browser.

    Il server e' gia' avviato dal chiamante (PORT valorizzato). Qui apriamo la
    pagina e teniamo vivo il processo: il server gira su un thread daemon, se il
    main thread finisse morirebbe tutto insieme a lui.
    """
    url = f"http://127.0.0.1:{PORT}/ui/index.html"
    print("")
    print("=" * 78)
    print(" VoxelAI Artist - MODALITA' WEB (nessuna finestra Qt, niente flicker)")
    print(f" Interfaccia: {url}")
    print(f" Server:      http://127.0.0.1:{PORT}")
    print(" Per chiudere: premi Ctrl+C in questa finestra.")
    print(" Per la finestra desktop: python main.py --py")
    print("=" * 78)
    print("")
    try:
        webbrowser.open(url)
    except Exception as e:  # noqa: BLE001 - senza browser il server resta usabile
        print(f"[web] impossibile aprire il browser ({e}): apri a mano {url}")
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        # Ctrl+C pulito: senza questo si vede un traceback su time.sleep.
        print("\nServer arrestato. A presto.")
    return 0


def run_py_mode():
    """Modalita' "py": finestra desktop Qt con la webview embedded."""
    # ANTI-FLICKER (causa radice). Il QWebEngineView usa una surface OpenGL/ANGLE
    # composita da Chromium. Senza contesto GL condiviso, quando la view passa in
    # modalita' GPU Qt RICREA la finestra nativa: e' il "sparisce e riappare" che
    # si vede a schermo. AA_ShareOpenGLContexts va impostato PRIMA di creare la
    # QApplication, altrimenti non ha effetto. Fallback getattr per PyQt5/6/PySide6.
    try:
        _aa = getattr(Qt, 'ApplicationAttribute', Qt)
        QApplication.setAttribute(getattr(_aa, 'AA_ShareOpenGLContexts'), True)
    except Exception as _e:
        print(f"[gl] AA_ShareOpenGLContexts non impostabile: {_e}")
    app = QApplication(sys.argv)
    _apply_dark_palette(app)
    window = MainWindow()  # noqa: F841 - il riferimento vive in MAIN_WINDOW
    # NIENTE apertura automatica delle impostazioni: se mancano i cookie e' la UI
    # ad aprire il proprio modale (vedi needsCookies in /api/settings).
    # La finestra si mostra da sola dopo il primo loadFinished (anti-flicker):
    # vedi MainWindow._reveal_when_ready. Niente window.show() qui.
    try:
        return app.exec()
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    # PORT = 0 -> l'OS sceglie una porta libera; il thread server la pubblica.
    while PORT == 0:
        time.sleep(0.1)

    _print_cookie_hint()

    mode = APP_MODE
    if mode == "py" and not GUI_AVAILABLE:
        # Nessun binding Qt importabile: invece di morire, degradiamo a web.
        print("")
        print("=" * 78)
        print(" ATTENZIONE: modalita' 'py' richiesta ma nessun binding Qt disponibile.")
        print(" Installa PyQt6 (pip install PyQt6 PyQt6-WebEngine) oppure usa la")
        print(" modalita' web. Passo automaticamente a 'web'.")
        print("=" * 78)
        mode = "web"

    if mode == "py":
        print(f"[avvio] modalita' 'py' (finestra desktop, {GUI_LIBRARY})")
        sys.exit(run_py_mode())
    else:
        sys.exit(run_web_mode())

