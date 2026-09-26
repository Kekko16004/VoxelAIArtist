"""Registro dei provider AI: Gemini a cookie (default) + provider a chiave API.

Perche' esiste
--------------
Fino a qui l'unico modo di generare era il client web `gemini`, autenticato coi
cookie del browser. Funziona a configurazione zero ed e' giusto che resti il
DEFAULT, ma non e' l'unica AI al mondo e non e' un'API con codici di stato. Qui
si aggiungono provider veri (Anthropic, qualunque endpoint OpenAI-compatibile, e
un tipo "custom" per il resto) senza toccare la via a cookie.

Il contratto verso il resto dell'app e' UNA funzione: `complete(prompt) -> str`.
Tutto il resto (registro, chiavi, mascheramento, classificazione errori) sta qui
dentro, cosi' `aiclient.ai_answer_text` resta la stessa funzione di prima con lo
stesso significato: "una chiamata all'AI, testo grezzo in uscita".

Dove vivono le credenziali (decisione, non gusto)
-------------------------------------------------
Le impostazioni stanno in `get_appdata_dir()` (che si SPOSTA con `set_app_name`:
PixelAIEditor ha le sue). I cookie stanno in `get_cookies_dir()`, che e' FISSO e
condiviso fra le app perche' un cookie e' una sessione Google, non una preferenza.

Una chiave API e' una credenziale come un cookie, non e' una preferenza — quindi
NON puo' finire in `settings.json` (che `merge_settings` rispedisce al client) e
va nella stessa famiglia dei cookie. Ma non e' una sessione Google condivisa: e'
una credenziale dell'utente presso un terzo. Vale comunque `get_cookies_dir()`,
cioe' la cartella FISSA condivisa, per due motivi:

  1. Chi configura la propria chiave Anthropic in VoxelAIArtist la vuole quasi
     certamente anche in PixelAIEditor: e' la stessa persona, lo stesso account,
     e le due app girano una dentro l'altra (ponte iframe). Chiederla due volte
     sarebbe lo stesso difetto che `COOKIES_APP_NAME` esiste per evitare.
  2. Decisivo: registro e chiavi devono stare nella STESSA famiglia di cartelle.
     Se il registro fosse per-app (APP_NAME) e le chiavi condivise, l'id `p1` di
     PixelAIEditor potrebbe essere OpenAI mentre `p1` del padre e' Anthropic, e
     entrambi leggerebbero lo stesso file chiavi: si manderebbe la chiave
     sbagliata al provider sbagliato. Tenendoli entrambi sotto il nome fisso, la
     divergenza e' impossibile per costruzione.

Sono comunque DUE file:
  - `providers.json`     — il registro. Non contiene chiavi, per costruzione.
  - `provider_keys.json` — solo `{provider_id: api_key}`.
Cosi' il mascheramento non e' una promessa ma una proprieta' strutturale:
`list_providers()` legge solo il registro, e non puo' far trapelare quello che
nel registro non c'e'.
"""

import json
import os
import re
import time
import uuid

import settings as app_settings


# --- Errori AI "parlanti" ---------------------------------------------------
# Definiti QUI, cioe' nello strato piu' basso, e re-esportati da `aiclient`:
# devono essere gli STESSI oggetti ovunque o `except AIAuthError` fallirebbe a
# seconda di chi ha importato cosa. `main.py` continua a importarli da
# `aiclient` come prima.

class AIAuthError(RuntimeError):
    """Credenziali mancanti/scadute: l'utente deve sistemare le impostazioni."""


class AITransientError(RuntimeError):
    """Rete, quota o rate-limit: la stessa richiesta puo' funzionare piu' tardi."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class AIFormatError(RuntimeError):
    """Il modello ha risposto, ma non con qualcosa di utilizzabile."""

    def __init__(self, message, answer=None):
        super().__init__(message)
        self.answer = answer


# --- Tipi di provider -------------------------------------------------------

TYPE_GEMINI = "gemini_cookies"
TYPE_ANTHROPIC = "anthropic"
TYPE_OPENAI = "openai_compatible"
TYPE_CUSTOM = "custom"

PROVIDER_TYPES = (TYPE_GEMINI, TYPE_ANTHROPIC, TYPE_OPENAI, TYPE_CUSTOM)

# Chi PUO' ricevere un'immagine. E' una capacita' DICHIARATA per tipo, non una
# promessa: il modello configurato dentro un tipo che la sostiene puo' comunque
# non essere multimodale (gpt-3.5, un Ollama testuale, un gateway che scarta il
# blocco immagine senza dirlo). Per questo esiste una SONDA che la verifica
# davvero mandando un'immagine di prova; qui si sa solo dove l'immagine ha un
# posto sintatticamente valido in cui andare.
#
# `custom` e' fuori per costruzione: l'utente descrive dove infilare il PROMPT
# (`prompt_path`), e non esiste nessun percorso ovvio dove infilare un'immagine
# in un endpoint che non abbiamo mai visto. Indovinarlo manderebbe un corpo che
# il provider rifiuta con un 400 illeggibile.
VISION_BY_TYPE = {
    TYPE_GEMINI: True,
    TYPE_ANTHROPIC: True,
    TYPE_OPENAI: True,
    TYPE_CUSTOM: False,
}

# Il client `gemini` accetta UNA immagine per chiamata
# (`generate_content(prompt, image)`), non una lista. Chi ha piu' viste da
# mostrare compone un contact sheet: e' una scelta che il chiamante deve fare
# consapevolmente, quindi qui si dichiara il limite invece di troncare in
# silenzio la seconda immagine.
MAX_IMAGES_BY_TYPE = {
    TYPE_GEMINI: 1,
    TYPE_ANTHROPIC: 8,
    TYPE_OPENAI: 8,
    TYPE_CUSTOM: 0,
}

# Il provider di default non sta nel registro: e' un'entry SINTETICA, sempre
# presente e non cancellabile. Se stesse su disco, un utente potrebbe
# cancellarla e restare senza alcun modo di generare a configurazione zero —
# che e' esattamente la proprieta' da non perdere.
GEMINI_ID = "gemini"

DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com"
ANTHROPIC_VERSION = "2023-06-01"

# Modelli suggeriti nella UI. Sono SUGGERIMENTI: il campo resta libero, perche'
# un elenco chiuso invecchia e bloccherebbe l'utente su un modello uscito ieri.
ANTHROPIC_MODELS = ("claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5")

# Stessa cosa per Gemini a cookie: il selettore della UI legge QUESTA lista
# quando il provider attivo e' Gemini, non un array hardcoded nel frontend.
GEMINI_MODELS = (
    {"id": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"},
    {"id": "gemini-3.1-pro", "label": "Gemini 3.1 Pro"},
)

# Endpoint /v1/models restituisce anche embedding, TTS, immagini: non stanno
# nel selettore di generazione.
_NON_CHAT_HINTS = (
    "embed", "whisper", "tts", "dall-e", "dalle", "image", "moderation",
    "transcribe", "audio", "realtime", "sora",
)

DEFAULT_TIMEOUT = 180
# Tetto di token in uscita. 16000 e' il valore consigliato per le richieste NON
# in streaming: sta sotto i timeout HTTP e basta per un modello a ops compatte.
DEFAULT_MAX_TOKENS = 16000

# 502-504 e i 52x di Cloudflare: il proxy ha tagliato, non e' un 429.
# Ritentarli dopo 20s con lo stesso prompt enorme fallisce di nuovo.
GATEWAY_TIMEOUTS = (502, 503, 504, 520, 521, 522, 523, 524)

_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


# --- Persistenza ------------------------------------------------------------

def get_credentials_dir():
    """Cartella di registro e chiavi: quella FISSA dei cookie (vedi il docstring
    del modulo per il perche').

    `VOXELAI_PROVIDERS_DIR` la sposta. Serve ai TEST: senza, la suite leggerebbe
    la configurazione reale dell'utente e, con un provider a chiave API attivo,
    proverebbe una chiamata di rete vera — mentre la suite deve girare senza
    rete, senza cookie e senza quota. Stessa idea di `PackManager(storage_dir=)`.
    """
    override = os.environ.get("VOXELAI_PROVIDERS_DIR")
    if override:
        try:
            os.makedirs(override, exist_ok=True)
        except OSError:
            pass
        return override
    return app_settings.get_cookies_dir()


def get_providers_path():
    """Registro dei provider (nessuna chiave dentro)."""
    return os.path.join(get_credentials_dir(), "providers.json")


def get_keys_path():
    """Solo le chiavi API, separate dal registro."""
    return os.path.join(get_credentials_dir(), "provider_keys.json")


def _read_json(path, fallback):
    if not os.path.exists(path):
        return fallback
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:                                       # noqa: BLE001
        return fallback
    if not isinstance(data, type(fallback)):
        return fallback
    return data


def _write_json(path, data, private=False):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    if private:
        # Best-effort: su Windows e' un no-op (gli ACL non passano da qui), su
        # POSIX toglie la lettura a gruppo/altri. Fallire qui non deve impedire
        # di salvare la chiave.
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def _load_registry():
    data = _read_json(get_providers_path(), {})
    items = data.get("providers")
    if not isinstance(items, list):
        items = []
    clean = [p for p in items if isinstance(p, dict) and p.get("id")]
    return {"providers": clean, "active": data.get("active") or GEMINI_ID}


def _save_registry(reg):
    _write_json(get_providers_path(), {
        "providers": reg.get("providers", []),
        "active": reg.get("active") or GEMINI_ID,
    })


def _load_keys():
    return _read_json(get_keys_path(), {})


def _save_keys(keys):
    _write_json(get_keys_path(), keys, private=True)


def get_api_key(provider_id):
    """Chiave in chiaro di un provider. Non esce MAI da questo modulo verso HTTP."""
    keys = _load_keys()
    val = keys.get(str(provider_id))
    return val if isinstance(val, str) else ""


def set_api_key(provider_id, key):
    keys = _load_keys()
    pid = str(provider_id)
    if key:
        keys[pid] = str(key)
    else:
        keys.pop(pid, None)
    _save_keys(keys)


# --- Mascheramento ----------------------------------------------------------

def mask_key(value):
    """'sk-ant-abc...WXYZ' -> '****WXYZ'. Stringa vuota se non c'e' chiave.

    Non ritorna mai un prefisso: su alcune chiavi il prefisso identifica
    l'organizzazione, e comunque non serve a riconoscerla — le ultime 4 si'.
    """
    s = str(value or "")
    if not s:
        return ""
    if len(s) <= 4:
        return "*" * len(s)
    return "****" + s[-4:]


# --- Entry sintetica del default -------------------------------------------

def _gemini_entry():
    return {
        "id": GEMINI_ID,
        "type": TYPE_GEMINI,
        "label": "Google Gemini",
        "model": "",
        "builtin": True,
        "needsKey": False,
        "hasKey": True,          # l'autenticazione e' a cookie: qui non serve chiave
    }


def _public_entry(entry):
    """Entry pubblica: MAI la chiave, solo la maschera e un booleano."""
    key = get_api_key(entry.get("id"))
    out = {
        "id": entry.get("id"),
        "type": entry.get("type"),
        "label": entry.get("label") or entry.get("id"),
        "model": entry.get("model") or "",
        "base_url": entry.get("base_url") or "",
        "builtin": False,
        "needsKey": True,
        "hasKey": bool(key),
        "keyMask": mask_key(key),
        "max_tokens": entry.get("max_tokens") or DEFAULT_MAX_TOKENS,
    }
    if entry.get("headers"):
        out["headers"] = dict(entry["headers"])
    # Anche qui `is not None`: un `auth_prefix` vuoto salvato deve tornare al
    # form come vuoto, o il salvataggio successivo lo rimetterebbe a "Bearer ".
    for k in ("auth_header", "auth_prefix", "prompt_path", "response_path", "body_template"):
        if entry.get(k) is not None:
            out[k] = entry[k]
    return out


# --- API pubblica del registro ---------------------------------------------

def list_providers():
    """Elenco pubblico (mascherato) + id dell'attivo.

    Legge il registro, che per costruzione non contiene chiavi: la chiave viene
    letta a parte e trasformata subito in maschera, quindi nessun percorso di
    questa funzione ha mai in mano la chiave in chiaro dentro un dict pubblico.
    """
    reg = _load_registry()
    items = [_gemini_entry()] + [_public_entry(p) for p in reg["providers"]]
    active = reg["active"]
    if not any(p["id"] == active for p in items):
        active = GEMINI_ID
    return {"providers": items, "active": active, "types": list(PROVIDER_TYPES),
            "anthropicModels": list(ANTHROPIC_MODELS),
            "geminiModels": [m["id"] for m in GEMINI_MODELS]}


def get_provider(provider_id):
    """Entry INTERNA (con base_url e header, senza chiave) o None."""
    pid = str(provider_id or "")
    if pid == GEMINI_ID:
        return _gemini_entry()
    for p in _load_registry()["providers"]:
        if p.get("id") == pid:
            return p
    return None


def get_active_provider():
    """Il provider attivo, con fallback a Gemini se l'attivo e' sparito."""
    reg = _load_registry()
    entry = get_provider(reg["active"])
    return entry or _gemini_entry()


def _normalize_headers(raw):
    """Header extra: solo coppie stringa->stringa. Un dict annidato qui
    diventerebbe un TypeError dentro urllib, cioe' un 500 senza spiegazione."""
    out = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            key = str(k).strip()
            if key:
                out[key] = str(v)
    return out


def _validate(entry):
    ptype = entry.get("type")
    if ptype not in PROVIDER_TYPES or ptype == TYPE_GEMINI:
        raise ValueError("tipo provider non valido: %s" % (ptype,))
    if ptype in (TYPE_OPENAI, TYPE_CUSTOM) and not entry.get("base_url"):
        raise ValueError("base_url obbligatorio per il tipo %s" % ptype)
    url = entry.get("base_url") or ""
    if url and not url.startswith(("http://", "https://")):
        raise ValueError("base_url deve iniziare con http:// o https://")
    return entry


def add_provider(data):
    """Aggiunge un provider. `data['api_key']` finisce nel file chiavi, MAI nel
    registro. Ritorna l'entry pubblica (mascherata)."""
    if not isinstance(data, dict):
        raise ValueError("il provider deve essere un oggetto JSON")
    reg = _load_registry()
    pid = str(data.get("id") or "").strip()
    if not pid or not _ID_RE.match(pid) or pid == GEMINI_ID:
        pid = "p_" + uuid.uuid4().hex[:8]
    if any(p.get("id") == pid for p in reg["providers"]):
        raise ValueError("esiste gia' un provider con id %s" % pid)
    entry = {
        "id": pid,
        "type": str(data.get("type") or "").strip(),
        "label": str(data.get("label") or "").strip() or pid,
        "model": str(data.get("model") or "").strip(),
        "base_url": str(data.get("base_url") or "").strip().rstrip("/"),
        "headers": _normalize_headers(data.get("headers")),
        "created_at": int(time.time()),
    }
    # `is not None` e non la verita': un `auth_prefix` VUOTO e' un valore, non
    # un campo assente. Significa "manda la chiave nuda", che e' come funziona
    # un header tipo `X-Api-Token`; trattarlo come assente ci rimetterebbe
    # "Bearer " davanti e il provider risponderebbe 401.
    for k in ("auth_header", "auth_prefix", "prompt_path", "response_path", "body_template"):
        if data.get(k) is not None:
            entry[k] = str(data[k]).strip() if k != "body_template" else data[k]
    if entry["type"] == TYPE_ANTHROPIC and not entry["base_url"]:
        entry["base_url"] = DEFAULT_ANTHROPIC_BASE
    try:
        entry["max_tokens"] = max(1, int(data.get("max_tokens") or DEFAULT_MAX_TOKENS))
    except (TypeError, ValueError):
        entry["max_tokens"] = DEFAULT_MAX_TOKENS
    _validate(entry)
    reg["providers"].append(entry)
    _save_registry(reg)
    if data.get("api_key"):
        set_api_key(pid, data["api_key"])
    return _public_entry(entry)


def update_provider(provider_id, data):
    """Modifica IN PLACE i campi passati. Una `api_key` vuota/assente NON
    cancella quella salvata: il form non la rimanda mai (vede solo la maschera),
    quindi trattarla come "vuota = togli" cancellerebbe la chiave a ogni
    salvataggio di un'etichetta."""
    if not isinstance(data, dict):
        raise ValueError("il provider deve essere un oggetto JSON")
    pid = str(provider_id or "")
    if pid == GEMINI_ID:
        raise ValueError("il provider predefinito non e' modificabile")
    reg = _load_registry()
    for entry in reg["providers"]:
        if entry.get("id") != pid:
            continue
        if data.get("type"):
            entry["type"] = str(data["type"]).strip()
        for field in ("label", "model", "auth_header", "auth_prefix",
                      "prompt_path", "response_path"):
            if field in data and data[field] is not None:
                entry[field] = str(data[field]).strip()
        if "base_url" in data and data["base_url"] is not None:
            entry["base_url"] = str(data["base_url"]).strip().rstrip("/")
        if "headers" in data:
            entry["headers"] = _normalize_headers(data.get("headers"))
        if "body_template" in data and data["body_template"]:
            entry["body_template"] = data["body_template"]
        if data.get("max_tokens"):
            try:
                entry["max_tokens"] = max(1, int(data["max_tokens"]))
            except (TypeError, ValueError):
                pass
        _validate(entry)
        _save_registry(reg)
        if data.get("api_key"):
            set_api_key(pid, data["api_key"])
        return _public_entry(entry)
    raise ValueError("provider non trovato: %s" % pid)


def delete_provider(provider_id):
    """Elimina provider e chiave. Se era l'attivo si torna a Gemini: lasciare
    attivo un id inesistente renderebbe l'app inutilizzabile fino al prossimo
    giro nelle impostazioni."""
    pid = str(provider_id or "")
    if pid == GEMINI_ID:
        raise ValueError("il provider predefinito non e' eliminabile")
    reg = _load_registry()
    before = len(reg["providers"])
    reg["providers"] = [p for p in reg["providers"] if p.get("id") != pid]
    if len(reg["providers"]) == before:
        raise ValueError("provider non trovato: %s" % pid)
    if reg["active"] == pid:
        reg["active"] = GEMINI_ID
    _save_registry(reg)
    set_api_key(pid, None)
    return list_providers()


def set_active_provider(provider_id):
    pid = str(provider_id or "")
    if pid != GEMINI_ID and get_provider(pid) is None:
        raise ValueError("provider non trovato: %s" % pid)
    reg = _load_registry()
    reg["active"] = pid or GEMINI_ID
    _save_registry(reg)
    return list_providers()


# --- Classificazione errori HTTP -------------------------------------------

def classify_http_status(status, body, label=""):
    """Codice di stato -> una delle tre classi.

    Un'API vera i codici li ha: qui NON si applicano le euristiche testuali di
    Gemini (che esistono solo perche' quel client i codici non li espone).
    401/403 = credenziali; 429 e 5xx = transitorio; il resto dei 4xx = richiesta
    sbagliata, che NON va ritentata e va mostrata all'utente com'e'.
    """
    detail = _short(body)
    who = (label + ": ") if label else ""
    if status in (401, 403):
        return AIAuthError(
            "%sla chiave API e' mancante, non valida o senza permessi (HTTP %s). "
            "Aprire le Impostazioni e reimpostarla. Dettaglio: %s"
            % (who, status, detail))
    if status == 429 or status >= 500:
        if status in GATEWAY_TIMEOUTS:
            return AITransientError(
                "%sil proxy ha tagliato la richiesta (HTTP %s) prima che il "
                "modello finisse. Riprovo subito in streaming. Dettaglio: %s"
                % (who, status, detail), status=status)
        return AITransientError(
            "%sservizio momentaneamente non disponibile o limite di richieste "
            "raggiunto (HTTP %s). Riprovare fra qualche minuto. Dettaglio: %s"
            % (who, status, detail), status=status)
    return AIFormatError(
        "%srichiesta rifiutata dal provider (HTTP %s). Controllare modello, "
        "base URL e parametri. Dettaglio: %s" % (who, status, detail))


def classify_network_error(exc, label=""):
    """Errori di rete: sempre transitori (DNS giu', TLS, timeout, host spento)."""
    who = (label + ": ") if label else ""
    return AITransientError(
        "%simpossibile contattare il provider AI. Riprovare fra qualche minuto. "
        "Dettaglio: %s" % (who, _short(str(exc) or exc.__class__.__name__)))


def _short(text, limit=400):
    s = str(text or "").strip().replace("\r", " ").replace("\n", " ")
    return s[:limit] + ("..." if len(s) > limit else "")


# --- Trasporto HTTP ---------------------------------------------------------

def _http_get_json(url, headers, timeout=15, label=""):
    """GET JSON -> dict. Stesso trasporto e stesse classi d'errore del POST:
    una chiave sbagliata su /v1/models e' un AIAuthError, non un 500 muto."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, method="GET")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:                                   # noqa: BLE001
            pass
        raise classify_http_status(e.code, body or e.reason, label) from e
    except urllib.error.URLError as e:
        raise classify_network_error(e.reason or e, label) from e
    except OSError as e:
        raise classify_network_error(e, label) from e
    try:
        return json.loads(raw)
    except ValueError as e:
        raise AIFormatError(
            "Risposta del provider non in JSON. Dettaglio: %s" % _short(raw)) from e


def _delta_text(obj):
    """Testo visibile da un chunk SSE o da un message OpenAI-compatibile."""
    if not isinstance(obj, dict):
        return ""
    parts = []
    for key in ("content", "text"):
        val = obj.get(key)
        if isinstance(val, str) and val:
            parts.append(val)
        elif isinstance(val, list):
            parts.append("".join(
                b.get("text", "") for b in val if isinstance(b, dict)))
    return "".join(parts)


def _read_openai_sse(resp):
    """Accumula i delta SSE in un dict con la stessa forma del non-stream."""
    chunks, reason = [], []
    buf = b""
    while True:
        piece = resp.read(1024)
        if not piece:
            break
        buf += piece
        while b"\n" in buf:
            raw_line, buf = buf.split(b"\n", 1)
            line = raw_line.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                text = "".join(chunks).strip()
                if not text:
                    text = "".join(reason).strip()
                return {"choices": [{"message": {"content": text}}]}
            try:
                ev = json.loads(data)
            except ValueError:
                continue
            choice = (ev.get("choices") or [{}])[0] if isinstance(ev, dict) else {}
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta") or choice.get("message") or {}
            if isinstance(delta, dict):
                bit = _delta_text(delta)
                if bit:
                    chunks.append(bit)
                rc = delta.get("reasoning_content")
                if isinstance(rc, str) and rc:
                    reason.append(rc)
    text = "".join(chunks).strip() or "".join(reason).strip()
    return {"choices": [{"message": {"content": text}}]}


def _http_post_json(url, headers, payload, timeout=DEFAULT_TIMEOUT, label=""):
    """POST JSON -> dict. Solo stdlib: `requests` sarebbe una dipendenza in piu'
    per fare la stessa cosa, e questo modulo deve poter girare in un bundle
    PyInstaller senza aggiungere niente al .spec.

    Con `stream: true` legge SSE a pezzi: Cloudflare (524) taglia se il
    primo byte non arriva, e Grok 4.5 ragiona a lungo prima di chiudere
    una risposta intera. I chunk tengono vivo il tunnel.

    L'import di urllib e' locale per coerenza col resto del modulo (nessun costo
    a import-time per chi non genera mai)."""
    import urllib.error
    import urllib.request

    stream = isinstance(payload, dict) and payload.get("stream")
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if stream:
                return _read_openai_sse(resp)
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:                                   # noqa: BLE001
            pass
        raise classify_http_status(e.code, body or e.reason, label) from e
    except urllib.error.URLError as e:
        raise classify_network_error(e.reason or e, label) from e
    except OSError as e:
        raise classify_network_error(e, label) from e
    try:
        return json.loads(raw)
    except ValueError as e:
        raise AIFormatError(
            "Risposta del provider non in JSON. Dettaglio: %s" % _short(raw)) from e


def _dig(obj, path):
    """Estrae un valore con un percorso tipo 'choices.0.message.content'.

    Serve al tipo `custom`: senza, l'unico modo di supportare un provider con una
    forma diversa sarebbe scrivergli un branch dedicato ogni volta.
    """
    cur = obj
    for token in str(path or "").split("."):
        if token == "":
            continue
        if isinstance(cur, list):
            try:
                cur = cur[int(token)]
            except (ValueError, IndexError):
                return None
        elif isinstance(cur, dict):
            if token not in cur:
                return None
            cur = cur[token]
        else:
            return None
    return cur


def _set_path(obj, path, value):
    """Scrive `value` dentro `obj` seguendo un percorso a punti, creando i dict
    intermedi. Usato dal body_template del tipo `custom`."""
    tokens = [t for t in str(path or "").split(".") if t != ""]
    if not tokens:
        return obj
    cur = obj
    for i, token in enumerate(tokens[:-1]):
        nxt = tokens[i + 1]
        if isinstance(cur, list):
            idx = int(token) if token.isdigit() else 0
            while len(cur) <= idx:
                cur.append([] if nxt.isdigit() else {})
            cur = cur[idx]
        else:
            if token not in cur or not isinstance(cur[token], (dict, list)):
                cur[token] = [] if nxt.isdigit() else {}
            cur = cur[token]
    last = tokens[-1]
    if isinstance(cur, list):
        idx = int(last) if last.isdigit() else 0
        while len(cur) <= idx:
            cur.append(None)
        cur[idx] = value
    else:
        cur[last] = value
    return obj


# --- Immagini in ingresso ---------------------------------------------------

_IMAGE_MIMES = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "webp": "image/webp", "gif": "image/gif",
}


def normalize_images(images):
    """Porta qualunque forma ragionevole a `[{"mime", "b64", "bytes"}, ...]`.

    Si accettano: `bytes` grezzi, una data-URL (`data:image/png;base64,...`),
    base64 nudo, o un dict `{mime, data|b64}`. Un singolo elemento non in lista
    viene incartato. Motivo: questa funzione sta al confine fra tre chiamanti
    diversi (browser che manda data-URL, test che mandano bytes, MCP che manda
    percorsi) e ognuno userebbe la propria forma; normalizzare qui e' un punto
    solo invece di tre rami dentro ogni `_complete_*`.

    Un elemento non decodificabile e' un ERRORE, non un elemento saltato: una
    critica visiva fatta su zero immagini risponderebbe comunque qualcosa di
    plausibile, che e' il modo peggiore di fallire.
    """
    import base64

    if images is None:
        return []
    if isinstance(images, (bytes, bytearray, str, dict)):
        images = [images]
    out = []
    for item in images:
        mime, raw, b64 = "image/png", None, None
        if isinstance(item, (bytes, bytearray)):
            raw = bytes(item)
        elif isinstance(item, dict):
            mime = str(item.get("mime") or item.get("mimeType") or mime)
            payload = item.get("data")
            if payload is None:
                payload = item.get("b64")
            if isinstance(payload, (bytes, bytearray)):
                raw = bytes(payload)
            else:
                b64 = str(payload or "")
        elif isinstance(item, str):
            b64 = item
        else:
            raise AIFormatError("Immagine in un formato non riconosciuto: %s"
                                % type(item).__name__)
        if b64 is not None:
            s = b64.strip()
            if s.startswith("data:"):
                head, _, tail = s.partition(",")
                if ";" in head:
                    declared = head[5:].split(";", 1)[0].strip()
                    if declared:
                        mime = declared
                s = tail
            # Il base64 di un canvas arriva spesso con capi di riga dentro.
            s = "".join(s.split())
            if not s:
                raise AIFormatError("Immagine vuota.")
            try:
                raw = base64.b64decode(s, validate=False)
            except Exception as e:                          # noqa: BLE001
                raise AIFormatError("Immagine non decodificabile: %s" % e) from e
        if not raw:
            raise AIFormatError("Immagine vuota.")
        if mime not in _IMAGE_MIMES.values():
            # Un mime inventato fa fallire Anthropic con un 400: si ricade sul
            # PNG, che e' cio' che produce un canvas.
            mime = "image/png"
        out.append({"mime": mime, "bytes": raw,
                    "b64": base64.b64encode(raw).decode("ascii")})
    return out


def _limit_images(entry, images):
    """Taglia alla capienza del tipo, ma solo dopo averlo DETTO al chiamante."""
    ptype = entry.get("type")
    if not images:
        return []
    if not VISION_BY_TYPE.get(ptype, False):
        raise AIFormatError(
            "Il provider '%s' non sostiene le immagini: la critica visiva va "
            "disattivata o si sceglie un altro provider."
            % (entry.get("label") or entry.get("id") or ptype))
    cap = MAX_IMAGES_BY_TYPE.get(ptype, 1)
    if len(images) > cap:
        print("[ai] %d immagini richieste, il provider ne accetta %d: uso le prime."
              % (len(images), cap))
        return images[:cap]
    return images


def supports_images(provider=None):
    """`{supported, reason, maxImages}` per il provider indicato (o l'attivo).

    `reason` e' un CODICE, non una frase: chi lo mostra e' la UI, che sa in che
    lingua parla l'utente. Stessa regola degli avvisi delle ops 2D.
    """
    if isinstance(provider, dict):
        entry = provider
    elif provider:
        entry = get_provider(provider) or {}
    else:
        entry = get_active_provider()
    ptype = entry.get("type") or TYPE_GEMINI
    ok = bool(VISION_BY_TYPE.get(ptype, False))
    reason = "ok" if ok else ("customUnsupported" if ptype == TYPE_CUSTOM
                              else "typeUnsupported")
    return {"supported": ok, "reason": reason,
            "maxImages": MAX_IMAGES_BY_TYPE.get(ptype, 0),
            "type": ptype, "provider": entry.get("id")}


# --- Provider: Anthropic ----------------------------------------------------

def _complete_anthropic(entry, prompt, images=None):
    """POST /v1/messages. HTTP grezzo di proposito: il pacchetto `anthropic` non
    e' installato e aggiungerlo renderebbe l'app dipendente da una libreria che
    serve solo a chi sceglie questo provider."""
    key = get_api_key(entry["id"])
    if not key:
        raise AIAuthError(
            "Chiave API Anthropic non configurata. Aprire le Impostazioni e "
            "inserirla nella scheda del provider.")
    base = (entry.get("base_url") or DEFAULT_ANTHROPIC_BASE).rstrip("/")
    headers = {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
    }
    headers.update(_normalize_headers(entry.get("headers")))
    # Le immagini vanno PRIMA del testo: il modello legge in ordine e la
    # domanda deve arrivare dopo cio' su cui va risposta. Senza immagini il
    # contenuto resta la stringa nuda di sempre, cosi' il corpo inviato dai
    # chiamanti storici e' byte per byte quello di prima.
    content = prompt
    if images:
        content = [{"type": "image",
                    "source": {"type": "base64", "media_type": im["mime"],
                               "data": im["b64"]}} for im in images]
        content.append({"type": "text", "text": prompt})
    # Corpo MINIMO di proposito: `temperature`, `top_p`, `top_k` e
    # `thinking.budget_tokens` sono RIFIUTATI con 400 dai modelli recenti
    # (Opus 5/4.8/4.7, Sonnet 5, Fable 5), mentre model+max_tokens+messages e'
    # valido su ogni modello, vecchio e nuovo. Il campo modello e' libero, quindi
    # non si puo' sapere qui quale famiglia ha scelto l'utente.
    payload = {
        "model": entry.get("model") or ANTHROPIC_MODELS[0],
        "max_tokens": entry.get("max_tokens") or DEFAULT_MAX_TOKENS,
        "messages": [{"role": "user", "content": content}],
    }
    data = _http_post_json(base + "/v1/messages", headers, payload,
                           label=entry.get("label") or "Anthropic")
    stop = data.get("stop_reason")
    blocks = data.get("content")
    parts = []
    if isinstance(blocks, list):
        for b in blocks:
            # I blocchi hanno un TIPO: su un modello con thinking attivo il primo
            # blocco e' `thinking` e non ha `.text`. Leggere blocks[0].text darebbe
            # None (o il ragionamento) invece della risposta.
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                parts.append(b["text"])
    text = "".join(parts).strip()
    if stop == "refusal":
        raise AIFormatError(
            "Il modello ha rifiutato di rispondere a questa richiesta.", answer=text)
    if stop == "max_tokens" and not text:
        raise AIFormatError(
            "Risposta troncata dal limite di token: alzare 'Token massimi' nelle "
            "impostazioni del provider.", answer=text)
    if not text:
        raise AIFormatError("Il provider ha risposto senza testo.", answer="")
    return text


# --- Provider: OpenAI-compatibile ------------------------------------------

def _complete_openai(entry, prompt, images=None):
    """POST {base}/chat/completions con `Authorization: Bearer`.

    Copre OpenAI, OpenRouter, Groq, Together, LM Studio, Ollama, vLLM: e' lo
    stesso contratto. Il base_url si accetta sia con che senza `/v1` finale —
    scriverlo in un modo e vedere un 404 e' l'errore piu' comune di questa
    famiglia di endpoint, e non ha senso farlo pagare all'utente.
    """
    key = get_api_key(entry["id"])
    base = (entry.get("base_url") or "").rstrip("/")
    if not base:
        raise AIFormatError("base_url non configurato per questo provider.")
    url = base + ("/chat/completions" if base.endswith("/v1")
                  else "/v1/chat/completions")
    headers = {"content-type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    headers.update(_normalize_headers(entry.get("headers")))
    model = entry.get("model") or "gpt-4o-mini"
    # Senza immagini `content` resta una STRINGA: la forma a blocchi e' accettata
    # da OpenAI ma non da tutti i gateway compatibili (LM Studio e qualche
    # proxy la rifiutano o la appiattiscono male), quindi non la si impone a chi
    # non ne ha bisogno.
    content = prompt
    if images:
        content = [{"type": "text", "text": prompt}]
        for im in images:
            content.append({"type": "image_url", "image_url": {
                "url": "data:%s;base64,%s" % (im["mime"], im["b64"])}})
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        # Streaming: Grok 4.5 ragiona a lungo; senza chunk Cloudflare
        # (504/524) taglia prima che arrivi il primo byte.
        "stream": True,
    }
    limit = entry.get("max_tokens") or DEFAULT_MAX_TOKENS
    # grok/o1/o3/o4 rifiutano `max_tokens` (deprecato). Gli altri endpoint
    # OpenAI-compatibili accettano ancora quello.
    mid = str(model).lower()
    if mid.startswith("grok") or mid.startswith("o1") or mid.startswith("o3") \
            or mid.startswith("o4"):
        payload["max_completion_tokens"] = limit
    elif limit:
        payload["max_tokens"] = limit
    data = _http_post_json(url, headers, payload,
                           label=entry.get("label") or "OpenAI")
    text = _dig(data, "choices.0.message.content")
    if isinstance(text, list):
        # Alcuni gateway rendono `content` come lista di blocchi in stile Anthropic.
        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
    if not isinstance(text, str) or not text.strip():
        text = _dig(data, "choices.0.text")
    if not isinstance(text, str) or not text.strip():
        raise AIFormatError("Il provider ha risposto senza testo. Risposta: %s"
                            % _short(json.dumps(data)))
    return text


# --- Provider: custom -------------------------------------------------------

def _complete_custom(entry, prompt, images=None):
    """Provider generico: l'utente descrive dove va il prompt e dove sta la
    risposta. E' l'unico modo di supportare un endpoint che non abbiamo mai
    visto senza aggiungere un branch a ogni richiesta d'utente.

    - `body_template`: JSON di partenza (dict o stringa JSON).
    - `prompt_path`:   dove infilare il prompt (default `prompt`).
    - `response_path`: dove leggere il testo (default `text`).
    - `auth_header` / `auth_prefix`: come mandare la chiave (default
      `Authorization` / `Bearer `).

    Le immagini NON sono supportate e il caso arriva qui solo se qualcuno
    scavalca `_limit_images`: non esiste un percorso plausibile dove infilarle in
    un corpo arbitrario, e inventarne uno darebbe un 400 al posto di un
    messaggio comprensibile.
    """
    if images:
        raise AIFormatError(
            "Un provider di tipo 'custom' non puo' ricevere immagini: il corpo "
            "della richiesta e' definito dall'utente e non c'e' un campo noto "
            "in cui metterle.")
    key = get_api_key(entry["id"])
    base = (entry.get("base_url") or "").rstrip("/")
    if not base:
        raise AIFormatError("base_url non configurato per questo provider.")
    template = entry.get("body_template")
    if isinstance(template, str) and template.strip():
        try:
            template = json.loads(template)
        except ValueError as e:
            raise AIFormatError(
                "Il corpo JSON personalizzato non e' valido: %s" % e) from e
    if not isinstance(template, dict):
        template = {}
    payload = json.loads(json.dumps(template))  # copia profonda: il registro non si muta
    if entry.get("model") and "model" not in payload:
        payload["model"] = entry["model"]
    _set_path(payload, entry.get("prompt_path") or "prompt", prompt)
    headers = {"content-type": "application/json"}
    if key:
        auth_header = entry.get("auth_header") or "Authorization"
        prefix = entry.get("auth_prefix")
        if prefix is None:
            prefix = "Bearer "
        headers[auth_header] = "%s%s" % (prefix, key)
    headers.update(_normalize_headers(entry.get("headers")))
    data = _http_post_json(base, headers, payload,
                           label=entry.get("label") or "Custom")
    text = _dig(data, entry.get("response_path") or "text")
    if isinstance(text, list):
        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
    if not isinstance(text, str) or not text.strip():
        raise AIFormatError(
            "Nessun testo nel percorso di risposta '%s'. Risposta: %s"
            % (entry.get("response_path") or "text", _short(json.dumps(data))))
    return text


# --- Elenco modelli ---------------------------------------------------------

def _looks_like_chat_model(mid):
    s = str(mid or "").strip().lower()
    if not s:
        return False
    return not any(h in s for h in _NON_CHAT_HINTS)


def _models_url(base):
    base = (base or "").rstrip("/")
    if not base:
        return ""
    if base.endswith("/v1"):
        return base + "/models"
    return base + "/v1/models"


def _parse_openai_models(data):
    items = data.get("data") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    out = []
    seen = set()
    for it in items:
        if not isinstance(it, dict):
            continue
        mid = str(it.get("id") or "").strip()
        if not mid or mid in seen or not _looks_like_chat_model(mid):
            continue
        seen.add(mid)
        out.append({"id": mid, "label": mid})
    out.sort(key=lambda m: m["id"].lower())
    return out


def _list_openai_models(entry):
    key = get_api_key(entry["id"])
    base = (entry.get("base_url") or "").rstrip("/")
    if not base:
        raise AIFormatError("base_url non configurato per questo provider.")
    headers = {}
    if key:
        headers["Authorization"] = "Bearer " + key
    headers.update(_normalize_headers(entry.get("headers")))
    data = _http_get_json(_models_url(base), headers,
                          label=entry.get("label") or "OpenAI")
    return _parse_openai_models(data)


def _list_anthropic_models(entry):
    key = get_api_key(entry["id"])
    if not key:
        return [{"id": m, "label": m} for m in ANTHROPIC_MODELS]
    base = (entry.get("base_url") or DEFAULT_ANTHROPIC_BASE).rstrip("/")
    headers = {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
    }
    headers.update(_normalize_headers(entry.get("headers")))
    try:
        data = _http_get_json(base + "/v1/models", headers,
                              label=entry.get("label") or "Anthropic")
    except (AIAuthError, AITransientError, AIFormatError):
        return [{"id": m, "label": m} for m in ANTHROPIC_MODELS]
    items = data.get("data") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        return [{"id": m, "label": m} for m in ANTHROPIC_MODELS]
    out, seen = [], set()
    for it in items:
        if not isinstance(it, dict):
            continue
        mid = str(it.get("id") or "").strip()
        if not mid or mid in seen:
            continue
        seen.add(mid)
        out.append({"id": mid, "label": it.get("display_name") or mid})
    return out or [{"id": m, "label": m} for m in ANTHROPIC_MODELS]


def list_models(provider_id=None):
    """Modelli del provider indicato (o di quello attivo).

    Gemini: lista fissa (cookie, niente catalogo HTTP).
    OpenAI-compatibile / custom: GET {base}/v1/models.
    Anthropic: GET /v1/models, con ripiego sulla lista locale se l'endpoint
    non risponde. Il selettore della UI deve mostrare SOLO questi, mai
    quelli di un altro provider.
    """
    if provider_id:
        entry = get_provider(provider_id)
        if entry is None:
            raise AIFormatError("Provider AI non trovato: %s" % provider_id)
    else:
        entry = get_active_provider()
    ptype = entry.get("type")
    configured = str(entry.get("model") or "").strip()
    if ptype == TYPE_GEMINI:
        models = [dict(m) for m in GEMINI_MODELS]
        source = "builtin"
    elif ptype == TYPE_ANTHROPIC:
        models = _list_anthropic_models(entry)
        source = "live"
    elif ptype in (TYPE_OPENAI, TYPE_CUSTOM):
        try:
            models = _list_openai_models(entry)
            source = "live"
        except (AIAuthError, AITransientError, AIFormatError):
            # Catalogo irraggiungibile: il modello configurato, non Gemini.
            models = ([{"id": configured, "label": configured}]
                      if configured else [])
            source = "configured"
    else:
        raise AIFormatError("Tipo di provider sconosciuto: %s" % ptype)
    if configured and not any(m["id"] == configured for m in models):
        models.insert(0, {"id": configured, "label": configured})
    return {
        "provider": entry.get("id"),
        "type": ptype,
        "label": entry.get("label") or entry.get("id"),
        "configured": configured or None,
        "source": source,
        "models": models,
    }


# --- Dispatch ---------------------------------------------------------------

def _complete_gemini(entry, prompt, model=None, images=None):
    """Ramo Gemini: delega ad `aiclient`, dove vive il client a cookie.

    L'import e' LOCALE, non circolare per costruzione: `aiclient` importa questo
    modulo a livello di file (per le classi d'errore), questo importa `aiclient`
    solo qui dentro, quando la funzione gira. E' lo stesso idioma con cui
    `_gemini_client` importa `gemini`.
    """
    import aiclient
    return aiclient.gemini_answer_text(prompt, model, images=images)


def _looks_like_gemini_model(name):
    s = str(name or "").strip().lower()
    return s.startswith("gemini") or s.startswith("gemma")


def complete(prompt, provider=None, model=None, images=None):
    """UNA chiamata all'AI col provider indicato (o quello attivo) -> testo.

    `provider` puo' essere un id o un'entry gia' risolta. `model` e' il valore
    del selettore della UI: se appartiene al provider attivo lo usa, cosi'
    si puo' scegliere grok-3 con la chiave Grok. Un nome Gemini (o vuoto)
    NON sovrascrive il modello del provider a chiave: e' il caso in cui la
    UI non ha ancora aggiornato il menu e manderebbe gemini-3.1-pro a xAI.

    `images` e' in CODA e opzionale, come `provider` prima di lui: nessuno dei
    chiamanti storici (voxel, coda pack, texture, animazioni, MCP) passa nulla e
    per loro il corpo inviato resta identico a prima. Con immagini vale la
    capienza del tipo (`MAX_IMAGES_BY_TYPE`) e un tipo che non le sostiene
    solleva invece di ignorarle.
    """
    if isinstance(provider, dict):
        entry = provider
    elif provider:
        entry = get_provider(provider)
        if entry is None:
            raise AIFormatError("Provider AI non trovato: %s" % provider)
    else:
        entry = get_active_provider()

    imgs = _limit_images(entry, normalize_images(images))

    ptype = entry.get("type")
    if ptype == TYPE_GEMINI:
        return _complete_gemini(entry, prompt, model, images=imgs)
    chosen = str(model or "").strip()
    if chosen and not _looks_like_gemini_model(chosen):
        entry = dict(entry)
        entry["model"] = chosen
    if ptype == TYPE_ANTHROPIC:
        return _complete_anthropic(entry, prompt, images=imgs)
    if ptype == TYPE_OPENAI:
        return _complete_openai(entry, prompt, images=imgs)
    if ptype == TYPE_CUSTOM:
        return _complete_custom(entry, prompt, images=imgs)
    raise AIFormatError("Tipo di provider sconosciuto: %s" % ptype)


def test_provider(provider_id, prompt=None):
    """Prova reale ed economica: chiede una parola sola.

    Ritorna `{ok, kind, message, sample}`; `kind` e' una delle tre classi
    (`auth`/`transient`/`format`) cosi' la UI puo' dire all'utente COSA fare
    invece di stampargli addosso un'eccezione.
    """
    text = prompt or "Rispondi con la sola parola: OK"
    try:
        answer = complete(text, provider=provider_id)
    except AIAuthError as e:
        return {"ok": False, "kind": "auth", "message": str(e)}
    except AITransientError as e:
        return {"ok": False, "kind": "transient", "message": str(e)}
    except AIFormatError as e:
        return {"ok": False, "kind": "format", "message": str(e)}
    except Exception as e:                                  # noqa: BLE001
        return {"ok": False, "kind": "format", "message": _short(str(e))}
    return {"ok": True, "kind": "ok", "sample": _short(answer, 200)}


def public_summary():
    """Riassunto per `GET /api/settings`: mai una chiave, solo la maschera."""
    info = list_providers()
    active_id = info["active"]
    active = next((p for p in info["providers"] if p["id"] == active_id), None)
    vision = supports_images(active_id)
    return {
        "active": active_id,
        "activeType": (active or {}).get("type", TYPE_GEMINI),
        "activeLabel": (active or {}).get("label", "Google Gemini"),
        "count": len(info["providers"]),
        "usesCookies": (active or {}).get("type", TYPE_GEMINI) == TYPE_GEMINI,
        # Capacita' DICHIARATA, non verificata: chi ci fa affidamento (la critica
        # visiva) manda prima la sonda. Vedi VISION_BY_TYPE.
        "vision": vision["supported"],
        "visionReason": vision["reason"],
        "maxImages": vision["maxImages"],
    }
