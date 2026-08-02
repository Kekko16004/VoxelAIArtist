            function buildObjectPayload(data) {
                const meta = (data && data.metadata) || {};
                const voxels = (data && data.voxels) || [];

                const hasParts = voxels.some(v => v.part);

                if (hasParts) {
                    const existingParts = [...new Set(voxels.filter(v => v.part).map(v => v.part))];
                    const fallbackPartName = existingParts.length > 0 ? existingParts[0] : (meta.name || 'main');
                    const partGroups = {};
                    voxels.forEach(v => {
                        if (v._hidden) return;
                        const pName = v.part || fallbackPartName;
                        if (!partGroups[pName]) partGroups[pName] = {};
                        const c = v.color.toUpperCase();
                        if (!partGroups[pName][c]) partGroups[pName][c] = [];
                        partGroups[pName][c].push(v.x, v.y, v.z);
                    });

                    const palette = {};
                    let paletteIndex = 0;
                    const allColors = new Set();
                    for (const pName in partGroups) {
                        for (const c in partGroups[pName]) allColors.add(c);
                    }
                    const colorToKey = {};
                    allColors.forEach(c => {
                        let key;
                        if (paletteIndex < 26) key = String.fromCharCode(97 + paletteIndex);
                        else if (paletteIndex < 52) key = String.fromCharCode(65 + (paletteIndex - 26));
                        else key = 'c' + (paletteIndex - 52);
                        paletteIndex++;
                        palette[key] = c;
                        colorToKey[c] = key;
                    });

                    const parts = {};
                    for (const pName in partGroups) {
                        const ops = [];
                        for (const c in partGroups[pName]) {
                            ops.push(["set", colorToKey[c], ...partGroups[pName][c]]);
                        }
                        parts[pName] = ops;
                    }

                    return {
                        metadata: {
                            name: meta.name || "voxel_model",
                            grid_size: meta.grid_size || [16, 16, 16]
                        },
                        palette: palette,
                        parts: parts
                    };
                }

                const palette = {};
                const ops = [];
                const colorGroups = {};
                voxels.forEach(v => {
                    const c = v.color.toUpperCase();
                    if (!colorGroups[c]) colorGroups[c] = [];
                    colorGroups[c].push(v.x, v.y, v.z);
                });

                let paletteIndex = 0;
                for (const c in colorGroups) {
                    let key;
                    if (paletteIndex < 26) key = String.fromCharCode(97 + paletteIndex);
                    else if (paletteIndex < 52) key = String.fromCharCode(65 + (paletteIndex - 26));
                    else key = 'c' + (paletteIndex - 52);
                    paletteIndex++;
                    palette[key] = c;
                    ops.push(["set", key, ...colorGroups[c]]);
                }

                return {
                    metadata: {
                        name: meta.name || "voxel_model",
                        grid_size: meta.grid_size || [16, 16, 16]
                    },
                    palette: palette,
                    ops: ops
                };
            }

            // Legacy single-object payload for the ACTIVE object. Kept for the AI
            // 'modify' request (which expects a single model) and as the save base.
            function getSavePayload() {
                if (typeof stashRigToActiveObject === 'function') stashRigToActiveObject();
                const out = buildObjectPayload(currentModelData);
                const r = (typeof serializeRig === 'function') ? serializeRig(rig) : null;
                if (r) out.rig = r;
                return out;
            }

            // Scene-aware save payload. One object -> legacy flat/compact format
            // (fully backward compatible). Multiple objects -> extended { objects:[...] }.
            function getSceneSavePayload() {
                // Il rig vive su obj.rig: quello dell'oggetto attivo va parcheggiato prima
                // di leggerlo, altrimenti si salverebbe la versione precedente alle
                // ultime modifiche (posa, pesi dipinti).
                if (typeof stashRigToActiveObject === 'function') stashRigToActiveObject();
                if (sceneObjects.length <= 1) {
                    return getSavePayload();
                }
                const out = { objects: [] };
                const rigs = [];
                sceneObjects.forEach(o => {
                    const p = buildObjectPayload(o.data);
                    const objPayload = {
                        name: o.name,
                        transform: o.transform,
                        visible: o.visible,
                        metadata: p.metadata,
                        palette: p.palette
                    };
                    if (p.parts) objPayload.parts = p.parts;
                    if (p.ops) objPayload.ops = p.ops;
                    // Ogni oggetto porta il PROPRIO rig (scheletro, posa, pesi dipinti,
                    // animazioni AI). Prima esisteva un solo rig per file, quindi in una
                    // scena corpo + armatura uno dei due lo perdeva al salvataggio.
                    const r = (typeof serializeRig === 'function') ? serializeRig(o.rig) : null;
                    if (r) { objPayload.rig = r; rigs.push(r); }
                    out.objects.push(objPayload);
                });
                // Compatibilita': le versioni precedenti leggono solo `rig` di radice. Lo
                // duplichiamo SOLO se un unico oggetto e' riggato (caso normale): con due o
                // piu' rig non c'e' un "il" rig e duplicare raddoppierebbe i pesi salvati.
                if (rigs.length === 1) out.rig = rigs[0];
                return out;
            }

            document.getElementById('saveJsonBtn').addEventListener('click', () => {
                const name = ((currentModelData.metadata && currentModelData.metadata.name) || "voxel_model").replace(/\s+/g, '_');
                const out = getSceneSavePayload();
                const jsonStr = JSON.stringify(out);
                const obfuscated = btoa(unescape(encodeURIComponent(jsonStr)));
                downloadFile(obfuscated, `${name}.voxelai`, 'application/octet-stream');
            });

            document.getElementById('savePlainJsonBtn').addEventListener('click', () => {
                const name = ((currentModelData.metadata && currentModelData.metadata.name) || "voxel_model").replace(/\s+/g, '_');
                const out = getSceneSavePayload();
                const jsonStr = JSON.stringify(out, null, 2);
                downloadFile(jsonStr, `${name}.json`, 'application/json');
            });
