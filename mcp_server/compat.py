"""Ponte verso `src/`: gli stessi moduli che usa l'app, non una seconda copia.

Il server MCP deve espandere le ops, parlare con l'AI e leggere le impostazioni
ESATTAMENTE come fa `main.py`. Reimplementare qui una qualunque di queste cose
creerebbe una seconda semantica da tenere allineata a mano — che e' gia' costato
tre difetti veri sul solo espansore delle ops (vedi `tests/ops_parity_cases.json`).

I moduli di `src/` si importano piatti (`import parser`, `import settings`), quindi
`src/` va messo in `sys.path`. Va messo in CODA e non in testa: `parser` e'
anche un modulo della libreria standard, e anteporre la cartella lo
ombreggerebbe per l'intero processo — compreso qualunque pacchetto di terze parti
che se lo aspetti. In coda vince invece la stdlib per chi non ha gia' importato
il nostro, e il nostro si raggiunge col percorso esplicito qui sotto.
"""

import contextlib
import importlib.util
import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE_DIR, "src")

if SRC_DIR not in sys.path:
    sys.path.append(SRC_DIR)


def _load(name):
    """Importa un modulo di `src/` PER PERCORSO.

    Non `import parser`: quel nome esiste anche nella stdlib (deprecato ma
    presente su varie versioni) e chi vince dipende dall'ordine di `sys.path`,
    cioe' da chi ha importato cosa prima di noi. Caricarlo per percorso rende
    l'esito indipendente dall'ordine.

    Il modulo viene registrato in `sys.modules` col suo nome piatto perche' i
    moduli di `src/` si importano fra loro cosi' (`aiclient` fa `import pack`):
    saltare la registrazione li farebbe caricare due volte, con due copie dello
    stato globale — e lo stato globale c'e' davvero (la coda dei pack).
    """
    if name in sys.modules:
        return sys.modules[name]
    path = os.path.join(SRC_DIR, name + ".py")
    if not os.path.isfile(path):
        raise ImportError("modulo '%s' non trovato in %s" % (name, SRC_DIR))
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return mod


_parser = _load("parser")

expand_ops = _parser.expand_ops
extract_and_parse_json = _parser.extract_and_parse_json
voxel_budget_for = _parser.voxel_budget_for


def settings_module():
    return _load("settings")


def pixelprompt_module():
    return _load("pixelprompt")


def aiclient_module():
    """Il client AI. Import PIGRO: tira dentro `pack` e, alla prima chiamata,
    il pacchetto `gemini`. Un client MCP che voglia solo aprire e convertire un
    file non deve pagare quel costo ne' fallire se `gemini` non e' installato."""
    return _load("aiclient")


def pack_module():
    return _load("pack")


@contextlib.contextmanager
def quiet():
    """Dirotta `print` su stderr per la durata del blocco.

    STDOUT E' IL CANALE DEL PROTOCOLLO MCP: una riga stampata li' dentro
    corrompe il messaggio JSON-RPC e il client si chiude senza dire perche'
    (vedi la nota in `server.main`). Il codice dell'app stampa eccome — avvisi
    sui prompt illeggibili, diagnostica dell'AI, la coda dei pack — e non deve
    essere riscritto per questo: si dirotta il suo stdout mentre gira.

    Sostituire `sys.stdout` non disturba il trasporto: `stdio_server` avvolge
    lo stream UNA volta all'avvio e tiene il proprio riferimento, quindi
    continua a scrivere sul vero stdout anche mentre questo blocco e' aperto.
    """
    with contextlib.redirect_stdout(sys.stderr):
        yield


class _StdoutProxy(object):
    """Il TESTO va su stderr, il BINARIO resta lo stdout vero.

    `quiet()` protegge un blocco, e per la maggior parte del codice dell'app
    basta. Non basta per la CODA DEI PACK: gira in thread propri e stampa
    quando salva un pack, cioe' a un momento che nessun `with` di qui
    racchiude. Una riga li' dentro corrompe il messaggio JSON-RPC in volo, e il
    client si chiude senza dire perche' — misurato: `[pack] salvato in ...`
    finiva davvero sul canale del protocollo.

    La separazione funziona perche' i due usi di `sys.stdout` sono distinti:
    `print` passa da `write`, il trasporto MCP legge `.buffer` (avvolge
    `sys.stdout.buffer` in un `TextIOWrapper` UTF-8 all'avvio). Quindi `write`
    finisce su stderr e `.buffer` continua a essere lo stdout autentico.

    `buffer_used` registra se il trasporto ha davvero preso `.buffer`: se un
    domani l'SDK avvolgesse `sys.stdout` come testo, il protocollo uscirebbe su
    stderr e il server sarebbe morto in silenzio. Cosi' invece lo si dice.
    """

    def __init__(self, text, binary):
        object.__setattr__(self, "_text", text)
        object.__setattr__(self, "_binary", binary)
        object.__setattr__(self, "buffer_used", False)

    @property
    def buffer(self):
        object.__setattr__(self, "buffer_used", True)
        return self._binary

    def write(self, s):
        return self._text.write(s)

    def writelines(self, lines):
        return self._text.writelines(lines)

    def flush(self):
        try:
            self._text.flush()
        except (ValueError, OSError):
            pass

    def isatty(self):
        return False

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(object.__getattribute__(self, "_text"), name)


def protect_stdout():
    """Blinda stdout per l'intero processo. Ritorna il proxy, o None.

    Due strati, per due modi diversi di sporcare il canale:

    - `sys.stdout` diventa il proxy qui sopra: ogni `print` di Python va su
      stderr, anche da un thread, anche dopo il ritorno di questa funzione.
    - il descrittore 1 viene puntato sul 2 (`dup2`): copre chi scrive sul
      descrittore senza passare da Python — una libreria in C, un
      sottoprocesso che eredita gli handle. Il vero stdout sopravvive nella
      copia privata (`dup`) che il proxy consegna come `.buffer`.

    Se qualcosa non e' disponibile (stdout catturato dalle prove, nessun
    descrittore reale) si degrada invece di sollevare: perdere la protezione e'
    un fastidio, non far partire il server e' un guasto.
    """
    try:
        real = sys.stdout
        binary = getattr(real, "buffer", real)
        try:
            fd = real.fileno()
        except (AttributeError, ValueError, OSError):
            fd = None
        if fd is not None:
            saved = os.dup(fd)
            binary = os.fdopen(saved, "wb", buffering=0)
            try:
                os.dup2(sys.stderr.fileno(), fd)
            except (AttributeError, ValueError, OSError):
                pass
        proxy = _StdoutProxy(sys.stderr, binary)
        sys.stdout = proxy
        return proxy
    except Exception:                                        # noqa: BLE001
        return None


def main_module():
    """`main.py` dell'app, caricato per percorso e in silenzio.

    E' l'unico posto dove vivono le REGOLE DI PROMPT (struttura grande, asset
    modulare, multi-parte, umanoide), l'assemblaggio dei prompt di pack,
    animazione e texture, e la normalizzazione delle risposte. Riscriverle qui
    darebbe due prompt diversi per lo stesso pulsante: l'app genererebbe una
    cosa e l'MCP un'altra, e la differenza si vedrebbe solo nei risultati.

    Tre precauzioni, ognuna per un modo in cui l'import poteva andare storto:

    - `sys.argv` viene AZZERATO: `_resolve_app_mode` legge gli argomenti del
      processo, e il server MCP viene avviato con i propri (`--workdir ...`).
      Una cartella di lavoro che si chiamasse `py` verrebbe letta come la
      modalita' desktop e farebbe caricare Qt per una finestra che non apriremo.
    - `VOXELAI_MODE` viene forzato a `web`: e' la modalita' senza Qt: nessuna
      DLL di Chromium, nessuna finestra, solo le funzioni pure che ci servono.
    - stdout dirottato (vedi `quiet`).

    Il modulo si registra come `voxelai_main` e non come `main`: `main` e' un
    nome comunissimo e sovrascriverlo in `sys.modules` significherebbe rubarlo
    a chiunque altro nel processo.
    """
    if "voxelai_main" in sys.modules:
        return sys.modules["voxelai_main"]
    path = os.path.join(BASE_DIR, "main.py")
    spec = importlib.util.spec_from_file_location("voxelai_main", path)
    mod = importlib.util.module_from_spec(spec)
    old_argv, old_mode = sys.argv, os.environ.get("VOXELAI_MODE")
    sys.argv = [path]
    os.environ["VOXELAI_MODE"] = "web"
    sys.modules["voxelai_main"] = mod
    try:
        with quiet():
            spec.loader.exec_module(mod)
    except Exception:
        sys.modules.pop("voxelai_main", None)
        raise
    finally:
        sys.argv = old_argv
        if old_mode is None:
            os.environ.pop("VOXELAI_MODE", None)
        else:
            os.environ["VOXELAI_MODE"] = old_mode
    return mod


def providers_module():
    return _load("providers")


def prompt_path(name):
    return os.path.join(BASE_DIR, "assets", "prompts", name)


def read_prompt(name, fallback=""):
    """Legge un template di prompt da `assets/prompts/`.

    In latin1 come il resto del progetto? No: i prompt sono UTF-8 e li scrive
    l'utente. Un carattere illeggibile diventa un carattere di sostituzione
    invece di far fallire la generazione, perche' un accento storto nel prompt
    non e' un motivo per non generare niente.
    """
    path = prompt_path(name)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return fallback
