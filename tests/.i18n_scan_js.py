#!/usr/bin/env python3
"""Scansiona i moduli JS per stringhe italiane hardcoded in contesti VISIBILI.
Euristica: righe non-commento che contengono un literal con parole italiane e
sono usate in alert/confirm/prompt/textContent/innerHTML/title/placeholder/label.
Uso: python tests/.i18n_scan_js.py
"""
import re, os, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

IT_WORDS = r"(?:\b(?:il|lo|la|le|gli|un|una|uno|del|della|dei|delle|degli|dal|dalla|nel|nella|sul|sulla|con|per|non|che|come|questo|questa|questi|queste|piu|puo|sono|essere|hai|serve|senza|solo|anche|ancora|ogni|tutti|tutte|tutto|prima|dopo|adesso|invece|oppure|quando|dove|perche|quindi|nessun|nessuna|nessuno|voxel|osso|ossa|scheletro|modello|oggetto|oggetti|parte|parti|colore|colori|griglia|pennello|posa|pose|pesi|animazione|animazioni|progetto|salva|salvataggio|carica|caricamento|errore|errori|apri|apertura|elimina|eliminare|rinomina|annulla|ripeti|impostazioni|cartella|file|formato|valido|valida|scegli|seleziona|clicca|premi|trascina|genera|generazione|crea|creare|creato|creata|aggiungi|rimuovi|rimuovere|cambia|attiva|attivo|attiva|disattiva|mostra|nascondi|riferimento|riferimenti|dimensione|larghezza|altezza|profondita|asse|assi|simmetria|specchia|centro|corpo|braccio|gamba|testa|mano|piede|nome|descrizione|richiesta|risposta|pronto|pronta|corrente|correnti|manuale|manuali|automatico|automatica)\b)"

VISIBLE = re.compile(
    r"(alert\(|confirm\(|(?<![\w.])prompt\(|\.textContent\s*=|\.innerHTML\s*=|\.title\s*=|"
    r"\.placeholder\s*=|setAttribute\(\s*['\"](?:title|placeholder|aria-label)|"
    r"\.label\s*=|textContent:|title:|label:|\.value\s*=\s*['\"]|throw new Error\(|"
    r"\.push\(\s*['\"]|=\s*['\"][^'\"]*['\"]\s*;?\s*//\s*)"
)
LIT = re.compile(r"""(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)""", re.S)

rows = []
for f in sorted(glob.glob(os.path.join(ROOT, 'ui', 'src', 'lib', '*.js'))):
    src = open(f, encoding='utf-8').read().split('\n')
    for i, line in enumerate(src, 1):
        s = line.strip()
        if s.startswith('//') or s.startswith('*') or s.startswith('/*'):
            continue
        code = line.split('//')[0] if '://' not in line else line
        if not VISIBLE.search(code):
            continue
        for m in LIT.finditer(code):
            lit = m.group(0)
            inner = lit[1:-1]
            if len(inner) < 3:
                continue
            if re.search(IT_WORDS, inner, re.I):
                rows.append((os.path.basename(f), i, inner[:120]))
                break

out = open(os.path.join(ROOT, 'tests', '.i18n_scan_js_out.txt'), 'w', encoding='utf-8')
cur = None
for fn, ln, txt in rows:
    if fn != cur:
        out.write('\n===== %s =====\n' % fn)
        cur = fn
    out.write('L%-6d %s\n' % (ln, txt))
out.write('\n--- %d righe sospette ---\n' % len(rows))
out.close()
print('%d righe sospette -> tests/.i18n_scan_js_out.txt' % len(rows))
