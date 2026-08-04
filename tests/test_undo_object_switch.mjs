/*
 * UNDO E OGGETTI — che Ctrl+Z non scriva i voxel nell'oggetto SBAGLIATO, e che
 * creare/eliminare un oggetto sia un passo di cronologia come gli altri.
 *
 * PRIMA META' (gruppi 3-6). `undo()` scriveva `currentModelData.voxels =
 * prev.voxels` PRIMA di riportare attivo l'oggetto dello scatto. Finche'
 * l'oggetto attivo non cambia mai fra lo scatto e l'annullamento (il pennello) i
 * due coincidono e non si vede niente. Ma ogni percorso che spinge uno scatto e
 * POI cambia oggetto — Shift+A, Elimina — faceva atterrare i voxel vecchi
 * addosso all'oggetto sbagliato, che perdeva il proprio contenuto senza un
 * errore ne' un avviso. Misurato prima della fix: Elimina "Albero" (50 voxel)
 * con "Casa" (2 voxel) in scena, poi Ctrl+Z -> la Casa si ritrovava 50 voxel.
 *
 * SECONDA META' (gruppi 1, 2, 2b). Aggiungere o togliere un oggetto era un buco
 * nella cronologia: Ctrl+Z non ripescava un oggetto eliminato e non toglieva una
 * primitiva appena creata. Ora la rosa dello scatto (`sceneMeta`) decide chi
 * deve stare in scena, e chi sta per sparire viaggia in `payloads`. I test qui
 * girano in ENTRAMBE le direzioni, perche' l'errore facile e' un ciclo che
 * funziona una volta sola: annullare deve poter essere ripristinato e
 * riannullato senza che l'oggetto perda voxel, id o posto nella lista.
 *
 * L'ORDINE e' l'altra meta' del test. `buildModel()` chiama `clearRigPreview()`
 * e azzera `selectedBoneIndex` (05-build-model.js:7-19), mentre `restoreSnapshot`
 * ricostruisce l'anteprima con `applyRig()` e riseleziona l'osso. Se buildModel
 * girasse DOPO, ogni Ctrl+Z spegnerebbe il rig: e' la fix "ovvia" (spostare
 * buildModel in fondo) ed e' sbagliata. Il gruppo [3] la tiene fuori.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const H = fs.readFileSync(path.join(ROOT, 'ui/src/lib/13-history.js'), 'utf8');
const i = H.indexOf('function snapshotObjectPayload(');
const j = H.indexOf('undoBtn.addEventListener');
if (i < 0 || j < 0) {
    console.log('FAIL: blocco della cronologia non trovato in 13-history.js');
    process.exit(1);
}
const blocco = H.slice(i, j);

// Mondo finto: gli oggetti si comportano come quelli veri (createObject in
// 04-objects.js), e setActiveObject fa la sola cosa che conta qui — spostare
// currentModelData sull'oggetto giusto.
function nuovoMondo() {
    const L = { ordine: [], build: 0 };
    const harness = `
    let sceneObjects = [], activeObjectId = null, currentModelData = null;
    let selectedObjectIds = [];
    let rig = null, selectedBoneIndex = -1;
    const undoStack = [], redoStack = [];
    const MAX_HISTORY = 50;
    let __id = 1;
    function makeDefaultTransform() { return { position: {x:0,y:0,z:0}, rotationY: 0, scale: 1 }; }
    function updateHistoryButtons() {}
    function buildModel() { L.build++; L.ordine.push('buildModel'); }
    function invalidateIncremental() {}
    function clearRigPreview() { L.ordine.push('clearRigPreview'); }
    function normalizeRig(r) { return r; }
    function applyRig() { L.ordine.push('applyRig'); }
    function selectBone(k) { selectedBoneIndex = k; L.ordine.push('selectBone'); }
    function stashRigToActiveObject() {}
    function updateBoneList() {}
    function updatePoseSliders() {}
    function updateRigUI() {}
    function requestRender() {}
    let rigType = 'humanoid';
    const rigTypeControl = { querySelectorAll: () => [] };
    function setActiveObject(id) {
        const o = sceneObjects.find(x => x.id === id);
        if (!o) return null;
        activeObjectId = id;
        currentModelData = o.data;
        return o;
    }
    // Come il vero createObject (04-objects.js:12-32): accetta un id esplicito e
    // tiene nextObjectId davanti. E' cio' che permette a un oggetto di RISORGERE
    // con la propria identita' invece che come un oggetto nuovo.
    function createObject(data, opts) {
        opts = opts || {};
        const id = (opts.id != null) ? opts.id : __id++;
        if (opts.id != null && opts.id >= __id) __id = opts.id + 1;
        const o = { id: id, data: data,
            get name() { return this.data.metadata.name; },
            set name(v) { this.data.metadata.name = v; },
            transform: opts.transform || makeDefaultTransform(),
            visible: (opts.visible !== undefined) ? opts.visible : true };
        sceneObjects.push(o);
        return o;
    }
    ${blocco}
    return { undo, redo, pushHistory, createObject, setActiveObject,
        rimuovi: (id) => { sceneObjects.splice(sceneObjects.findIndex(o => o.id === id), 1); },
        setRig: (r) => { rig = r; },
        attivo: () => currentModelData,
        ordineScena: () => sceneObjects.map(o => o.data.metadata.name),
        stato: () => sceneObjects.map(o => ({
            nome: o.data.metadata.name, n: o.data.voxels.length,
            attivo: o.id === activeObjectId })) };
    `;
    return { api: new Function('L', harness)(L), L };
}

const vox = (n, c) => Array.from({ length: n }, (_, k) => ({ x: k, y: 0, z: 0, color: c }));
const trova = (s, nome) => s.find(o => o.nome === nome);

// --- 1. Shift+A: creare una primitiva e annullare ---------------------------
console.log('[1] Shift+A poi Ctrl+Z: la primitiva SPARISCE e non viene svuotata');
{
    const { api } = nuovoMondo();
    const casa = api.createObject({ metadata: { name: 'Casa' }, voxels: vox(2, '#111111') });
    api.setActiveObject(casa.id);
    api.pushHistory();                    // <- primCreate spinge lo scatto...
    const cubo = api.createObject({ metadata: { name: 'Cubo' }, voxels: vox(4096, '#ABCDEF') });
    api.setActiveObject(cubo.id);         // ...e POI cambia oggetto attivo

    api.undo();
    const s = api.stato();
    // Un oggetto che esiste ORA ma non era nella rosa dello scatto e' nato dopo:
    // annullare la creazione vuol dire toglierlo, non svuotarlo. Il difetto
    // originale lo lasciava in scena con addosso i 2 voxel della Casa.
    ok(!trova(s, 'Cubo'), 'il cubo creato dopo lo scatto viene rimosso');
    ok(trova(s, 'Casa').n === 2, 'e la Casa conserva i suoi 2 voxel');
    ok(trova(s, 'Casa').attivo === true, 'l\'oggetto attivo torna quello dello scatto');

    api.redo();
    const r = api.stato();
    ok(!!trova(r, 'Cubo'), 'Ctrl+Y lo rimette in scena');
    ok(trova(r, 'Cubo') && trova(r, 'Cubo').n === 4096,
       `con tutti i suoi 4096 voxel (ne ha ${trova(r, 'Cubo') ? trova(r, 'Cubo').n : 'nessuno'})`);
    ok(trova(r, 'Cubo') && trova(r, 'Cubo').attivo === true, 'e torna anche attivo');
    ok(trova(r, 'Casa').n === 2, 'senza toccare la Casa');
}

// --- 2. Elimina oggetto: il caso peggiore ----------------------------------
console.log('[2] Elimina (o Ctrl+X) poi Ctrl+Z: l\'oggetto torna, e il superstite non eredita i suoi voxel');
{
    const { api } = nuovoMondo();
    const casa = api.createObject({ metadata: { name: 'Casa' }, voxels: vox(2, '#111111') });
    const albero = api.createObject({ metadata: { name: 'Albero' }, voxels: vox(50, '#00FF00') });
    api.setActiveObject(albero.id);
    // objDelete/Ctrl+X: lo scatto si porta dietro il contenuto di chi sparisce.
    api.pushHistory([albero]);
    api.rimuovi(albero.id);
    api.setActiveObject(casa.id);

    api.undo();
    const s = api.stato();
    ok(trova(s, 'Casa').n === 2,
       `la Casa resta a 2 voxel (prima della fix ne ereditava 50; ora ${trova(s, 'Casa').n})`);
    ok(!!trova(s, 'Albero'), 'l\'albero torna in scena');
    ok(trova(s, 'Albero') && trova(s, 'Albero').n === 50,
       `con i suoi 50 voxel (ne ha ${trova(s, 'Albero') ? trova(s, 'Albero').n : 'nessuno'})`);
    ok(trova(s, 'Albero') && trova(s, 'Albero').attivo === true,
       'e ridiventa l\'oggetto attivo, com\'era prima dell\'eliminazione');
    // L'ordine di scena e' quello della rosa: risorgere non vuol dire finire in
    // fondo alla lista (createObject accoda, restoreSceneMeta riordina).
    ok(api.ordineScena().join(',') === 'Casa,Albero',
       `torna anche al suo posto nella lista (${api.ordineScena().join(',')})`);

    api.redo();
    const r = api.stato();
    ok(!trova(r, 'Albero'), 'Ctrl+Y lo rielimina');
    ok(trova(r, 'Casa').n === 2, 'e la Casa resta com\'era');

    api.undo();
    ok(!!trova(api.stato(), 'Albero'),
       'e si puo\' riannullare: il ciclo regge piu\' di un giro');
}

// --- 2b. L'identita' dell'oggetto risorto ----------------------------------
console.log('[2b] chi risorge riprende il PROPRIO id, non uno nuovo');
{
    const { api } = nuovoMondo();
    const casa = api.createObject({ metadata: { name: 'Casa' }, voxels: vox(2, '#111111') });
    const albero = api.createObject({ metadata: { name: 'Albero' }, voxels: vox(50, '#00FF00') });
    const idAlbero = albero.id;
    api.setActiveObject(albero.id);
    api.pushHistory([albero]);
    api.rimuovi(albero.id);
    api.setActiveObject(casa.id);
    api.undo();
    // Se risorgesse con un id nuovo, ogni scatto piu' vecchio che lo nomina
    // (la rosa, activeObjectId) punterebbe a un oggetto che non esiste piu' e
    // gli annullamenti successivi lo lascerebbero indietro.
    const tornato = api.setActiveObject(idAlbero);
    ok(!!tornato, 'l\'id di prima ritrova l\'oggetto');
    ok(tornato && tornato.data.voxels.length === 50, 'ed e\' proprio lui, con i suoi voxel');
}

// --- 2c. Il posto nella lista ----------------------------------------------
console.log('[2c] chi risorge torna al suo posto, non in fondo alla lista');
{
    const { api } = nuovoMondo();
    const casa = api.createObject({ metadata: { name: 'Casa' }, voxels: vox(2, '#111111') });
    const albero = api.createObject({ metadata: { name: 'Albero' }, voxels: vox(50, '#00FF00') });
    const muro = api.createObject({ metadata: { name: 'Muro' }, voxels: vox(8, '#333333') });
    api.setActiveObject(albero.id);
    api.pushHistory([albero]);           // si elimina quello in MEZZO
    api.rimuovi(albero.id);
    api.setActiveObject(casa.id);

    api.undo();
    // createObject accoda in fondo, quindi senza il riordino l'ordine sarebbe
    // Casa,Muro,Albero: l'oggetto tornerebbe sì, ma in un altro punto
    // dell'outliner, e l'unione (che dipende dall'ordine di scena) cambierebbe
    // risultato dopo un semplice Ctrl+Z.
    ok(api.ordineScena().join(',') === 'Casa,Albero,Muro',
       `l'ordine di scena e' quello di prima (${api.ordineScena().join(',')})`);
}

// --- 3. L'ordine: buildModel PRIMA del rig ---------------------------------
console.log('[3] buildModel gira PRIMA di applyRig (altrimenti Ctrl+Z spegne il rig)');
{
    const { api, L } = nuovoMondo();
    const o = api.createObject({ metadata: { name: 'Figura' }, voxels: vox(5, '#111111') });
    api.setActiveObject(o.id);
    api.setRig({ type: 'humanoid', binding: 'rigid', bones: [{ name: 'root' }, { name: 'testa' }],
                 pose: {}, posePos: {}, weights: null, customAnims: [] });
    api.pushHistory();
    api.attivo().voxels = vox(9, '#FF0000');

    L.ordine.length = 0;
    api.undo();
    const iB = L.ordine.indexOf('buildModel'), iA = L.ordine.indexOf('applyRig');
    ok(iB >= 0, 'buildModel viene chiamato');
    ok(iA >= 0, 'e l\'anteprima del rig viene ricostruita');
    ok(iB < iA,
       `buildModel PRIMA di applyRig (ordine: ${L.ordine.join(' -> ')})`);
    ok(L.ordine.lastIndexOf('selectBone') > iB,
       'e l\'osso viene riselezionato dopo (buildModel azzera selectedBoneIndex)');
}

// --- 4. Il caso normale non deve cambiare ----------------------------------
console.log('[4] pennellata senza cambio oggetto: undo e redo invariati');
{
    const { api } = nuovoMondo();
    const casa = api.createObject({ metadata: { name: 'Casa' }, voxels: vox(2, '#111111') });
    api.setActiveObject(casa.id);
    api.pushHistory();
    api.attivo().voxels = vox(9, '#FF0000');

    api.undo();
    ok(api.stato()[0].n === 2, 'Ctrl+Z riporta ai 2 voxel di prima');
    api.redo();
    ok(api.stato()[0].n === 9, 'Ctrl+Y li rifa\' tornare 9');
    api.undo();
    ok(api.stato()[0].n === 2, 'e si puo\' riannullare');
}

// --- 5. Redo dopo un cambio oggetto ----------------------------------------
console.log('[5] anche il redo scrive nell\'oggetto giusto');
{
    const { api } = nuovoMondo();
    const casa = api.createObject({ metadata: { name: 'Casa' }, voxels: vox(2, '#111111') });
    api.setActiveObject(casa.id);
    api.pushHistory();
    api.attivo().voxels = vox(9, '#FF0000');       // pennellata sulla Casa
    const cubo = api.createObject({ metadata: { name: 'Cubo' }, voxels: vox(4096, '#ABCDEF') });
    api.setActiveObject(cubo.id);                  // Shift+A

    api.undo();                                    // torna alla Casa a 2, il cubo esce di scena
    api.redo();
    const s = api.stato();
    ok(trova(s, 'Cubo') && trova(s, 'Cubo').n === 4096,
       `il redo rimette il cubo intero (${trova(s, 'Cubo') ? trova(s, 'Cubo').n : 'sparito'} voxel)`);
    // La pennellata da 9 NON torna, ed e' corretto: lo scatto di redo viene preso
    // quando si preme Ctrl+Z, e in quel momento l'attivo era gia' il cubo. Uno
    // scatto porta i voxel del SOLO oggetto attivo (13-history.js:6-10), quindi i
    // 9 voxel della Casa non erano nella pila di redo per cominciare. Cio' che
    // conta e' che il redo non li inventi addosso a qualcun altro.
    ok(trova(s, 'Casa').n === 2,
       `la Casa resta com'era dopo l'annullamento (${trova(s, 'Casa').n} voxel), senza ereditare i 4096 del cubo`);
}

// --- 6. Uno scatto che punta a un oggetto sparito non deve rompere ---------
console.log('[6] se l\'oggetto dello scatto non esiste piu\', Ctrl+Z non solleva');
{
    const { api } = nuovoMondo();
    const casa = api.createObject({ metadata: { name: 'Casa' }, voxels: vox(2, '#111111') });
    const altro = api.createObject({ metadata: { name: 'Altro' }, voxels: vox(7, '#222222') });
    api.setActiveObject(altro.id);
    api.pushHistory();
    api.rimuovi(altro.id);                         // eliminato DOPO lo scatto
    api.setActiveObject(casa.id);
    let sollevato = null;
    try { api.undo(); } catch (e) { sollevato = e; }
    ok(sollevato === null, 'nessuna eccezione' + (sollevato ? ': ' + sollevato.message : ''));
    ok(trova(api.stato(), 'Casa').n === 2,
       `e la Casa non eredita i voxel dell'oggetto sparito (${trova(api.stato(), 'Casa').n})`);
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
