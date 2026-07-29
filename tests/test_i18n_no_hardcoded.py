"""Nessuna stringa italiana hardcoded nei messaggi della UI.

Le 6 lingue sono complete e t() esiste dal 2026-07: il rischio non e' piu' la
traduzione mancante, e' la riga nuova che scrive italiano a mano. Questo test
guarda i punti dove l'utente legge davvero il testo (alert/confirm/prompt e le
assegnazioni a textContent/innerHTML/title/placeholder) e pretende che il
literal passi da t().

Complementa test_i18n_keys_used.py: quello verifica che le chiavi citate
esistano, questo che non si smetta di citarle.
"""
import glob
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Parole che compaiono solo in prosa italiana, non in codice/CSS/HTML.
IT = re.compile(r"\b(?:il|lo|la|le|gli|un|una|del|della|dei|delle|con|per|non|"
                r"che|nel|nella|sono|questo|questa|prima|dopo|senza|serve|"
                r"seleziona|scegli|nessun|nessuna|almeno|deve|devi|puoi|"
                r"errore|errori|impossibile|valido|valida|caricare|caricamento|"
                r"salvataggio|eliminare|aggiungere|apertura|riprova|voxel)\b",
                re.IGNORECASE)

TARGETS = re.compile(r"\b(alert|confirm|prompt)\s*\(|"
                     r"\.(?:textContent|innerHTML|title|placeholder)\s*=")
LITERAL = re.compile(r"""(['"`])((?:\\.|(?!\1)[^\\])*)\1""")
TRANSLATED = re.compile(r"\b(?:t|tr)\(\s*['\"]")

# Eccezioni motivate: il testo italiano e' un segnaposto sostituito da
# applyI18n() grazie all'attributo data-i18n sullo stesso nodo.
ALLOW = {
    ("25-properties.js", 'data-i18n="properties.empty"'),
}


def allowed(name, line):
    return any(name == f and marker in line for f, marker in ALLOW)


def main():
    rows = []
    files = sorted(glob.glob(os.path.join(ROOT, "ui", "src", "lib", "*.js")))
    files += sorted(glob.glob(os.path.join(ROOT, "ui", "src", "utils", "*.js")))
    for path in files:
        name = os.path.basename(path)
        src = io.open(path, encoding="latin1").read()
        for n, line in enumerate(src.split("\n"), 1):
            if not TARGETS.search(line) or TRANSLATED.search(line):
                continue
            if allowed(name, line):
                continue
            if any(IT.search(txt) for txt in
                   (m.group(2) for m in LITERAL.finditer(line))):
                rows.append((name, n, line.strip()[:120]))

    print("file esaminati: %d" % len(files))
    if rows:
        print("FALLITO: %d messaggi ancora in italiano hardcoded" % len(rows))
        for name, n, line in rows:
            print("  %s:%d  %s" % (name, n, line))
        print("Usa t('chiave') (le chiavi esistono in ui/locales/it.json).")
        return 1
    print("nessun messaggio italiano hardcoded (%d eccezioni note)" % len(ALLOW))
    return 0


if __name__ == "__main__":
    sys.exit(main())
