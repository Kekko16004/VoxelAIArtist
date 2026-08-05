#!/usr/bin/env node
// Il ramo di RISCRITTURA TOTALE della modifica AI (08-generate-ai.js).
//
// Quando l'AI risponde con un modello intero invece di un diff (niente op 'del'
// e conteggio voxel simile all'attuale), `applyModifyResult` sostituisce
// l'oggetto in blocco. Quel ramo aveva due difetti, trovati dalla review del
// task 7:
//
//  1) usciva con `return` PRIMA di pushHistory(), quindi la cosa piu'
//     distruttiva che l'AI possa fare era anche l'unica non annullabile.
//  2) il payload spedito all'AI omette i materiali di proposito
//     (getSavePayload con {materials:false}: una texture base64 costerebbe piu'
//     del modello), quindi la risposta non li riporta indietro e sostituire in
//     blocco CANCELLAVA le definizioni del progetto, slegando ogni voxel.
//
// Il modulo e' un frammento di scope condiviso: si carica con new Function e
// stub minimi, come gli altri test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok - ' + m); } else { fail++; console.log('  FAIL - ' + m); } };

// --- stub DOM: ogni id esiste, ma senza comportamento ---------------------
const el = () => ({
    value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    options: [], files: [], appendChild() {}, addEventListener() {}, click() {},
    querySelectorAll: () => [], querySelector: () => null, remove() {},
});
const doc = { getElementById: () => el(), createElement: () => el(), addEventListener() {} };

const read = p => fs.readFileSync(path.join(ROOT, p), 'latin1');
// Si estrae la SOLA `applyModifyResult` dal sorgente vero. Il modulo intero
// non si carica: a livello top registra listener su elementi di altri moduli
// (toggleGrid, voxelGap...) che qui non esistono. Ritagliare la funzione tiene
// il test sul codice REALE - se cambia il sorgente, cambia cio' che si prova -
// senza dover ricostruire mezza applicazione.
function estraiFunzione(src, nome) {
    const start = src.indexOf('function ' + nome + '(');
    if (start < 0) throw new Error('funzione non trovata nel sorgente: ' + nome);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('parentesi non bilanciate estraendo ' + nome);
}
const src = read('ui/src/utils/expand-ops.js') + '\n'
    + estraiFunzione(read('ui/src/lib/08-generate-ai.js'), 'applyModifyResult');

// Ambiente condiviso: si registra cosa il modulo CHIAMA, per poterlo asserire.
function makeEnv(model, materials) {
    const log = { pushHistory: 0, invalidate: 0 };
    const obj = { id: 1, data: model };
    const api = new Function(
        'document', 'window', 'currentModelData', 'getActiveObject', 'pushHistory',
        'loadSceneFromParsed', 'rebuildVoxelMap', 'applyOpsToVoxelMap', 'syncVoxelsFromMap',
        'buildModel', 'voxelMap', 'invalidateIncremental', 'alert', 't', 'fetch',
        'updateHistoryButtons', 'requestRender', 'restoreRigForActiveObject', 'log', 'obj',
        src + `
        ;return { applyModifyResult, getModel: () => currentModelData, getObj: () => obj };`
    )(doc, { addEventListener() {} }, model, () => obj,
      () => { log.pushHistory++; }, () => {}, () => {}, () => {}, () => {},
      () => {}, new Map(), () => { log.invalidate++; }, () => {}, k => k,
      () => Promise.resolve({ ok: false }), () => {}, () => {}, () => {}, log, obj);
    return { api, log, obj };
}

console.log('test_ai_rewrite');

// Un modello con 10 voxel e un materiale con texture.
const MAT = { id: 'm1', name: 'Legno', color: '#8B5A2B', roughness: 0.6, metalness: 0, emissive: 0,
              texture: { data: 'data:image/png;base64,AAA', w: 8, h: 8 } };
const model = () => ({
    metadata: { name: 'Prova', grid_size: [16, 16, 16], materials: [JSON.parse(JSON.stringify(MAT))] },
    voxels: Array.from({ length: 10 }, (_, i) => ({ x: i, y: 0, z: 0, color: '#8B5A2B', material: 'm1' })),
});

// La risposta "modello intero": nessun 'del', e ops che rigenerano ~lo stesso
// numero di voxel. E' esattamente cio' che fa scattare il ramo distruttivo.
// FABBRICA, non costante: expandOps fa passare `data.metadata` PER
// RIFERIMENTO nel risultato, quindi un caso che ci scrive sopra sporcherebbe
// quelli successivi (misurato: il secondo caso ereditava i materiali del primo).
const rispostaIntera = () => ({
    metadata: { grid_size: [16, 16, 16] },
    palette: { a: '#FF0000' },
    ops: [['fill', 0, 0, 0, 9, 0, 0, 'a']],
});

{
    const { api, log } = makeEnv(model());
    api.applyModifyResult(rispostaIntera(), { palette: {} });
    const dopo = api.getObj().data;

    ok(dopo.voxels.length === 10, `il ramo di riscrittura totale e' scattato (${dopo.voxels.length} voxel)`);
    ok(log.pushHistory === 1,
        `pushHistory viene chiamato PRIMA di sostituire, cosi' Ctrl+Z annulla (${log.pushHistory})`);

    const mats = (dopo.metadata || {}).materials || [];
    ok(mats.length === 1 && mats[0].id === 'm1',
        `le definizioni dei materiali sopravvivono alla riscrittura (${mats.length})`);
    ok(mats.length === 1 && mats[0].texture && mats[0].texture.data,
        'e la texture con loro: la risposta dell\'AI non le contiene, vengono conservate');
    ok(log.invalidate === 1,
        `invalidateIncremental viene chiamata: currentModelData e' cambiato (${log.invalidate})`);
}

{
    // Un progetto SENZA materiali non deve guadagnarne uno vuoto: il ramo di
    // conservazione non deve inventare `materials: []`.
    const m = model();
    delete m.metadata.materials;
    const { api } = makeEnv(m);
    api.applyModifyResult(rispostaIntera(), { palette: {} });
    const meta = api.getObj().data.metadata || {};
    ok(!meta.materials || meta.materials.length === 0,
        'senza materiali non ne viene inventato uno: il file resta identico a prima');
}

{
    // Una risposta con 'del' e' un DIFF: non deve prendere il ramo di
    // sostituzione. Se lo prendesse, il test sopra passerebbe per caso.
    const { api, log } = makeEnv(model());
    api.applyModifyResult({ metadata: {}, palette: {}, ops: [['del', 0, 0, 0, 1, 0, 0]] }, { palette: {} });
    ok(log.invalidate === 0,
        'una risposta con \'del\' resta un diff e NON passa dal ramo di sostituzione');
}

console.log(`\n${fail ? 'FALLITI' : 'OK'}: ${pass} controlli passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
