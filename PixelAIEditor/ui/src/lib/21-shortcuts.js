    // =======================================================================
    //  21 - Scorciatoie: la tabella, e la tastiera globale
    //
    //  `PIX_SHORTCUTS` e' l'UNICA fonte di quattro cose che altrimenti
    //  divergerebbero al primo cambiamento:
    //    1. l'azione di ogni voce di menu (la esegue 20-menus, per `id`),
    //    2. la combinazione scritta accanto alla voce (idem, per `sc`, cioe'
    //       l'attributo `data-sc` del template),
    //    3. la guida F1, che si costruisce da qui,
    //    4. il comportamento della tastiera.
    //  Tre elenchi separati promettono presto un tasto che non fa nulla, ed e'
    //  il difetto che non si nota provando l'app: il menu lo dice, la tastiera
    //  no, e nessuno dei due mente in modo visibile.
    //
    //  I NOMI DEI TASTI non sono testo tradotto ed e' deliberato: `Ctrl`, `B`,
    //  `F1` si scrivono uguali nelle sei lingue, e una chiave per combinazione
    //  farebbe sessanta voci identiche da tradurre sei volte. Tradotte sono le
    //  DESCRIZIONI (`labelKey`), che infatti riusano le chiavi delle voci di
    //  menu: la descrizione di una scorciatoia E' l'etichetta della sua voce.
    //
    //  Forma di una voce (tutto tranne `labelKey` e' facoltativo):
    //    sc       nome in `data-sc`: dice a quali elementi scrivere la combinazione
    //    id       id della voce di menu che esegue la stessa azione
    //    combo    combinazione principale, es. 'Ctrl+Shift+Z'
    //    also     combinazioni alternative
    //    labelKey chiave i18n della descrizione
    //    group    gruppo nella guida
    //    run      cosa fa. Senza `run` la voce e' sola documentazione (lo spazio
    //             e Alt li gestiscono il puntatore e il gestore qui sotto)
    // =======================================================================

    const SC_GROUP_ORDER = ['tools', 'file', 'edit', 'image', 'layer', 'view', 'general'];

    // Il titolo di un gruppo e' quello del menu corrispondente: due chiavi con
    // lo stesso testo divergerebbero appena una delle due viene corretta.
    const SC_GROUP_KEY = {
        tools: 'pix.sc.groupTools',
        file: 'pix.menu.file',
        edit: 'pix.menu.edit',
        image: 'pix.menu.image',
        layer: 'pix.menu.layer',
        view: 'pix.menu.view',
        general: 'pix.sc.groupGeneral',
    };

    const PIX_SHORTCUTS = [
        // --- Strumenti: le lettere sono quelle degli attributi `data-key` della
        //     barra strumenti. Se cambiano li', cambiano qui: la barra le mostra
        //     nel suggerimento e questa tabella le esegue.
        { combo: 'B', labelKey: 'pix.tool.pencil', group: 'tools', run: () => setTool('pencil') },
        { combo: 'E', labelKey: 'pix.tool.eraser', group: 'tools', run: () => setTool('eraser') },
        { combo: 'G', labelKey: 'pix.tool.fill', group: 'tools', run: () => setTool('fill') },
        { combo: 'I', labelKey: 'pix.tool.picker', group: 'tools', run: () => setTool('picker') },
        { combo: 'L', labelKey: 'pix.tool.line', group: 'tools', run: () => setTool('line') },
        { combo: 'U', labelKey: 'pix.tool.rect', group: 'tools', run: () => setTool('rect') },
        { combo: 'O', labelKey: 'pix.tool.ellipse', group: 'tools', run: () => setTool('ellipse') },
        { combo: 'M', labelKey: 'pix.tool.select', group: 'tools', run: () => setTool('select') },
        { combo: 'Q', labelKey: 'pix.tool.lasso', group: 'tools', run: () => setTool('lasso') },
        { combo: 'W', labelKey: 'pix.tool.wand', group: 'tools', run: () => setTool('wand') },
        { combo: 'V', labelKey: 'pix.tool.move', group: 'tools', run: () => setTool('move') },

        // --- File. Ctrl+N e Ctrl+O appartengono al browser (finestra nuova, apri
        //     file) e li' `preventDefault` non basta sempre: restano perche' sono
        //     le combinazioni che tutti provano, e la voce di menu e' comunque la
        //     via garantita.
        { sc: 'newImage', id: 'pixNewBtn', combo: 'Ctrl+N', labelKey: 'pix.file.new', group: 'file', run: () => fileNew() },
        { sc: 'open', id: 'pixOpenBtn', combo: 'Ctrl+O', labelKey: 'pix.file.open', group: 'file', run: () => fileOpen() },
        { id: 'pixOpenLayerBtn', labelKey: 'pix.file.openLayer', group: 'file', run: () => fileOpenAsLayer() },
        { sc: 'export', id: 'pixExportBtn', combo: 'Ctrl+E', labelKey: 'pix.file.export', group: 'file', run: () => fileExportPng() },
        { sc: 'exportLayers', id: 'pixExportLayersBtn', combo: 'Ctrl+Shift+E', labelKey: 'pix.file.exportLayers', group: 'file', run: () => fileExportLayersZip() },

        // --- Modifica
        { sc: 'undo', id: 'pixUndoBtn', combo: 'Ctrl+Z', labelKey: 'pix.edit.undo', group: 'edit', run: () => undo() },
        // Ctrl+Y e Ctrl+Shift+Z sono la stessa cosa in due tradizioni diverse:
        // chi arriva da Windows prova la prima, chi arriva da un editor grafico
        // la seconda, e chi ne trova solo una crede che "ripeti" non esista.
        { sc: 'redo', id: 'pixRedoBtn', combo: 'Ctrl+Y', also: ['Ctrl+Shift+Z'], labelKey: 'pix.edit.redo', group: 'edit', run: () => redo() },
        { sc: 'cut', id: 'pixCutBtn', combo: 'Ctrl+X', labelKey: 'pix.edit.cut', group: 'edit', run: () => doCut() },
        { sc: 'copy', id: 'pixCopyBtn', combo: 'Ctrl+C', labelKey: 'pix.edit.copy', group: 'edit', run: () => doCopy(false) },
        { sc: 'paste', id: 'pixPasteBtn', combo: 'Ctrl+V', labelKey: 'pix.edit.paste', group: 'edit', run: () => doPaste() },
        { sc: 'pasteLayer', id: 'pixPasteLayerBtn', combo: 'Ctrl+Shift+V', labelKey: 'pix.edit.pasteLayer', group: 'edit', run: () => doPasteAsLayer() },
        { sc: 'selectAll', id: 'pixSelectAllBtn', combo: 'Ctrl+A', labelKey: 'pix.edit.selectAll', group: 'edit', run: () => selectAll() },
        { sc: 'selectNone', id: 'pixSelectNoneBtn', combo: 'Ctrl+D', labelKey: 'pix.edit.selectNone', group: 'edit', run: () => selectNone() },
        { sc: 'selectInvert', id: 'pixSelectInvertBtn', combo: 'Ctrl+Shift+I', labelKey: 'pix.edit.selectInvert', group: 'edit', run: () => selectInvert() },
        // Cancella i pixel selezionati. Non ha voce di menu (Taglia la copre
        // quasi tutta) ma e' il tasto che si preme d'istinto con una selezione
        // attiva. Backspace fa lo stesso: sulle tastiere che non hanno Canc e'
        // l'unico modo.
        { combo: 'Del', also: ['Backspace'], labelKey: 'pix.sc.deleteSel', group: 'edit', run: () => scDeleteSelection() },

        // --- Immagine. Ctrl+Alt+I / Ctrl+Alt+C sono le combinazioni di Photoshop
        //     per dimensione immagine e dimensione tela; Shift+H / Shift+V per
        //     gli specchi sono quelle di Aseprite. Chi disegna pixel art arriva
        //     da uno di questi due.
        { sc: 'resizeImage', id: 'pixResizeImageBtn', combo: 'Ctrl+Alt+I', labelKey: 'pix.image.resizeImage', group: 'image', run: () => imgResizeImage() },
        { sc: 'resizeCanvas', id: 'pixResizeCanvasBtn', combo: 'Ctrl+Alt+C', labelKey: 'pix.image.resizeCanvas', group: 'image', run: () => imgResizeCanvas() },
        { id: 'pixCropBtn', labelKey: 'pix.image.crop', group: 'image', run: () => imgCropToSelection() },
        { id: 'pixTrimBtn', labelKey: 'pix.image.trim', group: 'image', run: () => imgTrim() },
        { sc: 'flipH', id: 'pixFlipHBtn', combo: 'Shift+H', labelKey: 'pix.image.flipH', group: 'image', run: () => imgFlipH() },
        { sc: 'flipV', id: 'pixFlipVBtn', combo: 'Shift+V', labelKey: 'pix.image.flipV', group: 'image', run: () => imgFlipV() },
        { id: 'pixRot90Btn', combo: 'R', labelKey: 'pix.image.rot90', group: 'image', run: () => imgRot90() },
        { id: 'pixRot180Btn', combo: 'Shift+R', labelKey: 'pix.image.rot180', group: 'image', run: () => imgRot180() },
        { id: 'pixRemoveBgBtn', labelKey: 'pix.image.removeBg', group: 'image', run: () => filtRemoveBg() },
        { id: 'pixAdjustBtn', labelKey: 'pix.image.adjust', group: 'image', run: () => filtAdjust() },
        { id: 'pixPaletteBtn', labelKey: 'pix.image.palette', group: 'image', run: () => filtPalette() },
        { id: 'pixOutlineBtn', labelKey: 'pix.image.outline', group: 'image', run: () => filtOutline() },

        // --- Livello. Ctrl+[ e Ctrl+] spostano il LIVELLO, [ e ] da soli cambiano
        //     lo spessore del pennello: e' la stessa coppia di tasti con e senza
        //     Ctrl, come in Photoshop.
        { sc: 'layerAdd', id: 'pixLayerAddBtn', combo: 'Ctrl+Shift+N', labelKey: 'pix.layer.add', group: 'layer', run: () => layerAdd() },
        { sc: 'layerDup', id: 'pixLayerDupBtn', combo: 'Ctrl+J', labelKey: 'pix.layer.dup', group: 'layer', run: () => layerDup() },
        { id: 'pixLayerDelBtn', labelKey: 'pix.layer.del', group: 'layer', run: () => layerDel() },
        { sc: 'layerUp', id: 'pixLayerUpBtn', combo: 'Ctrl+]', labelKey: 'pix.layer.up', group: 'layer', run: () => layerUp() },
        { sc: 'layerDown', id: 'pixLayerDownBtn', combo: 'Ctrl+[', labelKey: 'pix.layer.down', group: 'layer', run: () => layerDown() },
        { sc: 'layerMerge', id: 'pixLayerMergeBtn', combo: 'Ctrl+M', labelKey: 'pix.layer.merge', group: 'layer', run: () => layerMerge() },
        { sc: 'layerFlatten', id: 'pixLayerFlattenBtn', combo: 'Ctrl+Shift+M', labelKey: 'pix.layer.flatten', group: 'layer', run: () => layerFlatten() },

        // --- Vista. Lo zoom da tastiera non ha un puntatore a cui ancorarsi:
        //     `zoomStep` senza coordinate ancora al centro del viewport, che e'
        //     il comportamento giusto per i comandi da menu e da tastiera.
        { sc: 'zoomIn', id: 'pixZoomInBtn', combo: 'Ctrl++', also: ['+'], labelKey: 'pix.view.zoomIn', group: 'view', run: () => zoomStep(1) },
        { sc: 'zoomOut', id: 'pixZoomOutBtn', combo: 'Ctrl+-', also: ['-'], labelKey: 'pix.view.zoomOut', group: 'view', run: () => zoomStep(-1) },
        { sc: 'zoomFit', id: 'pixZoomFitBtn', combo: 'Ctrl+0', labelKey: 'pix.view.zoomFit', group: 'view', run: () => zoomToFit() },
        { sc: 'zoom100', id: 'pixZoom100Btn', combo: 'Ctrl+1', labelKey: 'pix.view.zoom100', group: 'view', run: () => setZoom(1) },
        { sc: 'grid', id: 'pixGridBtn', combo: 'Ctrl+G', labelKey: 'pix.view.grid', group: 'view', run: () => toggleGrid() },
        { id: 'pixThemeBtn', labelKey: 'pix.view.theme', group: 'view', run: () => toggleTheme() },

        // --- Generale
        { combo: 'X', labelKey: 'pix.color.swap', group: 'general', run: () => swapColors() },
        { combo: ']', labelKey: 'pix.sc.sizeUp', group: 'general', run: () => bumpBrushSize(1) },
        { combo: '[', labelKey: 'pix.sc.sizeDown', group: 'general', run: () => bumpBrushSize(-1) },
        { combo: 'Esc', labelKey: 'pix.sc.escape', group: 'general' },
        { combo: 'Space', labelKey: 'pix.sc.pan', group: 'general' },
        { combo: 'Alt', labelKey: 'pix.sc.altPicker', group: 'general' },
        { combo: 'Shift', labelKey: 'pix.sc.xformFree', group: 'general' },
        { sc: 'help', id: 'pixShortcutsBtn', combo: 'F1', labelKey: 'pix.help.shortcuts', group: 'general', run: () => openHelp() },
    ];

    // --- Da combinazione a firma ------------------------------------------------
    // La tabella scrive 'Ctrl+Shift+Z', l'evento porta ctrlKey/shiftKey/key: le
    // due strade devono arrivare alla STESSA stringa, o il menu promette un
    // tasto che il gestore non riconosce.

    // Per questi tasti lo stato di Shift si IGNORA: su molte tastiere '+' e' gia'
    // Shift+'=', quindi pretendere "senza Shift" renderebbe Ctrl++ impossibile da
    // digitare su meta' delle tastiere.
    const SC_SYMBOL_KEYS = ['+', '-', '[', ']'];

    function scNormKey(raw) {
        const k = String(raw == null ? '' : raw);
        if (k === ' ' || k === 'Spacebar') return 'SPACE';
        const up = k.toUpperCase();
        if (up === 'ESCAPE' || up === 'ESC') return 'ESC';
        if (up === 'DELETE' || up === 'DEL') return 'DEL';
        // Stesso tasto fisico: '=' senza Shift, '+' con Shift, 'Add' sul
        // tastierino. Chi preme "piu'" si aspetta che ingrandisca comunque.
        if (up === '=' || up === 'ADD') return '+';
        if (up === '_' || up === 'SUBTRACT') return '-';
        return up;
    }

    function scSignature(ctrl, alt, shift, rawKey) {
        const k = scNormKey(rawKey);
        const useShift = shift && SC_SYMBOL_KEYS.indexOf(k) < 0;
        return (ctrl ? 'CTRL+' : '') + (alt ? 'ALT+' : '') + (useShift ? 'SHIFT+' : '') + k;
    }

    /**
     * 'Ctrl+Shift+Z' -> 'CTRL+SHIFT+Z'.
     *
     * I modificatori si mangiano dalla TESTA invece di spezzare la stringa sui
     * '+': cosi' il tasto finale puo' essere '+' ('Ctrl++') senza inventare un
     * nome tipo "Plus", che poi sarebbe da tradurre a mano in sei lingue.
     */
    function scParseCombo(combo) {
        let rest = String(combo == null ? '' : combo);
        let ctrl = false, alt = false, shift = false;
        for (;;) {
            const m = /^(Ctrl|Alt|Shift)\+/i.exec(rest);
            if (!m) break;
            const name = m[1].toLowerCase();
            if (name === 'ctrl') ctrl = true;
            else if (name === 'alt') alt = true;
            else shift = true;
            rest = rest.slice(m[0].length);
        }
        return scSignature(ctrl, alt, shift, rest);
    }

    /** Tutte le combinazioni di una voce, la principale per prima. */
    function scCombos(entry) {
        const out = [];
        if (!entry) return out;
        if (entry.combo) out.push(entry.combo);
        if (entry.also) {
            for (let i = 0; i < entry.also.length; i++) out.push(entry.also[i]);
        }
        return out;
    }

    let _scByKey = null;
    let _scById = null;
    let _scBySc = null;

    /** firma -> voce. Costruita una volta: la tabella non cambia a runtime. */
    function scKeyMap() {
        if (_scByKey) return _scByKey;
        _scByKey = new Map();
        for (let i = 0; i < PIX_SHORTCUTS.length; i++) {
            const e = PIX_SHORTCUTS[i];
            if (typeof e.run !== 'function') continue;      // voce di sola documentazione
            const combos = scCombos(e);
            for (let j = 0; j < combos.length; j++) {
                const sig = scParseCombo(combos[j]);
                // Un doppione si vede solo qui: nei menu le due voci mostrano
                // entrambe il tasto e una delle due non parte mai.
                if (_scByKey.has(sig)) console.warn('[shortcuts] combinazione doppia:', sig);
                else _scByKey.set(sig, e);
            }
        }
        return _scByKey;
    }

    /** La voce che comanda un certo elemento (id della voce di menu). */
    function shortcutById(id) {
        if (!_scById) {
            _scById = new Map();
            for (let i = 0; i < PIX_SHORTCUTS.length; i++) {
                const e = PIX_SHORTCUTS[i];
                if (e.id) _scById.set(e.id, e);
            }
        }
        return _scById.get(id) || null;
    }

    /** La voce che alimenta un `data-sc`. */
    function shortcutBySc(name) {
        if (!_scBySc) {
            _scBySc = new Map();
            for (let i = 0; i < PIX_SHORTCUTS.length; i++) {
                const e = PIX_SHORTCUTS[i];
                if (e.sc) _scBySc.set(e.sc, e);
            }
        }
        return _scBySc.get(name) || null;
    }

    // --- Esecuzione -------------------------------------------------------------

    /**
     * L'UNICA via d'esecuzione: la usano sia la tastiera sia il clic sulla voce
     * di menu (20-menus), cosi' i due non possono fare cose diverse.
     *
     * Ritorna un codice e non un booleano perche' al chiamante servono quattro
     * risposte distinte: 'ok', 'skipped' (voce spenta), 'failed' (l'azione ha
     * sollevato) e 'missing' (la funzione non esiste nel bundle). Su 'missing' i
     * menu hanno un ripiego che su 'failed' sarebbe sbagliato.
     *
     * Lo stato `disabled` della voce vale anche per la tastiera: se "Inverti
     * selezione" e' spento perche' non c'e' selezione, Ctrl+Shift+I non deve fare
     * di nascosto cio' che il menu dichiara impossibile.
     */
    function runShortcut(entry, opts) {
        if (!entry || typeof entry.run !== 'function') return 'skipped';
        if (entry.id) {
            const el = $(entry.id);
            if (el && el.disabled) return 'skipped';
        }
        try {
            entry.run();
            return 'ok';
        } catch (err) {
            // Un nome non dichiarato in NESSUN modulo del bundle e' un buco di
            // montaggio, non un errore dell'utente: va distinto, perche' i menu
            // possono ancora cavarsela lasciando parlare chi possiede la voce.
            const missing = (err instanceof ReferenceError);
            console.error('[shortcuts] azione non riuscita:', entry.id || entry.combo, err);
            if (!(opts && opts.quiet)) setStatus(t('pix.sc.actionFailed'), 'err');
            return missing ? 'missing' : 'failed';
        }
    }

    /**
     * Cancella i pixel selezionati dal livello attivo.
     *
     * Vive qui e non in 10-clipboard perche' non ha voce di menu: e' solo un
     * tasto. PRETENDE una selezione: senza, "Canc" svuoterebbe l'intero livello,
     * cioe' il gesto piu' distruttivo dell'app finirebbe sul tasto piu' facile da
     * premere per sbaglio.
     */
    function scDeleteSelection() {
        if (!selActive()) { setStatus(t('pix.msg.noSelection'), 'warn'); return false; }
        const layer = activeLayer();
        if (!layer) return false;
        pushHistory();
        const g = layer.ctx;
        const b = selBounds();
        for (let y = b.y0; y <= b.y1; y++) {
            for (let x = b.x0; x <= b.x1; x++) {
                // `selHas` e non il riquadro: dentro il riquadro di un lazo ci
                // sono pixel che la selezione non contiene e che non vanno persi.
                if (selHas(x, y)) g.clearRect(x, y, 1, 1);
            }
        }
        renderNow();
        markDirty();
        return true;
    }

    /**
     * Spessore del pennello da tastiera.
     *
     * Passa dal cursore invece di scrivere solo `toolOpts.size`: valore, cursore
     * ed etichetta devono restare d'accordo, e l'evento `input` serve a chi
     * possiede il cursore (assegnare `.value` da JS non lo emette da solo).
     */
    function bumpBrushSize(delta) {
        const slider = $('pixOptSize');
        const lo = slider ? (Number(slider.min) || 1) : 1;
        const hi = slider ? (Number(slider.max) || 16) : 16;
        const next = clampInt(toolOpts.size + delta, lo, hi);
        if (next === toolOpts.size) return;
        toolOpts.size = next;
        if (slider) {
            slider.value = String(next);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const label = $('pixOptSizeVal');
        if (label) label.textContent = String(next);
        requestOverlay();
    }

    // --- Guida (F1) -------------------------------------------------------------

    /**
     * Il corpo della guida si costruisce DALLA TABELLA a ogni apertura: cosi'
     * prende la lingua attiva e non puo' elencare una scorciatoia che non esiste
     * piu'. Le voci senza combinazione (le voci di menu che non ne hanno) si
     * escludono da sole.
     *
     * Niente innerHTML: i testi arrivano dai file di traduzione e non devono
     * poter iniettare markup. Le classi sono quelle che il tema ha gia'
     * (`row`, `grow`, `badge`, `menu-sep`): il CSS del template non si tocca.
     */
    function renderHelpBody() {
        const host = $('pixHelpBody');
        if (!host) return;
        host.textContent = '';
        let firstGroup = true;

        for (let g = 0; g < SC_GROUP_ORDER.length; g++) {
            const group = SC_GROUP_ORDER[g];
            const rows = PIX_SHORTCUTS.filter((e) => e.group === group && scCombos(e).length > 0);
            if (!rows.length) continue;

            if (!firstGroup) {
                const sep = document.createElement('div');
                sep.className = 'menu-sep';
                host.appendChild(sep);
            }
            firstGroup = false;

            const head = document.createElement('div');
            head.className = 'row';
            const strong = document.createElement('b');
            strong.textContent = t(SC_GROUP_KEY[group] || group);
            head.appendChild(strong);
            host.appendChild(head);

            for (let i = 0; i < rows.length; i++) {
                const entry = rows[i];
                const line = document.createElement('div');
                line.className = 'row';
                const desc = document.createElement('span');
                desc.className = 'grow';
                desc.textContent = t(entry.labelKey);
                line.appendChild(desc);
                const combos = scCombos(entry);
                for (let c = 0; c < combos.length; c++) {
                    const badge = document.createElement('span');
                    badge.className = 'badge';
                    badge.textContent = combos[c];
                    line.appendChild(badge);
                }
                host.appendChild(line);
            }
        }
    }

    function openHelp() {
        renderHelpBody();
        const ov = $('pixHelpOverlay');
        if (ov) openOverlay(ov);
    }

    function closeHelp() {
        const ov = $('pixHelpOverlay');
        if (ov) closeOverlay(ov);
    }

    function helpIsOpen() {
        const ov = $('pixHelpOverlay');
        return !!ov && ov.classList.contains('open');
    }

    // --- Tastiera globale --------------------------------------------------------

    /**
     * Le modali che Esc chiude sono solo LE MIE (impostazioni e aiuto).
     * `#pixPromptOverlay` appartiene a 18-dialogs, che ha gia' il suo gestore in
     * cattura: chiuderlo da qui lascerebbe la Promise di `pixConfirm` appesa per
     * sempre, cioe' un'azione che non finisce e nessun errore da nessuna parte.
     */
    function scOwnOpenOverlay() {
        const ids = ['pixSettingsOverlay', 'pixHelpOverlay'];
        // A ritroso: se per qualche via ne fossero aperte due, si chiude quella
        // disegnata sopra, che e' l'ultima nell'ordine del documento.
        for (let i = ids.length - 1; i >= 0; i--) {
            const el = $(ids[i]);
            if (el && el.classList.contains('open')) return el;
        }
        return null;
    }

    /**
     * Esc ha cinque significati, in ordine da "cio' che ho appena aperto" a
     * "cio' che sta li' da prima": chiudi il menu, chiudi la mia modale,
     * abbandona il tratto in corso, chiudi le maniglie di trasformazione,
     * deseleziona. Farne due con una sola pressione butterebbe via una selezione
     * che l'utente non stava toccando.
     *
     * Chiudere la trasformazione NON annulla ne' conferma niente: il documento
     * e' gia' quello che si vede a ogni rilascio del puntatore. Per rinunciare
     * c'e' Ctrl+Z, che e' anche il posto dove la si andrebbe a cercare.
     */
    function scHandleEscape(ev) {
        if (closeAllMenus()) { ev.preventDefault(); return; }
        const mine = scOwnOpenOverlay();
        if (mine) { closeOverlay(mine); ev.preventDefault(); return; }
        if (anyOverlayOpen()) return;               // e' di qualcun altro: se la vede lui
        if (stroke) { strokeCancel(); ev.preventDefault(); return; }
        if (xformActive()) { xformEnd(); ev.preventDefault(); return; }
        if (selActive()) { selectNone(); ev.preventDefault(); }
    }

    /**
     * La barra spaziatrice mette la tela in modalita' spostamento. `spaceDown`
     * e' dichiarata in 05-render.js (accanto a `beginPan`) e la legge
     * `initPointer` in 09-tools: qui si ASSEGNA soltanto - ridichiararla
     * creerebbe una seconda variabile nello stesso scope e il puntatore
     * continuerebbe a leggere quella vecchia, per sempre falsa.
     */
    function scSetSpace(down) {
        if (spaceDown === down) return;
        spaceDown = down;
        // Il cursore e' l'unico segno che la modalita' e' attiva; durante uno
        // spostamento vero e' `beginPan` a comandarlo e non va scavalcato.
        if (elStage && !isPanning()) elStage.style.cursor = down ? 'grab' : '';
    }

    function onGlobalKeyDown(ev) {
        // Ogni scorciatoia a lettera singola dipende da questa riga: senza,
        // scrivere "b" nel prompt dell'AI cambierebbe strumento.
        if (isTypingTarget(ev.target)) return;

        const ctrl = ev.ctrlKey || ev.metaKey;       // su Mac Cmd ha lo stesso ruolo
        const key = scNormKey(ev.key);

        if (key === 'ESC') { scHandleEscape(ev); return; }

        // F1 chiude la guida anche quando la guida e' l'unica modale aperta:
        // altrimenti il tasto che l'ha aperta non la richiude. Sotto un'altra
        // modale non si apre affatto, o finirebbe invisibile dietro per
        // ricomparire dal nulla alla chiusura di quella davanti.
        if (key === 'F1' && !ctrl && !ev.altKey && !ev.shiftKey) {
            ev.preventDefault();
            if (helpIsOpen()) { closeHelp(); return; }
            if (anyOverlayOpen()) return;
            closeAllMenus();
            openHelp();
            return;
        }

        // Sotto una modale la tastiera e' della modale.
        if (anyOverlayOpen()) return;

        if (key === 'SPACE' && !ctrl && !ev.altKey) {
            ev.preventDefault();                     // senza, la pagina scorre
            scSetSpace(true);
            return;
        }

        const entry = scKeyMap().get(scSignature(ctrl, ev.altKey, ev.shiftKey, ev.key));
        if (!entry) return;                          // niente preventDefault su cio' che non gestiamo
        ev.preventDefault();
        closeAllMenus();
        runShortcut(entry);
    }

    function onGlobalKeyUp(ev) {
        // Il rilascio NON passa da `isTypingTarget`: se lo spazio e' stato premuto
        // sulla tela e rilasciato con il fuoco altrove, restare in modalita'
        // spostamento renderebbe la matita inutilizzabile senza un motivo visibile.
        if (scNormKey(ev.key) === 'SPACE') scSetSpace(false);
    }

    function initShortcuts() {
        scKeyMap();                                  // subito: i doppioni si vedono all'avvio
        document.addEventListener('keydown', onGlobalKeyDown);
        document.addEventListener('keyup', onGlobalKeyUp);
        // Con Alt+Tab a spazio premuto il `keyup` non arriva mai, e al ritorno la
        // tela resterebbe in modalita' spostamento.
        window.addEventListener('blur', () => scSetSpace(false));

        // `#pixShortcutsBtn` NON si aggancia qui: e' una voce della tabella con un
        // `id`, quindi la esegue `initMenus` con tutte le altre. Un secondo
        // listener sullo stesso nodo aprirebbe la guida due volte.
        const closeBtn = $('pixHelpCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', closeHelp);
        const ov = $('pixHelpOverlay');
        if (ov) ov.addEventListener('click', (ev) => { if (ev.target === ov) closeHelp(); });
    }
