/*
 * Verifica la ROTAZIONE DEL MODELLO e il FRAME DEL PERSONAGGIO in
 * ui/src/lib/15-rig.js (senza browser):
 *   - planRotationY/applyModelRotation ruotano i voxel a passi esatti di 90 gradi
 *     attorno a Y: quattro rotazioni tornano ESATTAMENTE ai voxel di partenza
 *     (aritmetica intera, nessuna perdita) e nulla esce da [0, gridSize-1];
 *   - le chiavi "x,y,z" dei pesi dipinti (rig.weights) seguono il loro voxel:
 *     se restassero ferme il weight paint finirebbe su voxel sbagliati;
 *   - ossa e posa NON si toccano: lo scheletro resta canonico, e' il corpo che gira
 *     (era il bug del vecchio rotateSkeletonY: girare le ossa non gira le clip);
 *   - rigFacingYaw() deduce il verso del personaggio da piedi/ossa gemelle;
 *   - faceRotate() coniuga una rotazione nel frame del personaggio, e per
 *     un'imbardata di 180 gradi coincide con la vecchia convenzione di segni
 *     (rx, rz invertiti): e' la prova che la generalizzazione non e' una regressione.
 *
 * Come tests/test_rig_tools.mjs: il modulo e' un frammento di UNO scope condiviso,
 * quindi si carica con new Function e stub minimi di THREE/DOM. Qui il Quaternion
 * pero' e' VERO (serve la matematica) e non un no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// --- stub DOM permissivo (qui si testa la logica, non la UI) ---
const mkEl = () => ({
    textContent: '', innerHTML: '', value: '0', checked: false, disabled: false,
    style: {}, dataset: {}, title: '', children: [],
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, appendChild(c) { this.children.push(c); },
    querySelectorAll: () => [], querySelector: () => null, remove() { },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
});
global.document = { getElementById: () => mkEl(), createElement: mkEl, querySelector: () => null, addEventListener() { } };
global.window = { addEventListener() { } };
global.alert = () => { };
global.prompt = () => null;
global.confirm = () => false;
global.localStorage = { getItem: () => null, setItem() { }, removeItem() { } };
global.t = (key, vars) => (vars ? key + '(' + JSON.stringify(vars) + ')' : key);

// Contatori: rotateModelY deve passare da pushHistory (una sola voce di undo) e
// ricostruire la scena invalidando l'indice incrementale.
const calls = { pushHistory: 0, buildModel: 0, invalidate: 0, render: 0 };
global.pushHistory = () => { calls.pushHistory++; };
global.buildModel = () => { calls.buildModel++; };
global.invalidateIncremental = () => { calls.invalidate++; };
global.requestRender = () => { calls.render++; };
global.updateHistoryButtons = () => { };
global.rebuildVoxelMap = () => { };
global.undoStack = [];
global.currentModelData = { metadata: {}, voxels: [] };
global.modelPivot = { visible: true };
global.gizmoEnabled = false;
global.renderer = { domElement: mkEl() };
global.camera = { fov: 45, position: { distanceTo: () => 10 }, getWorldDirection: v => v };
global.controls = { addEventListener() { } };

class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
    distanceTo() { return 10; }
    applyQuaternion() { return this; }
    setFromMatrixPosition() { return this; }
}
// Quaternion VERO (le formule sono quelle di THREE r128, ordine Euler XYZ).
class Quat {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    clone() { return new Quat(this.x, this.y, this.z, this.w); }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    setFromAxisAngle(axis, angle) {
        const h = angle / 2, s = Math.sin(h);
        this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(h);
        return this;
    }
    setFromEuler(e) {
        const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
        const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        return this;
    }
    invert() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }  // unitario -> coniugato
    multiply(q) {
        const ax = this.x, ay = this.y, az = this.z, aw = this.w;
        const bx = q.x, by = q.y, bz = q.z, bw = q.w;
        this.x = ax * bw + aw * bx + ay * bz - az * by;
        this.y = ay * bw + aw * by + az * bx - ax * bz;
        this.z = az * bw + aw * bz + ax * by - ay * bx;
        this.w = aw * bw - ax * bx - ay * by - az * bz;
        return this;
    }
}
global.THREE = {
    Group: class { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.visible = true; } add(o) { this.children.push(o); } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); } },
    Object3D: class { constructor() { this.position = new V3(); this.rotation = new V3(); this.quaternion = new Quat(); this.scale = new V3(1, 1, 1); this.visible = true; this.userData = {}; } add() { } updateMatrix() { } },
    Vector3: V3,
    Vector2: class { constructor() { this.x = 0; this.y = 0; } },
    Plane: class { setFromNormalAndCoplanarPoint() { return this; } },
    Raycaster: class { constructor() { this.ray = { intersectPlane: () => null }; } setFromCamera() { } },
    Quaternion: Quat,
    Euler: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } setFromQuaternion() { return this; } },
    TransformControls: class {
        constructor() {
            return new Proxy({ visible: false, enabled: true, object: null, mode: 'rotate' }, {
                get(t, k) { if (k in t) return t[k]; return () => { }; },
                set(t, k, v) { t[k] = v; return true; },
            });
        }
    },
    Color: class { constructor() { this.r = 0; this.g = 0; this.b = 0; } setHSL() { return this; } getHexString() { return '000000'; } },
    MathUtils: { degToRad: d => d * Math.PI / 180, radToDeg: r => r * 180 / Math.PI },
};
global.scene = { add() { }, remove() { } };

const rigSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/15-rig.js'), 'latin1');
const api = new Function(rigSrc + `
 ;return {planRotationY, applyModelRotation, rotateModelY, rigFacingYaw, faceRotate,
          buildHumanoidSkeleton, voxelBounds,
          setRig:(r)=>{rig=r;}, getRig:()=>rig};`)();

const key = v => v.x + ',' + v.y + ',' + v.z;
const setOf = list => new Set(list.map(key));
const sameSet = (a, b) => a.size === b.size && [...a].every(k => b.has(k));

// --- modello di prova ASIMMETRICO su X e Z (una rotazione sbagliata si vede) ---
// L rovesciata: una colonna in (1,*,1) e un braccio che si allunga verso +Z.
function mkVoxels() {
    const v = [];
    for (let y = 0; y <= 3; y++) v.push({ x: 1, y, z: 1, color: '#111111' });
    for (let z = 2; z <= 5; z++) v.push({ x: 1, y: 3, z, color: '#222222' });
    v.push({ x: 4, y: 0, z: 1, color: '#333333', part: 'piede' });
    return v;
}
const GRID = 16;
function mkModel(grid) {
    return { metadata: { name: 'test', grid_size: grid || [GRID, GRID, GRID] }, voxels: mkVoxels() };
}

// --- 1. quattro rotazioni da 90 gradi = identita' esatta ------------------------
{
    global.currentModelData = mkModel();
    api.setRig(null);
    const before = setOf(currentModelData.voxels);
    const beforeJson = JSON.stringify(currentModelData.voxels);
    for (let i = 0; i < 4; i++) ok(api.applyModelRotation(1) === true, 'rotazione ' + (i + 1) + '/4 applicata');
    ok(sameSet(setOf(currentModelData.voxels), before), '4x90 gradi riportano ESATTAMENTE ai voxel di partenza');
    ok(JSON.stringify(currentModelData.voxels) === beforeJson,
        'ordine, colori e campi extra (part) sopravvivono intatti');
    ok(currentModelData.metadata.grid_size.join(',') === GRID + ',' + GRID + ',' + GRID,
        'griglia cubica: grid_size invariata');
}

// --- 2. +90 e -90 si annullano; 180+180 pure -----------------------------------
{
    global.currentModelData = mkModel();
    const before = JSON.stringify(currentModelData.voxels);
    api.applyModelRotation(1);
    api.applyModelRotation(3);
    ok(JSON.stringify(currentModelData.voxels) === before, '+90 seguito da -90 e\' l\'identita\'');
    api.applyModelRotation(2);
    api.applyModelRotation(2);
    ok(JSON.stringify(currentModelData.voxels) === before, '180 due volte e\' l\'identita\'');
    ok(api.applyModelRotation(0) === false && api.applyModelRotation(4) === false,
        'zero gradi (o un giro intero) non e\' una rotazione: niente da fare');
}

// --- 3. coordinate attese: rotazione attorno al centro della GRIGLIA -----------
// Convenzione di THREE (rotation.y positiva porta +Z su +X), la stessa di
// bakeTransform() in 04-objects.js: con passo 90 e griglia N, (x,z) -> (z, N-1-x).
{
    global.currentModelData = mkModel();
    const src = mkVoxels();
    api.applyModelRotation(1);
    const got = currentModelData.voxels;
    let wrong = 0;
    src.forEach((v, i) => {
        const ex = { x: v.z, y: v.y, z: GRID - 1 - v.x };
        if (got[i].x !== ex.x || got[i].y !== ex.y || got[i].z !== ex.z) wrong++;
    });
    ok(wrong === 0, '90 gradi: ogni voxel (x,z) finisce in (z, N-1-x)');
    ok(got.every(v => Number.isInteger(v.x) && Number.isInteger(v.z)),
        'nessuna coordinata frazionaria (rotazione a passi interi)');
    ok(got.every(v => v.x >= 0 && v.x <= GRID - 1 && v.z >= 0 && v.z <= GRID - 1),
        'tutto resta dentro [0, gridSize-1]');
    // La Y non c'entra: e' una rotazione attorno all'asse verticale.
    ok(got.every((v, i) => v.y === src[i].y), 'la quota Y non viene toccata');
}

// --- 3b. griglia pari e dispari: nessun voxel esce e nulla si perde ------------
[8, 9, 16, 31, 32].forEach(N => {
    const vox = [];
    for (let x = 0; x < N; x += 3) for (let z = 0; z < N; z += 2) vox.push({ x, y: 0, z, color: '#abcdef' });
    global.currentModelData = { metadata: { grid_size: [N, N, N] }, voxels: vox };
    const n0 = vox.length;
    let inside = true, uniq = new Set();
    for (let i = 0; i < 4; i++) {
        api.applyModelRotation(1);
        currentModelData.voxels.forEach(v => {
            if (v.x < 0 || v.z < 0 || v.x > N - 1 || v.z > N - 1) inside = false;
        });
    }
    currentModelData.voxels.forEach(v => uniq.add(key(v)));
    ok(inside && uniq.size === n0,
        'griglia ' + N + '^3: ogni giro resta in [0,' + (N - 1) + '] e nessun voxel collassa');
});

// --- 4. griglia NON quadrata su X/Z: la scatola si scambia --------------------
{
    global.currentModelData = mkModel([32, 16, 8]);
    api.applyModelRotation(1);
    ok(currentModelData.metadata.grid_size.join(',') === '8,16,32',
        'su 90 gradi grid_size scambia X e Z: ' + currentModelData.metadata.grid_size.join(','));
    ok(currentModelData.voxels.every(v => v.x >= 0 && v.x <= 7 && v.z >= 0 && v.z <= 31),
        'i voxel stanno nella scatola scambiata');
    api.applyModelRotation(2);
    ok(currentModelData.metadata.grid_size.join(',') === '8,16,32',
        '180 gradi non scambia niente');
}

// --- 5. voxel FUORI dalla scatola dichiarata: si ripiega sul bounding box ------
{
    // grid_size 8 ma il modello arriva a 20: il centro della griglia porterebbe
    // fuori, quindi si ruota attorno al bbox e si rientra a forza (mai negativi).
    global.currentModelData = {
        metadata: { grid_size: [8, 8, 8] },
        voxels: [{ x: 12, y: 0, z: 20, color: '#fff' }, { x: 20, y: 1, z: 12, color: '#fff' }]
    };
    const n = currentModelData.voxels.length;
    api.applyModelRotation(1);
    ok(currentModelData.voxels.every(v => v.x >= 0 && v.z >= 0),
        'fallback: nessuna coordinata negativa');
    ok(new Set(currentModelData.voxels.map(key)).size === n, 'fallback: nessun voxel perso');
    // Modello senza griglia dichiarata.
    global.currentModelData = { metadata: {}, voxels: mkVoxels() };
    const b0 = api.voxelBounds(currentModelData.voxels);
    api.applyModelRotation(3);
    const b1 = api.voxelBounds(currentModelData.voxels);
    ok(b1.minX === b0.minX && b1.minZ === b0.minZ,
        'senza grid_size l\'angolo minimo del modello resta dov\'era');
    ok(currentModelData.metadata.grid_size === undefined, 'senza griglia non se ne inventa una');
}

// --- 6. i pesi dipinti seguono il loro voxel; ossa e posa NON si muovono -------
{
    global.currentModelData = mkModel();
    const bones = [
        { name: 'hips', parent: -1, head: [1, 1, 1], tail: [1, 3, 1] },
        { name: 'foot_R', parent: 0, head: [4, 0, 1], tail: [4, 0, 3] },
    ];
    const rigData = {
        type: 'humanoid', binding: 'smooth', bones,
        pose: { hips: [0, 0.5, 0] },
        weights: { '1,3,5': 'hips', '4,0,1': { foot_R: 0.7, hips: 0.3 }, 'rotto': 'hips' },
        customAnims: []
    };
    api.setRig(rigData);
    const bonesJson = JSON.stringify(bones);
    const poseJson = JSON.stringify(rigData.pose);

    api.applyModelRotation(1);   // (x,z) -> (z, 15-x)
    const w = api.getRig().weights;
    ok(w['5,3,14'] === 'hips', 'la chiave 1,3,5 segue il voxel in 5,3,14: ' + Object.keys(w).join(' '));
    const blend = w['1,0,11'];
    ok(blend && blend.foot_R === 0.7 && blend.hips === 0.3,
        'i pesi GRADUALI arrivano interi sulla nuova chiave: ' + JSON.stringify(blend));
    ok(w['1,3,5'] === undefined && w['rotto'] === undefined,
        'le chiavi vecchie (e quelle malformate) non restano in giro');
    ok(JSON.stringify(api.getRig().bones) === bonesJson, 'le ossa NON si muovono (scheletro canonico)');
    ok(JSON.stringify(api.getRig().pose) === poseJson, 'la posa NON viene toccata');

    // Ogni chiave dei pesi punta a un voxel vivo: altrimenti pruneWeightOverrides
    // le butterebbe al primo applyRig e il weight paint sparirebbe.
    const live = new Set(currentModelData.voxels.map(key));
    ok(Object.keys(w).every(k => live.has(k)), 'tutte le chiavi rimappate puntano a voxel esistenti');

    // Pesi assenti: non si inventa un oggetto vuoto.
    api.setRig({ bones, pose: {}, weights: null, customAnims: [] });
    api.applyModelRotation(2);
    ok(api.getRig().weights === null, 'senza correzioni manuali weights resta null');
}

// --- 7. rotateModelY: una voce di undo, un rebuild, niente rig ----------------
{
    global.currentModelData = mkModel();
    api.setRig(null);
    calls.pushHistory = calls.buildModel = calls.invalidate = calls.render = 0;
    ok(api.rotateModelY(-90) === true, 'rotateModelY accetta i gradi (-90)');
    ok(calls.pushHistory === 1 && calls.buildModel === 1 && calls.invalidate === 1 && calls.render === 1,
        'una sola voce di undo + invalidazione incrementale + rebuild + render: ' + JSON.stringify(calls));
    ok(api.rotateModelY(0) === false && calls.pushHistory === 1,
        '0 gradi non tocca nulla (nessuna voce di undo inutile)');
    global.currentModelData = { metadata: { grid_size: [16, 16, 16] }, voxels: [] };
    ok(api.rotateModelY(90) === false && calls.pushHistory === 1, 'modello vuoto: niente da ruotare');
}

// --- 8. rigFacingYaw: da che parte guarda il personaggio ----------------------
{
    const body = [];
    for (let y = 0; y <= 18; y++) for (let x = 5; x <= 10; x++) for (let z = 7; z <= 8; z++) body.push({ x, y, z, color: '#888' });
    for (let x = 0; x <= 4; x++) for (let z = 7; z <= 8; z++) body.push({ x, y: 13, z, color: '#888' });
    for (let x = 11; x <= 15; x++) for (let z = 7; z <= 8; z++) body.push({ x, y: 13, z, color: '#888' });
    const skel = api.buildHumanoidSkeleton(body);
    ok(api.rigFacingYaw(skel.bones) === 0, 'scheletro autogenerato su un corpo simmetrico: frame canonico (0)');

    // Piedi verso -Z = il vecchio isFacingNegZ.
    const negZ = JSON.parse(JSON.stringify(skel.bones));
    negZ.forEach(b => { if (/^(foot|toeTip)_[LR]$/.test(b.name)) { const d = b.tail[2] - b.head[2]; b.tail[2] = b.head[2] - d; } });
    ok(api.rigFacingYaw(negZ) === 180, 'piedi verso -Z -> 180 (compatibile con il vecchio isFacingNegZ)');

    // Scheletro girato a mano di 90 gradi (col gizmo G): era il caso che rompeva
    // le clip, le gambe oscillavano di fianco.
    // NB: qui si usa la convenzione di THREE (rotation.y = deg), cioe' la stessa
    // di rigFacingYaw: R_y(deg) porta il davanti canonico (0,0,1) su (sin,0,cos),
    // quindi ruotando di `deg` ci si aspetta esattamente yaw = deg.
    const rot = (bones, deg) => {
        const st = ((deg / 90) % 4 + 4) % 4, cos = [1, 0, -1, 0][st], sin = [0, 1, 0, -1][st];
        const out = JSON.parse(JSON.stringify(bones));
        out.forEach(b => {
            [b.head, b.tail].forEach(p => {
                const x = p[0], z = p[2];
                p[0] = x * cos + z * sin; p[2] = -x * sin + z * cos;
            });
        });
        return out;
    };
    ok(api.rigFacingYaw(rot(skel.bones, 90)) === 90, 'scheletro ruotato di 90 -> yaw 90');
    ok(api.rigFacingYaw(rot(skel.bones, 180)) === 180, 'scheletro ruotato di 180 -> yaw 180');
    ok(api.rigFacingYaw(rot(skel.bones, 270)) === 270, 'scheletro ruotato di 270 -> yaw 270');

    // Senza piedi si usa l'asse laterale delle ossa gemelle _R/_L.
    const noFeet = skel.bones.filter(b => !/^(foot|toeTip|upperLeg|lowerLeg)_/.test(b.name));
    ok(api.rigFacingYaw(noFeet) === 0, 'senza piedi il davanti viene dedotto dalle ossa _R/_L');
    ok(api.rigFacingYaw(rot(noFeet, 270)) === 270, 'stessa deduzione su uno scheletro girato');

    // Catena generica (nessun piede, nessun gemello) -> canonico, non NaN.
    ok(api.rigFacingYaw([{ name: 'seg1', parent: -1, head: [0, 0, 0], tail: [0, 2, 0] }]) === 0,
        'scheletro generico: si resta sul frame canonico');
    ok(api.rigFacingYaw(null) === 0 && api.rigFacingYaw([]) === 0, 'ossa assenti: nessun errore, yaw 0');

    // INVARIANTE della funzione nuova: ruotare il MODELLO non cambia il frame
    // dello scheletro (e' esattamente il motivo per cui le clip restano valide).
    global.currentModelData = { metadata: { grid_size: [16, 16, 16] }, voxels: body.map(v => Object.assign({}, v)) };
    api.setRig({ bones: skel.bones, pose: {}, weights: null, customAnims: [] });
    api.applyModelRotation(1);
    ok(api.rigFacingYaw(api.getRig().bones) === 0,
        'dopo aver girato il corpo lo scheletro e\' ancora canonico');
}

// --- 9. faceRotate: la coniugazione porta la clip nel frame del personaggio ----
{
    const qOf = (x, y, z) => new Quat().setFromEuler(new THREE.Euler(x, y, z));
    const sameQ = (a, b, m) => ok(near(a.x, b.x, 1e-12) && near(a.y, b.y, 1e-12) &&
        near(a.z, b.z, 1e-12) && near(a.w, b.w, 1e-12), m);
    const yaw = deg => new Quat().setFromAxisAngle(new V3(0, 1, 0), deg * Math.PI / 180);

    const q = qOf(0.3, -0.2, 0.5);
    ok(api.faceRotate(q, null) === q, 'frame canonico: nessun calcolo, e\' lo STESSO quaternione');

    // 180 gradi: coniugare equivale a invertire rx e rz, cioe' esattamente cio' che
    // facevano legSign/kneeSign. E' la prova che il vecchio comportamento e' salvo.
    sameQ(api.faceRotate(qOf(0.3, -0.2, 0.5), yaw(180)), qOf(-0.3, -0.2, -0.5),
        'imbardata 180: equivale alla vecchia regola dei segni (-rx, ry, -rz)');

    // 90 gradi: una rotazione attorno a X (gamba avanti/indietro nel canonico)
    // diventa una rotazione attorno a -Z, cioe' avanti/indietro per un personaggio
    // che guarda +X. Prima invece la gamba si apriva DI LATO.
    sameQ(api.faceRotate(qOf(0.4, 0, 0), yaw(90)), qOf(0, 0, -0.4),
        'imbardata 90: la rotazione su X diventa su -Z (la gamba oscilla nel verso giusto)');
    sameQ(api.faceRotate(qOf(0.4, 0, 0), yaw(270)), qOf(0, 0, 0.4),
        'imbardata 270: verso opposto');
    // L'asse verticale non cambia mai: l'imbardata e' attorno a Y.
    sameQ(api.faceRotate(qOf(0, 0.6, 0), yaw(90)), qOf(0, 0.6, 0),
        'una rotazione attorno a Y e\' invariante per imbardata');
    // La coniugazione conserva l'angolo (nessuna deformazione del movimento).
    const src = qOf(0.7, 0.2, -0.4), conj = api.faceRotate(src.clone(), yaw(90));
    ok(near(Math.abs(conj.w), Math.abs(src.w), 1e-12), 'la coniugazione conserva l\'ampiezza della rotazione');
}

console.log(fail ? `\nFALLITI: ${fail} (pass=${pass})` : `\nTUTTI I TEST PASSATI  (pass=${pass})`);
process.exit(fail ? 1 : 0);
