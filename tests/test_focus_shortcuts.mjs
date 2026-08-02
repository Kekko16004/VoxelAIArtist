/*
 * FOCUS "APPICCICOSO" nei pannelli di sinistra.
 *
 * Il bug: dopo aver usato un <select> / una checkbox / un bottone, l'elemento
 * conserva il focus (bordo attorno) e le scorciatoie globali si spegnevano per
 * QUALUNQUE elemento focalizzato. Risultato: Tab, Ctrl+A e Ctrl+Z restavano
 * morti finche' non si cliccava altrove.
 *
 * Qui si verificano i due livelli del rimedio, presi DIRETTAMENTE da
 * ui/src/lib/01-scene-setup.js (non da una copia: se il blocco viene rimosso o
 * rinominato il test non parte nemmeno):
 *   1. isTypingTarget(evento): blocca solo se si sta digitando davvero, oppure
 *      se il tasto e' uno che quel controllo consuma nativamente;
 *   2. releaseFocusAfterPointer(): dopo l'interazione col MOUSE il controllo
 *      lascia il focus, preservandolo invece sul click SINTETICO di
 *      Invio/Spazio (altrimenti si spezza la navigazione da tastiera).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/01-scene-setup.js'), 'utf8');
const from = src.indexOf('const TEXT_INPUT_TYPES');
const MARK = 'releaseFocusAfterPointer();';
const to = src.indexOf(MARK, from);
if (from < 0 || to < 0) {
    console.log('FAIL: blocco "Focus e scorciatoie" non trovato in 01-scene-setup.js');
    process.exit(1);
}
const block = src.slice(from, to + MARK.length);

// --- DOM finto: solo cio' che il blocco usa davvero ---
const handlers = {};
const doc = {
    activeElement: null,
    addEventListener(t, f) { (handlers[t] || (handlers[t] = [])).push(f); },
};
const api = new Function('document', block +
    '\nreturn { isTextEntry, keyConsumedByControl, isTypingTarget };')(doc);
const fire = (t, e) => (handlers[t] || []).forEach(f => f(e));
const tick = () => new Promise(r => setTimeout(r, 1));

function el(tag, opts) {
    opts = opts || {};
    const e = {
        tagName: tag, type: opts.type, isContentEditable: !!opts.ce, _blurred: false,
        getAttribute: k => (opts.attrs && opts.attrs[k]) || null,
        blur() { this._blurred = true; },
    };
    // closest(): nel test ogni elemento "e' un controllo", basta a far passare
    // il filtro del gestore di click.
    e.closest = function () { return opts.notControl ? null : this; };
    return e;
}
const ev = (target, key, mods) => Object.assign({ target, key }, mods || {});

console.log('[1] isTextEntry: solo i campi che ricevono testo');
ok(api.isTextEntry(el('INPUT', { type: 'text' })), 'input text');
ok(api.isTextEntry(el('INPUT', { type: 'number' })), 'input number');
ok(api.isTextEntry(el('INPUT')), 'input senza type (default text)');
ok(api.isTextEntry(el('TEXTAREA')), 'textarea');
ok(api.isTextEntry(el('DIV', { ce: true })), 'contenteditable');
ok(!api.isTextEntry(el('SELECT')), 'un <select> NON e\' un campo di testo');
ok(!api.isTextEntry(el('INPUT', { type: 'range' })), 'slider');
ok(!api.isTextEntry(el('INPUT', { type: 'checkbox' })), 'checkbox');
ok(!api.isTextEntry(el('BUTTON')), 'bottone');
ok(!api.isTextEntry(null), 'null');

console.log('[2] keyConsumedByControl: quali tasti servono davvero al controllo');
const sel = el('SELECT'), rng = el('INPUT', { type: 'range' }), btn = el('BUTTON'),
    chk = el('INPUT', { type: 'checkbox' }), div = el('DIV'), txt = el('INPUT', { type: 'text' }),
    rolebtn = el('DIV', { attrs: { role: 'button' } });
ok(api.keyConsumedByControl(sel, ev(sel, 'ArrowDown')), 'select consuma ArrowDown');
ok(api.keyConsumedByControl(sel, ev(sel, 'g')), 'select consuma le lettere (type-ahead)');
ok(!api.keyConsumedByControl(sel, ev(sel, 'z', { ctrlKey: true })), 'select NON consuma Ctrl+Z');
ok(!api.keyConsumedByControl(sel, ev(sel, 'Tab')), 'select NON consuma Tab');
ok(api.keyConsumedByControl(rng, ev(rng, 'ArrowLeft')), 'slider consuma le frecce');
ok(!api.keyConsumedByControl(rng, ev(rng, 'x')), 'slider NON consuma le lettere');
ok(api.keyConsumedByControl(btn, ev(btn, ' ')), 'bottone consuma lo spazio');
ok(!api.keyConsumedByControl(btn, ev(btn, 'Tab')), 'bottone NON consuma Tab');
ok(api.keyConsumedByControl(rolebtn, ev(rolebtn, 'Enter')), 'role="button" consuma Invio');
ok(api.keyConsumedByControl(chk, ev(chk, ' ')), 'checkbox consuma lo spazio');
ok(!api.keyConsumedByControl(chk, ev(chk, 'q')), 'checkbox NON consuma le lettere');
ok(!api.keyConsumedByControl(div, ev(div, 'q')), 'un div qualunque non consuma niente');

console.log('[3] isTypingTarget: esattamente la regressione riportata');
const CASES = [
    [sel, 'z', { ctrlKey: true }, false, 'Ctrl+Z dopo aver usato un menu a tendina'],
    [sel, 'a', { ctrlKey: true }, false, 'Ctrl+A dopo un menu a tendina'],
    [sel, 'Tab', {}, false, 'Tab dopo un menu a tendina'],
    [chk, 'z', { ctrlKey: true }, false, 'Ctrl+Z dopo una checkbox'],
    [btn, 'z', { ctrlKey: true }, false, 'Ctrl+Z dopo un bottone'],
    [rng, 'z', { ctrlKey: true }, false, 'Ctrl+Z con uno slider di posa focalizzato'],
    [sel, 'ArrowDown', {}, true, 'ArrowDown resta al menu a tendina'],
    [btn, ' ', {}, true, 'lo spazio resta al bottone (e\' il suo "clic")'],
    [txt, 'z', { ctrlKey: true }, true, 'Ctrl+Z in un campo di testo resta nativo'],
    [txt, 'i', {}, true, 'una lettera in un campo di testo non e\' una scorciatoia'],
];
for (const [target, key, mods, want, label] of CASES) {
    ok(api.isTypingTarget(ev(target, key, mods)) === want, label);
}

async function main() {
    console.log('[4] releaseFocusAfterPointer: si libera col mouse, non con Invio');
    const s = el('SELECT');
    doc.activeElement = s;
    fire('change', { target: s });
    await tick();
    ok(s._blurred, 'change su <select>: il focus viene liberato');

    const t2 = el('INPUT', { type: 'text' });
    doc.activeElement = t2;
    fire('change', { target: t2 });
    await tick();
    ok(!t2._blurred, 'change su campo di testo: il focus RESTA (si sta scrivendo)');

    // detail === 0 => click SINTETICO da Invio/Spazio su un elemento raggiunto
    // col Tab: togliere il focus qui spezzerebbe la navigazione da tastiera.
    const b1 = el('BUTTON');
    doc.activeElement = b1;
    fire('click', { target: b1, detail: 0 });
    await tick();
    ok(!b1._blurred, 'click SINTETICO (Invio/Spazio): focus conservato per il Tab');

    const b2 = el('BUTTON');
    doc.activeElement = b2;
    fire('click', { target: b2, detail: 1 });
    await tick();
    ok(b2._blurred, 'click col MOUSE su un bottone: il focus viene liberato');

    const t3 = el('INPUT', { type: 'text' });
    doc.activeElement = t3;
    fire('click', { target: t3, detail: 1 });
    await tick();
    ok(!t3._blurred, 'click col mouse in un campo di testo: il focus RESTA');

    console.log('\n' + pass + ' passati, ' + fail + ' falliti');
    process.exit(fail ? 1 : 0);
}
main();
