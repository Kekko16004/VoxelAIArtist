            function rebuildVoxelMap() {
                voxelMap = new Map();
                (currentModelData.voxels || []).forEach(v => {
                    voxelMap.set(`${v.x},${v.y},${v.z}`, v.color.toUpperCase());
                });
            }

            // Sync currentModelData.voxels from the voxelMap after edits.
            // Preserva i campi extra (part, _hidden, ecc.) dai voxel originali.
            function syncVoxelsFromMap() {
                const extraByKey = new Map();
                (currentModelData.voxels || []).forEach(v => {
                    const k = `${v.x},${v.y},${v.z}`;
                    if (v.part !== undefined || v._hidden !== undefined) {
                        const extra = {};
                        if (v.part !== undefined) extra.part = v.part;
                        if (v._hidden !== undefined) extra._hidden = v._hidden;
                        extraByKey.set(k, extra);
                    }
                });
                currentModelData.voxels = [...voxelMap.entries()].map(([k, color]) => {
                    const [x, y, z] = k.split(',').map(Number);
                    const base = { x, y, z, color };
                    const extra = extraByKey.get(k);
                    if (extra) {
                        return Object.assign(base, extra);
                    }
                    const targetPart = (typeof getTargetPartForVoxel === 'function')
                        ? getTargetPartForVoxel(x, y, z)
                        : ((typeof activePartName !== 'undefined' && activePartName) ? activePartName : null);
                    if (targetPart) {
                        base.part = targetPart;
                    }
                    return base;
                });
            }
