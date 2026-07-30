/**
 * VoxelAIArtist - Importazione e Voxelizzazione GLB/GLTF
 *
 * PERCHE' NON SI USA PIU' IL RAYCASTING
 * -------------------------------------
 * La versione precedente lanciava raggi dai 6 lati della bounding box e
 * convertiva ogni `hit.point` in una coordinata voxel. Sul modello di prova ha
 * prodotto voxel con X da -940 a 1003 e Y fino a 6192 su una griglia dichiarata
 * 63x64x29: ZERO voxel dentro la griglia, quindi la vista appariva vuota pur
 * mostrando palette e conteggio corretti.
 *
 * Le cause, tutte intrinseche all'approccio a raggi in three r128:
 *
 *  1. `Box3.setFromObject()` chiama `computeBoundingBox()`, che include TUTTI i
 *     morph target (ogni fotogramma di ogni blend shape). Su un modello con
 *     morph la box usata per calcolare la scala e' enormemente piu' grande del
 *     modello visibile: la scala nasce gia' sbagliata.
 *  2. `intersectObject(scene, true)` colpisce QUALUNQUE oggetto: Line, Points,
 *     Sprite, helper degli scheletri. Per una Line il punto restituito e' quello
 *     piu' vicino SUL RAGGIO (non sul segmento), con soglia di 1 unita' di
 *     mondo: puo' cadere ovunque lungo la direzione del raggio.
 *  3. Per una SkinnedMesh, `Mesh.raycast()` in r128 usa la geometria in posa di
 *     riposo mentre la bounding box e' quella trasformata: i due non concordano.
 *
 * Nessuno si risolve con un filtro: il raggio e' lo strumento sbagliato. Qui si
 * rasterizzano direttamente i TRIANGOLI, come farebbe una GPU.
 *
 * COME FUNZIONA ORA
 * -----------------
 *  1. Raccoglie solo i nodi `isMesh` (Line/Points/Sprite esclusi per costruzione).
 *  2. Calcola la bounding box dai VERTICI REALI trasformati in world space,
 *     senza morph target: e' la box di cio' che si vede davvero.
 *  3. Per ogni triangolo campiona la superficie e riempie le celle, prendendo il
 *     colore da texture (UV baricentriche) / vertex color / materiale.
 *  4. Opzionalmente riempie l'interno con un flood fill dall'esterno.
 *  5. Riduce la palette a un numero gestibile di colori (median cut).
 *
 * Le coordinate sono clampate alla griglia per costruzione: e' impossibile che
 * un voxel finisca fuori, qualunque cosa contenga il file.
 */

/**
 * Punto d'ingresso: legge un file GLB/GLTF e ne restituisce il modello voxel.
 * `options` = { maxGridSize, fillInterior, maxColors }
 */
window.importGlbFormat = function (file, options) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function (e) {
            const buffer = e.target.result;
            let loader;
            try {
                loader = new THREE.GLTFLoader();
            } catch (err) {
                reject(new Error(t('glb.loaderMissing', { error: err.message })));
                return;
            }
            loader.parse(buffer, '', async (gltf) => {
                try {
                    resolve(await voxelizeScene(gltf.scene, options));
                } catch (err) {
                    reject(err);
                }
            }, (err) => {
                reject(new Error(t('glb.parseError', { error: (err && err.message) || err })));
            });
        };
        reader.onerror = () => reject(new Error(t('glb.readError')));
        reader.readAsArrayBuffer(file);
    });
};

// ---------------------------------------------------------------------------
// Campionamento colori da texture
// ---------------------------------------------------------------------------

function makeTextureSampler() {
    const cache = new Map();

    function canvasFor(map) {
        if (cache.has(map.uuid)) return cache.get(map.uuid);
        let entry = null;
        try {
            const img = map.image;
            const w = img && (img.width || img.videoWidth);
            const h = img && (img.height || img.videoHeight);
            if (w && h) {
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                    ctx.drawImage(img, 0, 0, w, h);
                    // Legge l'intera immagine UNA volta sola: una getImageData per
                    // ogni voxel sarebbe un trasferimento GPU->CPU per campione.
                    entry = {
                        data: ctx.getImageData(0, 0, w, h).data,
                        w: w, h: h, flipY: map.flipY !== false
                    };
                }
            }
        } catch (e) {
            entry = null;   // texture cross-origin o non decodificabile
        }
        cache.set(map.uuid, entry);
        return entry;
    }

    /** Colore [r,g,b] in 0..1 alle coordinate UV, oppure null. */
    return function sample(map, u, v) {
        if (!map) return null;
        const tex = canvasFor(map);
        if (!tex) return null;
        // Ripetizione: porta le UV in [0,1) come il wrapping della GPU.
        let tu = u - Math.floor(u);
        let tv = v - Math.floor(v);
        if (tex.flipY) tv = 1 - tv;
        let px = Math.floor(tu * tex.w);
        let py = Math.floor(tv * tex.h);
        if (px < 0) px = 0; if (px >= tex.w) px = tex.w - 1;
        if (py < 0) py = 0; if (py >= tex.h) py = tex.h - 1;
        const i = (py * tex.w + px) * 4;
        if (tex.data[i + 3] < 16) return null;   // pixel trasparente
        return [tex.data[i] / 255, tex.data[i + 1] / 255, tex.data[i + 2] / 255];
    };
}

// ---------------------------------------------------------------------------
// Riduzione della palette (median cut)
// ---------------------------------------------------------------------------

/**
 * Voxelizzare una mesh con texture produce centinaia di colori quasi identici
 * (un caso reale: 226 colori per 8392 voxel), inutilizzabili come palette voxel.
 * Il median cut divide ripetutamente l'insieme lungo il canale con la variazione
 * maggiore e usa la media pesata di ogni gruppo: e' l'algoritmo classico della
 * quantizzazione, molto piu' fedele di un arrotondamento dei bit.
 *
 * `counts` = Map("r,g,b" -> occorrenze). Ritorna Map(colore_orig -> [r,g,b]).
 */
function reducePalette(counts, maxColors) {
    const entries = [];
    counts.forEach((n, key) => {
        const p = key.split(',');
        entries.push({ r: +p[0], g: +p[1], b: +p[2], n: n, key: key });
    });
    if (entries.length <= maxColors) {
        const same = new Map();
        entries.forEach(e => same.set(e.key, [e.r, e.g, e.b]));
        return same;
    }

    let buckets = [entries];
    while (buckets.length < maxColors) {
        // Divide il gruppo con l'estensione cromatica maggiore: e' quello che
        // introdurrebbe l'errore piu' grande se lasciato intero.
        let target = -1, bestSpread = -1, bestChan = 0;
        for (let i = 0; i < buckets.length; i++) {
            const b = buckets[i];
            if (b.length < 2) continue;
            for (let c = 0; c < 3; c++) {
                const ch = c === 0 ? 'r' : (c === 1 ? 'g' : 'b');
                let lo = 255, hi = 0;
                for (const e of b) { if (e[ch] < lo) lo = e[ch]; if (e[ch] > hi) hi = e[ch]; }
                const spread = hi - lo;
                if (spread > bestSpread) { bestSpread = spread; target = i; bestChan = c; }
            }
        }
        if (target < 0 || bestSpread <= 0) break;   // non e' piu' divisibile
        const ch = bestChan === 0 ? 'r' : (bestChan === 1 ? 'g' : 'b');
        const b = buckets[target].slice().sort((x, y) => x[ch] - y[ch]);
        const mid = Math.floor(b.length / 2);
        buckets.splice(target, 1, b.slice(0, mid), b.slice(mid));
    }

    // Ogni gruppo diventa la sua media pesata sul numero di voxel: i colori
    // dominanti tirano il rappresentante verso di se'.
    const map = new Map();
    for (const b of buckets) {
        let sr = 0, sg = 0, sb = 0, sn = 0;
        for (const e of b) { sr += e.r * e.n; sg += e.g * e.n; sb += e.b * e.n; sn += e.n; }
        if (!sn) continue;
        const rep = [Math.round(sr / sn), Math.round(sg / sn), Math.round(sb / sn)];
        for (const e of b) map.set(e.key, rep);
    }
    return map;
}

function rgbToHexStr(r, g, b) {
    const h = n => {
        const s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
        return s.length === 1 ? '0' + s : s;
    };
    return ('#' + h(r) + h(g) + h(b)).toUpperCase();
}

// Chiavi palette corte e sempre valide: a..z, poi a1, b1, ...
function paletteKeyFor(n) {
    const letter = String.fromCharCode(97 + (n % 26));
    const round = Math.floor(n / 26);
    return round ? letter + round : letter;
}

// ---------------------------------------------------------------------------
// Voxelizzazione
// ---------------------------------------------------------------------------

async function voxelizeScene(gltfScene, options) {
    options = options || {};
    const maxGridSize = Math.max(8, Math.min(256, options.maxGridSize || 64));
    const fillInterior = options.fillInterior !== false;   // default: pieno
    const maxColors = Math.max(2, Math.min(256, options.maxColors || 64));

    const overlay = document.getElementById('importOverlay');
    const progBar = document.getElementById('importProgressBar');
    const progText = document.getElementById('importProgressText');
    const setProg = (pct, txt) => {
        if (progBar) progBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
        if (progText && txt) progText.textContent = txt;
    };
    const breathe = () => new Promise(r => setTimeout(r, 0));

    if (overlay) overlay.style.display = 'flex';
    setProg(0, t('glb.progAnalyze'));

    try {
        await breathe();
        gltfScene.updateMatrixWorld(true);

        // --- 1. Raccogli SOLO le mesh -------------------------------------
        // Line, Points, Sprite e Bone sono esclusi per costruzione: erano una
        // delle sorgenti di punti fuori scala nella versione a raggi.
        const meshes = [];
        gltfScene.traverse(o => {
            if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) {
                meshes.push(o);
            }
        });
        if (!meshes.length) throw new Error(t('glb.noVisibleMeshes'));

        // --- 2. Triangoli in world space ----------------------------------
        // I vertici vengono dagli attributi REALI (niente morph target, che
        // gonfiavano la bounding box) e sono trasformati con matrixWorld.
        const tris = [];
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;   // riassegnati in 2b
        const tmp = new THREE.Vector3();

        for (const mesh of meshes) {
            const geo = mesh.geometry;
            const pos = geo.attributes.position;
            const uvAttr = geo.attributes.uv;
            const colAttr = geo.attributes.color;
            const index = geo.index;
            const count = index ? index.count : pos.count;
            const isSkinned = !!(mesh.isSkinnedMesh && typeof mesh.boneTransform === 'function');

            // Cache dei vertici trasformati: un vertice e' condiviso da piu'
            // triangoli, ritrasformarlo ogni volta e' spreco puro.
            const cacheV = new Map();
            const worldVertex = (i) => {
                let v = cacheV.get(i);
                if (v) return v;
                tmp.fromBufferAttribute(pos, i);
                if (isSkinned) {
                    try { mesh.boneTransform(i, tmp); } catch (e) { /* resta la posa di riposo */ }
                }
                tmp.applyMatrix4(mesh.matrixWorld);
                v = { x: tmp.x, y: tmp.y, z: tmp.z };
                cacheV.set(i, v);
                if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
                if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
                if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
                return v;
            };

            // Materiale per gruppo (multi-material): serve a sapere quale texture
            // usare per ciascun triangolo.
            const groups = (geo.groups && geo.groups.length) ? geo.groups : null;
            const matFor = (triStart) => {
                const mm = mesh.material;
                if (!groups) return Array.isArray(mm) ? mm[0] : mm;
                for (const g of groups) {
                    if (triStart >= g.start && triStart < g.start + g.count) {
                        return Array.isArray(mm) ? mm[g.materialIndex] : mm;
                    }
                }
                return Array.isArray(mm) ? mm[0] : mm;
            };

            for (let i = 0; i + 2 < count; i += 3) {
                const a = index ? index.getX(i) : i;
                const b = index ? index.getX(i + 1) : i + 1;
                const c = index ? index.getX(i + 2) : i + 2;
                const tri = {
                    a: worldVertex(a), b: worldVertex(b), c: worldVertex(c),
                    mat: matFor(i)
                };
                if (uvAttr) {
                    tri.uv = [
                        [uvAttr.getX(a), uvAttr.getY(a)],
                        [uvAttr.getX(b), uvAttr.getY(b)],
                        [uvAttr.getX(c), uvAttr.getY(c)]
                    ];
                }
                if (colAttr) {
                    tri.vc = [
                        [colAttr.getX(a), colAttr.getY(a), colAttr.getZ(a)],
                        [colAttr.getX(b), colAttr.getY(b), colAttr.getZ(b)],
                        [colAttr.getX(c), colAttr.getY(c), colAttr.getZ(c)]
                    ];
                }
                tris.push(tri);
            }
        }

        if (!tris.length) throw new Error(t('glb.noTriangles'));

        // --- 2b. Scarta i nodi ISOLATI lontanissimi -----------------------
        // Molti GLB contengono nodi sperduti (helper, riferimenti, pezzi
        // dimenticati a migliaia di unita' dall'origine). Se entrano nella
        // bounding box, la griglia finisce per inquadrare lo spazio VUOTO fra il
        // modello e quel nodo: il modello reale si riduce a due voxel.
        // Criterio: si tiene il gruppo di triangoli attorno alla MEDIANA, e si
        // scartano quelli oltre 8 volte la dimensione mediana dell'insieme.
        // La mediana e' robusta: pochi outlier non la spostano.
        if (tris.length > 8) {
            const cx = [], cy = [], cz = [];
            for (const t of tris) {
                cx.push((t.a.x + t.b.x + t.c.x) / 3);
                cy.push((t.a.y + t.b.y + t.c.y) / 3);
                cz.push((t.a.z + t.b.z + t.c.z) / 3);
            }
            const med = (arr) => { const s2 = arr.slice().sort((p, q) => p - q); return s2[s2.length >> 1]; };
            const mx = med(cx), my = med(cy), mz = med(cz);
            // Scala di riferimento: distanza mediana dal centro (non il massimo,
            // che sarebbe dettato proprio dall'outlier che vogliamo escludere).
            const dists = [];
            for (let i = 0; i < tris.length; i++) {
                dists.push(Math.abs(cx[i] - mx) + Math.abs(cy[i] - my) + Math.abs(cz[i] - mz));
            }
            const medDist = med(dists);
            if (medDist > 0) {
                const limit = medDist * 8;
                const kept = [];
                for (let i = 0; i < tris.length; i++) {
                    if (dists[i] <= limit) kept.push(tris[i]);
                }
                // Si applica solo se resta la stragrande maggioranza del modello:
                // se scartasse meta' della mesh, il criterio non e' affidabile.
                if (kept.length >= tris.length * 0.8 && kept.length < tris.length) {
                    console.warn('[import-glb] scartati ' + (tris.length - kept.length) +
                        ' triangoli isolati lontani dal modello');
                    tris.length = 0;
                    Array.prototype.push.apply(tris, kept);
                    // Ricalcola la bounding box sui soli triangoli tenuti.
                    minX = minY = minZ = Infinity;
                    maxX = maxY = maxZ = -Infinity;
                    for (const t of tris) {
                        for (const v of [t.a, t.b, t.c]) {
                            if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
                            if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
                            if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
                        }
                    }
                }
            }
        }

        const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
        const maxDim = Math.max(sx, sy, sz);
        if (!(maxDim > 0)) throw new Error(t('glb.zeroSize'));

        // --- 3. Griglia ----------------------------------------------------
        const scale = (maxGridSize - 1) / maxDim;
        const W = Math.max(1, Math.round(sx * scale) + 1);
        const H = Math.max(1, Math.round(sy * scale) + 1);
        const D = Math.max(1, Math.round(sz * scale) + 1);

        // Da world a cella. Il clamp e' la garanzia STRUTTURALE che nessun voxel
        // possa finire fuori dalla griglia, qualunque cosa contenga il file: e'
        // esattamente cio' che mancava alla versione a raggi.
        const gx = (x) => { const v = Math.round((x - minX) * scale); return v < 0 ? 0 : (v >= W ? W - 1 : v); };
        const gy = (y) => { const v = Math.round((y - minY) * scale); return v < 0 ? 0 : (v >= H ? H - 1 : v); };
        const gz = (z) => { const v = Math.round((z - minZ) * scale); return v < 0 ? 0 : (v >= D ? D - 1 : v); };

        const sampleTex = makeTextureSampler();
        const cells = new Map();          // "x,y,z" -> [r,g,b] in 0..255

        function colorAt(tri, w0, w1, w2) {
            // Priorita': texture > vertex color > colore del materiale.
            const mat = tri.mat;
            if (tri.uv && mat && mat.map) {
                const u = tri.uv[0][0] * w0 + tri.uv[1][0] * w1 + tri.uv[2][0] * w2;
                const v = tri.uv[0][1] * w0 + tri.uv[1][1] * w1 + tri.uv[2][1] * w2;
                const t = sampleTex(mat.map, u, v);
                if (t) return [t[0] * 255, t[1] * 255, t[2] * 255];
            }
            if (tri.vc) {
                return [
                    (tri.vc[0][0] * w0 + tri.vc[1][0] * w1 + tri.vc[2][0] * w2) * 255,
                    (tri.vc[0][1] * w0 + tri.vc[1][1] * w1 + tri.vc[2][1] * w2) * 255,
                    (tri.vc[0][2] * w0 + tri.vc[1][2] * w1 + tri.vc[2][2] * w2) * 255
                ];
            }
            if (mat && mat.color) return [mat.color.r * 255, mat.color.g * 255, mat.color.b * 255];
            return [136, 136, 136];
        }

        // --- 4. Rasterizzazione dei triangoli ------------------------------
        // Campionamento baricentrico con passo inferiore a mezza cella: la
        // superficie resta senza buchi. Piu' semplice del test SAT triangolo/AABB
        // e, con questa densita', equivalente nel risultato.
        setProg(5, t('glb.progSurface'));
        const cellWorld = 1 / scale;
        let processed = 0;

        for (const tri of tris) {
            const A = tri.a, B = tri.b, C = tri.c;
            const ab = Math.sqrt((B.x - A.x) * (B.x - A.x) + (B.y - A.y) * (B.y - A.y) + (B.z - A.z) * (B.z - A.z)) / cellWorld;
            const ac = Math.sqrt((C.x - A.x) * (C.x - A.x) + (C.y - A.y) * (C.y - A.y) + (C.z - A.z) * (C.z - A.z)) / cellWorld;
            // x2 = mezza cella per campione. Tetto a 512 per non esplodere su un
            // triangolo gigante (una parete unica in una scena grande).
            const steps = Math.max(1, Math.min(512, Math.ceil(Math.max(ab, ac) * 2)));

            for (let i = 0; i <= steps; i++) {
                for (let j = 0; j <= steps - i; j++) {
                    const w1 = i / steps, w2 = j / steps, w0 = 1 - w1 - w2;
                    if (w0 < -1e-9) continue;
                    const px = A.x * w0 + B.x * w1 + C.x * w2;
                    const py = A.y * w0 + B.y * w1 + C.y * w2;
                    const pz = A.z * w0 + B.z * w1 + C.z * w2;
                    const key = gx(px) + ',' + gy(py) + ',' + gz(pz);
                    if (!cells.has(key)) cells.set(key, colorAt(tri, w0, w1, w2));
                }
            }

            processed++;
            if ((processed & 255) === 0) {
                setProg(5 + (processed / tris.length) * 65,
                    t('glb.progSurfaceCount', { done: processed, total: tris.length }));
                await breathe();
            }
        }

        if (!cells.size) throw new Error(t('glb.noVoxels'));

        // --- 5. Riempimento interno ----------------------------------------
        // Flood fill dall'ESTERNO: tutto cio' che il flood non raggiunge sta
        // dentro il guscio. Piu' robusto del test di parita', che sbaglia sulle
        // mesh non chiuse o con facce doppie.
        if (fillInterior && W * H * D <= 8000000) {
            setProg(72, t('glb.progFill'));
            await breathe();
            const idx = (x, y, z) => (z * H + y) * W + x;
            const solid = new Uint8Array(W * H * D);
            cells.forEach((_c, key) => {
                const p = key.split(',');
                solid[idx(+p[0], +p[1], +p[2])] = 1;
            });

            const outside = new Uint8Array(W * H * D);
            const stack = [];
            const seed = (x, y, z) => {
                const k = idx(x, y, z);
                if (!solid[k] && !outside[k]) { outside[k] = 1; stack.push(x, y, z); }
            };
            // Semina dalle sole facce della griglia (non da tutto il volume).
            for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) { seed(x, y, 0); seed(x, y, D - 1); }
            for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) { seed(x, 0, z); seed(x, H - 1, z); }
            for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) { seed(0, y, z); seed(W - 1, y, z); }

            while (stack.length) {
                const z = stack.pop(), y = stack.pop(), x = stack.pop();
                // Vicini calcolati sulle COORDINATE, non sull'indice lineare: un
                // +1 su x=W-1 "girerebbe" sulla riga successiva.
                for (let n = 0; n < 6; n++) {
                    let nx = x, ny = y, nz = z;
                    if (n === 0) nx++; else if (n === 1) nx--;
                    else if (n === 2) ny++; else if (n === 3) ny--;
                    else if (n === 4) nz++; else nz--;
                    if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= D) continue;
                    const nk = idx(nx, ny, nz);
                    if (!solid[nk] && !outside[nk]) { outside[nk] = 1; stack.push(nx, ny, nz); }
                }
            }

            // Le celle non raggiunte dall'esterno e non gia' piene sono interne:
            // ereditano il colore del voxel di superficie piu' vicino sopra.
            for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
                let lastColor = null;
                for (let y = H - 1; y >= 0; y--) {
                    const k = idx(x, y, z);
                    const key = x + ',' + y + ',' + z;
                    if (solid[k]) { lastColor = cells.get(key) || lastColor; continue; }
                    if (!outside[k]) cells.set(key, lastColor || [136, 136, 136]);
                }
            }
        }

        // --- 6. Palette ------------------------------------------------------
        setProg(85, t('glb.progPalette'));
        await breathe();
        const counts = new Map();
        cells.forEach(rgb => {
            const key = Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]);
            counts.set(key, (counts.get(key) || 0) + 1);
        });
        const remap = reducePalette(counts, maxColors);

        // --- 7. Payload nel formato compatto ---------------------------------
        // Raggruppa per colore in ops "set": lo stesso formato dei modelli
        // generati, quindi ricaricabile e modificabile come tutti gli altri.
        setProg(93, t('glb.progBuild'));
        await breathe();
        const byColor = new Map();
        cells.forEach((rgb, key) => {
            const ck = Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]);
            const rep = remap.get(ck) || [rgb[0], rgb[1], rgb[2]];
            const hex = rgbToHexStr(rep[0], rep[1], rep[2]);
            let list = byColor.get(hex);
            if (!list) { list = []; byColor.set(hex, list); }
            const p = key.split(',');
            list.push(+p[0], +p[1], +p[2]);
        });

        const palette = {};
        const ops = [];
        let n = 0;
        byColor.forEach((coords, hex) => {
            const key = paletteKeyFor(n++);
            palette[key] = hex;
            ops.push(['set', key].concat(coords));
        });

        console.log('[import-glb] ' + cells.size + ' voxel, ' + byColor.size +
            ' colori, griglia ' + W + 'x' + H + 'x' + D +
            ' (da ' + tris.length + ' triangoli)');

        setProg(100, t('glb.progDone'));
        return {
            metadata: { name: 'Imported_GLB', grid_size: [W, H, D] },
            palette: palette,
            ops: ops
        };
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
}
