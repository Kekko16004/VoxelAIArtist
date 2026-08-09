"""
Test del server di PixelAIEditor (`PixelAIEditor/main.py`): `build_prompt` e la
rotta POST /api/texture, piu' la separazione impostazioni / condivisione cookie.

Perche' esiste, dato che tests/test_texture_ai.py copre gia' /api/texture del
padre: le due rotte hanno lo stesso NOME e lo stesso contratto di risposta ma
non lo stesso codice, e le differenze sono proprio dove si sbaglia. Qui la tela
e' UNA e puo' non essere QUADRATA (`width` + `height`), la faccia richiesta e'
sempre `all`, e la risposta porta anche `ops` accanto a `faces`. Il motore
condiviso (`src/pixelprompt.py`, `src/aiclient.py`) e' provato dal test del
padre: qui si prova il CABLAGGIO di questa app.

Il server NON disegna: espandere le ops sulla tela e' compito di
`expandPixelOps` lato browser. Qui si verifica solo che la forma della risposta
AI venga ricondotta al contratto e che una risposta inutilizzabile diventi un
400 spiegato, invece di una tela che resta misteriosamente vuota.

Nessuna rete, nessun cookie, nessuna quota: `gemini` e' stubbato PRIMA
dell'import e le impostazioni vanno in una cartella temporanea.
"""
import os as _os
_HERE = _os.path.dirname(_os.path.abspath(__file__))
REPO_ROOT = _os.path.dirname(_HERE)
import atexit, importlib.util, json, os, re, shutil, sys, tempfile, threading
import time, urllib.error, urllib.request

os.chdir(REPO_ROOT)

# --- Isolamento delle impostazioni ------------------------------------------
# `PixelAIEditor/main.py` chiama `app_settings.set_app_name("PixelAIEditor")` a
# livello di MODULO, e `_appdata_root` (src/settings.py) legge %APPDATA% a ogni
# chiamata creando la cartella. Senza questo dirottamento il test scriverebbe
# nella cartella vera dell'utente.
_TMP_APPDATA = tempfile.mkdtemp(prefix="pixelai_test_")
_PREV_APPDATA = os.environ.get("APPDATA")
os.environ["APPDATA"] = _TMP_APPDATA


def _restore_appdata():
    if _PREV_APPDATA is None:
        os.environ.pop("APPDATA", None)
    else:
        os.environ["APPDATA"] = _PREV_APPDATA
    shutil.rmtree(_TMP_APPDATA, ignore_errors=True)


# Registrata subito: cosi' la pulizia avviene anche quando un check fallisce e
# il test esce con sys.exit(1).
atexit.register(_restore_appdata)

# --- Stub del client AI ------------------------------------------------------
# Va installato PRIMA dell'import: `aiclient._gemini_client` importa `gemini`
# dentro la funzione, quindi basta che il finto sia in sys.modules alla chiamata,
# ma anticiparlo e' l'unica garanzia che nessun percorso tocchi la rete.
import types

stub = types.ModuleType('gemini')


class _FakeResp:
    def __init__(self, t): self.text = t


NEXT_ANSWER = ['{}']
LAST_PROMPT = ['']


class Gemini:
    def __init__(self, *a, **k): pass

    def generate_content(self, prompt):
        LAST_PROMPT[0] = prompt
        v = NEXT_ANSWER[0]
        if isinstance(v, Exception):
            raise v
        return _FakeResp(v)


stub.Gemini = Gemini
sys.modules['gemini'] = stub

# --- Import del modulo sotto test -------------------------------------------
# `PixelAIEditor/main.py` collide di nome col `main.py` del padre, che altri
# test della suite importano nello stesso interprete solo in teoria (ogni test
# e' un processo) ma che qui sarebbe comunque la scelta sbagliata: un `import
# main` prenderebbe quello del padre, che sta sul sys.path della radice. Si
# carica dal PERCORSO, sotto un nome distinto.
_PIX_MAIN = os.path.join(REPO_ROOT, "PixelAIEditor", "main.py")
_spec = importlib.util.spec_from_file_location("pixmain", _PIX_MAIN)
pixmain = importlib.util.module_from_spec(_spec)
sys.modules["pixmain"] = pixmain
_spec.loader.exec_module(pixmain)

# `PixelAIEditor/main.py` fa `sys.path.insert(0, _src_dir())`: se l'import qui
# sopra e' andato a buon fine, `src/` e' raggiungibile e questi tre moduli sono
# gli STESSI oggetti che il server usa.
import aiclient
import pixelprompt
import settings as app_settings

fails = []


def check(cond, msg):
    if not cond:
        print("  FAIL " + msg); fails.append(msg)
    else:
        print("  OK  " + msg)


check(pixmain.__file__ == _PIX_MAIN,
      "PixelAIEditor/main.py importato dal percorso (non il main del padre)")
check(os.path.samefile(pixmain._src_dir(), os.path.join(REPO_ROOT, "src")),
      "src/ condiviso risolto e importabile (settings, pixelprompt, aiclient, parser)")
check(pixmain.APP_MODE == "web", "modalita' d'avvio risolta a 'web'")

# Il backoff dell'endpoint interattivo e' reale (20 s): non ritentare a velocita'
# reale nel test. Si sostituisce il MODULO time visto da aiclient, non
# `time.sleep` globale, cosi' il resto del test misura ancora il tempo vero.
class _FastTime:
    def __init__(self, real):
        self._real = real
        self.slept = []

    def sleep(self, seconds):
        self.slept.append(seconds)

    def __getattr__(self, name):
        return getattr(self._real, name)


_fast_time = _FastTime(time)
aiclient.time = _fast_time
check(aiclient._interactive_backoff() == [20],
      "un solo ritento entro il budget interattivo (%ds)"
      % aiclient.INTERACTIVE_RETRY_BUDGET_SECONDS)


# --- A. build_prompt ---------------------------------------------------------
def _declared_size(prompt):
    """Dimensione dichiarata nella sezione TELA, come coppia (w, h).

    Non si cerca la stringa nel prompt INTERO: il template nomina altre
    dimensioni negli esempi ("una tela 64x64 sono 4096 pixel", "su una tela
    32x32 l'ultimo pixel e' (31,31)"), quindi `"32x32" in prompt` e' vero anche
    per una tela 32x48 e la verifica del non-quadrato non avrebbe denti.
    """
    for line in prompt.split("\n"):
        if "griglia di" in line:
            m = re.search(r"(\d+)x(\d+)", line)
            if m:
                return (int(m.group(1)), int(m.group(2)))
    return None


p = pixmain.build_prompt("un cavaliere con la spada", 32, 48)
check(_declared_size(p) == (32, 48),
      "la dimensione e' dichiarata LARGHEZZAxALTEZZA (32x48)")
check("32x48" in p, "la coppia larghezza-altezza compare nel prompt")
# E' LA differenza dal padre: la' la faccia di un cubo e' sempre quadrata, qui
# uno sprite 32x48 deve restare 32x48. Un lato solo nel prompt farebbe disegnare
# all'AI in un rettangolo diverso da quello che la tela ha davvero.
check(_declared_size(pixmain.build_prompt("x", 20, 48)) == (20, 48),
      "una tela non quadrata NON diventa quadrata")
check(_declared_size(pixmain.build_prompt("x", 24)) == (24, 24),
      "omettendo l'altezza la tela e' quadrata")
check(_declared_size(pixmain.build_prompt("x", 24, None)) == (24, 24),
      "altezza None equivale a omessa")
check(_declared_size(pixmain.build_prompt("x", None)) == (16, 16),
      "dimensione mancante -> default %d" % pixelprompt.PIXEL_DEFAULT_SIDE)
check(_declared_size(pixmain.build_prompt("x", 9999, 9999)) == (128, 128),
      "dimensione fuori scala -> tetto %d" % pixelprompt.PIXEL_MAX_SIDE)
check(_declared_size(pixmain.build_prompt("x", 1, 2)) == (4, 4),
      "dimensione sotto il minimo -> %d" % pixelprompt.PIXEL_MIN_SIDE)
check(_declared_size(pixmain.build_prompt("x", 9999, 1)) == (128, 4),
      "i due lati sono riportati nei limiti in modo indipendente")
check(_declared_size(pixmain.build_prompt("x", "32", "48")) == (32, 48),
      "dimensione come stringa (arriva da un input HTML) accettata")

check("un cavaliere con la spada" in p, "la richiesta dell'utente finisce nel prompt")
check("[INSERISCI QUI" not in p, "nessun segnaposto rimasto nel prompt")
check(p.rstrip("\n").split("\n")[-1].strip() == "un cavaliere con la spada",
      "la richiesta e' l'ultima cosa che l'AI legge")
check("`mirror " in p and "`noise " in p and "`del " in p,
      "il prompt documenta i comandi compatti (mirror, noise, del)")
check("ALTO A SINISTRA" in p,
      "il prompt dichiara l'origine in ALTO A SINISTRA (immagine, non voxel)")
check('"all"' in p, "il prompt chiede una sola tela sotto la chiave 'all'")

# Il contesto e' il disegno GIA' sulla tela: e' li' che vive, quindi lo manda il
# client e il server lo inoltra senza interpretarlo.
check("12a4b" in pixmain.build_prompt("modifica", 16, 16, "12a4b\n16."),
      "il contesto inviato dal client entra nel prompt")
check("nessuna faccia disegnata" in pixmain.build_prompt("x", 16),
      "senza contesto il prompt lo dice esplicitamente")

# Contratto del modulo CONDIVISO, senza passare dal template su disco: se
# `height` venisse ignorato da build_pixel_prompt, tutti i controlli qui sopra
# cadrebbero insieme e non si capirebbe da che lato.
check(pixelprompt.build_pixel_prompt(
    "x", ["all"], size=20, height=48,
    template="D=[INSERISCI QUI LA DIMENSIONE]") == "D=20x48\nx\n",
      "build_pixel_prompt sostituisce la dimensione come LxA")


# --- B. rotta POST /api/texture ---------------------------------------------
SEEN_ERROR_BODIES = []


def _req(body, path="/api/texture", raw_body=None):
    url = 'http://127.0.0.1:%d%s' % (pixmain.PORT, path)
    data = raw_body if raw_body is not None else json.dumps(body).encode()
    rq = urllib.request.Request(url, data=data, method='POST',
                                headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(rq, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:                                        # noqa: BLE001
            payload = {}
        SEEN_ERROR_BODIES.append(payload)
        return e.code, payload
    except Exception as e:                                       # noqa: BLE001
        # Codice 0 = nessuna risposta HTTP. Un'eccezione dentro l'handler non
        # diventa un 500: socketserver chiude la connessione e il client vede
        # "connessione persa". Catturarla qui la fa diventare un check rosso
        # con un nome, invece di un traceback che interrompe il test.
        SEEN_ERROR_BODIES.append({"_nessunaRisposta": repr(e)})
        return 0, {"_nessunaRisposta": repr(e)}


threading.Thread(target=pixmain.start_server, daemon=True).start()
for _ in range(200):
    if pixmain.PORT:
        break
    time.sleep(0.05)
check(bool(pixmain.PORT), "server di test avviato (porta %s)" % pixmain.PORT)

TEX = ('{"size":32,"palette":{"o":"#1A1A22","p":"#E8B27A"},'
       '"faces":{"all":["fill 10 6 21 25 p","rect 10 6 21 25 o"]}}')

NEXT_ANSWER[0] = "```json\n" + TEX + "\n```"
s, d = _req({"prompt": "un cavaliere", "width": 32, "height": 48})
check(s == 200, "risposta AI valida -> 200")
check(isinstance(d.get("ops"), list) and d["ops"][0] == "fill 10 6 21 25 p",
      "la risposta porta `ops` come lista di comandi")
check(d.get("faces", {}).get("all") == d.get("ops"),
      "`faces` duplica le ops sotto 'all' (il modulo che espande e' condiviso)")
check(d.get("palette", {}).get("o") == "#1A1A22", "la palette torna al client")
check(d.get("size") == 32, "la dimensione dichiarata dall'AI torna al client")
check(not d.get("warnings") and not d.get("unknownFaces"),
      "risposta canonica senza avvisi")
check(_declared_size(LAST_PROMPT[0]) == (32, 48),
      "la rotta ha passato width e height al prompt")
check("un cavaliere" in LAST_PROMPT[0], "la rotta ha passato la richiesta")

# `size` da solo: il client dei materiali del padre e le versioni vecchie della
# UI mandano una tela quadrata sotto quel nome.
NEXT_ANSWER[0] = TEX
_req({"prompt": "x", "size": 24})
check(_declared_size(LAST_PROMPT[0]) == (24, 24),
      "`size` accettato come sinonimo di `width` (tela quadrata)")
NEXT_ANSWER[0] = TEX
_req({"prompt": "x", "width": 20, "size": 64, "height": 48})
check(_declared_size(LAST_PROMPT[0]) == (20, 48),
      "`width` ha la precedenza su `size`")

NEXT_ANSWER[0] = TEX
check(_req({"prompt": "x"})[0] == 200, "JSON nudo senza fence -> 200")
NEXT_ANSWER[0] = "Ecco lo sprite:\n```json\n" + TEX + "\n```\nSpero vada bene!"
check(_req({"prompt": "x"})[0] == 200, "chiacchiere attorno al JSON -> 200")

NEXT_ANSWER[0] = TEX
_req({"prompt": "aggiungi un elmo", "width": 32, "height": 48,
      "context": "10.12a10.\n32a"})
check("12a10" in LAST_PROMPT[0], "il contesto della tela entra nel prompt")

# --- Alias del nome della tela ----------------------------------------------
# Il punto piu' importante di questa rotta. Un nome non riconosciuto finirebbe
# fra le `unknownFaces` e la tela resterebbe VUOTA: l'utente lo legge come "non
# ha generato niente", non come "ha risposto usando un'altra parola". Costo di
# un alias mancante: una rigenerazione a pagamento per una parola.
OPS = '["fill 0 0 31 31 p","rect 0 0 31 31 o"]'
ALIAS_FORME = {
    "faces.canvas": '{"size":32,"palette":{"p":"#E8B27A","o":"#1A1A22"},'
                    '"faces":{"canvas":%s}}' % OPS,
    "faces.sprite": '{"faces":{"sprite":%s}}' % OPS,
    "faces.image": '{"faces":{"image":%s}}' % OPS,
    "faces.tela (italiano)": '{"faces":{"tela":%s}}' % OPS,
    "faces.all": '{"faces":{"all":%s}}' % OPS,
    "ops alla radice (nessuna faccia)": '{"size":32,"ops":%s}' % OPS,
    "comandi alla radice (sinonimo italiano)": '{"comandi":%s}' % OPS,
    "faccia come oggetto {ops:[...]}": '{"faces":{"canvas":{"ops":%s}}}' % OPS,
    "comandi in una stringa multiriga":
        '{"faces":{"all":"fill 0 0 31 31 p\\nrect 0 0 31 31 o"}}',
    "sinonimo 'facce'": '{"facce":{"all":%s}}' % OPS,
}
for label, answer in ALIAS_FORME.items():
    NEXT_ANSWER[0] = answer
    s, d = _req({"prompt": "x", "width": 32, "height": 32})
    check(s == 200 and d.get("ops") and d["ops"][0] == "fill 0 0 31 31 p",
          "nome della tela ricondotto: %s" % label)

# Piu' facce senza `all`: la tela e' UNA, quindi se ne usa una sola. Scartare le
# altre in silenzio sarebbe peggio che dirlo.
NEXT_ANSWER[0] = ('{"faces":{"px":["fill 0 0 31 31 p"],'
                  '"nx":["rect 0 0 31 31 o"]}}')
s, d = _req({"prompt": "un cubo", "width": 32})
check(s == 200 and len(d.get("ops") or []) == 1,
      "l'AI divide in piu' facce -> ne viene usata UNA sola")
check(any("usato" in w for w in d.get("warnings", [])),
      "la faccia scartata finisce negli avvisi, non nel silenzio")
check(d["faces"]["all"] == d["ops"],
      "la faccia scelta e' comunque esposta come 'all'")

# --- Errori: ognuno un codice spiegato, mai un 500 o una connessione muta ----
check(_req(None, raw_body=b"")[0] == 400, "corpo mancante -> 400")
check(_req(None, raw_body=b"{non json")[0] == 400, "corpo non JSON -> 400")
check(_req([1, 2, 3])[0] == 400, "corpo JSON non oggetto -> 400")
check(_req({})[0] == 400, "prompt mancante -> 400")
check(_req({"prompt": "   "})[0] == 400, "prompt vuoto (soli spazi) -> 400")

# REGRESSIONE: un `prompt` non testuale faceva sollevare `.strip()` DENTRO
# l'handler. Un'eccezione li' non diventa un 500: socketserver chiude la
# connessione e il client vede "connessione persa", senza codice e senza
# messaggio - esattamente il caso che il resto di questo blocco esiste per
# evitare. Cosa risponda (200 sulla descrizione convertita, o 400) e' un
# dettaglio; che RISPONDA non lo e'.
NEXT_ANSWER[0] = TEX
check(_req({"prompt": 5, "width": 16})[0] in (200, 400),
      "prompt numerico -> risposta HTTP, non connessione chiusa")
NEXT_ANSWER[0] = TEX
check(_req({"prompt": ["un", "cavaliere"], "width": 16})[0] in (200, 400),
      "prompt come lista -> risposta HTTP, non connessione chiusa")

NEXT_ANSWER[0] = "Mi dispiace, non posso disegnare pixel art."
s, d = _req({"prompt": "x"})
check(s == 400 and "rawPreview" in d,
      "risposta senza JSON -> 400 con anteprima del testo")
check("disegnare pixel art" in d.get("rawPreview", ""),
      "l'anteprima riporta davvero cio' che il modello ha risposto")

NEXT_ANSWER[0] = '{"faces":{"all":["glow 0 0 31 31 p","sparkle 1 1"]}}'
s, d = _req({"prompt": "x"})
check(s == 400, "solo comandi inventati -> 400")
check("glow" in d.get("error", ""),
      "il messaggio del 400 dice COSA non andava (il comando inventato)")
check(any("glow" in w for w in d.get("warnings", [])),
      "gli avvisi elencano i comandi scartati")

NEXT_ANSWER[0] = '{"size":32,"palette":{"p":"#E8B27A"},"faces":{}}'
s, d = _req({"prompt": "x"})
check(s == 400 and "warnings" in d, "JSON senza tela -> 400 spiegato")

NEXT_ANSWER[0] = '{"faces":{"sopra_sinistra":["fill 0 0 1 1 p"]}}'
s, d = _req({"prompt": "x"})
check(s == 400 and d.get("unknownFaces") == ["sopra_sinistra"],
      "nome irriconoscibile riportato in unknownFaces, non ignorato")

# Errori del client AI: classificati, non 500 opachi. `_classify_ai_error`
# riconosce l'autenticazione per INDIZI TESTUALI (il client `gemini` e' un web
# client e non espone codici).
NEXT_ANSWER[0] = Exception("cookie non valido o scaduto")
s, d = _req({"prompt": "x"})
check(s == 401 and d.get("needsCookies") is True,
      "sessione scaduta -> 401 con needsCookies (il client apre le Impostazioni)")

_fast_time.slept = []
NEXT_ANSWER[0] = OSError("connection reset by peer")
_t0 = time.time()
s, d = _req({"prompt": "x"})
check(s == 503 and d.get("retryable") is True, "errore di rete -> 503 riprovabile")
check(_fast_time.slept == [20],
      "l'errore transitorio e' stato ritentato una volta col backoff")
check(time.time() - _t0 < 10,
      "il ritento non ha atteso davvero 20s (time iniettato, non reale)")

# Nessuna credenziale nei corpi d'errore. Il messaggio riporta di proposito il
# "Dettaglio:" dell'eccezione del client AI, quindi la garanzia non e' gratuita:
# e' che il server non aggiunga MAI cookie o percorsi di credenziali.
check(len(SEEN_ERROR_BODIES) >= 10,
      "raccolti i corpi di tutti gli errori (%d)" % len(SEEN_ERROR_BODIES))
_all_errors = json.dumps(SEEN_ERROR_BODIES).lower()
for probe in ("secure_1psid", "__secure", "cookies.json"):
    check(probe not in _all_errors,
          "nessuna credenziale nei corpi d'errore (%s)" % probe)


# --- C. Impostazioni separate, cookie condivisi ------------------------------
# La decisione di design che vogliamo bloccare: le IMPOSTAZIONI si separano (la
# rotazione degli autosave conta i file per cartella e mescolarli farebbe
# cancellare gli uni per far posto agli altri), la SESSIONE Google no. Se i
# cookie seguissero APP_NAME, la stessa UI vedrebbe `has_cookies: true` servita
# dal padre e `false` avviata da sola: due comportamenti opposti per lo stesso
# codice a seconda di come e' stata aperta.
check(app_settings.APP_NAME == "PixelAIEditor",
      "l'import ha spostato le impostazioni su APP_NAME='PixelAIEditor'")
check(app_settings.COOKIES_APP_NAME == "VoxelAIArtist",
      "i cookie restano sotto COOKIES_APP_NAME='VoxelAIArtist'")
check(app_settings.get_cookies_dir() != app_settings.get_appdata_dir(),
      "cartella dei cookie e cartella delle impostazioni sono DIVERSE")
check(os.path.basename(app_settings.get_appdata_dir()) == "PixelAIEditor",
      "le impostazioni stanno in %APPDATA%/PixelAIEditor")
check(os.path.basename(app_settings.get_cookies_dir()) == "VoxelAIArtist",
      "i cookie stanno in %APPDATA%/VoxelAIArtist (condivisi col padre)")
# Il dirottamento di %APPDATA% deve avere funzionato, o il test avrebbe scritto
# nella cartella vera dell'utente.
check(app_settings.get_appdata_dir().startswith(_TMP_APPDATA),
      "le impostazioni del test vivono nella cartella temporanea")


# --- D. GET /api/settings ----------------------------------------------------
def _get(path):
    url = 'http://127.0.0.1:%d%s' % (pixmain.PORT, path)
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:                                        # noqa: BLE001
            return e.code, {}


s, d = _get('/api/settings')
check(s == 200, "GET /api/settings -> 200")
check(d.get("app") == "PixelAIEditor",
      "/api/settings si identifica come PixelAIEditor")
# Niente finestra Qt: la UI deve degradare a download del browser e
# <input type=file> invece di chiedere i dialog nativi.
check(d.get("is_desktop") is False, "is_desktop False: nessun dialog nativo")
check(isinstance(d.get("needsCookies"), bool),
      "needsCookies e' un booleano (la UI apre da se' il modale Impostazioni)")
check(d.get("needsCookies") is True,
      "senza cookie nella cartella temporanea needsCookies e' True")
check(d.get("app_mode") == "web", "app_mode 'web'")
check(d.get("cookies_path", "").endswith("cookies.json")
      and os.path.basename(os.path.dirname(d["cookies_path"])) == "VoxelAIArtist",
      "cookies_path punta alla cartella condivisa")

if fails:
    print("\n%d CHECK FALLITI" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("\nTUTTI I CHECK OK")
