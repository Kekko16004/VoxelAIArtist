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

// =======================================================================
//  SOLIDI DI RIVOLUZIONE (vasi, bottiglie, calici, colonne, ruote, piatti)
//
//  Un vaso non e' una pila di cilindri: e' una SILHOUETTE fatta girare. Il
//  vecchio `lathe` girava i punti cosi' com'erano e non chiudeva niente, con
//  tre conseguenze tutte visibili in un render:
//    - nessun fondo e nessuno spessore: si guardava DENTRO l'oggetto;
//    - profilo a spezzata, quindi spigoli netti dove i punti si uniscono,
//      che su una ceramica si leggono come un difetto;
//    - nessun modo di chiedere "un vaso" senza scrivere a mano dieci punti.
//
//  Qui il profilo si INTERPOLA (Catmull-Rom), il solido si CHIUDE, e con
//  `wall` diventa un recipiente vero: parete esterna, parete interna, fondo
//  e labbro.
// =======================================================================

/** Silhouette note: `[r, y]` normalizzati (r in 0..0.5, y in 0..1). */
const VESSEL_PROFILES = {
    vase:    [[0.30, 0.00], [0.33, 0.04], [0.45, 0.28], [0.50, 0.42],
              [0.44, 0.58], [0.28, 0.74], [0.26, 0.86], [0.33, 1.00]],
    amphora: [[0.12, 0.00], [0.22, 0.05], [0.42, 0.22], [0.50, 0.40],
              [0.42, 0.60], [0.24, 0.76], [0.20, 0.88], [0.30, 1.00]],
    bottle:  [[0.34, 0.00], [0.36, 0.06], [0.36, 0.42], [0.30, 0.56],
              [0.15, 0.68], [0.13, 0.92], [0.17, 1.00]],
    goblet:  [[0.40, 0.00], [0.40, 0.03], [0.16, 0.10], [0.07, 0.20],
              [0.07, 0.44], [0.22, 0.54], [0.40, 0.72], [0.44, 1.00]],
    bowl:    [[0.18, 0.00], [0.28, 0.06], [0.44, 0.30], [0.50, 0.70],
              [0.50, 1.00]],
    pot:     [[0.30, 0.00], [0.33, 0.05], [0.42, 0.45], [0.46, 0.85],
              [0.50, 1.00]],
    urn:     [[0.22, 0.00], [0.34, 0.08], [0.50, 0.35], [0.46, 0.66],
              [0.30, 0.88], [0.34, 1.00]],
    column:  [[0.44, 0.00], [0.50, 0.04], [0.46, 0.10], [0.44, 0.50],
              [0.40, 0.90], [0.48, 0.96], [0.50, 1.00]],
    baluster:[[0.36, 0.00], [0.40, 0.06], [0.22, 0.16], [0.38, 0.34],
              [0.44, 0.48], [0.30, 0.66], [0.16, 0.80], [0.34, 0.94],
              [0.38, 1.00]],
    plate:   [[0.00, 0.00], [0.30, 0.02], [0.44, 0.10], [0.50, 0.24],
              [0.50, 0.30]],
    dome:    [[0.50, 0.00], [0.49, 0.20], [0.44, 0.50], [0.30, 0.80],
              [0.00, 1.00]],
    barrel:  [[0.40, 0.00], [0.44, 0.10], [0.50, 0.50], [0.44, 0.90],
              [0.40, 1.00]],
};

const VESSEL_ALIASES = {
    vaso: 'vase', anfora: 'amphora', bottiglia: 'bottle', calice: 'goblet',
    chalice: 'goblet', cup: 'goblet', bicchiere: 'goblet', ciotola: 'bowl',
    scodella: 'bowl', pentola: 'pot', vasetto: 'pot', giara: 'urn',
    urna: 'urn', colonna: 'column', pilastro: 'column', balaustra: 'baluster',
    piatto: 'plate', dish: 'plate', cupola: 'dome', botte: 'barrel',
    keg: 'barrel', jar: 'urn',
};

function vesselProfile(name) {
    const s = String(name || '').trim().toLowerCase();
    const key = VESSEL_ALIASES[s] || s;
    const p = VESSEL_PROFILES[key];
    return p ? p.map(q => [q[0], q[1]]) : null;
}

/**
 * Interpolazione Catmull-Rom del profilo: pochi punti, silhouette liscia.
 * Senza questo il contorno e' una spezzata, e su un vaso gli spigoli fra i
 * segmenti si vedono come difetti di modellazione.
 */
function smoothProfile(pts, samples) {
    if (!pts || pts.length < 2) return pts || [];
    if (pts.length === 2 || samples <= pts.length) return pts.map(p => [p[0], p[1]]);
    const n = pts.length;
    const out = [];
    const total = Math.max(pts.length, samples | 0);
    for (let i = 0; i < total; i++) {
        const t = (i / (total - 1)) * (n - 1);
        const k = Math.min(n - 2, Math.floor(t));
        const f = t - k;
        // Punti di controllo con estremi duplicati: la curva parte e finisce
        // esattamente sul primo e sull'ultimo punto, che su un profilo e'
        // obbligatorio (il fondo e il labbro non si spostano).
        const p0 = pts[Math.max(0, k - 1)];
        const p1 = pts[k];
        const p2 = pts[Math.min(n - 1, k + 1)];
        const p3 = pts[Math.min(n - 1, k + 2)];
        const f2 = f * f, f3 = f2 * f;
        const cr = (a, b, c, d) =>
            0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f2
                   + (-a + 3 * b - 3 * c + d) * f3);
        out.push([Math.max(0, cr(p0[0], p1[0], p2[0], p3[0])),
                  cr(p0[1], p1[1], p2[1], p3[1])]);
    }
    return out;
}

/**
 * Rivoluzione di un profilo, con o senza parete.
 *
 * `prof`  : lista `[r, y]` dal BASSO verso l'ALTO, oppure un nome noto.
 * `wall`  : spessore della parete. > 0 => recipiente CAVO (parete interna,
 *           fondo e labbro). 0 => solido pieno.
 * `arc`   : gradi di rivoluzione (360 = intero).
 */
function primLathe2(prof, sides, arc, axis, wall, smooth) {
    let pts = Array.isArray(prof) ? prof.map(p => [Math.abs(p[0]), p[1]]) : vesselProfile(prof);
    if (!pts || pts.length < 2) return primCyl(0.5, 1, sides, 1, axis);
    pts.sort((a, b) => a[1] - b[1]);

    sides = Math.max(6, sides | 0 || 16);
    const samples = smooth === false ? pts.length
        : Math.max(pts.length, Math.min(64, pts.length * 5));
    pts = smoothProfile(pts, samples);

    if (arc == null) arc = 360;
    const arcR = (arc / 360) * Math.PI * 2;
    const closedRing = Math.abs(arc - 360) < 0.5;
    const segs = closedRing ? sides : Math.max(3, Math.ceil(sides * arc / 360));

    const yBottom = pts[0][1];
    const yTop = pts[pts.length - 1][1];
    const w = Math.max(0, wall || 0);

    const pos = [];
    const idx = [];

    function ringOf(profile) {
        const base = (pos.length / 3) | 0;
        for (let i = 0; i <= segs; i++) {
            const a = (i / segs) * arcR;
            const c = Math.cos(a), s = Math.sin(a);
            for (let j = 0; j < profile.length; j++) {
                pos.push(profile[j][0] * c, profile[j][1], profile[j][0] * s);
            }
        }
        return { base: base, stride: profile.length, count: profile.length };
    }

    function quads(ring, flip) {
        for (let i = 0; i < segs; i++) {
            for (let j = 0; j < ring.count - 1; j++) {
                const a = ring.base + i * ring.stride + j;
                const b = a + ring.stride;
                if (flip) idx.push(a, a + 1, b, a + 1, b + 1, b);
                else idx.push(a, b, a + 1, a + 1, b, b + 1);
            }
        }
    }

    const outer = ringOf(pts);
    quads(outer, false);

    if (w > 1e-6) {
        // Parete interna: stesso profilo rientrato di `wall`, dal fondo+wall
        // in su. Il raggio si tiene positivo: su un collo strettissimo la
        // parete si assottiglia invece di rivoltarsi.
        const inner = [];
        for (let j = 0; j < pts.length; j++) {
            const y = pts[j][1];
            if (y < yBottom + w) continue;
            inner.push([Math.max(0.0004, pts[j][0] - w), y]);
        }
        if (inner.length >= 2) {
            inner[0] = [inner[0][0], yBottom + w];
            const inRing = ringOf(inner);
            quads(inRing, true);          // normali verso l'interno
            // Labbro: anello che unisce il bordo esterno a quello interno.
            for (let i = 0; i < segs; i++) {
                const o0 = outer.base + i * outer.stride + (outer.count - 1);
                const o1 = o0 + outer.stride;
                const i0 = inRing.base + i * inRing.stride + (inRing.count - 1);
                const i1 = i0 + inRing.stride;
                idx.push(o0, i0, o1, i0, i1, o1);
            }
            // Fondo interno: disco alla quota yBottom+w.
            const cIn = (pos.length / 3) | 0;
            pos.push(0, yBottom + w, 0);
            for (let i = 0; i < segs; i++) {
                const a = inRing.base + i * inRing.stride;
                const b = inRing.base + ((i + 1) % (segs + 1)) * inRing.stride;
                idx.push(cIn, a, b);
            }
        }
    } else if (pts[pts.length - 1][0] > 1e-5) {
        // Solido: coperchio in cima (se il profilo non finisce a punta).
        const cTop = (pos.length / 3) | 0;
        pos.push(0, yTop, 0);
        for (let i = 0; i < segs; i++) {
            const a = outer.base + i * outer.stride + (outer.count - 1);
            const b = outer.base + ((i + 1) % (segs + 1)) * outer.stride + (outer.count - 1);
            idx.push(cTop, a, b);
        }
    }

    // Fondo esterno: sempre, anche sul solido. Senza, si guarda dentro
    // l'oggetto da sotto — ed e' esattamente cio' che faceva il vaso.
    if (pts[0][0] > 1e-5) {
        const cBot = (pos.length / 3) | 0;
        pos.push(0, yBottom, 0);
        for (let i = 0; i < segs; i++) {
            const a = outer.base + i * outer.stride;
            const b = outer.base + ((i + 1) % (segs + 1)) * outer.stride;
            idx.push(cBot, b, a);
        }
    }

    let m = meshCreate(pos, idx);
    if (axis === 'x') meshRotate(m, 0, 0, -90);
    else if (axis === 'z') meshRotate(m, 90, 0, 0);
    return m;
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
