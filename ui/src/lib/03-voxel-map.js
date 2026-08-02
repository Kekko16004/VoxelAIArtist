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
                    voxelMap.set(`${v.x},${v.y},${v.z}`, v.color.toUpperCase());
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
                const hiddenVoxels = [];
                (currentModelData.voxels || []).forEach(v => {
                    const k = `${v.x},${v.y},${v.z}`;
                    if (v._hidden) {
                        if (!voxelMap.has(k)) hiddenVoxels.push(v);
                        return;
                    }
                    if (v.part !== undefined) partByKey.set(k, v.part);
                });
                const rebuilt = [...voxelMap.entries()].map(([k, color]) => {
                    const [x, y, z] = k.split(',').map(Number);
                    const base = { x, y, z, color };
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
