"""PixelAIEditor — editor di pixel art 2D con generazione AI.

Avvio autonomo: `python main.py` (oppure `run.bat`). Serve la UI da un server
HTTP locale su porta effimera e la apre nel browser di sistema.

RAPPORTO CON VoxelAIArtist
--------------------------
Questa app e' autonoma ma vive nello stesso repo e RIUSA `../src` (settings,
parser, pixelprompt). NON importa `main.py` del padre, e non e' una svista:
quel modulo a livello di modulo risolve la modalita' d'avvio leggendo
`sys.argv` — che qui sarebbe il NOSTRO —, importa Gemini e il motore dei pack,
e lega il proprio `BASE_DIR` alla cartella del padre, cosicche' `translate_path`
servirebbe i file dell'albero sbagliato. Le poche funzioni condivise stanno in
`src/`, importabili da entrambi.

Quando l'editor e' aperto DENTRO VoxelAIArtist (finestra dei materiali), la
pagina e' servita dal server del PADRE: questo processo non parte affatto.
"""

import sys
import os
import json
import time
import threading
import http.server
import subprocess
import webbrowser
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _src_dir():
    """Cartella `src/` condivisa, sia da sorgente sia congelata.

    PyInstaller spacchetta i `datas` dentro `_MEIPASS`, quindi `src/` finisce
    ACCANTO a questo file e non un livello sopra: si prova prima il layout
    congelato, poi quello del repo.
    """
    here = os.path.join(BASE_DIR, "src")
    if os.path.isdir(here):
        return here
    return os.path.join(os.path.dirname(BASE_DIR), "src")


def _prompts_dir():
    """Cartella dei prompt: la propria se c'e', altrimenti quella del padre."""
    own = os.path.join(BASE_DIR, "assets", "prompts")
    if os.path.isdir(own):
        return own
    return os.path.join(os.path.dirname(BASE_DIR), "assets", "prompts")


sys.path.insert(0, _src_dir())
import settings as app_settings  # noqa: E402
import pixelprompt  # noqa: E402
from pixelprompt import normalize_pixel_data  # noqa: E402
from aiclient import (  # noqa: E402
    AIAuthError,
    AIFormatError,
    AITransientError,
    _classify_ai_error,
    ai_answer_text_retrying,
)
from parser import extract_and_parse_json  # noqa: E402

# Le IMPOSTAZIONI sono nostre, i COOKIE restano condivisi col padre (sono una
# sessione Google, non una preferenza). Vedi COOKIES_APP_NAME in settings.py.
# Va chiamata PRIMA di qualunque lettura delle impostazioni.
app_settings.set_app_name("PixelAIEditor")


# ===== MODALITA' DI AVVIO =====================================================
# Solo "web": nessuna finestra Qt, la UI si apre nel browser di sistema. La
# costante e la funzione esistono comunque per restare allineati al padre (che
# ha anche "py") e perche' `--mode=...` non deve far fallire l'avvio.
#
# La variabile d'ambiente e' PIXELAI_MODE, non VOXELAI_MODE: due app che si
# scambiano la modalita' perche' condividono una variabile e' un fastidio
# garantito. VOXELAI_MODE resta accettata come ripiego, cosi' chi ha gia' il
# proprio ambiente configurato non deve toccarlo.
APP_MODE = "web"

VALID_APP_MODES = ("web",)

_APP_MODE_ALIASES = {
    "browser": "web", "http": "web", "server": "web", "headless": "web",
    # Il padre ha anche una modalita' finestra; qui non c'e' nulla da embeddare,
    # ma chiederla non deve impedire l'avvio.
    "py": "web", "qt": "web", "pyqt": "web", "pyqt6": "web", "desktop": "web",
}


def _resolve_app_mode(default_mode="web", argv=None, env=None):
    """Risolve la modalita' d'avvio: argomento CLI > PIXELAI_MODE > costante.

    Copia deliberata dell'omonima del padre (§2.2 del piano): importarla
    significherebbe importare `main.py` di VoxelAIArtist con tutti i suoi
    effetti collaterali a livello di modulo. argv/env sono parametri per poter
    testare la funzione senza toccare il processo reale.
    """
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    env = os.environ if env is None else env

    raw = str(default_mode)
    source = "costante APP_MODE"

    env_val = (env.get("PIXELAI_MODE") or env.get("VOXELAI_MODE") or "").strip()
    if env_val:
        raw, source = env_val, "variabile PIXELAI_MODE"

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
        print("[avvio] modalita' '%s' non riconosciuta (%s): uso 'web'. "
              "PixelAIEditor ha solo la modalita' web." % (raw, source))
        mode = "web"
    return mode


APP_MODE = _resolve_app_mode(APP_MODE)

# PORT = 0 -> l'OS sceglie una porta libera. E' un globale di MODULO: il padre ha
# il proprio, quindi le due app non collidono mai, nemmeno avviate insieme.
PORT = 0


def _read_prompt_file(name, fallback=""):
    """Legge un prompt da assets/prompts. Il fallback non e' decorativo: senza
    file l'app deve comunque poter chiamare l'AI."""
    path = os.path.join(_prompts_dir(), name)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return fallback


def build_prompt(prompt, width=None, height=None, context=None):
    """Prompt per una TELA 2D, non per le sei facce di un cubo.

    Il motore e' `pixelprompt.build_pixel_prompt`, condiviso col padre; cambia
    solo il template (`prompt-pixel2d.txt`) e il fatto che la faccia e' sempre
    una sola, `all`. Il modulo condiviso accetta il testo del template come
    parametro proprio perche' le due app hanno cartelle `assets/prompts/`
    diverse: e' il chiamante a sapere qual e' la sua.
    """
    return pixelprompt.build_pixel_prompt(
        prompt, ["all"], context=context, size=width, height=height,
        template=_read_prompt_file("prompt-pixel2d.txt",
                                   pixelprompt.PIXEL_PROMPT_FALLBACK))


class PixelAIRequestHandler(http.server.SimpleHTTPRequestHandler):
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
        # I dizionari sono chiesti come 'locales/xx.json' RELATIVI al documento:
        # da /ui/index.html diventano /ui/locales/..., che esiste. Serviti dalla
        # radice (/), diventerebbero /locales/... : questo caso li rimanda in ui/.
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

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode('utf-8'))

    def _log_ai_answer(self, label, answer, exc=None):
        """Stampa la risposta grezza a console quando qualcosa va storto.

        Va a CONSOLE e non nella risposta HTTP: il testo del modello puo'
        contenere di tutto e il client ne riceve solo un'anteprima corta.
        """
        print("\n=== ERRORE %s ===" % label)
        if answer:
            print(answer[:2000])
        else:
            print("[Risposta non disponibile]")
        print("=" * 20)
        if exc is not None:
            import traceback
            traceback.print_exception(type(exc), exc, exc.__traceback__)

    def _send_ai_error(self, exc, label):
        """Mappa gli errori AI classificati su codici HTTP distinti.

        401 -> cookie da riconfigurare (il client apre le Impostazioni),
        503 -> rete/quota/rate-limit (riprovabile), 400 -> risposta non JSON.
        """
        self._log_ai_answer(label, getattr(exc, "answer", None), exc)
        if isinstance(exc, AIAuthError):
            self._send_json(401, {"error": str(exc), "needsCookies": True})
        elif isinstance(exc, AIFormatError):
            self._send_json(400, {"error": str(exc)})
        else:
            self._send_json(503, {"error": str(exc), "retryable": True})

    def _serve_html_injected(self, fs_path):
        """Serve la pagina principale. Nessuna iniezione di `__API_BASE__`: la UI
        e i suoi dizionari sono sempre RELATIVI al documento, e un base assoluto
        li farebbe pescare dall'albero sbagliato quando la stessa pagina e'
        servita dal padre dentro l'iframe."""
        try:
            with open(fs_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except OSError:
            self.send_error(404)
            return
        body = content.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path

        if route in ('/', '/ui/', '/index.html', '/ui/index.html'):
            self._serve_html_injected(os.path.join(BASE_DIR, 'ui', 'index.html'))
            return

        if route == '/api/settings':
            _has_cookies = app_settings.has_cookies()
            self._send_json(200, {
                "has_cookies": _has_cookies,
                # La UI usa questo flag per aprire da se' il modale Impostazioni
                # al primo avvio: la decisione e' della UI, non del server.
                "needsCookies": (not _has_cookies),
                "cookie_count": len(app_settings.load_cookies()),
                "cookies_path": app_settings.get_cookies_path(),
                "appdata_dir": app_settings.get_appdata_dir(),
                "app_mode": APP_MODE,
                # Niente dialog nativi: qui non c'e' nessuna finestra Qt, la UI
                # deve usare download del browser e <input type="file">.
                "is_desktop": False,
                "app": "PixelAIEditor",
            })
            return

        if route == '/api/settings/open-folder':
            try:
                folder = app_settings.get_appdata_dir()
                if sys.platform.startswith('win'):
                    subprocess.Popen('explorer "%s"' % folder)
                elif sys.platform == 'darwin':
                    subprocess.Popen(['open', folder])
                else:
                    subprocess.Popen(['xdg-open', folder])
                self._send_json(200, {"ok": True})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        if route == '/api/prefs':
            try:
                self._send_json(200, {"settings": app_settings.get_public_settings()})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        super().do_GET()

    def _handle_texture(self):
        """POST /api/texture — genera pixel art come COMANDI 2D compatti.

        Stessa rotta e stesso contratto di risposta del padre (`{size, palette,
        faces, unknownFaces?, warnings?}`), cosi' il modulo che espande le ops
        nel browser e' letteralmente lo stesso file. Le differenze sono due, ed
        entrambe nascono dal fatto che qui la tela e' UNA e puo' non essere
        quadrata: si accetta `height` accanto a `size`, e la faccia richiesta e'
        sempre `all`.

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
        # non diventa un 500 — chiude la connessione senza NESSUNA risposta
        # HTTP, e il client vede "connessione persa" invece di un messaggio.
        # E' la stessa insidia del Content-Length assente qui sopra, ed e' il
        # motivo per cui ogni controllo di questo blocco esiste.
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            self._send_json(400, {"error": "Descrizione del disegno mancante."})
            return

        answer = None
        try:
            final_prompt = build_prompt(prompt,
                                        payload.get("width", payload.get("size")),
                                        payload.get("height"),
                                        payload.get("context"))
            answer = ai_answer_text_retrying(final_prompt, payload.get("model"))
        except (AIAuthError, AITransientError) as e:
            self._send_ai_error(e, "PIXEL AI")
            return
        except Exception as e:                                  # noqa: BLE001
            self._send_ai_error(_classify_ai_error(e), "PIXEL AI")
            return

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
        # pixelprompt. Rifiutarlo costerebbe all'utente una rigenerazione per
        # una parola.
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

        # La tela e' una sola: se l'AI ha comunque diviso in facce (capita
        # quando il prompt dell'utente parla di un cubo), si prende `all` se
        # c'e', altrimenti la PRIMA. Scartare il resto in silenzio sarebbe
        # peggio che dirlo, quindi finisce negli avvisi.
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
            print("[pixel] risposta normalizzata con avvisi: %s"
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
        route = urlparse(self.path).path

        # Due nomi per la stessa cosa, e NON per pigrizia: dentro
        # VoxelAIArtist la pagina e' servita dal server del PADRE, dove
        # `/api/texture` esiste gia' ed e' la generazione delle facce di un
        # MATERIALE (altro prompt, altro contratto). Li' la rotta di questo
        # editor si chiama per forza `/api/texture2d`, quindi la UI chiede
        # sempre quel nome e qui lo si accetta insieme a quello storico. Un
        # `if ponte` nel client sceglierebbe la rotta in base a uno stato che
        # potrebbe non essere ancora arrivato (la stretta di mano e' un
        # messaggio asincrono), e sbagliarlo vorrebbe dire mandare la richiesta
        # al generatore dei materiali senza che nessuno se ne accorga.
        if route in ('/api/texture2d', '/api/texture'):
            self._handle_texture()
            return

        if route == '/api/prefs':
            try:
                body = self._read_json_body()
                patch = body.get("settings", body) if isinstance(body, dict) else {}
                updated = app_settings.merge_settings(patch)
                self._send_json(200, {"settings": {
                    k: v for k, v in updated.items()
                    if k not in ("cookies", "cookie", "token", "secret", "password", "auth")
                }})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        if route == '/api/settings/cookies':
            # Header assente -> int(None) -> TypeError non catturato -> nessuna
            # risposta al client. Stessa insidia gia' vista nel padre.
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
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        self._send_json(404, {"error": "Endpoint non trovato: %s" % route})

    def do_DELETE(self):
        route = urlparse(self.path).path

        if route == '/api/settings/cookies':
            try:
                p = app_settings.get_cookies_path()
                if os.path.exists(p):
                    os.remove(p)
                self._send_json(200, {"ok": True})
            except Exception as e:                              # noqa: BLE001
                self._send_json(500, {"error": str(e)})
            return

        self._send_json(404, {"error": "Endpoint non trovato: %s" % route})


def start_server():
    global PORT
    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer(("127.0.0.1", 0), PixelAIRequestHandler)
    PORT = server.server_address[1]
    print("[server] PixelAIEditor in ascolto sulla porta %d" % PORT)
    server.serve_forever()


def _print_cookie_hint():
    """Avvisa a console se non ci sono cookie salvati. Nessuna navigazione
    forzata: e' la UI ad aprire il proprio modale leggendo `needsCookies`."""
    try:
        if app_settings.has_cookies():
            return
    except Exception as e:                                      # noqa: BLE001
        print("[cookie] impossibile verificare i cookie: %s" % e)
        return
    print("-" * 78)
    print(" Nessun cookie salvato: la generazione AI non funzionera' finche' non")
    print(" li incolli in Impostazioni (dentro l'app).")
    print(" I cookie sono CONDIVISI con VoxelAIArtist: configurarli qui li")
    print(" configura anche la'.")
    try:
        print(" Cartella cookie: %s" % app_settings.get_cookies_dir())
    except Exception:
        pass
    print("-" * 78)


def run_web_mode():
    """Il server e' gia' avviato dal chiamante (PORT valorizzato). Qui apriamo la
    pagina e teniamo vivo il processo: il server gira su un thread daemon, se il
    main thread finisse morirebbe con lui."""
    url = "http://127.0.0.1:%d/ui/index.html" % PORT
    print("")
    print("=" * 78)
    print(" PixelAIEditor - editor pixel art 2D con AI")
    print(" Interfaccia: %s" % url)
    print(" Server:      http://127.0.0.1:%d" % PORT)
    print(" Per chiudere: premi Ctrl+C in questa finestra.")
    print("=" * 78)
    print("")
    try:
        webbrowser.open(url)
    except Exception as e:                                      # noqa: BLE001
        print("[web] impossibile aprire il browser (%s): apri a mano %s" % (e, url))
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        # Ctrl+C pulito: senza questo si vede un traceback su time.sleep.
        print("\nServer arrestato. A presto.")
    return 0


if __name__ == '__main__':
    if not os.path.exists(os.path.join(BASE_DIR, 'ui', 'index.html')):
        print("[avvio] ui/index.html non trovato: generalo con "
              "`node ui/build.mjs` da questa cartella.")

    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    while PORT == 0:
        time.sleep(0.1)

    _print_cookie_hint()
    sys.exit(run_web_mode())
