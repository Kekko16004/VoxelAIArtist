"""Client AI condiviso: una chiamata a Gemini, errori parlanti, retry.

Modulo CONDIVISO fra VoxelAIArtist e PixelAIEditor. Prima viveva dentro il
`main.py` del padre; duplicarlo nella seconda app significava duplicare anche la
classificazione degli errori, che e' la parte che si sbaglia (il client `gemini`
e' un web client reverse-engineered: non espone codici, solo messaggi, e
distinguere "cookie scaduti" da "quota" si fa solo per indizi testuali).

Il client NON e' l'API ufficiale: e' autenticato a cookie di browser. Da qui
discende tutto il resto — il rate-limit e' facile da prendere, la sessione si
puo' bruciare, e gli errori arrivano come stringhe.
"""

import time

import pack as pack_engine
import settings as app_settings


# --- Errori AI "parlanti" ---------------------------------------------------
# Un 500 con str(e) non dice all'utente cosa fare. Queste tre classi separano i
# soli casi su cui l'utente PUO' agire (cookie da riconfigurare / riprovare piu'
# tardi / il modello ha risposto ma non in JSON) e gli endpoint le mappano su
# codici e messaggi diversi.

class AIAuthError(RuntimeError):
    """Cookie Gemini mancanti o scaduti: serve riconfigurare la sessione."""


class AITransientError(RuntimeError):
    """Rete, quota o rate-limit: la stessa richiesta puo' funzionare piu' tardi."""


class AIFormatError(RuntimeError):
    """Il modello ha risposto, ma non con JSON utilizzabile."""

    def __init__(self, message, answer=None):
        super().__init__(message)
        self.answer = answer


# Indizi testuali di un problema di autenticazione. Il client `gemini` e' un web
# client reverse-engineered: non espone codici, solo messaggi.
_AI_AUTH_HINTS = (
    "cookie", "snlm0e", "nonce", "unauthorized", "forbidden", "401", "403",
    "sign in", "signin", "login", "credential", "not authenticated",
    "authentication", "secure_1psid", "session expired",
)


def _classify_ai_error(exc):
    """Traduce un'eccezione del client Gemini in una delle classi sopra."""
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


def ai_answer_text(final_prompt, model=None):
    """UNA chiamata al client Gemini -> testo grezzo della risposta.

    Punto di contatto unico: creazione client, cookie e classificazione degli
    errori stanno qui, non duplicati negli handler HTTP.
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


def ai_answer_text_retrying(final_prompt, model=None, sleep=None):
    """Come `ai_answer_text` ma ritenta gli errori transitori col backoff.

    Gli errori di autenticazione e di formato NON vengono ritentati (come nella
    coda pack: un JSON malformato non migliora riprovando subito).
    `sleep` e' iniettabile per i test.
    """
    sleep = sleep or time.sleep
    backoff = _interactive_backoff()
    last = None
    for attempt in range(len(backoff) + 1):
        try:
            return ai_answer_text(final_prompt, model)
        except AITransientError as e:
            last = e
            if attempt >= len(backoff):
                raise
            print("[ai] errore transitorio, ritento fra %ds: %s"
                  % (backoff[attempt], e))
            sleep(backoff[attempt])
    raise last  # pragma: no cover - il loop esce sempre da return/raise
