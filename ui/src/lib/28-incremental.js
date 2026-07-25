            // ===== RENDERING INCREMENTALE (idea #8) =====
            // Frammento dello scope condiviso (vedi ui/build.mjs): nessun import/export.
            //
            // PROBLEMA. `buildModel()` e' una ricostruzione TOTALE: rifa' la voxelMap,
            // ricalcola la visibilita' di tutti i voxel, ricrea l'array dei voxel,
            // distrugge e ricrea OGNI InstancedMesh e rigenera il DOM della palette.
            // Veniva chiamata a ogni singola pennellata. Misurato su computeVisibility:
            // 24k voxel -> 0,04 s | 98k -> 0,18 s | 393k -> 0,80 s (Python; in JS ~3-5x
            // meno, ma su 128^3 resta un blocco percepibile A OGNI TRATTO). Su una
            // griglia 256^3 sarebbe inutilizzabile: per questo il rendering incrementale
            // e' il prerequisito delle griglie grandi.
            //
            // SOLUZIONE. Durante un edit cambiano pochi voxel, quindi:
            //   - la visibilita' si ricalcola SOLO sulle celle toccate e sui loro vicini
            //     (una cella coperta puo' scoprirsi solo se un vicino sparisce);
            //   - l'array `currentModelData.voxels` si aggiorna in O(1) per cella grazie
            //     a un indice chiave -> posizione (`voxelIndex`), con rimozione
            //     swap-with-last invece della ricostruzione integrale;
            //   - si ricreano solo gli InstancedMesh dei COLORI toccati;
            //   - la palette DOM si riscrive solo se l'insieme dei colori e' cambiato
            //     (altrimenti le swatch lampeggiano a ogni tratto).
            //
            // SICUREZZA. `buildModel()` resta il percorso completo e autorevole per
            // load/generate/import/undo/cambio oggetto. Se qualcosa non torna,
            // `incrementalReady` va a false e tutto ricade su `buildModel()`.

            // Stato del renderer incrementale (valido per l'OGGETTO ATTIVO).
            //
            // NOTA sulle strutture dati: `visibleByColor` mappa colore -> Map(chiave ->
            // voxel), NON colore -> array. Con un array servirebbe un findIndex per
            // togliere una cella, cioe' O(colori x lunghezza_lista) per ogni cella
            // toccata: su un modello grande sarebbe piu' LENTO del rebuild completo che
            // stiamo cercando di evitare. Con le Map ogni rimozione e' O(1).
            // `visibleColorByKey` completa il quadro: dice a quale colore appartiene una
            // cella visibile, senza doverlo cercare fra le liste.
            let voxelIndex = null;         // "x,y,z" -> indice in currentModelData.voxels
            let visibleColorByKey = null;  // "x,y,z" -> "#RRGGBB" (solo celle visibili)
            let meshByColor = null;        // "#RRGGBB" -> InstancedMesh
            let visibleByColor = null;     // "#RRGGBB" -> Map("x,y,z" -> voxel)
            let paletteSignature = '';     // per non riscrivere il DOM della palette invano
            let incrementalReady = false;  // false = usa sempre il percorso completo
            let visibleVoxelsDirty = false; // visibleVoxels da ricostruire alla prossima lettura

            // Riallinea `visibleVoxels` alle liste per colore, ma SOLO se qualcosa e'
            // cambiato dall'ultima volta. Va chiamata da chi legge visibleVoxels (es.
            // l'export GLB) invece di pagare la ricostruzione a ogni pennellata.
            function syncVisibleVoxels() {
                if (!visibleVoxelsDirty || !visibleByColor) return;
                const fresh = [];
                visibleByColor.forEach(m => m.forEach(v => fresh.push(v)));
                visibleVoxels = fresh;
                visibleVoxelsDirty = false;
            }

            const NEIGHBOR_OFFSETS = [
                [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
            ];

            function vkey(x, y, z) { return x + ',' + y + ',' + z; }

            // Una cella e' visibile se ESISTE e almeno un vicino manca.
            function isVisibleAt(x, y, z) {
                if (!voxelMap.has(vkey(x, y, z))) return false;
                for (let i = 0; i < 6; i++) {
                    const o = NEIGHBOR_OFFSETS[i];
                    if (!voxelMap.has(vkey(x + o[0], y + o[1], z + o[2]))) return true;
                }
                return false;
            }

            // Costruisce lo stato incrementale dopo un rebuild completo. Chiamata da
            // buildModel(): da quel momento gli edit possono usare il percorso rapido.
            function primeIncrementalState(voxels, visible, meshMap) {
                try {
                    voxelIndex = new Map();
                    for (let i = 0; i < voxels.length; i++) {
                        const v = voxels[i];
                        voxelIndex.set(vkey(v.x, v.y, v.z), i);
                    }
                    visibleColorByKey = new Map();
                    visibleByColor = new Map();
                    for (let i = 0; i < visible.length; i++) {
                        const v = visible[i];
                        const k = vkey(v.x, v.y, v.z);
                        const hex = (v.color || '').toUpperCase();
                        visibleColorByKey.set(k, hex);
                        let m = visibleByColor.get(hex);
                        if (!m) { m = new Map(); visibleByColor.set(hex, m); }
                        m.set(k, v);
                    }
                    meshByColor = meshMap || new Map();
                    paletteSignature = computePaletteSignature();
                    // buildModel ha appena ricalcolato visibleVoxels: non e' sporco.
                    visibleVoxelsDirty = false;
                    incrementalReady = true;
                } catch (e) {
                    incrementalReady = false;
                }
            }

            function computePaletteSignature() {
                // Firma dell'insieme dei colori presenti. Se non cambia, il DOM della
                // palette non va toccato.
                if (!visibleByColor) return '';
                return Array.from(visibleByColor.keys()).sort().join('|');
            }

            // --- aggiornamento O(1) dell'array dei voxel -------------------------
            function voxelArrayAdd(x, y, z, color) {
                const arr = currentModelData.voxels;
                const k = vkey(x, y, z);
                const existing = voxelIndex.get(k);
                if (existing !== undefined) {          // gia' presente: solo ricolora
                    arr[existing].color = color;
                    return;
                }
                arr.push({ x: x, y: y, z: z, color: color });
                voxelIndex.set(k, arr.length - 1);
            }

            function voxelArrayRemove(x, y, z) {
                const arr = currentModelData.voxels;
                const k = vkey(x, y, z);
                const idx = voxelIndex.get(k);
                if (idx === undefined) return;
                const last = arr.length - 1;
                if (idx !== last) {
                    // swap-with-last: evita lo shift O(n) di splice.
                    const moved = arr[last];
                    arr[idx] = moved;
                    voxelIndex.set(vkey(moved.x, moved.y, moved.z), idx);
                }
                arr.pop();
                voxelIndex.delete(k);
            }

            // --- (ri)costruzione del mesh di UN SOLO colore ----------------------
            function rebuildColorMesh(colorHex) {
                const cellMap = visibleByColor.get(colorHex);
                const list = cellMap ? Array.from(cellMap.values()) : null;
                const old = meshByColor.get(colorHex);
                if (old) {
                    modelPivot.remove(old);
                    disposeMesh(old);
                    meshByColor.delete(colorHex);
                    const mi = meshes.indexOf(old);
                    if (mi >= 0) meshes.splice(mi, 1);
                }
                if (!list || list.length === 0) {
                    visibleByColor.delete(colorHex);
                    return;
                }
                // userData.voxels serve al raycasting per l'editing: deve contenere gli
                // stessi voxel, nello stesso ordine degli indici delle istanze.
                const gap = parseFloat(voxelGap.value);
                const boxSize = 1.0 - gap;
                // Riusa la geometria CONDIVISA (vedi getVoxelGeometry in
                // 05-build-model.js). Crearne una nuova per ogni colore a ogni
                // pennellata sprecava memoria GPU, e la vecchia veniva liberata da
                // disposeMesh rompendo gli altri mesh che la condividevano.
                const geometry = (typeof getVoxelGeometry === 'function')
                    ? getVoxelGeometry(boxSize)
                    : new THREE.BoxGeometry(boxSize, boxSize, boxSize);
                const material = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(colorHex),
                    roughness: 0.2,
                    metalness: 0.1,
                    wireframe: toggleWireframe.checked
                });
                const instMesh = new THREE.InstancedMesh(geometry, material, list.length);
                const dummy = new THREE.Object3D();
                for (let i = 0; i < list.length; i++) {
                    dummy.position.set(list[i].x, list[i].y, list[i].z);
                    dummy.updateMatrix();
                    instMesh.setMatrixAt(i, dummy.matrix);
                }
                instMesh.instanceMatrix.needsUpdate = true;
                // Stessa compensazione del percorso completo: i mesh vivono sotto il
                // pivot centrato sul modello.
                const c = modelPivotBaseCenter;
                instMesh.position.set(-c.x, -c.y, -c.z);
                instMesh.userData.voxels = list;
                modelPivot.add(instMesh);
                meshes.push(instMesh);
                meshByColor.set(colorHex, instMesh);
            }

            /**
             * Percorso rapido per gli edit. `cells` = celle toccate:
             *   { x, y, z, color }  -> aggiunta o ricolorazione
             *   { x, y, z, removed } -> rimozione
             * PRECONDIZIONE: `voxelMap` e' GIA' aggiornata dal chiamante (come fa oggi
             * performAction). Qui si allineano array, visibilita' e mesh.
             *
             * Ritorna true se l'aggiornamento rapido e' andato a buon fine; false se il
             * chiamante deve ricadere su buildModel().
             */
            function applyVoxelEdits(cells) {
                if (!incrementalReady || !voxelIndex || !visibleColorByKey || !meshByColor) return false;
                if (!Array.isArray(cells) || cells.length === 0) return true;
                // Oltre una certa massa il rebuild completo conviene: ogni cella toccata
                // ne fa esaminare 7, e i mesh dei colori coinvolti vanno comunque rifatti.
                if (cells.length > 4000) return false;

                try {
                    // 1. Array dei voxel: O(1) per cella (indice + swap-with-last).
                    for (let i = 0; i < cells.length; i++) {
                        const c = cells[i];
                        if (c.removed) voxelArrayRemove(c.x, c.y, c.z);
                        else voxelArrayAdd(c.x, c.y, c.z, (c.color || '').toUpperCase());
                    }

                    // 2. Visibilita': solo celle toccate + vicini. Una cella nascosta puo'
                    //    scoprirsi solo se le sparisce accanto un vicino, quindi l'intorno
                    //    di raggio 1 e' sufficiente e il costo non dipende dal modello.
                    const toCheck = new Map();
                    for (let i = 0; i < cells.length; i++) {
                        const c = cells[i];
                        toCheck.set(vkey(c.x, c.y, c.z), c);
                        for (let n = 0; n < 6; n++) {
                            const o = NEIGHBOR_OFFSETS[n];
                            const nx = c.x + o[0], ny = c.y + o[1], nz = c.z + o[2];
                            toCheck.set(vkey(nx, ny, nz), { x: nx, y: ny, z: nz });
                        }
                    }

                    const dirtyColors = new Set();
                    toCheck.forEach((pos, k) => {
                        const x = pos.x, y = pos.y, z = pos.z;
                        const prevColor = visibleColorByKey.get(k);   // undefined = non visibile
                        const nowVisible = isVisibleAt(x, y, z);
                        const nowColor = nowVisible ? (voxelMap.get(k) || '').toUpperCase() : undefined;

                        if (prevColor === nowColor) return;           // nulla da fare

                        if (prevColor !== undefined) {                // toglila dal vecchio colore
                            const m = visibleByColor.get(prevColor);
                            if (m) {
                                m.delete(k);
                                if (m.size === 0) visibleByColor.delete(prevColor);
                            }
                            dirtyColors.add(prevColor);
                            visibleColorByKey.delete(k);
                        }
                        if (nowColor !== undefined) {                 // aggiungila al nuovo
                            let m = visibleByColor.get(nowColor);
                            if (!m) { m = new Map(); visibleByColor.set(nowColor, m); }
                            m.set(k, { x: x, y: y, z: z, color: nowColor });
                            dirtyColors.add(nowColor);
                            visibleColorByKey.set(k, nowColor);
                        }
                    });

                    // 3. Ricrea SOLO i mesh dei colori toccati (non tutti).
                    dirtyColors.forEach(hex => rebuildColorMesh(hex));

                    // 4. Contatori e palette. La palette si riscrive solo se l'insieme dei
                    //    colori e' cambiato davvero: altrimenti le swatch lampeggiano a
                    //    ogni pennellata.
                    // `visibleVoxels` e' letto da 16-export-glb.js e deve restare
                    // aggiornato. MA ricostruire l'intero array a ogni pennellata era
                    // O(voxel visibili) PER TRATTO: su un modello grande annullava tutto
                    // il guadagno dell'incrementale e l'editing tornava a bloccarsi.
                    // Soluzione: marcarlo come "sporco" (costo zero) e ricostruirlo solo
                    // quando qualcuno lo legge davvero -> syncVisibleVoxels().
                    visibleVoxelsDirty = true;

                    voxelCountEl.textContent = currentModelData.voxels.length;
                    visibleCountEl.textContent = visibleColorByKey.size;
                    const sig = computePaletteSignature();
                    if (sig !== paletteSignature) {
                        paletteSignature = sig;
                        renderPaletteSwatches();
                    }

                    if (typeof requestRender === 'function') requestRender();
                    return true;
                } catch (e) {
                    // Qualunque imprevisto: si torna al percorso sicuro.
                    incrementalReady = false;
                    return false;
                }
            }

            // Disegna le swatch della palette dai colori attualmente visibili.
            // Estratta da buildModel() cosi' il percorso incrementale puo' riusarla.
            function renderPaletteSwatches(colorsOverride) {
                const colors = colorsOverride
                    || (visibleByColor ? Array.from(visibleByColor.keys()) : []);
                paletteEl.innerHTML = '';
                colors.forEach(c => {
                    const s = document.createElement('div');
                    s.className = 'swatch';
                    s.style.backgroundColor = c;
                    s.title = c + ' — clic per usarlo come colore attivo';
                    s.addEventListener('click', () => setActiveColor(c));
                    paletteEl.appendChild(s);
                });
            }

            // Invalida lo stato incrementale: il prossimo edit passera' dal percorso
            // completo. Da chiamare quando la scena cambia fuori dal percorso di edit.
            function invalidateIncremental() {
                incrementalReady = false;
                voxelIndex = null;
                visibleColorByKey = null;
                visibleByColor = null;
                meshByColor = null;
                paletteSignature = '';
            }
