"""Piano dell'architetto: contiguita', riparazione, audit contro le misure vere."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "src"))
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), "src"))

import plan as P

pass_n = fail_n = 0


def ok(c, m):
    global pass_n, fail_n
    if c:
        pass_n += 1
        print("  OK  " + m)
    else:
        fail_n += 1
        print("  FAIL " + m)


SPADA = {
    "asset": "spada", "axis": "y",
    "total": [0.115, 1.020, 0.035],
    "chain": [
        {"n": "pomolo", "from": 0.0, "to": 0.055, "w": 0.048, "d": 0.048},
        {"n": "impugnatura", "from": 0.055, "to": 0.230, "w": 0.034, "d": 0.028},
        {"n": "guardia", "from": 0.230, "to": 0.268, "w": 0.115, "d": 0.026},
        {"n": "lama", "from": 0.268, "to": 0.900, "w": 0.048, "d": 0.010},
        {"n": "punta", "from": 0.900, "to": 1.020, "w": 0.048, "d": 0.010},
    ],
    "extras": [{"n": "sguscio", "of": "lama", "from": 0.30, "to": 0.88,
                "w": 0.014, "d": 0.004}],
    "materials": [
        {"n": "acciaio", "col": "#B9C0C8", "on": ["lama", "punta", "guardia", "sguscio"]},
        {"n": "cuoio", "col": "#4A3526", "on": ["impugnatura"]},
        {"n": "ottone", "col": "#B08B3E", "on": ["pomolo"]},
    ],
}


def perfect_measure(plan):
    """Misure che coincidono col piano: l'audit deve tacere."""
    ai = P.AXIS_INDEX[plan["axis"]]
    parts = {}
    for s in plan["chain"] + plan["extras"]:
        size = [0.0, 0.0, 0.0]
        mn = [0.0, 0.0, 0.0]
        mx = [0.0, 0.0, 0.0]
        size[ai] = s["to"] - s["from"]
        mn[ai] = s["from"]
        mx[ai] = s["to"]
        if plan["axis"] == "y":
            size[0], size[2] = s["w"], s["d"]
        elif plan["axis"] == "z":
            size[0], size[1] = s["w"], s["d"]
        else:
            size[1], size[2] = s["w"], s["d"]
        parts[s["n"]] = {"min": mn, "max": mx, "size": size}
    return {"total": list(plan["total"]), "parts": parts}


def main():
    print("[1] piano valido")
    p, w = P.normalize_plan(SPADA)
    ok(p["axis"] == "y", "asse y")
    ok(abs(p["axisLength"] - 1.020) < 1e-6, "lunghezza asse 1.020 (%.4f)" % p["axisLength"])
    ok(len(p["chain"]) == 5, "5 segmenti")
    ok(abs(p["total"][0] - 0.115) < 1e-6, "larghezza dal massimo w")
    ok(not p["repairs"], "nessuna riparazione necessaria")
    ok(not [x for x in w if x["code"] == "chainGap"], "nessun buco")

    print("[2] buco nella catena -> riparato")
    holed = {k: (v if k != "chain" else [dict(s) for s in v]) for k, v in SPADA.items()}
    holed["chain"][2]["from"] = 0.30      # buco fra impugnatura (0.230) e guardia
    holed["chain"][2]["to"] = 0.34
    p2, w2 = P.normalize_plan(holed)
    ok(any(x["code"] == "chainGap" for x in w2), "buco segnalato")
    ok(any(r.startswith("closeGap") for r in p2["repairs"]), "buco chiuso")
    for i in range(len(p2["chain"]) - 1):
        ok(abs(p2["chain"][i]["to"] - p2["chain"][i + 1]["from"]) < 1e-6,
           "contiguo %s/%s" % (p2["chain"][i]["n"], p2["chain"][i + 1]["n"]))
    # La lunghezza del pezzo spostato si conserva.
    guard = [s for s in p2["chain"] if s["n"] == "guardia"][0]
    ok(abs((guard["to"] - guard["from"]) - 0.04) < 1e-6, "lunghezza del pezzo conservata")

    print("[3] totale dichiarato incoerente -> vince la catena")
    bad = {k: v for k, v in SPADA.items()}
    bad["total"] = [0.115, 4.04, 0.035]
    p3, w3 = P.normalize_plan(bad)
    ok(any(x["code"] == "totalMismatch" for x in w3), "totalMismatch segnalato")
    ok(abs(p3["total"][1] - 1.020) < 1e-6, "totale ricalcolato dalla catena")

    print("[4] audit: misure perfette -> zero difetti")
    d = P.audit_built(p, perfect_measure(p))
    ok(d == [], "nessun difetto (got %s)" % [x["code"] for x in d])

    print("[5] audit: la punta in fondo e gigante")
    m = perfect_measure(p)
    m["parts"]["punta"] = {"min": [0, 0.0, 0], "max": [0, 0.45, 0],
                           "size": [0.048, 0.45, 0.010]}
    m["total"] = [0.115, 1.020, 0.035]
    d = P.audit_built(p, m)
    codes = [x["code"] for x in d]
    ok("planPartLength" in codes, "lunghezza sbagliata rilevata")
    ok("planPartPosition" in codes, "posizione sbagliata rilevata")
    ok(any("0.900" in x["fix"] or "0.960" in x["fix"] for x in d if x["where"] == "punta"),
       "il fix contiene il numero giusto")

    print("[6] audit: pezzo mancante e pezzo estraneo")
    m2 = perfect_measure(p)
    del m2["parts"]["guardia"]
    m2["parts"]["piramide_gigante"] = {"min": [0, 0, 0], "max": [0.3, 0.5, 0.3],
                                       "size": [0.3, 0.5, 0.3]}
    d2 = P.audit_built(p, m2)
    codes2 = [x["code"] for x in d2]
    ok("planPartMissing" in codes2, "pezzo mancante")
    ok("planExtraneousPart" in codes2, "pezzo estraneo grande")

    print("[7] audit: ingombro trasversale fuori misura")
    m3 = perfect_measure(p)
    m3["total"] = [1.13, 1.020, 0.75]
    d3 = P.audit_built(p, m3)
    ok(any(x["code"] == "planTooWide" for x in d3), "planTooWide")

    print("[8] params e testo")
    params = P.plan_params(p)
    ok(params["lama_a"] == 0.268 and params["lama_b"] == 0.9, "params lama")
    ok(params["guardia_w"] == 0.115, "params guardia_w")
    txt = P.plan_text(p)
    ok("CATENA" in txt and "lama" in txt, "tabella con la catena")
    ok("(da+a)/2" in txt, "regola di costruzione nel testo")

    print("[9] piano senza catena solleva")
    try:
        P.normalize_plan({"axis": "y", "total": [1, 1, 1]})
        ok(False, "doveva sollevare")
    except ValueError:
        ok(True, "ValueError senza catena")

    print("[10] segmenti fuori ordine si riordinano")
    shuffled = {k: (list(reversed(v)) if k == "chain" else v)
                for k, v in SPADA.items()}
    p4, _ = P.normalize_plan(shuffled)
    ok(p4["chain"][0]["n"] == "pomolo", "riordinati per from")

    print("[11] decomposizione in compiti")
    tasks = P.plan_tasks(p)
    ok(len(tasks) == len(p["chain"]), "un compito per segmento (%d)" % len(tasks))
    ok([t["name"] for t in tasks] == [s["n"] for s in p["chain"]],
       "nell'ordine della catena")
    lama = [t for t in tasks if t["name"] == "lama"][0]
    ok(any(e["n"] == "sguscio" for e in lama["extras"]),
       "l'extra va al suo ospite: %s" % [e["n"] for e in lama["extras"]])
    ok(lama["prev"]["n"] == "guardia" and lama["next"]["n"] == "punta",
       "conosce i vicini")
    ok(abs(lama["prev"]["at"] - 0.268) < 1e-9, "e la quota di confine")
    ok(lama["budget"] > tasks[0]["budget"],
       "il corpo principale ha un budget maggiore di un collarino (%d vs %d)"
       % (lama["budget"], tasks[0]["budget"]))
    ok("acciaio" in lama["suggestedMats"], "sa quale materiale e' il suo")

    print("[12] un extra senza ospite valido non si perde")
    orfano = {k: v for k, v in SPADA.items()}
    orfano["extras"] = [{"n": "vagante", "of": "inesistente", "from": 0.30,
                         "to": 0.40, "w": 0.01, "d": 0.01}]
    po, _ = P.normalize_plan(orfano)
    ts2 = P.plan_tasks(po)
    assegnati = [t["name"] for t in ts2 if any(e["n"] == "vagante" for e in t["extras"])]
    ok(len(assegnati) == 1, "assegnato per quota a un segmento: %s" % assegnati)
    ok(assegnati[0] == "lama", "al segmento che lo contiene (0.30-0.40 sta in lama)")

    print("[13] il testo del compito contiene le interfacce")
    txt = P.task_text(p, lama)
    ok("PEZZO DA COSTRUIRE: lama" in txt, "intestazione")
    ok("0.2680" in txt and "0.9000" in txt, "le sue quote")
    ok("SOTTO" in txt and "guardia" in txt, "il vicino sotto")
    ok("SOPRA" in txt and "punta" in txt, "il vicino sopra")
    ok("sguscio" in txt, "i suoi dettagli")

    print("[14] i params del compito sono STRETTI")
    tp = P.task_params(p, lama)
    ok("lama_a" in tp and "lama_w" in tp, "i suoi")
    ok("guardia_a" in tp and "punta_a" in tp, "e quelli dei vicini")
    ok("pomolo_a" not in tp, "non quelli dei pezzi lontani")
    ok("sguscio_a" in tp, "e quelli dei suoi dettagli")

    print()
    print("PASS %d  FAIL %d" % (pass_n, fail_n))
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
