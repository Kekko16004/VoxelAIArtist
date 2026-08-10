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


def gemini_answer_text(final_prompt, model=None):
    """UNA chiamata al client Gemini a cookie -> testo grezzo della risposta.

    E' il corpo storico di `ai_answer_text`, ora raggiungibile anche dal ramo
    `gemini_cookies` di `providers.complete()`. Sta QUI e non in providers.py
    perche' cookie e classificazione a indizi testuali sono roba di Gemini, e
    providers.py non deve sapere che esistono.
    """
    try:
        client = _gemini_client(model)
    except Exception as e:                                  # noqa: BLE001
        raise _classify_ai_error(e) from e
    try:
        response = client.generate_content(final_prompt)
    except Exception as e:                                  # noqa: BLE001
        raise _classify_ai_error(e) from e
    return response.text if hasattr(response, 'text') else str(response)


def ai_answer_text(final_prompt, model=None, provider=None):
    """UNA chiamata all'AI ATTIVA -> testo grezzo della risposta.

    Punto di contatto unico: scelta del provider, credenziali e classificazione
    degli errori stanno qui sotto, non duplicati negli handler HTTP.

    `provider` e' opzionale e serve solo a forzare un provider per una singola
    chiamata (la prova di connessione delle impostazioni): nessun chiamante
    esistente deve passarlo, e senza si usa quello attivo — che a configurazione
    zero e' Gemini a cookie, come prima.

    `model` resta il valore del selettore della UI. Non sovrascrive il modello
    configurato in un provider a chiave API: vale solo se quel provider non ne
    dichiara uno (vedi `providers.complete`).
    """
    try:
        return ai_providers.complete(final_prompt, provider=provider, model=model)
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


def ai_answer_text_retrying(final_prompt, model=None, sleep=None, provider=None):
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
            return ai_answer_text(final_prompt, model, provider=provider)
        except AITransientError as e:
            last = e
            if attempt >= len(backoff):
                raise
            print("[ai] errore transitorio, ritento fra %ds: %s"
                  % (backoff[attempt], e))
            sleep(backoff[attempt])
    raise last  # pragma: no cover - il loop esce sempre da return/raise
