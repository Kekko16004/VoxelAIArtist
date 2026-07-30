"""6d. Nessun testo italiano non annotato in ui/src/index.template.html.

Il test 6c (`test_i18n_no_hardcoded.py`) guarda il **JavaScript**: alert, confirm,
textContent, title... Il markup statico gli sfugge del tutto, ed e' proprio dove
erano rimasti indietro i piu' visibili (le sezioni del rig, "Ruota", "Sposta",
i tooltip della barra progetto): 32 testi e 23 attributi `title=` scritti in
italiano dentro il template.

`applyI18n(root)` (ui/src/lib/23-i18n.js) tocca SOLO:
  - `textContent` dei nodi con `data-i18n`
  - `title` dei nodi con `data-i18n-title`
  - `placeholder` dei nodi con `data-i18n-placeholder`
Tutto il resto del markup resta nella lingua in cui e' scritto, per sempre.

Quindi: se un nodo contiene prosa italiana e il suo genitore diretto non ha
`data-i18n`, quel testo NON e' traducibile -> il test fallisce.

Nota sui `<label>` con dentro uno `<span>` dinamico
(`Dimensione pennello <span id="brushSizeVal">1</span>`): `data-i18n` sul label
sovrascriverebbe anche lo span, percio' il testo va avvolto in uno span proprio
(`<span data-i18n="...">Dimensione pennello</span> <span id="brushSizeVal">`).
"""
import io
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL = os.path.join(ROOT, "ui", "src", "index.template.html")

# Parole italiane: se una di queste compare in un testo, quel testo e' prosa da
# tradurre. Le stringhe di soli simboli/numeri/emoji non hanno match e passano.
IT = re.compile(
    r"\b(?:il|lo|la|le|gli|un|una|uno|del|della|dei|delle|con|per|non|che|nel|"
    r"nella|sono|questo|questa|prima|dopo|senza|serve|seleziona|scegli|nessun|"
    r"nessuna|almeno|deve|devi|puoi|errore|errori|impossibile|valido|valida|"
    r"caricare|caricamento|salvataggio|eliminare|aggiungere|apertura|riprova|"
    r"voxel|ruota|ruotare|muovi|muovere|scala|sposta|spostare|colora|colore|"
    r"colori|griglia|oggetto|oggetti|lingua|tema|aspetto|salva|salvato|apri|"
    r"nuovo|nuova|impostazioni|cartella|generale|avanzate|cancella|annulla|"
    r"conferma|chiudi|modifica|modalita|dimensione|dimensioni|altezza|"
    r"larghezza|profondita|specchio|specchia|simmetria|simmetrizza|pennello|"
    r"forma|dettagli|animazione|animazioni|ossa|osso|posa|pose|scheletro|"
    r"rigging|peso|pesi|fotogramma|fotogrammi|durata|velocita|riproduci|"
    r"esporta|importa|incolla|progetto|progetti|recenti|cronologia|aiuto|"
    r"scorciatoie|visualizza|mostra|nascondi|attiva|attivo|disattiva|riporta|"
    r"riferimento|richiesta|genera|generazione|modello|modelli|parte|parti|"
    r"figlio|figli|riempi|trasforma|libera|blocca|piano|asse|assi|centro|"
    r"nome|foto|libreria|rinomina|rinominarlo|premi|clic|clicca|tasto|"
    r"trascina|orientamento|estremita|arto|personaggio|rispetto|intera|"
    r"scena|automatici|predefiniti|combinazione|azione|passare)\b",
    re.IGNORECASE)

SKIP_TAGS = {"script", "style", "title", "option"}

# Eccezioni motivate. Chiave = testo esatto (strip) o valore esatto
# dell'attributo. Aggiungerne una richiede una riga di spiegazione.
ALLOW_TEXT = {
    # nomi propri / marchi: non si traducono
    "Voxel AI Artist",
    "VoxelAI",
    # valore iniziale di <span id="wpRadiusVal">: lo riscrive il JS con
    # t('rig.wp.radiusN'). Un data-i18n qui farebbe il danno opposto: al cambio
    # lingua applyI18n() rimetterebbe "2 voxel" anche con il raggio a 5.
    "2 voxel",
}
ALLOW_ATTR = {
    # nessuna per ora
}


class Scan(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self)
        self.stack = []
        self.texts = []
        self.attrs = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        line = self.getpos()[0]
        ident = d.get("id") or d.get("class") or ""
        if tag in SKIP_TAGS:
            self.skip += 1
        for attr in ("title", "placeholder"):
            val = (d.get(attr) or "").strip()
            if not val or val in ALLOW_ATTR or not IT.search(val):
                continue
            if ("data-i18n-" + attr) in d:
                continue
            self.attrs.append((line, tag, ident, attr, val))
        if tag not in ("br", "hr", "img", "input", "meta", "link"):
            self.stack.append((tag, "data-i18n" in d, line, ident))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag in SKIP_TAGS and self.skip:
            self.skip -= 1
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self.skip:
            self.skip -= 1
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if self.skip:
            return
        txt = data.strip()
        if not txt or txt in ALLOW_TEXT or not IT.search(txt):
            return
        if self.stack and self.stack[-1][1]:
            return                     # il genitore diretto ha data-i18n
        tag, _h, line, ident = self.stack[-1] if self.stack else ("?", 0, 0, "")
        self.texts.append((self.getpos()[0], tag, ident, " ".join(txt.split())))


p = Scan()
p.feed(io.open(TPL, encoding="utf-8").read())

if p.texts or p.attrs:
    out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    out.write("TESTO non traducibile: %d\n" % len(p.texts))
    for line, tag, ident, txt in p.texts:
        out.write("  riga %-5d <%s %s>  %s\n" % (line, tag, ident, txt[:90]))
    out.write("ATTRIBUTI non traducibili: %d\n" % len(p.attrs))
    for line, tag, ident, attr, val in p.attrs:
        out.write("  riga %-5d <%s %s>  %s=%s\n" % (line, tag, ident, attr, val[:80]))
    out.write("\nServe data-i18n / data-i18n-title / data-i18n-placeholder "
              "(vedi la docstring per i label con span dentro).\n")
    out.flush()
    sys.exit(1)

print("template: nessun testo italiano non annotato")
