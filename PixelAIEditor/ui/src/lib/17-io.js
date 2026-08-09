    // =======================================================================
    //  17 - File: nuovo, apri, esporta, trascinamento
    //
    //  Non c'e' un formato di progetto: questo editor apre e salva IMMAGINI. Un
    //  .pixai con dentro i livelli sarebbe la cosa ovvia da aggiungere, e non
    //  c'e' perche' un file che apre solo questa applicazione vale meno di un
    //  PNG che aprono tutte. I livelli si portano fuori con lo ZIP, che qualunque
    //  programma sa scompattare.
    //
    //  UN SOLO `<input type="file">` PER TUTTO (`#pixFileInput`). Averne uno per
    //  comando vorrebbe dire tre nodi nascosti che fanno la stessa cosa e tre
    //  handler da tenere allineati; qui cambiano `accept` e l'azione in sospeso.
    //  Due trappole, entrambe silenziose:
    //    - il valore va AZZERATO prima di aprire il selettore, o riscegliere lo
    //      STESSO file non scatena `change` (il valore non e' cambiato) e il
    //      comando sembra semplicemente ignorato;
    //    - l'azione va letta e azzerata dentro l'handler, perche' un annullamento
    //      del selettore non emette nessun evento e la lascerebbe appesa.
    //
    //  SPORCO / PULITO. `_dirty` esiste per una domanda sola: "stai per perdere
    //  del lavoro?". Lo alzano gli strumenti (`markDirty`) e lo abbassano le
    //  operazioni che portano il disegno fuori di qui. E' volutamente pessimista:
    //  un falso "ci sono modifiche" costa un clic, un falso "e' tutto salvato"
    //  costa il disegno.
    // =======================================================================

    let _dirty = false;
    let _fileAction = null;     // funzione (File) => void, in attesa del `change`

    function markDirty() { _dirty = true; }
    function clearDirty() { _dirty = false; }
    function isDirty() { return _dirty; }

    /**
     * Chiede conferma se c'e' lavoro non salvato. Ritorna una Promise di
     * booleano: `await` funziona sia qui sia se un domani `pixConfirm`
     * diventasse sincrona.
     */
    function confirmDiscard() {
        if (!_dirty) return Promise.resolve(true);
        return Promise.resolve(pixConfirm(t('pix.io.unsaved')));
    }

    // --- Selettore di file ---------------------------------------------------

    function pickFile(accept, action) {
        const input = $('pixFileInput');
        if (!input) return;
        _fileAction = action;
        input.accept = accept || 'image/*';
        input.value = '';               // vedi la nota in testa: senza, il secondo giro e' muto
        input.click();
    }

    function onFileInputChange(ev) {
        const files = ev.target && ev.target.files;
        const file = files && files[0];
        const action = _fileAction;
        _fileAction = null;
        if (!file || !action) return;
        action(file);
    }

    /**
     * Un file trascinato puo' arrivare con `type` vuoto (capita da certi archivi
     * e da alcune applicazioni): l'estensione e' l'unico appiglio rimasto, e
     * rifiutare il file perche' il sistema non ha saputo dire cos'e' sarebbe un
     * "non e' un'immagine" davanti a un PNG.
     */
    function isImageFile(file) {
        if (!file) return false;
        if (/^image\//i.test(file.type || '')) return true;
        return /\.(png|jpe?g|gif|bmp|webp|avif)$/i.test(file.name || '');
    }

    // --- Nuovo ---------------------------------------------------------------

    async function fileNew() {
        if (!(await confirmDiscard())) return false;
        const res = await pixPrompt({
            title: t('pix.file.new'),
            fields: [
                { name: 'w', type: 'number', label: t('pix.dlg.width'), value: doc.w, min: DOC_MIN_SIDE, max: DOC_MAX_SIDE },
                { name: 'h', type: 'number', label: t('pix.dlg.height'), value: doc.h, min: DOC_MIN_SIDE, max: DOC_MAX_SIDE },
            ],
        });
        if (!res) return false;
        const w = clampInt(res.w, DOC_MIN_SIDE, DOC_MAX_SIDE);
        const h = clampInt(res.h, DOC_MIN_SIDE, DOC_MAX_SIDE);

        newDoc(w, h);
        selectNone();
        // La cronologia si azzera DOPO il documento nuovo: un annulla che
        // riportasse al disegno di prima riaprirebbe un lavoro che l'utente ha
        // appena accettato di buttare, ma con la tela di adesso.
        resetHistory();
        zoomToFit();
        afterDocChange();
        clearDirty();               // `afterDocChange` sporca: qui la modifica E' il documento
        setStatus(t('pix.io.newDone', { w: doc.w, h: doc.h }), 'ok');
        return true;
    }

    // --- Apertura ------------------------------------------------------------

    function fileOpen() {
        pickFile('image/*', (file) => { openAsDocument(file); });
    }

    function fileOpenAsLayer() {
        pickFile('image/*', (file) => { openAsLayer(file); });
    }

    /** File -> immagine decodificata, oppure null (con il messaggio gia' dato). */
    async function decodeImageFile(file) {
        if (!isImageFile(file)) {
            setStatus(t('pix.io.notImage'), 'err');
            return null;
        }
        try {
            return await loadImageFromBlob(file);
        } catch (e) {
            setStatus(t('pix.io.readError', { name: file.name || '' }), 'err');
            return null;
        }
    }

    async function openAsDocument(file) {
        if (!(await confirmDiscard())) return false;
        const img = await decodeImageFile(file);
        if (!img) return false;

        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        let w = iw, h = ih;
        // Oltre il tetto si RIDUCE invece di rifiutare: un'immagine da 6000 px
        // e' quasi sempre una foto da cui si vuole ricavare uno sprite, e
        // "troppo grande, arrangiati" costringerebbe a passare da un altro
        // programma per fare esattamente questo.
        if (iw > DOC_MAX_SIDE || ih > DOC_MAX_SIDE) {
            const k = Math.min(DOC_MAX_SIDE / iw, DOC_MAX_SIDE / ih);
            w = Math.max(1, Math.round(iw * k));
            h = Math.max(1, Math.round(ih * k));
        }

        newDoc(w, h);
        doc.name = safeName(file.name, doc.name);
        const l = activeLayer();
        l.ctx.save();
        // L'interpolazione si accende SOLO quando si sta rimpicciolendo davvero.
        // A dimensione invariata (il caso normale: si apre un PNG di pixel art)
        // resta spenta, perche' e' esattamente cio' che altrimenti sbava i bordi
        // netti; su una riduzione forte, invece, il "pixel piu' vicino" darebbe
        // un'immagine sgranata e irriconoscibile.
        l.ctx.imageSmoothingEnabled = (w !== iw || h !== ih);
        l.ctx.drawImage(img, 0, 0, iw, ih, 0, 0, w, h);
        l.ctx.restore();

        selectNone();
        resetHistory();
        zoomToFit();
        afterDocChange();
        clearDirty();
        if (w !== iw || h !== ih) {
            setStatus(t('pix.io.scaled', { w: w, h: h, max: DOC_MAX_SIDE }), 'warn');
        } else {
            setStatus(t('pix.io.openDone', { name: file.name || '', w: w, h: h }), 'ok');
        }
        return true;
    }

    /**
     * L'immagine entra come livello nuovo, appoggiata in alto a sinistra e
     * TAGLIATA se e' piu' grande della tela.
     *
     * Non si ridimensiona il documento e non si scala l'immagine: sono due
     * decisioni che l'utente puo' prendere dopo (c'e' "Ridimensiona tela" e c'e'
     * la trasformazione dell'incolla), mentre farle qui automaticamente
     * cambierebbe il disegno gia' fatto per colpa di un file appena aggiunto.
     * Il taglio pero' va DETTO, o sembra che l'immagine sia arrivata storta.
     */
    async function openAsLayer(file) {
        const img = await decodeImageFile(file);
        if (!img) return false;

        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;

        pushHistory();
        const l = addLayer(true);
        l.name = safeName(file.name, l.name);
        // Il livello prende il nome del file: non e' piu' un nome automatico, e
        // un cambio di lingua non deve riportarlo a "Livello 2".
        clearAutoName(l);
        l.ctx.drawImage(img, 0, 0);
        afterDocChange();
        markDirty();

        if (iw > doc.w || ih > doc.h) {
            setStatus(t('pix.io.layerClipped', { w: doc.w, h: doc.h }), 'warn');
        } else {
            setStatus(t('pix.io.openLayerDone', { name: l.name }), 'ok');
        }
        return true;
    }

    // --- Esportazione --------------------------------------------------------

    /**
     * PNG del composito, cioe' il disegno COME SI VEDE: livelli nascosti fuori,
     * opacita' applicate. E' il PNG che l'utente si aspetta, e coincide con
     * l'anteprima, che e' l'unica garanzia che non ci sia una sorpresa dentro il
     * file.
     */
    async function fileExportPng() {
        try {
            const blob = await canvasToBlob(flattenToCanvas());
            const name = safeName(doc.name, 'sprite') + '.png';
            downloadBlob(blob, name);
            // Un solo livello: il PNG contiene TUTTO il documento, quindi il
            // lavoro e' davvero al sicuro. Con piu' livelli il PNG e' una
            // riduzione (li appiattisce), e dire "salvato" spingerebbe a chiudere
            // perdendo la struttura: li' lo sporco resta.
            if (doc.layers.length <= 1) clearDirty();
            setStatus(t('pix.io.exportDone', { name: name }), 'ok');
            return true;
        } catch (e) {
            console.warn('[io] export PNG', e);
            setStatus(t('pix.io.exportError'), 'err');
            return false;
        }
    }

    /**
     * Un PNG per livello dentro un unico ZIP.
     *
     * Lo ZIP non e' una comodita': i browser BLOCCANO i download multipli, quindi
     * dieci `downloadBlob` di fila fanno partire il primo e poi un avviso di
     * sicurezza, con gli altri nove persi in silenzio. E' l'unica ragione per cui
     * esiste `16-zip.js`.
     *
     * Il numero d'ordine e' nel nome (`01-...`) perche' un archivio non conserva
     * l'ordine: senza, chi lo riapre non sa piu' quale livello stava sopra, che
     * e' l'unica informazione che i PNG separati non portano con se'.
     * L'indice 1 e' il livello di FONDO, come nella lista.
     */
    async function fileExportLayersZip() {
        try {
            const used = new Set();
            const files = [];
            for (let i = 0; i < doc.layers.length; i++) {
                const l = doc.layers[i];
                const blob = await canvasToBlob(l.canvas);
                const buf = new Uint8Array(await blob.arrayBuffer());
                const num = (i + 1 < 10 ? '0' : '') + (i + 1);
                const name = zipUniqueName(num + '-' + safeName(l.name, num) + '.png', used);
                files.push({ name: name, data: buf });
            }
            const zipName = t('pix.io.zipName', { name: safeName(doc.name, 'sprite') });
            downloadBlob(createZipBlob(files), zipName);
            // Qui esce TUTTO, livelli nascosti compresi: il documento e' fuori di
            // qui per intero, quindi lo sporco si azzera davvero.
            clearDirty();
            setStatus(t('pix.io.zipDone', { n: files.length, name: zipName }), 'ok');
            return true;
        } catch (e) {
            console.warn('[io] export ZIP', e);
            setStatus(t('pix.io.exportError'), 'err');
            return false;
        }
    }

    // --- Trascinamento -------------------------------------------------------

    /**
     * Un'immagine trascinata sul visore diventa un livello nuovo.
     *
     * `preventDefault` su `dragover` NON e' una raffinatezza: senza, l'area non
     * e' un bersaglio valido, il `drop` non arriva mai e il browser fa la sua
     * cosa predefinita - APRE l'immagine al posto della pagina. L'applicazione
     * sparisce dalla scheda portandosi via il disegno non salvato.
     *
     * Per lo stesso motivo la difesa e' anche sulla finestra: un rilascio che
     * manca il visore di venti pixel non deve costare il lavoro.
     */
    function initDropTarget() {
        const stop = (ev) => { ev.preventDefault(); };
        window.addEventListener('dragover', stop, false);
        window.addEventListener('drop', stop, false);

        const vp = $('pixViewport');
        if (!vp) return;
        // Il segnale visivo e' uno stile in linea e non una classe: nel CSS del
        // template non c'e' una regola per questo stato, e inventarne una
        // vorrebbe dire toccare il template (che non e' di questo modulo). Il
        // colore viene dal token dell'accento, cosi' segue tema e personalizzazione.
        const mark = (on) => {
            vp.style.outline = on ? '2px dashed var(--accent-primary)' : '';
            vp.style.outlineOffset = on ? '-4px' : '';
        };
        vp.addEventListener('dragover', (ev) => {
            ev.preventDefault();
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
            mark(true);
        });
        // `dragleave` scatta anche passando SOPRA i figli del visore (la tela, il
        // riquadro della selezione): senza il controllo sul nodo di destinazione
        // il contorno lampeggerebbe a ogni movimento del puntatore.
        vp.addEventListener('dragleave', (ev) => {
            if (!vp.contains(ev.relatedTarget)) mark(false);
        });
        vp.addEventListener('drop', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            mark(false);
            const dt = ev.dataTransfer;
            const file = dt && dt.files && dt.files[0];
            if (!file) return;
            if (!isImageFile(file)) { setStatus(t('pix.io.notImage'), 'err'); return; }
            openAsLayer(file);
        });
    }

    // --- Avvio ---------------------------------------------------------------

    function initIO() {
        const wire = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
        wire('pixNewBtn', fileNew);
        wire('pixOpenBtn', fileOpen);
        wire('pixOpenLayerBtn', fileOpenAsLayer);
        wire('pixExportBtn', fileExportPng);
        wire('pixExportLayersBtn', fileExportLayersZip);

        const input = $('pixFileInput');
        if (input) input.addEventListener('change', onFileInputChange);

        initDropTarget();

        /**
         * L'avviso di chiusura usa il MECCANISMO STANDARD e nessun testo
         * personalizzato: i browser ignorano da anni la stringa che si passa e
         * mostrano la propria. Scriverne una qui darebbe un messaggio da
         * tradurre che non comparira' mai.
         */
        window.addEventListener('beforeunload', (ev) => {
            if (!_dirty) return;
            // Dentro VoxelAIArtist l'avviso NON si mostra: qui "salvare" vuol
            // dire riportare le facce al materiale, e chi chiude lo fa dal
            // pulsante del ponte, che chiede conferma nell'altra app. Un
            // secondo avviso, per giunta con il testo generico del browser
            // ("i dati potrebbero non essere salvati"), comparirebbe a chi ha
            // appena premuto "Applica" e ha gia' salvato.
            if (typeof bridgeIsActive === 'function' && bridgeIsActive()) return;
            ev.preventDefault();
            ev.returnValue = '';
        });
    }
