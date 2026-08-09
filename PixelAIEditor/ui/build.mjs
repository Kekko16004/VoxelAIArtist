#!/usr/bin/env node
/*
 * VoxelAIArtist — build script (nessuna dipendenza esterna, solo `fs`/`path`).
 *
 * Cosa fa:
 *   1. Legge il template `ui/src/index.template.html` (l'index.html con il grande
 *      blocco JS sostituito dal marcatore `<!--BUNDLE-->`, posto DENTRO l'unico
 *      <script>...</script>).
 *   2. Concatena i moduli JS elencati in `ui/src/manifest.json` NELL'ORDINE dato.
 *   3. Inserisce il bundle al posto del marcatore e scrive `ui/index.html`.
 *
 * Regola d'oro: i moduli sono frammenti di UN unico scope condiviso (nessun
 * import/export ES). La loro concatenazione, nell'ordine del manifest, deve
 * riprodurre ESATTAMENTE il blocco JS originale (a meno dell'header generato).
 *
 * Uso:  node ui/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileSync } from 'node:child_process';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(UI_DIR, 'src');
const TEMPLATE = path.join(SRC_DIR, 'index.template.html');
const ANNOTATOR = path.join(UI_DIR, 'annotate-i18n.mjs');

// i18n: (ri)annota il template con gli attributi data-i18n prima di concatenare.
// Lo script e' idempotente (non duplica attributi), quindi e' sicuro eseguirlo a
// ogni build: tiene le annotazioni in sync se il template cambia. Best-effort: se
// fallisce, si prosegue con le annotazioni gia' presenti nel template.
if (fs.existsSync(ANNOTATOR)) {
  try {
    execFileSync(process.execPath, [ANNOTATOR], { stdio: 'inherit' });
  } catch (e) {
    console.error('[build] avviso: annotate-i18n fallito, uso il template cosi\' com\'e\':', e.message);
  }
}
const MANIFEST = path.join(SRC_DIR, 'manifest.json');
const OUT = path.join(UI_DIR, 'index.html');
const MARKER = '<!--BUNDLE-->';

// Header inserito in cima al bundle. È un commento JS: non altera lo scope.
const HEADER =
  '// GENERATO da ui/build.mjs - NON modificare a mano.\n' +
  '// Modifica i moduli in ui/src/** e poi rilancia: node ui/build.mjs\n';

function fail(msg) {
  console.error('[build] ERRORE: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(TEMPLATE)) fail('template mancante: ' + TEMPLATE);
if (!fs.existsSync(MANIFEST)) fail('manifest mancante: ' + MANIFEST);

const template = fs.readFileSync(TEMPLATE, 'latin1');
if (!template.includes(MARKER)) fail('marcatore ' + MARKER + ' non trovato nel template');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'latin1'));
} catch (e) {
  fail('manifest.json non è JSON valido: ' + e.message);
}
if (!Array.isArray(manifest) || manifest.length === 0) fail('manifest deve essere un array non vuoto');

// Concatena i moduli nell'ordine del manifest, preservando byte-per-byte il
// contenuto (le fette sono state prodotte tagliando l'originale su confini di
// linea, quindi vanno riunite con "\n").
const parts = [];
for (const rel of manifest) {
  const abs = path.join(SRC_DIR, rel);
  if (!fs.existsSync(abs)) fail('modulo mancante nel manifest: ' + rel);
  const buf = fs.readFileSync(abs);
  // Guardia: i moduli sono letti/scritti in latin1. Un carattere non
  // rappresentabile (bullet, emoji, virgolette tipografiche) verrebbe
  // corrotto o troncherebbe il file allo script di scrittura. Meglio un
  // errore chiaro adesso che un bundle silenziosamente sbagliato.
  if (buf.length === 0) fail('modulo VUOTO (scrittura troncata?): ' + rel);
  const txt = buf.toString('latin1');
  const bad = txt.match(/[^\x00-\xFF]/);
  if (bad) fail('carattere non latin1 in ' + rel + ': ' + JSON.stringify(bad[0]));
  parts.push(txt);
}
const bundle = parts.join('\n');

// L'header va su una riga a sé, prima del bundle, dentro il <script>.
const replacement = HEADER + bundle;
const out = template.replace(MARKER, () => replacement);

fs.writeFileSync(OUT, out, 'latin1');

const lineCount = out.split('\n').length;
console.log('[build] moduli concatenati : ' + manifest.length);
console.log('[build] bundle (byte)      : ' + Buffer.byteLength(bundle, 'latin1'));
console.log('[build] index.html (byte)  : ' + Buffer.byteLength(out, 'latin1'));
console.log('[build] index.html (righe) : ' + lineCount);
console.log('[build] scritto            : ' + OUT);
