// =======================================================================
//  03b - Deformatori (niente THREE, array piatti)
//
//  Perche' esistono: un motore che sa solo PIAZZARE volumi produce oggetti
//  fatti di mattoni. Una lama si assottiglia verso la punta e verso il
//  filo, un manico si stringe in mezzo, un tetto e' inclinato, una roccia
//  e' irregolare. Sono tutte deformazioni di una primitiva, non primitive
//  nuove: aggiungerne una al catalogo per ogni forma sarebbe un catalogo
//  infinito.
//
//  Tutti operano in SPAZIO LOCALE (primitiva centrata sull'origine) e
//  PRIMA di rotazione e traslazione: deformare dopo aver ruotato darebbe
//  una rastremazione obliqua rispetto al pezzo.
// =======================================================================

const AXIS_I = { x: 0, y: 1, z: 2 };

function axisIndex(axis) {
    const i = AXIS_I[String(axis || 'y').toLowerCase()[0]];
    return i === undefined ? 1 : i;
}

/** Estensione [min,max] della mesh lungo un asse. */
function meshExtent(m, ai) {
    const p = m.pos;
    if (!p.length) return [0, 0];
    let lo = p[ai], hi = p[ai];
    for (let i = ai; i < p.length; i += 3) {
        if (p[i] < lo) lo = p[i];
        if (p[i] > hi) hi = p[i];
    }
    return [lo, hi];
}

/** Fattore normalizzato 0..1 lungo l'asse (0 = estremo min, 1 = estremo max). */
function _tFactor(v, lo, hi) {
    const span = hi - lo;
    if (Math.abs(span) < 1e-9) return 0.5;
    const t = (v - lo) / span;
    return t < 0 ? 0 : (t > 1 ? 1 : t);
}

/**
 * Rastremazione: scala la SEZIONE trasversale lungo l'asse.
 * `s0` e `s1` sono i fattori di scala all'estremo MIN e MAX, ognuno
 * `{a, b}` sui due assi trasversali (a = primo asse in ordine XYZ).
 * E' il deformatore che fa una lama, un tronco, una gamba di un tavolo.
 */
function meshTaper(m, axis, s0, s1) {
    const ai = axisIndex(axis);
    const [lo, hi] = meshExtent(m, ai);
    const cross = [0, 1, 2].filter(i => i !== ai);
    const p = m.pos;
    const a0 = (s0 && s0.a != null) ? s0.a : 1;
    const b0 = (s0 && s0.b != null) ? s0.b : 1;
    const a1 = (s1 && s1.a != null) ? s1.a : 1;
    const b1 = (s1 && s1.b != null) ? s1.b : 1;
    for (let i = 0; i < p.length; i += 3) {
        const t = _tFactor(p[i + ai], lo, hi);
        const sa = a0 + (a1 - a0) * t;
        const sb = b0 + (b1 - b0) * t;
        p[i + cross[0]] *= sa;
        p[i + cross[1]] *= sb;
    }
    return m;
}

/**
 * Inclinazione: sposta la sezione progressivamente lungo `by`.
 * `amount` e' lo spostamento TOTALE fra i due estremi, in unita' di mondo.
 * Serve per tetti, rampe, lame a sciabola, appoggi obliqui.
 */
function meshShear(m, axis, by, amount) {
    const ai = axisIndex(axis);
    const bi = axisIndex(by);
    if (ai === bi) return m;
    const [lo, hi] = meshExtent(m, ai);
    const p = m.pos;
    for (let i = 0; i < p.length; i += 3) {
        const t = _tFactor(p[i + ai], lo, hi) - 0.5;
        p[i + bi] += amount * t;
    }
    return m;
}

/** Torsione: rotazione progressiva attorno all'asse. `deg` e' l'angolo TOTALE. */
function meshTwist(m, axis, deg) {
    const ai = axisIndex(axis);
    const [lo, hi] = meshExtent(m, ai);
    const cross = [0, 1, 2].filter(i => i !== ai);
    const p = m.pos;
    const rad = (deg || 0) * Math.PI / 180;
    for (let i = 0; i < p.length; i += 3) {
        const t = _tFactor(p[i + ai], lo, hi) - 0.5;
        const a = rad * t;
        const c = Math.cos(a), s = Math.sin(a);
        const u = p[i + cross[0]], v = p[i + cross[1]];
        p[i + cross[0]] = u * c - v * s;
        p[i + cross[1]] = u * s + v * c;
    }
    return m;
}

/**
 * Piega: curva la mesh lungo l'asse, nel piano (asse, verso).
 * `deg` e' l'angolo TOTALE della curvatura. Corni, sciabole, archi, tubi
 * piegati, code.
 */
function meshBend(m, axis, deg, towards) {
    const ai = axisIndex(axis);
    const bi = axisIndex(towards || (ai === 1 ? 'z' : 'y'));
    if (ai === bi) return m;
    const rad = (deg || 0) * Math.PI / 180;
    if (Math.abs(rad) < 1e-6) return m;
    const [lo, hi] = meshExtent(m, ai);
    const len = hi - lo;
    if (len < 1e-9) return m;
    // Raggio tale che l'arco lungo `len` copra `rad`.
    const R = len / rad;
    const p = m.pos;
    for (let i = 0; i < p.length; i += 3) {
        const s = p[i + ai] - (lo + hi) * 0.5;    // arco dal centro
        const off = p[i + bi];                     // distanza dall'asse neutro
        const a = s / R;
        const r = R - off;
        p[i + ai] = Math.sin(a) * r;
        p[i + bi] = R - Math.cos(a) * r;
    }
    return m;
}

/**
 * Irregolarita' superficiale: sposta i vertici lungo la normale con
 * value-noise. Rocce, terreno, corteccia, metallo martellato.
 * `amp` e' in unita' di mondo.
 */
function meshWarp(m, amp, freq, seed) {
    amp = amp || 0;
    if (Math.abs(amp) < 1e-9) return m;
    freq = freq || 4;
    seed = (seed || 0) * 0.137;
    const n = meshNormals(m);
    const p = m.pos;
    function hash(x, y, z) {
        let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed) * 43758.5453;
        return (h - Math.floor(h)) * 2 - 1;
    }
    function noise(x, y, z) {
        const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
        const xf = x - xi, yf = y - yi, zf = z - zi;
        const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf), sz = zf * zf * (3 - 2 * zf);
        let acc = 0;
        for (let dz = 0; dz < 2; dz++) {
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
                    acc += w * hash(xi + dx, yi + dy, zi + dz);
                }
            }
        }
        return acc;
    }
    for (let i = 0; i < p.length; i += 3) {
        const d = noise(p[i] * freq, p[i + 1] * freq, p[i + 2] * freq) * amp;
        p[i] += n[i] * d;
        p[i + 1] += n[i + 1] * d;
        p[i + 2] += n[i + 2] * d;
    }
    return m;
}

/**
 * Schiacciamento asimmetrico su UN lato: comprime solo la meta' positiva o
 * negativa di un asse. E' il "stringere solo da un lato" — un filo di lama,
 * uno scalino a sbalzo, un profilo a goccia.
 */
function meshSquash(m, axis, side, factor) {
    const ai = axisIndex(axis);
    const p = m.pos;
    const f = factor == null ? 0.5 : factor;
    const positive = String(side || 'max') !== 'min';
    for (let i = 0; i < p.length; i += 3) {
        const v = p[i + ai];
        if (positive ? v > 0 : v < 0) p[i + ai] = v * f;
    }
    return m;
}

/**
 * Scatola con RACCORDO vero (rounded box).
 *
 * Si costruisce una griglia su ogni faccia e si proietta ogni vertice sulla
 * superficie della scatola arrotondata: preso il punto piu' vicino sulla
 * scatola INTERNA (quella ristretta di `r`), il vertice finisce a distanza
 * `r` da quello. E' la definizione della rounded box, e per costruzione i
 * vertici condivisi da due facce cadono nello stesso punto — quindi il
 * guscio resta chiuso senza cuciture da saldare a mano.
 *
 * Un bevel e' cio' che distingue un oggetto costruito da un cubo grezzo, e
 * fino a ieri il campo `bevel` della spec veniva ACCETTATO E IGNORATO.
 */
function primRoundBox(sx, sy, sz, r, seg) {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const maxR = Math.min(hx, hy, hz) * 0.98;
    r = Math.max(0, Math.min(r || 0, maxR));
    if (r < 1e-6) return primBox(sx, sy, sz);
    seg = Math.max(1, Math.min(8, seg | 0 || 2));
    const ix = hx - r, iy = hy - r, iz = hz - r;

    const pos = [];
    const idx = [];
    const n = seg + 1;

    // Sei facce, ognuna una griglia (n+1)x(n+1) sul quadrato della faccia.
    const faces = [
        { o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },   // +Z
        { o: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },  // -Z
        { o: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },   // +X
        { o: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },   // -X
        { o: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },   // +Y
        { o: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },   // -Y
    ];

    function project(x, y, z) {
        // punto piu' vicino sulla scatola interna
        const cx = Math.max(-ix, Math.min(ix, x));
        const cy = Math.max(-iy, Math.min(iy, y));
        const cz = Math.max(-iz, Math.min(iz, z));
        let dx = x - cx, dy = y - cy, dz = z - cz;
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l < 1e-9) return [x, y, z];
        return [cx + dx / l * r, cy + dy / l * r, cz + dz / l * r];
    }

    for (const f of faces) {
        const base = (pos.length / 3) | 0;
        for (let j = 0; j <= n; j++) {
            const fv = (j / n) * 2 - 1;
            for (let i2 = 0; i2 <= n; i2++) {
                const fu = (i2 / n) * 2 - 1;
                const x = f.o[0] * hx + f.u[0] * fu * hx + f.v[0] * fv * hx;
                const y = f.o[1] * hy + f.u[1] * fu * hy + f.v[1] * fv * hy;
                const z = f.o[2] * hz + f.u[2] * fu * hz + f.v[2] * fv * hz;
                // Le componenti lungo l'asse della faccia restano al bordo.
                const px = f.o[0] !== 0 ? f.o[0] * hx : x;
                const py = f.o[1] !== 0 ? f.o[1] * hy : y;
                const pz = f.o[2] !== 0 ? f.o[2] * hz : z;
                const q = project(px, py, pz);
                pos.push(q[0], q[1], q[2]);
            }
        }
        const stride = n + 1;
        for (let j = 0; j < n; j++) {
            for (let i2 = 0; i2 < n; i2++) {
                const a = base + j * stride + i2;
                const b = a + 1;
                const c = a + stride;
                const d = c + 1;
                idx.push(a, b, c, b, d, c);
            }
        }
    }
    return meshCreate(pos, idx);
}

/** Sezione 2D per il loft: rettangolo, ellisse, lente (lama), esagono. */
function sectionPoints(shape, seg) {
    const s = String(shape || 'ellipse').toLowerCase();
    seg = Math.max(4, seg | 0 || 12);
    const pts = [];
    if (s === 'rect' || s === 'box') {
        // Rettangolo con densita' uniforme sul perimetro (4 lati x k punti).
        const k = Math.max(1, Math.round(seg / 4));
        const corners = [[0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5], [0.5, -0.5]];
        for (let c = 0; c < 4; c++) {
            const a = corners[c], b = corners[(c + 1) % 4];
            for (let i = 0; i < k; i++) {
                const t = i / k;
                pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
        }
    } else if (s === 'lens' || s === 'blade' || s === 'lente') {
        // Lente biconvessa: e' la sezione di una LAMA. Due archi che si
        // incontrano in due punte laterali: e' cio' che da' il filo.
        const k = Math.max(3, Math.round(seg / 2));
        for (let i = 0; i <= k; i++) {
            const t = (i / k) * 2 - 1;
            pts.push([t * 0.5, Math.cos(t * Math.PI / 2) * 0.5]);
        }
        for (let i = k - 1; i > 0; i--) {
            const t = (i / k) * 2 - 1;
            pts.push([t * 0.5, -Math.cos(t * Math.PI / 2) * 0.5]);
        }
    } else if (s === 'hex' || s === 'hexagon') {
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
            pts.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5]);
        }
    } else if (s === 'tri') {
        for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
            pts.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5]);
        }
    } else {
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            pts.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5]);
        }
    }
    return pts;
}

/**
 * Loft con sezione a scelta e scala per-sezione su DUE assi.
 * Sostituisce il vecchio loft sempre-ellittico: una carrozzeria, un fusto,
 * una lama non sono cilindri schiacciati.
 */
function primLoft2(secs, shape, seg, axis, closedEnds) {
    if (!secs || secs.length < 2) return primCyl(0.5, 1, seg, 1, axis);
    const sorted = secs.slice().sort((a, b) => a.at - b.at);
    const ring = sectionPoints(shape, seg);
    const rn = ring.length;
    const pos = [];
    const idx = [];
    for (let i = 0; i < sorted.length; i++) {
        const sc = sorted[i];
        const sa = (sc.s && sc.s[0] != null) ? sc.s[0] : 1;
        const sb = (sc.s && sc.s[1] != null) ? sc.s[1] : sa;
        for (let k = 0; k < rn; k++) {
            pos.push(ring[k][0] * sa, sc.at, ring[k][1] * sb);
        }
    }
    for (let i = 0; i < sorted.length - 1; i++) {
        for (let k = 0; k < rn; k++) {
            const k2 = (k + 1) % rn;
            const a = i * rn + k, b = i * rn + k2;
            const c = (i + 1) * rn + k, d = (i + 1) * rn + k2;
            idx.push(a, c, b, b, c, d);
        }
    }
    if (closedEnds !== false) {
        for (const [si, flip] of [[0, true], [sorted.length - 1, false]]) {
            const base = si * rn;
            const ci = (pos.length / 3) | 0;
            let cx = 0, cy = 0, cz = 0;
            for (let k = 0; k < rn; k++) {
                cx += pos[(base + k) * 3];
                cy += pos[(base + k) * 3 + 1];
                cz += pos[(base + k) * 3 + 2];
            }
            pos.push(cx / rn, cy / rn, cz / rn);
            for (let k = 0; k < rn; k++) {
                const k2 = (k + 1) % rn;
                if (flip) idx.push(ci, base + k, base + k2);
                else idx.push(ci, base + k2, base + k);
            }
        }
    }
    let m = meshCreate(pos, idx);
    // NON si ricentra: in un loft le `secs.at` sono coordinate ASSOLUTE
    // sull'asse, cosi' il costruttore le prende dal piano (`lama_a`, `lama_b`)
    // e non deve calcolare un centro. Ricentrare qui renderebbe falsa quella
    // promessa e sposterebbe ogni loft di mezza lunghezza.
    if (axis === 'x') meshRotate(m, 0, 0, -90);
    else if (axis === 'z') meshRotate(m, 90, 0, 0);
    return m;
}

/** Normalizza il campo `taper`/`taper0` in `{a, b}`. */
function _taperPair(v, fallback) {
    if (v == null) return null;
    if (typeof v === 'number') return { a: v, b: v };
    if (typeof v === 'object') {
        const a = (v.a != null) ? v.a : (v.x != null ? v.x : (v.w != null ? v.w : 1));
        const b = (v.b != null) ? v.b : (v.z != null ? v.z : (v.d != null ? v.d : a));
        return { a: a, b: b };
    }
    return fallback || null;
}

/**
 * Applica tutti i deformatori dichiarati su un nodo GIA' risolto.
 * L'ordine e' fisso e non e' arbitrario: rastremare dopo aver piegato
 * darebbe una sezione che varia lungo una curva invece che lungo il pezzo.
 */
function applyDeformers(m, node) {
    const axis = node.axis || 'y';
    // 1. rastremazione (sezione lungo l'asse)
    const t1 = _taperPair(node.taperTo != null ? node.taperTo : node.taperObj);
    const t0 = _taperPair(node.taper0);
    if (t0 || t1) {
        meshTaper(m, axis, t0 || { a: 1, b: 1 }, t1 || { a: 1, b: 1 });
    }
    // 2. schiacciamento asimmetrico
    if (node.squash) {
        meshSquash(m, node.squash.axis || 'z', node.squash.side,
                   node.squash.f != null ? node.squash.f : 0.5);
    }
    // 3. inclinazione
    if (node.shear && node.shear.by != null) {
        meshShear(m, axis, node.shear.by, node.shear.amount || 0);
    }
    // 4. torsione
    if (node.twist) meshTwist(m, axis, node.twist);
    // 5. piega
    if (node.bendA) meshBend(m, axis, node.bendA, node.bendTo);
    // 6. irregolarita'
    if (node.warp && node.warp.amp) {
        meshWarp(m, node.warp.amp, node.warp.freq, node.warp.seed);
    }
    return m;
}
