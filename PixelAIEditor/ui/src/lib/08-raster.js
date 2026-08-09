    // =======================================================================
    //  08 - Primitive raster
    //
    //  Qui non si conosce nessuno strumento: si sa solo trasformare una forma
    //  geometrica in un elenco di pixel (`rasterLine`, `rasterRect`,
    //  `rasterEllipse`, `floodRegion`) e scrivere un pixel rispettando
    //  selezione, simmetria e spessore (`stampAt`).
    //
    //  Le primitive emettono coordinate tramite callback invece di disegnare:
    //  la stessa forma serve DUE volte, una per l'anteprima sull'overlay e una
    //  per il tratto definitivo sul livello. Con un disegno diretto servirebbero
    //  due implementazioni, e anteprima e risultato divergerebbero alla prima
    //  modifica - che e' il difetto piu' insidioso di un editor, perche' l'utente
    //  vede una cosa e ne ottiene un'altra.
    // =======================================================================

    // --- Scrittura di un pixel -----------------------------------------------

    /**
     * Scrive UN pixel del documento, gia' filtrato da limiti e selezione.
     *
     * `clearRect` prima di `fillRect` non e' ridondante: `fillRect` FONDE col
     * pixel esistente, quindi dipingere un colore semitrasparente sopra un
     * pixel gia' colorato darebbe una tinta mista invece del colore scelto. In
     * pixel art l'opacita' e' una proprieta' del pixel che si dipinge, non una
     * velatura da stendere: dipingere al 50% e poi ripassarci sopra deve
     * lasciare 50%, non 75%.
     *
     * `style` nullo = cancella (e' la gomma, senza un ramo dedicato).
     */
    function putPixel(g, x, y, style) {
        if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
        if (!selHas(x, y)) return;
        g.clearRect(x, y, 1, 1);
        if (style) { g.fillStyle = style; g.fillRect(x, y, 1, 1); }
    }

    /**
     * I punti immagine di (x,y) secondo la simmetria attiva.
     * L'asse e' il centro della TELA, non del disegno: e' l'unico riferimento
     * che non cambia mentre si disegna.
     */
    function mirrorPoints(x, y, mode) {
        const out = [{ x: x, y: y }];
        const mx = doc.w - 1 - x, my = doc.h - 1 - y;
        if (mode === 'h' || mode === 'hv') out.push({ x: mx, y: y });
        if (mode === 'v' || mode === 'hv') out.push({ x: x, y: my });
        if (mode === 'hv') out.push({ x: mx, y: my });
        return out;
    }

    /**
     * Pennello quadrato di lato `size` centrato su (x,y), replicato dalla
     * simmetria. Per i lati pari il centro cade fra due pixel: si sceglie di
     * estendere in basso a destra, sempre, cosi' che un tratto orizzontale
     * abbia spessore costante invece di oscillare di un pixel.
     */
    function stampAt(g, x, y, style, size, mode) {
        const s = Math.max(1, size | 0);
        const off = (s - 1) >> 1;
        const pts = mirrorPoints(x, y, mode);
        for (let p = 0; p < pts.length; p++) {
            const bx = pts[p].x - off, by = pts[p].y - off;
            for (let dy = 0; dy < s; dy++) {
                for (let dx = 0; dx < s; dx++) putPixel(g, bx + dx, by + dy, style);
            }
        }
    }

    // --- Forme ---------------------------------------------------------------

    /** Bresenham intero: nessun arrotondamento, nessun buco, nessun doppione. */
    function rasterLine(x0, y0, x1, y1, cb) {
        let x = x0 | 0, y = y0 | 0;
        const ex = x1 | 0, ey = y1 | 0;
        const dx = Math.abs(ex - x), dy = -Math.abs(ey - y);
        const sx = x < ex ? 1 : -1, sy = y < ey ? 1 : -1;
        let err = dx + dy;
        for (; ;) {
            cb(x, y);
            if (x === ex && y === ey) break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x += sx; }
            if (e2 <= dx) { err += dx; y += sy; }
        }
    }

    function rasterRect(x0, y0, x1, y1, filled, cb) {
        const X0 = Math.min(x0, x1), X1 = Math.max(x0, x1);
        const Y0 = Math.min(y0, y1), Y1 = Math.max(y0, y1);
        if (filled) {
            for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) cb(x, y);
            return;
        }
        for (let x = X0; x <= X1; x++) { cb(x, Y0); if (Y1 !== Y0) cb(x, Y1); }
        for (let y = Y0 + 1; y < Y1; y++) { cb(X0, y); if (X1 !== X0) cb(X1, y); }
    }

    /**
     * Ellisse inscritta nel rettangolo dato.
     *
     * Il contorno si ricava dalla stessa prova di appartenenza della versione
     * piena ("dentro, ma con un vicino fuori") invece che da un algoritmo suo:
     * cosi' contorno e pieno coincidono per costruzione, e il contorno risulta
     * CHIUSO anche sulle ellissi molto schiacciate, dove gli algoritmi a
     * quadranti lasciano buchi ai poli.
     */
    function rasterEllipse(x0, y0, x1, y1, filled, cb) {
        const X0 = Math.min(x0, x1), X1 = Math.max(x0, x1);
        const Y0 = Math.min(y0, y1), Y1 = Math.max(y0, y1);
        const rx = Math.max(0.5, (X1 - X0 + 1) / 2);
        const ry = Math.max(0.5, (Y1 - Y0 + 1) / 2);
        const cx = X0 + rx, cy = Y0 + ry;
        const inside = (x, y) => {
            const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
            return u * u + v * v <= 1;
        };
        for (let y = Y0; y <= Y1; y++) {
            for (let x = X0; x <= X1; x++) {
                if (!inside(x, y)) continue;
                if (filled) { cb(x, y); continue; }
                if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) cb(x, y);
            }
        }
    }

    // --- Colori e riempimento ------------------------------------------------

    /**
     * Distanza fra due colori RGBA, sul canale peggiore.
     *
     * L'ALPHA entra nel confronto, e non e' un dettaglio: senza, riempire una
     * zona trasparente sarebbe un no-op (tutti i pixel trasparenti hanno RGB
     * arbitrario, spesso 0,0,0, e sembrerebbero neri identici fra loro) - ed e'
     * il caso piu' comune, dare uno sfondo a un disegno cominciato su tela
     * vuota. Due pixel completamente trasparenti sono pero' considerati
     * UGUALI qualunque sia il loro RGB, che il canvas non conserva in modo
     * affidabile dopo un clearRect.
     */
    function rgbaDistance(d, i, r, g, b, a) {
        const da = Math.abs(d[i + 3] - a);
        if (d[i + 3] === 0 && a === 0) return 0;
        return Math.max(da, Math.abs(d[i] - r), Math.abs(d[i + 1] - g), Math.abs(d[i + 2] - b));
    }

    /**
     * Regione da riempire a partire da (sx,sy).
     *
     * `contiguous` false = tutti i pixel simili della tela, ovunque siano: e'
     * il "riempimento globale" che serve per sostituire un colore in tutto il
     * disegno senza rincorrerne le isole.
     *
     * Il riempimento contiguo usa una PILA esplicita e non la ricorsione: su
     * una tela 1024x1024 monocroma la ricorsione supera la profondita' massima
     * dello stack e l'operazione fallisce a meta', lasciando un riempimento
     * parziale che sembra un difetto del disegno.
     */
    function floodRegion(data, w, h, sx, sy, tolerance, contiguous, cb) {
        const si = (sy * w + sx) * 4;
        const r = data[si], g = data[si + 1], b = data[si + 2], a = data[si + 3];
        const tol = Math.max(0, tolerance | 0);

        if (!contiguous) {
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (rgbaDistance(data, (y * w + x) * 4, r, g, b, a) <= tol) cb(x, y);
                }
            }
            return;
        }

        const seen = new Uint8Array(w * h);
        const stack = [sy * w + sx];
        seen[sy * w + sx] = 1;
        while (stack.length) {
            const i = stack.pop();
            const x = i % w, y = (i / w) | 0;
            cb(x, y);
            if (x > 0 && !seen[i - 1] && rgbaDistance(data, (i - 1) * 4, r, g, b, a) <= tol) { seen[i - 1] = 1; stack.push(i - 1); }
            if (x < w - 1 && !seen[i + 1] && rgbaDistance(data, (i + 1) * 4, r, g, b, a) <= tol) { seen[i + 1] = 1; stack.push(i + 1); }
            if (y > 0 && !seen[i - w] && rgbaDistance(data, (i - w) * 4, r, g, b, a) <= tol) { seen[i - w] = 1; stack.push(i - w); }
            if (y < h - 1 && !seen[i + w] && rgbaDistance(data, (i + w) * 4, r, g, b, a) <= tol) { seen[i + w] = 1; stack.push(i + w); }
        }
    }

    /**
     * Colore di un pixel come {hex, alpha}. `sampleAll` decide se leggere il
     * composito o il solo livello attivo: il contagocce deve poter prendere il
     * colore che si VEDE, che su livelli semitrasparenti non e' quello scritto
     * in nessun livello.
     */
    function samplePixel(x, y, sampleAll) {
        if (!inDoc(x, y)) return null;
        const src = sampleAll ? flattenToCanvas() : activeLayer().canvas;
        const d = ctx2d(src).getImageData(x, y, 1, 1).data;
        return { hex: rgbToHex(d[0], d[1], d[2]), alpha: d[3] };
    }
