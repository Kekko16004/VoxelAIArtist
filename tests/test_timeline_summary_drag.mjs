/*
 * AFFERRARE LA RIGA SUMMARY PER SPOSTARE I KEYFRAME.
 *
 * Ctrl+A evidenziava i keyframe ma non permetteva di spostarli, ed era proprio
 * la lamentela: "ctrl+a non mi seleziona tutti i keyframe permettendomi di
 * spostarli". La causa non stava in Ctrl+A: stava in tlOnRowsPointerDown.
 *
 * I diamanti della riga Summary hanno dataset.bone VUOTO (tlAppendRow li crea con
 * `boneName || ''`, e la riga di riepilogo non ha un osso). La guardia del ramo
 * "trascina un keyframe" pretendeva `&& el.dataset.bone`, quindi il Summary
 * cadeva nel ramo finale - "clic nel vuoto" - che azzera la selezione e fa
 * scrubbing. Ed e' la riga che si afferra per prima per muovere tutto.
 *
 * Qui il vero handler viene ESTRATTO dal sorgente ed ESEGUITO su un DOM finto,
 * e le asserzioni guardano cosa succede alla selezione e alle POSIZIONI delle
 * chiavi - non se una certa stringa compare nel file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m, extra) => {
    if (c) { pass++; console.log('  OK  ' + m); }
    else { fail++; console.log('  FAIL ' + m + (extra === undefined ? '' : '   ' + extra)); }
};

const tlSrc = fs.readFileSync(path.join(ROOT, 'ui/src/lib/33-timeline.js'), 'utf8');

const FN = ['tlKeyTimesByBone', 'tlKeysAtTime', 'tlOnRowsPointerDown', 'tlApplyKeyDelta'];
const at = {};
FN.forEach(n => { at[n] = tlSrc.indexOf('function ' + n + '('); });
const mancanti = FN.filter(n => at[n] < 0);
if (mancanti.length) {
    console.log('FAIL: non trovate in 33-timeline.js: ' + mancanti.join(', '));
    process.exit(1);
}
const endOf = (src, from) => {
    // Fine della funzione: prima riga che chiude a rientro 12 (stile del progetto).
    const close = src.indexOf('\n            }', from);
    return close < 0 ? src.length : close + '\n            }'.length;
};

// Il finto contorno: 24 fps, 10 px per frame, e i soli appigli che le funzioni
// estratte usano davvero.
const harness = `
    const FPS = 24;
    let tlSelected = [];
    let tlKeyDrag = null;
    let ACTIVE_ANIM = null;
    let redraws = 0, scrubs = 0, frameSet = null;
    function tlActiveAnim() { return ACTIVE_ANIM; }
    function tlRedraw() { redraws++; }
    function tlBeginScrub() { scrubs++; }
    function tlSetFrame(f) { frameSet = f; }
    function tlLocalX(ev) { return ev.clientX; }
    function tlFrameOfX(x) { return Math.round(x / 10); }
    function tlFrameOfTime(t) { return t * FPS; }
    function tlTimeOfFrame(f) { return f / FPS; }
    function tlFrameCount() {
        return Math.max(1, Math.round((Number(ACTIVE_ANIM && ACTIVE_ANIM.duration) || 1) * FPS));
    }
    function tlIsSelectedKey(bone, t) {
        return tlSelected.some(s => s.bone === bone && Math.abs(s.t - t) < 1e-6);
    }
`;

const api = new Function(harness
    + FN.map(n => tlSrc.slice(at[n], endOf(tlSrc, at[n]))).join('\n')
    + `
    return {
        down: tlOnRowsPointerDown,
        keysAt: tlKeysAtTime,
        applyDelta: d => tlApplyKeyDelta(ACTIVE_ANIM, d),
        setAnim: a => { ACTIVE_ANIM = a; },
        sel: () => tlSelected,
        setSel: s => { tlSelected = s; },
        drag: () => tlKeyDrag,
        clearDrag: () => { tlKeyDrag = null; },
        stats: () => ({ redraws, scrubs, frameSet })
    };`)();

// --- il finto DOM ----------------------------------------------------------
function diamante(classi, t, bone) {
    return {
        classList: { contains: c => classi.indexOf(c) >= 0 },
        dataset: { t: String(t), bone: bone === undefined ? '' : bone }
    };
}
const somma = (t, ro) => diamante(ro ? ['tl-key', 'tl-key-sum', 'tl-key-ro'] : ['tl-key', 'tl-key-sum'], t);
const osso = (t, bone) => diamante(['tl-key'], t, bone);

let prevented = 0;
function evento(el, mods) {
    const m = mods || {};
    return {
        target: el,
        clientX: 0,
        shiftKey: !!m.shift, ctrlKey: !!m.ctrl, metaKey: !!m.meta,
        preventDefault: () => { prevented++; }
    };
}

// Colonne di dimensione DIVERSA (2 / 1 / 3): un bug che prende solo la prima
// traccia, o sempre lo stesso numero di chiavi, passerebbe con colonne uguali.
const nuovaAnim = () => ({
    name: 'test', duration: 1, fps: 24,
    tracks: [
        { bone: 'hips',       keys: [{ t: 0 }, { t: 0.25 }, { t: 0.5 }] },
        { bone: 'upperArm_R', keys: [{ t: 0 }, { t: 0.5 }] },
        { bone: 'upperArm_L', keys: [{ t: 0.5 }] }
    ]
});
const TUTTE = [
    { bone: 'hips', t: 0 }, { bone: 'hips', t: 0.25 }, { bone: 'hips', t: 0.5 },
    { bone: 'upperArm_R', t: 0 }, { bone: 'upperArm_R', t: 0.5 },
    { bone: 'upperArm_L', t: 0.5 }
];
const tempi = anim => anim.tracks.map(tr =>
    tr.bone + ':' + tr.keys.map(k => Math.round(k.t * 24)).join(',')).join(' | ');

console.log('[1] tlKeysAtTime: il diamante Summary vale TUTTA la colonna');
let anim = nuovaAnim();
api.setAnim(anim);
ok(api.keysAt(anim, 0).length === 2, 'a t=0 ci sono 2 chiavi', api.keysAt(anim, 0).length);
ok(api.keysAt(anim, 0.25).length === 1, 'a t=0.25 ce n\'e\' 1', api.keysAt(anim, 0.25).length);
ok(api.keysAt(anim, 0.5).length === 3, 'a t=0.5 ce ne sono 3', api.keysAt(anim, 0.5).length);
ok(api.keysAt(anim, 0.4).length === 0, 'dove non c\'e\' nulla, nessuna chiave');

console.log('[2] Summary da solo: prende la colonna e arma il trascinamento');
api.setSel([]); api.clearDrag();
api.down(evento(somma(0.5)));
ok(api.sel().length === 3, 'seleziona le 3 chiavi di quell\'istante', api.sel().length);
ok(api.sel().every(s => Math.abs(s.t - 0.5) < 1e-6), 'tutte a t=0.5');
ok(api.sel().some(s => s.bone === 'upperArm_L'),
   'anche l\'osso che ha una chiave SOLO li\' (non solo la prima traccia)');
// Il difetto originale: il Summary finiva nel ramo "clic nel vuoto", che lascia
// tlKeyDrag a null. Senza tlKeyDrag, tlOnPointerMove non sposta niente.
ok(api.drag() !== null, 'tlKeyDrag e\' armato: il gesto puo\' spostare');
ok(api.drag() !== null && api.drag().orig.length === 3,
   'orig contiene le 3 chiavi da spostare', api.drag() && api.drag().orig.length);
ok(api.stats().scrubs === 0, 'e NON fa scrubbing', api.stats().scrubs);

console.log('[3] dopo Ctrl+A, afferrare il Summary conserva TUTTA la selezione');
api.setAnim(nuovaAnim());
api.setSel(TUTTE.map(s => ({ bone: s.bone, t: s.t })));
api.clearDrag();
api.down(evento(somma(0.5)));
ok(api.sel().length === 6,
   'le 6 chiavi restano selezionate, non si riduce alla colonna', api.sel().length);
ok(api.drag() && api.drag().orig.length === 6,
   'e il trascinamento le porta tutte', api.drag() && api.drag().orig.length);

console.log('[4] e il trascinamento le sposta davvero, tutte insieme');
anim = nuovaAnim();
api.setAnim(anim);
api.setSel(TUTTE.map(s => ({ bone: s.bone, t: s.t })));
api.clearDrag();
api.down(evento(somma(0.5)));
const prima = tempi(anim);
// Senza trascinamento armato non c'e' niente da applicare: si registra il
// fallimento invece di far esplodere il test a meta' rapporto.
if (api.drag()) api.applyDelta(2);                  // +2 frame
const dopo = tempi(anim);
ok(dopo === 'hips:2,8,14 | upperArm_R:2,14 | upperArm_L:14',
   'ogni chiave e\' avanzata di 2 frame', dopo);
ok(prima !== dopo, 'e qualcosa si e\' mosso davvero');
ok(anim.tracks.reduce((n, tr) => n + tr.keys.length, 0) === 6,
   'nessuna chiave persa per strada',
   anim.tracks.reduce((n, tr) => n + tr.keys.length, 0));

console.log('[5] col tasto Shift il Summary aggiunge e toglie la colonna');
api.setAnim(nuovaAnim());
api.setSel([{ bone: 'hips', t: 0 }, { bone: 'upperArm_R', t: 0 }]);
api.clearDrag();
api.down(evento(somma(0.5), { shift: true }));
ok(api.sel().length === 5, 'la colonna si aggiunge alla selezione esistente', api.sel().length);
api.down(evento(somma(0.5), { shift: true }));
ok(api.sel().length === 2, 'ripremendo con Shift la stessa colonna si toglie', api.sel().length);
ok(api.sel().every(s => Math.abs(s.t) < 1e-6), 'restano solo le chiavi di t=0');

console.log('[6] i casi in cui il Summary NON deve rubare il gesto');
// Clip preimpostata (sola lettura): i diamanti hanno tl-key-ro e non si toccano.
api.setAnim(nuovaAnim());
api.setSel(TUTTE.map(s => ({ bone: s.bone, t: s.t })));
api.clearDrag();
const scrub0 = api.stats().scrubs;
api.down(evento(somma(0.5, true)));
ok(api.drag() === null, 'in sola lettura non arma nessun trascinamento');
ok(api.stats().scrubs === scrub0 + 1, 'e torna al comportamento "clic nel vuoto": scrubbing');
ok(api.sel().length === 0, 'che deseleziona, come prima');

// Un istante senza chiavi non puo' produrre un trascinamento vuoto.
api.setAnim(nuovaAnim());
api.setSel([{ bone: 'hips', t: 0 }]);
api.clearDrag();
const scrub1 = api.stats().scrubs;
api.down(evento(somma(0.4)));
ok(api.drag() === null && api.stats().scrubs === scrub1 + 1,
   'un diamante senza chiavi sotto non arma niente e scrubba');

console.log('[7] le righe d\'osso continuano a funzionare come prima');
api.setAnim(nuovaAnim());
api.setSel([]);
api.clearDrag();
api.down(evento(osso(0.5, 'upperArm_L')));
ok(api.sel().length === 1 && api.sel()[0].bone === 'upperArm_L',
   'un clic su una chiave d\'osso seleziona solo quella', JSON.stringify(api.sel()));
ok(api.drag() !== null, 'e arma il trascinamento');
// Una chiave gia' dentro una selezione multipla non la azzera: e' cosi' che si
// sposta il blocco afferrandolo da una riga d'osso.
api.setSel(TUTTE.map(s => ({ bone: s.bone, t: s.t })));
api.clearDrag();
api.down(evento(osso(0.25, 'hips')));
ok(api.sel().length === 6, 'afferrare una chiave gia\' selezionata conserva il blocco', api.sel().length);

ok(prevented > 0, 'i gesti riconosciuti chiamano preventDefault');

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
