"""Smoke test della coda pack + distillatore, con generatore FINTO (nessuna rete)."""
import os as _os
_HERE=_os.path.dirname(_os.path.abspath(__file__))
REPO_ROOT=_os.path.dirname(_HERE)
REPO_SRC=_os.path.join(REPO_ROOT,'src')
import json, os, sys, time, random
sys.path.insert(0, REPO_SRC)
import pack

REPO = REPO_ROOT
ok = lambda m: print("  OK  " + m)
def check(cond, msg):
    if not cond: print("  FAIL " + msg); sys.exit(1)
    ok(msg)

print("=== 1. slugify ===")
check(pack.slugify("Vaso fiori") == "Vaso_Fiori", "'Vaso fiori' -> Vaso_Fiori")
check(pack.slugify("Auricolare bluetooth") == "Auricolare_Bluetooth", "multi-word")
check(pack.slugify("  ") == "asset", "vuoto -> fallback")
check(pack.slugify('a<>:"|?*b') == "Ab", "caratteri illegali rimossi (slugify capitalizza)")
check(pack.slugify("Città d'arte") == "Città_D'arte", "accenti preservati")

print("=== 2. distill_style su esempi REALI del repo ===")
refs = []
for n in ('barrel.json','c64.json','sword.json'):
    with open(os.path.join(REPO,'examples',n), encoding='utf-8') as f:
        refs.append(json.load(f))
st = pack.distill_style(refs)
print("   ", {k:v for k,v in st.items() if k!='palette'})
print("    palette:", st['palette'])
check(st['sources'] == 3, "3 riferimenti analizzati")
check(len(st['palette']) > 0, "palette estratta (%d colori)" % len(st['palette']))
check(all(c.startswith('#') and len(c)==7 for c in st['palette']), "palette normalizzata #RRGGBB")
check(st['grid_size'] == [64,64,64], "grid_size per moda = %s" % st['grid_size'])
check(st['avg_voxels'] > 0, "avg_voxels stimato = %d" % st['avg_voxels'])
gv = st['grid_size'][0]*st['grid_size'][1]*st['grid_size'][2]
check(st['avg_voxels'] <= gv*0.5, "avg_voxels clampato al 50%% del volume griglia (%d <= %d)" % (st['avg_voxels'], gv*0.5))
check(st['density'] is not None and 0 < st['density'] <= 1, "densita' relativa = %s" % st['density'])
check(st['detail'] in ('basso','medio','alto'), "detail = %s" % st['detail'])

print("=== 3. distill_style su input SPAZZATURA (non deve mai sollevare) ===")
for bad in ([], [None], [{}], [{'ops':'nonlista'}], [{'ops':[['fill',1,2],['boh'],[]]}],
            [{'voxels':[{'color':'oops'},{'no':'color'}]}], ['stringa'], [{'ops':[['set','a']]}],
            [{'palette':{'a':'#GGGGGG'},'ops':[['fill',0,0,0,1,1,1,'a']]}]):
    r = pack.distill_style(bad)
    check(isinstance(r, dict) and 'palette' in r, "input degenere gestito: %.40s" % str(bad))

print("=== 4. build_style_contract ===")
c = pack.build_style_contract(st)
check('CONTRATTO DI STILE' in c, "header presente")
check('64x64x64' in c, "griglia nel contratto")
check(st['palette'][0] in c, "colori elencati")
empty = pack.build_style_contract({})
check('CONTRATTO DI STILE' in empty and len(empty) > 100, "contratto valido anche senza riferimenti")
ovr = pack.build_style_contract(st, grid_override=[32,32,32])
check('32x32x32' in ovr and '64x64x64' not in ovr, "grid_override vince sui riferimenti")

print("=== 5. variant_directive: le varianti sono DIVERSE fra loro ===")
ds = [pack.variant_directive("Vaso fiori", v, 5) for v in range(1,6)]
check(len(set(ds)) == 5, "5 varianti -> 5 direttive distinte")
check("variante 1" in ds[0].lower(), "variante 1 = canonica")

print("=== 6. coda: happy path (12 job) ===")
calls = []
def fake_gen(prompt, model, grid):
    calls.append(prompt)
    time.sleep(0.01)
    return {"metadata":{"grid_size":[32,32,32]},"palette":{"a":"#FF0000"},
            "ops":[["fill",0,0,0,3,3,3,"a"]]}
mgr = pack.PackManager(fake_gen)
run = mgr.create_run(["Vaso fiori","Televisore","Auricolare bluetooth"], 4,
                     references=refs, options={"model":"gemini-3.1-pro","grid_size":"32x32x32"})
check(len(run.jobs) == 12, "3 oggetti x 4 varianti = 12 job")
labels = [j.label for j in run.jobs]
check("Vaso_Fiori_1" in labels and "Vaso_Fiori_4" in labels, "label Vaso_Fiori_1..4")
check(labels[:3] == ["Vaso_Fiori_1","Televisore_1","Auricolare_Bluetooth_1"],
      "ordine interleaved: variante 1 di tutti prima")
for _ in range(400):
    if run.status == 'done': break
    time.sleep(0.05)
check(run.status == 'done', "run completato (status=%s)" % run.status)
check(run.counts()['done'] == 12, "12/12 done")
check(all(j.result['metadata']['name'] == j.label for j in run.jobs), "metadata.name = label")
check(len(calls) == 12, "generate chiamato 12 volte")
check(all('CONTRATTO DI STILE' in p for p in calls), "contratto iniettato in OGNI prompt")
check(run.eta_seconds() == 0, "ETA 0 a fine run")

print("=== 7. concorrenza serializzata (client a cookie) ===")
concurrent = {'max':0,'now':0}
import threading as th
lk = th.Lock()
def counting_gen(p,m,g):
    with lk:
        concurrent['now'] += 1; concurrent['max'] = max(concurrent['max'], concurrent['now'])
    time.sleep(0.05)
    with lk: concurrent['now'] -= 1
    return {"ops":[["set","#FFFFFF",0,0,0]]}
m2 = pack.PackManager(counting_gen)
r2 = m2.create_run(["A","B","C"], 3, options={})
for _ in range(400):
    if r2.status=='done': break
    time.sleep(0.05)
check(r2.status=='done', "run completato")
check(concurrent['max'] == 1, "concorrenza reale = 1 (max osservato %d)" % concurrent['max'])

print("=== 8. errori: no retry su errore permanente, retry su rate-limit ===")
attempts = {'n':0}
def bad_gen(p,m,g):
    attempts['n'] += 1
    raise ValueError("JSON malformato irrecuperabile")
m3 = pack.PackManager(bad_gen)
r3 = m3.create_run(["X"], 1, options={})
for _ in range(200):
    if r3.status=='done': break
    time.sleep(0.05)
check(r3.counts()['error'] == 1, "job in errore")
check(attempts['n'] == 1, "errore permanente NON ritentato (tentativi=%d)" % attempts['n'])
check('malformato' in r3.jobs[0].error, "messaggio d'errore propagato")

print("=== 9. risposta AI vuota/senza voxel -> errore, non successo silenzioso ===")
for empty_resp in (None, {}, {"metadata":{}}, "stringa", {"voxels":[]}):
    m4 = pack.PackManager(lambda p,m,g: empty_resp)
    r4 = m4.create_run(["Y"], 1, options={})
    for _ in range(100):
        if r4.status=='done': break
        time.sleep(0.02)
    check(r4.counts()['error']==1, "risposta %.20s -> errore" % str(empty_resp))

print("=== 10. ancora di stile senza riferimenti ===")
def anchor_gen(p,m,g):
    return {"metadata":{"grid_size":[48,48,48]},
            "palette":{"a":"#123456","b":"#ABCDEF"},
            "ops":[["fill",0,0,0,5,5,5,"a"],["box",0,0,0,7,7,7,"b"]]}
m5 = pack.PackManager(anchor_gen)
r5 = m5.create_run(["Vaso"], 3, references=[], options={})
for _ in range(300):
    if r5.status=='done': break
    time.sleep(0.05)
check(r5.counts()['done']==3, "3 job completati")
check(r5.anchor_style is not None, "ancora popolata dal primo successo")
check('#123456' in (r5.anchor_contract or ''), "palette dell'ancora nel contratto")

print("=== 11. limiti di sicurezza ===")
m6 = pack.PackManager(lambda p,m,g: {"ops":[["set","#FFF000",0,0,0]]})
for bad_args, why in (((["A"]*61, 1), "troppi oggetti"), (([], 1), "nessun oggetto"),
                      (([""," "], 1), "solo nomi vuoti"), ((["A"]*20, 10), "troppi job")):
    try:
        m6.create_run(*bad_args, options={}); check(False, why + " -> doveva alzare ValueError")
    except ValueError: ok(why + " rifiutato")
r7 = m6.create_run(["A"], 99, options={})
check(len(r7.jobs) == pack.MAX_VARIANTS, "varianti clampate a %d" % pack.MAX_VARIANTS)
r8 = m6.create_run(["A"], 1, options={"concurrency": 50})
check(r8.options['concurrency'] <= pack.MAX_CONCURRENCY, "concorrenza clampata")

print("=== 12. cancel + retry ===")
slow = pack.PackManager(lambda p,m,g: (time.sleep(0.3), {"ops":[["set","#FFFFFF",0,0,0]]})[1])
r9 = slow.create_run(["A","B","C","D","E"], 2, options={})
time.sleep(0.15); slow.cancel(r9.id)
for _ in range(200):
    if r9.status in ('cancelled','done'): break
    time.sleep(0.05)
check(r9.counts()['cancelled'] > 0, "job in coda annullati (%d)" % r9.counts()['cancelled'])
fail1 = {'n':0}
def flaky(p,m,g):
    fail1['n'] += 1
    if fail1['n'] <= 1: raise RuntimeError("boom permanente")
    return {"ops":[["set","#FFFFFF",1,1,1]]}
m10 = pack.PackManager(flaky)
r10 = m10.create_run(["Z"], 1, options={})
for _ in range(100):
    if r10.status=='done': break
    time.sleep(0.02)
check(r10.counts()['error']==1, "primo tentativo fallito")
m10.retry(r10.id, r10.jobs[0].id)
for _ in range(200):
    if r10.status=='done': break
    time.sleep(0.02)
check(r10.counts()['done']==1, "retry manuale recupera il job")

print("=== 13. to_dict serializzabile (contratto API) ===")
d = run.to_dict()
json.dumps(d)  # deve non sollevare
check(set(['id','status','counts','jobs','total','etaSeconds']).issubset(d.keys()), "campi API presenti")
check('result' not in d['jobs'][0], "il payload pesante NON viaggia nello status")
check('result' in run.jobs[0].to_dict(include_result=True), "result disponibile su richiesta")

print("\nTUTTI I TEST PASSATI")
