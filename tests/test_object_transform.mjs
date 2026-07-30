/*
 * bakeTransform() (ui/src/lib/04-objects.js) deve cuocere nei voxel ESATTAMENTE
 * la trasformazione che l'anteprima mostra.
 *
 * L'anteprima e' un Object3D di THREE: modelPivot.rotation.y (oggetto attivo,
 * 01-scene-setup.js) e Group.rotation.y (oggetti inattivi, renderInactiveObjects).
 * Quindi la matrice di riferimento e' Ry(+a) di THREE:
 *     x' =  x*cos(a) + z*sin(a)
 *     z' = -x*sin(a) + z*cos(a)
 * Il bake usava i segni opposti: in Proprieta' scrivevi "Rotazione Y: 90",
 * l'anteprima girava in un verso e al commit l'oggetto girava nell'altro.
 *
 * Qui la rotazione di riferimento e' calcolata a mano (non da THREE) proprio
 * per non dipendere dal CDN: e' la stessa formula, scritta una volta sola.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// 04-objects.js e' un frammento di uno scope condiviso: si carica con new Function
// e stub minimi, come tests/test_rig_rotate.mjs.
global.t = (k) => k;
global.sceneObjects = [];
global.activeObjectId = null;
global.nextObjectId = 1;
global.document = { getElementById: () => null, querySelector: () => null, createElement: () => ({ style: {}, dataset: {}, classList: { add() { }, remove() { } }, appendChild() { }, addEventListener() { } }) };
global.window = { addEventListener() { } };
global.THREE = { Group: class { constructor() { this.position = { set() { } }; this.rotation = { set() { } }; this.scale = { set() { } }; } add() { } } };
global.scene = { add() { }, remove() { } };

const src = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/04-objects.js'), 'latin1');
const api = new Function(src + ';return {bakeTransform, voxelsCenter, makeDefaultTransform};')();

const D2R = Math.PI / 180;

// Rotazione di riferimento: la Ry(+a) di THREE, attorno al centro c, poi la
// stessa scala/traslazione/arrotondamento del bake.
function expected(voxels, c, deg, scale, pos) {
    const a = deg * D2R;
    const cos = Math.round(Math.cos(a)), sin = Math.round(Math.sin(a));
    return voxels.map(v => {
        const dx = (v.x - c.x) * scale, dz = (v.z - c.z) * scale;
        return {
            x: Math.round(c.x + (dx * cos + dz * sin) + pos.x),
            y: Math.round(c.y + (v.y - c.y) * scale + pos.y),
            z: Math.round(c.z + (-dx * sin + dz * cos) + pos.z),
        };
    });
}

// Modello asimmetrico su X e Z: un verso sbagliato si vede subito.
const mkVoxels = () => [
    { x: 0, y: 0, z: 0, color: '#111111' },
    { x: 5, y: 0, z: 0, color: '#222222' },
    { x: 0, y: 0, z: 2, color: '#333333' },
    { x: 5, y: 1, z: 2, color: '#444444', part: 'estremita' },
];
const mkObj = (t) => ({ data: { metadata: {}, voxels: mkVoxels() }, transform: t });
const key = v => v.x + ',' + v.y + ',' + v.z;

// --- 1. il bake coincide con Ry(+a) di THREE, per tutti i quattro passi -------
[0, 90, 180, 270, -90, 360].forEach(deg => {
    const pos = { x: 0, y: 0, z: 0 };
    const obj = mkObj({ position: pos, rotationY: deg * D2R, scale: 1 });
    const c = api.voxelsCenter(mkVoxels());
    api.bakeTransform(obj);
    const exp = expected(mkVoxels(), c, deg, 1, pos);
    const got = obj.data.voxels;
    const same = got.length === exp.length && got.every((v, i) => key(v) === key(exp[i]));
    ok(same, deg + ' gradi: il bake e\' Ry(+a) di THREE  ' +
        got.map(key).join(' | ') + (same ? '' : '   atteso: ' + exp.map(key).join(' | ')));
});

// --- 2. il verso: a +90 il braccio su +Z finisce su +X ------------------------
// E' la meta' visibile del bug: con i vecchi segni finiva su -X.
{
    const obj = { data: { metadata: {}, voxels: [{ x: 0, y: 0, z: 0, color: '#f00' }, { x: 0, y: 0, z: 4, color: '#0f0' }] },
                  transform: { position: { x: 0, y: 0, z: 0 }, rotationY: 90 * D2R, scale: 1 } };
    api.bakeTransform(obj);
    const arm = obj.data.voxels[1], root = obj.data.voxels[0];
    ok(arm.x > root.x && arm.z === root.z,
        '+90: il braccio verso +Z passa su +X (' + key(root) + ' -> ' + key(arm) + ')');
}

// --- 3. posizione, scala e campi extra ---------------------------------------
{
    const pos = { x: 3, y: -1, z: 7 };
    const obj = mkObj({ position: pos, rotationY: 90 * D2R, scale: 2 });
    const c = api.voxelsCenter(mkVoxels());
    api.bakeTransform(obj);
    const exp = expected(mkVoxels(), c, 90, 2, pos);
    ok(obj.data.voxels.every((v, i) => key(v) === key(exp[i])),
        'rotazione + scala 2 + offset: identici al riferimento');
    ok(obj.data.voxels[3].part === 'estremita' && obj.data.voxels[1].color === '#222222',
        'colori e campi extra sopravvivono al bake');
    ok(obj.transform.rotationY === 0 && obj.transform.scale === 1 &&
        obj.transform.position.x === 0 && obj.transform.position.z === 0,
        'dopo il bake il transform torna a identita\'');
}

// --- 4. angoli non multipli di 90: snap al piu' vicino, mai coordinate rotte --
{
    [44, 46, 89, 91, 134].forEach(deg => {
        const obj = mkObj({ position: { x: 0, y: 0, z: 0 }, rotationY: deg * D2R, scale: 1 });
        api.bakeTransform(obj);
        const snapped = Math.round(deg / 90) * 90;
        const c = api.voxelsCenter(mkVoxels());
        const exp = expected(mkVoxels(), c, snapped, 1, { x: 0, y: 0, z: 0 });
        ok(obj.data.voxels.every((v, i) => key(v) === key(exp[i])) &&
            obj.data.voxels.every(v => Number.isInteger(v.x) && Number.isInteger(v.z)),
            deg + ' gradi -> snap a ' + snapped + ', coordinate intere');
    });
}

// --- 5. quattro bake da 90 gradi = identita' (con centro intero) --------------
// bakeTransform ruota attorno al centro del bounding box e arrotonda: se il
// centro cade a meta' voxel (lato pari) la griglia si sposta di mezza cella per
// giro -- e' il "LIMITE noto" scritto nel commento della funzione. Con lati
// dispari il centro e' intero e i quattro giri sono esatti.
{
    const odd = () => [
        { x: 0, y: 0, z: 0, color: '#111111' },
        { x: 4, y: 0, z: 0, color: '#222222' },
        { x: 0, y: 0, z: 4, color: '#333333' },
        { x: 4, y: 1, z: 2, color: '#444444' },
    ];
    const obj = { data: { metadata: {}, voxels: odd() }, transform: api.makeDefaultTransform() };
    const before = obj.data.voxels.map(key).join(' ');
    for (let i = 0; i < 4; i++) {
        obj.transform = { position: { x: 0, y: 0, z: 0 }, rotationY: 90 * D2R, scale: 1 };
        api.bakeTransform(obj);
    }
    ok(obj.data.voxels.map(key).join(' ') === before,
        'centro intero: 4 bake da 90 gradi riportano ai voxel di partenza');

    // Lato pari: si accetta la deriva di mezza cella, non la perdita di voxel.
    const even = { data: { metadata: {}, voxels: mkVoxels() }, transform: api.makeDefaultTransform() };
    for (let i = 0; i < 4; i++) {
        even.transform = { position: { x: 0, y: 0, z: 0 }, rotationY: 90 * D2R, scale: 1 };
        api.bakeTransform(even);
    }
    ok(new Set(even.data.voxels.map(key)).size === 4,
        'lato pari: i voxel restano 4 e distinti (nessuna fusione per arrotondamento)');
}

// --- 6. transform identita': nessun tocco ------------------------------------
{
    const obj = mkObj(api.makeDefaultTransform());
    const before = JSON.stringify(obj.data.voxels);
    api.bakeTransform(obj);
    ok(JSON.stringify(obj.data.voxels) === before, 'transform identita\': i voxel non si toccano');
}

console.log('');
console.log(fail ? 'TEST FALLITI  (pass=' + pass + ', fail=' + fail + ')'
    : 'TUTTI I TEST PASSATI  (pass=' + pass + ')');
process.exit(fail ? 1 : 0);
