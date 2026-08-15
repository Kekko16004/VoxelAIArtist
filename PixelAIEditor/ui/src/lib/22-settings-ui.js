    // =======================================================================
    //  22 - Modale delle impostazioni
    //
    //  Tre cose in una finestra sola: tema, colore d'accento, cookie.
    //
    //  TEMA E ACCENTO NON SI SCRIVONO QUI. Passano da `applyTheme` e
    //  `applyAccent` (03-prefs.js), che sono gli unici a conoscere la formula
    //  dei cinque token dell'accento - la stessa dello script sincrono nel
    //  `<head>`. Scrivere uno `style` a mano da qui darebbe un colore diverso
    //  prima e dopo il riavvio, cioe' il difetto che quello script serve
    //  proprio a togliere.
    //
    //  I COOKIE SONO CREDENZIALI. In questo file non compaiono MAI: non si
    //  stampano in console, non finiscono in un messaggio di stato, non
    //  restano nel campo dopo il salvataggio. L'unica cosa che si mostra e'
    //  QUANTI sono. Per lo stesso motivo, quando il salvataggio fallisce si
    //  riporta il codice HTTP e non il corpo della risposta: il server
    //  costruisce il proprio errore a partire dalla richiesta, e non c'e'
    //  ragione di rimandarne un pezzo a schermo.
    //
    //  I cookie stanno nella cartella dati CONDIVISA con VoxelAIArtist (lo dice
    //  gia' il template): configurarli qui li configura anche la'. Non e' un
    //  effetto collaterale, e' il motivo per cui c'e' un solo posto dove
    //  metterli invece di due che si sfasano.
    // =======================================================================

    let _settingsBound = false;

    /**
     * Le rotte sono ancorate alla RADICE: la pagina e' servita da
     * `/ui/index.html`, quindi un percorso relativo diventerebbe `/ui/api/...`.
     * `__API_BASE__` viene onorato se chi ci ospita lo inietta (il desktop di
     * VoxelAIArtist lo fa).
     */
    function settingsUrl(path) {
        return (window.__API_BASE__ ? window.__API_BASE__ : '') + path;
    }

    // --- Apertura e chiusura ------------------------------------------------------

    /**
     * `focusCookies` vero porta il fuoco sul campo dei cookie: la chiama
     * 15-ai.js quando la generazione riceve un 401, cioe' quando la modale si
     * apre PER quel campo e non per il tema. Senza, il fuoco resterebbe sulla
     * prima cosa focalizzabile (il tema) e chi arriva da un errore di
     * autenticazione dovrebbe cercarsi da solo il punto giusto.
     */
    function openSettings(focusCookies) {
        const ov = $('pixSettingsOverlay');
        if (!ov) return;
        syncSettingsControls();
        openOverlay(ov);
        // Lo stato dei cookie si chiede DOPO l'apertura: e' una richiesta di
        // rete e la finestra non deve aspettarla per comparire.
        refreshSettingsState();
        if (focusCookies) {
            const inp = $('pixCookieInput');
            if (inp) {
                if (inp.scrollIntoView) inp.scrollIntoView({ block: 'nearest' });
                inp.focus();
            }
        }
    }

    function closeSettings() {
        // Il campo si svuota anche uscendo senza salvare: un testo incollato e
        // dimenticato li' dentro e' una credenziale lasciata in giro, e
        // riaprendo la finestra sembrerebbe pure che sia gia' stata salvata.
        const inp = $('pixCookieInput');
        if (inp) inp.value = '';
        closeOverlay($('pixSettingsOverlay'));
    }

    /** Allinea i controlli locali (tema, accento) a cio' che e' in vigore.
     *  `applyTheme`/`applyAccent` lo fanno gia' quando cambiano qualcosa: questo
     *  serve al caso in cui la modale si apra senza che nulla sia cambiato. */
    function syncSettingsControls() {
        const sel = $('pixSettingsTheme');
        if (sel) sel.value = currentTheme();
        const acc = $('pixSettingsAccent');
        const cur = appliedAccent();
        if (acc && cur) acc.value = cur;
    }

    // --- Stato dei cookie ----------------------------------------------------------

    /**
     * Chiede al server quanti cookie ha. Non fallisce mai in modo visibile: se
     * il server non c'e' (pagina aperta da file://, backend spento) la modale
     * si DEGRADA - stato "sconosciuto" e i tre bottoni che parlano col server
     * spenti - invece di restare con un'etichetta vuota, che si legge come
     * "non ci sono cookie" e manda a cercare un problema che non esiste.
     */
    function refreshSettingsState() {
        fetch(settingsUrl('/api/settings'), { headers: { 'Accept': 'application/json' } })
            .then((res) => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then((data) => {
                // `cookie_count` e' il numero, non i cookie: e' l'unico dato di
                // questa risposta che si puo' mostrare.
                const n = Number(data && data.cookie_count) || 0;
                const dir = (data && (data.appdata_dir || data.cookies_path)) || '';
                showCookieState(n > 0 ? t('pix.settings.cookieCount', { count: n })
                    : t('pix.settings.cookieNone'), dir);
                setCookieButtons(true, n > 0);
            })
            .catch((err) => {
                // L'errore di rete si registra, la risposta no: non si sa cosa
                // contenga e questa e' la rotta dei cookie.
                console.warn('[settings] stato non disponibile:', err && err.message);
                showCookieState(t('pix.settings.cookieUnknown'), '');
                setCookieButtons(false, false);
            });
    }

    /** Due righe: lo stato e, se il server l'ha detta, la cartella dati. */
    function showCookieState(text, dir) {
        const host = $('pixCookieState');
        if (!host) return;
        host.textContent = '';
        const line = document.createElement('div');
        line.textContent = text;
        host.appendChild(line);
        if (dir) {
            const p = document.createElement('div');
            // Il percorso si deve poter selezionare e copiare: la regola globale
            // `*` mette `user-select: none` su tutto.
            p.style.userSelect = 'text';
            p.style.wordBreak = 'break-all';
            p.textContent = t('pix.settings.cookiePath', { path: dir });
            host.appendChild(p);
        }
    }

    /**
     * `online` = il server risponde; `hasCookies` = ce n'e' almeno uno.
     * Cancellare quando non c'e' niente da cancellare e' un bottone che non fa
     * nulla, e premerlo fa credere che i cookie ci fossero.
     */
    function setCookieButtons(online, hasCookies) {
        const save = $('pixCookieSaveBtn');
        if (save) save.disabled = !online;
        const clear = $('pixCookieClearBtn');
        if (clear) clear.disabled = !online || !hasCookies;
        const folder = $('pixOpenFolderBtn');
        if (folder) folder.disabled = !online;
        const inp = $('pixCookieInput');
        if (inp) inp.disabled = !online;
    }

    // --- Lettura di cio' che l'utente incolla -----------------------------------------

    /**
     * Riconosce le tre forme in cui i cookie arrivano davvero, e ne produce una
     * sola (`{nome: valore}`), che e' quella che `src/settings.py` si aspetta:
     *
     *   - oggetto JSON `{"__Secure-1PSID": "..."}` - scritto a mano;
     *   - array JSON `[{"name": "...", "value": "..."}]` - l'esportazione delle
     *     estensioni per i cookie, che e' il modo in cui li ottiene chiunque non
     *     li stia scrivendo a mano;
     *   - riga d'intestazione `nome=valore; nome2=valore2` - quella che si copia
     *     dalla scheda Rete degli strumenti per sviluppatori.
     *
     * Accettarne una sola vorrebbe dire mandare l'utente a convertire a mano un
     * testo che contiene le sue credenziali, cioe' il momento in cui finiscono
     * incollate dentro qualcos'altro.
     *
     * Ritorna null se non ne esce niente: il chiamante lo tratta come "non ho
     * capito", e non manda nulla al server.
     */
    function parseCookieBlob(text) {
        const s = String(text == null ? '' : text).trim();
        if (!s) return null;
        if (s.charAt(0) === '{' || s.charAt(0) === '[') {
            let data = null;
            try { data = JSON.parse(s); } catch (e) { return null; }
            return normalizeCookies(data);
        }
        const out = {};
        const parts = s.split(';');
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i].trim();
            if (!p) continue;
            const eq = p.indexOf('=');
            // `eq > 0`, non `>= 0`: una riga che comincia con '=' non ha nome, e
            // una chiave vuota nel file dei cookie non e' recuperabile.
            if (eq <= 0) continue;
            out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
        }
        return Object.keys(out).length ? out : null;
    }

    function normalizeCookies(data) {
        const out = {};
        if (Array.isArray(data)) {
            for (let i = 0; i < data.length; i++) {
                const c = data[i];
                if (!c || !c.name) continue;
                out[String(c.name)] = String(c.value == null ? '' : c.value);
            }
        } else if (data && typeof data === 'object') {
            const list = Array.isArray(data.cookies) ? data.cookies : null;
            if (list) {
                for (let i = 0; i < list.length; i++) {
                    const c = list[i];
                    if (!c || !c.name) continue;
                    out[String(c.name)] = String(c.value == null ? '' : c.value);
                }
            } else {
                for (const k in data) {
                    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
                    const v = data[k];
                    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
                }
            }
        }
        return Object.keys(out).length ? out : null;
    }

    // --- Comandi -----------------------------------------------------------------------

    function saveCookies() {
        const inp = $('pixCookieInput');
        if (!inp) return;
        const raw = inp.value;
        if (!String(raw || '').trim()) { setStatus(t('pix.settings.cookieEmpty'), 'warn'); return; }

        const cookies = parseCookieBlob(raw);
        if (!cookies) { setStatus(t('pix.settings.cookieBad'), 'err'); return; }
        const count = Object.keys(cookies).length;

        fetch(settingsUrl('/api/settings/cookies'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cookies),
        }).then((res) => {
            // Il corpo della risposta non si legge e non si mostra: e' la rotta
            // dei cookie e il codice HTTP dice gia' tutto quello che serve.
            if (!res.ok) throw new Error(res.status + ' ' + (res.statusText || ''));
            // Il campo si svuota SUBITO, prima di qualunque altra cosa: da qui
            // in poi le credenziali stanno nel file del server e non c'e' motivo
            // che restino anche in un campo di testo sullo schermo.
            inp.value = '';
            setStatus(t('pix.settings.cookieSaved', { count: count }), 'ok');
            refreshSettingsState();
        }).catch((err) => {
            setStatus(t('pix.settings.cookieFailed', { err: (err && err.message) || '' }), 'err');
        });
    }

    function clearCookies() {
        // Si chiede conferma: cancellarli spegne la generazione AI e rifarli
        // vuol dire tornare nel browser a riesportarli.
        pixConfirm(t('pix.settings.cookieClearAsk')).then((ok) => {
            if (!ok) return;
            fetch(settingsUrl('/api/settings/cookies'), { method: 'DELETE' }).then((res) => {
                if (!res.ok) throw new Error(res.status + ' ' + (res.statusText || ''));
                setStatus(t('pix.settings.cookieCleared'), 'ok');
                refreshSettingsState();
            }).catch((err) => {
                setStatus(t('pix.settings.cookieFailed', { err: (err && err.message) || '' }), 'err');
            });
        });
    }

    function openDataFolder() {
        fetch(settingsUrl('/api/settings/open-folder')).then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        }).then((data) => {
            // La cartella la apre il SERVER, sulla macchina dove gira: se
            // rispondesse `ok:false` non c'e' niente che il browser possa fare
            // al posto suo, quindi si dice che non ce l'ha fatta e basta.
            if (!data || data.ok !== true) throw new Error('ok:false');
        }).catch((err) => {
            console.warn('[settings] cartella non aperta:', err && err.message);
            setStatus(t('pix.settings.folderFailed'), 'err');
        });
    }

    // --- Avvio ---------------------------------------------------------------------------

    function initSettingsUI() {
        if (_settingsBound) return;
        _settingsBound = true;

        const sel = $('pixSettingsTheme');
        if (sel) sel.addEventListener('change', () => { applyTheme(sel.value); });

        const acc = $('pixSettingsAccent');
        if (acc) {
            // `input` scorre di continuo mentre si trascina nel selettore di
            // colore: li' si applica soltanto, senza salvare. La preferenza si
            // scrive su `change`, cioe' quando il colore e' stato SCELTO -
            // altrimenti sarebbero centinaia di scritture in localStorage per un
            // solo gesto, e ognuna verrebbe soprascritta un millisecondo dopo.
            acc.addEventListener('input', () => { applyAccent(acc.value, { save: false }); });
            acc.addEventListener('change', () => { applyAccent(acc.value); });
        }

        const save = $('pixCookieSaveBtn');
        if (save) save.addEventListener('click', saveCookies);
        const clear = $('pixCookieClearBtn');
        if (clear) clear.addEventListener('click', clearCookies);
        const folder = $('pixOpenFolderBtn');
        if (folder) folder.addEventListener('click', openDataFolder);

        const close = $('pixSettingsCloseBtn');
        if (close) close.addEventListener('click', closeSettings);

        const ov = $('pixSettingsOverlay');
        if (ov) {
            // Solo se il bersaglio E' lo sfondo: un trascinamento partito dentro
            // il campo dei cookie e finito fuori chiuderebbe la finestra, e con
            // essa svuoterebbe il campo (vedi `closeSettings`).
            ov.addEventListener('click', (ev) => { if (ev.target === ov) closeSettings(); });
        }

        // Niente `refreshSettingsState()` all'avvio: la modale e' chiusa,
        // nessuno vedrebbe il risultato, e sarebbe una richiesta di rete in piu'
        // proprio nel momento in cui la pagina sta ancora finendo di aprirsi.
        // Chi ha bisogno di sapere se i cookie mancano e' 15-ai.js, che lo
        // scopre dal 401 e apre la finestra gia' sul campo giusto.
    }
