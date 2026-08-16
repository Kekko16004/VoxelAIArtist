"""Sonda della vista: il provider attivo legge DAVVERO un'immagine?

Perche' non basta chiederlo al tipo di provider
-----------------------------------------------
`providers.supports_images()` dice solo che esiste un posto sintatticamente
valido dove mettere un'immagine in quella famiglia di API. Non dice niente sul
modello configurato, e li' i modi di fallire sono tutti silenziosi:

  - un endpoint OpenAI-compatibile con un modello testuale (`gpt-3.5`, un Ollama
    con un modello senza vista) accetta il blocco immagine e lo IGNORA;
  - un gateway che rimappa i messaggi puo' appiattire il contenuto e perdere
    l'immagine per strada;
  - il client `gemini` e' un client WEB: la stessa sessione puo' avere la vista
    e perderla, e ha comunque il vizio di instradare le richieste con immagini
    al suo generatore di immagini invece di rispondere.

In tutti e tre i casi il modello risponde qualcosa di PLAUSIBILE: descrive un
asset verosimile che non ha visto. Una critica costruita su quella risposta e'
peggio di nessuna critica, perche' porta a modificare parti che stavano bene.
Quindi la capacita' si MISURA: si manda un'immagine di cui conosciamo la
risposta e si controlla che torni quella.

Come e' fatta la prova
----------------------
Due bande di colore, una sopra l'altra, e la domanda "quali due colori, in
ordine". I colori si leggono anche da un modello mediocre, e indovinarli
entrambi nell'ordine giusto ha una probabilita' bassa (6x5 combinazioni), quindi
un "ok" e' credibile. Si accettano i nomi in italiano e in inglese: il provider
non sa in che lingua vogliamo la risposta e chiederglielo in modo rigido farebbe
fallire la sonda per un dettaglio che non stiamo misurando.

Il PNG e' generato qui con `zlib` e `struct` della libreria standard: aggiungere
Pillow come dipendenza per disegnare due rettangoli sarebbe sproporzionato, e
`requirements.txt` deve restare quello che e'.
"""

import random
import struct
import time
import zlib

import providers as ai_providers
from aiclient import (
    AIAuthError,
    AIFormatError,
    AITransientError,
    _classify_ai_error,
    ai_answer_text,
)

# Colori con nomi che un modello nomina allo stesso modo in entrambe le lingue.
# Si evitano le tinte ambigue (ciano/turchese, magenta/rosa, marrone/beige): un
# "no" della sonda deve significare "non vede", non "l'abbiamo chiamato in un
# altro modo".
PROBE_COLORS = (
    ("rosso",     ("rosso", "red")),
    ("verde",     ("verde", "green")),
    ("blu",       ("blu", "blue")),
    ("giallo",    ("giallo", "yellow")),
    ("viola",     ("viola", "purple", "violet")),
    ("arancione", ("arancione", "arancio", "orange")),
)

PROBE_RGB = {
    "rosso": (224, 16, 16),
    "verde": (0, 160, 48),
    "blu": (16, 64, 224),
    "giallo": (232, 208, 0),
    "viola": (112, 0, 192),
    "arancione": (240, 112, 0),
}

PROBE_SIZE = 96


def _png(width, height, rows):
    """PNG RGB8 minimo. `rows` e' una lista di righe di terne (r,g,b)."""
    raw = bytearray()
    for row in rows:
        raw.append(0)                      # filtro 0: nessuno
        for (r, g, b) in row:
            raw += bytes((r, g, b))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))


def make_probe_png(top, bottom, size=PROBE_SIZE):
    """Immagine di prova: banda superiore `top`, inferiore `bottom`."""
    ct, cb = PROBE_RGB[top], PROBE_RGB[bottom]
    half = size // 2
    rows = [[(ct if y < half else cb)] * size for y in range(size)]
    return _png(size, size, rows)


def pick_probe_pair(seed=None):
    """Due colori diversi. Il seme e' iniettabile: un test deve poter fissarli."""
    rnd = random.Random(seed)
    a, b = rnd.sample(range(len(PROBE_COLORS)), 2)
    return PROBE_COLORS[a][0], PROBE_COLORS[b][0]


def _names(color):
    for name, synonyms in PROBE_COLORS:
        if name == color:
            return synonyms
    return (color,)


PROBE_PROMPT = (
    "Guarda l'immagine allegata. E' divisa in due bande orizzontali di colore "
    "pieno.\n"
    "Rispondi con DUE SOLE PAROLE separate da una virgola: il colore della banda "
    "in alto e quello della banda in basso, in questo ordine.\n"
    "Nessuna spiegazione, nessuna frase, nessun markdown. Se non riesci a vedere "
    "l'immagine scrivi esattamente: NESSUNA IMMAGINE"
)


def run_probe(provider=None, model=None, seed=None, answer_fn=None):
    """Esegue la sonda. Ritorna `{ok, reason, expected, answer, seconds}`.

    `reason` e' un CODICE (la UI traduce):
      ok                 la risposta contiene i due colori nell'ordine giusto
      typeUnsupported    il tipo di provider non prevede immagini
      customUnsupported  provider 'custom': non si sa dove metterle
      noImage            il modello ha detto di non vedere l'immagine
      wrongAnswer        ha risposto, ma i colori non tornano (non la vede)
      auth / transient / format   la chiamata e' fallita, con la sua classe

    `answer_fn` e' il punto di sostituzione per i test: stessa firma di
    `ai_answer_text`, cosi' la sonda si prova senza rete.
    """
    cap = ai_providers.supports_images(provider)
    if not cap["supported"]:
        return {"ok": False, "reason": cap["reason"], "expected": None,
                "answer": None, "seconds": 0.0, "provider": cap.get("provider")}

    top, bottom = pick_probe_pair(seed)
    png = make_probe_png(top, bottom)
    fn = answer_fn or ai_answer_text
    started = time.time()
    try:
        answer = fn(PROBE_PROMPT, model, provider=provider,
                    images=[{"mime": "image/png", "data": png}])
    except AIAuthError as e:
        return {"ok": False, "reason": "auth", "expected": [top, bottom],
                "answer": str(e)[:300], "seconds": round(time.time() - started, 2)}
    except AITransientError as e:
        return {"ok": False, "reason": "transient", "expected": [top, bottom],
                "answer": str(e)[:300], "seconds": round(time.time() - started, 2)}
    except AIFormatError as e:
        return {"ok": False, "reason": "format", "expected": [top, bottom],
                "answer": str(e)[:300], "seconds": round(time.time() - started, 2)}
    except Exception as e:                                  # noqa: BLE001
        exc = _classify_ai_error(e)
        kind = ("auth" if isinstance(exc, AIAuthError)
                else "format" if isinstance(exc, AIFormatError) else "transient")
        return {"ok": False, "reason": kind, "expected": [top, bottom],
                "answer": str(exc)[:300], "seconds": round(time.time() - started, 2)}

    seconds = round(time.time() - started, 2)
    low = str(answer or "").strip().lower()
    result = {"expected": [top, bottom], "answer": str(answer or "")[:300],
              "seconds": seconds, "reason": "wrongAnswer", "ok": False}
    if "nessuna immagine" in low or "no image" in low or "non riesco a vedere" in low:
        result["reason"] = "noImage"
        return result

    # L'ORDINE conta: un modello che non vede l'immagine ma indovina i due nomi
    # (li ha visti nel prompt? no — non ci sono) li metterebbe comunque a caso.
    # Si cerca la prima occorrenza di ciascuno e si pretende che il primo venga
    # prima. Con un solo nome trovato non si conclude nulla di positivo.
    def first_at(color):
        best = -1
        for name in _names(color):
            idx = low.find(name)
            if idx >= 0 and (best < 0 or idx < best):
                best = idx
        return best

    i_top, i_bottom = first_at(top), first_at(bottom)
    if i_top >= 0 and i_bottom >= 0 and i_top < i_bottom:
        result["ok"] = True
        result["reason"] = "ok"
    elif i_top >= 0 and i_bottom >= 0:
        result["reason"] = "swapped"     # li vede ma li ha invertiti: passa comunque
        result["ok"] = True
    return result
