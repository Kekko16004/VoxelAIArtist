/*
 * DIAGNOSTICA (non e' un test): misura le FESSURE che lo skinning apre fra voxel
 * adiacenti la cui faccia condivisa e' stata eliminata dall'export.
 *
 * Per ogni coppia di voxel adiacenti si prendono i 4 spigoli della faccia in
 * comune e si skinnano DUE volte: con i pesi del voxel A e con quelli del voxel
 * B. Se i pesi differiscono i due risultati si separano: quella distanza e' la
 * larghezza della fessura nel modello posato.
 *
 * Categorie:
 *   A) osso DOMINANTE diverso  -> l'anteprima tiene la faccia, l'export la toglie
 *   B) dominante uguale, pesi diversi -> la tolgono entrambe
 *
 * Uso: node tests/.diag_cracks.mjs <modello.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VENDOR = process.env.THREE_DIR || path.join(REPO_ROOT, 'tests', '.vendor');
const MODEL = process.argv[2];

const sandbox = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(VENDOR, 'three.min.js'), 'utf8'), sandbox, { filename: 'three.min.js' });
const THREE = sandbox.THREE;
THREE.TransformControls = class extends THREE.Object3D {
    constructor() {
        super(); this.enabled = true; this.mode = 'rotate';
        ['attach', 'detach', 'setSize', 'setMode', 'setSpace', 'setTranslationSnap',
            'setRotationSnap', 'addEventListener', 'removeEventListener', 'dispose']
            .forEach(k => { this[k] = () => this; });
    }
};
global.THREE = THREE;

const raw = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
const expandSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/utils/expand-ops.js'), 'latin1');
const expandOps = new Function(expandSrc + '\n;return expandOps;')();
const model = expandOps(JSON.parse(JSON.stringify(raw)));
if (!model.metadata) model.metadata = raw.metadata || {};

const els = {};
const mkEl = (id) => (els[id] = els[id] || {
    id, textContent: '', innerHTML: '', value: '0', checked: true, disabled: false,
    style: {}, dataset: {}, title: '', children: [],
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, appendChild(c) { this.children.push(c); },
    querySelectorAll: () => [], querySelector: () => null, remove() { },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
});
mkEl('glbScaleCheckbox').checked = true;
mkEl('glbCullInternalCheckbox').checked = true;
mkEl('voxelGap').value = '0';
global.document = {
    getElementById: mkEl, createElement: () => mkEl('_t' + Math.random()),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() { },
    body: { appendChild() { } },
};
global.window = { addEventListener() { }, requestAnimationFrame: () => 0 };
global.alert = m => { throw new Error('alert: ' + m); };
global.t = k => k;
global.requestRender = () => { };
global.updateHistoryButtons = () => { };
global.pushHistory = () => { };
global.undoStack = []; global.redoStack = [];
global.buildModel = () => { };
global.currentModelData = model;
global.voxelGap = els.voxelGap;
global.visibleVoxels = model.voxels;
global.syncVisibleVoxels = () => { };
global.modelPivot = new THREE.Group();
global.scene = new THREE.Scene();
global.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
global.renderer = { domElement: mkEl('canvas') };
global.controls = { addEventListener() { }, update() { } };
global.gizmoEnabled = false; global.mixer = null;
global.gizmoBar = mkEl('gizmoBar');

const srcs = ['lib/15-rig.js', 'lib/16-export-glb.js']
    .map(rel => fs.readFileSync(path.join(REPO_ROOT, 'ui/src', rel), 'latin1'));
const api = new Function(srcs.join('\n') + `
;return { applyRig, buildFullSkinnedMesh, exportOrigin, applyPoseToBoneList,
          setRig: r => { rig = r; }, getRig: () => rig,
          getAssign: () => boneAssignments,
          getWIdx: () => boneWeightIndices, getWVal: () => boneWeightValues,
          MAXINF: MAX_BONE_INFLUENCES };`)();

const rigData = JSON.parse(JSON.stringify(raw.rig));
if (process.env.BINDING) rigData.binding = process.env.BINDING;   // 'parts' | 'rigid' | 'smooth'
api.setRig(rigData);
api.applyRig();

const voxels = model.voxels;
const assign = api.getAssign();
const wIdx = api.getWIdx(), wVal = api.getWVal();
const M = api.MAXINF;
const bones = rigData.bones;
console.log(`modello: ${voxels.length} voxel, ${bones.length} ossa, binding=${rigData.binding || '(default)'}`);

// --- mesh d'export, posata, esattamente come exportGLB() -------------------
const O = api.exportOrigin(voxels);
const K = 0.01;
const built = api.buildFullSkinnedMesh({ allFaces: false, bake: { origin: O, scale: K } });
api.applyPoseToBoneList(built.bones, K);
built.skeleton.update();
built.mesh.updateMatrixWorld(true);

// Matrici di skinning: boneMatrix_j = bone_j.matrixWorld * boneInverse_j.
const skel = built.skeleton;
const BM = skel.bones.map((b, j) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skel.boneInverses[j]));

// Verifica che la mia LBS coincida con quella di three su un vertice vero.
{
    const g = built.mesh.geometry;
    const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const i = 0;
    const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const mine = new THREE.Vector3();
    for (let s = 0; s < 4; s++) {
        const w = sw.array[i * 4 + s]; if (!w) continue;
        mine.add(p.clone().applyMatrix4(BM[si.array[i * 4 + s]]).multiplyScalar(w));
    }
    const theirs = new THREE.Vector3(); built.mesh.boneTransform(i, theirs);
    console.log(`check LBS: scarto ${mine.distanceTo(theirs).toExponential(2)} m (deve essere ~0)`);
}

function skinPoint(p, i) {
    const out = new THREE.Vector3();
    const base = i * M;
    let tot = 0;
    for (let s = 0; s < M; s++) {
        const w = wVal[base + s]; if (!(w > 0)) continue;
        const j = wIdx[base + s];
        out.add(p.clone().applyMatrix4(BM[j]).multiplyScalar(w));
        tot += w;
    }
    if (tot === 0) out.copy(p);
    return out;
}
function sameWeights(a, b) {
    const ba = a * M, bb = b * M;
    for (let s = 0; s < M; s++) {
        if (wIdx[ba + s] !== wIdx[bb + s]) return false;
        if (Math.abs(wVal[ba + s] - wVal[bb + s]) > 1e-6) return false;
    }
    return true;
}

const index = new Map();
voxels.forEach((v, i) => index.set(`${v.x},${v.y},${v.z}`, i));

const s = 0.5;
const FACES = [
    { n: [1, 0, 0], c: [[s, -s, -s], [s, s, -s], [s, s, s], [s, -s, s]] },
    { n: [-1, 0, 0], c: [[-s, -s, s], [-s, s, s], [-s, s, -s], [-s, -s, -s]] },
    { n: [0, 1, 0], c: [[-s, s, -s], [-s, s, s], [s, s, s], [s, s, -s]] },
    { n: [0, -1, 0], c: [[-s, -s, s], [-s, -s, -s], [s, -s, -s], [s, -s, s]] },
    { n: [0, 0, 1], c: [[s, -s, s], [s, s, s], [-s, s, s], [-s, -s, s]] },
    { n: [0, 0, -1], c: [[-s, -s, -s], [-s, s, -s], [s, s, -s], [s, -s, -s]] }
];

let nShared = 0, nDiffW = 0, catA = 0, catB = 0;
let maxGap = 0, maxWho = '';
const gapsA = [], gapsB = [];
const byPair = new Map();

for (let i = 0; i < voxels.length; i++) {
    const v = voxels[i];
    for (const f of FACES) {
        // ogni faccia condivisa una volta sola: solo direzioni positive
        if (f.n[0] < 0 || f.n[1] < 0 || f.n[2] < 0) continue;
        const nk = `${v.x + f.n[0]},${v.y + f.n[1]},${v.z + f.n[2]}`;
        const j = index.get(nk);
        if (j === undefined) continue;
        nShared++;
        if (sameWeights(i, j)) continue;
        nDiffW++;
        let g = 0;
        for (const off of f.c) {
            const p = new THREE.Vector3((v.x + off[0] - O.x) * K, (v.y + off[1] - O.y) * K, (v.z + off[2] - O.z) * K);
            const d = skinPoint(p, i).distanceTo(skinPoint(p, j));
            if (d > g) g = d;
        }
        const diffPrimary = assign[i] !== assign[j];
        if (diffPrimary) { catA++; gapsA.push(g); } else { catB++; gapsB.push(g); }
        if (g > maxGap) { maxGap = g; maxWho = `${bones[assign[i]].name} | ${bones[assign[j]].name} @ ${v.x},${v.y},${v.z}`; }
        if (g > 0.005) {
            const key = [bones[assign[i]].name, bones[assign[j]].name].sort().join(' | ');
            byPair.set(key, (byPair.get(key) || 0) + 1);
        }
    }
}

const pct = (arr, p) => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
const over = (arr, t) => arr.filter(x => x > t).length;

console.log(`\nfacce condivise fra voxel adiacenti: ${nShared}`);
console.log(`  con pesi DIVERSI (si aprono posando): ${nDiffW}`);
console.log(`  A) dominante diverso  -> anteprima le TIENE, export le TOGLIE : ${catA}`);
console.log(`  B) dominante uguale   -> tolte da entrambe                     : ${catB}`);
const mm = x => (x * 1000).toFixed(1) + 'mm';
const vx = x => (x / K).toFixed(2) + ' voxel';
console.log(`\nfessura massima: ${mm(maxGap)} (${vx(maxGap)})  su ${maxWho}`);
console.log(`categoria A: mediana ${mm(pct(gapsA, .5))}, p90 ${mm(pct(gapsA, .9))}, max ${mm(Math.max(0, ...gapsA))}`);
console.log(`             >1mm: ${over(gapsA, .001)}, >5mm: ${over(gapsA, .005)}, >10mm: ${over(gapsA, .01)}`);
console.log(`categoria B: mediana ${mm(pct(gapsB, .5))}, p90 ${mm(pct(gapsB, .9))}, max ${mm(Math.max(0, ...gapsB))}`);
console.log(`             >1mm: ${over(gapsB, .001)}, >5mm: ${over(gapsB, .005)}, >10mm: ${over(gapsB, .01)}`);
console.log(`\ncoppie di ossa con fessure >5mm:`);
[...byPair.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([k, n]) => console.log(`   ${n.toString().padStart(5)}  ${k}`));

// scala: quanto e' alto il personaggio, per dare un metro di paragone
let miny = 1e9, maxy = -1e9;
voxels.forEach(v => { if (v.y < miny) miny = v.y; if (v.y > maxy) maxy = v.y; });
console.log(`\nriferimento: altezza modello ${(maxy - miny + 1)} voxel = ${((maxy - miny + 1) * K).toFixed(2)} m; 1 voxel = ${mm(K)}`);

// --- la domanda che decide la forma del fix -------------------------------
// Se la regola d'export diventa quella dell'ANTEPRIMA (tieni la faccia quando
// l'osso DOMINANTE e' diverso), la categoria A e' tappata. Resta scoperta la
// categoria B: dominante uguale, pesi diversi. Quanto si apre quella?
console.log(`\nse la regola d'export = regola anteprima (dominante diverso -> tieni):`);
console.log(`  tappate  (cat A): ${catA}`);
console.log(`  SCOPERTE (cat B): ${catB}` +
    (catB ? `, max ${mm(Math.max(...gapsB))}, p99 ${mm(pct(gapsB, .99))}, >1mm ${over(gapsB, .001)}` : ''));

// --- soglia: quanto deve differire il peso perche' la fessura si veda? -----
// La fessura e' | sum_j (wA_j - wB_j) * M_j * p |, quindi cresce con la
// DIFFERENZA L1 dei due vettori di peso. Se si tappa solo sopra una soglia T
// si paga meno geometria; qui si misura quale T tappa tutte le fessure che si
// vedono davvero (>1mm = 0.1 voxel) e quanto costa.
function l1diff(a, b) {
    const acc = new Map();
    for (let s = 0; s < M; s++) {
        const ia = wIdx[a * M + s], wa = wVal[a * M + s];
        if (wa > 0) acc.set(ia, (acc.get(ia) || 0) + wa);
        const ib = wIdx[b * M + s], wb = wVal[b * M + s];
        if (wb > 0) acc.set(ib, (acc.get(ib) || 0) - wb);
    }
    let s = 0;
    acc.forEach(v => { s += Math.abs(v); });
    return s;
}

const pairs = [];
for (let i = 0; i < voxels.length; i++) {
    const v = voxels[i];
    for (const f of FACES) {
        if (f.n[0] < 0 || f.n[1] < 0 || f.n[2] < 0) continue;
        const j = index.get(`${v.x + f.n[0]},${v.y + f.n[1]},${v.z + f.n[2]}`);
        if (j === undefined || sameWeights(i, j)) continue;
        let g = 0;
        for (const off of f.c) {
            const p = new THREE.Vector3((v.x + off[0] - O.x) * K, (v.y + off[1] - O.y) * K, (v.z + off[2] - O.z) * K);
            const d = skinPoint(p, i).distanceTo(skinPoint(p, j));
            if (d > g) g = d;
        }
        pairs.push({ g, d: l1diff(i, j) });
    }
}
console.log(`\nsoglia sulla differenza L1 dei pesi (fessure visibili = >1mm):`);
console.log(`   T      facce tappate   fessure >1mm ancora scoperte   la piu' larga scoperta`);
for (const T of [0, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) {
    const kept = pairs.filter(p => p.d > T);
    const missed = pairs.filter(p => p.d <= T && p.g > 0.001);
    const worst = pairs.filter(p => p.d <= T).reduce((m, p) => Math.max(m, p.g), 0);
    console.log(`  ${String(T).padEnd(6)} ${String(kept.length).padStart(8)}` +
        `        ${String(missed.length).padStart(8)}` +
        `                 ${mm(worst).padStart(8)}`);
}
console.log(`  (totale facce condivise ${nShared}; il guscio d'export ha ~18k facce)`);
