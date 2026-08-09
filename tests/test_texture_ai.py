"""
Test di `build_pixel_prompt` / `normalize_pixel_data` e della rotta
POST /api/texture (main.py).

Il server NON disegna: espandere le ops sulla tela e' compito di
`expandPixelOps` (ui/src/lib/37-pixel-ops.js), che ha il suo test in
tests/test_pixel_ops.mjs. Qui si verifica solo che la forma della risposta AI
venga ricondotta al contratto e che una risposta inutilizzabile diventi un 400
spiegato, invece di una tela che resta misteriosamente vuota.

Nessuna rete, nessun cookie: `gemini` e' stubbato prima di importare main.
"""
import os as _os
_HERE = _os.path.dirname(_os.path.abspath(__file__))
REPO_ROOT = _os.path.dirname(_HERE)
import json, os, sys, types, threading, time, urllib.request, urllib.error

os.chdir(REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, 'src'))
sys.path.insert(0, REPO_ROOT)

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

import main

fails = []
def check(cond, msg):
    if not cond:
        print("  FAIL " + msg); fails.append(msg)
    else:
        print("  OK  " + msg)


# --- build_pixel_prompt ------------------------------------------------------
p = main.build_pixel_prompt("pietra muschiosa", ["px", "nx"], None, 32)
check("32x32" in p, "il prompt dichiara la dimensione della tela")
check("`px`" in p and "`nx`" in p, "il prompt elenca le facce richieste")
check("pietra muschiosa" in p, "la richiesta dell'utente finisce nel prompt")
check("[INSERISCI QUI" not in p, "nessun segnaposto rimasto nel prompt")
check("mirror" in p and "noise" in p, "il prompt documenta i comandi compatti")

# La richiesta va APPESA quando il template non ha il segnaposto: prompt-pixel.txt
# finisce con l'intestazione, come prompt.txt. Senza questo ramo l'AI riceve un
# prompt senza domanda e inventa un soggetto a caso.
tail = p.rstrip("\n").split("\n")[-1]
check(tail.strip() == "pietra muschiosa", "richiesta appesa in fondo al prompt")

# La dimensione e' del CLIENT, non dell'AI: la tela esiste gia'.
check("16x16" in main.build_pixel_prompt("x", ["all"], None, None),
      "dimensione mancante -> default 16")
check("128x128" in main.build_pixel_prompt("x", ["all"], None, 9999),
      "dimensione fuori scala -> tetto 128")
check("4x4" in main.build_pixel_prompt("x", ["all"], None, 1),
      "dimensione sotto il minimo -> 4")

# Sinonimi di faccia: un LLM (e il client) possono scrivere 'top' invece di 'py'.
# Si conta dentro la SEZIONE delle facce, non nel prompt intero: il template
# nomina le sigle anche nella regola sulla coerenza fra le facce.
def _faces_section(prompt):
    body = prompt.split("### FACCE DA DISEGNARE", 1)[1]
    return body.split("###", 1)[0]

p2 = main.build_pixel_prompt("erba", ["top", "Bottom", "py"], None, 16)
sec = _faces_section(p2)
check(sec.count("`py`") == 1 and "`ny`" in sec and sec.count("`") == 4,
      "sigle di faccia normalizzate e deduplicate")
check("`all`" in _faces_section(main.build_pixel_prompt("x", [], None, 16)),
      "nessuna faccia richiesta -> texture unica 'all'")

ctx = {"px": "FACCIA px\n4a4b\n8a"}
p3 = main.build_pixel_prompt("coerente", ["nx"], ctx, 16)
check("4a4b" in p3, "il contesto delle facce gia' disegnate entra nel prompt")
check("nessuna faccia disegnata" in main.build_pixel_prompt("x", ["px"], None, 16),
      "senza contesto il prompt lo dice esplicitamente")
check("4a4b" in main.build_pixel_prompt("x", ["nx"], "4a4b", 16),
      "il contesto accetta anche una stringa gia' pronta")


# --- normalize_pixel_data ----------------------------------------------------
def norm(d, faces=None):
    return main.normalize_pixel_data(d, faces)

GOOD = {"size": 16, "palette": {"s": "#6E6E73", "d": "#4a4a4f"},
        "faces": {"px": ["fill 0 0 15 15 s", "noise 0 0 15 15 d 0.2 7"]}}
r = norm(GOOD, ["px"])
check(r["size"] == 16 and r["faces"]["px"][0] == "fill 0 0 15 15 s",
      "risposta canonica passa invariata")
check(r["palette"]["d"] == "#4A4A4F", "i colori sono normalizzati in maiuscolo")
check(not r.get("warnings"), "risposta canonica senza avvisi")

check(norm({"size": 16, "palette": {"a": "#f0a"},
            "faces": {"all": ["fill 0 0 15 15 a"]}})["palette"]["a"] == "#FF00AA",
      "colore #RGB espanso a #RRGGBB")
check(norm({"palette": {"a": "#11223344"}, "faces": {"all": ["fill 0 0 1 1 a"]}}
           )["palette"]["a"] == "#112233",
      "colore #RRGGBBAA troncato: l'alpha vive nelle ops")
check(norm({"palette": {"a": "-"}, "faces": {"all": ["fill 0 0 1 1 a"]}}
           )["palette"]["a"] == "-",
      "il colore trasparente sopravvive alla normalizzazione")
check("a" not in norm({"palette": {"a": "rosso"},
                       "faces": {"all": ["fill 0 0 1 1 a"]}})["palette"],
      "colore non valido scartato, non fatale")

# Varianti innocue che un LLM produce di continuo. Prima erano "texture vuota".
VARIANTI = {
    "ops alla radice (faccia singola)":
        ({"size": 16, "ops": ["fill 0 0 15 15 s"]}, ["px"], "px"),
    "sinonimo 'comandi'":
        ({"comandi": ["fill 0 0 15 15 s"]}, ["nx"], "nx"),
    "faccia come oggetto {ops:[...]}":
        ({"faces": {"py": {"ops": ["fill 0 0 15 15 s"]}}}, ["py"], "py"),
    "comandi in una sola stringa multiriga":
        ({"faces": {"pz": "fill 0 0 15 15 s\nrect 0 0 15 15 d"}}, ["pz"], "pz"),
    "comando come array di token":
        ({"faces": {"nz": [["fill", 0, 0, 15, 15, "s"]]}}, ["nz"], "nz"),
    "sinonimo 'facce'":
        ({"facce": {"ny": ["fill 0 0 15 15 s"]}}, ["ny"], "ny"),
    "nome di faccia in inglese":
        ({"faces": {"top": ["fill 0 0 15 15 s"]}}, ["py"], "py"),
    "sinonimo di dimensione 'lato'":
        ({"lato": 32, "faces": {"all": ["fill 0 0 31 31 s"]}}, ["all"], "all"),
}
for label, (data, want, key) in VARIANTI.items():
    r = norm(data, want)
    check(bool(r["faces"].get(key)), "forma ricondotta: %s" % label)
check(norm(VARIANTI["comando come array di token"][0], ["nz"])["faces"]["nz"][0]
      == "fill 0 0 15 15 s", "array di token ricomposto in una riga")
check(norm(VARIANTI["sinonimo di dimensione 'lato'"][0], ["all"])["size"] == 32,
      "sinonimo di dimensione riconosciuto")

# Righe da ignorare senza buttare via la faccia.
r = norm({"faces": {"px": ["# commento", "// altro", "", "  ",
                           "fill 0 0 15 15 s", "fill 0 0 1 1 d,"]}}, ["px"])
check(r["faces"]["px"] == ["fill 0 0 15 15 s", "fill 0 0 1 1 d"],
      "commenti, righe vuote e virgole finali ripuliti")

r = norm({"faces": {"px": ["glow 0 0 15 15 s", "fill 0 0 15 15 s"]}}, ["px"])
check(r["faces"]["px"] == ["fill 0 0 15 15 s"],
      "comando inventato scartato, il resto della faccia resta")
check(any("glow" in w for w in r.get("warnings", [])),
      "il comando inventato viene segnalato")

r = norm({"faces": {"px": ["fill 0 0 1 1 s"] * (main.PIXEL_MAX_OPS + 50)}}, ["px"])
check(len(r["faces"]["px"]) == main.PIXEL_MAX_OPS,
      "tetto ai comandi per faccia (%d)" % main.PIXEL_MAX_OPS)

# Facce in eccesso o mancanti: avvisi, non errori. Il client applica solo quelle
# che ha chiesto, ma l'utente deve capire perche' una faccia e' rimasta vuota.
r = norm({"faces": {"px": ["fill 0 0 1 1 s"], "py": ["fill 0 0 1 1 s"]}}, ["px"])
check(r["faces"].get("py") and any("non richieste" in w for w in r["warnings"]),
      "faccia in eccesso conservata ma segnalata")
r = norm({"faces": {"px": ["fill 0 0 1 1 s"]}}, ["px", "nx"])
check(any("non disegnate" in w for w in r["warnings"]),
      "faccia richiesta e non disegnata viene segnalata")
r = norm({"faces": {"px": ["fill 0 0 1 1 s"], "sopra_sinistra": ["fill 0 0 1 1 s"]}},
         ["px"])
check(r.get("unknownFaces") == ["sopra_sinistra"],
      "sigla di faccia irriconoscibile riportata a parte")

# Risposte inutilizzabili: nessuna faccia, cosi' la rotta risponde 400.
for label, data in {
    "non e' un oggetto": [1, 2, 3],
    "nessuna faccia": {"size": 16, "palette": {"a": "#FFFFFF"}},
    "faccia senza comandi validi": {"faces": {"px": ["blah", 7]}},
    "comandi non in lista": {"faces": {"px": 42}},
}.items():
    check(not norm(data, ["px"]).get("faces"), "risposta inutilizzabile: %s" % label)
check(norm({"size": 999, "faces": {"all": ["fill 0 0 1 1 s"]}})["size"] == 128,
      "dimensione fuori range riportata al tetto")



# --- rotta POST /api/texture -------------------------------------------------
def _req(body, path="/api/texture", raw_body=None):
    url = 'http://127.0.0.1:%d%s' % (main.PORT, path)
    data = raw_body if raw_body is not None else json.dumps(body).encode()
    rq = urllib.request.Request(url, data=data, method='POST',
                                headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(rq, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    except Exception:
        # Connessione caduta senza risposta: e' ESATTAMENTE il sintomo che le
        # guardie isinstance/str devono impedire (un'eccezione dentro l'handler
        # non diventa un 500, socketserver chiude il socket e basta). Codice 0
        # per poterlo distinguere da un 400 spiegato.
        return 0, {}

threading.Thread(target=main.start_server, daemon=True).start()
for _ in range(200):
    if main.PORT: break
    time.sleep(0.05)
check(bool(main.PORT), "server di test avviato (porta %s)" % main.PORT)

TEX = ('{"size":16,"palette":{"s":"#6E6E73","d":"#4A4A4F"},'
       '"faces":{"px":["fill 0 0 15 15 s","noise 0 0 15 15 d 0.2 7"]}}')

NEXT_ANSWER[0] = "```json\n" + TEX + "\n```"
s, d = _req({"prompt": "pietra", "faces": ["px"], "size": 16})
check(s == 200 and d["faces"]["px"][0] == "fill 0 0 15 15 s",
      "risposta fenced ```json -> 200 con le ops della faccia")
check("16x16" in LAST_PROMPT[0] and "pietra" in LAST_PROMPT[0],
      "la rotta ha costruito il prompt con dimensione e richiesta")

NEXT_ANSWER[0] = TEX
check(_req({"prompt": "pietra", "faces": ["px"]})[0] == 200,
      "JSON nudo senza fence -> 200")

NEXT_ANSWER[0] = "Ecco la texture:\n```json\n" + TEX + "\n```\nSpero vada bene!"
check(_req({"prompt": "pietra", "faces": ["px"]})[0] == 200,
      "chiacchiere attorno al JSON -> 200")

# Il contesto e' opzionale e passa dal client (e' li' che vive la tela).
NEXT_ANSWER[0] = TEX
_req({"prompt": "coerente", "faces": ["nx"], "size": 16,
      "context": {"px": "FACCIA px (16x16)\n16a\n8a8b"}})
check("8a8b" in LAST_PROMPT[0], "il contesto inviato dal client entra nel prompt")

# Errori: ognuno deve essere un 400 spiegato, mai un 500 o una connessione muta.
check(_req({"faces": ["px"]})[0] == 400, "prompt mancante -> 400")
check(_req(None, raw_body=b"")[0] == 400, "corpo vuoto -> 400")
check(_req(None, raw_body=b"{non json")[0] == 400, "corpo non JSON -> 400")

NEXT_ANSWER[0] = "Mi dispiace, non posso disegnare texture."
s, d = _req({"prompt": "pietra", "faces": ["px"]})
check(s == 400 and "rawPreview" in d,
      "risposta senza JSON -> 400 con anteprima del testo")

NEXT_ANSWER[0] = '{"size":16,"palette":{"s":"#6E6E73"},"faces":{}}'
s, d = _req({"prompt": "pietra", "faces": ["px"]})
check(s == 400 and "warnings" in d, "JSON senza facce -> 400 spiegato")

NEXT_ANSWER[0] = '{"faces":{"px":["blah blah","nope"]}}'
s, d = _req({"prompt": "pietra", "faces": ["px"]})
check(s == 400 and any("blah" in w for w in d.get("warnings", [])),
      "solo comandi inventati -> 400 che dice quali")

# `faces` non lista: il client puo' mandare una sigla sola per sbaglio.
NEXT_ANSWER[0] = TEX
check(_req({"prompt": "pietra", "faces": "px"})[0] == 200,
      "faces come stringa singola accettata")
check(_req({"prompt": "pietra"})[0] == 200, "faces assente -> texture unica")

# Errori del client AI: classificati, non 500 opachi.
NEXT_ANSWER[0] = Exception("cookie non valido o scaduto")
s, d = _req({"prompt": "pietra", "faces": ["px"]})
check(s == 401 and d.get("needsCookies") is True,
      "sessione scaduta -> 401 con needsCookies (il client apre le Impostazioni)")
NEXT_ANSWER[0] = OSError("connection reset by peer")
s, d = _req({"prompt": "pietra", "faces": ["px"]})
check(s == 503 and d.get("retryable") is True,
      "errore di rete -> 503 riprovabile")

# Nessuna credenziale nella risposta buona. (Sul percorso d'errore il messaggio
# riporta di proposito il "Dettaglio:" dell'eccezione del client AI, che e'
# testo del client e non un valore di cookie.)
NEXT_ANSWER[0] = TEX
s, d = _req({"prompt": "pietra", "faces": ["px"]})
body = json.dumps(d).lower()
for probe in ("secure_1psid", "__secure", "cookies.json"):
    check(probe not in body, "nessuna credenziale nella risposta (%s)" % probe)

# Corpo JSON che NON e' un oggetto: `payload.get` solleverebbe DENTRO l'handler,
# e un'eccezione li' non diventa un 500 - socketserver stampa il traceback e
# chiude il socket, quindi il client vede "connessione persa" senza codice ne'
# messaggio. Il 400 e' la differenza fra un errore spiegato e un mistero.
NEXT_ANSWER[0] = TEX
check(_req(None, raw_body=b'[1,2,3]')[0] == 400,
      "corpo JSON non oggetto -> 400 (non connessione chiusa)")
check(_req(None, raw_body=b'"solo una stringa"')[0] == 400,
      "corpo JSON stringa -> 400")
# Stesso discorso per `.strip()` su un prompt non testuale: `str()` lo converte
# invece di far saltare l'handler. Non si pretende un codice preciso (una lista
# diventa una descrizione strampalata ma valida): si pretende che una RISPOSTA
# HTTP arrivi. Il codice 0 di `_req` e' la connessione chiusa, cioe' il difetto.
NEXT_ANSWER[0] = TEX
check(_req({"prompt": ["a", "b"], "faces": ["px"]})[0] != 0,
      "prompt non testuale -> risposta HTTP (non connessione chiusa)")
check(_req({"prompt": [], "faces": ["px"]})[0] == 400,
      "prompt lista vuota -> 400 'descrizione mancante'")

# La stessa guardia su /api/animate, che e' l'handler gemello.
check(_req(None, path="/api/animate", raw_body=b'[1,2,3]')[0] == 400,
      "/api/animate: corpo JSON non oggetto -> 400")
check(_req({"request": 42}, path="/api/animate")[0] == 400,
      "/api/animate: richiesta non testuale -> 400")


# --- rotta POST /api/texture2d (ponte con PixelAIEditor) ---------------------
# La tela 2D dell'editor di pixel art, quando l'editor e' aperto DENTRO
# VoxelAIArtist: la sua pagina e' servita da questo server (translate_path la
# ribasa su BASE_DIR), quindi la sua fetch su percorso assoluto arriva qui e non
# al suo `main.py`. Senza questa rotta la generazione AI sarebbe morta solo
# nell'iframe -- un difetto che l'app autonoma non mostra mai.
TEX2D = ('{"size":32,"palette":{"a":"#6E6E73","b":"-"},'
         '"faces":{"all":["fill 0 0 31 31 a","rect 4 4 12 12 b"]}}')

NEXT_ANSWER[0] = "```json\n" + TEX2D + "\n```"
s, d = _req({"prompt": "spada", "width": 32, "height": 32}, path="/api/texture2d")
check(s == 200, "/api/texture2d: richiesta buona -> 200")
check(d.get("size") == 32, "/api/texture2d: la risposta porta 'size'")
check(d.get("palette", {}).get("a") == "#6E6E73",
      "/api/texture2d: la risposta porta 'palette'")
check(d.get("ops") and d["ops"][0] == "fill 0 0 31 31 a",
      "/api/texture2d: la risposta porta 'ops'")
check(d.get("faces", {}).get("all") == d.get("ops"),
      "/api/texture2d: 'faces.all' duplica le ops (l'espansore condiviso vuole un dizionario)")
check("32x32" in LAST_PROMPT[0] and "spada" in LAST_PROMPT[0],
      "/api/texture2d: prompt costruito con dimensione e richiesta")
check("SPRITE" in LAST_PROMPT[0] or "sprite" in LAST_PROMPT[0],
      "/api/texture2d: usa il template dell'editor (prompt-pixel2d.txt), non quello delle facce")

# Una risposta divisa in facce (capita quando la descrizione parla di un cubo)
# non e' un errore: si prende una tela e lo si dice negli avvisi.
NEXT_ANSWER[0] = ('{"size":16,"faces":{"px":["fill 0 0 15 15 a"],'
                  '"nx":["fill 0 0 15 15 a"]},"palette":{"a":"#FFFFFF"}}')
s, d = _req({"prompt": "cubo", "size": 16}, path="/api/texture2d")
check(s == 200 and d.get("ops"), "/api/texture2d: risposta a piu' facce -> 200 con una tela")
check(any("usato" in w for w in d.get("warnings", [])),
      "/api/texture2d: la scelta della faccia finisce negli avvisi")

# Errori: ognuno un 400 spiegato, mai una connessione muta.
check(_req(None, path="/api/texture2d", raw_body=b"")[0] == 400,
      "/api/texture2d: corpo vuoto -> 400")
check(_req(None, path="/api/texture2d", raw_body=b"{non json")[0] == 400,
      "/api/texture2d: corpo non JSON -> 400")
check(_req(None, path="/api/texture2d", raw_body=b'[1,2,3]')[0] == 400,
      "/api/texture2d: corpo JSON non oggetto -> 400")
check(_req({"width": 32}, path="/api/texture2d")[0] == 400,
      "/api/texture2d: prompt mancante -> 400")
check(_req({"prompt": 42}, path="/api/texture2d")[0] != 0,
      "/api/texture2d: prompt non testuale -> risposta HTTP (non connessione chiusa)")
check(_req({"prompt": []}, path="/api/texture2d")[0] == 400,
      "/api/texture2d: prompt lista vuota -> 400")

NEXT_ANSWER[0] = "Mi dispiace, non posso disegnare."
s, d = _req({"prompt": "spada"}, path="/api/texture2d")
check(s == 400 and "rawPreview" in d,
      "/api/texture2d: risposta senza JSON -> 400 con anteprima")

NEXT_ANSWER[0] = '{"size":32,"palette":{"a":"#FFFFFF"},"faces":{}}'
s, d = _req({"prompt": "spada"}, path="/api/texture2d")
check(s == 400 and "warnings" in d, "/api/texture2d: JSON senza disegno -> 400 spiegato")

NEXT_ANSWER[0] = Exception("cookie non valido o scaduto")
s, d = _req({"prompt": "spada"}, path="/api/texture2d")
check(s == 401 and d.get("needsCookies") is True,
      "/api/texture2d: sessione scaduta -> 401 con needsCookies")
NEXT_ANSWER[0] = OSError("connection reset by peer")
s, d = _req({"prompt": "spada"}, path="/api/texture2d")
check(s == 503 and d.get("retryable") is True,
      "/api/texture2d: errore di rete -> 503 riprovabile")

# La pagina dell'editor e' servita dal server del padre senza rotte aggiuntive:
# e' il presupposto di tutto il ponte, e va verificato invece che dato per buono.
# Si costruisce l'handler senza farlo dialogare su un socket (translate_path e'
# puro): __init__ di BaseHTTPRequestHandler servirebbe una richiesta vera.
_h = object.__new__(main.VoxelAIRequestHandler)
_h.directory = os.getcwd()
check(_h.translate_path('/PixelAIEditor/ui/locales/it.json')
      == os.path.join(main.BASE_DIR, 'PixelAIEditor', 'ui', 'locales', 'it.json'),
      "translate_path ribasa /PixelAIEditor/... su BASE_DIR")
check(os.path.exists(_h.translate_path('/PixelAIEditor/ui/locales/it.json')),
      "il file mappato esiste davvero su disco")

if fails:
    print("\n%d CHECK FALLITI" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("\nTUTTI I CHECK OK")
