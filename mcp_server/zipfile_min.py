"""ZIP in sola modalita' STORE, senza dipendenze.

Perche' non `zipfile`. Si potrebbe, ed e' nella stdlib. Ma la UI ha gia' il suo
scrittore ZIP a mano (`ui/src/lib/29-zip.js`) perche' nel browser non c'era
alternativa, e i due devono produrre archivi indistinguibili: se il pacchetto
dell'MCP e quello della GUI si aprissero in modo diverso in Blender, il tempo
speso a capire perche' sarebbe molto piu' di queste sessanta righe.

STORE e non DEFLATE: i PNG di pixel art sono gia' compressi e l'OBJ e' testo
piccolo. Il guadagno sarebbe qualche percento, e store rende l'archivio
ispezionabile con qualunque cosa.
"""

import struct
import zlib


def _dos_time(ts=None):
    """(data, ora) nel formato DOS. Senza timestamp si usa una data FISSA e non
    l'ora corrente: cosi' esportare due volte lo stesso modello da' due file
    identici byte per byte, e un diff dice se e' cambiato il modello invece di
    dire sempre di si'."""
    if ts is None:
        return (0x21, 0x0000)               # 1980-01-01 00:00
    import time
    t = time.localtime(ts)
    date = ((t.tm_year - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday
    tm = (t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2)
    return (date, tm)


def build_zip(entries, timestamp=None):
    """[(nome, byte)] -> archivio ZIP.

    I nomi usano SEMPRE `/`, mai `\\`: uno ZIP con separatori Windows si apre
    su Windows e mostra un file solo con le barre nel nome ovunque altro.
    """
    date, tm = _dos_time(timestamp)
    out = bytearray()
    central = bytearray()
    for name, data in entries:
        name = str(name).replace("\\", "/").lstrip("/")
        nb = name.encode("utf-8")
        if isinstance(data, str):
            data = data.encode("utf-8")
        data = bytes(data)
        crc = zlib.crc32(data) & 0xFFFFFFFF
        offset = len(out)
        # flag bit 11 = nome in UTF-8. Senza, un nome accentato diventa
        # illeggibile negli estrattori che presumono CP437.
        header = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0x0800, 0,
                             tm, date, crc, len(data), len(data), len(nb), 0)
        out += header + nb + data
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20,
                               0x0800, 0, tm, date, crc, len(data), len(data),
                               len(nb), 0, 0, 0, 0, 0, offset) + nb
    cd_offset = len(out)
    out += central
    out += struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries),
                       len(entries), len(central), cd_offset, 0)
    return bytes(out)
