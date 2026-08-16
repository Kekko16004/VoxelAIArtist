/**
 * Deformatori, bevel vero, loft con sezioni, ZIP.
 * Tutto puro: gira in Node senza THREE e senza browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB = path.join(ROOT, 'ui', 'src', 'lib');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const files = ['01-expr.js', '02-mesh.js', '03-primitives.js', '03b-deform.js',
               '04-csg.js', '05-build.js', '06-validators.js'];
const code = files.map(f => fs.readFileSync(path.join(LIB, f), 'utf8')).join('\n')
  + '\n;this.__SAM = { meshBounds, meshIsClosed, meshIsEmpty, meshTriCount, meshVolume,'
  + ' meshArea, meshClone, primBox, primRoundBox, primCyl, primSphere, sectionPoints,'
  + ' primLoft2, meshTaper, meshShear, meshTwist, meshBend, meshWarp, meshSquash,'
  + ' applyDeformers, buildSpec, primBuild, validateAll, partMetrics, measuredFor };';
const sandbox = { console, Math, JSON, Float32Array, Uint32Array, Uint8Array, Map, Set, Object, Array };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const S = sandbox.__SAM;

console.log('[1] bevel: la scatola raccordata e\' chiusa e piu\' piccola dello spigolo vivo');
const plain = S.primBox(1, 1, 1);
const round = S.primRoundBox(1, 1, 1, 0.15, 3);
ok(!S.meshIsEmpty(round), 'rounded box non vuota');
ok(S.meshIsClosed(round), 'rounded box CHIUSA (' + S.meshTriCount(round) + ' tri)');
const bb = S.meshBounds(round);
ok(Math.abs(bb.size[0] - 1) < 1e-3, 'ingombro X invariato (' + bb.size[0].toFixed(4) + ')');
ok(Math.abs(S.meshVolume(round)) < Math.abs(S.meshVolume(plain)),
  'volume minore dello spigolo vivo (raccordo vero)');
ok(S.meshTriCount(round) > S.meshTriCount(plain), 'piu\' triangoli del box liscio');
// r=0 deve tornare la scatola semplice: senza, un bevel 0 costerebbe triangoli.
ok(S.meshTriCount(S.primRoundBox(1, 1, 1, 0, 3)) === S.meshTriCount(plain),
  'bevel 0 -> scatola semplice');

console.log('[2] bevel via primBuild (il campo era ACCETTATO E IGNORATO)');
const noBev = S.primBuild({ p: 'box', s: [1, 1, 1] }, 16, 2);
const yesBev = S.primBuild({ p: 'box', s: [1, 1, 1], bevel: 0.1 }, 16, 2);
ok(S.meshTriCount(yesBev) > S.meshTriCount(noBev), 'bevel ora cambia la geometria');

console.log('[3] taper: la sezione si stringe verso la fine');
const tap = S.primBox(1, 2, 1);
S.meshTaper(tap, 'y', { a: 1, b: 1 }, { a: 0.2, b: 1 });
const tb = S.meshBounds(tap);
ok(Math.abs(tb.size[1] - 2) < 1e-6, 'lunghezza invariata');
ok(Math.abs(tb.size[0] - 1) < 1e-6, 'larghezza massima invariata (alla base)');
// misura la larghezza in cima
let maxXTop = 0;
for (let i = 0; i < tap.pos.length; i += 3) {
    if (tap.pos[i + 1] > 0.99) maxXTop = Math.max(maxXTop, Math.abs(tap.pos[i]));
}
ok(Math.abs(maxXTop - 0.1) < 1e-6, 'in cima larga 0.2 (raggio 0.1), got ' + maxXTop.toFixed(4));
// lo spessore Z NON deve cambiare: e' il "stringere solo da un lato"
let maxZTop = 0;
for (let i = 0; i < tap.pos.length; i += 3) {
    if (tap.pos[i + 1] > 0.99) maxZTop = Math.max(maxZTop, Math.abs(tap.pos[i + 2]));
}
ok(Math.abs(maxZTop - 0.5) < 1e-6, 'spessore Z invariato (filo di lama)');

console.log('[4] shear, twist, bend, warp, squash cambiano la forma senza rompere');
for (const [name, fn] of [
    ['shear', (m) => S.meshShear(m, 'y', 'z', 0.4)],
    ['twist', (m) => S.meshTwist(m, 'y', 45)],
    ['bend', (m) => S.meshBend(m, 'y', 40, 'z')],
    ['warp', (m) => S.meshWarp(m, 0.03, 6, 1)],
    ['squash', (m) => S.meshSquash(m, 'z', 'max', 0.3)],
]) {
    const base = S.primBox(0.4, 2, 0.4);
    const before = JSON.stringify(S.meshBounds(base).size);
    const m = fn(S.meshClone(base));
    ok(!S.meshIsEmpty(m), name + ': mesh valida');
    let finite = true;
    for (let i = 0; i < m.pos.length; i++) if (!isFinite(m.pos[i])) finite = false;
    ok(finite, name + ': nessun NaN');
    ok(JSON.stringify(S.meshBounds(m).size) !== before || name === 'warp',
       name + ': la forma e\' cambiata');
}

console.log('[5] sezioni del loft');
ok(S.sectionPoints('rect', 12).length >= 4, 'rect');
ok(S.sectionPoints('lens', 16).length >= 6, 'lens');
ok(S.sectionPoints('hex').length === 6, 'hex ha 6 punti');
ok(S.sectionPoints('tri').length === 3, 'tri ha 3 punti');
// la lente e' piu' larga che alta: e' cio' che la rende una sezione di lama
const lens = S.sectionPoints('lens', 20);
const lw = Math.max(...lens.map(p => Math.abs(p[0])));
const lh = Math.max(...lens.map(p => Math.abs(p[1])));
ok(lw >= lh, 'la lente e\' larga almeno quanto alta (' + lw.toFixed(2) + '/' + lh.toFixed(2) + ')');

console.log('[6] loft: le sezioni sono ASSOLUTE sull\'asse');
const blade = S.primLoft2([
    { at: 0.268, s: [0.048, 0.010] },
    { at: 0.900, s: [0.040, 0.008] },
], 'lens', 16, 'y', true);
const lb = S.meshBounds(blade);
ok(Math.abs(lb.min[1] - 0.268) < 1e-4, 'inizia a 0.268 (got ' + lb.min[1].toFixed(4) + ')');
ok(Math.abs(lb.max[1] - 0.900) < 1e-4, 'finisce a 0.900 (got ' + lb.max[1].toFixed(4) + ')');
ok(Math.abs(lb.size[0] - 0.048) < 1e-3, 'larga 0.048');
ok(S.meshIsClosed(blade), 'lama chiusa');

console.log('[7] una spada con loft+lens passa i validatori');
const spada = {
    id: 'spada', cat: 'prop', style: 'lowpoly', detail: 3, ground: true,
    size: [0.115, 1.02, 0.048],
    params: { lama_a: 0.268, lama_b: 0.9, punta_a: 0.9, punta_b: 1.02 },
    mats: { acciaio: { col: '#B9C0C8' } },
    nodes: [
        { n: 'pomolo', p: 'sphere', r: 0.024, at: [0, 0.0275, 0], mat: 'acciaio' },
        { n: 'impugnatura', p: 'cyl', axis: 'y', r: 0.017, len: 0.175,
          at: [0, 0.1425, 0], taper0: 0.85, taperTo: 0.9, mat: 'acciaio' },
        { n: 'guardia', p: 'box', s: [0.115, 0.038, 0.026], at: [0, 0.249, 0],
          bevel: 0.004, mat: 'acciaio' },
        { n: 'lama', p: 'loft', axis: 'y', shape: 'lens',
          secs: [{ at: 'lama_a', s: [0.048, 0.010] }, { at: 'lama_b', s: [0.041, 0.008] }],
          mat: 'acciaio' },
        { n: 'punta', p: 'loft', axis: 'y', shape: 'lens',
          secs: [{ at: 'punta_a', s: [0.041, 0.008] }, { at: 'punta_b', s: [0.004, 0.003] }],
          mat: 'acciaio' },
    ],
};
const built = S.buildSpec(spada);
ok(built.parts.length === 5, '5 parti (got ' + built.parts.length + ')');
const sb = built.bounds;
ok(Math.abs(sb.size[1] - 1.02) < 0.02, 'alta ~1.02 m (got ' + sb.size[1].toFixed(4) + ')');
const defects = S.validateAll(spada, built, { hasPlan: true });
// L'intento di questo check e' "la GEOMETRIA e' sana", non "l'asset e' ricco":
// `underDetailed` e `unshaped` sono giudizi di qualita' e vengono provati a
// parte in [10] e [11] (questa spada ha 5 pezzi su un budget di 200, quindi li'
// deve proprio scattare).
const QUALITY = ['underDetailed', 'unshaped'];
const highs = defects.filter(d => d.sev === 'high' && QUALITY.indexOf(d.code) < 0);
ok(highs.length === 0, 'nessun difetto geometrico grave (' + highs.map(d => d.code).join(',') + ')');

console.log('[8] misure per parte e nodi bloccati');
const pm = S.partMetrics(built);
// Tolleranza 5 mm e non 1: `buildSpec` appoggia l'asset a terra, e il pomolo
// sferico (diametro 0.048) non riempie il suo segmento di 0.055 — quindi tutto
// scende di ~3.5 mm. E' comportamento voluto, non un errore di misura.
ok(pm.lama && Math.abs(pm.lama.min[1] - 0.268) < 0.005,
   'bbox della lama a ~0.268 (got ' + (pm.lama ? pm.lama.min[1].toFixed(4) : '?') + ')');
const spadaLocked = JSON.parse(JSON.stringify(spada));
spadaLocked.nodes[0].locked = true;
const meas = S.measuredFor(S.buildSpec(spadaLocked), spadaLocked);
ok(meas.locked.length === 1 && meas.locked[0] === 'pomolo',
   'i nodi bloccati viaggiano nell\'audit');

console.log('[9] bevel su extr (era la stessa insidia del box)');
const exNo = S.primBuild({ p: 'extr', prof: 'rect', len: 1, s: [0.4, 0.4, 0.4] }, 16, 2);
const exYes = S.primBuild({ p: 'extr', prof: 'rect', len: 1, s: [0.4, 0.4, 0.4], bevel: 0.06 }, 16, 2);
ok(S.meshTriCount(exYes) > S.meshTriCount(exNo), 'bevel su extr cambia la geometria');
ok(Math.abs(S.meshVolume(exYes)) < Math.abs(S.meshVolume(exNo)), 'smusso: volume minore');
const exb = S.meshBounds(exYes);
ok(Math.abs(exb.size[1] - 1) < 1e-6, 'lunghezza invariata');
ok(Math.abs(exb.size[0] - 0.4) < 1e-6, 'larghezza massima invariata');
// lo smusso deve restringere SOLO alle estremita'
let wTop = 0, wMid = 0;
for (let i = 0; i < exYes.pos.length; i += 3) {
    const y = exYes.pos[i + 1];
    if (y > 0.499) wTop = Math.max(wTop, Math.abs(exYes.pos[i]));
    if (Math.abs(y) < 0.01) wMid = Math.max(wMid, Math.abs(exYes.pos[i]));
}
ok(wTop < 0.2 - 1e-6, 'in cima e ristretto (' + wTop.toFixed(4) + ' < 0.2)');
ok(Math.abs(wMid - 0.2) < 1e-6 || wMid === 0, 'in mezzo resta pieno');
ok(S.meshIsClosed(exYes), 'extr smussata CHIUSA');

// profilo non circolare: lo smusso deve avere spessore uniforme, non scalato
const lNo = S.primBuild({ p: 'extr', prof: 'l', len: 1, s: [0.5, 0.5, 0.5] }, 16, 2);
const lYes = S.primBuild({ p: 'extr', prof: 'l', len: 1, s: [0.5, 0.5, 0.5], bevel: 0.05 }, 16, 2);
ok(S.meshTriCount(lYes) > S.meshTriCount(lNo), 'smusso anche su profilo a L');
let finiteL = true;
for (let i = 0; i < lYes.pos.length; i++) if (!isFinite(lYes.pos[i])) finiteL = false;
ok(finiteL, 'profilo a L senza NaN');

console.log('[10] il dettaglio richiesto viene MISURATO, non solo chiesto');
// La spada di [7] ha 5 pezzi: a dettaglio 3 il budget e' 200, quindi e' povera.
const dPoor = S.validateAll(spada, built, { hasPlan: true });
ok(dPoor.some(x => x.code === 'underDetailed'),
   'dettaglio 3 con 5 pezzi -> underDetailed (' + dPoor.map(x => x.code).join(',') + ')');
ok(dPoor.filter(x => x.code === 'underDetailed')[0].sev === 'high',
   'a dettaglio 3 conta come grave, quindi entra nel ciclo di correzione');
// A dettaglio basso la poverta' e' voluta.
const lowDetail = JSON.parse(JSON.stringify(spada));
lowDetail.detail = 1;
const dLow = S.validateAll(lowDetail, S.buildSpec(lowDetail), { hasPlan: true });
ok(!dLow.some(x => x.code === 'underDetailed'),
   'a dettaglio 1 nessuna pretesa di sottodettagli');
// Con abbastanza pezzi il difetto sparisce: la guardia ha denti.
const rich = JSON.parse(JSON.stringify(spada));
for (let i = 0; i < 45; i++) {
    rich.nodes.push({ n: 'anello_' + i, p: 'torus', r: 0.019, r2: 0.003,
                      at: [0, 0.07 + i * 0.002, 0], mat: 'acciaio' });
}
const dRich = S.validateAll(rich, S.buildSpec(rich), { hasPlan: true });
ok(!dRich.some(x => x.code === 'underDetailed'),
   'con 50 pezzi il difetto sparisce (' + dRich.map(x => x.code).join(',') + ')');

console.log('[11] primitive lisce senza forma');
const bricks = {
    id: 'mattoni', cat: 'prop', style: 'lowpoly', detail: 2, ground: true,
    size: [1, 1, 1], params: {}, mats: { m: { col: '#888888' } },
    nodes: [
        { n: 'a', p: 'box', s: [1, 0.2, 1], at: [0, 0.1, 0], mat: 'm' },
        { n: 'b', p: 'box', s: [0.8, 0.2, 0.8], at: [0, 0.3, 0], mat: 'm' },
        { n: 'c', p: 'cyl', r: 0.2, len: 0.4, at: [0, 0.6, 0], mat: 'm' },
        { n: 'd', p: 'box', s: [0.3, 0.2, 0.3], at: [0, 0.9, 0], mat: 'm' },
    ],
};
const dBricks = S.validateAll(bricks, S.buildSpec(bricks), { hasPlan: true });
ok(dBricks.some(x => x.code === 'unshaped'), 'quattro primitive nude -> unshaped');
// Bastano i deformatori per farlo tacere: non serve cambiare le misure.
const shaped = JSON.parse(JSON.stringify(bricks));
shaped.nodes[0].bevel = 0.02;
shaped.nodes[1].bevel = 0.02;
shaped.nodes[2].taperTo = 0.7;
shaped.nodes[3].bevel = 0.01;
const dShaped = S.validateAll(shaped, S.buildSpec(shaped), { hasPlan: true });
ok(!dShaped.some(x => x.code === 'unshaped'),
   'con bevel e taper il difetto sparisce');

console.log();
console.log('PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
