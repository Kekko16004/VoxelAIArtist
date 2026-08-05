// Prova che la guida si costruisce DAL DIZIONARIO e non da stringhe nel sorgente:
// dopo lo sweep i18n il modulo 31-help.js non contiene piu' il testo italiano, e
// una regressione tipica sarebbe una guida che si apre VUOTA (o che mostra le
// chiavi nude) senza che nessun test si accorga.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const it = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui/locales/it.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui/locales/en.json'), 'utf8'));
const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/31-help.js'), 'latin1');

// --- DOM finto, quel tanto che basta a renderHelp ------------------------
const mkEl = (tag) => ({
    tag, textContent: '', innerHTML: '', className: '', id: '', type: '', value: '',
    style: {}, dataset: {}, children: [],
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    addEventListener() { }, appendChild(c) { this.children.push(c); return c; },
    querySelectorAll: () => [], querySelector: () => null,
    scrollIntoView() { },
});
const hosts = { helpIndex: mkEl('div'), helpBody: mkEl('div') };
const document = {
    getElementById: (id) => hosts[id] || null,
    createElement: mkEl,
    // I nodi di testo del micro-markup: `tag` resta undefined, cosi' il controllo
    // sui <b>/<kbd> non li scambia per elementi.
    createTextNode: (s) => ({ textContent: s, children: [], appendChild() { } }),
    addEventListener() { },
};

// Testo di tutti i nodi, ricorsivo: e' cio' che l'utente leggerebbe.
const textOf = (el) => (el.textContent || '') + el.children.map(textOf).join(' ');

function build(dict) {
    hosts.helpIndex = mkEl('div');
    hosts.helpBody = mkEl('div');
    const t = (k, vars) => {
        let v = dict[k];
        if (v === undefined) return k;
        if (vars) for (const n of Object.keys(vars)) v = v.split('{' + n + '}').join(vars[n]);
        return v;
    };
    const api = new Function('document', 't', src + '\n;return { renderHelp, HELP_SECTIONS };')(document, t);
    api.renderHelp();
    return { api, index: textOf(hosts.helpIndex), body: textOf(hosts.helpBody) };
}

console.log('test_help_i18n');

// 1. Il sorgente non deve piu' contenere il testo della guida.
{
    const bodyIt = it['help.s.start.b'].split('\n')[0];
    ok(src.indexOf(bodyIt.slice(0, 40)) === -1,
        'il corpo della guida non e\' piu\' hardcoded nel sorgente');
    ok(src.indexOf('Primi passi') === -1,
        'nemmeno i titoli sono hardcoded nel sorgente');
}

// 2. Con it.json la guida esce in italiano, sezione per sezione.
{
    const r = build(it);
    ok(r.api.HELP_SECTIONS.length === 13, `13 sezioni (${r.api.HELP_SECTIONS.length})`);
    const missing = r.api.HELP_SECTIONS.filter(s => !it['help.s.' + s.id + '.t'] || !it['help.s.' + s.id + '.b']);
    ok(missing.length === 0,
        `ogni sezione ha titolo e corpo in it.json (mancanti: ${missing.map(s => s.id).join(',')})`);
    // Il titolo di OGNI sezione deve comparire davvero a schermo: e' il controllo
    // che una guida vuota non passa.
    const absent = r.api.HELP_SECTIONS.filter(s => r.body.indexOf(it['help.s.' + s.id + '.t']) === -1);
    ok(absent.length === 0, `i 13 titoli sono nel corpo reso (assenti: ${absent.map(s => s.id).join(',')})`);
    ok(r.index.indexOf(it['help.s.rig.t']) !== -1, 'l\'indice porta i titoli tradotti');
    ok(r.body.indexOf('help.s.') === -1, 'nessuna chiave nuda finisce a schermo');
    ok(r.body.length > 3000, `il corpo non e' vuoto (${r.body.length} caratteri)`);
}

// 3. Cambiando lingua cambia il testo. Era il difetto atteso: con le sezioni in
//    una costante di modulo il testo si congelava sulla lingua d'avvio.
{
    const ri = build(it);
    const re = build(en);
    ok(re.body.indexOf(en['help.s.start.t']) !== -1,
        'in inglese si vede il titolo inglese');
    ok(re.body.indexOf(it['help.s.start.b'].split('\n')[0]) === -1,
        'e NON si vede piu\' la riga italiana');
    ok(ri.body !== re.body, 'il corpo cambia con la lingua');
}

// 4. Il micro-markup regge: *grassetto* e [tasto] diventano nodi, non testo.
{
    const r = build(it);
    const flat = [];
    (function walk(el) { flat.push(el); el.children.forEach(walk); })(hosts.helpBody);
    ok(flat.some(e => e.tag === 'b'), 'il *grassetto* diventa un nodo <b>');
    ok(flat.some(e => e.tag === 'kbd'), 'il [tasto] diventa un nodo <kbd>');
    ok(r.body.indexOf('*') === -1, 'gli asterischi del markup non restano a schermo');
}

// 5. Dizionario vuoto: la guida non deve mostrare le chiavi nude.
{
    const r = build({});
    ok(r.body.indexOf('help.s.') === -1,
        'col dizionario vuoto non compaiono le chiavi (meglio vuoto che "help.s.rig.t")');
}

console.log(`\n${fail ? 'FALLITI' : 'OK'}: ${pass} controlli passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
