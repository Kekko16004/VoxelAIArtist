/*
 * Export GLB con i MATERIALI TEXTURIZZATI, statico e riggato.
 *
 * Un voxel puo' portare un `material` (id di metadata.materials) accanto al suo
 * `color`. Nell'export questo cambia tre cose, e ognuna e' un modo diverso di
 * sbagliare:
 *
 *  1) IL RAGGRUPPAMENTO. Le facce si raggruppavano per `v.color`, ma due voxel
 *     dello stesso colore con materiali diversi vogliono DUE materiali glTF
 *     distinti (uno con la texture, uno senza). Raggruppando per colore il
 *     secondo eredita il materiale del primo e la texture finisce dove non
 *     doveva. La chiave giusta e' `tokenOf(v)`.
 *
 *  2) GLI UV. `buildStaticExportMesh` e `buildSkinnedMesh` costruiscono i quad a
 *     mano ed emettevano solo `position` e `normal`. Senza l'attributo `uv` una
 *     `map` in glTF non ha coordinate: la texture non si vede (o si campiona
 *     tutta nello stesso pixel). Le facce del cubo hanno winding coerente,
 *     quindi lo stesso quadrato UV unitario vale per tutte e 6.
 *
 *  3) IL COLORE CHE SI MOLTIPLICA DUE VOLTE. In glTF il colore finale e'
 *     baseColorFactor * texture: col `map` il fattore deve restare BIANCO. E'
 *     la stessa trappola dell'invariante 6 del CLAUDE.md (COLOR_0), che qui
 *     resta valida e viene ricontrollata: la texture NON sostituisce la
 *     rimozione dell'attributo `color` dalla geometria riggata.
 *
 *  4) L'ORFANO. `decodeToken(tok, fallbackColor)` vuole il colore VERO del
 *     voxel come secondo argomento: su un id che non esiste piu' ricade su
 *     quello. Chi lo omette esporta quei voxel in grigio neutro invece che
 *     nella loro tinta. Qui c'e' un voxel con un id inesistente apposta.
 *
 * I moduli sono frammenti di UNO scope condiviso: si caricano con new Function
 * e stub minimi di THREE/DOM, come tests/test_glb_rigged_artifacts.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- stub DOM ------------------------------------------------------------
// I download avvenuti: un <a>.click() e' l'unico segno osservabile che il file
// e' davvero uscito. Serve al gruppo D, dove il difetto era proprio un export
// che spariva in silenzio.
const downloads = [];
const mkEl = () => ({
    textContent: '', innerHTML: '', value: '0', checked: false, disabled: false,
    style: {}, dataset: {}, title: '', children: [], href: '', download: '',
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, appendChild(c) { this.children.push(c); },
    querySelectorAll: () => [], querySelector: () => null, remove() { },
    click() { if (this.download) downloads.push(this.download); },
});
global.document = { getElementById: () => mkEl(), createElement: mkEl, addEventListener() { } };
global.window = { addEventListener() { } };
const alerts = [];
global.alert = (m) => { alerts.push(m); };
global.requestRender = () => { };
global.updateHistoryButtons = () => { };
global.pushHistory = () => { };
global.undoStack = [];
global.modelPivot = { visible: true };
global.gizmoEnabled = false;
global.updateGizmo = () => { };
global.buildModel = () => { };
global.renderer = { domElement: mkEl(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) };
global.camera = { fov: 45, position: { distanceTo: () => 10 }, getWorldDirection: v => v };
global.controls = { addEventListener() { } };
global.scene = { add() { }, remove() { } };
global.t = k => k;
global.voxelGap = { value: '0' };
global.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() { } };
global.Blob = global.Blob || class { constructor(p) { this.parts = p; } };
global.currentModelData = { metadata: {}, voxels: [] };

// --- stub THREE ----------------------------------------------------------
class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    distanceTo() { return 10; }
    applyQuaternion() { return this; }
}
class Quat {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    invert() { return this; } multiply() { return this; } setFromEuler() { return this; }
}
class Col {
    constructor(hex) { this.r = 0; this.g = 0; this.b = 0; if (typeof hex === 'string') this.set(hex); else if (typeof hex === 'number') this.setHex(hex); }
    set(hex) {
        if (typeof hex === 'number') return this.setHex(hex);
        const h = String(hex).replace('#', '');
        this.r = parseInt(h.slice(0, 2), 16) / 255;
        this.g = parseInt(h.slice(2, 4), 16) / 255;
        this.b = parseInt(h.slice(4, 6), 16) / 255;
        return this;
    }
    setHex(n) { this.r = ((n >> 16) & 255) / 255; this.g = ((n >> 8) & 255) / 255; this.b = (n & 255) / 255; return this; }
    setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
    setHSL() { return this; }
    clone() { const c = new Col(); c.r = this.r; c.g = this.g; c.b = this.b; return c; }
    convertSRGBToLinear() {
        const f = c => (c < 0.04045) ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
        this.r = f(this.r); this.g = f(this.g); this.b = f(this.b); return this;
    }
}
const linear = hex => new Col(hex).convertSRGBToLinear();
const attr = (arr, n) => ({ array: Array.from(arr), itemSize: n, needsUpdate: false });
class Geo {
    constructor() { this.attributes = {}; this.index = null; this.groups = []; }
    setAttribute(n, a) { this.attributes[n] = a; }
    getAttribute(n) { return this.attributes[n]; }
    deleteAttribute(n) { delete this.attributes[n]; return this; }
    setIndex(a) { this.index = Array.isArray(a) ? attr(a, 1) : a; }
    addGroup(start, count, matIndex) { this.groups.push({ start, count, matIndex }); }
    dispose() { this.disposed = true; }
}
// Le texture caricate dallo stub, per poter verificare che l'export ASPETTI il
// decode prima di chiamare l'exporter (un'immagine a width 0 finisce nel GLB
// come un canvas 0x0, cioe' una texture vuota).
const texLoads = [];
class TextureLoaderStub {
    load(url, onLoad, onProgress, onError) {
        const tex = {
            url, magFilter: null, minFilter: null, wrapS: null, wrapT: null,
            name: '', loaded: false, userData: {}, dispose() { this.disposed = true; },
        };
        const rec = {
            tex,
            // Il vero loader popola `image` col bitmap decodificato: e' quello che
            // il GLTFExporter misura per dimensionare il canvas.
            settle: () => { tex.loaded = true; tex.image = { width: 8, height: 8 }; if (onLoad) onLoad(tex); },
            // Come il vero TextureLoader su un'immagine illeggibile: `image` resta
            // undefined e chiama onError. E' il caso che faceva morire l'export in
            // silenzio.
            reject: () => { tex.loaded = true; if (onError) onError(new Error('decode fallito')); },
        };
        texLoads.push(rec);
        return tex;
    }
}
const parsedRoots = [];
global.THREE = {
    Group: class { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.scale = new V3(1, 1, 1); this.visible = true; this.name = ''; } add(o) { this.children.push(o); } remove() { } updateMatrixWorld() { } },
    Object3D: class { constructor() { this.position = new V3(); this.rotation = new V3(); this.quaternion = new Quat(); this.scale = new V3(1, 1, 1); this.visible = true; this.userData = {}; } add() { } updateMatrix() { } },
    Mesh: class { constructor(g, m) { this.geometry = g; this.material = m; this.position = new V3(); this.scale = new V3(1, 1, 1); this.name = ''; this.userData = {}; } add() { } updateMatrixWorld() { } },
    Vector3: V3, Quaternion: Quat,
    Euler: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } setFromQuaternion() { return this; } },
    TransformControls: class {
        constructor() {
            return new Proxy({ visible: false, enabled: true, object: null, mode: 'rotate' }, {
                get(t, k) { return (k in t) ? t[k] : () => { }; }, set(t, k, v) { t[k] = v; return true; },
            });
        }
    },
    Color: Col,
    MathUtils: { degToRad: d => d * Math.PI / 180, radToDeg: r => r * 180 / Math.PI },
    BufferGeometry: Geo,
    Float32BufferAttribute: class { constructor(a, n) { return attr(a, n); } },
    Uint16BufferAttribute: class { constructor(a, n) { return attr(a, n); } },
    // Come nel vero three, `color` e' SEMPRE un Color: passare 0xffffff nelle
    // opzioni non deve lasciare un numero, o `m.color.set(...)` in exportGLB
    // esploderebbe solo nel test e non nel browser.
    MeshStandardMaterial: class {
        constructor(o) {
            Object.assign(this, { map: null, emissive: null, emissiveIntensity: 1, vertexColors: false, side: -1, metalness: 0, roughness: 1, name: '' }, o);
            this.color = (o && o.color instanceof Col) ? o.color : new Col((o && o.color !== undefined) ? o.color : 0xffffff);
            this.userData = {};
        }
        dispose() { this.disposed = true; }
    },
    SkinnedMesh: class { constructor(g, m) { this.geometry = g; this.material = m; this.position = new V3(); this.scale = new V3(1, 1, 1); this.userData = {}; this.name = ''; } add() { } bind() { } updateMatrixWorld() { } },
    Bone: class { constructor() { this.name = ''; this.position = new V3(); this.rotation = { set() { return this; }, x: 0, y: 0, z: 0 }; this.quaternion = new Quat(); this.userData = {}; this.children = []; } add(b) { this.children.push(b); } },
    Skeleton: class { constructor(b) { this.bones = b; } update() { } },
    TextureLoader: TextureLoaderStub,
    QuaternionKeyframeTrack: class { constructor(n, t, v) { this.name = n; this.times = t; this.values = v; } },
    VectorKeyframeTrack: class { constructor(n, t, v) { this.name = n; this.times = t; this.values = v; } },
    AnimationClip: class { constructor(n, d, tr) { this.name = n; this.duration = d; this.tracks = tr; } },
    GLTFExporter: class {
        parse(root, onDone) {
            // I materiali stanno sul root quando e' una SkinnedMesh (export riggato)
            // e sui FIGLI quando e' un Group (export statico): guardare solo il root
            // renderebbe lo stub cieco sul percorso statico.
            const matsOf = o => !o || !o.material ? []
                : (Array.isArray(o.material) ? o.material : [o.material]);
            const mats = matsOf(root);
            const allMats = mats.concat(...(root.children || []).map(matsOf));
            // Fotografa lo STATO al momento della parse: e' l'unico istante che
            // conta, e le texture non ancora decodificate si vedono solo qui.
            parsedRoots.push({
                root,
                mats,
                hasColorAttr: !!(root.geometry && root.geometry.attributes && root.geometry.attributes.color),
                pending: texLoads.filter(r => !r.tex.loaded).length,
            });
            // Come il vero GLTFExporter r128: per incorporare l'immagine la
            // disegna su un canvas dimensionato su `image.width`. Su una texture
            // che non si e' decodificata `image` e' undefined e SOLLEVA. Il
            // criterio e' l'assenza di `image`, non un marcatore nostro: se
            // dipendesse da qualcosa che aggiunge il codice sotto esame, il
            // controllo non potrebbe mai vedere il difetto.
            allMats.forEach(m => {
                if (m && m.map && !(m.map.image && m.map.image.width)) {
                    throw new TypeError("Cannot read properties of undefined (reading 'width')");
                }
            });
            onDone(new ArrayBuffer(8));
        }
    },
    NearestFilter: 1003,
    RepeatWrapping: 1000,
    FrontSide: 0,
    DoubleSide: 2,
};

const read = p => fs.readFileSync(path.join(REPO_ROOT, p), 'latin1');
const matSrc = read('ui/src/lib/36-materials.js');
const rigSrc = read('ui/src/lib/15-rig.js');
const glbSrc = read('ui/src/lib/16-export-glb.js');

// ===== dati di prova =====================================================
// Quattro voxel ISOLATI (nessuno si tocca), cosi' ognuno emette tutte e 6 le
// facce e i conti sui quad sono esatti.
const TEX_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const MATERIALS = [
    { id: 'm1', name: 'Legno', color: '#8B5A2B', roughness: 0.9, metalness: 0.1, emissive: 0, texture: { data: TEX_PNG, w: 8, h: 8 } },
    { id: 'm2', name: 'Lampada', color: '#204060', roughness: 0.2, metalness: 0.8, emissive: 0.5, texture: null },
];
const VOXELS = [
    { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1' },   // texturizzato
    { x: 4, y: 0, z: 0, color: '#8B5A2B' },                   // STESSO colore, senza materiale
    { x: 8, y: 0, z: 0, color: '#112233', material: 'm9' },   // id ORFANO
    { x: 12, y: 0, z: 0, color: '#204060', material: 'm2' },  // materiale senza texture
];
const freshModel = () => ({
    metadata: { name: 'Prova', materials: MATERIALS.map(m => ({ ...m })) },
    voxels: VOXELS.map(v => ({ ...v })),
});

// ===== A. percorso STATICO ===============================================
console.log('== statico: un materiale per TOKEN, con UV e texture ==');
global.currentModelData = freshModel();
const statApi = new Function(matSrc + '\n' + glbSrc + `
 ;return { buildStaticExportMesh };`)();

const group = statApi.buildStaticExportMesh(1);
const mesh = group.children[0];
const mats = mesh.material;
const geo = mesh.geometry;

ok(mats.length === 4,
    `un materiale per token, non per colore (${mats.length} materiali per 4 token: '@m1', '#8B5A2B', '@m9', '@m2')`);

const byName = {};
mats.forEach(m => { byName[m.name] = m; });
ok(!!byName['@m1'] && !!byName['#8B5A2B'] && !!byName['@m9'] && !!byName['@m2'],
    `i materiali sono nominati col token (${mats.map(m => m.name).join(' ')})`);

// --- UV -----------------------------------------------------------------
const P = geo.attributes.position, UV = geo.attributes.uv;
ok(!!UV, 'la geometria statica porta l\'attributo uv');
if (UV) {
    ok(UV.itemSize === 2 && UV.array.length === (P.array.length / 3) * 2,
        `un uv per vertice (${UV.array.length} valori per ${P.array.length / 3} vertici)`);
    ok(UV.array.every(v => v === 0 || v === 1),
        'gli uv stanno sul quadrato unitario (voxel: una ripetizione per faccia)');
    // Ogni quad (4 vertici consecutivi) deve coprire i 4 angoli, non 4 volte lo
    // stesso: e' la differenza fra "texture visibile" e "un pixel spalmato".
    let badQuads = 0;
    for (let i = 0; i + 7 < UV.array.length; i += 8) {
        const corners = new Set();
        for (let k = 0; k < 4; k++) corners.add(UV.array[i + k * 2] + ',' + UV.array[i + k * 2 + 1]);
        if (corners.size !== 4) badQuads++;
    }
    ok(badQuads === 0, `ogni faccia copre i 4 angoli del quadrato UV (${badQuads} facce degeneri)`);
    ok(UV.array.length / 2 === VOXELS.length * 6 * 4,
        `${VOXELS.length}x6 facce x4 vertici (${UV.array.length / 2} uv)`);
}

// --- materiale texturizzato ---------------------------------------------
const m1 = byName['@m1'];
if (m1) {
    ok(!!m1.map, 'il materiale texturizzato porta una map');
    ok(m1.map && m1.map.url === TEX_PNG, 'la map e\' la data URL della texture del materiale');
    ok(m1.map && m1.map.magFilter === THREE.NearestFilter && m1.map.minFilter === THREE.NearestFilter,
        'la texture e\' a NearestFilter (voxel art: nessuna interpolazione)');
    ok(m1.color && near(m1.color.r, 1) && near(m1.color.g, 1) && near(m1.color.b, 1),
        'col map il baseColorFactor resta BIANCO (in glTF si moltiplica per la texture)');
    ok(near(m1.roughness, 0.9) && near(m1.metalness, 0.1),
        `ruvidita' e metallicita' vengono dal materiale (${m1.roughness}/${m1.metalness})`);
}

// --- materiale di solo colore -------------------------------------------
const plain = byName['#8B5A2B'];
if (plain) {
    ok(!plain.map, 'il voxel dello stesso colore SENZA materiale non eredita la texture');
    ok(near(plain.roughness, 0.35) && near(plain.metalness, 0.25),
        `solo colore: restano i valori di default dell\'export (${plain.roughness}/${plain.metalness})`);
    const L = linear('#8B5A2B');
    ok(near(plain.color.r, L.r) && near(plain.color.g, L.g) && near(plain.color.b, L.b),
        'solo colore: baseColorFactor e\' il colore convertito in lineare');
}

// --- orfano -------------------------------------------------------------
const orph = byName['@m9'];
if (orph) {
    const L = linear('#112233');
    ok(near(orph.color.r, L.r) && near(orph.color.g, L.g) && near(orph.color.b, L.b),
        'id orfano: il colore e\' quello del VOXEL, non il grigio neutro (decodeToken col 2o argomento)');
    const G = linear('#CCCCCC');
    ok(!(near(orph.color.r, G.r) && near(orph.color.g, G.g) && near(orph.color.b, G.b)),
        'id orfano: non e\' #CCCCCC (era il bug del secondo argomento dimenticato)');
    ok(!orph.map, 'id orfano: nessuna texture inventata');
}

// --- emissivo -----------------------------------------------------------
const m2 = byName['@m2'];
if (m2) {
    ok(!!m2.emissive && near(m2.emissiveIntensity, 0.5),
        `emissive dal materiale (intensita' ${m2.emissiveIntensity})`);
    ok(near(m2.roughness, 0.2) && near(m2.metalness, 0.8),
        'materiale senza texture: ruvidita\'/metallicita\' comunque sue');
}

ok(mats.every(m => m.side === THREE.FrontSide),
    'statico: tutti i materiali sono FrontSide (mai DoubleSide, vedi invariante 5)');

// ===== B. percorso RIGGATO ==============================================
console.log('\n== riggato: buildSkinnedMesh raggruppa per token e emette gli uv ==');
global.currentModelData = freshModel();
const rigApi = new Function(rigSrc + '\n' + matSrc + `
 ;return { buildHumanoidSkeleton, bindVoxels, bindSkin, buildSkinnedMesh,
           setRig:(r)=>{rig=r;} };`)();

// Corpo minimo ma reale: serve uno scheletro umanoide valido.
function body() {
    const vox = [];
    const put = (x, y, z, color, material) => vox.push(material ? { x, y, z, color, material } : { x, y, z, color });
    for (let y = 0; y <= 5; y++) for (let x = 6; x <= 9; x++) for (let z = 7; z <= 8; z++) put(x, y, z, '#332211');
    for (let y = 6; y <= 14; y++) for (let x = 5; x <= 10; x++) for (let z = 7; z <= 8; z++) put(x, y, z, '#332211');
    for (let y = 15; y <= 18; y++) for (let x = 6; x <= 9; x++) for (let z = 7; z <= 8; z++) put(x, y, z, '#332211');
    for (let x = 0; x <= 4; x++) for (let z = 7; z <= 8; z++) put(x, 13, z, '#332211');
    for (let x = 11; x <= 15; x++) for (let z = 7; z <= 8; z++) put(x, 13, z, '#332211');
    // Stesso colore del torso, ma con materiale: deve staccarsi in un gruppo suo.
    vox.filter(v => v.y === 18).forEach(v => { v.material = 'm1'; });
    return vox;
}
const rvox = body();
global.currentModelData = { metadata: { materials: MATERIALS.map(m => ({ ...m })) }, voxels: rvox };
const rigOut = rigApi.buildHumanoidSkeleton(rvox);
rigApi.setRig(rigOut);
const assign = rigApi.bindVoxels(rvox, rigOut.bones);
const skin = rigApi.bindSkin ? rigApi.bindSkin(rvox, rigOut.bones, assign) : null;
const rexp = rigApi.buildSkinnedMesh(rvox, rigOut.bones, assign, skin, { forExport: true });
const rgeo = rexp.mesh.geometry;
const rmats = Array.isArray(rexp.mesh.material) ? rexp.mesh.material : [rexp.mesh.material];

ok(!!rgeo.attributes.uv, 'la geometria riggata porta l\'attributo uv');
if (rgeo.attributes.uv) {
    ok(rgeo.attributes.uv.array.length === (rgeo.attributes.position.array.length / 3) * 2,
        `riggato: un uv per vertice (${rgeo.attributes.uv.array.length} per ${rgeo.attributes.position.array.length / 3})`);
}
const tokens = rmats.map(m => m.userData.token);
ok(tokens.includes('@m1') && tokens.includes('#332211'),
    `riggato: token distinti per lo stesso colore (${tokens.join(' ')})`);
const HEX = /^#[0-9A-F]{6}$/;
ok(rmats.every(m => HEX.test(String(m.userData.hexColor))),
    `riggato: userData.hexColor resta un hex VERO anche sui token materiale (${rmats.map(m => m.userData.hexColor).join(' ')})`);
ok(rmats.every(m => m.userData.materialId === null || typeof m.userData.materialId === 'string'),
    'riggato: userData.materialId e\' l\'id del materiale (o null)');
ok(rgeo.groups.every(g => g.count > 0),
    'riggato: nessun gruppo con count 0 (una primitiva senza indices e\' veleno, vedi 15-rig.js)');

// ===== C. exportGLB, il cablaggio vero ==================================
console.log('\n== exportGLB riggato: COLOR_0 via, texture dentro, FrontSide ==');
global.currentModelData = { metadata: { name: 'Prova', materials: MATERIALS.map(m => ({ ...m })) }, voxels: rvox };
const fullApi = new Function(rigSrc + '\n' + matSrc + '\n' + glbSrc + `
 ;return { exportGLB, buildHumanoidSkeleton, bindVoxels, bindSkin,
           setState:(s)=>{ rig=s.rig; boneAssignments=s.assign;
                           boneWeightIndices=s.wi; boneWeightValues=s.wv;
                           skinnedMesh=s.sm; skeleton=s.sk; rigClips=s.clips; } };`)();
const frig = fullApi.buildHumanoidSkeleton(rvox);
const fassign = fullApi.bindVoxels(rvox, frig.bones);
const fskin = fullApi.bindSkin(rvox, frig.bones, fassign);
fullApi.setState({
    rig: frig, assign: fassign, wi: fskin.indices, wv: fskin.weights,
    sm: { name: 'dummy' }, sk: { bones: [], update() { } }, clips: [],
});
texLoads.length = 0;
parsedRoots.length = 0;
fullApi.exportGLB();
// L'export aspetta il decode delle texture prima di chiamare l'exporter: se
// non lo facesse, `parsedRoots` sarebbe gia' pieno qui.
const parsedBefore = parsedRoots.length;
texLoads.forEach(r => r.settle());
await new Promise(r => setTimeout(r, 0));

ok(texLoads.length > 0, `l'export riggato carica la texture del materiale (${texLoads.length})`);
ok(parsedBefore === 0,
    'exportGLB aspetta il decode: senza attesa il GLTFExporter incorpora un canvas 0x0 (texture vuota)');
ok(parsedRoots.length === 1, `il GLTFExporter viene chiamato una volta sola (${parsedRoots.length})`);
const snap = parsedRoots[0];
if (snap) {
    ok(snap.hasColorAttr === false,
        'INVARIANTE 6: l\'attributo color non c\'e\' piu\' alla parse (la texture NON lo sostituisce)');
    ok(snap.pending === 0, 'nessuna texture ancora da decodificare al momento della parse');
    ok(snap.mats.length > 1 && snap.mats.every(m => m.side === THREE.FrontSide),
        `riggato: tutti i materiali FrontSide (${snap.mats.length})`);
    ok(snap.mats.every(m => m.vertexColors === false),
        'riggato: vertexColors spento su ogni materiale');
    const tm = snap.mats.filter(m => m.map);
    ok(tm.length === 1, `un solo materiale texturizzato (${tm.length})`);
    if (tm.length) {
        ok(near(tm[0].color.r, 1) && near(tm[0].color.g, 1) && near(tm[0].color.b, 1),
            'riggato: col map il baseColorFactor resta bianco');
        ok(tm[0].map.magFilter === THREE.NearestFilter, 'riggato: texture a NearestFilter');
        ok(near(tm[0].roughness, 0.9) && near(tm[0].metalness, 0.1),
            `riggato: ruvidita'/metallicita' dal materiale (${tm[0].roughness}/${tm[0].metalness})`);
    }
    const plainMats = snap.mats.filter(m => !m.map);
    ok(plainMats.length > 0 && plainMats.every(m => !(near(m.color.r, 1) && near(m.color.g, 1) && near(m.color.b, 1))),
        'riggato: i materiali senza texture tengono il loro colore, non diventano bianchi');
}

// ===== D. la texture che NON si decodifica ==============================
// Il difetto misurato (review del task 9, C1): una texture illeggibile risolveva
// comunque la promessa ma lasciava `map.image` undefined, e il GLTFExporter r128
// sollevava mentre disegnava sul canvas -- dentro un .then() senza .catch().
// Risultato: zero download, `restore()` mai eseguito (modello invisibile a
// schermo dopo un export riggato) e NESSUN errore mostrato. Meglio un GLB a
// tinte piatte che nessun GLB.
console.log('\n== texture illeggibile: il GLB esce lo stesso, a tinte piatte ==');
global.currentModelData = freshModel();
const failApi = new Function(rigSrc + '\n' + matSrc + '\n' + glbSrc + `
 ;return { exportGLB };`)();
texLoads.length = 0; parsedRoots.length = 0;
downloads.length = 0; alerts.length = 0;
failApi.exportGLB();
ok(texLoads.length === 1, `una texture in coda (${texLoads.length})`);
texLoads.forEach(r => r.reject());
await new Promise(r => setTimeout(r, 0));
const failRoot = parsedRoots.length ? parsedRoots[parsedRoots.length - 1].root : null;

ok(downloads.length === 1, `il GLB viene scaricato lo stesso (${downloads.length} download)`);
ok(parsedRoots.length === 1, `il GLTFExporter viene chiamato e non solleva (${parsedRoots.length})`);
// I materiali si guardano dal mesh, non da `snap.mats`: il root statico e' un
// Group e non porta `material` addosso.
const dmesh = failRoot && failRoot.children ? failRoot.children[0] : null;
const dmats = dmesh ? (Array.isArray(dmesh.material) ? dmesh.material : [dmesh.material]) : [];
ok(dmats.length > 0 && dmats.every(m => !m.map),
    `la texture rotta e' stata staccata dal materiale prima della parse (${dmats.length} materiali)`);
// Il bianco serviva solo a non moltiplicare due volte la tinta SOTTO una
// texture: caduta la texture, va disfatto o il modello esce slavato.
const wasTextured = dmats.filter(m => m.name === '@m1');
ok(wasTextured.length === 1 && !near(wasTextured[0].color.r, 1),
    `il materiale torna alla sua tinta invece di restare bianco (r=${wasTextured.length ? wasTextured[0].color.r.toFixed(3) : '?'})`);
ok(alerts.length === 1 && String(alerts[0]).indexOf('export.glb.texturesDropped') === 0,
    `l'utente viene avvisato, con una chiave i18n (${JSON.stringify(alerts)})`);

// Un secondo export non deve ereditare le promesse del primo: la lista delle
// texture in attesa e' stato di modulo e va azzerata a ogni export.
texLoads.length = 0; parsedRoots.length = 0; downloads.length = 0; alerts.length = 0;
global.currentModelData = { metadata: { name: 'Senza', materials: [] }, voxels: [{ x: 0, y: 0, z: 0, color: '#FF0000' }] };
failApi.exportGLB();
await new Promise(r => setTimeout(r, 0));
ok(downloads.length === 1 && parsedRoots.length === 1,
    `un export successivo senza texture non resta appeso alle promesse del precedente (${downloads.length} download)`);

console.log(`\n${fail ? 'FALLITI' : 'OK'}: ${pass} controlli passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
