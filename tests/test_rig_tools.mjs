/*
 * Verifica gli STRUMENTI RIG di ui/src/lib/32-rig-tools.js senza browser:
 *   - specchio su X di posa e pesi (regola (rx,-ry,-rz) + voxel gemello minX+maxX-x);
 *   - simmetrizzazione dello scheletro dopo le correzioni con G (idempotente);
 *   - editing delle ossa: il nome e' l'identita' (posa/pesi/animazioni migrano) e
 *     `parent` e' un INDICE, quindi eliminando un osso va rimappato tutto;
 *   - geometria dell'IK a due ossa, compreso il bersaglio fuori portata (niente NaN);
 *   - libreria di pose riusabile fra oggetti con nomi di ossa diversi.
 *
 * Come tests/test_rig_weights.mjs: i moduli sono frammenti di UNO scope condiviso,
 * quindi si caricano concatenati con new Function e stub minimi di THREE/DOM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- stub DOM permissivo (qui si testa la logica, non la UI) ---
const mkEl = () => ({
    textContent: '', innerHTML: '', value: '0', checked: false, disabled: false,
    style: {}, dataset: {}, title: '', children: [],
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, appendChild(c) { this.children.push(c); },
    querySelectorAll: () => [], querySelector: () => null, remove() { },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
});
global.document = { getElementById: () => mkEl(), createElement: mkEl, addEventListener() { } };
global.window = { addEventListener() { } };
global.alert = () => { };
global.prompt = () => null;
global.confirm = () => false;
const store = new Map();
global.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
};
global.requestRender = () => { };
global.updateHistoryButtons = () => { };
global.pushHistory = () => { };
global.undoStack = [];
global.currentModelData = { metadata: {}, voxels: [] };
global.modelPivot = { visible: true };
global.gizmoEnabled = false;
global.buildModel = () => { };
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
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
    distanceTo() { return 10; }
    applyQuaternion() { return this; }
    setFromMatrixPosition() { return this; }
}
global.THREE = {
    Group: class { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.visible = true; } add(o) { this.children.push(o); } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); } },
    Object3D: class { constructor() { this.position = new V3(); this.rotation = new V3(); this.quaternion = { copy: () => { }, setFromEuler: () => { } }; this.scale = new V3(1, 1, 1); this.visible = true; this.userData = {}; } add() { } updateMatrix() { } },
    Vector3: V3,
    Vector2: class { constructor() { this.x = 0; this.y = 0; } },
    Plane: class { setFromNormalAndCoplanarPoint() { return this; } },
    Raycaster: class { constructor() { this.ray = { intersectPlane: () => null }; } setFromCamera() { } },
    Quaternion: class { copy() { return this; } invert() { return this; } multiply() { return this; } setFromEuler() { return this; } setFromUnitVectors() { return this; } },
    Euler: class { constructor() { this.x = 0; this.y = 0; this.z = 0; } setFromQuaternion() { return this; } },
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
// `t` esiste sempre nel bundle vero (23-i18n.js sta piu' su nel manifest). Qui
// torna la chiave con i segnaposto risolti, cosi' un'asserzione puo' leggere
// SIA la chiave sia i valori che le sono stati passati.
global.t = (k, vars) => k + (vars ? JSON.stringify(vars) : '');

const rigSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/15-rig.js'), 'latin1');
const toolsSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/32-rig-tools.js'), 'latin1');
const api = new Function(rigSrc + '\n' + toolsSrc + `
 ;return {mirrorBoneName, boneSideOf, uniqueBoneName, mirrorPoseData, mirrorWeightsData,
          remapWeightEntry,
          symmetrizeBonesData, rigAddChildBone, rigRenameBone, rigDeleteBone,
          solveTwoBoneIK, ikChainForBone, poseForBones, poseLibLoad, poseLibSave,
          rigForwardZ, ikBendHint, buildHumanoidSkeleton, POSE_LIB_KEY, POSE_LIB_MAX};`)();

const dup = o => JSON.parse(JSON.stringify(o));

// --- nomi e lati ---------------------------------------------------------------
ok(api.mirrorBoneName('hand_L') === 'hand_R' && api.mirrorBoneName('hand_R') === 'hand_L',
    'mirrorBoneName scambia i suffissi _L/_R');
ok(api.mirrorBoneName('hips') === null, 'un osso centrale non ha gemello');
ok(api.boneSideOf('upperArm_R') === 'R' && api.boneSideOf('spine') === '', 'boneSideOf legge il lato');
ok(api.uniqueBoneName([{ name: 'coda' }, { name: 'coda_2' }], 'coda') === 'coda_3',
    'uniqueBoneName evita le collisioni');
ok(api.uniqueBoneName([], 'osso nuovo') === 'osso_nuovo', 'gli spazi diventano underscore');

// --- scheletro di prova simmetrico ---------------------------------------------
// x: L a sinistra (x bassa), R a destra (x alta); voxel da 0 a 10 -> mx = 10, cx = 5.
function mkBones() {
    return [
        { name: 'hips', parent: -1, head: [5, 5, 5], tail: [5, 7, 5] },
        { name: 'upperArm_L', parent: 0, head: [3, 7, 5], tail: [1, 7, 5] },
        { name: 'forearm_L', parent: 1, head: [1, 7, 5], tail: [0, 7, 5] },
        { name: 'handTip_L', parent: 2, head: [0, 7, 5], tail: [-1, 7, 5], helper: true },
        { name: 'upperArm_R', parent: 0, head: [7, 7, 5], tail: [9, 7, 5] },
        { name: 'forearm_R', parent: 4, head: [9, 7, 5], tail: [10, 7, 5] },
    ];
}
const voxels = [];
for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) voxels.push({ x, y, z: 5, color: '#888888' });

// --- 1. specchio della posa ----------------------------------------------------
{
    const bones = mkBones();
    const pose = { upperArm_L: [0.1, 0.2, 0.3], hips: [0, 0.5, 0] };
    const res = api.mirrorPoseData(bones, pose, 'LtoR');
    ok(res.changed === 1, 'LtoR specchia solo il lato R esistente (changed=' + res.changed + ')');
    const r = res.pose.upperArm_R;
    ok(near(r[0], 0.1) && near(r[1], -0.2) && near(r[2], -0.3), 'regola dello specchio: (rx, -ry, -rz)');
    ok(pose.upperArm_R === undefined, 'la posa originale non viene toccata (ritorno di un oggetto nuovo)');
    ok(near(res.pose.hips[1], 0.5), 'con LtoR le ossa centrali restano come sono');

    const both = api.mirrorPoseData(bones, { upperArm_L: [0.1, 0.2, 0.3], hips: [0, 0.5, 0] }, 'both');
    ok(near(both.pose.upperArm_R[1], -0.2) && both.pose.upperArm_L === undefined,
        'both SCAMBIA i due lati: la posa di L passa a R (e L prende quella - vuota - di R)');
    ok(near(both.pose.hips[1], -0.5), 'both specchia anche le ossa centrali su se stesse');

    // forearm_L non ha gemello nella lista? ce l'ha; usiamo un osso spaiato vero.
    const spaiato = api.mirrorPoseData([{ name: 'ala_L', parent: -1, head: [0, 0, 0], tail: [1, 0, 0] }],
        { ala_L: [0, 1, 1] }, 'LtoR');
    ok(spaiato.changed === 0, 'un arto senza gemello non produce nulla (undo inutile scartato)');
}

// --- 1b. specchio dei pesi dipinti --------------------------------------------
{
    const bones = mkBones();
    const weights = { '1,7,5': 'forearm_L', '5,5,5': 'hips' };
    const res = api.mirrorWeightsData(voxels, bones, weights, 'LtoR');
    ok(res.copied === 1, 'un solo voxel da specchiare (quello sull\'asse si salta)');
    ok(res.weights['9,7,5'] === 'forearm_R', 'il voxel gemello (minX+maxX-x) prende l\'osso gemello');
    ok(res.weights['1,7,5'] === 'forearm_L', 'la correzione originale resta');

    const noTwin = api.mirrorWeightsData([{ x: 1, y: 7, z: 5 }, { x: 5, y: 0, z: 0 }], bones, { '1,7,5': 'forearm_L' }, 'LtoR');
    ok(noTwin.copied === 0 && noTwin.skipped === 1, 'senza voxel gemello la correzione si scarta invece di creare dati morti');
    ok(api.mirrorWeightsData(voxels, bones, null, 'LtoR').copied === 0, 'nessuna correzione: niente da fare');
}

// --- 1c. i pesi GRADUALI {osso: peso} attraversano gli stessi strumenti --------
// Dal weight paint smooth una voce non e' piu' una stringa ma una miscela di ossa:
// se rinomina/elimina/specchia guardassero solo la forma stringa i pesi dipinti
// verrebbero silenziosamente buttati (era il bug da evitare).
{
    const bones = mkBones();
    const weights = { '1,7,5': { forearm_L: 0.7, upperArm_L: 0.3 }, '5,5,5': { hips: 1 } };
    const res = api.mirrorWeightsData(voxels, bones, weights, 'LtoR');
    ok(res.copied === 1, 'pesi graduali: un solo voxel da specchiare');
    const tw = res.weights['9,7,5'];
    ok(tw && near(tw.forearm_R, 0.7) && near(tw.upperArm_R, 0.3),
        'ogni osso della miscela passa al gemello mantenendo il suo peso: ' + JSON.stringify(tw));
    ok(res.weights['1,7,5'].forearm_L === 0.7, 'la miscela originale resta intatta');
    // hips non ha gemello: il peso resta su hips (non si perde).
    const both = api.mirrorWeightsData(voxels, bones, { '3,7,5': { upperArm_L: 0.5, hips: 0.5 } }, 'LtoR');
    const m = both.weights['7,7,5'];
    ok(m && near(m.upperArm_R, 0.5) && near(m.hips, 0.5),
        'un osso centrale nella miscela resta se stesso: ' + JSON.stringify(m));
}
{
    // remapWeightEntry: rinormalizzazione e svuotamento.
    const e = api.remapWeightEntry({ a: 0.5, b: 0.5 }, n => (n === 'b' ? null : n));
    ok(e && near(e.a, 1), 'perso un osso, il residuo si rinormalizza a 1: ' + JSON.stringify(e));
    ok(api.remapWeightEntry({ a: 1 }, () => null) === null, 'miscela senza ossa superstiti -> null');
    ok(api.remapWeightEntry('a', n => (n === 'a' ? 'z' : n)) === 'z', 'la forma stringa resta stringa');
    ok(api.remapWeightEntry('a', () => null) === null, 'stringa con osso sparito -> null');
    const fused = api.remapWeightEntry({ a: 0.25, b: 0.75 }, () => 'z');
    ok(fused && near(fused.z, 1), 'due ossa fuse nello stesso nome sommano i pesi');
}

// --- 2. simmetrizzazione dello scheletro --------------------------------------
{
    const bones = mkBones();
    bones[4].head = [7.5, 8, 6];          // upperArm_R spostato a mano con G
    bones[4].tail = [9.5, 8, 6];
    bones[0].head = [4, 5, 5];            // hips fuori asse
    const res = api.symmetrizeBonesData(bones, voxels, 'LtoR');
    const R = res.bones.find(b => b.name === 'upperArm_R');
    ok(near(R.head[0], 7) && near(R.head[1], 7) && near(R.head[2], 5),
        'RtoL/LtoR copia il lato sorgente riflesso: head ' + JSON.stringify(R.head));
    ok(res.moved === 1 && res.pairs === 2, 'una sola osso spostato, due coppie L/R viste');
    ok(res.centred === 1 && near(res.bones[0].head[0], 5), 'le ossa centrali vengono riagganciate all\'asse');
    const again = api.symmetrizeBonesData(res.bones, voxels, 'LtoR');
    ok(again.moved === 0 && again.centred === 0, 'la simmetrizzazione e\' idempotente');

    const avg = api.symmetrizeBonesData(bones, voxels, 'both');
    const aL = avg.bones.find(b => b.name === 'upperArm_L');
    const aR = avg.bones.find(b => b.name === 'upperArm_R');
    ok(near(aL.head[0], 10 - aR.head[0]) && near(aL.head[1], aR.head[1]),
        'both: la media dei due lati e\' simmetrica per costruzione');
}

// --- 4. editing delle ossa ----------------------------------------------------
{
    const rigData = { type: 'humanoid', bones: mkBones(), pose: { forearm_L: [0, 0.3, 0] }, weights: { '1,7,5': 'forearm_L' }, customAnims: [{ name: 'x', tracks: [{ bone: 'forearm_L', keys: [] }] }] };
    const idx = api.rigAddChildBone(rigData, 2, 'dita_L');
    ok(idx === rigData.bones.length - 1, 'il nuovo osso va IN FONDO (nessun indice parent slitta)');
    const nb = rigData.bones[idx];
    ok(nb.parent === 2 && near(nb.head[0], 0), 'nasce sulla coda del genitore');
    ok(near(nb.tail[0], -1) && near(nb.tail[1], 7), 'prosegue nella direzione del genitore');

    ok(api.rigRenameBone(rigData, 2, '') !== null, 'nome vuoto rifiutato');
    ok(api.rigRenameBone(rigData, 2, 'ciao mondo!') !== null, 'caratteri non ammessi rifiutati');
    ok(api.rigRenameBone(rigData, 2, 'hips') !== null, 'nome duplicato rifiutato');
    ok(api.rigRenameBone(rigData, 2, 'avambraccio_L') === null, 'rinomina valida accettata');
    ok(rigData.pose.avambraccio_L && rigData.pose.forearm_L === undefined, 'la posa segue il nuovo nome');
    ok(rigData.weights['1,7,5'] === 'avambraccio_L', 'le correzioni dei pesi seguono il nuovo nome');
    ok(rigData.customAnims[0].tracks[0].bone === 'avambraccio_L', 'i track delle animazioni AI seguono il nuovo nome');
}
{
    // Stesse due operazioni, ma con pesi GRADUALI.
    const rigData = {
        type: 'humanoid', bones: mkBones(), pose: {},
        weights: { '1,7,5': { forearm_L: 0.6, upperArm_L: 0.4 } }, customAnims: []
    };
    ok(api.rigRenameBone(rigData, 2, 'avambraccio_L') === null, 'rinomina accettata (pesi graduali)');
    const w = rigData.weights['1,7,5'];
    ok(w && near(w.avambraccio_L, 0.6) && near(w.upperArm_L, 0.4),
        'la miscela segue il nuovo nome senza toccare gli altri pesi: ' + JSON.stringify(w));

    const res = api.rigDeleteBone(rigData, 2);      // elimina avambraccio_L
    ok(!res.error, 'eliminazione accettata (pesi graduali)');
    const w2 = rigData.weights && rigData.weights['1,7,5'];
    ok(w2 && w2.avambraccio_L === undefined && near(w2.upperArm_L, 1),
        'il voxel sopravvive: perde la quota dell\'osso eliminato e si rinormalizza: ' + JSON.stringify(w2));
}
{
    // Catena a -> b -> c -> d: eliminando b, c deve riattaccarsi ad a con gli indici
    // rimappati. Era il bug classico: il rig si riattacca a ossa casuali.
    const rigData = {
        bones: [
            { name: 'a', parent: -1, head: [0, 0, 0], tail: [0, 1, 0] },
            { name: 'b', parent: 0, head: [0, 1, 0], tail: [0, 2, 0] },
            { name: 'c', parent: 1, head: [0, 2, 0], tail: [0, 3, 0] },
            { name: 'd', parent: 2, head: [0, 3, 0], tail: [0, 4, 0] },
            { name: 'bTip', parent: 1, head: [0, 2, 0], tail: [0, 2.2, 0], helper: true },
        ],
        pose: { b: [0, 1, 0], c: [0, 2, 0] },
        weights: { '0,1,0': 'b', '0,2,0': 'c' },
        customAnims: [{ name: 'k', tracks: [{ bone: 'b' }, { bone: 'c' }] }],
    };
    const res = api.rigDeleteBone(rigData, 1);
    ok(!res.error, 'eliminazione accettata');
    ok(rigData.bones.map(b => b.name).join(',') === 'a,c,d', 'osso e sua punta helper rimossi: ' + rigData.bones.map(b => b.name).join(','));
    ok(rigData.bones[1].parent === 0 && rigData.bones[2].parent === 1, 'i figli passano al genitore con gli indici rimappati');
    ok(res.select === 0, 'la selezione torna sul genitore');
    ok(rigData.pose.b === undefined && rigData.pose.c, 'la posa dell\'osso rimosso sparisce, le altre restano');
    ok(rigData.weights['0,1,0'] === undefined && rigData.weights['0,2,0'] === 'c', 'le correzioni dell\'osso rimosso spariscono');
    ok(rigData.customAnims[0].tracks.length === 1, 'i track dell\'osso rimosso spariscono');

    const solo = { bones: [{ name: 'a', parent: -1, head: [0, 0, 0], tail: [0, 1, 0] }] };
    ok(api.rigDeleteBone(solo, 0).error, 'non si puo\' svuotare del tutto lo scheletro');
}

// --- 3. geometria dell'IK ------------------------------------------------------
{
    const root = [0, 10, 0], l1 = 3, l2 = 3;
    const sol = api.solveTwoBoneIK(root, [4, 10, 0], l1, l2, [0, 0, -1]);
    const d1 = Math.hypot(sol.elbow[0] - root[0], sol.elbow[1] - root[1], sol.elbow[2] - root[2]);
    const d2 = Math.hypot(sol.effector[0] - sol.elbow[0], sol.effector[1] - sol.elbow[1], sol.effector[2] - sol.elbow[2]);
    ok(near(d1, l1, 1e-3), 'il primo osso conserva la sua lunghezza (' + d1.toFixed(4) + ')');
    ok(near(d2, l2, 1e-3), 'il secondo osso conserva la sua lunghezza (' + d2.toFixed(4) + ')');
    ok(near(sol.effector[0], 4, 1e-3) && sol.reachable, 'l\'estremita\' raggiunge il bersaglio');
    ok(sol.elbow[2] < -1e-6, 'bendHint decide da che parte piega l\'articolazione di mezzo');

    const far = api.solveTwoBoneIK(root, [50, 10, 0], l1, l2, [0, 0, -1]);
    const tot = Math.hypot(far.effector[0] - root[0], far.effector[1] - root[1], far.effector[2] - root[2]);
    ok(!far.reachable && near(tot, l1 + l2, 1e-3), 'bersaglio fuori portata: l\'arto si stende al massimo');
    ok([...far.elbow, ...far.effector].every(Number.isFinite), 'nessun NaN fuori portata');

    const zero = api.solveTwoBoneIK(root, root, l1, l2, [0, 0, -1]);
    ok([...zero.elbow, ...zero.effector].every(Number.isFinite), 'nessun NaN con bersaglio sulla radice');
}

// --- catena scelta dal nome ----------------------------------------------------
{
    const body = [];
    for (let y = 0; y <= 18; y++) for (let x = 5; x <= 10; x++) for (let z = 7; z <= 8; z++) body.push({ x, y, z, color: '#888888' });
    for (let x = 0; x <= 4; x++) for (let z = 7; z <= 8; z++) body.push({ x, y: 13, z, color: '#888888' });
    for (let x = 11; x <= 15; x++) for (let z = 7; z <= 8; z++) body.push({ x, y: 13, z, color: '#888888' });
    const skel = api.buildHumanoidSkeleton(body);
    const bones = skel.bones;
    const nameOf = i => bones[i].name;
    const hand = bones.findIndex(b => b.name === 'hand_R');
    const chain = api.ikChainForBone(bones, hand);
    ok(chain.length === 2 && nameOf(chain[0]) === 'upperArm_R' && nameOf(chain[1]) === 'forearm_R',
        'cliccando la mano si muove spalla+gomito: ' + chain.map(nameOf).join(' -> '));
    const foot = bones.findIndex(b => b.name === 'foot_L');
    const legChain = api.ikChainForBone(bones, foot);
    ok(legChain.length === 2 && nameOf(legChain[0]) === 'upperLeg_L' && nameOf(legChain[1]) === 'lowerLeg_L',
        'cliccando il piede si muove anca+ginocchio: ' + legChain.map(nameOf).join(' -> '));
    const head = bones.findIndex(b => b.name === 'head');
    const headChain = api.ikChainForBone(bones, head);
    ok(headChain.length === 2 && nameOf(headChain[1]) === 'head', 'un osso qualunque usa se stesso + il genitore');
    ok(api.ikChainForBone(bones, bones.findIndex(b => b.name === 'hips')).length === 1,
        'la radice non ha genitore: catena di un solo osso');
    ok(Math.abs(api.rigForwardZ(bones)) === 1, 'il verso "avanti" e\' dedotto dai piedi');
    const hintLeg = api.ikBendHint(bones, bones.findIndex(b => b.name === 'upperLeg_L'));
    const hintArm = api.ikBendHint(bones, bones.findIndex(b => b.name === 'upperArm_L'));
    ok(hintLeg[2] === -hintArm[2], 'ginocchio e gomito piegano in versi opposti');
}

// --- 5. libreria di pose ------------------------------------------------------
{
    const bones = mkBones();
    const saved = { upperArm_L: [0, 0.2, 0], upperArm_R: [0, -0.2, 0], coda: [1, 0, 0] };
    const res = api.poseForBones(saved, bones);
    ok(res.applied === 2 && res.missing.length === 1 && res.missing[0] === 'coda',
        'si applica solo alle ossa presenti (2 su 3) e riporta quali mancano');
    ok(res.pose.coda === undefined, 'le ossa assenti non entrano nella posa');
    ok(near(res.pose.upperArm_L[1], 0.2), 'i valori salvati arrivano intatti');

    store.clear();
    api.poseLibSave([{ name: 'Saluto', pose: { hips: [0, 0, 0] } }, { name: 'rotto' }]);
    const list = api.poseLibLoad();
    ok(list.length === 1 && list[0].name === 'Saluto', 'poseLibLoad scarta le voci senza posa');
    api.poseLibSave(Array.from({ length: 200 }, (_, i) => ({ name: 'p' + i, pose: { hips: [0, 0, 0] } })));
    ok(api.poseLibLoad().length === api.POSE_LIB_MAX, 'la libreria e\' limitata a ' + api.POSE_LIB_MAX + ' pose');
    store.set(api.POSE_LIB_KEY, '{non-json');
    ok(api.poseLibLoad().length === 0, 'localStorage corrotto non fa esplodere la UI');
}

console.log(fail ? `\nFALLITI: ${fail} (pass=${pass})` : `\nTUTTI I TEST PASSATI  (pass=${pass})`);
process.exit(fail ? 1 : 0);
