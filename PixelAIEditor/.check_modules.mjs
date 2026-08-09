#!/usr/bin/env node
/*
 * Controlli sui frammenti di PixelAIEditor, PRIMA di montare il bundle.
 *
 * I moduli sono pezzi di UNA sola closure: un `const` dichiarato due volte non
 * e' un avviso ma un SyntaxError al caricamento, e con lo script in fondo alla
 * pagina il sintomo e' una pagina disegnata e completamente morta - nessun
 * messaggio, nessun bottone che risponde. Trovarlo qui costa un secondo,
 * trovarlo nel browser costa mezz'ora di bisezione.
 *
 * Uso: node .check_modules.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const SRC = path.join(UI, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

let bad = 0;
const decl = new Map();          // nome -> [moduli]
// `const X` / `let X` / `function X` in cima al modulo (4 spazi di rientro).
const RE = /^ {4}(?:async )?(?:function|const|let|var) +([A-Za-z_$][\w$]*)/gm;

const TMP = path.join(UI, '.check-tmp.js');
for (const rel of manifest) {
    const abs = path.join(SRC, rel);
    if (!fs.existsSync(abs)) { console.log('MANCA   ' + rel); bad++; continue; }
    const txt = fs.readFileSync(abs, 'utf8');
    if (!txt.trim()) { console.log('VUOTO   ' + rel); bad++; continue; }

    // 00 apre la closure e 24 la chiude: da soli sono sbilanciati di proposito,
    // quindi la sintassi si controlla solo sui moduli in mezzo. I due estremi
    // li verifica il `node --check` del bundle montato.
    const isEdge = /00-|24-/.test(rel);
    if (!isEdge) {
        fs.writeFileSync(TMP, '(function(){\n' + txt + '\n})();\n');
        try {
            execFileSync(process.execPath, ['--check', TMP], { stdio: 'pipe' });
        } catch (e) {
            console.log('SINTASSI ' + rel + '\n' + String(e.stderr || e).split('\n').slice(0, 4).join('\n'));
            bad++;
        }
    }

    for (const m of txt.matchAll(RE)) {
        if (!decl.has(m[1])) decl.set(m[1], []);
        decl.get(m[1]).push(rel);
    }

    const nonLatin1 = [...txt].find((c) => c.charCodeAt(0) > 0xff);
    if (nonLatin1) {
        console.log('NON-LATIN1 ' + rel + ': ' + JSON.stringify(nonLatin1));
        bad++;
    }
}
if (fs.existsSync(TMP)) fs.unlinkSync(TMP);

for (const [name, mods] of decl) {
    if (mods.length > 1) { console.log('COLLISIONE ' + name + ' -> ' + mods.join(', ')); bad++; }
}

console.log(bad ? '\n' + bad + ' problemi' : 'moduli: ' + manifest.length + ', nessun problema');
process.exit(bad ? 1 : 0);
