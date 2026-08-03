/*
 * PRIMITIVE VOXEL (Shift+A). Le funzioni sono pure — niente DOM, niente THREE —
 * quindi si testano direttamente estraendole dai sorgenti.
 *
 * Le trappole vere, tutte gia' costate un bug in questo progetto:
 *  - una forma che produce ZERO voxel (a 'box' con float e' successo davvero);
 *  - l'errore di mezzo voxel, che rende una sfera di diametro pari sbilenca;
 *  - il guscio esterno "mangiato" di un voxel dal test sul raggio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/35-primitives.js'), 'utf8');
const budgetSrc = fs.readFileSync(path.join(ROOT, 'ui/src/utils/expand-ops.js'), 'utf8');
// voxelBudgetFor sta DOPO expandOps nel file, non prima: e' una posizione voluta
// dal Task 2 (tests/test_rig_parts_legs.mjs ritaglia expand-ops.js da
// indexOf('function expandOps') in avanti, quindi tutto cio' che sta prima
// sparisce da quel banco di prova). Percio' qui il blocco del budget si ritaglia
// per conto suo - dalle due const fino alla graffa di chiusura della funzione -
// invece di prendere "tutto quello che precede expandOps".
const bFrom = budgetSrc.indexOf('const MAX_VOXELS = 4000000;');
const bAt = budgetSrc.indexOf('function voxelBudgetFor');
const CLOSE = '\n            }';
const bClose = bAt < 0 ? -1 : budgetSrc.indexOf(CLOSE, bAt);
const bTo = bClose < 0 ? -1 : bClose + CLOSE.length;
if (bFrom < 0 || bAt < 0 || bClose < 0 || bFrom > bAt) {
    console.log('FAIL: voxelBudgetFor non trovata in expand-ops.js (Task 2 fatto?)');
    process.exit(1);
}
// Solo la parte PURA del modulo: si ferma al primo pezzo che tocca il DOM.
const uiMark = '// ===== UI: menu Shift+A e dialogo =====';
const pureEnd = src.indexOf(uiMark);
const pure = pureEnd < 0 ? src : src.slice(0, pureEnd);
const api = new Function(budgetSrc.slice(bFrom, bTo) + pure +
    '\nreturn { PRIMITIVE_SHAPES, primitiveShape, primitiveCells,' +
    ' primitiveGridFor, primitiveVoxelCount, voxelBudgetFor };')();
const IDS = ['cube', 'pyramid', 'cylinder', 'sphere', 'cone'];

console.log('[1] cinque forme, con proporzioni e default dichiarati');
ok(api.PRIMITIVE_SHAPES.length === 5, 'cinque forme');
ok(IDS.every(id => api.primitiveShape(id)), 'ogni id atteso esiste');
ok(api.primitiveShape('sphere').fixedRatio === true, 'la sfera ha proporzione FISSA');
ok(api.primitiveShape('cube').fixedRatio !== true, 'il cubo no');
ok(api.primitiveShape('nope') === null, 'un id sconosciuto da\' null');

console.log('[2] MAI vuote (e\' il bug che colpi\' box con i float)');
for (const id of IDS) {
    for (const s of [1, 2, 3, 8, 16]) {
        const h = Math.max(1, Math.round(s * api.primitiveShape(id).ratio));
        ok(api.primitiveCells(id, s, h).length > 0, `${id} a dimensione ${s} produce voxel`);
    }
}

console.log('[3] simmetria su X e su Z (coglie l\'errore di mezzo voxel)');
for (const id of IDS) {
    for (const s of [4, 5, 8, 9]) {
        const h = Math.max(1, Math.round(s * api.primitiveShape(id).ratio));
        const cells = api.primitiveCells(id, s, h);
        const set = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));
        const mirX = cells.every(c => set.has(`${s - 1 - c.x},${c.y},${c.z}`));
        const mirZ = cells.every(c => set.has(`${c.x},${c.y},${s - 1 - c.z}`));
        ok(mirX && mirZ, `${id} dimensione ${s}: simmetrica su X e Z`);
    }
}

console.log('[4] limiti: niente fuori dalla scatola, altezza esatta');
for (const id of IDS) {
    const s = 10, h = Math.max(1, Math.round(s * api.primitiveShape(id).ratio));
    const cells = api.primitiveCells(id, s, h);
    ok(cells.every(c => c.x >= 0 && c.x < s && c.z >= 0 && c.z < s && c.y >= 0 && c.y < h),
       `${id}: ogni voxel dentro ${s}x${h}x${s}`);
    const ys = cells.map(c => c.y);
    ok(Math.min(...ys) === 0 && Math.max(...ys) === h - 1,
       `${id}: occupa esattamente l'altezza chiesta`);
}

console.log('[5] forma');
ok(api.primitiveCells('cube', 6, 4).length === 6 * 6 * 4, 'cubo: pieno esatto');
{
    const cells = api.primitiveCells('cylinder', 9, 12);
    const perLevel = {};
    cells.forEach(c => { perLevel[c.y] = (perLevel[c.y] || 0) + 1; });
    const counts = Object.values(perLevel);
    ok(counts.every(n => n === counts[0]), 'cilindro: stessa sezione a ogni livello');
}
for (const id of ['cone', 'pyramid']) {
    const cells = api.primitiveCells(id, 12, 15);
    const w = {};
    cells.forEach(c => { w[c.y] = Math.max(w[c.y] || 0, 1); });
    const spanAt = y => {
        const xs = cells.filter(c => c.y === y).map(c => c.x);
        return xs.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0;
    };
    let mono = true;
    for (let y = 1; y < 15; y++) if (spanAt(y) > spanAt(y - 1)) mono = false;
    ok(mono, `${id}: si restringe in modo monotono verso l'alto`);
    ok(spanAt(14) > 0 && spanAt(14) <= 2, `${id}: l'apice e' non vuoto e largo al massimo 2`);
    ok(spanAt(0) === 12, `${id}: la base occupa tutta la dimensione`);
}
{
    const cells = api.primitiveCells('sphere', 8, 8);
    const set = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));
    ok(cells.every(c => set.has(`${c.x},${8 - 1 - c.y},${c.z}`)), 'sfera: simmetrica anche su Y');
}

console.log('[6] il guscio esterno non e\' mangiato di un voxel');
{
    // A dimensione dispari il livello equatoriale di una sfera deve toccare i due
    // bordi opposti: se il test sul raggio e' troppo severo, non ci arriva.
    const cells = api.primitiveCells('sphere', 9, 9).filter(c => c.y === 4);
    const xs = cells.map(c => c.x);
    ok(Math.min(...xs) === 0 && Math.max(...xs) === 8, 'sfera 9: l\'equatore tocca entrambi i bordi');
}

console.log('[7] scelta della griglia');
ok(api.primitiveGridFor(40, 40, 16) === 48, 'dimensione 40 su griglia 16 -> 48 (non 32)');
ok(api.primitiveGridFor(16, 16, 64) === 64, 'se ci sta gia\', la griglia non cambia');
ok(api.primitiveGridFor(600, 600, 64) === 512, 'dimensione 600 -> si ferma a 512');
ok(api.primitiveGridFor(200, 30, 32) === 256, 'vince la misura piu\' grande fra dimensione e altezza');

console.log('[8] il conteggio in forma chiusa e\' IDENTICO al ciclo sulle celle');
{
    // primitiveVoxelCount e' un secondo modello della stessa geometria: senza questo
    // confronto e' libero di divergere in silenzio, e il budget verrebbe deciso su un
    // numero sbagliato.
    const bad = [];
    for (const id of IDS) {
        const ratio = api.primitiveShape(id).ratio;
        for (let s = 1; s <= 40; s++) {
            for (const h of [1, 2, 3, s, Math.max(1, Math.round(s * ratio)), s * 2]) {
                const a = api.primitiveCells(id, s, h).length;
                const b = api.primitiveVoxelCount(id, s, h);
                if (a !== b) bad.push(`${id} ${s}x${h}: celle=${a} conteggio=${b}`);
            }
        }
    }
    ok(bad.length === 0, `misure 1..40, nessuna divergenza (${bad.length})`);
    if (bad.length) console.log('     ' + bad.slice(0, 6).join('\n     '));
    for (const id of IDS) {
        for (const s of [64, 100, 128]) {
            ok(api.primitiveCells(id, s, s).length === api.primitiveVoxelCount(id, s, s),
               `${id} ${s}: conteggio identico`);
        }
    }
    for (const bad2 of [[0, 4], [4, 0], [NaN, 4]]) {
        ok(api.primitiveVoxelCount('cube', bad2[0], bad2[1]) === 0,
           `conteggio(${bad2[0]},${bad2[1]}) -> 0`);
    }
}

console.log('[8-bis] la base occupa il lato chiesto ANCHE nelle forme schiacciate');
{
    // Il buco che ha lasciato passare un difetto vero sotto 107 asserzioni verdi: i
    // gruppi [4] e [5] provano solo altezze H >= S, cioe' l'unico regime in cui la
    // vecchia formula (y + 0.5) / H azzeccava la base. Con H < S/2 campionava il
    // centro del layer invece della base, e la piramide 16x1 nasceva larga 8.
    // Un tetto piatto e un cono schiacciato sono richieste normali: qui si pinnano.
    const spanBase = (id, S, H) => {
        const xs = new Set();
        for (const v of api.primitiveCells(id, S, H)) if (v.y === 0) xs.add(v.x);
        return xs.size;
    };
    const altezza = (id, S, H) => {
        let maxY = -1;
        for (const v of api.primitiveCells(id, S, H)) if (v.y > maxY) maxY = v.y;
        return maxY + 1;
    };
    const rotte = [];
    for (const id of ['pyramid', 'cone']) {
        for (const [S, H] of [[16, 1], [16, 2], [16, 4], [16, 8], [32, 4], [40, 3], [7, 1], [8, 2]]) {
            if (spanBase(id, S, H) !== S) rotte.push(`${id}(${S},${H}) base=${spanBase(id, S, H)} invece di ${S}`);
            if (altezza(id, S, H) !== H) rotte.push(`${id}(${S},${H}) altezza=${altezza(id, S, H)} invece di ${H}`);
        }
    }
    ok(rotte.length === 0, `piramide/cono schiacciati: base piena e altezza esatta (${rotte.length} rotti)`);
    if (rotte.length) console.log('     ' + rotte.slice(0, 6).join('\n     '));
    // Il caso singolo piu' facile da leggere, tenuto a parte perche' e' quello che
    // l'utente vede per primo: un tetto di altezza 1 e' un quadrato pieno.
    ok(spanBase('pyramid', 16, 1) === 16, 'piramide 16 alta 1 -> base larga 16, non 8');
    // E l'affusolamento non deve sparire: a H alta la cima resta una punta.
    const cima = (id, S, H) => {
        let maxY = -1; const top = new Set();
        for (const v of api.primitiveCells(id, S, H)) if (v.y > maxY) maxY = v.y;
        for (const v of api.primitiveCells(id, S, H)) if (v.y === maxY) top.add(v.x + ',' + v.z);
        return top.size;
    };
    ok(cima('pyramid', 16, 16) <= 4, 'piramide 16x16: la cima resta una punta');
    ok(cima('cone', 12, 18) <= 4, 'cono 12x18: la cima resta una punta');
}

console.log('[9] contare NON deve allocare: 512 va contato, non costruito');
{
    // Questo gruppo tiene in piedi il cap di CLAUDE.md. La regressione da cogliere
    // e' una sola e ha un nome: "semplificare" primitiveVoxelCount in
    // primitiveCells().length. Costa un OOM (misurato: ~13 s e oltre 4 GB su un cubo
    // 512) in una funzione che gira a ogni battuta di tasto nel campo Dimensione.
    //
    // L'asserzione e' STRUTTURALE, non cronometrica: una soglia di tempo o di heap
    // dipenderebbe dal carico della macchina e prima o poi fallirebbe senza una vera
    // regressione. Qui si legge il sorgente e si pretende che il conteggio non passi
    // dal costruttore di celle.
    const from = src.indexOf('function primitiveVoxelCount');
    ok(from >= 0, 'primitiveVoxelCount esiste');
    const body = src.slice(from, src.indexOf('\n            function ', from + 10));
    ok(!/primitiveCells/.test(body),
       'primitiveVoxelCount NON chiama primitiveCells (contare non deve allocare)');

    // E il conteggio a 512 deve comunque tornare il numero giusto: se la forma chiusa
    // sbaglia sulle misure grandi, il budget viene deciso su un numero falso.
    const counts = IDS.map(id => api.primitiveVoxelCount(id, 512, 512));
    ok(counts[0] === 512 * 512 * 512, 'cubo 512 = 134217728 voxel');
    ok(counts.every(n => Number.isFinite(n) && n > 0), 'ogni forma da\' un numero finito');
    ok(counts[3] < counts[2] && counts[2] < counts[0],
       'a 512 sfera < cilindro < cubo (i volumi restano ordinati)');
}

console.log('[10] budget: la forma piu\' costosa va rifiutata, non troncata');
{
    const g = api.primitiveGridFor(512, 512, 64);
    ok(api.primitiveVoxelCount('cube', 512, 512) > api.voxelBudgetFor([g, g, g]),
       'un cubo 512 sfonda il budget (va rifiutato a monte)');
    const g2 = api.primitiveGridFor(64, 64, 64);
    ok(api.primitiveVoxelCount('cube', 64, 64) <= api.voxelBudgetFor([g2, g2, g2]),
       'un cubo 64 sta nel budget');
    ok(api.primitiveVoxelCount('cube', 8, 8) === 512, 'primitiveVoxelCount conta davvero');
}

console.log('[11] parametri invalidi: array vuoto, non un\'eccezione');
for (const bad of [[0, 4], [-3, 4], [4, 0], [NaN, 4], [4, NaN]]) {
    ok(api.primitiveCells('cube', bad[0], bad[1]).length === 0,
       `cube(${bad[0]}, ${bad[1]}) -> vuoto`);
}
ok(api.primitiveCells('nope', 8, 8).length === 0, 'id sconosciuto -> vuoto');

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
