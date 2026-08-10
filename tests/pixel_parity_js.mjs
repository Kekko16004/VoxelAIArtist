// Lato JS della parita' delle ops 2D: espande i casi condivisi con
// `expandPixelOps` (ui/src/lib/37-pixel-ops.js) e scrive i risultati per il lato
// Python, che li confronta con `mcp_server/pixelops.py` (vedi
// tests/pixel_parity_check.sh).
//
// PERCHE' ESISTE. Fino all'MCP le ops dei pixel avevano UN SOLO consumatore, il
// browser, e il commento in testa al modulo JS diceva "nessuna parita' da
// mantenere, per scelta". `mcp_server/pixelops.py` e' il secondo consumatore,
// quindi quella frase non vale piu': una modifica alla semantica di qua va fatta
// anche di la'. E' la stessa situazione delle ops dei voxel, dove la divergenza
// e' costata tre difetti veri (un `box` frazionario che in JS dava ZERO voxel,
// int() contro Math.round, l'arrotondamento del banchiere nella `line`).
//
// Il confronto e' sui PIXEL, non su un riassunto: si scrive un digest per faccia
// (dimensioni, painted, avvisi) PIU' il buffer intero in esadecimale. Un hash
// direbbe solo "diversi"; il buffer dice DOVE, e su una tela 8x8 costa poco.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Il modulo e' un frammento di scope condiviso (nessun import/export) e la sua
// CODA tocca il DOM (`pixelBufferToTexture` crea un canvas). Si carica come fa
// gia' tests/test_pixel_ops.mjs: dentro una funzione, con `document` e
// `textureFromCanvasCtx` passati come parametri. Servono anche se non li usiamo:
// senza, il modulo non arriva in fondo. Sorgente letta in latin1 come fa la build.
function loadPixelOps() {
    const src = fs.readFileSync(path.join(ROOT, 'ui/src/lib/37-pixel-ops.js'), 'latin1');
    const fakeDoc = {
        createElement: () => ({
            width: 0, height: 0,
            getContext: () => ({
                createImageData: (w, h) => ({w, h, data: new Uint8ClampedArray(w * h * 4)}),
                putImageData() {}, clearRect() {},
            }),
            toDataURL: () => 'data:image/png;base64,STUB',
        }),
    };
    const textureFromCanvasCtx = (cv) => ({data: cv.toDataURL(), w: cv.width, h: cv.height});
    return new Function('document', 'textureFromCanvasCtx', src + `
        ;return { expandPixelOps, PIXEL_OPS_MAX, PIXEL_OPS_MAX_SIDE, PIXEL_OPS_MIN_SIDE };
    `)(fakeDoc, textureFromCanvasCtx);
}

// Un'op puo' essere {repeat, op}: la espandono ENTRAMBI i lati prima di chiamare.
// Serve solo al caso del budget - 20000 ops scritte per esteso sarebbero ~400 KB
// di JSON, e un file di casi che non si puo' leggere non lo rilegge nessuno.
function inflate(value) {
    if (Array.isArray(value)) {
        const out = [];
        for (const item of value) {
            if (item && typeof item === 'object' && !Array.isArray(item)
                && typeof item.op === 'string' && item.repeat) {
                for (let i = 0; i < item.repeat; i++) out.push(item.op);
            } else {
                out.push(inflate(item));
            }
        }
        return out;
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) out[k] = inflate(value[k]);
        return out;
    }
    return value;
}

function hex(buf) {
    let s = '';
    for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, '0');
    return s;
}

const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/pixel_ops_parity_cases.json'), 'utf8'));
const cases = doc.cases;
const {expandPixelOps, PIXEL_OPS_MAX, PIXEL_OPS_MAX_SIDE, PIXEL_OPS_MIN_SIDE} = loadPixelOps();

const out = {};
for (const c of cases) {
    try {
        const r = expandPixelOps(inflate(c.data), inflate(c.opts || {}));
        const faces = {};
        for (const k of Object.keys(r.faces || {})) faces[k] = hex(r.faces[k]);
        out[c.name] = {
            w: r.w, h: r.h,
            // Le chiavi ordinate: l'ordine di iterazione di un oggetto JS e quello
            // di un dict Python coincidono qui (inserimento), ma farci affidamento
            // trasformerebbe un riordino innocuo in un fallimento di parita'.
            faces,
            painted: r.painted || {},
            warnings: (r.warnings || []).slice().sort(),
        };
    } catch (e) {
        out[c.name] = {error: String(e && e.message || e)};
    }
}

fs.writeFileSync(path.join(ROOT, 'tests/.js_pixel_out.json'), JSON.stringify({
    cases: cases.map(c => c.name),
    results: out,
    // Le tre costanti viaggiano insieme ai risultati: sono la parte della
    // semantica che NESSUN caso puo' esercitare da solo (il tetto sui lati si
    // vede solo ai due estremi, e il tetto sulle ops solo con 20000 di esse).
    constants: {
        PIXEL_OPS_MAX, PIXEL_OPS_MAX_SIDE, PIXEL_OPS_MIN_SIDE,
    },
}));
console.log('js pixel ok, casi:', cases.length);
