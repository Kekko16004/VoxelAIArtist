/*
 * AIUTO (F1) — la modale non deve nascere SOTTO un'altra modale.
 *
 * helpOverlay ha z-index 70; primOverlay ne ha 95 e importOverlay 90. Con un
 * dialogo aperto, F1 costruiva l'Aiuto invisibile dietro di esso, e quello
 * ricompariva dal nulla appena il dialogo si chiudeva. Nessun test toccava
 * questo percorso: l'unica occorrenza di "F1" in tests/ era una variabile
 * locale in test_timeline_select_all.mjs.
 *
 * Qui il blocco initHelpModal viene ESTRATTO dal sorgente ed ESEGUITO contro un
 * DOM finto, quindi le asserzioni guardano gli effetti (quale display ha
 * l'overlay, se renderHelp e' stato chiamato) e non la forma del codice: una
 * guardia scritta con altri nomi passerebbe comunque, una guardia assente no.
 *
 * Le due trappole che questo file tiene ferme:
 *  - aprire sotto un'altra modale (il difetto);
 *  - il rovescio: la guardia non deve INTRAPPOLARE l'Aiuto gia' aperto. Se
 *    fosse messa prima del controllo isOpen(), con un dialogo sopra F1 non
 *    riuscirebbe piu' a chiudere l'Aiuto.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/31-help.js'), 'utf8');
const APRI = '(function initHelpModal() {';
const CHIUDI = '})();';
const da = src.indexOf(APRI);
const a = da < 0 ? -1 : src.indexOf(CHIUDI, da);
if (da < 0 || a < 0) {
    console.log('FAIL: blocco initHelpModal non trovato in 31-help.js');
    process.exit(1);
}
const blocco = src.slice(da, a + CHIUDI.length);

// --- DOM finto -------------------------------------------------------------
// Un id sconosciuto restituisce undefined, non un proxy complice: un id
// sbagliato nel sorgente diventa un TypeError qui, non un bug in produzione.
function elemento(id) {
    return {
        id,
        value: '',
        fuochi: 0,
        style: { display: 'none' },
        _h: {},
        addEventListener(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); },
        emetti(ev, arg) { (this._h[ev] || []).forEach(f => f.call(this, arg)); },
        focus() { this.fuochi++; }
    };
}

function scena({ modaleAperta = false, senzaTlModalOpen = false, senzaOverlay = false } = {}) {
    const els = {
        openHelpBtn: elemento('openHelpBtn'),
        helpCloseBtn: elemento('helpCloseBtn'),
        helpSearch: elemento('helpSearch')
    };
    if (!senzaOverlay) els.helpOverlay = elemento('helpOverlay');
    const stato = { render: 0, ultimaQuery: null, modaleAperta };
    const doc = {
        _h: {},
        getElementById(id) { return els[id]; },
        addEventListener(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); },
        tasto(key) {
            const e = { key, impedito: 0, preventDefault() { this.impedito++; } };
            (this._h.keydown || []).forEach(f => f(e));
            return e;
        },
        listenerTastiera() { return (this._h.keydown || []).length; }
    };
    const renderHelp = (q) => { stato.render++; stato.ultimaQuery = q; };
    const tlModalOpen = senzaTlModalOpen ? undefined : () => stato.modaleAperta;
    new Function('document', 'renderHelp', 'tlModalOpen', blocco)(doc, renderHelp, tlModalOpen);
    return { doc, els, stato, ov: els.helpOverlay };
}

const aperto = s => s.ov.style.display === 'flex';

// --- 1. il comportamento base: F1 apre, F1 richiude ------------------------
console.log('[1] F1 apre e richiude quando non c\'e\' nient\'altro');
{
    const s = scena();
    ok(!aperto(s), 'parte chiuso');
    s.doc.tasto('F1');
    ok(aperto(s), 'F1 apre l\'Aiuto');
    ok(s.stato.render === 1, 'l\'apertura ricostruisce il contenuto (lingua attiva)');
    s.doc.tasto('F1');
    ok(!aperto(s), 'un secondo F1 lo richiude');
}

// --- 2. IL DIFETTO: niente Aiuto sotto un'altra modale ---------------------
console.log('[2] con un\'altra modale aperta, F1 non apre nulla');
{
    const s = scena({ modaleAperta: true });
    const e = s.doc.tasto('F1');
    ok(!aperto(s), 'l\'overlay resta nascosto');
    // Non basta che sia invisibile: non deve nemmeno essere COSTRUITO, o il
    // lavoro di renderHelp verrebbe buttato dietro al dialogo.
    ok(s.stato.render === 0, 'renderHelp non viene nemmeno chiamata');
    ok(e.impedito === 1, 'F1 resta intercettato (l\'aiuto del browser non si apre)');
}

// --- 3. il rovescio: la guardia non deve intrappolare l'Aiuto aperto -------
// Se la guardia stesse PRIMA del controllo isOpen(), una modale che si apre
// sopra all'Aiuto lo renderebbe impossibile da chiudere con F1.
console.log('[3] Aiuto gia\' aperto + altra modale: F1 deve poter chiudere');
{
    const s = scena();
    s.doc.tasto('F1');
    ok(aperto(s), 'aperto per il caso');
    s.stato.modaleAperta = true;
    s.doc.tasto('F1');
    ok(!aperto(s), 'F1 lo chiude comunque');
}

// --- 4. la modale si apre e si chiude anche per le altre vie ---------------
console.log('[4] Escape, bottoni e click sul fondo');
{
    const s = scena();
    s.doc.tasto('Escape');
    ok(!aperto(s) && s.stato.render === 0, 'Escape a modale chiusa non fa nulla');
    s.els.openHelpBtn.emetti('click');
    ok(aperto(s), 'il bottone apre');
    ok(s.els.helpSearch.fuochi === 1, 'il campo di ricerca prende il fuoco');
    s.doc.tasto('Escape');
    ok(!aperto(s), 'Escape chiude');

    s.els.openHelpBtn.emetti('click');
    s.els.helpCloseBtn.emetti('click');
    ok(!aperto(s), 'il bottone di chiusura chiude');

    s.els.openHelpBtn.emetti('click');
    s.ov.emetti('click', { target: s.els.helpSearch });
    ok(aperto(s), 'un click DENTRO il pannello non chiude');
    s.ov.emetti('click', { target: s.ov });
    ok(!aperto(s), 'un click sul fondo chiude');
}

// --- 5. la ricerca ---------------------------------------------------------
console.log('[5] la ricerca ricostruisce con la query corrente');
{
    const s = scena();
    s.els.helpSearch.value = 'osso';
    s.els.helpSearch.emetti('input');
    ok(s.stato.ultimaQuery === 'osso', 'input passa il testo a renderHelp');
    s.doc.tasto('F1');
    ok(s.stato.ultimaQuery === 'osso', 'l\'apertura riusa la query gia\' scritta');
}

// --- 6. le due dipendenze mancanti non devono far esplodere nulla ----------
// 31-help.js sta nello stesso scope di 33-timeline.js, ma l'ordine del
// manifest non e' un contratto: la guardia e' scritta con typeof proprio per
// sopravvivere a un bundle in cui tlModalOpen non c'e'.
console.log('[6] senza tlModalOpen, e senza overlay, non solleva');
{
    const s = scena({ senzaTlModalOpen: true });
    s.doc.tasto('F1');
    ok(aperto(s), 'senza tlModalOpen l\'Aiuto si apre comunque');

    const vuota = scena({ senzaOverlay: true });
    ok(vuota.doc.listenerTastiera() === 0, 'senza helpOverlay non registra nemmeno il tasto');
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
