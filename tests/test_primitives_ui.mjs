/*
 * PRIMITIVE — la META' CON IL DOM: menu Shift+A, dialogo, creazione.
 *
 * tests/test_primitives.mjs si ferma al marcatore e prova solo le funzioni pure.
 * Tutto quello che sta sotto — la scorciatoia, i due passi del dialogo, il
 * rifiuto per budget, il centraggio dell'oggetto — non aveva asserzioni: il
 * bootstrap con DOM finto (tests/test_bootstrap.mjs) fa girare initPrimitives
 * contro un proxy in cui ogni id esiste e ogni chiamata riesce, quindi prova
 * che il codice non solleva, NON che decida bene.
 *
 * Qui il blocco UI viene ESTRATTO ed ESEGUITO contro un DOM finto che distingue
 * gli elementi (un id sbagliato da' undefined, non un proxy complice), e le
 * asserzioni guardano gli effetti: quale passo e' visibile, se il bottone Crea
 * e' disabilitato, quali voxel finiscono nell'oggetto creato.
 *
 * Le trappole che questo file tiene ferme:
 *  - Shift+A non deve scattare mentre si digita, ne' rubare Ctrl+Shift+A al rig;
 *  - contare prima di costruire: se primCreate costruisse le celle prima del
 *    controllo sul budget, un cubo 512 allocherebbe 134 milioni di celle
 *    ESATTAMENTE davanti al controllo che deve impedirlo;
 *  - la sfera non ha altezza indipendente (sarebbe un ellissoide);
 *  - l'oggetto nasce centrato su XZ e appoggiato a y=0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/35-primitives.js'), 'utf8');
const budgetSrc = fs.readFileSync(path.join(ROOT, 'ui/src/utils/expand-ops.js'), 'utf8');
const tplSrc = fs.readFileSync(path.join(ROOT, 'ui/src/index.template.html'), 'utf8');

const UI_MARK = '// ===== UI: menu Shift+A e dialogo =====';
const iUI = src.indexOf(UI_MARK);
if (iUI < 0) {
    console.log('FAIL: marcatore UI non trovato in 35-primitives.js');
    process.exit(1);
}
// Il budget serve al dialogo: si ritaglia come in test_primitives.mjs.
const bFrom = budgetSrc.indexOf('const MAX_VOXELS = 4000000;');
const bAt = budgetSrc.indexOf('function voxelBudgetFor');
const CLOSE = '\n            }';
const bTo = bAt < 0 ? -1 : budgetSrc.indexOf(CLOSE, bAt) + CLOSE.length;
if (bFrom < 0 || bAt < 0) {
    console.log('FAIL: voxelBudgetFor non trovata in expand-ops.js');
    process.exit(1);
}

// --- 1. gli id del dialogo esistono DAVVERO nel template -------------------
// Il bootstrap con DOM finto non puo' dirlo (ogni getElementById gli riesce), e
// un id sbagliato qui e' un TypeError al primo Shift+A, in produzione.
console.log('[1] ogni id toccato dal modulo esiste nel template');
{
    const usati = [...new Set([...src.slice(iUI).matchAll(/primEl\('([^']+)'\)/g)].map(m => m[1]))];
    ok(usati.length >= 8, `il modulo tocca ${usati.length} id (attesi almeno 8)`);
    const mancanti = usati.filter(id => !tplSrc.includes('id="' + id + '"'));
    ok(mancanti.length === 0,
       'tutti presenti nel template' + (mancanti.length ? ' -- MANCANTI: ' + mancanti.join(', ') : ''));
    // primOverlay deve stare anche nell'elenco delle modali della timeline,
    // altrimenti lo Spazio fa partire il playback mentre si digita una misura.
    const tl = fs.readFileSync(path.join(ROOT, 'ui/src/lib/33-timeline.js'), 'utf8');
    const iM = tl.indexOf('function tlModalOpen(');
    ok(iM > 0 && tl.slice(iM, iM + 400).includes("'primOverlay'"),
       'primOverlay e\' fra le modali di tlModalOpen (lo Spazio non parte)');
    // Le scorciatoie QOL del rig (I, Ctrl+C, Ctrl+V) uscivano solo su
    // isTypingTarget, che non basta: dopo un clic sull'imbottitura del dialogo il
    // fuoco torna al <body> e `I` inseriva un keyframe DIETRO al dialogo aperto.
    // Controllo strutturale perche' quel blocco non ha un harness proprio.
    const rig = fs.readFileSync(path.join(ROOT, 'ui/src/lib/15-rig.js'), 'utf8');
    const iQ = rig.indexOf('// --- QOL Shortcuts ---');
    // Cercare il solo nome `tlModalOpen()` NON basta: il commento accanto alla
    // guardia lo nomina, quindi togliere la riga e lasciare il commento passava
    // inosservato (mutazione F6 di .superpowers/mut-fixround.mjs). Serve la forma
    // dell'ISTRUZIONE: un `if (...tlModalOpen()...) return;`. Righe intere, non
    // frammenti, cosi' un commento non puo' fare da comparsa.
    const guardia = (rig.slice(iQ, iQ + 1400).split('\n')
        .filter(l => !l.trim().startsWith('//'))
        .some(l => /if\s*\(.*tlModalOpen\s*\(\s*\).*\)\s*return\s*;/.test(l)));
    ok(iQ > 0 && guardia,
       'anche le scorciatoie del rig escono su tlModalOpen prima di agire');
}

// --- 2. il DOM finto -------------------------------------------------------
// Volutamente SEVERO: chiede solo gli id che esistono, e un id sconosciuto
// torna undefined cosi' che un errore di battitura diventi un TypeError qui e
// non davanti all'utente.
function makeEl(id, extra) {
    return Object.assign({
        id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
        checked: false, disabled: false, className: '',
        children: [], _lis: {},
        focus() { this._focused = true; },
        select() { this._selected = true; },
        appendChild(c) { this.children.push(c); },
        addEventListener(ev, fn) { (this._lis[ev] ||= []).push(fn); },
        fire(ev, obj) { (this._lis[ev] || []).forEach(fn => fn(obj || {})); }
    }, extra || {});
}

function makeHarness(opts) {
    opts = opts || {};
    const els = {};
    for (const id of ['primOverlay', 'primStepShape', 'primStepSize', 'primShapeList',
                      'primChosenName', 'primSize', 'primHeight', 'primKeepRatio',
                      'primInfo', 'primCancel', 'primCreate']) {
        els[id] = makeEl(id);
    }
    els.primOverlay.style.display = 'none';
    els.primStepSize.style.display = 'none';
    els.primKeepRatio.checked = true;

    const log = { history: 0, created: [], selected: [], timeouts: 0 };
    const doc = {
        _lis: {},
        addEventListener(ev, fn) { (this._lis[ev] ||= []).push(fn); },
        getElementById: id => els[id],
        createElement: () => makeEl('nuovo')
    };
    const win = { _lis: {}, addEventListener(ev, fn) { (this._lis[ev] ||= []).push(fn); } };

    const harness = `
    const document = D, window = W;
    // setTimeout immediato: il focus e la selezione del campo sono osservabili
    // subito invece di sparire in un tick che il test non vede.
    function setTimeout(fn) { L.timeouts++; fn(); return 0; }
    // t() vero-abbastanza: interpola i {segnaposto} come 23-i18n.js, cosi' un
    // .replace() a mano al posto di t(key, vars) non passerebbe inosservato.
    function t(k, vars) {
        const s = DICT[k] !== undefined ? DICT[k] : k;
        return vars ? s.replace(/\\{(\\w+)\\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : s;
    }
    let currentModelData = { metadata: { grid_size: GRID }, voxels: [] };
    let activeColorHex = COLOR;
    function pushHistory() { L.history++; }
    function isTypingTarget(e) { return !!(e && e.__typing); }
    // L'elenco delle modali della timeline. Qui e' pilotato dal test, ma il
    // modulo deve chiamarlo: senza, Shift+A apriva il dialogo SOPRA Impostazioni
    // o Aiuto (z-index 95 contro 90/70) e un Esc chiudeva due cose insieme.
    function tlModalOpen() { return !!L.altraModale; }
    let __nextId = 7;
    function createObject(data) {
        const o = { id: __nextId++, data: data };
        L.created.push(o);
        return o;
    }
    function selectActiveObjectAndRefresh(id) { L.selected.push(id); }
    ${budgetSrc.slice(bFrom, bTo)}
    ${src.slice(0, iUI)}
    ${src.slice(iUI)}
    return {
        init: initPrimitives,
        open: primOpen,
        dims: primReadDims,
        create: primCreate,
        shapes: PRIMITIVE_SHAPES,
        count: primitiveVoxelCount,
        grid: primitiveGridFor,
        budget: voxelBudgetFor
    };`;
    const api = new Function('D', 'W', 'L', 'DICT', 'GRID', 'COLOR', harness)(
        doc, win, log,
        {
            'prim.cube': 'Cubo', 'prim.pyramid': 'Piramide', 'prim.cylinder': 'Cilindro',
            'prim.sphere': 'Sfera', 'prim.cone': 'Cono',
            'prim.info': '{n} voxel, griglia {g}',
            'prim.tooBig': 'Troppi voxel ({n}): riduci la dimensione'
        },
        opts.grid || [32, 32, 32],
        opts.color || '#123456');
    api.init();
    return { api, els, log, win, doc };
}

// --- 3. la scorciatoia -----------------------------------------------------
console.log('[2] Shift+A apre, e non ruba i tasti di nessun altro');
{
    const { api, els, win, log } = makeHarness();
    ok(win._lis.keydown && win._lis.keydown.length === 1, 'un solo listener keydown registrato');
    const key = (k, mod) => {
        const ev = Object.assign({ key: k, __prevented: 0, preventDefault() { this.__prevented++; } }, mod || {});
        win._lis.keydown[0](ev);
        return ev;
    };

    const chiuso = () => els.primOverlay.style.display === 'none';
    ok(chiuso(), 'parte chiuso');

    // I casi che NON devono aprire. Ognuno e' rivendicato da qualcun altro:
    // Ctrl+Shift+A e' del rig (Task 5), 'a' liscia e' una scorciatoia del
    // visore, e mentre si digita nessuna scorciatoia deve scattare.
    const noApre = [
        ['a senza Shift', 'a', {}],
        ['Ctrl+Shift+A (e\' del rig)', 'a', { shiftKey: true, ctrlKey: true }],
        ['Cmd+Shift+A', 'a', { shiftKey: true, metaKey: true }],
        ['Alt+Shift+A', 'a', { shiftKey: true, altKey: true }],
        ['Shift+B', 'b', { shiftKey: true }],
        ['Shift+A mentre si DIGITA', 'a', { shiftKey: true, __typing: true }]
    ];
    for (const [nome, k, mod] of noApre) {
        const ev = key(k, mod);
        ok(chiuso(), nome + ': non apre');
        ok(ev.__prevented === 0, nome + ': e non consuma l\'evento');
    }

    // Nemmeno con un'altra modale aperta: il dialogo delle primitive ha z-index
    // 95 contro i 90/70/60 delle altre, quindi si aprirebbe SOPRA e sarebbe
    // cliccabile, e poi un solo Esc chiuderebbe due cose.
    log.altraModale = true;
    let evM = key('A', { shiftKey: true });
    ok(chiuso(), 'con Impostazioni/Aiuto aperti: non apre');
    ok(evM.__prevented === 0, 'e non consuma l\'evento (resta di chi ha la modale)');
    log.altraModale = false;

    // E i casi che devono aprire: 'A' maiuscola arriva quando Shift e' premuto.
    const ev = key('A', { shiftKey: true });
    ok(els.primOverlay.style.display === 'flex', 'Shift+A apre il dialogo');
    ok(ev.__prevented === 1, 'e consuma l\'evento');
    ok(els.primStepShape.style.display === '' && els.primStepSize.style.display === 'none',
       'si apre sul PRIMO passo: la scelta della forma');

    // Gia' aperto: il tasto non deve ricostruire la lista sotto le dita.
    els.primShapeList.children.length = 0;
    key('A', { shiftKey: true });
    ok(els.primShapeList.children.length === 0, 'se e\' gia\' aperto non si riapre');

    // Idempotenza: initPrimitives due volte non raddoppia i listener.
    api.init();
    ok(win._lis.keydown.length === 1, 'init ripetuto non aggiunge un secondo listener');
}

console.log('[3] cinque forme tradotte, e la scelta porta al passo delle misure');
{
    const { els } = makeHarness();
    els.primOverlay._lis.keydown = els.primOverlay._lis.keydown || [];
    const { api, els: e2 } = makeHarness();
    api.open();
    ok(e2.primShapeList.children.length === 5, 'cinque bottoni, uno per forma');
    const nomi = e2.primShapeList.children.map(b => b.textContent);
    ok(nomi.join(',') === 'Cubo,Piramide,Cilindro,Sfera,Cono',
       'passano da t(): ' + nomi.join(','));
    ok(nomi.every(n => n && !n.startsWith('prim.')),
       'nessuna chiave i18n grezza a schermo');

    // Il clic sul primo bottone porta al passo 2 con il nome scelto.
    e2.primShapeList.children[0].fire('click');
    ok(e2.primStepShape.style.display === 'none' && e2.primStepSize.style.display === '',
       'la scelta porta al passo delle misure');
    ok(e2.primChosenName.textContent === 'Cubo', 'il titolo mostra la forma scelta');
    ok(e2.primSize.value === '16', 'la dimensione parte dal default della forma');
    ok(e2.primSize._focused === true && e2.primSize._selected === true,
       'il campo parte a fuoco e selezionato (si digita e Invio)');
    ok(e2.primInfo.textContent.includes('voxel'), 'l\'informativa e\' gia\' compilata');
}

console.log('[4] la sfera non ha un\'altezza indipendente');
{
    const { api, els } = makeHarness();
    api.open();
    const iSfera = api.shapes.findIndex(s => s.id === 'sphere');
    els.primShapeList.children[iSfera].fire('click');
    ok(els.primHeight.disabled === true, 'il campo Altezza e\' disabilitato');
    ok(els.primKeepRatio.disabled === true && els.primKeepRatio.checked === true,
       'e la proporzione e\' bloccata (un ellissoide e\' fuori scopo)');
    els.primSize.value = '20';
    els.primSize.fire('input');
    ok(els.primHeight.value === '20', 'l\'altezza segue il diametro');
    ok(api.dims().height === 20, 'e primReadDims concorda');

    // Il cubo invece lascia scegliere, ma solo togliendo la spunta: finche' la
    // proporzione e' mantenuta l'altezza e' DERIVATA e il campo resta disabilitato.
    // Senza questo, digitare un'altezza la faceva tornare indietro a ogni battuta
    // (primRefreshInfo la riscrive) e il dialogo sembrava rifiutare quel che si
    // scriveva. I voxel non erano sbagliati, l'aspetto si'.
    const { api: a2, els: e2 } = makeHarness();
    a2.open();
    e2.primShapeList.children[0].fire('click');
    ok(e2.primHeight.disabled === true,
       'col cubo e la proporzione mantenuta l\'altezza e\' derivata: campo disabilitato');
    e2.primKeepRatio.checked = false;
    e2.primKeepRatio.fire('change');
    ok(e2.primHeight.disabled === false, 'togliendo la spunta il campo si riabilita');
    e2.primHeight.value = '3';
    e2.primHeight.fire('input');
    ok(a2.dims().height === 3, 'senza proporzione l\'altezza vale quella scritta');
    ok(e2.primHeight.value === '3', 'e il campo NON viene riscritto sotto le dita');
    ok(a2.dims().size === 16, 'e la dimensione resta la sua');

    // Rimettendo la spunta il campo torna derivato e disabilitato.
    e2.primKeepRatio.checked = true;
    e2.primKeepRatio.fire('change');
    ok(e2.primHeight.disabled === true, 'rimettendo la spunta torna disabilitato');
    ok(e2.primHeight.value === '16', 'e riprende a seguire la dimensione');
}

console.log('[5] le misure sono sempre pulite: mai NaN, mai fuori da 1..512');
{
    const { api, els } = makeHarness();
    api.open();
    els.primShapeList.children[0].fire('click');
    els.primKeepRatio.checked = false;
    const casi = [
        ['vuoto', '', 1],
        ['zero', '0', 1],
        ['negativo', '-40', 1],
        ['lettere', 'abc', 1],
        ['oltre il massimo', '9999', 512],
        ['con la virgola', '12.7', 13],
        ['al limite', '512', 512]
    ];
    for (const [nome, val, atteso] of casi) {
        els.primSize.value = val;
        ok(api.dims().size === atteso, `dimensione "${nome}" (${val}) -> ${atteso}`);
    }
    els.primSize.value = '16';
    for (const [nome, val, atteso] of casi) {
        els.primHeight.value = val;
        ok(api.dims().height === atteso, `altezza "${nome}" (${val}) -> ${atteso}`);
    }
}

console.log('[6] budget sfondato: rifiuta, non tronca e non alloca');
{
    const { api, els, log } = makeHarness();
    api.open();
    els.primShapeList.children[0].fire('click');   // cubo
    els.primKeepRatio.checked = true;

    // 512 -> 134 milioni di celle, molto oltre il tetto di 8M di CLAUDE.md.
    els.primSize.value = '512';
    els.primSize.fire('input');
    ok(els.primCreate.disabled === true, 'il bottone Crea si disabilita');
    ok(els.primInfo.textContent.startsWith('Troppi voxel'),
       'e l\'informativa lo dice: ' + els.primInfo.textContent);
    ok(/\d{6,}/.test(els.primInfo.textContent),
       'con il numero vero interpolato da t(), non un {n} letterale');
    ok(!els.primInfo.textContent.includes('{'), 'nessun segnaposto rimasto a schermo');

    // Invio o doppio clic arrivano comunque: primCreate deve rifiutare da sola.
    // Se costruisse le celle prima del controllo, questa riga allocherebbe 134
    // milioni di oggetti — il test morirebbe per OOM invece di fallire.
    const t0 = Date.now();
    api.create();
    ok(log.created.length === 0, 'primCreate rifiuta anche se chiamata a mano');
    ok(log.history === 0, 'e non sporca la cronologia con un annullamento a vuoto');
    ok(Date.now() - t0 < 2000,
       `rifiuta CONTANDO, non costruendo (${Date.now() - t0} ms: una costruzione da 134M celle non rientra)`);

    // Tornando a una misura sana il bottone si riabilita.
    els.primSize.value = '16';
    els.primSize.fire('input');
    ok(els.primCreate.disabled === false, 'con una misura sana Crea torna attivo');
    ok(els.primInfo.textContent.includes('griglia'), 'e l\'informativa torna normale');
}

console.log('[7] creazione: oggetto centrato su XZ, appoggiato a y=0, del colore attivo');
{
    const { api, els, log } = makeHarness({ grid: [32, 32, 32], color: '#ABCDEF' });
    api.open();
    els.primShapeList.children[0].fire('click');   // cubo 16
    els.primCreate.fire('click');

    // pushHistory viene chiamata, ma NON aspettarti che Ctrl+Z faccia sparire
    // l'oggetto: aggiunte ed eliminazioni non sono annullabili (limite dichiarato
    // in 13-history.js:6-10). Lo scatto serve a non perdere lo stato precedente e
    // a far tornare attivo l'oggetto di prima. Che l'annullamento non SVUOTI poi
    // la primitiva appena creata e' provato da tests/test_undo_object_switch.mjs.
    ok(log.history === 1, 'la creazione spinge uno scatto di cronologia');
    ok(log.created.length === 1, 'un oggetto creato');
    const d = log.created[0].data;
    ok(d.voxels.length === 16 * 16 * 16, `16^3 = 4096 voxel (trovati ${d.voxels.length})`);
    ok(d.metadata.name === 'Cubo', 'il nome e\' tradotto, non "prim.cube"');
    ok(JSON.stringify(d.metadata.grid_size) === '[32,32,32]',
       'eredita la griglia dell\'oggetto attivo invece di rimpicciolirla');

    const xs = d.voxels.map(v => v.x), ys = d.voxels.map(v => v.y), zs = d.voxels.map(v => v.z);
    ok(Math.min(...ys) === 0, 'appoggiato a y=0');
    ok(Math.min(...xs) === 8 && Math.max(...xs) === 23, 'centrato su X (8..23 in una griglia 32)');
    ok(Math.min(...zs) === 8 && Math.max(...zs) === 23, 'centrato su Z');
    ok(d.voxels.every(v => v.color === '#ABCDEF'), 'del colore attivo');
    ok(log.selected.length === 1 && log.selected[0] === log.created[0].id,
       'e diventa l\'oggetto attivo (setActiveObject invalida l\'incrementale)');
    ok(els.primOverlay.style.display === 'none', 'il dialogo si chiude');

    // Una griglia piu' piccola della forma deve CRESCERE, non tagliare.
    const { api: a2, els: e2, log: l2 } = makeHarness({ grid: [16, 16, 16] });
    a2.open();
    const iCono = a2.shapes.findIndex(s => s.id === 'cone');
    e2.primShapeList.children[iCono].fire('click');   // cono 12, altezza 18
    e2.primCreate.fire('click');
    const g2 = l2.created[0].data.metadata.grid_size;
    ok(g2[1] >= 18, `la griglia cresce per contenere l'altezza 18 (${g2[1]})`);
    ok(l2.created[0].data.voxels.every(v => v.y < g2[1] && v.x < g2[0] && v.z < g2[2]),
       'e nessun voxel esce dalla griglia dichiarata');
}

console.log('[8] chiusura: Esc, clic sullo sfondo, Annulla; Invio crea');
{
    const { api, els, log, doc } = makeHarness();
    // I tasti si sparano a livello di DOCUMENTO, non sull'overlay: e' dove
    // arrivano davvero. Un keydown dentro il pannello risale fin qui, ma dopo un
    // clic sull'imbottitura del pannello il fuoco torna al <body> e l'overlay non
    // riceve piu' niente — un handler agganciato all'elemento smetterebbe di
    // funzionare proprio li'. E' il modo in cui chiudono tutte le altre modali
    // del progetto (26-settings-modal.js:33, 31-help.js:279).
    const docKey = k => {
        const ev = {
            key: k, __p: 0, __s: 0,
            preventDefault() { this.__p++; },
            stopPropagation() { this.__s++; }
        };
        (doc._lis.keydown || []).forEach(fn => fn(ev));
        return ev;
    };
    ok((doc._lis.keydown || []).length === 1, 'un handler di tastiera sul documento');

    api.open();
    els.primShapeList.children[0].fire('click');

    // Esc chiude e AZZERA la forma scelta: riaprendo si riparte dalla lista.
    let ev = docKey('Escape');
    ok(els.primOverlay.style.display === 'none', 'Esc chiude');
    ok(ev.__p === 1, 'e consuma il tasto');
    // stopPropagation, non solo preventDefault: l'estrusione ascolta su WINDOW
    // (13-history.js) e questo handler sta sul DOCUMENT, che in bubble corre
    // prima. Senza fermare l'evento, con l'estrusione armata un solo Esc
    // annullava l'estrusione E chiudeva il dialogo.
    ok(ev.__s === 1, 'e ferma la risalita a window (l\'estrusione non lo vede)');
    api.create();
    ok(log.created.length === 0, 'dopo la chiusura non c\'e\' piu\' una forma da creare');

    // A dialogo CHIUSO i tasti non sono nostri: Esc annulla l'estrusione
    // (13-history.js:196) e Invio serve altrove. Consumarli qui li ruberebbe.
    ev = docKey('Escape');
    ok(ev.__p === 0, 'a dialogo chiuso Esc passa oltre (l\'estrusione lo usa)');
    ok(ev.__s === 0, 'e non viene nemmeno fermato');
    ev = docKey('Enter');
    ok(ev.__p === 0 && log.created.length === 0, 'e Invio non crea nulla');

    // Invio crea, ma solo se il bottone e' attivo.
    api.open();
    els.primShapeList.children[0].fire('click');
    ev = docKey('Enter');
    ok(log.created.length === 1, 'Invio crea la primitiva');
    ok(ev.__p === 1, 'consumando il tasto');
    ok(ev.__s === 1, 'e fermandolo prima di window');

    api.open();
    els.primShapeList.children[0].fire('click');
    els.primCreate.disabled = true;
    docKey('Enter');
    ok(log.created.length === 1, 'con Crea disabilitato Invio non crea nulla');

    // Clic sullo sfondo chiude; un clic DENTRO il pannello no.
    api.open();
    els.primOverlay.fire('click', { target: els.primOverlay });
    ok(els.primOverlay.style.display === 'none', 'il clic sullo sfondo chiude');
    api.open();
    els.primOverlay.fire('click', { target: els.primSize });
    ok(els.primOverlay.style.display === 'flex', 'un clic dentro il pannello no');

    // Annulla.
    els.primCancel.fire('click');
    ok(els.primOverlay.style.display === 'none', 'Annulla chiude');
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
