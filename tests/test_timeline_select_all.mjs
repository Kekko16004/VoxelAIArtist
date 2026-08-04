/*
 * CTRL+A NELLA TIMELINE = seleziona tutti i keyframe.
 *
 * Tre cose si rompono facilmente, e il test le tiene ferme tutte e tre:
 *  1. Ctrl+A era scartato a monte (`if (ev.ctrlKey ...) return`, 33-timeline.js),
 *     quindi non arrivava mai: il ramo nuovo deve stare PRIMA di quel filtro.
 *  2. Ctrl+A e' rivendicato da altri due punti (gizmo globale in 01-scene-setup.js,
 *     rig in 15-rig.js). Dentro l'area timeline prende TUTTE le chiavi della clip;
 *     fuori (la viewport, col personaggio in posa) prende tutte quelle del SOLO
 *     frame corrente. In entrambi i casi l'evento si consuma solo se qualcosa e'
 *     stato davvero selezionato: se non c'e' nulla, torna al gizmo globale.
 *  3. Ctrl+Shift+A e' del rig: la timeline non deve rubarlo.
 *
 * Le funzioni pure sulla selezione si estraggono dai sorgenti; il resto e' un
 * modello del comportamento delle scorciatoie, verificato contro le stesse
 * condizioni scritte nel sorgente.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const tlSrc = fs.readFileSync(path.join(ROOT, 'ui/src/lib/33-timeline.js'), 'utf8');
const rigSrc = fs.readFileSync(path.join(ROOT, 'ui/src/lib/15-rig.js'), 'utf8');
const sceneSrc = fs.readFileSync(path.join(ROOT, 'ui/src/lib/01-scene-setup.js'), 'utf8');

// --- 1. le funzioni di selezione, estratte dal sorgente vero ---------------
const F1 = tlSrc.indexOf('function tlKeyTimesByBone(');
const F2 = tlSrc.indexOf('function tlSelectAllKeys(');
if (F1 < 0 || F2 < 0) {
    console.log('FAIL: tlKeyTimesByBone o tlSelectAllKeys non trovate in 33-timeline.js');
    process.exit(1);
}
const endOf = (src, from) => {
    // Fine della funzione: prima riga che chiude a rientro 12 (stile del progetto).
    const close = src.indexOf('\n            }', from);
    return close < 0 ? src.length : close + '\n            }'.length;
};
const harness = `
    let tlSelected = [];
    let redraws = 0, toolbarUpdates = 0;
    function tlRedraw() { redraws++; }
    function tlUpdateToolbar() { toolbarUpdates++; }
    function tlChanMenuOpen() { return chanOpen; }
    function tlCloseChanMenu() { chanOpen = false; closedChanMenu++; }
    let chanOpen = false, closedChanMenu = 0;
    let ACTIVE_ANIM = null;
    function tlActiveAnim() { return ACTIVE_ANIM; }
    function tlIsSelectedKey(bone, t) {
        return tlSelected.some(s => s.bone === bone && Math.abs(s.t - t) < 1e-6);
    }
`;
const api = new Function(harness
    + tlSrc.slice(F1, endOf(tlSrc, F1))
    + tlSrc.slice(F2, endOf(tlSrc, F2))
    + `
    return {
        selectAll: tlSelectAllKeys,
        setAnim: a => { ACTIVE_ANIM = a; },
        setChanOpen: v => { chanOpen = v; },
        sel: () => tlSelected,
        stats: () => ({ redraws, toolbarUpdates, closedChanMenu })
    };`)();

// Animazione con 3 ossa e conteggi DIVERSI: un bug che seleziona solo la prima
// traccia, o solo la prima chiave di ognuna, passerebbe con conteggi uguali.
const ANIM = { name: 'test', tracks: [
    { bone: 'hips',        keys: [{ t: 0 }, { t: 0.5 }, { t: 1 }] },
    { bone: 'upperArm_R',  keys: [{ t: 0 }, { t: 0.25 }] },
    { bone: 'upperArm_L',  keys: [{ t: 0.75 }] }
] };
const TOTAL = 6;

console.log('[1] seleziona TUTTE le chiavi di TUTTE le tracce');
api.setAnim(ANIM);
ok(api.selectAll() === true, 'la prima chiamata riporta true');
ok(api.sel().length === TOTAL, `${TOTAL} chiavi selezionate (trovate ${api.sel().length})`);
ok(api.sel().filter(s => s.bone === 'hips').length === 3, 'hips: 3');
ok(api.sel().filter(s => s.bone === 'upperArm_R').length === 2, 'upperArm_R: 2');
ok(api.sel().filter(s => s.bone === 'upperArm_L').length === 1, 'upperArm_L: 1');
ok(api.sel().every(s => typeof s.bone === 'string' && typeof s.t === 'number'),
   'la forma e\' {bone, t}: Canc e il trascinamento multiplo la usano cosi\'');
ok(api.stats().redraws > 0 && api.stats().toolbarUpdates > 0,
   'ridisegna e riabilita il pulsante Elimina');

console.log('[2] ripremuto svuota; da selezione parziale seleziona tutto');
ok(api.selectAll() === true && api.sel().length === 0, 'tutto selezionato -> svuota');
api.selectAll();
api.sel().pop();                      // selezione parziale: 5 su 6
ok(api.selectAll() === true && api.sel().length === TOTAL,
   'selezione parziale -> seleziona tutto, non svuota');

console.log('[3] preset (sola lettura): nessuna chiave da selezionare');
// tlActiveAnim() restituisce null per una preset, e tlKeyTimesByBone(null) da' {}:
// non esistono rombi selezionabili. Il no-op e' il comportamento ONESTO.
api.setAnim(null);
const before = api.sel().length;
ok(api.selectAll() === false, 'su una preset riporta false (nessuna operazione)');
ok(api.sel().length === before, 'e non tocca la selezione');

console.log('[4] chiude prima il menu dei canali, che ha la priorita\' sui tasti');
api.setAnim(ANIM);
api.setChanOpen(true);
const c0 = api.stats().closedChanMenu;
api.selectAll();
ok(api.stats().closedChanMenu === c0 + 1, 'il menu dei canali viene chiuso');

// --- 2. lo scoping, ESEGUENDO il vero handler -------------------------------
// Il primo giro di questo test controllava lo scoping leggendo il sorgente con
// delle regex. Passava anche mutando la condizione: 3 mutazioni su 9 non
// venivano viste, perche' un test che cerca la stringa "!ev.shiftKey" resta
// verde se quella stringa c'e' ma decide il contrario. Qui invece il blocco
// keydown viene ESTRATTO ed ESEGUITO, e le asserzioni guardano cosa fa
// l'evento: preventDefault chiamato o no, selezione cambiata o no.
function makeScope() {
    const kd = tlSrc.indexOf("window.addEventListener('keydown'");
    const end = tlSrc.indexOf('}, true);', kd);
    if (kd < 0 || end < 0) {
        console.log('FAIL: blocco keydown non trovato in 33-timeline.js');
        process.exit(1);
    }
    const handler = tlSrc.slice(tlSrc.indexOf('ev => {', kd), end + 1);

    // Anche i listener del puntatore, dallo stesso sorgente: sono cio' che
    // decide tlAreaHover, e la finestra di I1 (uscita a meta' gesto) vive
    // proprio nella loro interazione con tlEndPointer.
    const iEnter = tlSrc.indexOf("tlDock.addEventListener('pointerenter'");
    const iFocus = tlSrc.indexOf("tlDock.addEventListener('focusin'");
    const listeners = tlSrc.slice(iEnter, iFocus);
    const iEP = tlSrc.indexOf('function tlEndPointer(');
    // tlAreaActive dal sorgente VERO, non una copia: una copia qui sarebbe un
    // secondo modello della stessa decisione, e un test che stuba la funzione
    // sotto esame resta verde anche se quella diventa `return true`.
    const iAA = tlSrc.indexOf('function tlAreaActive(');
    // isTypingTarget dal sorgente VERO, con tutta la sua catena (isTextEntry,
    // keyConsumedByControl, le due tabelle di tasti). Era stubbata con un
    // booleano `S.typing` che nessun caso accendeva mai: togliere
    // `isTypingTarget(ev)` dalla guardia del keydown lasciava il test VERDE,
    // cioe' la protezione piu' importante del ramo (Ctrl+A non deve essere
    // inghiottito mentre si scrive nel prompt AI o si rinomina un'animazione)
    // non era asserita affatto. Estrarla invece di ricopiarla e' la stessa
    // regola gia' applicata a tlAreaActive: una copia qui sarebbe un secondo
    // modello della stessa decisione, libero di divergere in silenzio.
    const iTT = sceneSrc.indexOf('const TEXT_INPUT_TYPES = [');
    const iTTend = sceneSrc.indexOf('function isTypingTarget(');
    if (iEnter < 0 || iFocus < 0 || iEP < 0 || iAA < 0 || iTT < 0 || iTTend < 0) {
        console.log('FAIL: listener del puntatore, tlEndPointer, tlAreaActive o isTypingTarget non trovati');
        process.exit(1);
    }
    const typingSrc = sceneSrc.slice(iTT, endOf(sceneSrc, iTTend));
    if (!/function isTextEntry\(/.test(typingSrc) || !/function keyConsumedByControl\(/.test(typingSrc)) {
        console.log('FAIL: il blocco estratto non contiene isTextEntry/keyConsumedByControl');
        process.exit(1);
    }

    const stato = {
        tlVisible: true, chanOpen: false, modal: false,
        anim: null, drag: false, scrub: false
    };
    const log = { prevented: 0, stopped: 0, selectAll: 0, selectAllRet: true,
                  selectCol: 0, selectColRet: true, commits: 0 };

    const src = `
    let tlAreaHover = false, tlAreaFocus = false, tlHoverLeavePending = false;
    let tlKeyDrag = null, tlScrubbing = false;
    let tlSelected = [];
    let tlVisible = true;
    const tlDock = { addEventListener(ev, fn) { this['on' + ev] = fn; } };
    const tlPlayBtn = {}, tlInsertBtn = {};
    let tlFrame = 0;
    function tlChanMenuOpen() { return S.chanOpen; }
    function tlChanMenuKey() { return true; }
    function tlModalOpen() { return S.modal; }
    ${typingSrc}
    function tlActiveAnim() { return S.anim; }
    ${tlSrc.slice(iAA, endOf(tlSrc, iAA))}
    function tlSelectAllKeys() { L.selectAll++; return L.selectAllRet; }
    function tlSelectKeysAtCurrentFrame() { L.selectCol++; return L.selectColRet; }
    function tlCommit() { L.commits++; }
    function tlIsTogglePlayKey() { return false; }
    function tlIsActivatable() { return false; }
    function tlTogglePlayInternal() { }
    function tlDeleteSelectedKeys() { }
    function tlOpenChanMenu() { }
    function tlStopPlayback() { }
    function tlSetFrame() { }
    function tlUpdateToolbar() { }
    function tlRedraw() { }
    ${tlSrc.slice(iEP, endOf(tlSrc, iEP))}
    ${listeners}
    const onKey = ${handler};
    return {
        key(k, mod) {
            tlVisible = S.tlVisible;
            tlKeyDrag = S.drag ? { moved: false } : null;
            tlScrubbing = S.scrub;
            const ev = Object.assign({ key: k, target: null,
                preventDefault() { L.prevented++; },
                stopImmediatePropagation() { L.stopped++; } }, mod || {});
            onKey(ev);
        },
        enter() { tlDock.onpointerenter(); },
        leave() {
            tlKeyDrag = S.drag ? { moved: false } : null;
            tlScrubbing = S.scrub;
            tlDock.onpointerleave();
        },
        endGesture() { tlEndPointer(); },
        hover: () => tlAreaHover,
        pending: () => tlHoverLeavePending,
        setFocus: v => { tlAreaFocus = v; }
    };`;
    return { api: new Function('S', 'L', src)(stato, log), S: stato, L: log };
}

console.log('[5] Ctrl+A: dentro l\'area tutta la clip, fuori la colonna del frame');
{
    const { api, S, L } = makeScope();
    const CTRL_A = ['a', { ctrlKey: true }];

    // FUORI dall'area = la viewport, col personaggio in posa a schermo. Non e'
    // piu' un no-op: prende le chiavi del solo frame corrente. La timeline a
    // schermo (tlVisible, gia' preteso in cima all'handler) e' il segnale "sono
    // nel rigging", che e' esattamente la condizione chiesta.
    const p0 = L.prevented, s0 = L.stopped, a0 = L.selectAll, c0 = L.selectCol;
    api.key(...CTRL_A);
    ok(L.selectCol === c0 + 1, 'fuori dall\'area seleziona la colonna del frame corrente');
    ok(L.selectAll === a0, 'e NON tutta la clip: sono due meta\' distinte');
    ok(L.prevented === p0 + 1 && L.stopped === s0 + 1,
       'e consuma l\'evento, altrimenti il gizmo si sgancerebbe di nascosto');

    // Dentro l'area: tutta la clip, come prima.
    api.enter();
    api.key(...CTRL_A);
    ok(L.selectAll === a0 + 1, 'dentro l\'area seleziona tutta la clip');
    ok(L.selectCol === c0 + 1, 'e li\' la colonna non c\'entra');
    ok(L.prevented === p0 + 2 && L.stopped === s0 + 2, 'e consuma l\'evento');

    // Il filtro che scartava Ctrl a monte: se il ramo tornasse dopo di quello,
    // questa asserzione cadrebbe. E' la stessa cosa che il vecchio confronto
    // di indici voleva dire, ma misurata sull'effetto.
    ok(L.selectAll === a0 + 1, 'il ramo e\' raggiungibile: ctrlKey non lo scarta a monte');

    // Ctrl+Shift+A e' del rig, Ctrl+Alt+A di nessuno. Ne' la meta' "clip" ne'
    // la meta' "colonna" devono scattare.
    const a1 = L.selectAll, c1 = L.selectCol, p1 = L.prevented;
    api.key('a', { ctrlKey: true, shiftKey: true });
    api.key('a', { ctrlKey: true, altKey: true });
    ok(L.selectAll === a1 && L.selectCol === c1, 'Ctrl+Shift+A e Ctrl+Alt+A non li tocca');
    ok(L.prevented === p1, 'e non li consuma: restano del rig');

    // Maiuscola (BlocMaiusc attivo) e Cmd su Mac.
    api.key('A', { ctrlKey: true });
    ok(L.selectAll === a1 + 1, 'anche con la A maiuscola');
    api.key('a', { metaKey: true });
    ok(L.selectAll === a1 + 2, 'e con Cmd su Mac');

    // Una modale aperta, o la timeline nascosta, hanno la priorita' su ENTRAMBE
    // le meta': la guardia sta prima della biforcazione.
    const a2 = L.selectAll, c2 = L.selectCol;
    S.modal = true;  api.key(...CTRL_A);
    S.modal = false; S.tlVisible = false; api.key(...CTRL_A);
    S.tlVisible = true;
    ok(L.selectAll === a2 && L.selectCol === c2,
       'con una modale aperta o la timeline nascosta non fa nulla');

    // Se non c'era niente da selezionare (preset in sola lettura), l'evento
    // NON va consumato: sarebbe una scorciatoia che inghiotte il tasto e non fa
    // niente, e il gizmo non scatterebbe piu'. Vale per tutte e due le meta'.
    L.selectAllRet = false;
    const p3 = L.prevented;
    api.key(...CTRL_A);                       // dentro l'area (api.enter() sopra)
    ok(L.prevented === p3, 'clip vuota: lascia passare l\'evento');
    L.selectAllRet = true;

    {
        // Stessa cosa per la colonna: un frame senza chiavi sotto il playhead
        // e' il caso normale (le chiavi stanno solo su alcuni frame), e li'
        // Ctrl+A deve restare del gizmo globale invece di non fare nulla.
        const { api: v, L: Lv } = makeScope();     // area NON attiva: viewport
        Lv.selectColRet = false;
        v.key('a', { ctrlKey: true });
        ok(Lv.selectCol === 1, 'nella vista prova comunque a prendere la colonna');
        ok(Lv.prevented === 0 && Lv.stopped === 0,
           'ma su un frame senza chiavi lascia passare l\'evento al gizmo');
    }

    // Focus dentro il dock invece del puntatore sopra: stessa cosa.
    const { api: api2, L: L2 } = makeScope();
    api2.setFocus(true);
    api2.key('a', { ctrlKey: true });
    ok(L2.selectAll === 1 && L2.selectCol === 0,
       'basta il focus dentro il dock, senza puntatore sopra');
}

console.log('[6] chi sta SCRIVENDO tiene Ctrl+A: la timeline non lo inghiotte');
{
    // La guardia `isTypingTarget(ev)` sta prima del ramo Ctrl+A. Se cadesse, con
    // il puntatore sopra il dock (che e' in basso, quindi ci si passa sopra
    // continuamente) Ctrl+A dentro un campo di testo selezionerebbe i keyframe
    // invece del testo, e l'evento verrebbe consumato: l'utente perde il
    // "seleziona tutto" nel prompt AI e non capisce perche'.
    const { api, L } = makeScope();
    api.enter();                       // area attiva: il ramo e' raggiungibile
    api.key('a', { ctrlKey: true });
    ok(L.selectAll === 1, 'controllo: senza campo a fuoco il ramo scatta');

    const campi = [
        ['<input type=text> (nome animazione)', { tagName: 'INPUT', type: 'text' }],
        ['<input type=number> (dimensione griglia)', { tagName: 'INPUT', type: 'number' }],
        ['<textarea> (prompt AI)', { tagName: 'TEXTAREA' }],
        ['contenteditable', { isContentEditable: true, tagName: 'DIV' }],
        ['<input type=search>', { tagName: 'INPUT', type: 'search' }],
        ['<input> senza type (default text)', { tagName: 'INPUT' }]
    ];
    for (const [nome, target] of campi) {
        const a0 = L.selectAll, p0 = L.prevented, s0 = L.stopped, c0 = L.selectCol;
        api.key('a', { ctrlKey: true, target });
        ok(L.selectAll === a0 && L.selectCol === c0,
           'con il fuoco in ' + nome + ' non seleziona i keyframe');
        ok(L.prevented === p0 && L.stopped === s0,
           'e non consuma l\'evento: il campo riceve il suo "seleziona tutto"');
    }

    // Stesso caso ma col puntatore FUORI dal dock, dove ora c'e' la meta'
    // "colonna": la guardia sta prima della biforcazione, quindi deve fermare
    // anche quella. Senza questo caso si potrebbe scrivere nel prompt AI e
    // vedersi selezionare le chiavi del frame corrente.
    {
        const { api: v, L: Lv } = makeScope();     // niente enter(): viewport
        v.key('a', { ctrlKey: true, target: { tagName: 'TEXTAREA' } });
        ok(Lv.selectCol === 0 && Lv.selectAll === 0,
           'con il fuoco nel prompt AI non prende nemmeno la colonna');
        ok(Lv.prevented === 0, 'e lascia passare l\'evento');
    }

    // Lo slider e' escluso da TUTTA la guardia del keydown, Ctrl+A compreso
    // (`isTypingTarget(ev) || isRange`, 33-timeline.js): la riga esiste perche'
    // le frecce su uno slider di posa devono muovere lo slider e non il frame.
    // Con uno slider a fuoco Ctrl+A percio' non e' della timeline: resta del
    // gizmo globale. E' il comportamento scritto nel sorgente, non un effetto
    // collaterale, e questo caso lo tiene fermo — se qualcuno restringesse
    // l'esclusione ai soli tasti di navigazione, il test lo direbbe.
    {
        const a0 = L.selectAll, p0 = L.prevented;
        api.key('a', { ctrlKey: true, target: { tagName: 'INPUT', type: 'range' } });
        ok(L.selectAll === a0, 'con uno slider a fuoco la timeline non prende Ctrl+A');
        ok(L.prevented === p0, 'e lo lascia passare intatto');
    }

    // Il rovescio: un controllo NON testuale a fuoco non deve disattivare la
    // scorciatoia. keyConsumedByControl esce subito se c'e' ctrlKey, quindi il
    // type-ahead di un <select> non si mangia Ctrl+A. Senza questi casi la
    // guardia potrebbe diventare "qualunque elemento a fuoco blocca" e restare
    // verde.
    const controlli = [
        ['<select> (griglia, canale)', { tagName: 'SELECT' }],
        ['<button>', { tagName: 'BUTTON' }],
        ['<input type=checkbox>', { tagName: 'INPUT', type: 'checkbox' }],
        ['il canvas', { tagName: 'CANVAS' }]
    ];
    for (const [nome, target] of controlli) {
        const a0 = L.selectAll, p0 = L.prevented;
        api.key('a', { ctrlKey: true, target });
        ok(L.selectAll === a0 + 1, 'con il fuoco su ' + nome + ' Ctrl+A resta della timeline');
        ok(L.prevented === p0 + 1, 'e viene consumato');
    }
}

console.log('[7] l\'uscita a meta\' gesto non lascia il flag acceso per sempre');
{
    // I1: 'pointerleave' rinviava l'uscita durante un trascinamento (giusto:
    // altrimenti la scorciatoia moriva a meta' gesto) ma poi la DIMENTICAVA. Se
    // il gesto finiva col mouse fuori dal dock, 'pointerleave' non si ripeteva
    // piu' e tlAreaHover restava true: la timeline rubava Ctrl+A al gizmo da
    // qualunque punto dello schermo, fino al successivo giro dentro e fuori.
    const { api, S, L } = makeScope();
    api.enter();
    ok(api.hover() === true, 'puntatore dentro: area attiva');

    S.drag = true;
    api.leave();
    ok(api.hover() === true, 'durante il trascinamento l\'uscita e\' rinviata, non applicata');
    ok(api.pending() === true, 'ma resta annotata');
    api.key('a', { ctrlKey: true });
    ok(L.selectAll === 1, 'e la scorciatoia funziona ancora a meta\' gesto');

    S.drag = false;
    api.endGesture();
    ok(api.hover() === false, 'a gesto finito FUORI dal dock l\'area si spegne');
    ok(api.pending() === false, 'e il promemoria si consuma');
    const a1 = L.selectAll, cc1 = L.selectCol;
    api.key('a', { ctrlKey: true });
    ok(L.selectAll === a1 && L.selectCol === cc1 + 1,
       'e Ctrl+A passa alla meta\' "colonna": non e\' piu\' tutta la clip');

    // Il caso opposto: gesto finito DENTRO il dock, l'area deve restare attiva.
    const { api: b, S: Sb, L: Lb } = makeScope();
    b.enter();
    Sb.scrub = true;
    b.leave();
    b.enter();                 // rientrato prima di rilasciare
    Sb.scrub = false;
    b.endGesture();
    ok(b.hover() === true, 'rientrando prima del rilascio l\'area resta attiva');
    b.key('a', { ctrlKey: true });
    ok(Lb.selectAll === 1, 'e Ctrl+A resta della timeline');

    // Uscita SENZA gesto in corso: applicata subito, come prima.
    const { api: c } = makeScope();
    c.enter(); c.leave();
    ok(c.hover() === false, 'senza gesto in corso l\'uscita e\' immediata');
}

console.log('[8] il rig e\' passato a Ctrl+Shift+A, senza italiano hardcoded');
{
    const i = rigSrc.indexOf('tlSetKeyAllBones(true)');
    ok(i > 0, 'il ramo del rig esiste ancora');
    const ctx = rigSrc.slice(Math.max(0, i - 700), i);
    ok(/ev\.shiftKey/.test(ctx), 'il ramo del rig richiede shiftKey');
    ok(!/Tutte le ossa selezionate per Keyframe/.test(rigSrc),
       'il toast italiano hardcoded e\' sparito');
    ok(/t\(\s*'rig\.allBonesKeyed'\s*\)/.test(rigSrc), 'il toast passa da t()');
}

console.log('[9] il gizmo globale non risponde piu\' a Ctrl+Shift+A');
{
    const i = sceneSrc.indexOf("e.key.toLowerCase() === 'a'");
    ok(i > 0, 'il ramo del gizmo globale esiste');
    const line = sceneSrc.slice(i - 200, i + 60);
    ok(/!e\.shiftKey/.test(line), 'esclude shiftKey (altrimenti sgancia il gizmo di nascosto)');
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
