/*
 * Verifica i CANALI dei keyframe (stile Unity) di ui/src/lib/33-timeline.js:
 *   - tlInsertKey('loc' | 'rot' | 'locrot') scrive SOLO i canali richiesti e
 *     lascia intatti gli altri gia' presenti sulla stessa chiave;
 *   - il canale Location fa il giro completo: rig.posePos -> tlLivePosOf ->
 *     chiave {pos} -> tlSampleAnim -> tlApplyAt -> rig.posePos;
 *   - una chiave di sola Location NON inventa una rotazione (e viceversa);
 *   - tlChansAt descrive i canali della chiave (e' il tooltip del rombo);
 *   - il menu "quali canali" risponde a frecce, Invio, L/R/B, Esc e si chiude
 *     con qualunque altro tasto senza inserire nulla.
 *
 * Come tests/test_rig_tools.mjs: i moduli sono frammenti di UNO scope condiviso,
 * quindi si caricano concatenati con new Function e stub minimi di THREE/DOM.
 * Qui pero' gli id della timeline tornano null di proposito: cosi' tlHasDom() e'
 * falso, il blocco di wiring non parte e si testa la logica pura.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// --- stub DOM ------------------------------------------------------------------
const mkEl = () => {
    const el = {
        tagName: 'DIV', type: '', className: '', id: '',
        textContent: '', innerHTML: '', value: '0', checked: false, disabled: false,
        style: {}, dataset: {}, title: '', children: [], parentNode: null,
        offsetWidth: 220, offsetHeight: 120,
        classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
        _ev: {},
        addEventListener(k, fn) { (this._ev[k] || (this._ev[k] = [])).push(fn); },
        removeEventListener() { },
        fire(k, ev) { (this._ev[k] || []).forEach(fn => fn(ev || {})); },
        appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; },
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c) c.parentNode = null; return c; },
        contains(x) { return x === this || this.children.some(c => c && c.contains && c.contains(x)); },
        querySelectorAll(sel) { return this.children.filter(c => c && ('.' + c.className) === sel); },
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        getBoundingClientRect: () => ({ left: 0, top: 200, bottom: 220, width: 100, height: 20 }),
    };
    return el;
};
// Gli id della timeline devono mancare: vedi intestazione.
const isTimelineId = id => id === 'timelineDock' || /^tl[A-Z]/.test(String(id));
const body = mkEl();
global.document = {
    body,
    getElementById: id => (isTimelineId(id) ? null : mkEl()),
    createElement: mkEl,
    addEventListener() { }, removeEventListener() { },
};
global.window = { innerWidth: 1200, innerHeight: 800, addEventListener() { }, removeEventListener() { } };
global.alert = () => { };
global.prompt = () => null;
global.confirm = () => false;
const store = new Map();
global.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
};
global.t = (k) => k;
global.requestRender = () => { };
global.updateHistoryButtons = () => { };
let historyCalls = 0;
global.pushHistory = () => { historyCalls++; };
global.undoStack = [];
global.currentModelData = { metadata: {}, voxels: [] };
global.modelPivot = { visible: true };
global.gizmoEnabled = false;
global.buildModel = () => { };
global.renderer = { domElement: mkEl() };
global.camera = { fov: 45, position: { distanceTo: () => 10 }, getWorldDirection: v => v };
global.controls = { addEventListener() { } };
global.scene = { add() { }, remove() { } };

// --- stub THREE: qui la matematica dei quaternioni serve DAVVERO ----------------
// tlSampleRot fa Euler(gradi)->quaternion->slerp->Euler: con stub finti il test
// del canale Rotation non direbbe nulla.
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
class Euler {
    constructor(x = 0, y = 0, z = 0, order = 'XYZ') { this.x = x; this.y = y; this.z = z; this.order = order; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setFromQuaternion(q) {
        const { x, y, z, w } = q;
        const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
        const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
        const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
        this.y = Math.asin(Math.max(-1, Math.min(1, m13)));
        if (Math.abs(m13) < 0.9999999) { this.x = Math.atan2(-m23, m33); this.z = Math.atan2(-m12, m11); }
        else { this.x = Math.atan2(m32, m22); this.z = 0; }
        return this;
    }
}
class Quat {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    clone() { return new Quat(this.x, this.y, this.z, this.w); }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    identity() { this.x = this.y = this.z = 0; this.w = 1; return this; }
    invert() { this.x *= -1; this.y *= -1; this.z *= -1; return this; }
    multiply() { return this; }
    setFromUnitVectors() { return this; }
    setFromEuler(e) {
        const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
        const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        return this;
    }
    slerp(q, u) {
        if (u === 0) return this;
        if (u === 1) return this.copy(q);
        let cos = this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
        let bx = q.x, by = q.y, bz = q.z, bw = q.w;
        if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        if (cos > 0.9995) {
            this.x += (bx - this.x) * u; this.y += (by - this.y) * u;
            this.z += (bz - this.z) * u; this.w += (bw - this.w) * u;
            const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
            this.x /= l; this.y /= l; this.z /= l; this.w /= l;
            return this;
        }
        const th = Math.acos(cos), s = Math.sin(th);
        const a = Math.sin((1 - u) * th) / s, b = Math.sin(u * th) / s;
        this.x = this.x * a + bx * b; this.y = this.y * a + by * b;
        this.z = this.z * a + bz * b; this.w = this.w * a + bw * b;
        return this;
    }
}
global.THREE = {
    Group: class { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.visible = true; } add(o) { this.children.push(o); } remove() { } },
    Object3D: class { constructor() { this.position = new V3(); this.rotation = new V3(); this.quaternion = new Quat(); this.scale = new V3(1, 1, 1); this.visible = true; this.userData = {}; this.matrixWorld = {}; } add() { } updateMatrix() { } updateMatrixWorld() { } updateWorldMatrix() { } getWorldQuaternion(q) { return q; } },
    Vector3: V3,
    Vector2: class { constructor() { this.x = 0; this.y = 0; } },
    Plane: class { setFromNormalAndCoplanarPoint() { return this; } },
    Raycaster: class { constructor() { this.ray = { intersectPlane: () => null }; } setFromCamera() { } },
    Quaternion: Quat,
    Euler: Euler,
    QuaternionKeyframeTrack: class { constructor(n, t, v) { this.name = n; this.times = t; this.values = v; } },
    VectorKeyframeTrack: class { constructor(n, t, v) { this.name = n; this.times = t; this.values = v; } },
    AnimationClip: class { constructor(n, d, tr) { this.name = n; this.duration = d; this.tracks = tr || []; } },
    AnimationMixer: class { clipAction() { return { reset() { return this; }, play() { return this; }, stop() { } }; } },
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

const rigSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/15-rig.js'), 'latin1');
const tlSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/33-timeline.js'), 'latin1');
const api = new Function(rigSrc + '\n' + tlSrc + `
 ;return {
    tlInsertKey, tlLivePosOf, tlApplyAt, tlSampleAnim, tlSortedKeys, tlChansAt,
    tlOpenChanMenu, tlCloseChanMenu, tlChanMenuOpen, tlChanMenuKey, TL_CHANNELS,
    applyPoseToBones, posePosOf,
    chanIndex: () => tlChanIndex,
    chanMenuEl: () => tlChanMenu,
    setRig: v => { rig = v; },
    setSkeleton: v => { skeleton = v; },
    setSelectedBone: v => { selectedBoneIndex = v; },
    setClip: v => { tlClipName = v; },
    setFrame: v => { tlFrame = v; },
    setKeyAllBones: v => { tlKeyAllBones = v; },
 };`)();

// --- scena di prova -------------------------------------------------------------
const BONES = [
    { name: 'hips', parent: -1, head: [5, 5, 5], tail: [5, 7, 5] },
    { name: 'spine', parent: 0, head: [5, 7, 5], tail: [5, 9, 5] },
    { name: 'tip', parent: 1, head: [5, 9, 5], tail: [5, 10, 5], helper: true },
];
function mkSkeleton() {
    return {
        bones: BONES.map(b => ({
            name: b.name,
            position: new V3(b.head[0], b.head[1], b.head[2]),
            rotation: new V3(),
            quaternion: new Quat(),
            userData: { restPos: new V3(b.head[0], b.head[1], b.head[2]) },
            updateWorldMatrix() { }, matrixWorld: {},
            getWorldQuaternion(q) { return q; },
        })),
    };
}
// Ricrea da zero rig+scheletro+clip: ogni blocco parte pulito.
function reset(anim) {
    const rig = {
        bones: JSON.parse(JSON.stringify(BONES)),
        pose: {}, posePos: {}, binding: {}, type: 'humanoid',
        customAnims: [anim || { name: 'test', duration: 2, fps: 24, loop: true, tracks: [] }],
    };
    api.setRig(rig);
    api.setSkeleton(mkSkeleton());
    api.setSelectedBone(0);
    api.setKeyAllBones(false);
    api.setClip(rig.customAnims[0].name);
    api.setFrame(0);
    return rig;
}
const keysOf = (rig, bone) => {
    const tr = (rig.customAnims[0].tracks || []).find(x => x.bone === bone);
    return tr ? tr.keys : [];
};

// --- 1. quali canali finiscono nella chiave -------------------------------------
{
    const rig = reset();
    rig.pose.hips = [0.1, 0.2, 0.3];
    rig.posePos.hips = [1, 2, 3];
    api.tlInsertKey();                       // nessun argomento = comportamento storico
    const k = keysOf(rig, 'hips')[0];
    ok(!!k && Array.isArray(k.rot), 'senza argomenti si inserisce la Rotation (compatibilita\')');
    ok(!!k && !Array.isArray(k.pos), 'senza argomenti la Location NON viene scritta');
    ok(k && near(k.rot[0], 5.73, 0.01), 'la rotazione e\' salvata in GRADI (0.1 rad -> 5.73)');
}
{
    const rig = reset();
    rig.pose.hips = [0.1, 0.2, 0.3];
    rig.posePos.hips = [1, 2, 3];
    api.tlInsertKey('loc');
    const k = keysOf(rig, 'hips')[0];
    ok(!!k && Array.isArray(k.pos) && !Array.isArray(k.rot), "'loc' scrive solo la Location");
    ok(k && k.pos[0] === 1 && k.pos[1] === 2 && k.pos[2] === 3, 'la Location e\' la traslazione viva del rig');
}
{
    const rig = reset();
    rig.pose.hips = [0.1, 0, 0];
    rig.posePos.hips = [0, 1.5, 0];
    api.tlInsertKey('locrot');
    const k = keysOf(rig, 'hips')[0];
    ok(!!k && Array.isArray(k.pos) && Array.isArray(k.rot), "'locrot' scrive tutti e due i canali");
    ok(api.TL_CHANNELS.length === 3 && !api.TL_CHANNELS.some(c => c.id === 'scale'),
        'i canali sono esattamente tre: niente Scale');
}

// --- 2. un canale non richiesto non va perso ------------------------------------
{
    const rig = reset();
    rig.pose.hips = [0.1, 0, 0];
    rig.posePos.hips = [0, 4, 0];
    api.tlInsertKey('locrot');
    // Si cambia SOLO la rotazione e si ri-chiave la Rotation: la Location deve restare.
    rig.pose.hips = [0.5, 0, 0];
    rig.posePos.hips = [0, 99, 0];
    api.tlInsertKey('rot');
    const k = keysOf(rig, 'hips')[0];
    ok(keysOf(rig, 'hips').length === 1, 'ri-chiavare sullo stesso frame non duplica la chiave');
    ok(k && near(k.rot[0], 28.65, 0.01), 'la Rotation viene aggiornata');
    ok(k && k.pos[1] === 4, 'la Location preesistente NON viene toccata da un keying di sola Rotation');
}
{
    const rig = reset();
    rig.pose.hips = [0.1, 0, 0];
    api.tlInsertKey('rot');
    rig.pose.hips = [1.2, 0, 0];
    rig.posePos.hips = [3, 0, 0];
    api.tlInsertKey('loc');
    const k = keysOf(rig, 'hips')[0];
    ok(k && near(k.rot[0], 5.73, 0.01), 'e simmetricamente: la Rotation sopravvive a un keying di sola Location');
    ok(k && k.pos[0] === 3, 'la Location viene scritta');
}

// --- 3. tlLivePosOf: canale di posa, con ripiego sull'osso ----------------------
{
    const rig = reset();
    rig.posePos.spine = [1, -2, 0.5];
    const v = api.tlLivePosOf('spine');
    ok(v[0] === 1 && v[1] === -2 && v[2] === 0.5, 'tlLivePosOf legge rig.posePos');
    delete rig.posePos.spine;
    // Nessun canale: si misura l'osso rispetto al riposo (clip applicata da altrove).
    const sk = mkSkeleton();
    sk.bones[1].position.set(5, 12, 5);       // riposo y=7 -> offset +5
    api.setSkeleton(sk);
    const w = api.tlLivePosOf('spine');
    ok(near(w[1], 5), 'senza canale, tlLivePosOf misura l\'osso rispetto al riposo');
    ok(api.tlLivePosOf('inesistente').every(n => n === 0), 'un osso sconosciuto vale [0,0,0]');
}

// --- 4. giro completo del canale Location --------------------------------------
{
    const rig = reset();
    rig.posePos.hips = [0, 0, 0];
    api.tlInsertKey('loc');                   // t = 0
    api.setFrame(24);                         // 24 fps -> t = 1 s
    rig.posePos.hips = [0, 4, 0];
    api.tlInsertKey('loc');
    ok(keysOf(rig, 'hips').length === 2, 'due chiavi Location su frame diversi');

    const half = api.tlSampleAnim(rig.customAnims[0], 0.5);
    ok(half.pos.hips && near(half.pos.hips[1], 2), 'a meta\' strada la Location e\' interpolata (2)');
    ok(!half.rot.hips, 'una traccia di sola Location non produce una rotazione');

    api.tlApplyAt(0.5);
    ok(rig.posePos.hips && near(rig.posePos.hips[1], 2),
        'tlApplyAt scrive nel CANALE rig.posePos, non dritto sull\'osso');
    const bone = api.tlLivePosOf('hips');
    ok(near(bone[1], 2), 'e tlLivePosOf rilegge esattamente cio\' che si vede: I salva il valore giusto');

    // Chiave a meta' scrub: deve valere quello mostrato, non zero.
    api.setFrame(12);
    api.tlInsertKey('loc');
    const mid = keysOf(rig, 'hips').find(k => near(k.t, 0.5));
    ok(mid && near(mid.pos[1], 2), 'inserendo durante lo scrub si salva il valore visibile');
}

// --- 5. i due canali restano indipendenti nel campionamento --------------------
{
    const rig = reset();
    rig.pose.hips = [0, 0, 0];
    api.tlInsertKey('rot');
    api.setFrame(24);
    rig.posePos.hips = [0, 6, 0];
    api.tlInsertKey('loc');
    const tr = rig.customAnims[0].tracks.find(x => x.bone === 'hips');
    ok(api.tlSortedKeys(tr, 'rot').length === 1 && api.tlSortedKeys(tr, 'pos').length === 1,
        'tlSortedKeys separa i due canali sulla stessa traccia');
    const s = api.tlSampleAnim(rig.customAnims[0], 1);
    ok(s.pos.hips && near(s.pos.hips[1], 6), 'la Location arriva fino in fondo');
    ok(s.rot.hips && near(s.rot.hips[0], 0), 'la Rotation resta ferma sull\'unica chiave');
}

// --- 6. tooltip dei rombi -------------------------------------------------------
{
    const rig = reset();
    rig.pose.hips = [0.2, 0, 0];
    rig.posePos.hips = [1, 0, 0];
    api.tlInsertKey('locrot');
    const anim = rig.customAnims[0];
    ok(api.tlChansAt(anim, 'hips', 0) === 'timeline.chanLoc + timeline.chanRot',
        'tlChansAt elenca tutti e due i canali');
    api.setFrame(24);
    api.tlInsertKey('rot');
    ok(api.tlChansAt(anim, 'hips', 1) === 'timeline.chanRot', 'e solo quello presente se e\' uno');
    ok(api.tlChansAt(anim, 'hips', 99) === '', 'nessuna chiave a quel tempo -> stringa vuota');
}

// --- 7. tutte le ossa -----------------------------------------------------------
{
    const rig = reset();
    api.setKeyAllBones(true);
    rig.posePos.hips = [1, 0, 0];
    rig.posePos.spine = [0, 2, 0];
    api.tlInsertKey('loc');
    ok(keysOf(rig, 'hips').length === 1 && keysOf(rig, 'spine').length === 1,
        'il keying su tutte le ossa copre ogni osso reale');
    ok(keysOf(rig, 'tip').length === 0, 'le ossa helper restano fuori');
}

// --- 8. il menu dei canali ------------------------------------------------------
{
    const rig = reset();
    rig.pose.hips = [0.3, 0, 0];
    rig.posePos.hips = [0, 7, 0];

    api.tlOpenChanMenu(null);
    ok(api.tlChanMenuOpen(), 'il menu si apre');
    const box = api.chanMenuEl();
    ok(box && box.children.length === 3, 'tre voci: Location, Rotation, Location + Rotation');
    ok(box && box.children[1].dataset.chan === 'rot' && api.chanIndex() === 1,
        'parte evidenziata la Rotation (il caso piu\' frequente)');

    api.tlChanMenuKey({ key: 'ArrowDown' });
    ok(api.chanIndex() === 2, 'la freccia giu\' scende');
    api.tlChanMenuKey({ key: 'ArrowDown' });
    ok(api.chanIndex() === 0, 'e a fine elenco riparte da capo');
    api.tlChanMenuKey({ key: 'ArrowUp' });
    ok(api.chanIndex() === 2, 'la freccia su fa il giro all\'indietro');

    api.tlChanMenuKey({ key: 'Escape' });
    ok(!api.tlChanMenuOpen(), 'Esc chiude');
    ok(keysOf(rig, 'hips').length === 0, 'e non inserisce nulla');
    ok(box.parentNode === null, 'il menu viene staccato dal documento');
}
{
    const rig = reset();
    rig.pose.hips = [0.3, 0, 0];
    rig.posePos.hips = [0, 7, 0];
    api.tlOpenChanMenu(null);
    api.tlChanMenuKey({ key: 'Enter' });       // voce evidenziata = Rotation
    ok(!api.tlChanMenuOpen(), 'Invio chiude il menu');
    const k = keysOf(rig, 'hips')[0];
    ok(k && Array.isArray(k.rot) && !Array.isArray(k.pos), 'Invio inserisce la voce evidenziata');
}
{
    const rig = reset();
    rig.pose.hips = [0.3, 0, 0];
    rig.posePos.hips = [0, 7, 0];
    api.tlOpenChanMenu(null);
    api.tlChanMenuKey({ key: 'l' });
    const k = keysOf(rig, 'hips')[0];
    ok(k && Array.isArray(k.pos) && !Array.isArray(k.rot), 'L inserisce la sola Location');
}
{
    const rig = reset();
    rig.pose.hips = [0.3, 0, 0];
    rig.posePos.hips = [0, 7, 0];
    api.tlOpenChanMenu(null);
    api.tlChanMenuKey({ key: 'B' });
    const k = keysOf(rig, 'hips')[0];
    ok(k && Array.isArray(k.pos) && Array.isArray(k.rot), 'B (maiuscola o minuscola) inserisce tutti e due');
}
{
    const rig = reset();
    rig.pose.hips = [0.3, 0, 0];
    api.tlOpenChanMenu(null);
    ok(api.tlChanMenuKey({ key: 'q' }) === true, 'un tasto qualunque viene consumato dal menu');
    ok(!api.tlChanMenuOpen(), 'e lo chiude');
    ok(keysOf(rig, 'hips').length === 0, 'senza inserire niente');
}
{
    // Il clic sulla voce fa la stessa cosa della tastiera.
    const rig = reset();
    rig.pose.hips = [0.3, 0, 0];
    rig.posePos.hips = [0, 7, 0];
    api.tlOpenChanMenu(null);
    api.chanMenuEl().children[0].fire('click');
    ok(!api.tlChanMenuOpen(), 'il clic chiude il menu');
    const k = keysOf(rig, 'hips')[0];
    ok(k && Array.isArray(k.pos) && !Array.isArray(k.rot), 'e inserisce il canale della voce cliccata');
}
{
    // Senza una clip modificabile non c'e' niente da chiavare: il menu non si apre.
    reset();
    api.setClip('none');
    api.tlOpenChanMenu(null);
    ok(!api.tlChanMenuOpen(), 'nessuna clip personalizzata attiva -> il menu non si apre');
    api.setClip('test');
}

// --- 9. l'annullamento e' registrato --------------------------------------------
{
    reset();
    const before = historyCalls;
    api.tlInsertKey('locrot');
    ok(historyCalls === before + 1, 'ogni inserimento passa da pushHistory (Ctrl+Z funziona)');
}

console.log(`\n${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
