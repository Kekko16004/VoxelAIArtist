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
             updateMaterial, nextMaterialId, tokenOf, decodeToken, isMaterialToken,
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

// --- updateMaterial --------------------------------------------------------
// La modifica e' IN PLACE: muta l'oggetto esistente invece di sostituirlo, cosi'
// ogni riferimento alla lista (che e' aliasata fra oggetti) lo vede aggiornato.
{
  const { model: m, api: a } = fresh();
  const orig = a.addMaterial({ name: 'Originale', color: '#111111', roughness: 0.5 });
  const ref1 = a.materialsOfProject();
  const ref2 = m.metadata.materials;
  const updated = a.updateMaterial(orig.id, { name: 'Modificato', roughness: 0.9 });
  check('updateMaterial ritorna il materiale', updated && updated.id === orig.id, updated && updated.id);
  check('il nome e\' stato modificato', updated.name === 'Modificato', updated.name);
  check('roughness e\' stato modificato', updated.roughness === 0.9, String(updated.roughness));
  check('il colore NON modificato resta invariato', updated.color === '#111111', updated.color);
  check('updateMaterial muta IN PLACE, non sostituisce', a.materialById(orig.id) === orig);
  check('ogni riferimento alla lista lo vede aggiornato', ref1[0].name === 'Modificato' && ref2[0].name === 'Modificato');
  check('updateMaterial su id inesistente da\' null', a.updateMaterial('m99', { name: 'X' }) === null);
}

// Un patch con `texture: null` ESPLICITO rimuove la texture; senza quella chiave
// la texture attuale resta dov'e'. E' la differenza fra "non tocco la texture" e
// "la tolgo", che il form di modifica richiede.
{
  const { api: a } = fresh();
  const tex = { data: 'data:image/png;base64,AAA', w: 16, h: 16 };
  const m = a.addMaterial({ name: 'T', texture: tex, color: '#FF0000' });
  const senzaChiave = a.updateMaterial(m.id, { roughness: 0.8 });
  check('updateMaterial senza texture nel patch conserva quella esistente',
    senzaChiave.texture && senzaChiave.texture.data === tex.data, JSON.stringify(senzaChiave.texture));
  const conNull = a.updateMaterial(m.id, { texture: null });
  check('updateMaterial con texture: null esplicito la rimuove',
    conNull.texture === null, JSON.stringify(conNull.texture));
}

// Anche sul patch si applica la normalizzazione: un hex storto o un roughness
// fuori range vengono aggiustati, e il materiale non resta invalido. In modifica
// puo' arrivare dall'utente tanto quanto in creazione.
{
  const { api: a } = fresh();
  const m = a.addMaterial({ name: 'X', color: '#00FF00', roughness: 0.5 });
  const patched = a.updateMaterial(m.id, { color: '#zzzzzz', roughness: 99 });
  check('updateMaterial normalizza un hex malformato', patched.color === '#CCCCCC', patched.color);
  check('updateMaterial clampa roughness fuori range', patched.roughness === 1, String(patched.roughness));
}

// --- normalizzazione dei parametri ---// null e '' sono ASSENZA, non zero: in JSON un valore mancante si scrive null, e
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
    // `userData` esiste SEMPRE su un THREE.Material vero (e' `{}` dalla nascita):
    // senza, threeMaterialFor esplode nello stub mentre in browser funziona.
    constructor(p) { Object.assign(this, p); this.disposed = 0; this.map = null; this.userData = {}; }
    dispose() { this.disposed++; }
  }
  class TextureLoader {
    load(url, onLoad) {
      // La texture vera ha repeat/offset (Vector2) e center: applyUvToTexture li
      // scrive, quindi lo stub deve averli o si romperebbe qui mentre in browser
      // funziona.
      const vec = () => ({ x: 0, y: 0, set(a, b) { this.x = a; this.y = b; } });
      const tex = {
        image: url, disposed: 0, dispose() { this.disposed++; },
        repeat: vec(), offset: vec(), center: vec(), rotation: 0
      };
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

// --- opacita' e trasparenza -------------------------------------------------
// Due sorgenti indipendenti: l'opacity del materiale e i pixel non opachi della
// texture. La trappola e' che alphaTest e opacity NON si combinano: alphaTest
// confronta l'alpha FINALE (opacity * alphaDelTexel) con la soglia, quindi con
// opacity 0.4 e soglia 0.5 spariscono anche i pixel pieni e il materiale
// diventa invisibile invece che semitrasparente.
{
  const { api: a } = fresh();
  check('opacity assente vale 1 (pieno)', a.addMaterial({ name: 'x' }).opacity === 1);
  const { api: b } = fresh();
  check('opacity null vale 1, non 0', b.addMaterial({ name: 'x', opacity: null }).opacity === 1);
  const { api: c } = fresh();
  check('opacity viene clampata in 0..1',
    c.addMaterial({ name: 'x', opacity: 5 }).opacity === 1
    && c.addMaterial({ name: 'y', opacity: -3 }).opacity === 0);
}

{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  a.addMaterial({ id: 'm1', name: 'Pieno', color: '#8B5A2B' });
  const m = a.threeMaterialFor('@m1');
  check('un materiale pieno NON e\' trasparente', !m.transparent, String(m.transparent));
  check('un materiale pieno non ha alphaTest', !m.alphaTest, String(m.alphaTest));
}

{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  a.addMaterial({ id: 'm1', name: 'Vetro', color: '#AACCFF', opacity: 0.35 });
  const m = a.threeMaterialFor('@m1');
  check('opacity < 1 accende la trasparenza', m.transparent === true, String(m.transparent));
  check('e trasporta il valore di opacity', m.opacity === 0.35, String(m.opacity));
  check('opacity < 1 NON usa alphaTest (spegnerebbe tutto)',
    !m.alphaTest, String(m.alphaTest));
}

{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  a.addMaterial({ id: 'm1', name: 'Foglia', color: '#3A7D2C',
    texture: { data: 'data:image/png;base64,AAAA', w: 16, h: 16, alpha: true } });
  const m = a.threeMaterialFor('@m1');
  check('una texture con alpha accende la trasparenza', m.transparent === true, String(m.transparent));
  check('a opacita\' piena il taglio e\' secco (alphaTest 0.5)',
    m.alphaTest === 0.5, String(m.alphaTest));
}

{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  a.addMaterial({ id: 'm1', name: 'Foglia velata', color: '#3A7D2C', opacity: 0.4,
    texture: { data: 'data:image/png;base64,AAAA', w: 16, h: 16, alpha: true } });
  const m = a.threeMaterialFor('@m1');
  check('texture con alpha + opacity < 1: nessun alphaTest',
    !m.alphaTest, String(m.alphaTest));
  check('e la fusione usa l\'opacity chiesta', m.opacity === 0.4, String(m.opacity));
}

{
  const { api: a } = fresh();
  const senza = a.addMaterial({ name: 'x', texture: { data: 'd', w: 4, h: 4 } });
  check('senza il flag, la texture e\' considerata opaca', senza.texture.alpha === false,
    String(senza.texture.alpha));
  const con = a.addMaterial({ name: 'y', texture: { data: 'd', w: 4, h: 4, alpha: true } });
  check('il flag alpha della texture viene conservato', con.texture.alpha === true,
    String(con.texture.alpha));
}

// --- mappatura UV -----------------------------------------------------------
// `repeat` non puo' essere 0: azzererebbe la matrice UV e la faccia mostrerebbe
// un solo texel stirato, che si legge come "la texture non si e' caricata".
// La rotazione e' quantizzata a 90 gradi perche' un angolo qualunque interpola
// una texture ai pixel netti e la sfoca.
{
  const { api: a } = fresh();
  const d = a.addMaterial({ name: 'x' });
  check('senza uv valgono i default (1, 0, 0, 0)',
    d.uv.repeat === 1 && d.uv.offsetU === 0 && d.uv.offsetV === 0 && d.uv.rotation === 0,
    JSON.stringify(d.uv));
  const z = a.addMaterial({ name: 'y', uv: { repeat: 0 } });
  check('repeat 0 viene portato al minimo, non lasciato a zero', z.uv.repeat > 0,
    String(z.uv.repeat));
  const big = a.addMaterial({ name: 'z', uv: { repeat: 1000 } });
  check('repeat enorme viene tagliato', big.uv.repeat === 64, String(big.uv.repeat));
  const rot = a.addMaterial({ name: 'w', uv: { rotation: 100 } });
  check('la rotazione si quantizza a 90 gradi', rot.uv.rotation === 90, String(rot.uv.rotation));
  const neg = a.addMaterial({ name: 'v', uv: { rotation: -90 } });
  check('una rotazione negativa rientra in 0..359', neg.uv.rotation === 270, String(neg.uv.rotation));
  const nan = a.addMaterial({ name: 'u', uv: { repeat: 'abc', offsetU: null } });
  check('valori non numerici tornano ai default',
    nan.uv.repeat === 1 && nan.uv.offsetU === 0, JSON.stringify(nan.uv));
}

{
  const THREE = makeThree();
  const { api: a } = fresh({ THREE });
  a.addMaterial({ id: 'm1', name: 'Mattoni', color: '#8B5A2B',
    texture: { data: 'data:image/png;base64,AAAA', w: 16, h: 16 },
    uv: { repeat: 4, offsetU: 0.25, offsetV: 0.5, rotation: 90 } });
  const m = a.threeMaterialFor('@m1');
  check('le ripetizioni arrivano sulla texture',
    m.map.repeat.x === 4 && m.map.repeat.y === 4, JSON.stringify(m.map.repeat));
  check('lo scorrimento arriva sulla texture',
    m.map.offset.x === 0.25 && m.map.offset.y === 0.5, JSON.stringify(m.map.offset));
  // center a 0.5,0.5 PRIMA di ruotare: attorno all'angolo (0,0) l'immagine
  // uscirebbe dal quadrato UV invece di girare sul posto.
  check('il centro di rotazione e\' il centro della texture',
    m.map.center.x === 0.5 && m.map.center.y === 0.5, JSON.stringify(m.map.center));
  check('la rotazione arriva in radianti',
    Math.abs(m.map.rotation - Math.PI / 2) < 1e-9, String(m.map.rotation));
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
//
// drawImage viene chiamata nella forma a 9 argomenti (sorgente + destinazione),
// che e' quella che il ritaglio richiede: senza il rettangolo sorgente non si
// potrebbe prendere una porzione dell'immagine. Senza ritaglio la sorgente e'
// l'immagine INTERA, ed e' quello che il primo blocco verifica.
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
            drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { calls.drawImage = [sx, sy, sw, sh, dx, dy, dw, dh]; },
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
  check('senza ritaglio la sorgente e\' l\'immagine intera',
    JSON.stringify(calls.drawImage.slice(0, 4)) === JSON.stringify([0, 0, 512, 256]),
    JSON.stringify(calls.drawImage));
  check('l\'import disegna alla dimensione ridotta',
    JSON.stringify(calls.drawImage.slice(4)) === JSON.stringify([0, 0, 128, 64]),
    JSON.stringify(calls.drawImage));
  check('l\'import non interpola nel ridimensionamento', calls.smoothing === false,
    String(calls.smoothing));
  check('l\'import ritorna un data URL PNG', res.data === 'data:image/png;base64,ZZZZ', res.data);
  check('la tinta media viene dai pixel del canvas ridotto', res.color === '#800000', res.color);
  check('il blob viene rilasciato', calls.revoked.length === 1, JSON.stringify(calls.revoked));

  // Il ritaglio: il tetto si applica al RETTAGLIO, non all'immagine intera.
  // 200x100 sta sotto i 128 di lato lungo? no: 200 > 128, quindi scende a 128x64.
  // La sorgente invece resta esattamente il rettangolo chiesto.
  const conCrop = await a.importTextureFile({ name: 'x.png' }, { x: 10, y: 20, w: 200, h: 100 });
  check('il ritaglio passa a drawImage come rettangolo sorgente',
    JSON.stringify(calls.drawImage.slice(0, 4)) === JSON.stringify([10, 20, 200, 100]),
    JSON.stringify(calls.drawImage));
  check('il tetto si applica al ritaglio, non all\'immagine intera',
    conCrop.w === 128 && conCrop.h === 64, `${conCrop.w}x${conCrop.h}`);

  // Un ritaglio piu' piccolo del tetto NON viene ingrandito: ingrandirlo non
  // aggiunge dettaglio e gonfia il base64 dentro il .voxai.
  const piccolo = await a.importTextureFile({ name: 'x.png' }, { x: 0, y: 0, w: 40, h: 30 });
  check('un ritaglio sotto il tetto resta alla sua dimensione',
    piccolo.w === 40 && piccolo.h === 30, `${piccolo.w}x${piccolo.h}`);

  // Un rettangolo che sfora il bordo viene INTERSECATO con l'immagine: drawImage
  // con una sorgente fuori area disegna il nulla, quindi si otterrebbe una
  // texture trasparente senza un errore da nessuna parte.
  await a.importTextureFile({ name: 'x.png' }, { x: 500, y: 250, w: 999, h: 999 });
  check('un ritaglio oltre il bordo viene intersecato con l\'immagine',
    JSON.stringify(calls.drawImage.slice(0, 4)) === JSON.stringify([500, 250, 12, 6]),
    JSON.stringify(calls.drawImage));

  // Coordinate negative: si fermano a 0 invece di scorrere la sorgente indietro.
  await a.importTextureFile({ name: 'x.png' }, { x: -50, y: -50, w: 100, h: 100 });
  check('un ritaglio con coordinate negative parte da 0',
    calls.drawImage[0] === 0 && calls.drawImage[1] === 0,
    JSON.stringify(calls.drawImage));
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

// --- round-trip attraverso il formato compatto ------------------------------
// Le ops sanno esprimere SOLO colori (palette -> hex): non c'e' posto dove
// mettere un materiale. I materiali viaggiano quindi in metadata.material_map e
// vengono riversati sui voxel DOPO l'espansione, cosi' expand_ops (Python) /
// expandOps (JS) e la loro parita' non si toccano.
//
// 07-save-payload.js aggancia due listener a livello top (i bottoni di
// salvataggio): senza uno stub di document il modulo non si carica nemmeno.
// expand-ops.js entra nella fetta perche' il giro completo (salva -> espandi ->
// riversa) e' il requisito vero, non un dettaglio interno.
function loadSaveApi(model, scene) {
  const srcExp = fs.readFileSync(path.join(ROOT, 'ui/src/utils/expand-ops.js'), 'latin1');
  const srcMat = fs.readFileSync(path.join(ROOT, 'ui/src/lib/36-materials.js'), 'latin1');
  const srcSave = fs.readFileSync(path.join(ROOT, 'ui/src/lib/07-save-payload.js'), 'latin1');
  const doc = { getElementById: () => ({ addEventListener() {} }) };
  return new Function('currentModelData', 'sceneObjects', 'document',
    srcExp + srcMat + srcSave + `
   ;return { buildMaterialMap, applyMaterialMap, buildObjectPayload,
             getSceneSavePayload, expandOps, materialsOfProject };`
  )(model, scene || [], doc);
}

const LEGNO = { id: 'm1', name: 'Legno', color: '#8B5A2B', texture: null,
  roughness: 0.7, metalness: 0, emissive: 0 };

{
  const model = {
    metadata: { name: 'T', grid_size: [4, 4, 4], materials: [Object.assign({}, LEGNO)] },
    voxels: [
      { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1' },
      { x: 1, y: 0, z: 0, color: '#8B5A2B', material: 'm1' },
      { x: 2, y: 0, z: 0, color: '#FF0000' }
    ]
  };
  const mod = loadSaveApi(model);

  const mm = mod.buildMaterialMap(model.voxels);
  check('material_map raggruppa per id come una op set',
    JSON.stringify(mm) === JSON.stringify([['m1', 0, 0, 0, 1, 0, 0]]), JSON.stringify(mm));
  check('i voxel senza materiale non finiscono nella mappa',
    JSON.stringify(mm).indexOf('2,0,0') === -1 && mm.length === 1, JSON.stringify(mm));

  const payload = mod.buildObjectPayload(model);
  check('il payload porta le definizioni dei materiali',
    payload.metadata.materials.length === 1, JSON.stringify(payload.metadata.materials));
  check('il payload porta la material_map',
    JSON.stringify(payload.metadata.material_map) === JSON.stringify([['m1', 0, 0, 0, 1, 0, 0]]),
    JSON.stringify(payload.metadata.material_map));
  // Il contratto ops NON si allarga: nessuna chiave di palette diventa '@m1', o
  // i due espansori la risolverebbero a #CCCCCC.
  check('la palette resta di soli colori (ops intatte)',
    Object.values(payload.palette).every(c => typeof c === 'string' && /^#[0-9A-F]{6}$/.test(c)),
    JSON.stringify(payload.palette));
  check('le ops restano triplette di coordinate con chiave di palette',
    payload.ops.every(op => op[0] === 'set' && typeof op[1] === 'string' && op[1][0] !== '@'),
    JSON.stringify(payload.ops));

  // IL GIRO VERO: il payload salvato viene riespanso come all'apertura di un
  // file, e i materiali tornano sui voxel giusti.
  const riletto = mod.applyMaterialMap(mod.expandOps(JSON.parse(JSON.stringify(payload))));
  const at = (x, y, z) => riletto.voxels.find(v => v.x === x && v.y === y && v.z === z);
  check('salva -> espandi -> riversa: il materiale torna sui voxel giusti',
    at(0, 0, 0).material === 'm1' && at(1, 0, 0).material === 'm1'
    && at(2, 0, 0).material === undefined, JSON.stringify(riletto.voxels));
  check('salva -> espandi -> riversa: il colore resta quello del voxel',
    at(0, 0, 0).color === '#8B5A2B' && at(2, 0, 0).color === '#FF0000',
    JSON.stringify(riletto.voxels));
  check('salva -> espandi -> riversa: le definizioni sopravvivono',
    riletto.metadata.materials.length === 1 && riletto.metadata.materials[0].texture === null,
    JSON.stringify(riletto.metadata.materials));

  // Ricarica "a mano": i voxel arrivano espansi e SENZA materiale.
  const espansi = { metadata: payload.metadata, voxels: [
    { x: 0, y: 0, z: 0, color: '#8B5A2B' },
    { x: 1, y: 0, z: 0, color: '#8B5A2B' },
    { x: 2, y: 0, z: 0, color: '#FF0000' }
  ]};
  mod.applyMaterialMap(espansi);
  check('applyMaterialMap ripristina il materiale sui voxel giusti',
    espansi.voxels[0].material === 'm1' && espansi.voxels[1].material === 'm1'
    && espansi.voxels[2].material === undefined, JSON.stringify(espansi.voxels));
}

// Un progetto SENZA materiali deve produrre esattamente il file di prima: e' la
// garanzia di non aver rotto i .voxelai e i .json esistenti.
{
  const model = { metadata: { name: 'T', grid_size: [4, 4, 4] },
    voxels: [{ x: 0, y: 0, z: 0, color: '#FF0000' }] };
  const p = loadSaveApi(model).buildObjectPayload(model);
  check('senza materiali il metadata non cresce',
    JSON.stringify(Object.keys(p.metadata)) === JSON.stringify(['name', 'grid_size']),
    JSON.stringify(p.metadata));
}

// Un file importato senza texture: la mappa c'e' ma le definizioni no. Nessun
// ramo "if (niente texture)": e' l'ASSENZA della definizione a lasciare il
// voxel a tinta unita.
{
  const orfano = { metadata: { material_map: [['m9', 0, 0, 0]] },
    voxels: [{ x: 0, y: 0, z: 0, color: '#123456' }] };
  loadSaveApi(orfano).applyMaterialMap(orfano);
  check('un id senza definizione non viene applicato (tinta unita)',
    orfano.voxels[0].material === undefined, JSON.stringify(orfano.voxels));
  check('il colore del voxel orfano non viene toccato',
    orfano.voxels[0].color === '#123456', JSON.stringify(orfano.voxels));
}

// Nessuna mappa / dati storti: nulla deve rompersi (i file di TUTTE le versioni
// precedenti passano da qui).
{
  const mod = loadSaveApi({ metadata: {}, voxels: [] });
  const semplice = { metadata: {}, voxels: [{ x: 0, y: 0, z: 0, color: '#123456' }] };
  mod.applyMaterialMap(semplice);
  check('un file senza material_map passa indenne',
    semplice.voxels[0].material === undefined, JSON.stringify(semplice.voxels));
  check('applyMaterialMap regge null', mod.applyMaterialMap(null) === null);
  const senzaMeta = { voxels: [] };
  check('applyMaterialMap regge un payload senza metadata',
    mod.applyMaterialMap(senzaMeta) === senzaMeta);
  const storto = { metadata: { materials: [Object.assign({}, LEGNO)],
      material_map: ['m1', ['m1'], ['m1', 0, 0], null, ['m1', 0, 0, 0]] },
    voxels: [{ x: 0, y: 0, z: 0, color: '#8B5A2B' }] };
  mod.applyMaterialMap(storto);
  check('le voci malformate della mappa vengono ignorate senza lanciare',
    storto.voxels[0].material === 'm1', JSON.stringify(storto.voxels));
}

// Definizioni ARRIVATE da un JSON scritto a mano: decodeToken restituisce
// `mat.color` cosi' com'e', quindi un hex storto finirebbe dentro THREE.Color
// lontano da qui. Vanno normalizzate all'ingresso.
{
  const sporco = {
    metadata: {
      materials: [
        { id: 'm1', name: 'Storto', color: 'verde', roughness: null },
        { id: 'm1', name: 'Doppione', color: '#000000' },
        { name: 'Senza id', color: '#111111' }
      ],
      material_map: [['m1', 0, 0, 0]]
    },
    voxels: [{ x: 0, y: 0, z: 0, color: '#123456' }]
  };
  loadSaveApi(sporco).applyMaterialMap(sporco);
  const defs = sporco.metadata.materials;
  check('un hex storto in ingresso viene normalizzato al neutro',
    defs[0].color === '#CCCCCC', JSON.stringify(defs[0]));
  check('un roughness null in ingresso torna al default 0.6',
    defs[0].roughness === 0.6, String(defs[0].roughness));
  check('gli id duplicati in ingresso vengono scartati (vince il primo)',
    defs.length === 1 && defs[0].name === 'Storto', JSON.stringify(defs));
  check('una definizione senza id viene scartata',
    defs.every(d => !!d.id), JSON.stringify(defs));
  check('la mappa si applica comunque dopo la normalizzazione',
    sporco.voxels[0].material === 'm1', JSON.stringify(sporco.voxels));
}

// Un voxel NASCOSTO (parte nascosta nell'outliner) conserva il materiale: nel
// ramo piatto di buildObjectPayload finisce comunque nelle ops, quindi
// scartarlo dalla mappa gli farebbe perdere la texture al primo salvataggio.
{
  const model = { metadata: { materials: [Object.assign({}, LEGNO)] }, voxels: [
    { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1', _hidden: true }
  ]};
  const mm = loadSaveApi(model).buildMaterialMap(model.voxels);
  check('un voxel nascosto non perde il materiale nel salvataggio',
    JSON.stringify(mm) === JSON.stringify([['m1', 0, 0, 0]]), JSON.stringify(mm));
}

// Sulla stessa cella il voxel VISIBILE vince su quello nascosto, in qualunque
// ordine arrivino (vedi syncVoxelsFromMap in 03-voxel-map.js).
{
  const model = { metadata: { materials: [Object.assign({}, LEGNO)] }, voxels: [
    { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1', _hidden: true },
    { x: 0, y: 0, z: 0, color: '#888888', material: 'm2' }
  ]};
  const a = loadSaveApi(model).buildMaterialMap(model.voxels);
  const b = loadSaveApi(model).buildMaterialMap(model.voxels.slice().reverse());
  check('sulla stessa cella il visibile vince sul nascosto',
    JSON.stringify(a) === JSON.stringify([['m2', 0, 0, 0]])
    && JSON.stringify(b) === JSON.stringify([['m2', 0, 0, 0]]),
    JSON.stringify(a) + ' / ' + JSON.stringify(b));
}

// Il ramo con le PARTI e' un secondo `return` in buildObjectPayload: e' stato
// dimenticato una volta e nessun test lo avrebbe visto.
{
  const model = {
    metadata: { name: 'P', materials: [Object.assign({}, LEGNO)] },
    voxels: [
      { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1', part: 'testa' },
      { x: 1, y: 0, z: 0, color: '#FF0000', part: 'corpo' }
    ]
  };
  const mod = loadSaveApi(model);
  const p = mod.buildObjectPayload(model);
  check('anche il ramo con le parti porta i materiali',
    p.parts && p.metadata.materials.length === 1
    && JSON.stringify(p.metadata.material_map) === JSON.stringify([['m1', 0, 0, 0]]),
    JSON.stringify(p.metadata));
  const riletto = mod.applyMaterialMap(mod.expandOps(JSON.parse(JSON.stringify(p))));
  const testa = riletto.voxels.find(v => v.part === 'testa');
  check('il giro completo funziona anche con le parti',
    testa && testa.material === 'm1' && testa.color === '#8B5A2B',
    JSON.stringify(riletto.voxels));
}

// Scena MULTI-oggetto: ogni oggetto porta i PROPRI materiali nel proprio
// metadata, quindi lo stesso id in due oggetti sono materiali diversi e non
// c'e' nessuna lista globale da riconciliare.
{
  const uno = { metadata: { name: 'Uno', materials: [Object.assign({}, LEGNO)] },
    voxels: [{ x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1' }] };
  const due = { metadata: { name: 'Due', materials: [
      { id: 'm1', name: 'Pietra', color: '#888888', texture: null, roughness: 0.6, metalness: 0, emissive: 0 }] },
    voxels: [{ x: 5, y: 3, z: 1, color: '#888888', material: 'm1' }] };
  const scene = [{ data: uno, name: 'Uno', transform: null, visible: true },
                 { data: due, name: 'Due', transform: null, visible: true }];
  const out = loadSaveApi(uno, scene).getSceneSavePayload();
  check('ogni oggetto della scena porta i propri materiali',
    out.objects.length === 2
    && out.objects[0].metadata.materials[0].name === 'Legno'
    && out.objects[1].metadata.materials[0].name === 'Pietra',
    JSON.stringify(out.objects.map(o => o.metadata.materials)));
  check('ogni oggetto porta la propria material_map',
    JSON.stringify(out.objects[1].metadata.material_map) === JSON.stringify([['m1', 5, 3, 1]]),
    JSON.stringify(out.objects[1].metadata.material_map));
}

// La richiesta di MODIFICA all'AI manda il modello corrente nel prompt: le
// texture sono base64 fino a 128x128 l'una (decine di KB) e all'AI non servono,
// risponde con un diff di ops. Vanno omesse, o costano piu' del modello intero.
{
  const model = { metadata: { name: 'T', materials: [Object.assign({}, LEGNO,
      { texture: { data: 'data:image/png;base64,' + 'A'.repeat(2000), w: 8, h: 8 } })] },
    voxels: [{ x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1' }] };
  const p = loadSaveApi(model).buildObjectPayload(model, { materials: false });
  check('per l\'AI i materiali vengono omessi dal payload',
    p.metadata.materials === undefined && p.metadata.material_map === undefined,
    JSON.stringify(p.metadata));
  check('senza materiali il payload per l\'AI resta un modello normale',
    p.ops.length === 1 && Object.keys(p.palette).length === 1, JSON.stringify(p.ops));
}

// --- mutua esclusione fra colore e materiale --------------------------------
// Il requisito e' simmetrico: scegliere un materiale toglie il colore, scegliere
// un colore toglie il materiale. Si verifica su activeToken(), che e' l'unico
// punto da cui l'editing legge "cosa sto posando".
//
// setActiveColor vive in 11-symmetry-tools.js, che a livello top parla con la
// scena e col DOM e non si puo' caricare intero. Se ne ESTRAE il testo: cosi' il
// controllo e' sulla funzione VERA, non su una sua imitazione scritta nel test
// (che passerebbe anche se il modulo non chiamasse mai setActiveMaterial).
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('funzione non trovata: ' + name);
  // Conteggio di graffe: regge finche' la funzione non ne contiene dentro una
  // stringa o un template literal. Vale per setActiveColor; se un giorno non
  // valesse piu', questo helper esplode invece di estrarre un pezzo storto.
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('graffa non chiusa: ' + name);
}

function fakeClassList() {
  const set = new Set();
  return {
    add: c => set.add(c), remove: c => set.delete(c),
    contains: c => set.has(c), has: c => set.has(c),
    toggle: (c, on) => { if (on) set.add(c); else set.delete(c); }
  };
}

function fakeMaterialsDom() {
  const cards = [
    { dataset: { materialId: 'm1' }, classList: fakeClassList() },
    { dataset: { materialId: 'm2' }, classList: fakeClassList() }
  ];
  const swatchRow = { classList: fakeClassList() };
  const label = { textContent: 'prima' };
  const byId = {
    materialsPanel: { querySelectorAll: () => cards },
    activeColorRow: swatchRow,
    activeMaterialName: label
  };
  return { document: { getElementById: id => byId[id] || null }, cards, swatchRow, label };
}

function loadColorAndMaterials(model, startHex) {
  const srcMat = fs.readFileSync(path.join(ROOT, 'ui/src/lib/36-materials.js'), 'latin1');
  const srcSym = fs.readFileSync(path.join(ROOT, 'ui/src/lib/11-symmetry-tools.js'), 'latin1');
  const dom = fakeMaterialsDom();
  const input = { value: '' };
  const hexEl = { textContent: '' };
  const api = new Function('currentModelData', 'document', 'activeColorHex',
    'activeColorInput', 'activeColorHexEl',
    srcMat + '\n' + extractFunction(srcSym, 'setActiveColor') + `
   ;return { activeToken, setActiveMaterial, setActiveMaterialAndSync, getActiveMaterialId,
             refreshMaterialSelectionUI, setActiveColor, materialById,
             currentColor: () => activeColorHex };`
  )(model, dom.document, startHex, input, hexEl);
  return { api, dom, input, hexEl };
}

{
  const model = { metadata: { materials: [
    { id: 'm1', name: 'Legno', color: '#8B5A2B', texture: null, roughness: 0.7, metalness: 0, emissive: 0 },
    { id: 'm2', name: 'Pietra', color: '#888888', texture: null, roughness: 0.6, metalness: 0, emissive: 0 }
  ] }, voxels: [] };
  const { api, dom, input, hexEl } = loadColorAndMaterials(model, '#FF0000');

  check('senza materiale attivo si posa il colore', api.activeToken() === '#FF0000', api.activeToken());

  api.setActiveMaterialAndSync('m1');
  check('col materiale attivo si posa il materiale', api.activeToken() === '@m1', api.activeToken());
  // Scegliere un materiale NON deve azzerare activeColorHex: il colore resta
  // quello che era, solo scavalcato da activeToken(). E' cosi' che il clic sulla
  // swatch e' una via di ritorno funzionante e non un valore da reinventare.
  check('scegliere un materiale non cancella il colore', api.currentColor() === '#FF0000',
    api.currentColor());
  check('la scheda del materiale attivo viene evidenziata',
    dom.cards[0].classList.has('active') && !dom.cards[1].classList.has('active'),
    'evidenza sbagliata');
  check('il colore viene smorzato quando comanda un materiale',
    dom.swatchRow.classList.has('muted-by-material'), 'riga colore non smorzata');
  check('il nome del materiale attivo compare', dom.label.textContent === 'Legno', dom.label.textContent);

  api.setActiveColor('#0000ff');
  check('scegliere un colore azzera il materiale', api.getActiveMaterialId() === null,
    String(api.getActiveMaterialId()));
  check('e si torna a posare il colore', api.activeToken() === '#0000FF', api.activeToken());
  check('scegliere un colore toglie l\'evidenza alla scheda',
    !dom.cards[0].classList.has('active'), 'evidenza rimasta');
  check('scegliere un colore toglie lo smorzamento',
    !dom.swatchRow.classList.has('muted-by-material'), 'smorzamento rimasto');
  check('scegliere un colore svuota il nome del materiale attivo',
    dom.label.textContent === '', dom.label.textContent);
  check('setActiveColor aggiorna comunque input ed etichetta del colore',
    input.value === '#0000ff' && hexEl.textContent === '#0000FF',
    `${input.value}/${hexEl.textContent}`);

  // Un id attivo che non esiste (definizione cancellata sotto i piedi) non deve
  // far posare '@qualcosa' di inesistente: si ricade sul colore.
  api.setActiveMaterialAndSync('m99');
  check('un materiale attivo inesistente non viene posato',
    api.activeToken() === '#0000FF', api.activeToken());
}

{
  // Il colore attivo puo' arrivare minuscolo (input type=color): il token e' la
  // chiave dei gruppi di rendering, quindi '#aabbcc' e '#AABBCC' non devono
  // essere due token diversi.
  const { api } = loadColorAndMaterials({ metadata: {}, voxels: [] }, '#aabbcc');
  check('il token colore e\' sempre maiuscolo', api.activeToken() === '#AABBCC', api.activeToken());
}

// --- la voxelMap porta il TOKEN ---------------------------------------------
// 03-voxel-map.js e' la cerniera fra la mappa (sorgente di verita' per l'editing)
// e currentModelData.voxels (cio' che finisce su disco).
function loadVoxelMap(model) {
  const srcMat = fs.readFileSync(path.join(ROOT, 'ui/src/lib/36-materials.js'), 'latin1');
  const srcMap = fs.readFileSync(path.join(ROOT, 'ui/src/lib/03-voxel-map.js'), 'latin1');
  return new Function('currentModelData', 'voxelMap', srcMat + '\n' + srcMap + `
   ;return { rebuildVoxelMap, syncVoxelsFromMap, map: () => voxelMap };`)(model, new Map());
}

{
  const model = { metadata: { materials: [Object.assign({}, LEGNO)] }, voxels: [
    { x: 0, y: 0, z: 0, color: '#ab12cd' },
    { x: 1, y: 0, z: 0, color: '#8B5A2B', material: 'm1' }
  ]};
  const mod = loadVoxelMap(model);
  mod.rebuildVoxelMap();
  check('nella voxelMap un voxel semplice e\' il suo colore maiuscolo',
    mod.map().get('0,0,0') === '#AB12CD', mod.map().get('0,0,0'));
  check('nella voxelMap un voxel texturizzato e\' @id',
    mod.map().get('1,0,0') === '@m1', mod.map().get('1,0,0'));

  mod.syncVoxelsFromMap();
  const at = (x, y, z) => model.voxels.find(v => v.x === x && v.y === y && v.z === z);
  check('il giro mappa -> voxel non inventa materiali',
    at(0, 0, 0).color === '#AB12CD' && at(0, 0, 0).material === undefined,
    JSON.stringify(at(0, 0, 0)));
  check('il giro mappa -> voxel conserva il materiale',
    at(1, 0, 0).material === 'm1' && at(1, 0, 0).color === '#8B5A2B',
    JSON.stringify(at(1, 0, 0)));
}

// ORFANO NELLA MAPPA. Il caso peggiore, e il motivo per cui syncVoxelsFromMap
// DEVE passare a decodeToken il colore proprio del voxel: il token ha collassato
// il voxel a '@m77' buttandone via l'hex, quindi su un id senza definizione (un
// .voxai aperto senza i suoi materiali) non resta nulla su cui ricadere. E
// questo array e' esattamente quello che va su disco: un solo sync dopo un
// caricamento con orfani riscriverebbe ogni voxel a #CCCCCC, per sempre.
{
  const model = { metadata: { materials: [] }, voxels: [
    { x: 1, y: 2, z: 3, color: '#8B5A2B', material: 'm77' }
  ]};
  const mod = loadVoxelMap(model);
  mod.rebuildVoxelMap();
  mod.syncVoxelsFromMap();
  const v = model.voxels[0];
  check('un voxel ORFANO non perde il suo colore in un sync',
    v.color === '#8B5A2B', JSON.stringify(v));
  check('un voxel ORFANO non perde l\'id del materiale',
    v.material === 'm77', JSON.stringify(v));
}

// Cella appena dipinta: nella mappa c'e' un token ma nell'array non c'e' ancora
// nessun voxel da cui prendere un colore di riserva. Qui il ripiego non serve --
// solo un token MATERIALE puo' essere senza colore, e un materiale appena posato
// per definizione esiste.
{
  const model = { metadata: { materials: [Object.assign({}, LEGNO)] }, voxels: [] };
  const mod = loadVoxelMap(model);
  mod.rebuildVoxelMap();
  mod.map().set('4,0,0', '#00FF00');
  mod.map().set('5,0,0', '@m1');
  mod.syncVoxelsFromMap();
  const at = (x) => model.voxels.find(v => v.x === x);
  check('una cella dipinta col colore entra col suo colore',
    at(4).color === '#00FF00' && at(4).material === undefined, JSON.stringify(at(4)));
  check('una cella dipinta col materiale prende il colore della definizione',
    at(5).color === '#8B5A2B' && at(5).material === 'm1', JSON.stringify(at(5)));
}

// I voxel NASCOSTI restano fuori dalla mappa e sopravvivono al sync, materiale
// compreso: e' il comportamento di prima, e il token non deve smontarlo.
{
  const model = { metadata: { materials: [Object.assign({}, LEGNO)] }, voxels: [
    { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1', _hidden: true },
    { x: 1, y: 0, z: 0, color: '#FF0000' }
  ]};
  const mod = loadVoxelMap(model);
  mod.rebuildVoxelMap();
  check('un voxel nascosto non entra nella voxelMap', !mod.map().has('0,0,0'),
    JSON.stringify([...mod.map().keys()]));
  mod.syncVoxelsFromMap();
  const nascosto = model.voxels.find(v => v._hidden);
  check('un voxel nascosto sopravvive al sync col suo materiale',
    nascosto && nascosto.material === 'm1' && nascosto.color === '#8B5A2B',
    JSON.stringify(model.voxels));
}

if (failures.length) { console.error(`\nFALLITI: ${failures.length}`); process.exit(1); }
console.log('  tutti i controlli passati');
