# -*- coding: utf-8 -*-
"""Applica le tabelle .i18n_keys_*.py ai 6 file ui/locales/<lang>.json.

Convenzione preservata: UTF-8 SENZA BOM, indentazione 2 spazi, ensure_ascii=False,
ordine di inserimento (le nuove chiavi vengono APPESE in coda come le ondate
precedenti), file terminato da newline.
"""
import io
import json
import os
import runpy
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt']

new = {}
update = {}
order = []
for part in ('1', '2', '3', '4'):
    mod = runpy.run_path(os.path.join(ROOT, 'tests', '.i18n_keys_%s.py' % part))
    for k, v in mod.get('NEW', {}).items():
        if k in new:
            sys.exit('chiave duplicata fra le parti: ' + k)
        new[k] = v
        order.append(k)
    update.update(mod.get('UPDATE', {}))

for k, v in list(new.items()) + list(update.items()):
    if len(v) != len(LANGS):
        sys.exit('%s: attesi %d valori, trovati %d' % (k, len(LANGS), len(v)))
    for s in v:
        if not isinstance(s, str) or not s.strip():
            sys.exit('%s: valore vuoto o non stringa' % k)

added_total = 0
for i, lang in enumerate(LANGS):
    path = os.path.join(ROOT, 'ui', 'locales', '%s.json' % lang)
    with io.open(path, encoding='utf-8') as fh:
        d = json.load(fh)
    before = len(d)
    for k, v in update.items():
        if k not in d:
            sys.exit('%s: UPDATE su chiave inesistente %s' % (lang, k))
        d[k] = v[i]
    for k in order:
        if k in d:
            sys.exit('%s: la chiave nuova %s esiste gia' % (lang, k))
        d[k] = new[k][i]
    txt = json.dumps(d, ensure_ascii=False, indent=2) + '\n'
    with io.open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(txt)
    added_total += len(d) - before
    print('%s: %d -> %d chiavi (+%d)' % (lang, before, len(d), len(d) - before))

print('nuove chiavi per lingua: %d, aggiornate: %d' % (len(order), len(update)))
