// =======================================================================
//  06 - Validatori geometrici deterministici (zero chiamate AI)
//
//  Ogni validatore ritorna 0..N difetti {code, sev, where, what, fix}.
//  Si misurano sulla mesh costruita + sulla spec. Auto-riparazione solo
//  dell'inequivocabile (vedi autoRepair).
// =======================================================================

function defect(code, sev, where, what, fix) {
    return { code: code, sev: sev || 'medium', where: where || '',
             what: what || '', fix: fix || '' };
}

/** Occupancy grid SOLIDA: si rasterizzano i triangoli, non i vertici.
 *
 *  Campionare solo vertici e baricentri lascia buchi lungo le facce grandi, e
 *  il conteggio delle componenti connesse diventa una fabbrica di falsi
 *  positivi: su una spada dava "30 frammenti e 5 parti staccate" per un
 *  oggetto tutto attaccato. Qui ogni triangolo viene campionato sulla sua
 *  superficie con passo mezza cella, cosi' una faccia continua riempie celle
 *  contigue.
 */
function voxelizeBounds(mesh, res) {
    res = res || 24;
    const b = meshBounds(mesh);
    const size = b.size;
    const maxS = Math.max(size[0], size[1], size[2], 1e-6);
    const cell = maxS / res;
    const nx = Math.max(1, Math.ceil(size[0] / cell) + 1);
    const ny = Math.max(1, Math.ceil(size[1] / cell) + 1);
    const nz = Math.max(1, Math.ceil(size[2] / cell) + 1);
    const grid = new Uint8Array(nx * ny * nz);
    const p = mesh.pos, idx = mesh.idx;

    function mark(x, y, z) {
        const ix = Math.min(nx - 1, Math.max(0, ((x - b.min[0]) / cell) | 0));
        const iy = Math.min(ny - 1, Math.max(0, ((y - b.min[1]) / cell) | 0));
        const iz = Math.min(nz - 1, Math.max(0, ((z - b.min[2]) / cell) | 0));
        grid[ix + iy * nx + iz * nx * ny] = 1;
    }

    for (let i = 0; i < idx.length; i += 3) {
        const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
        const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
        const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
        const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
        // Passo di campionamento: mezza cella sul lato piu' lungo.
        const e1 = Math.max(Math.abs(bx - ax), Math.abs(by - ay), Math.abs(bz - az));
        const e2 = Math.max(Math.abs(cx - ax), Math.abs(cy - ay), Math.abs(cz - az));
        const n1 = Math.min(64, Math.max(1, Math.ceil(e1 / (cell * 0.5))));
        const n2 = Math.min(64, Math.max(1, Math.ceil(e2 / (cell * 0.5))));
        for (let u = 0; u <= n1; u++) {
            const fu = u / n1;
            for (let v = 0; v <= n2; v++) {
                const fv = v / n2;
                if (fu + fv > 1) continue;   // dentro il triangolo
                mark(ax + (bx - ax) * fu + (cx - ax) * fv,
                     ay + (by - ay) * fu + (cy - ay) * fv,
                     az + (bz - az) * fu + (cz - az) * fv);
            }
        }
    }
    return { grid: grid, nx: nx, ny: ny, nz: nz, cell: cell, bounds: b };
}

/** Componenti connesse a 26 vicini.
 *
 *  A 6 vicini due pezzi che si toccano di spigolo (una guardia infilata su una
 *  lama, una ruota su un assale) risultano staccati: e' geometria che in un
 *  motore di gioco e' saldata, e chiamarla "parte fluttuante" manda a caccia di
 *  un difetto che non c'e'.
 */
function countComponents(vox) {
    const { grid, nx, ny, nz } = vox;
    const seen = new Uint8Array(grid.length);
    const sizes = [];
    const stack = [];
    for (let i = 0; i < grid.length; i++) {
        if (!grid[i] || seen[i]) continue;
        let count = 0;
        stack.push(i);
        seen[i] = 1;
        while (stack.length) {
            const cur = stack.pop();
            count++;
            const x = cur % nx;
            const y = ((cur / nx) | 0) % ny;
            const z = (cur / (nx * ny)) | 0;
            for (let dz = -1; dz <= 1; dz++) {
                const zz = z + dz;
                if (zz < 0 || zz >= nz) continue;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= ny) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= nx) continue;
                        if (!dx && !dy && !dz) continue;
                        const n = xx + yy * nx + zz * nx * ny;
                        if (grid[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
                    }
                }
            }
        }
        sizes.push(count);
    }
    sizes.sort((a, b) => b - a);
    return sizes;
}

function validateGround(spec, built) {
    const d = [];
    const b = built.bounds;
    if (spec.ground !== false) {
        if (b.min[1] > 0.05) {
            d.push(defect('floating', 'high', '',
                'L\'asset galleggia a y=' + b.min[1].toFixed(3) + ' invece di poggiare a terra.',
                'Impostare ground:true e traslare di -minY.'));
        } else if (b.min[1] < -0.05) {
            d.push(defect('sinking', 'high', '',
                'L\'asset affonda sotto y=0 (minY=' + b.min[1].toFixed(3) + ').',
                'Traslare di -minY per appoggiarlo a terra.'));
        }
    }
    return d;
}

function validateSize(spec, built) {
    const d = [];
    const target = spec.size || [1, 1, 1];
    const size = built.bounds.size;
    for (let i = 0; i < 3; i++) {
        const t = Math.max(0.01, target[i] || 1);
        const s = size[i] || 0;
        const ratio = s / t;
        if (ratio < 0.4 || ratio > 2.5) {
            const axis = 'XYZ'[i];
            d.push(defect('sizeMismatch', 'medium', axis,
                'Ingombro ' + axis + '=' + s.toFixed(3) + 'm contro target ' + t.toFixed(3) + 'm (rapporto ' + ratio.toFixed(2) + ').',
                'Riscalare o correggere i params che comandano l\'asse ' + axis + '.'));
        }
    }
    if (size[0] < 0.01 && size[1] < 0.01 && size[2] < 0.01) {
        d.push(defect('emptyMesh', 'high', '',
            'La mesh risultante e\' vuota o degenerata.',
            'Verificare che i nodi producano volumi reali.'));
    }
    return d;
}

function validateSymmetry(spec, built) {
    const d = [];
    const flags = spec.flags || [];
    const wants = flags.indexOf('symmetric_x') >= 0
        || spec.cat === 'char' || spec.cat === 'vehicle';
    if (!wants || meshIsEmpty(built.merged)) return d;
    const vox = voxelizeBounds(built.merged, 20);
    const { grid, nx, ny, nz } = vox;
    let total = 0, mismatch = 0;
    for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
            for (let x = 0; x < Math.floor(nx / 2); x++) {
                const mx = nx - 1 - x;
                const a = grid[x + y * nx + z * nx * ny];
                const b = grid[mx + y * nx + z * nx * ny];
                if (a || b) total++;
                if (a !== b) mismatch++;
            }
        }
    }
    if (total > 0 && mismatch / total > 0.18) {
        d.push(defect('asymmetric', 'high', 'x',
            'Simmetria sinistra/destra scarsa: ' + Math.round(100 * mismatch / total) + '% delle celle non combacia.',
            'Usare mir:x sulle parti pari (braccia, gambe, ruote) invece di nodi separati.'));
    }
    return d;
}

function validateComponents(spec, built) {
    const d = [];
    if (meshIsEmpty(built.merged)) return d;
    const vox = voxelizeBounds(built.merged, 26);
    const sizes = countComponents(vox);
    if (sizes.length > 1) {
        const main = sizes[0] || 1;
        const scraps = sizes.slice(1).filter(s => s / main < 0.02);
        const big = sizes.slice(1).filter(s => s / main >= 0.02);
        if (big.length) {
            d.push(defect('detachedParts', 'high', '',
                (big.length + 1) + ' componenti connesse distinte: parti staccate o fluttuanti.',
                'Collegare le parti al corpo principale: ogni pezzo deve toccare un vicino.'));
        }
        if (scraps.length > 2) {
            d.push(defect('scraps', 'low', '',
                scraps.length + ' frammenti sotto il 2% del volume principale.',
                'Eliminare i nodi spuri o unirli al corpo.'));
        }
    }
    return d;
}

/** Bbox per ogni parte nominata: e' cio' che l'audit confronta col piano. */
function partMetrics(built) {
    const out = {};
    for (const part of (built.parts || [])) {
        if (!part.name || meshIsEmpty(part)) continue;
        const b = meshBounds(part);
        const r = (v) => Math.round(v * 100000) / 100000;
        out[part.name] = {
            min: b.min.map(r),
            max: b.max.map(r),
            size: b.size.map(r),
        };
    }
    return out;
}

/** Payload di misura per `POST /api/asset/audit` (o per auditPlanLocal). */
function measuredFor(built) {
    const b = built.bounds;
    const r = (v) => Math.round(v * 100000) / 100000;
    return {
        total: b.size.map(r),
        min: b.min.map(r),
        max: b.max.map(r),
        parts: partMetrics(built),
    };
}

function validateFlatTop(spec, built) {
    const d = [];
    if (meshIsEmpty(built.merged)) return d;
    const flags = spec.flags || [];
    const b = built.bounds;
    // Una bandiera non basta: il modello scrive `flat_top` anche su una spada,
    // perche' la regola compare fra quelle generali del prompt. Si pretende che
    // l'oggetto sia DAVVERO una piattaforma — impronta larga e bassa — o che lo
    // dica il nome. Senza questa guardia il validatore chiedeva di appiattire la
    // punta di una lama.
    const wide = b.size[0] > b.size[1] * 1.8 && b.size[2] > b.size[1] * 1.8;
    const named = /platform|piattaforma|pad|raft|pedana|piano|deck|ponte/i.test(spec.id || '');
    const isPlatform = (flags.indexOf('flat_top') >= 0 && wide) || named;
    if (!isPlatform) return d;
    const topY = b.max[1];
    const p = built.merged.pos;
    // Variazione delle Y dei vertici nel 10% superiore.
    let minTop = Infinity, maxTop = -Infinity, n = 0;
    const thresh = topY - Math.max(b.size[1] * 0.08, 0.02);
    for (let i = 1; i < p.length; i += 3) {
        if (p[i] >= thresh) {
            if (p[i] < minTop) minTop = p[i];
            if (p[i] > maxTop) maxTop = p[i];
            n++;
        }
    }
    if (n > 4 && (maxTop - minTop) > Math.max(0.03, b.size[1] * 0.05)) {
        d.push(defect('notFlatTop', 'high', 'top',
            'Faccia superiore non piatta: variazione ' + (maxTop - minTop).toFixed(3) + 'm.',
            'Appiattire la faccia superiore; i dettagli vanno sotto o sul bordo.'));
    }
    // Centro ostruito.
    if (flags.indexOf('no_center_pivot') >= 0 || isPlatform) {
        const cx = b.center[0], cz = b.center[2];
        const rx = b.size[0] * 0.15, rz = b.size[2] * 0.15;
        let above = 0;
        for (let i = 0; i < p.length; i += 3) {
            if (Math.abs(p[i] - cx) < rx && Math.abs(p[i + 2] - cz) < rz
                    && p[i + 1] > topY - 0.01 + 0.02) {
                above++;
            }
        }
        if (above > 6) {
            d.push(defect('centerObstruction', 'high', 'center',
                'Geometria al centro sopra il piano della piattaforma (' + above + ' vertici).',
                'Eliminare sbarre/perni centrali; la superficie deve restare libera.'));
        }
    }
    return d;
}

function validateLimbs(spec, built) {
    const d = [];
    if (spec.cat !== 'char') return d;
    const nodes = (built.resolved || []).filter(n => !n.op);
    const armish = nodes.filter(n => /arm|braccio|mano|hand|upperarm|lowerarm/i.test(n.n + ' ' + (n.role || '')));
    const names = nodes.map(n => n.n).join(' ');
    // Se c'e' mir:x su un braccio, conta come due.
    let armCount = 0;
    for (const n of armish) armCount += n.mir === 'x' ? 2 : 1;
    // Heuristica: se non ci sono nodi "arm", cerca simmetria generale.
    if (armish.length === 0) {
        // Forse l'AI ha usato nomi generici: controlla asimmetria gia' coperta.
        return d;
    }
    if (armCount < 2) {
        d.push(defect('missingLimb', 'high', 'arm',
            'Braccia insufficienti (' + armCount + '): un umanoide ne serve due.',
            'Aggiungere un nodo caps/box per il braccio con mir:x.'));
    }
    // Braccia abbassate: la Y del centro del braccio deve essere sotto la spalla
    // (approssimata come 0.7 * altezza).
    const height = built.bounds.size[1] || 1;
    const shoulderY = built.bounds.min[1] + height * 0.75;
    for (const n of armish) {
        if (n.at && n.at[1] > shoulderY + height * 0.05) {
            d.push(defect('armsNotDown', 'high', n.n,
                'Il braccio "' + n.n + '" e\' troppo in alto (y=' + n.at[1].toFixed(2) + '), non lungo il fianco.',
                'Abbassare la Y del braccio sotto la spalla; a riposo la mano sta piu\' in basso della spalla.'));
            break;
        }
    }
    // Equipaggiamento fuso nella testa.
    const headish = nodes.filter(n => /head|testa|cam|camera|antenna|visor|helmet/i.test(n.n + ' ' + (n.role || '')));
    for (const n of headish) {
        if (/cam|camera|antenna|visor|scope/i.test(n.n) && !/helmet|head|testa/i.test(spec.id || '')) {
            d.push(defect('headGear', 'medium', n.n,
                'Possibile equipaggiamento fuso nella testa: "' + n.n + '".',
                'Rimuovere se non richiesto nel prompt; la testa e\' la testa.'));
        }
    }
    return d;
}

function validateCabin(spec, built) {
    const d = [];
    if (spec.cat !== 'vehicle') return d;
    const nodes = (built.resolved || []).filter(n => !n.op);
    const cabin = nodes.filter(n => /cabin|cabina|cockpit|cabin|glass|vetro|canopy|abitacolo/i.test(n.n + ' ' + (n.role || '')));
    if (!cabin.length) {
        d.push(defect('noCabin', 'medium', '',
            'Nessun nodo riconoscibile come cabina/abitacolo.',
            'Aggiungere un volume cabina maggiorato, cavo se possibile.'));
        return d;
    }
    // Rapporto volume cabina / veicolo.
    let cabinVol = 0;
    for (const n of cabin) {
        const s = n.s || [0, 0, 0];
        cabinVol += Math.abs(s[0] * s[1] * s[2]);
    }
    const body = built.bounds.size;
    const bodyVol = Math.max(1e-6, body[0] * body[1] * body[2]);
    if (cabinVol / bodyVol < 0.05) {
        d.push(defect('smallCabin', 'high', cabin[0].n,
            'Cabina troppo piccola (' + Math.round(100 * cabinVol / bodyVol) + '% del volume).',
            'Maggiore i params della cabina: deve essere abbondante e leggibile.'));
    }
    return d;
}

function validateDegenerates(spec, built) {
    const d = [];
    if (meshIsEmpty(built.merged)) return d;
    const area = meshArea(built.merged);
    if (area < 1e-6) {
        d.push(defect('zeroArea', 'high', '', 'Area totale quasi zero.', 'Ricontrollare le primitive.'));
    }
    const p = built.merged.pos;
    for (let i = 0; i < p.length; i++) {
        if (!isFinite(p[i])) {
            d.push(defect('nanVerts', 'high', '', 'Vertici con NaN/Inf.', 'Espressione o primitiva degenerata.'));
            break;
        }
    }
    const tris = meshTriCount(built.merged);
    if (tris > 200000) {
        d.push(defect('tooManyTris', 'medium', '',
            tris + ' triangoli: troppo per un asset di gioco a questo detail.',
            'Ridurre detail o semplificare le primitive tonde.'));
    }
    return d;
}

function validateLogic(spec) {
    const d = [];
    const nodes = spec.nodes || [];
    const logic = spec.logic || [];
    const bound = new Set(logic.map(l => l.on));
    for (const n of nodes) {
        if (n.interactive && !bound.has(n.n)) {
            d.push(defect('unboundInteractive', 'medium', n.n,
                'Nodo interattivo "' + n.n + '" senza voce in logic.',
                'Aggiungere {"on":"' + n.n + '","var":"...","trig":"interact"}.'));
        }
    }
    return d;
}

function validateAll(spec, built, opts) {
    opts = opts || {};
    let defects = []
        .concat(validateGround(spec, built))
        .concat(validateSymmetry(spec, built))
        .concat(validateComponents(spec, built))
        .concat(validateFlatTop(spec, built))
        .concat(validateLimbs(spec, built))
        .concat(validateCabin(spec, built))
        .concat(validateDegenerates(spec, built))
        .concat(validateLogic(spec));
    // Con un PIANO l'ingombro non si giudica qui: l'audit lo confronta pezzo per
    // pezzo con numeri verificati, e un secondo giudizio piu' grezzo sullo stesso
    // fatto produrrebbe due difetti per una causa sola.
    if (!opts.hasPlan) defects = defects.concat(validateSize(spec, built));
    const rank = { high: 0, medium: 1, low: 2 };
    defects.sort((a, b) => (rank[a.sev] || 9) - (rank[b.sev] || 9));
    return defects;
}

function metricsOf(spec, built) {
    const b = built.bounds;
    const vox = meshIsEmpty(built.merged) ? null : voxelizeBounds(built.merged, 18);
    const comps = vox ? countComponents(vox) : [];
    return {
        nodes: (spec.nodes || []).length,
        parts: (built.parts || []).length,
        tris: meshTriCount(built.merged),
        verts: meshVertCount(built.merged),
        area: Math.round(meshArea(built.merged) * 1000) / 1000,
        volume: Math.round(Math.abs(meshVolume(built.merged)) * 1000) / 1000,
        closed: meshIsClosed(built.merged),
        boundaryEdges: meshBoundaryEdges(built.merged),
        bounds: {
            min: b.min.map(x => Math.round(x * 1000) / 1000),
            max: b.max.map(x => Math.round(x * 1000) / 1000),
            size: b.size.map(x => Math.round(x * 1000) / 1000),
        },
        targetSize: spec.size || null,
        components: comps.length,
        componentSizes: comps.slice(0, 6),
        ground: !!spec.ground,
        cat: spec.cat,
        style: spec.style,
        flags: spec.flags || [],
        warnings: (built.warnings || []).length,
    };
}

/** Auto-riparazione solo dell'inequivocabile. Ritorna {spec, repairs}. */
function autoRepair(spec, built) {
    const repairs = [];
    const out = JSON.parse(JSON.stringify(spec));

    // Appoggio a terra.
    if (out.ground !== false && built.bounds && Math.abs(built.bounds.min[1]) > 0.02) {
        const dy = -built.bounds.min[1];
        for (const n of out.nodes || []) {
            if (Array.isArray(n.at) && typeof n.at[1] === 'number') n.at[1] += dy;
        }
        repairs.push('groundShift:' + dy.toFixed(3));
    }

    // Riscalatura all'ingombro dichiarato (se TUTTI e 3 gli assi sono fuori di un
    // fattore simile: altrimenti e' una forma sbagliata, non una scala).
    if (out.size && built.bounds) {
        const t = out.size, s = built.bounds.size;
        const ratios = [0, 1, 2].map(i => (s[i] > 1e-6 ? t[i] / s[i] : 1));
        const mean = (ratios[0] + ratios[1] + ratios[2]) / 3;
        const spread = Math.max(...ratios.map(r => Math.abs(r - mean)));
        if (mean > 0 && (mean < 0.5 || mean > 2.0) && spread < mean * 0.35) {
            for (const k of Object.keys(out.params || {})) {
                if (typeof out.params[k] === 'number') out.params[k] *= mean;
            }
            repairs.push('uniformScale:' + mean.toFixed(3));
        }
    }

    return { spec: out, repairs: repairs };
}
