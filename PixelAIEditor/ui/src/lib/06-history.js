    // =======================================================================
    //  06 - Annulla / Ripeti
    //
    //  Uno snapshot e' lo STATO INTERO del documento (tela, tutti i livelli,
    //  quale e' attivo, la selezione). L'alternativa - registrare le singole
    //  modifiche e saperle invertire - va benissimo finche' le operazioni sono
    //  "dipingi un pixel", e crolla alla prima che cambia la forma del
    //  documento: ridimensiona, ritaglia, unisci, appiattisci, ruota. Uno
    //  snapshot le annulla tutte con lo stesso codice.
    //
    //  Il prezzo e' la memoria, e si paga a BUDGET invece che a numero fisso di
    //  passi: 60 annullamenti su una tela 32x32 sono 240 kB, gli stessi 60 su
    //  4096x4096 sarebbero 4 GB. Il limite giusto e' quindi in byte, non in
    //  passi, con un minimo garantito perche' un annullamento deve funzionare
    //  anche quando un singolo stato supera il budget.
    //
    //  LO SNAPSHOT SI PRENDE PRIMA DELLA MODIFICA e UNA VOLTA PER TRATTO, non
    //  per cella: annullare una pennellata di trenta pixel deve costare un
    //  Ctrl+Z, non trenta.
    // =======================================================================

    const HISTORY_BUDGET_BYTES = 256 * 1024 * 1024;
    const HISTORY_MIN_STATES = 4;

    const history = { past: [], future: [], bytes: 0 };

    function snapshotBytes(s) {
        let n = 0;
        for (let i = 0; i < s.layers.length; i++) n += s.w * s.h * 4;
        if (s.selMask) n += s.selMask.length;
        return n;
    }

    function takeSnapshot() {
        const layers = [];
        for (let i = 0; i < doc.layers.length; i++) {
            const l = doc.layers[i];
            layers.push({
                id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
                // `autoKey`/`autoArgs` viaggiano con lo snapshot: sono il motivo
                // per cui un nome automatico segue la lingua, e un annulla che
                // li perdesse congelerebbe "Livello 2" in italiano per sempre.
                autoKey: l.autoKey || null, autoArgs: l.autoArgs || null,
                canvas: cloneCanvas(l.canvas),
            });
        }
        return {
            w: doc.w, h: doc.h, active: doc.active, name: doc.name,
            layers: layers,
            // La selezione fa parte dello stato: senza, annullare un "ritaglia
            // alla selezione" ridarebbe i pixel ma non la selezione con cui
            // erano stati ritagliati, e il gesto successivo colpirebbe altrove.
            selMask: selMask ? selMask.slice(0) : null,
        };
    }

    function applySnapshot(s) {
        doc.w = s.w; doc.h = s.h; doc.name = s.name;
        doc.layers = s.layers.map((l) => {
            const canvas = cloneCanvas(l.canvas);
            return {
                id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
                autoKey: l.autoKey || null, autoArgs: l.autoArgs || null,
                canvas: canvas, ctx: ctx2d(canvas),
            };
        });
        doc.active = clamp(s.active, 0, doc.layers.length - 1);
        // La copia e' obbligatoria: senza, uno strumento che modifica la
        // maschera modificherebbe lo snapshot, e annullare due volte
        // riporterebbe la selezione sbagliata.
        selSetMask(s.selMask ? s.selMask.slice(0) : null);
    }

    function trimHistory() {
        while (history.past.length > HISTORY_MIN_STATES && history.bytes > HISTORY_BUDGET_BYTES) {
            const dropped = history.past.shift();
            history.bytes -= snapshotBytes(dropped);
        }
    }

    /**
     * Da chiamare PRIMA di modificare il documento. Ogni modifica nuova butta
     * la pila del "ripeti": tenerla creerebbe due futuri diversi e il secondo
     * Ctrl+Y ricomparirebbe da un documento che non esiste piu'.
     */
    function pushHistory() {
        // Chi sta per modificare il documento chiude la sessione di
        // trasformazione: quella tiene una fotografia del livello e la
        // ristampa a ogni trascinamento, quindi sopravvivere a una modifica
        // altrui vorrebbe dire cancellarla al gesto dopo. Sta qui perche' e' il
        // passaggio obbligato di OGNI modifica: metterlo nei singoli strumenti
        // vorrebbe dire ricordarsene anche nel prossimo.
        xformBeforeExternalEdit();
        const s = takeSnapshot();
        history.past.push(s);
        history.bytes += snapshotBytes(s);
        if (history.future.length) {
            for (let i = 0; i < history.future.length; i++) history.bytes -= snapshotBytes(history.future[i]);
            history.future.length = 0;
        }
        trimHistory();
        refreshHistoryUI();
    }

    function undo() {
        if (!history.past.length) { setStatus(t('pix.msg.nothingUndo'), 'warn'); return false; }
        // Annullare E' il modo di rinunciare a una trasformazione: la sessione
        // va chiusa PRIMA di prendere lo snapshot corrente, o quello finirebbe
        // nella pila del "ripeti" con dentro le maniglie di una scatola che il
        // documento ripristinato non ha piu'.
        xformEnd();
        const cur = takeSnapshot();
        history.future.push(cur);
        history.bytes += snapshotBytes(cur);
        const s = history.past.pop();
        history.bytes -= snapshotBytes(s);
        applySnapshot(s);
        afterHistoryChange();
        return true;
    }

    function redo() {
        if (!history.future.length) { setStatus(t('pix.msg.nothingRedo'), 'warn'); return false; }
        xformEnd();
        const cur = takeSnapshot();
        history.past.push(cur);
        history.bytes += snapshotBytes(cur);
        const s = history.future.pop();
        history.bytes -= snapshotBytes(s);
        applySnapshot(s);
        afterHistoryChange();
        return true;
    }

    function afterHistoryChange() {
        layoutStage();
        renderNow();
        refreshLayerList();
        refreshHistoryUI();
    }

    /**
     * Azzera la cronologia RIASSEGNANDO array nuovi, non svuotando i vecchi.
     *
     * La differenza conta perche' il ponte mette da parte `history.past` per
     * faccia (`bridgeStashActive`). Svuotando in place, l'array troncato era lo
     * STESSO oggetto finito nella riserva della faccia precedente: aprendo una
     * faccia mai toccata si trovava l'Annulla acceso, un Ctrl+Z ci riversava
     * sopra il disegno di un'altra faccia, e all'Applica quella faccia risultava
     * "modificata" e tornava al padre a sovrascrivere una texture che nessuno
     * aveva chiesto. Trovato con la prova end-to-end del ponte.
     */
    function resetHistory() {
        xformEnd();
        history.past = [];
        history.future = [];
        history.bytes = 0;
        refreshHistoryUI();
    }

    /** Abilita/disabilita le voci di menu: un Annulla cliccabile che non fa
     *  nulla e' peggio di uno spento, perche' fa dubitare che il documento sia
     *  gia' stato annullato. */
    function refreshHistoryUI() {
        const u = $('pixUndoBtn'), r = $('pixRedoBtn');
        if (u) u.disabled = history.past.length === 0;
        if (r) r.disabled = history.future.length === 0;
    }
