            function buildObjectPayload(data) {
                const meta = (data && data.metadata) || {};
                const voxels = (data && data.voxels) || [];

                // Compress voxels into palette and "set" operations for massive file size reduction
                const palette = {};
                let nextChar = 97; // 'a'
                const ops = [];

                // Group voxels by color
                const colorGroups = {};
                voxels.forEach(v => {
                    const c = v.color.toUpperCase();
                    if (!colorGroups[c]) colorGroups[c] = [];
                    colorGroups[c].push(v.x, v.y, v.z);
                });

                let paletteIndex = 0;
                for (const c in colorGroups) {
                    let key;
                    if (paletteIndex < 26) {
                        key = String.fromCharCode(97 + paletteIndex); // 'a'..'z'
                    } else if (paletteIndex < 52) {
                        key = String.fromCharCode(65 + (paletteIndex - 26)); // 'A'..'Z'
                    } else {
                        key = 'c' + (paletteIndex - 52); // 'c0', 'c1', 'c2'...
                    }
                    paletteIndex++;
                    palette[key] = c;
                    // op structure: ["set", key, x1,y1,z1, x2,y2,z2, ...]
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
                const out = buildObjectPayload(currentModelData);
                if (rig && rig.bones && rig.bones.length) {
                    out.rig = { type: rig.type, binding: rig.binding, bones: rig.bones, pose: rig.pose || {} };
                }
                return out;
            }

            // Scene-aware save payload. One object -> legacy flat/compact format
            // (fully backward compatible). Multiple objects -> extended { objects:[...] }.
            function getSceneSavePayload() {
                if (sceneObjects.length <= 1) {
                    return getSavePayload();
                }
                const out = { objects: [] };
                sceneObjects.forEach(o => {
                    const p = buildObjectPayload(o.data);
                    out.objects.push({
                        name: o.name,
                        transform: o.transform,
                        visible: o.visible,
                        metadata: p.metadata,
                        palette: p.palette,
                        ops: p.ops
                    });
                });
                // Rig currently belongs to the active object only.
                if (rig && rig.bones && rig.bones.length) {
                    out.rig = { type: rig.type, binding: rig.binding, bones: rig.bones, pose: rig.pose || {} };
                }
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
