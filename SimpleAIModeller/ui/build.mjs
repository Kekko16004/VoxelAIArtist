#!/usr/bin/env node
/*
 * SimpleAIModeller — build script (nessuna dipendenza esterna).
 * Concatena i moduli di ui/src/manifest.json dentro index.template.html
 * al posto del marcatore <!--BUNDLE--> e scrive ui/index.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(UI_DIR, 'src');
const TEMPLATE = path.join(SRC_DIR, 'index.template.html');
const MANIFEST = path.join(SRC_DIR, 'manifest.json');
const OUT = path.join(UI_DIR, 'index.html');
const MARKER = '<!--BUNDLE-->';

const HEADER =
  '// GENERATO da ui/build.mjs - NON modificare a mano.\n' +
  '// Modifica i moduli in ui/src/** e poi rilancia: node ui/build.mjs\n';

function fail(msg) {
  console.error('[build] ERRORE: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(TEMPLATE)) fail('template mancante: ' + TEMPLATE);
if (!fs.existsSync(MANIFEST)) fail('manifest mancante: ' + MANIFEST);

const template = fs.readFileSync(TEMPLATE, 'utf8');
if (!template.includes(MARKER)) fail('marcatore ' + MARKER + ' non trovato nel template');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  fail('manifest.json non e\' JSON valido: ' + e.message);
}
if (!Array.isArray(manifest) || !manifest.length) fail('manifest deve essere un array non vuoto');

const parts = [];
for (const rel of manifest) {
  const abs = path.join(SRC_DIR, rel);
  if (!fs.existsSync(abs)) fail('modulo mancante: ' + rel);
  const txt = fs.readFileSync(abs, 'utf8');
  if (!txt.length) fail('modulo VUOTO: ' + rel);
  parts.push(txt);
}
const bundle = parts.join('\n');
const out = template.replace(MARKER, () => HEADER + bundle);
fs.writeFileSync(OUT, out, 'utf8');

console.log('[build] moduli : ' + manifest.length);
console.log('[build] bundle : ' + Buffer.byteLength(bundle, 'utf8') + ' byte');
console.log('[build] out    : ' + OUT + ' (' + out.split('\n').length + ' righe)');
