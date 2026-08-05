/*
 * CTRL+X = TAGLIA L'OGGETTO ATTIVO (la X di Blender).
 *
 * La richiesta era che la primitiva appena creata con Shift+A fosse "un oggetto
 * come gli altri": Canc la elimina, Ctrl+X pure, e in entrambi i casi e' un
 * PASSO di cronologia, quindi Ctrl+Z riporta indietro davvero.
 *
 * Tre trappole, tutte gia' viste in questo file di sorgenti:
 *
 * 1. IL RAMO IRRAGGIUNGIBILE. Il blocco `if (e.ctrlKey || e.metaKey)` in
 *    13-history.js termina con un `return` incondizionato: qualunque gestione di
 *    Ctrl+X scritta PIU' IN BASSO nello stesso handler non viene mai eseguita, e
 *    il tasto sembra semplicemente non fare nulla. Il gruppo [1] lo prova
 *    eseguendo il vero blocco.
 *
 * 2. LA CONFERMA SPENTA DA UN EVENTO. `objDelete` e' agganciata ANCHE come
 *    listener del pulsante Elimina (11-symmetry-tools.js:111), quindi il suo
 *    `opts` puo' essere un MouseEvent. Con un controllo di verita' del tipo
 *    `opts && !opts.conferma` il click sul pulsante salterebbe la conferma e
 *    l'oggetto sparirebbe senza chiedere niente: serve il confronto esplicito
 *    con `false`. Il gruppo [4] tiene ferma la differenza fra le due chiamate.
 *
 * 3. LA X CHE VALE GIA' ALTRO. Sopra la timeline la X elimina i keyframe
 *    selezionati (33-timeline.js:1475) e in un campo di testo Ctrl+X e' il
 *    taglio nativo: in nessuno dei due casi l'utente si aspetta di perdere un
 *    oggetto della scena. Il gruppo [2] prova ogni guardia una per una, e il
 *    gruppo [3] i modificatori che NON devono attivare il taglio.
 *
 * Il test esegue il codice VERO estratto dai sorgenti: nessuno stub di
 * objDelete, nessun confronto sul testo del sorgente.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const H = fs.readFileSync(path.join(ROOT, 'ui/src/lib/13-history.js'), 'utf8');
const O = fs.readFileSync(path.join(ROOT, 'ui/src/lib/04-objects.js'), 'utf8');

// Il blocco Ctrl del keydown globale. Chiude su una graffa a 16 spazi; quelle
// annidate stanno a 20 o piu', quindi il confine e' univoco.
const kStart = H.indexOf('if (e.ctrlKey || e.metaKey) {');
const kEnd = H.indexOf('\n                }', kStart);
if (kStart < 0 || kEnd < 0) {
    console.log('FAIL: blocco Ctrl del keydown non trovato in 13-history.js');
    process.exit(1);
}
const bloccoCtrl = H.slice(kStart, kEnd + '\n                }'.length);

// objDelete vera, dal suo file. Chiude a 12 spazi.
const dStart = O.indexOf('function objDelete(');
const dEnd = O.indexOf('\n            }', dStart);
if (dStart < 0 || dEnd < 0) {
    console.log('FAIL: objDelete non trovata in 04-objects.js');
    process.exit(1);
}
const fonteObjDelete = O.slice(dStart, dEnd + '\n            }'.length);

ok(/Ctrl\+X|ctrlKey/.test(bloccoCtrl) && bloccoCtrl.indexOf("e.key === 'x'") >= 0,
   'il taglio e\' DENTRO il blocco Ctrl (che esce con return su ogni combinazione)');

function nuovoMondo(cfg) {
    cfg = cfg || {};
    const L = { conferme: [], storia: [], build: 0, prevenuto: false };
    const harness = `
    let sceneObjects = [], activeObjectId = null, currentModelData = null;
    let selectedObjectIds = [], activePartName = null;
    let __id = 1;
    const RISPOSTA = ${cfg.confermaRisposta === false ? 'false' : 'true'};
    let modale = ${cfg.modale ? 'true' : 'false'};
    let sullaTimeline = ${cfg.timeline ? 'true' : 'false'};
    function confirm(msg) { L.conferme.push(msg); return RISPOSTA; }
    // Il bundle vero ha SEMPRE t (23-i18n.js sta prima di tutti nel manifest): la
    // carenza era dello stub, non del sorgente. Prima di bootI18n il t vero
    // ritorna la chiave nuda, quindi questo riproduce il caso reale peggiore.
    function t(k, vars) { return k; }
    function tlModalOpen() { return modale; }
    function tlAreaActive() { return sullaTimeline; }
    function isTextEntry(t) {
        return !!(t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text')));
    }
    function pushHistory(carry) {
        L.storia.push(Array.isArray(carry) ? carry.map(o => o.name) : null);
    }
    function undo() { L.storia.push('undo'); }
    function redo() { L.storia.push('redo'); }
    function buildModel() { L.build++; }
    function rebuildVoxelMap() {}
    function renderObjectsList() {}
    function invalidateIncremental() {}
    function makeDefaultTransform() { return { position: {x:0,y:0,z:0}, rotationY: 0, scale: 1 }; }
    function createObject(data) {
        const o = { id: __id++, data: data,
            get name() { return this.data.metadata.name; },
            set name(v) { this.data.metadata.name = v; },
            transform: makeDefaultTransform(), visible: true };
        sceneObjects.push(o);
        return o;
    }
    function setActiveObject(id) {
        const o = sceneObjects.find(x => x.id === id);
        if (!o) return null;
        activeObjectId = id; currentModelData = o.data; return o;
    }
    function getActiveObject() { return sceneObjects.find(o => o.id === activeObjectId) || null; }
    ${fonteObjDelete}
    function onKey(e) {
        const t = e.target;
        const isRange = !!(t && t.tagName === 'INPUT' && t.type === 'range');
        const isTextField = isTextEntry(t);
        ${bloccoCtrl}
    }
    return { onKey, objDelete, createObject, setActiveObject,
        setParte: (p) => { activePartName = p; },
        nomi: () => sceneObjects.map(o => o.name),
        attivo: () => { const o = getActiveObject(); return o ? o.name : null; } };
    `;
    return { api: new Function('L', harness)(L), L };
}

const vox = (n) => Array.from({ length: n }, (_, k) => ({ x: k, y: 0, z: 0, color: '#111111' }));
// Evento finto. `target` di default e' il body: non un campo di testo.
function tasto(k, extra) {
    const e = Object.assign({
        key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
        target: { tagName: 'BODY' }, prevenuto: false
    }, extra || {});
    e.preventDefault = () => { e.prevenuto = true; };
    return e;
}
function scenaDueOggetti(cfg) {
    const m = nuovoMondo(cfg);
    const casa = m.api.createObject({ metadata: { name: 'Casa' }, voxels: vox(2) });
    const cubo = m.api.createObject({ metadata: { name: 'Cubo' }, voxels: vox(9) });
    m.api.setActiveObject(cubo.id);
    m.L.storia.length = 0; m.L.conferme.length = 0;
    return Object.assign(m, { casa, cubo });
}

// --- 1. Il taglio ----------------------------------------------------------
console.log('[1] Ctrl+X elimina l\'oggetto attivo, senza conferma, come passo di cronologia');
{
    const { api, L } = scenaDueOggetti();
    const e = tasto('x', { ctrlKey: true });
    api.onKey(e);
    ok(api.nomi().join(',') === 'Casa', `il Cubo esce di scena (restano: ${api.nomi().join(',')})`);
    ok(L.conferme.length === 0, 'senza chiedere conferma (Ctrl+Z e\' la rete, la conferma sarebbe attrito)');
    ok(L.storia.length === 1, 'ed e\' UN passo di cronologia');
    ok(L.storia[0] && L.storia[0].join(',') === 'Cubo',
       `lo scatto si porta dietro il contenuto del Cubo (${JSON.stringify(L.storia[0])}) — senza, Ctrl+Z non avrebbe i suoi voxel`);
    ok(api.attivo() === 'Casa', 'e l\'oggetto attivo passa a quello rimasto');
    ok(e.prevenuto === true, 'l\'evento viene consumato');
}

console.log('[1b] la X maiuscola (Ctrl+Maiusc bloccato a parte) e Meta+X valgono uguale');
{
    const a = scenaDueOggetti();
    a.api.onKey(tasto('X', { ctrlKey: true }));
    ok(a.api.nomi().join(',') === 'Casa', 'Ctrl+X con key "X" taglia');
    const b = scenaDueOggetti();
    b.api.onKey(tasto('x', { metaKey: true }));
    ok(b.api.nomi().join(',') === 'Casa', 'Cmd+X taglia (macOS)');
}

console.log('[1c] Ctrl+X sull\'ultimo oggetto non lascia la scena vuota');
{
    const m = nuovoMondo();
    const solo = m.api.createObject({ metadata: { name: 'Unico' }, voxels: vox(5) });
    m.api.setActiveObject(solo.id);
    m.api.onKey(tasto('x', { ctrlKey: true }));
    ok(m.api.nomi().length === 1, 'resta un oggetto in scena');
    ok(m.api.nomi()[0] === 'Oggetto 1', `ed e\' quello vuoto di riserva (${m.api.nomi()[0]})`);
    ok(m.api.attivo() === 'Oggetto 1', 'che diventa attivo: currentModelData non resta appeso al morto');
}

// --- 2. Le guardie ---------------------------------------------------------
console.log('[2] dove la X vale gia\' altro, l\'oggetto non si tocca');
{
    const a = scenaDueOggetti();
    const eA = tasto('x', { ctrlKey: true, target: { tagName: 'INPUT', type: 'text' } });
    a.api.onKey(eA);
    ok(a.api.nomi().join(',') === 'Casa,Cubo', 'in un campo di testo nessun oggetto viene eliminato');
    ok(eA.prevenuto === false, 'e l\'evento NON viene consumato: resta il taglio nativo del testo');

    const b = scenaDueOggetti({ modale: true });
    const eB = tasto('x', { ctrlKey: true });
    b.api.onKey(eB);
    ok(b.api.nomi().join(',') === 'Casa,Cubo', 'con una modale aperta la tastiera e\' sua');
    ok(eB.prevenuto === false, 'e l\'evento le arriva intatto');

    const c = scenaDueOggetti({ timeline: true });
    const eC = tasto('x', { ctrlKey: true });
    c.api.onKey(eC);
    ok(c.api.nomi().join(',') === 'Casa,Cubo',
       'sopra la timeline la X e\' gia\' "elimina i keyframe selezionati"');
    ok(eC.prevenuto === false, 'e l\'evento resta disponibile alla timeline');
}

console.log('[3] i modificatori che NON sono il taglio');
{
    const a = scenaDueOggetti();
    a.api.onKey(tasto('x', { ctrlKey: true, shiftKey: true }));
    ok(a.api.nomi().join(',') === 'Casa,Cubo', 'Ctrl+Maiusc+X non taglia');
    const b = scenaDueOggetti();
    b.api.onKey(tasto('x', { ctrlKey: true, altKey: true }));
    ok(b.api.nomi().join(',') === 'Casa,Cubo', 'Ctrl+Alt+X non taglia');
    const c = scenaDueOggetti();
    c.api.onKey(tasto('x'));
    ok(c.api.nomi().join(',') === 'Casa,Cubo',
       'la X nuda non taglia (nel Disegna e sulla timeline vale altro)');
    // Il vicino di casa: Ctrl+Z passa dallo stesso blocco e non deve essere
    // stato disturbato dall'aggiunta del ramo.
    const d = scenaDueOggetti();
    d.api.onKey(tasto('z', { ctrlKey: true }));
    ok(d.L.storia.join(',') === 'undo', 'e Ctrl+Z continua ad annullare');
    ok(d.api.nomi().join(',') === 'Casa,Cubo', 'senza eliminare niente');
}

// --- 4. objDelete: conferma sì dal pulsante, no da Ctrl+X ------------------
console.log('[4] objDelete: il pulsante chiede conferma, Ctrl+X no');
{
    // Come 11-symmetry-tools.js:111 la aggancia: bind('objDeleteBtn', objDelete).
    // L'argomento e' un MouseEvent, non le opzioni.
    const a = scenaDueOggetti();
    const r = a.api.objDelete({ type: 'click', clientX: 12, clientY: 30, bubbles: true });
    ok(a.L.conferme.length === 1,
       'un evento del mouse al posto delle opzioni NON spegne la conferma');
    ok(r === true && a.api.nomi().join(',') === 'Casa', 'e con il sì l\'oggetto viene eliminato');

    const b = scenaDueOggetti({ confermaRisposta: false });
    const r2 = b.api.objDelete({ type: 'click' });
    ok(r2 === false, 'con il no torna false');
    ok(b.api.nomi().join(',') === 'Casa,Cubo', 'e la scena non cambia');
    ok(b.L.storia.length === 0,
       'né viene spinto uno scatto: un annullamento a vuoto mangerebbe un passo di cronologia');

    const c = scenaDueOggetti({ confermaRisposta: false });
    const r3 = c.api.objDelete({ conferma: false });
    ok(r3 === true && c.api.nomi().join(',') === 'Casa',
       'con {conferma:false} taglia anche se confirm avrebbe detto no');
    ok(c.L.conferme.length === 0, 'senza nemmeno chiamarlo');
}

console.log('[4b] con una parte attiva, Ctrl+X taglia la PARTE, non l\'oggetto');
{
    const { api, L } = scenaDueOggetti();
    api.setParte('braccio_L');
    api.onKey(tasto('x', { ctrlKey: true }));
    ok(api.nomi().join(',') === 'Casa,Cubo', 'l\'oggetto resta in scena');
    ok(L.storia.length === 1, 'ed e\' comunque un passo annullabile');
    ok(L.conferme.length === 0, 'anche qui senza conferma');
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
