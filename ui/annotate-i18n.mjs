// annotate-i18n.mjs — inietta attributi data-i18n nel template a partire da it.json.
//
// it.json e' la lingua SORGENTE: i suoi valori sono le stringhe italiane reali gia'
// presenti nel template. Questo script, in modo DETERMINISTICO e idempotente, cerca
// ogni valore italiano e annota l'elemento che lo contiene con:
//   - data-i18n="key"             per il testo interno di un elemento foglia
//   - data-i18n-title="key"       per l'attributo title="..."
//   - data-i18n-placeholder="key" per placeholder="..."
//   - data-i18n-html-title (documento) per <title>
//
// A runtime, 24-i18n.js legge questi attributi e sostituisce i testi con la lingua scelta.
// Le stringhe SOLO-runtime (in JS, es. alert/confirm) NON sono nel template: le gestisce
// direttamente il motore via t(key) nel codice JS, non qui.
//
// Eseguito da build.mjs PRIMA della concatenazione, oppure a mano: `node ui/annotate-i18n.mjs`.
// Idempotente: rilanciarlo non duplica attributi (salta gli elementi gia' annotati).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(__dirname, 'src', 'index.template.html');
const IT = path.join(__dirname, 'locales', 'it.json');

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Escape del valore cosi' come apparirebbe DENTRO l'HTML (le graffe dei placeholder restano).
function htmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function annotate() {
  let tpl = fs.readFileSync(TPL, 'utf8');
  const it = JSON.parse(fs.readFileSync(IT, 'utf8'));

  const report = { title: 0, placeholder: 0, text: 0, docTitle: 0, skipped: 0, notFound: [] };

  // Ordina le chiavi per lunghezza del valore DECRESCENTE: cosi' i testi lunghi/specifici
  // vengono matchati prima di eventuali sottostringhe piu' corte, evitando match parziali.
  const keys = Object.keys(it).sort((a, b) => String(it[b]).length - String(it[a]).length);

  for (const key of keys) {
    const raw = String(it[key]);
    if (raw.length < 2) { report.skipped++; continue; }
    const val = htmlText(raw);
    const valRe = escRe(val);

    // 1) title="VALORE"  -> aggiunge data-i18n-title="key" allo stesso tag (se non gia' presente)
    let did = false;
    {
      const re = new RegExp(`(<[^>]*?)\\btitle=("|')${valRe}\\2([^>]*?>)`, 'g');
      tpl = tpl.replace(re, (m, pre, q, post) => {
        if (/data-i18n-title=/.test(m)) return m;
        did = true; report.title++;
        return `${pre}title=${q}${val}${q} data-i18n-title="${key}"${post}`;
      });
    }
    // 2) placeholder="VALORE"
    {
      const re = new RegExp(`(<[^>]*?)\\bplaceholder=("|')${valRe}\\2([^>]*?>)`, 'g');
      tpl = tpl.replace(re, (m, pre, q, post) => {
        if (/data-i18n-placeholder=/.test(m)) return m;
        did = true; report.placeholder++;
        return `${pre}placeholder=${q}${val}${q} data-i18n-placeholder="${key}"${post}`;
      });
    }
    // 3) <title>VALORE</title>  (documento)
    {
      const re = new RegExp(`<title>${valRe}</title>`, 'g');
      if (re.test(tpl)) {
        tpl = tpl.replace(re, `<title data-i18n="${key}">${val}</title>`);
        did = true; report.docTitle++;
      }
    }
    // 4) Testo interno di un elemento foglia: >VALORE<  (senza tag annidati nel mezzo).
    //    Solo se il tag di apertura NON ha gia' un data-i18n. Match del piu' vicino "<...>".
    {
      // Cattura: <tag ...>  VALORE  </...>   con VALORE senza '<' dentro (elemento foglia)
      const re = new RegExp(`(<([a-zA-Z][\\w-]*)([^>]*)>)(\\s*)${valRe}(\\s*)(</\\2>)`, 'g');
      tpl = tpl.replace(re, (m, open, tag, attrs, ws1, ws2, close) => {
        if (/data-i18n=/.test(open)) return m;
        did = true; report.text++;
        const newOpen = `<${tag}${attrs} data-i18n="${key}">`;
        return `${newOpen}${ws1}${val}${ws2}${close}`;
      });
    }

    if (!did) report.notFound.push(key);
  }

  fs.writeFileSync(TPL, tpl, 'utf8');
  return report;
}

const r = annotate();
console.log('[annotate-i18n] title=%d placeholder=%d text=%d docTitle=%d skipped=%d',
  r.title, r.placeholder, r.text, r.docTitle, r.skipped);
console.log('[annotate-i18n] chiavi senza match nel template (runtime/JS):', r.notFound.length);
