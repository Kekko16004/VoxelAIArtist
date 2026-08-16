/**
 * Chiavi i18n: parita' esatta fra i dizionari, e ogni chiave usata da t() o da
 * data-i18n deve esistere. La guardia del padre, ridotta all'essenziale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOC = path.join(ROOT, 'ui', 'locales');
const LIB = path.join(ROOT, 'ui', 'src', 'lib');
const TPL = path.join(ROOT, 'ui', 'src', 'index.template.html');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const index = JSON.parse(fs.readFileSync(path.join(LOC, 'index.json'), 'utf8'));
const codes = index.locales.map(l => l.code);
ok(codes.includes('it'), 'index.json elenca it');

const dicts = {};
for (const c of codes) {
  dicts[c] = JSON.parse(fs.readFileSync(path.join(LOC, c + '.json'), 'utf8'));
}
const itKeys = Object.keys(dicts.it).sort();
ok(itKeys.length > 40, 'it.json ha ' + itKeys.length + ' chiavi');

console.log('[1] parita\' fra le lingue');
for (const c of codes) {
  if (c === 'it') continue;
  const keys = Object.keys(dicts[c]).sort();
  const missing = itKeys.filter(k => !(k in dicts[c]));
  const extra = keys.filter(k => !(k in dicts.it));
  ok(missing.length === 0, c + ': nessuna chiave mancante' + (missing.length ? ' (' + missing.join(',') + ')' : ''));
  ok(extra.length === 0, c + ': nessuna chiave in piu\'' + (extra.length ? ' (' + extra.join(',') + ')' : ''));
}

console.log('[2] chiavi usate nel template');
const tpl = fs.readFileSync(TPL, 'utf8');
const tplKeys = new Set();
for (const m of tpl.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) {
  tplKeys.add(m[1]);
}
const tplMissing = [...tplKeys].filter(k => !(k in dicts.it));
ok(tplMissing.length === 0, 'template: tutte le ' + tplKeys.size + ' chiavi esistono'
  + (tplMissing.length ? ' (mancano: ' + tplMissing.join(',') + ')' : ''));

console.log('[3] chiavi usate da t() nel JS');
const jsKeys = new Set();
for (const f of fs.readdirSync(LIB)) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(LIB, f), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) jsKeys.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) jsKeys.add(m[1]);
}
const jsMissing = [...jsKeys].filter(k => !(k in dicts.it));
ok(jsMissing.length === 0, 'js: tutte le ' + jsKeys.size + ' chiavi esistono'
  + (jsMissing.length ? ' (mancano: ' + jsMissing.join(',') + ')' : ''));

console.log('[4] segnaposto coerenti fra le lingue');
function placeholders(s) {
  return [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
}
for (const c of codes) {
  if (c === 'it') continue;
  const bad = itKeys.filter(k => k in dicts[c]
    && placeholders(dicts.it[k]) !== placeholders(dicts[c][k]));
  ok(bad.length === 0, c + ': segnaposto coerenti'
    + (bad.length ? ' (diversi in: ' + bad.join(',') + ')' : ''));
}

console.log();
console.log('PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
