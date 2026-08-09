    // =======================================================================
    //  24 - Avvio
    //
    //  L'unico modulo che ESEGUE qualcosa. Tutti gli altri dichiarano soltanto
    //  funzioni e costanti, ed e' per questo che l'ordine del manifest conta
    //  solo per le costanti (`const` ha la temporal dead zone) e non per le
    //  funzioni fra loro: quando `init()` parte, il bundle e' gia' tutto letto.
    //
    //  Qui si chiude anche la closure aperta da 00-bootstrap-head.js.
    // =======================================================================

    const PIXELAI_VERSION = '1.0.0';

    /**
     * Ordine di avvio. Solo tre vincoli sono veri, il resto e' indifferente e
     * l'ordine sotto e' scritto per raccontare cosa succede:
     *
     *  - `cacheViewportDom()` per prima: mezza app legge `elStage`/`elCanvas`,
     *    e prima di questa chiamata sono `null`.
     *  - `initShortcuts()` dopo `initPointer()`: le scorciatoie scrivono
     *    `spaceDown` e leggono il viewport, che il puntatore governa.
     *  - `initSettingsUI()` dopo `initPrefs()`: altrimenti il modale mostra il
     *    tema scritto nel template invece di quello salvato, e la prima
     *    apertura sembra aver dimenticato la preferenza.
     *
     * `initLayerOpacity()` NON si chiama qui: la chiama gia' `initLayersPanel()`.
     * Chiamarla due volte aggancerebbe due handler allo stesso cursore, e ogni
     * trascinamento spingerebbe DUE voci nella cronologia - cioe' due Ctrl+Z per
     * disfare un movimento solo.
     */
    function init() {
        cacheViewportDom();
        initPrefs();
        initDialogs();

        initToolbar();
        initPointer();
        initSwatches();
        initLayersPanel();

        initClipboard();
        initImageOps();
        initFilters();
        initIO();
        initAiPanel();
        initBridge();

        initShortcuts();
        initMenus();
        initSettingsUI();

        // Il documento vuoto di partenza. `newDoc` non tocca la cronologia (e'
        // usata anche dal ponte a documento gia' aperto), quindi la pila si
        // azzera qui: senza, il primo Ctrl+Z riporterebbe a uno stato di prima
        // dell'avvio che non e' mai esistito.
        newDoc(DOC_DEFAULT_W, DOC_DEFAULT_H);
        resetHistory();
        afterHistoryChange();
        layoutStage();
        zoomToFit();
        clearDirty();

        // Ultima e senza await: i testi italiani sono GIA' nel DOM (il template
        // e' annotato proprio da it.json), quindi aspettare i dizionari
        // ritarderebbe il primo disegno per non cambiare niente a chi usa
        // l'italiano. Chi usa un'altra lingua vede il testo cambiare, ed e' il
        // prezzo giusto: l'alternativa e' una pagina bianca finche' un fetch
        // non risponde, anche quando quel fetch fallira'.
        bootI18n();
    }

    /**
     * Un errore qui lascerebbe una pagina disegnata ma morta - il caso peggiore,
     * perche' sembra funzionante e non lo e'. Si scrive in console (per chi
     * sviluppa) e nella barra di stato (per chi usa), e si marca la radice:
     * `data-pixelai` e' anche il segnale che una prova automatica aspetta invece
     * di dormire un tempo a caso.
     */
    try {
        init();
        document.documentElement.setAttribute('data-pixelai', 'ready');
    } catch (err) {
        console.error('[PixelAI] avvio fallito:', err);
        document.documentElement.setAttribute('data-pixelai', 'error');
        try {
            const el = document.getElementById('pixStatusMsg');
            // `t()` funziona anche prima di bootI18n: senza dizionario ritorna
            // la chiave nuda, che qui e' comunque meglio del nulla.
            if (el) { el.textContent = t('pix.boot.failed'); el.className = 'grow msg err'; }
        } catch (e) { /* se anche questo salta, resta la console */ }
    }

    // Superficie pubblica: il minimo indispensabile. Tutto il resto vive nella
    // closure di proposito - `doc`, `zoom`, `sel` su `window` collidono con
    // l'API del browser e, quando l'editor gira dentro VoxelAIArtist, con la
    // pagina che lo ospita. Chi verifica l'app lo fa da fuori (tasti veri, clic
    // veri, poi DOM e pixel): esporre gli interni qui inviterebbe a provare
    // funzioni invece dell'interfaccia, ed e' l'interfaccia che si rompe.
    window.PixelAI = {
        version: PIXELAI_VERSION,
        isBridged: function () { return bridgeIsActive(); },
    };

});
