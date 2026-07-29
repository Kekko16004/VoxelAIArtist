"""Controllo: ogni chiave i18n usata dal codice esiste in ui/locales/it.json.

Nasce da un bug reale: `t('rig.anim.errGeneric')` non esisteva in nessun locale,
quindi l'alert mostrava la chiave stessa. Il test delle chiavi complete
(run_all.sh) confronta i locali FRA LORO e non se ne accorge.

Copre:
  - le chiamate `t('chiave')` / `t("chiave")` nei moduli JS di ui/src/lib;
  - gli attributi data-i18n / data-i18n-title / data-i18n-placeholder del
    template (quelli sono gia' applicati da applyI18n, ma un typo li rende muti).

Le chiavi costruite a runtime (`t('pack.' + x)`) non sono verificabili e vengono
ignorate: il regex prende solo le stringhe letterali.
"""
import glob
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ref = json.load(io.open(os.path.join(ROOT, "ui/locales/it.json"), encoding="utf-8"))

CALL_RE = re.compile(r"""\b(?:t|tr)\(\s*(['"])([A-Za-z0-9_.\-]+)\1""")
ATTR_RE = re.compile(r"""data-i18n(?:-title|-placeholder)?\s*=\s*(['"])([^'"]+)\1""")

missing = []
used = set()

for path in sorted(glob.glob(os.path.join(ROOT, "ui/src/lib/*.js"))) + \
        sorted(glob.glob(os.path.join(ROOT, "ui/src/utils/*.js"))):
    src = io.open(path, encoding="latin1").read()
    for line_no, line in enumerate(src.split("\n"), 1):
        for _q, key in CALL_RE.findall(line):
            used.add(key)
            if key not in ref:
                missing.append((os.path.relpath(path, ROOT), line_no, key))

tpl = os.path.join(ROOT, "ui/src/index.template.html")
src = io.open(tpl, encoding="latin1").read()
for line_no, line in enumerate(src.split("\n"), 1):
    for _q, key in ATTR_RE.findall(line):
        used.add(key)
        if key not in ref:
            missing.append((os.path.relpath(tpl, ROOT), line_no, key))

print("chiavi i18n citate dal codice: %d (di %d in it.json)" % (len(used), len(ref)))
if missing:
    print("CHIAVI INESISTENTI (%d):" % len(missing))
    for f, n, k in missing:
        print("  %s:%d  %s" % (f, n, k))
    sys.exit(1)
print("tutte le chiavi citate esistono in it.json")
