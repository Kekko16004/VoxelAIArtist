"""L'AVVIO AUTONOMO serve davvero l'applicazione.

Il prompt che ha creato questa app chiedeva "un file bat/py per avviare solo
quello", e questo e' l'unico test che prova quel percorso. Gli altri tre della
suite leggono file dal disco senza mai passare da `main.py`, e la verifica GUI
serve la pagina da un server di comodo scritto dentro la prova stessa: quindi
`BASE_DIR`, `translate_path` e le rotte `/api/*` restavano non provati, ed e'
esattamente li' che vive la differenza fra "avviato da solo" e "avviato dentro
VoxelAIArtist".

Non lancia un processo separato: importa `main.py` e avvia il suo server sul
thread di servizio che userebbe l'avvio vero. Cosi' il browser non si apre (lo
apre `main()`, non `start_server`) e non resta un processo appeso se il test
fallisce a meta'.

Niente rete, niente cookie, niente quota AI: si interrogano solo rotte locali, e
nessuna di quelle toccate qui chiama il generatore.
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

# La console di Windows e' cp1252 e le etichette qui sotto hanno accenti.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:                                                # noqa: BLE001
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)

# `translate_path` risolve i percorsi rispetto alla cartella dell'app facendo un
# `relpath` su `os.getcwd()`: lanciato da un'altra cartella servirebbe file da
# un'altra parte, che e' un difetto vero ma non quello che questo test cerca.
os.chdir(APP)
sys.path.insert(0, APP)

import main as app                                               # noqa: E402

ok = 0
fail = 0


def check(label, cond, detail=None):
    global ok, fail
    if cond:
        ok += 1
        print('  ok - ' + label)
    else:
        fail += 1
        print('  FALLITO - ' + label + (' :: ' + repr(detail) if detail is not None else ''))


threading.Thread(target=app.start_server, daemon=True).start()
for _ in range(200):
    if app.PORT:
        break
    time.sleep(0.05)
check('il server sceglie una porta libera', bool(app.PORT), app.PORT)
if not app.PORT:
    print('')
    print('%d ok, %d falliti' % (ok, fail))
    sys.exit(1)

BASE = 'http://127.0.0.1:%d' % app.PORT


def get(path):
    try:
        with urllib.request.urlopen(BASE + path, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:                                       # noqa: BLE001
        return 0, str(e).encode('utf-8', 'replace')


status, body = get('/ui/index.html')
check('serve ui/index.html', status == 200, status)
# Un segnaposto non sostituito vuol dire build mai lanciata: la pagina si
# aprirebbe vuota e senza errori in console, perche' manca proprio lo script.
check("la pagina e' il bundle vero, non il segnaposto",
      b'<!--BUNDLE-->' not in body and len(body) > 200000, len(body))
# Con un BASE_DIR sbagliato il server servirebbe l'index di VoxelAIArtist senza
# lamentarsi di niente: si aprirebbe l'app sbagliata dal collegamento giusto.
check("la pagina e' PixelAIEditor e non quella del padre",
      b'pixApp' in body or b'PixelAIEditor' in body)

status, body = get('/ui/locales/it.json')
check('serve i dizionari', status == 200 and b'pix.' in body, status)

status, body = get('/api/settings')
check('/api/settings risponde', status == 200, status)
if status == 200:
    data = json.loads(body.decode('utf-8'))
    # `needsCookies` e' il contratto su cui la finestra delle impostazioni decide
    # se aprirsi da sola. Se sparisse, chi non ha i cookie non riceverebbe nessun
    # invito a metterli e la generazione fallirebbe muta.
    check('/api/settings dichiara needsCookies', 'needsCookies' in data, sorted(data))
    check("/api/settings si dichiara PixelAIEditor", data.get('app') == 'PixelAIEditor',
          data.get('app'))

# I cookie sono CONDIVISI col padre di proposito (una sessione Google non e' una
# preferenza), le impostazioni no. Se la condivisione si rompesse, la stessa
# installazione chiederebbe di rifare il login solo quando l'editor e' avviato
# da solo -- un difetto che non si vede mai provando il ponte.
sys.path.insert(0, os.path.join(os.path.dirname(APP), 'src'))
import settings as st                                            # noqa: E402
check('i cookie restano nella cartella condivisa',
      os.path.basename(os.path.dirname(st.get_cookies_path())) == 'VoxelAIArtist',
      st.get_cookies_path())
check('le impostazioni invece sono separate',
      os.path.basename(st.get_appdata_dir()) == 'PixelAIEditor',
      st.get_appdata_dir())

# Un percorso che risale l'albero non deve uscire dalla cartella dell'app: e'
# l'attacco classico su un server statico scritto a mano, e qui il server ascolta
# comunque su una porta.
status, _ = get('/ui/../../../../Windows/win.ini')
check('non si esce dalla cartella (path traversal)', status in (403, 404), status)

print('')
if fail:
    print('%d ok, %d falliti' % (ok, fail))
else:
    print('tutti i controlli passati (%d)' % ok)
sys.exit(1 if fail else 0)
