            // ===== OPS COMPATTE 2D (pixel art) =====
            // Frammento dello scope condiviso (vedi ui/build.mjs): nessun import/export.
            //
            // Stesso concetto delle ops dei voxel (src/parser.py `expand_ops`), ma su
            // un piano: l'AI descrive una texture con una manciata di comandi invece di
            // elencare i pixel. Una tela 32x32 sono 1024 pixel, cioe' ~4 KB di JSON
            // elencandoli; le stesse 32x32 in ops stanno in 300 byte. E' l'unico modo
            // per cui "genera 6 facce" non sfondi il budget di token della risposta.
            //
            // PERCHE' QUI E NON ANCHE IN PYTHON. Le ops dei voxel esistono in due
            // implementazioni (parser.py + expand-ops.js) perche' la coda pack le
            // espande sul server, e quella parita' e' costata tre difetti veri. Le ops
            // dei pixel non hanno un consumatore server-side: la tela vive nel browser,
            // quindi l'espansione sta SOLO qui e il backend si limita a validare la
            // forma della risposta (main.py: `normalize_pixel_data`). Nessuna parita'
            // da mantenere, per scelta.
            //
            // ORIGINE: (0,0) e' in ALTO A SINISTRA, x verso destra, y verso il BASSO.
            // E' la convenzione di ImageData e quella che un modello linguistico usa
            // spontaneamente per uno sprite: cambiarla capovolgerebbe ogni texture.

            // Sopra questo tetto la tela non e' piu' pixel art (e MATERIAL_TEXTURE_MAX
            // in 36-materials.js taglia comunque a 128 all'import).
            const PIXEL_OPS_MAX_SIDE = 128;
            const PIXEL_OPS_MIN_SIDE = 4;
            // Tetto al NUMERO DI COMANDI, condiviso fra tutte le facce di una
            // risposta. Il costo in pixel e' gia' limitato per costruzione, perche'
            // `pixelRectArgs` ritaglia ogni op alla tela: un `fill 0 0 9999 9999`
            // scrive al massimo w*h, non gira all'infinito come faceva l'analogo
            // sui voxel (`fill 0 0 0 299 299 299` = 27M celle). Quello che resta
            // illimitato e' la LUNGHEZZA della lista, ed e' questo a fermarla.
            const PIXEL_OPS_MAX = 20000;

            // Alfabeto delle chiavi di palette usato per DESCRIVERE una faccia
            // esistente (il contesto). '.' e' riservato al trasparente.
            const PIXEL_RLE_ALPHABET =
                'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+*';
            const PIXEL_RLE_TRANSPARENT = '.';

            function pixelClampSide(n, dflt) {
                const v = Math.round(Number(n));
                if (!isFinite(v)) return dflt;
                return Math.min(PIXEL_OPS_MAX_SIDE, Math.max(PIXEL_OPS_MIN_SIDE, v));
            }

            // Un colore delle ops -> [r,g,b,a]. Accetta la chiave di palette, il
            // letterale '#RRGGBB', '#RRGGBBAA' e le parole del trasparente.
            //
            // Il trasparente NON e' un colore ma non e' nemmeno un errore: e' il
            // pixel vuoto, e serve in ogni texture con parti invisibili (foglie,
            // vetro, una ringhiera). Tenerlo qui, come valore possibile di QUALUNQUE
            // op, evita un ramo dedicato: `set - 3 4` fa un foro sparso senza che
            // esista un'op "buca".
            function pixelColorToRgba(token, palette) {
                if (token === null || token === undefined) return null;
                let s = String(token).trim();
                if (!s) return null;
                if (s === '-' || s.toLowerCase() === 'none' || s === PIXEL_RLE_TRANSPARENT
                    || s.toLowerCase() === 'trasparente' || s.toLowerCase() === 'transparent') {
                    return [0, 0, 0, 0];
                }
                // Chiave di palette: risolta PRIMA del letterale, cosi' una palette che
                // mappa 'a' -> '#...' vince su un'interpretazione fantasiosa.
                if (palette && Object.prototype.hasOwnProperty.call(palette, s)) {
                    const mapped = palette[s];
                    // La palette puo' dichiarare il trasparente per una sua chiave.
                    if (mapped === null || mapped === undefined) return [0, 0, 0, 0];
                    s = String(mapped).trim();
                    if (s === '-' || s.toLowerCase() === 'none') return [0, 0, 0, 0];
                }
                if (s[0] !== '#') return null;
                const hex = s.slice(1);
                if (!/^[0-9A-Fa-f]+$/.test(hex)) return null;
                if (hex.length === 3) {
                    return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16),
                        parseInt(hex[2] + hex[2], 16), 255];
                }
                if (hex.length === 6) {
                    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16),
                        parseInt(hex.slice(4, 6), 16), 255];
                }
                if (hex.length === 8) {
                    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16),
                        parseInt(hex.slice(4, 6), 16), parseInt(hex.slice(6, 8), 16)];
                }
                return null;
            }

            // Scrive un pixel SOSTITUENDO il canale alpha invece di fondere: due ops
            // sovrapposte si comportano come due ops di voxel (l'ultima vince), e
            // dipingere un colore pieno sopra un pixel semitrasparente non lascia una
            // tinta mista. E' la stessa ragione del clearRect in `artPaintCell`.
            function pixelPut(buf, w, h, x, y, rgba) {
                if (x < 0 || y < 0 || x >= w || y >= h) return 0;
                const i = (y * w + x) * 4;
                buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
                return 1;
            }

            function pixelSpan(buf, w, h, x0, x1, y, rgba) {
                let n = 0;
                for (let x = x0; x <= x1; x++) n += pixelPut(buf, w, h, x, y, rgba);
                return n;
            }

            // Linea di Bresenham. `line` esiste anche fra le ops dei voxel e li' passa
            // per l'asse dominante: qui il caso e' 2D e Bresenham e' esatto, quindi non
            // c'e' una semantica da tenere allineata a Python (vedi il commento in testa).
            function pixelLine(buf, w, h, x0, y0, x1, y1, rgba) {
                let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
                let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
                let err = dx - dy, n = 0, guard = (dx + dy + 2) * 2;
                let x = x0, y = y0;
                while (guard-- > 0) {
                    n += pixelPut(buf, w, h, x, y, rgba);
                    if (x === x1 && y === y1) break;
                    const e2 = 2 * err;
                    if (e2 > -dy) { err -= dy; x += sx; }
                    if (e2 < dx) { err += dx; y += sy; }
                }
                return n;
            }

            // Le coordinate arrivano da un LLM: possono essere float, invertite
            // (x1 < x0) o fuori tela. Si normalizzano invece di scartare l'op, perche'
            // un rettangolo con gli angoli scambiati e' chiaramente inteso e scartarlo
            // lascerebbe un buco nella texture senza dire perche'.
            function pixelRectArgs(a, b, c, d, w, h) {
                const n = v => Math.round(Number(v));
                let x0 = n(a), y0 = n(b), x1 = n(c), y1 = n(d);
                if (![x0, y0, x1, y1].every(isFinite)) return null;
                if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
                if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
                if (x1 < 0 || y1 < 0 || x0 >= w || y0 >= h) return null;   // interamente fuori
                return { x0: Math.max(0, x0), y0: Math.max(0, y0),
                    x1: Math.min(w - 1, x1), y1: Math.min(h - 1, y1) };
            }

            // Applica UNA op sul buffer RGBA. Ritorna il numero di pixel scritti
            // (0 = op inutile: serve a distinguere "risposta vuota" da "risposta
            // sbagliata", che e' l'unico modo di dire all'utente cosa e' andato storto).
            //
            // Gli avvisi sono CODICI, non frasi: questo modulo non ha DOM e non sa
            // che lingua parla l'utente, quindi una frase italiana qui sarebbe testo
            // per l'utente scritto nel posto sbagliato (la guardia i18n la conta, ed
            // ha ragione). Il codice e' la prima parola; cio' che segue e' il dato
            // grezzo (il comando, il nome del colore) e non va tradotto.
            function applyPixelOp(op, buf, w, h, palette, warnings) {
                if (typeof op !== 'string') return 0;
                const parts = op.trim().split(/[\s,]+/).filter(s => s.length);
                if (!parts.length) return 0;
                const cmd = parts[0].toLowerCase();
                const bad = msg => { if (warnings && warnings.length < 20) warnings.push(msg); return 0; };

                if (cmd === 'del') {
                    const r = pixelRectArgs(parts[1], parts[2], parts[3], parts[4], w, h);
                    if (!r) return bad('badCoords ' + op);
                    let n = 0;
                    for (let y = r.y0; y <= r.y1; y++) n += pixelSpan(buf, w, h, r.x0, r.x1, y, [0, 0, 0, 0]);
                    return n;
                }

                if (cmd === 'set') {
                    const rgba = pixelColorToRgba(parts[1], palette);
                    if (!rgba) return bad('badColor ' + cmd + ' ' + parts[1]);
                    let n = 0;
                    // Coppie x y. Un numero spaiato in coda viene ignorato: e' l'errore
                    // tipico di una risposta troncata, e scartare tutta l'op perderebbe
                    // le coppie buone che la precedono.
                    for (let i = 2; i + 1 < parts.length; i += 2) {
                        const x = Math.round(Number(parts[i])), y = Math.round(Number(parts[i + 1]));
                        if (isFinite(x) && isFinite(y)) n += pixelPut(buf, w, h, x, y, rgba);
                    }
                    return n;
                }

                const rgba = pixelColorToRgba(parts[5], palette);
                if (cmd === 'fill' || cmd === 'rect' || cmd === 'line') {
                    if (!rgba) return bad('badColor ' + cmd + ' ' + parts[5]);
                }

                if (cmd === 'fill') {
                    const r = pixelRectArgs(parts[1], parts[2], parts[3], parts[4], w, h);
                    if (!r) return bad('badCoords ' + op);
                    let n = 0;
                    for (let y = r.y0; y <= r.y1; y++) n += pixelSpan(buf, w, h, r.x0, r.x1, y, rgba);
                    return n;
                }

                if (cmd === 'rect') {
                    // Il contorno si ricava dai bordi RICHIESTI, non da quelli tagliati:
                    // un rettangolo che esce dalla tela deve perdere il lato fuori, non
                    // disegnarlo appiccicato al bordo (sarebbe una cornice inventata).
                    const nn = v => Math.round(Number(v));
                    let x0 = nn(parts[1]), y0 = nn(parts[2]), x1 = nn(parts[3]), y1 = nn(parts[4]);
                    if (![x0, y0, x1, y1].every(isFinite)) return bad('badCoords ' + op);
                    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
                    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
                    let n = 0;
                    for (let x = x0; x <= x1; x++) {
                        n += pixelPut(buf, w, h, x, y0, rgba);
                        n += pixelPut(buf, w, h, x, y1, rgba);
                    }
                    for (let y = y0 + 1; y <= y1 - 1; y++) {
                        n += pixelPut(buf, w, h, x0, y, rgba);
                        n += pixelPut(buf, w, h, x1, y, rgba);
                    }
                    return n;
                }

                if (cmd === 'line') {
                    const nn = v => Math.round(Number(v));
                    const x0 = nn(parts[1]), y0 = nn(parts[2]), x1 = nn(parts[3]), y1 = nn(parts[4]);
                    if (![x0, y0, x1, y1].every(isFinite)) return bad('badCoords ' + op);
                    return pixelLine(buf, w, h, x0, y0, x1, y1, rgba);
                }

                if (cmd === 'mirror') return applyPixelMirror(parts[1], buf, w, h);
                if (cmd === 'noise') return applyPixelNoise(parts, buf, w, h, palette, warnings);
                return bad('unknownCmd ' + cmd);
            }
            // `mirror x` ribalta la META' SINISTRA sulla destra, `mirror y` la meta'
            // alta sul basso. Una texture simmetrica (mattoni, un volto, una porta) si
            // descrive cosi' con meta' delle ops, ed e' il risparmio piu' grande dopo
            // `fill`. Con lato dispari la colonna/riga centrale resta com'e'.
            //
            // Va applicata DOPO aver disegnato la meta' sorgente: opera sul buffer,
            // non sulla lista di ops, quindi vede tutto quello che la precede.
            function applyPixelMirror(axis, buf, w, h) {
                const a = String(axis || 'x').toLowerCase();
                let n = 0;
                if (a === 'x') {
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < Math.floor(w / 2); x++) {
                            const s = (y * w + x) * 4, d = (y * w + (w - 1 - x)) * 4;
                            buf[d] = buf[s]; buf[d + 1] = buf[s + 1];
                            buf[d + 2] = buf[s + 2]; buf[d + 3] = buf[s + 3];
                            n++;
                        }
                    }
                } else if (a === 'y') {
                    for (let y = 0; y < Math.floor(h / 2); y++) {
                        for (let x = 0; x < w; x++) {
                            const s = (y * w + x) * 4, d = ((h - 1 - y) * w + x) * 4;
                            buf[d] = buf[s]; buf[d + 1] = buf[s + 1];
                            buf[d + 2] = buf[s + 2]; buf[d + 3] = buf[s + 3];
                            n++;
                        }
                    }
                }
                return n;
            }

            // `noise x0 y0 x1 y1 colore densita [seme]` sparge un colore nel rettangolo.
            // Serve per pietra, terra, ruggine, legno: il dithering e' cio' che rende
            // una texture "di tutto rispetto" invece di una tinta piatta, e descriverlo
            // con `set` costerebbe due numeri per pixel (una 32x32 al 20% sono 200
            // coordinate, ~400 token per faccia).
            //
            // Il generatore e' un LCG con seme ESPLICITO, non Math.random: la stessa
            // risposta dell'AI deve ridare la stessa texture. Con un random vero,
            // riaprire il materiale (o rifare la build) darebbe un'immagine diversa da
            // quella che l'utente ha approvato.
            function applyPixelNoise(parts, buf, w, h, palette, warnings) {
                const r = pixelRectArgs(parts[1], parts[2], parts[3], parts[4], w, h);
                if (!r) {
                    if (warnings && warnings.length < 20) warnings.push('badCoords noise');
                    return 0;
                }
                const rgba = pixelColorToRgba(parts[5], palette);
                if (!rgba) {
                    if (warnings && warnings.length < 20) warnings.push('badColor noise ' + parts[5]);
                    return 0;
                }
                let d = Number(parts[6]);
                if (!isFinite(d)) d = 0.25;
                if (d > 1) d = d / 100;                       // "30" inteso come 30%
                d = Math.min(1, Math.max(0, d));
                let seed = Math.round(Number(parts[7]));
                if (!isFinite(seed)) seed = 1;
                // Il seme entra nello stato: seed 0 con un LCG puro resterebbe 0.
                let s = (seed * 1103515245 + 12345) & 0x7fffffff;
                const next = () => {
                    s = (s * 1103515245 + 12345) & 0x7fffffff;
                    return s / 0x7fffffff;
                };
                let n = 0;
                for (let y = r.y0; y <= r.y1; y++) {
                    for (let x = r.x0; x <= r.x1; x++) {
                        if (next() < d) n += pixelPut(buf, w, h, x, y, rgba);
                    }
                }
                return n;
            }

            // Una op che rende TRASPARENTE l'intera faccia: `del` che la copre
            // tutta, o un `fill` a colore trasparente altrettanto largo. Il
            // riconoscimento e' volutamente stretto (deve coprire TUTTO): una
            // `del` parziale e' un intaglio legittimo del profilo, e scartarla
            // toglierebbe all'AI il suo unico modo di sottrarre.
            function pixelIsWipeOp(op, w, h, palette) {
                if (typeof op !== 'string') return false;
                const p = op.trim().split(/[\s,]+/).filter((s) => s.length);
                const cmd = (p[0] || '').toLowerCase();
                if (cmd !== 'del' && cmd !== 'fill') return false;
                if (cmd === 'fill') {
                    const rgba = pixelColorToRgba(p[5], palette);
                    if (!rgba || rgba[3] !== 0) return false;
                }
                const n = (v) => Math.round(Number(v));
                let x0 = n(p[1]), y0 = n(p[2]), x1 = n(p[3]), y1 = n(p[4]);
                if (![x0, y0, x1, y1].every(isFinite)) return false;
                if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
                if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
                return x0 <= 0 && y0 <= 0 && x1 >= w - 1 && y1 >= h - 1;
            }

            // L'op aggiunge colore? Solo i comandi che dipingono, e solo con un
            // colore OPACO: `fill ... -` toglie invece di aggiungere, e `mirror`
            // copia cio' che gia' c'e'.
            function pixelOpPaints(op, palette) {
                if (typeof op !== 'string') return false;
                const p = op.trim().split(/[\s,]+/).filter((s) => s.length);
                const cmd = (p[0] || '').toLowerCase();
                if (cmd !== 'fill' && cmd !== 'rect' && cmd !== 'line'
                    && cmd !== 'set' && cmd !== 'noise') return false;
                const rgba = pixelColorToRgba(cmd === 'set' ? p[1] : p[5], palette);
                return !!rgba && rgba[3] !== 0;
            }

            // Scarta le cancellazioni totali che NESSUNA pennellata segue.
            //
            // L'AI chiude spesso con `del 0 0 W-1 H-1` credendo di "ripulire lo
            // sfondo trasparente" - ma le ops si applicano in ordine su un
            // buffer, quindi quella cancella il disegno appena fatto e la faccia
            // torna VUOTA. Stesso esito con `del` totale seguito solo da
            // `mirror`, che copia il vuoto. Misurato con l'AI vera: due risposte
            // su dodici finivano cosi', ed e' il difetto peggiore, perche' una
            // faccia vuota non si distingue da "non ha generato niente".
            //
            // Una `del` totale con un vero disegno DOPO non si tocca: li' e' un
            // "riparti da capo" legittimo, ed e' la ragione per cui la regola
            // non puo' essere "vietato cancellare tutto".
            function pixelDropSuicidalOps(ops, w, h, palette, warnings) {
                const paintsAfter = [];
                let seen = false;
                for (let i = ops.length - 1; i >= 0; i--) {
                    paintsAfter[i] = seen;
                    if (pixelOpPaints(ops[i], palette)) seen = true;
                }
                const kept = ops.filter((op, i) =>
                    !(pixelIsWipeOp(op, w, h, palette) && !paintsAfter[i]));
                if (kept.length !== ops.length && warnings && warnings.length < 20) {
                    warnings.push('wipeDropped');
                }
                return kept;
            }

            // Espande la risposta dell'AI in un buffer RGBA per faccia.
            //
            // Forme accettate (un LLM ne produce piu' di una, e rifiutarle costerebbe
            // una rigenerazione all'utente per una virgola):
            //   { size, palette, faces: { px: ["fill ..."], ... } }
            //   { size, palette, faces: { px: { ops: [...] }, ... } }
            //   { size, palette, ops: [...] }            -> texture unica ('all')
            //   { size, palette, faces: { all: [...] } }  -> idem
            //
            // Ritorna { w, h, faces: { chiave: Uint8ClampedArray }, painted: {...},
            // warnings: [] }. `painted` per faccia serve a chi chiama per NON
            // sovrascrivere una faccia con una tela vuota: una risposta che nomina
            // una faccia e poi non ci disegna niente cancellerebbe il disegno
            // esistente, che e' peggio di non aver generato.
            // `warnings` sono codici (vedi applyPixelOp), non frasi da mostrare.
            function expandPixelOps(data, opts) {
                const o = opts || {};
                const warnings = [];
                if (!data || typeof data !== 'object') {
                    return { w: 0, h: 0, faces: {}, painted: {}, warnings: ['emptyAnswer'] };
                }
                const dflt = pixelClampSide(o.size, 16);
                let w = pixelClampSide(data.w || data.width || data.size, dflt);
                let h = pixelClampSide(data.h || data.height || data.size, dflt);
                // Se il chiamante impone la dimensione (la tela esiste gia' e le altre
                // facce sono di quel lato) si ignora quella dichiarata dall'AI: mescolare
                // facce di lati diversi sullo stesso cubo si vede come una texture
                // "che non si e' caricata" su una faccia sola.
                if (o.forceSize) { w = pixelClampSide(o.size, dflt); h = w; }

                const palette = {};
                const rawPal = data.palette || data.colors || data.colori;
                if (rawPal && typeof rawPal === 'object') {
                    Object.keys(rawPal).forEach(k => { palette[k] = rawPal[k]; });
                }

                let rawFaces = data.faces || data.facce || null;
                if (!rawFaces) {
                    const ops = data.ops || data.comandi || null;
                    rawFaces = ops ? { all: ops } : {};
                }

                const faces = {}, painted = {};
                let budget = PIXEL_OPS_MAX;
                Object.keys(rawFaces).forEach(rawKey => {
                    const key = String(rawKey).trim().toLowerCase();
                    let entry = rawFaces[rawKey];
                    // Una faccia puo' dichiarare una palette PROPRIA, che si somma a
                    // quella comune (la faccia vince sulle chiavi omonime). Non e'
                    // nel prompt - li' la palette e' una sola, e costa meno token -
                    // ma e' fra le forme che un LLM produce da se', e senza questo
                    // ramo le sue chiavi non risolvono: le ops non dipingono nulla e
                    // la faccia torna VUOTA, che si legge come "non ha generato
                    // niente" invece che come una risposta scritta un po' diversa.
                    let facePal = palette;
                    if (entry && !Array.isArray(entry) && typeof entry === 'object') {
                        const rp = entry.palette || entry.colors || entry.colori;
                        if (rp && typeof rp === 'object') {
                            facePal = Object.assign({}, palette, rp);
                        }
                        entry = entry.ops || entry.comandi || entry.list || null;
                    }
                    if (typeof entry === 'string') entry = entry.split('\n');
                    if (!Array.isArray(entry)) {
                        warnings.push('noOps ' + key);
                        return;
                    }
                    const buf = new Uint8ClampedArray(w * h * 4);   // tutto trasparente
                    const list = pixelDropSuicidalOps(entry, w, h, facePal, warnings);
                    let n = 0;
                    for (let i = 0; i < list.length; i++) {
                        if (budget-- <= 0) { warnings.push('truncated'); break; }
                        n += applyPixelOp(list[i], buf, w, h, facePal, warnings);
                    }
                    faces[key] = buf;
                    painted[key] = n;
                });

                return { w: w, h: h, faces: faces, painted: painted, warnings: warnings };
            }

            // --- descrizione di una faccia esistente (il contesto) --------------------
            // Il verso opposto: dai pixel a un testo che l'AI possa LEGGERE. Serve a
            // "usa le altre facce come contesto", che e' l'unico modo per cui la faccia
            // che si rigenera resti coerente con quelle gia' disegnate.
            //
            // Formato: una riga per riga di pixel, `<n><chiave>` con n omesso quando e'
            // 1. Su una riga uniforme costa 3 caratteri invece di 32; su una riga
            // irregolare degrada esattamente nella griglia di caratteri, che e' la
            // rappresentazione che un modello legge meglio. Un solo formato che si
            // adatta da se': niente scelta fra "griglia" e "compatto".
            //
            // Le chiavi sono LE STESSE che il modello deve riusare nella risposta,
            // quindi la palette del contesto e quella dell'output condividono
            // l'alfabeto e non c'e' una traduzione da inventare.
            function pixelsToRleRows(px, w, h, opts) {
                const o = opts || {};
                const maxKeys = Math.min(PIXEL_RLE_ALPHABET.length, o.maxColors || 48);
                const byHex = new Map();
                const palette = {};
                let used = 0;

                // Colore piu' vicino fra quelli GIA' battezzati: una foto importata ha
                // centinaia di tinte e l'alfabeto ne regge poche decine. Approssimare e'
                // giusto perche' questo testo e' contesto, non la texture: serve a far
                // capire "com'e' fatta la faccia accanto", non a ricostruirla.
                const nearest = (r, g, b) => {
                    let best = null, bestD = Infinity;
                    byHex.forEach((ch, hex) => {
                        const rr = parseInt(hex.slice(1, 3), 16), gg = parseInt(hex.slice(3, 5), 16),
                            bb = parseInt(hex.slice(5, 7), 16);
                        const d = (rr - r) * (rr - r) + (gg - g) * (gg - g) + (bb - b) * (bb - b);
                        if (d < bestD) { bestD = d; best = ch; }
                    });
                    return best;
                };

                const keyFor = (r, g, b, a) => {
                    if (a < 8) return PIXEL_RLE_TRANSPARENT;
                    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
                    const known = byHex.get(hex);
                    if (known) return known;
                    if (used >= maxKeys) return nearest(r, g, b) || PIXEL_RLE_TRANSPARENT;
                    const ch = PIXEL_RLE_ALPHABET[used++];
                    byHex.set(hex, ch);
                    palette[ch] = hex;
                    return ch;
                };

                const rows = [];
                for (let y = 0; y < h; y++) {
                    let out = '', runCh = null, runN = 0;
                    const flush = () => {
                        if (runCh === null) return;
                        out += (runN > 1 ? String(runN) : '') + runCh;
                    };
                    for (let x = 0; x < w; x++) {
                        const i = (y * w + x) * 4;
                        const ch = keyFor(px[i], px[i + 1], px[i + 2], px[i + 3]);
                        if (ch === runCh) { runN++; continue; }
                        flush();
                        runCh = ch; runN = 1;
                    }
                    flush();
                    rows.push(out);
                }
                return { w: w, h: h, palette: palette, rows: rows };
            }


            // Il testo che finisce nel prompt per UNA faccia di contesto. Compatto per
            // costruzione (vedi pixelsToRleRows): una 16x16 a tinta piatta sono ~60
            // caratteri, la stessa faccia elencata pixel per pixel ne sarebbe 1500.
            function pixelContextBlock(label, grid) {
                const lines = [];
                lines.push('FACCIA ' + label + ' (' + grid.w + 'x' + grid.h + '):');
                const pal = Object.keys(grid.palette)
                    .map(k => k + '=' + grid.palette[k]).join(' ');
                lines.push('  colori: ' + (pal || '(vuota)') + '  ' + PIXEL_RLE_TRANSPARENT + '=trasparente');
                grid.rows.forEach(r => lines.push('  ' + r));
                return lines.join('\n');
            }

            // Scrive un buffer RGBA espanso dentro un contesto 2D. `putImageData`
            // SOSTITUISCE i pixel invece di fonderli (a differenza di drawImage), che
            // e' esattamente cio' che serve: una texture generata con parti trasparenti
            // deve lasciare il buco, non far trasparire il disegno di prima.
            function pixelBufferToCtx(ctx, buf, w, h) {
                if (!ctx || !buf) return false;
                const img = ctx.createImageData(w, h);
                img.data.set(buf);
                ctx.putImageData(img, 0, 0);
                return true;
            }

            // Un buffer RGBA -> la forma {data,w,h,color,alpha} che i materiali si
            // aspettano (vedi textureFromCanvasCtx in 36-materials.js). Passa da un
            // canvas d'appoggio: e' l'unico modo di ottenere il PNG in base64, e
            // riusare la tela visibile costringerebbe a disegnarci sopra le facce che
            // non si stanno guardando.
            function pixelBufferToTexture(buf, w, h) {
                const cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                const ctx = cv.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                pixelBufferToCtx(ctx, buf, w, h);
                return textureFromCanvasCtx(cv, ctx);
            }
