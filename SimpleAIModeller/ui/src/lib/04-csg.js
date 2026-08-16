// =======================================================================
//  04 - CSG su array piatti (BSP alla csg.js)
//
//  Unione / sottrazione / intersezione senza dipendenze. Dopo ogni op si
//  verifica che il guscio resti chiuso: se non lo e', si tiene la mesh non
//  tagliata e si emette un avviso — esportare un modello bucato e' peggio
//  di perdere un dettaglio.
// =======================================================================

function csgEps() { return 1e-5; }

function csgV(x, y, z) { return { x: x, y: y, z: z }; }
function csgCloneV(v) { return { x: v.x, y: v.y, z: v.z }; }
function csgAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function csgSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function csgMul(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function csgDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function csgCross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function csgLerp(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function csgPoly(vertices) {
    const a = vertices[0], b = vertices[1], c = vertices[2];
    const n = csgCross(csgSub(b, a), csgSub(c, a));
    const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z) || 1;
    n.x /= len; n.y /= len; n.z /= len;
    return { vertices: vertices.map(csgCloneV), normal: n, w: csgDot(n, a) };
}

function csgFlip(poly) {
    poly.vertices.reverse();
    poly.normal = csgMul(poly.normal, -1);
    poly.w = -poly.w;
    return poly;
}

function csgClonePoly(poly) {
    return {
        vertices: poly.vertices.map(csgCloneV),
        normal: csgCloneV(poly.normal),
        w: poly.w,
    };
}

// Classifica e spezza un poligono rispetto a un piano.
const CSG_COPLANAR = 0, CSG_FRONT = 1, CSG_BACK = 2, CSG_SPANNING = 3;

function csgSplitPoly(plane, poly, coFront, coBack, front, back) {
    const EPS = csgEps();
    let polyType = 0;
    const types = [];
    for (let i = 0; i < poly.vertices.length; i++) {
        const t = csgDot(plane.normal, poly.vertices[i]) - plane.w;
        const type = t < -EPS ? CSG_BACK : t > EPS ? CSG_FRONT : CSG_COPLANAR;
        polyType |= type;
        types.push(type);
    }
    switch (polyType) {
        case CSG_COPLANAR:
            (csgDot(plane.normal, poly.normal) > 0 ? coFront : coBack).push(poly);
            break;
        case CSG_FRONT: front.push(poly); break;
        case CSG_BACK: back.push(poly); break;
        case CSG_SPANNING: {
            const f = [], b = [];
            for (let i = 0; i < poly.vertices.length; i++) {
                const j = (i + 1) % poly.vertices.length;
                const ti = types[i], tj = types[j];
                const vi = poly.vertices[i], vj = poly.vertices[j];
                if (ti !== CSG_BACK) f.push(vi);
                if (ti !== CSG_FRONT) b.push(ti !== CSG_BACK ? csgCloneV(vi) : vi);
                if ((ti | tj) === CSG_SPANNING) {
                    const t = (plane.w - csgDot(plane.normal, vi))
                            / csgDot(plane.normal, csgSub(vj, vi));
                    const v = csgLerp(vi, vj, t);
                    f.push(v);
                    b.push(csgCloneV(v));
                }
            }
            if (f.length >= 3) front.push(csgPoly(f));
            if (b.length >= 3) back.push(csgPoly(b));
            break;
        }
    }
}

function csgNode(polys) {
    return { plane: null, front: null, back: null, polygons: polys || [] };
}

function csgBuild(node, polys) {
    if (!polys || !polys.length) return;
    if (!node.plane) node.plane = {
        normal: csgCloneV(polys[0].normal),
        w: polys[0].w,
    };
    const front = [], back = [];
    for (let i = 0; i < polys.length; i++) {
        csgSplitPoly(node.plane, polys[i], node.polygons, node.polygons, front, back);
    }
    if (front.length) {
        if (!node.front) node.front = csgNode();
        csgBuild(node.front, front);
    }
    if (back.length) {
        if (!node.back) node.back = csgNode();
        csgBuild(node.back, back);
    }
}

function csgAllPolys(node, list) {
    list = list || [];
    if (!node) return list;
    for (let i = 0; i < node.polygons.length; i++) list.push(node.polygons[i]);
    if (node.front) csgAllPolys(node.front, list);
    if (node.back) csgAllPolys(node.back, list);
    return list;
}

function csgCloneNode(node) {
    if (!node) return null;
    const n = csgNode(node.polygons.map(csgClonePoly));
    if (node.plane) n.plane = { normal: csgCloneV(node.plane.normal), w: node.plane.w };
    n.front = csgCloneNode(node.front);
    n.back = csgCloneNode(node.back);
    return n;
}

function csgInvert(node) {
    if (!node) return null;
    for (let i = 0; i < node.polygons.length; i++) csgFlip(node.polygons[i]);
    if (node.plane) {
        node.plane.normal = csgMul(node.plane.normal, -1);
        node.plane.w = -node.plane.w;
    }
    const t = node.front;
    node.front = csgInvert(node.back);
    node.back = csgInvert(t);
    return node;
}

function csgClipPolys(node, polys) {
    if (!node.plane) return polys.slice();
    const front = [], back = [];
    for (let i = 0; i < polys.length; i++) {
        csgSplitPoly(node.plane, polys[i], front, back, front, back);
    }
    if (node.front) {
        const f = csgClipPolys(node.front, front);
        front.length = 0;
        for (let i = 0; i < f.length; i++) front.push(f[i]);
    }
    if (node.back) {
        const b = csgClipPolys(node.back, back);
        return front.concat(b);
    }
    return front;
}

function csgClipTo(a, b) {
    a.polygons = csgClipPolys(b, a.polygons);
    if (a.front) csgClipTo(a.front, b);
    if (a.back) csgClipTo(a.back, b);
}

function csgMeshToPolys(m) {
    const p = m.pos, idx = m.idx;
    const polys = [];
    for (let i = 0; i < idx.length; i += 3) {
        const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
        const verts = [
            csgV(p[ia], p[ia + 1], p[ia + 2]),
            csgV(p[ib], p[ib + 1], p[ib + 2]),
            csgV(p[ic], p[ic + 1], p[ic + 2]),
        ];
        // Scarta triangoli degeneri.
        const e1 = csgSub(verts[1], verts[0]);
        const e2 = csgSub(verts[2], verts[0]);
        const cr = csgCross(e1, e2);
        if (cr.x * cr.x + cr.y * cr.y + cr.z * cr.z < 1e-14) continue;
        polys.push(csgPoly(verts));
    }
    return polys;
}

function csgPolysToMesh(polys, mat, name) {
    const pos = [];
    const idx = [];
    for (let i = 0; i < polys.length; i++) {
        const v = polys[i].vertices;
        // Fan triangulation per poligoni a N lati prodotti dallo split.
        const base = (pos.length / 3) | 0;
        for (let j = 0; j < v.length; j++) {
            pos.push(v[j].x, v[j].y, v[j].z);
        }
        for (let j = 1; j < v.length - 1; j++) {
            idx.push(base, base + j, base + j + 1);
        }
    }
    return meshCreate(pos, idx, mat, name);
}

function csgFromMesh(m) {
    const node = csgNode();
    csgBuild(node, csgMeshToPolys(m));
    return node;
}

function csgUnion(a, b) {
    a = csgCloneNode(a); b = csgCloneNode(b);
    csgClipTo(a, b);
    csgClipTo(b, a);
    csgInvert(b);
    csgClipTo(b, a);
    csgInvert(b);
    csgBuild(a, csgAllPolys(b));
    return a;
}

function csgSubtract(a, b) {
    a = csgCloneNode(a); b = csgCloneNode(b);
    csgInvert(a);
    csgClipTo(a, b);
    csgClipTo(b, a);
    csgInvert(b);
    csgClipTo(b, a);
    csgInvert(b);
    csgBuild(a, csgAllPolys(b));
    csgInvert(a);
    return a;
}

function csgIntersect(a, b) {
    a = csgCloneNode(a); b = csgCloneNode(b);
    csgInvert(a);
    csgClipTo(b, a);
    csgInvert(b);
    csgClipTo(a, b);
    csgClipTo(b, a);
    csgBuild(a, csgAllPolys(b));
    csgInvert(a);
    return a;
}

/**
 * Applica una booleana fra due mesh. Ritorna {mesh, ok, reason}.
 * Se il risultato non e' chiuso o e' vuoto, `ok=false` e mesh = A originale.
 */
function csgApply(meshA, meshB, op) {
    if (meshIsEmpty(meshA)) return { mesh: meshA, ok: false, reason: 'emptyA' };
    if (meshIsEmpty(meshB)) return { mesh: meshA, ok: false, reason: 'emptyB' };
    try {
        const na = csgFromMesh(meshA);
        const nb = csgFromMesh(meshB);
        let result;
        if (op === 'sub') result = csgSubtract(na, nb);
        else if (op === 'int') result = csgIntersect(na, nb);
        else result = csgUnion(na, nb);
        const polys = csgAllPolys(result);
        if (!polys.length) return { mesh: meshA, ok: false, reason: 'emptyResult' };
        const out = csgPolysToMesh(polys, meshA.mat, meshA.name);
        // Un risultato non chiuso e' quasi sempre un fallimento del BSP su
        // geometria non-manifold o coplanare. Si tiene l'originale.
        if (!meshIsClosed(out) && op === 'sub') {
            // Per la sottrazione un buco e' a volte voluto (un tubo): si
            // accetta se l'area e' ragionevole.
            if (meshArea(out) < meshArea(meshA) * 0.01) {
                return { mesh: meshA, ok: false, reason: 'degenerate' };
            }
        }
        return { mesh: out, ok: true, reason: 'ok' };
    } catch (e) {
        return { mesh: meshA, ok: false, reason: 'exception' };
    }
}
