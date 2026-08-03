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

console.log('[2] chiudere un pannello lo salva in localStorage');
// L'utente chiude rpOutliner: <details> aggiorna `open` e POI emette 'toggle'.
panels[0].open = false;
panels[0]._toggle();
const saved = JSON.parse(ls.getItem('voxelai.rpSections') || '[]');
ok(saved.includes('rpOutliner'), 'rpOutliner compare fra i chiusi');
ok(!saved.includes('rpView'),
   'rpView non compare: era chiuso per default, non per una scelta dell\'utente');

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

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
