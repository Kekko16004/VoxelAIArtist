            /* ===== T-formats: Import/Export .vox (MagicaVoxel) e .schem (Minecraft) =====
             * Encoder/decoder di due formati BINARI + i relativi pulsanti UI.
             *
             * NOTA ENDIANNESS (critica):
             *   - .vox   : RIFF-like, interi LITTLE-endian.
             *   - .schem : NBT, interi BIG-endian (gli array di byte no, sono grezzi).
             * Gestiamo entrambi ESPLICITAMENTE con DataView.
             *
             * NOTA ASSI .vox:
             *   Nel nostro editor l'asse verticale (up) e' Y. In MagicaVoxel l'up e' Z.
             *   Conversione al'export:  vox=(x, z, y)   (il nostro Y-up finisce su vox Z-up)
             *   Conversione all'import:  our=(x, z, y)   (l'inverso: vox (vx,vy,vz) -> our (vx,vz,vy))
             *   Il round-trip e' quindi esatto.
             *
             * Esportiamo i voxel dell'OGGETTO ATTIVO (come fanno gia' OBJ e GLB).
             * LIMITE noto: gli altri oggetti della scena non sono inclusi in .vox/.schem. */

            // --- piccoli helper colore -------------------------------------------
            function _fmtHex2(n) { const s = (n & 0xff).toString(16); return s.length === 1 ? '0' + s : s; }
            function fmtHexRGB(r, g, b) { return ('#' + _fmtHex2(r) + _fmtHex2(g) + _fmtHex2(b)).toUpperCase(); }
            function hexToRGB(hex) {
                const h = String(hex || '#CCCCCC').replace('#', '');
                return [parseInt(h.substring(0, 2), 16) || 0, parseInt(h.substring(2, 4), 16) || 0, parseInt(h.substring(4, 6), 16) || 0];
            }

            // Voxel esportabili: quelli dell'oggetto attivo (coerente con OBJ/GLB).
            function getFormatExportVoxels() {
                return (currentModelData && currentModelData.voxels) ? currentModelData.voxels : [];
            }
            function getFormatExportName() {
                const meta = (currentModelData && currentModelData.metadata) || {};
                return (meta.name || 'voxel_model').replace(/\s+/g, '_');
            }

            /* =========================================================================
             * MagicaVoxel .vox
             * =======================================================================*/

            // Writer di byte con auto-grow, tutto LITTLE-endian per .vox.
            function ByteWriter() {
                this.buf = new Uint8Array(1024);
                this.len = 0;
            }
            ByteWriter.prototype._ensure = function (n) {
                if (this.len + n <= this.buf.length) return;
                let cap = this.buf.length;
                while (cap < this.len + n) cap *= 2;
                const nb = new Uint8Array(cap);
                nb.set(this.buf.subarray(0, this.len));
                this.buf = nb;
            };
            ByteWriter.prototype.u8 = function (v) { this._ensure(1); this.buf[this.len++] = v & 0xff; };
            ByteWriter.prototype.i32 = function (v) {
                this._ensure(4);
                // little-endian
                this.buf[this.len++] = v & 0xff;
                this.buf[this.len++] = (v >>> 8) & 0xff;
                this.buf[this.len++] = (v >>> 16) & 0xff;
                this.buf[this.len++] = (v >>> 24) & 0xff;
            };
            ByteWriter.prototype.str4 = function (s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); };
            ByteWriter.prototype.bytes = function (arr) { this._ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; };
            ByteWriter.prototype.result = function () { return this.buf.subarray(0, this.len); };

            // Costruisce un chunk .vox: id[4] + i32 lenContent + i32 lenChildren + content + children.
            function voxChunk(id, content, children) {
                const w = new ByteWriter();
                w.str4(id);
                w.i32(content ? content.length : 0);
                w.i32(children ? children.length : 0);
                if (content) w.bytes(content);
                if (children) w.bytes(children);
                return w.result();
            }

            // Encoder .vox. Ritorna un Uint8Array pronto per il download.
            function encodeVox(voxels) {
                voxels = voxels || [];
                // 1) Normalizza le coordinate a origine 0 (MagicaVoxel non ammette negativi).
                let minX = Infinity, minY = Infinity, minZ = Infinity;
                voxels.forEach(v => {
                    if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z;
                });
                if (!voxels.length) { minX = 0; minY = 0; minZ = 0; }

                // 2) Palette: fino a 255 colori unici (indici 1..255). Se ce ne sono di piu',
                //    i colori extra vengono mappati al piu' vicino gia' presente (quantizzazione).
                //    LIMITE noto: >255 colori -> perdita di fedelta' cromatica.
                const paletteHex = [];       // paletteHex[i] = "#RRGGBB" per colorIndex i+1
                const hexToIndex = new Map(); // "#RRGGBB" -> colorIndex (1..255)
                function nearestIndex(rgb) {
                    let best = 1, bestD = Infinity;
                    for (let i = 0; i < paletteHex.length; i++) {
                        const p = hexToRGB(paletteHex[i]);
                        const d = (p[0] - rgb[0]) ** 2 + (p[1] - rgb[1]) ** 2 + (p[2] - rgb[2]) ** 2;
                        if (d < bestD) { bestD = d; best = i + 1; }
                    }
                    return best;
                }
                function colorIndexFor(hex) {
                    const H = String(hex).toUpperCase();
                    if (hexToIndex.has(H)) return hexToIndex.get(H);
                    if (paletteHex.length < 255) {
                        paletteHex.push(H);
                        const idx = paletteHex.length; // 1-based
                        hexToIndex.set(H, idx);
                        return idx;
                    }
                    return nearestIndex(hexToRGB(H)); // palette piena -> mappa al piu' vicino
                }

                // 3) Voxel convertiti: asse verticale Y (nostro) -> Z (vox).  our(x,y,z) -> vox(x, z, y)
                const outVox = [];
                let maxVX = 0, maxVY = 0, maxVZ = 0;
                voxels.forEach(v => {
                    const ci = colorIndexFor(v.color || '#CCCCCC');
                    const vx = Math.round(v.x - minX);
                    const vy = Math.round(v.z - minZ); // vox X,Y = pianta orizzontale
                    const vz = Math.round(v.y - minY); // vox Z = verticale (nostro Y)
                    if (vx > maxVX) maxVX = vx; if (vy > maxVY) maxVY = vy; if (vz > maxVZ) maxVZ = vz;
                    outVox.push([vx, vy, vz, ci]);
                });
                const sizeX = Math.min(256, maxVX + 1);
                const sizeY = Math.min(256, maxVY + 1);
                const sizeZ = Math.min(256, maxVZ + 1);

                // 4) Chunk SIZE (3x i32) + XYZI (i32 count + 4 byte/voxel).
                const sizeW = new ByteWriter();
                sizeW.i32(sizeX); sizeW.i32(sizeY); sizeW.i32(sizeZ);
                const sizeChunk = voxChunk('SIZE', sizeW.result(), null);

                const xyziW = new ByteWriter();
                xyziW.i32(outVox.length);
                outVox.forEach(v => { xyziW.u8(v[0]); xyziW.u8(v[1]); xyziW.u8(v[2]); xyziW.u8(v[3]); });
                const xyziChunk = voxChunk('XYZI', xyziW.result(), null);

                // 5) Chunk RGBA: 256 entry (r,g,b,a). palette[i] -> colorIndex i+1 (off-by-one).
                //    L'indice 0 non e' usato: la 1a entry qui corrisponde a colorIndex 1.
                const rgbaW = new ByteWriter();
                for (let i = 0; i < 256; i++) {
                    if (i < paletteHex.length) {
                        const c = hexToRGB(paletteHex[i]);
                        rgbaW.u8(c[0]); rgbaW.u8(c[1]); rgbaW.u8(c[2]); rgbaW.u8(255);
                    } else {
                        rgbaW.u8(0); rgbaW.u8(0); rgbaW.u8(0); rgbaW.u8(0);
                    }
                }
                const rgbaChunk = voxChunk('RGBA', rgbaW.result(), null);

                // 6) MAIN: content vuoto, children = SIZE+XYZI+RGBA.
                const childrenW = new ByteWriter();
                childrenW.bytes(sizeChunk); childrenW.bytes(xyziChunk); childrenW.bytes(rgbaChunk);
                const mainChunk = voxChunk('MAIN', new Uint8Array(0), childrenW.result());

                // 7) Header: "VOX " + i32 version(150) + MAIN.
                const out = new ByteWriter();
                out.str4('VOX ');
                out.i32(150);
                out.bytes(mainChunk);
                return out.result();
            }

            // Palette di default MagicaVoxel (usata all'import se manca il chunk RGBA).
            // Formato 0xAABBGGRR little-endian gia' srotolato in [r,g,b].
            const VOX_DEFAULT_PALETTE = (function () {
                // Palette compatta "safe": una rampa di 255 colori. Non e' la palette
                // esatta di MagicaVoxel ma e' un fallback ragionevole (documentato) usato
                // solo quando un .vox non porta il proprio chunk RGBA (raro).
                const p = [];
                for (let i = 0; i < 256; i++) {
                    const r = (i * 7) & 0xff, g = (i * 13) & 0xff, b = (i * 23) & 0xff;
                    p.push([r, g, b]);
                }
                return p;
            })();

            // Decoder .vox. Ritorna { voxels:[{x,y,z,color}] } (primo modello se multi).
            function decodeVox(arrayBuffer) {
                const dv = new DataView(arrayBuffer);
                const bytes = new Uint8Array(arrayBuffer);
                if (bytes.length < 8) throw new Error(t('formats.voxTooShort'));
                const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
                if (magic !== 'VOX ') throw new Error(t('formats.voxBadMagic'));
                // version = dv.getInt32(4, true) -- non serve validarla.

                // Il primo chunk (a offset 8) e' MAIN; ne scandiamo i children.
                // Struttura chunk: id[4] + i32 lenContent + i32 lenChildren + content + children.
                let models = [];       // ognuno: { size:[x,y,z], vox:[[x,y,z,ci]...] }
                let palette = null;    // [ [r,g,b], ... ] 1-based logico (indice 0 = colorIndex 1)

                function walk(offset, end) {
                    while (offset + 12 <= end) {
                        const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
                        const nContent = dv.getInt32(offset + 4, true);
                        const nChildren = dv.getInt32(offset + 8, true);
                        const contentStart = offset + 12;
                        const childrenStart = contentStart + nContent;
                        const next = childrenStart + nChildren;
                        if (id === 'SIZE') {
                            const sx = dv.getInt32(contentStart, true);
                            const sy = dv.getInt32(contentStart + 4, true);
                            const sz = dv.getInt32(contentStart + 8, true);
                            models.push({ size: [sx, sy, sz], vox: [] });
                        } else if (id === 'XYZI') {
                            const num = dv.getInt32(contentStart, true);
                            const list = [];
                            let p = contentStart + 4;
                            for (let i = 0; i < num; i++) {
                                list.push([bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]);
                                p += 4;
                            }
                            if (models.length) models[models.length - 1].vox = list;
                            else models.push({ size: null, vox: list });
                        } else if (id === 'RGBA') {
                            palette = [];
                            let p = contentStart;
                            for (let i = 0; i < 256; i++) {
                                palette.push([bytes[p], bytes[p + 1], bytes[p + 2]]); // ignoriamo alpha
                                p += 4;
                            }
                        } else if (id === 'MAIN') {
                            // MAIN ha content vuoto: scendi nei children.
                            walk(childrenStart, next);
                        }
                        // altri chunk (PACK, nTRN, MATL, ...) ignorati.
                        offset = next;
                    }
                }
                // Parte dal primo chunk (MAIN) subito dopo l'header di 8 byte.
                walk(8, bytes.length);

                if (!models.length) throw new Error(t('formats.voxNoModels'));
                const m = models[0]; // importiamo il PRIMO modello. LIMITE: multi-modello non fuso.

                // Palette: RGBA se presente, altrimenti fallback default. colorIndex n -> palette[n-1].
                const pal = palette || VOX_DEFAULT_PALETTE;
                const voxels = [];
                m.vox.forEach(v => {
                    const [vx, vy, vz, ci] = v;
                    const rgb = pal[(ci - 1) & 0xff] || [204, 204, 204];
                    // Inverso della conversione assi: vox(x,y,z) -> our(x, z, y)
                    voxels.push({ x: vx, y: vz, z: vy, color: fmtHexRGB(rgb[0], rgb[1], rgb[2]) });
                });
                return { metadata: {}, voxels };
            }

            /* =========================================================================
             * Minecraft .schem (Sponge Schematic v2)
             *
             * Struttura: NBT (interi BIG-endian) compresso gzip.
             *   root compound (nome "Schematic"):
             *     Version(int)=2, DataVersion(int)=2975 (Minecraft 1.18.2),
             *     Width/Height/Length(short), Palette(compound stato->id int),
             *     PaletteMax(int), BlockData(byte array, indici palette come varint LEB128
             *     in ordine  index = x + z*Width + y*Width*Length),
             *     Offset(int array [x,y,z]).
             *
             * GZIP: usiamo pako se GIA' caricato (non lo e'); altrimenti CompressionStream
             * ('gzip') se disponibile (QtWebEngine/Chromium moderno lo espone). Se nessuno
             * dei due c'e', produciamo un .schem NON compresso e lo segnaliamo all'utente
             * (alcuni tool leggono NBT non compresso). Vedi encodeSchem() piu' sotto.
             * =======================================================================*/

            // --- Encoder NBT minimale (BIG-endian) -------------------------------
            // Tag id: 1=Byte 2=Short 3=Int 4=Long 7=ByteArray 8=String 9=List
            //         10=Compound 11=IntArray.
            function NBTWriter() { this.w = new ByteWriter(); }
            NBTWriter.prototype._i16 = function (v) { this.w.u8((v >> 8) & 0xff); this.w.u8(v & 0xff); };
            NBTWriter.prototype._i32be = function (v) {
                this.w.u8((v >>> 24) & 0xff); this.w.u8((v >>> 16) & 0xff);
                this.w.u8((v >>> 8) & 0xff); this.w.u8(v & 0xff);
            };
            NBTWriter.prototype._name = function (s) {
                // UTF-8 modificato: qui usiamo ASCII (i nomi/blocchi sono ASCII) -> ok.
                const bytes = [];
                for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
                this._i16(bytes.length);
                this.w.bytes(new Uint8Array(bytes));
            };
            // Scrive un tag "named" (id + nome + payload).
            NBTWriter.prototype.tagByte = function (name, v) { this.w.u8(1); this._name(name); this.w.u8(v & 0xff); };
            NBTWriter.prototype.tagShort = function (name, v) { this.w.u8(2); this._name(name); this._i16(v); };
            NBTWriter.prototype.tagInt = function (name, v) { this.w.u8(3); this._name(name); this._i32be(v); };
            NBTWriter.prototype.tagString = function (name, v) { this.w.u8(8); this._name(name); this._name(v); };
            NBTWriter.prototype.tagByteArray = function (name, arr) {
                this.w.u8(7); this._name(name); this._i32be(arr.length); this.w.bytes(arr);
            };
            NBTWriter.prototype.tagIntArray = function (name, arr) {
                this.w.u8(11); this._name(name); this._i32be(arr.length);
                for (let i = 0; i < arr.length; i++) this._i32be(arr[i]);
            };
            // Apre un compound named (i tag successivi vanno "dentro"); chiudi con endCompound().
            NBTWriter.prototype.beginCompound = function (name) { this.w.u8(10); this._name(name); };
            NBTWriter.prototype.endCompound = function () { this.w.u8(0); };
            // Compound INTERNO senza header (per Palette): scrive solo i figli + TAG_End.
            NBTWriter.prototype.beginCompoundTag = function (name) { this.w.u8(10); this._name(name); };
            NBTWriter.prototype.result = function () { return this.w.result(); };

            // --- Tabella mapping colore -> blocco Minecraft ----------------------
            // Blocchi solidi colorati (concrete/wool + alcuni naturali) con il loro RGB
            // approssimato. Per ogni voxel scegliamo il blocco col colore piu' vicino
            // (distanza euclidea RGB). Voxel assente = minecraft:air.
            // Documentata e volutamente compatta: copre l'intera ruota colori base.
            const MC_BLOCK_COLORS = [
                ['minecraft:white_concrete', 207, 213, 214],
                ['minecraft:light_gray_concrete', 125, 125, 115],
                ['minecraft:gray_concrete', 54, 57, 61],
                ['minecraft:black_concrete', 8, 10, 15],
                ['minecraft:red_concrete', 142, 32, 32],
                ['minecraft:orange_concrete', 224, 97, 0],
                ['minecraft:yellow_concrete', 240, 175, 21],
                ['minecraft:lime_concrete', 94, 168, 24],
                ['minecraft:green_concrete', 73, 91, 36],
                ['minecraft:cyan_concrete', 21, 119, 136],
                ['minecraft:light_blue_concrete', 36, 137, 199],
                ['minecraft:blue_concrete', 45, 47, 143],
                ['minecraft:purple_concrete', 100, 32, 156],
                ['minecraft:magenta_concrete', 169, 48, 159],
                ['minecraft:pink_concrete', 214, 101, 143],
                ['minecraft:brown_concrete', 96, 60, 32],
                ['minecraft:dirt', 134, 96, 67],
                ['minecraft:oak_planks', 162, 131, 79],
                ['minecraft:sand', 219, 207, 163],
                ['minecraft:stone', 125, 125, 125],
                ['minecraft:cobblestone', 122, 122, 122],
                ['minecraft:snow_block', 249, 254, 254],
                ['minecraft:gold_block', 246, 208, 62],
                ['minecraft:redstone_block', 175, 24, 5],
                ['minecraft:emerald_block', 42, 203, 90],
                ['minecraft:lapis_block', 31, 67, 140],
                ['minecraft:diamond_block', 100, 224, 216]
            ];
            function nearestMCBlock(hex) {
                const rgb = hexToRGB(hex);
                let best = MC_BLOCK_COLORS[0][0], bestD = Infinity;
                for (let i = 0; i < MC_BLOCK_COLORS.length; i++) {
                    const b = MC_BLOCK_COLORS[i];
                    const d = (b[1] - rgb[0]) ** 2 + (b[2] - rgb[1]) ** 2 + (b[3] - rgb[2]) ** 2;
                    if (d < bestD) { bestD = d; best = b[0]; }
                }
                return best;
            }

            // Varint LEB128 (unsigned) usato da BlockData.
            function writeVarint(byteArr, value) {
                value = value >>> 0;
                while (true) {
                    if ((value & ~0x7f) === 0) { byteArr.push(value); return; }
                    byteArr.push((value & 0x7f) | 0x80);
                    value >>>= 7;
                }
            }
            function readVarint(bytes, offsetObj) {
                let value = 0, shift = 0, b;
                do {
                    b = bytes[offsetObj.o++];
                    value |= (b & 0x7f) << shift;
                    shift += 7;
                } while (b & 0x80);
                return value >>> 0;
            }

            // Encoder .schem: costruisce l'NBT (non compresso). Ritorna Uint8Array NBT grezzo.
            function encodeSchemNBT(voxels) {
                voxels = voxels || [];
                // Bounding box + normalizzazione a 0.
                let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                voxels.forEach(v => {
                    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
                    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
                    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
                });
                if (!voxels.length) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0; }
                const W = maxX - minX + 1, H = maxY - minY + 1, L = maxZ - minZ + 1;

                // Mappa voxel -> blocco MC, costruendo la palette (stato blocco -> id).
                const palette = { 'minecraft:air': 0 };
                let paletteNext = 1;
                function paletteId(block) {
                    if (palette[block] === undefined) palette[block] = paletteNext++;
                    return palette[block];
                }
                const voxBlock = new Map();
                voxels.forEach(v => {
                    const block = nearestMCBlock(v.color || '#CCCCCC');
                    paletteId(block);
                    voxBlock.set(`${Math.round(v.x - minX)},${Math.round(v.y - minY)},${Math.round(v.z - minZ)}`, block);
                });

                // BlockData: per ogni cella (ordine y,z,x) scrive l'id palette come varint.
                const blockData = [];
                for (let y = 0; y < H; y++) {
                    for (let z = 0; z < L; z++) {
                        for (let x = 0; x < W; x++) {
                            const block = voxBlock.get(`${x},${y},${z}`) || 'minecraft:air';
                            writeVarint(blockData, palette[block]);
                        }
                    }
                }

                // Serializza l'NBT (Sponge v2).
                const nbt = new NBTWriter();
                nbt.beginCompound('Schematic');
                nbt.tagInt('Version', 2);
                nbt.tagInt('DataVersion', 2975); // Minecraft 1.18.2
                nbt.tagShort('Width', W);
                nbt.tagShort('Height', H);
                nbt.tagShort('Length', L);
                nbt.tagInt('PaletteMax', paletteNext);
                nbt.beginCompound('Palette');
                Object.keys(palette).forEach(block => nbt.tagInt(block, palette[block]));
                nbt.endCompound();
                nbt.tagByteArray('BlockData', new Uint8Array(blockData));
                nbt.tagIntArray('Offset', [0, 0, 0]);
                nbt.endCompound();
                return nbt.result();
            }

            // gzip (best-effort): pako -> CompressionStream -> null (nessuna compressione).
            async function gzipBytes(uint8) {
                if (typeof pako !== 'undefined' && pako && typeof pako.gzip === 'function') {
                    return { data: pako.gzip(uint8), gzipped: true };
                }
                if (typeof CompressionStream !== 'undefined') {
                    try {
                        const cs = new CompressionStream('gzip');
                        const writer = cs.writable.getWriter();
                        writer.write(uint8); writer.close();
                        const ab = await new Response(cs.readable).arrayBuffer();
                        return { data: new Uint8Array(ab), gzipped: true };
                    } catch (e) { /* cade nel fallback non compresso */ }
                }
                return { data: uint8, gzipped: false };
            }

            // gunzip (best-effort) per l'import: pako -> DecompressionStream -> passthrough.
            async function gunzipBytes(uint8) {
                // rileva l'header gzip (0x1f 0x8b); se assente ritorna com'e' (NBT nudo).
                if (!(uint8[0] === 0x1f && uint8[1] === 0x8b)) return uint8;
                if (typeof pako !== 'undefined' && pako && typeof pako.ungzip === 'function') {
                    return pako.ungzip(uint8);
                }
                if (typeof DecompressionStream !== 'undefined') {
                    const ds = new DecompressionStream('gzip');
                    const writer = ds.writable.getWriter();
                    writer.write(uint8); writer.close();
                    const ab = await new Response(ds.readable).arrayBuffer();
                    return new Uint8Array(ab);
                }
                throw new Error(t('formats.schemNoGunzip'));
            }

            // --- Decoder NBT minimale (BIG-endian) per l'import .schem ------------
            function decodeNBT(bytes) {
                const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let o = 0;
                function i16() { const v = dv.getInt16(o, false); o += 2; return v; }
                function i32() { const v = dv.getInt32(o, false); o += 4; return v; }
                function name() { const len = dv.getUint16(o, false); o += 2; let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[o++]); return s; }
                function payload(type) {
                    switch (type) {
                        case 1: return bytes[o++]; // Byte
                        case 2: return i16();      // Short
                        case 3: return i32();      // Int
                        case 4: { const hi = i32(), lo = i32(); return hi * 4294967296 + (lo >>> 0); } // Long (approx)
                        case 5: { const v = dv.getFloat32(o, false); o += 4; return v; }
                        case 6: { const v = dv.getFloat64(o, false); o += 8; return v; }
                        case 7: { const len = i32(); const arr = bytes.subarray(o, o + len); o += len; return arr; } // ByteArray
                        case 8: return name(); // String
                        case 9: { const et = bytes[o++]; const len = i32(); const arr = []; for (let i = 0; i < len; i++) arr.push(payload(et)); return arr; } // List
                        case 10: { const obj = {}; while (true) { const t = bytes[o++]; if (t === 0) break; const nm = name(); obj[nm] = payload(t); } return obj; } // Compound
                        case 11: { const len = i32(); const arr = []; for (let i = 0; i < len; i++) arr.push(i32()); return arr; } // IntArray
                        case 12: { const len = i32(); const arr = []; for (let i = 0; i < len; i++) { const hi = i32(), lo = i32(); arr.push(hi * 4294967296 + (lo >>> 0)); } return arr; } // LongArray
                        default: throw new Error(t('formats.nbtUnsupportedTag', { tag: type }));
                    }
                }
                const rootType = bytes[o++];
                if (rootType !== 10) throw new Error(t('formats.nbtRootNotCompound'));
                name(); // nome root (di solito "Schematic")
                return payload(10);
            }

            // Decoder .schem completo (gunzip + NBT + ricostruzione voxel).
            async function decodeSchem(arrayBuffer) {
                let bytes = new Uint8Array(arrayBuffer);
                bytes = await gunzipBytes(bytes);
                const root = decodeNBT(bytes);
                // Sponge v2 puo' annidare i dati sotto "Schematic"; gestiamo entrambi.
                const s = root.Schematic || root;
                const W = s.Width, H = s.Height, L = s.Length;
                const palette = s.Palette || {};
                const idToBlock = {};
                Object.keys(palette).forEach(block => { idToBlock[palette[block]] = block; });
                // id blocco -> colore hex (via tabella MC). air -> skip.
                const blockColor = {};
                MC_BLOCK_COLORS.forEach(b => { blockColor[b[0]] = fmtHexRGB(b[1], b[2], b[3]); });

                const blockData = s.BlockData;
                if (!blockData) throw new Error(t('formats.schemNoBlockData'));
                const off = { o: 0 };
                const voxels = [];
                for (let y = 0; y < H; y++) {
                    for (let z = 0; z < L; z++) {
                        for (let x = 0; x < W; x++) {
                            const id = readVarint(blockData, off);
                            const block = idToBlock[id];
                            if (!block || block === 'minecraft:air') continue;
                            // togli eventuali blockstate properties: "minecraft:x[...]"
                            const base = block.split('[')[0];
                            const color = blockColor[base] || '#CCCCCC';
                            voxels.push({ x: x, y: y, z: z, color: color });
                        }
                    }
                }
                return { metadata: {}, voxels };
            }

            /* =========================================================================
             * Download binario + wiring pulsanti UI
             * =======================================================================*/

            // Estende downloadFile ai binari (Blob accetta Uint8Array come BlobPart).
            function downloadBinary(uint8, fileName, contentType) {
                const blob = new Blob([uint8], { type: contentType || 'application/octet-stream' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(a.href);
            }

            (function wireFormatButtons() {
                const voxBtn = document.getElementById('exportVoxBtn');
                if (voxBtn) voxBtn.addEventListener('click', () => {
                    try {
                        const data = encodeVox(getFormatExportVoxels());
                        downloadBinary(data, getFormatExportName() + '.vox', 'application/octet-stream');
                        if (typeof archiveExportJson === 'function') archiveExportJson(getFormatExportName());
                    } catch (e) {
                        alert(t('formats.voxExportError', { error: e.message }));
                    }
                });

                const schemBtn = document.getElementById('exportSchemBtn');
                if (schemBtn) schemBtn.addEventListener('click', async () => {
                    try {
                        const nbt = encodeSchemNBT(getFormatExportVoxels());
                        const res = await gzipBytes(nbt);
                        downloadBinary(res.data, getFormatExportName() + '.schem', 'application/octet-stream');
                        if (typeof archiveExportJson === 'function') archiveExportJson(getFormatExportName());
                        if (!res.gzipped) {
                            alert(t('formats.schemNoGzip'));
                        }
                    } catch (e) {
                        alert(t('formats.schemExportError', { error: e.message }));
                    }
                });
            })();

            // Instrada .vox/.schem: ritorna una Promise con { metadata, voxels }.
            function importBinaryFormat(file, arrayBuffer) {
                const nameLc = (file.name || '').toLowerCase();
                if (nameLc.endsWith('.vox')) return Promise.resolve(decodeVox(arrayBuffer));
                if (nameLc.endsWith('.schem') || nameLc.endsWith('.schematic')) return decodeSchem(arrayBuffer);
                return Promise.reject(new Error(t('project.unknownBinary', { ext: file.name })));
            }
