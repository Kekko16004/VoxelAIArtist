#!/usr/bin/env node
// Materiali: store, id, token. Il modulo e' un frammento di scope condiviso,
// quindi lo si carica con new Function come fa test_incremental.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name}: ${detail || ''}`); failures.push(name); }
}

function loadMaterials() {
  const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/36-materials.js'), 'latin1');
  // THREE, document, Image e URL entrano come PARAMETRI, non come globali di
  // Node: cosi' ogni istanza vede i propri stub (e Node non ne ha di suoi per
  // Image/document, mentre la sua URL non ha createObjectURL).
  return new Function('currentModelData', 'THREE', 'document', 'Image', 'URL', src + `
   ;return { materialsOfProject, materialById, addMaterial, removeMaterial,
             nextMaterialId, tokenOf, decodeToken, isMaterialToken,
             averageColorFromPixels, setActiveMaterial, getActiveMaterialId,
             fitTextureSize, importTextureFile, threeMaterialFor,
             clearMaterialCache };`);
}

// Ogni istanza ha il suo scope (e quindi il suo store): le sezioni che sporcano
// la lista lavorano su un modello proprio invece di ripulirla a mano, cosi' un
// check non puo' dipendere dall'ordine di quelli prima.
const factory = loadMaterials();
const fresh = (env) => {
  const model = { metadata: {}, voxels: [] };
  const e = env || {};
  return { model, api: factory(model, e.THREE, e.document, e.Image, e.URL) };
};

console.log('test_materials');

const { model, api } = fresh();

// --- id ---
check('il primo id e\' m1', api.nextMaterialId([]) === 'm1', api.nextMaterialId([]));
check('l\'id e\' il primo intero LIBERO, non l\'ultimo+1',
  api.nextMaterialId(['m1', 'm3']) === 'm2', api.nextMaterialId(['m1', 'm3']));

// --- store ---
const legno = api.addMaterial({ name: 'Legno', color: '#8B5A2B', roughness: 0.7 });
check('addMaterial assegna un id', legno.id === 'm1', legno.id);
check('addMaterial normalizza i campi mancanti',
  legno.metalness === 0 && legno.emissive === 0 && legno.texture === null,
  JSON.stringify(legno));
check('il materiale finisce in metadata.materials',
  model.metadata.materials.length === 1, JSON.stringify(model.metadata.materials));
check('materialById lo ritrova', api.materialById('m1').name === 'Legno');
check('materialById su id ignoto da\' null', api.materialById('m99') === null);
const pietra = api.addMaterial({ name: 'Pietra', color: '#888888' });
check('il secondo materiale prende m2', pietra.id === 'm2', pietra.id);
check('removeMaterial toglie', api.removeMaterial('m1') === true && api.materialsOfProject().length === 1);
check('removeMaterial su id ignoto da\' false', api.removeMaterial('m1') === false);

// Il buco lasciato da m1 va RIEMPITO davvero: nextMaterialId da solo prova la
// matematica, non che addMaterial gli passi la lista giusta.
{
  const riuso = api.addMaterial({ name: 'Riuso', color: '#010101' });
  check('addMaterial riusa l\'id liberato da removeMaterial', riuso.id === 'm1', riuso.id);
  api.removeMaterial('m1');
}

// --- normalizzazione dei parametri ---
// null e '' sono ASSENZA, non zero: in JSON un valore mancante si scrive null, e
// Number(null) e' 0 (che isFinite accetta), quindi senza una guardia esplicita il
// default 0.6 non scattava mai e la superficie usciva a specchio. Si vedeva solo
// su roughness perche' e' l'unico default diverso da zero.
{
  const { api: a } = fresh();
  check('roughness assente vale 0.6', a.addMaterial({ name: 'x' }).roughness === 0.6,
    String(a.materialsOfProject()[0].roughness));
  const { api: b } = fresh();
  check('roughness null vale 0.6 (non 0)', b.addMaterial({ roughness: null }).roughness === 0.6,
    String(b.materialsOfProject()[0].roughness));
  const { api: c } = fresh();
  check('roughness \'\' vale 0.6 (non 0)', c.addMaterial({ roughness: '' }).roughness === 0.6,
    String(c.materialsOfProject()[0].roughness));
  const { api: d } = fresh();
  check('roughness non numerico vale 0.6', d.addMaterial({ roughness: 'abc' }).roughness === 0.6,
    String(d.materialsOfProject()[0].roughness));
  const { api: e } = fresh();
  check('roughness 5 viene tagliato a 1', e.addMaterial({ roughness: 5 }).roughness === 1,
    String(e.materialsOfProject()[0].roughness));
  const { api: f } = fresh();
  check('roughness -1 viene tagliato a 0', f.addMaterial({ roughness: -1 }).roughness === 0,
    String(f.materialsOfProject()[0].roughness));
  const { api: g } = fresh();
  const gm = g.addMaterial({ metalness: 2, emissive: -3 });
  check('anche metalness ed emissive vengono tagliati',
    gm.metalness === 1 && gm.emissive === 0, JSON.stringify(gm));
}

// --- colore malformato ---
// Questo modulo e' il punto di conversione di cui si fidano swatch, .vox, .schem,
// MTL e THREE.Color: "inizia con #" non basta a dichiararlo valido, e l'output di
// un LLM e' esattamente il posto da cui aspettarsi un hex storto.
{
  const { api: a } = fresh();
  check('un hex troppo lungo non passa per valido',
    a.addMaterial({ color: '#12345678' }).color === '#CCCCCC',
    a.materialsOfProject()[0].color);
  const { api: b } = fresh();
  check('un hex con caratteri non esadecimali non passa',
    b.addMaterial({ color: '#gg1122' }).color === '#CCCCCC',
    b.materialsOfProject()[0].color);
  const { api: c } = fresh();
  check('il solo cancelletto non passa', c.addMaterial({ color: '#' }).color === '#CCCCCC',
    c.materialsOfProject()[0].color);
  const { api: d } = fresh();
  check('un hex valido minuscolo viene messo in maiuscolo',
    d.addMaterial({ color: '#ab12cd' }).color === '#AB12CD',
    d.materialsOfProject()[0].color);
}

// --- id esplicito (giro di ricarica del progetto) ---
// Se l'id cambiasse, ogni voxel che lo cita resterebbe orfano: la ricarica DEVE
// poterlo imporre. Sulla collisione invece rimappa, e allora sta al chiamante
// accorgersene confrontando mat.id con def.id: non farlo lega i suoi voxel al
// materiale preesistente, che e' peggio di un orfano perche' non si vede.
{
  const { api: a } = fresh();
  const esplicito = a.addMaterial({ id: 'm7', name: 'Salvato', color: '#123456' });
  check('un id esplicito e libero viene conservato', esplicito.id === 'm7', esplicito.id);
  const collisione = a.addMaterial({ id: 'm7', name: 'Doppione', color: '#654321' });
  check('un id esplicito gia\' preso viene rimappato', collisione.id !== 'm7', collisione.id);
  check('la rimappatura prende il primo id libero', collisione.id === 'm1', collisione.id);
  check('il materiale preesistente non viene sovrascritto',
    a.materialById('m7').name === 'Salvato', a.materialById('m7').name);
}

// --- token ---
check('tokenOf di un voxel senza materiale e\' il colore maiuscolo',
  api.tokenOf({ color: '#ab12cd' }) === '#AB12CD', api.tokenOf({ color: '#ab12cd' }));
check('tokenOf di un voxel con materiale e\' @id',
  api.tokenOf({ color: '#888888', material: 'm2' }) === '@m2');
check('isMaterialToken distingue', api.isMaterialToken('@m2') === true && api.isMaterialToken('#AABBCC') === false);

const dec = api.decodeToken('@m2');
check('decodeToken risolve il colore dal materiale',
  dec.material === 'm2' && dec.color === '#888888', JSON.stringify(dec));

// ORFANO. Il token ha collassato il voxel a '@m77' buttandone via l'hex, quindi
// il colore proprio puo' arrivare solo dal chiamante: si ricade su QUELLO, non su
// un grigio fisso, o un .voxai privato delle sue definizioni si aprirebbe tutto
// grigio invece che "lo stesso modello a tinte piatte". E l'id NON si azzera: e'
// un problema d'ordine (materiali caricati dopo i voxel), e syncVoxelsFromMap
// riscrive currentModelData.voxels dai valori della mappa, quindi azzerarlo
// renderebbe definitiva su disco una perdita che era transitoria.
const orfano = api.decodeToken('@m77', '#123456');
check('un token orfano ricade sul colore del voxel',
  orfano.color === '#123456', JSON.stringify(orfano));
check('un token orfano CONSERVA l\'id del materiale',
  orfano.material === 'm77', JSON.stringify(orfano));
const orfanoNudo = api.decodeToken('@m77');
check('un orfano senza colore di riserva degrada al neutro',
  orfanoNudo.color === '#CCCCCC' && orfanoNudo.material === 'm77', JSON.stringify(orfanoNudo));
check('il colore di riserva viene normalizzato in maiuscolo',
  api.decodeToken('@m77', '#ab12cd').color === '#AB12CD',
  api.decodeToken('@m77', '#ab12cd').color);
check('un colore di riserva malformato non passa',
  api.decodeToken('@m77', 'verde').color === '#CCCCCC',
  api.decodeToken('@m77', 'verde').color);
check('tokenOf e decodeToken sono inverse anche su un orfano',
  api.tokenOf(api.decodeToken('@m77', '#123456')) === '@m77',
  api.tokenOf(api.decodeToken('@m77', '#123456')));

const decCol = api.decodeToken('#AABBCC');
check('decodeToken di un colore non inventa materiali',
  decCol.material === null && decCol.color === '#AABBCC', JSON.stringify(decCol));
check('un token colore malformato non viene spacciato per valido',
  api.decodeToken('#12345678').color === '#CCCCCC', api.decodeToken('#12345678').color);
check('tokenOf e decodeToken sono inverse sui colori',
  api.tokenOf(api.decodeToken('#AABBCC')) === '#AABBCC');
check('tokenOf e decodeToken sono inverse sui materiali',
  api.tokenOf(api.decodeToken('@m2')) === '@m2');

// --- tinta media ---
// 2 pixel rossi + 2 pixel neri (RGBA) -> #800000 circa.
const px = [255,0,0,255, 255,0,0,255, 0,0,0,255, 0,0,0,255];
const avg = api.averageColorFromPixels(px);
check('la tinta media e\' la media dei canali', avg === '#800000', avg);
// I pixel TRASPARENTI non devono tirare la media verso il nero: sono assenza di
// colore, non colore nero. Una texture con bordo trasparente diventerebbe scura.
const px2 = [255,0,0,255, 0,0,0,0];
check('i pixel trasparenti sono ignorati', api.averageColorFromPixels(px2) === '#FF0000',
  api.averageColorFromPixels(px2));

// --- selezione attiva ---
api.setActiveMaterial('m2');
check('setActiveMaterial imposta', api.getActiveMaterialId() === 'm2');
api.setActiveMaterial(null);
check('setActiveMaterial(null) azzera', api.getActiveMaterialId() === null);

// --- ridimensionamento ---
const api2 = api; // stesso modulo
check('una texture piccola non viene ingrandita',
  JSON.stringify(api2.fitTextureSize(32, 16, 128)) === JSON.stringify({ w: 32, h: 16 }),
  JSON.stringify(api2.fitTextureSize(32, 16, 128)));
check('una texture grande rientra nel lato massimo',
  JSON.stringify(api2.fitTextureSize(512, 256, 128)) === JSON.stringify({ w: 128, h: 64 }),
  JSON.stringify(api2.fitTextureSize(512, 256, 128)));
check('il lato lungo comanda anche in verticale',
  JSON.stringify(api2.fitTextureSize(100, 400, 128)) === JSON.stringify({ w: 32, h: 128 }),
  JSON.stringify(api2.fitTextureSize(100, 400, 128)));
check('nessun lato scende sotto 1 pixel',
  api2.fitTextureSize(1000, 3, 128).h === 1, JSON.stringify(api2.fitTextureSize(1000, 3, 128)));
// Senza `max` deve valere il tetto del modulo (128): e' la forma con cui lo
// chiama importTextureFile, e un default sbagliato passerebbe inosservato.
check('senza max vale il tetto MATERIAL_TEXTURE_MAX',
  JSON.stringify(api2.fitTextureSize(512, 512)) === JSON.stringify({ w: 128, h: 128 }),
  JSON.stringify(api2.fitTextureSize(512, 512)));

// --- stub minimi di THREE / DOM ---------------------------------------------
// Il modulo non viene caricato in un browser: si stubba SOLO cio' che tocca.
// Gli stub registrano le chiamate, perche' quello che va provato non e' che il
// codice non lanci, ma che imposti NearestFilter/Repeat e la chiave di cache.
function makeThree() {
  const loaded = [];
  class Color {
    constructor(c) { this.value = c; }
  }
  class MeshStandardMaterial {
    constructor(p) { Object.assign(this, p); this.disposed = 0; this.map = null; }
    dispose() { this.disposed++; }
  }
  class TextureLoader {
    load(url, onLoad) {
      const tex = { image: url, disposed: 0, dispose() { this.disposed++; } };
      loaded.push(tex);
      if (onLoad) onLoad(tex);
      return tex;
    }
  }
  return {
    Color, MeshStandardMaterial, TextureLoader,
    NearestFilter: 'NEAREST', RepeatWrapping: 'REPEAT',
    _loaded: loaded
  };
}

// --- materiali THREE ---------------------------------------------------------
{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  const m = a.threeMaterialFor('#AABBCC');
  check('un token colore da\' un materiale col suo colore',
    m.color.value === '#AABBCC', JSON.stringify(m.color));
  check('senza materiale valgono i default del viewer',
    m.roughness === 0.2 && m.metalness === 0.1, `${m.roughness}/${m.metalness}`);
  check('il materiale e\' riusato dalla cache a parita\' di token',
    a.threeMaterialFor('#AABBCC') === m, 'due istanze per lo stesso token');
  const w = a.threeMaterialFor('#AABBCC', { wireframe: true });
  check('il wireframe e\' una voce di cache distinta', w !== m && w.wireframe === true,
    `${w === m}/${w.wireframe}`);
}

// I parametri del materiale devono arrivare dalla DEFINIZIONE, non dai default.
{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  a.addMaterial({ id: 'm1', name: 'Metallo', color: '#889099', roughness: 0.15, metalness: 0.9 });
  const m = a.threeMaterialFor('@m1');
  check('roughness e metalness vengono dalla definizione',
    m.roughness === 0.15 && m.metalness === 0.9, `${m.roughness}/${m.metalness}`);
  check('il colore del materiale vince sul neutro', m.color.value === '#889099',
    JSON.stringify(m.color));
  check('senza emissive il materiale non emette', !m.emissive, JSON.stringify(m.emissive));
}

{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  a.addMaterial({ id: 'm1', name: 'Lava', color: '#FF4400', emissive: 0.8 });
  const m = a.threeMaterialFor('@m1');
  check('emissive > 0 accende il materiale',
    m.emissive && m.emissive.value === '#FF4400' && m.emissiveIntensity === 0.8,
    JSON.stringify([m.emissive, m.emissiveIntensity]));
}

// La texture: filtri e wrapping sono il punto, non il caricamento in se'.
// NearestFilter perche' interpolare la voxel art la sfoca; RepeatWrapping perche'
// il greedy mesh dell'export emette UV oltre 1 (una faccia = N voxel).
{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  a.addMaterial({ id: 'm1', name: 'Legno', color: '#8B5A2B',
    texture: { data: 'data:image/png;base64,AAAA', w: 16, h: 16 } });
  const m = a.threeMaterialFor('@m1');
  check('la texture viene applicata come map', !!m.map && m.map.image === 'data:image/png;base64,AAAA',
    JSON.stringify(m.map && m.map.image));
  check('la texture non viene interpolata',
    m.map.magFilter === 'NEAREST' && m.map.minFilter === 'NEAREST',
    `${m.map.magFilter}/${m.map.minFilter}`);
  check('la texture si ripete su entrambi gli assi',
    m.map.wrapS === 'REPEAT' && m.map.wrapT === 'REPEAT', `${m.map.wrapS}/${m.map.wrapT}`);
  // Con una map, THREE MOLTIPLICA color per il texel: lasciando la tinta media
  // la texture uscirebbe scurita due volte (lo stesso difetto del COLOR_0 nel GLB).
  check('con la texture il colore torna bianco', m.color.value === 0xffffff,
    JSON.stringify(m.color));
}

// ORFANO. `dec.material` resta valorizzato di proposito (vedi decodeToken), quindi
// chi decide se la definizione esiste DEVE passare da materialById: fidarsi della
// verita' del campo darebbe un def null-safe solo per caso. E il colore proprio
// del voxel va passato, o il modello uscirebbe grigio uniforme.
{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  const m = a.threeMaterialFor('@m77', { color: '#123456' });
  check('un materiale orfano usa il colore del voxel', m.color.value === '#123456',
    JSON.stringify(m.color));
  check('un materiale orfano non lancia e ricade sui default',
    m.roughness === 0.2 && m.metalness === 0.1, `${m.roughness}/${m.metalness}`);
  // Due orfani di colore diverso NON possono condividere una voce di cache, o il
  // primo colore vincerebbe su tutti i voxel dello stesso id.
  const m2 = a.threeMaterialFor('@m77', { color: '#ABCDEF' });
  check('due orfani di colore diverso non si spartiscono la cache',
    m2 !== m && m2.color.value === '#ABCDEF', JSON.stringify(m2.color));
}

// clearMaterialCache: serve a far vedere una definizione MODIFICATA. Se non
// liberasse la voce, cambiare la ruvidita' non cambierebbe nulla sullo schermo.
{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  a.addMaterial({ id: 'm1', name: 'Legno', color: '#8B5A2B', roughness: 0.7,
    texture: { data: 'data:image/png;base64,AAAA', w: 8, h: 8 } });
  const before = a.threeMaterialFor('@m1');
  a.clearMaterialCache();
  check('clearMaterialCache libera il materiale', before.disposed === 1, String(before.disposed));
  check('clearMaterialCache libera anche la texture', before.map.disposed === 1,
    String(before.map.disposed));
  const after = a.threeMaterialFor('@m1');
  check('dopo il clear il materiale viene ricostruito', after !== before, 'stessa istanza');
}

// --- import della texture ----------------------------------------------------
// Il canvas e' finto: registra le chiamate e restituisce pixel noti. Prova che
// l'import ridimensiona (il tetto e' applicato QUI, non in normalizeMaterial),
// che disattiva lo smoothing e che la tinta media arriva dallo stesso canvas.
{
  const calls = { drawImage: null, smoothing: null, getImageData: null, revoked: [] };
  const pixels = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const doc = {
    createElement() {
      return {
        width: 0, height: 0,
        getContext() {
          return {
            set imageSmoothingEnabled(v) { calls.smoothing = v; },
            get imageSmoothingEnabled() { return calls.smoothing; },
            drawImage(img, x, y, w, h) { calls.drawImage = [x, y, w, h]; },
            getImageData(x, y, w, h) { calls.getImageData = [x, y, w, h]; return { data: pixels }; }
          };
        },
        toDataURL(type) { return 'data:' + type + ';base64,ZZZZ'; }
      };
    }
  };
  class FakeImage {
    set src(v) { this._src = v; this.width = 512; this.height = 256; this.onload(); }
    get src() { return this._src; }
  }
  const FakeURL = {
    createObjectURL() { return 'blob:finto'; },
    revokeObjectURL(u) { calls.revoked.push(u); }
  };
  const { api: a } = fresh({ THREE: makeThree(), document: doc, Image: FakeImage, URL: FakeURL });
  const res = await a.importTextureFile({ name: 'x.png' });
  check('l\'import ridimensiona entro il tetto', res.w === 128 && res.h === 64,
    `${res.w}x${res.h}`);
  check('l\'import disegna alla dimensione ridotta',
    JSON.stringify(calls.drawImage) === JSON.stringify([0, 0, 128, 64]),
    JSON.stringify(calls.drawImage));
  check('l\'import non interpola nel ridimensionamento', calls.smoothing === false,
    String(calls.smoothing));
  check('l\'import ritorna un data URL PNG', res.data === 'data:image/png;base64,ZZZZ', res.data);
  check('la tinta media viene dai pixel del canvas ridotto', res.color === '#800000', res.color);
  check('il blob viene rilasciato', calls.revoked.length === 1, JSON.stringify(calls.revoked));
}

// Un file che non e' un'immagine deve RIFIUTARE (e rilasciare il blob), non
// restare appeso: il pannello mostrera' il suo messaggio da t().
{
  const revoked = [];
  class BrokenImage {
    set src(v) { this.onerror(new Error('nope')); }
  }
  const FakeURL = {
    createObjectURL() { return 'blob:rotto'; },
    revokeObjectURL(u) { revoked.push(u); }
  };
  const { api: a } = fresh({ THREE: makeThree(), document: {}, Image: BrokenImage, URL: FakeURL });
  let rejected = false;
  try { await a.importTextureFile({ name: 'x.txt' }); } catch (e) { rejected = true; }
  check('un file non decodificabile fa fallire la promessa', rejected, 'la promessa e\' passata');
  check('anche in errore il blob viene rilasciato', revoked.length === 1, JSON.stringify(revoked));
}

if (failures.length) { console.error(`\nFALLITI: ${failures.length}`); process.exit(1); }
console.log('  tutti i controlli passati');
