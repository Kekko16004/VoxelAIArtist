#!/usr/bin/env python3
"""Confronta il testo italiano inline di 31-help.js con le chiavi help.s.* di it.json.
Se divergono, gli italiani vedono it.json (stale) e le altre lingue una traduzione
di un testo che non esiste piu'. Strumento di lavoro, non parte della suite.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = json.load(open(os.path.join(ROOT, 'ui/locales/it.json'), encoding='utf-8'))
src = open(os.path.join(ROOT, 'ui/src/lib/31-help.js'), encoding='utf-8').read()

LIT = re.compile(r"'((?:[^'\\]|\\.)*)'")
SEC = re.compile(r"id: '(\w+)', icon: '([^']*)', title: '((?:[^'\\]|\\.)*)',\s*body: \[(.*?)\]\.join", re.S)

for m in SEC.finditer(src):
    sid, icon, title, body = m.groups()
    title = title.replace("\\'", "'")
    lines = [x.replace("\\'", "'") for x in LIT.findall(body)]
    inline = '\n'.join(lines)
    jt = d.get('help.s.%s.t' % sid, '')
    jb = d.get('help.s.%s.b' % sid, '')
    print('%-9s title %-6s body %-6s (inline %d righe/%d ch | it.json %d righe/%d ch)' % (
        sid,
        'OK' if title == jt else 'DRIFT',
        'OK' if inline == jb else 'DRIFT',
        inline.count('\n') + 1, len(inline),
        jb.count('\n') + 1, len(jb)))
