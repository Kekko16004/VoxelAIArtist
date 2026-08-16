// =======================================================================
//  05 - Interprete della spec: nodi -> mesh
//
//  Risolve le espressioni, costruisce le primitive, applica array/mirror/
//  rotazione/traslazione, esegue le booleane nell'ordine di dichiarazione.
//  Ritorna {parts, merged, warnings, bounds} dove `parts` e' una mesh per
//  nodo visibile (per l'export a parti nominate e per il rig).
// =======================================================================

function resolveNode(node, params) {
    // Copia con tutti i campi numerici risolti.
    const n = { n: node.n, p: node.p || 'box' };
    if (node.s != null) n.s = evalVec3(node.s, params, [1, 1, 1]);
    else n.s = [1, 1, 1];
    n.at = node.at != null ? evalVec3(node.at, params, [0, 0, 0]) : [0, 0, 0];
    if (node.rot != null) n.rot = evalVec3(node.rot, params, [0, 0, 0]);
    for (const k of ['r', 'r2', 'len', 'taper', 'arc', 'wall', 'bevel',
                     'amp', 'freq', 'turns', 'inner']) {
        if (node[k] != null) n[k] = evalExpr(node[k], params);
    }
    for (const k of ['sides', 'steps', 'seed']) {
        if (node[k] != null) n[k] = Math.round(evalExpr(node[k], params));
    }
    if (node.axis) n.axis = node.axis;
    if (node.prof != null) {
        if (Array.isArray(node.prof)) {
            n.prof = node.prof.map(p => [
                evalExpr(p[0], params), evalExpr(p[1], params)]);
        } else n.prof = node.prof;
    }
    if (node.secs) {
        n.secs = node.secs.map(s => ({
            at: evalExpr(s.at, params),
            s: evalVec3(s.s, params, [1, 1, 1]),
        }));
    }
    if (node.path) {
        n.path = node.path.map(p => evalVec3(p, params, [0, 0, 0]));
    }
    if (node.op) { n.op = node.op; n.of = node.of; }
    if (node.arr) {
        n.arr = {
            n: Math.max(1, Math.round(evalExpr(node.arr.n, params))),
            step: evalVec3(node.arr.step, params, [0, 0, 0]),
        };
        if (node.arr.rot) n.arr.rot = evalVec3(node.arr.rot, params, [0, 0, 0]);
    }
    if (node.mir) n.mir = node.mir;
    if (node.mat) n.mat = node.mat;
    if (node.bone) n.bone = node.bone;
    if (node.role) n.role = node.role;
    if (node.hidden) n.hidden = true;
    if (node.interactive) n.interactive = true;
    return n;
}

function transformInstance(mesh, at, rot, i, arr) {
    let m = meshClone(mesh);
    if (arr && i > 0) {
        meshTranslate(m, arr.step[0] * i, arr.step[1] * i, arr.step[2] * i);
        if (arr.rot) {
            meshRotate(m, (arr.rot[0] || 0) * i, (arr.rot[1] || 0) * i, (arr.rot[2] || 0) * i);
        }
    }
    if (rot) meshRotate(m, rot[0] || 0, rot[1] || 0, rot[2] || 0);
    if (at) meshTranslate(m, at[0] || 0, at[1] || 0, at[2] || 0);
    return m;
}

function buildNodeMesh(node, seg) {
    const base = primBuild(node, seg);
    base.mat = node.mat || '';
    base.name = node.n || '';
    const count = (node.arr && node.arr.n) || 1;
    const instances = [];
    for (let i = 0; i < count; i++) {
        instances.push(transformInstance(base, node.at, node.rot, i, node.arr));
    }
    let m = instances.length === 1 ? instances[0] : meshMerge(instances);
    if (node.mir) {
        const mirrored = meshClone(m);
        meshMirror(mirrored, node.mir);
        m = meshMerge([m, mirrored]);
    }
    m.mat = node.mat || '';
    m.name = node.n || '';
    return m;
}

function buildSpec(spec) {
    const warnings = [];
    if (!spec || !spec.nodes || !spec.nodes.length) {
        return { parts: [], merged: meshCreate([], []), warnings: [{ code: 'empty' }],
                 bounds: meshBounds(meshCreate([], [])) };
    }
    const params = Object.assign({}, spec.params || {});
    const detail = Math.max(0, Math.min(3, spec.detail | 0));
    const seg = DETAIL_LEVELS[detail].seg;

    // Budget nodi: non si taglia in silenzio, si avvisa.
    const budget = DETAIL_LEVELS[detail].nodes;
    if (spec.nodes.length > budget) {
        warnings.push({ code: 'overBudget', v: spec.nodes.length + '>' + budget });
    }

    const resolved = spec.nodes.map(n => resolveNode(n, params));
    const byName = {};
    const solidMeshes = {};   // nome -> mesh (dopo trasformazioni, prima delle booleane)
    const isTool = {};        // nodi usati come utensili booleani

    for (const n of resolved) {
        if (n.op && n.of) isTool[n.n] = true;
    }

    for (const n of resolved) {
        try {
            solidMeshes[n.n] = buildNodeMesh(n, seg);
        } catch (e) {
            warnings.push({ code: 'buildFail', at: n.n, v: String(e.message || e).slice(0, 60) });
            solidMeshes[n.n] = meshCreate([], [], n.mat, n.n);
        }
        byName[n.n] = n;
    }

    // Booleane in ordine di dichiarazione. Un utensile puo' colpire un target
    // gia' modificato da un'op precedente.
    const live = Object.assign({}, solidMeshes);
    for (const n of resolved) {
        if (!n.op || !n.of) continue;
        const target = live[n.of];
        const tool = live[n.n] || solidMeshes[n.n];
        if (!target || meshIsEmpty(target)) {
            warnings.push({ code: 'boolMissingTarget', at: n.n, v: n.of });
            continue;
        }
        if (!tool || meshIsEmpty(tool)) {
            warnings.push({ code: 'boolMissingTool', at: n.n });
            continue;
        }
        const result = csgApply(target, tool, n.op);
        if (!result.ok) {
            warnings.push({ code: 'boolFailed', at: n.n, v: result.reason });
        } else {
            result.mesh.mat = target.mat;
            result.mesh.name = n.of;
            live[n.of] = result.mesh;
        }
        // L'utensile non e' mai visibile.
        live[n.n] = null;
    }

    const parts = [];
    for (const n of resolved) {
        if (isTool[n.n]) continue;
        if (n.hidden) continue;
        const m = live[n.n];
        if (!m || meshIsEmpty(m)) continue;
        m.name = n.n;
        m.mat = n.mat || m.mat || '';
        m.bone = n.bone || '';
        m.role = n.role || '';
        parts.push(m);
    }

    // Ground: se richiesto, sposta tutto cosi' il minimo Y sia 0.
    let merged = parts.length ? meshMerge(parts) : meshCreate([], []);
    if (spec.ground !== false && !meshIsEmpty(merged)) {
        const b = meshBounds(merged);
        if (Math.abs(b.min[1]) > 1e-5) {
            const dy = -b.min[1];
            for (const p of parts) meshTranslate(p, 0, dy, 0);
            meshTranslate(merged, 0, dy, 0);
        }
    }

    return {
        parts: parts,
        merged: parts.length ? meshMerge(parts) : merged,
        warnings: warnings,
        bounds: meshBounds(parts.length ? meshMerge(parts) : merged),
        resolved: resolved,
    };
}
