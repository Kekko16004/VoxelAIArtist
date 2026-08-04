/*
 * CTRL+A NELLA VISTA = tutte le chiavi, ma del SOLO frame dove sono.
 *
 * Nella timeline Ctrl+A prende tutta la clip. Nella viewport, col personaggio a
 * schermo mentre si posa, serve l'altra meta': "me li seleziona TUTTI ma di quel
 * frame esatto dove sono", cioe' la COLONNA sotto il playhead. Sono due gesti
 * diversi con lo stesso tasto, distinti da dove sta il puntatore.
 *
 * Qui gira la vera tlSelectKeysAtCurrentFrame, estratta dal sorgente, con il vero
 * tlKeysAtTime sotto. Le asserzioni guardano QUALI chiavi finiscono in tlSelected,
 * non se una stringa compare nel file: lo scoping del tasto e' gia' coperto da
 * test_timeline_select_all.mjs, questo copre cosa viene selezionato.
 *
 * Le tre trappole vere di questa funzione:
 *  1. il playhead e' un NUMERO DI FRAME, le chiavi vivono in SECONDI. Confrontare
 *     tlFrame con k.t direttamente prende sempre e solo il frame 0 (dove i due
 *     valori coincidono per caso), e con la clip ferma all'inizio sembra
 *     funzionare benissimo.
 *  2. durante il play tlFrame e' FRAZIONARIO: senza arrotondare, la colonna non
 *     esiste mai e Ctrl+A non fa niente.
 *  3. un frame senza chiavi deve riportare false, non "selezione vuota": se
 *     consumasse comunque l'evento, Ctrl+A nella vista diventerebbe un tasto
 *     morto che ha anche spento il gizmo globale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m, extra) => {
    if (c) { pass++; console.log('  OK  ' + m); }
    else { fail++; console.log('  FAIL ' + m + (extra === undefined ? '' : '   ' + extra)); }
};

const tlSrc = fs.readFileSync(path.join(ROOT, 'ui/src/lib/33-timeline.js'), 'utf8');

const FN = ['tlKeyTimesByBone', 'tlKeysAtTime', 'tlSelectKeysAtCurrentFrame',
            'tlSelectAllKeys'];
const at = {};
FN.forEach(n => { at[n] = tlSrc.indexOf('function ' + n + '('); });
const mancanti = FN.filter(n => at[n] < 0);
if (mancanti.length) {
    console.log('FAIL: non trovate in 33-timeline.js: ' + mancanti.join(', '));
    process.exit(1);
}
const endOf = (src, from) => {
    // Fine della funzione: prima riga che chiude a rientro 12 (stile del progetto).
    const close = src.indexOf('\n            }', from);
    return close < 0 ? src.length : close + '\n            }'.length;
};

// tlTimeOfFrame viene dal sorgente VERO e non ricopiata: e' meta' della
// conversione sotto esame, e una copia qui sarebbe libera di divergere.
const iTOF = tlSrc.indexOf('function tlTimeOfFrame(');
if (iTOF < 0) { console.log('FAIL: tlTimeOfFrame non trovata'); process.exit(1); }

const harness = `
    const FPS = 24;
    let tlSelected = [];
    let tlFrame = 0;
    let ACTIVE_ANIM = null;
    let redraws = 0, toolbarUpdates = 0, closedChanMenu = 0;
    let chanOpen = false;
    function tlFps() { return FPS; }
    function tlActiveAnim() { return ACTIVE_ANIM; }
    function tlRedraw() { redraws++; }
    function tlUpdateToolbar() { toolbarUpdates++; }
    function tlChanMenuOpen() { return chanOpen; }
    function tlCloseChanMenu() { chanOpen = false; closedChanMenu++; }
    function tlIsSelectedKey(bone, t) {
        return tlSelected.some(s => s.bone === bone && Math.abs(s.t - t) < 1e-6);
    }
    ${tlSrc.slice(iTOF, tlSrc.indexOf('\n', iTOF))}
`;

const api = new Function(harness
    + FN.map(n => tlSrc.slice(at[n], endOf(tlSrc, at[n]))).join('\n')
    + `
    return {
        colonna: tlSelectKeysAtCurrentFrame,
        tutte: tlSelectAllKeys,
        setAnim: a => { ACTIVE_ANIM = a; },
        setFrame: f => { tlFrame = f; },
        setChanOpen: v => { chanOpen = v; },
        sel: () => tlSelected,
        setSel: s => { tlSelected = s; },
        stats: () => ({ redraws, toolbarUpdates, closedChanMenu })
    };`)();

// Frame 0 / 6 / 12 a 24 fps = 0 / 0.25 / 0.5 s, con conteggi DIVERSI per colonna
// (2 / 1 / 3): un bug che prende sempre la prima traccia, o sempre lo stesso
// numero di chiavi, passerebbe con colonne uguali. upperArm_L ha una chiave SOLA,
// e non nella prima colonna: prenderla dimostra che si scorrono tutte le tracce.
const ANIM = () => ({
    name: 'test', duration: 1, fps: 24,
    tracks: [
        { bone: 'hips',       keys: [{ t: 0 }, { t: 0.25 }, { t: 0.5 }] },
        { bone: 'upperArm_R', keys: [{ t: 0 }, { t: 0.5 }] },
        { bone: 'upperArm_L', keys: [{ t: 0.5 }] }
    ]
});
const etichette = () => api.sel().map(s => s.bone + '@' + Math.round(s.t * 24))
    .sort().join(' ');

console.log('[1] prende la colonna del frame corrente, e solo quella');
api.setAnim(ANIM());
api.setSel([]);
api.setFrame(12);                          // 0.5 s
ok(api.colonna() === true, 'riporta true: c\'era qualcosa da selezionare');
ok(api.sel().length === 3, 'le 3 chiavi di quell\'istante', api.sel().length);
ok(etichette() === 'hips@12 upperArm_L@12 upperArm_R@12',
   'esattamente quelle tre, una per traccia', etichette());
ok(api.sel().some(s => s.bone === 'upperArm_L'),
   'compreso l\'osso che ha una chiave SOLO li\' (non solo la prima traccia)');
ok(api.stats().redraws > 0 && api.stats().toolbarUpdates > 0,
   'ridisegna e riabilita il pulsante Elimina');

console.log('[2] su un altro frame prende un\'altra colonna');
api.setSel([]);
api.setFrame(6);                           // 0.25 s: solo hips
ok(api.colonna() === true && api.sel().length === 1, 'al frame 6 c\'e\' una chiave sola',
   api.sel().length);
ok(etichette() === 'hips@6', 'ed e\' quella di hips', etichette());

api.setSel([]);
api.setFrame(0);
ok(api.colonna() === true && api.sel().length === 2, 'al frame 0 ce ne sono 2',
   api.sel().length);
ok(etichette() === 'hips@0 upperArm_R@0', 'hips e upperArm_R', etichette());

console.log('[3] NON e\' tutta la clip: e\' il punto della richiesta');
// La clip ha 6 chiavi in tutto. Se la colonna ne prendesse 6 la meta' "vista"
// sarebbe indistinguibile dalla meta' "timeline", e la funzione non servirebbe.
api.setSel([]);
api.setFrame(12);
api.colonna();
const dellaColonna = api.sel().length;
api.setSel([]);
api.tutte();
ok(api.sel().length === 6, 'controllo: tutta la clip fa 6 chiavi', api.sel().length);
ok(dellaColonna === 3 && dellaColonna < api.sel().length,
   'la colonna ne prende meno: 3 su 6', dellaColonna + ' su ' + api.sel().length);

console.log('[4] frame senza chiavi: false, e la selezione resta com\'era');
api.setAnim(ANIM());
api.setSel([{ bone: 'hips', t: 0 }]);
api.setFrame(9);                           // 0.375 s: nessuna chiave
ok(api.colonna() === false, 'riporta false');
ok(api.sel().length === 1 && api.sel()[0].bone === 'hips',
   'e non tocca la selezione esistente', JSON.stringify(api.sel()));
// Il "riporta false" e' cio' che nell'handler evita di consumare l'evento: senza,
// Ctrl+A nella vista sarebbe un tasto morto che ha anche spento il gizmo.

console.log('[5] preset in sola lettura (nessuna clip modificabile): no-op onesto');
api.setAnim(null);
api.setSel([]);
ok(api.colonna() === false, 'su una preset riporta false');
ok(api.sel().length === 0, 'e non seleziona nulla');

console.log('[6] il playhead e\' in FRAME, le chiavi in secondi');
// La trappola numero 1. Al frame 0 i due valori coincidono per caso, quindi un
// confronto sbagliato (k.t contro tlFrame senza conversione) passa inosservato
// finche' non si sposta il playhead. Qui si sposta.
api.setAnim(ANIM());
api.setSel([]);
api.setFrame(12);
api.colonna();
ok(api.sel().length === 3,
   'al frame 12 (= 0.5 s) la colonna esiste: la conversione c\'e\'', api.sel().length);
ok(api.sel().every(s => Math.abs(s.t - 0.5) < 1e-6),
   'e i tempi salvati sono in SECONDI, come li vuole tlApplyKeyDelta',
   JSON.stringify(api.sel()));

console.log('[7] durante il play il frame e\' frazionario');
// La trappola numero 2: senza Math.round, 11.97 non becca nessuna chiave e
// Ctrl+A durante la riproduzione non fa niente.
api.setAnim(ANIM());
api.setSel([]);
api.setFrame(11.97);
ok(api.colonna() === true && api.sel().length === 3,
   'un playhead a 11.97 prende comunque la colonna del frame 12', api.sel().length);
api.setSel([]);
api.setFrame(12.4);
ok(api.colonna() === true && api.sel().length === 3,
   'e cosi\' 12.4', api.sel().length);
api.setSel([]);
api.setFrame(12.6);
ok(api.colonna() === false,
   'ma 12.6 arrotonda a 13, che di chiavi non ne ha: non inventa niente');

console.log('[8] toggle: ripremendo si deseleziona');
api.setAnim(ANIM());
api.setSel([]);
api.setFrame(12);
api.colonna();
ok(api.sel().length === 3, 'prima pressione: 3', api.sel().length);
ok(api.colonna() === true && api.sel().length === 0,
   'seconda pressione sulla stessa colonna: svuota', api.sel().length);
// Da una selezione PARZIALE deve completare, non svuotare: altrimenti dopo aver
// cliccato una chiave a mano Ctrl+A cancellerebbe la selezione invece di
// estenderla.
api.setSel([{ bone: 'hips', t: 0.5 }]);
ok(api.colonna() === true && api.sel().length === 3,
   'da selezione parziale completa la colonna', api.sel().length);
// E una selezione di ALTRE chiavi (stesso numero, tempi diversi) non deve
// contare come "colonna gia' presa": e' il caso che un confronto sui soli
// conteggi sbaglierebbe.
api.setSel([{ bone: 'hips', t: 0 }, { bone: 'upperArm_R', t: 0 },
            { bone: 'hips', t: 0.25 }]);
api.colonna();
ok(etichette() === 'hips@12 upperArm_L@12 upperArm_R@12',
   'tre chiavi di un ALTRO istante non contano come colonna gia\' selezionata',
   etichette());

console.log('[9] chiude prima il menu dei canali, che ha la priorita\' sui tasti');
api.setAnim(ANIM());
api.setFrame(12);
api.setSel([]);
api.setChanOpen(true);
const c0 = api.stats().closedChanMenu;
api.colonna();
ok(api.stats().closedChanMenu === c0 + 1, 'il menu dei canali viene chiuso');

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
