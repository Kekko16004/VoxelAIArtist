#!/usr/bin/env node
// Guardia anti-hardcode i18n.
//
// Perche' una BASELINE invece di zero: al momento in cui questa guardia nasce il
// debito esiste gia' (~50 testi nel template, ~280 stringhe nei moduli). Un test
// assoluto sarebbe rosso da subito e verrebbe ignorato. Con la baseline il test e'
// verde adesso e diventa rosso se qualcuno AGGIUNGE debito: ogni passo dello sweep
// abbassa i numeri, e a zero il meccanismo si rimuove.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ABBASSARE a ogni passo dello sweep. Non alzare mai.
const BASELINE = { template: 74, js: 269 };

// File dove una stringa italiana NON e' testo per l'utente. Motivare ogni voce.
const JS_ALLOW = new Set([
  'lib/22-screens.js',   // CSS inline iniettato via textContent: non e' testo
]);

let failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name}: ${detail}`); failures.push(name); }
}

// --- strip dei commenti -------------------------------------------------
// Scorre il carattere tracciando i delimitatori di stringa. Uno strip ingenuo
// (regex su //) scambierebbe la barra dentro 'http://x' per l'inizio di un
// commento e taglierebbe via il resto della riga, nascondendo stringhe vere.
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += (n === undefined ? '' : n); i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

// Parole che rendono una stringa "italiano per l'utente" al di la' di ogni dubbio.
const IT_WORDS = /\b(il|lo|la|le|gli|un|una|del|della|dei|delle|per|con|sul|sulla|nel|nella|non|che|questo|questa|sono|essere|puoi|devi|verra|verranno|seleziona|scegli|salva|carica|crea|elimina|annulla|modifica|aggiungi|nessun|nessuna|errore|attenzione|impossibile)\b/i;

function scanJs() {
  const libDir = path.join(ROOT, 'ui/src/lib');
  let count = 0;
  for (const f of fs.readdirSync(libDir).sort()) {
    if (!f.endsWith('.js')) continue;
    if (JS_ALLOW.has('lib/' + f)) continue;
    const src = stripComments(fs.readFileSync(path.join(libDir, f), 'latin1'));
    const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const val = m[2];
      if (val.length < 4) continue;
      if (IT_WORDS.test(val)) count++;
    }
  }
  return count;
}

function scanTemplate() {
  const html = fs.readFileSync(path.join(ROOT, 'ui/src/index.template.html'), 'latin1');
  let count = 0;
  // Elementi foglia con testo: <tag ...>testo</tag> senza altri tag dentro.
  const re = /<(label|button|option|p|div|span|h1|h2|h3|td|th|a)\b([^>]*)>([^<>]*[A-Za-z]{3,}[^<>]*)<\/\1>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[2], text = m[3].trim();
    if (!text) continue;
    if (/data-i18n\s*=/.test(attrs)) continue;
    count++;
  }
  // title= e placeholder= senza il rispettivo data-i18n-*
  const reT = /<[a-z][^>]*\btitle\s*=\s*"[^"]{3,}"[^>]*>/gi;
  while ((m = reT.exec(html)) !== null) {
    if (!/data-i18n-title\s*=/.test(m[0])) count++;
  }
  const reP = /<[a-z][^>]*\bplaceholder\s*=\s*"[^"]{3,}"[^>]*>/gi;
  while ((m = reP.exec(html)) !== null) {
    if (!/data-i18n-placeholder\s*=/.test(m[0])) count++;
  }
  return count;
}

console.log('test_i18n_hardcoded');

const tpl = scanTemplate();
const js = scanJs();
console.log(`  (rilevati: template=${tpl} js=${js} | baseline template=${BASELINE.template} js=${BASELINE.js})`);

check('il debito nel template non sale', tpl <= BASELINE.template,
  `${tpl} > ${BASELINE.template}: estrai la stringa in una chiave i18n invece di allargare la baseline`);
check('il debito nei moduli JS non sale', js <= BASELINE.js,
  `${js} > ${BASELINE.js}: usa t('chiave') invece di una stringa italiana`);

// Lo strip dei commenti e' il punto fragile della guardia: se sbagliasse,
// il conteggio crollerebbe e il test passerebbe sempre. Lo verifichiamo.
const probe = stripComments(`const a = 'http://esempio/con la barra'; // via il commento\nconst b = 1;`);
check('lo strip non scambia // dentro una stringa per un commento',
  probe.includes('http://esempio/con la barra'), 'la stringa e\' stata troncata dallo strip');
check('lo strip toglie davvero i commenti di riga',
  !probe.includes('via il commento'), 'il commento e\' sopravvissuto');
check('lo strip toglie i commenti di blocco',
  !stripComments('a /* con la nota */ b').includes('con la nota'), 'commento di blocco sopravvissuto');

if (failures.length) { console.error(`\nFALLITI: ${failures.length}`); process.exit(1); }
console.log('  tutti i controlli passati');
