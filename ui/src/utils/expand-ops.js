            function expandOps(data) {
                if (!data || typeof data !== 'object') return data;
                const ops = data.ops;
                const parts = data.parts;
                if ((!ops || !Array.isArray(ops) || ops.length === 0) && (!parts || typeof parts !== 'object')) {
                    if (!Array.isArray(data.voxels)) data.voxels = [];
                    return data;
                }
                const palette = data.palette || {};
                const resolveColor = (key) => {
                    if (typeof key === 'string' && key.startsWith('#')) return key.toUpperCase();
                    let col = palette[key];
                    if (!col && typeof key === 'string') {
                        const normKey = key.normalize ? key.normalize('NFC') : key;
                        for (const k in palette) {
                            if (k === normKey || (k.normalize && k.normalize('NFC') === normKey)) {
                                col = palette[k];
                                break;
                            }
                        }
                    }
                    return (typeof col === 'string' && col) ? col.toUpperCase() : '#CCCCCC';
                };
                const MAX_VOXELS = 4000000;
                const MAX_VOXELS_ABSOLUTE = 8000000;
                const budgetLimit = (function () {
                    try {
                        const g = (data.metadata && data.metadata.grid_size) || null;
                        if (Array.isArray(g) && g.length === 3) {
                            const w = parseInt(g[0], 10), h = parseInt(g[1], 10), d = parseInt(g[2], 10);
                            if (w > 0 && h > 0 && d > 0) {
                                const half = Math.floor((w * h * d) / 2);
                                return Math.max(MAX_VOXELS, Math.min(half, MAX_VOXELS_ABSOLUTE));
                            }
                        }
                    } catch (e) {}
                    return MAX_VOXELS;
                })();
                const trunc = (v) => Math.trunc(Number(v) || 0);
                const pyRound = (v) => {
                    const n = Number(v) || 0;
                    const f = Math.floor(n);
                    const diff = n - f;
                    if (diff > 0.5) return f + 1;
                    if (diff < 0.5) return f;
                    return (f % 2 === 0) ? f : f + 1;
                };
                const rng = (a, b) => {
                    a = trunc(a); b = trunc(b);
                    if (a > b) { const t = a; a = b; b = t; }
                    const out = [];
                    for (let i = a; i <= b; i++) out.push(i);
                    return out;
                };

                function processOps(opList, grid, globalVoxelCount) {
                    const budgetOk = () => (grid.size + globalVoxelCount) < budgetLimit;
                    const K = (x, y, z) => `${x},${y},${z}`;
                    const doFill = (x0, y0, z0, x1, y1, z1, c) => {
                        for (const x of rng(x0, x1)) for (const y of rng(y0, y1)) for (const z of rng(z0, z1)) {
                            if (!budgetOk()) return;
                            grid.set(K(x, y, z), c);
                        }
                    };
                    const doBox = (x0, y0, z0, x1, y1, z1, c) => {
                        const xmin = Math.min(trunc(x0), trunc(x1)), xmax = Math.max(trunc(x0), trunc(x1));
                        const ymin = Math.min(trunc(y0), trunc(y1)), ymax = Math.max(trunc(y0), trunc(y1));
                        const zmin = Math.min(trunc(z0), trunc(z1)), zmax = Math.max(trunc(z0), trunc(z1));
                        for (const x of rng(x0, x1)) for (const y of rng(y0, y1)) for (const z of rng(z0, z1)) {
                            if (x === xmin || x === xmax || y === ymin || y === ymax || z === zmin || z === zmax) {
                                if (!budgetOk()) return;
                                grid.set(K(x, y, z), c);
                            }
                        }
                    };
                    const doLine = (x0, y0, z0, x1, y1, z1, c) => {
                        x0 = trunc(x0); y0 = trunc(y0); z0 = trunc(z0);
                        x1 = trunc(x1); y1 = trunc(y1); z1 = trunc(z1);
                        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
                        if (steps === 0) { grid.set(K(x0, y0, z0), c); return; }
                        for (let i = 0; i <= steps; i++) {
                            const t = i / steps;
                            if (!budgetOk()) return;
                            grid.set(K(pyRound(x0 + (x1 - x0) * t), pyRound(y0 + (y1 - y0) * t), pyRound(z0 + (z1 - z0) * t)), c);
                        }
                    };
                    const doRect = (axis, level, a0, b0, a1, b1, c) => {
                        level = trunc(level); axis = String(axis).toLowerCase();
                        for (const a of rng(a0, a1)) for (const b of rng(b0, b1)) {
                            if (!budgetOk()) return;
                            if (axis === 'y') grid.set(K(a, level, b), c);
                            else if (axis === 'x') grid.set(K(level, a, b), c);
                            else if (axis === 'z') grid.set(K(a, b, level), c);
                        }
                    };
                    const doSet = (c, coords) => {
                        for (let i = 0; i + 2 < coords.length; i += 3) {
                            if (!budgetOk()) return;
                            grid.set(K(trunc(coords[i]), trunc(coords[i + 1]), trunc(coords[i + 2])), c);
                        }
                    };
                    const doDel = (x0, y0, z0, x1, y1, z1) => {
                        for (const x of rng(x0, x1)) for (const y of rng(y0, y1)) for (const z of rng(z0, z1)) grid.delete(K(x, y, z));
                    };
                    for (const op of opList) {
                        if (!Array.isArray(op) || op.length === 0) continue;
                        const name = String(op[0]).toLowerCase();
                        try {
                            if (name === 'fill') doFill(op[1], op[2], op[3], op[4], op[5], op[6], resolveColor(op[7]));
                            else if (name === 'box') doBox(op[1], op[2], op[3], op[4], op[5], op[6], resolveColor(op[7]));
                            else if (name === 'line') doLine(op[1], op[2], op[3], op[4], op[5], op[6], resolveColor(op[7]));
                            else if (name === 'rect') doRect(op[1], op[2], op[3], op[4], op[5], op[6], resolveColor(op[7]));
                            else if (name === 'set') doSet(resolveColor(op[1]), op.slice(2));
                            else if (name === 'del') doDel(op[1], op[2], op[3], op[4], op[5], op[6]);
                        } catch (e) {}
                    }
                }

                const allVoxels = [];

                if (parts && typeof parts === 'object' && Object.keys(parts).length > 0) {
                    let globalCount = 0;
                    for (const partName in parts) {
                        if (!Array.isArray(parts[partName])) continue;
                        const grid = new Map();
                        processOps(parts[partName], grid, globalCount);
                        for (const [k, c] of grid) {
                            const [x, y, z] = k.split(',').map(Number);
                            allVoxels.push({ x, y, z, color: c, part: partName });
                        }
                        globalCount = allVoxels.length;
                    }
                } else if (ops && Array.isArray(ops)) {
                    const grid = new Map();
                    processOps(ops, grid, 0);
                    for (const [k, c] of grid) {
                        const [x, y, z] = k.split(',').map(Number);
                        allVoxels.push({ x, y, z, color: c });
                    }
                }

                return { metadata: data.metadata || {}, voxels: allVoxels };
            }

            // Occlusion Culling Algorithm — compact numeric key (avoids 32-bit signed overflow)
            function computeVisibility(voxels) {
                if (!voxels || !voxels.length) return voxels;
                // Usa moltiplicatori numeri primi grandi ma sicuri per non avere collisioni
                // senza traboccare int32. MAX coord per asse <= 4095, offset 1 per negativi.
                const OFF = 1;
                const MX = 4097, MY = 4097;
                const set = new Set();
                const len = voxels.length;
                for (let i = 0; i < len; i++) {
                    const v = voxels[i];
                    set.add((v.x + OFF) + (v.y + OFF) * MX + (v.z + OFF) * MX * MY);
                }
                const visible = [];
                for (let i = 0; i < len; i++) {
                    const v = voxels[i];
                    const ox = v.x + OFF;
                    const oy = v.y + OFF;
                    const oz = v.z + OFF;
                    if (!set.has((ox+1) + oy*MX + oz*MX*MY) ||
                        !set.has((ox-1) + oy*MX + oz*MX*MY) ||
                        !set.has(ox + (oy+1)*MX + oz*MX*MY) ||
                        !set.has(ox + (oy-1)*MX + oz*MX*MY) ||
                        !set.has(ox + oy*MX + (oz+1)*MX*MY) ||
                        !set.has(ox + oy*MX + (oz-1)*MX*MY)) {
                        visible.push(v);
                    }
                }
                return visible;
            }

            // Render Model from currentModelData
            // Rebuild the voxel lookup map (key "x,y,z" -> color) from currentModelData.