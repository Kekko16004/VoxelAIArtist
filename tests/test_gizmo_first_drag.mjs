/*
 * PRIMO DRAG DEL GIZMO: la posa non deve saltare.
 *
 * In r128 TransformControls fotografa _quaternionStart PRIMA di mettere
 * dragging = true (che e' cio' che emette 'dragging-changed' -> onGizmoDragStart).
 * Se al pointerdown gizmoProxy e' disallineato rispetto all'osso, onGizmoChange --
 * che scrive la posa in ASSOLUTO -- porta la posa all'orientamento del proxy.
 * Il rimedio e' un listener pointerdown in CAPTURE su window che risincronizza il
 * proxy prima che TransformControls lo guardi.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/15-rig.js'), 'utf8');
const from = src.indexOf("let gizmoMode = 'rotate';");
const to = src.indexOf('// Move a joint in rest space', from);
if (from < 0 || to < 0) {
    console.log('FAIL: blocco del gizmo non trovato in 15-rig.js (marcatori cambiati?)');
    process.exit(1);
}
const block = src.slice(from, to);
ok(/addEventListener\(\s*'pointerdown'[\s\S]{0,400}?true\s*\)/.test(block),
   'il blocco registra un pointerdown in capture (la fix e\' presente)');

// --- THREE finto: solo cio' che il blocco usa, ma con matematica REALE ---
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    lengthSq() { return this.x ** 2 + this.y ** 2 + this.z ** 2; }
    setFromMatrixPosition(m) { this.x = m.pos.x; this.y = m.pos.y; this.z = m.pos.z; return this; }
}
class Quat {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    clone() { return new Quat(this.x, this.y, this.z, this.w); }
    identity() { this.x = this.y = this.z = 0; this.w = 1; return this; }
    invert() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }   // unitario
    dot(q) { return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w; }
    multiply(b) {
        const a = this;
        const x = a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y;
        const y = a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z;
        const z = a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x;
        const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
        this.x = x; this.y = y; this.z = z; this.w = w; return this;
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
}
class Euler {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    copy(e) { this.x = e.x; this.y = e.y; this.z = e.z; return this; }
    // XYZ, come THREE: matrice dal quaternione, poi estrazione.
    setFromQuaternion(q) {
        const x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z;
        const xx = q.x * x2, xy = q.x * y2, xz = q.x * z2;
        const yy = q.y * y2, yz = q.y * z2, zz = q.z * z2;
        const wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;
        const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy;
        const m22 = 1 - (xx + zz), m23 = yz - wx;
        const m32 = yz + wx, m33 = 1 - (xx + yy);
        this.y = Math.asin(clamp(m13, -1, 1));
        if (Math.abs(m13) < 0.9999999) { this.x = Math.atan2(-m23, m33); this.z = Math.atan2(-m12, m11); }
        else { this.x = Math.atan2(m32, m22); this.z = 0; }
        return this;
    }
}

class Obj3D {
    constructor() { this.position = new V3(); this.quaternion = new Quat(); this.rotation = new Euler(); }
    updateMatrixWorld() { }
}
// TransformControls finto: replica SOLO l'ordine di r128 che conta.
class FakeTC {
    constructor() {
        this.dragging = false; this.axis = null; this.object = null;
        this.enabled = false; this.visible = false;
        this._l = {}; this._quaternionStart = new Quat();
    }
    addEventListener(t, f) { (this._l[t] || (this._l[t] = [])).push(f); }
    _emit(t, e) { (this._l[t] || []).forEach(f => f(e)); }
    attach(o) { this.object = o; return this; }
    detach() { this.object = null; return this; }
    setMode() { } setSpace() { } setSize() { }
    // r128 pointerDown: fotografia PRIMA, dragging (e quindi l'evento) DOPO.
    pointerDown() {
        this._quaternionStart.copy(this.object.quaternion);
        this.dragging = true;
        this._emit('dragging-changed', { value: true });
    }
    // Un movimento del mouse: TC scriverebbe una rotazione sul proxy partendo da
    // _quaternionStart. Qui la applichiamo come delta e notifichiamo, come TC.
    pointerMove(deltaQ) {
        this.object.quaternion.copy(new Quat().copy(deltaQ).multiply(this._quaternionStart));
        this._emit('objectChange', {});
    }
    pointerUp() { this.dragging = false; this._emit('dragging-changed', { value: false }); }
}
const THREE = { Object3D: Obj3D, Quaternion: Quat, Euler, Vector3: V3, TransformControls: FakeTC };

// Osso finto: quaternione mondo imposto a mano, genitore identita'.
function makeBone(name, worldQ) {
    return {
        name, isBone: true, parent: null,
        rotation: new Euler(), matrixWorld: { pos: new V3(1, 2, 3) },
        updateWorldMatrix() { }, getWorldQuaternion(q) { return q.copy(worldQ); },
    };
}

const winL = {};
const window_ = { addEventListener(t, f, c) { (winL[t] || (winL[t] = [])).push({ f, capture: !!c }); } };
const dom = { addEventListener() { } };
const api = new Function(
    'THREE', 'scene', 'camera', 'renderer', 'controls', 'gizmoBar', 'window',
    'pushHistory', 'updateBoneMarker', 'updateRotLabels', 'poseRot', 'animSelect',
    'rigPreviewActive', 'weightPaintActive', 'applyRig', 'selectBone',
    'var skeleton = null, selectedBoneIndex = -1, rig = null, currentAction = null;\n' +
    block +
    '\nreturn { tc: transformControls, proxy: gizmoProxy, syncGizmoToBone, updateGizmo,' +
    ' set(s, i, r) { skeleton = s; selectedBoneIndex = i; rig = r; },' +
    ' pose() { return rig.pose; } };'
)(THREE, { add() { } }, {}, { domElement: dom }, { enabled: true },
  { classList: { toggle() { } } }, window_,
  () => { }, () => { }, () => { },
  { x: { value: 0 }, y: { value: 0 }, z: { value: 0 } }, { value: 'none' }, true, false,
  () => { }, () => { });

// --- scenario ---
const REST = new Quat().setFromEuler(new Euler(0, 0, 0));          // osso a riposo
const STALE = new Quat().setFromEuler(new Euler(0.9, 0.3, -0.7));  // proxy stantio
const firePointerDown = () => (winL['pointerdown'] || [])
    .filter(x => x.capture).forEach(x => x.f({ button: 0 }));

// Porta i controls nello stato in cui li lascia updateGizmo() sulla scheda Rig:
// abilitati e agganciati al proxy. La fix si autolimita a quello stato, quindi il
// test deve riprodurlo o non proverebbe nulla.
function armGizmo() { api.tc.enabled = true; api.tc.attach(api.proxy); }

function scenario(boneQ, proxyQ, deltaQ) {
    const bone = makeBone('upperArm_R', boneQ);
    const rig = { bones: [{ name: 'upperArm_R' }], pose: {} };
    api.set({ bones: [bone] }, 0, rig);
    armGizmo();
    api.proxy.quaternion.copy(proxyQ);          // stato di partenza del proxy
    firePointerDown();                          // <-- la fix, se c'e', gira qui
    api.tc.pointerDown();                       // fotografia + dragging-changed
    api.tc.pointerMove(deltaQ);                 // primo objectChange
    const written = rig.pose['upperArm_R'].slice();
    api.tc.pointerUp();
    return written;
}
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

console.log('[1] proxy STANTIO: il primo objectChange non deve saltare');
// Movimento nullo: la posa scritta deve essere quella dell'OSSO (riposo = 0,0,0),
// non quella del proxy stantio.
ok(near(scenario(REST, STALE, new Quat()), [0, 0, 0]),
   'movimento nullo con proxy stantio -> posa invariata (nessun salto)');

console.log('[2] un movimento vero produce esattamente quel movimento');
const D = new Quat().setFromEuler(new Euler(0, 0, 0.5));
ok(near(scenario(REST, STALE, D), [0, 0, 0.5], 1e-6),
   'delta di 0.5 rad su Z con proxy stantio -> posa = 0.5 rad su Z');

console.log('[3] caso di controllo: proxy GIA\' allineato, nulla cambia');
ok(near(scenario(REST, REST, new Quat()), [0, 0, 0]), 'proxy allineato, movimento nullo');
ok(near(scenario(REST, REST, D), [0, 0, 0.5], 1e-6), 'proxy allineato, delta 0.5 su Z');

console.log('[4] la risincronizzazione non scatta a meta\' trascinamento');
{
    const bone = makeBone('upperArm_R', REST);
    api.set({ bones: [bone] }, 0, { bones: [{ name: 'upperArm_R' }], pose: {} });
    armGizmo();
    api.proxy.quaternion.copy(REST);
    firePointerDown(); api.tc.pointerDown();
    api.tc.pointerMove(D);
    const before = api.proxy.quaternion.clone();
    firePointerDown();                          // pointerdown spurio DURANTE il drag
    ok(Math.abs(api.proxy.quaternion.dot(before)) > 0.999999,
       'un pointerdown durante il drag non risincronizza (non annulla il gesto)');
    api.tc.pointerUp();
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
