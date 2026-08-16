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
  + ' applyDeformers, buildSpec, primBuild, validateAll, partMetrics, measuredFor,'
  + ' primLathe2, vesselProfile, smoothProfile, VESSEL_PROFILES,'
  + ' componentReport, autoRepair, offsetField, primTubePath,'
  + ' meshSmoothNormals, specProfiles, validateProfiles, repairAgainstPlan };';
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
// Senza PIANO non si sa quanti pezzi meriti quell'oggetto, quindi resta un
// avviso: un vaso e' un solido di rivoluzione e sta in due pezzi, e pretenderne
// quaranta perche' il budget e' duecento farebbe imbullonare pezzi inutili.
ok(dPoor.filter(x => x.code === 'underDetailed')[0].sev === 'medium',
   'senza piano e solo un avviso');
// Col PIANO il bersaglio esiste, e allora e' grave: entra nel ciclo di correzione.
const dPlanned = S.validateAll(spada, built, { hasPlan: true, expectedParts: 14 });
const ud = dPlanned.filter(x => x.code === 'underDetailed')[0];
ok(ud && ud.sev === 'high', 'con un piano da 14 pezzi diventa grave');
ok(ud && ud.what.indexOf('13') >= 0, 'chiede i pezzi del piano meno uno: ' + (ud ? ud.what : ''));
// Un piano da 2 pezzi (un vaso) NON pretende dettaglio che non serve.
const dVase = S.validateAll(spada, built, { hasPlan: true, expectedParts: 2 });
ok(!dVase.some(x => x.code === 'underDetailed'),
   'un piano da 2 pezzi e soddisfatto da 5 parti');
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

console.log('[12] tornio: un vaso deve essere un SOLIDO, non un guscio');
const vaso = S.primLathe2('vase', 32, 360, 'y', 0.006);
ok(!S.meshIsEmpty(vaso), 'vaso costruito');
ok(S.meshIsClosed(vaso), 'vaso CHIUSO: fondo, parete e labbro (era aperto)');
const vb = S.meshBounds(vaso);
ok(Math.abs(vb.min[1]) < 1e-6, 'parte da y=0');
ok(Math.abs(vb.max[1] - 1) < 1e-6, 'silhouette normalizzata: alta 1');
ok(vb.size[0] > 0.5 && vb.size[0] <= 1.001, 'larga entro il diametro');
// Cavo davvero: il volume del solido con parete e MOLTO minore del pieno.
const pieno = S.primLathe2('vase', 32, 360, 'y', 0);
ok(Math.abs(S.meshVolume(vaso)) < Math.abs(S.meshVolume(pieno)) * 0.6,
   'con wall il volume crolla: e cavo (' + Math.abs(S.meshVolume(vaso)).toFixed(4)
   + ' vs ' + Math.abs(S.meshVolume(pieno)).toFixed(4) + ')');
ok(S.meshIsClosed(pieno), 'anche il solido pieno e chiuso');

console.log('[13] profilo interpolato: silhouette liscia, non spezzata');
const raw4 = [[0.3, 0], [0.5, 0.4], [0.26, 0.75], [0.33, 1]];
const smooth = S.smoothProfile(raw4, 20);
ok(smooth.length === 20, 'campionato a 20 punti');
ok(Math.abs(smooth[0][0] - 0.3) < 1e-9 && Math.abs(smooth[0][1]) < 1e-9,
   'parte esattamente sul primo punto');
const last = smooth[smooth.length - 1];
ok(Math.abs(last[0] - 0.33) < 1e-9 && Math.abs(last[1] - 1) < 1e-9,
   'finisce esattamente sull ultimo punto');
ok(smooth.every(p => p[0] >= 0), 'nessun raggio negativo');
// La curva deve DEVIARE dalla spezzata: se coincidesse, non stiamo lisciando.
let maxDev = 0;
for (const p of smooth) {
    // distanza dal segmento piu vicino della spezzata originale
    let best = Infinity;
    for (let i = 0; i < raw4.length - 1; i++) {
        const a = raw4[i], b = raw4[i + 1];
        const vx = b[0] - a[0], vy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p[0]-a[0])*vx + (p[1]-a[1])*vy) / (vx*vx+vy*vy)));
        const dx = a[0] + vx*t - p[0], dy = a[1] + vy*t - p[1];
        best = Math.min(best, Math.sqrt(dx*dx + dy*dy));
    }
    maxDev = Math.max(maxDev, best);
}
ok(maxDev > 0.002, 'la curva si scosta dalla spezzata (' + maxDev.toFixed(4) + ')');

console.log('[14] silhouette note');
ok(Object.keys(S.VESSEL_PROFILES).length >= 10, 'almeno dieci silhouette');
ok(S.vesselProfile('vaso') && S.vesselProfile('bottiglia') && S.vesselProfile('calice'),
   'gli alias italiani risolvono');
ok(S.vesselProfile('inesistente') === null, 'un nome ignoto da null (non un vaso a caso)');
for (const name of Object.keys(S.VESSEL_PROFILES)) {
    const m = S.primLathe2(name, 24, 360, 'y', 0);
    ok(!S.meshIsEmpty(m) && S.meshIsClosed(m), name + ': solido chiuso');
}

console.log('[15] tornio dal nodo, con scala su r e len');
const vasoNodo = S.primBuild({ p: 'lathe', prof: 'vase', r: 0.145, len: 0.42,
                               wall: 0.006, sides: 32, axis: 'y' }, 32, 2);
const vnb = S.meshBounds(vasoNodo);
ok(Math.abs(vnb.max[1] - 0.42) < 1e-4, 'alto 0.42 come chiesto (' + vnb.max[1].toFixed(4) + ')');
ok(Math.abs(vnb.size[0] - 0.29) < 0.01, 'largo 0.29 = 2*r (' + vnb.size[0].toFixed(4) + ')');
ok(S.meshIsClosed(vasoNodo), 'chiuso anche passando dal nodo');

console.log('[16] array POLARE: le copie girano attorno all asse');
const polare = {
    id: 'flangia', cat: 'prop', style: 'lowpoly', detail: 2, ground: true,
    size: [0.4, 0.1, 0.4], params: {}, mats: { m: { col: '#888888' } },
    nodes: [
        { n: 'bullone', p: 'cyl', r: 0.012, len: 0.03, axis: 'y',
          at: [0.15, 0.05, 0], mat: 'm',
          arr: { n: 8, step: [0, 0, 0], rot: [0, 45, 0] } },
    ],
};
const bp = S.buildSpec(polare);
const bpb = bp.bounds;
// Otto bulloni a raggio 0.15 riempiono un cerchio di diametro 0.30 su X e Z:
// se le copie restassero sovrapposte, l'ingombro sarebbe quello di UN bullone.
ok(bpb.size[0] > 0.28 && bpb.size[0] < 0.33,
   'ingombro X = cerchio dei bulloni (' + bpb.size[0].toFixed(3) + ')');
ok(bpb.size[2] > 0.28 && bpb.size[2] < 0.33,
   'ingombro Z = cerchio dei bulloni (' + bpb.size[2].toFixed(3) + ')');
ok(Math.abs(bpb.size[0] - bpb.size[2]) < 0.01, 'simmetrico attorno all asse');
// Contro-prova: senza rot le copie stanno tutte insieme.
const fermo = JSON.parse(JSON.stringify(polare));
delete fermo.nodes[0].arr.rot;
const fb = S.buildSpec(fermo).bounds;
ok(fb.size[0] < 0.05, 'senza rot le copie restano sovrapposte (' + fb.size[0].toFixed(3) + ')');
// L'array lineare non e stato rotto dalla correzione.
const lineare = JSON.parse(JSON.stringify(polare));
lineare.nodes[0].at = [0, 0.05, 0];
lineare.nodes[0].arr = { n: 4, step: [0.1, 0, 0] };
const lbb = S.buildSpec(lineare).bounds;
ok(lbb.size[0] > 0.29 && lbb.size[0] < 0.35,
   'array lineare: 4 copie a passo 0.1 (' + lbb.size[0].toFixed(3) + ')');

console.log('[17] pezzi staccati: DIRE quale e di quanto');
const staccato = {
    id: 'staccato', cat: 'prop', style: 'lowpoly', detail: 1, ground: true,
    size: [0.4, 0.4, 0.2], params: {}, mats: { m: { col: '#888888' } },
    nodes: [
        { n: 'corpo', p: 'box', s: [0.2, 0.2, 0.1], at: [0, 0.1, 0], mat: 'm' },
        { n: 'appendice', p: 'box', s: [0.06, 0.06, 0.06], at: [0.19, 0.1, 0], mat: 'm' },
    ],
};
const bs = S.buildSpec(staccato);
const rep = S.componentReport(bs);
ok(rep.components === 2, 'due componenti (' + rep.components + ')');
ok(rep.isolated.length === 1, 'una parte isolata');
ok(rep.isolated[0].name === 'appendice', 'nominata: ' + rep.isolated[0].name);
ok(rep.isolated[0].nearest === 'corpo', 'sa da chi e staccata');
ok(rep.isolated[0].axis === 0, 'sa su quale asse (X)');
ok(rep.isolated[0].gap > 0.02 && rep.isolated[0].gap < 0.08,
   'misura il distacco: ' + (rep.isolated[0].gap * 1000).toFixed(1) + ' mm');
const dSt = S.validateAll(staccato, bs, { hasPlan: true, expectedParts: 2 });
const det = dSt.filter(x => x.code === 'detachedParts')[0];
ok(det && det.where === 'appendice', 'il difetto punta il nodo giusto');
ok(det && det.what.indexOf('mm') > 0, 'il difetto contiene i millimetri');

console.log('[18] aggancio automatico, senza AI');
const fixed = S.autoRepair(staccato, bs);
ok(fixed.repairs.some(r => r.indexOf('snap:appendice') === 0),
   'agganciato: ' + fixed.repairs.join(','));
const bs2 = S.buildSpec(fixed.spec);
const rep2 = S.componentReport(bs2);
ok(rep2.components === 1 || rep2.isolated.length === 0,
   'dopo l aggancio e un pezzo solo (' + rep2.components + ')');
// Un pezzo LONTANO non si trascina di nascosto: resta un difetto da segnalare.
const lontano = JSON.parse(JSON.stringify(staccato));
lontano.nodes[1].at = [0.9, 0.1, 0];
const bl = S.buildSpec(lontano);
const fl = S.autoRepair(lontano, bl);
ok(!fl.repairs.some(r => r.indexOf('snap:') === 0),
   'un pezzo lontano NON viene spostato in silenzio');
// Un nodo bloccato a mano non si tocca.
const bloccato = JSON.parse(JSON.stringify(staccato));
bloccato.nodes[1].locked = true;
const fb2 = S.autoRepair(bloccato, S.buildSpec(bloccato));
ok(!fb2.repairs.some(r => r.indexOf('snap:') === 0),
   'un nodo locked non viene agganciato');

console.log('[19] offsetField non scollega dalla catena del piano');
ok(S.offsetField(0.5, 0.1) === 0.6, 'numero + numero');
ok(S.offsetField('(a+b)/2', 0.02) === '((a+b)/2)+0.02',
   'espressione conservata: ' + S.offsetField('(a+b)/2', 0.02));
ok(S.offsetField('h', -0.03) === '(h)-0.03', 'delta negativo');
ok(S.offsetField('h', 0) === 'h', 'delta nullo non tocca niente');

console.log('[20] tubo lungo un percorso (era accettato e IGNORATO)');
const ansaPath = [[0.10, 0.30, 0], [0.15, 0.286, 0], [0.168, 0.245, 0],
                  [0.152, 0.208, 0], [0.108, 0.196, 0]];
const ansa = S.primTubePath(ansaPath, 0.013, 14);
ok(!S.meshIsEmpty(ansa), 'ansa costruita');
ok(S.meshIsClosed(ansa), 'ansa CHIUSA (tappi ai capi)');
const ab = S.meshBounds(ansa);
// La curva va da x=0.10 a x=0.168: l'ingombro deve rispecchiarla, non essere
// quello di un tubo retto.
ok(ab.min[0] > 0.08 && ab.max[0] < 0.19,
   'segue la curva su X (' + ab.min[0].toFixed(3) + '..' + ab.max[0].toFixed(3) + ')');
ok(ab.size[1] > 0.09 && ab.size[1] < 0.14,
   'e su Y (' + ab.size[1].toFixed(3) + ')');
ok(ab.size[2] < 0.03, 'resta piatta su Z come il percorso');
// Un tubo RETTO con lo stesso raggio non ha lo stesso ingombro: la prova che il
// percorso conta davvero.
const retto = S.primBuild({ p: 'tube', r: 0.013, len: 0.115, axis: 'y' }, 14, 2);
ok(S.meshBounds(retto).size[0] < 0.03,
   'il tubo retto resta sottile su X (contro-prova)');
// Dal nodo, con `path`, si passa dal percorso.
const daNodo = S.primBuild({ p: 'tube', r: 0.013, path: ansaPath }, 14, 2);
ok(Math.abs(S.meshBounds(daNodo).size[0] - ab.size[0]) < 1e-6,
   'primBuild usa il percorso quando c e');
let finiteA = true;
for (let i = 0; i < ansa.pos.length; i++) if (!isFinite(ansa.pos[i])) finiteA = false;
ok(finiteA, 'nessun NaN nel trasporto delle terne');
// Percorso verticale: e il caso in cui una terna fissa si capovolge.
const vert = S.primTubePath([[0, 0, 0], [0, 0.1, 0], [0, 0.2, 0]], 0.01, 12);
ok(S.meshIsClosed(vert) && !S.meshIsEmpty(vert),
   'percorso verticale senza capovolgimenti');

console.log('[21] auto smooth: normali, non geometria');
const cil = S.primCyl(0.1, 0.3, 12, 1, 'y');
const flat = S.meshSmoothNormals(cil, 1);      // soglia minima = tutto vivo
const soft = S.meshSmoothNormals(cil, 60);     // soglia alta = fianco liscio
ok(soft.pos.length === flat.pos.length, 'stesso numero di vertici espansi');
// Il volume NON deve cambiare: e un'operazione sulle normali.
const vFlat = S.meshVolume({ pos: flat.pos, idx: flat.idx });
const vSoft = S.meshVolume({ pos: soft.pos, idx: soft.idx });
ok(Math.abs(vFlat - vSoft) < 1e-9, 'volume identico (la geometria non si tocca)');
// Entrambi in valore assoluto: `meshVolume` e' FIRMATO e il confronto fra un
// valore firmato e uno assoluto fallirebbe per il segno, non per il volume.
ok(Math.abs(Math.abs(vFlat) - Math.abs(S.meshVolume(cil))) < 1e-6,
   'e identico all originale');
// Le normali del fianco devono DIVERGERE fra flat e smooth: e la prova che la
// soglia lavora. Con soglia 1 grado ogni faccia tiene la sua normale.
let diff = 0;
for (let i = 0; i < soft.normals.length; i += 3) {
    const d = Math.abs(soft.normals[i] - flat.normals[i])
            + Math.abs(soft.normals[i + 1] - flat.normals[i + 1])
            + Math.abs(soft.normals[i + 2] - flat.normals[i + 2]);
    if (d > 0.01) diff++;
}
ok(diff > 20, diff + ' normali cambiate con la soglia alta');
// Normali unitarie in entrambi i casi: una normale non normalizzata scurisce.
let unit = true;
for (let i = 0; i < soft.normals.length; i += 3) {
    const l = Math.hypot(soft.normals[i], soft.normals[i+1], soft.normals[i+2]);
    if (Math.abs(l - 1) > 1e-3) unit = false;
}
ok(unit, 'tutte le normali sono unitarie');
// Su un CUBO la soglia 40 deve tenere gli spigoli vivi: le facce a 90 gradi
// non si mediano, o il cubo sembrerebbe una palla.
const cubo = S.primBox(1, 1, 1);
const cs = S.meshSmoothNormals(cubo, 40);
let axisAligned = 0;
for (let i = 0; i < cs.normals.length; i += 3) {
    const m = Math.max(Math.abs(cs.normals[i]), Math.abs(cs.normals[i+1]),
                       Math.abs(cs.normals[i+2]));
    if (m > 0.999) axisAligned++;
}
ok(axisAligned === cs.normals.length / 3,
   'il cubo resta a spigoli vivi (' + axisAligned + ' normali sugli assi)');

console.log('[22] validatori del profilo 2D');
const buonProfilo = { nodes: [{ n: 'v', p: 'lathe',
    prof: [[0.05,0],[0.06,0.01],[0.11,0.13],[0.12,0.19],[0.08,0.31],[0.09,0.41]] }] };
ok(S.validateProfiles(buonProfilo).length === 0,
   'un profilo pulito non da difetti');
const tornaIndietro = { nodes: [{ n: 'v', p: 'lathe',
    prof: [[0.05,0],[0.11,0.20],[0.09,0.10],[0.08,0.30]] }] };
ok(S.validateProfiles(tornaIndietro).some(x => x.code === 'profileNotMonotone'),
   'quota che torna indietro -> profileNotMonotone');
const gradino = { nodes: [{ n: 'v', p: 'lathe',
    prof: [[0.05,0],[0.05,0.10],[0.12,0.101],[0.12,0.30]] }] };
ok(S.validateProfiles(gradino).some(x => x.code === 'profileStep'),
   'salto di raggio a quota ferma -> profileStep (la pila di dischi)');
const negativo = { nodes: [{ n: 'v', p: 'lathe', prof: [[0.05,0],[-0.02,0.1],[0.05,0.2]] }] };
ok(S.validateProfiles(negativo).some(x => x.code === 'profileNegativeRadius'),
   'raggio negativo rilevato');
ok(S.specProfiles(buonProfilo).length === 1, 'specProfiles trova il profilo');
ok(S.specProfiles({ nodes: [{ n: 'x', p: 'box' }] }).length === 0,
   'e ignora i nodi senza profilo');

console.log('[23] riscalatura contro il piano (il plinto da 1 metro)');
const planV = { axis: 'y', axisLength: 0.65,
    chain: [{ n: 'plinto', from: 0, to: 0.045, w: 0.21, d: 0.21 },
            { n: 'corpo', from: 0.045, to: 0.65, w: 0.30, d: 0.30 }],
    extras: [] };
const sbagliata = {
    id: 'v', cat: 'prop', style: 'lowpoly', detail: 2, ground: true,
    params: {}, mats: {},
    nodes: [
        { n: 'plinto', p: 'box', s: [1.0, 0.045, 1.0], at: [0, 0.0225, 0] },
        { n: 'corpo', p: 'cyl', r: 0.15, len: 0.605, at: [0, 0.3475, 0] },
    ],
};
const bWrong = S.buildSpec(sbagliata);
ok(bWrong.bounds.size[0] > 0.9, 'il plinto sbagliato porta l ingombro a 1 m');
const rp = S.repairAgainstPlan(sbagliata, bWrong, planV);
ok(rp.repairs.some(r => r.indexOf('rescale:plinto') === 0),
   'riscalato: ' + rp.repairs.join(','));
const bFixed = S.buildSpec(rp.spec);
ok(bFixed.bounds.size[0] < 0.35,
   'ingombro rientrato a ' + bFixed.bounds.size[0].toFixed(3) + ' m');
// Un nodo GIA' giusto non si tocca: la riparazione non deve rimaneggiare il
// lavoro buono.
ok(!rp.repairs.some(r => r.indexOf('rescale:corpo') === 0),
   'il corpo, che era corretto, resta intatto');
// Un nodo bloccato a mano non si tocca mai.
const bloccata = JSON.parse(JSON.stringify(sbagliata));
bloccata.nodes[0].locked = true;
const rp2 = S.repairAgainstPlan(bloccata, S.buildSpec(bloccata), planV);
ok(!rp2.repairs.length, 'un nodo locked non viene riscalato');

console.log();
console.log('PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
