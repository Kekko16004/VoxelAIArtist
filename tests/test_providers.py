"""
Test del registro provider AI (`src/providers.py`), del dispatch di
`aiclient.ai_answer_text` e delle rotte `/api/providers*` sul VERO
ThreadingHTTPServer di main.py.

Niente rete, niente cookie, niente quota:
  - `gemini` e' stubbato prima di importare main (come in tutta la suite);
  - lo strato HTTP dei provider (`providers._http_post_json`) e' sostituito da
    una funzione finta, quindi nessun byte esce dalla macchina;
  - `VOXELAI_PROVIDERS_DIR` punta a una cartella temporanea, quindi il test non
    legge ne' scrive la configurazione reale dell'utente. Senza questo, con un
    provider a chiave API attivo la suite proverebbe una chiamata VERA.

Cosa si verifica, e perche' proprio questo:
  1. il default a configurazione zero e' Gemini a cookie (la proprieta' che il
     multi-provider non deve rompere);
  2. una chiave API non compare MAI in un payload pubblico (registro, elenco,
     /api/settings, /api/providers) — asserito cercando la chiave in chiaro;
  3. ogni tipo di provider mappa i propri guasti sulle STESSE tre classi, e per
     le API vere si guarda il codice di stato, non il testo del messaggio;
  4. cancellare il provider attivo riporta a Gemini invece di lasciare l'app
     puntata su un id inesistente.
"""
import os as _os
_HERE = _os.path.dirname(_os.path.abspath(__file__))
REPO_ROOT = _os.path.dirname(_HERE)
import json, os, sys, tempfile, threading, time, types, urllib.error, urllib.request

os.chdir(REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, 'src'))
sys.path.insert(0, REPO_ROOT)

# Cartella isolata PRIMA di qualunque import: providers.py la legge a ogni
# chiamata, ma un import che scrivesse su disco sporcherebbe l'appdata vera.
_TMP = tempfile.mkdtemp(prefix='voxai_prov_')
os.environ['VOXELAI_PROVIDERS_DIR'] = _TMP

stub = types.ModuleType('gemini')
class _FakeResp:
    def __init__(self, t): self.text = t
GEMINI_CALLS = [0]
NEXT_GEMINI = ['risposta di gemini']
class Gemini:
    def __init__(self, *a, **k): pass
    def generate_content(self, prompt):
        GEMINI_CALLS[0] += 1
        v = NEXT_GEMINI[0]
        if isinstance(v, Exception):
            raise v
        return _FakeResp(v)
stub.Gemini = Gemini
sys.modules['gemini'] = stub

import main
import aiclient
import providers as P

fails = []
def check(cond, msg):
    if not cond:
        print("  FAIL " + msg); fails.append(msg)
    else:
        print("  OK  " + msg)

SECRET = 'sk-ant-api03-NONDEVEUSCIREMAI-WXYZ'
OPENAI_SECRET = 'sk-openai-ALTRETTANTOSEGRETO-4321'

# --- Strato HTTP finto -------------------------------------------------------
# Si sostituisce `_http_post_json`, cioe' l'UNICO punto da cui i provider parlano
# con la rete. Sostituire urllib lascerebbe scoperta la classificazione degli
# errori, che e' proprio la parte da provare.
CALLS = []
NEXT_HTTP = [None]      # dict da restituire, oppure un'Exception da sollevare

def _fake_http(url, headers, payload, timeout=P.DEFAULT_TIMEOUT, label=""):
    CALLS.append({"url": url, "headers": dict(headers), "payload": payload,
                  "label": label})
    v = NEXT_HTTP[0]
    if isinstance(v, Exception):
        raise v
    return v

P._http_post_json = _fake_http

def http_status(code, body='{"error":{"message":"boom"}}'):
    """Costruisce l'eccezione che urllib solleverebbe per quel codice, passata
    per la VERA classify_http_status: e' quella la funzione sotto esame."""
    return P.classify_http_status(code, body, "Prova")


print("=== default a configurazione zero ===")
info = P.list_providers()
check(info['active'] == 'gemini', "l'attivo di partenza e' Gemini a cookie")
check(len(info['providers']) == 1 and info['providers'][0]['builtin'],
      "l'unico provider di partenza e' quello predefinito")
check(P.get_active_provider()['type'] == P.TYPE_GEMINI,
      "get_active_provider -> gemini_cookies")
GEMINI_CALLS[0] = 0
check(aiclient.ai_answer_text("ciao") == 'risposta di gemini',
      "ai_answer_text senza configurazione passa dal client Gemini")
check(GEMINI_CALLS[0] == 1, "il client Gemini e' stato chiamato una volta sola")
check(not CALLS, "nessuna chiamata HTTP a provider esterni")

print("\n=== il predefinito non si tocca ===")
for fn, label in ((P.delete_provider, 'delete'), (lambda i: P.update_provider(i, {}), 'update')):
    try:
        fn('gemini'); check(False, "%s del predefinito deve essere rifiutato" % label)
    except ValueError:
        check(True, "%s del predefinito rifiutato con ValueError" % label)

print("\n=== aggiunta provider + mascheramento ===")
ent = P.add_provider({"type": "anthropic", "label": "Claude mio",
                      "model": "claude-opus-5", "api_key": SECRET})
PID = ent['id']
check(ent['keyMask'] == '****WXYZ', "la chiave esce mascherata: %s" % ent['keyMask'])
check(ent['hasKey'] is True, "hasKey=true quando la chiave c'e'")
check('api_key' not in ent and SECRET not in json.dumps(ent),
      "l'entry pubblica non contiene la chiave")
registry_raw = open(P.get_providers_path(), encoding='utf-8').read()
check(SECRET not in registry_raw, "providers.json non contiene la chiave")
check(SECRET in open(P.get_keys_path(), encoding='utf-8').read(),
      "la chiave e' nel file chiavi separato")
check(SECRET not in json.dumps(P.list_providers()),
      "list_providers non fa trapelare la chiave")
check(SECRET not in json.dumps(P.public_summary()),
      "public_summary non fa trapelare la chiave")
check(SECRET not in json.dumps(app_public := __import__('settings').get_public_settings()),
      "get_public_settings non contiene la chiave")
check(P.get_api_key(PID) == SECRET, "la chiave in chiaro resta leggibile all'interno")
check(P.mask_key('abc') == '***' and P.mask_key('') == '',
      "mask_key non rivela nulla su chiavi corte")

print("\n=== modifica: una chiave assente non cancella quella salvata ===")
P.update_provider(PID, {"label": "Claude rinominato"})
check(P.get_api_key(PID) == SECRET,
      "salvare solo l'etichetta NON perde la chiave")
check(P.get_provider(PID)['label'] == 'Claude rinominato', "l'etichetta e' aggiornata")
P.update_provider(PID, {"api_key": SECRET + '2'})
check(P.get_api_key(PID) == SECRET + '2', "una chiave nuova sostituisce la vecchia")
P.update_provider(PID, {"api_key": SECRET})

print("\n=== dispatch sul provider attivo ===")
P.set_active_provider(PID)
GEMINI_CALLS[0] = 0
CALLS.clear()
NEXT_HTTP[0] = {"content": [{"type": "text", "text": '{"ok":1}'}],
                "stop_reason": "end_turn"}
out = aiclient.ai_answer_text("disegna un vaso")
check(out == '{"ok":1}', "il testo torna dal blocco `text` di Anthropic")
check(GEMINI_CALLS[0] == 0, "con un provider attivo Gemini NON viene chiamato")
check(len(CALLS) == 1 and CALLS[0]['url'].endswith('/v1/messages'),
      "rotta Anthropic: %s" % CALLS[0]['url'])
check(CALLS[0]['headers'].get('x-api-key') == SECRET,
      "la chiave viaggia nell'header x-api-key")
check(CALLS[0]['headers'].get('anthropic-version') == '2023-06-01',
      "anthropic-version presente")
check(CALLS[0]['payload']['model'] == 'claude-opus-5', "il modello e' quello configurato")
check('temperature' not in CALLS[0]['payload']
      and 'top_p' not in CALLS[0]['payload'],
      "nessun parametro rifiutato dai modelli recenti (temperature/top_p)")

print("\n=== il modello della UI non sovrascrive quello del provider ===")
CALLS.clear()
aiclient.ai_answer_text("x", model="gemini-3.1-pro")
check(CALLS[0]['payload']['model'] == 'claude-opus-5',
      "un nome di modello Gemini dalla UI non finisce ad Anthropic")
CALLS.clear()
aiclient.ai_answer_text("x", model="claude-sonnet-5")
check(CALLS[0]['payload']['model'] == 'claude-sonnet-5',
      "un modello del provider attivo scelto in UI viene usato")

print("\n=== blocchi non-testo e stop_reason ===")
NEXT_HTTP[0] = {"content": [{"type": "thinking", "thinking": "ragiono..."},
                            {"type": "text", "text": "VERO"}],
                "stop_reason": "end_turn"}
check(aiclient.ai_answer_text("x") == "VERO",
      "un blocco `thinking` iniziale non viene confuso con la risposta")
NEXT_HTTP[0] = {"content": [], "stop_reason": "refusal"}
try:
    aiclient.ai_answer_text("x"); check(False, "un rifiuto deve sollevare")
except P.AIFormatError:
    check(True, "stop_reason=refusal -> AIFormatError (non ritentabile)")
NEXT_HTTP[0] = {"content": [], "stop_reason": "max_tokens"}
try:
    aiclient.ai_answer_text("x"); check(False, "risposta troncata deve sollevare")
except P.AIFormatError as e:
    check('Token massimi' in str(e) or 'token' in str(e).lower(),
          "stop_reason=max_tokens -> AIFormatError che dice cosa alzare")

print("\n=== classificazione per codice di stato (nessuna euristica testuale) ===")
CASES = [(401, P.AIAuthError), (403, P.AIAuthError), (429, P.AITransientError),
         (500, P.AITransientError), (503, P.AITransientError),
         (529, P.AITransientError), (400, P.AIFormatError),
         (404, P.AIFormatError), (413, P.AIFormatError)]
for code, klass in CASES:
    got = P.classify_http_status(code, 'testo del provider', 'X')
    check(isinstance(got, klass), "HTTP %d -> %s" % (code, klass.__name__))
# Il punto vero: il MESSAGGIO non deve poter cambiare la classe. Un 503 il cui
# testo non contiene nessun indizio testuale resta transitorio, e un 400 che
# contiene la parola "quota" resta un errore di richiesta.
check(isinstance(P.classify_http_status(503, 'zzz', ''), P.AITransientError),
      "503 con testo insignificante resta transitorio")
check(isinstance(P.classify_http_status(400, 'quota rate limit', ''), P.AIFormatError),
      "400 col testo 'quota rate limit' NON diventa transitorio")
check(isinstance(P.classify_network_error(OSError('dns'), ''), P.AITransientError),
      "errore di rete -> transitorio")

print("\n=== le tre classi arrivano intatte fino ad ai_answer_text ===")
for code, klass in ((401, P.AIAuthError), (429, P.AITransientError),
                    (400, P.AIFormatError)):
    NEXT_HTTP[0] = http_status(code)
    try:
        aiclient.ai_answer_text("x"); check(False, "HTTP %d deve sollevare" % code)
    except Exception as e:                                   # noqa: BLE001
        check(isinstance(e, klass),
              "ai_answer_text propaga HTTP %d come %s (ricevuto %s)"
              % (code, klass.__name__, type(e).__name__))

print("\n=== _classify_ai_error non riclassifica un errore gia' classificato ===")
already = P.AITransientError("503 senza indizi")
check(aiclient._classify_ai_error(already) is already,
      "un'eccezione classificata passa intatta (stesso oggetto)")
check(isinstance(aiclient._classify_ai_error(RuntimeError("cookie scaduti")),
                 P.AIAuthError),
      "l'euristica testuale di Gemini funziona ancora sui suoi errori")

print("\n=== retry: transitorio si ritenta, auth e formato no ===")
tries = [0]
def _count_then(exc_or_val):
    def f(*a, **k):
        tries[0] += 1
        if isinstance(exc_or_val, Exception):
            raise exc_or_val
        return exc_or_val
    return f
_slept = []
saved = aiclient._interactive_backoff
aiclient._interactive_backoff = lambda: [1, 1]
for exc, expect_tries, name in ((http_status(429), 3, 'transitorio'),
                                (http_status(401), 1, 'auth'),
                                (http_status(400), 1, 'formato')):
    tries[0] = 0; _slept.clear()
    NEXT_HTTP[0] = exc
    P._http_post_json = _count_then(exc)
    try:
        aiclient.ai_answer_text_retrying("x", sleep=lambda s: _slept.append(s))
    except Exception:                                        # noqa: BLE001
        pass
    check(tries[0] == expect_tries,
          "errore %s: %d tentativi (atteso %d)" % (name, tries[0], expect_tries))
aiclient._interactive_backoff = saved
P._http_post_json = _fake_http

print("\n=== catalogo modelli del provider attivo ===")
GETS = []
NEXT_GET = [None]
_real_get = P._http_get_json

def _fake_get(url, headers, timeout=15, label=""):
    GETS.append({"url": url, "headers": dict(headers), "label": label})
    v = NEXT_GET[0]
    if isinstance(v, Exception):
        raise v
    return v

P._http_get_json = _fake_get
gemini_cat = P.list_models("gemini")
check(gemini_cat["type"] == P.TYPE_GEMINI, "Gemini: tipo nel catalogo")
check(all(m["id"].startswith("gemini") for m in gemini_cat["models"]),
      "Gemini: solo modelli Gemini")
check(not GETS, "Gemini: niente GET /v1/models")

NEXT_GET[0] = {"data": [
    {"id": "grok-3"}, {"id": "grok-3-mini"},
    {"id": "text-embedding-3-small"}, {"id": "whisper-1"},
]}
oent_models = P.add_provider({
    "type": "openai_compatible", "label": "Grok",
    "base_url": "https://api.x.ai/v1", "model": "grok-3",
    "api_key": OPENAI_SECRET})
cat = P.list_models(oent_models["id"])
check(cat["type"] == P.TYPE_OPENAI, "Grok: tipo openai_compatible")
check(GETS and GETS[-1]["url"] == "https://api.x.ai/v1/models",
      "Grok: GET {base}/v1/models")
ids = [m["id"] for m in cat["models"]]
check("grok-3" in ids and "grok-3-mini" in ids, "Grok: modelli xAI nel catalogo")
check("text-embedding-3-small" not in ids and "whisper-1" not in ids,
      "Grok: embedding/whisper esclusi")
check(all(not i.startswith("gemini") for i in ids),
      "Grok: nessun modello Gemini nel catalogo")
NEXT_GET[0] = P.AIAuthError("chiave sbagliata")
cat_fail = P.list_models(oent_models["id"])
fail_ids = [m["id"] for m in cat_fail["models"]]
check(fail_ids == ["grok-3"],
      "Grok: catalogo irraggiungibile -> solo il modello configurato, non Gemini")
P._http_get_json = _real_get

print("\n=== provider OpenAI-compatibile ===")
oent = P.add_provider({"type": "openai_compatible", "label": "LM Studio",
                       "base_url": "http://127.0.0.1:1234/v1",
                       "model": "qwen3-8b", "api_key": OPENAI_SECRET})
OPID = oent['id']
P.set_active_provider(OPID)
CALLS.clear()
NEXT_HTTP[0] = {"choices": [{"message": {"content": "ciao dal locale"}}]}
check(aiclient.ai_answer_text("x") == "ciao dal locale",
      "il testo torna da choices[0].message.content")
check(CALLS[0]['url'] == 'http://127.0.0.1:1234/v1/chat/completions',
      "base_url che finisce con /v1 non viene raddoppiato: %s" % CALLS[0]['url'])
check(CALLS[0]['headers'].get('Authorization') == 'Bearer ' + OPENAI_SECRET,
      "la chiave viaggia come Bearer")
P.update_provider(OPID, {"base_url": "http://127.0.0.1:1234"})
CALLS.clear()
aiclient.ai_answer_text("x")
check(CALLS[0]['url'] == 'http://127.0.0.1:1234/v1/chat/completions',
      "base_url senza /v1 lo riceve: %s" % CALLS[0]['url'])
NEXT_HTTP[0] = {"choices": [{"message": {"content": [{"type": "text", "text": "a blocchi"}]}}]}
check(aiclient.ai_answer_text("x") == "a blocchi",
      "un gateway che rende `content` a blocchi viene comunque letto")
NEXT_HTTP[0] = {"choices": []}
try:
    aiclient.ai_answer_text("x"); check(False, "risposta senza testo deve sollevare")
except P.AIFormatError:
    check(True, "risposta senza testo -> AIFormatError")

print("\n=== provider custom (percorsi configurabili) ===")
cent = P.add_provider({"type": "custom", "label": "Mio endpoint",
                       "base_url": "https://esempio.test/v9/gen",
                       "api_key": "chiave-custom-9999",
                       "prompt_path": "input.messages.0.text",
                       "response_path": "result.output.0.content",
                       "auth_header": "X-Api-Token", "auth_prefix": "",
                       "body_template": '{"stream": false}'})
P.set_active_provider(cent['id'])
CALLS.clear()
NEXT_HTTP[0] = {"result": {"output": [{"content": "testo custom"}]}}
check(aiclient.ai_answer_text("PROMPT") == "testo custom",
      "response_path a punti legge il testo dove dice l'utente")
check(CALLS[0]['payload']['input']['messages'][0]['text'] == 'PROMPT',
      "prompt_path crea i livelli intermedi: %s" % json.dumps(CALLS[0]['payload']))
check(CALLS[0]['payload']['stream'] is False, "il body_template e' preservato")
check(CALLS[0]['headers'].get('X-Api-Token') == 'chiave-custom-9999',
      "auth_header/auth_prefix personalizzati")
check(CALLS[0]['url'] == 'https://esempio.test/v9/gen',
      "il custom usa base_url cosi' com'e'")
NEXT_HTTP[0] = {"result": {}}
try:
    aiclient.ai_answer_text("x"); check(False, "percorso mancante deve sollevare")
except P.AIFormatError as e:
    check('result.output.0.content' in str(e),
          "l'errore dice QUALE percorso non ha trovato")
# Il registro non deve mutare fra due chiamate: `payload` parte da una copia.
CALLS.clear()
NEXT_HTTP[0] = {"result": {"output": [{"content": "due"}]}}
aiclient.ai_answer_text("SECONDO")
check(P.get_provider(cent['id'])['body_template'] == '{"stream": false}',
      "il body_template sul registro non viene mutato dalla chiamata")

print("\n=== validazione ===")
for bad, why in (({"type": "openai_compatible"}, 'base_url mancante'),
                 ({"type": "boh"}, 'tipo sconosciuto'),
                 ({"type": "gemini_cookies"}, 'il predefinito non si duplica'),
                 ({"type": "custom", "base_url": "ftp://x"}, 'schema non http')):
    try:
        P.add_provider(bad); check(False, "add rifiuta: %s" % why)
    except ValueError:
        check(True, "add rifiuta: %s" % why)

print("\n=== test_provider classifica invece di sollevare ===")
P.set_active_provider(PID)
NEXT_HTTP[0] = {"content": [{"type": "text", "text": "OK"}], "stop_reason": "end_turn"}
r = P.test_provider(PID)
check(r['ok'] is True and r['kind'] == 'ok', "prova riuscita -> ok")
for code, kind in ((401, 'auth'), (429, 'transient'), (400, 'format')):
    NEXT_HTTP[0] = http_status(code)
    r = P.test_provider(PID)
    check(r['ok'] is False and r['kind'] == kind,
          "prova con HTTP %d -> kind=%s (ricevuto %s)" % (code, kind, r['kind']))
check(SECRET not in json.dumps(P.test_provider(PID)),
      "l'esito della prova non contiene la chiave")

print("\n=== chiave assente: errore parlante, nessuna chiamata ===")
nokey = P.add_provider({"type": "anthropic", "label": "Senza chiave"})
P.set_active_provider(nokey['id'])
CALLS.clear()
try:
    aiclient.ai_answer_text("x"); check(False, "senza chiave deve sollevare")
except P.AIAuthError:
    check(True, "provider senza chiave -> AIAuthError")
check(not CALLS, "senza chiave non si chiama nemmeno il provider")

print("\n=== eliminazione dell'attivo -> ritorno a Gemini ===")
P.set_active_provider(PID)
P.delete_provider(PID)
check(P.list_providers()['active'] == 'gemini',
      "cancellando l'attivo si torna al predefinito")
check(P.get_api_key(PID) == '', "la chiave viene cancellata col provider")
check(SECRET not in open(P.get_keys_path(), encoding='utf-8').read(),
      "la chiave non resta nel file chiavi")
GEMINI_CALLS[0] = 0
check(aiclient.ai_answer_text("ciao") == 'risposta di gemini',
      "dopo l'eliminazione si torna a generare con Gemini")
check(GEMINI_CALLS[0] == 1, "e la chiamata e' andata davvero al client Gemini")
try:
    P.set_active_provider('inesistente'); check(False, "attivare un id ignoto deve sollevare")
except ValueError:
    check(True, "attivare un id inesistente e' rifiutato")


# --- Rotte HTTP sul vero server ---------------------------------------------
print("\n=== rotte /api/providers sul vero ThreadingHTTPServer ===")

def req(method, path, body=None):
    url = 'http://127.0.0.1:%d%s' % (main.PORT, path)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={'Content-Type': 'application/json'} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

th = threading.Thread(target=main.start_server, daemon=True); th.start()
for _ in range(200):
    if main.PORT:
        break
    time.sleep(0.05)
check(bool(main.PORT), "server avviato sulla porta %s" % main.PORT)

s, d = req('GET', '/api/settings')
check(s == 200 and isinstance(d.get('provider'), dict),
      "/api/settings espone il riassunto del provider")
check(d['provider']['active'] == 'gemini' and d['provider']['usesCookies'] is True,
      "a riposo /api/settings dice Gemini")
check(SECRET not in json.dumps(d) and OPENAI_SECRET not in json.dumps(d),
      "/api/settings non contiene nessuna chiave")

s, d = req('GET', '/api/providers')
check(s == 200 and any(p['id'] == 'gemini' for p in d['providers']),
      "GET /api/providers elenca il predefinito")
check(OPENAI_SECRET not in json.dumps(d), "GET /api/providers non fa trapelare chiavi")
s, d = req('GET', '/api/providers/models')
check(s == 200 and d.get('type') == P.TYPE_GEMINI,
      "GET /api/providers/models a riposo e' Gemini")
check(all(str(m.get('id', '')).startswith('gemini') for m in (d.get('models') or [])),
      "Gemini cookie: il catalogo resta quello di sempre")

s, d = req('POST', '/api/providers', {"type": "anthropic", "label": "Via HTTP",
                                      "model": "claude-sonnet-5",
                                      "api_key": 'sk-http-SEGRETO-0007'})
check(s == 200 and d['provider']['keyMask'] == '****0007',
      "POST /api/providers crea e ritorna mascherato")
HPID = d['provider']['id']
check('sk-http-SEGRETO-0007' not in json.dumps(d),
      "la risposta della creazione non contiene la chiave")

s, d = req('POST', '/api/providers', {"id": HPID, "label": "Rinominato via HTTP"})
check(s == 200 and d['provider']['label'] == 'Rinominato via HTTP',
      "POST con id modifica invece di creare")
check(P.get_api_key(HPID) == 'sk-http-SEGRETO-0007',
      "la modifica via HTTP non perde la chiave")

s, d = req('POST', '/api/providers', {"action": "activate", "id": HPID})
check(s == 200 and d['active'] == HPID, "action=activate cambia l'attivo")
s, d = req('GET', '/api/settings')
check(d['provider']['usesCookies'] is False and d['provider']['activeType'] == 'anthropic',
      "/api/settings segue l'attivo")
_saved_get = P._http_get_json
P._http_get_json = lambda url, headers, timeout=15, label="": {
    "data": [{"id": "claude-sonnet-5", "display_name": "Sonnet 5"}]}
try:
    s, d = req('GET', '/api/providers/models')
finally:
    P._http_get_json = _saved_get
check(s == 200 and d.get('type') == 'anthropic',
      "GET /api/providers/models segue l'attivo (non Gemini)")
check(all(not str(m.get('id', '')).startswith('gemini') for m in (d.get('models') or [])),
      "con Anthropic attivo il catalogo non contiene Gemini")

NEXT_HTTP[0] = {"content": [{"type": "text", "text": "OK"}], "stop_reason": "end_turn"}
s, d = req('POST', '/api/providers/test', {"id": HPID})
check(s == 200 and d['ok'] is True, "POST /api/providers/test riuscito -> 200 ok:true")
NEXT_HTTP[0] = http_status(401)
s, d = req('POST', '/api/providers/test', {"id": HPID})
check(s == 200 and d['ok'] is False and d['kind'] == 'auth',
      "una prova fallita resta 200 con kind=auth (non un 401 HTTP)")

# Le insidie del corpo: un handler che solleva chiude il socket SENZA risposta.
s, d = req('POST', '/api/providers', None)
check(s == 400, "POST senza corpo -> 400 (non socket chiuso), ricevuto %s" % s)
for raw in (b'[]', b'"stringa"', b'{ non json'):
    url = 'http://127.0.0.1:%d/api/providers' % main.PORT
    r = urllib.request.Request(url, data=raw, method='POST',
                               headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
    check(code == 400, "corpo %r -> 400 (ricevuto %s)" % (raw[:12], code))
s, d = req('POST', '/api/providers/test', {})
check(s == 400, "test senza id -> 400")
s, d = req('DELETE', '/api/providers')
check(s == 400, "DELETE senza id -> 400")
s, d = req('DELETE', '/api/providers?id=gemini')
check(s == 400, "DELETE del predefinito -> 400")
s, d = req('DELETE', '/api/providers?id=%s' % HPID)
check(s == 200 and d['active'] == 'gemini',
      "DELETE dell'attivo -> 200 e ritorno a Gemini")
s, d = req('DELETE', '/api/providers?id=%s' % HPID)
check(s == 400, "DELETE di un id inesistente -> 400")

# Ultima rete di sicurezza: nessuna delle chiavi usate nel test compare in
# NESSUNA delle risposte pubbliche, lette una volta di piu' tutte insieme.
_public = json.dumps([req('GET', '/api/settings')[1], req('GET', '/api/providers')[1],
                      __import__('settings').get_public_settings()])
for s_ in (SECRET, OPENAI_SECRET, 'sk-http-SEGRETO-0007', 'chiave-custom-9999'):
    check(s_ not in _public, "nessuna traccia di %s nei payload pubblici" % s_[:12])

if fails:
    print("\n%d CHECK FALLITI" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("\nTUTTI I CHECK OK (%s)" % _TMP)
