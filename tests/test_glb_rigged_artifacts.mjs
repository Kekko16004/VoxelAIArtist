/*
 * Difende l'export GLB del modello RIGGATO da due difetti che in Blender si
 * vedevano solo su quel percorso (gli export statici uscivano bene):
 *
 *  1) FACCE INTERNE DOPPIE -> "linee che non esistono".
 *     `buildSkinnedMesh` tiene la faccia fra due voxel che si deformano in modo
 *     DIVERSO. A riposo quel confine e' interno al modello e i due voxel
 *     emettono ognuno la propria meta' nello stesso piano: due quad coplanari a
 *     distanza zero. Con materiali DoubleSide Blender li disegna entrambi ->
 *     z-fighting, cioe' triangoli a ombreggiatura alternata.
 *     Lo risolve FrontSide, NON la cull: le due meta' hanno orientamento
 *     OPPOSTO (una guarda in +X, l'altra in -X), quindi il backface culling ne
 *     disegna sempre e solo una. Misurato sul modello dell'utente: 1268 coppie
 *     coincidenti, 1268 fronte/retro, zero con lo stesso verso.
 *
 *  1b) GUSCIO APERTO IN POSA, se si "risolve" il punto 1 togliendo ENTRAMBE le
 *     meta'. A riposo la mesh sembra chiusa, perche' quei due quad erano sepolti
 *     e coincidenti; ma appena la posa separa le due ossa le meta' mancanti sono
 *     esattamente le PARETI della fessura, e con FrontSide si guarda dentro il
 *     modello vuoto. Misurato sul modello dell'utente: 0 spigoli di bordo a
 *     riposo e 936 sulla mesh POSATA, fessure fino a 55 mm (5.5 voxel), 7 zone
 *     passanti nel render. Da qui la regola attuale: in export la faccia si
 *     toglie SOLO fra voxel che si deformano IDENTICI (stessi 4 pesi sulle
 *     stesse ossa), perche' solo quella resta interna in ogni posa.
 *
 *  2) COLORE APPLICATO DUE VOLTE -> modello quasi nero.
 *     La geometria riggata porta sempre un attributo `color` (anteprima: colori
 *     per osso / rampa dei pesi) e il GLTFExporter r128 lo scrive in COLOR_0
 *     guardando LA GEOMETRIA, non `material.vertexColors`. In glTF vale
 *     baseColorFactor * COLOR_0, quindi lo stesso colore su entrambi da' il
 *     colore lineare al quadrato. L'export deve TOGLIERE l'attributo.
 *     Indizio che lo confermava: l'unico materiale giusto era #FFFFFF, perche'
 *     per il bianco l'exporter omette baseColorFactor.
 *
 * Il modulo e' un frammento di scope condiviso: si carica con new Function e
 * stub minimi di THREE/DOM, come tests/test_rig_weights.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const mkEl = () => ({
    textContent: '', innerHTML: '', value: '0', checked: false, disabled: false,
    style: {}, dataset: {}, title: '', children: [],
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, appendChild() { }, querySelectorAll: () => [],
    querySelector: () => null, remove() { },
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
global.scene = { add() { }, remove() { } };

class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    distanceTo() { return 10; }
    applyQuaternion() { return this; }
}
// Geometria che registra attributi e indici: e' l'oggetto su cui si misura.
class Geo {
    constructor() { this.attributes = {}; this.index = null; this.groups = []; }
    setAttribute(n, a) { this.attributes[n] = a; }
    getAttribute(n) { return this.attributes[n]; }
    deleteAttribute(n) { delete this.attributes[n]; return this; }
    // three avvolge un array grezzo in un BufferAttribute: si fa lo stesso, cosi'
    // `geo.index.array` esiste come nel vero three.
    setIndex(a) { this.index = Array.isArray(a) ? attr(a) : a; }
    addGroup(start, count, matIndex) { this.groups.push({ start, count, matIndex }); }
    dispose() { }
}
const attr = arr => ({ array: Array.from(arr), needsUpdate: false });
global.THREE = {
    Group: class { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.visible = true; } add(o) { this.children.push(o); } remove() { } },
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
    Color: class {
        constructor(hex) { this.r = 0; this.g = 0; this.b = 0; if (typeof hex === 'string') this.set(hex); }
        set(hex) {
            const h = String(hex).replace('#', '');
            this.r = parseInt(h.slice(0, 2), 16) / 255;
            this.g = parseInt(h.slice(2, 4), 16) / 255;
            this.b = parseInt(h.slice(4, 6), 16) / 255;
            return this;
        }
        setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
        setHSL() { return this; }
        convertSRGBToLinear() {
            const f = c => (c < 0.04045) ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
            this.r = f(this.r); this.g = f(this.g); this.b = f(this.b); return this;
        }
    },
    MathUtils: { degToRad: d => d * Math.PI / 180, radToDeg: r => r * 180 / Math.PI },
    BufferGeometry: Geo,
    Float32BufferAttribute: class { constructor(a, n) { return attr(a), Object.assign(attr(a), { itemSize: n }); } },
    Uint16BufferAttribute: class { constructor(a, n) { return Object.assign(attr(a), { itemSize: n }); } },
    MeshStandardMaterial: class { constructor(o) { Object.assign(this, { color: null, vertexColors: false, side: 0, metalness: 0, roughness: 1, name: '' }, o); this.userData = {}; } dispose() { } },
    SkinnedMesh: class { constructor(g, m) { this.geometry = g; this.material = m; this.position = new V3(); this.scale = new V3(1, 1, 1); this.userData = {}; this.name = ''; } add() { } bind() { } updateMatrixWorld() { } },
    Bone: class { constructor() { this.name = ''; this.position = new V3(); this.rotation = new V3(); this.quaternion = {}; this.userData = {}; this.children = []; } add(b) { this.children.push(b); } },
    Skeleton: class { constructor(b) { this.bones = b; } update() { } },
    FrontSide: 0,
    DoubleSide: 2,
};

const src = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/15-rig.js'), 'latin1');
const api = new Function(src + `
 ;return {buildHumanoidSkeleton, bindVoxels, buildSkinnedMesh,
          setRig:(r)=>{rig=r;}, bindSkin};`)();

// --- corpo sintetico: un braccio orizzontale attaccato al torso garantisce un
// confine fra ossa diverse, che e' esattamente dove nascevano i quad doppi ---
function humanBody() {
    const vox = [];
    const put = (x, y, z) => vox.push({ x, y, z, color: '#332211' });
    for (let y = 0; y <= 5; y++) for (let x = 6; x <= 9; x++) for (let z = 7; z <= 8; z++) put(x, y, z);
    for (let y = 6; y <= 14; y++) for (let x = 5; x <= 10; x++) for (let z = 7; z <= 8; z++) put(x, y, z);
    for (let y = 15; y <= 18; y++) for (let x = 6; x <= 9; x++) for (let z = 7; z <= 8; z++) put(x, y, z);
    for (let x = 0; x <= 4; x++) for (let z = 7; z <= 8; z++) put(x, 13, z);
    for (let x = 11; x <= 15; x++) for (let z = 7; z <= 8; z++) put(x, 13, z);
    return vox;
}

const voxels = humanBody();
const rigOut = api.buildHumanoidSkeleton(voxels);
api.setRig(rigOut);
const assign = api.bindVoxels(voxels, rigOut.bones);
const skin = api.bindSkin ? api.bindSkin(voxels, rigOut.bones, assign) : null;

const fmt = n => (Math.abs(n) < 1e-9 ? 0 : n).toFixed(4);
const pKey = (P, i) => `${fmt(P[i * 3])},${fmt(P[i * 3 + 1])},${fmt(P[i * 3 + 2])}`;
// Chiave di un quad: i suoi 4 vertici, ordinati. Due quad con la stessa chiave
// sono coplanari a distanza zero (il caso del punto 1).
const quadKey = pts => pts.slice().sort().join('|');

// Legge la geometria del modulo reale e la rilegge come quad: i due triangoli
// consecutivi che `buildSkinnedMesh` emette per ogni faccia.
function readQuads(geo) {
    const P = geo.attributes.position.array;
    const I = geo.index.array;
    const out = [];
    for (let k = 0; k + 5 < I.length; k += 6) {
        const idx = [I[k], I[k + 1], I[k + 2], I[k + 5]];
        const pts = idx.map(i => pKey(P, i));
        if (new Set(pts).size !== 4) continue;
        // Normale GEOMETRICA (prodotto vettoriale): e' quella che il
        // rasterizzatore usa per decidere fronte/retro, non l'attributo.
        const g = i => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
        const [a, b, c] = [g(idx[0]), g(idx[1]), g(idx[2])];
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        const L = Math.hypot(n[0], n[1], n[2]) || 1;
        out.push({ idx, pts, key: quadKey(pts), n: n.map(v => v / L) });
    }
    return out;
}

// Coppie di quad coincidenti, divise per verso. OPPOSTE = il backface culling
// ne disegna una sola (innocue). UGUALI = due facce sovrapposte visibili
// insieme, cioe' lo z-fighting di partenza.
function coincidentPairs(quads) {
    const byKey = new Map();
    for (const q of quads) {
        if (!byKey.has(q.key)) byKey.set(q.key, []);
        byKey.get(q.key).push(q);
    }
    let pairs = 0, opposite = 0, same = 0;
    byKey.forEach(list => {
        for (let a = 0; a < list.length; a++)
            for (let b = a + 1; b < list.length; b++) {
                pairs++;
                const d = list[a].n[0] * list[b].n[0] + list[a].n[1] * list[b].n[1] + list[a].n[2] * list[b].n[2];
                if (d < -0.99) opposite++; else same++;
            }
    });
    return { pairs, opposite, same, quads: quads.length };
}

// Spigoli di BORDO, cioe' i buchi. Non si possono contare a riposo saldando i
// vertici per posizione: le due meta' di una giunzione coincidono e un buco
// aperto sembrerebbe chiuso. Si saldano quindi i vertici che restano identici in
// OGNI posa: stessa posizione E stessi pesi. Su quella mesh, la superficie di
// ogni gruppo che si deforma insieme e' un solido chiuso, quindi ogni spigolo
// deve avere un numero PARI di facce (2, o 4 dove due voxel si toccano in
// diagonale). Uno spigolo con una faccia sola e' una fessura che si aprira'.
function openEdges(geo) {
    const P = geo.attributes.position.array;
    const SI = geo.attributes.skinIndex.array;
    const SW = geo.attributes.skinWeight.array;
    // Stessa quantizzazione di `deformsAlike` in 15-rig.js: i pesi sotto
    // WEIGHT_EPS contano come zero, gli altri a 1/65536.
    const wKey = i => {
        let s = '';
        for (let j = 0; j < 4; j++) {
            const w = SW[i * 4 + j];
            s += (w > 1e-4) ? `${SI[i * 4 + j]}:${Math.round(w * 65536)};` : '_;';
        }
        return s;
    };
    const vKey = i => pKey(P, i) + '#' + wKey(i);
    const edges = new Map();
    for (const q of readQuads(geo)) {
        const k = q.idx.map(vKey);
        for (let j = 0; j < 4; j++) {
            const e = [k[j], k[(j + 1) % 4]].sort().join('=');
            edges.set(e, (edges.get(e) || 0) + 1);
        }
    }
    let open = 0;
    edges.forEach(c => { if (c % 2 === 1) open++; });
    return open;
}

const mk = opts => api.buildSkinnedMesh(voxels, rigOut.bones, assign, skin, opts);

// --- 1. le facce coincidenti dell'export sono coppie FRONTE/RETRO ---------
// E' l'affermazione su cui poggia tutto: tenere le due meta' di una giunzione
// non ridà z-fighting perche' i materiali sono FrontSide e di due quad coplanari
// con normali opposte il backface culling ne disegna esattamente uno.
const exp = mk({ forExport: true });
const expQuads = readQuads(exp.mesh.geometry);
const expQ = coincidentPairs(expQuads);
ok(expQ.quads > 100, `geometria di export non banale (${expQ.quads} quad)`);
ok(expQ.pairs > 0,
    `export: le giunzioni sono tappate su ENTRAMBI i lati (${expQ.pairs} coppie coincidenti)`);
ok(expQ.same === 0,
    `export: ogni coppia coincidente e' fronte/retro (${expQ.opposite}/${expQ.pairs} opposte, ${expQ.same} con lo stesso verso)`);

// --- 1b. il guscio esportato e' CHIUSO anche quando la posa lo apre --------
// Il difetto vero: a riposo era chiuso, in posa aveva 936 spigoli di bordo.
ok(openEdges(exp.mesh.geometry) === 0,
    `export: nessuno spigolo di bordo sulla mesh saldata per deformazione (buchi in posa)`);
// Che il controllo abbia i denti lo prova l'ANTEPRIMA, che toglie le facce fra
// voxel con lo stesso osso dominante ma pesi diversi: quelle si aprono in posa.
// E' accettabile a schermo (DoubleSide mostra la parete di fondo), non in export.
const prev = mk({});
const prevOpen = openEdges(prev.mesh.geometry);
ok(prevOpen > 0,
    `il controllo dei bordi distingue davvero i due gusci (anteprima: ${prevOpen} spigoli aperti)`);

// --- 2. l'ANTEPRIMA tiene il bordo fra ossa del weight paint --------------
// Questo e' anche il controllo che il fix non sia un `continue` indiscriminato.
const prevQ = coincidentPairs(readQuads(prev.mesh.geometry));
ok(prevQ.pairs > 0,
    `anteprima: il bordo fra ossa resta visibile (${prevQ.pairs} quad condivisi, servono al weight paint)`);
// L'export non e' un rebuild ingenuo: la cull c'e' ancora, e il conto torna
// esattamente. Ogni faccia interna per sempre risparmia DUE quad (una meta' per
// voxel), quindi quad = 6*voxel - 2*interne. La verifica del rapporto la fa il
// modello reale, non questo corpo di prova: qui il torso e' spesso 2 voxel,
// quindi quasi ogni faccia condivisa e' una giunzione (misurato sul modello
// dell'utente, binding 'parts': 11610 quad su 50543 facce condivise).
const fullCount = voxels.length * 6;

// --- 2b. la regola esatta, faccia per faccia ------------------------------
// Per ogni coppia di voxel adiacenti: 2 quad se si deformano diversamente
// (giunzione tappata da entrambi i lati), 0 se si deformano identici (interna
// per sempre). Mai 1: quello e' il guscio aperto.
const SIx = exp.mesh.geometry.attributes.skinIndex.array;
const SWx = exp.mesh.geometry.attributes.skinWeight.array;
const wsig = i => {
    let s = '';
    for (let j = 0; j < 4; j++) {
        const w = skin ? skin.weights[i * 4 + j] : (j === 0 ? 1 : 0);
        const b = skin ? skin.indices[i * 4 + j] : assign[i];
        s += (w > 1e-4) ? `${b}:${Math.round(w * 65536)};` : '_;';
    }
    return s;
};
const atCell = new Map(voxels.map((v, i) => [`${v.x},${v.y},${v.z}`, i]));
const perKey = new Map();
for (const q of expQuads) perKey.set(q.key, (perKey.get(q.key) || 0) + 1);
let junctions = 0, internals = 0, wrong = 0;
for (let i = 0; i < voxels.length; i++) {
    const v = voxels[i];
    for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        const j = atCell.get(`${v.x + dx},${v.y + dy},${v.z + dz}`);
        if (j === undefined) continue;
        // I 4 angoli della faccia condivisa, nelle stesse coordinate della mesh.
        const c = [];
        const fixed = [v.x + dx * 0.5, v.y + dy * 0.5, v.z + dz * 0.5];
        const ax = dx ? 1 : 0, bx = dz ? 1 : 2;   // i due assi liberi
        for (const [sa, sb] of [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]]) {
            const p = fixed.slice();
            p[ax] += sa; p[bx] += sb;
            c.push(`${fmt(p[0])},${fmt(p[1])},${fmt(p[2])}`);
        }
        const got = perKey.get(quadKey(c)) || 0;
        const alike = wsig(i) === wsig(j);
        if (alike) { internals++; if (got !== 0) wrong++; }
        else { junctions++; if (got !== 2) wrong++; }
    }
}
ok(junctions > 0 && internals > 0,
    `il caso di prova ha sia giunzioni (${junctions}) sia facce interne per sempre (${internals})`);
ok(wrong === 0,
    `export: 2 quad su ogni giunzione, 0 sulle facce interne (${wrong} facce fuori regola)`);
ok(expQ.quads === fullCount - 2 * internals,
    `export: la cull interna lavora ancora, ${2 * internals} quad in meno del pieno (${expQ.quads} = ${fullCount} - 2x${internals})`);

// --- 3. modello PIENO: le facce fra cubi adiacenti sono VOLUTE ------------
const full = mk({ forExport: true, allFaces: true });
const fullQ = coincidentPairs(readQuads(full.mesh.geometry));
ok(fullQ.quads === fullCount,
    `pieno: 6 facce per voxel (${fullQ.quads} = ${voxels.length}x6)`);

// --- 3b. NESSUN GRUPPO VUOTO -> niente primitiva senza `indices` -----------
// Un colore usato SOLO da voxel interni (tutti e 6 i vicini occupati) non
// emette nemmeno una faccia nel guscio: il suo gruppo esce con count 0. Il
// GLTFExporter r128 chiama processAccessor per quel range, che restituisce
// null ("Skip creating an accessor if the attribute doesn't have data"), e poi
// fa `delete primitive.indices`. Per la specifica glTF una primitiva SENZA
// indices va disegnata prendendo i vertici in sequenza: l'intero buffer del
// modello (36296 vertici) letto a triple arbitrarie. Misurato sul modello
// dell'utente: 12098 triangoli fantasma, 3265 piu' larghi di 2 voxel e 51 con
// un lato fino a 0.90 m, cioe' l'altezza intera del personaggio. Sono le
// "linee strane" che attraversano la mesh e, essendo triangoli enormi in un
// materiale scuro (#2D2D35) che ombreggiano contro la luce, anche le macchie
// che facevano sembrare i colori sbagliati.
// Il modello dell'utente ne aveva UNO su 31 colori; anche un modello statico
// semplice come Pressure_Plate ha un colore interno (#06D6A0, 4 voxel).
function internalColorBody() {
    const vox = humanBody();
    // Il torso e' spesso 6x9x2: niente di interno. Si ispessisce una fetta e si
    // colora d'altro il cubo centrale, che resta cosi' completamente sepolto.
    for (let y = 9; y <= 11; y++)
        for (let x = 6; x <= 8; x++)
            for (let z = 5; z <= 10; z++)
                if (!vox.some(v => v.x === x && v.y === y && v.z === z))
                    vox.push({ x, y, z, color: '#332211' });
    const buried = vox.find(v => v.x === 7 && v.y === 10 && v.z === 7);
    buried.color = '#2D2D35';
    return { vox, buried };
}

const { vox: intVox, buried } = internalColorBody();
const occupied = new Set(intVox.map(v => `${v.x},${v.y},${v.z}`));
const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
ok(NB.every(n => occupied.has(`${buried.x + n[0]},${buried.y + n[1]},${buried.z + n[2]}`)),
    'il caso di prova ha davvero un voxel completamente interno (colore #2D2D35)');

const intRig = api.buildHumanoidSkeleton(intVox);
api.setRig(intRig);
const intAssign = api.bindVoxels(intVox, intRig.bones);
const intSkin = api.bindSkin ? api.bindSkin(intVox, intRig.bones, intAssign) : null;
const intExp = api.buildSkinnedMesh(intVox, intRig.bones, intAssign, intSkin, { forExport: true });
const intGroups = intExp.mesh.geometry.groups;
const emptyGroups = intGroups.filter(g => g.count === 0);
ok(emptyGroups.length === 0,
    `export: nessun gruppo con count 0 (trovati ${emptyGroups.length}; ognuno diventa una primitiva senza indices)`);
const intMats = Array.isArray(intExp.mesh.material) ? intExp.mesh.material : [intExp.mesh.material];
ok(intGroups.every(g => g.matIndex >= 0 && g.matIndex < intMats.length),
    'export: ogni gruppo punta a un materiale esistente');
// Con i pesi lisci il voxel sepolto NON e' piu' senza facce: si deforma diverso
// dai vicini, quindi emette i suoi tappi ed e' giusto che abbia un materiale.
// Il caso "colore davvero senza nemmeno una faccia" esiste ancora e va coperto:
// lo si ottiene con voxel che si deformano tutti identici (binding rigido a un
// osso solo, che e' anche cio' che fa un rig con `binding:'rigid'`).
const rigidAssign = new Int32Array(intVox.length);   // tutti sull'osso 0
const intRigid = api.buildSkinnedMesh(intVox, intRig.bones, rigidAssign, null, { forExport: true });
const rigidMats = Array.isArray(intRigid.mesh.material) ? intRigid.mesh.material : [intRigid.mesh.material];
ok(intRigid.mesh.geometry.groups.every(g => g.count > 0),
    `export rigido: nessun gruppo con count 0 (trovati ${intRigid.mesh.geometry.groups.filter(g => g.count === 0).length})`);
ok(!rigidMats.some(m => m.userData.hexColor === '#2D2D35'),
    'export rigido: il colore senza nemmeno una faccia non porta con se un materiale orfano');
// L'ANTEPRIMA non deve perdere nulla: quel voxel interno si vede in weight paint
// perche' il bordo fra ossa diverse resta.
const intPrev = api.buildSkinnedMesh(intVox, intRig.bones, intAssign, intSkin, {});
ok(intPrev.mesh.geometry.groups.every(g => g.count > 0),
    'anteprima: nemmeno qui restano gruppi vuoti');
// Rimette il rig del corpo base per non influenzare i controlli successivi.
api.setRig(rigOut);

// --- 4. la geometria riggata PORTA l'attributo color ----------------------
// Se un giorno smettesse di portarlo, il test 5 diventerebbe vacuo.
ok(!!exp.mesh.geometry.attributes.color,
    'la geometria riggata porta l\'attributo color (COLOR_0 se non rimosso)');

// --- 5. l'export GLB rimuove color e non usa DoubleSide -------------------
// Si legge il modulo di export: il ramo riggato deve togliere l'attributo,
// perche' l'exporter r128 guarda la geometria e non material.vertexColors.
const glbSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/16-export-glb.js'), 'latin1');
ok(/deleteAttribute\(\s*['"]color['"]\s*\)/.test(glbSrc),
    'export GLB: l\'attributo color viene rimosso (niente baseColorFactor * COLOR_0)');
ok(!/side:\s*THREE\.DoubleSide/.test(glbSrc) && !/\.side\s*=\s*THREE\.DoubleSide/.test(glbSrc),
    'export GLB: nessun materiale DoubleSide (il backface culling copre le facce interne)');
ok(/m\.side\s*=\s*THREE\.FrontSide/.test(glbSrc),
    'export GLB riggato: i materiali passano a FrontSide');

console.log(`\n${fail ? 'FALLITI' : 'OK'}: ${pass} controlli passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
