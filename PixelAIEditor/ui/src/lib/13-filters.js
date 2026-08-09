    // =======================================================================
    //  13 - Filtri e regolazioni
    //
    //  Quattro operazioni che riscrivono i pixel del LIVELLO ATTIVO: rimuovi
    //  sfondo, regolazioni colore, palette con dithering, contorno. Nessuna
    //  tocca il composito - un filtro che appiattisse cinque livelli per poter
    //  lavorare sarebbe un "appiattisci" travestito.
    //
    //  Tutte passano dalla stessa coppia: `getImageData` una volta,
    //  `putImageData` una volta. Non si disegna pixel per pixel col contesto
    //  perche' su una tela grande sarebbero milioni di `fillRect`, e non si usa
    //  `putPixel` (che filtra da solo la selezione) perche' qui la selezione si
    //  applica saltando gli indici non selezionati: il buffer si riscrive
    //  INTERO, e i pixel saltati ci tornano identici a come erano.
    //
    //  I pixel completamente trasparenti restano fuori da tutto. Il loro RGB e'
    //  arbitrario (il canvas non lo conserva dopo un clearRect), quindi
    //  entrerebbero nei calcoli come un nero che nessuno vede: inquinerebbe i
    //  cluster della palette e farebbe comparire colore dove c'e' il vuoto.
    // =======================================================================

    // Campioni per il calcolo della palette. Oltre questa soglia si campiona a
    // passo: il median cut non ha bisogno di ogni pixel per sapere dove stanno
    // i colori, e su 4096x4096 la differenza e' fra un istante e dieci secondi.
    const PALETTE_SAMPLE_MAX = 60000;

    // Matrice di Bayer 4x4 (ordine classico). E' una SOGLIA per pixel, quindi
    // il risultato non dipende dai vicini: si puo' calcolare in qualunque
    // ordine, a differenza della diffusione dell'errore.
    const BAYER4 = [
        0, 8, 2, 10,
        12, 4, 14, 6,
        3, 11, 1, 9,
        15, 7, 13, 5,
    ];

    // Buffer condivisi per la conversione HSL: due oggetti per pixel sarebbero
    // due milioni di allocazioni per ogni movimento di uno slider.
    const _hsl = [0, 0, 0];
    const _rgb = [0, 0, 0];

    /** La maschera se e' davvero installata, altrimenti null (= tutto libero). */
    function filterMask() { return selActive() ? selMask : null; }

    /**
     * Butta l'ultimo snapshot: serve quando un filtro, applicato, non ha
     * cambiato NIENTE (nessun pixel di sfondo trovato, nessun contorno da
     * disegnare). Lasciarlo lascerebbe un Ctrl+Z che non fa nulla, e l'utente
     * lo premerebbe due volte perdendo anche l'operazione di prima.
     *
     * Si passa da `snapshotBytes` invece di fare solo `pop()`: il budget della
     * cronologia e' contato in byte, e uno snapshot tolto senza scalarne il peso
     * farebbe scartare in anticipo annullamenti buoni.
     */
    function dropLastSnapshot() {
        if (!history.past.length) return;
        history.bytes -= snapshotBytes(history.past.pop());
        refreshHistoryUI();
    }

    // =======================================================================
    //  Rimuovi sfondo
    // =======================================================================

    /**
     * "Solo dal bordo" e' acceso di default e non e' un dettaglio.
     *
     * Un confronto globale toglie OGNI pixel simile al colore scelto, ovunque
     * sia: togliendo un cielo azzurro si bucano anche gli occhi azzurri del
     * personaggio, e il buco si nota solo dopo, a disegno finito. La
     * propagazione dai quattro bordi toglie solo cio' che e' ATTACCATO
     * all'esterno, che e' la definizione operativa di "sfondo". Il confronto
     * globale resta offerto perche' su una sprite gia' ritagliata, dove lo
     * sfondo e' a chiazze staccate fra loro, e' l'unico che le prenda tutte.
     *
     * `feather` sfuma: oltre la tolleranza c'e' una banda in cui l'alpha scende
     * invece di spegnersi di colpo. Serve alle immagini con i bordi antialiasati
     * (una foto, un PNG scalato), dove il taglio netto lascia un alone del
     * colore vecchio tutto attorno alla figura.
     */
    function removeBackground(hex, tol, edgeOnly, feather) {
        const w = doc.w, h = doc.h, n = w * h;
        const g = activeLayer().ctx;
        const img = g.getImageData(0, 0, w, h);
        const d = img.data;
        const c = hexToRgb(hex) || { r: 255, g: 255, b: 255 };
        const sel = filterMask();
        const band = feather ? Math.max(8, Math.round(tol * 0.5)) : 0;
        const limit = tol + band;
        let touched = 0;

        // Il pixel gia' trasparente non si conta e non si tocca: sarebbe un
        // "cambiamento" da zero a zero che gonfia il resoconto finale.
        const fade = (i, dist) => {
            const o = i * 4;
            if (d[o + 3] === 0) return 0;
            const f = dist <= tol ? 0 : (band > 0 && dist < limit ? (dist - tol) / band : 1);
            if (f >= 1) return 0;
            d[o + 3] = Math.round(d[o + 3] * f);
            return 1;
        };

        if (!edgeOnly) {
            for (let i = 0; i < n; i++) {
                if (sel && !sel[i]) continue;
                const o = i * 4;
                if (d[o + 3] === 0) continue;
                touched += fade(i, rgbaDistance(d, o, c.r, c.g, c.b, 255));
            }
        } else {
            // Propagazione con pila esplicita, come `floodRegion`: la ricorsione
            // su una tela grande e monocroma sfonda lo stack e l'operazione
            // fallisce a meta', lasciando un risultato che sembra un difetto
            // del disegno.
            const seen = new Uint8Array(n);
            const stack = [];
            const visit = (x, y) => {
                if (x < 0 || y < 0 || x >= w || y >= h) return;
                const i = y * w + x;
                if (seen[i]) return;
                seen[i] = 1;
                // Fuori dalla selezione il fondo non passa: la selezione e' una
                // protezione, e un fondo che la attraversasse la renderebbe
                // decorativa.
                if (sel && !sel[i]) return;
                const o = i * 4;
                // Il gia' trasparente e' fondo per definizione e deve lasciar
                // passare: e' il caso di una sprite gia' scontornata a meta'.
                const dist = (d[o + 3] === 0) ? 0 : rgbaDistance(d, o, c.r, c.g, c.b, 255);
                if (dist > limit) return;
                touched += fade(i, dist);
                // Dentro la banda di sfumatura si tinge ma NON si propaga: e' il
                // bordo, e propagarci sopra mangerebbe la figura di un pixel per
                // ogni giro.
                if (dist <= tol) stack.push(i);
            };

            for (let x = 0; x < w; x++) { visit(x, 0); visit(x, h - 1); }
            for (let y = 0; y < h; y++) { visit(0, y); visit(w - 1, y); }
            while (stack.length) {
                const i = stack.pop();
                const x = i % w, y = (i / w) | 0;
                visit(x - 1, y); visit(x + 1, y); visit(x, y - 1); visit(x, y + 1);
            }
        }

        g.putImageData(img, 0, 0);
        return touched;
    }

    function filtRemoveBg() {
        if (!activeLayer()) return Promise.resolve(false);
        // Predefinito: l'angolo in alto a sinistra del COMPOSITO, cioe' il
        // colore che si vede li'. E' lo sfondo nella stragrande maggioranza
        // delle immagini, e sbagliarlo costa un clic sul selettore.
        const corner = samplePixel(0, 0, true);
        return pixPrompt({
            title: t('pix.filt.removeBgTitle'),
            fields: [
                { name: 'color', type: 'color', label: t('pix.filt.bgColor'), value: corner ? corner.hex : '#ffffff' },
                { name: 'tol', type: 'range', label: t('pix.opt.tolerance'), value: 32, min: 0, max: 255 },
                { name: 'edge', type: 'checkbox', label: t('pix.filt.edgeOnly'), value: true },
                { name: 'feather', type: 'checkbox', label: t('pix.filt.feather'), value: false },
            ],
        }).then((res) => {
            if (!res) return false;
            pushHistory();
            const n = removeBackground(res.color, clampInt(res.tol, 0, 255), !!res.edge, !!res.feather);
            if (!n) {
                dropLastSnapshot();
                setStatus(t('pix.filt.removedNone'), 'warn');
                return false;
            }
            renderNow();
            markDirty();
            setStatus(t('pix.filt.removed', { n: n }), 'ok');
            return true;
        });
    }

    // =======================================================================
    //  Regolazioni colore
    // =======================================================================

    function rgb2hsl(r, g, b) {
        const R = r / 255, G = g / 255, B = b / 255;
        const max = Math.max(R, G, B), min = Math.min(R, G, B);
        const l = (max + min) / 2;
        let hh = 0, s = 0;
        if (max !== min) {
            const dd = max - min;
            s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
            if (max === R) hh = (G - B) / dd + (G < B ? 6 : 0);
            else if (max === G) hh = (B - R) / dd + 2;
            else hh = (R - G) / dd + 4;
            hh /= 6;
        }
        _hsl[0] = hh; _hsl[1] = s; _hsl[2] = l;
        return _hsl;
    }

    function hue2rgb(p, q, tt) {
        let x = tt;
        if (x < 0) x += 1;
        if (x > 1) x -= 1;
        if (x < 1 / 6) return p + (q - p) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
        return p;
    }

    function hsl2rgb(hh, s, l) {
        if (s === 0) { _rgb[0] = _rgb[1] = _rgb[2] = l * 255; return _rgb; }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        _rgb[0] = hue2rgb(p, q, hh + 1 / 3) * 255;
        _rgb[1] = hue2rgb(p, q, hh) * 255;
        _rgb[2] = hue2rgb(p, q, hh - 1 / 3) * 255;
        return _rgb;
    }

    /** I valori del dialogo (percentuali e gradi) tradotti in coefficienti. */
    function normAdjust(v) {
        const bri = (Number(v.bri) || 0) / 100 * 255;
        const C = (Number(v.con) || 0) / 100 * 255;
        return {
            bri: bri,
            // Formula classica del contrasto: a -100 tutto collassa su 128 (grigio
            // medio), a +100 si apre di ~130 volte senza mai dividere per zero,
            // perche' con contrasto in [-100,100] il denominatore 259-C sta in
            // [4,514].
            kc: (259 * (C + 255)) / (255 * (259 - C)),
            sat: 1 + (Number(v.sat) || 0) / 100,
            hue: Number(v.hue) || 0,
            any: !!(Number(v.bri) || Number(v.con) || Number(v.sat) || Number(v.hue)),
        };
    }

    /**
     * Applica le regolazioni leggendo SEMPRE da `src` e scrivendo in `dst`.
     *
     * Rileggere dal livello a ogni movimento dello slider accumulerebbe le
     * regolazioni una sull'altra: portare la luminosita' a +10 e poi a +20
     * darebbe +30, e riportarla a 0 non tornerebbe all'immagine di partenza.
     */
    function adjustInto(src, dst, p, sel) {
        const s = src.data, d = dst.data;
        d.set(s);
        for (let i = 0, n = s.length >> 2; i < n; i++) {
            const o = i * 4;
            if (s[o + 3] === 0) continue;
            if (sel && !sel[i]) continue;
            let r = s[o], g = s[o + 1], b = s[o + 2];
            if (p.bri) { r += p.bri; g += p.bri; b += p.bri; }
            if (p.kc !== 1) {
                r = (r - 128) * p.kc + 128;
                g = (g - 128) * p.kc + 128;
                b = (b - 128) * p.kc + 128;
            }
            if (p.sat !== 1) {
                // Luma Rec.601: la saturazione e' una distanza dal GRIGIO
                // percepito, non dalla media dei tre canali. Con la media, il
                // verde desaturato diventa piu' chiaro del blu che gli stava
                // accanto e i valori si scambiano di posto.
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                r = lum + (r - lum) * p.sat;
                g = lum + (g - lum) * p.sat;
                b = lum + (b - lum) * p.sat;
            }
            if (p.hue) {
                // La tinta e' l'unica che passa da HSL, e solo quando serve: il
                // giro di conversione costa, e a zero gradi deve restituire
                // esattamente il colore di partenza. Farlo sempre lo
                // arrotonderebbe due volte per niente.
                const c = rgb2hsl(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255));
                const out = hsl2rgb((c[0] + p.hue / 360 + 1) % 1, c[1], c[2]);
                r = out[0]; g = out[1]; b = out[2];
            }
            d[o] = clampInt(r, 0, 255);
            d[o + 1] = clampInt(g, 0, 255);
            d[o + 2] = clampInt(b, 0, 255);
        }
    }

    /**
     * L'anteprima scrive sul livello VERO (non su un canvas a parte) perche' e'
     * l'unico modo di vederla come si vedra' davvero: sotto un livello
     * semitrasparente, in mezzo alla pila, col fondo a scacchi.
     *
     * Il prezzo e' l'ordine alla conferma: si RIPRISTINA l'originale, POI si
     * prende lo snapshot, POI si applica. Prendere lo snapshot per primo
     * fotograferebbe un'anteprima, e annullare riporterebbe a un'immagine che
     * l'utente non ha mai confermato.
     */
    function filtAdjust() {
        const layer = activeLayer();
        if (!layer) return Promise.resolve(false);
        const g = layer.ctx;
        const w = doc.w, h = doc.h;
        const orig = g.getImageData(0, 0, w, h);
        const work = g.createImageData(w, h);
        const sel = filterMask();

        const paint = (p) => { adjustInto(orig, work, p, sel); g.putImageData(work, 0, 0); requestRender(); };

        return pixPrompt({
            title: t('pix.filt.adjustTitle'),
            onChange: (v) => paint(normAdjust(v)),
            fields: [
                { name: 'bri', type: 'range', label: t('pix.filt.brightness'), value: 0, min: -100, max: 100 },
                { name: 'con', type: 'range', label: t('pix.filt.contrast'), value: 0, min: -100, max: 100 },
                { name: 'sat', type: 'range', label: t('pix.filt.saturation'), value: 0, min: -100, max: 100 },
                { name: 'hue', type: 'range', label: t('pix.filt.hue'), value: 0, min: -180, max: 180 },
            ],
        }).then((res) => {
            g.putImageData(orig, 0, 0);
            if (!res) { renderNow(); return false; }
            const p = normAdjust(res);
            if (!p.any) { renderNow(); return false; }
            pushHistory();
            adjustInto(orig, work, p, sel);
            g.putImageData(work, 0, 0);
            renderNow();
            markDirty();
            return true;
        });
    }

    // =======================================================================
    //  Palette e dithering
    // =======================================================================

    /**
     * I colori dei campioni del pannello.
     *
     * Si legge `swatchColors()` e non il DOM: nel pannello c'e' anche il bottone
     * "aggiungi", che e' una `.swatch` senza colore, e i doppioni vanno tolti
     * comunque perche' una voce ripetuta nella palette non produce un colore in
     * piu' - fa solo lavorare due volte la ricerca del piu' vicino.
     */
    function swatchPalette() {
        const out = [];
        const seen = Object.create(null);
        const list = swatchColors();
        for (let i = 0; i < list.length; i++) {
            const c = hexToRgb(list[i]);
            if (!c) continue;
            const k = c.r + ',' + c.g + ',' + c.b;
            if (seen[k]) continue;
            seen[k] = 1;
            out.push([c.r, c.g, c.b]);
        }
        return out;
    }

    /**
     * I colori su cui calcolare la palette. Si campiona a passo COPRIMO con la
     * larghezza: un passo che divide la larghezza pescherebbe sempre le stesse
     * colonne, e su un disegno a strisce verticali la palette conterrebbe un
     * colore solo.
     */
    function collectColorSamples() {
        const w = doc.w, h = doc.h, n = w * h;
        const d = activeLayer().ctx.getImageData(0, 0, w, h).data;
        const sel = filterMask();
        let step = Math.max(1, Math.floor(n / PALETTE_SAMPLE_MAX));
        while (step > 1 && w % step === 0) step++;
        const out = [];
        for (let i = 0; i < n; i += step) {
            if (sel && !sel[i]) continue;
            const o = i * 4;
            if (d[o + 3] === 0) continue;
            out.push([d[o], d[o + 1], d[o + 2]]);
        }
        return out;
    }

    /** Canale piu' esteso della scatola e ampiezza di quell'estensione. */
    function boxRange(box) {
        let lo = [255, 255, 255], hi = [0, 0, 0];
        for (let i = 0; i < box.length; i++) {
            for (let c = 0; c < 3; c++) {
                const v = box[i][c];
                if (v < lo[c]) lo[c] = v;
                if (v > hi[c]) hi[c] = v;
            }
        }
        let ch = 0, range = hi[0] - lo[0];
        if (hi[1] - lo[1] > range) { ch = 1; range = hi[1] - lo[1]; }
        if (hi[2] - lo[2] > range) { ch = 2; range = hi[2] - lo[2]; }
        return { ch: ch, range: range };
    }

    function averageColor(box) {
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < box.length; i++) { r += box[i][0]; g += box[i][1]; b += box[i][2]; }
        const n = Math.max(1, box.length);
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }

    /**
     * Median cut: si divide sempre la scatola col LATO PIU' LUNGO, tagliandola
     * alla mediana di quel lato.
     *
     * Dividere sempre la prima scatola, o tagliare a meta' dell'intervallo
     * invece che alla mediana, produce una palette che descrive lo spazio dei
     * colori invece del disegno: dieci sfumature per un cielo uniforme e una
     * sola per il personaggio che ci sta davanti.
     *
     * Se tutte le scatole sono uniformi si esce PRIMA di aver raggiunto il
     * numero chiesto: l'immagine ha meno colori di quanti ne siano stati
     * richiesti, e inventarne di finti darebbe voci doppie.
     */
    function medianCut(pixels, want) {
        let boxes = [pixels];
        while (boxes.length < want) {
            let bi = -1, bestRange = 0, bestCh = 0;
            for (let i = 0; i < boxes.length; i++) {
                if (boxes[i].length < 2) continue;
                const r = boxRange(boxes[i]);
                if (r.range > bestRange) { bestRange = r.range; bestCh = r.ch; bi = i; }
            }
            if (bi < 0 || bestRange === 0) break;
            const box = boxes[bi];
            box.sort((a, b) => a[bestCh] - b[bestCh]);
            const mid = box.length >> 1;
            boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
        }
        const pal = [];
        for (let i = 0; i < boxes.length; i++) pal.push(averageColor(boxes[i]));
        return pal;
    }

    /** Indice della voce di palette piu' vicina, a distanza euclidea al quadrato. */
    function nearestIndex(pal, r, g, b) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < pal.length; i++) {
            const dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b;
            const dd = dr * dr + dg * dg + db * db;
            if (dd < bestD) { bestD = dd; best = i; }
        }
        return best;
    }

    /** Spinge una frazione dell'errore su un vicino, se ha senso tingerlo. */
    function diffuse(buf, d, sel, w, h, x, y, f, er, eg, eb) {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const i = y * w + x;
        // L'errore non si spinge su cio' che restera' trasparente o fuori
        // selezione: sarebbe perso, e in cambio il bordo della figura
        // diventerebbe piu' scuro (o piu' chiaro) del suo interno.
        if (d[i * 4 + 3] === 0) return;
        if (sel && !sel[i]) return;
        const o = i * 3;
        buf[o] += er * f; buf[o + 1] += eg * f; buf[o + 2] += eb * f;
    }

    /**
     * Riscrive il livello attivo coi soli colori della palette.
     *
     * Tre dithering, e non uno solo, perche' rispondono a tre esigenze diverse:
     * nessuno da' le campiture piatte che la pixel art vuole; Bayer e' una
     * soglia per pixel, quindi ordinato, ripetibile e adatto a una texture che
     * scorre (l'errore non si trascina da un fotogramma all'altro); Floyd-
     * Steinberg da' il risultato piu' fedele su una foto ma sporca le campiture
     * con pixel isolati.
     */
    function quantizeActive(pal, dither) {
        const w = doc.w, h = doc.h;
        const g = activeLayer().ctx;
        const img = g.getImageData(0, 0, w, h);
        const d = img.data;
        const sel = filterMask();
        // Ampiezza del disturbo ordinato: la distanza tipica fra due voci di
        // palette. Un valore fisso sgranerebbe una palette fitta e non basterebbe
        // a rompere le bande di una palette povera.
        const spread = 255 / Math.max(2, Math.cbrt(pal.length));

        let buf = null;
        if (dither === 'floyd') {
            buf = new Float32Array(w * h * 3);
            for (let i = 0, n = w * h; i < n; i++) {
                const o = i * 4, p = i * 3;
                buf[p] = d[o]; buf[p + 1] = d[o + 1]; buf[p + 2] = d[o + 2];
            }
        }

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x, o = i * 4;
                if (d[o + 3] === 0) continue;
                if (sel && !sel[i]) continue;
                let r, g2, b;
                if (buf) {
                    const p = i * 3;
                    r = buf[p]; g2 = buf[p + 1]; b = buf[p + 2];
                } else {
                    r = d[o]; g2 = d[o + 1]; b = d[o + 2];
                    if (dither === 'bayer') {
                        const off = (BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * spread;
                        r += off; g2 += off; b += off;
                    }
                }
                const c = pal[nearestIndex(pal, r, g2, b)];
                d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2];
                if (buf) {
                    // Pesi di Floyd-Steinberg, in ordine di scansione: destra,
                    // poi la riga sotto. Cambiare i pesi cambia la grana; la
                    // somma deve restare 1 o l'immagine schiarisce o scurisce
                    // riga dopo riga.
                    const er = r - c[0], eg = g2 - c[1], eb = b - c[2];
                    diffuse(buf, d, sel, w, h, x + 1, y, 7 / 16, er, eg, eb);
                    diffuse(buf, d, sel, w, h, x - 1, y + 1, 3 / 16, er, eg, eb);
                    diffuse(buf, d, sel, w, h, x, y + 1, 5 / 16, er, eg, eb);
                    diffuse(buf, d, sel, w, h, x + 1, y + 1, 1 / 16, er, eg, eb);
                }
            }
        }
        g.putImageData(img, 0, 0);
    }

    function filtPalette() {
        if (!activeLayer()) return Promise.resolve(false);
        return pixPrompt({
            title: t('pix.filt.paletteTitle'),
            fields: [
                {
                    name: 'mode', type: 'select', label: t('pix.filt.mode'), value: 'count',
                    options: [
                        { value: 'count', label: t('pix.filt.modeCount') },
                        { value: 'swatches', label: t('pix.filt.modeSwatches') },
                    ],
                },
                { name: 'colors', type: 'range', label: t('pix.filt.colors'), value: 16, min: 2, max: 64 },
                {
                    name: 'dither', type: 'select', label: t('pix.filt.dither'), value: 'none',
                    options: [
                        { value: 'none', label: t('pix.filt.ditherNone') },
                        { value: 'bayer', label: t('pix.filt.ditherBayer') },
                        { value: 'floyd', label: t('pix.filt.ditherFloyd') },
                    ],
                },
            ],
        }).then((res) => {
            if (!res) return false;
            let pal;
            if (res.mode === 'swatches') {
                pal = swatchPalette();
                if (!pal.length) { setStatus(t('pix.filt.noSwatches'), 'warn'); return false; }
            } else {
                const samples = collectColorSamples();
                if (!samples.length) { setStatus(t('pix.filt.emptyLayer'), 'warn'); return false; }
                pal = medianCut(samples, clampInt(res.colors, 2, 64));
            }
            pushHistory();
            quantizeActive(pal, res.dither);
            renderNow();
            markDirty();
            setStatus(t('pix.filt.paletteDone', { n: pal.length }), 'ok');
            return true;
        });
    }

    // =======================================================================
    //  Contorno
    // =======================================================================

    /**
     * Dilatazione (o erosione, con `shrink`) di una maschera binaria, un passo.
     *
     * Si itera un passo alla volta invece di calcolare una distanza: con
     * spessori fino a 8 e' la stessa cosa in tempo, e il contorno che ne esce
     * segue la forma della griglia scelta (a 4 direzioni gli angoli restano
     * squadrati, che in pixel art e' cio' che si vuole) invece di approssimare
     * un cerchio.
     */
    function morphStep(src, w, h, diag, shrink) {
        const out = new Uint8Array(src.length);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                // Dilatare cerca un vicino PIENO, erodere ne cerca uno VUOTO:
                // e' la stessa scansione letta nei due versi, non due cicli da
                // tenere allineati.
                let hit = false;
                for (let dy = -1; dy <= 1 && !hit; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (!dx && !dy) continue;
                        if (!diag && dx && dy) continue;
                        const nx = x + dx, ny = y + dy;
                        // Fuori tela conta come VUOTO: cosi' erodendo, il bordo
                        // della tela e' un bordo della figura e il contorno
                        // interno lo segue invece di interrompersi.
                        const v = (nx < 0 || ny < 0 || nx >= w || ny >= h) ? 0 : src[ny * w + nx];
                        if (shrink ? (v === 0) : (v === 1)) { hit = true; break; }
                    }
                }
                if (shrink) out[i] = (src[i] && !hit) ? 1 : 0;
                else out[i] = (src[i] || hit) ? 1 : 0;
            }
        }
        return out;
    }

    function applyOutline(hex, size, outside, diag) {
        const w = doc.w, h = doc.h, n = w * h;
        const g = activeLayer().ctx;
        const img = g.getImageData(0, 0, w, h);
        const d = img.data;
        const sel = filterMask();
        const c = hexToRgb(hex) || { r: 0, g: 0, b: 0 };

        // La forma e' l'ALPHA, non il colore: e' l'unica definizione che
        // funziona su un disegno di qualunque tinta, compreso uno nero su tela
        // trasparente.
        const solid = new Uint8Array(n);
        for (let i = 0; i < n; i++) solid[i] = d[i * 4 + 3] > 0 ? 1 : 0;

        let morph = solid;
        for (let k = 0; k < size; k++) morph = morphStep(morph, w, h, diag, !outside);

        let painted = 0;
        for (let i = 0; i < n; i++) {
            // Fuori: cio' che la dilatazione ha aggiunto. Dentro: cio' che
            // l'erosione ha tolto. Due sottrazioni speculari, nessun secondo
            // algoritmo da tenere allineato al primo.
            const on = outside ? (morph[i] && !solid[i]) : (solid[i] && !morph[i]);
            if (!on) continue;
            if (sel && !sel[i]) continue;
            const o = i * 4;
            d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b; d[o + 3] = 255;
            painted++;
        }
        g.putImageData(img, 0, 0);
        return painted;
    }

    function filtOutline() {
        if (!activeLayer()) return Promise.resolve(false);
        return pixPrompt({
            title: t('pix.filt.outlineTitle'),
            fields: [
                { name: 'color', type: 'color', label: t('pix.filt.outlineColor'), value: colorPrimary },
                { name: 'size', type: 'range', label: t('pix.opt.size'), value: 1, min: 1, max: 8 },
                {
                    name: 'pos', type: 'select', label: t('pix.filt.outlinePos'), value: 'out',
                    options: [
                        { value: 'out', label: t('pix.filt.outlineOutside') },
                        { value: 'in', label: t('pix.filt.outlineInside') },
                    ],
                },
                {
                    // A 4 direzioni gli spigoli restano vivi, a 8 il contorno
                    // gira anche attorno alle diagonali. Sono due risultati
                    // legittimi e diversi: le scale di pixel disegnate a
                    // gradini vogliono l'una, le figure tonde l'altra.
                    name: 'nb', type: 'select', label: t('pix.filt.neighbors'), value: '8',
                    options: [
                        { value: '4', label: t('pix.filt.neighbors4') },
                        { value: '8', label: t('pix.filt.neighbors8') },
                    ],
                },
            ],
        }).then((res) => {
            if (!res) return false;
            pushHistory();
            const n = applyOutline(res.color, clampInt(res.size, 1, 8), res.pos !== 'in', String(res.nb) === '8');
            if (!n) {
                dropLastSnapshot();
                setStatus(t('pix.filt.outlineNone'), 'warn');
                return false;
            }
            renderNow();
            markDirty();
            setStatus(t('pix.filt.outlineDone', { n: n }), 'ok');
            return true;
        });
    }

    // --- Collegamento ---------------------------------------------------------

    function initFilters() {
        const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
        bind('pixRemoveBgBtn', filtRemoveBg);
        bind('pixAdjustBtn', filtAdjust);
        bind('pixPaletteBtn', filtPalette);
        bind('pixOutlineBtn', filtOutline);
    }
