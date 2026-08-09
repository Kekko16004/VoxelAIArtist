    // =======================================================================
    //  04 - Il documento: tela, livelli, composizione
    //
    //  Il documento e' una pila di livelli, ognuno un canvas offscreen delle
    //  ESATTE dimensioni della tela. Non ci sono livelli piu' piccoli con un
    //  offset: costerebbe un rettangolo da tenere aggiornato in ogni operazione
    //  (disegno, incolla, specchia, ritaglia) e ogni strumento dovrebbe
    //  convertire le coordinate. Con livelli a piena tela, "pixel (x,y) del
    //  livello" e "pixel (x,y) del documento" sono la stessa cosa ovunque, e il
    //  costo e' memoria che serve comunque appena l'utente riempie il livello.
    //
    //  ORDINE: `doc.layers[0]` e' il FONDO, l'ultimo e' in cima. E' l'ordine in
    //  cui si compone (si disegna dal fondo verso l'alto) e va tenuto cosi'; la
    //  lista nel pannello lo mostra ROVESCIATO, perche' l'utente si aspetta la
    //  cima in cima. La conversione avviene in un punto solo, in 11-layers-ui.
    // =======================================================================

    let _layerSeq = 0;

    const doc = {
        w: DOC_DEFAULT_W,
        h: DOC_DEFAULT_H,
        layers: [],
        active: 0,
        name: 'sprite',
    };

    /**
     * Un livello nuovo, trasparente, della dimensione corrente della tela.
     * `opacity` e' 0..1 (moltiplicatore di composizione), non 0..100: la UI
     * mostra percentuali ma il canvas vuole un moltiplicatore, e convertire in
     * un punto solo evita di chiedersi ogni volta in che unita' sia il valore.
     */
    function makeLayer(name, w, h) {
        const canvas = makeCanvas(w || doc.w, h || doc.h);
        return {
            id: ++_layerSeq,
            name: name,
            visible: true,
            opacity: 1,
            canvas: canvas,
            ctx: ctx2d(canvas),
        };
    }

    function activeLayer() {
        return doc.layers[doc.active] || null;
    }

    /**
     * Nome automatico di un livello: "Livello 3".
     *
     * Il nome NON si limita a essere calcolato, si RICORDA da dove viene
     * (`autoKey` / `autoArgs`), e serve a due cose distinte:
     *
     *  - Il primo livello nasce dentro `init()`, cioe' PRIMA di `bootI18n()`,
     *    dove `t()` ritorna la chiave nuda per contratto. Senza memoria del
     *    perche', quel livello si chiamerebbe per sempre "pix.layer.itemName" -
     *    ed e' esattamente cosi' che si presentava nell'elenco (visto in GUI
     *    reale, invisibile leggendo il codice: la chiave esiste, il dizionario
     *    no, e nessuno solleva).
     *  - Un nome che l'utente non ha scritto e' una didascalia, non un dato:
     *    passando all'inglese "Livello 2" deve diventare "Layer 2".
     *
     * Appena qualcuno rinomina il livello - a mano o aprendo un file - la
     * memoria si cancella (`clearAutoName`) e il nome diventa suo.
     */
    function autoNameLayer(layer, key, args) {
        layer.autoKey = key;
        layer.autoArgs = args || null;
        layer.name = t(key, resolveAutoArgs(args));
        return layer;
    }

    /**
     * Risolve gli argomenti di un nome automatico, che possono essere a loro
     * volta nomi automatici: `{ key, args }` invece di una stringa.
     *
     * Serve perche' l'etichetta di una copia ha DUE parti traducibili. La copia
     * di "Livello 2" e' "Livello 2 copia", e in inglese devono cambiare tutte e
     * due: "Layer 2 copy". Trattandone una sola - il caso in cui si era
     * inciampati - la riga restava "Livello 2 copia" accanto a "Layer 1", cioe'
     * l'elenco in due lingue insieme.
     *
     * Un argomento che NON e' un nome automatico passa intatto, ed e' cosi' che
     * la copia di un livello rinominato a mano conserva la parola dell'utente
     * ("Cielo copia" -> "Cielo copy"): si traduce la didascalia, non il dato.
     */
    function resolveAutoArgs(args) {
        if (!args) return null;
        const out = {};
        for (const k in args) {
            if (!Object.prototype.hasOwnProperty.call(args, k)) continue;
            const v = args[k];
            out[k] = (v && typeof v === 'object' && v.key) ? t(v.key, resolveAutoArgs(v.args)) : v;
        }
        return out;
    }

    /** Il livello come argomento di un altro nome: il suo riferimento
     *  automatico se ne ha uno, altrimenti il nome che ha adesso (che a quel
     *  punto e' testo dell'utente e non si tocca). */
    function autoRefOf(layer) {
        return layer.autoKey ? { key: layer.autoKey, args: layer.autoArgs } : layer.name;
    }

    function clearAutoName(layer) {
        if (layer) { layer.autoKey = null; layer.autoArgs = null; }
    }

    /**
     * Rideriva i nomi automatici. Registrata in `I18N_REDRAW`: l'elenco dei
     * livelli e' costruito da JS, quindi `applyI18n` (che lavora sugli attributi
     * `data-i18n` del template) non lo vedrebbe mai.
     */
    function relabelAutoLayers() {
        for (const l of doc.layers) {
            if (l.autoKey) l.name = t(l.autoKey, resolveAutoArgs(l.autoArgs));
        }
        if (typeof refreshLayerList === 'function') refreshLayerList();
    }

    /**
     * Ricrea il documento da zero. NON tocca la cronologia: chi chiama decide
     * se l'operazione e' annullabile (aprire un file lo e', l'avvio no).
     */
    function newDoc(w, h, keepName) {
        doc.w = clampInt(w, DOC_MIN_SIDE, DOC_MAX_SIDE);
        doc.h = clampInt(h, DOC_MIN_SIDE, DOC_MAX_SIDE);
        doc.layers = [autoNameLayer(makeLayer(''), 'pix.layer.itemName', { n: 1 })];
        doc.active = 0;
        if (!keepName) doc.name = 'sprite';
    }

    function addLayer(atTop) {
        const l = autoNameLayer(makeLayer(''), 'pix.layer.itemName',
                                { n: doc.layers.length + 1 });
        const at = atTop ? doc.layers.length : (doc.active + 1);
        doc.layers.splice(at, 0, l);
        doc.active = at;
        return l;
    }

    function duplicateLayer() {
        const src = activeLayer();
        if (!src) return null;
        // Il nome della copia resta AUTOMATICO anche quando l'originale e' stato
        // rinominato a mano: "copia" e' una didascalia e deve seguire la lingua,
        // mentre la parola dell'utente viaggia dentro l'argomento e passa
        // intatta (vedi resolveAutoArgs).
        const l = autoNameLayer(makeLayer(''), 'pix.layer.copyName', { name: autoRefOf(src) });
        l.visible = src.visible;
        l.opacity = src.opacity;
        l.ctx.drawImage(src.canvas, 0, 0);
        doc.layers.splice(doc.active + 1, 0, l);
        doc.active += 1;
        return l;
    }

    /** Elimina il livello attivo. Ritorna false se e' l'ultimo rimasto. */
    function deleteLayer() {
        if (doc.layers.length <= 1) return false;
        doc.layers.splice(doc.active, 1);
        doc.active = clamp(doc.active - 1, 0, doc.layers.length - 1);
        return true;
    }

    /** `dir` = +1 verso la cima, -1 verso il fondo. */
    function moveLayer(dir) {
        const to = doc.active + dir;
        if (to < 0 || to >= doc.layers.length) return false;
        const l = doc.layers[doc.active];
        doc.layers[doc.active] = doc.layers[to];
        doc.layers[to] = l;
        doc.active = to;
        return true;
    }

    /**
     * Fonde il livello attivo su quello SOTTO.
     *
     * L'opacita' del livello di sopra entra nel disegno (viene "cotta" nei
     * pixel) mentre quella di sotto resta una proprieta' del livello: e' la
     * regola di ogni editor a livelli, e l'alternativa - moltiplicare entrambe
     * nei pixel - cambierebbe l'aspetto del risultato appena il livello di
     * sotto non e' opaco.
     */
    function mergeDown() {
        if (doc.active <= 0) return false;
        const top = doc.layers[doc.active];
        const bottom = doc.layers[doc.active - 1];
        bottom.ctx.save();
        bottom.ctx.globalAlpha = top.opacity;
        bottom.ctx.drawImage(top.canvas, 0, 0);
        bottom.ctx.restore();
        doc.layers.splice(doc.active, 1);
        doc.active -= 1;
        return true;
    }

    /** Riduce il documento a un solo livello, con il composito dentro. */
    function flattenDoc() {
        if (doc.layers.length <= 1 && doc.layers[0] && doc.layers[0].opacity === 1) return false;
        const flat = autoNameLayer(makeLayer(''), 'pix.layer.flatName');
        compositeTo(flat.ctx);
        doc.layers = [flat];
        doc.active = 0;
        return true;
    }

    /**
     * Disegna tutti i livelli visibili su un contesto, dal fondo alla cima.
     * E' l'unico posto che conosce l'ordine di composizione: il visore, le
     * miniature, l'export PNG e il contesto mandato all'AI passano tutti da qui,
     * quindi non possono mostrare tre immagini diverse dello stesso documento.
     */
    function compositeTo(g, w, h) {
        const W = w || doc.w, H = h || doc.h;
        g.clearRect(0, 0, W, H);
        g.save();
        g.imageSmoothingEnabled = false;
        for (let i = 0; i < doc.layers.length; i++) {
            const l = doc.layers[i];
            if (!l.visible || l.opacity <= 0) continue;
            g.globalAlpha = l.opacity;
            g.drawImage(l.canvas, 0, 0);
        }
        g.restore();
    }

    /** Il documento composito in un canvas nuovo (per export e contesto AI). */
    function flattenToCanvas() {
        const c = makeCanvas(doc.w, doc.h);
        compositeTo(ctx2d(c));
        return c;
    }

    // --- Ridimensionamento ---------------------------------------------------
    // Due operazioni diverse che a parole si somigliano e vanno tenute distinte:
    //  - RIDIMENSIONA IMMAGINE: il disegno viene ricampionato, la tela cambia.
    //  - RIDIMENSIONA TELA: il disegno resta della sua dimensione, la tela gli
    //    cresce o gli si stringe attorno (con un ancoraggio).
    // Un editor che ne offre una sola costringe a rifare il disegno per
    // aggiungere un margine.

    /**
     * Applica a OGNI livello una trasformazione che ridisegna il vecchio canvas
     * su uno nuovo di dimensione (w,h).
     *
     * Il canvas d'appoggio e' obbligatorio: assegnare `width`/`height` a un
     * canvas lo AZZERA, quindi ridimensionare quello esistente e poi leggerne i
     * pixel darebbe una tela vuota.
     */
    function remapLayers(w, h, draw) {
        for (let i = 0; i < doc.layers.length; i++) {
            const l = doc.layers[i];
            const old = l.canvas;
            const nc = makeCanvas(w, h);
            const ng = ctx2d(nc);
            draw(ng, old, i);
            l.canvas = nc;
            l.ctx = ng;
        }
        doc.w = w;
        doc.h = h;
    }

    function resizeImage(w, h, smooth) {
        const W = clampInt(w, DOC_MIN_SIDE, DOC_MAX_SIDE);
        const H = clampInt(h, DOC_MIN_SIDE, DOC_MAX_SIDE);
        remapLayers(W, H, (g, old) => {
            g.imageSmoothingEnabled = !!smooth;
            g.drawImage(old, 0, 0, old.width, old.height, 0, 0, W, H);
        });
    }

    /**
     * `anchor` e' una delle nove posizioni "tl","t","tr","l","c","r","bl","b","br":
     * dice dove finisce il disegno vecchio dentro la tela nuova.
     */
    function resizeCanvasTo(w, h, anchor) {
        const W = clampInt(w, DOC_MIN_SIDE, DOC_MAX_SIDE);
        const H = clampInt(h, DOC_MIN_SIDE, DOC_MAX_SIDE);
        const a = String(anchor || 'tl');
        const dx = a.indexOf('l') >= 0 ? 0 : (a.indexOf('r') >= 0 ? (W - doc.w) : Math.round((W - doc.w) / 2));
        const dy = a.indexOf('t') >= 0 ? 0 : (a.indexOf('b') >= 0 ? (H - doc.h) : Math.round((H - doc.h) / 2));
        remapLayers(W, H, (g, old) => { g.drawImage(old, dx, dy); });
    }

    /** Ritaglia il documento al rettangolo (inclusivo) dato. */
    function cropTo(x0, y0, x1, y1) {
        const X0 = clampInt(Math.min(x0, x1), 0, doc.w - 1);
        const Y0 = clampInt(Math.min(y0, y1), 0, doc.h - 1);
        const X1 = clampInt(Math.max(x0, x1), 0, doc.w - 1);
        const Y1 = clampInt(Math.max(y0, y1), 0, doc.h - 1);
        const W = X1 - X0 + 1, H = Y1 - Y0 + 1;
        remapLayers(W, H, (g, old) => { g.drawImage(old, -X0, -Y0); });
    }

    /**
     * Rettangolo dei pixel non trasparenti del COMPOSITO, oppure null se il
     * documento e' interamente vuoto (in quel caso rifilare lo azzererebbe).
     */
    function opaqueBounds() {
        const c = flattenToCanvas();
        const d = ctx2d(c).getImageData(0, 0, doc.w, doc.h).data;
        let x0 = doc.w, y0 = doc.h, x1 = -1, y1 = -1;
        for (let y = 0; y < doc.h; y++) {
            for (let x = 0; x < doc.w; x++) {
                if (d[(y * doc.w + x) * 4 + 3] === 0) continue;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
        return x1 < 0 ? null : { x0: x0, y0: y0, x1: x1, y1: y1 };
    }
