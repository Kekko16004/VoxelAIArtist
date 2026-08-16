"""Piano dell'architetto: distinta di misure verificata aritmeticamente.

Perche' esiste
--------------
Il difetto piu' costoso della generazione non e' estetico, e' ARITMETICO: il
modello piazza i pezzi indovinando dove sta il loro centro, dichiara un ingombro
che non c'entra con cio' che costruisce, e il risultato ha una punta enorme in
fondo e una guardia larga come la lama. Nessun prompt piu' lungo lo risolve,
perche' il problema non e' che non sa cos'e' una spada: e' che non fa la somma.

La cura e' cambiare la RAPPRESENTAZIONE. Un oggetto viene descritto prima come
una CATENA di segmenti contigui lungo il suo asse principale (`from`/`to` in
metri). Da quella catena:

  - il centro di un pezzo e' (from+to)/2 e la lunghezza e' (to-from): non c'e'
    piu' niente da indovinare, e sono due numeri che si CONTROLLANO;
  - la contiguita' (`chain[i].to == chain[i+1].from`) e la somma totale sono
    verificabili QUI, prima di costruire, e un piano che non torna si aggiusta
    da solo (`repair_chain`) invece di diventare un modello sbagliato;
  - dopo la costruzione la mesh si CONFRONTA col piano pezzo per pezzo
    (`audit_built`), e ogni scostamento diventa un'istruzione di correzione con
    i numeri dentro ("lama misura 0.28 lungo Y ma il piano dice 0.63").

L'ingombro finale NON e' un valore dichiarato a priori: e' quello misurato sulla
mesh. Il piano dice quanto DEVE venire, la misura dice quanto E' venuto, e la
differenza e' un difetto — non un'opinione.
"""

import json
import re

AXES = ("x", "y", "z")
AXIS_INDEX = {"x": 0, "y": 1, "z": 2}

# Tolleranze dell'audit. Sono due perche' un errore di 2 mm su una lama di 60 cm
# e' rumore di arrotondamento, mentre 2 mm su uno spessore di 8 mm e' il 25%.
TOL_ABS = 0.006          # 6 mm
TOL_REL = 0.18           # 18%

_NAME_RE = re.compile(r"[^A-Za-z0-9_]+")

MAX_CHAIN = 16
MAX_EXTRAS = 24


def _slug(v, fallback="p"):
    s = _NAME_RE.sub("_", str(v or "")).strip("_")
    return (s or fallback)[:48]


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float("inf"), float("-inf")):
        return default
    return f


def _first(d, *names, **kw):
    default = kw.get("default")
    if not isinstance(d, dict):
        return default
    for n in names:
        if n in d and d[n] is not None:
            return d[n]
    return default


def _warn(out, code, at=None, extra=None):
    item = {"code": code}
    if at:
        item["at"] = str(at)[:60]
    if extra is not None:
        item["v"] = str(extra)[:60]
    for w in out:
        if w.get("code") == code and w.get("at") == item.get("at"):
            w["n"] = w.get("n", 1) + 1
            return
    out.append(item)


def _segment(raw, warns, index, prefix="chain"):
    if not isinstance(raw, dict):
        _warn(warns, "badSegment", "%s[%d]" % (prefix, index))
        return None
    name = _slug(_first(raw, "n", "name", "id", "part", default=""),
                 "%s%d" % (prefix[:1], index + 1))
    a = _num(_first(raw, "from", "start", "a", "y0", "begin", default=0.0))
    b = _num(_first(raw, "to", "end", "b", "y1", "finish", default=0.0))
    if b < a:
        a, b = b, a
        _warn(warns, "segmentReversed", name)
    seg = {
        "n": name,
        "from": round(a, 5),
        "to": round(b, 5),
        "w": abs(_num(_first(raw, "w", "width", "wx", default=0.0))),
        "d": abs(_num(_first(raw, "d", "depth", "dz", "thickness", default=0.0))),
    }
    of = _first(raw, "of", "on", "parent", "host")
    if of:
        seg["of"] = _slug(of, "")
    role = _first(raw, "role", "kind", "type")
    if role:
        seg["role"] = _slug(role, "")
    if seg["w"] <= 0:
        _warn(warns, "segmentNoWidth", name)
    if seg["d"] <= 0:
        seg["d"] = seg["w"]
        _warn(warns, "segmentNoDepth", name)
    return seg


def normalize_plan(raw, request=None):
    """Piano grezzo -> piano canonico + avvisi. Solleva se non c'e' una catena."""
    warns = []
    if isinstance(raw, str):
        raw = json.loads(raw)
    if not isinstance(raw, dict):
        raise ValueError("Il piano deve essere un oggetto JSON.")

    for wrapper in ("plan", "piano", "blueprint", "spec", "data", "result"):
        inner = raw.get(wrapper)
        if isinstance(inner, dict) and ("chain" in inner or "segments" in inner):
            _warn(warns, "unwrapped", wrapper)
            raw = inner
            break

    axis = str(_first(raw, "axis", "main_axis", "along", default="y") or "y").strip().lower()[:1]
    if axis not in AXES:
        _warn(warns, "badAxis", "axis", axis)
        axis = "y"

    raw_chain = _first(raw, "chain", "segments", "sequence", "parts", default=[])
    if isinstance(raw_chain, dict):
        conv = []
        for k, v in raw_chain.items():
            if isinstance(v, dict):
                item = dict(v)
                item.setdefault("n", k)
                conv.append(item)
        raw_chain = conv
    if not isinstance(raw_chain, (list, tuple)) or not raw_chain:
        raise ValueError("Il piano non contiene una catena di segmenti.")

    chain = []
    seen = set()
    for i, rs in enumerate(list(raw_chain)[:MAX_CHAIN]):
        seg = _segment(rs, warns, i, "chain")
        if seg is None:
            continue
        if seg["n"] in seen:
            seg["n"] = seg["n"] + "_%d" % (i + 1)
            _warn(warns, "duplicateSegment", seg["n"])
        seen.add(seg["n"])
        chain.append(seg)
    if not chain:
        raise ValueError("Nessun segmento utilizzabile nella catena.")

    chain.sort(key=lambda s: (s["from"], s["to"]))

    extras = []
    for i, rs in enumerate(list(_first(raw, "extras", "details", "addons",
                                       default=[]))[:MAX_EXTRAS]):
        seg = _segment(rs, warns, i, "extra")
        if seg is None:
            continue
        if seg["n"] in seen:
            seg["n"] = seg["n"] + "_x%d" % (i + 1)
        seen.add(seg["n"])
        extras.append(seg)

    plan = {
        "asset": str(_first(raw, "asset", "name", "subject",
                            default=(request or "")) or "")[:120],
        "axis": axis,
        "chain": chain,
        "extras": extras,
    }

    # --- Riparazione della catena --------------------------------------------
    # Un piano con buchi o sovrapposizioni non e' un piano: si chiude la catena
    # QUI, dove costa una riga, invece di lasciare che diventi geometria.
    repairs = []
    if abs(chain[0]["from"]) > 1e-6:
        shift = chain[0]["from"]
        for s in chain:
            s["from"] = round(s["from"] - shift, 5)
            s["to"] = round(s["to"] - shift, 5)
        for s in extras:
            s["from"] = round(s["from"] - shift, 5)
            s["to"] = round(s["to"] - shift, 5)
        repairs.append("shiftToZero:%.4f" % shift)

    for i in range(len(chain) - 1):
        gap = chain[i + 1]["from"] - chain[i]["to"]
        if abs(gap) > 1e-6:
            # Si chiude tirando l'inizio del successivo sulla fine del precedente:
            # la LUNGHEZZA del pezzo dopo si conserva, cosi' non si deforma un
            # pezzo per colpa del vicino.
            length = chain[i + 1]["to"] - chain[i + 1]["from"]
            chain[i + 1]["from"] = chain[i]["to"]
            chain[i + 1]["to"] = round(chain[i]["to"] + length, 5)
            repairs.append("closeGap:%s/%s:%.4f" % (chain[i]["n"], chain[i + 1]["n"], gap))
            _warn(warns, "chainGap", chain[i + 1]["n"], round(gap, 4))

    axis_len = round(chain[-1]["to"] - chain[0]["from"], 5)

    # Trasversali: massimo fra i segmenti e gli extras che sporgono.
    max_w = max([s["w"] for s in chain] + [s["w"] for s in extras] + [0.0])
    max_d = max([s["d"] for s in chain] + [s["d"] for s in extras] + [0.0])

    declared = _first(raw, "total", "bbox", "size", "dimensions")
    total = [0.0, 0.0, 0.0]
    ai = AXIS_INDEX[axis]
    other = [i for i in (0, 1, 2) if i != ai]
    total[ai] = axis_len
    total[other[0]] = max_w if other[0] == 0 or axis != "x" else max_d
    # Assegnazione esplicita: w -> asse X quando l'asse principale non e' X,
    # altrimenti w -> Y. E' una convenzione, ma dichiarata.
    if axis == "y":
        total[0], total[2] = max_w, max_d
    elif axis == "z":
        total[0], total[1] = max_w, max_d
    else:
        total[1], total[2] = max_w, max_d
    total = [round(max(0.001, t), 5) for t in total]

    if isinstance(declared, (list, tuple)) and len(declared) >= 3:
        dec = [abs(_num(x)) for x in declared[:3]]
        if dec[ai] > 1e-6 and abs(dec[ai] - axis_len) > max(TOL_ABS, axis_len * 0.08):
            _warn(warns, "totalMismatch", "total",
                  "%.3f!=%.3f" % (dec[ai], axis_len))
            repairs.append("totalFromChain:%.4f" % axis_len)
        # I trasversali dichiarati si tengono se sono >= ai misurati (un extra
        # puo' sporgere in un modo che la distinta non descrive), mai se sono
        # piu' piccoli: sarebbe un ingombro che non contiene i suoi pezzi.
        for i in other:
            if dec[i] > total[i]:
                total[i] = round(dec[i], 5)

    plan["total"] = total
    plan["axisLength"] = axis_len
    plan["repairs"] = repairs

    # Extras fuori dal loro ospite.
    by_name = {s["n"]: s for s in chain}
    for e in extras:
        host = by_name.get(e.get("of"))
        if not host:
            continue
        if e["from"] < host["from"] - TOL_ABS or e["to"] > host["to"] + TOL_ABS:
            _warn(warns, "extraOutsideHost", e["n"])
            e["from"] = round(max(e["from"], host["from"]), 5)
            e["to"] = round(min(e["to"], host["to"]), 5)
            if e["to"] <= e["from"]:
                e["to"] = round(min(host["to"], e["from"] + 0.01), 5)

    mats = []
    for i, m in enumerate(list(_first(raw, "materials", "mats", default=[]))[:8]):
        if not isinstance(m, dict):
            continue
        name = _slug(_first(m, "n", "name", "id", default=""), "m%d" % (i + 1))
        col = str(_first(m, "col", "color", "hex", default="#CCCCCC") or "#CCCCCC")
        if not col.startswith("#"):
            col = "#" + col
        on = [_slug(x, "") for x in _first(m, "on", "parts", "nodes", default=[])]
        mats.append({"n": name, "col": col.upper()[:7], "on": [x for x in on if x]})
    plan["materials"] = mats

    # Ogni pezzo dovrebbe avere un materiale: non e' fatale, ma va detto.
    assigned = set()
    for m in mats:
        assigned.update(m["on"])
    for s in chain + extras:
        if s["n"] not in assigned:
            _warn(warns, "segmentNoMaterial", s["n"])

    return plan, warns


def plan_text(plan):
    """Distinta come TABELLA compatta, per il prompt di costruzione.

    Tabella e non JSON: il costruttore deve LEGGERE numeri e riusarli, e una
    tabella allineata rende evidente la contiguita' (la colonna `da` ripete la
    colonna `a` della riga sopra), che e' proprio la proprieta' da non rompere.
    """
    ai = AXIS_INDEX[plan["axis"]]
    L = []
    L.append("ASSE PRINCIPALE: %s   LUNGHEZZA TOTALE: %.4f m"
             % (plan["axis"].upper(), plan["axisLength"]))
    L.append("INGOMBRO COMPLESSIVO (X Y Z): %.4f  %.4f  %.4f"
             % tuple(plan["total"]))
    L.append("")
    L.append("CATENA (contigua, da 0 a %.4f lungo %s):"
             % (plan["axisLength"], plan["axis"].upper()))
    L.append("  nome              da       a        lung.    largh.   prof.")
    for s in plan["chain"]:
        L.append("  %-16s %-8.4f %-8.4f %-8.4f %-8.4f %-8.4f"
                 % (s["n"][:16], s["from"], s["to"], s["to"] - s["from"], s["w"], s["d"]))
    if plan["extras"]:
        L.append("")
        L.append("DETTAGLI (dentro il pezzo indicato):")
        L.append("  nome              su                da       a        largh.   prof.")
        for s in plan["extras"]:
            L.append("  %-16s %-16s %-8.4f %-8.4f %-8.4f %-8.4f"
                     % (s["n"][:16], (s.get("of") or "-")[:16], s["from"], s["to"],
                        s["w"], s["d"]))
    if plan.get("materials"):
        L.append("")
        L.append("MATERIALI:")
        for m in plan["materials"]:
            L.append("  %-12s %-8s  su: %s" % (m["n"], m["col"], ", ".join(m["on"])))
    L.append("")
    L.append("REGOLA DI COSTRUZIONE: per ogni pezzo il centro sull'asse %s e'"
             % plan["axis"].upper())
    L.append("(da+a)/2 e la lunghezza e' (a-da). NON inventare altre posizioni.")
    return "\n".join(L)


def plan_params(plan):
    """Params gia' pronti derivati dal piano: `<pezzo>_a`, `<pezzo>_b`, `_w`, `_d`.

    Si consegnano al costruttore perche' scriva `at` e `s` come espressioni su
    QUESTI nomi invece di ricopiare numeri a mano. Ricopiare e' dove si perde una
    cifra, ed e' anche cio' che rende impossibile aggiustare l'asset dopo:
    cambiando un parametro si muove tutta la catena.
    """
    out = {}
    for s in plan["chain"] + plan["extras"]:
        n = s["n"]
        out[n + "_a"] = round(s["from"], 5)
        out[n + "_b"] = round(s["to"], 5)
        out[n + "_w"] = round(s["w"], 5)
        out[n + "_d"] = round(s["d"], 5)
    return out


def audit_built(plan, measured, tol_abs=TOL_ABS, tol_rel=TOL_REL):
    """Confronta la mesh COSTRUITA col piano. Ritorna una lista di difetti.

    `measured` e' `{"total": [x,y,z], "parts": {nome: {"min":[..], "max":[..],
    "size":[..]}}}` — cioe' quello che misura il motore JS.

    Non e' una critica estetica: sono numeri contro numeri, e ogni difetto porta
    con se' la correzione da fare. E' la parte che nessun modello linguistico
    puo' sbagliare per conto nostro.
    """
    defects = []
    ai = AXIS_INDEX[plan["axis"]]
    axis_name = plan["axis"].upper()

    def off(a, b):
        return abs(a - b) > max(tol_abs, abs(b) * tol_rel)

    total = (measured or {}).get("total") or []
    if len(total) >= 3:
        got = _num(total[ai])
        want = plan["axisLength"]
        if off(got, want):
            defects.append({
                "code": "planAxisLength", "sev": "high", "where": axis_name,
                "what": "Lunghezza su %s = %.3f m, il piano dice %.3f m."
                        % (axis_name, got, want),
                "fix": "Correggere i params dei pezzi della catena cosi' che la "
                       "somma delle lunghezze faccia %.3f." % want,
            })
        for i in (0, 1, 2):
            if i == ai:
                continue
            g, w = _num(total[i]), _num(plan["total"][i])
            # Un trasversale piu' PICCOLO del piano e' un dettaglio mancante;
            # piu' GRANDE e' un pezzo fuori misura, che e' il difetto vero.
            if g > w * (1 + tol_rel) + tol_abs:
                defects.append({
                    "code": "planTooWide", "sev": "high", "where": "XYZ"[i],
                    "what": "Ingombro %s = %.3f m, il piano dice %.3f m."
                            % ("XYZ"[i], g, w),
                    "fix": "Ridurre la larghezza dei pezzi che sporgono su %s: "
                           "nessuno deve superare %.3f." % ("XYZ"[i], w),
                })
            elif g < w * (1 - tol_rel) - tol_abs:
                defects.append({
                    "code": "planTooNarrow", "sev": "medium", "where": "XYZ"[i],
                    "what": "Ingombro %s = %.3f m, il piano dice %.3f m."
                            % ("XYZ"[i], g, w),
                    "fix": "Portare la larghezza dei pezzi su %s a %.3f."
                           % ("XYZ"[i], w),
                })

    parts = (measured or {}).get("parts") or {}
    # Un nodo mosso a mano nell'editor arriva marcato: la sua posizione e' una
    # SCELTA dell'utente, non un errore del modello. Senza questa esclusione il
    # ratchet "correggerebbe" ogni modifica manuale al giro dopo, e l'editor
    # diventerebbe inutilizzabile.
    locked = set((measured or {}).get("locked") or [])
    planned = {s["n"]: s for s in plan["chain"] if s["n"] not in locked}
    planned_extras = {s["n"]: s for s in plan["extras"] if s["n"] not in locked}

    for name, seg in planned.items():
        got = parts.get(name)
        if not got:
            defects.append({
                "code": "planPartMissing", "sev": "high", "where": name,
                "what": "Il pezzo \"%s\" del piano non esiste nel modello." % name,
                "fix": "Aggiungere un nodo \"%s\" con centro %s=%.4f e lunghezza %.4f."
                       % (name, axis_name, (seg["from"] + seg["to"]) / 2,
                          seg["to"] - seg["from"]),
            })
            continue
        size = got.get("size") or [0, 0, 0]
        gmin = got.get("min") or [0, 0, 0]
        gmax = got.get("max") or [0, 0, 0]
        want_len = seg["to"] - seg["from"]
        if off(_num(size[ai]), want_len):
            defects.append({
                "code": "planPartLength", "sev": "high", "where": name,
                "what": "\"%s\" e' lungo %.3f m su %s, il piano dice %.3f m."
                        % (name, _num(size[ai]), axis_name, want_len),
                "fix": "Impostare la lunghezza di \"%s\" a %.4f (da %.4f a %.4f)."
                       % (name, want_len, seg["from"], seg["to"]),
            })
        # Posizione: il pezzo deve stare DOVE dice il piano, non solo essere
        # lungo il giusto. Un pezzo giusto nel posto sbagliato e' il difetto che
        # produce le punte in fondo e le guardie in mezzo alla lama.
        want_a, want_b = seg["from"], seg["to"]
        if off(_num(gmin[ai]), want_a) or off(_num(gmax[ai]), want_b):
            defects.append({
                "code": "planPartPosition", "sev": "high", "where": name,
                "what": "\"%s\" occupa %s da %.3f a %.3f, il piano dice da %.3f a %.3f."
                        % (name, axis_name, _num(gmin[ai]), _num(gmax[ai]), want_a, want_b),
                "fix": "Spostare \"%s\": centro su %s = %.4f."
                       % (name, axis_name, (want_a + want_b) / 2),
            })
        # Trasversali.
        cross = [i for i in (0, 1, 2) if i != ai]
        wants = {}
        if plan["axis"] == "y":
            wants = {0: seg["w"], 2: seg["d"]}
        elif plan["axis"] == "z":
            wants = {0: seg["w"], 1: seg["d"]}
        else:
            wants = {1: seg["w"], 2: seg["d"]}
        for i in cross:
            want = wants.get(i, 0.0)
            if want <= 0:
                continue
            g = _num(size[i])
            if off(g, want):
                defects.append({
                    "code": "planPartCross", "sev": "medium", "where": name,
                    "what": "\"%s\" misura %.3f su %s, il piano dice %.3f."
                            % (name, g, "XYZ"[i], want),
                    "fix": "Portare la sezione di \"%s\" su %s a %.4f."
                           % (name, "XYZ"[i], want),
                })

    for name, seg in planned_extras.items():
        if name not in parts:
            defects.append({
                "code": "planExtraMissing", "sev": "low", "where": name,
                "what": "Il dettaglio \"%s\" del piano non c'e'." % name,
                "fix": "Aggiungerlo su \"%s\" fra %.4f e %.4f."
                       % (seg.get("of") or "?", seg["from"], seg["to"]),
            })

    # Pezzi che il piano non prevede: non sono un errore di per se', ma se sono
    # grandi lo sono (e' cosi' che compare la piramide gigante).
    for name, got in parts.items():
        if name in planned or name in planned_extras or name in locked:
            continue
        if any(s["n"] == name for s in plan["chain"] + plan["extras"]):
            continue
        size = got.get("size") or [0, 0, 0]
        if _num(size[ai]) > plan["axisLength"] * 0.25:
            defects.append({
                "code": "planExtraneousPart", "sev": "high", "where": name,
                "what": "\"%s\" non e' nel piano ed e' grande (%.3f m su %s)."
                        % (name, _num(size[ai]), axis_name),
                "fix": "Eliminare \"%s\" o ricondurlo a un pezzo del piano." % name,
            })

    rank = {"high": 0, "medium": 1, "low": 2}
    defects.sort(key=lambda d: rank.get(d.get("sev"), 9))
    return defects


def plan_stats(plan):
    return {
        "axis": plan["axis"],
        "axisLength": plan["axisLength"],
        "total": plan["total"],
        "segments": len(plan["chain"]),
        "extras": len(plan["extras"]),
        "materials": len(plan.get("materials") or []),
        "repairs": plan.get("repairs") or [],
    }


# --- Decomposizione in TASK ---------------------------------------------------

def plan_tasks(plan):
    """Il piano diventa una lista di compiti, uno per segmento.

    Perche' a pezzi
    ---------------
    Un modello che deve emettere sessanta nodi in una sola risposta perde
    precisione su tutti: sbaglia una misura qui, dimentica un dettaglio la',
    inventa un materiale nuovo a meta' strada. Sei chiamate da cinque nodi
    ognuna, ognuna con davanti UN pezzo e le sue misure, non hanno quel problema
    — ed e' anche l'unico modo di chiedere davvero "il massimo dettaglio su
    questo pezzo".

    La decomposizione NON costa una chiamata AI: il piano la contiene gia'. Ogni
    segmento della catena e' un compito, e gli `extras` che lo indicano come
    ospite (`of`) vanno con lui. Chiederla a un modello sarebbe pagare per
    un'informazione che abbiamo.

    Ogni task porta le sue INTERFACCE: il pezzo sotto e quello sopra, con la
    quota di confine e la loro sezione. E' cio' che tiene coerente un oggetto
    costruito in sei conversazioni diverse: chi fa la guardia sa che sotto di lei
    l'impugnatura finisce a 0.230 con sezione 0.034, quindi la sua base combacia
    invece di galleggiare.
    """
    chain = plan.get("chain") or []
    extras = plan.get("extras") or []
    mats = plan.get("materials") or []

    by_host = {}
    orphans = []
    names = {s["n"] for s in chain}
    for e in extras:
        host = e.get("of")
        if host in names:
            by_host.setdefault(host, []).append(e)
        else:
            orphans.append(e)

    # Un extra senza ospite valido si assegna al segmento che lo CONTIENE per
    # quota: e' un'informazione che il piano ha comunque, e scartarlo
    # perderebbe un dettaglio che l'architetto ha voluto.
    for e in orphans:
        mid = (e["from"] + e["to"]) / 2
        best, bestd = None, None
        for s in chain:
            if s["from"] - TOL_ABS <= mid <= s["to"] + TOL_ABS:
                best = s["n"]
                break
            d = min(abs(mid - s["from"]), abs(mid - s["to"]))
            if bestd is None or d < bestd:
                bestd, best = d, s["n"]
        if best:
            by_host.setdefault(best, []).append(e)

    tasks = []
    for i, seg in enumerate(chain):
        prev_seg = chain[i - 1] if i > 0 else None
        next_seg = chain[i + 1] if i + 1 < len(chain) else None
        own_extras = by_host.get(seg["n"], [])
        # Materiali pertinenti: quelli che nominano questo pezzo o i suoi
        # dettagli. Si passa comunque TUTTA la palette (serve a non inventarne
        # di nuovi), ma si segnala quali sono i suoi.
        own_names = {seg["n"]} | {e["n"] for e in own_extras}
        suggested = [m["n"] for m in mats
                     if own_names & set(m.get("on") or [])]
        tasks.append({
            "i": i,
            "n": len(chain),
            "name": seg["n"],
            "seg": seg,
            "extras": own_extras,
            "prev": ({"n": prev_seg["n"], "at": prev_seg["to"],
                      "w": prev_seg["w"], "d": prev_seg["d"]} if prev_seg else None),
            "next": ({"n": next_seg["n"], "at": next_seg["from"],
                      "w": next_seg["w"], "d": next_seg["d"]} if next_seg else None),
            "role": seg.get("role") or "",
            "suggestedMats": suggested,
            # Quanti nodi ha senso chiedere per QUESTO pezzo: il corpo
            # principale ne merita piu' di un collarino.
            "budget": max(2, min(12, 2 + len(own_extras) * 2
                                 + (2 if seg["to"] - seg["from"]
                                    > plan["axisLength"] * 0.25 else 0))),
        })
    return tasks


def task_text(plan, task):
    """Il compito come testo, con le interfacce. Va nel prompt del pezzo."""
    ax = plan["axis"].upper()
    seg = task["seg"]
    L = []
    L.append("PEZZO DA COSTRUIRE: %s   (%d di %d)"
             % (task["name"], task["i"] + 1, task["n"]))
    L.append("  sull'asse %s va da %.4f a %.4f  (lunghezza %.4f)"
             % (ax, seg["from"], seg["to"], seg["to"] - seg["from"]))
    L.append("  sezione trasversale: larghezza %.4f, profondita' %.4f"
             % (seg["w"], seg["d"]))
    L.append("  centro sull'asse %s = %.4f" % (ax, (seg["from"] + seg["to"]) / 2))
    if task["role"]:
        L.append("  funzione: %s" % task["role"])
    L.append("")
    if task["prev"]:
        p = task["prev"]
        L.append("  SOTTO di lui c'e' \"%s\", che finisce a %s=%.4f con sezione "
                 "%.4f x %.4f: la tua base deve combaciare la' (o sovrapporsi di "
                 "1-2 mm), non galleggiare."
                 % (p["n"], ax, p["at"], p["w"], p["d"]))
    else:
        L.append("  E' il pezzo piu' in basso: la sua base sta a %s=%.4f."
                 % (ax, seg["from"]))
    if task["next"]:
        nx = task["next"]
        L.append("  SOPRA di lui comincia \"%s\" a %s=%.4f con sezione %.4f x %.4f: "
                 "non invadere quello spazio."
                 % (nx["n"], ax, nx["at"], nx["w"], nx["d"]))
    else:
        L.append("  E' il pezzo piu' in alto: finisce a %s=%.4f." % (ax, seg["to"]))
    if task["extras"]:
        L.append("")
        L.append("  DETTAGLI che devono stare su questo pezzo:")
        for e in task["extras"]:
            L.append("    - %-16s da %.4f a %.4f, sezione %.4f x %.4f"
                     % (e["n"], e["from"], e["to"], e["w"], e["d"]))
    L.append("")
    L.append("  Nodi attesi per questo pezzo: da %d a %d."
             % (max(1, task["budget"] - 1), task["budget"] + 2))
    return "\n".join(L)


def task_params(plan, task):
    """Solo i params che servono a QUESTO pezzo, piu' quelli dei vicini.

    Passare tutti i parametri di tutti i segmenti invita a usarli, e un pezzo
    che cita le misure di un altro e' il modo in cui un oggetto costruito a pezzi
    torna incoerente.
    """
    keep = {task["name"]}
    keep.update(e["n"] for e in task["extras"])
    if task["prev"]:
        keep.add(task["prev"]["n"])
    if task["next"]:
        keep.add(task["next"]["n"])
    allp = plan_params(plan)
    out = {}
    for k, v in allp.items():
        base = k.rsplit("_", 1)[0]
        if base in keep:
            out[k] = v
    return out

