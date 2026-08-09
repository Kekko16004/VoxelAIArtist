#!/usr/bin/env node
// Guardia delle CHIAVI i18n di PixelAIEditor.
//
// Perche' e' la guardia di maggior valore: una chiave citata dal codice e assente
// dal dizionario non solleva niente. `t()` ripiega sulla CHIAVE NUDA (scelta
// documentata in 02-i18n.js, e giusta: meglio un identificatore che una frase
// mutilata), quindi il difetto arriva fino allo schermo travestito da testo. La
// prima scansione fatta con questo criterio ha trovato 26 chiavi fantasma, fra cui
// `pix.sc.groupTools`: la finestra delle scorciatoie stampava quella stringa come
// titolo di gruppo. Nessun test unitario poteva accorgersene, e nemmeno una
// rilettura del codice: il codice era giusto, mancava la voce nel dizionario.
//
// PERCHE' LA REGEX E' LARGA (`['"](pix\....)['"]`) E NON `t('...')`.
// Una regex su `t(` trova solo le chiavi passate direttamente alla funzione: 130
// delle 197 citate. Le altre 67 sono citate come VALORI DI TABELLA
// (`{ combo: 'B', labelKey: 'pix.tool.pencil', ... }` in 21-shortcuts.js, i menu,
// le facce del ponte) e vengono risolte da `t()` molte righe piu' in la', a
// runtime, in un ciclo. Sono esattamente quelle che mancavano: la finestra delle
// scorciatoie e' costruita per tabella. Con la regex stretta il difetto sarebbe
// rimasto invisibile a questa guardia, cioe' la guardia sarebbe nata cieca sul
// caso che l'ha motivata. Il prezzo della regex larga e' qualche falso positivo
// teorico (una chiave nominata in un commento); il prezzo di quella stretta era
// non vedere un terzo del codice.
//
// Non serve rete: legge solo file locali.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(ROOT, 'ui/locales');
const TEMPLATE = path.join(ROOT, 'ui/src/index.template.html');
const SOURCE_LANG = 'it';

let failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name}: ${detail}`); failures.push(name); }
}
function warn(msg) { console.log(`  avviso - ${msg}`); }

// --- lettura dei dizionari ------------------------------------------------
// I dizionari sono UTF-8 (contengono accenti veri): leggerli in latin1 li
// trasformerebbe in mojibake e il confronto dei segnaposto resterebbe valido
// solo per caso. `index.json` non e' un dizionario ma l'elenco delle lingue:
// va escluso o comparirebbe come una lingua con 3 chiavi e 259 mancanti.
function loadLocales() {
  const out = new Map();
  for (const f of fs.readdirSync(LOCALES).sort()) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    out.set(f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8')));
  }
  return out;
}

// --- sorgenti che finiscono nel bundle ------------------------------------
// `ui/src/utils/` oggi non esiste in questa app, ma e' nel percorso del padre:
// tenerlo previene la via di fuga "sposto la stringa in utils/ e la guardia non
// la vede piu'".
function jsSources() {
  const out = [];
  for (const dir of ['ui/src/lib', 'ui/src/utils']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.js')) continue;
      out.push({ name: path.basename(dir) + '/' + f, src: fs.readFileSync(path.join(abs, f), 'utf8') });
    }
  }
  // <script> inline del template. I blocchi <style> vanno neutralizzati prima:
  // nel padre la parola "<script>" compariva dentro un commento CSS e il match
  // si portava dietro 1800 righe di CSS. Qui non succede, ma il template cambia.
  const tpl = fs.readFileSync(TEMPLATE, 'utf8')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, k = 0;
  while ((m = re.exec(tpl)) !== null) {
    if (!m[1].trim()) continue;
    out.push({ name: `index.template.html#script${++k}`, src: m[1] });
  }
  return out;
}

const KEY_RE = /['"](pix\.[A-Za-z0-9_.]+)['"]/g;

// chiave -> insieme dei file che la citano. Serve il file, non solo il nome:
// "manca pix.sc.groupTools" da sola non dice dove guardare.
function scanCitations(sources) {
  const cited = new Map();
  for (const { name, src } of sources) {
    let m;
    KEY_RE.lastIndex = 0;
    while ((m = KEY_RE.exec(src)) !== null) {
      if (!cited.has(m[1])) cited.set(m[1], new Set());
      cited.get(m[1]).add(name);
    }
  }
  return cited;
}

// Chiavi citate dal TEMPLATE via data-i18n / -title / -placeholder. Non passano
// da `t()` nel codice ma dal ciclo di applyI18n: contano come citazioni, e
// dichiararle "morte" perche' il JS non le nomina sarebbe un falso allarme.
function scanTemplateAttrs() {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const out = new Set();
  const re = /data-i18n(?:-[a-z-]+)?\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(tpl)) !== null) out.add(m[1]);
  return out;
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;   // la stessa forma di i18nInterpolate
function placeholders(s) {
  const out = [];
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(String(s))) !== null) out.push(m[1]);
  return out.sort();
}

console.log('test_i18n_keys');

const locales = loadLocales();
const ref = locales.get(SOURCE_LANG);
check(`il dizionario sorgente ${SOURCE_LANG}.json esiste`, !!ref, `${SOURCE_LANG}.json non trovato in ui/locales`);
if (!ref) { console.error('\nFALLITI: 1'); process.exit(1); }

const sources = jsSources();
check('le sorgenti JS sono state trovate', sources.length > 1,
  `solo ${sources.length} sorgenti: percorsi sbagliati, la scansione girerebbe a vuoto`);

const cited = scanCitations(sources);
// Un letterale che finisce col punto NON e' una chiave: e' un PREFISSO composto a
// runtime (`'pix.ai.warn.' + code`, `'pix.bridge.face.' + key`). Cercarlo nel
// dizionario darebbe un falso positivo perpetuo. Ma non va nemmeno ignorato: se
// nessuna chiave inizia con quel prefisso, la composizione non risolvera' MAI e
// l'utente vedra' `pix.ai.warn.badColor` a schermo - lo stesso difetto, per
// un'altra via.
const prefixes = [...cited.keys()].filter((k) => k.endsWith('.'));
const fullKeys = [...cited.keys()].filter((k) => !k.endsWith('.'));

// (a) ogni chiave citata esiste nel dizionario sorgente
const ghosts = fullKeys.filter((k) => !(k in ref)).sort();
console.log(`  (citate: ${fullKeys.length} chiavi + ${prefixes.length} prefissi dinamici | dizionario ${SOURCE_LANG}: ${Object.keys(ref).length})`);
check('ogni chiave pix.* citata dalle sorgenti esiste in it.json', ghosts.length === 0,
  `${ghosts.length} chiavi fantasma (t() ne stamperebbe il NOME a schermo):\n` +
  ghosts.map((k) => `      ${k}  <- ${[...cited.get(k)].join(', ')}`).join('\n'));

// (a-bis) e altrettanto per il TEMPLATE. `data-i18n` non passa da `t()` ma dal
// ciclo di applyI18n, che ha la stessa cecita': un attributo che punta a una
// chiave inesistente non solleva, lascia il testo italiano al primo caricamento e
// poi lo sostituisce col nulla o col nome della chiave al primo cambio lingua.
// Oggi le annotazioni le scrive annotate-i18n a partire da it.json (quindi non
// possono essere fantasma), ma un'annotazione scritta a mano - o una chiave
// rinominata nel dizionario e non nel template - sfuggirebbe a tutto il resto.
const tplKeys = scanTemplateAttrs();
const tplGhosts = [...tplKeys].filter((k) => !(k in ref) && !prefixes.some((p) => k.startsWith(p))).sort();
check('ogni data-i18n del template punta a una chiave esistente', tplGhosts.length === 0,
  `${tplGhosts.length} attributi fantasma: ${tplGhosts.slice(0, 10).join(', ')}`);

for (const p of prefixes.sort()) {
  const hits = Object.keys(ref).filter((k) => k.startsWith(p));
  check(`il prefisso dinamico ${p}* risolve su almeno una chiave`, hits.length > 0,
    `nessuna chiave inizia con ${p} (citato da ${[...cited.get(p)].join(', ')}): la concatenazione a runtime non trovera' nulla`);
}

// (b) parita' esatta fra le lingue, riportata per NOME
// Il conteggio da solo non basta: due lingue con 259 chiavi possono avere una
// chiave diversa ciascuna e il totale tornerebbe. Il nome dice cosa tradurre.
const refKeys = new Set(Object.keys(ref));
for (const [lang, dict] of locales) {
  if (lang === SOURCE_LANG) continue;
  const keys = new Set(Object.keys(dict));
  const missing = [...refKeys].filter((k) => !keys.has(k)).sort();
  const extra = [...keys].filter((k) => !refKeys.has(k)).sort();
  check(`${lang}.json ha esattamente le chiavi di ${SOURCE_LANG}.json`,
    missing.length === 0 && extra.length === 0,
    `${missing.length} mancanti (es. ${missing.slice(0, 5).join(', ') || '-'}), ` +
    `${extra.length} in piu' (es. ${extra.slice(0, 5).join(', ') || '-'})`);
  // Una chiave presente ma VUOTA e' peggio di una mancante: `t()` non ripiega
  // (la chiave c'e'), quindi al suo posto compare il nulla - un bottone senza
  // scritta, che si legge come un difetto di layout.
  const empty = Object.keys(dict).filter((k) => typeof dict[k] === 'string' && !dict[k].trim()).sort();
  check(`${lang}.json non ha valori vuoti`, empty.length === 0,
    `${empty.length} chiavi vuote (es. ${empty.slice(0, 5).join(', ')})`);
}

// (c) coerenza dei segnaposto
// Una traduzione che PERDE {count} mostra una frase senza il numero; una che lo
// storpia ({conteggio}) lo stampa a schermo con le graffe, perche'
// i18nInterpolate lascia intatto un segnaposto senza valore. Nessuno dei due casi
// si vede rileggendo il dizionario, e nessuno dei due rompe l'app: escono in
// produzione.
for (const [lang, dict] of locales) {
  if (lang === SOURCE_LANG) continue;
  const bad = [];
  for (const [k, v] of Object.entries(ref)) {
    if (!(k in dict)) continue;
    const a = placeholders(v).join(','), b = placeholders(dict[k]).join(',');
    if (a !== b) bad.push(`${k}: it{${a}} vs ${lang}{${b}}`);
  }
  check(`${lang}.json usa gli stessi segnaposto di ${SOURCE_LANG}.json`, bad.length === 0,
    `${bad.length} divergenze:\n      ${bad.slice(0, 8).join('\n      ')}`);
}

// --- la guardia deve avere i denti ---------------------------------------
// Se la scansione girasse a vuoto (regex sbagliata, cartella sbagliata) tutti i
// controlli qui sopra sarebbero verdi per assenza di dati. Queste sonde provano
// che il meccanismo funziona, sulla forma che l'ha motivato.
const probe = scanCitations([{ name: 'sonda', src: `{ combo: 'B', labelKey: 'pix.sonda.tabella' }` }]);
check('la scansione trova una chiave in posizione di VALORE DI TABELLA',
  probe.has('pix.sonda.tabella'),
  'la regex non vede labelKey: \'...\' - e\' la forma delle 8 chiavi mancanti nella finestra scorciatoie');
const probe2 = scanCitations([{ name: 'sonda', src: `setStatus(t("pix.sonda.chiamata"), 'warn')` }]);
check('la scansione trova una chiave passata a t()', probe2.has('pix.sonda.chiamata'),
  'la regex non vede t("...")');
// E la prova sul repo vero: se la regex larga non trovasse nulla piu' di `t(`,
// vorrebbe dire che le tabelle sono sparite o che stiamo leggendo altro.
const narrowKeys = new Set();
for (const { src } of sources) for (const m of src.matchAll(/\bt\(\s*['"](pix\.[A-Za-z0-9_.]+)['"]/g)) narrowKeys.add(m[1]);
const onlyWide = [...cited.keys()].filter((k) => !narrowKeys.has(k));
console.log(`  (scansione larga: ${cited.size} | solo-t(): ${narrowKeys.size} | viste solo dalla larga: ${onlyWide.length})`);
check("la scansione larga vede piu' chiavi di quella su t(", onlyWide.length > 0,
  'nessuna chiave in posizione di tabella: la regex larga non sta aggiungendo nulla, controllare che stia leggendo i sorgenti giusti');

// --- peso morto: AVVISO, non errore --------------------------------------
// Una chiave tradotta in 6 lingue e citata da nessuno costa lavoro di traduzione
// a ogni giro. Non e' un difetto (non si vede a schermo), quindi non fa fallire
// il test: ma va cercata ANCHE nel template, o ogni etichetta annotata con
// data-i18n sembrerebbe inutilizzata e l'avviso diventerebbe rumore da ignorare.
const tplAttrs = tplKeys;
const unused = Object.keys(ref)
  .filter((k) => !cited.has(k) && !tplAttrs.has(k) && !prefixes.some((p) => k.startsWith(p)))
  .sort();
if (unused.length) {
  warn(`${unused.length} chiavi tradotte e mai citate (peso morto): ${unused.slice(0, 12).join(', ')}${unused.length > 12 ? ' ...' : ''}`);
} else {
  console.log(`  ok - nessuna chiave tradotta inutilizzata (${tplAttrs.size} citate dal template via data-i18n)`);
}

console.log(`  (lingue: ${[...locales.keys()].join(', ')} | ${Object.keys(ref).length} chiavi ciascuna)`);
if (failures.length) { console.error(`\nFALLITI: ${failures.length}`); process.exit(1); }
console.log('  tutti i controlli passati');
