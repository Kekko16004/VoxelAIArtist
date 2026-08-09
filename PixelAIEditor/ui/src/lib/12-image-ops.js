    // =======================================================================
    //  12 - Operazioni sull'immagine
    //
    //  Ridimensiona, ritaglia, rifila, specchia, ruota. Tutte cambiano la FORMA
    //  del documento, e quindi tutte devono rispondere alla stessa domanda: che
    //  ne e' della selezione?
    //
    //  Una maschera lasciata ferma dopo una rotazione protegge pixel che non
    //  sono piu' li': il gesto successivo colpisce il vuoto e sembra che lo
    //  strumento non funzioni. Dove la trasformazione e' ESATTA (specchia,
    //  ruota: ogni pixel va in un pixel, senza resti) la maschera si trasforma
    //  insieme al disegno - e' `remapDoc`. Dove non lo e' (ridimensiona,
    //  ritaglia, rifila: i pixel cambiano di numero o di posto in un modo che
    //  una maschera puo' solo approssimare) si DESELEZIONA, che e' un risultato
    //  onesto invece di una selezione ricampionata a caso.
    //
    //  Ridimensiona immagine e ridimensiona tela si somigliano solo a parole:
    //  la prima ricampiona il disegno, la seconda gli cambia la cornice attorno.
    //  Un editor che ne offre una sola costringe a rifare il disegno per
    //  aggiungergli un margine.
    // =======================================================================

    /**
     * Cio' che va fatto dopo QUALUNQUE cambio di forma del documento.
     *
     * `layoutStage` perche' la tela puo' aver cambiato dimensione (senza,
     * lo stage resta grande come prima e il disegno si vede stirato dal CSS),
     * `renderNow` e non `requestRender` perche' queste operazioni arrivano da un
     * comando esplicito e un fotogramma di ritardo si legge come esitazione.
     * Sta qui e non in ogni chiamante perche' dimenticarne un pezzo produce
     * difetti diversi fra loro (il visore giusto e la lista dei livelli
     * vecchia, o viceversa) che sembrano difetti diversi.
     */
    function afterDocChange() {
        layoutStage();
        renderNow();
        refreshLayerList();
        markDirty();
    }

    /**
     * Trasformazione esatta: ridisegna ogni livello su una tela (newW,newH) e
     * porta con se' la selezione.
     *
     * `mapIndex(x,y)` da' l'indice NUOVO del pixel vecchio (x,y). Si passa un
     * indice e non un punto perche' su una tela 4096x4096 sarebbero 16 milioni
     * di oggetti allocati per un'operazione che dura un istante.
     *
     * La maschera va letta PRIMA di `remapLayers`, che riscrive doc.w/doc.h: da
     * quel momento `selActive()` confronta la lunghezza con le dimensioni nuove
     * e risponde di no anche quando una selezione c'era.
     */
    function remapDoc(newW, newH, draw, mapIndex) {
        const oldW = doc.w, oldH = doc.h;
        const oldMask = selActive() ? selMask : null;
        remapLayers(newW, newH, draw);
        if (oldMask) {
            const m = newMask();
            for (let y = 0; y < oldH; y++) {
                const row = y * oldW;
                for (let x = 0; x < oldW; x++) {
                    if (oldMask[row + x]) m[mapIndex(x, y)] = 1;
                }
            }
            selSetMask(m);
        }
        afterDocChange();
    }

    // --- Ridimensiona ---------------------------------------------------------

    /**
     * "Mantieni le proporzioni" applicato DOPO la chiusura del dialogo.
     *
     * `pixPrompt` e' un renderer stupido: non sa legare due campi fra loro, e
     * insegnarglielo per questo caso solo lo renderebbe un dialogo speciale che
     * poi va mantenuto. La regola e' quindi: comanda il lato che l'utente ha
     * CAMBIATO; se li ha cambiati entrambi comanda la larghezza, che e' il campo
     * che si compila per primo.
     */
    function ratioFix(w, h, w0, h0, lock) {
        if (!lock || w0 < 1 || h0 < 1) return { w: w, h: h };
        if (w !== w0) return { w: w, h: clampInt(Math.round(h0 * w / w0), DOC_MIN_SIDE, DOC_MAX_SIDE) };
        if (h !== h0) return { w: clampInt(Math.round(w0 * h / h0), DOC_MIN_SIDE, DOC_MAX_SIDE), h: h };
        return { w: w, h: h };
    }

    function imgResizeImage() {
        const w0 = doc.w, h0 = doc.h;
        return pixPrompt({
            title: t('pix.image.resizeImageTitle'),
            fields: [
                { name: 'w', type: 'number', label: t('pix.dlg.width'), value: w0, min: DOC_MIN_SIDE, max: DOC_MAX_SIDE },
                { name: 'h', type: 'number', label: t('pix.dlg.height'), value: h0, min: DOC_MIN_SIDE, max: DOC_MAX_SIDE },
                { name: 'lock', type: 'checkbox', label: t('pix.dlg.keepRatio'), value: true },
                {
                    name: 'interp', type: 'select', label: t('pix.image.interp'),
                    // Il predefinito e' NETTA, e non e' una preferenza: in pixel
                    // art l'interpolazione morbida e' esattamente cio' che si
                    // legge come "il programma ha rovinato il disegno". La
                    // morbida resta offerta perche' su una foto importata e'
                    // l'unica che dia un risultato guardabile.
                    value: 'nearest',
                    options: [
                        { value: 'nearest', label: t('pix.image.interpNearest') },
                        { value: 'smooth', label: t('pix.image.interpSmooth') },
                    ],
                },
            ],
        }).then((res) => {
            if (!res) return false;
            const size = ratioFix(
                clampInt(res.w, DOC_MIN_SIDE, DOC_MAX_SIDE),
                clampInt(res.h, DOC_MIN_SIDE, DOC_MAX_SIDE),
                w0, h0, !!res.lock);
            if (size.w === w0 && size.h === h0) return false;
            pushHistory();
            resizeImage(size.w, size.h, res.interp === 'smooth');
            selectNone();
            afterDocChange();
            setStatus(t('pix.image.newSize', { w: doc.w, h: doc.h }), 'ok');
            return true;
        });
    }

    function imgResizeCanvas() {
        const w0 = doc.w, h0 = doc.h;
        return pixPrompt({
            title: t('pix.image.resizeCanvasTitle'),
            fields: [
                { name: 'w', type: 'number', label: t('pix.dlg.width'), value: w0, min: DOC_MIN_SIDE, max: DOC_MAX_SIDE },
                { name: 'h', type: 'number', label: t('pix.dlg.height'), value: h0, min: DOC_MIN_SIDE, max: DOC_MAX_SIDE },
                // L'ancora dice DOVE finisce il disegno vecchio nella tela
                // nuova. Senza, allargare la tela sarebbe utile solo a chi
                // voleva il margine in basso a destra.
                { name: 'anchor', type: 'anchor', label: t('pix.dlg.anchor'), value: 'c' },
            ],
        }).then((res) => {
            if (!res) return false;
            const W = clampInt(res.w, DOC_MIN_SIDE, DOC_MAX_SIDE);
            const H = clampInt(res.h, DOC_MIN_SIDE, DOC_MAX_SIDE);
            if (W === w0 && H === h0) return false;
            pushHistory();
            resizeCanvasTo(W, H, res.anchor || 'c');
            // Anche a parita' di dimensioni l'ancora SPOSTA il disegno, quindi
            // la maschera non varrebbe piu' comunque.
            selectNone();
            afterDocChange();
            setStatus(t('pix.image.newSize', { w: doc.w, h: doc.h }), 'ok');
            return true;
        });
    }

    // --- Ritaglia e rifila ----------------------------------------------------

    function imgCropToSelection() {
        if (!selActive() || !selBox) { setStatus(t('pix.msg.noSelection'), 'warn'); return false; }
        const x0 = selBox.x0, y0 = selBox.y0, x1 = selBox.x1, y1 = selBox.y1;
        pushHistory();
        cropTo(x0, y0, x1, y1);
        // Dopo il ritaglio il rettangolo E' il documento: tenere una selezione
        // che coincide con tutta la tela non protegge niente e si mette in mezzo
        // al primo tratto.
        selectNone();
        afterDocChange();
        setStatus(t('pix.image.newSize', { w: doc.w, h: doc.h }), 'ok');
        return true;
    }

    function imgTrim() {
        const b = opaqueBounds();
        // null = documento interamente trasparente: rifilare lo azzererebbe, e
        // una tela di lato zero non esiste.
        if (!b) { setStatus(t('pix.msg.emptyDoc'), 'warn'); return false; }
        if (b.x0 === 0 && b.y0 === 0 && b.x1 === doc.w - 1 && b.y1 === doc.h - 1) {
            // Niente da togliere: si esce senza toccare la cronologia, o Ctrl+Z
            // annullerebbe un'operazione che non ha cambiato nulla.
            setStatus(t('pix.msg.nothingTrim'), '');
            return false;
        }
        pushHistory();
        cropTo(b.x0, b.y0, b.x1, b.y1);
        selectNone();
        afterDocChange();
        setStatus(t('pix.image.newSize', { w: doc.w, h: doc.h }), 'ok');
        return true;
    }

    // --- Specchia e ruota -----------------------------------------------------
    // Le trasformazioni passano dalla matrice del contesto e non da un ciclo sui
    // pixel: a multipli di 90 gradi la mappatura e' esatta (ogni pixel cade su
    // un pixel) e non c'e' niente da interpolare. E' anche il motivo per cui si
    // offrono 90 e 180 e non un angolo qualunque: un angolo libero campiona fra
    // i texel e sfoca il disegno, e NearestFilter non basta a salvarlo.

    function imgFlipH() {
        const W = doc.w;
        pushHistory();
        remapDoc(W, doc.h,
            (g, old) => { g.translate(W, 0); g.scale(-1, 1); g.drawImage(old, 0, 0); },
            (x, y) => y * W + (W - 1 - x));
        return true;
    }

    function imgFlipV() {
        const W = doc.w, H = doc.h;
        pushHistory();
        remapDoc(W, H,
            (g, old) => { g.translate(0, H); g.scale(1, -1); g.drawImage(old, 0, 0); },
            (x, y) => (H - 1 - y) * W + x);
        return true;
    }

    /**
     * Rotazione di 90 gradi in senso orario: la tela SCAMBIA i lati, quindi la
     * larghezza nuova e' `H`. Il pixel vecchio (x,y) finisce in (H-1-y, x), e la
     * riga nuova e' lunga H: da qui l'indice `x * H + (H - 1 - y)`.
     */
    function imgRot90() {
        const W = doc.w, H = doc.h;
        pushHistory();
        remapDoc(H, W,
            (g, old) => { g.translate(H, 0); g.rotate(Math.PI / 2); g.drawImage(old, 0, 0); },
            (x, y) => x * H + (H - 1 - y));
        setStatus(t('pix.image.newSize', { w: doc.w, h: doc.h }), 'ok');
        return true;
    }

    function imgRot180() {
        const W = doc.w, H = doc.h;
        pushHistory();
        remapDoc(W, H,
            (g, old) => { g.translate(W, H); g.scale(-1, -1); g.drawImage(old, 0, 0); },
            (x, y) => (H - 1 - y) * W + (W - 1 - x));
        return true;
    }

    // --- Collegamento ---------------------------------------------------------

    function initImageOps() {
        const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
        bind('pixResizeImageBtn', imgResizeImage);
        bind('pixResizeCanvasBtn', imgResizeCanvas);
        bind('pixCropBtn', imgCropToSelection);
        bind('pixTrimBtn', imgTrim);
        bind('pixFlipHBtn', imgFlipH);
        bind('pixFlipVBtn', imgFlipV);
        bind('pixRot90Btn', imgRot90);
        bind('pixRot180Btn', imgRot180);
    }
