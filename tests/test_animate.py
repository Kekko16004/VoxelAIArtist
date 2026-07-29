"""
Test di `normalize_anim_data` (main.py): riconduce QUALSIASI forma plausibile di
risposta AI al contratto che `buildClipFromAnimData` (ui/src/lib/15-rig.js) accetta.
Nessuna rete, nessun cookie: il modulo `gemini` e' stubbato prima di importare main.
"""
import os as _os
_HERE = _os.path.dirname(_os.path.abspath(__file__))
REPO_ROOT = _os.path.dirname(_HERE)
import json, os, sys, types, threading, time, urllib.request, urllib.error

os.chdir(REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, 'src'))
sys.path.insert(0, REPO_ROOT)

stub = types.ModuleType('gemini')
class _FakeResp:
    def __init__(self, t): self.text = t
# Risposta (o eccezione) che il finto client restituira' alla prossima chiamata.
NEXT_ANSWER = ['{}']
class Gemini:
    def __init__(self, *a, **k): pass
    def generate_content(self, prompt):
        v = NEXT_ANSWER[0]
        if isinstance(v, Exception):
            raise v
        return _FakeResp(v)
stub.Gemini = Gemini
sys.modules['gemini'] = stub

import main

ok = lambda m: print("  OK  " + m)
fails = []
def check(cond, msg):
    if not cond:
        print("  FAIL " + msg); fails.append(msg)
    else:
        ok(msg)

BONES = ["hips", "spine", "chest", "upperArm_R", "upperArm_L", "forearm_R",
         "forearm_L", "hand_R", "hand_L", "upperLeg_R", "upperLeg_L",
         "lowerLeg_R", "lowerLeg_L", "foot_R", "foot_L"]

def norm(data, bones=BONES):
    return main.normalize_anim_data(data, bones)

def shape_ok(res):
    """Il contratto minimo preteso dal client."""
    if not isinstance(res, dict): return False
    if not isinstance(res.get("name"), str) or not res["name"]: return False
    if not isinstance(res.get("duration"), (int, float)) or res["duration"] <= 0: return False
    if not isinstance(res.get("loop"), bool): return False
    if not isinstance(res.get("tracks"), list): return False
    for tr in res["tracks"]:
        if not isinstance(tr, dict) or not isinstance(tr.get("bone"), str): return False
        keys = tr.get("keys")
        if not isinstance(keys, list) or len(keys) < 2: return False
        ts = []
        for k in keys:
            if not isinstance(k, dict): return False
            if not isinstance(k.get("t"), (int, float)): return False
            if k["t"] < 0 or k["t"] > res["duration"] + 1e-6: return False
            if "rot" not in k and "pos" not in k: return False
            for field in ("rot", "pos"):
                if field in k:
                    v = k[field]
                    if not isinstance(v, list) or len(v) != 3: return False
                    if not all(isinstance(c, float) for c in v): return False
            ts.append(k["t"])
        if ts != sorted(ts): return False
    return True

def bones_of(res):
    return [t["bone"] for t in res["tracks"]]

print("=== 1. forma canonica: passa intatta ===")
canon = {"name": "Saluto", "duration": 2.0, "loop": True, "tracks": [
    {"bone": "upperArm_R", "keys": [{"t": 0.0, "rot": [0, 0, 0]},
                                    {"t": 1.0, "rot": [0, 0, -120]},
                                    {"t": 2.0, "rot": [0, 0, 0]}]}]}
r = norm(canon)
check(shape_ok(r), "forma canonica valida")
check(r["name"] == "Saluto" and r["duration"] == 2.0 and r["loop"] is True,
      "metadati preservati (name/duration/loop)")
check(bones_of(r) == ["upperArm_R"] and len(r["tracks"][0]["keys"]) == 3,
      "track e keyframe preservati")
check("unknownBones" not in r and "warnings" not in r,
      "nessuna diagnostica su input pulito")

print("=== 2. tracks come OGGETTO bone -> keys ===")
r = norm({"duration": 1.0, "tracks": {
    "hips": [{"t": 0, "pos": [0, 0, 0]}, {"t": 1, "pos": [0, 2, 0]}],
    "spine": {"keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [10, 0, 0]}]}}})
check(shape_ok(r), "tracks-oggetto -> forma valida")
check(sorted(bones_of(r)) == ["hips", "spine"], "entrambe le ossa recuperate")

print("=== 3. sinonimi: keyframes/rotation/time ===")
r = norm({"name": "Camminata", "length": 1.2, "looping": "yes", "channels": [
    {"boneName": "upperLeg_L", "keyframes": [
        {"time": 0, "rotation": [0, 0, 0]},
        {"time": 0.6, "rotation": [30, 0, 0]},
        {"time": 1.2, "rotation": [0, 0, 0]}]}]})
check(shape_ok(r), "sinonimi -> forma valida")
check(bones_of(r) == ["upperLeg_L"], "osso risolto da 'boneName'")
check(r["duration"] == 1.2 and r["loop"] is True, "'length'/'looping' interpretati")
check([k["t"] for k in r["tracks"][0]["keys"]] == [0.0, 0.6, 1.2], "'time' -> 't'")

print("=== 4. angoli e tempi come STRINGHE ===")
r = norm({"duration": "2.5s", "tracks": [
    {"bone": "forearm_R", "keys": [{"t": "0", "rot": ["0", "0", "-45"]},
                                   {"t": "2.5", "rot": "0, 0, 0"}]}]})
check(shape_ok(r), "stringhe -> forma valida")
check(r["duration"] == 2.5, "durata da stringa '2.5s'")
check(r["tracks"][0]["keys"][0]["rot"] == [0.0, 0.0, -45.0],
      "rot da stringhe numeriche")
check(r["tracks"][0]["keys"][1]["rot"] == [0.0, 0.0, 0.0],
      "rot da stringa unica '0, 0, 0'")

print("=== 5. nesting: bones/animation/animations ===")
r = norm({"animation": {"name": "Idle", "duration": 1.0, "bones": [
    {"bone": "chest", "keys": [{"t": 0, "rot": [0, 0, 0]},
                               {"t": 1, "rot": [2, 0, 0]}]}]}})
check(shape_ok(r) and bones_of(r) == ["chest"], "clip annidata in 'animation'")
check(r["name"] == "Idle", "metadati letti dal nodo annidato")

print("=== 6. array al TOP LEVEL (nessun wrapper) ===")
r = norm([{"bone": "hand_L", "keys": [{"t": 0, "rot": [0, 0, 0]},
                                      {"t": 1, "rot": [0, 90, 0]}]}])
check(shape_ok(r) and bones_of(r) == ["hand_L"], "array top-level accettato")
check(r["duration"] >= 1.0, "durata dedotta dai keyframe")

print("=== 7. singolo track non incapsulato ===")
r = norm({"bone": "foot_R", "keys": [{"t": 0, "rot": [0, 0, 0]},
                                     {"t": 0.5, "rot": [-20, 0, 0]}]})
check(shape_ok(r) and bones_of(r) == ["foot_R"], "track singolo accettato")

print("=== 8. rot come componenti sciolte / dict {x,y,z} ===")
r = norm({"duration": 1.0, "tracks": [
    {"bone": "spine", "keys": [{"t": 0, "rx": 0, "ry": 0, "rz": 0},
                               {"t": 1, "rot": {"x": 5, "y": 0, "z": 0}}]}]})
check(shape_ok(r), "componenti sciolte -> forma valida")
check(r["tracks"][0]["keys"][1]["rot"] == [5.0, 0.0, 0.0], "rot da dict {x,y,z}")

print("=== 9. nomi ossa con case/spazi/trattini diversi ===")
r = norm({"duration": 1.0, "tracks": [
    {"bone": "Upper Arm-R", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, 0, -30]}]},
    {"bone": "UPPERLEG_l", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [20, 0, 0]}]},
    {"bone": "upper arm left", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 30]}]}]})
check(shape_ok(r), "nomi tolleranti -> forma valida")
check(bones_of(r) == ["upperArm_R", "upperLeg_L", "upperArm_L"],
      "nomi rimappati su quelli REALI dello scheletro")

print("=== 10. ossa inventate scartate, le valide sopravvivono ===")
r = norm({"duration": 1.0, "tracks": [
    {"bone": "tail_01", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 30]}]},
    {"bone": "hips", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, 5, 0]}]}]})
check(shape_ok(r) and bones_of(r) == ["hips"], "osso sconosciuto scartato")
check(r.get("unknownBones") == ["tail_01"], "unknownBones riporta il nome inventato")

print("=== 11. nessun track valido -> tracks vuota (il caller risponde 400) ===")
r = norm({"duration": 1.0, "tracks": [
    {"bone": "wing_R", "keys": [{"t": 0, "rot": [0, 0, 0]}]},
    {"bone": "antenna", "keys": [{"t": 1, "rot": [0, 0, 5]}]}]})
check(r["tracks"] == [], "tracks vuota con sole ossa inventate")
check(sorted(r.get("unknownBones", [])) == ["antenna", "wing_R"],
      "tutti i nomi inventati elencati")
check(isinstance(r.get("duration"), float) and isinstance(r.get("name"), str),
      "forma comunque completa (nessun KeyError lato caller)")
r = norm({"garbage": True, "foo": [1, 2, 3]})
check(r["tracks"] == [] and isinstance(r.get("duration"), float),
      "input senza nulla di riconoscibile -> tracks vuota")

print("=== 12. un solo keyframe -> duplicato a t=0 e t=duration ===")
r = norm({"duration": 1.5, "tracks": [
    {"bone": "hand_R", "keys": [{"t": 0.7, "rot": [0, 0, -90]}]}]})
check(shape_ok(r), "keyframe singolo -> forma valida")
ks = r["tracks"][0]["keys"]
check(len(ks) == 2 and ks[0]["t"] == 0.0 and ks[1]["t"] == 1.5,
      "keyframe duplicato agli estremi")
check(ks[0]["rot"] == ks[1]["rot"] == [0.0, 0.0, -90.0], "posa preservata")
check(any("duplicato" in w for w in r.get("warnings", [])), "warning emesso")

print("=== 13. t non numerici / non ordinati / oltre duration ===")
r = norm({"duration": 1.0, "tracks": [
    {"bone": "spine", "keys": [{"t": 2.0, "rot": [10, 0, 0]},
                               {"t": 0.0, "rot": [0, 0, 0]},
                               {"t": -5, "rot": [1, 0, 0]},
                               {"t": "mezzo", "rot": [2, 0, 0]}]}]})
check(shape_ok(r), "tempi sporchi -> forma valida")
ts = [k["t"] for k in r["tracks"][0]["keys"]]
check(ts == sorted(ts), "keyframe ordinati per t")
check(all(t >= 0 for t in ts), "nessun t negativo")
check(r["duration"] >= 2.0, "duration estesa per non perdere keyframe")
check(all(t <= r["duration"] + 1e-9 for t in ts), "nessun t oltre duration")

print("=== 14. keys come dict tempo -> keyframe, e liste [t,x,y,z] ===")
r = norm({"duration": 1.0, "tracks": [
    {"bone": "chest", "keys": {"0": {"rot": [0, 0, 0]}, "1.0": {"rot": [4, 0, 0]}}},
    {"bone": "foot_L", "keys": [[0, 0, 0, 0], [1.0, -15, 0, 0]]}]})
check(shape_ok(r), "keys-dict e keys-lista -> forma valida")
check(sorted(bones_of(r)) == ["chest", "foot_L"], "entrambi i track recuperati")
check(r["tracks"][1]["keys"][1]["rot"] == [-15.0, 0.0, 0.0], "[t,x,y,z] interpretato")

print("=== 15. rot e pos sullo stesso istante vengono fusi ===")
r = norm({"duration": 1.0, "tracks": [
    {"bone": "hips", "keys": [{"t": 0, "rot": [0, 0, 0], "pos": [0, 0, 0]},
                              {"t": 1, "rot": [0, 5, 0], "position": [0, 1, 0]}]}]})
check(shape_ok(r), "rot+pos -> forma valida")
k = r["tracks"][0]["keys"][1]
check(k.get("rot") == [0.0, 5.0, 0.0] and k.get("pos") == [0.0, 1.0, 0.0],
      "rot e pos coesistono nello stesso keyframe")

print("=== 16. duration assurda / mancante -> clamp ===")
r = norm({"tracks": [{"bone": "spine", "keys": [{"t": 0, "rot": [0, 0, 0]},
                                                {"t": 0.5, "rot": [3, 0, 0]}]}]})
check(shape_ok(r) and r["duration"] >= 0.5, "duration assente -> dedotta")
r = norm({"duration": 9999, "tracks": [{"bone": "spine", "keys": [
    {"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [3, 0, 0]}]}]})
check(r["duration"] == main.ANIM_MAX_DURATION, "duration eccessiva clampata al max")
r = norm({"duration": -3, "tracks": [{"bone": "spine", "keys": [
    {"t": 0, "rot": [0, 0, 0]}, {"t": 0.4, "rot": [3, 0, 0]}]}]})
check(r["duration"] >= main.ANIM_MIN_DURATION, "duration negativa -> minimo/dedotta")

print("=== 17. senza elenco ossa: nessun filtro, ma forma valida ===")
r = main.normalize_anim_data({"duration": 1.0, "tracks": [
    {"bone": "qualsiasi_osso", "keys": [{"t": 0, "rot": [0, 0, 0]},
                                        {"t": 1, "rot": [0, 0, 5]}]}]}, [])
check(shape_ok(r) and bones_of(r) == ["qualsiasi_osso"],
      "senza scheletro il nome passa cosi' com'e'")

print("=== 18. robustezza: input non-dict / valori nulli ===")
for bad in (None, [], "testo libero", 42, {"tracks": None}, {"tracks": [None, 5]},
            {"tracks": [{"bone": "hips"}]}, {"tracks": [{"keys": []}]}):
    try:
        r = norm(bad)
    except Exception as e:
        check(False, "input %r ha sollevato %s" % (bad, e)); continue
    check(isinstance(r, dict) and isinstance(r.get("tracks"), list)
          and isinstance(r.get("duration"), float) and isinstance(r.get("name"), str),
          "input %r gestito senza eccezioni" % (bad,))

print("=== 19. il risultato e' JSON-serializzabile ===")
r = norm(canon)
try:
    json.dumps(r)
    ok("normalize_anim_data -> JSON serializzabile")
except Exception as e:
    check(False, "risultato non serializzabile: %s" % e)

print("=== 20. prompt: fallback inline coerente con il file su disco ===")
p = main.build_anim_prompt("saluta con la mano", BONES)
check("[INSERISCI QUI LE OSSA]" not in p and "[INSERISCI QUI LA RICHIESTA]" not in p,
      "placeholder sostituiti")
check("upperArm_R" in p and "saluta con la mano" in p, "ossa e richiesta iniettate")
for token in ("SOLO", "tracks", "rot", "keys"):
    check(token in p and token in main.ANIM_PROMPT_FALLBACK,
          "vincolo '%s' presente sia nel file che nel fallback" % token)
try:
    main.ANIM_PROMPT_FALLBACK.encode('latin-1')
    ok("fallback inline codificabile in latin-1")
except Exception as e:
    check(False, "fallback non latin-1: %s" % e)

print("=== 21. HTTP /api/animate sul vero server (nessuna rete) ===")
# Il bug segnalato si vede SOLO passando dall'endpoint: qui si verifica il
# cablaggio completo (parsing risposta -> normalizzazione -> codici HTTP).
# Budget di retry a 0: senza questo un errore transitorio farebbe dormire 20s.
main.INTERACTIVE_RETRY_BUDGET_SECONDS = 0

def _req(body, path="/api/animate", raw_body=None):
    url = 'http://127.0.0.1:%d%s' % (main.PORT, path)
    data = raw_body if raw_body is not None else json.dumps(body).encode()
    rq = urllib.request.Request(url, data=data, method='POST',
                                headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(rq, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}

threading.Thread(target=main.start_server, daemon=True).start()
for _ in range(200):
    if main.PORT: break
    time.sleep(0.05)
check(bool(main.PORT), "server di test avviato (porta %s)" % main.PORT)

CLIP = ('{"name":"Saluto","duration":2.0,"loop":true,"tracks":[{"bone":"upperArm_R",'
        '"keys":[{"t":0,"rot":[0,0,0]},{"t":1,"rot":[0,0,-120]},{"t":2,"rot":[0,0,0]}]}]}')

NEXT_ANSWER[0] = "```json\n" + CLIP + "\n```"
s, d = _req({"prompt": "saluta", "bones": BONES, "model": "gemini-3-pro"})
check(s == 200 and shape_ok(d), "risposta fenced ```json -> 200 e forma valida")
check(bones_of(d) == ["upperArm_R"], "track consegnato al client")

# Il caso che rompeva davvero: prosa con delle graffe PRIMA del JSON.
NEXT_ANSWER[0] = ("Certo! Uso la struttura {name, duration, tracks}. Ecco la clip:\n"
                  + CLIP + "\nSpero sia utile!")
s, d = _req({"prompt": "saluta", "bones": BONES})
check(s == 200 and shape_ok(d), "prosa prima/dopo il JSON -> 200 (era il crash)")

# Forma deviante (tracks come oggetto + sinonimi): il client ne accetta una sola.
NEXT_ANSWER[0] = ('{"duration":1.0,"tracks":{"hips":{"keyframes":['
                  '{"time":0,"rotation":[0,0,0]},{"time":1,"rotation":[0,5,0]}]}}}')
s, d = _req({"prompt": "respira", "bones": BONES})
check(s == 200 and shape_ok(d) and bones_of(d) == ["hips"],
      "forma deviante normalizzata -> 200")

NEXT_ANSWER[0] = "Mi dispiace, non posso generare animazioni."
s, d = _req({"prompt": "saluta", "bones": BONES})
check(s == 400 and "JSON" in d.get("error", ""), "risposta senza JSON -> 400 parlante")
check(d.get("rawPreview", "").startswith("Mi dispiace"), "rawPreview per diagnosi")
# `code` e `detail` sono il contratto che permette alla UI di scrivere il
# messaggio nella lingua dell'utente invece di mostrare `error` in italiano.
check(d.get("code") == "badJson", "il 400 di formato porta code=badJson")
check(bool(d.get("detail")), "detail contiene il messaggio del parser")

NEXT_ANSWER[0] = ('{"duration":1.0,"tracks":[{"bone":"tail_01","keys":['
                  '{"t":0,"rot":[0,0,0]},{"t":1,"rot":[0,0,30]}]}]}')
s, d = _req({"prompt": "muovi la coda", "bones": BONES})
check(s == 400 and d.get("unknownBones") == ["tail_01"],
      "solo ossa inventate -> 400 con l'elenco")
check(d.get("availableBones") == BONES, "400 elenca anche le ossa disponibili")
check(d.get("code") == "noUsableTracks", "il 400 senza track porta code=noUsableTracks")
# Le liste NON vanno anche concatenate dentro `error`: la UI le impagina da
# sola (tradotte), e prima l'alert le mostrava due volte.
check("tail_01" not in d.get("error", ""),
      "error e' la sola frase-titolo, senza le liste duplicate")

NEXT_ANSWER[0] = RuntimeError("Failed to fetch SNlM0e: cookies expired")
s, d = _req({"prompt": "saluta", "bones": BONES})
check(s == 401 and d.get("needsCookies") is True, "cookie scaduti -> 401 needsCookies")
check("cookie" in d.get("error", "").lower(), "il 401 spiega cosa fare")

NEXT_ANSWER[0] = RuntimeError("429 Too Many Requests")
s, d = _req({"prompt": "saluta", "bones": BONES})
check(s == 503 and d.get("retryable") is True, "rate limit -> 503 retryable")

NEXT_ANSWER[0] = CLIP
s, d = _req({"prompt": "   ", "bones": BONES})
check(s == 400 and "error" in d, "prompt vuoto -> 400 (nessuna chiamata AI)")
s, d = _req(None, raw_body=b'{non json}')
check(s == 400 and "error" in d, "body non JSON -> 400, non 500")

# Nessuna credenziale nei messaggi restituiti al client.
for probe in ("secure_1psid", "__Secure", "cookies.json"):
    check(probe not in json.dumps(d), "nessuna credenziale nella risposta (%s)" % probe)

if fails:
    print("\n%d CHECK FALLITI" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("\nTUTTI I CHECK OK")

