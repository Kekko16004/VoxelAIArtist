"""Sessione: i documenti aperti dal server e il file su cui insistono.

Un server MCP e' senza stato per protocollo — ogni chiamata di strumento arriva
sola — ma modellare i voxel non lo e': "riempi da qui a qui" ha senso solo
rispetto a un modello che esiste gia'. Quindi lo stato vive QUI, in un registro
di documenti aperti, e gli strumenti lo raggiungono per nome.

Perche' un registro e non un singolo documento. Un assistente che converte un
`.vox` in GLB mentre ne sta modellando un altro non deve vedere i due
mescolarsi; e chi lavora su un solo modello non paga niente, perche' il nome del
documento e' opzionale ovunque e in sua assenza si usa quello CORRENTE.

Il documento corrente e' l'ultimo aperto o creato. E' la stessa convenzione
dell'oggetto attivo dentro un documento (`Document.active`), e per la stessa
ragione: rende l'uso normale — un modello alla volta — privo di cerimonie, senza
togliere la possibilita' di essere espliciti quando i modelli sono due.
"""

import json
import os

from .document import Document


class SessionError(RuntimeError):
    """Errore d'uso da riportare al chiamante come testo, non come traccia."""


class Session(object):
    def __init__(self):
        self.docs = {}               # nome -> Document
        self.current = None          # nome del documento corrente
        self._counter = 0

    # --- registro ---------------------------------------------------------

    def unique_name(self, base):
        base = (str(base or "").strip() or "Progetto")
        if base not in self.docs:
            return base
        n = 2
        while "%s %d" % (base, n) in self.docs:
            n += 1
        return "%s %d" % (base, n)

    def auto_save(self, doc):
        """Copia di sicurezza nella cartella dell'app, se e' raggiungibile.

        Due dettagli, entrambi gia' costati un guasto silenzioso:

        `src/` si importa PIATTO. `from src import settings` solleva sempre
        `ValueError: source code string cannot contain null bytes`, perche'
        `src/__init__.py` sono sei byte di BOM UTF-16: il pacchetto non e'
        importabile e non lo diventera'. Con l'`except` largo qui sotto
        l'eccezione spariva a ogni chiamata e l'autosalvataggio non ha MAI
        scritto niente, senza dirlo. Il percorso lo prepara `compat`.

        L'`except` resta largo perche' una copia di sicurezza non deve poter far
        fallire un'esportazione riuscita, ma ora il motivo si legge con --debug
        invece di sparire.
        """
        try:
            from . import compat
            app_settings = compat.settings_module()
            pid = self.name_of(doc) or getattr(doc, "name", "mcp_project")
            disp = getattr(doc, "name", pid) or pid
            if hasattr(doc, "objects") and doc.objects:
                obj_names = [o.name for o in doc.objects if getattr(o, "name", None)]
                if obj_names:
                    disp = ", ".join(obj_names[:3])
            app_settings.write_autosave(doc.to_payload(), pid, display_name=disp)
        except Exception as e:
            import logging
            logging.getLogger("voxelai.mcp").debug("autosave non riuscito: %r", e)

    def export_history(self, doc, name=None):
        """JSON definitivo nella cartella history (NON l'autosave).

        Stesso `except` largo dell'autosave: un export riuscito non deve
        fallire perche' la cartella history non e' scrivibile.
        """
        try:
            from . import compat
            app_settings = compat.settings_module()
            disp = (name or getattr(doc, "name", None)
                    or self.name_of(doc) or "modello")
            if hasattr(doc, "objects") and doc.objects:
                obj_names = [o.name for o in doc.objects if getattr(o, "name", None)]
                if obj_names and not name:
                    disp = obj_names[0]
            return app_settings.write_export_history(doc.to_payload(), disp)
        except Exception as e:
            import logging
            logging.getLogger("voxelai.mcp").debug("export-history non riuscito: %r", e)
            return None


    def put(self, doc, name=None):
        name = self.unique_name(name or doc.name)
        doc.name = name
        self.docs[name] = doc
        self.current = name
        self.auto_save(doc)
        return name

    def get(self, name=None):
        if name is None or name == "":
            if self.current is None:
                raise SessionError(
                    "nessun documento aperto: usa voxel_new o voxel_open")
            return self.docs[self.current]
        key = str(name)
        if key in self.docs:
            return self.docs[key]
        low = key.strip().lower()
        for k, doc in self.docs.items():
            if k.lower() == low:
                return doc
        names = ", ".join(sorted(self.docs)) or "(nessuno)"
        raise SessionError("documento '%s' non aperto. Aperti: %s" % (key, names))

    def name_of(self, doc):
        for k, d in self.docs.items():
            if d is doc:
                return k
        return doc.name

    def use(self, name):
        doc = self.get(name)
        self.current = self.name_of(doc)
        return doc

    def close(self, name=None):
        doc = self.get(name)
        key = self.name_of(doc)
        self.docs.pop(key, None)
        if self.current == key:
            self.current = next(iter(self.docs), None)
        return key

    def new(self, name=None):
        self._counter += 1
        doc = Document(name or "Progetto %d" % self._counter)
        return self.put(doc, name)

    def open_path(self, path, name=None):
        path = os.path.expanduser(str(path))
        if not os.path.isfile(path):
            raise SessionError("file non trovato: %s" % path)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except ValueError as e:
            raise SessionError("il file non e' un progetto JSON valido: %s" % e)
        except OSError as e:
            raise SessionError("non riesco a leggere %s: %s" % (path, e))
        doc = Document.from_payload(
            data, name=name or os.path.splitext(os.path.basename(path))[0],
            path=path)
        return self.put(doc, doc.name)

    def save_path(self, doc, path=None):
        target = path or doc.path
        if not target:
            raise SessionError(
                "documento senza percorso: indica dove salvarlo")
        target = os.path.expanduser(str(target))
        folder = os.path.dirname(os.path.abspath(target))
        if folder and not os.path.isdir(folder):
            raise SessionError("la cartella non esiste: %s" % folder)
        payload = {"format": "voxai-project", "version": 1,
                   "data": doc.to_payload()}
        try:
            with open(target, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except OSError as e:
            raise SessionError("non riesco a scrivere %s: %s" % (target, e))
        doc.path = target
        self.auto_save(doc)
        return target


SESSION = Session()

