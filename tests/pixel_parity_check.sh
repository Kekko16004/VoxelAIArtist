#!/usr/bin/env bash
# Parita' delle OPS 2D (pixel art) fra le due implementazioni:
#   ui/src/lib/37-pixel-ops.js   `expandPixelOps`   (la tela del browser)
#   mcp_server/pixelops.py       `expand_pixel_ops` (l'MCP)
#
# Fino all'MCP le ops dei pixel avevano un solo consumatore e non c'era parita'
# da mantenere. Ora ce ne sono due, quindi c'e' - ed e' esattamente la situazione
# che sulle ops dei VOXEL e' costata tre difetti veri prima che
# tests/parity_check.sh li trovasse. Questo file e' l'analogo per il 2D.
#
# Vive in un file suo, come parity_check.sh, per essere lanciabile da solo: la
# batteria di mutazioni lo esegue isolato invece di ripetere tutta la suite.
#
# Uso:  bash tests/pixel_parity_check.sh

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")" || exit 1

node tests/pixel_parity_js.mjs >/dev/null || exit 1

python3 - <<'PY'
import json, os, sys

ROOT = os.getcwd()
sys.path.insert(0, ROOT)
from mcp_server import pixelops

doc = json.load(open(os.path.join(ROOT, "tests/pixel_ops_parity_cases.json"),
                    encoding="utf-8"))
js = json.load(open(os.path.join(ROOT, "tests/.js_pixel_out.json"), encoding="utf-8"))
cases = doc["cases"]


def inflate(value):
    """{repeat, op} -> l'op ripetuta. La stessa cosa che fa il lato JS.

    Il caso del budget (20000 ops) va scritto cosi' o il file dei casi diventa
    400 KB, e un file che non si puo' leggere non lo rilegge nessuno.
    """
    if isinstance(value, list):
        out = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("op"), str) and item.get("repeat"):
                out.extend([item["op"]] * int(item["repeat"]))
            else:
                out.append(inflate(item))
        return out
    if isinstance(value, dict):
        return {k: inflate(v) for k, v in value.items()}
    return value


def norm_warn(w):
    """L'UNICA differenza di forma tollerata negli avvisi: il dato ASSENTE.

    Un avviso e' `codice` + il dato grezzo che lo ha causato, e i due moduli lo
    dicono entrambi nella loro docstring: il codice e' il contratto (chi chiama
    lo traduce), il dato serve a chi legge il log. Quando il dato MANCA - `set`
    senza colore - JS stampa la sua parola per il niente e Python la sua, e
    pretendere che coincidano vorrebbe dire scrivere "undefined" dentro codice
    Python solo per far passare un confronto.

    La sostituzione e' volutamente sull'INTERO ultimo campo e non su una
    sottostringa: se un lato echeggiasse il colore e l'altro l'op intera - una
    divergenza vera - questa funzione non la nasconderebbe.
    """
    return w[:-len("None")] + "undefined" if w.endswith(" None") else w


# --- pavimenti di copertura ---------------------------------------------------
# Un elenco di casi vuoto o troncato mette d'accordo i due lati su NIENTE, e
# "0/0 identici" esce verde. Non e' un timore teorico: su tests/parity_check.sh
# due mutazioni (lista troncata a 3, lista svuotata) passavano entrambe prima che
# i pavimenti ci fossero. Qui la lista arriva dal file condiviso, quindi va
# PRETESA da questo lato, che non la produce.
ATTESI = 55
SONDE = [
    # Le due trappole della porta, quelle per cui il modulo Python esiste.
    "fill-coordinate-frazionarie",      # js_round contro l'arrotondamento del banchiere
    "noise-seme-esplicito",             # la perdita di precisione dell'LCG
    # I rami che nessun altro caso tocca.
    "budget-condiviso-fra-le-facce",    # il tetto di 20000 ops e' della RISPOSTA
    "del-totale-suicida",               # la difesa contro la cancellazione totale
    "del-totale-con-disegno-dopo",      # e il suo contrario, che NON va scartato
    "palette-per-faccia-si-somma",      # trovato in GUI reale, ignorato in silenzio
    "dimensione-imposta-da-chi-chiama",
    "risposta-non-e-un-oggetto",
    "coordinate-in-forme-strane",       # Number() non e' float()
    "mirror-su-lato-dispari",
]
nomi = [c["name"] for c in cases]
manca = [s for s in SONDE if s not in nomi]
if len(cases) < ATTESI or manca or len(js.get("results") or {}) != len(cases):
    print("COPERTURA PERSA: %d casi (attesi almeno %d), %d dal lato JS, sonde "
          "assenti: %r" % (len(cases), ATTESI, len(js.get("results") or {}), manca))
    print("    (se hai tolto dei casi da tests/pixel_ops_parity_cases.json, "
          "aggiorna ATTESI qui - ma prima chiediti perche')")
    sys.exit(1)
if len(set(nomi)) != len(nomi):
    print("COPERTURA PERSA: due casi hanno lo stesso nome, uno dei due non e' "
          "confrontato")
    sys.exit(1)

# Le costanti sono la parte di semantica che nessun singolo caso puo' esercitare
# per intero, ed e' proprio la specie di divergenza gia' vista sui voxel: alzare
# MAX_VOXELS_ABSOLUTE nel solo lato JS passava tutta la suite.
cost = js.get("constants") or {}
attese_cost = {
    "PIXEL_OPS_MAX": pixelops.PIXEL_OPS_MAX,
    "PIXEL_OPS_MAX_SIDE": pixelops.PIXEL_OPS_MAX_SIDE,
    "PIXEL_OPS_MIN_SIDE": pixelops.PIXEL_OPS_MIN_SIDE,
}
cost_diff = ["%s: js=%r py=%r" % (k, cost.get(k), v)
             for k, v in attese_cost.items() if cost.get(k) != v]

# --- il confronto -------------------------------------------------------------
bad = []
esercitati = set()
for c in cases:
    name = c["name"]
    got = pixelops.expand_pixel_ops(inflate(json.loads(json.dumps(c["data"]))),
                                    inflate(json.loads(json.dumps(c.get("opts") or {}))))
    py = {
        "w": got["w"], "h": got["h"],
        "faces": {k: bytes(v).hex() for k, v in (got.get("faces") or {}).items()},
        "painted": got.get("painted") or {},
        "warnings": sorted(norm_warn(w) for w in (got.get("warnings") or [])),
    }
    esercitati.update(w.split(" ")[0] for w in py["warnings"])
    ref = js["results"].get(name)
    if ref != py:
        motivo = "assente dal lato JS" if ref is None else ""
        if isinstance(ref, dict) and "error" in ref:
            motivo = "il lato JS ha sollevato: " + str(ref["error"])
        elif isinstance(ref, dict) and not motivo:
            for campo in ("w", "h", "painted", "warnings"):
                if ref.get(campo) != py[campo]:
                    motivo = "%s: js=%r py=%r" % (campo, ref.get(campo), py[campo])
                    break
            else:
                jf, pf = ref.get("faces") or {}, py["faces"]
                if set(jf) != set(pf):
                    motivo = "facce: js=%r py=%r" % (sorted(jf), sorted(pf))
                else:
                    for k in sorted(pf):
                        if jf[k] != pf[k]:
                            # Il primo pixel diverso: dice DOVE, che e' cio' che
                            # serve per capire quale op ha divergito.
                            i = next((i for i in range(0, min(len(jf[k]), len(pf[k])), 8)
                                      if jf[k][i:i + 8] != pf[k][i:i + 8]), 0)
                            px = i // 8
                            motivo = ("faccia %s, pixel %d (x=%d y=%d): js=%s py=%s"
                                      % (k, px, px % max(1, py["w"]), px // max(1, py["w"]),
                                         jf[k][i:i + 8], pf[k][i:i + 8]))
                            break
        bad.append("%s -> %s" % (name, motivo or "differiscono"))

# I rami interessanti devono essere ESERCITATI, non solo presenti fra i casi:
# senza una risposta che li attivi il confronto girerebbe a vuoto su di essi.
AVVISI_ATTESI = {"badCoords", "badColor", "unknownCmd", "truncated", "noOps",
                 "emptyAnswer", "wipeDropped"}
mai = sorted(AVVISI_ATTESI - esercitati)

print("parita ops 2D: %d/%d casi identici" % (len(cases) - len(bad), len(cases)))
for b in bad:
    print("    DIVERGENTE", b)
for d in cost_diff:
    print("    COSTANTE DIVERGENTE", d)
if mai:
    print("COPERTURA PERSA: questi avvisi non li produce nessun caso: %r" % mai)

sys.exit(1 if (bad or cost_diff or mai) else 0)
PY
