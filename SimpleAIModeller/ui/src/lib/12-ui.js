// =======================================================================
//  12 - UI: generazione, pannelli, critica, impostazioni
// =======================================================================

let appState = {
    spec: null,
    built: null,
    plan: null,
    defects: [],
    metrics: null,
    visionOk: null,         // null=sconosciuto, true/false
    visionReason: '',
    busy: false,
    settings: null,
    rounds: 0,
};

// Quante volte al massimo si ritenta la correzione automatica. Ogni giro e' UNA
// chiamata AI: due bastano a chiudere gli errori aritmetici (che sono locali e
// puntuali), e oltre si entra nel territorio in cui il modello ricomincia a
// riscrivere parti sane.
const MAX_FIX_ROUNDS = 2;

function setStatus(msg, kind) {
    const el = $('statusBar');
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
}

function setBusy(on, label) {
    appState.busy = !!on;
    const btn = $('generateBtn');
    if (btn) btn.disabled = !!on;
    const spin = $('busyOverlay');
    if (spin) spin.hidden = !on;
    if (label) setStatus(label, 'busy');
}

function readForm() {
    return {
        prompt: ($('promptInput') && $('promptInput').value || '').trim(),
        cat: ($('catSelect') && $('catSelect').value) || 'prop',
        style: ($('styleSelect') && $('styleSelect').value) || 'lowpoly',
        detail: parseInt(($('detailSelect') && $('detailSelect').value) || '2', 10),
        size: [
            parseFloat(($('sizeX') && $('sizeX').value) || '0') || 0,
            parseFloat(($('sizeY') && $('sizeY').value) || '0') || 0,
            parseFloat(($('sizeZ') && $('sizeZ').value) || '0') || 0,
        ],
        ground: !($('groundCheck') && !$('groundCheck').checked),
        planFirst: !($('planCheck') && !$('planCheck').checked),
        vision: !!( $('visionCheck') && $('visionCheck').checked ),
        autofix: !($('autofixCheck') && !$('autofixCheck').checked),
        model: ($('modelSelect') && $('modelSelect').value) || '',
        notes: ($('notesInput') && $('notesInput').value) || '',
    };
}

/** Quanti pezzi ci si aspetta di vedere: lo dice il PIANO, non il budget. */
function validateOpts() {
    const plan = appState.plan;
    const expected = plan && plan.chain
        ? plan.chain.length + ((plan.extras && plan.extras.length) || 0)
        : 0;
    return { hasPlan: !!plan, expectedParts: expected };
}

function renderPlan(plan) {
    const box = $('planOut');
    if (!box) return;
    if (!plan || !plan.chain) {
        box.textContent = t('plan.none');
        return;
    }
    const ax = plan.axis.toUpperCase();
    const lines = [];
    lines.push(t('plan.header', {
        axis: ax,
        len: plan.axisLength.toFixed(3),
        total: plan.total.map(v => v.toFixed(3)).join(' x '),
    }));
    for (const s of plan.chain) {
        lines.push('  ' + s.n.padEnd(16).slice(0, 16)
            + ' ' + s.from.toFixed(3) + ' → ' + s.to.toFixed(3)
            + '  (' + (s.to - s.from).toFixed(3) + ')'
            + '  w' + s.w.toFixed(3) + ' d' + s.d.toFixed(3));
    }
    for (const s of (plan.extras || [])) {
        lines.push('  · ' + s.n.padEnd(14).slice(0, 14)
            + ' su ' + (s.of || '-')
            + ' ' + s.from.toFixed(3) + '→' + s.to.toFixed(3));
    }
    if (plan.repairs && plan.repairs.length) {
        lines.push(t('plan.repaired', { n: plan.repairs.length }));
    }
    box.textContent = lines.join('\n');
}

function showSpecInUi(spec, built, defects) {
    appState.spec = spec;
    appState.built = built;
    appState.defects = defects || [];
    // JSON
    const jsonEl = $('jsonOut');
    if (jsonEl) jsonEl.value = JSON.stringify(spec, null, 2);
    // Stats
    const statsEl = $('statsOut');
    if (statsEl && built) {
        const m = metricsOf(spec, built);
        appState.metrics = m;
        statsEl.textContent =
            t('stats.line', {
                nodes: m.nodes, parts: m.parts, tris: m.tris,
                size: m.bounds.size.map(x => x.toFixed(3)).join(' x '),
                closed: m.closed ? t('stats.closed') : t('stats.open'),
            });
    }
    // Nodes list
    const list = $('nodesList');
    if (list) {
        list.innerHTML = '';
        for (const n of (spec.nodes || [])) {
            const li = document.createElement('li');
            li.dataset.node = n.n;
            li.textContent = n.n + '  ·  ' + n.p
                + (n.mat ? '  ·  ' + n.mat : '')
                + (n.op ? '  ·  ' + n.op + '→' + n.of : '')
                + (n.mir ? '  ·  mir:' + n.mir : '')
                + (n.locked ? '  ·  🔒' : '');
            li.addEventListener('click', () => selectNode(n.n));
            if (n.n === selectedName) li.classList.add('selected');
            list.appendChild(li);
        }
    }
    // Defects
    renderDefects(appState.defects);
    // Params
    const paramsEl = $('paramsList');
    if (paramsEl) {
        paramsEl.innerHTML = '';
        for (const [k, v] of Object.entries(spec.params || {})) {
            const row = document.createElement('div');
            row.className = 'param-row';
            const lab = document.createElement('label');
            lab.textContent = k;
            const inp = document.createElement('input');
            inp.type = 'number'; inp.step = 'any'; inp.value = v;
            inp.dataset.param = k;
            inp.addEventListener('change', () => {
                if (!appState.spec) return;
                appState.spec.params[k] = parseFloat(inp.value) || 0;
                rebuildCurrent();
            });
            row.appendChild(lab); row.appendChild(inp);
            paramsEl.appendChild(row);
        }
    }
}

function renderDefects(defects) {
    const box = $('defectsList');
    if (!box) return;
    box.innerHTML = '';
    if (!defects || !defects.length) {
        box.innerHTML = '<li class="ok">' + t('defects.none') + '</li>';
        return;
    }
    for (const d of defects) {
        const li = document.createElement('li');
        li.className = 'sev-' + (d.sev || 'medium');
        li.innerHTML = '<strong>[' + (d.sev || '?') + '] ' + (d.code || '')
            + (d.where ? ' @ ' + d.where : '') + '</strong>'
            + '<div>' + (d.what || '') + '</div>'
            + (d.fix ? '<div class="fix">' + d.fix + '</div>' : '');
        box.appendChild(li);
    }
}

function rebuildCurrent() {
    if (!appState.spec) return;
    const built = showSpec(appState.spec);
    const defects = validateAll(appState.spec, built, validateOpts());
    showSpecInUi(appState.spec, built, defects);
    return { built, defects };
}

/** Audit aritmetico contro il piano. Nessuna AI: e' una somma, e sta in un solo
 *  posto (Python, `src/plan.py`) proprio per non avere due implementazioni. */
async function auditAgainstPlan(spec, built) {
    if (!appState.plan || !appState.plan.chain) return [];
    try {
        const data = await apiPost('/api/asset/audit', {
            plan: appState.plan,
            measured: measuredFor(built, spec),
        });
        return data.defects || [];
    } catch (e) {
        console.warn('[audit]', e);
        return [];
    }
}

function mergeDefects(lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
        for (const d of (list || [])) {
            const k = (d.code || '') + '|' + (d.where || '');
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(d);
        }
    }
    const rank = { high: 0, medium: 1, low: 2 };
    out.sort((a, b) => (rank[a.sev] || 9) - (rank[b.sev] || 9));
    return out;
}

function countHigh(defects) {
    return (defects || []).filter(d => d.sev === 'high').length;
}

/** Un giro di correzione: patch AI guidata dai difetti, poi ricostruzione e
 *  riaudit. Ritorna i nuovi difetti, o null se la patch e' fallita. */
async function fixRound(defects, humanText) {
    const data = await apiPost('/api/asset/patch', {
        spec: appState.spec,
        plan: appState.plan,
        defects: defects,
        request: humanText || '',
        model: readForm().model,
    });
    let spec = data.spec;
    let built = showSpec(spec);
    const ar = autoRepair(spec, built);
    if (ar.repairs.length) {
        spec = ar.spec;
        built = showSpec(spec);
    }
    appState.spec = spec;
    appState.built = built;
    const local = validateAll(spec, built, validateOpts());
    const audit = await auditAgainstPlan(spec, built);
    const merged = mergeDefects([audit, local]);
    showSpecInUi(spec, built, merged);
    return { defects: merged, applied: data.applied || 0 };
}

async function doGenerate() {
    const form = readForm();
    if (!form.prompt) {
        setStatus(t('err.noPrompt'), 'error');
        return;
    }
    setBusy(true, form.planFirst ? t('status.planning') : t('status.generating'));
    appState.rounds = 0;
    try {
        const data = await apiPost('/api/asset/generate', {
            prompt: form.prompt,
            cat: form.cat,
            style: form.style,
            detail: form.detail,
            size: (form.size[0] > 0 || form.size[1] > 0 || form.size[2] > 0)
                ? form.size : null,
            ground: form.ground,
            planFirst: form.planFirst,
            notes: form.notes,
            model: form.model,
        });
        appState.plan = data.plan || null;
        renderPlan(appState.plan);

        let spec = data.spec;
        let built = showSpec(spec);
        const ar = autoRepair(spec, built);
        if (ar.repairs.length) {
            spec = ar.spec;
            built = showSpec(spec);
        }
        appState.spec = spec;
        appState.built = built;

        let local = validateAll(spec, built, validateOpts());
        let audit = await auditAgainstPlan(spec, built);
        let defects = mergeDefects([audit, local]);
        showSpecInUi(spec, built, defects);

        // RATCHET aritmetico: finche' ci sono difetti gravi e i giri restano,
        // si corregge. La condizione di uscita non e' "il modello dice ok" ma
        // "i numeri tornano", che e' l'unica che non si puo' allucinare.
        while (form.autofix && countHigh(defects) > 0 && appState.rounds < MAX_FIX_ROUNDS) {
            appState.rounds++;
            setBusy(true, t('status.fixing', {
                round: appState.rounds, max: MAX_FIX_ROUNDS,
                n: countHigh(defects),
            }));
            const before = countHigh(defects);
            let res;
            try {
                res = await fixRound(defects, '');
            } catch (e) {
                console.warn('[fix]', e);
                break;
            }
            defects = res.defects;
            // Se un giro non migliora niente, insistere spreca chiamate.
            if (countHigh(defects) >= before) break;
        }

        // Critica visiva opzionale, DOPO che i numeri tornano: giudicare
        // l'estetica di un modello con le misure sbagliate e' tempo perso.
        if (form.vision && appState.visionOk !== false && countHigh(defects) === 0) {
            await doCritique(false);
        } else {
            setStatus(t('status.ready', {
                nodes: (appState.spec.nodes || []).length,
                defects: defects.length,
            }), countHigh(defects) ? 'warn' : 'ok');
        }
    } catch (e) {
        console.error(e);
        if (e.status === 401) {
            setStatus(t('err.auth'), 'error');
            openSettings();
        } else {
            setStatus(t('err.generate', { msg: e.message || e }), 'error');
        }
    } finally {
        setBusy(false);
    }
}

async function doCritique(fromGenerate) {
    if (!appState.spec || !appState.built) {
        setStatus(t('err.noAsset'), 'error');
        return;
    }
    setBusy(true, t('status.critiquing'));
    try {
        const metrics = metricsOf(appState.spec, appState.built);
        let image = null;
        if (appState.visionOk !== false && ($('visionCheck') && $('visionCheck').checked)) {
            try {
                image = contactSheetDataURL({ tileW: 280, tileH: 210 });
            } catch (e) {
                console.warn('[sheet]', e);
            }
        }
        // Se vision non e' ok, chiedi feedback umano.
        if (!image || appState.visionOk === false) {
            setBusy(false);
            const human = window.prompt(t('critique.humanPrompt'), '');
            if (human == null || !String(human).trim()) {
                setStatus(t('status.ready', {
                    nodes: (appState.spec.nodes || []).length,
                    defects: appState.defects.length,
                }), 'ok');
                return;
            }
            await doPatch(String(human).trim());
            return;
        }
        const data = await apiPost('/api/asset/critique', {
            spec: appState.spec,
            metrics: metrics,
            image: image,
            request: ($('promptInput') && $('promptInput').value) || '',
        });
        const defects = (data.defects || []).concat(
            // tiene anche i validatori locali
            appState.defects.filter(d => d.sev === 'high')
        );
        // dedup by code+where
        const seen = new Set();
        const merged = [];
        for (const d of defects) {
            const k = d.code + '|' + d.where;
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(d);
        }
        appState.defects = merged;
        renderDefects(merged);
        setStatus(t('status.critiqueDone', {
            verdict: data.verdict || '?',
            score: data.score != null ? data.score : '—',
            n: merged.length,
        }), data.verdict === 'pass' ? 'ok' : 'warn');

        if (data.verdict === 'fail' && merged.length && fromGenerate) {
            // Una passata di patch automatica.
            await doPatch('', merged);
        }
    } catch (e) {
        console.error(e);
        setStatus(t('err.critique', { msg: e.message || e }), 'error');
    } finally {
        setBusy(false);
    }
}

async function doPatch(humanText, defects) {
    if (!appState.spec) return;
    setBusy(true, t('status.patching'));
    try {
        const res = await fixRound(defects || appState.defects, humanText || '');
        setStatus(t('status.patched', {
            applied: res.applied,
            defects: res.defects.length,
        }), countHigh(res.defects) ? 'warn' : 'ok');
    } catch (e) {
        console.error(e);
        setStatus(t('err.patch', { msg: e.message || e }), 'error');
    } finally {
        setBusy(false);
    }
}

async function probeVision() {
    const el = $('visionStatus');
    try {
        if (el) el.textContent = t('vision.probing');
        const data = await apiPost('/api/vision/probe', {});
        appState.visionOk = !!data.ok;
        appState.visionReason = data.reason || '';
        if (el) {
            el.textContent = data.ok
                ? t('vision.ok', { s: data.seconds || '?' })
                : t('vision.fail', { reason: data.reason || '?' });
            el.dataset.ok = data.ok ? '1' : '0';
        }
        const chk = $('visionCheck');
        if (chk && !data.ok) {
            chk.checked = false;
            chk.disabled = data.reason === 'typeUnsupported'
                || data.reason === 'customUnsupported';
        }
        return data;
    } catch (e) {
        appState.visionOk = false;
        if (el) el.textContent = t('vision.fail', { reason: e.message || e });
        return null;
    }
}

// --- Settings modal --------------------------------------------------------

function openSettings() {
    const m = $('settingsModal');
    if (m) m.hidden = false;
    refreshSettings();
}

function closeSettings() {
    const m = $('settingsModal');
    if (m) m.hidden = true;
}

async function refreshSettings() {
    try {
        const s = await apiGet('/api/settings');
        appState.settings = s;
        const info = $('settingsInfo');
        if (info) {
            info.textContent = t('settings.summary', {
                provider: (s.provider && s.provider.activeLabel) || '?',
                cookies: s.has_cookies ? t('settings.cookiesYes') : t('settings.cookiesNo'),
                vision: (s.provider && s.provider.vision) ? t('settings.visionYes') : t('settings.visionNo'),
            });
        }
        const prov = await apiGet('/api/providers');
        const list = $('providerList');
        if (list) {
            list.innerHTML = '';
            for (const p of (prov.providers || [])) {
                const li = document.createElement('li');
                const active = p.id === prov.active;
                li.innerHTML = '<strong>' + (p.label || p.id) + '</strong> '
                    + '<span class="muted">' + (p.type || '') + '</span> '
                    + (active ? '<em>' + t('settings.active') + '</em>' : '');
                if (!active) {
                    const btn = document.createElement('button');
                    btn.textContent = t('settings.use');
                    btn.onclick = async () => {
                        await apiPost('/api/providers', { action: 'activate', id: p.id });
                        refreshSettings();
                        probeVision();
                    };
                    li.appendChild(btn);
                }
                list.appendChild(li);
            }
        }
    } catch (e) {
        console.warn(e);
    }
}

async function saveCookies() {
    const ta = $('cookiesInput');
    if (!ta) return;
    let data;
    try { data = JSON.parse(ta.value); }
    catch (e) { setStatus(t('err.badJson'), 'error'); return; }
    try {
        await apiPost('/api/settings/cookies', data);
        setStatus(t('settings.cookiesSaved'), 'ok');
        refreshSettings();
    } catch (e) {
        setStatus(t('err.generic', { msg: e.message }), 'error');
    }
}

// --- Demo asset (senza AI) -------------------------------------------------

function loadDemo() {
    const demo = {
        id: 'cassa_demo',
        cat: 'prop',
        style: 'lowpoly',
        detail: 2,
        size: [0.9, 0.7, 0.6],
        ground: true,
        params: { w: 0.9, h: 0.62, d: 0.6, t: 0.05, lid: 0.08 },
        mats: {
            legno: { col: '#6B4A2F', rough: 0.85,
                     noise: { t: 'stripe', scale: 26, amp: 0.22, col2: '#4A3120' } },
            ferro: { col: '#4A4F57', rough: 0.4, metal: 0.85,
                     noise: { t: 'scratch', scale: 60, amp: 0.15 } },
        },
        nodes: [
            { n: 'corpo', p: 'box', s: ['w', 'h', 'd'], at: [0, 'h/2', 0],
              bevel: 0.02, mat: 'legno' },
            { n: 'cavo', p: 'box', s: ['w-2*t', 'h-t', 'd-2*t'],
              at: [0, 'h/2+t', 0], op: 'sub', of: 'corpo' },
            { n: 'fascia', p: 'box', s: ['w+t*0.4', 't*1.2', 'd+t*0.4'],
              at: [0, 'h*0.25', 0], mat: 'ferro',
              arr: { n: 2, step: [0, 'h*0.5', 0] } },
            { n: 'coperchio', p: 'box', s: ['w', 'lid', 'd'],
              at: [0, 'h+lid/2', 0], mat: 'legno', bone: 'cardine', interactive: true },
            { n: 'cardine', p: 'cyl', r: 't*0.6', len: 'w*0.8', axis: 'x',
              at: [0, 'h+lid*0.5', '-d/2+t*0.6'], mat: 'ferro' },
        ],
        rig: [{ b: 'cardine', piv: [0, 'h', '-d/2'], axis: 'x', lim: [-100, 0] }],
        clips: {
            apri: { dur: 0.6, loop: false,
                    keys: [[0, { cardine: [0, 0, 0] }],
                           [0.6, { cardine: [-95, 0, 0] }]] },
        },
        logic: [{ on: 'coperchio', var: 'aperta', trig: 'interact', clip: 'apri' }],
        col: [{ t: 'box', at: [0, 'h/2', 0], s: ['w', 'h+lid', 'd'] }],
        flags: ['hollow'],
    };
    // Le espressioni restano stringhe: le risolve buildSpec.
    // Ma bevel numerico e' gia' risolto.
    const built = showSpec(demo);
    appState.plan = null;
    renderPlan(null);
    const defects = validateAll(demo, built, { hasPlan: false });
    showSpecInUi(demo, built, defects);
    setStatus(t('status.demo'), 'ok');
}

/** Popola il selettore modello dal provider attivo. Onesta': con Gemini a
 *  cookie il client installato NON espone il modello (vedi `_gemini_client` nel
 *  padre), quindi la scelta vale per i provider a chiave API. Dirlo e' meglio
 *  che offrire una tendina che non fa niente. */
async function populateModels() {
    const sel = $('modelSelect');
    if (!sel) return;
    try {
        const prov = await apiGet('/api/providers');
        const active = (prov.providers || []).find(p => p.id === prov.active);
        sel.innerHTML = '';
        const opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = t('model.default');
        sel.appendChild(opt0);
        let list = [];
        if (active && active.type === 'gemini_cookies') list = prov.geminiModels || [];
        else if (active && active.type === 'anthropic') list = prov.anthropicModels || [];
        else if (active && active.model) list = [active.model];
        for (const m of list) {
            const o = document.createElement('option');
            o.value = m; o.textContent = m;
            sel.appendChild(o);
        }
        const note = $('modelNote');
        if (note) {
            note.textContent = (active && active.type === 'gemini_cookies')
                ? t('model.geminiNote') : '';
        }
    } catch (e) { /* offline */ }
}

function wireUi() {
    const gen = $('generateBtn');
    if (gen) gen.addEventListener('click', doGenerate);
    const demo = $('demoBtn');
    if (demo) demo.addEventListener('click', loadDemo);
    const crit = $('critiqueBtn');
    if (crit) crit.addEventListener('click', () => doCritique(false));
    const patch = $('patchBtn');
    if (patch) patch.addEventListener('click', () => {
        const human = window.prompt(t('critique.humanPrompt'), '');
        if (human != null) doPatch(String(human));
    });
    const setBtn = $('settingsBtn');
    if (setBtn) setBtn.addEventListener('click', openSettings);
    const setClose = $('settingsClose');
    if (setClose) setClose.addEventListener('click', closeSettings);
    const saveCk = $('saveCookiesBtn');
    if (saveCk) saveCk.addEventListener('click', saveCookies);
    const probeBtn = $('probeVisionBtn');
    if (probeBtn) probeBtn.addEventListener('click', probeVision);

    // Views
    $$('[data-view]').forEach(btn => {
        btn.addEventListener('click', () => setView(btn.getAttribute('data-view')));
    });

    // Export
    const expBundle = $('exportBundleBtn');
    if (expBundle) expBundle.addEventListener('click', async () => {
        try {
            setBusy(true, t('status.zipping'));
            const n = await exportBundle(appState.spec, appState.built, appState.plan);
            setStatus(t('status.bundled', { kb: Math.round(n / 1024) }), 'ok');
        } catch (e) {
            setStatus(t('err.export', { msg: e.message }), 'error');
        } finally { setBusy(false); }
    });
    const expGlb = $('exportGlbBtn');
    if (expGlb) expGlb.addEventListener('click', async () => {
        try {
            await exportGLB(appState.spec, appState.built);
            setStatus(t('status.exported', { fmt: 'GLB' }), 'ok');
        } catch (e) { setStatus(t('err.export', { msg: e.message }), 'error'); }
    });
    const expObj = $('exportObjBtn');
    if (expObj) expObj.addEventListener('click', () => {
        try {
            exportOBJ(appState.spec, appState.built);
            setStatus(t('status.exported', { fmt: 'OBJ' }), 'ok');
        } catch (e) { setStatus(t('err.export', { msg: e.message }), 'error'); }
    });
    const expJson = $('exportJsonBtn');
    if (expJson) expJson.addEventListener('click', () => {
        try {
            exportJSON(appState.spec);
            setStatus(t('status.exported', { fmt: 'JSON' }), 'ok');
        } catch (e) { setStatus(t('err.export', { msg: e.message }), 'error'); }
    });
    const expCol = $('exportColBtn');
    if (expCol) expCol.addEventListener('click', () => {
        try {
            exportColliders(appState.spec);
            setStatus(t('status.exported', { fmt: 'colliders' }), 'ok');
        } catch (e) { setStatus(t('err.export', { msg: e.message }), 'error'); }
    });

    // Sheet preview
    const sheetBtn = $('sheetBtn');
    if (sheetBtn) sheetBtn.addEventListener('click', () => {
        try {
            const url = contactSheetDataURL();
            const w = window.open('');
            if (w) w.document.write('<img src="' + url + '" style="width:100%">');
        } catch (e) { setStatus(t('err.export', { msg: e.message }), 'error'); }
    });

    // Human ref toggle
    const hum = $('humanCheck');
    if (hum) {
        hum.checked = loadPref('showHuman', true);
        hum.addEventListener('change', () => {
            if (humanRef) humanRef.visible = hum.checked;
            savePref('showHuman', hum.checked);
            _needsRender = true;
        });
    }

    // Apply JSON button
    const applyJson = $('applyJsonBtn');
    if (applyJson) applyJson.addEventListener('click', async () => {
        try {
            const raw = JSON.parse($('jsonOut').value);
            const data = await apiPost('/api/asset/normalize', { spec: raw });
            const built = showSpec(data.spec);
            appState.spec = data.spec;
            appState.built = built;
            const local = validateAll(data.spec, built, validateOpts());
            const audit = await auditAgainstPlan(data.spec, built);
            showSpecInUi(data.spec, built, mergeDefects([audit, local]));
            setStatus(t('status.normalized', { n: (data.warnings || []).length }), 'ok');
        } catch (e) {
            setStatus(t('err.generic', { msg: e.message }), 'error');
        }
    });

    // Import (bottone + input file; il drag&drop e' agganciato altrove)
    const impBtn = $('importBtn');
    const impInput = $('importInput');
    if (impBtn && impInput) {
        impBtn.addEventListener('click', () => impInput.click());
        impInput.addEventListener('change', async () => {
            const f = impInput.files && impInput.files[0];
            if (f) await openAnyFile(f);
            impInput.value = '';
        });
    }
    const clearRef = $('clearRefBtn');
    if (clearRef) clearRef.addEventListener('click', () => {
        clearReference();
        setStatus(t('status.refCleared'), 'ok');
    });

    // Ctrl+Enter to generate
    const prompt = $('promptInput');
    if (prompt) prompt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            doGenerate();
        }
    });
}
