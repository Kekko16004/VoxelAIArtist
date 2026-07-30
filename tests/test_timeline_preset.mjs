/*
 * Timeline: i keyframe delle clip PRESET devono vedersi (in sola lettura) e lo scrub
 * deve funzionare. Regressione da bug reale: "nella timeline non vedo i keyframe delle
 * animazioni gia' fatte" - tlRenderRows() chiedeva i tempi a tlActiveAnim(), che guarda
 * solo rig.customAnims, quindi per una preset ogni riga nasceva vuota.
 *
 * Copre:
 *   - tlAnimDataFromClip(): keyframe REALI estratti da un AnimationClip (quaternion ->
 *     Euler in gradi, position -> offset dalla restPos);
 *   - le righe disegnate per una preset: tempi per osso + riepilogo = unione, diamanti
 *     marcati .tl-key-ro;
 *   - editing negato: inserimento/eliminazione non toccano nulla, badge "sola lettura";
 *   - scrub: campiona il dato derivato, scrive in rig.pose e ZITTISCE il mixer;
 *   - playhead: durante la riproduzione di una preset segue currentAction.time (con
 *     avvolgimento sulla durata) senza toccare la posa;
 *   - "Rendi modificabile": la copia in rig.customAnims ha gli stessi keyframe e da'
 *     una clip pienamente editabile.
 *
 * Come tests/test_rig_tools.mjs: il modulo e' un frammento di UNO scope condiviso,
 * quindi si carica con new Function e stub minimi di DOM/THREE. Qui NON si carica
 * 15-rig.js: le poche cose che servono (rig, skeleton, rigClips, currentAction,
 * applyPoseToBones, playClip) sono stub globali, cosi' il test resta sulla timeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const nearList = (a, b, eps = 1e-3) => Array.isArray(a) && a.length === b.length
    && a.every((v, i) => near(Number(v), b[i], eps));

// --- DOM finto con classList/children veri (le asserzioni leggono i diamanti) -----
class El {
    constructor(tag = 'div') {
        this.tagName = String(tag).toUpperCase();
        this._cls = new Set();
        this._text = '';
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.attrs = {};
        this.value = '';
        this.title = '';
        this.disabled = false;
        this.parentNode = null;
        this.clientWidth = 1000;
        this.offsetWidth = 130;
        this.offsetHeight = 190;
    }
    get className() { return Array.from(this._cls).join(' '); }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get classList() {
        const s = this._cls;
        return {
            add: (...c) => c.forEach(x => s.add(x)),
            remove: (...c) => c.forEach(x => s.delete(x)),
            toggle: (c, on) => { if (on === undefined ? s.has(c) : !on) s.delete(c); else s.add(c); },
            contains: c => s.has(c),
        };
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get options() { return this.children; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
        const i = this.children.indexOf(ref);
        c.parentNode = this;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        return c;
    }
    remove() { }
    addEventListener() { }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return (k in this.attrs) ? this.attrs[k] : null; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 200 }; }
    setPointerCapture() { }
    releasePointerCapture() { }
}
const els = new Map();
const byId = id => { if (!els.has(id)) els.set(id, new El()); return els.get(id); };
const toolbar = new El();
byId('tlStatus').parentNode = toolbar;
toolbar.appendChild(byId('tlStatus'));
global.document = { getElementById: byId, createElement: t => new El(t), addEventListener() { } };
global.window = { addEventListener() { } };
global.alert = () => { };

// --- THREE: qui la matematica dei quaternioni deve essere VERA (il test verifica i
// gradi estratti dalle tracce e la posa campionata), quindi e' portata da three r128.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
class Euler {
    constructor(x = 0, y = 0, z = 0, order = 'XYZ') { this.x = x; this.y = y; this.z = z; this.order = order; }
    setFromQuaternion(q) {
        const { x, y, z, w } = q;
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;
        const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy;
        const m22 = 1 - (xx + zz), m23 = yz - wx;
        const m32 = yz + wx, m33 = 1 - (xx + yy);
        this.y = Math.asin(clamp(m13, -1, 1));
        if (Math.abs(m13) < 0.9999999) { this.x = Math.atan2(-m23, m33); this.z = Math.atan2(-m12, m11); }
        else { this.x = Math.atan2(m32, m22); this.z = 0; }
        return this;
    }
}
class Quaternion {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
    setFromEuler(e) {
        const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
        const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        return this;
    }
    slerp(qb, t) {
        if (t === 0) return this;
        if (t === 1) { this.x = qb.x; this.y = qb.y; this.z = qb.z; this.w = qb.w; return this; }
        const { x, y, z, w } = this;
        let cos = w * qb.w + x * qb.x + y * qb.y + z * qb.z;
        let bx = qb.x, by = qb.y, bz = qb.z, bw = qb.w;
        if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        if (cos >= 1) return this;
        const sin = Math.sqrt(1 - cos * cos);
        if (Math.abs(sin) < 1e-6) {
            this.x = 0.5 * (x + bx); this.y = 0.5 * (y + by);
            this.z = 0.5 * (z + bz); this.w = 0.5 * (w + bw);
            return this;
        }
        const half = Math.atan2(sin, cos);
        const ra = Math.sin((1 - t) * half) / sin, rb = Math.sin(t * half) / sin;
        this.x = x * ra + bx * rb; this.y = y * ra + by * rb;
        this.z = z * ra + bz * rb; this.w = w * ra + bw * rb;
        return this;
    }
}
global.THREE = { Euler, Quaternion };
// --- rig / scheletro / clip finti -------------------------------------------------
const HIP_REST = { x: 5, y: 10, z: 5 };
const d2r = d => d * Math.PI / 180;

function mkBone(name, rest) {
    return {
        name: name,
        userData: rest ? { restPos: { x: rest.x, y: rest.y, z: rest.z } } : {},
        rotation: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
        position: {
            x: rest ? rest.x : 0, y: rest ? rest.y : 0, z: rest ? rest.z : 0,
            set(x, y, z) { this.x = x; this.y = y; this.z = z; },
            copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; },
        },
    };
}
global.rig = { type: 'humanoid', bones: [{ name: 'hips' }, { name: 'upperLeg_L' }], pose: {}, customAnims: [] };
global.skeleton = { bones: [mkBone('hips', HIP_REST), mkBone('upperLeg_L', null)] };
global.selectedBoneIndex = -1;
global.rigPreviewActive = true;
global.animSelect = byId('animSelect');

// applyPoseToBones() finto, con la stessa semantica del vero: scrive le rotazioni da
// rig.pose e RIPORTA le ossa alla restPos (le posizioni le riscrive poi tlApplyAt).
global.applyPoseToBones = () => {
    global.skeleton.bones.forEach((b, i) => {
        const p = (global.rig.pose && global.rig.pose[global.rig.bones[i].name]) || [0, 0, 0];
        b.rotation.set(p[0], p[1], p[2]);
        if (b.userData.restPos) b.position.copy(b.userData.restPos);
    });
};
let renderCalls = 0;
global.requestRender = () => { renderCalls++; };
global.pushHistory = () => { };
global.uniqueAnimName = base => base + '_2';
let buildClipsCalls = 0;
global.buildAnimationClips = () => { buildClipsCalls++; };
global.t = (key, vars) => (vars ? key + '(' + JSON.stringify(vars) + ')' : key);

// Tracce quaternion costruite dagli stessi Euler in gradi che ci aspettiamo indietro.
const quatValues = eulers => {
    const out = [];
    eulers.forEach(e => {
        const q = new Quaternion().setFromEuler(new Euler(d2r(e[0]), d2r(e[1]), d2r(e[2]), 'XYZ'));
        out.push(q.x, q.y, q.z, q.w);
    });
    return out;
};
// La preset: un AnimationClip come quelli di buildAnimationClips() (walk, 1s).
const presetClip = {
    name: 'walk', duration: 1,
    tracks: [
        {
            name: 'upperLeg_L.quaternion', times: [0, 0.5, 1],
            values: quatValues([[0, 0, 0], [30, 0, 0], [0, 0, 0]]),
        },
        {
            name: 'hips.position', times: [0, 0.5],
            values: [HIP_REST.x, HIP_REST.y, HIP_REST.z,
            HIP_REST.x, HIP_REST.y + 0.4, HIP_REST.z],
        },
    ],
};
global.rigClips = [presetClip];

// L'action del mixer: stop() la ferma davvero (il modulo ci conta per non farsi
// sovrascrivere la posa a ogni frame).
function mkAction(clip) {
    return {
        time: 0, paused: false, stopped: false, _running: true,
        getClip: () => clip,
        isRunning() { return this._running; },
        stop() { this.stopped = true; this._running = false; this.time = 0; return this; },
    };
}
const playCalls = [];
global.currentAction = null;
global.playClip = name => {
    playCalls.push(name);
    const c = global.rigClips.find(x => x && x.name === name);
    global.currentAction = c ? mkAction(c) : null;
};

// --- carica il modulo -------------------------------------------------------------
const src = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/33-timeline.js'), 'latin1');
const api = new Function(src + `
 ;return {tlAnimDataFromClip, tlPresetAnim, tlDisplayAnim, tlActiveAnim, tlKeyTimesByBone,
          tlRenderRows, tlUpdateToolbar, tlRedraw, tlApplyAt, tlSetFrame, tlTick,
          tlTogglePlay, tlSelectClip, tlInsertKey, tlDeleteSelectedKeys, tlMakeEditable,
          tlSilenceMixer, tlFrameOfTime, tlTimeOfFrame, tlFrameCount, tlCountKeys,
          badge: tlRoBadge,
          get: () => ({tlVisible, tlPlaying, tlClipName, tlFrame, tlSelected, tlPoseBackup, tlLoop}),
          set: (k, v) => {
              if (k === 'tlVisible') tlVisible = v;
              else if (k === 'tlClipName') tlClipName = v;
              else if (k === 'tlPlaying') tlPlaying = v;
              else if (k === 'tlFrame') tlFrame = v;
              else if (k === 'tlLoop') tlLoop = v;
              else if (k === 'tlSelected') tlSelected = v;
              else throw new Error('chiave ignota: ' + k);
          }};`)();
const rowsEl = byId('tlRows');
const labelsEl = byId('tlLabels');
const statusEl = byId('tlStatus');
const insertBtn = byId('tlInsertKeyBtn');
const deleteBtn = byId('tlDeleteKeyBtn');
const editableBtn = byId('tlMakeEditableBtn');
const rows = () => rowsEl.children.map(r => ({
    bone: r.dataset.bone,
    times: r.children.map(k => Number(k.dataset.t)),
    allRo: r.children.length > 0 && r.children.every(k => k.classList.contains('tl-key-ro')),
    anyRo: r.children.some(k => k.classList.contains('tl-key-ro')),
}));

// --- 1. keyframe REALI ricavati dalla clip ----------------------------------------
{
    const data = api.tlAnimDataFromClip(presetClip, 'walk');
    ok(!!data && data.tracks.length === 2, 'tlAnimDataFromClip trova le due tracce');
    const leg = data.tracks.find(tr => tr.bone === 'upperLeg_L');
    const hips = data.tracks.find(tr => tr.bone === 'hips');
    ok(nearList(leg.keys.map(k => k.t), [0, 0.5, 1]), 'i tempi della traccia di rotazione sono quelli della clip');
    ok(nearList(leg.keys[1].rot, [30, 0, 0], 0.02), 'il quaternione torna Euler in gradi: ' + JSON.stringify(leg.keys[1].rot));
    ok(nearList(hips.keys.map(k => k.t), [0, 0.5]), 'i tempi della traccia di posizione sono quelli della clip');
    ok(nearList(hips.keys[1].pos, [0, 0.4, 0]), 'la posizione diventa offset dalla restPos: ' + JSON.stringify(hips.keys[1].pos));
    ok(near(data.duration, 1), 'la durata arriva dalla clip');
}

// --- 2. le righe della preset NON sono piu' vuote (il bug) ------------------------
api.set('tlVisible', true);
api.tlSelectClip('walk');
{
    ok(api.get().tlClipName === 'walk' && playCalls[0] === 'walk',
        'selezionare una preset la manda al mixer come prima');
    ok(api.tlActiveAnim() === null, 'una preset NON ha un dato modificabile (era la causa delle righe vuote)');
    const r = rows();
    ok(r.length === 3, 'tre righe: riepilogo + hips + upperLeg_L (viste: ' + r.length + ')');
    const summary = r[0], hips = r.find(x => x.bone === 'hips'), leg = r.find(x => x.bone === 'upperLeg_L');
    ok(labelsEl.children[0].textContent === 'timeline.summary', 'la prima riga e\' il riepilogo');
    ok(leg && leg.times.length === 3 && nearList(leg.times, [0, 0.5, 1]),
        'REGRESSIONE: la riga dell\'osso mostra i keyframe reali: ' + JSON.stringify(leg && leg.times));
    ok(hips && nearList(hips.times, [0, 0.5]), 'anche la traccia di posizione ha i suoi keyframe');
    ok(nearList(summary.times, [0, 0.5, 1]), 'il riepilogo e\' l\'UNIONE dei tempi: ' + JSON.stringify(summary.times));
    ok(r.every(x => x.allRo), 'tutti i diamanti sono marcati .tl-key-ro (sola lettura)');
    ok(rowsEl.children[1].children[0].style.background === 'var(--text-secondary)',
        'i diamanti in sola lettura sono grigi (muted)');
    ok(api.tlPresetAnim() === api.tlPresetAnim(), 'il dato derivato e\' in cache (non si ricalcola a ogni render)');
}
// --- 3. editing negato + badge di sola lettura ------------------------------------
{
    ok(insertBtn.disabled === true && deleteBtn.disabled === true,
        'inserimento/eliminazione disabilitati su una preset');
    ok(editableBtn.style.display === '', '"Rendi modificabile" e\' visibile');
    ok(api.badge && api.badge.style.display === '' && api.badge.textContent === 'timeline.readOnly',
        'il badge "sola lettura" e\' in barra con il testo tradotto');
    ok(api.badge.title === 'timeline.statusPreset', 'il badge spiega nel title come renderla modificabile');
    ok(toolbar.children.indexOf(api.badge) === toolbar.children.indexOf(statusEl) - 1,
        'il badge e\' inserito accanto a #tlStatus');
    ok(String(statusEl.textContent).indexOf('timeline.statusPresetKeys') === 0,
        'lo stato conta i keyframe in sola lettura: ' + statusEl.textContent);

    global.selectedBoneIndex = 1;
    const before = api.tlCountKeys(api.tlPresetAnim());
    api.tlInsertKey();
    ok(global.rig.customAnims.length === 0 && api.tlCountKeys(api.tlPresetAnim()) === before,
        'tlInsertKey() su una preset non crea e non modifica nulla');
    api.set('tlSelected', [{ bone: 'upperLeg_L', t: 0 }]);
    api.tlDeleteSelectedKeys();
    ok(api.tlCountKeys(api.tlPresetAnim()) === before,
        'tlDeleteSelectedKeys() su una preset non cancella nessuna chiave');
    api.set('tlSelected', []);
    global.selectedBoneIndex = -1;
}

// --- 4. scrub: campiona il dato derivato e zittisce il mixer ----------------------
{
    const act = global.currentAction;
    ok(!!act, 'prima dello scrub la preset e\' in mano al mixer');
    renderCalls = 0;
    api.tlSetFrame(12);                       // 12/24 fps = 0.5s, dove sta la chiave a 30 gradi
    ok(act.stopped === true && global.currentAction === null,
        'lo scrub FERMA l\'action (in pausa continuerebbe a scrivere sulle ossa)');
    ok(global.animSelect.value === 'none', 'il menu animazioni torna a "nessuna": la posa e\' della timeline');
    ok(api.get().tlPlaying === false, 'spento il mixer, la preset non e\' piu\' in riproduzione');
    ok(nearList(global.rig.pose.upperLeg_L, [d2r(30), 0, 0]),
        'la posa campionata finisce in rig.pose in radianti: ' + JSON.stringify(global.rig.pose.upperLeg_L));
    ok(near(global.skeleton.bones[1].rotation.x, d2r(30)), 'l\'osso e\' ruotato di conseguenza');
    ok(near(global.skeleton.bones[0].position.y, HIP_REST.y + 0.4),
        'la traccia di posizione si applica come offset dalla restPos: ' + global.skeleton.bones[0].position.y);
    ok(renderCalls > 0, 'lo scrub chiede un render (la app disegna on-demand)');

    // A meta' strada fra due chiavi il valore e' interpolato, non "l'ultima chiave".
    api.tlSetFrame(6);                        // 0.25s, fra 0 e 0.5
    const mid = global.rig.pose.upperLeg_L[0];
    ok(mid > d2r(10) && mid < d2r(20), 'fra due chiavi la rotazione e\' interpolata (' + (mid * 180 / Math.PI).toFixed(1) + ' gradi)');
}
// --- 5. Play restituisce il controllo al mixer, il playhead lo segue ---------------
{
    api.set('tlFrame', 6);
    api.tlTogglePlay();                       // Play su una preset
    const act = global.currentAction;
    ok(!!act && act.paused === false && api.get().tlPlaying === true,
        'Play su una preset ricrea/riprende l\'action del mixer');
    ok(near(act.time, 0.25), 'la riproduzione riparte dal playhead (t=' + act.time + ')');

    const poseBefore = JSON.stringify(global.rig.pose);
    act.time = 0.75;                          // come dopo un mixer.update()
    api.tlTick(0.016);
    ok(near(api.get().tlFrame, 18), 'il playhead segue currentAction.time (frame ' + api.get().tlFrame + ')');
    ok(JSON.stringify(global.rig.pose) === poseBefore,
        'durante la riproduzione la timeline NON scrive la posa: la muove il mixer');

    act.time = 1.4;                           // clip in ciclo: tempo oltre la durata
    api.tlTick(0.016);
    ok(near(api.get().tlFrame, 9.6), 'il tempo oltre la durata si avvolge (frame ' + api.get().tlFrame + ')');

    api.tlTogglePlay();                       // Pausa
    ok(act.paused === true && api.get().tlPlaying === false, 'Pausa mette in pausa l\'action, non la ferma');
    api.set('tlPlaying', true);
    api.tlTick(0.016);
    ok(api.get().tlPlaying === false, 'con l\'action in pausa il trasporto della timeline si spegne da solo');
}

// --- 6. "Rendi modificabile": stessi keyframe, ora editabili -----------------------
{
    api.set('tlClipName', 'walk');
    global.currentAction = null;
    api.tlMakeEditable();
    const anim = global.rig.customAnims[0];
    ok(!!anim && anim.name === 'walk_2', 'la copia modificabile nasce con nome univoco');
    ok(buildClipsCalls > 0, 'le clip THREE vengono ricostruite (export e menu allineati)');
    const leg = anim.tracks.find(tr => tr.bone === 'upperLeg_L');
    ok(nearList(leg.keys.map(k => k.t), [0, 0.5, 1]),
        'la copia ha gli STESSI tempi di chiave della preset: ' + JSON.stringify(leg.keys.map(k => k.t)));
    ok(api.get().tlClipName === 'walk_2' && !!api.tlActiveAnim(), 'la timeline passa alla copia modificabile');

    api.tlRedraw();
    const r = rows();
    ok(r.every(x => !x.anyRo), 'ora i diamanti NON sono piu\' in sola lettura');
    ok(nearList(r.find(x => x.bone === 'upperLeg_L').times, [0, 0.5, 1]),
        'i keyframe restano visibili dopo la conversione');
    ok(insertBtn.disabled === false, 'inserimento riabilitato');
    ok(api.badge.style.display === 'none' && editableBtn.style.display === 'none',
        'badge e pulsante di conversione spariscono su una clip modificabile');

    global.selectedBoneIndex = 1;
    api.set('tlFrame', 6);
    api.tlInsertKey();
    const keys = global.rig.customAnims[0].tracks.find(tr => tr.bone === 'upperLeg_L').keys;
    ok(keys.length === 4 && keys.some(k => near(k.t, 0.25)),
        'sulla copia inserire una chiave funziona come sempre (' + keys.length + ' chiavi)');
}

console.log(fail ? `\nFALLITI: ${fail} (pass=${pass})` : `\nTUTTI I TEST PASSATI  (pass=${pass})`);
process.exit(fail ? 1 : 0);
