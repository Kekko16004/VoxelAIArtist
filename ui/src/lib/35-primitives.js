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
                    // Frazione di altezza dal BASSO: t=0 al livello 0 (raggio pieno) e
                    // t=1 all'ultimo livello (apice). La forma precedente (y + 0.5) / H
                    // campionava il centro del layer, e con H < S/2 la base nasceva
                    // ristretta: piramide 16 alta 1 usciva larga 8 invece di 16, 32x4
                    // usciva 28. Un tetto piatto e' una richiesta normale, quindi la base
                    // deve valere il lato chiesto a QUALUNQUE altezza. Il max(1, H-1)
                    // evita la divisione per zero a H=1, dove l'unico livello e' la base.
                    // Pinnata dal gruppo [8-bis] del test, che copre proprio H < S/2.
                    const t = y / Math.max(1, H - 1);
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
                    // IDENTICA alla formula del generatore qui sopra: se una delle due
                    // cambia senza l'altra, il conteggio diverge dalla geometria e il
                    // budget si decide su un numero sbagliato. Il gruppo [8] del test
                    // confronta i due valori forma per forma.
                    // (Nessun nome di funzione qui dentro: il gruppo [9] ispeziona questo
                    //  corpo per garantire che contare non allochi.)
                    const t = y / Math.max(1, H - 1);
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

            // ===== UI: menu Shift+A e dialogo =====
            // Da qui in giu' si tocca il DOM: il test estrae SOLO la parte sopra questo
            // marcatore. Se il marcatore cambia testo, il test si porta dietro il DOM e
            // fallisce con "document is not defined" — e' voluto che sia rumoroso.
            let primShapeId = null;
            let primKeepRatioPref = true;

            function primEl(id) { return document.getElementById(id); }

            function primClose() {
                const ov = primEl('primOverlay');
                if (ov) ov.style.display = 'none';
                primShapeId = null;
            }

            function primOpen() {
                const ov = primEl('primOverlay');
                if (!ov) return;
                primShapeId = null;
                primEl('primStepShape').style.display = '';
                primEl('primStepSize').style.display = 'none';
                const list = primEl('primShapeList');
                list.innerHTML = '';
                PRIMITIVE_SHAPES.forEach((s, i) => {
                    const b = document.createElement('button');
                    b.className = 'btn';
                    b.textContent = t(s.i18nKey);
                    b.style.textAlign = 'left';
                    b.addEventListener('click', () => primPickShape(s.id));
                    list.appendChild(b);
                    if (i === 0) setTimeout(() => b.focus(), 0);
                });
                ov.style.display = 'flex';
            }
            function primPickShape(id) {
                const s = primitiveShape(id);
                if (!s) return;
                primShapeId = id;
                primEl('primStepShape').style.display = 'none';
                primEl('primStepSize').style.display = '';
                primEl('primChosenName').textContent = t(s.i18nKey);
                const sizeEl = primEl('primSize'), hEl = primEl('primHeight');
                sizeEl.value = String(s.defaultSize);
                hEl.value = String(Math.max(1, Math.round(s.defaultSize * s.ratio)));
                // La sfera non ha un'altezza indipendente: un'altezza diversa dal
                // diametro non e' una sfera, e' un ellissoide (fuori scopo).
                const keep = primEl('primKeepRatio');
                keep.checked = s.fixedRatio ? true : primKeepRatioPref;
                keep.disabled = !!s.fixedRatio;
                hEl.disabled = !!s.fixedRatio;
                primRefreshInfo();
                // Il campo principale parte a fuoco E selezionato: chi sa gia' la misura
                // digita e preme Invio senza toccare il mouse.
                setTimeout(() => { sizeEl.focus(); sizeEl.select(); }, 0);
            }

            // Misure correnti, gia' pulite: mai NaN, mai sotto 1, mai sopra 512.
            function primReadDims() {
                const s = primitiveShape(primShapeId);
                let size = Math.round(Number(primEl('primSize').value));
                if (!Number.isFinite(size)) size = 1;
                size = Math.min(512, Math.max(1, size));
                let h;
                if (s && s.fixedRatio) {
                    h = size;
                } else if (primEl('primKeepRatio').checked) {
                    h = Math.max(1, Math.round(size * (s ? s.ratio : 1)));
                } else {
                    h = Math.round(Number(primEl('primHeight').value));
                    if (!Number.isFinite(h)) h = 1;
                }
                h = Math.min(512, Math.max(1, h));
                return { size: size, height: h };
            }

            // Griglia dell'oggetto attivo, come numero singolo: la primitiva non deve
            // rimpicciolire la griglia che l'utente ha scelto.
            function primCurrentGrid() {
                const g = (typeof currentModelData !== 'undefined' && currentModelData.metadata
                    && currentModelData.metadata.grid_size) || null;
                return Array.isArray(g) ? Math.max(g[0], g[1], g[2]) : 16;
            }

            function primRefreshInfo() {
                if (!primShapeId) return;
                const d = primReadDims();
                if (primEl('primKeepRatio').checked || primitiveShape(primShapeId).fixedRatio) {
                    primEl('primHeight').value = String(d.height);
                }
                const g = primitiveGridFor(d.size, d.height, primCurrentGrid());
                const n = primitiveVoxelCount(primShapeId, d.size, d.height);
                const budget = voxelBudgetFor([g, g, g]);
                const info = primEl('primInfo'), btn = primEl('primCreate');
                if (n > budget) {
                    // Rifiutare, non troncare: una forma tagliata a meta' e' peggio di un
                    // messaggio chiaro. Il tetto e' quello di CLAUDE.md, non un numero nuovo.
                    // t(key, vars) interpola da solo i {segnaposto} (23-i18n.js:49): niente
                    // .replace() a mano, che salterebbe la lingua di ripiego.
                    info.textContent = t('prim.tooBig', { n: n });
                    btn.disabled = true;
                } else {
                    info.textContent = t('prim.info', { n: n, g: g });
                    btn.disabled = false;
                }
            }
            function primCreate() {
                if (!primShapeId) return;
                const d = primReadDims();
                const g = primitiveGridFor(d.size, d.height, primCurrentGrid());
                // CONTARE PRIMA, costruire dopo: invertire i due passaggi rimette
                // l'allocazione da 134 milioni di celle proprio davanti al controllo
                // che deve impedirla. Il bottone e' gia' disabilitato in questo caso,
                // ma Invio e un doppio clic arrivano lo stesso.
                const n = primitiveVoxelCount(primShapeId, d.size, d.height);
                if (!n || n > voxelBudgetFor([g, g, g])) return;
                const cells = primitiveCells(primShapeId, d.size, d.height);
                if (!cells.length) return;
                pushHistory();
                // Centrata su XZ e appoggiata a y=0, come gli asset del pack
                // (normalize_asset): una primitiva che nasce in un angolo va spostata
                // a mano ogni volta.
                const ox = Math.floor((g - d.size) / 2), oz = Math.floor((g - d.size) / 2);
                const color = (typeof activeColorHex === 'string') ? activeColorHex : '#CCCCCC';
                const voxels = cells.map(c => ({ x: c.x + ox, y: c.y, z: c.z + oz, color: color }));
                const obj = createObject({
                    metadata: { name: t(primitiveShape(primShapeId).i18nKey), grid_size: [g, g, g] },
                    voxels: voxels
                });
                primClose();
                // setActiveObject (dentro selectActiveObjectAndRefresh) invalida gia' lo
                // stato incrementale e fa il buildModel: CLAUDE.md lo impone a chi
                // sostituisce currentModelData, e passando di qui e' gratis.
                selectActiveObjectAndRefresh(obj.id);
            }

            function initPrimitives() {
                const ov = primEl('primOverlay');
                if (!ov || ov.dataset.primInit === '1') return;   // idempotente
                ov.dataset.primInit = '1';
                primEl('primCancel').addEventListener('click', primClose);
                primEl('primCreate').addEventListener('click', primCreate);
                primEl('primSize').addEventListener('input', primRefreshInfo);
                primEl('primHeight').addEventListener('input', primRefreshInfo);
                primEl('primKeepRatio').addEventListener('change', () => {
                    const s = primitiveShape(primShapeId);
                    if (s && !s.fixedRatio) primKeepRatioPref = primEl('primKeepRatio').checked;
                    primRefreshInfo();
                });
                // Clic sullo sfondo = annulla, come importOverlay.
                ov.addEventListener('click', e => { if (e.target === ov) primClose(); });
                ov.addEventListener('keydown', e => {
                    if (e.key === 'Escape') { e.preventDefault(); primClose(); }
                    else if (e.key === 'Enter' && primShapeId && !primEl('primCreate').disabled) {
                        e.preventDefault(); primCreate();
                    }
                });
                window.addEventListener('keydown', e => {
                    // Shift+A e' libero: l'unico shiftKey a tastiera nel progetto e'
                    // Ctrl+Shift+Z in 13-history.js. Ctrl/Alt esclusi per non rubare
                    // Ctrl+Shift+A, che dal Task 5 e' del rig.
                    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
                    if (e.key !== 'A' && e.key !== 'a') return;
                    if (isTypingTarget(e)) return;
                    if (ov.style.display !== 'none') return;   // gia' aperto
                    e.preventDefault();
                    primOpen();
                });
            }
