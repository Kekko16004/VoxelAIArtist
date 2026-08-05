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
            //   - si ricreano solo gli InstancedMesh dei TOKEN toccati;
            //   - la palette DOM si riscrive solo se l'insieme dei token e' cambiato
            //     (altrimenti le swatch lampeggiano a ogni tratto).
            //
            // SICUREZZA. `buildModel()` resta il percorso completo e autorevole per
            // load/generate/import/undo/cambio oggetto. Se qualcosa non torna,
            // `incrementalReady` va a false e tutto ricade su `buildModel()`.

            // Stato del renderer incrementale (valido per l'OGGETTO ATTIVO).
            //
            // I nomi dicono "color" per continuita' storica, ma la CHIAVE e' il TOKEN
            // di 36-materials.js: '#RRGGBB' per un colore, '@id' per un materiale. Due
            // voxel dello stesso colore con materiali diversi sono percio' due gruppi e
            // due InstancedMesh, che e' l'unico modo di dargli due materiali THREE.
            //
            // NOTA sulle strutture dati: `visibleByColor` mappa token -> Map(chiave ->
            // voxel), NON token -> array. Con un array servirebbe un findIndex per
            // togliere una cella, cioe' O(token x lunghezza_lista) per ogni cella
            // toccata: su un modello grande sarebbe piu' LENTO del rebuild completo che
            // stiamo cercando di evitare. Con le Map ogni rimozione e' O(1).
            // `visibleColorByKey` completa il quadro: dice a quale token appartiene una
            // cella visibile, senza doverlo cercare fra le liste.
            let voxelIndex = null;         // "x,y,z" -> indice in currentModelData.voxels
            let visibleColorByKey = null;  // "x,y,z" -> token (solo celle visibili)
            let meshByColor = null;        // token -> InstancedMesh
            let visibleByColor = null;     // token -> Map("x,y,z" -> voxel)
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
                    // Con voxel NASCOSTI l'array completo (currentModelData.voxels) e la
                    // lista filtrata `voxels` divergono: gli indici del percorso rapido
                    // (costruiti su `voxels`) punterebbero ai voxel sbagliati nell'array
                    // completo, corrompendo place/remove/draw. Finche' qualcosa e'
                    // nascosto restiamo sul percorso completo (buildModel), che filtra
                    // _hidden correttamente. Perf: penalita' solo mentre c'e' del nascosto.
                    const fullLen = (currentModelData && Array.isArray(currentModelData.voxels))
                        ? currentModelData.voxels.length : voxels.length;
                    if (fullLen !== voxels.length) { incrementalReady = false; return; }
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
                        // tokenOf, non v.color: senza di lui due voxel dello stesso
                        // colore con materiali diversi finirebbero nello stesso mesh e
                        // uno dei due materiali non si vedrebbe mai.
                        const hex = tokenOf(v);
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
                // Firma dell'insieme dei TOKEN presenti. Se non cambia, il DOM della
                // palette non va toccato. Deve essere per token e non per colore:
                // assegnare un materiale a un voxel non cambia il suo colore, quindi
                // una firma sui soli colori non si accorgerebbe mai della differenza e
                // la palette non mostrerebbe la nuova voce.
                if (!visibleByColor) return '';
                return Array.from(visibleByColor.keys()).sort().join('|');
            }

            // Normalizza un valore letto dalla voxelMap in un TOKEN canonico, con le
            // stesse regole di tokenOf: un colore va MAIUSCOLO, un id di materiale NO.
            // Maiuscolizzare tutto (com'era) trasformava '@m1' in '@M1', cioe' in un id
            // diverso: il gruppo non combaciava piu' con quello di primeIncrementalState
            // e il materiale risultava orfano.
            function tokenNormalized(tok) {
                if (typeof tok !== 'string' || tok === '') return undefined;
                return isMaterialToken(tok) ? tok : tok.toUpperCase();
            }

            function getTargetPartForVoxel(x, y, z) {
                if (typeof activePartName !== 'undefined' && activePartName) return activePartName;
                const voxels = (currentModelData && currentModelData.voxels) || [];
                let minDist = Infinity;
                let nearestPart = null;
                for (let i = 0; i < voxels.length; i++) {
                    const v = voxels[i];
                    if (v.part) {
                        const d = Math.abs(v.x - x) + Math.abs(v.y - y) + Math.abs(v.z - z);
                        if (d < minDist) {
                            minDist = d;
                            nearestPart = v.part;
                            if (d === 1) break;
                        }
                    }
                }
                return nearestPart;
            }

            // `decodeToken` risolve un id di materiale con una SCANSIONE LINEARE della
            // lista (materialById): su una pennellata da 4000 celle sarebbe una
            // scansione per cella. I token distinti in una pennellata sono di norma uno,
            // quindi si memoizza per (token, colore di ripiego) e la scansione si paga
            // una volta sola. La cache vive quanto la singola applyVoxelEdits: piu' a
            // lungo e non vedrebbe una definizione appena aggiunta.
            function decodeTokenMemo(cache, token, fallbackColor) {
                const ck = token + '|' + (fallbackColor || '');
                let hit = cache.get(ck);
                if (hit === undefined) {
                    hit = decodeToken(token, fallbackColor);
                    cache.set(ck, hit);
                }
                return hit;
            }

            // `token` e' un token (vedi 36-materials.js), non un colore: va SCOMPOSTO,
            // altrimenti nel voxel finirebbe color: '@m1' e ogni consumatore che si
            // aspetta un hex (export, .vox, MTL) leggerebbe spazzatura.
            function voxelArrayAdd(x, y, z, token, decCache) {
                const arr = currentModelData.voxels;
                const k = vkey(x, y, z);
                const existing = voxelIndex.get(k);
                const targetPart = getTargetPartForVoxel(x, y, z);
                // Il colore del voxel che c'e' GIA' e' il ripiego giusto per un id
                // orfano: assegnare un materiale non ancora caricato non deve
                // ricolorare di grigio un voxel che aveva il suo colore.
                const fallback = (existing !== undefined && arr[existing]) ? arr[existing].color : undefined;
                const dec = decCache
                    ? decodeTokenMemo(decCache, token, fallback)
                    : decodeToken(token, fallback);
                if (existing !== undefined) {          // gia' presente: solo ricolora
                    arr[existing].color = dec.color;
                    if (dec.material) arr[existing].material = dec.material;
                    else delete arr[existing].material;
                    if (targetPart) arr[existing].part = targetPart;
                    return;
                }
                const newVoxel = { x: x, y: y, z: z, color: dec.color };
                if (dec.material) newVoxel.material = dec.material;
                if (targetPart) newVoxel.part = targetPart;
                arr.push(newVoxel);
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

            // --- materiale THREE di un token ------------------------------------
            // Unico punto in cui i due percorsi di rendering (completo e incrementale)
            // si procurano un materiale, cosi' non possono divergere.
            //
            // `sample` e' un voxel QUALSIASI del gruppo e serve solo per il suo colore:
            // su un id ORFANO threeMaterialFor ricade su quello invece che sul grigio
            // neutro, e un modello aperto senza le sue definizioni resta a tinte piatte.
            // Limite noto e inevitabile a questo livello: il token collassa il colore,
            // quindi due voxel ORFANI dello stesso id ma di colore diverso stanno nello
            // stesso gruppo e prendono il colore del primo. Vale solo per gli orfani --
            // con la definizione presente il colore lo decide lei.
            //
            // Il materiale arriva dalla cache di 36-materials.js ed e' CONDIVISO fra i
            // mesh e fra i rebuild; e' threeMaterialFor a marcarlo userData.shared, e
            // disposeMesh (05-build-model.js) a rispettare il marchio. Qui non si tocca.
            function voxelMaterialFor(token, sample) {
                return threeMaterialFor(token, {
                    wireframe: toggleWireframe.checked,
                    color: sample ? sample.color : undefined
                });
            }

            // --- (ri)costruzione del mesh di UN SOLO token ----------------------
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
                const material = voxelMaterialFor(colorHex, list[0]);
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
                    // Un solo memo di decodifica per tutta la pennellata: vedi
                    // decodeTokenMemo. Non va tenuto fra chiamate diverse.
                    const decCache = new Map();

                    // 1. Array dei voxel: O(1) per cella (indice + swap-with-last).
                    for (let i = 0; i < cells.length; i++) {
                        const c = cells[i];
                        if (c.removed) voxelArrayRemove(c.x, c.y, c.z);
                        else voxelArrayAdd(c.x, c.y, c.z, tokenNormalized(c.color), decCache);
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
                        // voxelMap contiene gia' il TOKEN: va normalizzato come fa
                        // tokenOf (colore maiuscolo, id di materiale intatto), non
                        // maiuscolizzato in blocco -- '@m1' e '@M1' sono id diversi.
                        const nowColor = nowVisible ? tokenNormalized(voxelMap.get(k)) : undefined;

                        if (prevColor === nowColor) return;           // nulla da fare

                        // Il voxel com'era PRIMA: unico posto in cui questo ramo ha
                        // ancora in mano il colore vero della cella, e serve piu' sotto
                        // se l'array non la contiene.
                        const prevMap = (prevColor !== undefined) ? visibleByColor.get(prevColor) : undefined;
                        const prevVox = prevMap ? prevMap.get(k) : undefined;

                        if (prevColor !== undefined) {                // toglila dal vecchio token
                            if (prevMap) {
                                prevMap.delete(k);
                                if (prevMap.size === 0) visibleByColor.delete(prevColor);
                            }
                            dirtyColors.add(prevColor);
                            visibleColorByKey.delete(k);
                        }
                        if (nowColor !== undefined) {                 // aggiungila al nuovo
                            let m = visibleByColor.get(nowColor);
                            if (!m) { m = new Map(); visibleByColor.set(nowColor, m); }
                            const idx = voxelIndex ? voxelIndex.get(k) : undefined;
                            let voxObj = (idx !== undefined && currentModelData.voxels[idx])
                                ? currentModelData.voxels[idx]
                                : null;
                            if (!voxObj) {
                                // Ripiego difensivo (la cella dovrebbe stare nell'array).
                                // Anche qui il token va SCOMPOSTO, o il voxel finto
                                // porterebbe color: '@m1'. Il solo colore vero a
                                // disposizione e' quello che la cella aveva prima.
                                const dec = decodeToken(nowColor, prevVox ? prevVox.color : undefined);
                                voxObj = { x: x, y: y, z: z, color: dec.color };
                                if (dec.material) voxObj.material = dec.material;
                            }
                            m.set(k, voxObj);
                            dirtyColors.add(nowColor);
                            visibleColorByKey.set(k, nowColor);
                        }
                    });

                    // 3. Ricrea SOLO i mesh dei token toccati (non tutti).
                    dirtyColors.forEach(hex => rebuildColorMesh(hex));

                    // 4. Contatori e palette. La palette si riscrive solo se l'insieme dei
                    //    token e' cambiato davvero: altrimenti le swatch lampeggiano a
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

            // Disegna le swatch della palette dai TOKEN attualmente visibili.
            // Estratta da buildModel() cosi' il percorso incrementale puo' riusarla.
            // Un token materiale mostra la miniatura della texture; un token colore il
            // colore pieno. Il click seleziona l'uno o l'altro, coerentemente con la
            // mutua esclusione fra colore e materiale.
            function renderPaletteSwatches(tokensOverride) {
                const tokens = tokensOverride
                    || (visibleByColor ? Array.from(visibleByColor.keys()) : []);
                paletteEl.innerHTML = '';
                tokens.forEach(tok => {
                    const s = document.createElement('div');
                    s.className = 'swatch';
                    // decodeToken UNA volta per token (non per voxel): risolve l'id con
                    // una scansione lineare della lista materiali.
                    const dec = decodeToken(tok);
                    // materialById, non `dec.material`: su un id orfano il campo resta
                    // valorizzato di proposito ma la definizione non c'e'.
                    const def = dec.material ? materialById(dec.material) : null;
                    s.style.backgroundColor = dec.color;
                    if (def && def.texture && def.texture.data) {
                        s.style.backgroundImage = `url(${def.texture.data})`;
                        s.style.backgroundSize = 'cover';
                        s.style.imageRendering = 'pixelated';
                    }
                    if (def) {
                        s.title = t('materials.swatchMaterialTitle', { name: def.name });
                        // setActiveMaterialAndSync arriva col pannello materiali: finche'
                        // non c'e' si seleziona comunque il materiale, senza ReferenceError.
                        s.addEventListener('click', () => {
                            if (typeof setActiveMaterialAndSync === 'function') setActiveMaterialAndSync(dec.material);
                            else if (typeof setActiveMaterial === 'function') setActiveMaterial(dec.material);
                        });
                    } else {
                        s.title = t('materials.swatchColorTitle', { color: dec.color });
                        s.addEventListener('click', () => setActiveColor(dec.color));
                    }
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
