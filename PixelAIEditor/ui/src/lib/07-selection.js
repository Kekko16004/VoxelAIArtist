    // =======================================================================
    //  07 - Selezione
    //
    //  La selezione e' una MASCHERA di 1 byte per pixel, non un rettangolo.
    //  Il rettangolo basta per lo strumento omonimo e non basta per nient'altro:
    //  bacchetta magica, lazo, "inverti selezione" e le combinazioni con Shift
    //  producono forme qualunque. Con la maschera tutti gli strumenti passano
    //  dallo stesso cancello, `selHas(x,y)`, e nessuno di loro sa che forma
    //  abbia la selezione.
    //
    //  `selMask === null` significa NESSUNA selezione, cioe' "tutto il
    //  documento e' modificabile". Non e' la stessa cosa di una maschera piena
    //  di 1: quella e' "Seleziona tutto", che si vede (ha il bordo animato) e
    //  che "Ritaglia alla selezione" usa. La differenza conta.
    // =======================================================================

    let selMask = null;
    let selBox = null;          // {x0,y0,x1,y1} inclusivo, null se non c'e' selezione
    let _antEdges = null;       // indici dei pixel di bordo, per il tratteggio
    let _antPhase = 0;
    let _antTimer = 0;

    // Cambia a ogni scrittura della maschera. Chi tiene in mano qualcosa di
    // derivato dalla selezione (la trasformazione, che ne solleva i pixel) lo
    // confronta invece di farsi avvisare: gli avvisi si dimenticano, un numero
    // diverso no.
    let _selVersion = 0;

    // Oltre questa soglia il tratteggio non si anima: ridisegnare mezzo milione
    // di pixel ogni 120 ms per un effetto decorativo rende l'app a scatti
    // proprio quando la selezione e' complessa e serve lavorarci.
    const ANT_ANIMATE_MAX = 40000;

    function selActive() {
        return selMask !== null && selMask.length === doc.w * doc.h;
    }

    /**
     * L'unico cancello del disegno. Va chiamato da OGNI strumento prima di
     * scrivere un pixel: e' cio' che rende la selezione una "protezione" e non
     * un semplice riquadro decorativo.
     */
    function selHas(x, y) {
        if (!selActive()) return true;
        if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return false;
        return selMask[y * doc.w + x] !== 0;
    }

    /** Rettangolo su cui operare: la selezione se c'e', tutto il documento se no. */
    function selBounds() {
        if (selActive() && selBox) return { x0: selBox.x0, y0: selBox.y0, x1: selBox.x1, y1: selBox.y1 };
        return { x0: 0, y0: 0, x1: doc.w - 1, y1: doc.h - 1 };
    }

    function newMask() { return new Uint8Array(doc.w * doc.h); }

    /**
     * Installa una maschera (o la toglie con null) e ricalcola tutto cio' che
     * ne dipende. E' l'unico punto che scrive `selMask`: il riquadro e il bordo
     * animato non possono restare indietro perche' non c'e' un'altra via.
     */
    function selSetMask(mask) {
        if (mask && mask.length !== doc.w * doc.h) mask = null;
        // Una maschera senza nemmeno un pixel non e' una selezione vuota da
        // mostrare: e' una selezione che non c'e'. Tenerla bloccherebbe ogni
        // strumento senza che si veda perche'.
        if (mask) {
            let any = false;
            for (let i = 0; i < mask.length; i++) { if (mask[i]) { any = true; break; } }
            if (!any) mask = null;
        }
        selMask = mask;
        _selVersion++;
        selRecomputeBox();
        selRecomputeEdges();
        updateAntTimer();
        requestOverlay();
        refreshSelectionUI();
    }

    function selRecomputeBox() {
        if (!selActive()) { selBox = null; return; }
        let x0 = doc.w, y0 = doc.h, x1 = -1, y1 = -1;
        for (let y = 0; y < doc.h; y++) {
            const row = y * doc.w;
            for (let x = 0; x < doc.w; x++) {
                if (!selMask[row + x]) continue;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
        selBox = (x1 < 0) ? null : { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    /**
     * Pixel di bordo = selezionati con almeno un vicino non selezionato (o
     * fuori tela). Si calcolano UNA VOLTA per selezione e non a ogni fotogramma
     * del tratteggio: e' la differenza fra un'animazione gratis e una scansione
     * dell'intera tela dodici volte al secondo.
     */
    function selRecomputeEdges() {
        if (!selActive()) { _antEdges = null; return; }
        const w = doc.w, h = doc.h, out = [];
        for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) {
                if (!selMask[row + x]) continue;
                const l = x > 0 ? selMask[row + x - 1] : 0;
                const r = x < w - 1 ? selMask[row + x + 1] : 0;
                const u = y > 0 ? selMask[row - w + x] : 0;
                const d = y < h - 1 ? selMask[row + w + x] : 0;
                if (!l || !r || !u || !d) out.push(row + x);
            }
        }
        _antEdges = out;
    }

    function updateAntTimer() {
        const want = _antEdges && _antEdges.length > 0 && _antEdges.length <= ANT_ANIMATE_MAX;
        if (want && !_antTimer) {
            _antTimer = setInterval(() => { _antPhase = (_antPhase + 1) & 15; requestOverlay(); }, 120);
        } else if (!want && _antTimer) {
            clearInterval(_antTimer); _antTimer = 0;
        }
    }

    /**
     * Il bordo tratteggiato, disegnato NEI PIXEL del documento.
     *
     * Non e' un `setLineDash` su un tracciato: l'overlay e' grande quanto il
     * documento e viene ingrandito dal CSS, quindi una linea di 1 px disegnata
     * qui diventa spessa quanto un pixel del disegno a qualunque zoom - che e'
     * esattamente cio' che serve. Un tracciato vettoriale, invece, sarebbe
     * spesso 1/zoom di pixel di schermo e a 32x sparirebbe.
     */
    function drawSelectionAnts(g) {
        if (!_antEdges || !_antEdges.length) return;
        const w = doc.w;
        g.save();
        for (let k = 0; k < _antEdges.length; k++) {
            const i = _antEdges[k];
            const x = i % w, y = (i / w) | 0;
            g.fillStyle = (((x + y + _antPhase) >> 2) & 1) ? '#000000' : '#ffffff';
            g.fillRect(x, y, 1, 1);
        }
        g.restore();
    }

    // --- Costruzione di selezioni --------------------------------------------
    // `mode`: 'replace' (predefinito), 'add' (Shift), 'sub' (Alt).
    // I modificatori sono la ragione per cui queste funzioni prendono una
    // maschera "nuova" e la combinano invece di installarla: senza, ogni
    // strumento dovrebbe implementare la combinazione per conto suo.

    function selCombine(fresh, mode) {
        if (mode === 'add' && selActive()) {
            for (let i = 0; i < fresh.length; i++) if (selMask[i]) fresh[i] = 1;
        } else if (mode === 'sub') {
            if (!selActive()) {
                // Sottrarre da "nessuna selezione" significa sottrarre da tutto.
                const all = newMask();
                for (let i = 0; i < all.length; i++) all[i] = fresh[i] ? 0 : 1;
                fresh = all;
            } else {
                const out = newMask();
                for (let i = 0; i < out.length; i++) out[i] = (selMask[i] && !fresh[i]) ? 1 : 0;
                fresh = out;
            }
        }
        selSetMask(fresh);
    }

    function selectAll() {
        const m = newMask();
        m.fill(1);
        selSetMask(m);
    }

    function selectNone() { selSetMask(null); }

    /**
     * Inverte la selezione. Senza selezione non fa nulla di proposito:
     * l'inverso di "tutto" e' "niente", e una selezione vuota blocca ogni
     * strumento senza che si veda il perche'.
     */
    function selectInvert() {
        if (!selActive()) { setStatus(t('pix.msg.noSelection'), 'warn'); return; }
        const m = newMask();
        for (let i = 0; i < m.length; i++) m[i] = selMask[i] ? 0 : 1;
        selSetMask(m);
    }

    function selectRect(x0, y0, x1, y1, mode) {
        const X0 = clamp(Math.min(x0, x1), 0, doc.w - 1);
        const Y0 = clamp(Math.min(y0, y1), 0, doc.h - 1);
        const X1 = clamp(Math.max(x0, x1), 0, doc.w - 1);
        const Y1 = clamp(Math.max(y0, y1), 0, doc.h - 1);
        const m = newMask();
        for (let y = Y0; y <= Y1; y++) {
            const row = y * doc.w;
            for (let x = X0; x <= X1; x++) m[row + x] = 1;
        }
        selCombine(m, mode);
    }

    /**
     * Poligono chiuso -> maschera, con la regola PARI/DISPARI.
     *
     * Il campionamento e' al CENTRO del pixel (x+0.5, y+0.5), non all'angolo:
     * sull'angolo un lato che passa esattamente per la griglia intera da'
     * risultati diversi a destra e a sinistra dello stesso bordo, e il lazo
     * lascia una fila di pixel dentro o fuori a seconda di come e' stato
     * disegnato.
     */
    function selectPolygon(points, mode) {
        const m = newMask();
        const n = points.length;
        if (n >= 3) {
            for (let y = 0; y < doc.h; y++) {
                const py = y + 0.5, row = y * doc.w;
                const xs = [];
                for (let i = 0, j = n - 1; i < n; j = i++) {
                    const a = points[j], b = points[i];
                    if ((a.y > py) === (b.y > py)) continue;
                    xs.push(a.x + (py - a.y) / (b.y - a.y) * (b.x - a.x));
                }
                xs.sort((p, q) => p - q);
                for (let k = 0; k + 1 < xs.length; k += 2) {
                    const from = Math.max(0, Math.ceil(xs[k] - 0.5));
                    const to = Math.min(doc.w - 1, Math.floor(xs[k + 1] - 0.5));
                    for (let x = from; x <= to; x++) m[row + x] = 1;
                }
            }
        }
        selCombine(m, mode);
    }

    /**
     * Bacchetta magica. `sampleAll` sceglie se guardare il composito (come si
     * VEDE il disegno) o il solo livello attivo: sono due risposte diverse e
     * legittime, e indovinare quale voglia l'utente e' il modo di sbagliare
     * entrambe.
     */
    function selectWand(x, y, tolerance, contiguous, sampleAll, mode) {
        if (!inDoc(x, y)) return;
        const src = sampleAll ? flattenToCanvas() : activeLayer().canvas;
        const data = ctx2d(src).getImageData(0, 0, doc.w, doc.h).data;
        const m = newMask();
        floodRegion(data, doc.w, doc.h, x, y, tolerance, contiguous, (px, py) => {
            m[py * doc.w + px] = 1;
        });
        selCombine(m, mode);
    }

    /** Mostra o nasconde le voci che hanno senso solo con una selezione. */
    function refreshSelectionUI() {
        const on = selActive();
        const ids = ['pixCropBtn', 'pixSelectNoneBtn', 'pixSelectInvertBtn'];
        for (let i = 0; i < ids.length; i++) {
            const el = $(ids[i]);
            if (el) el.disabled = !on;
        }
    }
