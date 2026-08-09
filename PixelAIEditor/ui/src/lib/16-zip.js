    // =======================================================================
    //  16 - Scrittore ZIP minimale
    //
    //  Portato da VoxelAIArtist (`ui/src/lib/29-zip.js`), invariato nella
    //  sostanza. Nessuna dipendenza esterna, nessun CDN: l'app deve funzionare
    //  offline e senza script remoti.
    //
    //  PERCHE' ESISTE. Non per risparmiare byte, ma perche' i browser BLOCCANO i
    //  download multipli: "Esporta livelli" con dieci livelli farebbe partire il
    //  primo PNG e poi un avviso di sicurezza, con gli altri nove persi. Un file
    //  solo passa sempre.
    //
    //  MODALITA' STORE (nessuna compressione): DEFLATE andrebbe scritto a mano
    //  (centinaia di righe) o preso da una libreria. Il contenuto qui sono PNG,
    //  che sono GIA' compressi: comprimerli di nuovo non toglie quasi niente, e
    //  in cambio il formato resta banale da verificare. Uno ZIP STORE lo apre
    //  Windows, macOS, Linux e qualunque strumento.
    //
    //  Riferimento: APPNOTE.TXT di PKWARE, sezioni 4.3.7 (local file header),
    //  4.3.12 (central directory), 4.3.16 (end of central directory).
    // =======================================================================

    // CRC-32, polinomio standard 0xEDB88320.
    //
    // La tabella si costruisce ALLA PRIMA CHIAMATA e non al caricamento del
    // modulo: qui i file sono frammenti di una closure sola e al livello
    // superiore ci vanno solo dichiarazioni, non lavoro. Sono 256 iterazioni di
    // niente, ma farle all'avvio significa farle anche a chi non esportera' mai
    // uno ZIP - e il costo dell'avvio e' l'unico che l'utente vede sempre.
    let _crcTable = null;

    function crc32Table() {
        if (_crcTable) return _crcTable;
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        _crcTable = t;
        return t;
    }

    function crc32(bytes) {
        const table = crc32Table();
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) {
            c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function utf8Bytes(str) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
        // Ripiego difensivo per ambienti molto vecchi.
        const s = unescape(encodeURIComponent(str));
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
        return out;
    }

    /** Data JS -> formato MS-DOS dello ZIP (due parole da 16 bit). */
    function dosDateTime(d) {
        const year = Math.max(1980, d.getFullYear());
        return {
            time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5)
                | ((Math.floor(d.getSeconds() / 2)) & 0x1F),
            date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5)
                | (d.getDate() & 0x1F),
        };
    }

    /**
     * Rende unico il nome di una voce dentro l'archivio.
     *
     * Due livelli possono chiamarsi allo stesso modo - "Livello 1" duplicato lo
     * fa da se' - e uno ZIP con due voci omonime NON e' un errore per il
     * formato: lo scompattatore semplicemente sovrascrive la prima con la
     * seconda, e all'utente sparisce un livello senza un messaggio. Il suffisso
     * numerico e' l'unica cosa che glielo evita.
     *
     * `used` e' un Set che il chiamante tiene per tutta la costruzione.
     */
    function zipUniqueName(name, used) {
        let base = String(name || 'file');
        let ext = '';
        const dot = base.lastIndexOf('.');
        if (dot > 0) { ext = base.slice(dot); base = base.slice(0, dot); }
        let candidate = base + ext;
        let i = 2;
        while (used.has(candidate.toLowerCase())) {
            candidate = base + '-' + i + ext;
            i++;
        }
        used.add(candidate.toLowerCase());
        return candidate;
    }

    /**
     * Crea un Blob ZIP da una lista di file.
     * `files` = [{ name: "cartella/file.png", data: string | Uint8Array }]
     * I nomi possono contenere '/' per creare cartelle.
     */
    function createZipBlob(files) {
        const entries = [];
        const chunks = [];
        let offset = 0;
        const now = dosDateTime(new Date());

        // --- 1. Local file header + dati, per ogni file ---
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const nameBytes = utf8Bytes(f.name);
            const data = (f.data instanceof Uint8Array) ? f.data : utf8Bytes(String(f.data));
            const crc = crc32(data);

            const header = new Uint8Array(30 + nameBytes.length);
            const hv = new DataView(header.buffer);
            hv.setUint32(0, 0x04034b50, true);   // firma local file header
            hv.setUint16(4, 20, true);           // versione minima (2.0)
            hv.setUint16(6, 0x0800, true);       // flag: nomi in UTF-8
            hv.setUint16(8, 0, true);            // metodo 0 = STORE
            hv.setUint16(10, now.time, true);
            hv.setUint16(12, now.date, true);
            hv.setUint32(14, crc, true);
            hv.setUint32(18, data.length, true); // dimensione compressa
            hv.setUint32(22, data.length, true); // dimensione reale
            hv.setUint16(26, nameBytes.length, true);
            hv.setUint16(28, 0, true);           // extra field: assente
            header.set(nameBytes, 30);

            entries.push({ nameBytes: nameBytes, crc: crc, size: data.length, offset: offset });
            chunks.push(header, data);
            offset += header.length + data.length;
        }

        // --- 2. Central directory ---
        const centralStart = offset;
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const rec = new Uint8Array(46 + e.nameBytes.length);
            const rv = new DataView(rec.buffer);
            rv.setUint32(0, 0x02014b50, true);   // firma central directory
            rv.setUint16(4, 20, true);           // versione di creazione
            rv.setUint16(6, 20, true);           // versione minima
            rv.setUint16(8, 0x0800, true);       // flag UTF-8
            rv.setUint16(10, 0, true);           // STORE
            rv.setUint16(12, now.time, true);
            rv.setUint16(14, now.date, true);
            rv.setUint32(16, e.crc, true);
            rv.setUint32(20, e.size, true);
            rv.setUint32(24, e.size, true);
            rv.setUint16(28, e.nameBytes.length, true);
            rv.setUint32(42, e.offset, true);    // offset del local header
            rec.set(e.nameBytes, 46);
            chunks.push(rec);
            offset += rec.length;
        }

        // --- 3. End of central directory ---
        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, entries.length, true);         // voci su questo disco
        ev.setUint16(10, entries.length, true);        // voci totali
        ev.setUint32(12, offset - centralStart, true); // dimensione directory
        ev.setUint32(16, centralStart, true);          // offset directory
        chunks.push(end);

        return new Blob(chunks, { type: 'application/zip' });
    }
