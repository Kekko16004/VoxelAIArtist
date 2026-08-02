/*
 * MISURA la separazione delle gambe nel binding "Pezzi".
 *
 * DESIGN FINALE (2026-08-01): ogni parte "arto" deve essere dedicata a UNA
 * gamba sola: `gamba_R`, `gamba_L`, `piede_R`, `piede_L`. Una parte che copre
 * ENTRAMBE le gambe (es. `pantaloni`) non alimenta entrambe le catene: e'
 * impossibile senza introdurre crossing (voxel gamba sinistra -> osso destro).
 * Invece la parte elegge un osso root dominante: se i due lati votano quasi 50/50
 * (MIRROR_TIE), il root sale al common ancestor (`hips`); altrimenti la catena
 * vincente prende tutto e la gamba opposta resta vuota.
 *
 * Il test verifica questo invariante finale: modelli con parti per-gamba ->
 * entrambe le gambe ricevono i loro voxel, 0 crossing; una parte simmetrica che
 * copre entrambe le gambe -> root promosso all'antenato comune (`hips`), cioe'
 * niente saldatura su una gamba sola e comunque 0 crossing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// --- stub DOM/THREE minimi (stesso schema di tests/test_rig_weights.mjs) ---
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
global.requestRender = () => { };
global.updateHistoryButtons = () => { };
global.pushHistory = () => { };
global.undoStack = [];
global.currentModelData = { metadata: {}, voxels: [] };
global.modelPivot = { visible: true };
global.gizmoEnabled = false;
global.updateGizmo = () => { };
global.buildModel = () => { };
global.renderer = { domElement: mkEl(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) };
global.camera = { fov: 45, position: { distanceTo: () => 10 } };
global.controls = { addEventListener() { } };

class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    distanceTo() { return 10; }
    applyQuaternion() { return this; }
}
global.THREE = {
    Group: class { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.visible = true; } add(o) { this.children.push(o); } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); } },
    Object3D: class { constructor() { this.position = new V3(); this.rotation = new V3(); this.quaternion = { copy: () => { }, setFromEuler: () => { } }; this.scale = new V3(1, 1, 1); this.visible = true; this.userData = {}; } add() { } updateMatrix() { } },
    Vector3: V3,
    Quaternion: class { copy() { return this; } invert() { return this; } multiply() { return this; } setFromEuler() { return this; } },
    Euler: class { constructor() { this.x = 0; this.y = 0; this.z = 0; } setFromQuaternion() { return this; } },
    TransformControls: class {
        constructor() {
            return new Proxy({ visible: false, enabled: true, object: null, mode: 'rotate' }, {
                get(t, k) { if (k in t) return t[k]; return () => { }; },
                set(t, k, v) { t[k] = v; return true; },
            });
        }
    },
    Color: class { constructor() { this.r = 0; this.g = 0; this.b = 0; } setHSL() { return this; } },
    MathUtils: { degToRad: d => d * Math.PI / 180, radToDeg: r => r * 180 / Math.PI },
};
global.scene = { add() { }, remove() { } };

const src = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/15-rig.js'), 'latin1');
const api = new Function(src + `
 ;return {buildHumanoidSkeleton, bindSkin, setRig:(r)=>{rig=r;}};`)();

// --- manichino: torso, testa, due braccia, due gambe SEPARATE nello spazio ---
// Convenzione di 15-rig.js: `_R` sta alla X MAGGIORE, `_L` alla X minore.
// Le gambe stanno a x 5-7 (sinistra) e x 12-14 (destra): fra loro c'e' un vuoto,
// quindi sono due componenti connessi distinti.
function dummyPerLimb() {
    const vox = [];
    const put = (x, y, z, part) => vox.push({ x, y, z, color: '#888888', part });
    for (const s of [{ x0: 5, x1: 7, suf: 'L' }, { x0: 12, x1: 14, suf: 'R' }]) {
        for (let y = 0; y <= 3; y++) for (let x = s.x0; x <= s.x1; x++) for (let z = 8; z <= 10; z++) put(x, y, z, 'piede_' + s.suf);
        for (let y = 4; y <= 13; y++) for (let x = s.x0; x <= s.x1; x++) for (let z = 8; z <= 10; z++) put(x, y, z, 'gamba_' + s.suf);
    }
    for (let y = 14; y <= 17; y++) for (let x = 5; x <= 14; x++) for (let z = 8; z <= 10; z++) put(x, y, z, 'bacino');
    for (let y = 18; y <= 32; y++) for (let x = 5; x <= 14; x++) for (let z = 8; z <= 10; z++) put(x, y, z, 'torso');
    // La testa e' il ~13% dell'altezza: e' la proporzione che assumono le frazioni
    // di buildHumanoidSkeleton (headY = minY + 0.88*H). Con una testa "chibi" al
    // 21% le sue righe basse cadrebbero SOTTO la stazione `neck` e finirebbero
    // legittimamente su `chest`: sarebbe un difetto del manichino, non del rig.
    for (let y = 33; y <= 37; y++) for (let x = 7; x <= 12; x++) for (let z = 8; z <= 10; z++) put(x, y, z, 'testa');
    for (let x = 0; x <= 4; x++) for (let y = 26; y <= 28; y++) for (let z = 8; z <= 10; z++) put(x, y, z, 'braccio_L');
    for (let x = 15; x <= 19; x++) for (let y = 26; y <= 28; y++) for (let z = 8; z <= 10; z++) put(x, y, z, 'braccio_R');
    return vox;
}

// Costruisce lo scheletro, lega la pelle in modalita' "Pezzi" e restituisce gli
// strumenti per interrogare il risultato.
function bind(voxels) {
    const bones = api.buildHumanoidSkeleton(voxels).bones;
    api.setRig({ type: 'humanoid', bones, pose: {}, weights: null, binding: 'parts' });
    const res = api.bindSkin(voxels, bones, null, { binding: 'parts', hardness: 6 });
    const nameOf = i => bones[i] ? bones[i].name : '??';
    const hist = part => {
        const h = new Map();
        voxels.forEach((v, i) => {
            if (v.part !== part) return;
            const n = nameOf(res.primary[i]);
            h.set(n, (h.get(n) || 0) + 1);
        });
        return h;
    };
    return { bones, primary: res.primary, nameOf, hist };
}
const show = h => [...h.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => k + '=' + c).join(' ');
const sum = (h, names) => names.reduce((s, n) => s + (h.get(n) || 0), 0);

// =============================================================================
// A. Parti PER ARTO (il formato che l'utente deve produrre): ogni gamba viva.
// =============================================================================
console.log('\n[A] parti per arto');
{
    const voxels = dummyPerLimb();
    const { primary, nameOf, hist } = bind(voxels);
    for (const p of ['gamba_R', 'gamba_L', 'piede_R', 'piede_L']) {
        console.log('  ' + p.padEnd(9) + ': ' + show(hist(p)));
    }
    const legR = sum(hist('gamba_R'), ['upperLeg_R', 'lowerLeg_R', 'foot_R'])
        + sum(hist('piede_R'), ['upperLeg_R', 'lowerLeg_R', 'foot_R']);
    const legL = sum(hist('gamba_L'), ['upperLeg_L', 'lowerLeg_L', 'foot_L'])
        + sum(hist('piede_L'), ['upperLeg_L', 'lowerLeg_L', 'foot_L']);
    ok(legR > 0 && legL > 0,
        'entrambe le catene gambe ricevono voxel (R=' + legR + ' L=' + legL + ')');
    const ratio = Math.min(legR, legL) / Math.max(legR, legL, 1);
    ok(ratio > 0.6, 'le due gambe sono bilanciate (rapporto ' + ratio.toFixed(2) + ')');

    // Nessun voxel della gamba a X bassa (_L) deve finire su un osso _R e
    // viceversa: e' esattamente la saldatura che l'utente vedeva in camminata.
    let crossed = 0;
    voxels.forEach((v, i) => {
        if (!/^(gamba|piede)_/.test(v.part || '')) return;
        const n = nameOf(primary[i]);
        if (v.x <= 7 && n.endsWith('_R')) crossed++;
        if (v.x >= 12 && n.endsWith('_L')) crossed++;
    });
    ok(crossed === 0, 'nessun voxel di una gamba assegnato all\'osso dell\'altra (' + crossed + ' incrociati)');

    // Idem per le braccia: `braccio_L` sta a X bassa.
    let armX = 0;
    voxels.forEach((v, i) => {
        if (!/^braccio_/.test(v.part || '')) return;
        const n = nameOf(primary[i]);
        if (v.part === 'braccio_L' && n.endsWith('_R')) armX++;
        if (v.part === 'braccio_R' && n.endsWith('_L')) armX++;
    });
    ok(armX === 0, 'nessun voxel di un braccio sull\'osso del lato opposto (' + armX + ')');

    // La testa non deve tornare a spalmarsi sulle spalle (regressione del fix (g)).
    const ht = hist('testa');
    const headOnSpine = sum(ht, ['head', 'neck', 'headTip']);
    ok(headOnSpine === [...ht.values()].reduce((a, b) => a + b, 0),
        'la testa resta su neck/head, non sulle spalle: ' + [...ht.keys()].join(','));
}

// =============================================================================
// B. Parte SIMMETRICA su entrambe le gambe: niente coin flip su un lato solo.
//    Una parte cosi' non puo' alimentare due catene senza incrociare, quindi il
//    root sale all'antenato comune (`hips`/`spine`). Cio' che NON deve succedere
//    e' che finisca tutta su upperLeg_R o upperLeg_L: quella e' la saldatura.
// =============================================================================
console.log('\n[B] parte unica su entrambe le gambe (MIRROR_TIE)');
{
    const voxels = dummyPerLimb().map(v => (
        /^(gamba|piede)_/.test(v.part) ? { ...v, part: 'pantaloni' } : v
    ));
    const { hist } = bind(voxels);
    const h = hist('pantaloni');
    console.log('  istogramma pantaloni: ' + show(h));
    const onOneLeg = sum(h, ['upperLeg_R', 'lowerLeg_R', 'foot_R'])
        + sum(h, ['upperLeg_L', 'lowerLeg_L', 'foot_L']);
    ok(onOneLeg === 0,
        'la parte simmetrica NON si salda su una gamba sola (' + onOneLeg + ' voxel su ossa di gamba)');
    ok(sum(h, ['hips', 'spine']) > 0,
        'la parte simmetrica sale sull\'antenato comune: ' + [...h.keys()].join(','));
}

// --- diagnostica opzionale sul modello reale dell'utente ---------------------
// Non e' committato (sta sul Desktop): se manca, la suite passa lo stesso.
const REAL = process.env.VOXELAI_RIG_FIXTURE
    || 'C:/Users/FRANCY/Desktop/Tecnico_del_Video_TPose.json';
if (fs.existsSync(REAL)) {
    console.log('\n[C] modello reale');
    const expSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/utils/expand-ops.js'), 'latin1');
    const head = expSrc.indexOf('function expandOps');
    const expApi = new Function(expSrc.slice(head, expSrc.indexOf('// Render Model from currentModelData')) + `
     ;return {expandOps};`)();
    const data = JSON.parse(fs.readFileSync(REAL, 'utf8'));
    const flat = expApi.expandOps(JSON.parse(JSON.stringify(data)));
    const rv = flat.voxels;
    console.log('  ' + rv.length + ' voxel, parti: ' + [...new Set(rv.map(v => v.part))].join(','));
    // ATTENZIONE: head/tail devono restare ARRAY [x,y,z]. distSqToSegment legge
    // a[0]/a[1]/a[2]: passando {x,y,z} ogni costo diventa NaN, nessun confronto
    // e' vero e vince sempre il primo osso candidato (hips). Sembra un bug del
    // rig, e' un bug del test: gia' preso una volta.
    const rb = data.rig.bones.map(b => ({
        name: b.name, parent: b.parent,
        head: b.head.slice(), tail: b.tail.slice(),
        helper: b.helper || /Tip$/.test(b.name) || undefined,
    }));
    api.setRig({ type: 'humanoid', bones: rb, pose: {}, weights: null, binding: 'parts' });
    const r2 = api.bindSkin(rv, rb, null, { binding: 'parts', hardness: 6 });
    const nm = i => rb[i] ? rb[i].name : '??';
    const parts = [...new Set(rv.map(v => v.part))].filter(p => /_(R|L)$/.test(p || ''));
    for (const part of parts) {
        const h = new Map();
        rv.forEach((v, i) => { if (v.part !== part) return; const n = nm(r2.primary[i]); h.set(n, (h.get(n) || 0) + 1); });
        console.log('  ' + part.padEnd(10) + ': ' + show(h));
    }
    // Ogni parte lateralizzata deve restare sulla propria catena.
    let x = 0;
    rv.forEach((v, i) => {
        const p = v.part || '';
        if (!/_(R|L)$/.test(p)) return;
        const side = p.slice(-1), other = side === 'R' ? '_L' : '_R';
        if (nm(r2.primary[i]).endsWith(other)) x++;
    });
    ok(x === 0, 'nessun voxel assegnato a un osso del lato opposto (' + x + ')');
    const legVox = s => rv.filter((v, i) => /^(gamba|piede)_/.test(v.part || '') && nm(r2.primary[i]).endsWith('_' + s)).length;
    const R = legVox('R'), L = legVox('L');
    ok(R > 0 && L > 0, 'entrambe le gambe hanno voxel (R=' + R + ' L=' + L + ')');
} else {
    console.log('\n  --  modello reale assente, salto la diagnostica');
}

console.log(`\n${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
