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

# Come si COSTRUISCE l'oggetto. E' la decisione piu' importante del piano, e
# sbagliarla non si recupera con nessun prompt.
#
# Il difetto che ha reso necessario questo campo: un vaso e' UNA superficie di
# rivoluzione — un profilo, uno spin, una parete, un labbro bevellato, un solo
# oggetto — e tagliarlo in cinque segmenti costruiti da cinque chiamate
# indipendenti produce una PILA DI DISCHI TORNITI. Che e' esattamente cio' che
# usciva. La catena di segmenti va benissimo per una spada (pomolo, impugnatura,
# guardia e lama SONO solidi distinti) ed e' sbagliata per un vaso.
STRATEGIES = ("revolve", "chain", "shell", "limbs")

STRATEGY_ALIASES = {
    "lathe": "revolve", "spin": "revolve", "rotational": "revolve",
    "rivoluzione": "revolve", "tornio": "revolve", "axisymmetric": "revolve",
    "stack": "chain", "segments": "chain", "catena": "chain",
    "parts": "chain", "assembly": "chain",
    "box": "shell", "boolean": "shell", "hollow": "shell",
    "architecture": "shell", "guscio": "shell", "building": "shell",
    "character": "limbs", "humanoid": "limbs", "creature": "limbs",
    "arti": "limbs", "body": "limbs",
}

# Parole che dicono "questo oggetto e' tondo attorno a un asse". Servono a
# INDOVINARE la strategia quando il piano non la dichiara: meglio un'euristica
# esplicita che un default sbagliato per meta' degli oggetti.
_REVOLVE_HINTS = (
    "vaso", "vase", "anfora", "amphora", "bottiglia", "bottle", "calice",
    "goblet", "bicchiere", "tazza", "cup", "mug", "ciotola", "bowl", "scodella",
    "piatto", "plate", "pentola", "pot", "pignatta", "giara", "urna", "urn",
    "jar", "barattolo", "colonna", "column", "pilastro", "balaustra",
    "baluster", "candelabro", "candlestick", "lampada", "lamp", "lampadario",
    "chandelier", "cupola", "dome", "campana", "bell", "botte", "barrel",
    "secchio", "bucket", "ruota", "wheel", "pomolo", "knob", "fungo",
    "mushroom", "clessidra", "hourglass", "trottola", "top", "fontana",
    "fountain", "torretta", "turret", "silo", "tornio", "boccale", "brocca",
    "pitcher", "teiera", "teapot", "ampolla", "flask", "provetta", "vial",
)

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

    # --- Strategia di costruzione --------------------------------------------
    strat = str(_first(raw, "strategy", "strategia", "construction", "build",
                       default="") or "").strip().lower()
    strat = STRATEGY_ALIASES.get(strat, strat)
    if strat not in STRATEGIES:
        if strat:
            _warn(warns, "unknownStrategy", "strategy", strat)
        strat = _infer_strategy(plan, request, warns)
    plan["strategy"] = strat

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


def _infer_strategy(plan, request, warns):
    """Indovina la strategia quando il piano non la dichiara.

    Due indizi, entrambi buoni:
      - il NOME dell'oggetto (un vaso e' un vaso);
      - la GEOMETRIA della catena: se ogni segmento ha larghezza e profondita'
        quasi uguali, l'oggetto e' tondo attorno all'asse per costruzione, e
        tagliarlo in solidi separati lo trasformerebbe in una pila di dischi.
    """
    text = " ".join([str(plan.get("asset") or ""), str(request or "")]).lower()
    for hint in _REVOLVE_HINTS:
        if hint in text:
            _warn(warns, "strategyInferred", "strategy", "revolve/" + hint)
            return "revolve"

    chain = plan.get("chain") or []
    if chain:
        square = 0
        for s in chain:
            w, d = s["w"], s["d"]
            if w > 1e-6 and abs(w - d) / max(w, d) < 0.12:
                square += 1
        if square == len(chain) and len(chain) >= 3:
            _warn(warns, "strategyInferred", "strategy", "revolve/sezioniTonde")
            return "revolve"

    if "person" in text or "uman" in text or "creatur" in text or "robot" in text:
        return "limbs"
    if "edifici" in text or "casa" in text or "buildin" in text or "torre" in text:
        return "shell"
    return "chain"


def plan_stats(plan):
    return {
        "axis": plan["axis"],
        "strategy": plan.get("strategy") or "chain",
        "axisLength": plan["axisLength"],
        "total": plan["total"],
        "segments": len(plan["chain"]),
        "extras": len(plan["extras"]),
        "materials": len(plan.get("materials") or []),
        "repairs": plan.get("repairs") or [],
    }


# --- Decomposizione in TASK ---------------------------------------------------

def plan_tasks(plan):
    """Il piano diventa una lista di compiti. La STRATEGIA decide come.

    Perche' a pezzi
    ---------------
    Un modello che deve emettere sessanta nodi in una sola risposta perde
    precisione su tutti. Compiti piccoli e ben definiti no.

    Ma "pezzo" non vuol dire sempre "segmento della catena", e sbagliarlo e' il
    difetto piu' grave che questo file ha avuto. Un vaso e' UNA superficie di
    rivoluzione: un profilo, uno spin, una parete, un labbro. Tagliarlo in cinque
    segmenti costruiti da cinque chiamate indipendenti produce una PILA DI DISCHI
    TORNITI, ed e' esattamente cio' che usciva. Per una spada invece i segmenti
    SONO solidi distinti (pomolo, impugnatura, guardia, lama) e la catena e' la
    decomposizione giusta.

    Quindi:
      - `revolve`: UN compito costruisce il corpo intero come un solo `lathe` con
        il profilo completo; i segmenti diventano le STAZIONI di quel profilo.
        Gli extras (manici, fasce, piedi separati) restano compiti a se'.
      - `chain` / `shell` / `limbs`: un compito per segmento, con gli extras
        appesi al loro ospite.

    Ogni task porta le sue INTERFACCE: e' cio' che tiene coerente un oggetto
    costruito in piu' conversazioni.
    """
    chain = plan.get("chain") or []
    extras = plan.get("extras") or []
    mats = plan.get("materials") or []
    strategy = plan.get("strategy") or "chain"

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

    def mats_for(names_set):
        return [m["n"] for m in mats if names_set & set(m.get("on") or [])]

    tasks = []

    if strategy == "revolve" and chain:
        # UN compito per tutto il corpo. Le stazioni del profilo sono i segmenti.
        body_names = {s["n"] for s in chain}
        # Gli extras che sono davvero parte del profilo (fasce, collarini
        # concentrici) restano al corpo; quelli che sporgono (manici, becchi,
        # piedi) sono compiti a se', perche' non sono solidi di rivoluzione.
        inline, standalone = [], []
        for e in extras:
            w, d = e["w"], e["d"]
            round_ish = w > 1e-6 and abs(w - d) / max(w, d) < 0.15
            wide = w >= max(0.35 * max(s["w"] for s in chain), 1e-6)
            (inline if (round_ish and wide) else standalone).append(e)

        tasks.append({
            "i": 0,
            "n": 1 + len(standalone),
            "name": plan.get("asset") and "corpo" or "corpo",
            "kind": "revolve",
            "seg": {"n": "corpo", "from": chain[0]["from"], "to": chain[-1]["to"],
                    "w": max(s["w"] for s in chain),
                    "d": max(s["d"] for s in chain)},
            "stations": [{"n": s["n"], "from": s["from"], "to": s["to"],
                          "w": s["w"], "d": s["d"]} for s in chain],
            "extras": inline,
            "prev": None,
            "next": None,
            "role": "corpo tornito completo",
            "suggestedMats": mats_for(body_names | {e["n"] for e in inline})
                             or [m["n"] for m in mats[:1]],
            "budget": 3 + len(inline),
        })
        for j, e in enumerate(standalone):
            host = e.get("of") if e.get("of") in names else "corpo"
            tasks.append({
                "i": j + 1,
                "n": 1 + len(standalone),
                "name": e["n"],
                "kind": "detail",
                "seg": e,
                "stations": [],
                "extras": [],
                "prev": {"n": "corpo", "at": e["from"],
                         "w": _radius_at(chain, e["from"]) * 2,
                         "d": _radius_at(chain, e["from"]) * 2},
                "next": None,
                "role": "dettaglio applicato sul corpo (%s)" % host,
                "suggestedMats": mats_for({e["n"]}),
                "budget": 3,
            })
        return tasks

    for i, seg in enumerate(chain):
        prev_seg = chain[i - 1] if i > 0 else None
        next_seg = chain[i + 1] if i + 1 < len(chain) else None
        own_extras = by_host.get(seg["n"], [])
        own_names = {seg["n"]} | {e["n"] for e in own_extras}
        tasks.append({
            "i": i,
            "n": len(chain),
            "name": seg["n"],
            "kind": "segment",
            "seg": seg,
            "stations": [],
            "extras": own_extras,
            "prev": ({"n": prev_seg["n"], "at": prev_seg["to"],
                      "w": prev_seg["w"], "d": prev_seg["d"]} if prev_seg else None),
            "next": ({"n": next_seg["n"], "at": next_seg["from"],
                      "w": next_seg["w"], "d": next_seg["d"]} if next_seg else None),
            "role": seg.get("role") or "",
            "suggestedMats": mats_for(own_names),
            "budget": max(2, min(12, 2 + len(own_extras) * 2
                                 + (2 if seg["to"] - seg["from"]
                                    > plan["axisLength"] * 0.25 else 0))),
        })
    return tasks


def _radius_at(chain, y):
    """Raggio del corpo alla quota y: serve a dire a un manico dove attaccarsi."""
    for s in chain:
        if s["from"] - TOL_ABS <= y <= s["to"] + TOL_ABS:
            return s["w"] / 2.0
    best, bestd = chain[0], None
    for s in chain:
        d = min(abs(y - s["from"]), abs(y - s["to"]))
        if bestd is None or d < bestd:
            bestd, best = d, s
    return best["w"] / 2.0


def task_text(plan, task):
    """Il compito come testo, con le interfacce. Va nel prompt del pezzo."""
    ax = plan["axis"].upper()
    seg = task["seg"]
    kind = task.get("kind") or "segment"
    L = []

    if kind == "revolve":
        L.append("COMPITO: IL CORPO INTERO, come UN SOLO solido di rivoluzione.")
        L.append("")
        L.append("Questo oggetto e' tondo attorno all'asse %s: si costruisce con"
                 " UN nodo `lathe`, non impilando cilindri. Un profilo, uno spin,"
                 " una parete, un labbro." % ax)
        L.append("  altezza totale sull'asse %s: da %.4f a %.4f  (%.4f)"
                 % (ax, seg["from"], seg["to"], seg["to"] - seg["from"]))
        L.append("  diametro massimo: %.4f" % seg["w"])
        L.append("")
        L.append("STAZIONI DEL PROFILO (il diametro che l'oggetto deve avere a")
        L.append("quelle quote: il tuo profilo deve passarci dentro, con una")
        L.append("curva continua):")
        L.append("  quota %s      da       a        diametro   raggio"
                 % ax.lower())
        for st in task.get("stations") or []:
            L.append("  %-14s %-8.4f %-8.4f %-10.4f %.4f"
                     % (st["n"][:14], st["from"], st["to"], st["w"], st["w"] / 2))
        if task.get("extras"):
            L.append("")
            L.append("RILIEVI concentrici da includere nel profilo (non nodi a se'):")
            for e in task["extras"]:
                L.append("  - %-14s da %.4f a %.4f, diametro %.4f"
                         % (e["n"], e["from"], e["to"], e["w"]))
        L.append("")
        L.append("  Nodi attesi: 1 (il corpo) piu' al massimo %d per i rilievi che"
                 % max(1, len(task.get("extras") or [])))
        L.append("  il profilo non puo' esprimere. NON spezzare il corpo.")
        return "\n".join(L)

    if kind == "detail":
        L.append("COMPITO: un DETTAGLIO applicato su un corpo gia' costruito.")
        L.append("")
        L.append("  nome: %s" % task["name"])
        L.append("  sull'asse %s va da %.4f a %.4f  (lunghezza %.4f)"
                 % (ax, seg["from"], seg["to"], seg["to"] - seg["from"]))
        L.append("  sezione: %.4f x %.4f" % (seg["w"], seg["d"]))
        if task.get("prev"):
            p = task["prev"]
            L.append("  il CORPO a quella quota ha raggio %.4f: il tuo dettaglio"
                     " deve partire da la' e sovrapporsi di 1-2 mm, non"
                     " galleggiare." % (p["w"] / 2))
        L.append("  Se e' una coppia (due manici, due anse), usa UN nodo con"
                 " \"mir\":\"x\" invece di due.")
        L.append("")
        L.append("  Nodi attesi: da 1 a %d." % (task["budget"] + 1))
        return "\n".join(L)

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
    """Solo i params che servono a QUESTO compito, piu' quelli dei vicini.

    Passare tutti i parametri di tutti i segmenti invita a usarli, e un pezzo
    che cita le misure di un altro e' il modo in cui un oggetto costruito a pezzi
    torna incoerente. Il corpo tornito e' l'eccezione: le stazioni del profilo
    SONO i segmenti, quindi gli servono tutti.
    """
    allp = plan_params(plan)
    kind = task.get("kind") or "segment"
    if kind == "revolve":
        keep = {st["n"] for st in (task.get("stations") or [])}
        keep.update(e["n"] for e in (task.get("extras") or []))
    else:
        keep = {task["name"]}
        keep.update(e["n"] for e in (task.get("extras") or []))
        if task.get("prev") and task["prev"].get("n"):
            keep.add(task["prev"]["n"])
        if task.get("next") and task["next"].get("n"):
            keep.add(task["next"]["n"])
    out = {}
    for k, v in allp.items():
        base = k.rsplit("_", 1)[0]
        if base in keep:
            out[k] = v
    return out


# --- STADI DI LAVORAZIONE -----------------------------------------------------

def plan_stages(plan, detail=2):
    """Il piano diventa 1-3 STADI, non N pezzi.

    Perche' a stadi e non a pezzi
    -----------------------------
    Un pezzo per volta risolve la precisione ma introduce due problemi suoi: il
    numero di chiamate cresce col numero di segmenti (una spada finiva in sei
    passaggi, quando due o tre bastano), e nessuna chiamata vede mai l'oggetto
    INTERO — cosi' si perde il senso delle proporzioni fra le parti, che e'
    esattamente il difetto riportato.

    Un modellatore non lavora a pezzi: lavora a OPERAZIONI. Prima blocca tutto
    l'oggetto con volumi grezzi (e' li' che si fissano le proporzioni), poi
    rifinisce le forme (tornio, raccordi, rastremature), poi aggiunge i dettagli.
    Ogni stadio vede l'oggetto COMPLETO e ha UN mestiere da esercitare.

    Numero di stadi:
      dettaglio 0   ->  blocco                          (1 chiamata)
      dettaglio 1   ->  blocco + rifinitura             (2)
      dettaglio 2/3 ->  blocco + rifinitura + dettagli  (3)
    e su un oggetto SEMPLICE (pochi segmenti e pochi extras) i dettagli si
    fondono nella rifinitura: una spada resta a due stadi, cioe' tre chiamate
    contando il piano.
    """
    chain = plan.get("chain") or []
    extras = plan.get("extras") or []
    detail = max(0, min(3, int(detail if detail is not None else 2)))
    simple = len(chain) <= 5 and len(extras) <= 3

    stages = [{"kind": "blockout", "name": "blocco"}]
    if detail >= 1:
        stages.append({"kind": "refine", "name": "rifinitura"})
    if detail >= 2 and not simple:
        stages.append({"kind": "details", "name": "dettagli"})

    # Su un oggetto semplice la rifinitura porta anche i dettagli: si DICE nel
    # compito, cosi' chi rifinisce sa che non ci sara' un terzo giro e non
    # rimanda i dettagli a uno stadio che non arrivera'.
    merged = (detail >= 2 and simple)
    total = len(stages)
    for i, st in enumerate(stages):
        st["i"] = i
        st["n"] = total
        st["detail"] = detail
        st["mergeDetails"] = bool(merged and st["kind"] == "refine")
        st["segments"] = len(chain)
        st["extras"] = extras
        st["budget"] = (max(4, len(chain) + 2) if st["kind"] == "blockout"
                        else max(6, len(chain) + len(extras) + 2))
    return stages


def stage_text(plan, stage):
    """Lo stadio come compito: entra nello stesso prompt che serve i pezzi."""
    ax = plan["axis"].upper()
    kind = stage["kind"]
    L = []
    L.append("STADIO %d di %d: %s" % (stage["i"] + 1, stage["n"],
                                      stage["name"].upper()))
    L.append("")

    if kind == "blockout":
        L.append("Costruisci TUTTO l'oggetto con i volumi principali, seguendo la")
        L.append("catena. Niente dettagli, niente decorazioni: questo stadio serve")
        L.append("a fissare le PROPORZIONI, ed e' l'unico in cui un errore poi non")
        L.append("si recupera.")
        L.append("")
        L.append("  - il primitivo giusto per la forma: tondo attorno a un asse ->")
        L.append("    `lathe`; lama o carrozzeria -> `loft`; scatolato -> `box`;")
        L.append("    coperchio bombato o volta -> `cyl` con `arc`;")
        L.append("  - le quote esatte della tabella, niente numeri inventati;")
        L.append("  - i pezzi si TOCCANO: ogni segmento comincia dove finisce il")
        L.append("    precedente, quindi combaciano per costruzione;")
        L.append("  - a ogni nodo il suo materiale, dalla palette.")
        L.append("")
        L.append("  Nodi attesi: da %d a %d." % (max(1, stage["segments"]),
                                                 stage["budget"] + 2))
        if plan.get("strategy") == "revolve":
            L.append("")
            L.append("  ATTENZIONE: questo oggetto e' di RIVOLUZIONE. Il corpo e' UN")
            L.append("  SOLO nodo `lathe` con il profilo completo che passa per tutte")
            L.append("  le stazioni della tabella — NON un nodo per segmento.")
            L.append("  Impilare cilindri di raggio diverso da' una pila di dischi.")
        return "\n".join(L)

    if kind == "refine":
        L.append("Hai davanti l'oggetto bloccato (te lo trovi qui sotto). RIFINISCI")
        L.append("le forme senza cambiare le proporzioni ne' le quote della catena.")
        L.append("")
        L.append("Cosa si fa in questo stadio — solo cio' che serve a QUESTO oggetto:")
        L.append("  - sostituire i volumi grezzi col primitivo giusto: piu' cilindri")
        L.append("    impilati diventano UN `lathe` col profilo completo; una lastra")
        L.append("    che deve essere una lama diventa `loft` con `shape:\"lens\"`;")
        L.append("    un coperchio bombato diventa `cyl` con `arc`;")
        L.append("  - `bevel` sugli spigoli che nella realta' sono lavorati;")
        L.append("  - `taperTo` / `taper0` dove il pezzo si stringe, per-asse se si")
        L.append("    stringe solo in una direzione (e' il filo di una lama);")
        L.append("  - `wall` sui recipienti, perche' siano cavi;")
        L.append("  - `shear`, `twist`, `bendA`, `warp` dove la forma lo chiede;")
        L.append("  - `sides` piu' alto sui pezzi tondi grandi e in primo piano.")
        if stage.get("mergeDetails"):
            L.append("")
            L.append("Questo oggetto e' semplice, quindi NON ci sara' un terzo stadio:")
            L.append("aggiungi ORA anche i dettagli che merita — collari alle")
            L.append("giunzioni, avvolgimenti con `arr`, scanalature con `sub`,")
            L.append("terminali sagomati, borchie.")
            if stage["extras"]:
                L.append("Dettagli previsti dal piano:")
                for e in stage["extras"]:
                    L.append("  - %-16s da %.4f a %.4f, sezione %.4f x %.4f"
                             % (e["n"], e["from"], e["to"], e["w"], e["d"]))
        L.append("")
        L.append("Rispondi con la lista COMPLETA dei nodi: sostituisce la")
        L.append("precedente, non e' una differenza.")
        return "\n".join(L)

    L.append("Hai davanti l'oggetto rifinito (qui sotto). AGGIUNGI i dettagli")
    L.append("senza toccare i volumi che ci sono.")
    L.append("")
    L.append("Su ogni GIUNZIONE fra due pezzi diversi ci va un collare, una")
    L.append("fascetta o un cambio di materiale: le giunzioni nude sono la prima")
    L.append("cosa che si nota in un modello.")
    L.append("Le ripetizioni si fanno con `arr` (lineare) o con `arr` + `rot`")
    L.append("(polare attorno all'asse): avvolgimenti, borchie, doghe, bulloni,")
    L.append("raggi, greche. Mai copie scritte a mano.")
    if stage["extras"]:
        L.append("")
        L.append("Dettagli previsti dal piano:")
        for e in stage["extras"]:
            L.append("  - %-16s su %-14s da %.4f a %.4f, sezione %.4f x %.4f"
                     % (e["n"], (e.get("of") or "-"), e["from"], e["to"],
                        e["w"], e["d"]))
    L.append("")
    L.append("Rispondi con i nodi NUOVI soltanto: quelli che ci sono restano.")
    L.append("  Nodi attesi: da %d a %d." % (max(2, len(stage["extras"])),
                                             stage["budget"] + 4))
    return "\n".join(L)
