            // --- Primitive voxel (Shift+A) --------------------------------------------
            // Un file, due meta': qui sopra la MATEMATICA (funzioni pure, nessun DOM e
            // nessun THREE, testate da tests/test_primitives.mjs estraendo il sorgente);
            // sotto il marcatore "UI" il menu e il dialogo.
            //
            // Coordinate CENTRATE sul centro geometrico: il centro di una misura pari
            // cade a meta' voxel (size 8 -> centro 3.5), quindi lavorare con la distanza
            // dal centro rende ogni forma simmetrica PER COSTRUZIONE. Con l'origine su 0
            // invece una sfera di diametro pari esce sbilenca di un voxel, ed e' un
            // difetto che a occhio non si nota e in Blender si', a specchio fatto.
            //
            // Il raggio del test e' size/2, NON (size-1)/2: il voxel piu' esterno ha il
            // centro a (size-1)/2 dal centro, quindi con il raggio piu' piccolo il guscio
            // esterno risulta mangiato di un voxel. L'asserzione [6] del test copre
            // esattamente questo.
            const PRIMITIVE_GRIDS = [32, 48, 64, 128, 192, 256, 384, 512];

            const PRIMITIVE_SHAPES = [
                { id: 'cube',     i18nKey: 'prim.cube',     ratio: 1.0, defaultSize: 16 },
                { id: 'pyramid',  i18nKey: 'prim.pyramid',  ratio: 1.0, defaultSize: 16 },
                { id: 'cylinder', i18nKey: 'prim.cylinder', ratio: 1.5, defaultSize: 12 },
                { id: 'sphere',   i18nKey: 'prim.sphere',   ratio: 1.0, defaultSize: 16, fixedRatio: true },
                { id: 'cone',     i18nKey: 'prim.cone',     ratio: 1.5, defaultSize: 12 }
            ];

            function primitiveShape(id) {
                for (const s of PRIMITIVE_SHAPES) if (s.id === id) return s;
                return null;
            }

            // Misura intera valida: >= 1 e finita. Un NaN che arriva da un campo di testo
            // vuoto deve produrre ZERO celle, non un ciclo su NaN.
            function primIntOk(v) {
                const n = Number(v);
                return Number.isFinite(n) && Math.floor(n) >= 1;
            }

            // Raggio minimo che tiene l'apice NON vuoto. Su misura pari il voxel piu'
            // interno ha il centro a 0.5 da entrambi gli assi, quindi serve
            // sqrt(0.5^2 + 0.5^2); su misura dispari il centro cade su un voxel e
            // qualunque raggio va bene. Senza questo minimo cono e piramide perdono i
            // livelli in cima e non arrivano all'altezza chiesta.
            const PRIM_APEX_MIN = Math.SQRT1_2;   // ~0.7072

            function primitiveCells(id, size, height) {
                const shape = primitiveShape(id);
                if (!shape || !primIntOk(size) || !primIntOk(height)) return [];
                const S = Math.floor(Number(size));
                const H = Math.floor(Number(height));
                const cx = (S - 1) / 2, cz = (S - 1) / 2, cy = (H - 1) / 2;
                const r = S / 2, ry = H / 2;
                const out = [];
                for (let y = 0; y < H; y++) {
                    // Frazione di altezza al CENTRO della cella: con (y/H) il livello 0
                    // avrebbe raggio pieno e l'ultimo raggio zero, sbilanciato in basso.
                    const t = (y + 0.5) / H;
                    const rAt = Math.max(PRIM_APEX_MIN, r * (1 - t));
                    const dy = y - cy;
                    for (let x = 0; x < S; x++) {
                        const dx = x - cx;
                        for (let z = 0; z < S; z++) {
                            const dz = z - cz;
                            let inside;
                            if (id === 'cube') {
                                inside = true;
                            } else if (id === 'cylinder') {
                                inside = (dx * dx + dz * dz) <= r * r;
                            } else if (id === 'sphere') {
                                // Normalizzata: se un giorno arriva un ellissoide, qui non
                                // cambia niente. Oggi ry === r perche' fixedRatio.
                                inside = (dx * dx) / (r * r) + (dy * dy) / (ry * ry)
                                       + (dz * dz) / (r * r) <= 1;
                            } else if (id === 'cone') {
                                inside = (dx * dx + dz * dz) <= rAt * rAt;
                            } else {   // pyramid: base quadrata che si restringe
                                inside = Math.abs(dx) <= rAt && Math.abs(dz) <= rAt;
                            }
                            if (inside) out.push({ x: x, y: y, z: z });
                        }
                    }
                }
                return out;
            }

            // Quanti interi z in [0,S) soddisfano (z-cz)^2 <= R, con cz = (S-1)/2.
            // Chiuso, ma ESATTO: sqrt da' il candidato e poi si corregge testando il
            // predicato VERO su di esso e sul vicino. Fidarsi della sqrt e' proprio il
            // genere di errore da un voxel che il test di simmetria caccia.
            function primSpanSq(S, R) {
                if (!(R >= 0)) return 0;
                const cz = (S - 1) / 2;
                let k = Math.floor(cz + Math.sqrt(R));
                if (k > S - 1) k = S - 1;
                while (k >= 0 && (k - cz) * (k - cz) > R) k--;
                while (k + 1 <= S - 1 && (k + 1 - cz) * (k + 1 - cz) <= R) k++;
                if (k < 0) return 0;
                return Math.max(0, 2 * k - S + 2);   // simmetrico intorno a cz
            }

            // Come sopra sul predicato |z-cz| <= q: la piramide confronta i valori
            // assoluti, non i quadrati, e in virgola mobile non e' la stessa cosa.
            function primSpanAbs(S, q) {
                if (!(q >= 0)) return 0;
                const cz = (S - 1) / 2;
                let k = Math.floor(cz + q);
                if (k > S - 1) k = S - 1;
                while (k >= 0 && Math.abs(k - cz) > q) k--;
                while (k + 1 <= S - 1 && Math.abs(k + 1 - cz) <= q) k++;
                if (k < 0) return 0;
                return Math.max(0, 2 * k - S + 2);
            }

            // CONTA senza costruire: vedi la nota nelle Interfaces. Le condizioni sono
            // le STESSE di primitiveCells, riscritte per riga invece che per cella; il
            // test [8] pretende che i due numeri coincidano, altrimenti la forma chiusa
            // e' un secondo modello della geometria libero di divergere.
            function primitiveVoxelCount(id, size, height) {
                const shape = primitiveShape(id);
                if (!shape || !primIntOk(size) || !primIntOk(height)) return 0;
                const S = Math.floor(Number(size));
                const H = Math.floor(Number(height));
                if (id === 'cube') return S * S * H;
                const cx = (S - 1) / 2, cy = (H - 1) / 2;
                const r = S / 2, ry = H / 2;
                let n = 0;
                for (let y = 0; y < H; y++) {
                    const t = (y + 0.5) / H;
                    const rAt = Math.max(PRIM_APEX_MIN, r * (1 - t));
                    const dy = y - cy;
                    if (id === 'pyramid') {
                        const w = primSpanAbs(S, rAt);
                        n += w * w;
                        continue;
                    }
                    for (let x = 0; x < S; x++) {
                        const dx = x - cx;
                        if (id === 'cylinder') {
                            n += primSpanSq(S, r * r - dx * dx);
                        } else if (id === 'cone') {
                            n += primSpanSq(S, rAt * rAt - dx * dx);
                        } else {   // sphere
                            const rest = 1 - (dx * dx) / (r * r) - (dy * dy) / (ry * ry);
                            n += primSpanSq(S, rest * r * r);
                        }
                    }
                }
                return n;
            }

            // Prima griglia standard che contiene la forma. Non RIMPICCIOLISCE mai la
            // griglia corrente: se la forma ci sta gia', l'oggetto nuovo eredita quella
            // dell'utente invece di scendere al minimo che basta.
            function primitiveGridFor(size, height, currentGrid) {
                const need = Math.max(1, Math.round(Number(size) || 0), Math.round(Number(height) || 0));
                const cur = Math.round(Number(currentGrid) || 0);
                if (cur > 0 && cur >= need) return cur;
                for (const g of PRIMITIVE_GRIDS) if (g >= need) return g;
                return PRIMITIVE_GRIDS[PRIMITIVE_GRIDS.length - 1];
            }
