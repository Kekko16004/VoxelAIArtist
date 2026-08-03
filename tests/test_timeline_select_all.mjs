/*
 * CTRL+A NELLA TIMELINE = seleziona tutti i keyframe.
 *
 * Tre cose si rompono facilmente, e il test le tiene ferme tutte e tre:
 *  1. Ctrl+A era scartato a monte (`if (ev.ctrlKey ...) return`, 33-timeline.js),
 *     quindi non arrivava mai: il ramo nuovo deve stare PRIMA di quel filtro.
 *  2. Ctrl+A e' rivendicato da altri due punti (gizmo globale in 01-scene-setup.js,
 *     rig in 15-rig.js). Fuori dall'area timeline l'evento NON va consumato,
 *     altrimenti si spegne il gizmo; dentro, va consumato del tutto.
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

console.log('[5] il ramo nuovo sta PRIMA del filtro che scartava Ctrl');
{
    const kd = tlSrc.indexOf("window.addEventListener('keydown'");
    const block = tlSrc.slice(kd, kd + 3000);
    const iSelectAll = block.indexOf('tlSelectAllKeys');
    const iCtrlFilter = block.indexOf('if (ev.ctrlKey || ev.metaKey || ev.altKey) return;');
    ok(iSelectAll > 0, 'la scorciatoia chiama tlSelectAllKeys');
    ok(iCtrlFilter > 0 && iSelectAll < iCtrlFilter,
       'il ramo Ctrl+A precede il filtro che scarta ctrlKey (altrimenti e\' morto)');
    ok(/!ev\.shiftKey/.test(block.slice(iSelectAll - 400, iSelectAll)),
       'il ramo esclude shiftKey: Ctrl+Shift+A resta del rig');
    ok(/stopImmediatePropagation/.test(block.slice(iSelectAll - 400, iSelectAll + 400)),
       'consuma l\'evento, cosi\' il gizmo globale non scatta anche lui');
}

console.log('[6] l\'area timeline e\' un flag, non hit-testing');
ok(/function tlAreaActive\(/.test(tlSrc), 'tlAreaActive esiste');
ok(/pointerenter|pointerover/.test(tlSrc) && /pointerleave/.test(tlSrc),
   'il flag si aggiorna col puntatore');
ok(/focusin/.test(tlSrc), 'e col focus: Ctrl+A funziona subito dopo aver cliccato una chiave');

console.log('[7] il rig e\' passato a Ctrl+Shift+A, senza italiano hardcoded');
{
    const i = rigSrc.indexOf('tlSetKeyAllBones(true)');
    ok(i > 0, 'il ramo del rig esiste ancora');
    const ctx = rigSrc.slice(Math.max(0, i - 700), i);
    ok(/ev\.shiftKey/.test(ctx), 'il ramo del rig richiede shiftKey');
    ok(!/Tutte le ossa selezionate per Keyframe/.test(rigSrc),
       'il toast italiano hardcoded e\' sparito');
    ok(/t\(\s*'rig\.allBonesKeyed'\s*\)/.test(rigSrc), 'il toast passa da t()');
}

console.log('[8] il gizmo globale non risponde piu\' a Ctrl+Shift+A');
{
    const i = sceneSrc.indexOf("e.key.toLowerCase() === 'a'");
    ok(i > 0, 'il ramo del gizmo globale esiste');
    const line = sceneSrc.slice(i - 200, i + 60);
    ok(/!e\.shiftKey/.test(line), 'esclude shiftKey (altrimenti sgancia il gizmo di nascosto)');
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
