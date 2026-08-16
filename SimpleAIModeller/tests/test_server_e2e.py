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

calls = {"plan": 0, "asset": 0, "patch": 0, "critique": 0, "part": 0}
parts_seen = []


def _fence(obj):
    """Blocco ```json ... ``` intorno a un oggetto."""
    return "```json" + chr(10) + json.dumps(obj) + chr(10) + "```"


def fake_ai(prompt, model=None, sleep=None, provider=None, images=None):
    text = str(prompt)
    if "MODELLATORE 3D" in text or "PEZZO DA COSTRUIRE" in text:
        calls["part"] += 1
        # Si estrae il nome del pezzo dal compito: la finta AI deve rispondere
        # con i nodi di QUEL pezzo, altrimenti il test non prova niente.
        import re as _re
        m = _re.search(r"PEZZO DA COSTRUIRE: (\S+)", text)
        name = m.group(1) if m else "pezzo"
        parts_seen.append(name)
        body = {"params": {name + "_sp": 0.003},
                "nodes": [
                    {"n": name + "_corpo", "p": "cyl", "axis": "y",
                     "r": name + "_w/2", "len": name + "_b-" + name + "_a",
                     "at": [0, "(" + name + "_a+" + name + "_b)/2", 0],
                     "mat": "acciaio"},
                    {"n": name + "_collare", "p": "torus",
                     "r": name + "_w/2", "r2": name + "_sp",
                     "at": [0, name + "_a", 0], "mat": "acciaio"},
                ]}
        return _fence(body)
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

    print("[10] i compiti si derivano dal piano, senza chiamare l'AI")
    before_ai = sum(calls.values())
    code, td = post(base, "/api/asset/tasks", {"plan": data["plan"]})
    ok(code == 200, "tasks 200")
    ok(td["count"] == 5, "cinque compiti come i segmenti (%s)" % td["count"])
    ok(sum(calls.values()) == before_ai, "nessuna chiamata AI per decomporre")
    names = [t["name"] for t in td["tasks"]]
    ok(names == ["pomolo", "impugnatura", "guardia", "lama", "punta"],
       "compiti nell'ordine della catena: %s" % names)
    t1 = td["tasks"][1]
    ok(t1["prev"]["n"] == "pomolo" and t1["next"]["n"] == "guardia",
       "il compito conosce i vicini")
    ok(abs(t1["prev"]["at"] - 0.055) < 1e-9,
       "e la quota di confine: %s" % t1["prev"]["at"])
    ok("CATENA" in td["texts"][1] or "PEZZO DA COSTRUIRE" in td["texts"][1],
       "il testo del compito e' pronto per il prompt")

    print("[11] un pezzo per volta")
    code, p0 = post(base, "/api/asset/part",
                    {"plan": data["plan"], "index": 3, "prompt": "spada",
                     "detail": 3})
    ok(code == 200, "part 200")
    ok(calls["part"] == 1, "una chiamata per un pezzo")
    ok(parts_seen[-1] == "lama", "il prompt conteneva IL pezzo giusto (%s)" % parts_seen[-1])
    ok(len(p0["nodes"]) == 2, "torna solo i nodi del pezzo (%d)" % len(p0["nodes"]))
    ok(all(n["n"].startswith("lama_") for n in p0["nodes"]),
       "i nodi sono prefissati col pezzo: %s" % [n["n"] for n in p0["nodes"]])
    ok("lama_a" in p0["params"] and "lama_sp" in p0["params"],
       "params del piano + quelli del pezzo")
    ok("pomolo_a" not in p0["params"],
       "NON riceve i params dei pezzi lontani (contesto stretto)")

    print("[12] indice fuori range e piano mancante")
    code, _ = post(base, "/api/asset/part", {"plan": data["plan"], "index": 99})
    ok(code == 400, "indice fuori range -> 400")
    code, _ = post(base, "/api/asset/part", {"index": 0})
    ok(code == 400, "senza piano -> 400")

    print()
    print("PASS %d  FAIL %d" % (pass_n, fail_n))
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
