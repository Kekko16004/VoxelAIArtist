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
                // Tetto di sicurezza sulle celle: un op malformato dell'AI (es.
                // `fill 0 0 0 299 299 299` = 27 milioni di celle) congelava il tab
                // del browser senza messaggi. Superata la soglia il modello viene
                // troncato: meglio parziale che con la UI bloccata.
                //
                // ADATTIVO alla griglia (come voxel_budget_for() in src/parser.py, che
                // DEVE restare identico): con le griglie grandi per case ed edifici un
                // tetto fisso a 4M troncava modelli legittimi.
                // 8M celle ~= 0,8 GB di heap (misurato: ~98 byte per cella fra chiave
                // stringa e valore). A 24M si arrivava a ~2,2 GB e il tab moriva.
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
                    } catch (e) { /* metadata assente o malformato */ }
                    return MAX_VOXELS;
                })();
                const budgetOk = () => grid.size < budgetLimit;
                // ATTENZIONE — PARITA' CON PYTHON (src/parser.py::expand_ops).
                // `int()` in Python TRONCA verso zero; Math.round() arrotonda al
                // piu' vicino. Con coordinate frazionarie (che l'AI produce) le due
                // implementazioni divergevano: un `fill 0.9 ... 3.9` dava x 0..3 in
                // Python e x 1..4 in JS, cioe' il modello si spostava di un voxel
                // fra viewer e file salvato. `trunc` replica esattamente `int()`.
                const trunc = (v) => Math.trunc(Number(v) || 0);
                // Python round() usa il "banker's rounding" (arrotonda .5 al PARI piu'
                // vicino): round(0.5)=0, round(1.5)=2, round(2.5)=2. Math.round()
                // arrotonda sempre verso +inf: 0.5->1, 2.5->3. La differenza si vede
                // su `line`: una diagonale con steps pari cadeva su t=0.5 esatti e i
                // due motori disegnavano scalini SFALSATI (anche con coordinate
                // intere in input). pyRound replica la semantica di Python.
                const pyRound = (v) => {
                    const n = Number(v) || 0;
                    const f = Math.floor(n);
                    const diff = n - f;
                    if (diff > 0.5) return f + 1;
                    if (diff < 0.5) return f;
                    return (f % 2 === 0) ? f : f + 1;   // esattamente .5 -> pari
                };
                const rng = (a, b) => {
                    a = trunc(a); b = trunc(b);
                    if (a > b) { const t = a; a = b; b = t; }
                    const out = [];
                    for (let i = a; i <= b; i++) out.push(i);
                    return out;
                };
                const doFill = (x0, y0, z0, x1, y1, z1, c) => {
                    for (const x of rng(x0, x1)) for (const y of rng(y0, y1)) for (const z of rng(z0, z1)) {
                        if (!budgetOk()) return;
                        grid.set(K(x, y, z), c);
                    }
                };
                const doBox = (x0, y0, z0, x1, y1, z1, c) => {
                    // Gli estremi DEVONO essere troncati come i valori iterati da
                    // rng(): confrontare un indice intero con un limite frazionario
                    // (1 === 0.5) e' sempre falso, e il guscio non veniva mai
                    // disegnato -> il box spariva completamente dal viewer.
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
                    level = trunc(level); axis = String(axis).toLowerCase();   // parita': Python usa int(level)
                    for (const a of rng(a0, a1)) for (const b of rng(b0, b1)) {
                        if (!budgetOk()) return;
                        if (axis === 'y') grid.set(K(a, level, b), c);
                        else if (axis === 'x') grid.set(K(level, a, b), c);
                        else if (axis === 'z') grid.set(K(a, b, level), c);
                    }
                };
                const doSet = (c, coords) => {
                    // parita': Python usa int() su ogni coordinata (troncamento).
                    for (let i = 0; i + 2 < coords.length; i += 3) {
                        if (!budgetOk()) return;
                        grid.set(K(trunc(coords[i]), trunc(coords[i + 1]), trunc(coords[i + 2])), c);
                    }
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