/*
 * DIAGNOSTICA: i quad coincidenti dell'export hanno orientamento OPPOSTO?
 *
 * E' l'affermazione su cui poggia il fix: tenere le due meta' di una giunzione
 * non produce z-fighting perche' i materiali sono FrontSide e di due quad
 * coplanari con normali opposte il backface culling ne disegna esattamente uno.
 * Se anche una sola coppia avesse la STESSA normale, sarebbero due facce
 * sovrapposte visibili insieme: z-fighting, cioe' il difetto di partenza.
 *
 * Si controlla la normale GEOMETRICA (dal prodotto vettoriale dei vertici, che
 * e' cio' che il rasterizzatore usa per decidere fronte/retro), non l'attributo.
 *
 * Uso: node tests/.diag_winding.mjs <modello.json>
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
global.requestRender = () => { }; global.updateHistoryButtons = () => { };
global.pushHistory = () => { }; global.undoStack = []; global.redoStack = [];
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
          setRig: r => { rig = r; } };`)();

const rigData = JSON.parse(JSON.stringify(raw.rig));
if (process.env.BINDING) rigData.binding = process.env.BINDING;
api.setRig(rigData);
api.applyRig();

const O = api.exportOrigin(model.voxels);
const K = 0.01;
const built = api.buildFullSkinnedMesh({ allFaces: false, bake: { origin: O, scale: K } });
const g = built.mesh.geometry;
const P = g.attributes.position.array;
const I = g.index.array;

// Raggruppa i triangoli in quad (2 triangoli consecutivi, come li emette il
// costruttore) e calcola normale geometrica + chiave dei 4 vertici.
const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nn = new THREE.Vector3();
const map = new Map();
let quads = 0;
for (let k = 0; k + 5 < I.length; k += 6) {
    const idx = [I[k], I[k + 1], I[k + 2], I[k + 5]];
    const key = idx.map(i => `${P[i * 3].toFixed(5)},${P[i * 3 + 1].toFixed(5)},${P[i * 3 + 2].toFixed(5)}`)
        .slice().sort().join('|');
    va.set(P[I[k] * 3], P[I[k] * 3 + 1], P[I[k] * 3 + 2]);
    vb.set(P[I[k + 1] * 3], P[I[k + 1] * 3 + 1], P[I[k + 1] * 3 + 2]);
    vc.set(P[I[k + 2] * 3], P[I[k + 2] * 3 + 1], P[I[k + 2] * 3 + 2]);
    ab.subVectors(vb, va); ac.subVectors(vc, va);
    nn.crossVectors(ab, ac).normalize();
    quads++;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(nn.clone());
}

let dupPairs = 0, opposite = 0, same = 0, worst = -1;
map.forEach(list => {
    if (list.length < 2) return;
    for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
            dupPairs++;
            const d = list[a].dot(list[b]);
            if (d < -0.99) opposite++;
            else { same++; if (d > worst) worst = d; }
        }
});

console.log(`binding=${rigData.binding}`);
console.log(`quad totali nell'export: ${quads}`);
console.log(`coppie di quad COINCIDENTI: ${dupPairs}`);
console.log(`  con normali OPPOSTE (FrontSide ne disegna 1 -> ok) : ${opposite}`);
console.log(`  con normali UGUALI   (z-fighting!)                 : ${same}`
    + (same ? `  (dot massimo ${worst.toFixed(4)})` : ''));
console.log(same === 0
    ? '\nOK: ogni giunzione e\' una coppia fronte/retro, il backface culling la risolve.'
    : '\nATTENZIONE: ci sono facce sovrapposte con lo stesso verso.');
