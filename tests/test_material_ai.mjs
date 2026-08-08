#!/usr/bin/env node
/**
 * Quali facce si generano, e dove finisce cio' che l'AI risponde.
 *
 * Sono le due decisioni della generazione AI delle texture in cui un errore e'
 * INVISIBILE: si vede solo come "mi ha rifatto una faccia che non gli avevo
 * chiesto" o "ha cancellato il disegno" molti clic dopo. Il resto del pannello
 * (clic, tela, undo) si prova in GUI vera, come dice CLAUDE.md: qui stanno solo
 * le due funzioni pure.
 *
 * Il modulo e' un frammento di UNA closure condivisa (niente import/export): si
 * carica come corpo di funzione, come fa tests/test_materials.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
function check(msg, cond, detail) {
    if (cond) console.log('  ok   - ' + msg);
    else { console.log('  FAIL - ' + msg + (detail ? ': ' + detail : '')); fails++; }
}

const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/36-materials.js'), 'latin1');
const API = new Function('currentModelData', 'THREE', 'document', 'Image', 'URL', src + `
    ;return { materialAiTargets, materialAiPlan, MATERIAL_FACE_KEYS };
`)({ metadata: {}, voxels: [] });

const FACES = API.MATERIAL_FACE_KEYS;
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const targets = (mode, scope, pick, active) => API.materialAiTargets(mode, scope, pick, active);

console.log('test_material_ai');

// --- quali facce generare ----------------------------------------------------
// Con una texture unica non c'e' un ambito da scegliere: la faccia e' `all`, la
// stessa chiave che il server e l'espansore usano per quel caso.
check('texture unica -> `all`', same(targets('single', 'all', FACES, 'px'), ['all']),
      JSON.stringify(targets('single', 'all', FACES, 'px')));

check('ambito "questa" -> solo la faccia attiva',
      same(targets('six', 'active', ['py', 'nz'], 'nx'), ['nx']));
check('ambito "tutte" -> le sei facce',
      same(targets('six', 'all', [], 'px'), FACES.slice()));
check('ambito "scegli" -> le facce spuntate',
      same(targets('six', 'choose', ['py', 'nz'], 'px'), ['py', 'nz']));

// Nessuna spunta non e' un'intenzione: si genera quella che si sta guardando,
// invece di non fare niente e far rileggere un errore.
check('"scegli" senza spunte -> la faccia attiva',
      same(targets('six', 'choose', [], 'pz'), ['pz']));
check('"scegli" con sigle inventate -> la faccia attiva',
      same(targets('six', 'choose', ['sopra', 'x', ''], 'ny'), ['ny']));
check('"scegli" tiene solo le sigle valide',
      same(targets('six', 'choose', ['px', 'boh', 'ny'], 'pz'), ['px', 'ny']));

// L'ambito non deve poter restituire una lista vuota: chi chiama ci costruisce
// sopra il piano, e una lista vuota diventerebbe "l'AI non ha disegnato niente".
for (const scope of ['active', 'all', 'choose', undefined, 'boh']) {
    check('ambito "' + scope + '" non da\' mai una lista vuota',
          targets('six', scope, [], 'px').length > 0);
}

// --- dove finisce la risposta ------------------------------------------------
const out = (painted, w) => {
    const side = w || 8;
    const faces = {};
    Object.keys(painted).forEach(k => { faces[k] = new Uint8ClampedArray(side * side * 4); });
    return { w: side, h: side, faces: faces, painted: painted, warnings: [] };
};
const plan = (o, t, active) => API.materialAiPlan(o, t, active || 'px');
const flat = p => p.map(x => x[0] + '<-' + x[1]).join(' ');

check('faccia chiesta e disegnata: si applica a se stessa',
      same(flat(plan(out({ px: 12, nx: 9 }), ['px', 'nx'])).split(' '),
           ['px<-px', 'nx<-nx']), flat(plan(out({ px: 12, nx: 9 }), ['px', 'nx'])));

// Il caso piu' frequente: si chiedono sei facce e l'AI ne manda una sola.
// Scartarla lascerebbe la tela intatta senza dire perche'.
check('`all` si apre su tutte le facce chieste',
      plan(out({ all: 40 }), FACES.slice()).length === 6
      && plan(out({ all: 40 }), FACES.slice()).every(p => p[1] === 'all'));
check('`all` in texture unica va sulla tela',
      same(flat(plan(out({ all: 40 }), ['all'])).split(' '), ['all<-all']));
// Risposta con una sigla di faccia su una richiesta a texture unica: la tela e'
// una sola, quindi quel disegno e' LA texture.
check('faccia singola in texture unica va sulla tela',
      same(flat(plan(out({ pz: 40 }), ['all'])).split(' '), ['all<-pz']),
      flat(plan(out({ pz: 40 }), ['all'])));

// painted a 0: la faccia e' stata nominata e non disegnata. Riversarla
// cancellerebbe il disegno che c'era, che e' peggio del non aver generato.
check('faccia nominata e non disegnata: scartata',
      same(flat(plan(out({ px: 0, nx: 7 }), ['px', 'nx'])).split(' '), ['nx<-nx']),
      flat(plan(out({ px: 0, nx: 7 }), ['px', 'nx'])));
check('`all` vuoto non azzera le facce chieste',
      plan(out({ all: 0 }), FACES.slice()).length === 0);
check('niente di disegnato -> piano vuoto (il chiamante avvisa)',
      plan(out({}), ['px']).length === 0);

// L'ambito che l'utente ha scelto e' un LIMITE, non un suggerimento: applicare
// una faccia in piu' sovrascriverebbe un disegno che non si voleva rifare.
check('faccia in piu\' nella risposta: NON si applica',
      same(flat(plan(out({ px: 5, py: 5 }), ['px'])).split(' '), ['px<-px']),
      flat(plan(out({ px: 5, py: 5 }), ['px'])));
check('faccia chiesta assente dalla risposta: si ripiega su `all`',
      same(flat(plan(out({ all: 5, px: 9 }), ['px', 'ny'])).split(' '),
           ['px<-px', 'ny<-all']), flat(plan(out({ all: 5, px: 9 }), ['px', 'ny'])));

// Ingressi degeneri: nessuna eccezione, piano vuoto.
for (const [label, o] of Object.entries({
    'null': null, 'senza faces': { w: 8, h: 8, painted: {} },
    'senza painted': { w: 8, h: 8, faces: { px: null } },
    'stringa': 'boh',
})) {
    let threw = false, p = null;
    try { p = plan(o, ['px']); } catch (e) { threw = true; }
    check('risposta degenere non solleva: ' + label, !threw && Array.isArray(p));
}

if (fails) { console.log('\n' + fails + ' CHECK FALLITI'); process.exit(1); }
console.log('\nTUTTI I CHECK OK');
