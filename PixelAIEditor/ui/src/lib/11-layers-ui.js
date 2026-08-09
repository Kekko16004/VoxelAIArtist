    // =======================================================================
    //  11 - Pannello dei livelli
    //
    //  Questo pannello ha DUE aggiornamenti diversi, e confonderli e' il difetto
    //  classico di questo pezzo d'interfaccia:
    //    - refreshLayerList()   RICOSTRUISCE le righe. Si chiama solo quando
    //      l'insieme dei livelli cambia davvero (aggiunto, duplicato, eliminato,
    //      spostato, unito) o dopo un annulla.
    //    - refreshLayerThumbs() ridisegna SOLO dentro i canvas gia' esistenti.
    //      La chiama renderNow(), cioe' a OGNI pennellata.
    //  Se le miniature ricostruissero l'elenco, ogni pennellata distruggerebbe
    //  la riga sotto il puntatore: il clic sull'occhio non arriverebbe mai (il
    //  nodo su cui e' partito il pointerdown non esiste piu' al pointerup) e una
    //  rinomina a meta' sparirebbe alla prima cella dipinta. Per lo stesso
    //  motivo le miniature sono STROZZATE a ~10 al secondo: ridisegnare dieci
    //  canvas per ogni movimento del puntatore costa piu' del disegno stesso.
    //
    //  ORDINE. `doc.layers[0]` e' il livello piu' in BASSO; l'elenco a schermo
    //  mostra il piu' alto IN CIMA, come ogni editor. La conversione fra i due
    //  ordini vive in UNA SOLA funzione, `layerIndexForRow`: sparpagliarla e' il
    //  modo garantito di invertire un indice da qualche parte e cancellare il
    //  livello sbagliato - per giunta un difetto che si vede solo con tre o piu'
    //  livelli, quindi non con quelli con cui si prova.
    // =======================================================================

    // Lato massimo della miniatura, in px CSS. Il buffer del canvas invece non
    // sale mai sopra la dimensione del documento: ingrandire e' gratis via CSS
    // (`image-rendering: pixelated` sulla classe .thumb), allocare no.
    const LAYER_THUMB_PX = 30;
    const LAYER_THUMB_MS = 100;

    const EYE_OPEN_SVG =
        '<svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path>' +
        '<circle cx="12" cy="12" r="3"></circle></svg>';
    const EYE_SHUT_SVG =
        '<svg viewBox="0 0 24 24"><path d="M17.9 17.9A10 10 0 0 1 12 20C5 20 1 12 1 12a18.4 18.4 0 0 1 5.1-5.9">' +
        '</path><path d="M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2"></path>' +
        '<path d="M9.9 9.9a3 3 0 1 0 4.2 4.2"></path><path d="M1 1l22 22"></path></svg>';

    let _thumbTimer = 0;
    let _thumbPending = false;
    let _layerRebuilding = false;
    let _opacityDrag = false;
    let _renaming = null;       // {row, input, node, rowEl} oppure null

    /**
     * L'UNICO punto di conversione fra l'ordine del modello (0 = fondo) e quello
     * a schermo (riga 0 = cima). Ogni lettura di un indice di livello a partire
     * da una riga passa di qui, comprese le miniature e i pulsanti.
     */
    function layerIndexForRow(row) { return doc.layers.length - 1 - row; }

    // --- Costruzione dell'elenco ---------------------------------------------

    function refreshLayerList() {
        const list = $('pixLayerList');
        if (!list) return;
        // Una rinomina in corso viene ABBANDONATA, non salvata: un rebuild
        // capita quando l'insieme dei livelli cambia (o dopo un annulla), cioe'
        // quando la riga che si stava rinominando puo' non esistere piu'. Il
        // caso normale - si clicca altrove - passa dal blur, che invece salva.
        cancelRename();
        _layerRebuilding = true;
        list.innerHTML = '';
        for (let row = 0; row < doc.layers.length; row++) list.appendChild(buildLayerRow(row));
        _layerRebuilding = false;
        drawLayerThumbsNow();
        updateLayerSelection();
    }

    function buildLayerRow(row) {
        const l = doc.layers[layerIndexForRow(row)];
        const el = document.createElement('div');
        el.className = 'layer-item';
        el._row = row;

        const thumb = document.createElement('canvas');
        thumb.className = 'thumb';

        const eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'eye';
        eye.title = t('pix.layer.visibleToggle');
        eye.innerHTML = l.visible ? EYE_OPEN_SVG : EYE_SHUT_SVG;
        // Senza stopPropagation il clic sull'occhio attiverebbe ANCHE il
        // livello: due effetti per un gesto solo, e nascondere un livello ne
        // cambierebbe di nascosto quello su cui si sta disegnando.
        eye.addEventListener('click', (ev) => { ev.stopPropagation(); toggleLayerVisible(row); });

        const name = document.createElement('span');
        name.className = 'lname';
        name.textContent = l.name;
        name.title = t('pix.layer.rename');
        name.addEventListener('dblclick', (ev) => { ev.stopPropagation(); beginRename(el); });

        el.appendChild(thumb);
        el.appendChild(eye);
        el.appendChild(name);
        el.classList.toggle('hidden-layer', !l.visible);
        el.addEventListener('click', () => setActiveLayer(row));
        return el;
    }

    /** Aggiorna UNA riga senza ricostruirla (visibilita' e nome). */
    function syncLayerRow(row) {
        const list = $('pixLayerList');
        if (!list) return;
        const el = list.children[row];
        if (!el) return;
        const l = doc.layers[layerIndexForRow(row)];
        if (!l) return;
        el.classList.toggle('hidden-layer', !l.visible);
        const eye = el.querySelector('.eye');
        if (eye) eye.innerHTML = l.visible ? EYE_OPEN_SVG : EYE_SHUT_SVG;
        const name = el.querySelector('span.lname');
        if (name) name.textContent = l.name;
    }

    /**
     * Evidenziazione, cursore di opacita' e pulsanti. Non tocca il DOM delle
     * righe: cambiare livello attivo e' il gesto piu' frequente del pannello e
     * non deve costare una ricostruzione.
     */
    function updateLayerSelection() {
        const list = $('pixLayerList');
        if (list) {
            for (let row = 0; row < list.children.length; row++) {
                list.children[row].classList.toggle('active', layerIndexForRow(row) === doc.active);
            }
        }
        const l = activeLayer();
        const pct = l ? Math.round(l.opacity * 100) : 100;
        const sl = $('pixLayerOpacity');
        if (sl) sl.value = String(pct);
        const out = $('pixLayerOpacityVal');
        if (out) out.textContent = t('pix.common.percent', { n: pct });
        updateLayerButtons();
    }

    /**
     * Un pulsante cliccabile che non fa nulla e' peggio di uno spento: fa
     * dubitare che l'operazione sia gia' stata fatta. Quindi cio' che non ha
     * senso si disabilita, sia nel menu sia nel pannello di destra.
     */
    function updateLayerButtons() {
        const n = doc.layers.length;
        const top = doc.active >= n - 1;
        const bottom = doc.active <= 0;
        const flat = n <= 1 && doc.layers[0] && doc.layers[0].opacity === 1;
        eachLayerBtn('pixLayerDelBtn', (b) => { b.disabled = n <= 1; });
        eachLayerBtn('pixLayerUpBtn', (b) => { b.disabled = top; });
        eachLayerBtn('pixLayerDownBtn', (b) => { b.disabled = bottom; });
        eachLayerBtn('pixLayerMergeBtn', (b) => { b.disabled = bottom; });
        eachLayerBtn('pixLayerFlattenBtn', (b) => { b.disabled = !!flat; });
    }

    /**
     * Gli stessi comandi esistono due volte: nel menu Livello e nel pannello di
     * destra (stesso id col suffisso "2"). Passano di qui per NON diventare due
     * implementazioni che divergono - e perche' disabilitarne una sola
     * lascerebbe l'altra a fare il danno.
     */
    function eachLayerBtn(id, fn) {
        const a = $(id), b = $(id + '2');
        if (a) fn(a);
        if (b) fn(b);
    }

    function bindLayerBtn(id, handler) {
        eachLayerBtn(id, (el) => el.addEventListener('click', handler));
    }

    // --- Miniature -----------------------------------------------------------

    /**
     * Chiamata da renderNow(), cioe' potenzialmente a ogni movimento del
     * puntatore. Disegna subito la prima volta (il risultato di un tratto deve
     * comparire, non aspettare) e poi al massimo una volta ogni LAYER_THUMB_MS,
     * con un ultimo passaggio in coda se nel frattempo e' cambiato altro.
     */
    function refreshLayerThumbs() {
        if (_thumbTimer) { _thumbPending = true; return; }
        drawLayerThumbsNow();
        _thumbTimer = setTimeout(() => {
            _thumbTimer = 0;
            if (_thumbPending) { _thumbPending = false; refreshLayerThumbs(); }
        }, LAYER_THUMB_MS);
    }

    function drawLayerThumbsNow() {
        const list = $('pixLayerList');
        if (!list) return;
        const rows = list.children;
        if (rows.length !== doc.layers.length) {
            // Rete di sicurezza: qualcuno ha cambiato l'insieme dei livelli
            // senza ricostruire l'elenco. Le righe sono gia' sbagliate, quindi
            // ricostruirle qui non distrugge nulla che valesse la pena tenere.
            // La guardia impedisce la ricorsione se il conteggio non torna.
            if (!_layerRebuilding) refreshLayerList();
            return;
        }
        for (let row = 0; row < rows.length; row++) {
            const c = rows[row].querySelector('canvas.thumb');
            if (c) drawLayerThumb(c, doc.layers[layerIndexForRow(row)]);
        }
    }

    /**
     * La miniatura mostra il livello DA SOLO e a piena opacita': serve a
     * riconoscere cosa c'e' dentro, e un livello al 10% sarebbe una casella
     * vuota identica a un livello davvero vuoto. Che sia nascosto lo dice gia'
     * la riga (classe .hidden-layer).
     */
    function drawLayerThumb(c, l) {
        if (!l) return;
        // Il buffer si rimpicciolisce, non si ingrandisce mai: il CSS scala in
        // su gratis. Assegnare width/height AZZERA il canvas, quindi si tocca
        // solo quando cambia davvero - e subito dopo si ridisegna comunque.
        const k = Math.min(1, LAYER_THUMB_PX / doc.w, LAYER_THUMB_PX / doc.h);
        const bw = Math.max(1, Math.round(doc.w * k));
        const bh = Math.max(1, Math.round(doc.h * k));
        if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
        // La casella CSS segue la PROPORZIONE del documento: forzarla quadrata
        // schiaccerebbe uno sprite largo, ed e' proprio la miniatura a doverlo
        // far riconoscere.
        const s = Math.min(LAYER_THUMB_PX / doc.w, LAYER_THUMB_PX / doc.h);
        c.style.width = Math.max(1, Math.round(doc.w * s)) + 'px';
        c.style.height = Math.max(1, Math.round(doc.h * s)) + 'px';
        const g = ctx2d(c);
        g.clearRect(0, 0, bw, bh);
        g.drawImage(l.canvas, 0, 0, doc.w, doc.h, 0, 0, bw, bh);
    }

    // --- Rinomina in linea ----------------------------------------------------

    function beginRename(rowEl) {
        cancelRename();
        const row = rowEl._row;
        const l = doc.layers[layerIndexForRow(row)];
        const node = rowEl.querySelector('span.lname');
        if (!l || !node) return;

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'field-strong lname';
        inp.value = l.name;
        // La regola globale `*` mette `user-select: none` su tutto: senza questo
        // il testo dentro il campo non si riesce a selezionare col mouse.
        inp.style.userSelect = 'text';
        inp.style.minWidth = '0';

        _renaming = { row: row, input: inp, node: node, rowEl: rowEl };
        rowEl.replaceChild(inp, node);
        inp.focus();
        inp.select();

        inp.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); commitRename(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); cancelRename(); }
            // Le scorciatoie globali sono a lettera singola: senza questo,
            // scrivere "b" nel nome cambierebbe strumento. `isTypingTarget` le
            // filtra gia', ma qui il campo nasce e muore dentro una riga
            // cliccabile e conviene fermare l'evento comunque.
            ev.stopPropagation();
        });
        inp.addEventListener('blur', () => commitRename());
        inp.addEventListener('click', (ev) => ev.stopPropagation());
        inp.addEventListener('dblclick', (ev) => ev.stopPropagation());
    }

    function commitRename() {
        const r = _renaming;
        if (!r) return;
        // Si azzera PRIMA di toccare il DOM: togliere un campo col fuoco fa
        // scattare `blur`, che rientrerebbe qui dentro.
        _renaming = null;
        const l = doc.layers[layerIndexForRow(r.row)];
        const next = String(r.input.value || '').trim();
        if (l && next && next !== l.name) {
            pushHistory();
            l.name = next;
            // Il nome ora e' suo: senza questo, il prossimo cambio di lingua lo
            // riscriverebbe con "Livello 2" (vedi autoNameLayer in 04-doc.js).
            clearAutoName(l);
            markDirty();
        }
        if (l) r.node.textContent = l.name;
        if (r.input.parentNode === r.rowEl) r.rowEl.replaceChild(r.node, r.input);
    }

    function cancelRename() {
        const r = _renaming;
        if (!r) return;
        _renaming = null;
        if (r.input.parentNode === r.rowEl) r.rowEl.replaceChild(r.node, r.input);
    }

    // --- Operazioni ------------------------------------------------------------
    // Sempre nello stesso ordine: pushHistory() PRIMA della modifica, poi la
    // funzione di 04-doc.js, poi renderNow + refreshLayerList + markDirty. Il
    // controllo di fattibilita' viene prima ancora dello snapshot: una
    // cronologia con dentro un passo che non ha cambiato niente costringe a
    // premere Ctrl+Z due volte per vedere un effetto.

    function afterLayerSetChange() {
        renderNow();
        refreshLayerList();
        markDirty();
    }

    function layerAdd() {
        pushHistory();
        addLayer(false);
        afterLayerSetChange();
    }

    function layerDup() {
        pushHistory();
        duplicateLayer();
        afterLayerSetChange();
    }

    function layerDel() {
        if (doc.layers.length <= 1) { setStatus(t('pix.msg.needTwoLayers'), 'warn'); return; }
        pushHistory();
        deleteLayer();
        afterLayerSetChange();
    }

    function layerUp() {
        if (doc.active >= doc.layers.length - 1) { setStatus(t('pix.msg.noLayerAbove'), 'warn'); return; }
        pushHistory();
        moveLayer(1);
        afterLayerSetChange();
    }

    function layerDown() {
        if (doc.active <= 0) { setStatus(t('pix.msg.noLayerBelow'), 'warn'); return; }
        pushHistory();
        moveLayer(-1);
        afterLayerSetChange();
    }

    function layerMerge() {
        if (doc.active <= 0) { setStatus(t('pix.msg.noMergeTarget'), 'warn'); return; }
        pushHistory();
        mergeDown();
        afterLayerSetChange();
    }

    function layerFlatten() {
        if (doc.layers.length <= 1 && doc.layers[0] && doc.layers[0].opacity === 1) {
            setStatus(t('pix.msg.alreadyFlat'), 'warn');
            return;
        }
        pushHistory();
        flattenDoc();
        afterLayerSetChange();
    }

    function toggleLayerVisible(row) {
        const l = doc.layers[layerIndexForRow(row)];
        if (!l) return;
        pushHistory();
        l.visible = !l.visible;
        renderNow();
        // L'insieme dei livelli non e' cambiato: si aggiorna la riga e basta.
        syncLayerRow(row);
        markDirty();
    }

    function setActiveLayer(row) {
        const i = layerIndexForRow(row);
        if (i < 0 || i >= doc.layers.length || i === doc.active) return;
        doc.active = i;
        // Il trascinamento dell'opacita' appartiene a UN livello: se non si
        // azzerasse, il primo movimento del cursore sul livello nuovo salterebbe
        // lo snapshot credendo di essere nello stesso trascinamento di prima.
        _opacityDrag = false;
        updateLayerSelection();
    }

    // --- Opacita' del livello --------------------------------------------------

    function initLayerOpacity() {
        const sl = $('pixLayerOpacity');
        if (!sl) return;

        sl.addEventListener('input', () => {
            const l = activeLayer();
            if (!l) return;
            // Lo snapshot si prende alla PRIMA modifica del trascinamento, dove
            // il documento ha ancora il valore vecchio: uno per evento
            // riempirebbe la cronologia di cento passi per un solo gesto, e uno
            // preso alla fine avrebbe gia' dentro il valore nuovo, cioe'
            // annullerebbe niente.
            if (!_opacityDrag) { _opacityDrag = true; pushHistory(); }
            const pct = clampInt(sl.value, 0, 100);
            l.opacity = pct / 100;
            const out = $('pixLayerOpacityVal');
            if (out) out.textContent = t('pix.common.percent', { n: pct });
            requestRender();
        });

        const done = () => {
            if (!_opacityDrag) return;
            _opacityDrag = false;
            markDirty();
        };
        sl.addEventListener('change', done);
        sl.addEventListener('blur', done);
    }

    // --- Avvio -----------------------------------------------------------------

    function initLayersPanel() {
        bindLayerBtn('pixLayerAddBtn', layerAdd);
        bindLayerBtn('pixLayerDupBtn', layerDup);
        bindLayerBtn('pixLayerDelBtn', layerDel);
        bindLayerBtn('pixLayerUpBtn', layerUp);
        bindLayerBtn('pixLayerDownBtn', layerDown);
        bindLayerBtn('pixLayerMergeBtn', layerMerge);
        bindLayerBtn('pixLayerFlattenBtn', layerFlatten);
        initLayerOpacity();
        refreshLayerList();
    }
