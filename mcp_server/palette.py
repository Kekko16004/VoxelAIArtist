"""Colori: normalizzazione, distanza percettiva, costruzione della palette.

Le chiavi di palette sono le stesse di `buildObjectPayload` (07-save-payload.js):
`a`..`z`, poi `A`..`Z`, poi `c0`, `c1`, ... Non e' un dettaglio estetico: un file
salvato dal server MCP e uno salvato dalla UI devono essere confrontabili a
occhio quando si indaga un difetto, e chiavi diverse renderebbero ogni diff
illeggibile.

La distanza fra colori NON e' euclidea in RGB. Due colori a pari distanza in RGB
possono essere indistinguibili o palesemente diversi: l'occhio pesa molto il
verde e pochissimo il blu. Qui si usa la stessa ponderazione "redmean" che usa
`enforce_palette` nella coda dei pack, cosi' rimappare una palette da MCP da'
lo stesso risultato che rimapparla da un pack — se dessero risultati diversi,
lo stesso modello cambierebbe colori a seconda di come lo si e' fatto passare.
"""

_HEX_DIGITS = "0123456789abcdefABCDEF"

# a..z, A..Z: 52 chiavi da un carattere. Oltre, `c0`, `c1`, ...: due caratteri
# costano un byte in piu' ma restano leggibili, e una palette oltre 52 colori e'
# gia' un'eccezione.
_PALETTE_KEYS = ([chr(c) for c in range(ord("a"), ord("z") + 1)]
                 + [chr(c) for c in range(ord("A"), ord("Z") + 1)])


def normalize_hex(value, default=None):
    """'#RRGGBB' maiuscolo, oppure `default`.

    Accetta `#RGB` (espanso), `RRGGBB` senza cancelletto e `#RRGGBBAA` (l'alpha
    si scarta: nei voxel la trasparenza vive nel materiale, non nel colore).
    Tollerare queste forme costa poche righe e evita di scartare l'output di un
    AI per un cancelletto mancante.
    """
    if value is None:
        return default
    s = str(value).strip()
    if not s:
        return default
    if s.startswith("#"):
        s = s[1:]
    if not s or not all(c in _HEX_DIGITS for c in s):
        return default
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    elif len(s) == 4:
        s = "".join(c * 2 for c in s[:3])
    elif len(s) == 8:
        s = s[:6]
    if len(s) != 6:
        return default
    return "#" + s.upper()


def hex_to_rgb(value):
    h = normalize_hex(value, "#CCCCCC")
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


def rgb_to_hex(r, g, b):
    def clamp(v):
        return max(0, min(255, int(round(v))))
    return "#%02X%02X%02X" % (clamp(r), clamp(g), clamp(b))


def color_distance(a, b):
    """Distanza percettiva approssimata (redmean). Non e' una metrica esatta ma
    e' molto meglio dell'euclidea in RGB e non richiede una conversione in Lab."""
    r1, g1, b1 = hex_to_rgb(a)
    r2, g2, b2 = hex_to_rgb(b)
    rmean = (r1 + r2) / 2.0
    dr, dg, db = r1 - r2, g1 - g2, b1 - b2
    return ((2 + rmean / 256.0) * dr * dr
            + 4 * dg * dg
            + (2 + (255 - rmean) / 256.0) * db * db) ** 0.5


def nearest_color(value, choices):
    """Il colore di `choices` percettivamente piu' vicino a `value`."""
    target = normalize_hex(value, "#CCCCCC")
    best, best_d = None, None
    for c in choices:
        c = normalize_hex(c)
        if c is None:
            continue
        d = color_distance(target, c)
        if best_d is None or d < best_d:
            best, best_d = c, d
    return best or target


def average_color(colors):
    """Tinta media. E' il colore che un voxel texturizzato porta in `color`,
    cosi' ogni percorso che pretende un hex (.vox, .schem, le swatch, l'MTL
    senza PNG) funziona senza sapere che i materiali esistono."""
    acc = [0, 0, 0]
    n = 0
    for c in colors:
        r, g, b = hex_to_rgb(c)
        acc[0] += r
        acc[1] += g
        acc[2] += b
        n += 1
    if not n:
        return "#CCCCCC"
    return rgb_to_hex(acc[0] / n, acc[1] / n, acc[2] / n)


def luminance(value):
    """0..1 percettiva. Serve a decidere un colore di contrasto (testo su swatch,
    sfondo dell'anteprima) senza chiederlo a chi chiama."""
    r, g, b = hex_to_rgb(value)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0


def shade(value, factor):
    """Schiarisce (factor > 1) o scurisce (factor < 1) mantenendo la tinta.
    Usato dai generatori di forme per ombreggiare senza chiedere una palette."""
    r, g, b = hex_to_rgb(value)
    return rgb_to_hex(r * factor, g * factor, b * factor)


def build_palette(colors):
    """({chiave: colore}, {colore: chiave}) per la lista di colori data.

    L'ordine e' quello di PRIMA APPARIZIONE, non alfabetico: cosi' la chiave `a`
    e' il colore dominante del modello nella stragrande maggioranza dei casi
    (i voxel arrivano ordinati per y/z/x), e una palette letta a occhio racconta
    subito di che colore e' l'oggetto.
    """
    palette, key_of = {}, {}
    for c in colors:
        c = normalize_hex(c, "#CCCCCC")
        if c in key_of:
            continue
        idx = len(key_of)
        key = _PALETTE_KEYS[idx] if idx < len(_PALETTE_KEYS) else "c%d" % (idx - len(_PALETTE_KEYS))
        key_of[c] = key
        palette[key] = c
    return palette, key_of


def enforce_palette(colors, allowed):
    """Rimappa ogni colore sul piu' vicino della palette consentita.

    E' la GARANZIA di coerenza cromatica: il prompt e' un desiderio, questo e'
    un fatto. Stessa funzione concettuale di `enforce_palette` in `src/pack.py`,
    qui applicata a un modello gia' in memoria.
    """
    allowed = [normalize_hex(c) for c in allowed]
    allowed = [c for c in allowed if c]
    if not allowed:
        return {}
    cache = {}
    for c in colors:
        c = normalize_hex(c, "#CCCCCC")
        if c not in cache:
            cache[c] = nearest_color(c, allowed)
    return cache
