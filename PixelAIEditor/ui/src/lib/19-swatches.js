    // =======================================================================
    //  19 - Palette di colori
    //
    //  La palette e' un elenco di hex e nient'altro: nessuna opacita', nessun
    //  nome. L'opacita' e' una proprieta' del PENNELLO (`colorAlpha`), non del
    //  colore, e metterla anche qui creerebbe due verita' sul colore corrente -
    //  quella della tavolozza e quella del cursore - che divergono al primo
    //  clic.
    //
    //  Gesti (l'unico posto dove sono scritti, e il titolo di ogni casella li
    //  ripete perche' nessuno li indovina da solo):
    //    clic          -> colore primario
    //    clic destro   -> colore secondario  (Ctrl+clic fa lo stesso: su un
    //                     trackpad senza secondo tasto e' l'unica via)
    //    Alt+clic      -> rimuove il colore dalla palette
    //  Alt e non un menu contestuale: il tasto destro e' gia' preso dal colore
    //  secondario, e un menu per una sola voce e' due gesti al posto di uno.
    //  Nessuna conferma, perche' rimettere un colore costa un clic sul "+".
    // =======================================================================

    // Rampa da pixel art, non i colori puri del web: il rosso #ff0000 e il verde
    // #00ff00 non stanno insieme in nessun disegno, e una tavolozza di partenza
    // che non si puo' usare e' peggio di una vuota. Sono famiglie da 3-5 valori
    // (scuro -> chiaro) perche' in pixel art l'ombreggiatura si fa scegliendo il
    // gradino accanto, non schiarendo un colore a mano.
    const DEFAULT_SWATCHES = [
        '#12121a', '#3a3d4a', '#6e7385', '#b9bec9', '#f2f3f7',   // neutri
        '#6b3f2a', '#a9663f', '#d99a6c', '#f6d3ae',               // pelle
        '#4a2f1b', '#7a5230', '#ab7c46',                          // legno
        '#1e4d2b', '#3f8f3f', '#7ac74f',                          // verde
        '#16324f', '#2a6f97', '#4fa3d1', '#a8dff0',               // azzurro
        '#5c1a1a', '#a32b2b', '#e05252',                          // rosso
        '#d9852b', '#f2c14e',                                     // giallo
    ];

    // Il pannello e' largo 280 px: a 20 px per casella ci stanno ~11 per riga,
    // quindi 64 colori sono 6 righe. Oltre, la palette diventa una lista da
    // scorrere e smette di essere una tavolozza che si abbraccia con l'occhio.
    const MAX_SWATCHES = 64;
    const SWATCH_PREF = 'swatches';

    // Il "+" e' un SVG e non il carattere '+', per la stessa ragione della
    // freccetta dei pannelli: un glifo tipografico obbligherebbe a decidere la
    // codifica del sorgente e verrebbe contato dalla guardia i18n come testo.
    const SWATCH_ADD_SVG =
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
        'stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>';

    let _swatches = DEFAULT_SWATCHES.slice(0);

    /** "#RGB", "RRGGBB", "#RrGgBb" -> "#rrggbb"; null se non e' un colore. */
    function swatchHex(hex) {
        const c = hexToRgb(hex);
        return c ? rgbToHex(c.r, c.g, c.b) : null;
    }

    /** Normalizza, scarta i non-colori, toglie i doppioni e taglia al massimo. */
    function swatchClean(list) {
        const out = [];
        if (!list || !list.length) return out;
        for (let i = 0; i < list.length && out.length < MAX_SWATCHES; i++) {
            const h = swatchHex(list[i]);
            if (h && out.indexOf(h) < 0) out.push(h);
        }
        return out;
    }

    /** L'elenco degli hex della palette corrente (copia: chi la usa la modifica). */
    function swatchColors() { return _swatches.slice(0); }

    function saveSwatches() {
        savePref(SWATCH_PREF, JSON.stringify(_swatches));
    }

    // --- Disegno del pannello -------------------------------------------------

    function refreshSwatches() {
        const box = $('pixSwatches');
        if (!box) return;
        box.innerHTML = '';
        for (let i = 0; i < _swatches.length; i++) {
            const hex = _swatches[i];
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'swatch';
            b.style.background = hex;
            b.setAttribute('data-hex', hex);
            b.title = t('pix.swatch.item', { hex: hex });
            box.appendChild(b);
        }

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'swatch';
        add.setAttribute('data-swatch-add', '1');
        add.title = t('pix.swatch.add');
        // Stili in linea e non una classe: il tema non ha una regola per questa
        // casella, e inventarne una qui vorrebbe dire toccare il CSS del
        // template. Il bordo e la dimensione arrivano comunque da .swatch,
        // quindi il "+" resta allineato alle altre caselle.
        add.style.background = 'transparent';
        add.style.display = 'flex';
        add.style.alignItems = 'center';
        add.style.justifyContent = 'center';
        add.style.color = 'var(--text-secondary)';
        add.innerHTML = SWATCH_ADD_SVG;
        box.appendChild(add);

        refreshSwatchActive();
    }

    /**
     * Sposta SOLO l'evidenziazione. La chiama `refreshColorUI` a ogni cambio di
     * colore, contagocce compreso: se ricostruisse le caselle, tenere premuto
     * Alt e passare sul disegno rifarebbe la tavolozza a ogni pixel toccato.
     */
    function refreshSwatchActive() {
        const box = $('pixSwatches');
        if (!box) return;
        const cur = String(colorPrimary || '').toLowerCase();
        for (let i = 0; i < box.children.length; i++) {
            const el = box.children[i];
            const h = el.getAttribute('data-hex');
            el.classList.toggle('active', !!h && h === cur);
        }
    }

    // --- Modifiche alla palette -----------------------------------------------

    function addSwatch(hex) {
        const h = swatchHex(hex);
        if (!h) return false;
        if (_swatches.indexOf(h) >= 0) {
            // Un doppione non e' un errore da nascondere: senza messaggio, il
            // clic sul "+" sembra non aver fatto nulla.
            setStatus(t('pix.msg.swatchExists'), 'warn');
            return false;
        }
        if (_swatches.length >= MAX_SWATCHES) {
            setStatus(t('pix.msg.swatchFull', { n: MAX_SWATCHES }), 'warn');
            return false;
        }
        _swatches.push(h);
        saveSwatches();
        refreshSwatches();
        return true;
    }

    function removeSwatch(hex) {
        const i = _swatches.indexOf(String(hex || '').toLowerCase());
        if (i < 0) return false;
        _swatches.splice(i, 1);
        saveSwatches();
        refreshSwatches();
        setStatus(t('pix.msg.swatchRemoved'), 'ok');
        return true;
    }

    /**
     * Sostituisce l'intera palette. La usa chi RICAVA una tavolozza dal disegno
     * (il filtro "Palette e dithering", la generazione AI): la sostituzione e'
     * voluta, perche' aggiungere venti colori a quelli gia' presenti darebbe
     * una tavolozza che non e' ne' quella vecchia ne' quella nuova.
     */
    function setSwatchesFromColors(list) {
        const clean = swatchClean(list);
        if (!clean.length) return false;
        _swatches = clean;
        saveSwatches();
        refreshSwatches();
        return true;
    }

    // --- Eventi ----------------------------------------------------------------
    // Un solo gestore sul contenitore, non uno per casella: le caselle si
    // rifanno a ogni modifica della palette, e agganciarle una per una
    // significherebbe riagganciare tutto ogni volta.

    function onSwatchClick(ev) {
        const b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
        if (!b) return;
        if (b.hasAttribute('data-swatch-add')) { addSwatch(colorPrimary); return; }
        const hex = b.getAttribute('data-hex');
        if (!hex) return;
        if (ev.altKey) { removeSwatch(hex); return; }
        if (ev.ctrlKey || ev.metaKey) { setSecondary(hex); return; }
        setPrimary(hex);
    }

    function onSwatchContext(ev) {
        const b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
        if (!b) return;
        // Il menu del browser va fermato comunque: aperto sopra la tavolozza
        // copre le caselle e il clic successivo finisce su di lui.
        ev.preventDefault();
        const hex = b.getAttribute('data-hex');
        if (hex) setSecondary(hex);
    }

    function initSwatches() {
        let saved = null;
        try {
            const raw = loadPref(SWATCH_PREF, '');
            if (raw) saved = JSON.parse(raw);
        } catch (e) {
            // Una preferenza illeggibile (scritta a mano, o di una versione
            // vecchia) non deve impedire l'avvio: si riparte dalla palette
            // predefinita, che e' esattamente cio' che serve in quel caso.
            saved = null;
        }
        const clean = swatchClean(saved);
        _swatches = clean.length ? clean : DEFAULT_SWATCHES.slice(0);

        const box = $('pixSwatches');
        if (box) {
            box.addEventListener('click', onSwatchClick);
            box.addEventListener('contextmenu', onSwatchContext);
        }
        refreshSwatches();
    }
