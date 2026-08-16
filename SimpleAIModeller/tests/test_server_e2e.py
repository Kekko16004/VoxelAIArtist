"""End-to-end degli endpoint con AI FINTA: piano -> build -> audit -> patch.

Nessuna rete, nessun cookie, nessuna quota: `main.ai_answer_text_retrying` viene
sostituita da una funzione che riconosce quale prompt sta ricevendo e risponde di
conseguenza. E' il punto di sostituzione giusto perche' gli handler la risolvono
dai globali del modulo a ogni chiamata.
"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.environ.setdefault("VOXELAI_PROVIDERS_DIR", tempfile.mkdtemp(prefix="sam_e2e_"))
sys.path.insert(0, ROOT)

import main as sam  # noqa: E402

pass_n = fail_n = 0


def ok(c, m):
    global pass_n, fail_n
    if c:
        pass_n += 1
        print("  OK  " + m)
    else:
        fail_n += 1
        print("  FAIL " + m)


FAKE_PLAN = {
    "asset": "spada a una mano",
    "axis": "y",
    "total": [0.115, 1.020, 0.035],
    "chain": [
        {"n": "pomolo", "from": 0.0, "to": 0.055, "w": 0.048, "d": 0.048},
        {"n": "impugnatura", "from": 0.055, "to": 0.230, "w": 0.034, "d": 0.028},
        {"n": "guardia", "from": 0.230, "to": 0.268, "w": 0.115, "d": 0.026},
        {"n": "lama", "from": 0.268, "to": 0.900, "w": 0.048, "d": 0.010},
        {"n": "punta", "from": 0.900, "to": 1.020, "w": 0.048, "d": 0.010},
    ],
    "extras": [],
    "materials": [{"n": "acciaio", "col": "#B9C0C8",
                   "on": ["pomolo", "impugnatura", "guardia", "lama", "punta"]}],
}

FAKE_SPEC = {
    "id": "spada", "cat": "prop", "style": "lowpoly", "detail": 3, "ground": True,
    "params": {"lama_a": 0.268, "lama_b": 0.900, "lama_w": 0.048, "lama_d": 0.010},
    "mats": {"acciaio": {"col": "#B9C0C8", "rough": 0.35, "metal": 0.8}},
    "nodes": [
        {"n": "lama", "p": "box", "s": ["lama_w", "lama_b-lama_a", "lama_d"],
         "at": [0, "(lama_a+lama_b)/2", 0], "mat": "acciaio"},
        {"n": "punta", "p": "pyr", "s": ["lama_w", 0.12, "lama_d"],
         "at": [0, 0.96, 0], "mat": "acciaio"},
    ],
}

FAKE_PATCH = {"patch": [["set", "params.lama_b", 0.95],
                        ["set", "nodes.punta.at", [0, 1.01, 0]]]}

calls = {"plan": 0, "asset": 0, "patch": 0, "critique": 0}


def fake_ai(prompt, model=None, sleep=None, provider=None, images=None):
    text = str(prompt)
    if "ARCHITETTO" in text or "DISTINTA DI MISURE" in text:
        calls["plan"] += 1
        return "```json\n" + json.dumps(FAKE_PLAN) + "\n```"
    if "CORRETTORE" in text or "patch" in text.lower() and "DIFETTI" in text:
        calls["patch"] += 1
        return "```json\n" + json.dumps(FAKE_PATCH) + "\n```"
    if "CRITICO" in text:
        calls["critique"] += 1
        return '```json\n{"verdict":"pass","score":88,"defects":[]}\n```'
    calls["asset"] += 1
    return "```json\n" + json.dumps(FAKE_SPEC) + "\n```"


sam.ai_answer_text_retrying = fake_ai


def post(base, path, body):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + path, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def main():
    t = threading.Thread(target=sam.start_server, daemon=True)
    t.start()
    while sam.PORT == 0:
        time.sleep(0.05)
    base = "http://127.0.0.1:%d" % sam.PORT

    print("[1] generate chiama PRIMA il piano")
    code, data = post(base, "/api/asset/generate", {"prompt": "spada", "cat": "prop"})
    ok(code == 200, "200 (%s)" % code)
    ok(calls["plan"] == 1, "una chiamata al piano")
    ok(calls["asset"] == 1, "una chiamata alla costruzione")
    ok(data.get("plan") and data["plan"].get("chain"), "piano nella risposta")
    ok(abs(data["plan"]["axisLength"] - 1.020) < 1e-6, "lunghezza del piano")

    spec = data["spec"]
    print("[2] ingombro e params vengono dal piano")
    ok(abs(spec["size"][1] - 1.020) < 1e-6,
       "size Y dal piano (%.4f)" % spec["size"][1])
    ok("punta_a" in spec["params"] and "guardia_w" in spec["params"],
       "params del piano iniettati")
    ok(any(x["code"] == "planParamsInjected" for x in data["warnings"]),
       "iniezione segnalata")

    print("[3] audit contro misure sbagliate")
    measured = {
        "total": [0.115, 1.020, 0.035],
        "parts": {
            "lama": {"min": [0, 0.268, 0], "max": [0, 0.900, 0],
                     "size": [0.048, 0.632, 0.010]},
            # punta enorme e in fondo: e' il difetto reale visto in GUI
            "punta": {"min": [0, 0.0, 0], "max": [0, 0.45, 0],
                      "size": [0.048, 0.45, 0.010]},
        },
    }
    code, audit = post(base, "/api/asset/audit",
                       {"plan": data["plan"], "measured": measured})
    ok(code == 200, "audit 200")
    codes = [d["code"] for d in audit["defects"]]
    ok("planPartLength" in codes, "punta fuori lunghezza")
    ok("planPartPosition" in codes, "punta fuori posizione")
    ok("planPartMissing" in codes, "pezzi del piano mancanti")
    ok(audit["verdict"] == "fail", "verdetto fail")

    print("[4] audit con misure giuste tace")
    good = {"total": [0.115, 1.020, 0.035], "parts": {}}
    for s in data["plan"]["chain"]:
        good["parts"][s["n"]] = {
            "min": [0, s["from"], 0], "max": [0, s["to"], 0],
            "size": [s["w"], s["to"] - s["from"], s["d"]],
        }
    code, audit2 = post(base, "/api/asset/audit",
                        {"plan": data["plan"], "measured": good})
    ok(audit2["defects"] == [], "zero difetti (%s)" % [d["code"] for d in audit2["defects"]])
    ok(audit2["verdict"] == "pass", "verdetto pass")

    print("[5] patch riceve il piano e applica")
    code, patched = post(base, "/api/asset/patch", {
        "spec": spec, "plan": data["plan"],
        "defects": audit["defects"],
    })
    ok(code == 200, "patch 200")
    ok(calls["patch"] == 1, "una chiamata di patch")
    ok(patched["applied"] >= 2, "op applicate (%s)" % patched["applied"])
    ok(abs(patched["spec"]["params"]["lama_b"] - 0.95) < 1e-9, "param aggiornato")
    ok(abs(patched["spec"]["size"][1] - 1.020) < 1e-6, "size resta quello del piano")

    print("[6] patch pronta non chiama l'AI")
    before = calls["patch"]
    code, p2 = post(base, "/api/asset/patch", {
        "spec": spec, "patch": [["set", "params.lama_b", 0.8]],
    })
    ok(code == 200 and calls["patch"] == before, "nessuna chiamata AI")
    ok(abs(p2["spec"]["params"]["lama_b"] - 0.8) < 1e-9, "applicata localmente")

    print("[7] endpoint del solo piano")
    code, only = post(base, "/api/asset/plan", {"prompt": "spada"})
    ok(code == 200 and only.get("plan"), "plan 200")
    ok("CATENA" in only.get("text", ""), "testo tabellare")
    ok(only["params"].get("lama_a") == 0.268, "params esposti")

    print("[8] generate senza piano se disattivato")
    before_plan = calls["plan"]
    code, nop = post(base, "/api/asset/generate",
                     {"prompt": "spada", "planFirst": False})
    ok(code == 200, "200")
    ok(calls["plan"] == before_plan, "nessuna chiamata al piano")
    ok(nop.get("plan") is None, "nessun piano in risposta")

    print("[9] audit senza piano -> 400")
    code, err = post(base, "/api/asset/audit", {"measured": good})
    ok(code == 400, "400 senza piano")

    print()
    print("PASS %d  FAIL %d" % (pass_n, fail_n))
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
