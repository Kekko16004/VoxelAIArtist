    // =======================================================================
    //  10 - Appunti: copia, taglia, incolla
    //
    //  DUE CANALI, non uno. Gli appunti di SISTEMA sono quelli che servono
    //  davvero (si incolla uno screenshot dentro l'editor, si porta un disegno
    //  fuori), ma non ci si puo' contare: `navigator.clipboard` vuole un
    //  contesto sicuro, un permesso che l'utente puo' negare, e la LETTURA non
    //  esiste affatto in alcuni browser. Se fosse l'unico canale, un Ctrl+C
    //  seguito da Ctrl+V DENTRO la stessa app fallirebbe in silenzio - il modo
    //  peggiore di fallire, perche' sembra che il comando non esista. Quindi
    //  ogni copia riempie anche una RISERVA interna (un canvas), e l'incolla la
    //  usa quando il sistema non offre un'immagine. La precedenza resta al
    //  sistema: e' li' che arriva cio' che viene da fuori, e quando i due
    //  differiscono e' il sistema ad essere piu' recente.
    //
    //  Si copia il LIVELLO ATTIVO, non il composito. Incollare rimette il
    //  contenuto su UN livello solo: copiando il composito, i pixel di cinque
    //  livelli tornerebbero fusi in uno senza che nessuno l'abbia chiesto. Chi
    //  vuole il composito ha "Appiattisci immagine", che e' la stessa richiesta
    //  detta a voce alta invece che di nascosto dentro un Ctrl+C.
    //
    //  Dopo l'incolla la SELEZIONE diventa il rettangolo incollato: e' l'unico
    //  modo di riposizionare cio' che si e' appena incollato (lo strumento
    //  Sposta lavora sulla selezione) senza inventare uno stato "flottante", che
    //  costerebbe un ramo dedicato in ogni strumento e in ogni salvataggio.
    // =======================================================================

    // La riserva interna. E' un canvas e non un ImageData perche' va anche
    // ridisegnata (drawImage ritaglia da solo cio' che esce dalla tela).
    let _clipCanvas = null;

    // Ctrl+V arriva DUE volte: una come scorciatoia da tastiera e una come
    // evento `paste` del documento. Senza questa guardia lo stesso contenuto
    // verrebbe incollato due volte, con due voci di annullamento. La finestra e'
    // corta: due Ctrl+V voluti sono comunque piu' lenti di cosi'.
    const PASTE_GUARD_MS = 400;
    let _pasteAt = 0;
    let _pasteBusy = false;

    // --- Copia ---------------------------------------------------------------

    /**
     * Il contenuto da copiare: il livello attivo limitato alla selezione, o
     * tutto il livello se selezione non ce n'e'.
     *
     * Fuori dalla maschera l'alpha va a zero invece di essere ritagliato al solo
     * riquadro: una selezione a lazo copiata come rettangolo pieno si porterebbe
     * dietro tutto cio' che le sta attorno, e l'utente se ne accorgerebbe solo
     * dopo aver incollato.
     */
    function clipRegionCanvas() {
        const layer = activeLayer();
        if (!layer) return null;
        const b = selBounds();
        const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
        if (w < 1 || h < 1) return null;

        const c = makeCanvas(w, h);
        const g = ctx2d(c);
        g.drawImage(layer.canvas, -b.x0, -b.y0);

        if (selActive()) {
            const img = g.getImageData(0, 0, w, h);
            const d = img.data;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (!selHas(b.x0 + x, b.y0 + y)) d[(y * w + x) * 4 + 3] = 0;
                }
            }
            g.putImageData(img, 0, 0);
        }
        return c;
    }

    /**
     * Scrive sugli appunti di sistema. Non solleva MAI: qui un errore e' la
     * normalita' (permesso negato, API assente, documento non a fuoco) e non
     * deve impedire alla riserva interna di funzionare. Ritorna se ha scritto,
     * per chi volesse dirlo all'utente.
     */
    function writeSystemClipboard(canvas) {
        if (!navigator.clipboard || !navigator.clipboard.write || !window.ClipboardItem) {
            return Promise.resolve(false);
        }
        return canvasToBlob(canvas)
            .then((blob) => navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]))
            .then(() => true)
            .catch(() => false);
    }

    /** `silent` serve a doCut, che dira' lui com'e' andata. */
    function doCopy(silent) {
        const c = clipRegionCanvas();
        if (!c) return null;
        _clipCanvas = c;
        writeSystemClipboard(c);
        if (!silent) setStatus(t('pix.clip.copied', { w: c.width, h: c.height }), 'ok');
        return c;
    }

    function doCut() {
        const c = doCopy(true);
        if (!c) return false;
        pushHistory();
        const g = activeLayer().ctx;
        const b = selBounds();
        for (let y = b.y0; y <= b.y1; y++) {
            for (let x = b.x0; x <= b.x1; x++) {
                // `selHas` e non il riquadro: dentro il riquadro di un lazo ci
                // sono pixel che la selezione non contiene e che il taglio non
                // deve portare via.
                if (selHas(x, y)) g.clearRect(x, y, 1, 1);
            }
        }
        renderNow();
        markDirty();
        setStatus(t('pix.clip.cut', { w: c.width, h: c.height }), 'ok');
        return true;
    }

    // --- Incolla --------------------------------------------------------------

    function readSystemClipboardImage() {
        if (!navigator.clipboard || !navigator.clipboard.read) return Promise.resolve(null);
        return navigator.clipboard.read().then((items) => {
            for (let i = 0; i < items.length; i++) {
                const types = items[i].types || [];
                for (let k = 0; k < types.length; k++) {
                    if (types[k].indexOf('image/') === 0) return items[i].getType(types[k]);
                }
            }
            return null;
        }).catch(() => null);
    }

    function canvasFromImage(img) {
        const c = makeCanvas(img.width || img.naturalWidth, img.height || img.naturalHeight);
        ctx2d(c).drawImage(img, 0, 0);
        return c;
    }

    /** True se si puo' cominciare un incolla adesso (vedi PASTE_GUARD_MS). */
    function pasteGateOpen() {
        const now = Date.now();
        if (_pasteBusy) return false;
        if (now - _pasteAt < PASTE_GUARD_MS) return false;
        _pasteAt = now;
        _pasteBusy = true;
        return true;
    }

    function pasteGateClose() {
        _pasteBusy = false;
        _pasteAt = Date.now();
    }

    /**
     * Mette `src` sul documento. `asLayer` lo porta su un livello nuovo in cima
     * invece che su quello attivo.
     *
     * NON si maschera con la selezione corrente: quella sarebbe "Incolla
     * dentro", un'altra operazione. Qui la selezione viene SOSTITUITA dal
     * rettangolo incollato.
     */
    function pasteCanvas(src, asLayer) {
        if (!src || !src.width || !src.height) {
            setStatus(t('pix.clip.empty'), 'warn');
            return Promise.resolve(false);
        }

        const bigger = src.width > doc.w || src.height > doc.h;
        // La domanda va fatta PRIMA dello snapshot: `pixConfirm` e' asincrona e
        // uno snapshot preso prima resterebbe appeso se l'utente annulla.
        const ask = bigger
            ? pixConfirm(t('pix.clip.growAsk', { w: src.width, h: src.height, dw: doc.w, dh: doc.h }))
            : Promise.resolve(false);

        return ask.then((grow) => {
            pushHistory();
            if (grow) resizeCanvasTo(Math.max(src.width, doc.w), Math.max(src.height, doc.h), 'tl');

            // Origine: l'angolo della selezione se ce n'e' una (l'utente ha gia'
            // indicato dove vuole il contenuto), altrimenti il centro della
            // tela. Al centro e non a (0,0) perche' un incolla piccolo in un
            // angolo sembra non essere avvenuto.
            let ox, oy;
            if (selActive() && selBox) { ox = selBox.x0; oy = selBox.y0; }
            else { ox = Math.round((doc.w - src.width) / 2); oy = Math.round((doc.h - src.height) / 2); }
            ox = clamp(ox, 0, Math.max(0, doc.w - src.width));
            oy = clamp(oy, 0, Math.max(0, doc.h - src.height));

            const layer = asLayer ? addLayer(true) : activeLayer();
            layer.ctx.drawImage(src, ox, oy);

            const x1 = Math.min(doc.w - 1, ox + src.width - 1);
            const y1 = Math.min(doc.h - 1, oy + src.height - 1);
            const m = newMask();
            for (let y = oy; y <= y1; y++) {
                const row = y * doc.w;
                for (let x = ox; x <= x1; x++) m[row + x] = 1;
            }
            selSetMask(m);

            // `afterDocChange` sta in 12-image-ops: e' una dichiarazione di
            // funzione nella stessa closure, quindi e' gia' definita quando
            // questa riga gira (le chiamate partono tutte dal boot).
            afterDocChange();

            if (bigger && !grow) {
                setStatus(t('pix.clip.cropped', { w: src.width, h: src.height, dw: doc.w, dh: doc.h }), 'warn');
            } else {
                setStatus(t('pix.clip.pasted', { w: src.width, h: src.height }), 'ok');
            }
            return true;
        });
    }

    /** Incolla un'immagine che arriva da fuori (evento paste, appunti, file). */
    function pasteImageBlob(blob, asLayer) {
        if (!pasteGateOpen()) return Promise.resolve(false);
        return loadImageFromBlob(blob)
            .then((img) => pasteCanvas(canvasFromImage(img), asLayer))
            .catch(() => {
                setStatus(t('pix.clip.badImage'), 'err');
                return false;
            })
            .then((ok) => { pasteGateClose(); return ok; });
    }

    function pasteFromAnywhere(asLayer) {
        if (!pasteGateOpen()) return Promise.resolve(false);
        return readSystemClipboardImage()
            .then((blob) => {
                if (!blob) return null;
                // Un blob illeggibile non e' un motivo per rinunciare: la
                // riserva interna puo' benissimo avere qualcosa di buono.
                return loadImageFromBlob(blob).then(canvasFromImage).catch(() => null);
            })
            .then((fromSystem) => {
                const src = fromSystem || _clipCanvas;
                if (!src) { setStatus(t('pix.clip.empty'), 'warn'); return false; }
                return pasteCanvas(src, asLayer);
            })
            .then((ok) => { pasteGateClose(); return ok; });
    }

    function doPaste() { return pasteFromAnywhere(false); }
    function doPasteAsLayer() { return pasteFromAnywhere(true); }

    // --- Collegamento ---------------------------------------------------------

    /**
     * L'evento `paste` del documento e' la via PIU' affidabile per cio' che
     * arriva da fuori: porta l'immagine con se', senza permessi e senza l'API
     * asincrona, quindi funziona anche dove `navigator.clipboard.read` non
     * esiste. Si ignora quando il bersaglio e' un campo di testo, dove Ctrl+V
     * deve incollare TESTO.
     */
    function onDocumentPaste(ev) {
        if (isTypingTarget(ev.target)) return;
        const items = (ev.clipboardData && ev.clipboardData.items) || [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind !== 'file' || String(items[i].type).indexOf('image/') !== 0) continue;
            const file = items[i].getAsFile();
            if (!file) continue;
            ev.preventDefault();
            pasteImageBlob(file, false);
            return;
        }
    }

    function initClipboard() {
        const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
        bind('pixCopyBtn', () => doCopy(false));
        bind('pixCutBtn', doCut);
        bind('pixPasteBtn', doPaste);
        bind('pixPasteLayerBtn', doPasteAsLayer);
        document.addEventListener('paste', onDocumentPaste);
    }
