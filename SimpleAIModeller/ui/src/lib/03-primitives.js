// =======================================================================
//  03 - Primitive parametriche (niente THREE)
//
//  Ogni funzione ritorna {pos, idx}. Le dimensioni sono PIENE (non il
//  raggio) dove c'e' `s`, e il centro e' l'origine. `seg` decide quanti
//  spicchi hanno le forme tonde.
// =======================================================================

const DETAIL_LEVELS = [
    { seg: 8,  bevel: 1, nodes: 12 },
    { seg: 12, bevel: 1, nodes: 30 },
    { seg: 20, bevel: 2, nodes: 80 },
    { seg: 32, bevel: 3, nodes: 200 },
];

function primBox(sx, sy, sz) {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    // 24 vertici (4 per faccia) cosi' le normali per-faccia restano piatte.
    const pos = new Float32Array([
        // +Z
        -hx, -hy,  hz,  hx, -hy,  hz,  hx,  hy,  hz, -hx,  hy,  hz,
        // -Z
         hx, -hy, -hz, -hx, -hy, -hz, -hx,  hy, -hz,  hx,  hy, -hz,
        // +X
         hx, -hy,  hz,  hx, -hy, -hz,  hx,  hy, -hz,  hx,  hy,  hz,
        // -X
        -hx, -hy, -hz, -hx, -hy,  hz, -hx,  hy,  hz, -hx,  hy, -hz,
        // +Y
        -hx,  hy,  hz,  hx,  hy,  hz,  hx,  hy, -hz, -hx,  hy, -hz,
        // -Y
        -hx, -hy, -hz,  hx, -hy, -hz,  hx, -hy,  hz, -hx, -hy,  hz,
    ]);
    const idx = new Uint32Array([
        0,1,2, 0,2,3,  4,5,6, 4,6,7,  8,9,10, 8,10,11,
        12,13,14, 12,14,15,  16,17,18, 16,18,19,  20,21,22, 20,22,23,
    ]);
    return meshCreate(pos, idx);
}

function primPlane(sx, sz) {
    const hx = sx * 0.5, hz = sz * 0.5;
    return meshCreate(
        new Float32Array([-hx, 0, -hz,  hx, 0, -hz,  hx, 0,  hz, -hx, 0,  hz]),
        new Uint32Array([0, 1, 2, 0, 2, 3]));
}

function primSphere(r, seg) {
    seg = Math.max(6, seg | 0);
    const rings = Math.max(3, (seg / 2) | 0);
    const pos = [];
    const idx = [];
    for (let y = 0; y <= rings; y++) {
        const v = y / rings;
        const phi = v * Math.PI;
        const sp = Math.sin(phi), cp = Math.cos(phi);
        for (let x = 0; x <= seg; x++) {
            const u = x / seg;
            const th = u * Math.PI * 2;
            pos.push(r * sp * Math.cos(th), r * cp, r * sp * Math.sin(th));
        }
    }
    const stride = seg + 1;
    for (let y = 0; y < rings; y++) {
        for (let x = 0; x < seg; x++) {
            const a = y * stride + x;
            const b = a + stride;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    return meshCreate(pos, idx);
}

/** Cilindro lungo `axis` (default Y). `taper` e' il raggio in cima / raggio base. */
function primCyl(r, len, seg, taper, axis) {
    seg = Math.max(6, seg | 0);
    if (taper == null) taper = 1;
    const half = len * 0.5;
    const rTop = r * taper;
    const pos = [];
    const idx = [];
    // laterale: 2 anelli
    for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        pos.push(r * c, -half, r * s);
        pos.push(rTop * c, half, rTop * s);
    }
    for (let i = 0; i < seg; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, c, b, b, c, d);
    }
    // coperchi (fan)
    if (r > 1e-6) {
        const baseCenter = (pos.length / 3) | 0;
        pos.push(0, -half, 0);
        const baseStart = (pos.length / 3) | 0;
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            pos.push(r * Math.cos(a), -half, r * Math.sin(a));
        }
        for (let i = 0; i < seg; i++) {
            idx.push(baseCenter, baseStart + ((i + 1) % seg), baseStart + i);
        }
    }
    if (rTop > 1e-6) {
        const topCenter = (pos.length / 3) | 0;
        pos.push(0, half, 0);
        const topStart = (pos.length / 3) | 0;
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            pos.push(rTop * Math.cos(a), half, rTop * Math.sin(a));
        }
        for (let i = 0; i < seg; i++) {
            idx.push(topCenter, topStart + i, topStart + ((i + 1) % seg));
        }
    }
    let m = meshCreate(pos, idx);
    if (axis === 'x') meshRotate(m, 0, 0, -90);
    else if (axis === 'z') meshRotate(m, 90, 0, 0);
    return m;
}

function primCaps(r, len, seg, axis) {
    // Capsula = cilindro + due emisfere. `len` e' la lunghezza TOTALE inclusi i cappucci.
    seg = Math.max(6, seg | 0);
    const body = Math.max(0, len - 2 * r);
    const parts = [];
    if (body > 1e-6) parts.push(primCyl(r, body, seg, 1, 'y'));
    // emisfera superiore
    const hemi = Math.max(3, (seg / 2) | 0);
    function hemiSphere(sign) {
        const pos = [], idx = [];
        for (let y = 0; y <= hemi; y++) {
            const v = y / hemi;
            const phi = v * Math.PI * 0.5;
            const sp = Math.sin(phi), cp = Math.cos(phi);
            for (let x = 0; x <= seg; x++) {
                const th = (x / seg) * Math.PI * 2;
                pos.push(r * sp * Math.cos(th),
                         sign * (body * 0.5 + r * cp),
                         r * sp * Math.sin(th));
            }
        }
        const stride = seg + 1;
        for (let y = 0; y < hemi; y++) {
            for (let x = 0; x < seg; x++) {
                const a = y * stride + x, b = a + stride;
                if (sign > 0) idx.push(a, a + 1, b, a + 1, b + 1, b);
                else idx.push(a, b, a + 1, a + 1, b, b + 1);
            }
        }
        return meshCreate(pos, idx);
    }
    parts.push(hemiSphere(1), hemiSphere(-1));
    let m = meshMerge(parts);
    if (axis === 'x') meshRotate(m, 0, 0, -90);
    else if (axis === 'z') meshRotate(m, 90, 0, 0);
    return m;
}

function primTorus(R, r, seg, arc) {
    seg = Math.max(6, seg | 0);
    const tube = Math.max(6, (seg / 2) | 0);
    if (arc == null) arc = 360;
    const arcR = (arc / 360) * Math.PI * 2;
    const closed = Math.abs(arc - 360) < 0.5;
    const segs = closed ? seg : Math.max(3, Math.ceil(seg * arc / 360));
    const pos = [];
    const idx = [];
    for (let i = 0; i <= segs; i++) {
        const u = (i / segs) * arcR;
        const cu = Math.cos(u), su = Math.sin(u);
        for (let j = 0; j <= tube; j++) {
            const v = (j / tube) * Math.PI * 2;
            const cv = Math.cos(v), sv = Math.sin(v);
            pos.push((R + r * cv) * cu, r * sv, (R + r * cv) * su);
        }
    }
    const stride = tube + 1;
    for (let i = 0; i < segs; i++) {
        for (let j = 0; j < tube; j++) {
            const a = i * stride + j, b = a + stride;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    return meshCreate(pos, idx);
}

function primWedge(sx, sy, sz) {
    // Cuneo: triangolo nel piano XY estruso su Z. Base a y=-hy, punta a +X.
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const pos = new Float32Array([
        -hx, -hy, -hz,  hx, -hy, -hz,  -hx,  hy, -hz,
        -hx, -hy,  hz,  hx, -hy,  hz,  -hx,  hy,  hz,
    ]);
    const idx = new Uint32Array([
        0, 2, 1,  3, 4, 5,          // front / back (winding)
        0, 1, 4,  0, 4, 3,          // bottom
        1, 2, 5,  1, 5, 4,          // slope
        0, 3, 5,  0, 5, 2,          // vertical
    ]);
    return meshCreate(pos, idx);
}

function primPyr(sx, sy, sz) {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const pos = new Float32Array([
        -hx, -hy, -hz,  hx, -hy, -hz,  hx, -hy,  hz, -hx, -hy,  hz,  // base
         0,   hy,  0,                                              // apex
    ]);
    const idx = new Uint32Array([
        0, 1, 2, 0, 2, 3,          // base
        0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0,
    ]);
    return meshCreate(pos, idx);
}

function primTube(r, len, wall, seg, axis) {
    wall = Math.max(0.001, Math.min(wall == null ? r * 0.3 : wall, r * 0.95));
    const outer = primCyl(r, len, seg, 1, axis);
    // Per un tubo vero servirebbe una booleana; qui si costruisce un guscio
    // a mano (anello laterale + due corone).
    seg = Math.max(6, seg | 0);
    const half = len * 0.5;
    const ri = r - wall;
    const pos = [];
    const idx = [];
    for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        pos.push(r * c, -half, r * s);
        pos.push(r * c,  half, r * s);
        pos.push(ri * c, -half, ri * s);
        pos.push(ri * c,  half, ri * s);
    }
    for (let i = 0; i < seg; i++) {
        const o = i * 4;
        // outer wall
        idx.push(o, o + 4, o + 1, o + 1, o + 4, o + 5);
        // inner wall (inverted)
        idx.push(o + 2, o + 3, o + 6, o + 3, o + 7, o + 6);
        // bottom rim
        idx.push(o, o + 2, o + 4, o + 2, o + 6, o + 4);
        // top rim
        idx.push(o + 1, o + 5, o + 3, o + 3, o + 5, o + 7);
    }
    let m = meshCreate(pos, idx);
    if (axis === 'x') meshRotate(m, 0, 0, -90);
    else if (axis === 'z') meshRotate(m, 90, 0, 0);
    return m;
}

function _profilePoints(prof, sides, s) {
    // Ritorna lista di [x,y] nel piano del profilo. `s` e' la scala [sx,sy].
    const sx = (s && s[0]) || 1, sy = (s && s[1]) || sx;
    if (Array.isArray(prof)) {
        return prof.map(p => [p[0] * sx, p[1] * sy]);
    }
    const t = String(prof || 'rect').toLowerCase();
    const n = Math.max(3, sides | 0 || 6);
    const pts = [];
    if (t === 'rect' || t === 'rrect') {
        const hx = 0.5 * sx, hy = 0.5 * sy;
        if (t === 'rrect') {
            const rr = Math.min(hx, hy) * 0.2;
            const seg = 4;
            function corner(cx, cy, a0) {
                for (let i = 0; i <= seg; i++) {
                    const a = a0 + (i / seg) * Math.PI * 0.5;
                    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
                }
            }
            corner(hx - rr, hy - rr, 0);
            corner(-hx + rr, hy - rr, Math.PI * 0.5);
            corner(-hx + rr, -hy + rr, Math.PI);
            corner(hx - rr, -hy + rr, Math.PI * 1.5);
        } else {
            pts.push([hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]);
        }
    } else if (t === 'ngon' || t === 'tri' || t === 'poly') {
        const nn = t === 'tri' ? 3 : n;
        for (let i = 0; i < nn; i++) {
            const a = (i / nn) * Math.PI * 2 + Math.PI / nn;
            pts.push([Math.cos(a) * 0.5 * sx, Math.sin(a) * 0.5 * sy]);
        }
    } else if (t === 'star') {
        for (let i = 0; i < n * 2; i++) {
            const a = (i / (n * 2)) * Math.PI * 2 - Math.PI * 0.5;
            const rad = (i % 2 === 0) ? 0.5 : 0.22;
            pts.push([Math.cos(a) * rad * sx, Math.sin(a) * rad * sy]);
        }
    } else if (t === 'l') {
        const t0 = 0.3;
        pts.push([0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5], [0.5, -0.5],
                 [0.5, -0.5 + t0], [-0.5 + t0, -0.5 + t0],
                 [-0.5 + t0, 0.5 - t0], [0.5, 0.5 - t0]);
        for (const p of pts) { p[0] *= sx; p[1] *= sy; }
    } else if (t === 't' || t === 'cross') {
        const t0 = t === 'cross' ? 0.2 : 0.25;
        if (t === 'cross') {
            pts.push([t0, 0.5], [-t0, 0.5], [-t0, t0], [-0.5, t0], [-0.5, -t0],
                     [-t0, -t0], [-t0, -0.5], [t0, -0.5], [t0, -t0], [0.5, -t0],
                     [0.5, t0], [t0, t0]);
        } else {
            pts.push([0.5, 0.5], [-0.5, 0.5], [-0.5, 0.5 - t0], [-t0, 0.5 - t0],
                     [-t0, -0.5], [t0, -0.5], [t0, 0.5 - t0], [0.5, 0.5 - t0]);
        }
        for (const p of pts) { p[0] *= sx; p[1] *= sy; }
    } else if (t === 'trapz') {
        pts.push([0.5 * sx, -0.5 * sy], [0.3 * sx, 0.5 * sy],
                 [-0.3 * sx, 0.5 * sy], [-0.5 * sx, -0.5 * sy]);
    } else if (t === 'teardrop' || t === 'arc') {
        for (let i = 0; i <= n; i++) {
            const a = (i / n) * Math.PI * 2 - Math.PI * 0.5;
            const rr = (a > Math.PI * 0.5 && a < Math.PI * 1.5) ? 0.35 : 0.5;
            pts.push([Math.cos(a) * rr * sx, Math.sin(a) * rr * sy]);
        }
    } else {
        // fallback rect
        const hx = 0.5 * sx, hy = 0.5 * sy;
        pts.push([hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]);
    }
    return pts;
}

function primExtr(prof, len, sides, s, axis, bevel) {
    const pts = _profilePoints(prof, sides, s);
    if (pts.length < 3) return primBox(s ? s[0] : 1, len, s ? s[1] : 1);
    const half = len * 0.5;
    const n = pts.length;

    // Baricentro: serve sia ai coperchi sia allo smusso, che sposta ogni punto
    // VERSO il baricentro invece di scalare il profilo. Su un profilo non
    // circolare (una L, una croce) scalare sposterebbe i lati di quantita'
    // diverse e lo smusso risulterebbe di spessore variabile.
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= n; cy /= n;

    const b = Math.max(0, Math.min(bevel || 0, half * 0.49));
    function inset(p, d) {
        const dx = cx - p[0], dy = cy - p[1];
        const l = Math.sqrt(dx * dx + dy * dy);
        if (l < 1e-9) return [p[0], p[1]];
        const k = Math.min(d, l * 0.9) / l;
        return [p[0] + dx * k, p[1] + dy * k];
    }

    // Anelli: con smusso sono quattro (inset, pieno, pieno, inset), senza due.
    const rings = b > 1e-6
        ? [{ y: -half, d: b }, { y: -half + b, d: 0 },
           { y: half - b, d: 0 }, { y: half, d: b }]
        : [{ y: -half, d: 0 }, { y: half, d: 0 }];

    const pos = [];
    for (const r of rings) {
        for (let i = 0; i < n; i++) {
            const q = r.d > 0 ? inset(pts[i], r.d) : pts[i];
            pos.push(q[0], r.y, q[1]);
        }
    }
    const idx = [];
    for (let ring = 0; ring < rings.length - 1; ring++) {
        const a0 = ring * n, b0 = (ring + 1) * n;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            idx.push(a0 + i, a0 + j, b0 + i, a0 + j, b0 + j, b0 + i);
        }
    }
    // Coperchi sul primo e ultimo anello.
    const lastRing = (rings.length - 1) * n;
    const botC = (pos.length / 3) | 0;
    pos.push(rings[0].d > 0 ? cx : cx, -half, rings[0].d > 0 ? cy : cy);
    const topC = botC + 1;
    pos.push(cx, half, cy);
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        idx.push(botC, j, i);
        idx.push(topC, lastRing + i, lastRing + j);
    }
    let m = meshCreate(pos, idx);
    if (axis === 'x') meshRotate(m, 0, 0, -90);
    else if (axis === 'z') meshRotate(m, 90, 0, 0);
    return m;
}

// `primLathe` (rivoluzione a spezzata, senza fondo ne' parete) e' stato
// RIMOSSO: lo sostituisce `primLathe2` in 03b-deform.js, che interpola il
// profilo e chiude il solido. Tenerne due avrebbe significato due
// implementazioni della stessa cosa destinate a divergere — ed e' la prima
// avvertenza di questo repo.

function primLoft(secs, seg, axis) {
    // secs: [{at, s:[sx,sy,sz]}] ordinati. Si interpolano sezioni circolari/rettangolari.
    if (!secs || secs.length < 2) return primCyl(0.5, 1, seg, 1, axis);
    seg = Math.max(6, seg | 0);
    const sorted = secs.slice().sort((a, b) => a.at - b.at);
    const pos = [];
    const idx = [];
    for (let i = 0; i < sorted.length; i++) {
        const sc = sorted[i];
        const sx = (sc.s && sc.s[0]) || 1;
        const sy = (sc.s && sc.s[1]) || sx;
        // sezione ellittica nel piano XZ, Y = at
        for (let k = 0; k <= seg; k++) {
            const a = (k / seg) * Math.PI * 2;
            pos.push(Math.cos(a) * sx * 0.5, sc.at, Math.sin(a) * sy * 0.5);
        }
    }
    const stride = seg + 1;
    for (let i = 0; i < sorted.length - 1; i++) {
        for (let k = 0; k < seg; k++) {
            const a = i * stride + k, b = a + stride;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    // coperchi
    function cap(si, flip) {
        const base = si * stride;
        const cIdx = (pos.length / 3) | 0;
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < seg; k++) {
            cx += pos[(base + k) * 3];
            cy += pos[(base + k) * 3 + 1];
            cz += pos[(base + k) * 3 + 2];
        }
        pos.push(cx / seg, cy / seg, cz / seg);
        for (let k = 0; k < seg; k++) {
            if (flip) idx.push(cIdx, base + k, base + ((k + 1) % seg));
            else idx.push(cIdx, base + ((k + 1) % seg), base + k);
        }
    }
    cap(0, true);
    cap(sorted.length - 1, false);
    let m = meshCreate(pos, idx);
    // Centra su Y (at e' assoluto nella spec, ma la primitiva e' centrata)
    const b = meshBounds(m);
    meshTranslate(m, 0, -b.center[1], 0);
    if (axis === 'x') meshRotate(m, 0, 0, -90);
    else if (axis === 'z') meshRotate(m, 90, 0, 0);
    return m;
}

function primHelix(r, r2, len, turns, seg, axis) {
    turns = Math.max(0.5, turns || 3);
    r2 = r2 == null ? r * 0.15 : r2;
    seg = Math.max(8, seg | 0);
    const steps = Math.max(8, Math.ceil(seg * turns * 2));
    const tubeSeg = Math.max(4, (seg / 3) | 0);
    const pos = [];
    const idx = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = t * turns * Math.PI * 2;
        const y = (t - 0.5) * len;
        const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
        // tangente approssimata
        const tx = -Math.sin(a), tz = Math.cos(a);
        // normale (verso l'asse) e binormale
        const nx = -Math.cos(a), nz = -Math.sin(a);
        for (let j = 0; j <= tubeSeg; j++) {
            const b = (j / tubeSeg) * Math.PI * 2;
            const cb = Math.cos(b), sb = Math.sin(b);
            // cerchio nel piano (n, up-ish)
            pos.push(cx + (nx * cb + 0 * sb) * r2,
                     y + sb * r2,
                     cz + (nz * cb) * r2);
        }
    }
    const stride = tubeSeg + 1;
    for (let i = 0; i < steps; i++) {
        for (let j = 0; j < tubeSeg; j++) {
            const a = i * stride + j, b = a + stride;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    let m = meshCreate(pos, idx);
    if (axis === 'x') meshRotate(m, 0, 0, -90);
    else if (axis === 'z') meshRotate(m, 90, 0, 0);
    return m;
}

function primField(sx, sy, sz, seed, amp, freq, seg) {
    // Heightfield su XZ, altezza Y da rumore value-noise semplice.
    seg = Math.max(4, seg | 0);
    seed = seed || 0;
    amp = amp == null ? 0.3 : amp;
    freq = freq == null ? 2 : freq;
    function hash(ix, iz) {
        let n = (ix * 374761393 + iz * 668265263 + seed * 1274126177) | 0;
        n = (n ^ (n >> 13)) * 1274126177;
        n = n ^ (n >> 16);
        return ((n & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    }
    function smooth(ix, iz) {
        const x0 = Math.floor(ix), z0 = Math.floor(iz);
        const fx = ix - x0, fz = iz - z0;
        const sx_ = fx * fx * (3 - 2 * fx), sz_ = fz * fz * (3 - 2 * fz);
        const a = hash(x0, z0), b = hash(x0 + 1, z0);
        const c = hash(x0, z0 + 1), d = hash(x0 + 1, z0 + 1);
        return a + (b - a) * sx_ + (c - a) * sz_ + (a - b - c + d) * sx_ * sz_;
    }
    const pos = [];
    const idx = [];
    for (let z = 0; z <= seg; z++) {
        for (let x = 0; x <= seg; x++) {
            const u = x / seg, v = z / seg;
            const px = (u - 0.5) * sx;
            const pz = (v - 0.5) * sz;
            const h = smooth(u * freq, v * freq) * amp * sy;
            pos.push(px, h, pz);
        }
    }
    const stride = seg + 1;
    for (let z = 0; z < seg; z++) {
        for (let x = 0; x < seg; x++) {
            const a = z * stride + x, b = a + stride;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    // Spessore minimo: estrude verso il basso per avere un volume chiuso.
    const topN = (pos.length / 3) | 0;
    const baseY = -sy * 0.5;
    for (let z = 0; z <= seg; z++) {
        for (let x = 0; x <= seg; x++) {
            const u = x / seg, v = z / seg;
            pos.push((u - 0.5) * sx, baseY, (v - 0.5) * sz);
        }
    }
    for (let z = 0; z < seg; z++) {
        for (let x = 0; x < seg; x++) {
            const a = topN + z * stride + x, b = a + stride;
            idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
    }
    // lati
    function edge(getTop, getBot, n) {
        for (let i = 0; i < n; i++) {
            const t0 = getTop(i), t1 = getTop(i + 1);
            const b0 = getBot(i), b1 = getBot(i + 1);
            idx.push(t0, b0, t1, t1, b0, b1);
        }
    }
    edge(i => i, i => topN + i, seg);
    edge(i => seg * stride + i, i => topN + seg * stride + i, seg);
    edge(i => i * stride, i => topN + i * stride, seg);
    edge(i => i * stride + seg, i => topN + i * stride + seg, seg);
    return meshCreate(pos, idx);
}

function primStairs(sx, sy, sz, steps) {
    steps = Math.max(1, Math.min(64, steps | 0 || 6));
    const parts = [];
    const stepH = sy / steps;
    const stepD = sz / steps;
    for (let i = 0; i < steps; i++) {
        const d = sz - i * stepD;
        const box = primBox(sx, stepH, d);
        meshTranslate(box, 0, -sy * 0.5 + stepH * (i + 0.5), -sz * 0.5 + d * 0.5);
        parts.push(box);
    }
    return meshMerge(parts);
}

function primArch(sx, sy, sz, r, wall, seg) {
    // Arco: blocco con un buco a semicerchio. Approssimato come estrusione
    // di un profilo a U rovesciata.
    wall = wall == null ? Math.min(sx, sy) * 0.15 : wall;
    r = r == null ? Math.min(sx * 0.5 - wall, sy - wall) : r;
    seg = Math.max(6, seg | 0);
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const pts = [];
    // profilo esterno (rettangolo)
    // e interno (semicerchio + piedi)
    // Costruiamo due box laterali + un box sopra + un torus mezzo... piu'
    // semplice: box pieno e si lascia al CSG il buco. Qui, senza CSG ancora
    // caricato, costruiamo un guscio a U.
    const parts = [];
    // piedritto sx
    const post = primBox(wall, sy, sz);
    meshTranslate(meshClone(post), -hx + wall * 0.5, 0, 0);
    parts.push(meshTranslate(primBox(wall, sy, sz), -hx + wall * 0.5, 0, 0));
    parts.push(meshTranslate(primBox(wall, sy, sz), hx - wall * 0.5, 0, 0));
    // architrave
    const topH = Math.max(wall, sy - r - 0.01);
    parts.push(meshTranslate(primBox(sx, topH, sz), 0, hy - topH * 0.5, 0));
    // semicerchio pieno come "spalla" dell'arco (semplificato: torus mezzo no;
    // due wedge / un cyl tagliato). Usiamo un mezzo-cilindro come rinfianco.
    const arch = primCyl(r + wall, sz, seg, 1, 'z');
    // non sottraiamo: lasciamo il mezzo-cilindro sopra i piedritti come arco pieno
    // (l'apertura e' lo spazio sotto). Per un arco vero il buco andrebbe scavato
    // col CSG; qui e' un arco "pieno" stilizzato.
    meshTranslate(arch, 0, -hy + r + wall * 0.5, 0);
    // taglia la meta' inferiore nascondendola: teniamo solo y > centro
    // (filtro vertici e' costoso; lasciamo l'arco pieno e i piedritti).
    parts.push(arch);
    return meshMerge(parts);
}

/** Costruisce la primitiva di un nodo gia' risolto (numeri puri). */
function primBuild(node, seg, bevelSeg) {
    const p = node.p || 'box';
    const s = node.s || [1, 1, 1];
    const axis = node.axis || 'y';
    seg = seg || 16;
    bevelSeg = bevelSeg || 2;
    switch (p) {
        case 'box':
            // `bevel` non e' piu' decorativo: se c'e', si costruisce una
            // scatola RACCORDATA. Era il campo piu' usato dal generatore e
            // veniva ignorato in silenzio.
            if (node.bevel && node.bevel > 1e-6) {
                return primRoundBox(s[0], s[1], s[2], node.bevel, bevelSeg);
            }
            return primBox(s[0], s[1], s[2]);
        case 'plane':  return primPlane(s[0], s[2] != null ? s[2] : s[1]);
        case 'sphere': {
            const r = node.r != null ? node.r : Math.max(s[0], s[1], s[2]) * 0.5;
            const m = primSphere(r, seg);
            if (node.r == null && (s[0] !== s[1] || s[1] !== s[2])) {
                meshScale(m, s[0] / (r * 2), s[1] / (r * 2), s[2] / (r * 2));
            }
            return m;
        }
        case 'cyl':    return primCyl(node.r != null ? node.r : s[0] * 0.5,
                                      node.len != null ? node.len : s[1],
                                      seg, node.taper, axis);
        case 'caps':   return primCaps(node.r != null ? node.r : s[0] * 0.5,
                                       node.len != null ? node.len : s[1],
                                       seg, axis);
        case 'torus':  return primTorus(node.r != null ? node.r : s[0] * 0.5,
                                        node.r2 != null ? node.r2 : (node.r || s[0] * 0.5) * 0.3,
                                        seg, node.arc);
        case 'wedge':  return primWedge(s[0], s[1], s[2]);
        case 'pyr':    return primPyr(s[0], s[1], s[2]);
        case 'tube':
            // Con un `path` il tubo SEGUE la curva: e' il primitivo delle anse,
            // dei becchi, dei cavi, dei corrimano. Prima `path` veniva accettato
            // e ignorato, e un'ansa chiesta cosi' usciva come una lamella piatta.
            if (node.path && node.path.length >= 2) {
                return primTubePath(node.path,
                                    node.r != null ? node.r : s[0] * 0.5,
                                    seg, node.wall,
                                    node.taperTo ? node.taperTo.a : null);
            }
            return primTube(node.r != null ? node.r : s[0] * 0.5,
                            node.len != null ? node.len : s[1],
                            node.wall, seg, axis);
        case 'extr':   return primExtr(node.prof || 'rect',
                                       node.len != null ? node.len : s[1],
                                       node.sides || seg,
                                       s, axis, node.bevel);
        case 'lathe': {
            // Con un nome noto (`vase`, `bottle`, `goblet`, ...) la silhouette
            // e' normalizzata 0..1 e va scalata su `s`/`r`/`len`; con punti
            // espliciti sono coordinate assolute e si rispettano.
            let prof = node.prof;
            if (typeof prof === 'string' && vesselProfile(prof)) {
                const rr = node.r != null ? node.r : (s[0] * 0.5);
                const hh = node.len != null ? node.len : s[1];
                prof = vesselProfile(prof).map(p => [p[0] * 2 * rr, p[1] * hh]);
            }
            return primLathe2(prof, node.sides || seg, node.arc, axis,
                              node.wall, node.smooth);
        }
        case 'loft':   return primLoft2(node.secs, node.shape || 'ellipse', seg, axis,
                                        node.closed !== false);
        case 'helix':  return primHelix(node.r || 0.4, node.r2, node.len || 1,
                                        node.turns || 4, seg, axis);
        case 'field':  return primField(s[0], s[1], s[2], node.seed, node.amp,
                                        node.freq, Math.max(6, (seg / 2) | 0));
        case 'stairs': return primStairs(s[0], s[1], s[2], node.steps || 6);
        case 'arch':   return primArch(s[0], s[1], s[2], node.r, node.wall, seg);
        default:       return primBox(s[0], s[1], s[2]);
    }
}
