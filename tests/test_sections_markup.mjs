/*
 * Le sezioni della sidebar devono essere richiudibili NEL FILE CHE IL BROWSER
 * CARICA, cioe' in ui/index.html.
 *
 * tests/test_sections.mjs prova la LOGICA di 34-sections.js con un DOM finto:
 * passa anche se il markup generato non contiene nessun <details>, perche' il
 * DOM finto se lo costruisce da solo. Questo test guarda invece l'artefatto
 * costruito da `node ui/build.mjs`, che e' l'unica cosa che l'utente vede.
 *
 * Perche' esiste: una copia dell'app in cui l'HTML generato era vecchio mostrava
 * i titoli della sidebar senza freccia e senza possibilita' di chiuderli, mentre
 * tutti i test erano verdi.
 *
 * Requisiti di un <details> funzionante in Chromium:
 *   - il <summary> deve essere il PRIMO figlio del <details> (altrimenti il
 *     browser ne genera uno implicito e il titolo non e' piu' il comando);
 *   - il corpo deve stare dentro il <details>, non dopo;
 *   - il marker di default va nascosto in due modi (list-style: none e
 *     ::-webkit-details-marker), altrimenti si vedono due frecce.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// build.mjs legge/scrive ui/src in latin1: si rilegge con la stessa codifica.
const HTML = fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'latin1');

// Il bundle JS e' l'ULTIMO <script> del file: tutto quello che viene prima e'
// markup + CSS. Serve separarli, perche' 34-sections.js cita "sb-section" nei
// commenti e altrimenti i conteggi sarebbero falsati.
const cut = HTML.lastIndexOf('<script>');
ok(cut > 0, 'ui/index.html contiene il bundle inline');
const MARKUP = HTML.slice(0, cut);
const BUNDLE = HTML.slice(cut);

// ---------------- 1. le sezioni esistono davvero nel markup ----------------
const openTag = /<details\b([^>]*)>/g;
const sections = [];
let m;
while ((m = openTag.exec(MARKUP))) {
    if (!/\bclass="[^"]*\bsb-section\b/.test(m[1])) continue;
    sections.push({ attrs: m[1], at: m.index, bodyStart: openTag.lastIndex });
}
ok(sections.length >= 15,
    'sidebar/impostazioni: ' + sections.length + ' sezioni <details class="sb-section"> (minimo 15)');

const ids = sections.map(s => (s.attrs.match(/id="([^"]+)"/) || [, ''])[1]);
ok(ids.every(Boolean), 'ogni sezione ha un id (serve per ricordarne lo stato)');
ok(ids.every(i => i.startsWith('sbSec')), 'gli id seguono la convenzione sbSec*');
ok(new Set(ids).size === ids.length, 'nessun id duplicato');
['sbSecGenerate', 'sbSecModelInfo', 'sbSecTools', 'sbSecSkeleton', 'sbSecAppearance']
    .forEach(id => ok(ids.includes(id), 'presente la sezione ' + id));

// ---------------- 2. struttura di ciascun <details> ----------------
// Chiusura corrispondente, contando gli annidamenti (le opzioni GLB sono un
// <details> dentro la sezione "Genera").
function closeOf(html, from) {
    const tags = /<\/?details\b/g;
    tags.lastIndex = from;
    let depth = 1, t;
    while ((t = tags.exec(html))) {
        depth += t[0][1] === '/' ? -1 : 1;
        if (depth === 0) return t.index;
    }
    return -1;
}

let badFirst = [], badBody = [], badSummaryClass = [], notClosed = [];
sections.forEach((s, i) => {
    const end = closeOf(MARKUP, s.bodyStart);
    if (end < 0) { notClosed.push(ids[i]); return; }
    const inner = MARKUP.slice(s.bodyStart, end);
    const first = inner.match(/<([a-zA-Z][\w-]*)\b([^>]*)>/);
    if (!first || first[1].toLowerCase() !== 'summary') badFirst.push(ids[i]);
    else if (!/\bclass="[^"]*\bsection-title\b/.test(first[2])) badSummaryClass.push(ids[i]);
    const afterSummary = inner.slice(inner.indexOf('</summary>') + 10);
    if (!/^\s*<div\b[^>]*\bclass="[^"]*\bsb-body\b/.test(afterSummary)) badBody.push(ids[i]);
});
ok(!notClosed.length, '</details> presente per ogni sezione' + (notClosed.length ? ': ' + notClosed : ''));
ok(!badFirst.length, 'il <summary> e\' il primo figlio del <details>' + (badFirst.length ? ' -- NO: ' + badFirst : ''));
ok(!badSummaryClass.length, 'il <summary> conserva class="section-title"' + (badSummaryClass.length ? ' -- NO: ' + badSummaryClass : ''));
ok(!badBody.length, 'subito dopo il </summary> c\'e\' il <div class="sb-body">' + (badBody.length ? ' -- NO: ' + badBody : ''));

// ---------------- 3. nessun titolo rimasto fuori da un <summary> ----------------
// Un .section-title su un <div> nel markup e' un titolo non richiudibile: e'
// esattamente il difetto segnalato. I titoli iniettati a runtime (22-screens.js)
// stanno nel bundle, non qui, e li promuove sbUpgradeInjected().
const flatTitles = [];
const titleTag = /<([a-zA-Z][\w-]*)\b([^>]*\bclass="[^"]*\bsection-title\b[^"]*"[^>]*)>/g;
while ((m = titleTag.exec(MARKUP))) {
    if (m[1].toLowerCase() !== 'summary') flatTitles.push(m[1] + ' ' + m[2].slice(0, 70));
}
ok(!flatTitles.length,
    'nel markup ogni .section-title e\' un <summary>' + (flatTitles.length ? ' -- fuori: ' + flatTitles.join(' / ') : ''));

// ---------------- 4. il CSS che rende cliccabile e visibile il comando -------
[
    ['.sb-section > summary', 'regola sul summary della sezione'],
    ['cursor: pointer', 'summary cliccabile (cursor: pointer)'],
    ['::-webkit-details-marker', 'marker di default nascosto (Chromium)'],
    ['list-style: none', 'marker di default nascosto (standard)'],
    ['.sb-section[open] > summary::after', 'chevron che ruota da chiuso a aperto'],
    ['.sb-toggle-all', 'stile del comando "Apri/Chiudi tutto"'],
].forEach(([needle, label]) => ok(MARKUP.includes(needle), 'CSS: ' + label));

// Il chevron sta a destra solo se il summary e' un contenitore flex: .section-title
// lo e' gia', ma se qualcuno lo cambiasse la freccia finirebbe attaccata al testo.
const st = MARKUP.match(/\.section-title\s*\{[^}]*\}/);
ok(st && /display:\s*flex/.test(st[0]), '.section-title resta display: flex (chevron allineato a destra)');
ok(st && /margin-left:\s*auto/.test((MARKUP.match(/\.sb-section > summary::after\s*\{[^}]*\}/) || [''])[0]),
    'il chevron usa margin-left: auto');

// ---------------- 5. il modulo che le pilota e' nel bundle ------------------
[
    ['voxelai-sections', 'chiave localStorage dello stato'],
    ['sbInitSections', 'applicazione dello stato salvato'],
    ['sbUpgradeInjected', 'promozione delle sezioni iniettate a runtime'],
    ['sbBuildToggleAll', 'creazione del comando Apri/Chiudi tutto'],
    ['sbSectionsPrepaint', 'stile temporaneo anti-lampeggio'],
].forEach(([needle, label]) => ok(BUNDLE.includes(needle), 'bundle: ' + label));

// Lo stile anti-lampeggio deve essere rimosso, altrimenti resta a sovrascrivere
// per sempre lo stato reale delle sezioni.
ok(/sbSectionsPrepaint[\s\S]{0,400}?remove\(\)/.test(BUNDLE) ||
    BUNDLE.includes("getElementById('sbSectionsPrepaint')"),
    'bundle: il prepaint viene rimosso dopo l\'avvio');

console.log('');
console.log(fail ? 'TEST FALLITI  (pass=' + pass + ', fail=' + fail + ')'
    : 'TUTTI I TEST PASSATI  (pass=' + pass + ')');
process.exit(fail ? 1 : 0);
