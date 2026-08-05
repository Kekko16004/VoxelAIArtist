            function rebuildVoxelMap() {
                voxelMap = new Map();
                (currentModelData.voxels || []).forEach(v => {
                    // I voxel NASCOSTI (es. un coperchio la cui parte e' stata nascosta
                    // nell'outliner) NON entrano nella voxelMap: la mappa e' la sorgente
                    // di verita' per l'editing, quindi tenerli dentro faceva rifiutare il
                    // piazzamento su quella cella (l'anteprima verde appariva ma il blocco
                    // non veniva messo). Esclusi qui, la cella risulta libera e si puo'
                    // costruire "sopra" la parte nascosta. syncVoxelsFromMap li conserva.
                    if (v._hidden) return;
                    // Il valore e' un TOKEN ('#RRGGBB' o '@m1'), non un colore: vedi
                    // 36-materials.js. Le decine di confronti sparsi per l'editor lo
                    // trattano come stringa opaca e restano invariati.
                    voxelMap.set(`${v.x},${v.y},${v.z}`, tokenOf(v));
                });
            }

            // Sync currentModelData.voxels from the voxelMap after edits.
            // Preserva i campi extra (part) e tiene da parte i voxel NASCOSTI, che
            // NON stanno nella voxelMap (vedi rebuildVoxelMap). Un voxel nascosto
            // sopravvive finche' nessun nuovo blocco occupa la sua cella: se l'utente
            // costruisce proprio li' sopra, quella cella entra nella voxelMap e il
            // nuovo blocco (visibile) sostituisce quello nascosto.
            function syncVoxelsFromMap() {
                const partByKey = new Map();
                // Colore PROPRIO di ogni cella prima della ricostruzione. Serve come
                // ripiego per decodeToken su un id ORFANO: il token ha collassato il
                // voxel a '@m1' buttandone via l'hex, quindi il suo colore vero puo'
                // arrivare solo da qui. Senza, un .voxai aperto senza le sue definizioni
                // vedrebbe ogni voxel texturizzato riscritto a #CCCCCC al primo sync --
                // e questo array e' cio' che finisce su disco, quindi la perdita
                // sarebbe definitiva.
                const colorByKey = new Map();
                const hiddenVoxels = [];
                (currentModelData.voxels || []).forEach(v => {
                    const k = `${v.x},${v.y},${v.z}`;
                    if (v._hidden) {
                        if (!voxelMap.has(k)) hiddenVoxels.push(v);
                        return;
                    }
                    if (v.part !== undefined) partByKey.set(k, v.part);
                    if (v.color) colorByKey.set(k, v.color);
                });
                const rebuilt = [...voxelMap.entries()].map(([k, token]) => {
                    const [x, y, z] = k.split(',').map(Number);
                    // Una cella APPENA dipinta non ha un colore precedente, e non le
                    // serve: solo un token materiale puo' essere privo di colore, e un
                    // materiale appena posato per definizione esiste (vedi activeToken).
                    const dec = decodeToken(token, colorByKey.get(k));
                    const base = { x, y, z, color: dec.color };
                    if (dec.material) base.material = dec.material;
                    const part = partByKey.get(k);
                    if (part !== undefined) {
                        base.part = part;
                        return base;
                    }
                    const targetPart = (typeof getTargetPartForVoxel === 'function')
                        ? getTargetPartForVoxel(x, y, z)
                        : ((typeof activePartName !== 'undefined' && activePartName) ? activePartName : null);
                    if (targetPart) {
                        base.part = targetPart;
                    }
                    return base;
                });
                currentModelData.voxels = rebuilt.concat(hiddenVoxels);
            }
