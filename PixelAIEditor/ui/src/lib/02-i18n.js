    // =======================================================================
    //  02 - Traduzioni
    //
    //  I testi del template sono annotati con data-i18n / data-i18n-title /
    //  data-i18n-placeholder da `ui/annotate-i18n.mjs`, che li trova per VALORE
    //  a partire da `ui/locales/it.json`. Quindi it.json non e' una traduzione
    //  italiana: e' la LINGUA SORGENTE, i suoi valori SONO le stringhe gia'
    //  presenti nel DOM. Da qui due conseguenze che valgono per tutto il file:
    //    - se il fetch dei dizionari fallisce (offline, file://) l'app resta
    //      perfettamente in italiano invece di mostrare le chiavi;
    //    - alla prima applicazione IN ITALIANO non c'e' niente da riscrivere.
    //
    //  Le stringhe costruite a runtime dal JS non stanno nel template e non
    //  sono annotabili: passano da `t('chiave', {var})`. Nessun testo per
    //  l'utente e' scritto in chiaro nel codice, mai - nemmeno negli errori,
    //  nelle conferme e nei messaggi di stato.
    //
    //  URL DEI DIZIONARI: RELATIVI al documento, sempre. La pagina puo' essere
    //  servita da questo server (`/ui/index.html`) oppure da VoxelAIArtist, che
    //  la incorpora: un base assoluto li farebbe pescare dall'albero sbagliato.
    //  E' anche il motivo per cui `main.py` rimanda `/locales/...` in `ui/`.
    // =======================================================================

    const I18N_FALLBACK = 'it';

    // ATTENZIONE, `var` NON e' una svista. Tutti i moduli finiscono in UN SOLO
    // scope condiviso e `t()` e' una dichiarazione di funzione, quindi e'
    // hoistata e CHIAMABILE prima che questa riga venga eseguita. Con
    // `let`/`const` queste variabili sarebbero in temporal dead zone e leggerle
    // non darebbe `undefined`: solleverebbe ReferenceError, uccidendo il
    // bootstrap da li' in poi (schermo nero, interfaccia morta). Con `var` sono
    // hoistate a `undefined` e le guardie dentro `t()` fanno il loro lavoro:
    // si ottiene la CHIAVE NUDA, che e' il ripiego documentato e voluto - non
    // un difetto da tappare con un italiano scritto a mano nel codice.
    var i18nDict = {};                 // dizionario della lingua attiva
    var i18nCache = {};                // codice -> dizionario (evita il rifetch)
    var i18nLang = I18N_FALLBACK;
    var i18nApplied = false;           // true dopo la prima applicazione vera

    let i18nLocales = [{ code: 'it', name: 'Italiano' }];   // rimpiazzato da index.json

    // Funzioni da richiamare dopo un cambio lingua. `applyI18n` riscrive solo i
    // nodi ANNOTATI: le liste costruite dal JS (livelli, campioni di colore)
    // nascono con i testi della lingua attiva AL MOMENTO in cui sono costruite,
    // e senza questo elenco resterebbero nella lingua di prima per sempre.
    // Un modulo con testo costruito a runtime aggiunge qui il proprio nome.
    // `relabelAutoLayers` sta PRIMA di `refreshLayerList`: rideriva i nomi
    // automatici dei livelli ("Livello 2") e solo dopo ha senso ridisegnare le
    // righe. Invertirli mostrerebbe i nomi della lingua di prima fino alla
    // modifica successiva.
    const I18N_REDRAW = ['relabelAutoLayers', 'refreshLayerList', 'refreshSwatches', 'refreshBridgeFaces',
                         'relabelAutoStatus'];

    function i18nUrl(file) { return 'locales/' + file; }

    /** Sostituisce i segnaposto {nome}. Un segnaposto senza valore resta com'e':
     *  meglio un `{n}` visibile che una frase mutilata senza spiegazione. */
    function i18nInterpolate(str, vars) {
        if (!vars || typeof str !== 'string') return str;
        return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    }

    /**
     * Traduzione delle stringhe usate dal JS. Cerca nella lingua attiva, poi
     * nell'italiano (che e' la sorgente e ha SEMPRE tutte le chiavi), infine
     * ritorna la chiave nuda - utile in sviluppo per scoprire cosa manca.
     */
    function t(key, vars) {
        let s = (i18nDict && key in i18nDict) ? i18nDict[key] : undefined;
        if (s === undefined && i18nCache && i18nCache.it && key in i18nCache.it) s = i18nCache.it[key];
        if (s === undefined) s = key;
        return i18nInterpolate(s, vars);
    }

    /** Il valore di una chiave, o undefined: serve agli attributi, dove
     *  scrivere la chiave nuda in un `title` sarebbe peggio che non scriverlo. */
    function i18nValue(key) {
        if (i18nDict && key in i18nDict) return i18nDict[key];
        if (i18nCache && i18nCache.it && key in i18nCache.it) return i18nCache.it[key];
        return undefined;
    }

    /** Traduce gli elementi annotati sotto `root` (default: tutto il documento). */
    function applyI18n(root) {
        root = root || document;
        $$('[data-i18n]', root).forEach((el) => {
            const v = i18nValue(el.getAttribute('data-i18n'));
            if (v !== undefined) el.textContent = v;
        });
        $$('[data-i18n-title]', root).forEach((el) => {
            const v = i18nValue(el.getAttribute('data-i18n-title'));
            if (v !== undefined) el.setAttribute('title', v);
        });
        $$('[data-i18n-placeholder]', root).forEach((el) => {
            const v = i18nValue(el.getAttribute('data-i18n-placeholder'));
            if (v !== undefined) el.setAttribute('placeholder', v);
        });
        const title = i18nValue('app.title');
        if (title !== undefined) document.title = title;
        document.documentElement.setAttribute('lang', i18nLang);
    }

    function i18nFetchDict(code) {
        if (i18nCache[code]) return Promise.resolve(i18nCache[code]);
        return fetch(i18nUrl(code + '.json')).then((res) => {
            if (!res.ok) throw new Error('locale ' + code);
            return res.json();
        }).then((dict) => {
            i18nCache[code] = dict;
            return dict;
        });
    }

    /**
     * Carica e applica una lingua. `opts.silent` non la persiste (serve
     * all'avvio: ripristinare una scelta non e' farne una nuova).
     *
     * Un fallimento NON e' fatale e non si propaga: si resta sulla lingua
     * corrente, che nel peggiore dei casi e' l'italiano gia' nel DOM.
     */
    async function setLang(code, opts) {
        opts = opts || {};
        try {
            // L'italiano va sempre in cache: e' il ripiego di `t()` per le
            // chiavi che una traduzione non copre ancora.
            if (!i18nCache.it) {
                try { i18nCache.it = await i18nFetchDict('it'); } catch (e) { /* offline */ }
            }
            const dict = (code === 'it' && i18nCache.it) ? i18nCache.it : await i18nFetchDict(code);

            // ANTI-SFARFALLIO. I testi italiani sono GIA' nel DOM (il template
            // e' annotato proprio da it.json): alla prima applicazione in
            // italiano `applyI18n` riscriverebbe centinaia di nodi con stringhe
            // identiche, subito dopo il primo disegno. Per le altre lingue il
            // testo deve davvero cambiare, quindi si applica.
            const sameAsDom = (code === I18N_FALLBACK && i18nLang === I18N_FALLBACK && !i18nApplied);

            i18nDict = dict;
            i18nLang = code;
            if (sameAsDom) document.documentElement.setAttribute('lang', code);
            else applyI18n(document);
            i18nApplied = true;

            i18nRedrawRuntimeText();

            if (!opts.silent) savePref('lang', code);
            const sel = $('languageSelect');
            if (sel && sel.value !== code) sel.value = code;
        } catch (e) {
            console.warn('[i18n] lingua non caricata:', code, e);
        }
    }

    /**
     * Ridisegna cio' che il JS ha costruito con i testi della lingua di prima.
     * Ogni chiamata e' protetta per conto suo: un pannello che solleva non deve
     * impedire agli altri di aggiornarsi (si vedrebbe meta' app in due lingue).
     */
    function i18nRedrawRuntimeText() {
        for (let i = 0; i < I18N_REDRAW.length; i++) {
            const name = I18N_REDRAW[i];
            try {
                const fn = i18nLookupFn(name);
                if (fn) fn();
            } catch (e) { /* un pannello non pronto non ferma gli altri */ }
        }
    }

    /**
     * I moduli vivono in una closure, non su `window`: un nome non si risolve
     * con `window[name]`. Questa e' l'unica tabella che lega un nome alla sua
     * funzione, ed e' esplicita di proposito - una `eval` qui aprirebbe la
     * porta a eseguire testo che arriva da un dizionario.
     */
    function i18nLookupFn(name) {
        if (name === 'relabelAutoLayers') return (typeof relabelAutoLayers === 'function') ? relabelAutoLayers : null;
        if (name === 'relabelAutoStatus') return (typeof relabelAutoStatus === 'function') ? relabelAutoStatus : null;
        if (name === 'refreshLayerList') return (typeof refreshLayerList === 'function') ? refreshLayerList : null;
        if (name === 'refreshSwatches') return (typeof refreshSwatches === 'function') ? refreshSwatches : null;
        if (name === 'refreshBridgeFaces') return (typeof refreshBridgeFaces === 'function') ? refreshBridgeFaces : null;
        return null;
    }

    function currentLang() { return i18nLang; }

    /** Riempie il selettore di lingua leggendo `locales/index.json`: le lingue
     *  non sono scritte nel codice, aggiungerne una e' aggiungere un file. */
    function buildLanguageSelector() {
        const sel = $('languageSelect');
        if (!sel) return;
        sel.innerHTML = '';
        for (let i = 0; i < i18nLocales.length; i++) {
            const o = document.createElement('option');
            o.value = i18nLocales[i].code;
            o.textContent = i18nLocales[i].name;
            sel.appendChild(o);
        }
        sel.value = i18nLang;
        sel.onchange = () => { setLang(sel.value); };
    }

    /**
     * Avvio: elenco delle lingue, scelta della lingua, applicazione.
     * Priorita': preferenza salvata > lingua del browser (se c'e' un dizionario)
     * > italiano. Non blocca il resto dell'init.
     */
    async function bootI18n() {
        try {
            const res = await fetch(i18nUrl('index.json'));
            if (res.ok) {
                const idx = await res.json();
                if (idx && Array.isArray(idx.locales) && idx.locales.length) i18nLocales = idx.locales;
            }
        } catch (e) { /* offline o file://: resta solo l'italiano, gia' nel DOM */ }

        let start = I18N_FALLBACK;
        const saved = loadPref('lang', null);
        if (saved && i18nLocales.some((l) => l.code === saved)) {
            start = saved;
        } else {
            const nav = String((navigator && navigator.language) || I18N_FALLBACK).slice(0, 2).toLowerCase();
            if (i18nLocales.some((l) => l.code === nav)) start = nav;
        }

        buildLanguageSelector();
        await setLang(start, { silent: true });
    }
