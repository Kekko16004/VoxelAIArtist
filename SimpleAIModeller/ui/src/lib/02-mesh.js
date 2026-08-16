// =======================================================================
//  02 - Mesh a array piatti (niente THREE)
//
//  Una mesh e' { pos:Float32Array|number[], idx:Uint32Array|number[],
//                mat?:string, name?:string }. Nessuna normale qui: si
//  calcolano al confine (quando si costruisce la BufferGeometry) oppure
//  per i validatori che ne hanno bisogno.
//
//  Tutte le trasformazioni mutano UNA copia: le primitive pure non si
//  toccano, cosi' un array di 20 istanze non deforma la sorgente.
// =======================================================================

function meshCreate(pos, idx, mat, name) {
    return {
        pos: (pos instanceof Float32Array) ? pos : new Float32Array(pos || []),
        idx: (idx instanceof Uint32Array) ? idx : new Uint32Array(idx || []),
        mat: mat || '',
        name: name || '',
    };
}

function meshClone(m) {
    return {
        pos: new Float32Array(m.pos),
        idx: new Uint32Array(m.idx),
        mat: m.mat || '',
        name: m.name || '',
    };
}

function meshVertCount(m) { return (m.pos.length / 3) | 0; }
function meshTriCount(m) { return (m.idx.length / 3) | 0; }

function meshIsEmpty(m) {
    return !m || m.pos.length < 9 || m.idx.length < 3;
}

function meshBounds(m) {
    const p = m.pos;
    if (!p.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
    let minX = p[0], minY = p[1], minZ = p[2];
    let maxX = p[0], maxY = p[1], maxZ = p[2];
    for (let i = 3; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
        size: [maxX - minX, maxY - minY, maxZ - minZ],
        center: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
    };
}

function meshTranslate(m, dx, dy, dz) {
    const p = m.pos;
    for (let i = 0; i < p.length; i += 3) {
        p[i] += dx; p[i + 1] += dy; p[i + 2] += dz;
    }
    return m;
}

function meshScale(m, sx, sy, sz) {
    if (sy == null) sy = sx;
    if (sz == null) sz = sx;
    const p = m.pos;
    for (let i = 0; i < p.length; i += 3) {
        p[i] *= sx; p[i + 1] *= sy; p[i + 2] *= sz;
    }
    return m;
}

/** Rotazione Euler XYZ in GRADI, intorno all'origine. */
function meshRotate(m, rx, ry, rz) {
    const toR = Math.PI / 180;
    const cx = Math.cos((rx || 0) * toR), sx = Math.sin((rx || 0) * toR);
    const cy = Math.cos((ry || 0) * toR), sy = Math.sin((ry || 0) * toR);
    const cz = Math.cos((rz || 0) * toR), sz = Math.sin((rz || 0) * toR);
    const p = m.pos;
    for (let i = 0; i < p.length; i += 3) {
        let x = p[i], y = p[i + 1], z = p[i + 2];
        // X
        let y2 = y * cx - z * sx;
        let z2 = y * sx + z * cx;
        y = y2; z = z2;
        // Y
        let x2 = x * cy + z * sy;
        z2 = -x * sy + z * cy;
        x = x2; z = z2;
        // Z
        x2 = x * cz - y * sz;
        y2 = x * sz + y * cz;
        p[i] = x2; p[i + 1] = y2; p[i + 2] = z;
    }
    return m;
}

function meshMirror(m, axis) {
    const p = m.pos;
    const a = (axis === 'y') ? 1 : (axis === 'z') ? 2 : 0;
    for (let i = 0; i < p.length; i += 3) p[i + a] = -p[i + a];
    // Specchiare inverte l'orientamento delle facce: si scambiano i due
    // indici di ogni triangolo, altrimenti le normali puntano dentro.
    meshReverse(m);
    return m;
}

/** Scambia due indici per triangolo: inverte il verso di TUTTE le facce. */
function meshReverse(m) {
    const idx = m.idx;
    for (let i = 0; i < idx.length; i += 3) {
        const t = idx[i + 1];
        idx[i + 1] = idx[i + 2];
        idx[i + 2] = t;
    }
    return m;
}

/**
 * Porta le normali VERSO L'ESTERNO, ribaltando la mesh se il volume firmato
 * e' negativo.
 *
 * Serve perche' il verso delle facce non e' una preferenza estetica: decide
 * cosa si vede e cosa si sottrae. Con `THREE.FrontSide` (anteprima ed export)
 * un guscio rovesciato e' TRASPARENTE — si guarda dentro l'oggetto; il
 * contorno toon a guscio invertito (`BackSide`) disegna le facce VICINE e
 * copre il pezzo di nero; e la CSG deduce il dentro/fuori dalla normale della
 * faccia, quindi un utensile rovesciato fa dire a una sottrazione "togli tutto
 * cio' che sta FUORI dal cilindro" e restituisce il TAPPO invece del buco.
 *
 * Misurato: 12 delle 24 primitive nascevano rovesciate (sphere, cyl anche a
 * settore, torus anche ad arco, tube, extr, lathe, tubepath, e loft con
 * sezione `lens`), tutte con ZERO spigoli di bordo — gusci chiusi, solo con
 * gli indici nell'ordine opposto. Normalizzare qui le sistema tutte in un
 * punto e mette al riparo anche le primitive future: correggerle una per una
 * lascerebbe il difetto pronto a rinascere alla prossima aggiunta.
 *
 * Solo su gusci CHIUSI: su una mesh aperta (l'elica non ha i tappi) il volume
 * firmato non ha significato geometrico e ribaltarla peggiorerebbe.
 */
function meshEnsureOutward(m) {
    if (!m || m.idx.length < 3) return m;
    if (meshBoundaryEdges(m) !== 0) return m;
    if (meshVolume(m) < 0) meshReverse(m);
    return m;
}

function meshMerge(list) {
    let nV = 0, nI = 0;
    for (let i = 0; i < list.length; i++) {
        if (!list[i]) continue;
        nV += list[i].pos.length;
        nI += list[i].idx.length;
    }
    const pos = new Float32Array(nV);
    const idx = new Uint32Array(nI);
    let oV = 0, oI = 0, vBase = 0;
    let mat = '', name = '';
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m) continue;
        pos.set(m.pos, oV);
        const base = vBase;
        for (let j = 0; j < m.idx.length; j++) idx[oI + j] = m.idx[j] + base;
        oV += m.pos.length;
        oI += m.idx.length;
        vBase += (m.pos.length / 3) | 0;
        if (!mat && m.mat) mat = m.mat;
        if (!name && m.name) name = m.name;
    }
    return meshCreate(pos, idx, mat, name);
}

/** Normali per-vertice mediate. Ritorna Float32Array lungo come pos. */
function meshNormals(m) {
    const p = m.pos, idx = m.idx;
    const n = new Float32Array(p.length);
    for (let i = 0; i < idx.length; i += 3) {
        const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
        const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
        const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
        const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
        const abx = bx - ax, aby = by - ay, abz = bz - az;
        const acx = cx - ax, acy = cy - ay, acz = cz - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        n[ia] += nx; n[ia + 1] += ny; n[ia + 2] += nz;
        n[ib] += nx; n[ib + 1] += ny; n[ib + 2] += nz;
        n[ic] += nx; n[ic + 1] += ny; n[ic + 2] += nz;
    }
    for (let i = 0; i < n.length; i += 3) {
        const x = n[i], y = n[i + 1], z = n[i + 2];
        const l = Math.sqrt(x * x + y * y + z * z) || 1;
        n[i] = x / l; n[i + 1] = y / l; n[i + 2] = z / l;
    }
    return n;
}

/** Area totale delle facce (per i validatori e per scartare i degeneri). */
function meshArea(m) {
    const p = m.pos, idx = m.idx;
    let area = 0;
    for (let i = 0; i < idx.length; i += 3) {
        const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
        const abx = p[ib] - p[ia], aby = p[ib + 1] - p[ia + 1], abz = p[ib + 2] - p[ia + 2];
        const acx = p[ic] - p[ia], acy = p[ic + 1] - p[ia + 1], acz = p[ic + 2] - p[ia + 2];
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        area += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    }
    return area;
}

/** Volume firmato (teorema della divergenza). Positivo se le normali escono. */
function meshVolume(m) {
    const p = m.pos, idx = m.idx;
    let vol = 0;
    for (let i = 0; i < idx.length; i += 3) {
        const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
        const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
        const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
        const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
        vol += ax * (by * cz - bz * cy)
             - ay * (bx * cz - bz * cx)
             + az * (bx * cy - by * cx);
    }
    return vol / 6;
}

/** Quanti spigoli hanno un solo triangolo adiacente (0 = chiuso).

    Si saldano i vertici PER POSIZIONE, non per indice: box e sphere sono
    costruiti con vertici duplicati sui bordi di faccia (per le normali
    piatte / la cucitura UV), e contarli come distinti farebbe risultare
    aperto un guscio che geometricamente e' chiuso.
*/
function meshBoundaryEdges(m) {
    const p = m.pos, idx = m.idx;
    const quant = 1e4; // 0.1 mm
    function vid(i) {
        const o = i * 3;
        return (Math.round(p[o] * quant)) + ',' +
               (Math.round(p[o + 1] * quant)) + ',' +
               (Math.round(p[o + 2] * quant));
    }
    const edges = new Map();
    function key(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
    for (let i = 0; i < idx.length; i += 3) {
        const a = vid(idx[i]), b = vid(idx[i + 1]), c = vid(idx[i + 2]);
        if (a === b || b === c || c === a) continue; // degenere
        for (const k of [key(a, b), key(b, c), key(c, a)]) {
            edges.set(k, (edges.get(k) || 0) + 1);
        }
    }
    let boundary = 0;
    for (const n of edges.values()) if (n === 1) boundary++;
    return boundary;
}

function meshIsClosed(m) {
    return meshBoundaryEdges(m) === 0 && meshVertCount(m) >= 4;
}
