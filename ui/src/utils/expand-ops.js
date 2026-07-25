            function expandOps(data) {
                if (!data || typeof data !== 'object') return data;
                const ops = data.ops;
                if (!ops || !Array.isArray(ops)) {
                    if (!Array.isArray(data.voxels)) data.voxels = [];
                    return data;
                }
                const palette = data.palette || {};
                const resolveColor = (key) => {
                    if (typeof key === 'string' && key.startsWith('#')) return key.toUpperCase();
                    const col = palette[key];
                    return (typeof col === 'string' && col) ? col.toUpperCase() : '#CCCCCC';
                };
                const grid = new Map();
                const K = (x, y, z) => `${x},${y},${z}`;
                const rng = (a, b) => {
                    a = Math.round(a); b = Math.round(b);
                    if (a > b) { const t = a; a = b; b = t; }
                    const out = [];
                    for (let i = a; i <= b; i++) out.push(i);
                    return out;
                };
                const doFill = (x0, y0, z0, x1, y1, z1, c) => {
                    for (const x of rng(x0, x1)) for (const y of rng(y0, y1)) for (const z of rng(z0, z1)) grid.set(K(x, y, z), c);
                };
                const doBox = (x0, y0, z0, x1, y1, z1, c) => {
                    const xmin = Math.min(x0, x1), xmax = Math.max(x0, x1);
                    const ymin = Math.min(y0, y1), ymax = Math.max(y0, y1);
                    const zmin = Math.min(z0, z1), zmax = Math.max(z0, z1);
                    for (const x of rng(x0, x1)) for (const y of rng(y0, y1)) for (const z of rng(z0, z1)) {
                        if (x === xmin || x === xmax || y === ymin || y === ymax || z === zmin || z === zmax) grid.set(K(x, y, z), c);
                    }
                };
                const doLine = (x0, y0, z0, x1, y1, z1, c) => {
                    x0 = Math.round(x0); y0 = Math.round(y0); z0 = Math.round(z0);
                    x1 = Math.round(x1); y1 = Math.round(y1); z1 = Math.round(z1);
                    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
                    if (steps === 0) { grid.set(K(x0, y0, z0), c); return; }
                    for (let i = 0; i <= steps; i++) {
                        const t = i / steps;
                        grid.set(K(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), Math.round(z0 + (z1 - z0) * t)), c);
                    }
                };
                const doRect = (axis, level, a0, b0, a1, b1, c) => {
                    level = Math.round(level); axis = String(axis).toLowerCase();
                    for (const a of rng(a0, a1)) for (const b of rng(b0, b1)) {
                        if (axis === 'y') grid.set(K(a, level, b), c);
                        else if (axis === 'x') grid.set(K(level, a, b), c);
                        else if (axis === 'z') grid.set(K(a, b, level), c);
                    }
                };
                const doSet = (c, coords) => {
                    for (let i = 0; i + 2 < coords.length; i += 3) grid.set(K(Math.round(coords[i]), Math.round(coords[i + 1]), Math.round(coords[i + 2])), c);
                };
                const doDel = (x0, y0, z0, x1, y1, z1) => {
                    for (const x of rng(x0, x1)) for (const y of rng(y0, y1)) for (const z of rng(z0, z1)) grid.delete(K(x, y, z));
                };
                for (const op of ops) {
                    if (!Array.isArray(op) || op.length === 0) continue;
                    const name = String(op[0]).toLowerCase();
                    try {
                        if (name === 'fill') doFill(op[1], op[2], op[3], op[4], op[5], op[6], resolveColor(op[7]));
                        else if (name === 'box') doBox(op[1], op[2], op[3], op[4], op[5], op[6], resolveColor(op[7]));
                        else if (name === 'line') doLine(op[1], op[2], op[3], op[4], op[5], op[6], resolveColor(op[7]));
                        else if (name === 'rect') doRect(op[1], op[2], op[3], op[4], op[5], op[6], resolveColor(op[7]));
                        else if (name === 'set') doSet(resolveColor(op[1]), op.slice(2));
                        else if (name === 'del') doDel(op[1], op[2], op[3], op[4], op[5], op[6]);
                    } catch (e) { /* skip malformed op */ }
                }
                const voxels = [];
                for (const [k, c] of grid) {
                    const [x, y, z] = k.split(',').map(Number);
                    voxels.push({ x, y, z, color: c });
                }
                return { metadata: data.metadata || {}, voxels };
            }

            // Occlusion Culling Algorithm (high optimization for large 128x128 models)
            function computeVisibility(voxels) {
                const set = new Set();
                voxels.forEach(v => set.add(`${v.x},${v.y},${v.z}`));

                return voxels.filter(v => {
                    // If voxel is surrounded on all 6 sides, it is fully hidden
                    const neighbors = [
                        `${v.x + 1},${v.y},${v.z}`,
                        `${v.x - 1},${v.y},${v.z}`,
                        `${v.x},${v.y + 1},${v.z}`,
                        `${v.x},${v.y - 1},${v.z}`,
                        `${v.x},${v.y},${v.z + 1}`,
                        `${v.x},${v.y},${v.z - 1}`
                    ];
                    return neighbors.some(n => !set.has(n));
                });
            }

            // Render Model from currentModelData
            // Rebuild the voxel lookup map (key "x,y,z" -> color) from currentModelData.