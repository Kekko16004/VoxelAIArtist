    // =======================================================================
    //  20 - Barra dei menu
    //
    //  Due lavori, e nessuno dei due e' "disegnare i menu": il markup e' gia'
    //  nel template.
    //
    //  1. APERTURA E CHIUSURA. Un menu alla volta, e con uno aperto basta
    //     PASSARE sopra a un altro per cambiarlo: e' cio' che fa ogni barra dei
    //     menu, e senza si e' costretti a un clic per chiudere e uno per aprire.
    //
    //  2. ESECUZIONE. Le voci di menu NON vengono agganciate una per una qui.
    //     C'e' UN SOLO ascoltatore per `.menu`, in CATTURA, che cerca la voce
    //     in `PIX_SHORTCUTS` (per `id`) e la esegue con `runShortcut`, la stessa
    //     via della tastiera.
    //
    //  Perche' in cattura e con `stopPropagation`: alcuni moduli (10-clipboard,
    //  11-layers-ui, 12-image-ops, 13-filters, 17-io) agganciano GIA' un
    //  `click` sulle proprie voci. Aggiungerne un secondo qui farebbe eseguire
    //  ogni comando DUE volte - due livelli aggiunti, due ridimensionamenti,
    //  due voci nella cronologia - e sarebbe un difetto che si vede solo dai
    //  menu, mai dalla tastiera. In cattura si arriva prima del bersaglio, e
    //  fermare li' l'evento impedisce che il gestore proprio della voce parta.
    //  Cosi' il comando lo esegue una sola cosa, la tabella, che e' anche quella
    //  che ha scritto la scorciatoia accanto all'etichetta.
    //
    //  Le voci SPENTE non arrivano nemmeno qui: su un `<button disabled>` il
    //  browser non genera l'evento di clic. E' voluto che il menu resti aperto:
    //  chiuderlo darebbe l'impressione che qualcosa sia successo.
    // =======================================================================

    let _menuBound = false;

    // --- Apertura e chiusura ---------------------------------------------------

    function menuElements() { return $$('.topbar .menu'); }

    function menuAnyOpen() { return !!document.querySelector('.topbar .menu.open'); }

    /** Ritorna true se c'era davvero qualcosa da chiudere: Esc lo usa per
     *  decidere se ha gia' fatto il suo lavoro o se deve passare oltre. */
    function closeAllMenus() {
        const open = $$('.topbar .menu.open');
        for (let i = 0; i < open.length; i++) {
            open[i].classList.remove('open');
            const trig = open[i].querySelector('[data-menu-trigger]');
            if (trig) trig.setAttribute('aria-expanded', 'false');
        }
        return open.length > 0;
    }

    function openMenu(menuEl) {
        if (!menuEl) return;
        if (menuEl.classList.contains('open')) return;
        closeAllMenus();
        menuEl.classList.add('open');
        const trig = menuEl.querySelector('[data-menu-trigger]');
        if (trig) trig.setAttribute('aria-expanded', 'true');
    }

    function toggleMenu(menuEl) {
        if (!menuEl) return;
        if (menuEl.classList.contains('open')) closeAllMenus();
        else openMenu(menuEl);
    }

    // --- Esecuzione delle voci ---------------------------------------------------

    /**
     * L'unico gestore dei clic sui menu. In cattura sul `.menu`, vedi la nota in
     * cima al file.
     */
    function onMenuClickCapture(ev) {
        const item = ev.target && ev.target.closest ? ev.target.closest('.menu-item') : null;
        if (!item) return;

        // Ripiego: stiamo rilanciando noi il clic perche' la tabella non sapeva
        // eseguirlo. Si lascia passare, cosi' parte il gestore proprio della voce.
        if (item._pixPass) { item._pixPass = false; return; }

        const entry = item.id ? shortcutById(item.id) : null;
        if (!entry || typeof entry.run !== 'function') {
            // Voce non in tabella: la esegue chi l'ha agganciata. Non si ferma
            // l'evento, si chiude soltanto il menu.
            closeAllMenus();
            return;
        }

        // Da qui in poi il comando e' nostro: nessun altro deve eseguirlo.
        ev.preventDefault();
        ev.stopPropagation();

        // Il menu si chiude PRIMA dell'azione: molte voci aprono un dialogo, e
        // un menu ancora aperto sopra la modale si prenderebbe il clic
        // successivo oltre a restare visibile sopra lo sfondo scurito.
        closeAllMenus();

        const res = runShortcut(entry, { quiet: true });
        if (res !== 'missing') {
            if (res === 'failed') setStatus(t('pix.sc.actionFailed'), 'err');
            return;
        }

        // 'missing' = il nome scritto nella tabella non esiste nel bundle. E' un
        // errore NOSTRO, e il modulo che possiede la voce probabilmente funziona
        // benissimo: gli si restituisce il clic invece di lasciare l'utente con un menu
        // che non fa niente.
        console.warn('[menus] azione assente in tabella, passo la voce al suo modulo:', item.id);
        item._pixPass = true;
        item.click();
    }

    function onMenuTriggerClick(ev) {
        const trig = ev.target && ev.target.closest ? ev.target.closest('[data-menu-trigger]') : null;
        if (!trig) return;
        const menuEl = trig.closest('.menu');
        ev.preventDefault();
        ev.stopPropagation();
        toggleMenu(menuEl);
    }

    /**
     * Con un menu gia' aperto, passare sopra a un altro lo apre. Se non ce n'e'
     * nessuno aperto NON si apre niente: un menu che si spalanca solo perche' il
     * puntatore attraversa la barra e' il difetto opposto, e capita di continuo
     * mentre si va verso il selettore della lingua.
     */
    function onMenuTriggerEnter(ev) {
        if (!menuAnyOpen()) return;
        const trig = ev.currentTarget;
        openMenu(trig.closest('.menu'));
    }

    // --- Scorciatoie scritte accanto alle voci -----------------------------------

    /**
     * Riscrive le combinazioni ovunque servano, leggendole da `PIX_SHORTCUTS`.
     * Tre bersagli, tre modi diversi perche' tre sono i contesti:
     *
     *  - `.menu-item[data-sc]`: uno `<span class="shortcut">` in coda alla voce.
     *    Il CSS ha gia' la regola (`margin-left: auto`), quindi la combinazione
     *    si allinea a destra da sola.
     *  - altri `[data-sc]` (i doppioni nel pannello di destra): la combinazione
     *    va nel `title`, perche' li' l'etichetta e' corta e uno `span` in piu'
     *    dentro un `.btn` allargherebbe il bottone.
     *  - `[data-key]` (barra strumenti, scambia colori): idem, nel `title`.
     *
     * Si puo' richiamare quante volte si vuole: e' idempotente.
     */
    function applyMenuShortcutLabels() {
        const items = $$('[data-sc]');
        for (let i = 0; i < items.length; i++) {
            const el = items[i];
            const entry = shortcutBySc(el.getAttribute('data-sc'));
            const combo = entry && entry.combo ? entry.combo : '';
            if (el.classList.contains('menu-item')) setItemShortcutSpan(el, combo);
            else if (combo) setTitleWithCombo(el, combo);
        }

        const keyed = $$('[data-key]');
        for (let k = 0; k < keyed.length; k++) {
            const el = keyed[k];
            const raw = el.getAttribute('data-key');
            // La lettera nel template e la lettera nella tabella devono essere la
            // stessa cosa. Se non lo sono il suggerimento prometterebbe un tasto
            // che non fa niente: si scrive comunque quella del template (e' cio'
            // che l'utente vede) ma si segnala, perche' e' un disallineamento fra
            // due sorgenti che dovrebbero essere una sola.
            const entry = scKeyMap().get(scParseCombo(raw));
            if (!entry) console.warn('[menus] data-key senza voce in PIX_SHORTCUTS:', raw, el.id || '');
            setTitleWithCombo(el, entry && entry.combo ? entry.combo : raw);
        }
    }

    function setItemShortcutSpan(el, combo) {
        let span = null;
        for (let i = 0; i < el.children.length; i++) {
            if (el.children[i].classList.contains('shortcut')) { span = el.children[i]; break; }
        }
        if (!combo) { if (span) span.remove(); return; }
        if (!span) {
            span = document.createElement('span');
            span.className = 'shortcut';
            el.appendChild(span);
        }
        span.textContent = combo;
    }

    /**
     * `title` = etichetta + combinazione, senza accumulare.
     *
     * Non si puo' memorizzare l'etichetta una volta sola: `applyI18n` riscrive i
     * `title` annotati a ogni cambio di lingua, quindi la base cambia. E non si
     * puo' nemmeno riusare sempre il titolo corrente, o a ogni passaggio si
     * otterrebbe "Matita (B) (B)". Si tiene quindi cio' che si e' scritto
     * l'ultima volta: se il titolo e' ancora quello, la base e' quella vecchia;
     * se e' cambiato, l'ha riscritto la traduzione ed E' la base nuova.
     *
     * Il primo passaggio avviene PRIMA di `bootI18n` (24-boot chiama `initMenus`
     * e solo alla fine i dizionari), e li' `t()` restituisce la chiave nuda:
     * scriverla nel `title` sostituirebbe "Matita" con "pix.sc.hint", e se il
     * fetch dei dizionari fallisce (file://, offline) resterebbe cosi' per
     * sempre. Quindi si controlla prima con `i18nValue`, che per questo esiste, e
     * senza dizionario si lascia il titolo com'e': la combinazione la aggiunge il
     * passaggio innescato da `lang` appena i testi arrivano.
     */
    function setTitleWithCombo(el, combo) {
        if (i18nValue('pix.sc.hint') === undefined) return;
        const cur = el.getAttribute('title') || '';
        const base = (el._pixTitleOut !== undefined && cur === el._pixTitleOut)
            ? el._pixTitleBase
            : cur;
        if (!base) return;                       // niente etichetta: non si inventa
        const out = t('pix.sc.hint', { label: base, combo: combo });
        el._pixTitleBase = base;
        el._pixTitleOut = out;
        el.setAttribute('title', out);
    }

    /**
     * `applyI18n` riscrive `textContent` e `title` dei nodi annotati, e non
     * conosce le scorciatoie: dopo un cambio di lingua i `title` tornerebbero
     * senza combinazione. L'elenco `I18N_REDRAW` di 02-i18n.js e' chiuso e non
     * si tocca da qui, quindi ci si aggancia a cio' che `applyI18n` fa PER
     * ULTIMO, cioe' scrivere `lang` sulla radice.
     *
     * Lo `<span class="shortcut">` invece sopravvive da solo: nel template
     * l'etichetta e' in uno `<span>` figlio, quindi la traduzione riscrive
     * quello e non il bottone. Si riapplica comunque tutto: e' una manciata di
     * nodi e succede solo quando l'utente cambia lingua.
     */
    function watchLangForShortcutLabels() {
        if (typeof MutationObserver !== 'function') return;
        const obs = new MutationObserver(() => { applyMenuShortcutLabels(); });
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    }

    // --- Avvio -------------------------------------------------------------------

    function initMenus() {
        if (_menuBound) return;                  // due chiamate = due esecuzioni per clic
        _menuBound = true;

        const menus = menuElements();
        for (let i = 0; i < menus.length; i++) {
            const menuEl = menus[i];
            menuEl.addEventListener('click', onMenuClickCapture, true);
            const trig = menuEl.querySelector('[data-menu-trigger]');
            if (!trig) continue;
            trig.setAttribute('aria-haspopup', 'true');
            trig.setAttribute('aria-expanded', 'false');
            trig.addEventListener('click', onMenuTriggerClick);
            // `pointerenter` e non `mouseenter`: con una penna o un dito
            // `mouseenter` arriva solo dopo il tocco, cioe' mai in tempo.
            trig.addEventListener('pointerenter', onMenuTriggerEnter);
        }

        // Chiusura al clic fuori. Su `pointerdown` e non su `click`: un
        // trascinamento partito dentro il menu e finito sulla tela non deve
        // lasciare il menu aperto, e soprattutto il clic sulla tela deve gia'
        // trovare il menu chiuso. In cattura, cosi' non dipende da chi ferma
        // l'evento piu' in basso.
        document.addEventListener('pointerdown', (ev) => {
            if (!menuAnyOpen()) return;
            const inside = ev.target && ev.target.closest ? ev.target.closest('.topbar .menu') : null;
            if (!inside) closeAllMenus();
        }, true);

        // Esc lo gestisce 21-shortcuts chiamando `closeAllMenus()`: e' li' che si
        // decide l'ordine fra chiudi-menu, chiudi-modale, abbandona-tratto e
        // deseleziona, e averlo in due punti lo farebbe divergere.

        const settingsBtn = $('pixSettingsBtn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                closeAllMenus();
                openSettings(false);
            });
        }

        applyMenuShortcutLabels();
        watchLangForShortcutLabels();
        warnUnboundMenuItems();
    }

    /**
     * Diagnostica d'avvio: una voce di menu senza azione in tabella E senza un
     * gestore proprio e' un bottone che non fa niente, e provandola sembra che
     * il comando "non funzioni piu'" invece che non essere mai stato collegato.
     * Il gestore proprio non si puo' ispezionare, quindi si segnala solo cio'
     * che manca alla tabella: e' l'unica meta' che possiamo davvero controllare.
     */
    function warnUnboundMenuItems() {
        const items = $$('.topbar .menu-item');
        const orphans = [];
        for (let i = 0; i < items.length; i++) {
            const id = items[i].id;
            if (!id || !shortcutById(id)) orphans.push(id || '(senza id)');
        }
        if (orphans.length) console.warn('[menus] voci senza azione in PIX_SHORTCUTS:', orphans.join(', '));
    }
