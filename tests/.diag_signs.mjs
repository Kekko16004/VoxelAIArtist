/*
 * DIAGNOSTICA: che cosa fa una rotazione locale POSITIVA su X a un arto?
 *
 * Serve a fissare la convenzione dei preset di animazione: si applica +30 gradi
 * su X (e su Z per le braccia) a un osso e si misura DOVE FINISCE la sua punta
 * in coordinate mondo, cosi' "avanti/indietro" e "verso il corpo" non sono piu'
 * una deduzione a mano ma una misura.
 *
 * Uso: node tests/.diag_signs.mjs <modello.json>
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
;return { applyRig, buildAnimationClips, rigFacingYaw,
          getSkeleton: () => skeleton, getClips: () => rigClips,
          getRig: () => rig, setRig: r => { rig = r; } };`)();

const rigData = JSON.parse(JSON.stringify(raw.rig));
api.setRig(rigData);
api.applyRig();
const skeleton = api.getSkeleton();
const byName = {};
rigData.bones.forEach((bd, i) => byName[bd.name] = skeleton.bones[i]);

console.log(`faceYaw dello scheletro = ${api.rigFacingYaw(rigData.bones)}`);

// Punta dell'osso in coordinate mondo: origine del figlio se c'e', altrimenti
// l'osso stesso spostato della sua lunghezza (i bone sono autorati sugli assi).
function tipWorld(bone, bd) {
    bone.updateMatrixWorld(true);
    const len = Math.hypot(bd.tail[0] - bd.head[0], bd.tail[1] - bd.head[1], bd.tail[2] - bd.head[2]);
    const dir = new THREE.Vector3(bd.tail[0] - bd.head[0], bd.tail[1] - bd.head[1], bd.tail[2] - bd.head[2]).normalize();
    return dir.multiplyScalar(len).applyMatrix4(bone.matrixWorld);
}

function probe(name, euler) {
    const bd = rigData.bones.find(b => b.name === name);
    const bone = byName[name];
    if (!bone || !bd) { console.log(`  ${name}: assente`); return; }
    const save = bone.quaternion.clone();
    bone.quaternion.identity();
    skeleton.bones[0].updateMatrixWorld(true);
    const rest = tipWorld(bone, bd);
    bone.quaternion.setFromEuler(new THREE.Euler(
        euler[0] * Math.PI / 180, euler[1] * Math.PI / 180, euler[2] * Math.PI / 180));
    skeleton.bones[0].updateMatrixWorld(true);
    const now = tipWorld(bone, bd);
    bone.quaternion.copy(save);
    skeleton.bones[0].updateMatrixWorld(true);
    const d = now.clone().sub(rest);
    const lbl = a => (Math.abs(a) < 0.05 ? '  ~0  ' : (a > 0 ? '+' : '') + a.toFixed(2));
    console.log(`  ${name.padEnd(12)} rot(${euler.join(',').padEnd(10)})`
        + `  dX ${lbl(d.x)}  dY ${lbl(d.y)}  dZ ${lbl(d.z)}`
        + `   -> ${Math.abs(d.z) > Math.abs(d.x) ? (d.z > 0 ? '+Z' : '-Z') : (d.x > 0 ? '+X' : '-X')}`);
}

// Dove guarda il personaggio: la punta del piede.
const ft = rigData.bones.find(b => /^foot_[LR]$/.test(b.name));
if (ft) console.log(`davanti (coda di ${ft.name} - testa): dZ=${(ft.tail[2] - ft.head[2]).toFixed(2)} dX=${(ft.tail[0] - ft.head[0]).toFixed(2)}`);
const uaR = rigData.bones.find(b => b.name === 'upperArm_R');
const uaL = rigData.bones.find(b => b.name === 'upperArm_L');
if (uaR && uaL) console.log(`upperArm_R.head.x=${uaR.head[0]}  upperArm_L.head.x=${uaL.head[0]} (destra = X maggiore)`);

console.log('\nX POSITIVA su gamba/braccio:');
probe('upperLeg_R', [30, 0, 0]);
probe('lowerLeg_R', [30, 0, 0]);
probe('upperArm_R', [30, 0, 0]);
console.log('\nX NEGATIVA:');
probe('upperLeg_R', [-30, 0, 0]);
probe('upperArm_R', [-30, 0, 0]);
console.log('\nZ delle braccia (la posa "lungo il corpo" dei preset):');
probe('upperArm_R', [0, 0, -78]);
probe('upperArm_L', [0, 0, 78]);
console.log('\nZ opposta (controprova: deve allontanarsi dal corpo):');
probe('upperArm_R', [0, 0, 78]);
console.log('\nBraccio in alto (salto/saluto):');
probe('upperArm_R', [0, 0, -160]);

// Le clip dei preset: ogni preset deve ruotare le braccia anche su Z.
api.buildAnimationClips();
console.log('\nclip costruite:');
api.getClips().forEach(c => {
    const bones = new Set(c.tracks.map(t => t.name.split('.')[0]));
    console.log(`  ${c.name.padEnd(6)} dur ${String(c.duration).padEnd(4)} tracce ${String(c.tracks.length).padEnd(3)} ossa ${bones.size}`);
});
