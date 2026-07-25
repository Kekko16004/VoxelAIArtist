"""
Test E2E degli endpoint /api/pack/* con il VERO ThreadingHTTPServer di main.py,
ma con Gemini sostituito da un generatore finto (nessuna rete, nessun cookie).
Verifica il contratto HTTP che il frontend consuma davvero.
"""
import os as _os
_HERE=_os.path.dirname(_os.path.abspath(__file__))
REPO_ROOT=_os.path.dirname(_HERE)
REPO_SRC=_os.path.join(REPO_ROOT,'src')
import json, os, sys, threading, time, urllib.request, urllib.error

REPO=REPO_ROOT
os.chdir(REPO)
sys.path.insert(0, os.path.join(REPO,'src'))
sys.path.insert(0, REPO)

# --- stub del modulo `gemini` PRIMA di importare main (main fa `from gemini import Gemini`) ---
import types
stub=types.ModuleType('gemini')
class _FakeResp:
    def __init__(self,t): self.text=t
class Gemini:
    def __init__(self,*a,**k): pass
    def generate_content(self, prompt):
        time.sleep(0.05)
        # risposta realistica: fenced json come quella vera
        return _FakeResp('```json\n{"metadata":{"grid_size":[48,48,48]},'
                         '"palette":{"a":"#8B4513","b":"#228B22"},'
                         '"ops":[["fill",0,0,0,10,4,10,"a"],["box",2,5,2,8,12,8,"b"]]}\n```')
stub.Gemini=Gemini
sys.modules['gemini']=stub

# PyQt non c'e' nel sandbox: main.py ha il fallback GUI_AVAILABLE=False, va bene.
import main

def req(method, path, body=None):
    url='http://127.0.0.1:%d%s'%(main.PORT,path)
    data=json.dumps(body).encode() if body is not None else None
    r=urllib.request.Request(url, data=data, method=method,
                             headers={'Content-Type':'application/json'} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

ok=lambda m: print("  OK  "+m)
def check(c,m):
    if not c: print("  FAIL "+m); sys.exit(1)
    ok(m)

th=threading.Thread(target=main.start_server, daemon=True); th.start()
for _ in range(200):
    if main.PORT: break
    time.sleep(0.05)
print("server su porta", main.PORT)

print("=== status con nessun pack ===")
s,d=req('GET','/api/pack/status')
check(s==200 and d.get('empty'), "status vuoto -> {empty:true} (no 500)")

print("=== start pack 2 oggetti x 2 varianti ===")
s,d=req('POST','/api/pack/start',{"objects":["Vaso fiori","Televisore"],"variants":2,
        "references":[],"gridSize":"48x48x48","model":"gemini-3.1-pro"})
check(s==200, "start -> 200 (ricevuto %s)"%s)
run_id=d['id']
check(d['total']==4, "4 job creati")
labels=[j['label'] for j in d['jobs']]
check(labels==['Vaso_Fiori_1','Televisore_1','Vaso_Fiori_2','Televisore_2'],
      "label+ordine interleaved: %s"%labels)

print("=== polling fino a completamento ===")
for _ in range(200):
    s,d=req('GET','/api/pack/status?runId='+run_id)
    if d.get('status')=='done': break
    time.sleep(0.2)
check(d['status']=='done', "pack completato")
check(d['counts']['done']==4, "4/4 done (counts=%s)"%d['counts'])
check(all('result' not in j for j in d['jobs']), "lo status NON contiene i modelli (payload leggero)")

print("=== result di un singolo asset ===")
jid=d['jobs'][0]['id']
s,r=req('GET','/api/pack/result?runId=%s&jobId=%s'%(run_id,jid))
check(s==200, "result -> 200")
check("model" in r, "result contiene model")
m=r['model']
check(m['metadata']['name']=='Vaso_Fiori_1', "metadata.name = label (%s)"%m['metadata']['name'])
check(m['metadata']['grid_size']==[48,48,48], "grid_size rispettata")
check(bool(m.get('ops')), "ops presenti")

print("=== result di un jobId inesistente ===")
s,r=req('GET','/api/pack/result?runId=%s&jobId=nope'%run_id)
check(s==404, "jobId ignoto -> 404 (ricevuto %s)"%s)
s,r=req('GET','/api/pack/result?runId=%s'%run_id)
check(s==400, "jobId mancante -> 400")

print("=== /api/pack/all ===")
s,r=req('GET','/api/pack/all?runId='+run_id)
check(s==200 and r['count']==4, "all -> 4 asset")
check(all(a['model'] and a['label'] for a in r['assets']), "ogni asset ha label+model")

print("=== validazione input ===")
for body,why in (({"objects":[],"variants":1},"nessun oggetto"),
                 ({"objects":["A"]*61,"variants":1},"troppi oggetti"),
                 ({"objects":["A"]*20,"variants":10},"troppi job")):
    s,r=req('POST','/api/pack/start',body)
    check(s==400 and 'error' in r, "%s -> 400 con messaggio"%why)

print("=== cancel di un pack inesistente ===")
s,r=req('POST','/api/pack/cancel',{"runId":"inesistente"})
check(s==404, "cancel su id ignoto -> 404")

print("=== /api/generate ancora funzionante (nessuna regressione) ===")
s,r=req('POST','/api/generate',{"prompt":"un albero","gridSize":"32x32x32","mode":"generate"})
check(s==200, "generate -> 200")
check(bool(r.get('voxels') or r.get('ops')), "generate ritorna un modello")

print("\nTUTTI I TEST E2E PASSATI")
