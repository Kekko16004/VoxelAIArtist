#!/usr/bin/env node
// Guardia anti-hardcode i18n di PixelAIEditor.
//
// L'altra meta' del problema rispetto a test_i18n_keys.mjs: quello controlla che
// ogni chiave CITATA esista, questo che ogni testo per l'utente sia diventato una
// chiave. Una stringa italiana scritta in chiaro non manca da nessun file - non
// esiste proprio - quindi nessun confronto fra dizionari puo' vederla, e l'app
// resta parzialmente in italiano in tutte e sei le lingue.
//
// Il tokenizer e le sonde sono presi da `tests/test_i18n_hardcoded.mjs` del padre
// VoxelAIArtist e NON reinventati: ognuna delle sue righe strane e' la cicatrice
// di un difetto misurato la' (il letterale regex che apriva una stringa e rendeva
// la guardia cieca in silenzio, la barra dopo una stringa chiusa, l'eccezione
// delle keyword che moriva sullo spazio). Riscriverlo da capo qui vorrebbe dire
// ricommetterli uno per uno.
//
// Perche' una BASELINE invece di zero: il debito esiste gia' nel momento in cui
// la guardia nasce. Un test assoluto sarebbe rosso da subito e verrebbe ignorato.
// Con la baseline il test e' verde adesso e diventa rosso appena qualcuno
// AGGIUNGE debito. I numeri vanno SOLO ABBASSATI, mai alzati: a zero il
// meccanismo si rimuove.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Misurata il 2026-08-08 sulle sorgenti di PixelAIEditor.
// ABBASSARE a ogni passo dello sweep. NON ALZARE MAI: alzarla e' il modo in cui
// una guardia del genere smette di guardare.
//
// Cosa sono, oggi, gli 8 rilevati (elenco con PIX_I18N_DUMP=1): sei messaggi di
// console per lo sviluppatore ("[prefs] non salvata:"), la chiave
// 'pix.layer.del' (falso positivo: `del` e' in IT_WORDS) e la tabella
// BRIDGE_FACE_PROMPT di 23-bridge.js, che e' testo per il MODELLO dentro il
// prompt, non per l'utente. Nessuno e' testo dell'interfaccia: sono il rumore
// dichiarato del criterio, non debito da estrarre. Restano contati lo stesso,
// perche' l'allow-list vuota vale piu' di 8 falsi positivi: nel padre l'unica
// esclusione presente nascondeva 26 stringhe vere.
const BASELINE = { template: 0, js: 8 };

// File dove una stringa italiana NON e' testo per l'utente. Motivare ogni voce.
// VUOTA di proposito, come nel padre: escludere un modulo in blocco e' il modo
// piu' rapido per nascondere le stringhe vere che contiene. Nel padre
// l'esclusione di un solo file copriva 26 stringhe reali.
const JS_ALLOW = new Set([]);

let failures = [];
let desyncs = [];
function check(name, cond, detail) {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name}: ${detail}`); failures.push(name); }
}

// --- strip dei commenti -------------------------------------------------
// Scorre il carattere tracciando i delimitatori di stringa. Uno strip ingenuo
// (regex su //) scambierebbe la barra dentro 'http://x' per l'inizio di un
// commento e taglierebbe via il resto della riga, nascondendo stringhe vere.
//
// Deve riconoscere anche i LETTERALI REGEX, e non e' un vezzo: in /["]/ la
// virgoletta e' un carattere della classe, non l'apertura di una stringa.
// Prendendola per un'apertura, tutto il resto del file viene tokenizzato a
// rovescio e il conteggio CROLLA -- e siccome l'asserzione e' `count <=
// BASELINE`, un crollo non fa fallire nulla: la guardia diventa cieca in
// silenzio.
//
// Distinguere `/` divisione da `/` inizio-di-regex non si puo' fare senza
// parsare: la regola pratica e' guardare l'ultimo token significativo. Dopo un
// VALORE (identificatore, numero, `)`, `]`, `}`, o una stringa appena chiusa)
// la barra e' una divisione; in ogni altra posizione e' un letterale regex.
// Eccezione: una PAROLA CHIAVE finisce per lettera ma non e' un valore, quindi
// `return /["]/` apre una regex -- e va tenuta viva attraverso gli spazi.
const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete',
  'void', 'instanceof', 'do', 'else', 'yield', 'await', 'throw']);
function tokenize(src) {
  let out = '';
  let i = 0;
  let quote = null;        // delimitatore di stringa aperto
  let depth = 0;           // profondita' dei commenti di blocco (0 o 1)
  let prev = '';           // ultimo carattere significativo visto
  let word = '';           // ultima parola vista, per riconoscere le keyword
  let dotted = false;      // ...ed era preceduta da un punto? (obj.in NON e' `in`)
  const startsRegex = () => {
    if (word && !dotted && KEYWORDS.has(word)) return true;
    return !/[A-Za-z0-9_$)\]}]/.test(prev);
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += (n === undefined ? '' : n); i += 2; continue; }
      // Stringa CHIUSA: e' un valore, quindi la barra che segue e' una
      // divisione. Senza aggiornare prev qui restava il delimitatore di
      // APERTURA, e `"ab" / 2` veniva letto come un letterale regex che si
      // mangiava il resto della riga -- in silenzio.
      if (c === quote) { quote = null; prev = 'x'; word = ''; dotted = false; }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; prev = c; word = ''; dotted = false; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      depth = 1; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i >= src.length) return { out, quote, depth };   // commento non chiuso
      depth = 0; i += 2; continue;
    }
    // Letterale regex: consumalo senza emetterlo, cosi' il suo contenuto non
    // puo' essere letto ne' come stringa ne' come commento.
    if (c === '/' && startsRegex()) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') break;                 // regex non terminata: esci
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        i++;
      }
      prev = 'x';   // una regex e' un valore: la barra successiva e' divisione
      word = '';
      dotted = false;
      continue;
    }
    out += c;
    // `word` NON va azzerata sugli spazi, o l'eccezione delle keyword sarebbe
    // morta: in `return /re/` fra la parola e la barra c'e' uno spazio.
    if (/[A-Za-z0-9_$]/.test(c)) {
      if (!word) dotted = (prev === '.');
      word += c;
    } else if (!/\s/.test(c)) {
      word = '';
      dotted = false;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { out, quote, depth };
}
// Comodita' per le sonde: solo il testo.
function stripComments(src) { return tokenize(src).out; }

// Parole che rendono una stringa "italiano per l'utente" al di la' di ogni dubbio.
// Identica al padre: allargarla qui e alzare la baseline sarebbero la stessa cosa
// vista da due lati, e restringerla e' il modo silenzioso di svuotare la guardia.
const IT_WORDS = /\b(il|lo|la|le|gli|un|una|del|della|dei|delle|per|con|sul|sulla|nel|nella|non|che|questo|questa|sono|essere|puoi|devi|verra|verranno|seleziona|scegli|salva|carica|crea|elimina|annulla|modifica|aggiungi|nessun|nessuna|errore|attenzione|impossibile)\b/i;

// Ogni sorgente JS che finisce nel bundle: i moduli del manifest E gli <script>
// inline del template. Coprire solo lib/ lascerebbe una via di fuga - spostare
// una stringa nel template non e' un modo per farla sparire dal conteggio.
function jsSources() {
  const out = [];
  for (const dir of ['ui/src/lib', 'ui/src/utils']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.js')) continue;
      const rel = path.basename(dir) + '/' + f;
      if (JS_ALLOW.has(rel)) continue;
      // latin1: i moduli DEVONO essere latin1-puri (lo impone .check_modules.mjs
      // e la build li rilegge cosi'). Leggerli con lo stesso metodo della build
      // significa contare esattamente i byte che finiranno nel bundle.
      out.push({ name: rel, src: fs.readFileSync(path.join(abs, f), 'latin1') });
    }
  }
  // <script> inline del template, escluso il segnaposto del bundle (che a build
  // fatta contiene tutti i moduli: contarlo sarebbe contare due volte -- qui il
  // segnaposto e' <!--BUNDLE-->, quindi nel TEMPLATE quel blocco e' vuoto e viene
  // gia' saltato dal controllo su body.trim()).
  //
  // I blocchi <style> vanno neutralizzati PRIMA: la parola "<script>" puo'
  // comparire dentro un commento CSS, e senza questo passaggio il match
  // acchiapperebbe quel finto tag e si porterebbe dietro tutto il CSS.
  const tpl = fs.readFileSync(path.join(ROOT, 'ui/src/index.template.html'), 'latin1')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, k = 0;
  while ((m = re.exec(tpl)) !== null) {
    const body = m[1];
    if (!body.trim()) continue;
    out.push({ name: `index.template.html#script${++k}`, src: body });
  }
  return out;
}

function scanJs(collect) {
  let count = 0;
  for (const { name, src: raw } of jsSources()) {
    const { out: src, quote, depth } = tokenize(raw);
    // Un tokenizer che finisce con una stringa o un commento aperto ha perso il
    // filo: da quel punto il file e' letto a rovescio e il conteggio scende.
    // Siccome l'asserzione e' `<=`, un calo non fa fallire nulla, quindi la
    // desincronizzazione va segnalata DA SE'.
    if (quote || depth) desyncs.push(`${name} (${quote ? 'stringa' : 'commento'} non chiuso)`);
    const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const val = m[2];
      if (val.length < 4) continue;
      if (IT_WORDS.test(val)) { count++; if (collect) collect.push(`${name}: ${JSON.stringify(val).slice(0, 90)}`); }
    }
  }
  return count;
}

function scanTemplate(collect) {
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
    if (collect) collect.push(`testo: ${text.slice(0, 70)}`);
  }
  // title= e placeholder= senza il rispettivo data-i18n-*
  const reT = /<[a-z][^>]*\btitle\s*=\s*"[^"]{3,}"[^>]*>/gi;
  while ((m = reT.exec(html)) !== null) {
    if (!/data-i18n-title\s*=/.test(m[0])) { count++; if (collect) collect.push(`title: ${m[0].slice(0, 70)}`); }
  }
  const reP = /<[a-z][^>]*\bplaceholder\s*=\s*"[^"]{3,}"[^>]*>/gi;
  while ((m = reP.exec(html)) !== null) {
    if (!/data-i18n-placeholder\s*=/.test(m[0])) { count++; if (collect) collect.push(`placeholder: ${m[0].slice(0, 70)}`); }
  }
  return count;
}

console.log('test_i18n_hardcoded');

const tplHits = [], jsHits = [];
const tpl = scanTemplate(tplHits);
const js = scanJs(jsHits);
console.log(`  (rilevati: template=${tpl} js=${js} | baseline template=${BASELINE.template} js=${BASELINE.js})`);

// Per abbassare la baseline serve sapere QUALI sono le stringhe rimaste: senza
// l'elenco si finisce a bisezionare il conteggio. Fuori dal caso di fallimento
// pero' sono rumore, quindi l'elenco e' a richiesta: PIX_I18N_DUMP=1.
if (process.env.PIX_I18N_DUMP) {
  for (const h of tplHits) console.log(`    [template] ${h}`);
  for (const h of jsHits) console.log(`    [js] ${h}`);
}

check('il debito nel template non sale', tpl <= BASELINE.template,
  `${tpl} > ${BASELINE.template}: estrai la stringa in una chiave i18n invece di allargare la baseline\n      ` +
  tplHits.slice(0, 10).join('\n      '));
check('il debito nei moduli JS non sale', js <= BASELINE.js,
  `${js} > ${BASELINE.js}: usa t('chiave') invece di una stringa italiana\n      ` +
  jsHits.slice(0, 10).join('\n      '));

// Nessun file deve finire con una stringa o un commento aperto: sarebbe la
// firma di una desincronizzazione, cioe' di un conteggio inaffidabile.
check('il tokenizer non si desincronizza su nessun sorgente', desyncs.length === 0,
  `tokenizer perso su: ${desyncs.join(', ')}`);

// La guardia deve avere dei sorgenti da guardare: con un percorso sbagliato
// scanJs() tornerebbe 0 e ogni asserzione `<=` sarebbe verde per assenza di dati.
const nSources = jsSources().length;
check('la guardia sta leggendo dei sorgenti veri', nSources >= 10,
  `solo ${nSources} sorgenti trovate sotto ${ROOT}: percorsi sbagliati, il conteggio e' finto`);

// Lo strip dei commenti e' il punto fragile della guardia: se sbagliasse,
// il conteggio crollerebbe e il test passerebbe sempre. Lo verifichiamo.
const probe = stripComments(`const a = 'http://esempio/con la barra'; // via il commento\nconst b = 1;`);
check('lo strip non scambia // dentro una stringa per un commento',
  probe.includes('http://esempio/con la barra'), 'la stringa e\' stata troncata dallo strip');
check('lo strip toglie davvero i commenti di riga',
  !probe.includes('via il commento'), 'il commento e\' sopravvissuto');
check('lo strip toglie i commenti di blocco',
  !stripComments('a /* con la nota */ b').includes('con la nota'), 'commento di blocco sopravvissuto');

// Un letterale regex con una virgoletta dentro non deve aprire una stringa:
// la riga dopo va ancora vista. E' il difetto che rendeva la guardia cieca.
const reProbe = tokenize(`const q = s.replace(/["]/g, '-');\nconst m = "seleziona un colore";`);
check('un letterale regex con virgoletta non apre una stringa',
  reProbe.quote === null, `tokenizer con ${reProbe.quote} aperto dopo /["]/`);
check('la stringa dopo un letterale regex e\' ancora visibile',
  reProbe.out.includes('seleziona un colore'), 'la stringa dopo la regex e\' andata perduta');
// La barra ESCAPATA dentro una regex: /\// non finisce alla seconda barra. La
// stringa bersaglio sta sulla STESSA riga di proposito: il difetto era che `\`
// seguito da `//` veniva preso per un commento di RIGA, quindi una sonda con il
// bersaglio sulla riga dopo passerebbe anche col difetto presente.
const escProbe = tokenize(`const p = str.replace(/\\//g, "-"); const msg = "seleziona il colore";`);
check('la barra escapata in una regex non tronca la riga',
  escProbe.out.includes('seleziona il colore'), 'la stringa dopo /\\// e\' andata perduta');
// La divisione NON deve essere letta come regex, o si mangerebbe il codice.
const divProbe = tokenize(`const r = (a) / (b); const t = "non toccare questo";`);
check('una divisione non viene letta come letterale regex',
  divProbe.out.includes('non toccare questo'), 'la divisione ha inghiottito il resto');
// L'eccezione delle keyword deve sopravvivere allo SPAZIO: `return /re/`.
const kwProbe = tokenize(`return /["]/g.test(s); const m = "seleziona un colore";`);
check('una keyword seguita da spazio apre comunque un letterale regex',
  kwProbe.quote === null && kwProbe.out.includes('seleziona un colore'),
  `dopo "return /[\"]/" il tokenizer ha ${kwProbe.quote} aperto o ha perso la stringa`);
// Una PROPRIETA' che si chiama come una keyword non e' una keyword.
check('obj.in non viene scambiata per la keyword in',
  tokenize('const r = obj.in / 2; const t = "non toccare questo";').out.includes('non toccare questo'),
  'obj.in e\' stata trattata come keyword e la divisione e\' diventata una regex');
// Una stringa CHIUSA e' un valore: la barra dopo e' una divisione.
const strDivProbe = tokenize(`const _r = "ab" / 2; const _a = "seleziona un colore";`);
check('una barra dopo una stringa chiusa e\' una divisione, non una regex',
  strDivProbe.out.includes('seleziona un colore'),
  'la barra dopo "ab" ha inghiottito la stringa successiva');
// Il rilevatore di desincronizzazione deve avere i denti: se non segnalasse
// nulla mai, il controllo qui sopra sarebbe decorativo.
check('una stringa non chiusa viene segnalata',
  tokenize("const a = 'aperta e mai chiusa").quote === "'", 'la stringa aperta non e\' stata rilevata');
check('un commento di blocco non chiuso viene segnalato',
  tokenize('a /* mai chiuso').depth === 1, 'il commento aperto non e\' stato rilevato');

if (failures.length) { console.error(`\nFALLITI: ${failures.length}`); process.exit(1); }
console.log('  tutti i controlli passati');
