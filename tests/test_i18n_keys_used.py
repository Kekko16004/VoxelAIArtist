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

# --- segnaposto: i nomi passati a t() devono coincidere con quelli nel testo ---
# Un `t('rigTools.poseBoneCount', { count: 3 })` (la chiave vuole {n}) non da'
# errore: mostra "{n} ossa nella posa" all'utente. Silenzioso e brutto.
PLACEHOLDER_RE = re.compile(r"\{([A-Za-z0-9_]+)\}")


def object_keys(src, start):
    """Nomi di primo livello dell'oggetto letterale che inizia a `start` ('{').

    Accetta sia `{ error: e.message }` sia la forma abbreviata `{ n }`: la
    posizione conta, non i due punti (dopo `:` l'identificatore e' un valore).
    """
    depth, i, quote, out, n = 0, start, None, [], len(src)
    expect_key = False
    while i < n:
        c = src[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c in "{[(":
            depth += 1
            expect_key = (depth == 1)
        elif c in "}])":
            depth -= 1
            if depth == 0:
                return out
        elif depth == 1 and c == ",":
            expect_key = True
        elif depth == 1 and expect_key and (c.isalpha() or c in "_$"):
            m = re.match(r"[A-Za-z_$][A-Za-z0-9_$]*", src[i:])
            out.append(m.group(0))
            expect_key = False
            i += m.end() - 1
        i += 1
    return out


bad = []
for path in sorted(glob.glob(os.path.join(ROOT, "ui/src/lib/*.js"))) + \
        sorted(glob.glob(os.path.join(ROOT, "ui/src/utils/*.js"))):
    src = io.open(path, encoding="latin1").read()
    rel = os.path.relpath(path, ROOT)
    for m in CALL_RE.finditer(src):
        key = m.group(2)
        want = set(PLACEHOLDER_RE.findall(str(ref.get(key, ""))))
        rest = src[m.end():]
        # dopo la chiave: `)` -> nessuna variabile, `, {` -> oggetto di variabili.
        arg = re.match(r"\s*,\s*(?=\{)", rest)
        got = set(object_keys(src, m.end() + arg.end())) if arg else set()
        if arg is None and re.match(r"\s*,\s*[A-Za-z_$]", rest):
            continue                      # variabili passate per riferimento
        line_no = src.count("\n", 0, m.start()) + 1
        for name in sorted(want - got):
            bad.append((rel, line_no, key, "{%s} non passato" % name))
        for name in sorted(got - want):
            bad.append((rel, line_no, key, "'%s' non esiste nel testo" % name))

if bad:
    print("SEGNAPOSTO DISALLINEATI (%d):" % len(bad))
    for f, n, k, why in bad:
        print("  %s:%d  %s -> %s" % (f, n, k, why))
    sys.exit(1)
print("segnaposto {..} coerenti in tutte le chiamate t(chiave, {...})")

