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

print("=== origini: una pagina web estranea non parla con l'app ===")
def raw(method, path, headers, body=None):
    url='http://127.0.0.1:%d%s'%(main.PORT,path)
    data=json.dumps(body).encode() if body is not None else None
    h=dict(headers)
    if data: h['Content-Type']='application/json'
    r=urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)
evil={'Origin':'https://sito-malevolo.example'}
s,h=raw('POST','/api/prefs',evil,{"settings":{"x":1}})
check(s==403, "POST /api/prefs da sito esterno -> 403 (ricevuto %s)"%s)
s,h=raw('POST','/api/project/save',{'Origin':'null'},{"path":"x.voxai","data":{}})
check(s==403, "POST con Origin null -> 403 (ricevuto %s)"%s)
s,h=raw('DELETE','/api/settings/cookies',evil)
check(s==403, "DELETE cookie da sito esterno -> 403 (ricevuto %s)"%s)
# Un <img src=...> non manda Origin ma Sec-Fetch-Site si': niente Esplora risorse.
s,h=raw('GET','/api/settings/open-folder',{'Sec-Fetch-Site':'cross-site'})
check(s==403, "GET con effetti da <img> cross-site -> 403 (ricevuto %s)"%s)
s,h=raw('GET','/api/pack/status',{'Origin':'http://127.0.0.1:%d'%main.PORT})
check(s==200 and h.get('Access-Control-Allow-Origin')=='http://127.0.0.1:%d'%main.PORT,
      "pagina locale servita con la SUA origine, non * (%s %r)"%(s,h.get('Access-Control-Allow-Origin')))
s,h=raw('GET','/api/pack/status',{})
check(s==200 and h.get('Access-Control-Allow-Origin')!='*', "senza Origin: servita, niente *")
s,h=raw('GET','/ui/index.html',evil)
check(s==200, "i file statici restano liberi")

print("=== console cp1252: un'emoji non fa saltare la risposta ===")
import io
buf=io.BytesIO(); fake=io.TextIOWrapper(buf, encoding='cp1252')
keep_out=sys.stdout; sys.stdout=fake
boom=None
try:
    main._safe_console()
    try:
        print("risposta con emoji \U0001F600"); fake.flush()
    except UnicodeEncodeError as e:
        boom=e
finally:
    sys.stdout=keep_out
check(boom is None and b'?' in buf.getvalue(), "print di un'emoji su cp1252 -> '?' e niente eccezione")

print("\nTUTTI I TEST E2E PASSATI")
