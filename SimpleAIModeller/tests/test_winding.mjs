/**
 * Il VERSO DELLE FACCE (winding) di ogni primitiva.
 *
 * Perche' questo test esiste: dodici delle ventiquattro primitive nascevano
 * con i triangoli in ordine orario, cioe' con le normali rivolte DENTRO. Tutte
 * con zero spigoli di bordo — gusci perfettamente chiusi, solo rovesciati —
 * quindi nessun controllo di tenuta li vedeva. E la suite non poteva vederli
 * per costruzione: ogni asserzione sul volume era avvolta in `Math.abs()`, e
 * `metricsOf` fa lo stesso. Il segno del volume ERA l'informazione.
 *
 * Cosa rompeva, misurato:
 *   - anteprima ed export usano `THREE.FrontSide`, quindi un guscio rovesciato
 *     e' trasparente: si guarda DENTRO l'oggetto. E' il "materiale che si vede
 *     solo da un lato" e il coperchio della cassa che sembra cavo.
 *   - il contorno toon e' un guscio invertito (`BackSide`, scala 1.03): su
 *     geometria rovesciata disegna le facce VICINE e copre il pezzo di nero.
 *   - la CSG deduce il dentro/fuori dalla normale, quindi un utensile
 *     rovesciato inverte la sottrazione: la piastra della serratura della demo
 *     era il TAPPO del buco, non la piastra bucata.
 *
 * Se questo test fallisce, NON aggirarlo con `DoubleSide`: le normali
 * continuerebbero a puntare dentro (illuminazione sbagliata) e l'export
 * resterebbe rovesciato per Blender e Unity.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB = path.join(ROOT, 'ui', 'src', 'lib');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const files = [
  '01-expr.js', '02-mesh.js', '03-primitives.js', '03b-deform.js',
  '04-csg.js', '05-build.js', '06-validators.js',
];
const code = files.map(f => fs.readFileSync(path.join(LIB, f), 'utf8')).join('\n')
  + '\n;this.__SAM = { meshCreate, meshVolume, meshBoundaryEdges, meshIsClosed,'
  + ' meshEnsureOutward, meshReverse, meshMirror, meshTriCount,'
  + ' primBuild, primBuildRaw, primBox, buildSpec, csgApply, meshBounds };';
const sandbox = { console, Math, JSON, Float32Array, Uint32Array, Uint8Array, Map, Set, Object, Array };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const S = sandbox.__SAM;

// Ogni voce e' un nodo della spec. Si coprono anche le varianti che cambiano
// il codice di costruzione: un settore di cilindro e un arco di toro emettono
// pareti radiali e tappi a ventaglio che il caso intero non ha.
const CATALOGO = [
  ['box', { p: 'box', s: [1, 1, 1] }],
  ['box con bevel (roundbox)', { p: 'box', s: [1, 1, 1], bevel: 0.1 }],
  ['sphere', { p: 'sphere', r: 0.5 }],
  ['cyl', { p: 'cyl', r: 0.5, len: 1 }],
  ['cyl settore arc=180', { p: 'cyl', r: 0.5, len: 1, arc: 180, axis: 'x' }],
  ['cyl rastremato', { p: 'cyl', r: 0.5, len: 1, taper: 0.3 }],
  ['caps', { p: 'caps', r: 0.3, len: 1 }],
  ['torus', { p: 'torus', r: 0.5, r2: 0.15 }],
  ['torus arco', { p: 'torus', r: 0.5, r2: 0.15, arc: 182 }],
  ['wedge', { p: 'wedge', s: [1, 1, 1] }],
  ['pyr', { p: 'pyr', s: [1, 1, 1] }],
  ['tube', { p: 'tube', r: 0.5, len: 1, wall: 0.1 }],
  ['tube su percorso', { p: 'tube', r: 0.06, path: [[0, 0, 0], [0.2, 0.4, 0], [0, 0.8, 0]] }],
  ['extr rect', { p: 'extr', prof: 'rect', len: 1, s: [1, 1, 1] }],
  ['extr hex', { p: 'extr', prof: 'hex', len: 1, s: [1, 1, 1] }],
  ['extr con bevel', { p: 'extr', prof: 'rect', len: 1, s: [1, 1, 1], bevel: 0.06 }],
  ['lathe silhouette nota', { p: 'lathe', prof: 'vase', r: 0.4, len: 1 }],
  ['lathe con parete', { p: 'lathe', prof: 'vase', r: 0.4, len: 1, wall: 0.03 }],
  ['lathe punti espliciti', { p: 'lathe', prof: [[0, 0], [0.4, 0.1], [0.3, 0.9], [0, 1]] }],
  ['loft ellipse', { p: 'loft', shape: 'ellipse', secs: [{ at: 0, s: [0.4, 0.4] }, { at: 1, s: [0.2, 0.2] }] }],
  ['loft lens (la LAMA)', { p: 'loft', shape: 'lens', secs: [{ at: 0, s: [0.4, 0.05] }, { at: 1, s: [0.2, 0.03] }] }],
  ['loft rect', { p: 'loft', shape: 'rect', secs: [{ at: 0, s: [0.4, 0.4] }, { at: 1, s: [0.2, 0.2] }] }],
  ['loft hex', { p: 'loft', shape: 'hex', secs: [{ at: 0, s: [0.4, 0.4] }, { at: 1, s: [0.2, 0.2] }] }],
  ['loft tri', { p: 'loft', shape: 'tri', secs: [{ at: 0, s: [0.4, 0.4] }, { at: 1, s: [0.2, 0.2] }] }],
  ['stairs', { p: 'stairs', s: [1, 1, 1], steps: 4 }],
  ['field', { p: 'field', s: [1, 1, 1], amp: 0.1, freq: 3 }],
  ['arch', { p: 'arch', s: [1, 1, 1], r: 0.4, wall: 0.1 }],
];

console.log('[1] ogni primitiva CHIUSA ha le normali verso l\'esterno');
let chiuse = 0;
for (const [nome, node] of CATALOGO) {
  const m = S.primBuild(node, 20, 2);
  const bnd = S.meshBoundaryEdges(m);
  const vol = S.meshVolume(m);
  if (bnd !== 0) {
    // Un guscio aperto e' un difetto a se': lo si dichiara, non lo si mescola
    // col verso delle facce, dove il volume firmato non significa nulla.
    console.log('  --  ' + nome + ' e\' APERTA (bordo ' + bnd + '), verso non giudicabile');
    continue;
  }
  chiuse++;
  ok(vol > 0, nome + ' volume ' + vol.toFixed(6) + ' > 0');
}
ok(chiuse >= 25, 'almeno 25 primitive chiuse coperte (sono ' + chiuse + ')');

console.log('[2] meshEnsureOutward non tocca i gusci APERTI');
// L'elica non ha i tappi: il volume firmato non ha significato geometrico e
// ribaltarla peggiorerebbe invece di correggere.
const elica = S.primBuild({ p: 'helix', r: 0.4, r2: 0.05, len: 1, turns: 4 }, 16, 2);
ok(S.meshBoundaryEdges(elica) > 0, 'l\'elica e\' aperta (bordo ' + S.meshBoundaryEdges(elica) + ')');
const apertaPrima = Array.from(elica.idx.slice(0, 9));
S.meshEnsureOutward(elica);
ok(apertaPrima.join(',') === Array.from(elica.idx.slice(0, 9)).join(','),
   'gli indici di una mesh aperta restano invariati');

console.log('[3] meshEnsureOutward e\' idempotente e sa ribaltare');
const cubo = S.primBox(1, 1, 1);
const v0 = S.meshVolume(cubo);
S.meshEnsureOutward(cubo);
ok(Math.abs(S.meshVolume(cubo) - v0) < 1e-12, 'una mesh gia\' giusta non si muove');
S.meshReverse(cubo);
ok(S.meshVolume(cubo) < 0, 'meshReverse inverte il segno');
S.meshEnsureOutward(cubo);
ok(Math.abs(S.meshVolume(cubo) - v0) < 1e-12, 'e meshEnsureOutward lo raddrizza');

console.log('[4] meshMirror continua a invertire il verso (specchiare cambia la mano)');
const dx = S.primBox(1, 1, 1);
const volDx = S.meshVolume(dx);
S.meshMirror(dx, 'x');
ok(S.meshVolume(dx) > 0, 'la copia specchiata ha ancora le normali fuori');
ok(Math.abs(S.meshVolume(dx) - volDx) < 1e-12, 'e lo stesso volume');

console.log('[5] la booleana sottrae il BUCO, non restituisce il TAPPO');
// La CSG deduce il dentro/fuori dalla normale della faccia. Con un utensile
// rovesciato, "sottrai il cilindro" diventa "tieni solo il cilindro": e' il
// difetto della piastra della serratura nella demo della cassa.
const piastra = S.buildSpec({
  id: 'serratura', detail: 2, ground: false, params: {},
  nodes: [
    { n: 'piastra', p: 'box', s: [0.06, 0.08, 0.008] },
    { n: 'buco', p: 'cyl', axis: 'z', r: 0.009, len: 0.03, op: 'sub', of: 'piastra' },
  ],
});
const volPiastra = S.meshVolume(piastra.parts[0]);
const volPiena = 0.06 * 0.08 * 0.008;               // 3.84e-5
const volTappo = Math.PI * 0.009 * 0.009 * 0.008;   // 2.04e-6
ok(volPiastra > volPiena * 0.5,
   'la piastra bucata conserva la maggior parte del volume (' + volPiastra.toExponential(3) + ')');
ok(volPiastra > volTappo * 3,
   'e NON e\' il tappo del buco (tappo ~' + volTappo.toExponential(3) + ')');

console.log('[6] il coperchio a settore della cassa e\' un solido, non un guscio da guardare dentro');
const coperchio = S.primBuild({ p: 'cyl', axis: 'x', arc: 180, r: 0.28, len: 0.9, sides: 28 }, 28, 2);
ok(S.meshBoundaryEdges(coperchio) === 0, 'il settore e\' stagno');
ok(S.meshVolume(coperchio) > 0, 'e rivolto verso l\'esterno');

console.log();
console.log('PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
