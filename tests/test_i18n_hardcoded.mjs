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
const BASELINE = { template: 73, js: 187 };

// File dove una stringa italiana NON e' testo per l'utente. Motivare ogni voce.
// VUOTA di proposito: 22-screens.js era escluso in blocco perche' inietta un
// blob di CSS via textContent, ma lo stesso modulo costruisce le schermate di
// avvio/impostazioni concatenando HTML con testo italiano VERO ("Nessun
// progetto recente...", "Sfoglia...", "Mostra la schermata iniziale
// all'avvio"). L'esclusione nascondeva 26 stringhe reali e avrebbe lasciato
// dichiarare completo lo sweep senza guardare quel modulo. Il CSS produce
// qualche falso positivo: e' il prezzo, molto piu' basso del rischio opposto.
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
// silenzio. Misurato: con /["]/g in 02-io-files.js si potevano aggiungere tre
// stringhe italiane restando esattamente a 269.
//
// Distinguere `/` divisione da `/` inizio-di-regex non si puo' fare senza
// parsare: la regola pratica e' guardare l'ultimo token significativo. Dopo un
// VALORE (identificatore, numero, `)`, `]`, `}`, o una stringa appena chiusa)
// la barra e' una divisione; in ogni altra posizione e' un letterale regex.
// Eccezione: una PAROLA CHIAVE finisce per lettera ma non e' un valore, quindi
// `return /["]/` apre una regex. Oggi nel repo non ce n'e' nessuna, ma costa
// una riga tenerne conto -- e va tenuta viva attraverso gli spazi, vedi sotto.
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
      // mangiava il resto della riga -- in silenzio, perche' il file finiva
      // comunque in stato pulito e la rete della desincronizzazione non
      // scattava.
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
    // morta: in `return /re/` fra la parola e la barra c'e' uno spazio, quindi
    // al momento del controllo word sarebbe gia' vuota e prev sarebbe 'n' --
    // cioe' "divisione", che e' esattamente il caso da evitare. Solo un
    // carattere non-spazio e non-identificatore chiude la parola.
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
const IT_WORDS = /\b(il|lo|la|le|gli|un|una|del|della|dei|delle|per|con|sul|sulla|nel|nella|non|che|questo|questa|sono|essere|puoi|devi|verra|verranno|seleziona|scegli|salva|carica|crea|elimina|annulla|modifica|aggiungi|nessun|nessuna|errore|attenzione|impossibile)\b/i;

// Ogni sorgente JS che finisce nel bundle. Coprire solo lib/ lasciava due vie
// di fuga: ui/src/utils/*.js e i <script> inline del template. Una stringa
// spostata la' sfuggiva del tutto alla guardia, e lo "zero" finale dello sweep
// avrebbe voluto dire poco.
function jsSources() {
  const out = [];
  for (const dir of ['ui/src/lib', 'ui/src/utils']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.js')) continue;
      const rel = path.basename(dir) + '/' + f;
      if (JS_ALLOW.has(rel)) continue;
      out.push({ name: rel, src: fs.readFileSync(path.join(abs, f), 'latin1') });
    }
  }
  // <script> inline del template, escluso il segnaposto del bundle (che a
  // build fatta contiene tutti i moduli: contarlo sarebbe contare due volte).
  //
  // I blocchi <style> vanno neutralizzati PRIMA: a riga 39 del template la
  // parola "<script>" compare dentro un commento CSS, e senza questo passaggio
  // il match acchiappava quel finto tag e si portava dietro ~1800 righe di CSS
  // fino al primo </script> vero. Trovato dal controllo di desincronizzazione
  // qui sotto, che ha segnalato una stringa non chiusa in quel blocco.
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

function scanJs() {
  let count = 0;
  for (const { name, src: raw } of jsSources()) {
    const { out: src, quote, depth } = tokenize(raw);
    // Un tokenizer che finisce con una stringa o un commento aperto ha perso il
    // filo: da quel punto il file e' letto a rovescio e il conteggio scende.
    // Siccome l'asserzione e' `<=`, un calo non fa fallire nulla, quindi la
    // desincronizzazione va segnalata DA SE', qualunque ne sia la causa --
    // comprese quelle a cui non abbiamo pensato.
    if (quote || depth) desyncs.push(`${name} (${quote ? 'stringa' : 'commento'} non chiuso)`);
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

// Nessun file deve finire con una stringa o un commento aperto: sarebbe la
// firma di una desincronizzazione, cioe' di un conteggio inaffidabile.
check('il tokenizer non si desincronizza su nessun sorgente', desyncs.length === 0,
  `tokenizer perso su: ${desyncs.join(', ')}`);

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
// La barra ESCAPATA dentro una regex: /\// non finisce alla seconda barra.
// La stringa bersaglio sta sulla STESSA riga di proposito: il difetto era che
// `\` seguito da `//` veniva preso per un commento di RIGA, quindi una sonda
// che mettesse il bersaglio sulla riga dopo passerebbe anche col difetto
// presente, e non proverebbe niente.
const escProbe = tokenize(`const p = str.replace(/\\//g, "-"); const msg = "seleziona il colore";`);
check('la barra escapata in una regex non tronca la riga',
  escProbe.out.includes('seleziona il colore'), 'la stringa dopo /\\// e\' andata perduta');
// La divisione NON deve essere letta come regex, o si mangerebbe il codice.
const divProbe = tokenize(`const r = (a) / (b); const t = "non toccare questo";`);
check('una divisione non viene letta come letterale regex',
  divProbe.out.includes('non toccare questo'), 'la divisione ha inghiottito il resto');
// L'eccezione delle keyword deve sopravvivere allo SPAZIO: `return /re/` si
// scrive cosi', non attaccato. Azzerando la parola sugli spazi il controllo
// vedeva word='' e prev='n' e decideva "divisione", cioe' l'eccezione era
// morta e la forma normale restava scoperta.
const kwProbe = tokenize(`return /["]/g.test(s); const m = "seleziona un colore";`);
check('una keyword seguita da spazio apre comunque un letterale regex',
  kwProbe.quote === null && kwProbe.out.includes('seleziona un colore'),
  `dopo "return /[\"]/" il tokenizer ha ${kwProbe.quote} aperto o ha perso la stringa`);
// Una PROPRIETA' che si chiama come una keyword non e' una keyword.
check('obj.in non viene scambiata per la keyword in',
  tokenize('const r = obj.in / 2; const t = "non toccare questo";').out.includes('non toccare questo'),
  'obj.in e\' stata trattata come keyword e la divisione e\' diventata una regex');
// Una stringa CHIUSA e' un valore: la barra dopo e' una divisione. Se prev
// restasse il delimitatore di apertura, `"ab" / 2` aprirebbe una regex che si
// mangia il resto -- e il file finirebbe pulito, quindi in SILENZIO.
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
