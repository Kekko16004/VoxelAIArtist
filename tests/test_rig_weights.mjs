/*
 * Verifica la LOGICA DI BINDING del rig (ui/src/lib/15-rig.js) senza browser:
 *   - lo scheletro semplificato non ha piu' le stub `pelvis_L/R` ne' `upperChest`;
 *   - le ossa-punta (helper) NON ricevono voxel: prima un handTip si rubava le dita
 *     producendo un osso che deforma la mesh ma che nessuna clip anima;
 *   - il passo di coerenza elimina i voxel isolati assegnati all'osso sbagliato
 *     (sono quelli che si strappano in Blender quando l'osso ruota);
 *   - le sovrascritture manuali del weight paint vincono sull'automatico, si
 *     ignorano se citano un osso inesistente e vengono ripulite se il voxel muore.
 *
 * Il modulo e' un frammento di scope condiviso: si carica con new Function e stub
 * minimi di THREE/DOM, come fa tests/test_incremental.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// --- stub DOM: un elemento permissivo basta, qui non si testa la UI ---
const mkEl = () => {
    const el = {
        textContent: '', innerHTML: '', value: '0', checked: false, disabled: false,
        style: {}, dataset: {}, title: '', children: [],
        classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
        addEventListener() { }, appendChild(c) { this.children.push(c); },
        querySelectorAll: () => [], querySelector: () => null, remove() { },
    };
    return el;
};
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

// --- stub Three.js minimo (solo cio' che tocca il caricamento del modulo) ---
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
    // Il gizmo ha molti metodi (setSize/setMode/setSpace/attach/...): un proxy
    // permissivo evita di inseguirli uno a uno a ogni modifica del rig.
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
 ;return {buildHumanoidSkeleton, bindVoxels, boneCost, applyWeightOverrides,
          setRig:(r)=>{rig=r;}, getRig:()=>rig, pruneWeightOverrides};`)();

// --- corpo umanoide sintetico: torso pieno, due braccia, due gambe, testa ---
function humanBody() {
    const vox = [];
    const put = (x, y, z) => vox.push({ x, y, z, color: '#888888' });
    for (let y = 0; y <= 5; y++) for (let x = 6; x <= 9; x++) for (let z = 7; z <= 8; z++) put(x, y, z);      // gambe/bacino
    for (let y = 6; y <= 14; y++) for (let x = 5; x <= 10; x++) for (let z = 7; z <= 8; z++) put(x, y, z);    // torso
    for (let y = 15; y <= 18; y++) for (let x = 6; x <= 9; x++) for (let z = 7; z <= 8; z++) put(x, y, z);    // testa
    for (let x = 0; x <= 4; x++) for (let z = 7; z <= 8; z++) put(x, 13, z);                                  // braccio dx (x basso)
    for (let x = 11; x <= 15; x++) for (let z = 7; z <= 8; z++) put(x, 13, z);                                // braccio sx
    return vox;
}

const voxels = humanBody();
const rigOut = api.buildHumanoidSkeleton(voxels);
const bones = rigOut.bones;
const names = bones.map(b => b.name);

ok(!names.some(n => n.startsWith('pelvis')), 'nessun osso pelvis_L/R (stub dell\'inguine rimosse)');
ok(!names.includes('upperChest'), 'upperChest fuso in chest');
ok(['hips', 'spine', 'chest', 'neck', 'head'].every(n => names.includes(n)), 'colonna base presente');
ok(['upperLeg_L', 'lowerLeg_L', 'foot_L', 'upperArm_R', 'forearm_R', 'hand_R'].every(n => names.includes(n)),
    'arti standard presenti');
const legL = bones.find(b => b.name === 'upperLeg_L');
ok(bones[legL.parent].name === 'hips', 'le gambe si attaccano direttamente a hips');
const helpers = bones.filter(b => b.helper).map(b => b.name);
ok(helpers.length === 5 && helpers.every(n => n.includes('Tip')), 'le 5 ossa-punta sono marcate helper: ' + helpers.join(','));
const selectable = bones.filter(b => !b.helper).length;
ok(selectable === 19, 'ossa selezionabili = 19 (trovate ' + selectable + ')');

api.setRig({ type: 'humanoid', bones, pose: {}, weights: null });
const assign = api.bindVoxels(voxels, bones, null);
ok(assign.length === voxels.length, 'un\'assegnazione per voxel');
const helperIdx = new Set(bones.map((b, i) => b.helper ? i : -1).filter(i => i >= 0));
ok(![...assign].some(a => helperIdx.has(a)), 'nessun voxel assegnato a un osso helper');

// Ogni osso non-helper delle catene animate dovrebbe avere almeno un voxel: un osso
// vuoto ruota senza muovere nulla (l'utente crede che il rig sia rotto).
const used = new Set(assign);
const orphans = bones.map((b, i) => (!b.helper && !used.has(i)) ? b.name : null).filter(Boolean);
ok(orphans.length <= 4, 'pochi ossa senza voxel su un manichino grezzo: ' + (orphans.join(',') || 'nessuno'));

// Lato: _R sta a x ALTA e _L a x bassa (armXR = cx + 0.32W). I voxel del braccio a
// x bassa devono quindi finire su ossa _L, mai su _R: e' la penalita' di lato in
// boneCost che lo garantisce, senza di essa la mano destra si prendeva pezzi del
// braccio sinistro.
const armLeft = voxels.map((v, i) => (v.y === 13 && v.x <= 2) ? assign[i] : -1).filter(i => i >= 0);
ok(armLeft.length > 0 && armLeft.every(i => bones[i].name.endsWith('_L')),
    'il braccio a x bassa resta sulle ossa _L (' + [...new Set(armLeft.map(i => bones[i].name))].join(',') + ')');

// --- coerenza: un voxel isolato con l'osso sbagliato viene riassorbito ---
{
    const a2 = api.bindVoxels(voxels, bones, null);
    // Cerca un voxel interno al torso e verifica che condivida l'osso con la maggioranza
    // dei vicini: e' esattamente cio' che smoothAssignments garantisce.
    const idx = new Map();
    voxels.forEach((v, i) => idx.set(v.x + ',' + v.y + ',' + v.z, i));
    const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    let isolated = 0, interior = 0;
    voxels.forEach((v, i) => {
        let neigh = 0, same = 0;
        N.forEach(o => {
            const k = idx.get((v.x + o[0]) + ',' + (v.y + o[1]) + ',' + (v.z + o[2]));
            if (k === undefined) return;
            neigh++; if (a2[k] === a2[i]) same++;
        });
        if (neigh < 5) return;
        interior++;
        if (same === 0) isolated++;
    });
    ok(interior > 50, 'il manichino ha voxel interni da controllare (' + interior + ')');
    ok(isolated === 0, 'nessun voxel interno isolato su un osso diverso da TUTTI i vicini (' + isolated + ')');
}

// --- sovrascritture manuali (weight paint) ---
{
    const v0 = voxels[0];
    const key = v0.x + ',' + v0.y + ',' + v0.z;
    const target = bones.findIndex(b => b.name === 'hand_L');
    const w = {}; w[key] = 'hand_L';
    const a3 = api.bindVoxels(voxels, bones, w);
    ok(a3[0] === target, 'la sovrascrittura manuale vince sull\'automatico');

    const a4 = api.bindVoxels(voxels, bones, { [key]: 'osso_inesistente' });
    ok(a4[0] === assign[0], 'una sovrascrittura che cita un osso inesistente viene ignorata');

    // prune: chiave che punta a un voxel cancellato
    api.setRig({ type: 'humanoid', bones, pose: {}, weights: { [key]: 'hand_L', '999,999,999': 'hips' } });
    api.pruneWeightOverrides(voxels);
    const wl = api.getRig().weights;
    ok(wl && wl[key] === 'hand_L' && wl['999,999,999'] === undefined, 'prune butta le chiavi orfane e tiene quelle vive');

    api.setRig({ type: 'humanoid', bones, pose: {}, weights: { '999,999,999': 'hips' } });
    api.pruneWeightOverrides(voxels);
    ok(api.getRig().weights === null, 'weights svuotato del tutto -> null (niente chiave morta nel salvataggio)');
}

console.log(fail ? `\nFALLITI: ${fail} (pass=${pass})` : `\nTUTTI I TEST PASSATI  (pass=${pass})`);
process.exit(fail ? 1 : 0);
