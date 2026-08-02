/*
 * Export GLB end-to-end, headless, con il VERO three.js r128 e il VERO
 * GLTFExporter: carica i moduli 15-rig.js / 16-export-glb.js come fa il browser
 * (frammenti di uno scope condiviso), monta un rig su un modello reale e scrive
 * il .glb su disco. Serve a farlo poi reimportare da Blender in tests/.blender_probe.py.
 *
 * Uso: node tests/.glb_export_harness.mjs <modello.json> <out.glb> [--noscale] [--full]
 *
 * Non e' un test in se': e' lo strumento che PRODUCE l'artefatto da verificare.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VENDOR = process.env.THREE_DIR || path.join(REPO_ROOT, 'tests', '.vendor');

const argv = process.argv.slice(2);
const MODEL = argv[0];
const OUT = argv[1];
const DO_SCALE = !argv.includes('--noscale');
const CULL = !argv.includes('--full');

// --- three.js r128 gira in un contesto con un `self`/`window` minimi -------
// GLTFExporter in modalita' binary usa Blob + FileReader di window: Node 18+ ha
// entrambi nativi, quindi si passano quelli veri (un finto Blob restituirebbe
// un GLB vuoto senza dare errore).
const FileReaderImpl = globalThis.FileReader || (await import('node:buffer')).Blob && class {
    readAsArrayBuffer(blob) {
        blob.arrayBuffer().then(buf => { this.result = buf; this.onloadend && this.onloadend(); });
    }
    readAsDataURL(blob) {
        blob.arrayBuffer().then(buf => {
            this.result = 'data:' + (blob.type || 'application/octet-stream') +
                ';base64,' + Buffer.from(buf).toString('base64');
            this.onloadend && this.onloadend();
        });
    }
};
const sandbox = {
    console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    Blob: globalThis.Blob, FileReader: FileReaderImpl, URL: globalThis.URL,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(VENDOR, 'three.min.js'), 'utf8'), sandbox, { filename: 'three.min.js' });
vm.runInContext(fs.readFileSync(path.join(VENDOR, 'GLTFExporter.js'), 'utf8'), sandbox, { filename: 'GLTFExporter.js' });
const THREE = sandbox.THREE;
if (!THREE || !THREE.GLTFExporter) throw new Error('three.js/GLTFExporter non caricati');
// TransformControls sta in un file examples/ a parte e serve solo al gizmo a
// schermo: qui una sottoclasse di Object3D (cosi' scene.add/remove funzionano
// davvero) con i metodi del gizmo resi innocui.
THREE.TransformControls = class extends THREE.Object3D {
    constructor() {
        super();
        this.enabled = true;
        this.mode = 'rotate';
        ['attach', 'detach', 'setSize', 'setMode', 'setSpace', 'setTranslationSnap',
            'setRotationSnap', 'addEventListener', 'removeEventListener', 'dispose']
            .forEach(k => { this[k] = () => this; });
    }
};
global.THREE = THREE;

// --- modello: si espandono le ops come fa il browser ----------------------
const raw = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
const expandSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/utils/expand-ops.js'), 'latin1');
const expandOps = new Function(expandSrc + '\n;return expandOps;')();
const model = expandOps(JSON.parse(JSON.stringify(raw)));
if (!model.voxels || !model.voxels.length) throw new Error('modello senza voxel dopo expandOps');
if (!model.metadata) model.metadata = raw.metadata || {};

// --- stub DOM/app: solo cio' che i due moduli toccano davvero -------------
const els = {};
const mkEl = (id) => (els[id] = els[id] || {
    id, textContent: '', innerHTML: '', value: '0', checked: true, disabled: false,
    style: {}, dataset: {}, title: '', children: [],
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, appendChild(c) { this.children.push(c); },
    querySelectorAll: () => [], querySelector: () => null, remove() { },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
});
// Le due caselle che pilotano l'export.
mkEl('glbScaleCheckbox').checked = DO_SCALE;
mkEl('glbCullInternalCheckbox').checked = CULL;
mkEl('voxelGap').value = '0';

global.document = {
    getElementById: mkEl,
    createElement: () => mkEl('_tmp_' + Math.random()),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() { },
    body: { appendChild() { } },
};
global.window = { addEventListener() { }, requestAnimationFrame: () => 0 };
global.alert = (m) => { throw new Error('alert(): ' + m); };
global.prompt = () => null;
global.confirm = () => false;
const store = new Map();
global.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); },
};
// t() vero non c'e' (23-i18n.js non e' caricato): si restituisce l'italiano
// per le poche stringhe che finiscono DENTRO il file esportato, cosi' il nome
// della clip nel glb e' quello vero e non la chiave grezza.
const I18N = { 'export.glb.poseClip': 'Posa (dall’editor)' };
global.t = (k) => I18N[k] || k;
global.requestRender = () => { };
global.updateHistoryButtons = () => { };
global.pushHistory = () => { };
global.undoStack = [];
global.redoStack = [];
global.buildModel = () => { };
global.currentModelData = model;
global.voxelGap = els.voxelGap;
global.visibleVoxels = model.voxels;
global.syncVisibleVoxels = () => { };
global.modelPivot = new THREE.Group();
global.scene = new THREE.Scene();
global.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
global.camera.position.set(0, 0, 100);
global.renderer = { domElement: mkEl('canvas') };
global.controls = { addEventListener() { }, update() { } };
global.gizmoEnabled = false;
global.mixer = null;
// Elementi che vivono in altri moduli non caricati qui (la barra del gizmo e'
// dichiarata in un modulo di UI): senza stub il rig fallisce al primo refresh.
global.gizmoBar = mkEl('gizmoBar');

// --- carica i moduli nell'ordine del manifest (scope condiviso) -----------
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ui/src/manifest.json'), 'latin1'));
const want = ['lib/15-rig.js', 'lib/16-export-glb.js'];
const srcs = want.map(rel => {
    if (!manifest.includes(rel)) throw new Error('modulo non nel manifest: ' + rel);
    return fs.readFileSync(path.join(REPO_ROOT, 'ui/src', rel), 'latin1');
});

// 16-export-glb.js registra un listener sul bottone: lo stub lo assorbe.
const api = new Function(srcs.join('\n') + `
;return { buildHumanoidSkeleton, applyRig, exportGLB, buildFullSkinnedMesh,
          exportOrigin, scaleClipsForExport,
          setRig: r => { rig = r; }, getRig: () => rig,
          getSkinnedMesh: () => skinnedMesh, getClips: () => rigClips };
`)();

// --- monta il rig (se c'e') e lancia l'export -----------------------------
// Con --static si salta il rig apposta, per esercitare l'altro ramo di exportGLB().
const STATIC = argv.includes('--static');
const rigData = (!STATIC && raw.rig && raw.rig.bones && raw.rig.bones.length)
    ? JSON.parse(JSON.stringify(raw.rig))
    : null;
if (!STATIC) {
    if (!rigData) throw new Error('il modello non ha un rig: usa --static per il percorso statico');
    // Posa e traslazioni di posa restano quelle salvate: l'export DEVE neutralizzarle.
    api.setRig(rigData);
    api.applyRig();
    if (!api.getSkinnedMesh()) throw new Error('applyRig non ha prodotto la skinned mesh');
}

// Il download nel browser passa da Blob+anchor: qui si intercetta il risultato.
// Blob/URL restano quelli VERI (l'exporter li usa internamente per produrre il
// buffer); si sostituisce solo l'anchor, che nel browser fa partire il file.
let written = false;
global.Blob = globalThis.Blob;
global.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() { } };
const origCreate = global.document.createElement;
global.document.createElement = (tag) => {
    if (tag !== 'a') return origCreate(tag);
    return { href: '', download: '', click() { } };
};

// exportGLB() costruisce l'export root e chiama il vero GLTFExporter: si
// intercetta parse() solo per catturare il buffer prodotto.
// Se ne approfitta per misurare la silhouette POSATA con lo skinning vero
// (SkinnedMesh.boneTransform): e' il "come si vede nell'app", e diventa
// l'atteso che Blender deve riprodurre all'apertura del file.
function poseBounds(mesh) {
    if (!mesh.isSkinnedMesh || !mesh.geometry.attributes.skinIndex) return null;
    mesh.updateMatrixWorld(true);
    const n = mesh.geometry.attributes.position.count;
    const v = new THREE.Vector3();
    const b = { minx: 1e9, maxx: -1e9, miny: 1e9, maxy: -1e9, minz: 1e9, maxz: -1e9 };
    for (let i = 0; i < n; i++) {
        mesh.boneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        if (v.x < b.minx) b.minx = v.x; if (v.x > b.maxx) b.maxx = v.x;
        if (v.y < b.miny) b.miny = v.y; if (v.y > b.maxy) b.maxy = v.y;
        if (v.z < b.minz) b.minz = v.z; if (v.z > b.maxz) b.maxz = v.z;
    }
    return b;
}

const origParse = THREE.GLTFExporter.prototype.parse;
THREE.GLTFExporter.prototype.parse = function (input, onDone, opts) {
    const pb = poseBounds(input);
    if (pb) {
        // three.js e' Y-up, Blender Z-up: (x, y, z) -> (x, -z, y).
        const expect = {
            x: [pb.minx, pb.maxx],
            y: [-pb.maxz, -pb.minz],
            z: [pb.miny, pb.maxy]
        };
        fs.writeFileSync(OUT + '.expect.json', JSON.stringify(expect, null, 1));
        console.log(`HARNESS: silhouette posata attesa  X[${pb.minx.toFixed(3)},${pb.maxx.toFixed(3)}]`
            + ` Z[${pb.miny.toFixed(3)},${pb.maxy.toFixed(3)}]  larghezza ${(pb.maxx - pb.minx).toFixed(3)}`
            + ` altezza ${(pb.maxy - pb.miny).toFixed(3)}`);
    }
    return origParse.call(this, input, (result) => {
        fs.writeFileSync(OUT, Buffer.from(result));
        written = true;
        onDone(result);
    }, opts);
};

api.exportGLB();

// L'export e' asincrono (FileReader): si attende che il file compaia.
const deadline = Date.now() + 120000;
while (!written && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
}
if (!written) { console.error('HARNESS: nessun GLB scritto'); process.exit(1); }
const sz = fs.statSync(OUT).size;
console.log(`HARNESS: scritto ${OUT} (${sz} byte), scale=${DO_SCALE ? '0.01' : '1'}, cull=${CULL}`);
// Sanita' post-export: l'editor deve tornare com'era.
const r2 = api.getRig();
if (r2) {
    console.log(`HARNESS: posa ripristinata -> pose=${Object.keys(r2.pose || {}).length} chiavi, posePos=${Object.keys(r2.posePos || {}).length} chiavi`);
}
