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
  return new Function('currentModelData', src + `
   ;return { materialsOfProject, materialById, addMaterial, removeMaterial,
             nextMaterialId, tokenOf, decodeToken, isMaterialToken,
             averageColorFromPixels, setActiveMaterial, getActiveMaterialId };`);
}

// Ogni istanza ha il suo scope (e quindi il suo store): le sezioni che sporcano
// la lista lavorano su un modello proprio invece di ripulirla a mano, cosi' un
// check non puo' dipendere dall'ordine di quelli prima.
const factory = loadMaterials();
const fresh = () => {
  const model = { metadata: {}, voxels: [] };
  return { model, api: factory(model) };
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

if (failures.length) { console.error(`\nFALLITI: ${failures.length}`); process.exit(1); }
console.log('  tutti i controlli passati');
