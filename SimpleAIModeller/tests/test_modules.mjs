/**
 * GUARDIA DI SINTASSI su ogni modulo di ui/src/lib.
 *
 * Perche' esiste: i moduli sono frammenti di UNA sola closure, quindi un errore
 * di sintassi in uno qualsiasi rende la pagina DIPINTA E COMPLETAMENTE MORTA,
 * senza un messaggio visibile. I test di geometria caricano solo i moduli puri
 * (01-06): un backtick di troppo dentro il template GLSL di 07-materials.js e'
 * passato inosservato fino a una prova in GUI. Questa guardia controlla TUTTI i
 * moduli, il bundle concatenato e il blocco dentro index.html.
 *
 * Si controlla la concatenazione e non i file uno per uno: un `const` ripetuto
 * in due moduli e' legale in ognuno e un SyntaxError insieme, ed e' proprio il
 * modo in cui questi bundle muoiono.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'ui', 'src');
const LIB = path.join(SRC, 'lib');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

function checkSyntax(code, label) {
    try {
        // `new vm.Script` compila senza eseguire: e' esattamente cio' che serve
        // (eseguire richiederebbe document, THREE, fetch...).
        new vm.Script(code, { filename: label });
        return null;
    } catch (e) {
        return e.message + (e.lineNumber ? ' (riga ' + e.lineNumber + ')' : '');
    }
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

console.log('[1] ogni modulo del manifest esiste e non e\' vuoto');
const sources = [];
for (const rel of manifest) {
    const abs = path.join(SRC, rel);
    ok(fs.existsSync(abs), rel + ' esiste');
    const txt = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    ok(txt.length > 0, rel + ' non vuoto');
    sources.push({ rel, txt });
}

console.log('[2] sintassi di ogni modulo, isolato');
for (const { rel, txt } of sources) {
    // I frammenti aprono/chiudono la closure, quindi da soli non sono bilanciati:
    // si compila il modulo dentro una funzione per dargli un contesto valido.
    const wrapped = rel.indexOf('00-bootstrap') >= 0 || rel.indexOf('13-boot') >= 0
        ? null : '(async function(){\n' + txt + '\n})';
    if (!wrapped) continue;
    const err = checkSyntax(wrapped, rel);
    ok(!err, rel + (err ? ' -> ' + err : ''));
}

console.log('[3] sintassi del BUNDLE concatenato (const duplicati, closure)');
const bundle = sources.map(s => s.txt).join('\n');
const bundleErr = checkSyntax(bundle, 'bundle');
ok(!bundleErr, 'il bundle compila' + (bundleErr ? ' -> ' + bundleErr : ''));

console.log('[4] il blocco dentro index.html compila');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
ok(!!m, 'trovato il blocco module in index.html');
if (m) {
    const err = checkSyntax(m[1], 'index.html');
    ok(!err, 'index.html compila' + (err ? ' -> ' + err : ''));
    ok(m[1].indexOf('GENERATO da ui/build.mjs') >= 0,
       'index.html e\' generato dal build (header presente)');
}

console.log('[5] backtick sbilanciati nei template GLSL');
// Un backtick dentro un template literal lo CHIUDE: nei commenti dello shader
// e' l'errore piu' facile da fare, e ammazza la pagina senza dire dove.
for (const { rel, txt } of sources) {
    const count = (txt.match(/`/g) || []).length;
    ok(count % 2 === 0, rel + ': backtick pari (' + count + ')');
}

console.log();
console.log('PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
