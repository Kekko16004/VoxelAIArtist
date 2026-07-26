"""
Blocchi modulari per level builder (snap) e palette non piu' invasiva.
Riproduce i due difetti segnalati dall'utente:
  - un blocco di ferro grigio diventava verde terra (palette forzata)
  - i blocchi non riempivano la griglia -> fessure nel level builder
Nessuna rete, nessun cookie, nessuna quota AI.
"""
import json, os, sys, time

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(REPO_ROOT, 'src'))

import pack
from parser import expand_ops

ok = lambda m: print("  OK  " + m)
def check(c, m):
    if not c:
        print("  FAIL " + m); sys.exit(1)
    ok(m)

print("=== 1. il difetto: palette di terra imposta a un blocco di ferro ===")
terra_palette = ['#6B4423', '#4A7C23']          # marrone + verde erba
ferro = {'palette': {'a': '#9A9A9A', 'b': '#C0C0C0', 'c': '#6E6E6E', 'd': '#E8E8E8'},
         'ops': [['fill', 0, 0, 0, 7, 7, 7, 'a']]}

# Comportamento AGGRESSIVO (tolerance=None): e' quello che rovinava i blocchi
aggr, rep_a = pack.enforce_palette(json.loads(json.dumps(ferro)), terra_palette, tolerance=None)
verdi = [v for v in aggr['palette'].values() if v in terra_palette]
check(len(verdi) == 4, "senza tolleranza: tutti e 4 i grigi diventano terra/erba (il difetto)")

# Comportamento DI DEFAULT: la tolleranza protegge i materiali diversi
safe, rep_s = pack.enforce_palette(json.loads(json.dumps(ferro)), terra_palette)
grigi = [v for v in safe['palette'].values() if v.upper() in
         ('#9A9A9A', '#C0C0C0', '#6E6E6E', '#E8E8E8')]
check(len(grigi) >= 2, "con tolleranza: i grigi lontani restano grigi (%d su 4)" % len(grigi))
check(rep_s['kept'] > 0, "il report dice quanti colori sono stati lasciati (%d)" % rep_s['kept'])

print("=== 2. ma le SFUMATURE dello stesso materiale vanno ancora allineate ===")
quasi = {'palette': {'a': '#4B7D24', 'b': '#6C4524'}, 'ops': []}   # a un passo dall'ancora
out, rep = pack.enforce_palette(quasi, terra_palette)
check(rep['remapped'] == 2 and rep['kept'] == 0,
      "due sfumature vicine allineate alla palette (remapped=%d, kept=%d)" % (rep['remapped'], rep['kept']))
check(set(out['palette'].values()) <= set(terra_palette), "usano solo colori del pack")

print("=== 3. il criterio percettivo distingue materiale da sfumatura ===")
# La sola distanza RGB non basta: misurato, "grigio scuro vs verde" dista 20.251
# mentre "verde chiaro vs verde scuro" dista 4.924. Serve saturazione + tinta.
TOL = pack.DEFAULT_PALETTE_TOLERANCE
diversi = [('#9A9A9A', '#4A7C23', 'ferro vs erba'),
           ('#6E6E6E', '#4A7C23', 'grigio scuro vs verde'),
           ('#8B5A2B', '#808080', 'legno vs grigio'),
           ('#4A7C23', '#6B4423', 'verde vs marrone'),
           ('#E8E8E8', '#6B4423', 'bianco vs terra')]
for a, b, lbl in diversi:
    check(not pack._same_material(a, b, TOL), "materiali diversi riconosciuti: %s" % lbl)

sfumature = [('#9A9A9A', '#A0A0A0', 'due grigi'),
             ('#4A7C23', '#5C9B2F', 'verde chiaro/scuro'),
             ('#6B4423', '#71492A', 'due marroni'),
             ('#C0C0C0', '#B5B5B5', 'due argenti')]
for a, b, lbl in sfumature:
    check(pack._same_material(a, b, TOL), "sfumature riconosciute: %s" % lbl)

# il caso che la sola distanza sbagliava
check(pack._color_distance('#6E6E6E', '#4A7C23') < pack._color_distance('#9A9A9A', '#4A7C23'),
      "la distanza da sola fallirebbe: grigio scuro e piu VICINO al verde di quanto lo sia il grigio chiaro")

print("=== 4. verifica modularita': blocco CONFORME ===")
good = {'metadata': {'grid_size': [8, 8, 8]},
        'palette': {'a': '#808080', 'b': '#606060'},
        'ops': [['fill', 0, 0, 0, 7, 7, 7, 'a'],      # riempie TUTTA la griglia
                ['del', 2, 7, 2, 5, 7, 5],            # solco inciso in cima
                ['rect', 'y', 7, 0, 0, 7, 7, 'b']]}
r = pack.check_modular_block(good, expand_fn=expand_ops)
check(r['ok'], "blocco conforme: nessun problema (%s)" % (r['issues'] or 'ok'))
check(r['fillsGrid'], "tocca tutti i bordi della griglia")
check(r['bottomComplete'] >= 0.95, "faccia inferiore piena al %d%%" % int(r['bottomComplete'] * 100))
check(all(v >= 0.8 for v in r['faces'].values()), "facce laterali complete: %s" % r['faces'])

print("=== 5. verifica modularita': blocco NON conforme (aria intorno) ===")
bad = {'metadata': {'grid_size': [16, 16, 16]}, 'palette': {'a': '#808080'},
       'ops': [['fill', 4, 2, 4, 11, 9, 11, 'a']]}
r2 = pack.check_modular_block(bad, expand_fn=expand_ops)
check(not r2['ok'], "blocco con aria intorno segnalato come NON conforme")
check(not r2['fillsGrid'], "rilevato che non arriva ai bordi")
check(len(r2['issues']) >= 2, "%d problemi descritti in italiano" % len(r2['issues']))
check(all(isinstance(i, str) and i for i in r2['issues']), "messaggi non vuoti")

print("=== 6. blocco cavo: base piena ma sommita' aperta ===")
hollow = {'metadata': {'grid_size': [8, 8, 8]}, 'palette': {'a': '#808080'},
          'ops': [['fill', 0, 0, 0, 7, 7, 7, 'a'], ['del', 1, 4, 1, 6, 7, 6]]}
r3 = pack.check_modular_block(hollow, expand_fn=expand_ops)
check(r3['fillsGrid'], "blocco cavo riempie comunque la griglia")
check(r3['bottomComplete'] == 1.0, "base ancora piena al 100%")

print("=== 7. casi degeneri: non deve mai sollevare ===")
for bad_in in ({}, None, {'metadata': {}}, {'metadata': {'grid_size': 'x'}},
               {'metadata': {'grid_size': [8, 8, 8]}}, 'stringa'):
    rr = pack.check_modular_block(bad_in if isinstance(bad_in, dict) else {}, expand_fn=expand_ops)
    check(isinstance(rr, dict) and 'issues' in rr, "input degenere gestito: %.24s" % str(bad_in))

print("=== 8. il worker in modalita' modulare NON ricentra il blocco ===")
# L'ancoraggio sposterebbe il blocco via dai bordi, rompendo lo snap.
gen = lambda p, m, g: {'metadata': {'grid_size': [8, 8, 8]},
                       'palette': {'a': '#8899AA'},
                       'ops': [['fill', 0, 0, 0, 7, 7, 7, 'a']]}
mgr = pack.PackManager(gen)
run = mgr.create_run(['Blocco pietra'], 1,
                     options={'grid_size': '8x8x8', 'modular': True,
                              'expand_fn': expand_ops})
for _ in range(200):
    if run.status == 'done':
        break
    time.sleep(0.05)
check(run.counts()['done'] == 1, "job completato")
job = run.jobs[0]
b = pack.model_bounds(job.result)
check(b == (0, 0, 0, 7, 7, 7), "blocco resta a filo della griglia: %s" % (b,))
check(job.modular_report is not None, "report di modularita' presente")
check(job.modular_report['ok'], "blocco riconosciuto conforme")

print("=== 9. il report viaggia nell'API di stato ===")
d = job.to_dict()
json.dumps(d)
check(d.get('modular') is not None, "campo 'modular' esposto al frontend")
check(d['modular']['ok'] is True, "esito leggibile dalla UI")

print("=== 10. senza modalita' modulare l'ancoraggio resta attivo ===")
gen2 = lambda p, m, g: {'metadata': {'grid_size': [16, 16, 16]},
                        'palette': {'a': '#8899AA'},
                        'ops': [['fill', 5, 3, 5, 9, 7, 9, 'a']]}
mgr2 = pack.PackManager(gen2)
run2 = mgr2.create_run(['Vaso'], 1, options={'grid_size': '16x16x16'})
for _ in range(200):
    if run2.status == 'done':
        break
    time.sleep(0.05)
b2 = pack.model_bounds(run2.jobs[0].result)
check(b2[1] == 0, "oggetto normale ancora appoggiato a y=0 (miny=%d)" % b2[1])
check(run2.jobs[0].modular_report is None, "nessun report modulare fuori dalla modalita'")

print("\nTUTTI I TEST MODULARI PASSATI")
