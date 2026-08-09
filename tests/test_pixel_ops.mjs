/**
 * Test dell'espansore delle ops 2D (ui/src/lib/37-pixel-ops.js).
 *
 * E' l'UNICA implementazione: le ops dei pixel non hanno un consumatore
 * server-side, quindi non esiste una parita' da verificare come per le ops dei
 * voxel (tests/ops_parity_cases.json). Qui si controlla la semantica: ordine
 * degli strati, ritaglio ai bordi, trasparenza, determinismo del rumore e il
 * giro completo pixel -> RLE -> testo per il contesto del prompt.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
function check(cond, msg) {
    if (cond) { console.log('  OK  ' + msg); }
    else { console.log('  FAIL ' + msg); fails++; }
}

// Il modulo e' un frammento di UNA closure condivisa (niente import/export):
// si carica come corpo di funzione, come fanno gli altri test.
function loadPixelOps() {
    const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/37-pixel-ops.js'), 'latin1');
    const fakeDoc = {
        createElement: () => ({
            width: 0, height: 0,
            getContext: () => ({
                createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
                putImageData() {}, clearRect() {},
            }),
            toDataURL: () => 'data:image/png;base64,STUB',
        }),
    };
    const textureFromCanvasCtx = (cv) => ({ data: cv.toDataURL(), w: cv.width, h: cv.height,
                                            color: '#808080', alpha: false });
    return new Function('document', 'textureFromCanvasCtx', src + `
        ;return { expandPixelOps, pixelsToRleRows, pixelContextBlock,
                  pixelColorToRgba, pixelClampSide, applyPixelOp,
                  PIXEL_OPS_MAX, PIXEL_OPS_MAX_SIDE, PIXEL_OPS_MIN_SIDE };
    `)(fakeDoc, textureFromCanvasCtx);
}

const P = loadPixelOps();

// Lettore comodo: colore del pixel (x,y) come [r,g,b,a].
const at = (buf, w, x, y) => Array.from(buf.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
const RED = [255, 0, 0, 255], BLU = [0, 0, 255, 255], NADA = [0, 0, 0, 0];
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function run(ops, opts) {
    const o = Object.assign({ size: 8 }, opts || {});
    const r = P.expandPixelOps({ size: o.size, palette: o.palette || {},
                                 faces: { all: ops } }, { size: o.size });
    return { buf: r.faces.all, w: r.w, h: r.h, r };
}

// --- fondamenta --------------------------------------------------------------
check(P.pixelClampSide(200) === 128 && P.pixelClampSide(1) === 4
      && P.pixelClampSide('abc', 16) === 16, 'lato ritagliato fra 4 e 128');

check(eq(P.pixelColorToRgba('#FF0000'), RED), 'colore literal #RRGGBB');
check(eq(P.pixelColorToRgba('#f00'), RED), 'colore literal #RGB espanso');
check(eq(P.pixelColorToRgba('#FF000080').slice(0, 3), [255, 0, 0])
      && P.pixelColorToRgba('#FF000080')[3] === 128, 'colore #RRGGBBAA con alpha');
check(eq(P.pixelColorToRgba('-'), NADA) && eq(P.pixelColorToRgba('none'), NADA),
      'il colore trasparente e\' davvero trasparente');
check(eq(P.pixelColorToRgba('a', { a: '#FF0000' }), RED), 'chiave di palette risolta');
// La palette vince sul literal: una chiave chiamata "f00" deve restare una chiave.
check(eq(P.pixelColorToRgba('f00', { f00: '#0000FF' }), BLU),
      'la palette ha la precedenza sul literal');

// --- fill / ordine degli strati ---------------------------------------------
let { buf, w } = run(['fill 0 0 7 7 a', 'fill 2 2 3 3 b'],
                     { palette: { a: '#FF0000', b: '#0000FF' } });
check(eq(at(buf, w, 0, 0), RED) && eq(at(buf, w, 7, 7), RED), 'fill copre tutta la tela');
check(eq(at(buf, w, 2, 2), BLU) && eq(at(buf, w, 3, 3), BLU),
      'il comando successivo sovrascrive il precedente');
check(eq(at(buf, w, 4, 4), RED), 'fuori dal secondo fill resta il primo');

({ buf, w } = run(['fill 3 3 3 3 a'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 3, 3), RED) && eq(at(buf, w, 3, 4), NADA),
      'fill di un solo pixel');

// Angoli invertiti: un LLM li scrive spesso al contrario.
({ buf, w } = run(['fill 5 5 1 1 a'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 1, 1), RED) && eq(at(buf, w, 5, 5), RED),
      'angoli invertiti normalizzati');

// --- origine in alto a sinistra ---------------------------------------------
({ buf, w } = run(['fill 0 0 7 0 a'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 0, 0), RED) && eq(at(buf, w, 0, 7), NADA),
      'y=0 e\' la riga in ALTO (origine in alto a sinistra)');

// --- rect / line / set / del -------------------------------------------------
({ buf, w } = run(['rect 1 1 6 6 a'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 1, 1), RED) && eq(at(buf, w, 6, 6), RED)
      && eq(at(buf, w, 3, 1), RED) && eq(at(buf, w, 1, 3), RED),
      'rect disegna il contorno');
check(eq(at(buf, w, 3, 3), NADA), 'rect NON riempie l\'interno');

({ buf, w } = run(['line 0 0 7 7 a'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 0, 0), RED) && eq(at(buf, w, 4, 4), RED) && eq(at(buf, w, 7, 7), RED),
      'line traccia la diagonale');
check(eq(at(buf, w, 0, 7), NADA), 'line non sporca fuori dal tracciato');

({ buf, w } = run(['set a 1 1 3 5 6 2'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 1, 1), RED) && eq(at(buf, w, 3, 5), RED) && eq(at(buf, w, 6, 2), RED),
      'set dipinge pixel sparsi dello stesso colore');
check(eq(at(buf, w, 2, 2), NADA), 'set non dipinge altro');

// Coordinata spaiata in coda: una risposta troncata non deve buttare via l'op.
({ buf, w } = run(['set a 1 1 3 5 6'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 1, 1), RED) && eq(at(buf, w, 3, 5), RED),
      'set con coordinata spaiata finale: il resto resta');

({ buf, w } = run(['fill 0 0 7 7 a', 'del 2 2 5 5'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 3, 3), NADA) && eq(at(buf, w, 0, 0), RED),
      'del rende trasparente (buca la texture)');
({ buf, w } = run(['fill 0 0 7 7 a', 'fill 2 2 5 5 -'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 3, 3), NADA), 'il colore `-` buca come del');

// Il pixel trasparente SOSTITUISCE, non fonde: dipingere opaco su semitrasparente
// darebbe altrimenti una tinta mista (stessa ragione del clearRect in artPaintCell).
({ buf, w } = run(['fill 0 0 7 7 #FF000080', 'fill 0 0 7 7 #0000FF'], {}));
check(eq(at(buf, w, 0, 0), BLU), 'il colore opaco sostituisce, non fonde');

// --- ritaglio ai bordi -------------------------------------------------------
let res = run(['fill -5 -5 100 100 a'], { palette: { a: '#FF0000' } });
check(eq(at(res.buf, res.w, 0, 0), RED) && eq(at(res.buf, res.w, 7, 7), RED),
      'fill oltre i bordi viene ritagliato, non scartato');
res = run(['fill 20 20 30 30 a'], { palette: { a: '#FF0000' } });
check(res.r.painted.all === 0, 'op interamente fuori tela non dipinge nulla');
check((res.r.warnings || []).length > 0, 'op fuori tela segnalata');

// Il contorno si calcola sui bordi RICHIESTI: un rect che sborda deve PERDERE
// il lato esterno, non disegnarne uno finto sul bordo della tela.
res = run(['rect -3 1 6 6 a'], { palette: { a: '#FF0000' } });
check(eq(at(res.buf, res.w, 0, 3), NADA),
      'rect che sborda non inventa un lato sul bordo della tela');
check(eq(at(res.buf, res.w, 6, 3), RED), 'rect che sborda tiene il lato interno');

// --- mirror ------------------------------------------------------------------
({ buf, w } = run(['fill 0 0 1 7 a', 'mirror x'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 6, 0), RED) && eq(at(buf, w, 7, 0), RED),
      'mirror x ribalta la meta\' sinistra sulla destra');
check(eq(at(buf, w, 3, 0), NADA), 'mirror x non tocca il centro vuoto');

({ buf, w } = run(['fill 0 0 7 1 a', 'mirror y'], { palette: { a: '#FF0000' } }));
check(eq(at(buf, w, 0, 6), RED) && eq(at(buf, w, 0, 7), RED),
      'mirror y ribalta la meta\' alta sul basso');

// Lato dispari: la colonna centrale resta com'e'.
res = P.expandPixelOps({ size: 7, palette: { a: '#FF0000' },
                         faces: { all: ['fill 0 0 2 6 a', 'mirror x'] } }, { size: 7 });
check(eq(at(res.faces.all, 7, 6, 0), RED) && eq(at(res.faces.all, 7, 3, 0), NADA),
      'mirror x su lato dispari lascia la colonna centrale');

// --- noise deterministico ----------------------------------------------------
const n1 = run(['fill 0 0 7 7 a', 'noise 0 0 7 7 b 0.5 7'],
               { palette: { a: '#FF0000', b: '#0000FF' } }).buf;
const n2 = run(['fill 0 0 7 7 a', 'noise 0 0 7 7 b 0.5 7'],
               { palette: { a: '#FF0000', b: '#0000FF' } }).buf;
const n3 = run(['fill 0 0 7 7 a', 'noise 0 0 7 7 b 0.5 21'],
               { palette: { a: '#FF0000', b: '#0000FF' } }).buf;
check(n1.every((v, i) => v === n2[i]),
      'noise con lo stesso seme e\' identico (la texture salvata si riproduce)');
check(!n3.every((v, i) => v === n1[i]), 'un seme diverso da\' una grana diversa');
let blues = 0;
for (let i = 0; i < 64; i++) if (n1[i * 4 + 2] === 255) blues++;
check(blues > 10 && blues < 54, 'densita\' 0.5 sparge circa meta\' pixel (%d/64)'.replace('%d', blues));
// Densita' scritta in percentuale: capita, e 50 non deve valere "5000%".
const nPct = run(['fill 0 0 7 7 a', 'noise 0 0 7 7 b 50 7'],
                 { palette: { a: '#FF0000', b: '#0000FF' } }).buf;
check(nPct.every((v, i) => v === n1[i]), 'densita\' > 1 letta come percentuale');

// --- forme di ingresso accettate ---------------------------------------------
const FORME = {
    'faces con lista di ops':
        [{ size: 8, faces: { px: ['fill 0 0 7 7 #FF0000'] } }, 'px'],
    'faces con oggetto {ops}':
        [{ size: 8, faces: { px: { ops: ['fill 0 0 7 7 #FF0000'] } } }, 'px'],
    'faces con stringa multiriga':
        [{ size: 8, faces: { px: 'fill 0 0 7 7 #FF0000\nrect 0 0 7 7 #0000FF' } }, 'px'],
    'ops alla radice -> all':
        [{ size: 8, ops: ['fill 0 0 7 7 #FF0000'] }, 'all'],
    'sinonimo comandi/facce':
        [{ size: 8, facce: { px: { comandi: ['fill 0 0 7 7 #FF0000'] } } }, 'px'],
    'sinonimi w/h':
        [{ w: 8, h: 8, faces: { px: ['fill 0 0 7 7 #FF0000'] } }, 'px'],
};
for (const [label, [data, key]] of Object.entries(FORME)) {
    const r = P.expandPixelOps(data, { size: 8 });
    check(r.faces[key] && r.painted[key] > 0, 'forma accettata: ' + label);
}

// Palette dichiarata DENTRO la faccia: non e' la forma del prompt (li' e' una
// sola, e costa meno token), ma un LLM la produce lo stesso. Senza accettarla le
// chiavi non risolvono e la faccia torna vuota - che si legge come "non ha
// generato niente" invece che come una risposta scritta un po' diversa.
res = P.expandPixelOps({
    size: 8,
    faces: { px: { palette: { a: '#FF0000' }, ops: ['fill 0 0 7 7 a'] } },
}, { size: 8 });
check(eq(at(res.faces.px, 8, 0, 0), RED), 'palette dichiarata dentro la faccia');

// Le due palette si SOMMANO, e sulla stessa chiave vince la faccia: la comune
// resta utile per i colori condivisi senza doverli ripetere sei volte.
res = P.expandPixelOps({
    size: 8, palette: { a: '#FF0000', b: '#00FF00' },
    faces: { px: { palette: { b: '#0000FF' }, ops: ['fill 0 0 3 7 a', 'fill 4 0 7 7 b'] } },
}, { size: 8 });
check(eq(at(res.faces.px, 8, 0, 0), RED), 'la palette comune vale anche dentro la faccia');
check(eq(at(res.faces.px, 8, 5, 0), BLU), 'sulla stessa chiave vince la palette della faccia');

// ...e la palette di una faccia non deve sporcare le altre.
res = P.expandPixelOps({
    size: 8, palette: { a: '#FF0000' },
    faces: { px: { palette: { a: '#0000FF' }, ops: ['fill 0 0 7 7 a'] },
             nx: { ops: ['fill 0 0 7 7 a'] } },
}, { size: 8 });
check(eq(at(res.faces.px, 8, 0, 0), BLU) && eq(at(res.faces.nx, 8, 0, 0), RED),
      'la palette di una faccia non contagia le altre');

// Sei facce in una risposta sola, ognuna col suo disegno.
res = P.expandPixelOps({
    size: 8, palette: { a: '#FF0000', b: '#0000FF' },
    faces: { px: ['fill 0 0 7 7 a'], nx: ['fill 0 0 7 7 a'], py: ['fill 0 0 7 7 b'],
             ny: ['fill 0 0 7 7 b'], pz: ['fill 0 0 7 7 a'], nz: ['fill 0 0 7 7 a'] },
}, { size: 8 });
check(Object.keys(res.faces).length === 6, 'sei facce espanse in una risposta');
check(eq(at(res.faces.py, 8, 0, 0), BLU) && eq(at(res.faces.px, 8, 0, 0), RED),
      'ogni faccia ha il suo disegno indipendente');

// `painted` esiste perche' il chiamante non sovrascriva un disegno con una tela
// vuota: una faccia nominata ma non disegnata deve risultare a zero.
res = P.expandPixelOps({ size: 8, faces: { px: ['fill 0 0 7 7 #FF0000'], nx: [] } },
                       { size: 8 });
check(res.painted.px > 0 && !res.painted.nx,
      'painted distingue una faccia disegnata da una vuota');

// La dimensione del client vince su quella dichiarata dall'AI: la tela esiste
// gia' e ricampionarla perderebbe il disegno.
res = P.expandPixelOps({ size: 64, faces: { all: ['fill 0 0 7 7 #FF0000'] } },
                       { size: 8, forceSize: true });
check(res.w === 8 && res.h === 8, 'forceSize ignora la dimensione dichiarata dall\'AI');
res = P.expandPixelOps({ size: 32, faces: { all: ['fill 0 0 31 31 #FF0000'] } },
                       { size: 8 });
check(res.w === 32, 'senza forceSize vale la dimensione dichiarata dall\'AI');

// Tetto al numero di comandi, condiviso fra le facce: una lista assurda viene
// troncata invece di girare a lungo. Il costo in PIXEL e' gia' limitato dal
// ritaglio (ogni op scrive al massimo w*h), quindi il conto giusto e' sulle ops.
const TROPPE = P.PIXEL_OPS_MAX + 500;
res = P.expandPixelOps({
    size: 8,
    faces: { px: Array(TROPPE).fill('fill 0 0 0 0 #FF0000'),
             nx: ['fill 0 0 7 7 #0000FF'] },
}, { size: 8 });
check((res.warnings || []).some(x => /^truncated/.test(x)),
      'lista di comandi assurda troncata e segnalata');
check(!res.painted.nx,
      'il budget e\' condiviso: esaurito su una faccia, si ferma anche sulle altre');

// ...ma un `fill` che sborda enormemente NON e' un caso da budget: viene
// ritagliato e costa quanto la tela.
res = P.expandPixelOps({ size: 8, faces: { all: ['fill -9999 -9999 9999 9999 #FF0000'] } },
                       { size: 8 });
check(res.painted.all === 64 && !(res.warnings || []).some(x => /^truncated/.test(x)),
      'un fill enorme viene ritagliato alla tela, non troncato');

// Ingressi degeneri: niente eccezioni, la tela resta vuota.
for (const [label, data] of Object.entries({
    'null': null, 'stringa': 'ciao', 'array': [1, 2, 3],
    'oggetto vuoto': {}, 'faces vuoto': { faces: {} },
    'ops non stringhe': { faces: { all: [null, 7, {}] } },
})) {
    let threw = false, out = null;
    try { out = P.expandPixelOps(data, { size: 8 }); } catch (e) { threw = true; }
    check(!threw && out && typeof out.faces === 'object',
          'ingresso degenere non solleva: ' + label);
}

// --- cancellazione totale in coda (`wipeDropped`) -----------------------------
// L'AI chiude spesso con un `del` che copre l'intera tela, credendo di "pulire
// lo sfondo trasparente": il risultato e' una tela VUOTA. Misurato: 2 risposte
// vere su 12. Il testo del prompt da solo non e' bastato (successo due volte in
// due tornate), quindi lo scarto e' strutturale. Un `del` totale con del disegno
// DOPO e' invece un ricominciare legittimo e va conservato.
// `painted` conta i pixel TOCCATI dalle ops (anche da un `del`), quindi qui la
// misura giusta e' quanti pixel restano opachi alla fine.
const opachi = (b) => { let n = 0; for (let i = 3; i < b.length; i += 4) if (b[i]) n++; return n; };

res = P.expandPixelOps({ size: 8, palette: { a: '#FF0000' },
                         faces: { all: ['fill 1 1 6 6 a', 'del 0 0 7 7'] } }, { size: 8 });
check(opachi(res.faces.all) === 36,
      'un `del` totale in coda viene scartato invece di svuotare la tela');
check((res.warnings || []).includes('wipeDropped'),
      'lo scarto e\' segnalato con un CODICE, non con una frase');

res = P.expandPixelOps({ size: 8, palette: { a: '#FF0000' },
                         faces: { all: ['fill 1 1 6 6 a', 'fill 0 0 7 7 -'] } }, { size: 8 });
check(opachi(res.faces.all) === 36,
      'anche un `fill` col colore trasparente sull\'intera tela e\' una cancellazione');

res = P.expandPixelOps({ size: 8, palette: { a: '#FF0000' },
                         faces: { all: ['fill 1 1 6 6 a', 'del 0 0 7 7', 'fill 2 2 5 5 a'] } },
                       { size: 8 });
check(opachi(res.faces.all) === 16 && !(res.warnings || []).includes('wipeDropped'),
      'un `del` totale con disegno DOPO e\' un ricominciare: si conserva');

// `mirror` non e' un comando che dipinge: un `del` totale seguito solo da
// `mirror` lascia comunque la tela vuota, quindi va scartato lo stesso.
res = P.expandPixelOps({ size: 8, palette: { a: '#FF0000' },
                         faces: { all: ['fill 0 1 3 6 a', 'del 0 0 7 7', 'mirror x'] } },
                       { size: 8 });
check(opachi(res.faces.all) > 0,
      '`mirror` dopo un `del` totale non salva la tela: il `del` va scartato');

// Un `del` parziale non e' una cancellazione totale: intagliare il profilo e'
// l'uso normale del comando e non deve sparire.
res = P.expandPixelOps({ size: 8, palette: { a: '#FF0000' },
                         faces: { all: ['fill 0 0 7 7 a', 'del 0 0 3 7'] } }, { size: 8 });
check(opachi(res.faces.all) === 32 && !(res.warnings || []).includes('wipeDropped'),
      'un `del` parziale resta intatto');

// La stessa difesa deve esistere nel gemello di PixelAIEditor: due copie che
// divergono darebbero risultati diversi a seconda di come l'editor e' aperto.
const gemello = fs.readFileSync(
    path.join(ROOT, 'PixelAIEditor/ui/src/lib/14-pixel-ops.js'), 'latin1');
for (const fn of ['pixelIsWipeOp', 'pixelOpPaints', 'pixelDropSuicidalOps']) {
    check(gemello.includes('function ' + fn + '('),
          'il gemello di PixelAIEditor ha anche lui ' + fn);
}
check(/pixelDropSuicidalOps\(/.test(gemello.split('function pixelDropSuicidalOps')[1] || ''),
      'nel gemello lo scarto e\' anche CHIAMATO, non solo definito');

// --- pixel -> RLE -> testo del contesto --------------------------------------
// Il giro completo: e' quello che rende possibile "usa le altre facce come
// contesto". Le chiavi del contesto sono le stesse che l'AI riusa in risposta.
res = run(['fill 0 0 7 7 a', 'fill 0 0 3 0 b'],
          { palette: { a: '#FF0000', b: '#0000FF' } });
let grid = P.pixelsToRleRows(res.buf, 8, 8);
check(grid.w === 8 && grid.h === 8 && grid.rows.length === 8,
      'RLE: una riga di testo per ogni riga di pixel');
check(Object.values(grid.palette).includes('#FF0000')
      && Object.values(grid.palette).includes('#0000FF'),
      'RLE: la palette raccoglie i colori trovati');
const keyOf = hex => Object.keys(grid.palette).find(k => grid.palette[k] === hex);
check(grid.rows[0] === '4' + keyOf('#0000FF') + '4' + keyOf('#FF0000'),
      'RLE: le sequenze diventano <n><chiave> (riga 0: ' + grid.rows[0] + ')');
check(grid.rows[1] === '8' + keyOf('#FF0000'), 'RLE: riga uniforme in 2 caratteri');

// Il trasparente ha il suo carattere: le parti invisibili sono normali in una
// texture e l'AI deve poterle vedere nel contesto.
res = run(['fill 0 0 7 7 a', 'del 0 0 7 0'], { palette: { a: '#FF0000' } });
grid = P.pixelsToRleRows(res.buf, 8, 8);
check(grid.rows[0] === '8.', 'RLE: il trasparente e\' il punto');
check(!Object.values(grid.palette).includes('#000000'),
      'RLE: il trasparente non entra in palette come nero');

// Riga irregolare: degrada nella griglia di caratteri, senza contatori a 1.
res = run(['set a 0 0 2 0 4 0'], { palette: { a: '#FF0000' } });
grid = P.pixelsToRleRows(res.buf, 8, 8);
check(!/1[a-z.]/.test(grid.rows[0]) && grid.rows[0].length === 8 - 0 + 0
      || !/1/.test(grid.rows[0]),
      'RLE: il contatore 1 e\' omesso (riga: ' + grid.rows[0] + ')');

// Tetto ai colori: oltre il massimo si ricade sul colore piu' vicino invece di
// esaurire l'alfabeto o buttare via la riga.
const many = new Uint8ClampedArray(8 * 8 * 4);
for (let i = 0; i < 64; i++) {
    many[i * 4] = i * 4; many[i * 4 + 1] = 10; many[i * 4 + 2] = 10; many[i * 4 + 3] = 255;
}
grid = P.pixelsToRleRows(many, 8, 8, { maxColors: 4 });
check(Object.keys(grid.palette).length <= 4, 'RLE: tetto ai colori rispettato');
check(grid.rows.every(r => r.length > 0), 'RLE: nessuna riga persa oltre il tetto');

// Il blocco di testo per il prompt.
res = run(['fill 0 0 7 7 a'], { palette: { a: '#FF0000' } });
const block = P.pixelContextBlock('px', P.pixelsToRleRows(res.buf, 8, 8));
check(block.includes('px') && block.includes('8x8') && block.includes('#FF0000'),
      'il blocco di contesto dichiara faccia, dimensione e palette');
check(block.split('\n').length >= 8 + 2,
      'il blocco di contesto contiene tutte le righe di pixel');

if (fails) {
    console.log('\n' + fails + ' CHECK FALLITI');
    process.exit(1);
}
console.log('\nTUTTI I CHECK OK');
