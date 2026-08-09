    // =======================================================================
    //  18 - Dialoghi e overlay
    //
    //  Un solo dialogo per tutta l'app, costruito da una descrizione dei campi.
    //  L'alternativa - una modale nel template per ogni comando che chiede
    //  qualcosa - vuol dire ridimensiona-immagine, ridimensiona-tela, contorno,
    //  regolazioni, palette... ognuna con il suo Esc, il suo Invio, la sua
    //  trappola del fuoco da sbagliare per conto proprio.
    //
    //  IL DIALOGO E' UN RENDERER STUPIDO: riceve etichette GIA' TRADOTTE e non
    //  conosce nessuna chiave i18n. Chi chiama sa cosa sta chiedendo ("larghezza
    //  in pixel"), il dialogo no: fargli scegliere la traduzione vorrebbe dire
    //  un ramo per ogni chiamante dentro un modulo che non ne conosce nessuno.
    //  Le uniche chiavi che usa sono quelle della sua PROPRIA cornice (Conferma,
    //  Annulla, il titolo di un avviso), che sono sue e non del chiamante.
    // =======================================================================

    const ANCHOR_CELLS = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

    // Un pallino, non una lettera: le nove caselle dell'ancoraggio non hanno
    // testo da tradurre e la griglia si legge per posizione.
    const ANCHOR_DOT_SVG =
        '<svg viewBox="0 0 24 24" width="8" height="8"><circle cx="12" cy="12" r="7" ' +
        'fill="currentColor" stroke="none"></circle></svg>';

    // Oltre questa coda un dialogo in piu' non e' un'attesa, e' un difetto:
    // meglio rispondere "annullato" che aprirne venti in fila.
    const DLG_QUEUE_MAX = 8;

    let _dlg = null;            // il dialogo aperto: {spec, resolve, fields}
    const _dlgQueue = [];
    let _dlgFieldSeq = 0;

    // --- Overlay condivisi -----------------------------------------------------

    /**
     * Apre un overlay qualunque (impostazioni, aiuto, dialogo).
     *
     * Il nodo da cui si e' partiti si ricorda SUL NODO dell'overlay e non in una
     * variabile del modulo: gli overlay sono piu' d'uno e una variabile sola
     * farebbe restituire il fuoco al posto sbagliato appena se ne aprono due.
     */
    function openOverlay(el) {
        if (!el) return;
        el._pixFocusBack = document.activeElement;
        el.classList.add('open');
        // Il fuoco si sposta DOPO la classe: a display:none un elemento non e'
        // focalizzabile e la chiamata cadrebbe nel vuoto.
        const f = focusablesIn(el)[0];
        if (f) f.focus();
    }

    function closeOverlay(el) {
        if (!el) return;
        el.classList.remove('open');
        const back = el._pixFocusBack;
        el._pixFocusBack = null;
        if (back && back.focus && document.contains(back)) back.focus();
    }

    /**
     * Serve alle scorciatoie globali per non sparare mentre una modale e'
     * aperta. Guarda la CLASSE, non un elenco di id: cosi' vale anche per gli
     * overlay che non conosce (impostazioni, aiuto) e per quelli che verranno,
     * mentre un elenco andrebbe aggiornato a ogni modale nuova e il giorno che
     * ci si dimentica Ctrl+Z annulla il disegno mentre si scrive in un campo.
     */
    function anyOverlayOpen() {
        return !!document.querySelector('.overlay.open');
    }

    /** L'overlay aperto piu' in alto: l'ultimo nell'ordine del documento. */
    function topOpenOverlay() {
        const all = $$('.overlay.open');
        return all.length ? all[all.length - 1] : null;
    }

    function focusablesIn(root) {
        const sel = 'button, input, select, textarea, a[href], [tabindex]';
        return $$(sel, root).filter((el) => {
            if (el.disabled) return false;
            if (el.getAttribute('tabindex') === '-1') return false;
            // Un elemento nascosto (il bottone Annulla di un avviso) non e' un
            // bersaglio del fuoco: darglielo lascerebbe il dialogo senza fuoco
            // visibile e la trappola girerebbe a vuoto.
            return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        });
    }

    // --- Tastiera ---------------------------------------------------------------

    /**
     * Tab non deve poter uscire dalla modale (dietro c'e' un'app intera di
     * bottoni che sembrerebbero raggiungibili e non lo sono), Esc annulla,
     * Invio conferma.
     *
     * In CATTURA, perche' l'app ha scorciatoie a lettera singola agganciate piu'
     * in basso: Esc con un dialogo aperto deve chiudere il dialogo, non
     * abbandonare il tratto in corso sulla tela.
     *
     * Esc e Invio valgono SOLO per il dialogo di questo modulo: gli altri
     * overlay hanno il loro bottone di chiusura e il loro gestore, e chiuderli
     * da qui salterebbe la loro pulizia.
     */
    function onOverlayKey(ev) {
        const ov = topOpenOverlay();
        if (!ov) return;

        if (ev.key === 'Tab') { trapTab(ev, ov); return; }
        if (!_dlg || ov !== $('pixPromptOverlay')) return;

        if (ev.key === 'Escape') {
            ev.preventDefault(); ev.stopPropagation();
            dlgFinish(false);
            return;
        }
        if (ev.key === 'Enter') {
            const el = document.activeElement;
            const tag = (el && el.tagName ? el.tagName : '').toUpperCase();
            // In un'area di testo Invio e' un a capo, e su un bottone e' gia' un
            // clic: confermare qui farebbe due cose per un tasto solo.
            if (tag === 'TEXTAREA') return;
            if (tag === 'BUTTON' && ov.contains(el)) return;
            ev.preventDefault(); ev.stopPropagation();
            dlgFinish(true);
        }
    }

    function trapTab(ev, ov) {
        const items = focusablesIn(ov);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        const cur = document.activeElement;
        if (!ov.contains(cur)) {
            ev.preventDefault();
            (ev.shiftKey ? last : first).focus();
            return;
        }
        if (ev.shiftKey && cur === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && cur === last) { ev.preventDefault(); first.focus(); }
    }

    // --- API pubblica ------------------------------------------------------------

    /**
     * Dialogo a campi. Ritorna i valori per nome, oppure null se annullato.
     * `null` e non un rifiuto della Promise: annullare e' una risposta normale,
     * e un `throw` costringerebbe ogni chiamante a un try/catch per il caso
     * piu' comune di tutti.
     */
    function pixPrompt(spec) {
        return new Promise((resolve) => {
            const job = { spec: spec || {}, resolve: resolve, fields: [] };
            if (_dlg) {
                // SI ACCODA, non si rifiuta. Rifiutare risponderebbe "annullato"
                // a un dialogo che l'utente non ha nemmeno visto, e il chiamante
                // non ha modo di distinguere le due cose.
                if (_dlgQueue.length >= DLG_QUEUE_MAX) {
                    setStatus(t('pix.msg.dlgBusy'), 'warn');
                    resolve(null);
                    return;
                }
                _dlgQueue.push(job);
                return;
            }
            showDialog(job);
        });
    }

    /** Avviso: un solo bottone, nessuna scelta da fare. */
    function pixAlert(msg) {
        return pixPrompt({
            title: t('pix.dlg.notice'),
            okLabel: t('pix.dlg.close'),
            noCancel: true,
            fields: [{ type: 'message', label: msg }],
        }).then(() => true);
    }

    /** Domanda si'/no. true = confermato. */
    function pixConfirm(msg) {
        return pixPrompt({
            title: t('pix.dlg.question'),
            okLabel: t('pix.dlg.proceed'),
            fields: [{ type: 'message', label: msg }],
        }).then((v) => v !== null);
    }

    // --- Apertura e chiusura -------------------------------------------------------

    function showDialog(job) {
        const ov = $('pixPromptOverlay'), body = $('pixPromptBody'), title = $('pixPromptTitle');
        if (!ov || !body || !title) { job.resolve(null); return; }

        _dlg = job;
        const spec = job.spec;
        title.textContent = spec.title || '';

        body.innerHTML = '';
        // La modale impila i suoi figli con un gap, ma il corpo e' UN solo
        // figlio: senza questo i campi si accatastano senza respiro. Stile in
        // linea perche' il tema non ha una classe per il corpo di un dialogo e
        // inventarla vorrebbe dire toccare il CSS del template.
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.gap = '10px';

        job.fields = [];
        const list = spec.fields || [];
        for (let i = 0; i < list.length; i++) {
            const f = buildField(list[i]);
            if (!f) continue;
            body.appendChild(f.node);
            job.fields.push(f);
        }

        const ok = $('pixPromptOkBtn');
        if (ok) ok.textContent = spec.okLabel || t('pix.dlg.ok');
        const cancel = $('pixPromptCancelBtn');
        if (cancel) cancel.classList.toggle('hidden', spec.noCancel === true);

        openOverlay(ov);
    }

    function dlgFinish(ok) {
        const job = _dlg;
        if (!job) return;
        // I valori si leggono PRIMA di smontare i campi, e `_dlg` si azzera
        // prima di risolvere: chi riceve la risposta puo' aprire subito un altro
        // dialogo, e lo troverebbe "gia' occupato" da quello che sta chiudendo.
        const values = ok ? dlgValues() : null;
        _dlg = null;

        closeOverlay($('pixPromptOverlay'));
        const body = $('pixPromptBody');
        if (body) body.innerHTML = '';
        const cancel = $('pixPromptCancelBtn');
        if (cancel) cancel.classList.remove('hidden');

        job.resolve(values);
        // Il prossimo della coda parte in un turno separato: il chiamante appena
        // risolto deve poter reagire (e magari aprire il SUO dialogo) prima che
        // ne compaia un altro, o il fuoco salterebbe fra i due.
        setTimeout(pumpDialogQueue, 0);
    }

    function pumpDialogQueue() {
        if (_dlg || !_dlgQueue.length) return;
        showDialog(_dlgQueue.shift());
    }

    function dlgValues() {
        const out = {};
        if (!_dlg) return out;
        for (let i = 0; i < _dlg.fields.length; i++) {
            const f = _dlg.fields[i];
            if (f.name && f.get) out[f.name] = f.get();
        }
        return out;
    }

    /** Un campo e' cambiato: si avvisa il chiamante con TUTTI i valori. */
    function notifyDialogChange() {
        if (!_dlg || typeof _dlg.spec.onChange !== 'function') return;
        _dlg.spec.onChange(dlgValues());
    }

    // --- Campi ----------------------------------------------------------------------
    // Ogni ramo ritorna {name, node, get}. `get` e' una chiusura sul controllo,
    // non una ricerca nel DOM al momento della conferma: cosi' i valori si
    // leggono anche da un corpo appena smontato e non serve un id per campo.

    function buildField(f) {
        if (!f) return null;
        const type = f.type || 'text';
        const row = document.createElement('div');
        row.className = 'row';

        if (type === 'note' || type === 'message') {
            const n = document.createElement('div');
            n.className = (type === 'note') ? 'hint' : 'grow';
            // Un messaggio arriva anche su piu' righe (un errore, un elenco):
            // senza questo il browser lo appiattisce in un paragrafo unico.
            n.style.whiteSpace = 'pre-wrap';
            n.style.userSelect = 'text';
            n.style.lineHeight = '1.45';
            n.textContent = f.label || '';
            row.appendChild(n);
            return { name: null, node: row, get: null };
        }

        const id = 'pixDlgField' + (++_dlgFieldSeq);

        if (type === 'checkbox') {
            // Nel tema l'interruttore E' l'etichetta: <label class="switch"> con
            // dentro l'<input> invisibile e la .slider. L'etichetta di testo va
            // accanto, come nella barra delle opzioni.
            const sw = document.createElement('label');
            sw.className = 'switch';
            const inp = document.createElement('input');
            inp.type = 'checkbox';
            inp.id = id;
            inp.checked = !!f.value;
            const sl = document.createElement('span');
            sl.className = 'slider';
            sw.appendChild(inp);
            sw.appendChild(sl);
            const txt = document.createElement('span');
            txt.className = 'grow';
            txt.textContent = f.label || '';
            row.appendChild(sw);
            row.appendChild(txt);
            return { name: f.name, node: row, get: () => inp.checked };
        }

        const lab = document.createElement('label');
        lab.htmlFor = id;
        lab.textContent = f.label || '';
        row.appendChild(lab);

        if (type === 'anchor') {
            row.style.alignItems = 'flex-start';
            const grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = 'repeat(3, 30px)';
            grid.style.gap = '3px';
            grid.id = id;
            let cur = ANCHOR_CELLS.indexOf(String(f.value)) >= 0 ? String(f.value) : 'c';
            const cells = [];
            const paint = () => {
                for (let i = 0; i < cells.length; i++) {
                    cells[i].classList.toggle('primary', cells[i].getAttribute('data-anchor') === cur);
                }
            };
            for (let i = 0; i < ANCHOR_CELLS.length; i++) {
                const a = ANCHOR_CELLS[i];
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn';
                b.style.padding = '0';
                b.style.height = '30px';
                b.setAttribute('data-anchor', a);
                b.innerHTML = ANCHOR_DOT_SVG;
                b.addEventListener('click', () => { cur = a; paint(); notifyDialogChange(); });
                cells.push(b);
                grid.appendChild(b);
            }
            paint();
            row.appendChild(grid);
            return { name: f.name, node: row, get: () => cur };
        }

        if (type === 'select') {
            const sel = document.createElement('select');
            sel.className = 'field-strong grow';
            sel.id = id;
            const opts = f.options || [];
            for (let i = 0; i < opts.length; i++) {
                const o = document.createElement('option');
                o.value = String(opts[i].value);
                o.textContent = String(opts[i].label);
                sel.appendChild(o);
            }
            sel.value = String(f.value);
            row.appendChild(sel);
            return { name: f.name, node: row, get: () => sel.value };
        }

        if (type === 'range') {
            const inp = document.createElement('input');
            inp.type = 'range';
            inp.className = 'grow';
            inp.id = id;
            inp.min = String(f.min);
            inp.max = String(f.max);
            inp.step = String(f.step == null ? 1 : f.step);
            inp.value = String(f.value);
            // Il valore accanto al cursore: senza, un cursore non dice mai a
            // quale numero si e' fermato, e regolare "56 o 57" e' impossibile.
            const out = document.createElement('span');
            out.textContent = inp.value;
            inp.addEventListener('input', () => { out.textContent = inp.value; });
            row.appendChild(inp);
            row.appendChild(out);
            return { name: f.name, node: row, get: () => Number(inp.value) };
        }

        if (type === 'number') {
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.className = 'field-strong';
            inp.id = id;
            inp.style.width = '96px';
            inp.style.userSelect = 'text';
            if (f.min != null) inp.min = String(f.min);
            if (f.max != null) inp.max = String(f.max);
            inp.step = String(f.step == null ? 1 : f.step);
            inp.value = String(f.value);
            row.appendChild(inp);
            if (f.min != null && f.max != null) {
                // L'intervallo ammesso accanto al campo: il numero corrente si
                // legge nel campo stesso, quello che non si sa e' fin dove si
                // puo' andare - e scoprirlo con un valore rifiutato e' peggio.
                const hint = document.createElement('span');
                hint.className = 'hint';
                hint.textContent = t('pix.common.range', { min: f.min, max: f.max });
                row.appendChild(hint);
            }
            return { name: f.name, node: row, get: () => Number(inp.value) };
        }

        if (type === 'color') {
            const inp = document.createElement('input');
            inp.type = 'color';
            inp.className = 'field-strong';
            inp.id = id;
            inp.value = String(f.value || '#000000');
            row.appendChild(inp);
            return { name: f.name, node: row, get: () => inp.value };
        }

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'field-strong grow';
        inp.id = id;
        inp.value = String(f.value == null ? '' : f.value);
        if (f.placeholder) inp.placeholder = String(f.placeholder);
        // La regola globale `*` mette user-select: none su tutto: senza questo
        // il testo dentro il campo non si seleziona col mouse.
        inp.style.userSelect = 'text';
        row.appendChild(inp);
        return { name: f.name, node: row, get: () => inp.value };
    }

    // --- Avvio ---------------------------------------------------------------------

    function initDialogs() {
        // Tutti gli handler si agganciano UNA VOLTA e leggono `_dlg`, che
        // l'apertura riempie. Agganciarli dentro showDialog li accumulerebbe:
        // alla terza apertura "Conferma" risolverebbe tre volte, e le prime due
        // Promise finirebbero su dialoghi che non esistono piu'.
        document.addEventListener('keydown', onOverlayKey, true);

        const ok = $('pixPromptOkBtn');
        if (ok) ok.addEventListener('click', () => dlgFinish(true));
        const cancel = $('pixPromptCancelBtn');
        if (cancel) cancel.addEventListener('click', () => dlgFinish(false));

        const ov = $('pixPromptOverlay');
        if (ov) {
            // Il clic fuori dalla modale annulla, ma su POINTERDOWN e col
            // bersaglio esatto: con un click un trascinamento partito dentro un
            // campo e finito sullo sfondo chiuderebbe il dialogo per sbaglio.
            ov.addEventListener('pointerdown', (ev) => { if (ev.target === ov) dlgFinish(false); });
        }

        const body = $('pixPromptBody');
        if (body) {
            body.addEventListener('input', notifyDialogChange);
            body.addEventListener('change', notifyDialogChange);
        }
    }
