            // ===== SCRITTORE ZIP MINIMALE (idea #5) =====
            // Frammento dello scope condiviso: nessun import/export, nessuna dipendenza
            // esterna (niente JSZip da CDN: l'app deve funzionare anche offline, e in
            // ambiente desktop non vogliamo aggiungere script remoti).
            //
            // Scrive ZIP in modalita' STORE (nessuna compressione). Perche' STORE:
            //   - la compressione DEFLATE andrebbe implementata a mano (centinaia di
            //     righe) o presa da una libreria esterna;
            //   - i contenuti sono .vox/.glb (gia' binari compatti) e testo OBJ/JSON;
            //     l'utente scompatta subito il pacchetto, quindi la dimensione sul
            //     disco conta poco rispetto all'affidabilita' del formato.
            // Uno ZIP STORE e' apribile da Windows, macOS, Linux e da qualunque tool.
            //
            // Riferimento: APPNOTE.TXT di PKWARE, sezioni 4.3.7 (local file header),
            // 4.3.12 (central directory) e 4.3.16 (end of central directory).

            // CRC-32 (polinomio standard 0xEDB88320). Tabella calcolata una volta sola.
            const CRC32_TABLE = (function () {
                const t = new Uint32Array(256);
                for (let n = 0; n < 256; n++) {
                    let c = n;
                    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                    t[n] = c >>> 0;
                }
                return t;
            })();

            function crc32(bytes) {
                let c = 0xFFFFFFFF;
                for (let i = 0; i < bytes.length; i++) {
                    c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
                }
                return (c ^ 0xFFFFFFFF) >>> 0;
            }

            function utf8Bytes(str) {
                // TextEncoder e' presente in ogni browser moderno e nella webview Qt.
                if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
                // Fallback difensivo per ambienti molto vecchi.
                const s = unescape(encodeURIComponent(str));
                const out = new Uint8Array(s.length);
                for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
                return out;
            }

            // Converte una data JS nel formato MS-DOS usato dallo ZIP (2 x 16 bit).
            function dosDateTime(d) {
                const year = Math.max(1980, d.getFullYear());
                return {
                    time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5)
                        | ((Math.floor(d.getSeconds() / 2)) & 0x1F),
                    date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5)
                        | (d.getDate() & 0x1F)
                };
            }

            /**
             * Crea un Blob ZIP da una lista di file.
             * `files` = [{ name: "cartella/file.txt", data: string | Uint8Array }]
             * I nomi possono contenere '/' per creare cartelle.
             */
            function createZipBlob(files) {
                const entries = [];
                const chunks = [];
                let offset = 0;
                const now = dosDateTime(new Date());

                // --- 1. Local file header + dati, per ogni file ---
                for (const f of files) {
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
                for (const e of entries) {
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
                ev.setUint16(8, entries.length, true);        // voci su questo disco
                ev.setUint16(10, entries.length, true);       // voci totali
                ev.setUint32(12, offset - centralStart, true); // dimensione directory
                ev.setUint32(16, centralStart, true);          // offset directory
                chunks.push(end);

                return new Blob(chunks, { type: 'application/zip' });
            }

            // Scarica un Blob con un nome file, riusando il meccanismo del resto
            // dell'app (link temporaneo + revoca dell'URL).
            function downloadBlob(blob, filename) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                // Ritardo prima della revoca: alcuni browser annullano il download se
                // l'URL sparisce troppo presto.
                setTimeout(() => URL.revokeObjectURL(url), 2000);
            }
