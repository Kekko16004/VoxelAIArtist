// =======================================================================
//  09d - Editor: selezione, gizmo, undo/redo, scorciatoie
//
//  Il gizmo scrive NELLA SPEC, non sulla scena: spostare una mesh e
//  lasciare la spec com'era darebbe un modello che al primo rebuild torna
//  dov'era, e un export che non corrisponde a cio' che si vede.
//
//  Un nodo mosso a mano viene marcato `locked`: l'audit lo salta, perche'
//  la posizione scelta dall'utente non e' un errore del modello. Senza
//  questo, il ratchet "correggerebbe" ogni modifica manuale al giro dopo.
// =======================================================================

let gizmo = null;
let selectedName = '';
let selectedMesh = null;
let gizmoMode = 'translate';
let historyStack = [];
let historyIndex = -1;
const HISTORY_MAX = 60;

function currentSnap() {
    return JSON.stringify({ spec: appState.spec, plan: appState.plan });
}

function pushHistory() {
    if (!appState.spec) return;
    const snap = currentSnap();
    // Una modifica nuova azzera il redo: tenere un futuro che non discende
    // dal presente e' il modo classico di far ricomparire roba cancellata.
    if (historyIndex < historyStack.length - 1) {
        historyStack = historyStack.slice(0, historyIndex + 1);
    }
    if (historyStack.length && historyStack[historyStack.length - 1] === snap) return;
    historyStack.push(snap);
    if (historyStack.length > HISTORY_MAX) historyStack.shift();
    historyIndex = historyStack.length - 1;
}

function restoreHistory(delta) {
    const target = historyIndex + delta;
    if (target < 0 || target >= historyStack.length) return false;
    historyIndex = target;
    const snap = JSON.parse(historyStack[historyIndex]);
    appState.spec = snap.spec;
    appState.plan = snap.plan;
    renderPlan(appState.plan);
    const built = showSpec(appState.spec);
    appState.built = built;
    const defects = validateAll(appState.spec, built, validateOpts());
    showSpecInUi(appState.spec, built, defects);
    selectNode(selectedName, true);
    if (typeof refreshSmoothButton === 'function') refreshSmoothButton();
    return true;
}

/**
 * `pushHistory` registra lo stato PRIMA della modifica (e' il punto in cui si
 * torna), quindi lo stato ATTUALE non e' ancora nello stack. Se si annullasse
 * subito, si salterebbe indietro di due passi: il primo undo dopo un'azione
 * riporterebbe allo stato precedente a quello precedente. Qui, prima di
 * scendere, si deposita lo stato attuale in cima — cosi' esiste anche un futuro
 * a cui il redo puo' tornare.
 */
function undo() {
    if (!appState.spec || !historyStack.length) return;
    const cur = currentSnap();
    if (historyIndex === historyStack.length - 1 && historyStack[historyIndex] !== cur) {
        historyStack.push(cur);
        historyIndex = historyStack.length - 1;
        if (historyStack.length > HISTORY_MAX) {
            historyStack.shift();
            historyIndex--;
        }
    }
    if (restoreHistory(-1)) setStatus(t('status.undo'), 'ok');
}

function redo() {
    if (restoreHistory(1)) setStatus(t('status.redo'), 'ok');
}

function specNode(name) {
    if (!appState.spec) return null;
    return (appState.spec.nodes || []).find(n => n.n === name) || null;
}

function findMeshByName(name) {
    if (!assetRoot) return null;
    let found = null;
    assetRoot.traverse((c) => {
        if (!found && c.isMesh && c.name === name) found = c;
    });
    return found;
}

function selectNode(name, quiet) {
    selectedName = name || '';
    selectedMesh = name ? findMeshByName(name) : null;

    // Evidenzia nell'outliner.
    $$('#nodesList li').forEach((li) => {
        li.classList.toggle('selected', li.dataset.node === selectedName);
    });

    if (gizmo) {
        if (selectedMesh) {
            gizmo.attach(selectedMesh);
            gizmo.visible = true;
        } else {
            gizmo.detach();
            gizmo.visible = false;
        }
    }
    const box = $('selInfo');
    if (box) {
        const n = specNode(selectedName);
        box.textContent = n
            ? t('sel.info', {
                name: n.n, prim: n.p,
                mat: n.mat || '—',
                locked: n.locked ? t('sel.locked') : '',
            })
            : t('sel.none');
    }
    if (!quiet) _needsRender = true;
}

/** Click nel viewport: raycast sulle parti. */
function wirePicking() {
    const canvas = $('viewport');
    if (!canvas) return;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downX = 0, downY = 0;
    canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
    canvas.addEventListener('pointerup', (e) => {
        // Un trascinamento e' orbita, non selezione: senza questa soglia
        // ogni rotazione della camera cambierebbe la selezione.
        if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
        if (gizmo && gizmo.dragging) return;
        const r = canvas.getBoundingClientRect();
        ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
        ray.setFromCamera(ndc, camera);
        const hits = ray.intersectObjects(assetRoot ? assetRoot.children : [], true);
        const hit = hits.find(h => h.object && h.object.isMesh
                              && !/_outline$/.test(h.object.name));
        selectNode(hit ? hit.object.name : '');
    });
}

function initGizmo() {
    if (!TransformControls || !camera || !renderer) return;
    gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSpace('local');
    gizmo.visible = false;
    gizmo.addEventListener('change', () => { _needsRender = true; });
    gizmo.addEventListener('dragging-changed', (e) => {
        if (controls) controls.enabled = !e.value;
        if (e.value) {
            pushHistory();
            _gizmoStart = selectedMesh ? {
                pos: selectedMesh.position.clone(),
                rot: selectedMesh.rotation.clone(),
                scale: selectedMesh.scale.clone(),
            } : null;
        } else {
            commitGizmo();
        }
    });
    // In r15x+ TransformControls non e' un Object3D: si aggiunge il suo helper.
    const helper = (typeof gizmo.getHelper === 'function') ? gizmo.getHelper() : gizmo;
    scene.add(helper);
    gizmo._helper = helper;
}

let _gizmoStart = null;

/**
 * Scrive la trasformazione del gizmo nella spec.
 *
 * Le misure sono ESPRESSIONI (`(lama_a+lama_b)/2`): sostituirle con un numero
 * scollegherebbe il nodo dalla catena del piano. Quindi si scrive il valore
 * numerico E si marca il nodo `locked`, cosi' l'audit non lo tratta piu' come
 * un errore del modello — e' una scelta di chi lo ha mosso.
 */
function commitGizmo() {
    if (!selectedMesh || !selectedName || !appState.spec) return;
    const node = specNode(selectedName);
    if (!node) return;
    const built = appState.built;
    const partBefore = built && built.parts.find(p => p.name === selectedName);

    if (gizmoMode === 'translate') {
        const d = selectedMesh.position;
        if (d.lengthSq() < 1e-12) return;
        const at = (partBefore ? meshBounds(partBefore).center : [0, 0, 0]);
        // `at` della spec e' il centro del volume: si somma lo spostamento.
        const cur = Array.isArray(node.at) ? node.at.slice() : [0, 0, 0];
        node.at = [
            _numOrExpr(cur[0], d.x), _numOrExpr(cur[1], d.y), _numOrExpr(cur[2], d.z),
        ];
    } else if (gizmoMode === 'rotate') {
        const e = selectedMesh.rotation;
        const deg = (v) => Math.round(v * 180 / Math.PI * 100) / 100;
        const cur = Array.isArray(node.rot) ? node.rot.slice() : [0, 0, 0];
        node.rot = [
            _numOrExpr(cur[0], deg(e.x)), _numOrExpr(cur[1], deg(e.y)),
            _numOrExpr(cur[2], deg(e.z)),
        ];
    } else if (gizmoMode === 'scale') {
        const s = selectedMesh.scale;
        const cur = Array.isArray(node.s) ? node.s.slice() : [1, 1, 1];
        node.s = [_mulOrExpr(cur[0], s.x), _mulOrExpr(cur[1], s.y), _mulOrExpr(cur[2], s.z)];
    }
    node.locked = true;
    selectedMesh.position.set(0, 0, 0);
    selectedMesh.rotation.set(0, 0, 0);
    selectedMesh.scale.set(1, 1, 1);

    rebuildAfterEdit();
}

/** Somma un delta a un campo che puo' essere numero o espressione. */
function _numOrExpr(cur, delta) {
    if (Math.abs(delta) < 1e-9) return cur;
    if (typeof cur === 'number') return Math.round((cur + delta) * 100000) / 100000;
    const d = Math.round(delta * 100000) / 100000;
    return '(' + String(cur) + ')' + (d >= 0 ? '+' : '') + d;
}

function _mulOrExpr(cur, factor) {
    if (Math.abs(factor - 1) < 1e-9) return cur;
    if (typeof cur === 'number') return Math.round(cur * factor * 100000) / 100000;
    return '(' + String(cur) + ')*' + (Math.round(factor * 100000) / 100000);
}

function rebuildAfterEdit() {
    const built = showSpec(appState.spec);
    appState.built = built;
    const defects = validateAll(appState.spec, built, validateOpts());
    showSpecInUi(appState.spec, built, defects);
    selectNode(selectedName, true);
}

function setGizmoMode(mode) {
    gizmoMode = mode;
    if (gizmo) gizmo.setMode(mode);
    $$('[data-gizmo]').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-gizmo') === mode);
    });
    _needsRender = true;
}

function deleteSelected() {
    if (!selectedName || !appState.spec) return;
    pushHistory();
    const name = selectedName;
    appState.spec.nodes = (appState.spec.nodes || []).filter(n => n.n !== name);
    // Le booleane che puntavano al nodo cancellato restano orfane.
    for (const n of appState.spec.nodes) {
        if (n.of === name) { delete n.op; delete n.of; }
    }
    selectNode('');
    rebuildAfterEdit();
    setStatus(t('status.deleted', { name: name }), 'ok');
}

function duplicateSelected() {
    const node = specNode(selectedName);
    if (!node || !appState.spec) return;
    pushHistory();
    const copy = JSON.parse(JSON.stringify(node));
    let i = 2;
    const names = new Set(appState.spec.nodes.map(n => n.n));
    while (names.has(copy.n + '_' + i)) i++;
    copy.n = copy.n + '_' + i;
    copy.locked = true;
    appState.spec.nodes.push(copy);
    rebuildAfterEdit();
    selectNode(copy.n);
    setStatus(t('status.duplicated', { name: copy.n }), 'ok');
}

function toggleWireframe() {
    if (!assetRoot) return;
    assetRoot.traverse((c) => {
        if (c.isMesh && c.material && !/_outline$/.test(c.name)) {
            c.material.wireframe = !c.material.wireframe;
        }
    });
    _needsRender = true;
}

function frameSelection() {
    if (selectedMesh && appState.built) {
        const part = appState.built.parts.find(p => p.name === selectedName);
        if (part) {
            fitCameraToAsset(meshBounds(part));
            return;
        }
    }
    if (appState.built) fitCameraToAsset(appState.built.bounds);
}

function wireShortcuts() {
    window.addEventListener('keydown', (e) => {
        const tag = (e.target && e.target.tagName) || '';
        // In un campo di testo le lettere sono testo, non comandi.
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            if (e.key === 'Escape') e.target.blur();
            return;
        }
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === 'z') {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
        if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (k === 'g') { setGizmoMode('translate'); e.preventDefault(); }
        else if (k === 'r') { setGizmoMode('rotate'); e.preventDefault(); }
        else if (k === 's') { setGizmoMode('scale'); e.preventDefault(); }
        else if (k === 'w') { toggleWireframe(); e.preventDefault(); }
        else if (k === 'a') { toggleAutoSmooth(); e.preventDefault(); }
        else if (k === 'f') { frameSelection(); e.preventDefault(); }
        else if (k === 'delete' || k === 'backspace') { deleteSelected(); e.preventDefault(); }
        else if (k === 'escape') { selectNode(''); }
        else if (k >= '1' && k <= '6') {
            const views = ['front', 'back', 'left', 'right', 'top', 'persp'];
            setView(views[parseInt(k, 10) - 1]);
            e.preventDefault();
        }
    });
}

function initEditor() {
    initGizmo();
    wirePicking();
    wireShortcuts();
    setGizmoMode('translate');
    $$('[data-gizmo]').forEach(b => {
        b.addEventListener('click', () => setGizmoMode(b.getAttribute('data-gizmo')));
    });
    const del = $('deleteNodeBtn');
    if (del) del.addEventListener('click', deleteSelected);
    const dup = $('dupNodeBtn');
    if (dup) dup.addEventListener('click', duplicateSelected);
    const un = $('undoBtn');
    if (un) un.addEventListener('click', undo);
    const re = $('redoBtn');
    if (re) re.addEventListener('click', redo);
    const wf = $('wireBtn');
    if (wf) wf.addEventListener('click', toggleWireframe);
    const sm = $('smoothBtn');
    if (sm) {
        sm.addEventListener('click', (e) => {
            // Shift+clic scorre la soglia d'angolo invece di spegnere: e' la
            // regolazione che serve piu' spesso dopo averlo acceso.
            if (e.shiftKey) cycleSmoothAngle(); else toggleAutoSmooth();
        });
    }
    refreshSmoothButton();
}

/**
 * Auto smooth: accende/spegne le normali smussate (come Shade Auto Smooth).
 *
 * E' una proprieta' della SPEC, non della vista: cosi' sopravvive alla
 * ricostruzione, finisce nell'export, si salva col progetto ed e' ANNULLABILE
 * con Ctrl+Z come ogni altra modifica. Un interruttore di sola vista sarebbe
 * sparito al primo rebuild e l'export non l'avrebbe rispettato.
 */
const SMOOTH_ANGLE_DEFAULT = 40;

function toggleAutoSmooth(angle) {
    if (!appState.spec) return;
    pushHistory();
    const cur = appState.spec.smooth;
    if (cur && cur.on) {
        appState.spec.smooth = { on: false, angle: cur.angle || SMOOTH_ANGLE_DEFAULT };
    } else {
        appState.spec.smooth = {
            on: true,
            angle: angle || (cur && cur.angle) || SMOOTH_ANGLE_DEFAULT,
        };
    }
    rebuildAfterEdit();
    refreshSmoothButton();
    setStatus(appState.spec.smooth.on
        ? t('status.smoothOn', { angle: appState.spec.smooth.angle })
        : t('status.smoothOff'), 'ok');
}

/** Cambia la soglia d'angolo senza spegnere: piu' alta = piu' tondo. */
function cycleSmoothAngle() {
    if (!appState.spec) return;
    const steps = [20, 30, 40, 60, 80];
    const cur = (appState.spec.smooth && appState.spec.smooth.angle)
        || SMOOTH_ANGLE_DEFAULT;
    const next = steps[(steps.indexOf(cur) + 1 + steps.length) % steps.length]
        || SMOOTH_ANGLE_DEFAULT;
    pushHistory();
    appState.spec.smooth = { on: true, angle: next };
    rebuildAfterEdit();
    refreshSmoothButton();
    setStatus(t('status.smoothOn', { angle: next }), 'ok');
}

function refreshSmoothButton() {
    const btn = $('smoothBtn');
    if (!btn) return;
    const on = !!(appState.spec && appState.spec.smooth && appState.spec.smooth.on);
    btn.classList.toggle('active', on);
    const angle = (appState.spec && appState.spec.smooth && appState.spec.smooth.angle)
        || SMOOTH_ANGLE_DEFAULT;
    btn.title = on ? t('smooth.titleOn', { angle: angle }) : t('smooth.titleOff');
}
