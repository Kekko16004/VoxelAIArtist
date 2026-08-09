    // =======================================================================
    //  03 - Preferenze, tema, accento
    //
    //  Le preferenze stanno in localStorage con il prefisso `pixelai-`, e NON
    //  sul server. Il motivo e' uno solo ma e' vincolante: il tema e il colore
    //  d'accento vengono applicati da uno script sincrono nel `<head>`, PRIMA
    //  del primo disegno, per non far lampeggiare l'app in bianco a ogni
    //  avvio. Li' dentro si puo' leggere solo qualcosa di sincrono, cioe'
    //  localStorage: una `fetch` reintrodurrebbe esattamente il lampo che lo
    //  script serve a togliere. Mettere la verita' sul server e la copia qui
    //  darebbe due sorgenti che divergono al primo avvio offline.
    //
    //  LE CHIAVI SONO UN CONTRATTO CON IL TEMPLATE. Lo script del `<head>`
    //  legge `pixelai-theme` e `pixelai-accent` e ricava i cinque token
    //  dell'accento con una formula precisa. Le funzioni qui sotto DEVONO
    //  produrre gli stessi token con la stessa formula: se differiscono, il
    //  colore cambia sotto gli occhi dell'utente quando `initPrefs` gira - il
    //  lampo torna, solo piu' tardi e piu' difficile da attribuire.
    //  Chi tocca una delle due copie tocca anche l'altra.
    // =======================================================================

    const PREF_PREFIX = 'pixelai-';

    const PREF_THEME = 'theme';
    const PREF_ACCENT = 'accent';
    const PREF_GRID = 'grid';
    const PREF_LANG = 'lang';          // usata da 02-i18n.js
    const ACCENT_DEFAULT = '#475569';  // deve combaciare con il value di #pixSettingsAccent

    /**
     * Scrive una preferenza. Il valore diventa SEMPRE una stringa: localStorage
     * memorizza stringhe comunque, e convertire qui evita che un `true` torni
     * indietro come `"true"` e venga confrontato con `true` da qualche parte.
     *
     * Un errore non si propaga: in modalita' privata `setItem` puo' sollevare
     * QuotaExceededError, e non poter ricordare una preferenza non e' un motivo
     * per interrompere il gesto dell'utente (lo strumento va comunque cambiato).
     */
    function savePref(key, value) {
        try {
            localStorage.setItem(PREF_PREFIX + key, String(value));
        } catch (e) {
            console.warn('[prefs] non salvata:', key, e);
        }
    }

    /** Legge una preferenza. `def` torna sia se manca sia se localStorage e'
     *  inaccessibile: il chiamante non deve distinguere i due casi. */
    function loadPref(key, def) {
        try {
            const v = localStorage.getItem(PREF_PREFIX + key);
            return (v === null || v === undefined) ? def : v;
        } catch (e) {
            return def;
        }
    }

    function clearPref(key) {
        try { localStorage.removeItem(PREF_PREFIX + key); } catch (e) { /* niente da fare */ }
    }

    // --- Tema ----------------------------------------------------------------

    function prefersLight() {
        try {
            return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
        } catch (e) { return false; }
    }

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }

    /**
     * Applica il tema scrivendo `data-theme` sull'elemento radice - lo stesso
     * attributo dello script del `<head>`, cosi' c'e' un unico interruttore che
     * il CSS osserva. `opts.save === false` applica senza ricordare: serve
     * all'avvio, dove ripristinare una scelta non e' farne una nuova (e
     * riscrivere il valore che si e' appena letto e' rumore inutile).
     */
    function applyTheme(name, opts) {
        const theme = (name === 'light') ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', theme);
        if (!opts || opts.save !== false) savePref(PREF_THEME, theme);
        const sel = $('pixSettingsTheme');
        if (sel && sel.value !== theme) sel.value = theme;
        return theme;
    }

    function toggleTheme() {
        return applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    }

    // --- Accento -------------------------------------------------------------

    /** '#RRGGBB' minuscolo, oppure null se non e' un colore. Il `#` iniziale e'
     *  facoltativo perche' un valore incollato a mano spesso non ce l'ha. */
    function normalizeAccent(hex) {
        const s = String(hex || '').trim();
        if (!/^#?[0-9a-fA-F]{6}$/.test(s)) return null;
        return '#' + (s[0] === '#' ? s.slice(1) : s).toLowerCase();
    }

    /**
     * I cinque token derivati dall'accento.
     *
     * COPIA ESATTA della formula dello script inline nel `<head>` (mescola
     * verso il bianco al 20% per il chiaro, verso il nero al 22% per il cupo,
     * due velature al 25% e al 35%). Anche il formato delle stringhe `rgba(...)`
     * e' identico, spazi compresi: `initPrefs` confronta il token gia' applicato
     * con quello che applicherebbe, e una virgola senza spazio renderebbe i due
     * valori diversi facendo riscrivere sempre tutto.
     *
     * Di proposito NON tocca `--glass-border-focus`: lo script del `<head>` non
     * lo tocca, e aggiungerlo qui darebbe un bordo del fuoco diverso prima e
     * dopo `initPrefs`.
     */
    function accentTokens(hex) {
        const c = hexToRgb(hex);
        const mix = (v, target, f) => Math.round(v + (target - v) * f);
        return {
            '--accent-primary': rgbToHex(c.r, c.g, c.b),
            '--accent-secondary': rgbToHex(mix(c.r, 255, 0.20), mix(c.g, 255, 0.20), mix(c.b, 255, 0.20)),
            '--accent-deep': rgbToHex(mix(c.r, 0, 0.22), mix(c.g, 0, 0.22), mix(c.b, 0, 0.22)),
            '--accent-soft': 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', 0.25)',
            '--accent-glow': 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', 0.35)',
        };
    }

    function applyAccent(hex, opts) {
        const norm = normalizeAccent(hex);
        if (!norm) return null;
        const tokens = accentTokens(norm);
        const root = document.documentElement;
        for (const k in tokens) root.style.setProperty(k, tokens[k]);
        if (!opts || opts.save !== false) savePref(PREF_ACCENT, norm);
        const inp = $('pixSettingsAccent');
        if (inp && normalizeAccent(inp.value) !== norm) inp.value = norm;
        return norm;
    }

    /** L'accento gia' in vigore, letto dallo stile inline della radice: e' cio'
     *  che lo script del `<head>` ha scritto, non cio' che noi crediamo. */
    function appliedAccent() {
        const v = document.documentElement.style.getPropertyValue('--accent-primary');
        return normalizeAccent(v);
    }

    // --- Avvio ---------------------------------------------------------------

    /**
     * Riallinea l'interfaccia alle preferenze salvate.
     *
     * Tema e accento sono GIA' stati applicati dallo script del `<head>`: qui si
     * riapplicano SOLO se il risultato sarebbe diverso. Riapplicarli sempre non
     * sarebbe sbagliato, sarebbe visibile - riscrivere le variabili CSS della
     * radice invalida lo stile dell'intero documento, e farlo a pagina gia'
     * disegnata e' un ricalcolo completo per niente.
     *
     * Va chiamata DOPO `cacheViewportDom()`: il ripristino della griglia scrive
     * su un nodo che prima di allora nessuno ha ancora cercato, e senza quel
     * nodo `setGrid` esce senza fare niente (la preferenza risulterebbe
     * "dimenticata" a ogni avvio).
     */
    function initPrefs() {
        const savedTheme = loadPref(PREF_THEME, null);
        const wantTheme = (savedTheme === 'light' || savedTheme === 'dark')
            ? savedTheme
            : (prefersLight() ? 'light' : 'dark');
        // `applyTheme` allinea comunque la select del modale, quindi non c'e' un
        // ramo "salta tutto": si salta solo la scrittura dell'attributo.
        if (currentTheme() !== wantTheme) applyTheme(wantTheme, { save: false });
        else {
            const sel = $('pixSettingsTheme');
            if (sel) sel.value = wantTheme;
        }

        const savedAccent = normalizeAccent(loadPref(PREF_ACCENT, null)) || ACCENT_DEFAULT;
        if (appliedAccent() !== savedAccent) applyAccent(savedAccent, { save: false });
        else {
            const inp = $('pixSettingsAccent');
            if (inp) inp.value = savedAccent;
        }

        // La griglia e' una preferenza non visiva a caldo: la applica `setGrid`,
        // che e' anche l'unico punto che la scrive.
        if (typeof setGrid === 'function') setGrid(loadPref(PREF_GRID, '0') === '1');
    }
