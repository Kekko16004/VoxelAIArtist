/*
 * PERSISTENZA DEI PANNELLI DEL PANNELLO DESTRO.
 *
 * I quattro <details class="rp-section"> (Outliner, Proprieta', Palette, Vista)
 * devono ricordare il loro stato aperto/chiuso tra una sessione e l'altra.
 * Il test estrae initRightPanelPersist() dal sorgente e la esegue contro un DOM
 * finto, verificando che lo stato venga salvato e ripristinato.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/34-collapsible.js'), 'utf8');
const MARK = 'function initRightPanelPersist(';
if (src.indexOf(MARK) < 0) {
    console.log('FAIL: initRightPanelPersist non trovata in 34-collapsible.js');
    process.exit(1);
}
const from = src.indexOf(MARK);
// Fine della funzione: prima riga che chiude a rientro 12.
const to = src.indexOf('\n            }', from) + '\n            }'.length;

// --- DOM finto ---
const store = {};
const ls = {
    getItem: k => store[k] !== undefined ? store[k] : null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; }
};
// Quattro <details> con id stabili, come nel template. Ogni "sessione" costruisce
// pannelli NUOVI: un riavvio e' un DOM nuovo, non gli stessi oggetti riusati.
// (Riusare gli stessi renderebbe il test contraddittorio con l'idempotenza:
// la seconda chiamata deve essere un no-op sugli STESSI nodi, ma deve ripristinare
// lo stato su nodi FRESCHI. Sono due casi diversi, e vanno tenuti separati.)
function makeDetails(id, open) {
    return {
        id, open,
        dataset: {},
        addEventListener(ev, fn) { this['_' + ev] = fn; }
    };
}
function makePanels() {
    return [
        makeDetails('rpOutliner', true),
        makeDetails('rpProperties', true),
        makeDetails('rpPalette', true),
        makeDetails('rpView', false)    // l'unico senza `open` nel template
    ];
}
let panels = makePanels();
const doc = {
    querySelectorAll: sel => sel === '.rp-section[id]' ? panels : []
};

const api = new Function('document', 'localStorage',
    src.slice(from, to) + '\nreturn { initRightPanelPersist };')(doc, ls);

console.log('[1] al primo avvio (nessun dato salvato) lo stato del template e\' rispettato');
api.initRightPanelPersist();
ok(panels[0].open === true,  'rpOutliner: aperto (default template)');
ok(panels[3].open === false, 'rpView: chiuso (default template)');
ok(ls.getItem('voxelai.rpSections') === null,
   'senza azioni dell\'utente non scrive nulla: il default del template resta l\'autorita\'');

console.log('[2] chiudere un pannello salva l\'ISTANTANEA di tutti i chiusi');
// L'utente chiude rpOutliner: <details> aggiorna `open` e POI emette 'toggle'.
panels[0].open = false;
panels[0]._toggle();
const saved = JSON.parse(ls.getItem('voxelai.rpSections') || '[]');
ok(saved.includes('rpOutliner'), 'rpOutliner compare fra i chiusi');
// rpView era gia' chiuso (default del template) e non e' stato toccato, ma
// nell'istantanea c'e': si salva lo STATO, non l'ultima azione. Deve esserci,
// perche' in lettura la lista e' autoritativa (`open = !closed.has(id)`): se
// mancasse, il riavvio lo riaprirebbe. E' il difetto pinnato dal gruppo [7].
ok(saved.includes('rpView'),
   'anche rpView, chiuso e non toccato, e\' nell\'istantanea');
ok(saved.length === 2, 'e i due aperti non ci sono');

console.log('[3] riaprire un pannello lo rimuove dalla lista');
panels[0].open = true;
panels[0]._toggle();
ok(!JSON.parse(ls.getItem('voxelai.rpSections') || '[]').includes('rpOutliner'),
   'rpOutliner rimosso dopo la riapertura');

console.log('[4] idempotente: sugli STESSI nodi la seconda chiamata non fa nulla');
const before = panels[0]._toggle;
api.initRightPanelPersist();
ok(panels[0]._toggle === before, 'il listener non viene sostituito (niente doppie scritture)');

console.log('[5] al RIAVVIO (DOM nuovo) lo stato salvato viene ripristinato');
ls.setItem('voxelai.rpSections', JSON.stringify(['rpPalette']));
panels = makePanels();              // sessione nuova: nodi freschi, flag pulito
api.initRightPanelPersist();
ok(panels[2].open === false, 'rpPalette ripristinato CHIUSO');
ok(panels[0].open === true,  'rpOutliner resta aperto');
ok(panels[3].open === true,
   'rpView torna APERTO: non e\' nella lista dei chiusi, e la lista salvata batte il default del template');

console.log('[6] dato corrotto in localStorage: si riparte dal template, senza eccezioni');
ls.setItem('voxelai.rpSections', '{non json');
panels = makePanels();
let threw = false;
try { api.initRightPanelPersist(); } catch (e) { threw = true; }
ok(!threw, 'non solleva');
ok(panels[0].open === true && panels[3].open === false, 'stato del template intatto');

console.log('[7] ANDATA E RITORNO: cio\' che si scrive deve reggere il riavvio');
{
    // Il difetto che questo gruppo pinna: lo stato veniva SCRITTO a differenza
    // (aggiungi/togli il pannello toccato) ma LETTO come autoritativo (la lista
    // decide tutto). Chiudendo l'Outliner e riaprendolo la lista tornava [], e
    // al lancio dopo [] riapriva il pannello Vista, che il template spedisce
    // CHIUSO. L'utente vedeva riaprirsi un pannello che non aveva mai aperto.
    ls.removeItem('voxelai.rpSections');
    panels = makePanels();
    api.initRightPanelPersist();
    ok(panels[3].open === false, 'partenza: il template spedisce Vista chiuso');

    // L'utente chiude l'Outliner e ci ripensa subito.
    panels[0].open = false; panels[0]._toggle();
    panels[0].open = true;  panels[0]._toggle();

    // Riavvio: DOM nuovo, stessa storage.
    panels = makePanels();
    api.initRightPanelPersist();
    ok(panels[3].open === false,
       'Vista resta CHIUSO dopo aver toccato un ALTRO pannello (era il bug)');
    ok(panels[0].open === true, 'Outliner resta aperto come l\'utente l\'ha lasciato');

    // E una chiusura vera deve sopravvivere al riavvio.
    panels[1].open = false; panels[1]._toggle();
    panels = makePanels();
    api.initRightPanelPersist();
    ok(panels[1].open === false, 'un pannello chiuso davvero resta chiuso');
    ok(panels[3].open === false, 'e Vista continua a rispettare il template');
}

console.log('[8] id obsoleti: un pannello tolto dal template esce dall\'elenco');
{
    // Scrivendo a differenza, l'id di un pannello rimosso restava in storage per
    // sempre. Con l'istantanea l'elenco contiene solo cio' che esiste ADESSO.
    ls.setItem('voxelai.rpSections', JSON.stringify(['rpPalette', 'rpFantasma']));
    panels = makePanels();
    api.initRightPanelPersist();
    ok(panels[2].open === false, 'rpPalette chiuso: gli id noti valgono ancora');
    panels[2].open = true; panels[2]._toggle();
    const salvato = JSON.parse(ls.getItem('voxelai.rpSections'));
    ok(!salvato.includes('rpFantasma'),
       'rpFantasma non e\' nel DOM, quindi sparisce dall\'elenco al primo salvataggio');
}

console.log('[9] anti-flash: il ripristino gira PRIMA del primo paint');
{
    // Il bootstrap del bundle e' dentro window.load, che aspetta i cinque
    // script Three.js dal CDN: ripristinare i pannelli la' li dipinge aperti
    // (default del template) e poi li richiude sotto gli occhi dell'utente.
    // Serve un blocco sincrono inline nel template, subito dopo i <details>.
    const tpl = fs.readFileSync(path.join(ROOT, 'ui/src/index.template.html'), 'utf8');
    const F = 'function restoreRightPanels(';
    const iF = tpl.indexOf(F);
    ok(iF >= 0, 'il template contiene il blocco sincrono restoreRightPanels');

    // Deve stare DOPO l'ultimo <details class="rp-section">, altrimenti gira su
    // un DOM che non contiene ancora i pannelli e non ripristina niente.
    const iLast = tpl.lastIndexOf('<details class="rp-section"');
    ok(iF > iLast && iLast >= 0, 'sta dopo i quattro <details>, che quindi esistono gia\'');

    const END = '})();';
    const iEnd = tpl.indexOf(END, iF);
    ok(iEnd > iF, 'il blocco e\' una IIFE chiusa');
    const body = tpl.slice(iF, iEnd);
    // La regola documentata dell'anti-flash: solo localStorage. Un fetch qui
    // e' asincrono e reintroduce esattamente il lampo che il blocco elimina.
    ok(!/\bfetch\b|\bawait\b|XMLHttpRequest/.test(body),
       'legge solo localStorage: nessun fetch/await, la regola anti-flash regge');
    ok(body.includes('voxelai.rpSections'),
       'usa la stessa chiave di RP_LS_KEY in 34-collapsible.js');

    // E soprattutto: le due implementazioni devono DECIDERE ALLO STESSO MODO.
    // Sono due modelli dello stesso stato e sono liberi di divergere.
    const inline = new Function('document', 'localStorage',
        body + '}\nreturn restoreRightPanels;')(doc, ls);

    let diverse = [];
    for (const salvato of [null, [], ['rpView'], ['rpPalette'], ['rpOutliner', 'rpView'],
                           ['rpOutliner', 'rpProperties', 'rpPalette', 'rpView'],
                           ['rpFantasma']]) {
        if (salvato === null) ls.removeItem('voxelai.rpSections');
        else ls.setItem('voxelai.rpSections', JSON.stringify(salvato));

        panels = makePanels();
        inline();
        const daInline = panels.map(p => p.open);

        panels = makePanels();
        api.initRightPanelPersist();
        const daJs = panels.map(p => p.open);

        if (daInline.join() !== daJs.join()) {
            diverse.push(JSON.stringify(salvato) + ': inline ' + daInline + ' vs js ' + daJs);
        }
    }
    ok(diverse.length === 0,
       'inline e initRightPanelPersist concordano su 7 stati salvati' +
       (diverse.length ? ' -- DIVERGONO: ' + diverse.join(' | ') : ''));

    // Il blocco inline non deve toccare la storage: scriverla e' compito del
    // listener 'toggle'. Se scrivesse, al primo avvio inventerebbe un elenco.
    ls.removeItem('voxelai.rpSections');
    panels = makePanels();
    inline();
    ok(ls.getItem('voxelai.rpSections') === null, 'non scrive nulla: solo legge');
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
