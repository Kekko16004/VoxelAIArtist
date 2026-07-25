            function rebuildVoxelMap() {
                voxelMap = new Map();
                (currentModelData.voxels || []).forEach(v => {
                    voxelMap.set(`${v.x},${v.y},${v.z}`, v.color.toUpperCase());
                });
            }

            // Sync currentModelData.voxels from the voxelMap after edits.
            function syncVoxelsFromMap() {
                currentModelData.voxels = [...voxelMap.entries()].map(([k, color]) => {
                    const [x, y, z] = k.split(',').map(Number);
                    return { x, y, z, color };
                });
            }
