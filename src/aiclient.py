"""Client AI condiviso: una chiamata all'AI attiva, errori parlanti, retry.

Modulo CONDIVISO fra VoxelAIArtist e PixelAIEditor. Prima viveva dentro il
`main.py` del padre; duplicarlo nella seconda app significava duplicare anche la
classificazione degli errori, che e' la parte che si sbaglia (il client `gemini`
e' un web client reverse-engineered: non espone codici, solo messaggi, e
distinguere "cookie scaduti" da "quota" si fa solo per indizi testuali).

Il client Gemini NON e' l'API ufficiale: e' autenticato a cookie di browser. Da
qui discende tutto il resto — il rate-limit e' facile da prendere, la sessione si
puo' bruciare, e gli errori arrivano come stringhe.

Da quando esistono i provider (`src/providers.py`), `ai_answer_text` NON e' piu'
legata a Gemini: chiede al provider ATTIVO. Gemini a cookie resta il default e il
ripiego, quindi chi non configura niente non vede alcuna differenza. La firma e
il significato delle due funzioni pubbliche non cambiano: una chiamata, testo
grezzo in uscita, e le stesse tre classi d'errore.

Le classi d'errore sono DEFINITE in `providers.py` e qui re-esportate: devono
essere gli stessi oggetti in tutta l'app, o `except AIAuthError` funzionerebbe o
no a seconda di chi ha importato cosa. `main.py` continua a importarle da qui.
"""

import time

import pack as pack_engine
import providers as ai_providers
import settings as app_settings
from providers import AIAuthError, AIFormatError, AITransientError  # noqa: F401


# --- Errori AI "parlanti" ---------------------------------------------------
# Un 500 con str(e) non dice all'utente cosa fare. Le tre classi (in
# providers.py) separano i soli casi su cui l'utente PUO' agire (credenziali da
# riconfigurare / riprovare piu' tardi / il modello ha risposto ma non in JSON) e
# gli endpoint le mappano su codici e messaggi diversi.

# Indizi testuali di un problema di autenticazione. Il client `gemini` e' un web
# client reverse-engineered: non espone codici, solo messaggi.
_AI_AUTH_HINTS = (
    "cookie", "snlm0e", "nonce", "unauthorized", "forbidden", "401", "403",
    "sign in", "signin", "login", "credential", "not authenticated",
    "authentication", "secure_1psid", "session expired",
)


def _classify_ai_error(exc):
    """Traduce un'eccezione del client Gemini in una delle classi sopra.

    Un'eccezione GIA' classificata passa intatta. Le euristiche qui sotto sono
    fatte per un client senza codici di stato: applicarle a un errore che arriva
    da un'API vera lo riclassificherebbe leggendone il messaggio (un 503 il cui
    testo non contiene nessuno degli indizi diventerebbe "errore generico"), e
    l'informazione buona — il codice HTTP — verrebbe buttata via.
    """
    if isinstance(exc, (AIAuthError, AITransientError, AIFormatError)):
        return exc
    msg = str(exc).strip() or exc.__class__.__name__
    low = msg.lower()
    if any(h in low for h in _AI_AUTH_HINTS):
        return AIAuthError(
            "Sessione Gemini non valida: i cookie sono mancanti o scaduti. "
            "Apri le Impostazioni e reimposta i cookie del browser. "
            "Dettaglio: %s" % msg)
    # Riusa ESATTAMENTE il criterio di transitorieta' della coda pack: se un
    # errore vale un retry nella coda, vale un retry anche qui.
    if pack_engine._looks_like_rate_limit(msg) or isinstance(exc, (OSError,)):
        return AITransientError(
            "Servizio AI non raggiungibile o quota/limite temporaneo. "
            "Riprova fra qualche minuto. Dettaglio: %s" % msg)
    return AITransientError("Errore del servizio AI: %s" % msg)


def _gemini_client(model=None):
    """Crea il client Gemini con i cookie salvati (o auto-discovery).

    `model` e' accettato per uniformita' con la UI (il selettore modello) ma il
    client `gemini` installato NON espone un parametro modello
    (`Gemini.__init__` non lo prevede e `generate_content(prompt, image)`
    nemmeno): il valore viene quindi ignorato qui, in UN SOLO punto, invece che
    silenziosamente in tre endpoint diversi. Il giorno in cui il client lo
    supportera' basta cambiare questa funzione.

    L'import e' LOCALE di proposito: importare `gemini` a livello di modulo
    renderebbe il pacchetto una dipendenza per chiunque importi questo file,
    inclusi i test che non toccano l'AI.
    """
    from gemini import Gemini
    cookies_dict = app_settings.load_cookies()
    if cookies_dict:
        return Gemini(cookies=cookies_dict, timeout=180)
    return Gemini(auto_cookies=True, timeout=180)


def gemini_answer_text(final_prompt, model=None, images=None):
    """UNA chiamata al client Gemini a cookie -> testo grezzo della risposta.

    E' il corpo storico di `ai_answer_text`, ora raggiungibile anche dal ramo
    `gemini_cookies` di `providers.complete()`. Sta QUI e non in providers.py
    perche' cookie e classificazione a indizi testuali sono roba di Gemini, e
    providers.py non deve sapere che esistono.

    `images` e' una lista gia' normalizzata da `providers.normalize_images`. Il
    client accetta UNA immagine (`generate_content(prompt, image)`), quindi si
    passa la prima; il taglio con avviso e' avvenuto a monte, in `_limit_images`,
    dove si sa quante ne accetta il tipo. Si passano i BYTES e non un percorso:
    l'immagine arriva da un canvas del browser e non esiste su disco, e scriverla
    in un file temporaneo solo per rileggerla vorrebbe dire scegliere una
    cartella, gestirne la cancellazione e lasciare in giro il render dell'utente.
    """
    try:
        client = _gemini_client(model)
    except Exception as e:                                  # noqa: BLE001
        raise _classify_ai_error(e) from e
    try:
        if images:
            response = client.generate_content(final_prompt, images[0]["bytes"])
        else:
            response = client.generate_content(final_prompt)
    except Exception as e:                                  # noqa: BLE001
        raise _classify_ai_error(e) from e
    return response.text if hasattr(response, 'text') else str(response)


def ai_answer_text(final_prompt, model=None, provider=None, images=None):
    """UNA chiamata all'AI ATTIVA -> testo grezzo della risposta.

    Punto di contatto unico: scelta del provider, credenziali e classificazione
    degli errori stanno qui sotto, non duplicati negli handler HTTP.

    `provider` e' opzionale e serve solo a forzare un provider per una singola
    chiamata (la prova di connessione delle impostazioni): nessun chiamante
    esistente deve passarlo, e senza si usa quello attivo — che a configurazione
    zero e' Gemini a cookie, come prima.

    `images` e' l'ultimo arrivato e vale la stessa regola: opzionale, in coda,
    nessun chiamante storico lo passa. Serve alla critica visiva di
    SimpleAIModeller. Un provider che non sostiene le immagini solleva
    `AIFormatError` invece di ignorarle in silenzio — una critica fatta su zero
    immagini risponderebbe comunque qualcosa di plausibile.

    `model` e' il valore del selettore della UI. Se appartiene al provider
    attivo lo usa; un nome Gemini non finisce mai a Grok/Anthropic.
    """
    try:
        return ai_providers.complete(final_prompt, provider=provider, model=model,
                                     images=images)
    except (AIAuthError, AITransientError, AIFormatError):
        raise
    except Exception as e:                                  # noqa: BLE001
        raise _classify_ai_error(e) from e


# Backoff per gli endpoint INTERATTIVI. La scala e' quella della coda pack
# (nessun valore duplicato) ma troncata a un budget compatibile con una
# richiesta HTTP sincrona: nella coda si possono aspettare 20+60+150 s, davanti
# a uno spinner no.
INTERACTIVE_RETRY_BUDGET_SECONDS = 30


def _interactive_backoff():
    waits, total = [], 0
    for w in pack_engine.RETRY_BACKOFF_SECONDS:
        if total + w > INTERACTIVE_RETRY_BUDGET_SECONDS:
            break
        waits.append(w)
        total += w
    return waits


# Gemini (e altri chat) a volte rispondono in prosa invece che in JSON:
# "Non posso assisterti, poiche' sono solo un modello linguistico...".
# Non e' un errore HTTP, quindi il retry di rete non lo vede. E' un fallimento
# di FORMATO: la scena resta vuota. La cura misurata (PixelAIEditor) e' inquadrare
# il compito come compilatore di dati, e ritentare UNA volta con un nudge se
# la risposta e' un rifiuto o non contiene JSON. Un jailbreak (DAN) non va
# aggiunto: peggiora il filtro e non produce ops.
_REFUSAL_HINTS = (
    "non posso assisterti",
    "non posso aiutarti",
    "sono solo un modello",
    "sono un modello linguistico",
    "non ho la capacita",
    "i'm just a language model",
    "i am just a language model",
    "i'm only a language model",
    "as a language model",
    "as an ai language model",
    "cannot assist",
    "can't assist",
    "i cannot help with that",
    "i'm unable to",
    "i am unable to",
    "i can't help with",
)

_JSON_RETRY_NUDGE = (
    "\n\nOUTPUT JSON ONLY. No prose, no refusal. A ```json block with "
    "metadata, palette and ops. You are a voxel compiler, not a chatbot."
)


def _fold_ascii(text):
    out = []
    for ch in str(text).lower():
        out.append({
            "à": "a", "á": "a", "â": "a", "ä": "a",
            "è": "e", "é": "e", "ê": "e",
            "ì": "i", "í": "i",
            "ò": "o", "ó": "o", "ô": "o",
            "ù": "u", "ú": "u",
        }.get(ch, ch))
    return "".join(out)


def looks_like_refusal(text):
    """True se la risposta e' un rifiuto in prosa, non un JSON di ops."""
    if text is None:
        return True
    s = str(text).strip()
    if not s:
        return True
    low = _fold_ascii(s)
    return any(h in low for h in _REFUSAL_HINTS)


def _looks_like_json_payload(text):
    s = str(text or "")
    if "```json" in s.lower() or "```JSON" in s:
        return True
    return "{" in s and ("ops" in s or "voxels" in s or "palette" in s)


def ai_json_text_retrying(final_prompt, model=None, sleep=None, provider=None,
                          images=None):
    """Come `ai_answer_text_retrying`, piu' UN ritento se la risposta e' un rifiuto.

    Il ritento di rete (quota/5xx) resta in `ai_answer_text_retrying`. Questo
    copre il caso in cui il provider 200-ok ma parla invece di compilare.
    """
    answer = ai_answer_text_retrying(final_prompt, model, sleep=sleep,
                                     provider=provider, images=images)
    if looks_like_refusal(answer) or not _looks_like_json_payload(answer):
        print("[ai] risposta non-JSON o rifiuto, ritento una volta")
        answer = ai_answer_text_retrying(
            str(final_prompt) + _JSON_RETRY_NUDGE, model, sleep=sleep,
            provider=provider, images=images)
    return answer


def ai_answer_text_retrying(final_prompt, model=None, sleep=None, provider=None,
                            images=None):
    """Come `ai_answer_text` ma ritenta gli errori transitori col backoff.

    Gli errori di autenticazione e di formato NON vengono ritentati (come nella
    coda pack: un JSON malformato non migliora riprovando subito, e una chiave
    sbagliata resta sbagliata). `sleep` e' iniettabile per i test.
    """
    sleep = sleep or time.sleep
    backoff = _interactive_backoff()
    last = None
    for attempt in range(len(backoff) + 1):
        try:
            return ai_answer_text(final_prompt, model, provider=provider,
                                  images=images)
        except AITransientError as e:
            last = e
            if attempt >= len(backoff):
                raise
            # 504/524 = proxy tagliato: 20s di attesa non aiutano, ritento subito.
            wait = 1 if getattr(e, "status", None) in (502, 503, 504, 520, 521, 522, 523, 524) \
                else backoff[attempt]
            print("[ai] errore transitorio, ritento fra %ds: %s" % (wait, e))
            sleep(wait)
    raise last  # pragma: no cover - il loop esce sempre da return/raise
