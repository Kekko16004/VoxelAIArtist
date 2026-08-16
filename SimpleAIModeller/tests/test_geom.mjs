/**
 * Test del motore geometrico (espressioni, primitive, build, validatori).
 * Gira in Node senza THREE e senza browser: geom/* e' puro.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB = path.join(ROOT, 'ui', 'src', 'lib');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// Carica i moduli puri (01-06) in un contesto condiviso.
const files = [
  '01-expr.js', '02-mesh.js', '03-primitives.js',
  '04-csg.js', '05-build.js', '06-validators.js',
];
const code = files.map(f => fs.readFileSync(path.join(LIB, f), 'utf8')).join('\n')
  + '\n;this.__SAM = { evalExpr, evalVec3, meshBounds, meshIsEmpty, meshIsClosed,'
  + ' meshArea, meshVolume, meshTriCount, meshMerge, meshTranslate,'
  + ' primBox, primSphere, primCyl, primCaps, primTorus, primStairs, primBuild,'
  + ' csgApply, buildSpec, validateAll, metricsOf, autoRepair, DETAIL_LEVELS };';
const sandbox = { console, Math, JSON, Float32Array, Uint32Array, Uint8Array, Map, Set, Object, Array };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const {
  evalExpr, evalVec3,
  meshBounds, meshIsEmpty, meshIsClosed, meshArea, meshVolume, meshTriCount, meshMerge, meshTranslate,
  primBox, primSphere, primCyl, primCaps, primTorus, primStairs, primBuild,
  csgApply,
  buildSpec, validateAll, metricsOf, autoRepair, DETAIL_LEVELS,
} = sandbox.__SAM;

console.log('[1] espressioni');
ok(Math.abs(evalExpr('1+2*3') - 7) < 1e-9, '1+2*3=7');
ok(Math.abs(evalExpr('h*0.5', { h: 2 }) - 1) < 1e-9, 'h*0.5');
ok(Math.abs(evalExpr('w-2*t', { w: 1, t: 0.1 }) - 0.8) < 1e-9, 'w-2*t');
ok(Math.abs(evalExpr('min(1,2)') - 1) < 1e-9, 'min');
ok(Math.abs(evalExpr('clamp(5,0,1)') - 1) < 1e-9, 'clamp');
ok(Math.abs(evalExpr('-h/2', { h: 4 }) + 2) < 1e-9, 'unario -');
ok(Math.abs(evalExpr('PI') - Math.PI) < 1e-9, 'PI');
ok(evalExpr('sconosciuto', {}) === 0, 'id ignoto -> 0');
const v = evalVec3(['w', 'h/2', 0], { w: 2, h: 4 });
ok(v[0] === 2 && v[1] === 2 && v[2] === 0, 'evalVec3');

console.log('[2] primitive chiuse e non vuote');
const prims = [
  ['box', primBox(1, 1, 1)],
  ['sphere', primSphere(0.5, 12)],
  ['cyl', primCyl(0.5, 1, 12, 1, 'y')],
  ['caps', primCaps(0.2, 1, 12, 'y')],
  ['torus', primTorus(0.5, 0.15, 12)],
  ['stairs', primStairs(1, 1, 1, 4)],
];
for (const [name, m] of prims) {
  ok(!meshIsEmpty(m), name + ' non vuota');
  ok(meshTriCount(m) > 0, name + ' ha triangoli');
  ok(meshArea(m) > 0, name + ' area > 0');
  const b = meshBounds(m);
  ok(b.size.every(s => isFinite(s) && s >= 0), name + ' bounds finiti');
}
ok(meshIsClosed(primBox(1, 1, 1)), 'box chiuso');
ok(meshIsClosed(primSphere(0.5, 16)), 'sphere chiusa');

console.log('[3] CSG sub');
const a = primBox(2, 2, 2);
const b = primBox(1, 1, 1);
const sub = csgApply(a, b, 'sub');
ok(sub.ok, 'sub ok');
ok(!meshIsEmpty(sub.mesh), 'sub non vuota');
ok(meshVolume(sub.mesh) < meshVolume(a), 'sub riduce volume');

console.log('[4] buildSpec cassa');
const cassa = {
  id: 'cassa', cat: 'prop', style: 'lowpoly', detail: 2,
  size: [0.9, 0.7, 0.6], ground: true,
  params: { w: 0.9, h: 0.62, d: 0.6, t: 0.05, lid: 0.08 },
  mats: { legno: { col: '#6B4A2F' }, ferro: { col: '#555' } },
  nodes: [
    { n: 'corpo', p: 'box', s: ['w', 'h', 'd'], at: [0, 'h/2', 0], mat: 'legno' },
    { n: 'cavo', p: 'box', s: ['w-2*t', 'h-t', 'd-2*t'], at: [0, 'h/2+t', 0], op: 'sub', of: 'corpo' },
    { n: 'fascia', p: 'box', s: ['w', 't', 'd'], at: [0, 'h*0.25', 0], mat: 'ferro',
      arr: { n: 2, step: [0, 'h*0.5', 0] } },
    { n: 'coperchio', p: 'box', s: ['w', 'lid', 'd'], at: [0, 'h+lid/2', 0], mat: 'legno' },
  ],
  flags: ['hollow'],
};
const built = buildSpec(cassa);
ok(built.parts.length >= 2, 'almeno 2 parti visibili (utensile escluso)');
ok(!meshIsEmpty(built.merged), 'merged non vuota');
ok(Math.abs(built.bounds.min[1]) < 0.05, 'appoggiata a y≈0 (minY=' + built.bounds.min[1] + ')');
ok(built.bounds.size[0] > 0.5 && built.bounds.size[1] > 0.5, 'ingombro plausibile');

console.log('[5] validatori');
const defects = validateAll(cassa, built);
ok(Array.isArray(defects), 'defects e\' array');
// asset sano: niente high critici di empty/nan
ok(!defects.some(d => d.code === 'emptyMesh' || d.code === 'nanVerts'), 'niente empty/nan');

// asset rotto: un solo braccio
const mono = {
  id: 'mono', cat: 'char', style: 'lowpoly', detail: 1, ground: true,
  size: [0.6, 1.7, 0.4],
  params: {},
  nodes: [
    { n: 'torso', p: 'box', s: [0.4, 0.6, 0.25], at: [0, 1.1, 0] },
    { n: 'head', p: 'sphere', r: 0.12, at: [0, 1.55, 0] },
    { n: 'braccio_R', p: 'caps', r: 0.05, len: 0.5, at: [0.3, 1.5, 0] }, // troppo in alto, uno solo
    { n: 'gamba_L', p: 'caps', r: 0.06, len: 0.7, at: [-0.1, 0.4, 0] },
    { n: 'gamba_R', p: 'caps', r: 0.06, len: 0.7, at: [0.1, 0.4, 0] },
  ],
  flags: ['arms_down', 'symmetric_x'],
};
const bMono = buildSpec(mono);
const dMono = validateAll(mono, bMono);
ok(dMono.some(d => d.code === 'missingLimb' || d.code === 'asymmetric' || d.code === 'armsNotDown'),
  'prende difetti umanoide monobraccio (got: ' + dMono.map(d => d.code).join(',') + ')');

console.log('[6] metrics e autoRepair');
const m = metricsOf(cassa, built);
ok(m.nodes === 4 && m.tris > 0, 'metrics');
const floating = JSON.parse(JSON.stringify(cassa));
// forza un asset che galleggia: sposta tutto in alto via params
floating.params.h = 0.62;
const bF = buildSpec(floating);
// simula minY alto
bF.bounds.min[1] = 0.5;
const ar = autoRepair(floating, bF);
ok(ar.repairs.some(r => r.startsWith('groundShift')), 'autoRepair ground');

console.log('[7] DETAIL_LEVELS allineato');
ok(DETAIL_LEVELS.length === 4, '4 livelli');
ok(DETAIL_LEVELS[2].seg === 20 && DETAIL_LEVELS[2].nodes === 80, 'detail 2 = 20/80');

console.log();
console.log('PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
