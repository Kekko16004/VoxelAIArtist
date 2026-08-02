#!/usr/bin/env python3
"""Scansiona il template per testo visibile NON annotato con data-i18n.
Uso: python tests/.i18n_scan.py [--json]
Non fa parte della suite: e' uno strumento di lavoro per l'i18n.
"""
import re
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'ui', 'src', 'index.template.html')
html = open(SRC, encoding='utf-8').read()
# I commenti non sono testo visibile: li sostituiamo con spazi (mantenendo le righe).
html = re.sub(r'<!--.*?-->', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), html, flags=re.S)
html = re.sub(r'<!DOCTYPE[^>]*>', lambda m: ' ' * len(m.group(0)), html, flags=re.I)

# Rimuove <style>, <script>, commenti
def strip_blocks(s):
    out = []
    i = 0
    while True:
        m = re.search(r'<(style|script)\b', s[i:], re.I)
        if not m:
            out.append((i, len(s)))
            break
        start = i + m.start()
        tag = m.group(1)
        end = s.lower().find('</%s>' % tag, start)
        if end < 0:
            out.append((i, len(s)))
            break
        out.append((i, start))
        i = end + len(tag) + 3
    return out

ranges = strip_blocks(html)
lines_of = lambda pos: html.count('\n', 0, pos) + 1

TAG_RE = re.compile(r'<([a-zA-Z][\w-]*)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*)>|</([a-zA-Z][\w-]*)>')
findings = []
for (rs, re_) in ranges:
    chunk = html[rs:re_]
    pos = 0
    stack = []
    for m in TAG_RE.finditer(chunk):
        text = chunk[pos:m.start()]
        pos = m.end()
        stripped = re.sub(r'\s+', ' ', text).strip()
        if stripped and re.search(r'[A-Za-zÀ-ſ]{2}', stripped):
            open_tag = stack[-1] if stack else None
            if not (open_tag and open_tag[1]):
                findings.append(('TEXT', lines_of(rs + m.start()), (open_tag[0] if open_tag else '?'), stripped[:100]))
        if m.group(1):
            name = m.group(1).lower()
            attrs = m.group(2) or ''
            has = 'data-i18n=' in attrs
            selfclose = attrs.rstrip().endswith('/') or name in ('br', 'input', 'img', 'hr', 'meta', 'link')
            # attributi visibili
            for attr, key in (('title', 'data-i18n-title'), ('placeholder', 'data-i18n-placeholder')):
                am = re.search(r'\b%s="([^"]*)"' % attr, attrs)
                if am and am.group(1).strip() and key not in attrs:
                    findings.append((attr.upper(), lines_of(rs + m.start()), name, am.group(1)[:100]))
            if not selfclose:
                stack.append((name, has))
        elif m.group(3):
            if stack:
                stack.pop()

out = open(os.path.join(ROOT, 'tests', '.i18n_scan_out.txt'), 'w', encoding='utf-8')
for kind, line, tag, txt in findings:
    out.write('%-12s L%-6d <%s> %s\n' % (kind, line, tag, txt))
out.write('--- %d stringhe non annotate ---\n' % len(findings))
out.close()
print('%d stringhe non annotate -> tests/.i18n_scan_out.txt' % len(findings))
