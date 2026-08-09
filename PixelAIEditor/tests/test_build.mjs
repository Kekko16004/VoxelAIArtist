#!/usr/bin/env node
// Build di PixelAIEditor: moduli sani, bundle che compila, bundle AGGIORNATO.
//
// I moduli non sono file indipendenti: sono fette di UNA sola closure concatenate
// da ui/build.mjs. Le conseguenze sono tre, e questo test copre una trappola per
// ciascuna:
//   1. un `const` dichiarato in due moduli e' un SyntaxError al caricamento, non
//      un avviso. Con lo <script> in fondo alla pagina il sintomo e' una pagina
//      DISEGNATA e completamente morta: nessun errore visibile, nessun bottone
//      che risponde. E' quello che cerca .check_modules.mjs.
//   2. il bundle deve compilare per intero: 00 apre la closure e 24 la chiude,
//      quindi la sintassi dei due estremi si vede solo sul file montato.
//   3. `ui/index.html` e' GENERATO ma e' anche il file che il server serve.
//      Committare un modulo senza rilanciare la build lascia in repo un bundle
//      vecchio: le sorgenti mostrano la correzione, l'app no. E' il difetto piu'
//      insidioso dei tre, perche' ogni rilettura del codice conferma che e' a
//      posto.
//
// QUESTO TEST NON DEVE LASCIARE TRACCE. `ui/build.mjs` riscrive `ui/index.html`
// e, tramite annotate-i18n, anche `ui/src/index.template.html`: un test che
// rigenera in silenzio si "aggiusterebbe da solo" e non segnalerebbe mai il
// caso 3. Quindi i due file vengono fotografati prima e RIMESSI COM'ERANO in un
// finally, qualunque cosa succeda.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INDEX = path.join(ROOT, 'ui/index.html');
const TEMPLATE = path.join(ROOT, 'ui/src/index.template.html');

let failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name}: ${detail}`); failures.push(name); }
}

// Esegue un comando node e restituisce { ok, out }. Non lancia: un fallimento e'
// un dato del test, non un'eccezione da cui uscire senza ripristinare i file.
function runNode(script, cwd) {
  try {
    const out = execFileSync(process.execPath, [script], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

console.log('test_build');

// Fotografia in BUFFER, non in stringa: index.html e' scritto in latin1 e il
// template in utf8. Un round-trip attraverso una stringa con la codifica
// sbagliata corromperebbe i quattro accenti del template ("Opacità") proprio
// mentre il test promette di non toccare nulla.
const snapIndex = fs.existsSync(INDEX) ? fs.readFileSync(INDEX) : null;
const snapTemplate = fs.readFileSync(TEMPLATE);

try {
  // --- 1. moduli --------------------------------------------------------
  const chk = runNode(path.join(ROOT, '.check_modules.mjs'), ROOT);
  check('.check_modules.mjs esce 0 (nessuna collisione, nessun modulo vuoto, tutto latin1)',
    chk.ok, `uscita non zero:\n      ${chk.out.trim().split('\n').join('\n      ')}`);

  // --- 2. build ---------------------------------------------------------
  const build = runNode(path.join(ROOT, 'ui/build.mjs'), ROOT);
  check('ui/build.mjs ricostruisce il bundle senza errori', build.ok,
    `uscita non zero:\n      ${build.out.trim().split('\n').join('\n      ')}`);

  const built = fs.existsSync(INDEX) ? fs.readFileSync(INDEX) : null;
  check('la build ha prodotto ui/index.html', !!built && built.length > 0, 'file assente o vuoto');

  if (built) {
    // --- 3. sintassi di OGNI <script> ------------------------------------
    // I blocchi <style> vanno neutralizzati prima di cercare i tag: la parola
    // "<script>" puo' comparire dentro un commento CSS (succede nel padre) e il
    // match si porterebbe dietro migliaia di righe di CSS, che poi non compilano
    // -- un fallimento vero, con una causa completamente inventata.
    const html = built.toString('latin1').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m, n = 0;
    while ((m = re.exec(html)) !== null) {
      const body = m[1];
      if (!body.trim()) continue;
      n++;
      const tmp = path.join(HERE, `.build_check${n}.js`);
      // utf8 in scrittura: il corpo e' gia' una stringa latin1 decodificata,
      // riscriverla in utf8 conserva i caratteri (non i byte, che a node --check
      // non servono).
      fs.writeFileSync(tmp, body, 'utf8');
      let ok = true, err = '';
      try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      } catch (e) {
        ok = false;
        err = String(e.stderr || e).split('\n').slice(0, 5).join('\n      ');
      }
      fs.unlinkSync(tmp);
      check(`<script> #${n} del bundle compila (node --check)`, ok, err);
    }
    check('il bundle contiene almeno due <script> inline', n >= 2,
      `trovati ${n}: l'estrazione non sta vedendo i blocchi, il controllo di sintassi girerebbe a vuoto`);

    // --- 4. il bundle in repo e' AGGIORNATO -------------------------------
    // Il confronto e' byte per byte: la build e' una concatenazione
    // deterministica, quindi qualunque differenza vuol dire che il file
    // committato non viene da queste sorgenti.
    const same = snapIndex && Buffer.compare(snapIndex, built) === 0;
    let detail = 'ui/index.html in repo NON corrisponde alle sorgenti: qualcuno ha modificato ui/src/** senza rilanciare `node ui/build.mjs`. L\'app servirebbe il bundle vecchio. Rimedio: `node ui/build.mjs` e committa anche ui/index.html.';
    if (snapIndex && built) {
      // Il primo byte diverso dice se e' un ritocco o un'altra generazione.
      let i = 0;
      const lim = Math.min(snapIndex.length, built.length);
      while (i < lim && snapIndex[i] === built[i]) i++;
      const line = snapIndex.subarray(0, i).toString('latin1').split('\n').length;
      detail += ` (prima differenza a riga ~${line}; ${snapIndex.length} byte in repo vs ${built.length} rigenerati)`;
    }
    check('ui/index.html in repo e\' gia\' rigenerato dalle sorgenti', !!same, detail);
  }

  // Distingue le due cause di un bundle diverso: se anche il TEMPLATE e' cambiato,
  // il colpevole e' annotate-i18n (una stringa nuova in it.json mai annotata nel
  // template), non un modulo dimenticato. Senza questa distinzione si va a
  // cercare il difetto in ui/src/lib/ dove non c'e'.
  const tplAfter = fs.readFileSync(TEMPLATE);
  check('annotate-i18n non ha annotazioni da aggiungere al template',
    Buffer.compare(snapTemplate, tplAfter) === 0,
    'la build ha MODIFICATO ui/src/index.template.html: ci sono valori di it.json non ancora annotati con data-i18n. Rilancia `node ui/build.mjs` e committa anche il template.');
} finally {
  // Ripristino incondizionato: il test misura, non ripara.
  fs.writeFileSync(TEMPLATE, snapTemplate);
  if (snapIndex) fs.writeFileSync(INDEX, snapIndex);
  for (const f of fs.readdirSync(HERE)) {
    if (/^\.build_check\d+\.js$/.test(f)) fs.unlinkSync(path.join(HERE, f));
  }
}

if (failures.length) { console.error(`\nFALLITI: ${failures.length}`); process.exit(1); }
console.log('  tutti i controlli passati');
