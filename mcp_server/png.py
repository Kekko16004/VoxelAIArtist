"""PNG: codifica e decodifica in RGBA, senza dipendenze.

Perche' non Pillow. Pillow c'e' in questo ambiente ma non e' fra le dipendenze
dichiarate dell'app, e il server MCP deve poter girare dove gira l'app. Un PNG
RGBA e' zlib piu' un'intestazione: sono un centinaio di righe, contro una
dipendenza che il pacchetto PyInstaller dovrebbe portarsi dietro.

C'e' comunque una VIA RAPIDA con Pillow in decodifica, e solo li': i PNG che
scriviamo noi sono sempre RGBA a 8 bit, mentre quelli che ci arrivano possono
essere in scala di grigi, a palette, a 16 bit o interlacciati. Implementare
Adam7 a mano per un caso di ripiego sarebbe sproporzionato; quando Pillow non
c'e' si decodificano le forme non interlacciate, che sono la stragrande
maggioranza, e le altre danno un errore parlante invece di pixel a caso.
"""

import struct
import zlib

_SIG = b"\x89PNG\r\n\x1a\n"


def _chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def encode_png(buf, w, h):
    """Buffer RGBA (w*h*4 byte) -> PNG.

    Filtro 0 su ogni riga. Un filtro adattivo comprimerebbe meglio, ma queste
    immagini sono texture di pixel art fino a 128x128: il guadagno e' di qualche
    kilobyte e il costo e' un pezzo di codice in piu' da avere ragione.
    """
    if len(buf) < w * h * 4:
        raise ValueError("buffer troppo corto per %dx%d RGBA" % (w, h))
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += buf[y * stride:(y + 1) * stride]
    out = bytearray(_SIG)
    out += _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    out += _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    out += _chunk(b"IEND", b"")
    return bytes(out)


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _unfilter(data, w, h, bpp):
    stride = w * bpp
    out = bytearray(stride * h)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        ft = data[pos]
        pos += 1
        line = bytearray(data[pos:pos + stride])
        pos += stride
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                c = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(a, prev[i], c)) & 0xFF
        elif ft != 0:
            raise ValueError("filtro PNG sconosciuto: %d" % ft)
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return out


def decode_png(blob):
    """PNG -> (buffer RGBA, w, h). Solleva ValueError su un file illeggibile."""
    try:
        return _decode_pillow(blob)
    except ImportError:
        pass
    return _decode_pure(blob)


def _decode_pillow(blob):
    import io

    from PIL import Image
    with Image.open(io.BytesIO(blob)) as im:
        im = im.convert("RGBA")
        return bytearray(im.tobytes()), im.width, im.height


def _decode_pure(blob):
    if not blob.startswith(_SIG):
        raise ValueError("non e' un file PNG")
    pos = len(_SIG)
    w = h = depth = ctype = interlace = None
    idat = bytearray()
    plte = None
    trns = None
    while pos + 8 <= len(blob):
        (length,) = struct.unpack(">I", blob[pos:pos + 4])
        tag = blob[pos + 4:pos + 8]
        data = blob[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            w, h, depth, ctype, _comp, _filt, interlace = struct.unpack(
                ">IIBBBBB", data)
        elif tag == b"PLTE":
            plte = data
        elif tag == b"tRNS":
            trns = data
        elif tag == b"IDAT":
            idat += data
        elif tag == b"IEND":
            break
    if w is None:
        raise ValueError("PNG senza intestazione IHDR")
    if interlace:
        raise ValueError("PNG interlacciato: installa Pillow per leggerlo")
    if depth not in (8, 16):
        if not (depth in (1, 2, 4) and ctype == 3):
            raise ValueError("profondita' PNG non supportata: %d bit" % depth)

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(ctype)
    if channels is None:
        raise ValueError("tipo di colore PNG non supportato: %d" % ctype)

    raw = zlib.decompress(bytes(idat))
    if ctype == 3 and depth < 8:
        rows = _unpack_indexed(raw, w, h, depth)
    else:
        bpp = max(1, channels * depth // 8)
        rows = _unfilter(raw, w, h, bpp)
        if depth == 16:
            rows = bytearray(rows[i] for i in range(0, len(rows), 2))

    out = bytearray(w * h * 4)
    for i in range(w * h):
        if ctype == 6:
            out[i * 4:i * 4 + 4] = rows[i * 4:i * 4 + 4]
        elif ctype == 2:
            out[i * 4:i * 4 + 3] = rows[i * 3:i * 3 + 3]
            out[i * 4 + 3] = 255
        elif ctype == 0:
            g = rows[i]
            out[i * 4:i * 4 + 4] = bytes((g, g, g, 255))
        elif ctype == 4:
            g = rows[i * 2]
            out[i * 4:i * 4 + 4] = bytes((g, g, g, rows[i * 2 + 1]))
        elif ctype == 3:
            idx = rows[i]
            if plte is None or idx * 3 + 2 >= len(plte):
                out[i * 4:i * 4 + 4] = b"\x00\x00\x00\x00"
                continue
            out[i * 4:i * 4 + 3] = plte[idx * 3:idx * 3 + 3]
            out[i * 4 + 3] = trns[idx] if trns and idx < len(trns) else 255
    return out, w, h


def _unpack_indexed(raw, w, h, depth):
    """Righe a palette con meno di 8 bit per pixel -> un byte per pixel."""
    per_byte = 8 // depth
    stride = (w + per_byte - 1) // per_byte
    filtered = _unfilter(raw, stride, h, 1)
    mask = (1 << depth) - 1
    out = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            byte = filtered[y * stride + x // per_byte]
            shift = 8 - depth * (x % per_byte + 1)
            out[y * w + x] = (byte >> shift) & mask
    return out


def scale_nearest(buf, w, h, nw, nh):
    """Ricampionamento al vicino piu' prossimo.

    E' l'unico corretto per la pixel art: qualunque interpolazione sfoca i bordi
    netti, che sono l'intero punto di una texture di pixel art. Stessa scelta di
    `imageSmoothingEnabled = false` lato UI.
    """
    if nw == w and nh == h:
        return bytearray(buf)
    out = bytearray(nw * nh * 4)
    for y in range(nh):
        sy = min(h - 1, y * h // nh)
        for x in range(nw):
            sx = min(w - 1, x * w // nw)
            si = (sy * w + sx) * 4
            di = (y * nw + x) * 4
            out[di:di + 4] = buf[si:si + 4]
    return out


def crop(buf, w, h, x0, y0, cw, ch):
    x0 = max(0, min(w - 1, int(x0)))
    y0 = max(0, min(h - 1, int(y0)))
    cw = max(1, min(w - x0, int(cw)))
    ch = max(1, min(h - y0, int(ch)))
    out = bytearray(cw * ch * 4)
    for y in range(ch):
        si = ((y0 + y) * w + x0) * 4
        di = y * cw * 4
        out[di:di + cw * 4] = buf[si:si + cw * 4]
    return out, cw, ch


def buffer_average_color(buf, w, h):
    """Tinta media dei pixel OPACHI. E' il `color` che porta un voxel
    texturizzato, cosi' ogni percorso che pretende un hex funziona senza sapere
    che i materiali esistono. I pixel trasparenti si ESCLUDONO: includerli
    tirerebbe ogni tinta verso il nero, e una texture per meta' trasparente
    darebbe un voxel scuro che non somiglia a niente di quello che si vede."""
    r = g = b = n = 0
    for i in range(0, w * h * 4, 4):
        if buf[i + 3] < 8:
            continue
        r += buf[i]
        g += buf[i + 1]
        b += buf[i + 2]
        n += 1
    if not n:
        return "#CCCCCC"
    return "#%02X%02X%02X" % (round(r / n), round(g / n), round(b / n))


def buffer_has_alpha(buf):
    """C'e' almeno un pixel non opaco? Si misura UNA volta all'import e si porta
    appresso nel materiale (`texture.alpha`), per non ridecodificare il PNG a
    ogni costruzione del materiale."""
    return any(buf[i] < 255 for i in range(3, len(buf), 4))


def to_data_url(buf, w, h):
    """Il PNG come data URL, cioe' la forma in cui i materiali portano la texture
    (`texture.data` in 36-materials.js). Tenerla in base64 e' cio' che permette a
    un `.voxai` di essere UN file invece di un file piu' una cartella."""
    import base64
    return "data:image/png;base64," + base64.b64encode(
        encode_png(buf, w, h)).decode("ascii")


def from_data_url(url):
    """Il verso opposto. Accetta anche un base64 nudo, perche' e' cio' che si
    ottiene copiando un data URL a mano e tagliando il prefisso."""
    import base64
    s = str(url or "").strip()
    if s.startswith("data:"):
        comma = s.find(",")
        if comma < 0:
            raise ValueError("data URL malformato")
        s = s[comma + 1:]
    blob = base64.b64decode(s, validate=False)
    return decode_png(blob)
