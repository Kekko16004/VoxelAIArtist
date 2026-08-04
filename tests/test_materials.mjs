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
  return new Function('currentModelData', 'localStorage', src + `
   ;return { materialsOfProject, materialById, addMaterial, removeMaterial,
             nextMaterialId, tokenOf, decodeToken, isMaterialToken,
             averageColorFromPixels, setActiveMaterial, getActiveMaterialId };`);
}

console.log('test_materials');

const fakeStore = (() => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
})();

const model = { metadata: {}, voxels: [] };
const api = loadMaterials()(model, fakeStore);

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

// --- token ---
check('tokenOf di un voxel senza materiale e\' il colore maiuscolo',
  api.tokenOf({ color: '#ab12cd' }) === '#AB12CD', api.tokenOf({ color: '#ab12cd' }));
check('tokenOf di un voxel con materiale e\' @id',
  api.tokenOf({ color: '#888888', material: 'm2' }) === '@m2');
check('isMaterialToken distingue', api.isMaterialToken('@m2') === true && api.isMaterialToken('#AABBCC') === false);

const dec = api.decodeToken('@m2');
check('decodeToken risolve il colore dal materiale',
  dec.material === 'm2' && dec.color === '#888888', JSON.stringify(dec));
const decOrfano = api.decodeToken('@m77');
check('un token orfano degrada a tinta unita neutra',
  decOrfano.material === null && /^#[0-9A-F]{6}$/.test(decOrfano.color), JSON.stringify(decOrfano));
const decCol = api.decodeToken('#AABBCC');
check('decodeToken di un colore non inventa materiali',
  decCol.material === null && decCol.color === '#AABBCC', JSON.stringify(decCol));
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
