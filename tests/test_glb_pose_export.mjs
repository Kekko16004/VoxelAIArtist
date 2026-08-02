/*
 * L'export GLB deve consegnare il modello NELLA POSA DELL'EDITOR.
 *
 * Il bug che questo test blocca: un personaggio in piedi con le braccia lungo i
 * fianchi usciva in T-pose. Tre cause distinte, tutte verificate qui:
 *
 *   1. l'export azzerava `rig.pose` / `rig.posePos` "per stare a riposo", cioe'
 *      buttava via la posa dell'utente (upperArm_R a -64 gradi);
 *   2. le tracce `.position` delle clip sono POSIZIONI ASSOLUTE in unita' voxel:
 *      riusate su ossa cotte (radici traslate sull'origine, tutto scalato di K)
 *      riportavano l'osso radice alla sua coordinata voxel, +0.62 m su X;
 *   3. all'import Blender assegna d'ufficio la PRIMA action del file, e le sue
 *      tracce coprono la posa sui nodi: serve che la posa sia la prima clip.
 *
 * La mesh resta legata a riposo (le inverse bind matrices si calcolano li'), la
 * posa vive sui nodi: cuocerla nei vertici la applicherebbe due volte.
 *
 * Come test_rig_weights.mjs: i moduli sono frammenti di UNO scope condiviso,
 * caricati con new Function su stub minimi di THREE/DOM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const mkEl = () => ({
    textContent: '', innerHTML: '', value: '0', checked: false, disabled: false,
    style: {}, dataset: {}, title: '', children: [],
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, appendChild(c) { this.children.push(c); },
    querySelectorAll: () => [], querySelector: () => null, remove() { },
});
global.document = { getElementById: () => mkEl(), createElement: mkEl, addEventListener() { } };
global.window = { addEventListener() { } };
global.alert = () => { };
global.prompt = () => null;
global.confirm = () => false;
const store = new Map();
global.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); },
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
global.t = (k) => k;

class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
}
class Quat {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    invert() { return this; } multiply() { return this; }
    setFromEuler(e) {
        const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
        const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
        this.x = s1 * c2 * c3 + c1 * s2 * s3; this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3; this.w = c1 * c2 * c3 - s1 * s2 * s3;
        return this;
    }
}
class Euler {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setFromQuaternion() { return this; }
}
// Un osso vero deve tenere rotation e quaternion allineati: buildPoseClip legge
// bone.quaternion, applyPoseToBoneList scrive bone.rotation. Se lo stub li
// tenesse separati il test passerebbe anche con l'export rotto.
class Bone {
    constructor() {
        this.name = ''; this.position = new V3(); this.scale = new V3(1, 1, 1);
        this.userData = {}; this.children = []; this.parent = null;
        this._q = new Quat();
        const self = this;
        this.rotation = {
            _x: 0, _y: 0, _z: 0,
            set x(v) { this._x = v; self._sync(); }, get x() { return this._x; },
            set y(v) { this._y = v; self._sync(); }, get y() { return this._y; },
            set z(v) { this._z = v; self._sync(); }, get z() { return this._z; },
            set(x, y, z) { this._x = x; this._y = y; this._z = z; self._sync(); return this; },
        };
    }
    _sync() { this._q.setFromEuler(new Euler(this.rotation.x, this.rotation.y, this.rotation.z)); }
    get quaternion() { return this._q; }
    add(o) { this.children.push(o); o.parent = this; }
    updateMatrix() { } updateMatrixWorld() { }
}

const tracksMade = [];
global.THREE = {
    Group: class { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.visible = true; } add(o) { this.children.push(o); } remove() { } },
    Object3D: class { constructor() { this.position = new V3(); this.rotation = new V3(); this.quaternion = new Quat(); this.scale = new V3(1, 1, 1); this.userData = {}; } add() { } updateMatrix() { } },
    Bone,
    Vector3: V3, Quaternion: Quat, Euler,
    TransformControls: class {
        constructor() {
            return new Proxy({ visible: false, enabled: true, object: null, mode: 'rotate' }, {
                get(t, k) { return (k in t) ? t[k] : () => { }; }, set(t, k, v) { t[k] = v; return true; },
            });
        }
    },
    Color: class { constructor() { this.r = 0; this.g = 0; this.b = 0; } setHSL() { return this; } },
    MathUtils: { degToRad: d => d * Math.PI / 180, radToDeg: r => r * 180 / Math.PI },
    QuaternionKeyframeTrack: class { constructor(name, times, values) { this.name = name; this.times = times; this.values = values; tracksMade.push(this); } },
    VectorKeyframeTrack: class { constructor(name, times, values) { this.name = name; this.times = times; this.values = values; tracksMade.push(this); } },
    AnimationClip: class { constructor(name, duration, tracks) { this.name = name; this.duration = duration; this.tracks = tracks; } },
};
global.scene = { add() { }, remove() { } };

const src = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/15-rig.js'), 'latin1');
const api = new Function(src + `
 ;return { buildPoseClip, scaleClipsForExport, applyPoseToBoneList,
           setRig:(r)=>{rig=r;}, getRig:()=>rig,
           setSkeleton:(s)=>{skeleton=s;} };`)();

// --- scenario: due ossa, posa reale presa dal file dell'utente ------------
// hips a (63,40,31) in unita' voxel, upperArm_R suo figlio. La posa e' quella
// che falliva: braccio ruotato di -64.3 gradi su Z.
const RIG = {
    type: 'humanoid',
    bones: [
        { name: 'hips', parent: -1, head: [63, 40, 31], tail: [63, 44, 31] },
        { name: 'upperArm_R', parent: 0, head: [74, 64, 31], tail: [74, 51, 31] },
    ],
    pose: { hips: [0, -0.0838, 0], upperArm_R: [0.3718, 0, -1.1223] },
    posePos: { hips: [0, -0.074, 0] },
};
api.setRig(RIG);

const K = 0.01;
// Ossa "a schermo": riposo in coordinate voxel assolute.
const screenBones = RIG.bones.map((bd, i) => {
    const b = new Bone(); b.name = bd.name;
    const ph = bd.parent >= 0 ? RIG.bones[bd.parent].head : [0, 0, 0];
    b.position.set(bd.head[0] - ph[0], bd.head[1] - ph[1], bd.head[2] - ph[2]);
    b.userData.restPos = b.position.clone();
    return b;
});
// Ossa "cotte" per l'export: origine tolta alle radici, tutto scalato di K.
const O = { x: 63, y: 0, z: 31 };
const bakedBones = RIG.bones.map((bd, i) => {
    const b = new Bone(); b.name = bd.name;
    const ph = bd.parent >= 0 ? RIG.bones[bd.parent].head : [O.x, O.y, O.z];
    b.position.set((bd.head[0] - ph[0]) * K, (bd.head[1] - ph[1]) * K, (bd.head[2] - ph[2]) * K);
    b.userData.restPos = b.position.clone();
    return b;
});
api.setSkeleton({ bones: screenBones, update() { } });

console.log('== la posa arriva sulle ossa d\'export ==');
api.applyPoseToBoneList(bakedBones, K);
const armB = bakedBones[1], hipsB = bakedBones[0];
ok(near(armB.rotation.z, -1.1223), 'upperArm_R conserva la rotazione Z (-1.1223 rad = -64.3 gradi)');
ok(near(armB.rotation.x, 0.3718), 'upperArm_R conserva la rotazione X');
ok(!near(armB.rotation.z, 0), 'la posa NON e\' azzerata: era il bug della T-pose');
// posePos e' in unita' voxel: sulle ossa cotte va scalato, altrimenti -0.074
// voxel diventano -0.074 metri, cioe' 7 cm su un modello alto uno.
ok(near(hipsB.position.y, hipsB.userData.restPos.y + (-0.074 * K)),
    'la traslazione di posa e\' riscalata di K (' + hipsB.position.y.toFixed(6) + ')');
// A schermo K=1: la stessa posa non deve essere rimpicciolita nell'editor.
api.applyPoseToBoneList(screenBones, 1);
ok(near(screenBones[0].position.y, screenBones[0].userData.restPos.y - 0.074),
    'a schermo la traslazione resta in unita\' voxel');

console.log('== le clip vengono ribasate, non solo scalate ==');
// Traccia di posizione com'e' costruita davvero: riposo a schermo + delta.
const hipsRest = screenBones[0].userData.restPos;
const clip = {
    name: 'walk', duration: 1,
    tracks: [
        { name: 'hips.position', times: [0, 0.5], values: [hipsRest.x, hipsRest.y, hipsRest.z, hipsRest.x, hipsRest.y + 0.5, hipsRest.z] },
        { name: 'hips.quaternion', times: [0], values: [0, 0, 0, 1] },
    ],
};
const out = api.scaleClipsForExport([clip], K, bakedBones);
const pos = out[0].tracks.find(t => /\.position$/.test(t.name));
const bakedRest = bakedBones[0].userData.restPos;
ok(near(pos.values[0], bakedRest.x, 1e-6),
    'il primo keyframe torna sul riposo COTTO su X (' + pos.values[0].toFixed(6) + ', non ' + (hipsRest.x * K).toFixed(6) + ')');
ok(!near(pos.values[0], hipsRest.x * K, 1e-6),
    'non e\' piu\' il vecchio "moltiplica e basta": quello spostava il modello di 0.63 m');
ok(near(pos.values[4], bakedRest.y + 0.5 * K, 1e-6), 'il delta di 0.5 voxel resta 0.5 voxel scalati, non 0.5 m');
ok(out[0].tracks.some(t => /\.quaternion$/.test(t.name)), 'le tracce di rotazione sopravvivono intatte');
// Senza le ossa d'export non si sa ribasare: deve degradare, non esplodere.
const degraded = api.scaleClipsForExport([clip], K, null);
ok(degraded && degraded[0] && degraded[0].tracks.length === 2, 'senza ossa d\'export degrada a sola scalatura');

console.log('== la posa esce come clip (Blender applica la prima action) ==');
api.applyPoseToBoneList(bakedBones, K);
const pc = api.buildPoseClip(bakedBones, 'Posa');
ok(!!pc, 'la clip di posa viene creata');
ok(pc.duration > 0, 'ha durata > 0 (una clip di durata zero viene scartata)');
const armQ = pc.tracks.find(t => t.name === 'upperArm_R.quaternion');
ok(!!armQ, 'contiene la rotazione di upperArm_R');
const q = new Quat().setFromEuler(new Euler(0.3718, 0, -1.1223));
ok(near(armQ.values[0], q.x, 1e-6) && near(armQ.values[3], q.w, 1e-6),
    'il quaternione della clip e\' quello della posa dell\'editor');
ok(near(armQ.values[0], armQ.values[4], 1e-9) && near(armQ.values[3], armQ.values[7], 1e-9),
    'i due keyframe sono identici: la posa resta ferma a qualunque frame');
ok(pc.tracks.filter(t => /\.position$/.test(t.name)).length === bakedBones.length,
    'ogni osso ha anche la sua traccia di posizione');
ok(!api.buildPoseClip([], 'Posa') && !api.buildPoseClip(null, 'Posa'),
    'senza ossa non produce una clip vuota');

console.log('== l\'editor non viene toccato dall\'export ==');
ok(Object.keys(api.getRig().pose).length === 2 && near(api.getRig().pose.upperArm_R[2], -1.1223),
    'rig.pose e\' ancora quella dell\'utente dopo aver costruito tutto per l\'export');
ok(Object.keys(api.getRig().posePos).length === 1, 'rig.posePos intatta');

console.log(`\n${pass} controlli OK, ${fail} falliti`);
process.exit(fail ? 1 : 0);
