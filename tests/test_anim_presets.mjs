/*
 * Verifica i PRESET DI ANIMAZIONE di ui/src/lib/15-rig.js (idle/walk/run/jump/wave).
 *
 * Il difetto che questo test blocca: LE BRACCIA IN T-POSE. A riposo il braccio
 * e' allineato all'asse X, quindi una rotazione locale attorno a X non lo muove
 * di un millimetro (misurabile: rot(30,0,0) sposta la punta di (0,0,0)). Le clip
 * vecchie ruotavano le braccia SOLO su X: compilavano, giravano, e lasciavano il
 * personaggio con le braccia aperte a croce in ogni animazione. Serve la Z.
 * L'asserzione centrale non guarda i numeri delle chiavi ma DOVE FINISCE LA
 * PUNTA DEL BRACCIO: e' l'unica formulazione che non si possa soddisfare per
 * sbaglio scrivendo una rotazione qualsiasi.
 *
 * Il secondo invariante e' la camminata di riferimento: su uno scheletro con
 * faceYaw 180 il preset `walk` deve ricostruire esattamente la clip validata a
 * mano ("NaturalWalk", fixture qui sotto). Il vecchio `legSign` aveva il segno
 * opposto e produceva la camminata specchiata, con le gambe che spingevano
 * all'indietro.
 *
 * La matematica dei quaternioni e' implementata qui (vera, ~50 righe): un mock
 * inerte renderebbe l'asserzione geometrica priva di significato, e la three.js
 * scaricata a mano vive in tests/.vendor/, che e' gitignorata e quindi non puo'
 * essere una dipendenza della suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// ---------------------------------------------------------------- THREE minimo
class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    length() { return Math.hypot(this.x, this.y, this.z); }
    normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
    applyQuaternion(q) {
        const { x, y, z } = this, { x: qx, y: qy, z: qz, w: qw } = q;
        const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z;
        const iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
        this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
        this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
        this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
        return this;
    }
}
class Euler { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
class Quat {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    clone() { return new Quat(this.x, this.y, this.z, this.w); }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    identity() { this.x = this.y = this.z = 0; this.w = 1; return this; }
    invert() { this.x *= -1; this.y *= -1; this.z *= -1; return this; }
    setFromAxisAngle(axis, angle) {
        const h = angle / 2, s = Math.sin(h);
        this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(h);
        return this;
    }
    // ordine XYZ, come THREE.Quaternion.setFromEuler di default
    setFromEuler(e) {
        const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
        const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        return this;
    }
    multiply(q) {
        const { x: ax, y: ay, z: az, w: aw } = this, { x: bx, y: by, z: bz, w: bw } = q;
        this.x = ax * bw + aw * bx + ay * bz - az * by;
        this.y = ay * bw + aw * by + az * bx - ax * bz;
        this.z = az * bw + aw * bz + ax * by - ay * bx;
        this.w = aw * bw - ax * bx - ay * by - az * bz;
        return this;
    }
}
class Track {
    constructor(name, times, values) { this.name = name; this.times = times; this.values = values; }
}
global.THREE = {
    Vector3: V3, Euler, Quaternion: Quat,
    QuaternionKeyframeTrack: class extends Track { },
    VectorKeyframeTrack: class extends Track { },
    AnimationClip: class {
        constructor(name, duration, tracks) { this.name = name; this.duration = duration; this.tracks = tracks; }
    },
    Group: class { constructor() { this.children = []; this.position = new V3(); } add() { } remove() { } },
    Object3D: class { constructor() { this.position = new V3(); this.quaternion = new Quat(); this.userData = {}; } add() { } },
    Bone: class { constructor() { this.position = new V3(); this.quaternion = new Quat(); this.children = []; } add(b) { this.children.push(b); } },
    Color: class { constructor(c) { this.c = c; } set() { return this; } },
    Matrix4: class { constructor() { this.elements = new Array(16).fill(0); } },
    Mesh: class { constructor() { this.position = new V3(); this.userData = {}; } },
    SkinnedMesh: class { constructor() { this.position = new V3(); this.userData = {}; } },
    Skeleton: class { constructor(bones) { this.bones = bones || []; } },
    AnimationMixer: class { constructor() { } clipAction() { return { reset() { return this; }, play() { return this; }, stop() { } }; } },
    BufferGeometry: class { setAttribute() { } setIndex() { } dispose() { } computeVertexNormals() { } },
    BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    Float32BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    Uint16BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    MeshStandardMaterial: class { constructor(o) { Object.assign(this, o || {}); this.userData = {}; } dispose() { } },
    MeshBasicMaterial: class { constructor(o) { Object.assign(this, o || {}); this.userData = {}; } dispose() { } },
    LineBasicMaterial: class { constructor(o) { Object.assign(this, o || {}); } dispose() { } },
    Line: class { constructor() { this.position = new V3(); } },
    LineSegments: class { constructor() { this.position = new V3(); } },
    SphereGeometry: class { dispose() { } },
    BoxGeometry: class { dispose() { } },
    CylinderGeometry: class { dispose() { } },
    PlaneGeometry: class { dispose() { } },
    DoubleSide: 2, FrontSide: 0,
    TransformControls: class {
        constructor() {
            return new Proxy({ visible: false, enabled: true, object: null, mode: 'rotate' }, {
                get(t, k) { return (k in t) ? t[k] : () => { }; },
                set(t, k, v) { t[k] = v; return true; },
            });
        }
    },
};

// -------------------------------------------------------------- DOM permissivo
const mkEl = () => ({
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false, selected: false,
    style: {}, dataset: {}, title: '', children: [], options: [], length: 0,
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, removeEventListener() { }, appendChild(c) { this.children.push(c); },
    insertBefore(c) { this.children.push(c); }, removeChild() { }, remove() { },
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    setAttribute() { }, getAttribute: () => null, focus() { }, blur() { }, click() { },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    add() { },
});
global.document = {
    getElementById: () => mkEl(), createElement: () => mkEl(), createTextNode: () => mkEl(),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() { },
    body: mkEl(), documentElement: mkEl(),
};
global.window = { addEventListener() { }, requestAnimationFrame: () => 0, __API_BASE__: '' };
global.alert = () => { }; global.prompt = () => null; global.confirm = () => false;
global.fetch = () => Promise.reject(new Error('nessuna rete nei test'));
global.t = k => k;
global.requestRender = () => { }; global.updateHistoryButtons = () => { }; global.pushHistory = () => { };
global.undoStack = []; global.redoStack = []; global.buildModel = () => { };
global.currentModelData = { metadata: {}, voxels: [] };
global.visibleVoxels = []; global.syncVisibleVoxels = () => { };
global.voxelGap = { value: '0' };
global.modelPivot = new THREE.Group(); global.scene = new THREE.Group();
global.camera = { position: new V3(0, 0, 10), fov: 45, getWorldDirection: v => v };
global.renderer = { domElement: mkEl() };
global.controls = { addEventListener() { }, update() { } };
global.gizmoEnabled = false; global.mixer = null;
global.setActiveColor = () => { }; global.disposeMesh = () => { };
global.getVoxelGeometry = () => new THREE.BoxGeometry();
global.saveProjectSilently = () => { }; global.markDirty = () => { };

const src = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/15-rig.js'), 'latin1');
const api = new Function(src + `
;return { buildAnimationClips, buildClipFromAnimData, rigFacingYaw, faceRotate,
          getClips: () => rigClips,
          setRig: r => { rig = r; }, setSkeleton: s => { skeleton = s; } };`)();

// ------------------------------------------------------- scheletro di prova
// Umanoide autorato sugli assi: _R a X maggiore. `frontZ` decide dove guarda
// (la coda del piede), cioe' il faceYaw: -1 -> guarda -Z (faceYaw 180).
function humanoid(frontZ) {
    const B = (name, parent, head, tail) => ({ name, parent, head, tail });
    const defs = [
        B('hips', -1, [10, 20, 10], [10, 24, 10]),
        B('spine', 0, [10, 24, 10], [10, 28, 10]),
        B('chest', 1, [10, 28, 10], [10, 33, 10]),
        B('neck', 2, [10, 33, 10], [10, 35, 10]),
        B('head', 3, [10, 35, 10], [10, 40, 10]),
        B('shoulder_R', 2, [11, 32, 10], [14, 32, 10]),
        B('upperArm_R', 5, [14, 32, 10], [18, 32, 10]),
        B('forearm_R', 6, [18, 32, 10], [22, 32, 10]),
        B('hand_R', 7, [22, 32, 10], [24, 32, 10]),
        B('shoulder_L', 2, [9, 32, 10], [6, 32, 10]),
        B('upperArm_L', 9, [6, 32, 10], [2, 32, 10]),
        B('forearm_L', 10, [2, 32, 10], [-2, 32, 10]),
        B('hand_L', 11, [-2, 32, 10], [-4, 32, 10]),
        B('upperLeg_R', 0, [13, 20, 10], [13, 11, 10]),
        B('lowerLeg_R', 13, [13, 11, 10], [13, 2, 10]),
        B('foot_R', 14, [13, 2, 10], [13, 2, 10 + 4 * frontZ]),
        B('upperLeg_L', 0, [7, 20, 10], [7, 11, 10]),
        B('lowerLeg_L', 16, [7, 11, 10], [7, 2, 10]),
        B('foot_L', 17, [7, 2, 10], [7, 2, 10 + 4 * frontZ]),
    ];
    return { bones: defs, binding: 'parts', pose: {}, posePos: {}, customAnims: [] };
}

// skeleton.bones deve essere allineato per INDICE a rig.bones (lo assume
// buildClipFromAnimData). Le ossa sono figlie del genitore, con position
// locale = differenza fra le teste: identita' come quaternione a riposo.
function skeletonFor(rigData) {
    const bones = rigData.bones.map(bd => {
        const b = new THREE.Bone();
        b.name = bd.name;
        b.userData = { restPos: bd.head.slice() };
        return b;
    });
    rigData.bones.forEach((bd, i) => {
        const p = bd.parent >= 0 ? rigData.bones[bd.parent] : null;
        const h = p ? p.head : [0, 0, 0];
        bones[i].position.set(bd.head[0] - h[0], bd.head[1] - h[1], bd.head[2] - h[2]);
        bones[i].parentIndex = bd.parent;
        if (bd.parent >= 0) bones[bd.parent].add(bones[i]);
    });
    return { bones };
}

// Punta dell'osso in coordinate MONDO applicando le rotazioni della catena.
function tipWorld(rigData, quatByName, name) {
    const idx = rigData.bones.findIndex(b => b.name === name);
    const bd = rigData.bones[idx];
    // rotazione accumulata dai genitori + posizione della testa
    const chain = [];
    for (let i = idx; i >= 0; i = rigData.bones[i].parent) chain.unshift(i);
    let q = new Quat(), pos = new V3(0, 0, 0);
    chain.forEach(i => {
        const b = rigData.bones[i];
        const p = b.parent >= 0 ? rigData.bones[b.parent] : null;
        const local = new V3(b.head[0] - (p ? p.head[0] : 0), b.head[1] - (p ? p.head[1] : 0),
            b.head[2] - (p ? p.head[2] : 0));
        pos.add(local.applyQuaternion(q));
        const lq = quatByName[b.name];
        if (lq) q = q.clone().multiply(lq);
    });
    const dir = new V3(bd.tail[0] - bd.head[0], bd.tail[1] - bd.head[1], bd.tail[2] - bd.head[2]);
    return pos.add(dir.applyQuaternion(q));
}

// Estrae da una clip le rotazioni per osso al tempo t (chiave esatta).
function quatsAt(clip, tt) {
    const out = {};
    clip.tracks.forEach(tr => {
        if (!(tr instanceof THREE.QuaternionKeyframeTrack)) return;
        const name = tr.name.split('.')[0];
        const k = tr.times.findIndex(x => Math.abs(x - tt) < 1e-9);
        if (k < 0) return;
        out[name] = new Quat(tr.values[k * 4], tr.values[k * 4 + 1], tr.values[k * 4 + 2], tr.values[k * 4 + 3]);
    });
    return out;
}

const PRESETS = ['idle', 'walk', 'run', 'jump', 'wave'];
console.log('\n--- scheletro rivolto a -Z (faceYaw 180, il frame della clip di riferimento) ---');
const rig180 = humanoid(-1);
api.setRig(rig180);
api.setSkeleton(skeletonFor(rig180));
ok(api.rigFacingYaw(rig180.bones) === 180, 'rigFacingYaw legge 180 dai piedi');
api.buildAnimationClips();
const clips = api.getClips();
ok(PRESETS.every(n => clips.some(c => c.name === n)),
    'i cinque preset esistono: ' + clips.map(c => c.name).join(' '));

// === L'ASSERZIONE CENTRALE: nessun preset lascia le braccia in T-pose. =====
// A riposo la punta di upperArm_R sta a X massima. Se la clip la muove di meno
// del 40% della lunghezza del braccio, il braccio e' ancora aperto a croce.
const armLen = 4;
for (const name of PRESETS) {
    const clip = clips.find(c => c.name === name);
    const times = [...new Set(clip.tracks.flatMap(t => t.times))].sort((a, b) => a - b);
    let worstR = Infinity, worstL = Infinity;
    for (const tt of times) {
        const q = quatsAt(clip, tt);
        if (!q.upperArm_R || !q.upperArm_L) continue;
        const restR = tipWorld(rig180, {}, 'upperArm_R');
        const restL = tipWorld(rig180, {}, 'upperArm_L');
        worstR = Math.min(worstR, tipWorld(rig180, q, 'upperArm_R').sub(restR).length());
        worstL = Math.min(worstL, tipWorld(rig180, q, 'upperArm_L').sub(restL).length());
    }
    ok(worstR > armLen * 0.4 && worstL > armLen * 0.4,
        `${name}: braccia FUORI dalla T-pose a ogni chiave `
        + `(spostamento minimo dx ${worstR.toFixed(2)} sx ${worstL.toFixed(2)} su ${armLen} di braccio)`);
}

// Le braccia scendono: la punta va piu' in basso della spalla, non di lato.
{
    const clip = clips.find(c => c.name === 'idle');
    const q = quatsAt(clip, 0);
    const tip = tipWorld(rig180, q, 'upperArm_R');
    const rest = tipWorld(rig180, {}, 'upperArm_R');
    ok(tip.y < rest.y - 2, `idle: il braccio destro pende in basso (dY ${(tip.y - rest.y).toFixed(2)})`);
    ok(tip.x < rest.x - 2, `idle: e rientra verso il corpo (dX ${(tip.x - rest.x).toFixed(2)})`);
}

// === La camminata di riferimento, chiave per chiave. ======================
// Fixture: la clip "NaturalWalk" validata a mano. Su faceYaw 180 il preset
// `walk` deve ricostruirla identica.
const NATURAL_WALK = {
    hips: [[0, [0, 5, 2]], [0.25, [0, 0, 0]], [0.5, [0, -5, -2]], [0.75, [0, 0, 0]], [1, [0, 5, 2]]],
    spine: [[0, [2, -4, 0]], [0.25, [2, 0, 0]], [0.5, [2, 4, 0]], [0.75, [2, 0, 0]], [1, [2, -4, 0]]],
    chest: [[0, [0, -3, -1]], [0.25, [0, 0, 0]], [0.5, [0, 3, 1]], [0.75, [0, 0, 0]], [1, [0, -3, -1]]],
    head: [[0, [-2, 0, 0]], [0.25, [1, 0, 0]], [0.5, [-2, 0, 0]], [0.75, [1, 0, 0]], [1, [-2, 0, 0]]],
    upperLeg_R: [[0, [30, 0, 0]], [0.25, [0, 0, 0]], [0.5, [-30, 0, 0]], [0.75, [10, 0, 0]], [1, [30, 0, 0]]],
    lowerLeg_R: [[0, [-5, 0, 0]], [0.25, [-15, 0, 0]], [0.5, [-10, 0, 0]], [0.75, [-60, 0, 0]], [1, [-5, 0, 0]]],
    foot_R: [[0, [-15, 0, 0]], [0.25, [0, 0, 0]], [0.5, [25, 0, 0]], [0.75, [-5, 0, 0]], [1, [-15, 0, 0]]],
    upperLeg_L: [[0, [-30, 0, 0]], [0.25, [10, 0, 0]], [0.5, [30, 0, 0]], [0.75, [0, 0, 0]], [1, [-30, 0, 0]]],
    lowerLeg_L: [[0, [-10, 0, 0]], [0.25, [-60, 0, 0]], [0.5, [-5, 0, 0]], [0.75, [-15, 0, 0]], [1, [-10, 0, 0]]],
    foot_L: [[0, [25, 0, 0]], [0.25, [-5, 0, 0]], [0.5, [-15, 0, 0]], [0.75, [0, 0, 0]], [1, [25, 0, 0]]],
    upperArm_R: [[0, [-30, 0, -78]], [0.25, [0, 0, -78]], [0.5, [30, 0, -78]], [0.75, [0, 0, -78]], [1, [-30, 0, -78]]],
    forearm_R: [[0, [15, 0, 0]], [0.25, [25, 0, 0]], [0.5, [45, 0, 0]], [0.75, [25, 0, 0]], [1, [15, 0, 0]]],
    upperArm_L: [[0, [30, 0, 78]], [0.25, [0, 0, 78]], [0.5, [-30, 0, 78]], [0.75, [0, 0, 78]], [1, [30, 0, 78]]],
    forearm_L: [[0, [45, 0, 0]], [0.25, [25, 0, 0]], [0.5, [15, 0, 0]], [0.75, [25, 0, 0]], [1, [45, 0, 0]]],
};
{
    const walk = clips.find(c => c.name === 'walk');
    ok(walk.duration === 1, 'walk: durata 1 s come la clip di riferimento');
    let diff = 0, worst = '', worstD = 0, checked = 0;
    for (const [bone, keys] of Object.entries(NATURAL_WALK)) {
        for (const [tt, deg] of keys) {
            const q = quatsAt(walk, tt)[bone];
            if (!q) { diff++; worst = `${bone}@${tt} traccia assente`; continue; }
            const want = new Quat().setFromEuler(new Euler(
                deg[0] * Math.PI / 180, deg[1] * Math.PI / 180, deg[2] * Math.PI / 180));
            const d = Math.max(Math.abs(q.x - want.x), Math.abs(q.y - want.y),
                Math.abs(q.z - want.z), Math.abs(q.w - want.w));
            checked++;
            if (d > 1e-9) { diff++; if (d > worstD) { worstD = d; worst = `${bone}@${tt} scarto ${d.toFixed(6)}`; } }
        }
    }
    ok(diff === 0, `walk ricostruisce NaturalWalk: ${checked} chiavi confrontate`
        + (diff ? ` -- ${diff} DIVERSE, peggiore ${worst}` : ', tutte identiche'));
}

// Contro-oscillazione braccia/gambe: e' cio' che rende una camminata leggibile.
{
    const walk = clips.find(c => c.name === 'walk');
    const q = quatsAt(walk, 0);
    const legZ = tipWorld(rig180, q, 'upperLeg_R').z - tipWorld(rig180, {}, 'upperLeg_R').z;
    const armZ = tipWorld(rig180, q, 'upperArm_R').z - tipWorld(rig180, { upperArm_R: q.upperArm_R.clone().identity ? q.upperArm_R : q.upperArm_R }, 'upperArm_R').z;
    // il braccio va confrontato con la posa "lungo il corpo" (solo Z), non col riposo
    const down = new Quat().setFromEuler(new Euler(0, 0, -78 * Math.PI / 180));
    const armSwing = tipWorld(rig180, q, 'upperArm_R').z - tipWorld(rig180, { upperArm_R: down }, 'upperArm_R').z;
    ok(legZ * armSwing < 0,
        `walk: braccio e gamba dello stesso lato contro-oscillano (gamba dZ ${legZ.toFixed(2)}, braccio dZ ${armSwing.toFixed(2)})`);
    void armZ;
}

// Corsa e salto: quello che li distingue da una camminata.
{
    const run = clips.find(c => c.name === 'run');
    const walk = clips.find(c => c.name === 'walk');
    ok(run.duration < walk.duration, `run: ciclo piu' corto della walk (${run.duration}s < ${walk.duration}s)`);
    const swing = (clip, tt) => {
        const q = quatsAt(clip, tt);
        return tipWorld(rig180, q, 'upperLeg_R').z - tipWorld(rig180, {}, 'upperLeg_R').z;
    };
    const ampl = clip => Math.max(...[...new Set(clip.tracks.flatMap(t => t.times))].map(tt => Math.abs(swing(clip, tt))));
    ok(ampl(run) > ampl(walk), `run: falcata piu' ampia (${ampl(run).toFixed(2)} > ${ampl(walk).toFixed(2)})`);

    const jump = clips.find(c => c.name === 'jump');
    const hipsPos = jump.tracks.find(tr => tr.name === 'hips.position');
    ok(!!hipsPos, 'jump: il bacino ha una traccia di posizione (il corpo si stacca)');
    const ys = [];
    for (let i = 0; i < hipsPos.times.length; i++) ys.push(hipsPos.values[i * 3 + 1]);
    ok(Math.max(...ys) - Math.min(...ys) > 2,
        `jump: escursione verticale del bacino ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} voxel`);
    ok(ys[0] === ys[ys.length - 1], 'jump: parte e finisce alla stessa altezza (non deriva)');
}

// Il saluto muove il braccio destro e tiene il SINISTRO lungo il corpo: prima
// il sinistro non era animato affatto e restava in T-pose.
{
    const wave = clips.find(c => c.name === 'wave');
    const names = new Set(wave.tracks.map(t => t.name.split('.')[0]));
    ok(names.has('upperArm_L'), 'wave: anche il braccio SINISTRO e\' animato');
    const shoulderY = 32;
    const q = quatsAt(wave, 0.4);
    const tipR = tipWorld(rig180, q, 'upperArm_R');
    ok(tipR.y > shoulderY, `wave: la mano destra sale sopra la spalla (y ${tipR.y.toFixed(1)} > ${shoulderY})`);
    // Il sinistro va controllato sulle SUE chiavi: quatsAt legge solo i tempi
    // esatti, e a 0.4 il braccio sinistro non ne ha (resterebbe a riposo, cioe'
    // in T-pose, e l'asserzione misurerebbe il test invece del codice).
    const trL = wave.tracks.find(tr => tr.name === 'upperArm_L.quaternion');
    const worstL = Math.max(...trL.times.map(tt => tipWorld(rig180, quatsAt(wave, tt), 'upperArm_L').y));
    ok(worstL < shoulderY - 2,
        `wave: il braccio sinistro resta giu' per tutta la clip (y max ${worstL.toFixed(1)} su ${trL.times.length} chiavi)`);
}

// --- scheletro rivolto a +Z: le gambe devono spingere nell'ALTRO verso ------
console.log('\n--- scheletro rivolto a +Z (faceYaw 0): i preset si specchiano ---');
const rig0 = humanoid(1);
api.setRig(rig0);
api.setSkeleton(skeletonFor(rig0));
ok(api.rigFacingYaw(rig0.bones) === 0, 'rigFacingYaw legge 0 dai piedi');
api.buildAnimationClips();
const clips0 = api.getClips();
{
    const w180 = clips.find(c => c.name === 'walk');
    const w0 = clips0.find(c => c.name === 'walk');
    const leg180 = tipWorld(rig180, quatsAt(w180, 0), 'upperLeg_R').z - tipWorld(rig180, {}, 'upperLeg_R').z;
    const leg0 = tipWorld(rig0, quatsAt(w0, 0), 'upperLeg_R').z - tipWorld(rig0, {}, 'upperLeg_R').z;
    ok(leg180 * leg0 < 0,
        `walk: la gamba oscilla verso il davanti di CIASCUNO scheletro (dZ ${leg180.toFixed(2)} vs ${leg0.toFixed(2)})`);
    // e le braccia restano lungo il corpo in entrambi i casi (la Z non si specchia)
    const armX = (rd, c) => tipWorld(rd, quatsAt(c, 0), 'upperArm_R').x - tipWorld(rd, {}, 'upperArm_R').x;
    ok(armX(rig180, w180) < -2 && armX(rig0, w0) < -2,
        `walk: il braccio destro rientra verso il corpo in entrambi gli orientamenti `
        + `(dX ${armX(rig180, w180).toFixed(2)} e ${armX(rig0, w0).toFixed(2)})`);
}
for (const name of PRESETS) {
    const clip = clips0.find(c => c.name === name);
    const times = [...new Set(clip.tracks.flatMap(t => t.times))].sort((a, b) => a - b);
    let worst = Infinity;
    for (const tt of times) {
        const q = quatsAt(clip, tt);
        if (!q.upperArm_R) continue;
        worst = Math.min(worst, tipWorld(rig0, q, 'upperArm_R').sub(tipWorld(rig0, {}, 'upperArm_R')).length());
    }
    ok(worst > armLen * 0.4, `${name} (faceYaw 0): braccia fuori dalla T-pose (min ${worst.toFixed(2)})`);
}

// --- scheletro ridotto: nessun crash se mancano le ossa dei preset ---------
console.log('\n--- scheletro ridotto (senza spalle/mani/collo) ---');
{
    const small = humanoid(-1);
    small.bones = small.bones.filter(b => !/^(shoulder|hand|neck)_?[LR]?$/.test(b.name));
    // `parent` e' un INDICE: va rimappato dopo il filtro, come fa l'editor.
    const idx = {}; small.bones.forEach((b, i) => idx[b.name] = i);
    const full = humanoid(-1).bones;
    small.bones = small.bones.map(b => {
        const orig = full.find(o => o.name === b.name);
        let p = orig.parent;
        while (p >= 0 && !(full[p].name in idx)) p = full[p].parent;
        return { ...b, parent: p >= 0 ? idx[full[p].name] : -1 };
    });
    api.setRig(small);
    api.setSkeleton(skeletonFor(small));
    api.buildAnimationClips();
    const cs = api.getClips();
    ok(PRESETS.every(n => cs.some(c => c.name === n)), 'i preset si costruiscono comunque');
    const known = new Set(small.bones.map(b => b.name));
    const stray = cs.flatMap(c => c.tracks.map(tr => tr.name.split('.')[0])).filter(n => !known.has(n));
    ok(stray.length === 0, 'nessuna traccia su ossa inesistenti' + (stray.length ? ': ' + stray.join(' ') : ''));
    const wave = cs.find(c => c.name === 'wave');
    const q = quatsAt(wave, 0.4);
    ok(!!q.upperArm_R, 'wave: il braccio si alza anche senza osso spalla');
}

// --- le clip dell'AI NON vanno coniugate ----------------------------------
// I preset sono scritti nel frame canonico; le clip dell'AI arrivano gia' nel
// frame dello scheletro reale. Coniugarle anche loro le ruoterebbe due volte.
console.log('\n--- clip AI: nessuna coniugazione ---');
{
    const r90 = humanoid(-1);
    // piedi lungo +X -> faceYaw 90, il caso in cui i preset si coniugano
    r90.bones = r90.bones.map(b => /^foot_[LR]$/.test(b.name)
        ? { ...b, tail: [b.head[0] + 4, b.head[1], b.head[2]] } : b);
    api.setRig(r90);
    api.setSkeleton(skeletonFor(r90));
    ok(api.rigFacingYaw(r90.bones) === 90, 'rigFacingYaw legge 90');
    const custom = {
        name: 'aiClip', duration: 1, loop: true,
        tracks: [{ bone: 'upperArm_R', keys: [{ t: 0, rot: [11, 22, 33] }] }],
    };
    const clip = api.buildClipFromAnimData(custom);
    const got = quatsAt(clip, 0).upperArm_R;
    const want = new Quat().setFromEuler(new Euler(11 * Math.PI / 180, 22 * Math.PI / 180, 33 * Math.PI / 180));
    const d = Math.max(Math.abs(got.x - want.x), Math.abs(got.y - want.y),
        Math.abs(got.z - want.z), Math.abs(got.w - want.w));
    ok(d < 1e-12, `senza qFace la rotazione passa invariata (scarto ${d.toExponential(1)})`);
    const qFace = new Quat().setFromAxisAngle(new V3(0, 1, 0), Math.PI / 2);
    const rot = api.buildClipFromAnimData(custom, qFace);
    const got2 = quatsAt(rot, 0).upperArm_R;
    const d2 = Math.max(Math.abs(got2.x - want.x), Math.abs(got2.y - want.y),
        Math.abs(got2.z - want.z), Math.abs(got2.w - want.w));
    ok(d2 > 1e-3, `con qFace invece viene coniugata (scarto ${d2.toFixed(4)}) -- il test ha denti`);
    // e i preset su questo scheletro la usano davvero
    api.buildAnimationClips();
    const walk90 = api.getClips().find(c => c.name === 'walk');
    const legQ = quatsAt(walk90, 0).upperLeg_R;
    ok(Math.abs(legQ.y) > 1e-6 || Math.abs(legQ.z) > 1e-6,
        'preset a 90 gradi: la rotazione della gamba non e\' piu\' solo su X');
}

console.log(`\n=== preset di animazione: ${pass} superati, ${fail} falliti ===`);
process.exit(fail ? 1 : 0);
