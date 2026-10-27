"""Scrittura su disco ATOMICA, per ogni file che l'utente non deve perdere.

Il difetto che risolve (riprodotto nell'audit del 2026-10-26): ogni salvataggio
faceva `open(path, "w")` + `json.dump`. `open("w")` TRONCA il file prima ancora
di aver serializzato una riga, quindi:
- un errore a meta' `json.dump` (un valore non serializzabile, disco pieno, il
  processo chiuso) lasciava il file VECCHIO distrutto e quello nuovo a meta':
  un `.voxai` illeggibile, un `settings.json` vuoto;
- un lettore che arrivava in quell'istante (l'app e l'MCP leggono gli stessi
  `settings.json` / `providers.json`, e il server HTTP e' multi-thread) vedeva
  un JSON troncato, ricadeva su `{}`, e alla sua scrittura successiva salvava
  `{}` piu' la sua chiave: impostazioni, provider e CHIAVI API spariti.

Qui si scrive in un file temporaneo nella STESSA cartella (stesso volume, o
`os.replace` non e' atomico), si fa `fsync` e lo si sostituisce al vero con
`os.replace`. Il file vecchio resta intatto fino all'ultimo istante.

Su Windows `os.replace` fallisce con PermissionError se un altro processo ha il
file aperto proprio in quel momento (un lettore, un antivirus): si ritenta per
poco piu' di mezzo secondo prima di arrendersi.

Il JSON si SERIALIZZA PRIMA di aprire qualunque file: un `TypeError` di
`json.dumps` non tocca il disco.
"""

import json
import os
import tempfile
import threading
import time

# Un solo lock per i read-modify-write di questo PROCESSO (settings, provider,
# libreria). Rientrante: `set_setting` lo prende e chiama `save_settings`, che
# lo riprende. Fra processi diversi resta il rischio di un aggiornamento perso,
# ma non piu' quello di un file troncato.
LOCK = threading.RLock()

_REPLACE_TRIES = 12
_REPLACE_WAIT = 0.05


def atomic_write_bytes(path, data):
    """Scrive `data` (bytes) in `path` senza mai lasciarlo a meta'."""
    path = os.path.abspath(path)
    folder = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".",
                               suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        last = None
        for _ in range(_REPLACE_TRIES):
            try:
                os.replace(tmp, path)
                return path
            except PermissionError as e:          # Windows: file aperto altrove
                last = e
                time.sleep(_REPLACE_WAIT)
        raise last
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def atomic_write_text(path, text, encoding="utf-8"):
    return atomic_write_bytes(path, str(text).encode(encoding))


def atomic_write_json(path, obj, **dump_kwargs):
    """`json.dump` atomico. Serializza PRIMA: un errore non tocca il file."""
    text = json.dumps(obj, **dump_kwargs)
    return atomic_write_text(path, text)


def backup_corrupt(path):
    """Mette da parte un file che non si riesce a leggere, invece di
    sovrascriverlo: e' l'unica copia di cio' che conteneva. Ritorna il nuovo
    nome o None."""
    if not os.path.exists(path):
        return None
    dest = "%s.corrotto-%d" % (path, int(time.time()))
    try:
        os.replace(path, dest)
        return dest
    except OSError:
        return None
