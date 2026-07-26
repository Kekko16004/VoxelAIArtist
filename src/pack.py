"""
pack.py — Multigenerazione "Asset Pack" per VoxelAIArtist.

Questo modulo contiene DUE cose, entrambe indipendenti da main.py e da Gemini
(quindi testabili in isolamento con un generatore finto):

  1. Il DISTILLATORE DI STILE (`distill_style`, `build_style_contract`):
     dato un insieme di modelli JSON di riferimento, ne estrae un "contratto di
     stile" testuale compatto (palette condivisa, griglia, densita', mix di ops)
     da iniettare nel prompt di OGNI asset del pack. Non incolla mai i JSON
     interi nel prompt: i file di esempio pesano ~12 KB l'uno e farebbero
     esplodere il budget token degradando la qualita'.

  2. La CODA DI PACK (`PackRun`, `PackManager`):
     una coda server-side con worker a concorrenza limitata (default 1). Vive nel
     processo Python e non nel browser, cosi' un reload della webview non perde
     il lavoro: la UI fa polling su /api/pack/status.
     Il client Gemini usato dall'app NON e' l'API ufficiale (e' un client web
     autenticato a cookie): sparare N richieste in parallelo significa farsi
     rate-limitare o bruciare la sessione. Per questo la concorrenza di default
     e' 1, con backoff esponenziale sugli errori di rate-limit.

ANCORA DI STILE (il trucco che rende il pack davvero coerente)
-------------------------------------------------------------
Se l'utente NON carica riferimenti, il pack rischia N palette diverse = pack
inutilizzabile. Soluzione: il primo asset completato con successo diventa
l'ANCORA. La sua palette viene estratta e iniettata come contratto per tutti i
job successivi. E' lo stesso principio dello "style anchor" usato dai servizi
hosted, ottenuto qui senza training ne' LoRA.
"""

import json
import os
import re
import threading
import time
import uuid

# ---------------------------------------------------------------------------
# Costanti di tuning
# ---------------------------------------------------------------------------

MAX_PALETTE_IN_CONTRACT = 20   # colori massimi elencati nel contratto di stile
MAX_OBJECTS = 60               # tetto di sicurezza sugli oggetti richiesti
MAX_VARIANTS = 10              # tetto di sicurezza sulle varianti per oggetto
MAX_JOBS = 120                 # tetto assoluto sui job di un singolo pack
DEFAULT_CONCURRENCY = 1        # vedi nota sul client Gemini a cookie
MAX_CONCURRENCY = 2

# Backoff sugli errori che sembrano rate-limit / quota.
RETRY_BACKOFF_SECONDS = [20, 60, 150]
_RATE_LIMIT_HINTS = (
    "rate", "quota", "429", "too many", "limit", "exhaust",
    "unavailable", "503", "overload", "temporarily",
)


def _looks_like_rate_limit(msg):
    """True se il messaggio d'errore sembra un limite temporaneo (vale ritentare)."""
    low = (msg or "").lower()
    return any(h in low for h in _RATE_LIMIT_HINTS)


# ---------------------------------------------------------------------------
# Utility: slug e nomi file-safe
# ---------------------------------------------------------------------------

def slugify(name, fallback="asset"):
    """'Vaso fiori' -> 'Vaso_Fiori'. Sicuro per nomi file su Windows/macOS/Linux."""
    s = (name or "").strip()
    if not s:
        return fallback
    # Titolo per parola, poi underscore. Mantiene lettere accentate.
    parts = [p for p in re.split(r"[\s/\\]+", s) if p]
    parts = [p[:1].upper() + p[1:] if p else p for p in parts]
    s = "_".join(parts)
    s = re.sub(r'[<>:"|?*\x00-\x1f]', "", s)
    s = re.sub(r"_{2,}", "_", s).strip("_.")
    return s[:64] or fallback


# ---------------------------------------------------------------------------
# DISTILLATORE DI STILE
# ---------------------------------------------------------------------------

_HEX_RE = re.compile(r"^#?[0-9A-Fa-f]{6}$")


def _norm_hex(c):
    """Normalizza un colore a '#RRGGBB' maiuscolo, o None se non e' un hex."""
    if not isinstance(c, str):
        return None
    c = c.strip()
    if not _HEX_RE.match(c):
        return None
    if not c.startswith("#"):
        c = "#" + c
    return c.upper()


def _luminance(hex_color):
    """Luminanza relativa approssimata (0..1) per ordinare la palette."""
    try:
        r = int(hex_color[1:3], 16) / 255.0
        g = int(hex_color[3:5], 16) / 255.0
        b = int(hex_color[5:7], 16) / 255.0
    except (ValueError, IndexError):
        return 0.0
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _saturation(hex_color):
    """Saturazione HSL approssimata (0..1): distingue grigi da colori vivi."""
    try:
        r = int(hex_color[1:3], 16) / 255.0
        g = int(hex_color[3:5], 16) / 255.0
        b = int(hex_color[5:7], 16) / 255.0
    except (ValueError, IndexError):
        return 0.0
    mx, mn = max(r, g, b), min(r, g, b)
    if mx == mn:
        return 0.0
    l = (mx + mn) / 2.0
    d = mx - mn
    return d / (2.0 - mx - mn) if l > 0.5 else d / (mx + mn)


def _round_coarse(n):
    """
    Arrotonda a una cifra significativa 'umana'. Il conteggio voxel stimato e'
    approssimato: scriverlo come '91224' nel prompt suggerisce una precisione
    che non abbiamo. '~2500' comunica l'ordine di grandezza, che e' il punto.
    """
    n = int(n or 0)
    if n <= 0:
        return 0
    for step in (10000, 1000, 100, 10):
        if n >= step:
            return int(round(n / float(step))) * step
    return n


def _iter_models(payload):
    """
    Normalizza un payload in una lista di modelli singoli.
    Gestisce sia il formato legacy ({voxels}/{ops}) sia il multi-oggetto
    ({objects:[...]}) prodotto da getSceneSavePayload().
    """
    if not isinstance(payload, dict):
        return []
    objs = payload.get("objects")
    if isinstance(objs, list) and objs:
        return [o for o in objs if isinstance(o, dict)]
    return [payload]


def _color_weights_from_model(model):
    """
    Stima quanti voxel usa ogni colore, SENZA espandere le ops.
    Per 'fill' il volume e' dx*dy*dz: esatto e costa O(1) invece di O(voxel).
    Serve solo a pesare la palette, quindi l'approssimazione va benissimo.

    Ritorna (weights: {hex: peso}, total: int, ops_mix: {nome_op: conteggio}).
    """
    weights = {}
    ops_mix = {}
    total = 0

    palette = model.get("palette") if isinstance(model.get("palette"), dict) else {}

    def resolve(key):
        """Chiave palette o hex letterale -> hex normalizzato."""
        direct = _norm_hex(key)
        if direct:
            return direct
        if isinstance(key, str) and key in palette:
            return _norm_hex(palette[key])
        return None

    def add(hexc, w):
        nonlocal total
        if not hexc or w <= 0:
            return
        weights[hexc] = weights.get(hexc, 0) + w
        total += w

    # --- caso 1: voxel flat ---
    voxels = model.get("voxels")
    if isinstance(voxels, list) and voxels:
        for v in voxels:
            if isinstance(v, dict):
                add(_norm_hex(v.get("color")), 1)
        ops_mix["voxels"] = len(voxels)
        return weights, total, ops_mix

    # --- caso 2: ops compatte ---
    ops = model.get("ops")
    if not isinstance(ops, list):
        return weights, total, ops_mix

    for op in ops:
        if not isinstance(op, list) or not op:
            continue
        name = str(op[0]).lower()
        ops_mix[name] = ops_mix.get(name, 0) + 1
        try:
            if name in ("fill", "box", "line") and len(op) >= 8:
                x0, y0, z0, x1, y1, z1 = (int(op[i]) for i in range(1, 7))
                col = resolve(op[7])
                dx, dy, dz = abs(x1 - x0) + 1, abs(y1 - y0) + 1, abs(z1 - z0) + 1
                if name == "fill":
                    add(col, dx * dy * dz)
                elif name == "box":
                    # Guscio cavo: volume esterno meno il volume interno.
                    inner = max(0, dx - 2) * max(0, dy - 2) * max(0, dz - 2)
                    add(col, dx * dy * dz - inner)
                else:  # line: passi lungo l'asse dominante
                    add(col, max(dx, dy, dz))
            elif name == "rect" and len(op) >= 7:
                a0, b0, a1, b1 = (int(op[i]) for i in range(3, 7))
                add(resolve(op[7] if len(op) > 7 else None),
                    (abs(a1 - a0) + 1) * (abs(b1 - b0) + 1))
            elif name == "set" and len(op) >= 5:
                col = resolve(op[1])
                add(col, max(0, (len(op) - 2) // 3))
            # 'del' non aggiunge colore: ignorato di proposito.
        except (TypeError, ValueError):
            continue

    return weights, total, ops_mix


def distill_style(references):
    """
    Analizza i modelli di riferimento e restituisce un dizionario di stile.

    `references` = lista di payload JSON gia' parsati (dict). Vengono ignorati
    silenziosamente gli elementi non validi: un file corrotto non deve far
    fallire l'avvio di un pack.

    Ritorna:
      {
        "sources": int,          # modelli effettivamente analizzati
        "palette": [hex, ...],   # palette condivisa, ordinata
        "grid_size": [x,y,z]|None,
        "avg_voxels": int,
        "avg_palette_size": int,
        "ops_mix": {op: conteggio},
        "detail": "basso"|"medio"|"alto",
      }
    """
    agg_weights = {}
    grids = []
    voxel_counts = []
    palette_sizes = []
    ops_mix_total = {}
    analysed = 0

    for ref in (references or []):
        for model in _iter_models(ref):
            weights, total, ops_mix = _color_weights_from_model(model)
            if not weights and not total:
                continue
            analysed += 1
            for c, w in weights.items():
                agg_weights[c] = agg_weights.get(c, 0) + w
            for k, v in ops_mix.items():
                ops_mix_total[k] = ops_mix_total.get(k, 0) + v
            if total:
                voxel_counts.append(total)
            palette_sizes.append(len(weights))
            meta = model.get("metadata") if isinstance(model.get("metadata"), dict) else {}
            g = meta.get("grid_size")
            if isinstance(g, list) and len(g) == 3:
                try:
                    grids.append([int(g[0]), int(g[1]), int(g[2])])
                except (TypeError, ValueError):
                    pass

    # Palette: ordina per peso decrescente, poi taglia. Il riordino finale per
    # luminanza rende l'elenco leggibile nel prompt (scuri -> chiari).
    ranked = sorted(agg_weights.items(), key=lambda kv: -kv[1])[:MAX_PALETTE_IN_CONTRACT]
    palette = [c for c, _ in sorted(ranked, key=lambda kv: _luminance(kv[0]))]

    grid = None
    if grids:
        # Moda sulla griglia: il valore piu' ricorrente fra i riferimenti.
        counts = {}
        for g in grids:
            counts[tuple(g)] = counts.get(tuple(g), 0) + 1
        grid = list(max(counts.items(), key=lambda kv: kv[1])[0])

    avg_raw = int(sum(voxel_counts) / len(voxel_counts)) if voxel_counts else 0
    avg_pal = int(round(sum(palette_sizes) / len(palette_sizes))) if palette_sizes else 0

    # ATTENZIONE: avg_raw e' una SOVRASTIMA. Le ops si applicano in ordine e
    # quelle successive sovrascrivono le precedenti, e 'del' scava: sommare i
    # volumi conta piu' volte le stesse celle. Sui file di esempio del repo
    # questo produceva ~91k voxel su griglia 64^3 (densita' 35%): iniettare quel
    # numero nel prompt spingerebbe l'AI a generare modelli assurdamente densi.
    # Quindi: clamp al volume della griglia e arrotondamento grossolano, e la
    # classificazione del dettaglio usa la DENSITA' relativa, non il valore
    # assoluto (2000 voxel su 16^3 e' molto denso, su 128^3 e' quasi vuoto).
    grid_volume = (grid[0] * grid[1] * grid[2]) if grid else 0
    density = None
    if grid_volume and avg_raw:
        density = min(1.0, avg_raw / float(grid_volume))

    avg_voxels = avg_raw
    if grid_volume:
        avg_voxels = min(avg_raw, int(grid_volume * 0.5))
    avg_voxels = _round_coarse(avg_voxels)

    if density is not None:
        detail = "basso" if density < 0.05 else ("alto" if density > 0.25 else "medio")
    elif avg_raw:
        detail = "basso" if avg_raw < 600 else ("alto" if avg_raw > 4000 else "medio")
    else:
        detail = "medio"

    return {
        "sources": analysed,
        "palette": palette,
        "grid_size": grid,
        "avg_voxels": avg_voxels,
        "density": round(density, 3) if density is not None else None,
        "avg_palette_size": avg_pal,
        "ops_mix": ops_mix_total,
        "detail": detail,
    }


def _palette_role(hexc):
    """Etichetta grossolana del ruolo di un colore, per guidare l'LLM."""
    lum, sat = _luminance(hexc), _saturation(hexc)
    if sat < 0.12:
        if lum < 0.2:
            return "ombra/outline"
        if lum > 0.85:
            return "luce/highlight"
        return "neutro"
    if lum < 0.3:
        return "scuro saturo"
    if lum > 0.75:
        return "chiaro saturo"
    return "colore base"


def build_style_contract(style, grid_override=None, detail_override=None, extra_notes=None):
    """
    Trasforma il dizionario di `distill_style` in un blocco di testo compatto da
    iniettare nel prompt. Se `style` e' vuoto (nessun riferimento e nessuna
    ancora), ritorna solo le regole di coerenza generiche: il pack resta
    coerente perche' il primo asset diventera' l'ancora.
    """
    lines = []
    lines.append("[CONTRATTO DI STILE DEL PACK - VINCOLANTE, RISPETTALO SEMPRE]")
    lines.append(
        "Questo asset fa parte di un PACK: deve sembrare disegnato dalla stessa "
        "mano degli altri. Coerenza di stile > originalita' del singolo pezzo."
    )

    grid = grid_override or (style or {}).get("grid_size")
    if grid and isinstance(grid, list) and len(grid) == 3:
        lines.append(
            "- Griglia OBBLIGATORIA per ogni asset del pack: "
            f"{grid[0]}x{grid[1]}x{grid[2]}. Imposta metadata.grid_size = "
            f"[{grid[0]}, {grid[1]}, {grid[2]}]."
        )

    palette = (style or {}).get("palette") or []
    if palette:
        lines.append(
            f"- PALETTE DI RIFERIMENTO ({len(palette)} colori). Questa e' la "
            "gamma cromatica del pack: usala come guida per la SATURAZIONE, il "
            "contrasto e il trattamento delle ombre.\n"
            "  IMPORTANTE: se il soggetto che stai generando e' fatto di un "
            "materiale DIVERSO (es. ferro/pietra quando qui sotto vedi colori di "
            "terra ed erba), NON forzare questi colori sul tuo oggetto: un blocco "
            "di ferro deve restare grigio metallico. Usa i colori giusti per il "
            "TUO materiale, mantenendo lo stesso livello di saturazione e lo "
            "stesso modo di rendere luci e ombre."
        )
        for hexc in palette:
            lines.append(f"    {hexc}   ({_palette_role(hexc)})")

    detail = detail_override or (style or {}).get("detail")
    avg_voxels = (style or {}).get("avg_voxels") or 0
    if detail:
        # Nota: avg_voxels e' una stima grossolana (vedi _round_coarse), quindi
        # la presentiamo come ordine di grandezza e non come target esatto.
        target = f" (ordine di grandezza: ~{avg_voxels} voxel per asset)" if avg_voxels else ""
        lines.append(
            f"- Livello di dettaglio: {detail}{target}. Mantienilo UNIFORME su tutto "
            "il pack: non fare un asset iper-dettagliato e il successivo grezzo."
        )

    ops_mix = (style or {}).get("ops_mix") or {}
    if ops_mix:
        top = sorted(ops_mix.items(), key=lambda kv: -kv[1])[:3]
        lines.append(
            "- Stile costruttivo dei riferimenti (imitalo): "
            + ", ".join(f"{k} x{v}" for k, v in top)
        )

    lines.append(
        "- Regole di coerenza non negoziabili (valgono SEMPRE, anche fra soggetti "
        "e materiali diversi): stesso spessore di outline; stessa dimensione del "
        "dettaglio piu' piccolo; stesso modo di rendere ombre e luci; oggetto "
        "centrato sull'asse XZ e appoggiato a y=0; scala relativa plausibile "
        "rispetto agli altri oggetti del pack; nessun elemento fluttuante "
        "staccato dal corpo principale."
    )
    lines.append(
        "- Cosa NON deve essere condiviso: il SOGGETTO e il MATERIALE. Ogni "
        "oggetto della lista e' una cosa a se': generane la forma corretta per "
        "cio' che ti viene chiesto, non una variante dell'oggetto precedente."
    )

    if extra_notes:
        lines.append("- Note aggiuntive dell'utente: " + str(extra_notes).strip())

    lines.append("[FINE CONTRATTO DI STILE]")
    return "\n".join(lines)


def _color_distance(a, b):
    """
    Distanza percettiva approssimata fra due hex. Pesi 2/4/3 su R/G/B: e' la
    classica approssimazione "redmean-lite", molto piu' fedele all'occhio della
    distanza euclidea RGB pura (l'occhio e' piu' sensibile al verde).
    """
    try:
        ar, ag, ab = int(a[1:3], 16), int(a[3:5], 16), int(a[5:7], 16)
        br, bg, bb = int(b[1:3], 16), int(b[3:5], 16), int(b[5:7], 16)
    except (ValueError, IndexError):
        return float("inf")
    return 2 * (ar - br) ** 2 + 4 * (ag - bg) ** 2 + 3 * (ab - bb) ** 2


# Quando NON rimappare un colore sulla palette del pack.
#
# Prima usavo solo la distanza RGB, ma i dati mostrano che non basta: misurata
# sui casi reali, "grigio scuro vs verde" dista 20.251 mentre "verde chiaro vs
# verde scuro" dista 4.924 -> qualunque soglia unica sbaglia uno dei due casi.
#
# Il criterio giusto e' PERCETTIVO, non metrico: un grigio (saturazione ~0.00)
# non e' mai "una sfumatura" di un verde saturo (0.56), per quanto vicini siano
# i numeri RGB. Quindi decidiamo su tre segnali:
#   1. saturazione molto diversa -> materiali diversi (ferro vs terra);
#   2. tinta molto diversa       -> materiali diversi (verde vs marrone);
#   3. distanza molto grande     -> materiali diversi comunque.
# Se nessuno scatta, e' una sfumatura dello stesso materiale e va allineata.
SATURATION_GAP = 0.22     # oltre questo divario di saturazione: materiale diverso
HUE_GAP_DEGREES = 45      # oltre questo divario di tinta: materiale diverso
DEFAULT_PALETTE_TOLERANCE = 60000   # distanza RGB pesata oltre cui non si rimappa


def _hue(hex_color):
    """Tinta in gradi 0-360, oppure None per i grigi (nessuna tinta definita)."""
    try:
        r = int(hex_color[1:3], 16) / 255.0
        g = int(hex_color[3:5], 16) / 255.0
        b = int(hex_color[5:7], 16) / 255.0
    except (ValueError, IndexError):
        return None
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    if d < 1e-6:
        return None
    if mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return h * 60.0


def _same_material(a, b, tolerance=None):
    """
    True se `a` puo' essere considerato una sfumatura di `b` (stesso materiale),
    quindi rimappabile. False se sono materiali diversi e vanno lasciati stare.
    """
    sa, sb = _saturation(a), _saturation(b)
    if abs(sa - sb) > SATURATION_GAP:
        return False                      # es. grigio ferro (0.00) vs erba (0.56)
    ha, hb = _hue(a), _hue(b)
    if ha is not None and hb is not None:
        diff = abs(ha - hb)
        if diff > 180:
            diff = 360 - diff             # la tinta e' circolare
        if diff > HUE_GAP_DEGREES:
            return False                  # es. verde (94) vs marrone (27)
    elif (ha is None) != (hb is None):
        # uno e' grigio e l'altro no: stesso materiale solo se il colorato e'
        # comunque quasi desaturato (allora e' davvero una sfumatura di grigio)
        if max(sa, sb) > SATURATION_GAP:
            return False
    if tolerance is not None and _color_distance(a, b) > tolerance:
        return False
    return True


def enforce_palette(model_data, palette, tolerance=DEFAULT_PALETTE_TOLERANCE):
    """
    GARANZIA di coerenza cromatica: rimappa ogni colore del modello al piu'
    vicino della palette del pack.

    Questo e' il punto centrale del design. La ricerca sui competitor mostra che
    tutti i servizi hosted tentano la coerenza SOLO via prompt ("mantieni lo
    stesso stile") e che l'incoerenza dei batch resta un loro difetto noto. Un
    prompt e' un auspicio; questa funzione e' un vincolo. Dopo questo passaggio
    il pack HA la stessa palette, indipendentemente da quanto l'LLM ha
    obbedito.

    `tolerance` = distanza massima oltre la quale un colore viene LASCIATO STARE.
    Passare None disattiva la soglia e forza ogni colore sulla palette (comportamento
    aggressivo: usalo solo quando i soggetti condividono davvero i materiali).

    Ritorna (modello_modificato, report) dove report =
      {"remapped": n_colori_rimappati, "map": {da: a}, "exact": n_colori_giusti,
       "kept": n_colori_lasciati_invariati_perche_troppo_lontani}
    Modifica il dict in place (e lo ritorna) per non duplicare payload grandi.
    """
    report = {"remapped": 0, "map": {}, "exact": 0, "kept": 0}
    if not isinstance(model_data, dict) or not palette:
        return model_data, report

    allowed = [c for c in (_norm_hex(p) for p in palette) if c]
    if not allowed:
        return model_data, report
    allowed_set = set(allowed)
    cache = {}

    def nearest(hexc):
        """Colore consentito piu' vicino, con memoizzazione."""
        if hexc in cache:
            return cache[hexc]
        if hexc in allowed_set:
            cache[hexc] = hexc
            return hexc
        best, best_d = allowed[0], float("inf")
        for cand in allowed:
            d = _color_distance(hexc, cand)
            if d < best_d:
                best, best_d = cand, d
        # tolerance: se il colore e' troppo lontano da tutta la palette puo'
        # essere lasciato stare (usato per palette parziali/permissive).
        # Materiale diverso (non una sfumatura)? Lascialo com'e': e' cio' che
        # impediva a un blocco di ferro di diventare interamente verde terra.
        if tolerance is not None and not _same_material(hexc, best, tolerance):
            cache[hexc] = hexc
            report["kept"] += 1
            return hexc
        cache[hexc] = best
        return best

    def remap(raw):
        """Rimappa un valore colore; ritorna None se non e' un hex valido."""
        norm = _norm_hex(raw)
        if not norm:
            return None
        tgt = nearest(norm)
        if tgt == norm:
            report["exact"] += 1
        else:
            report["remapped"] += 1
            report["map"][norm] = tgt
        return tgt

    # --- palette dichiarata nel modello ---
    pal = model_data.get("palette")
    if isinstance(pal, dict):
        for k, v in list(pal.items()):
            tgt = remap(v)
            if tgt:
                pal[k] = tgt

    # --- voxel flat ---
    voxels = model_data.get("voxels")
    if isinstance(voxels, list):
        for v in voxels:
            if isinstance(v, dict):
                tgt = remap(v.get("color"))
                if tgt:
                    v["color"] = tgt

    # --- ops: i colori possono essere hex letterali inline ---
    ops = model_data.get("ops")
    if isinstance(ops, list):
        for op in ops:
            if not isinstance(op, list) or not op:
                continue
            name = str(op[0]).lower()
            idx = None
            if name in ("fill", "box", "line") and len(op) >= 8:
                idx = 7
            elif name == "rect" and len(op) >= 8:
                idx = 7
            elif name == "set" and len(op) >= 2:
                idx = 1
            if idx is None or idx >= len(op):
                continue
            # Solo hex letterali: le chiavi di palette sono gia' state rimappate
            # tramite il dizionario palette, riscriverle qui le romperebbe.
            if _norm_hex(op[idx]):
                tgt = remap(op[idx])
                if tgt:
                    op[idx] = tgt

    return model_data, report


def model_bounds(model_data):
    """
    Bounding box del modello: (minx,miny,minz,maxx,maxy,maxz) oppure None se vuoto.
    Funziona sui voxel flat; se ci sono solo ops le stima dalle coordinate degli op
    (piu' economico che espandere tutto).
    """
    if not isinstance(model_data, dict):
        return None
    lo = [None, None, None]
    hi = [None, None, None]

    def take(x, y, z):
        for i, v in enumerate((x, y, z)):
            if lo[i] is None or v < lo[i]:
                lo[i] = v
            if hi[i] is None or v > hi[i]:
                hi[i] = v

    voxels = model_data.get("voxels")
    if isinstance(voxels, list) and voxels:
        for v in voxels:
            if isinstance(v, dict):
                try:
                    take(int(v["x"]), int(v["y"]), int(v["z"]))
                except (KeyError, TypeError, ValueError):
                    continue
    else:
        ops = model_data.get("ops")
        if not isinstance(ops, list):
            return None
        for op in ops:
            if not isinstance(op, list) or not op:
                continue
            name = str(op[0]).lower()
            try:
                if name in ("fill", "box", "line", "del") and len(op) >= 7:
                    take(int(op[1]), int(op[2]), int(op[3]))
                    take(int(op[4]), int(op[5]), int(op[6]))
                elif name == "set" and len(op) >= 5:
                    coords = op[2:]
                    for i in range(0, len(coords) - 2, 3):
                        take(int(coords[i]), int(coords[i + 1]), int(coords[i + 2]))
            except (TypeError, ValueError):
                continue

    if lo[0] is None:
        return None
    return (lo[0], lo[1], lo[2], hi[0], hi[1], hi[2])


def _translate_model(model_data, dx, dy, dz):
    """Trasla in place tutte le coordinate del modello (voxel e ops)."""
    if dx == 0 and dy == 0 and dz == 0:
        return model_data

    voxels = model_data.get("voxels")
    if isinstance(voxels, list):
        for v in voxels:
            if isinstance(v, dict):
                try:
                    v["x"] = int(v["x"]) + dx
                    v["y"] = int(v["y"]) + dy
                    v["z"] = int(v["z"]) + dz
                except (KeyError, TypeError, ValueError):
                    continue

    ops = model_data.get("ops")
    if isinstance(ops, list):
        for op in ops:
            if not isinstance(op, list) or not op:
                continue
            name = str(op[0]).lower()
            try:
                if name in ("fill", "box", "line", "del") and len(op) >= 7:
                    op[1] = int(op[1]) + dx; op[2] = int(op[2]) + dy; op[3] = int(op[3]) + dz
                    op[4] = int(op[4]) + dx; op[5] = int(op[5]) + dy; op[6] = int(op[6]) + dz
                elif name == "rect" and len(op) >= 7:
                    # ["rect", axis, level, a0, b0, a1, b1, color]
                    axis = str(op[1]).lower()
                    da, db, dlevel = (dx, dz, dy) if axis == "y" else \
                                     ((dy, dz, dx) if axis == "x" else (dx, dy, dz))
                    op[2] = int(op[2]) + dlevel
                    op[3] = int(op[3]) + da; op[4] = int(op[4]) + db
                    op[5] = int(op[5]) + da; op[6] = int(op[6]) + db
                elif name == "set" and len(op) >= 5:
                    for i in range(2, len(op) - 2, 3):
                        op[i] = int(op[i]) + dx
                        op[i + 1] = int(op[i + 1]) + dy
                        op[i + 2] = int(op[i + 2]) + dz
            except (TypeError, ValueError):
                continue
    return model_data


def normalize_asset(model_data, grid_size=None):
    """
    ANCORAGGIO (idea #4). Centra l'asset sugli assi X/Z e lo appoggia a y=0.

    Perche' serve: un pack va importato in un motore di gioco e messo in scena.
    Se ogni asset ha un'origine diversa (uno parte da y=5, un altro e' spostato
    in un angolo della griglia), chi lo importa deve riposizionare a mano ogni
    pezzo. Il prompt lo chiede gia', ma come per la palette: chiedere non basta,
    qui lo IMPONIAMO dopo la generazione.

    Ritorna (model_data, report) con report = {"moved": (dx,dy,dz), "bounds": ...}.
    """
    report = {"moved": (0, 0, 0), "bounds": None, "size": None}
    if not isinstance(model_data, dict):
        return model_data, report

    b = model_bounds(model_data)
    if not b:
        return model_data, report
    minx, miny, minz, maxx, maxy, maxz = b
    sx, sy, sz = (maxx - minx + 1), (maxy - miny + 1), (maxz - minz + 1)

    meta = model_data.get("metadata") if isinstance(model_data.get("metadata"), dict) else {}
    grid = grid_size or meta.get("grid_size") or [max(32, sx), max(32, sy), max(32, sz)]
    try:
        gw, gh, gd = int(grid[0]), int(grid[1]), int(grid[2])
    except (TypeError, ValueError, IndexError):
        gw, gh, gd = max(32, sx), max(32, sy), max(32, sz)

    # Centro su X/Z, appoggio a y=0.
    dx = (gw - sx) // 2 - minx
    dz = (gd - sz) // 2 - minz
    dy = -miny

    _translate_model(model_data, dx, dy, dz)
    report["moved"] = (dx, dy, dz)
    report["bounds"] = (0, 0, 0, sx - 1, sy - 1, sz - 1)
    report["size"] = (sx, sy, sz)
    return model_data, report


# Taglie relative dichiarabili per oggetto. Il valore e' la frazione di griglia
# che l'oggetto dovrebbe occupare sull'asse maggiore.
SIZE_HINTS = {
    "minuscolo": 0.15,   # anello, moneta
    "piccolo": 0.30,     # tazza, auricolare, vaso
    "medio": 0.50,       # televisore, sedia
    "grande": 0.75,      # armadio, auto
    "enorme": 0.95,      # casa, edificio
}


def parse_size_hint(name):
    """
    Estrae una taglia dichiarata dal nome oggetto: "Armadio :grande" -> ("Armadio",
    "grande"). Senza suffisso ritorna (nome, None): niente magie, la normalizzazione
    di scala si applica solo se l'utente l'ha chiesta esplicitamente.
    """
    if not isinstance(name, str) or ":" not in name:
        return (name or "").strip(), None
    head, _, tail = name.rpartition(":")
    tag = tail.strip().lower()
    if tag in SIZE_HINTS:
        return head.strip(), tag
    return name.strip(), None


def pack_coherence_report(assets):
    """
    REPORT DI COERENZA (idea #4). `assets` = [{"label":..., "model":...}].

    Restituisce dimensioni per asset, la mediana e gli OUTLIER: gli asset la cui
    dimensione si discosta troppo dalla mediana del pack. E' il problema numero
    uno dei competitor (in un batch reale si sono viste una spada da 19.416 cm3 e
    un arco da 1.395.337 cm3 destinati alla stessa scena): saperlo prima di
    importare in Unity vale molto di piu' che scoprirlo dopo.
    """
    rows = []
    for a in (assets or []):
        model = a.get("model") if isinstance(a, dict) else None
        b = model_bounds(model) if model else None
        if not b:
            continue
        sx, sy, sz = (b[3] - b[0] + 1), (b[4] - b[1] + 1), (b[5] - b[2] + 1)
        rows.append({
            "label": a.get("label"),
            "size": [sx, sy, sz],
            "maxDim": max(sx, sy, sz),
            "volume": sx * sy * sz,
        })
    if not rows:
        return {"assets": [], "median": None, "outliers": []}

    dims = sorted(r["maxDim"] for r in rows)
    median = dims[len(dims) // 2]

    outliers = []
    for r in rows:
        ratio = (r["maxDim"] / median) if median else 1.0
        r["ratio"] = round(ratio, 2)
        # Oltre 2x o sotto 0,5x rispetto alla mediana: l'asset stona nel pack.
        if ratio >= 2.0 or ratio <= 0.5:
            outliers.append({"label": r["label"], "ratio": r["ratio"],
                             "maxDim": r["maxDim"], "median": median})
    return {"assets": rows, "median": median, "outliers": outliers}


def check_modular_block(model_data, grid_size=None, expand_fn=None):
    """
    VERIFICA DI MODULARITA' (blocchi per level builder con snap).

    Il prompt CHIEDE all'AI un blocco che riempie tutta la griglia con facce
    piane. Ma come per la palette, chiedere non basta: qui misuriamo il
    risultato. Un blocco che non tocca i bordi lascia fessure quando l'utente
    lo affianca, ed e' inutilizzabile in un level builder.

    Ritorna un report:
      {
        "ok": bool,                 # nessun problema bloccante
        "grid": [W,H,D],
        "bounds": [x0,y0,z0,x1,y1,z1],
        "fillsGrid": bool,          # tocca tutti e 6 i bordi
        "bottomComplete": float,    # frazione della faccia y=0 effettivamente piena
        "faces": {"x0":frac, ...},  # completezza di ogni faccia laterale
        "issues": [str, ...],       # problemi in italiano, pronti da mostrare
      }
    `expand_fn` permette di iniettare expand_ops senza creare una dipendenza
    circolare fra i moduli (main.py passa quella vera).
    """
    report = {"ok": False, "grid": None, "bounds": None, "fillsGrid": False,
              "bottomComplete": 0.0, "faces": {}, "issues": []}
    if not isinstance(model_data, dict):
        report["issues"].append("Modello non valido.")
        return report

    meta = model_data.get("metadata") if isinstance(model_data.get("metadata"), dict) else {}
    grid = grid_size or meta.get("grid_size")
    try:
        gw, gh, gd = int(grid[0]), int(grid[1]), int(grid[2])
    except (TypeError, ValueError, IndexError):
        report["issues"].append("Griglia non dichiarata: impossibile verificare la modularita'.")
        return report
    report["grid"] = [gw, gh, gd]

    # Serve l'insieme reale delle celle occupate.
    voxels = model_data.get("voxels")
    if (not voxels) and expand_fn:
        try:
            voxels = (expand_fn(json.loads(json.dumps(model_data))) or {}).get("voxels")
        except Exception:
            voxels = None
    if not voxels:
        report["issues"].append("Nessun voxel: blocco vuoto.")
        return report

    occupied = set()
    for v in voxels:
        try:
            occupied.add((int(v["x"]), int(v["y"]), int(v["z"])))
        except (KeyError, TypeError, ValueError):
            continue
    if not occupied:
        report["issues"].append("Nessun voxel valido.")
        return report

    xs = [c[0] for c in occupied]; ys = [c[1] for c in occupied]; zs = [c[2] for c in occupied]
    b = [min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)]
    report["bounds"] = b

    # --- 1. il blocco tocca tutti i bordi della griglia? ---
    touches = {
        "x0": b[0] <= 0, "x1": b[3] >= gw - 1,
        "y0": b[1] <= 0, "y1": b[4] >= gh - 1,
        "z0": b[2] <= 0, "z1": b[5] >= gd - 1,
    }
    report["fillsGrid"] = all(touches.values())
    if not report["fillsGrid"]:
        gaps = [k for k, ok in touches.items() if not ok]
        report["issues"].append(
            "Il blocco non arriva ai bordi %s della griglia %dx%dx%d: "
            "affiancandolo restano fessure." % (", ".join(gaps), gw, gh, gd))

    # --- 2. faccia inferiore piena? (appoggio del blocco) ---
    bottom = sum(1 for x in range(gw) for z in range(gd) if (x, 0, z) in occupied)
    report["bottomComplete"] = round(bottom / float(gw * gd), 3) if gw * gd else 0.0
    if report["bottomComplete"] < 0.95:
        report["issues"].append(
            "Faccia inferiore piena solo al %d%%: il blocco non appoggia in modo "
            "uniforme." % int(report["bottomComplete"] * 100))

    # --- 3. facce laterali: quanto sono complete nella zona occupata? ---
    h = max(1, b[4] - b[1] + 1)
    def face_fill(axis, at):
        if axis == "x":
            cells = [(at, y, z) for y in range(b[1], b[4] + 1) for z in range(gd)]
        else:
            cells = [(x, y, at) for y in range(b[1], b[4] + 1) for x in range(gw)]
        if not cells:
            return 0.0
        return round(sum(1 for c in cells if c in occupied) / float(len(cells)), 3)

    report["faces"] = {"x0": face_fill("x", 0), "x1": face_fill("x", gw - 1),
                       "z0": face_fill("z", 0), "z1": face_fill("z", gd - 1)}
    weak = [k for k, v in report["faces"].items() if v < 0.80]
    if weak:
        report["issues"].append(
            "Facce laterali incomplete (%s): la giunzione con il blocco vicino "
            "mostrera' dei buchi." % ", ".join("%s %d%%" % (k, int(report["faces"][k] * 100))
                                               for k in weak))

    report["ok"] = not report["issues"]
    return report


def extract_anchor_style(model_data):
    """
    Estrae un dizionario di stile da UN modello appena generato, per usarlo come
    ancora per i job successivi. Stesso formato di `distill_style`.
    """
    return distill_style([model_data]) if isinstance(model_data, dict) else {}


# ---------------------------------------------------------------------------
# CODA DI PACK
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# PERSISTENZA DEI PACK (idea #9)
# ---------------------------------------------------------------------------
# La coda vive in memoria: chiudendo l'app un pack da 40 minuti sparirebbe.
# Qui lo salviamo su disco (asset + manifest), il che sblocca due cose che
# nessun servizio hosted a crediti puo' offrire:
#   - riaprire un pack di settimane prima e aggiungere oggetti NELLO STESSO
#     STILE, riusando la palette salvata;
#   - rigenerare un pack dallo stesso manifest = riproducibilita' reale.

def packs_root(base_dir=None):
    """Cartella dei pack salvati. Di default accanto alle altre impostazioni."""
    if base_dir:
        root = os.path.join(base_dir, "packs")
    else:
        try:
            import settings as _s
            root = os.path.join(_s.get_appdata_dir(), "packs")
        except Exception:
            root = os.path.join(os.path.expanduser("~"), ".voxelai", "packs")
    os.makedirs(root, exist_ok=True)
    return root


def save_pack_to_disk(run, base_dir=None):
    """
    Salva un PackRun: un file JSON per asset completato + manifest.json.
    Ritorna il percorso della cartella, o None se non c'e' nulla da salvare.
    Best-effort: un errore di scrittura non deve mai far fallire un pack.
    """
    try:
        done = [j for j in run.jobs if j.status == "done" and j.result]
        if not done:
            return None

        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(run.created_at))
        folder = os.path.join(packs_root(base_dir), "%s_%s" % (stamp, run.id))
        assets_dir = os.path.join(folder, "assets")
        os.makedirs(assets_dir, exist_ok=True)

        manifest = {
            "format": "voxelai-pack",
            "version": 1,
            "id": run.id,
            "createdAt": run.created_at,
            "savedAt": time.time(),
            "options": {
                "model": run.options.get("model"),
                "gridSize": run.options.get("grid_size"),
                "variants": run.options.get("variants"),
                "enforcePalette": run.options.get("enforce_palette", True),
                "normalize": run.options.get("normalize", True),
                "notes": run.options.get("notes"),
            },
            # La palette e' la chiave della riproducibilita': con questa un pack
            # futuro puo' nascere gia' coerente con questo.
            "palette": (run.style.get("palette")
                        or (run.anchor_style or {}).get("palette") or []),
            "styleSources": run.style.get("sources", 0),
            "objects": sorted({j.object_name for j in run.jobs}),
            "assets": [],
        }

        for j in done:
            fname = "%s.json" % j.label
            with open(os.path.join(assets_dir, fname), "w", encoding="utf-8") as f:
                json.dump(j.result, f, ensure_ascii=False, separators=(",", ":"))
            manifest["assets"].append({
                "label": j.label,
                "object": j.object_name,
                "variant": j.variant,
                "file": "assets/" + fname,
            })

        with open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        return folder
    except Exception as e:
        print("[pack] salvataggio su disco fallito: %s" % e)
        return None


def list_saved_packs(base_dir=None, limit=50):
    """Elenco dei pack salvati, dal piu' recente. Solo i metadati del manifest."""
    out = []
    try:
        root = packs_root(base_dir)
        for name in sorted(os.listdir(root), reverse=True)[:limit]:
            mpath = os.path.join(root, name, "manifest.json")
            if not os.path.exists(mpath):
                continue
            try:
                with open(mpath, "r", encoding="utf-8") as f:
                    m = json.load(f)
                out.append({
                    "folder": name,
                    "id": m.get("id"),
                    "savedAt": m.get("savedAt"),
                    "assetCount": len(m.get("assets") or []),
                    "objects": m.get("objects") or [],
                    "palette": m.get("palette") or [],
                    "options": m.get("options") or {},
                })
            except (OSError, ValueError):
                continue
    except OSError:
        pass
    return out


def load_saved_pack(folder, base_dir=None, with_models=True):
    """Carica un pack salvato: manifest + (opzionale) i modelli degli asset."""
    root = packs_root(base_dir)
    # Difesa da path traversal: accetta solo un nome di cartella diretto.
    safe = os.path.basename(str(folder or ""))
    path = os.path.join(root, safe)
    mpath = os.path.join(path, "manifest.json")
    if not safe or not os.path.exists(mpath):
        return None
    with open(mpath, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    if with_models:
        for a in manifest.get("assets") or []:
            fp = os.path.join(path, a.get("file") or "")
            try:
                with open(fp, "r", encoding="utf-8") as mf:
                    a["model"] = json.load(mf)
            except (OSError, ValueError):
                a["model"] = None
    return manifest


class PackJob(object):
    """Un singolo asset da generare: (oggetto, variante)."""

    __slots__ = ("id", "object_name", "variant", "label", "status", "error",
                 "result", "attempts", "queued_at", "started_at", "finished_at",
                 "palette_remapped", "modular_report")

    def __init__(self, job_id, object_name, variant, label):
        self.id = job_id
        self.object_name = object_name
        self.variant = variant
        self.label = label
        self.status = "queued"      # queued | running | done | error | cancelled
        self.error = None
        self.result = None          # dict del modello generato (solo in memoria)
        self.attempts = 0
        self.palette_remapped = 0   # colori rimappati da enforce_palette
        self.modular_report = None  # esito della verifica blocchi modulari
        self.queued_at = time.time()
        self.started_at = None
        self.finished_at = None

    def duration(self):
        if not self.started_at:
            return None
        return (self.finished_at or time.time()) - self.started_at

    def to_dict(self, include_result=False):
        d = {
            "id": self.id,
            "objectName": self.object_name,
            "variant": self.variant,
            "label": self.label,
            "status": self.status,
            "error": self.error,
            "attempts": self.attempts,
            "duration": round(self.duration(), 1) if self.duration() else None,
            "paletteRemapped": self.palette_remapped,
            "modular": self.modular_report,
        }
        if include_result:
            d["result"] = self.result
        return d


class PackRun(object):
    """Un pack completo: lista di job + contratto di stile + stato aggregato."""

    def __init__(self, run_id, jobs, style, base_contract, options):
        self.id = run_id
        self.jobs = jobs
        self.style = style or {}
        self.base_contract = base_contract or ""
        self.options = options or {}
        self.created_at = time.time()
        self.finished_at = None
        self.cancelled = threading.Event()
        # Ancora di stile: popolata dal primo job completato quando non ci sono
        # riferimenti, cosi' i job successivi eredifano la stessa palette.
        self.anchor_style = None
        self.anchor_contract = None
        self.saved_path = None      # cartella su disco dopo il salvataggio (#9)
        self._saved = False
        self._durations = []

    # --- stato aggregato -------------------------------------------------
    def counts(self):
        c = {"queued": 0, "running": 0, "done": 0, "error": 0, "cancelled": 0}
        for j in self.jobs:
            c[j.status] = c.get(j.status, 0) + 1
        return c

    @property
    def status(self):
        if self.cancelled.is_set():
            c = self.counts()
            return "cancelled" if not c["running"] else "cancelling"
        c = self.counts()
        if c["queued"] or c["running"]:
            return "running"
        return "done"

    def record_duration(self, seconds):
        if seconds and seconds > 0:
            self._durations.append(seconds)

    def eta_seconds(self):
        """Stima grossolana del tempo residuo: media reale x job rimanenti."""
        if not self._durations:
            return None
        c = self.counts()
        remaining = c["queued"] + c["running"]
        if not remaining:
            return 0
        avg = sum(self._durations) / len(self._durations)
        conc = max(1, int(self.options.get("concurrency") or DEFAULT_CONCURRENCY))
        return int(avg * remaining / conc)

    def to_dict(self):
        return {
            "id": self.id,
            "status": self.status,
            "counts": self.counts(),
            "total": len(self.jobs),
            "jobs": [j.to_dict() for j in self.jobs],
            "etaSeconds": self.eta_seconds(),
            "styleSources": self.style.get("sources", 0),
            "paletteLocked": bool(self.style.get("palette") or (self.anchor_style or {}).get("palette")),
            "createdAt": self.created_at,
            "options": {
                "concurrency": self.options.get("concurrency", DEFAULT_CONCURRENCY),
                "gridSize": self.options.get("grid_size"),
                "model": self.options.get("model"),
            },
        }

    def find(self, job_id):
        for j in self.jobs:
            if j.id == job_id:
                return j
        return None


class PackManager(object):
    """
    Gestore dei pack. `generate_fn(prompt, model, grid_size) -> dict` viene
    iniettato dall'esterno: main.py passa il vero client Gemini, i test passano
    un generatore finto. Cosi' la coda e' verificabile senza rete ne' cookie.
    """

    def __init__(self, generate_fn, prompt_builder=None, storage_dir=None):
        self._generate = generate_fn
        self._prompt_builder = prompt_builder or _default_prompt_builder
        # Dove salvare i pack completati (#9). None = cartella impostazioni
        # dell'app. I test passano una cartella temporanea per non sporcare
        # l'ambiente reale dell'utente.
        self._storage_dir = storage_dir
        self._runs = {}
        self._lock = threading.RLock()
        self._workers = []

    # --- creazione -------------------------------------------------------
    def create_run(self, objects, variants, references=None, options=None):
        """
        objects   : lista di stringhe (es. ["Vaso fiori", "Televisore"])
        variants  : int, generazioni per oggetto
        references: lista di payload JSON parsati (puo' essere vuota)
        options   : {"model":..., "grid_size":..., "concurrency":..., "notes":...}
        """
        options = dict(options or {})
        names = [str(o).strip() for o in (objects or []) if str(o).strip()]
        if not names:
            raise ValueError("Nessun oggetto specificato per il pack.")
        if len(names) > MAX_OBJECTS:
            raise ValueError(f"Troppi oggetti: massimo {MAX_OBJECTS}.")

        try:
            variants = int(variants)
        except (TypeError, ValueError):
            variants = 1
        variants = max(1, min(MAX_VARIANTS, variants))

        if len(names) * variants > MAX_JOBS:
            raise ValueError(
                f"Troppi job ({len(names) * variants}): il massimo per pack e' {MAX_JOBS}. "
                "Riduci gli oggetti o le varianti."
            )

        conc = options.get("concurrency")
        try:
            conc = int(conc) if conc else DEFAULT_CONCURRENCY
        except (TypeError, ValueError):
            conc = DEFAULT_CONCURRENCY
        options["concurrency"] = max(1, min(MAX_CONCURRENCY, conc))

        style = distill_style(references or [])
        contract = build_style_contract(
            style,
            grid_override=_parse_grid(options.get("grid_size")),
            extra_notes=options.get("notes"),
        )

        run_id = uuid.uuid4().hex[:12]
        jobs = []
        # Ordine di accodamento: variante 1 di TUTTI gli oggetti, poi variante 2...
        # Cosi' l'utente vede subito un campione completo del pack invece di 5
        # vasi prima di vedere il primo televisore.
        for v in range(1, variants + 1):
            for name in names:
                # "Armadio :grande" -> nome pulito + taglia relativa dichiarata.
                clean, _size = parse_size_hint(name)
                label = "%s_%d" % (slugify(clean), v)
                jobs.append(PackJob("%s-%d-%s" % (slugify(clean).lower(), v, uuid.uuid4().hex[:4]),
                                    name, v, label))

        run = PackRun(run_id, jobs, style, contract, options)
        with self._lock:
            self._runs[run_id] = run
        self._spawn_workers(run)
        return run

    def get(self, run_id):
        with self._lock:
            return self._runs.get(run_id)

    def latest(self):
        with self._lock:
            if not self._runs:
                return None
            return max(self._runs.values(), key=lambda r: r.created_at)

    def cancel(self, run_id):
        run = self.get(run_id)
        if not run:
            return None
        run.cancelled.set()
        # I job non ancora partiti vengono chiusi subito; quello in corso
        # terminera' da se' (non si puo' interrompere una HTTP call in volo).
        for j in run.jobs:
            if j.status == "queued":
                j.status = "cancelled"
                j.finished_at = time.time()
        return run

    def retry(self, run_id, job_id):
        """Rimette in coda un job fallito (o tutti, se job_id e' None)."""
        run = self.get(run_id)
        if not run:
            return None
        targets = []
        if job_id:
            j = run.find(job_id)
            if j:
                targets = [j]
        else:
            targets = [j for j in run.jobs if j.status in ("error", "cancelled")]
        if not targets:
            return run
        run.cancelled.clear()
        for j in targets:
            j.status = "queued"
            j.error = None
            j.started_at = None
            j.finished_at = None
        self._spawn_workers(run)
        return run

    # --- worker ----------------------------------------------------------
    def _spawn_workers(self, run):
        """Avvia i thread worker mancanti per questo run."""
        alive = [t for t in self._workers if t.is_alive()]
        self._workers = alive
        want = run.options.get("concurrency", DEFAULT_CONCURRENCY)
        tag = "pack-%s" % run.id
        current = len([t for t in alive if t.name.startswith(tag)])
        for i in range(max(0, want - current)):
            t = threading.Thread(target=self._worker_loop, args=(run,),
                                 name="%s-w%d" % (tag, current + i), daemon=True)
            t.start()
            self._workers.append(t)

    def _next_job(self, run):
        with self._lock:
            for j in run.jobs:
                if j.status == "queued":
                    j.status = "running"
                    j.started_at = time.time()
                    return j
        return None

    def _effective_contract(self, run):
        """Contratto attivo: l'ancora ha la precedenza se non c'erano riferimenti."""
        if run.anchor_contract and not (run.style.get("palette")):
            return run.anchor_contract
        return run.base_contract

    def _worker_loop(self, run):
        while not run.cancelled.is_set():
            job = self._next_job(run)
            if job is None:
                break
            try:
                self._run_job(run, job)
            except Exception as e:  # rete di sicurezza: un worker non deve morire
                job.status = "error"
                job.error = "Errore interno worker: %s" % e
                job.finished_at = time.time()
        if run.status in ("done", "cancelled") and not run.finished_at:
            run.finished_at = time.time()
            # Persistenza (#9): il pack sopravvive alla chiusura dell'app.
            # Best-effort e sotto lock, cosi' due worker che finiscono insieme
            # non scrivono la stessa cartella due volte.
            with self._lock:
                if not getattr(run, "_saved", False):
                    run._saved = True
                    run.saved_path = save_pack_to_disk(run, base_dir=self._storage_dir)
                    if run.saved_path:
                        print("[pack] salvato in %s" % run.saved_path)

    def _run_job(self, run, job):
        contract = self._effective_contract(run)
        prompt = self._prompt_builder(job.object_name, job.variant, contract, run.options)

        last_error = None
        for attempt in range(len(RETRY_BACKOFF_SECONDS) + 1):
            if run.cancelled.is_set():
                job.status = "cancelled"
                job.finished_at = time.time()
                return
            job.attempts = attempt + 1
            try:
                data = self._generate(prompt, run.options.get("model"),
                                      run.options.get("grid_size"))
                if not isinstance(data, dict) or not (data.get("voxels") or data.get("ops")):
                    raise ValueError("Risposta AI priva di voxel/ops utilizzabili.")

                # VINCOLO CROMATICO (non semplice auspicio nel prompt): rimappa
                # i colori sulla palette del pack. Senza questo, "usa solo questi
                # colori" resta una richiesta che l'LLM disattende regolarmente e
                # il pack esce con N palette diverse.
                palette_report = None
                if run.options.get("enforce_palette", True):
                    target_palette = (run.style.get("palette")
                                      or (run.anchor_style or {}).get("palette"))
                    if target_palette:
                        try:
                            data, palette_report = enforce_palette(data, target_palette)
                        except Exception:
                            palette_report = None  # mai bloccare un job per questo

                # VERIFICA MODULARITA': in modalita' blocchi il risultato deve
                # riempire la griglia e avere facce piane, altrimenti nel level
                # builder restano fessure. Il report finisce nel job e la UI lo
                # mostra: meglio dirlo che consegnare un tileset rotto.
                if run.options.get("modular"):
                    try:
                        job.modular_report = check_modular_block(
                            data, _parse_grid(run.options.get("grid_size")),
                            expand_fn=run.options.get("expand_fn"))
                    except Exception:
                        job.modular_report = None

                # ANCORAGGIO (#4): centra su XZ e appoggia a y=0, cosi' il pack si
                # importa in un motore di gioco senza riposizionare a mano ogni pezzo.
                # In modalita' modulare l'ancoraggio e' controproducente: il blocco
                # DEVE restare a filo della griglia, non essere ricentrato.
                if run.options.get("normalize", True) and not run.options.get("modular"):
                    try:
                        data, _anchor_report = normalize_asset(
                            data, _parse_grid(run.options.get("grid_size")))
                    except Exception:
                        pass  # l'ancoraggio e' un miglioramento, mai un blocco

                # Nome leggibile e stabile: e' cio' che l'utente vede nella lista
                # ed e' anche il nome file all'export del pack.
                meta = data.setdefault("metadata", {})
                if isinstance(meta, dict):
                    meta["name"] = job.label
                    meta["pack_object"] = job.object_name
                    meta["pack_variant"] = job.variant
                if palette_report:
                    job.palette_remapped = palette_report.get("remapped", 0)

                job.result = data
                job.status = "done"
                job.finished_at = time.time()
                run.record_duration(job.duration())

                # Primo successo senza riferimenti -> diventa l'ancora di stile.
                if not run.style.get("palette") and run.anchor_style is None:
                    try:
                        anchor = extract_anchor_style(data)
                        if anchor.get("palette"):
                            run.anchor_style = anchor
                            run.anchor_contract = build_style_contract(
                                anchor,
                                grid_override=_parse_grid(run.options.get("grid_size")),
                                extra_notes=run.options.get("notes"),
                            )
                    except Exception:
                        pass  # l'ancora e' un bonus: se fallisce, si prosegue
                return

            except Exception as e:
                last_error = str(e) or e.__class__.__name__
                # Ritenta solo se l'errore sembra temporaneo: su un JSON malformato
                # riprovare 3 volte fa solo perdere tempo e quota.
                if attempt < len(RETRY_BACKOFF_SECONDS) and _looks_like_rate_limit(last_error):
                    wait = RETRY_BACKOFF_SECONDS[attempt]
                    if run.cancelled.wait(timeout=wait):
                        job.status = "cancelled"
                        job.finished_at = time.time()
                        return
                    continue
                break

        job.status = "error"
        job.error = last_error or "Errore sconosciuto"
        job.finished_at = time.time()


# ---------------------------------------------------------------------------
# Helper di prompt (default sovrascrivibile da main.py)
# ---------------------------------------------------------------------------

def _parse_grid(grid_size):
    """'32x32x32' -> [32,32,32]; passa attraverso liste gia' valide; 'auto' -> None."""
    if isinstance(grid_size, list) and len(grid_size) == 3:
        try:
            return [int(v) for v in grid_size]
        except (TypeError, ValueError):
            return None
    if isinstance(grid_size, str) and grid_size and grid_size != "auto":
        parts = grid_size.lower().split("x")
        if len(parts) == 3:
            try:
                return [int(p) for p in parts]
            except ValueError:
                return None
    return None


def _default_prompt_builder(object_name, variant, contract, options):
    """Fallback minimale: main.py inietta il vero builder basato sui template."""
    out = ["SOGGETTO DA GENERARE: %s" % object_name]
    if variant > 1:
        out.append(
            "VARIANTE %d: proponi una variante RICONOSCIBILMENTE DIVERSA nella forma "
            "e nei dettagli, ma con lo stesso stile e la stessa palette." % variant
        )
    if contract:
        out.append(contract)
    return "\n\n".join(out)


def variant_directive(object_name, variant, total_variants=None):
    """
    Istruzione anti-cloni. Senza questa, chiedere 5 volte "Vaso fiori" con lo
    stesso prompt produce 5 modelli quasi identici: l'LLM e' deterministico
    nell'intento. Ogni variante riceve un'angolazione progettuale diversa.
    """
    if variant <= 1:
        return (
            "Questa e' la variante 1 (il pezzo di riferimento del set): fai la "
            "versione piu' canonica e leggibile del soggetto."
        )
    angles = [
        "proporzioni diverse (piu' alto/stretto o piu' basso/largo)",
        "dettagli decorativi differenti, mantenendo la silhouette riconoscibile",
        "una variante 'usurata/vissuta' con asimmetrie volute",
        "una variante piu' elaborata, con un elemento aggiuntivo caratterizzante",
        "una variante minimalista, con meno elementi ma piu' definiti",
        "un orientamento o una posa leggermente diversa",
        "una sottocategoria diversa dello stesso oggetto",
        "una variante con materiali diversi, restando nella palette",
        "una variante di taglia diversa, coerente col resto del pack",
    ]
    angle = angles[(variant - 2) % len(angles)]
    tot = (" di %d" % total_variants) if total_variants else ""
    return (
        "Questa e' la variante %d%s dello stesso soggetto '%s'. Deve essere "
        "RICONOSCIBILMENTE DIVERSA dalle altre varianti: %s. "
        "NON replicare la variante 1 con piccole modifiche: cambia davvero la forma. "
        "Lo stile e la palette restano identici."
        % (variant, tot, object_name, angle)
    )
