    // =======================================================================
    //  05 - Visore: layout, zoom, spostamento, disegno a schermo
    //
    //  Due canvas sovrapposti, ENTRAMBI della dimensione del documento in pixel
    //  veri; e' il CSS a ingrandirli (`image-rendering: pixelated`).
    //    - #pixCanvas : il composito dei livelli. E' il disegno.
    //    - #pixOverlay: selezione e anteprime degli strumenti. Non e' il
    //      disegno e non finisce mai in un export.
    //  Tenere le anteprime su un canvas separato evita l'errore classico:
    //  disegnare l'anteprima sul livello e poi "cancellarla" ridisegnando il
    //  disegno sotto, che a ogni movimento del puntatore costa un ridisegno
    //  completo e sbaglia appena il livello sotto non e' opaco.
    //
    //  Il render e' A RICHIESTA (`requestRender`), non a 60 fps: qui non si
    //  muove nulla da solo e un rAF perenne terrebbe sveglia la GPU per una
    //  tela ferma.
    // =======================================================================

    let elViewport = null, elStage = null, elCanvas = null, elOverlay = null, elGrid = null;
    let gCanvas = null, gOverlay = null;

    let zoom = 8;
    let gridOn = false;

    let _renderPending = false;
    let _overlayPending = false;
    let _statusTimer = 0;
    // La chiave del messaggio in barra, quando ne ha una: vedi `setStatusKey`.
    let _statusAuto = null;

    function cacheViewportDom() {
        elViewport = $('pixViewport');
        elStage = $('pixStage');
        elCanvas = $('pixCanvas');
        elOverlay = $('pixOverlay');
        elGrid = $('pixGrid');
        gCanvas = ctx2d(elCanvas);
        gOverlay = ctx2d(elOverlay);
    }

    /**
     * Allinea la dimensione in pixel dei due canvas a quella del documento.
     *
     * Assegnare `width`/`height` AZZERA un canvas, quindi si tocca solo quando
     * e' davvero cambiato: farlo a ogni render cancellerebbe il disegno appena
     * fatto e costringerebbe a ricomporre tutto per ogni pennellata.
     */
    function syncCanvasSize() {
        if (elCanvas.width !== doc.w || elCanvas.height !== doc.h) {
            elCanvas.width = doc.w; elCanvas.height = doc.h;
            gCanvas = ctx2d(elCanvas);
        }
        if (elOverlay.width !== doc.w || elOverlay.height !== doc.h) {
            elOverlay.width = doc.w; elOverlay.height = doc.h;
            gOverlay = ctx2d(elOverlay);
        }
    }

    /**
     * Lo stage e' l'UNICO punto che decide quanto grande si vede il disegno:
     * tela, overlay e griglia lo riempiono al 100% via CSS, quindi restano
     * allineati al pixel a qualunque zoom senza doversi accordare fra loro.
     */
    function layoutStage() {
        elStage.style.width = (doc.w * zoom) + 'px';
        elStage.style.height = (doc.h * zoom) + 'px';
        elStage.style.setProperty('--cell', zoom + 'px');
        applyGridVisibility();
        const zs = $('pixStatusZoom');
        if (zs) zs.textContent = (zoom * 100) + '%';
        const ss = $('pixStatusSize');
        if (ss) ss.textContent = doc.w + ' x ' + doc.h;
    }

    /**
     * La griglia si spegne da sola sotto GRID_MIN_ZOOM: con un passo di pochi
     * pixel le linee occupano meta' della cella e si vede solo la griglia. E'
     * una soppressione di RESA, non uno spegnimento della preferenza: tornando
     * a ingrandire la griglia riappare senza che l'utente la riaccenda.
     */
    function applyGridVisibility() {
        if (!elGrid) return;
        elGrid.classList.toggle('on', gridOn && zoom >= GRID_MIN_ZOOM);
    }

    function setGrid(on) {
        gridOn = !!on;
        savePref('grid', gridOn ? '1' : '0');
        applyGridVisibility();
    }

    function toggleGrid() { setGrid(!gridOn); }

    // --- Zoom ---------------------------------------------------------------

    /** Il fattore valido piu' vicino a `z`, sempre uno di PIX_ZOOMS. */
    function snapZoom(z) {
        let best = PIX_ZOOMS[0];
        for (let i = 0; i < PIX_ZOOMS.length; i++) {
            if (Math.abs(PIX_ZOOMS[i] - z) < Math.abs(best - z)) best = PIX_ZOOMS[i];
        }
        return best;
    }

    /**
     * Cambia zoom ANCORANDO il punto sotto il puntatore.
     *
     * Senza l'ancoraggio, ingrandire porta via da sotto il mouse esattamente la
     * zona che si stava guardando: si finisce a inseguire il proprio disegno
     * con le barre di scorrimento. Con `clientX` nullo l'ancora e' il centro del
     * viewport, che e' il comportamento giusto per i comandi da menu e da
     * tastiera.
     */
    function setZoom(z, clientX, clientY) {
        const next = clamp(z | 0, PIX_ZOOMS[0], PIX_ZOOMS[PIX_ZOOMS.length - 1]);
        if (next === zoom) return;
        const vr = elViewport.getBoundingClientRect();
        if (clientX == null || clientY == null ||
            clientX < vr.left || clientX > vr.right || clientY < vr.top || clientY > vr.bottom) {
            clientX = vr.left + vr.width / 2;
            clientY = vr.top + vr.height / 2;
        }
        const before = elStage.getBoundingClientRect();
        // Punto del documento sotto il puntatore, in coordinate frazionarie.
        const ax = (clientX - before.left) / zoom;
        const ay = (clientY - before.top) / zoom;

        zoom = next;
        layoutStage();

        // Dopo il layout lo stage puo' essersi spostato da solo (`margin: auto`
        // lo centra finche' ci sta): la posizione va RIMISURATA, non dedotta.
        const after = elStage.getBoundingClientRect();
        elViewport.scrollLeft += (after.left + ax * zoom) - clientX;
        elViewport.scrollTop += (after.top + ay * zoom) - clientY;
    }

    function zoomStep(dir, clientX, clientY) {
        let i = PIX_ZOOMS.indexOf(zoom);
        if (i < 0) i = PIX_ZOOMS.indexOf(snapZoom(zoom));
        setZoom(PIX_ZOOMS[clamp(i + dir, 0, PIX_ZOOMS.length - 1)], clientX, clientY);
    }

    /**
     * Zoom massimo che fa entrare tutta la tela nel viewport.
     * Va chiamata a viewport VISIBILE: con `display:none` misura 0 e "adatta"
     * darebbe sempre il minimo.
     */
    function zoomToFit() {
        const vr = elViewport.getBoundingClientRect();
        if (vr.width < 2 || vr.height < 2) return;
        const pad = 24;
        const fit = Math.min((vr.width - pad) / doc.w, (vr.height - pad) / doc.h);
        let best = PIX_ZOOMS[0];
        for (let i = 0; i < PIX_ZOOMS.length; i++) {
            if (PIX_ZOOMS[i] <= fit) best = PIX_ZOOMS[i];
        }
        const prev = zoom;
        zoom = best;
        layoutStage();
        if (prev === best) return;
        // Ricentra: con "adatta" l'ancoraggio al puntatore non ha senso, la
        // tela intera deve stare in mezzo.
        elViewport.scrollLeft = (elViewport.scrollWidth - elViewport.clientWidth) / 2;
        elViewport.scrollTop = (elViewport.scrollHeight - elViewport.clientHeight) / 2;
    }

    // --- Coordinate ----------------------------------------------------------

    /**
     * Punto del documento sotto un evento del puntatore. Puo' cadere FUORI
     * dalla tela (numeri negativi o >= w/h): filtrarlo qui nasconderebbe la
     * differenza fra "sul bordo" e "fuori", che serve agli strumenti a
     * trascinamento (un rettangolo puo' cominciare fuori e finire dentro).
     */
    function screenToPixel(clientX, clientY) {
        const r = elStage.getBoundingClientRect();
        return {
            x: Math.floor((clientX - r.left) / zoom),
            y: Math.floor((clientY - r.top) / zoom),
        };
    }

    function inDoc(x, y) { return x >= 0 && y >= 0 && x < doc.w && y < doc.h; }

    /**
     * Come `screenToPixel`, ma SENZA arrotondare.
     *
     * Serve alla trasformazione della selezione, dove le grandezze in gioco
     * (angolo, fattore di scala, distanza da una maniglia) sono continue:
     * arrotondando qui, a zoom 1 una rotazione avrebbe scatti di parecchi gradi
     * fra un pixel e l'altro, e la scatola si muoverebbe a strappi. Il
     * risultato si arrotonda alla FINE, dove serve davvero.
     */
    function screenToPixelF(clientX, clientY) {
        const r = elStage.getBoundingClientRect();
        return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
    }

    // --- Disegno a schermo ---------------------------------------------------

    function requestRender() {
        if (_renderPending) return;
        _renderPending = true;
        requestAnimationFrame(() => { _renderPending = false; renderNow(); });
    }

    function renderNow() {
        syncCanvasSize();
        compositeTo(gCanvas);
        requestOverlay();
        refreshLayerThumbs();
    }

    function requestOverlay() {
        if (_overlayPending) return;
        _overlayPending = true;
        requestAnimationFrame(() => { _overlayPending = false; overlayNow(); });
    }

    function overlayNow() {
        syncCanvasSize();
        gOverlay.clearRect(0, 0, doc.w, doc.h);
        // Le formiche vanno SOTTO, non sopra. La scatola di trasformazione e le
        // sue maniglie stanno sul bordo della selezione, cioe' esattamente dove
        // passano le formiche: disegnandole dopo le coprono. In GUI reale
        // l'angolo alto-sinistro non si vedeva MAI - e' l'unico dei quattro che
        // cade su un pixel selezionato, e quindi l'unico su cui passa una
        // formica. Una maniglia invisibile e' peggio di un bordo coperto: il
        // bordo si indovina dalla selezione, la maniglia si cerca col mouse.
        if (!xformSuppressAnts()) drawSelectionAnts(gOverlay);
        drawToolOverlay(gOverlay);
    }

    // --- Barra di stato -------------------------------------------------------

    /**
     * `kind` e' '', 'ok', 'warn' o 'err'. Il messaggio si cancella da solo:
     * un errore rimasto li' per mezz'ora si legge come lo stato attuale.
     */
    /**
     * Messaggio di stato gia' RISOLTO. Chi ha una chiave usa `setStatusKey`.
     *
     * Il testo qui e' una stringa e basta, quindi `_statusAuto` si azzera: un
     * messaggio scritto a mano non deve essere riscritto dal cambio lingua.
     */
    function setStatus(msg, kind, ms) {
        _statusAuto = null;
        showStatus(msg, kind, ms);
    }

    /**
     * Messaggio di stato che RICORDA la chiave da cui viene.
     *
     * Serve perche' `t()` prima di `bootI18n` ritorna la chiave nuda per
     * contratto, e `bootI18n` e' l'ultima riga dell'avvio, senza await (aspetta
     * due fetch). Il ponte invece parte subito: manda `hello`, il padre risponde
     * all'istante e il messaggio "N facce caricate" veniva scritto mentre il
     * dizionario non c'era ancora - in barra si leggeva `pix.bridge.msg.loaded`
     * per tutti e 4,5 i secondi di vita del messaggio. Visto in GUI reale.
     *
     * Il titolo del ponte accanto si riprendeva da solo perche'
     * `refreshBridgeFaces` sta in `I18N_REDRAW`; un messaggio di stato e' uno
     * sparo singolo e non lo ridisegna nessuno, quindi la memoria della chiave
     * (`_statusAuto`) e' l'unico modo di rimediare senza aspettare i dizionari
     * prima del primo disegno.
     */
    function setStatusKey(key, args, kind, ms) {
        showStatus(t(key, args), kind, ms);
        _statusAuto = { key: key, args: args || null };
    }

    function showStatus(msg, kind, ms) {
        const el = $('pixStatusMsg');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'grow msg' + (kind ? ' ' + kind : '');
        if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = 0; }
        if (msg) {
            _statusTimer = setTimeout(() => {
                el.textContent = ''; el.className = 'grow msg'; _statusTimer = 0;
                _statusAuto = null;
            }, ms || (kind === 'err' ? 9000 : 4500));
        }
    }

    /**
     * Riscrive il messaggio in corso quando arrivano (o cambiano) i dizionari.
     * Registrata in `I18N_REDRAW`. Se la barra e' gia' scaduta non si riaccende:
     * far ricomparire un messaggio vecchio al cambio lingua sarebbe peggio del
     * difetto che questa funzione ripara.
     */
    function relabelAutoStatus() {
        if (!_statusAuto) return;
        const el = $('pixStatusMsg');
        if (!el || !el.textContent) return;
        el.textContent = t(_statusAuto.key, _statusAuto.args);
    }

    function setStatusPos(x, y) {
        const el = $('pixStatusPos');
        if (!el) return;
        el.textContent = (x == null) ? '-' : (x + ', ' + y);
    }

    // --- Spostamento della tela ----------------------------------------------
    // Tasto centrale o barra spaziatrice. Il filtro non e' un vezzo: senza,
    // trascinare per spostarsi a zoom alto sporcherebbe il disegno a ogni
    // movimento, perche' il tasto sinistro dipinge.

    let spaceDown = false;
    let _pan = null;

    function beginPan(ev) {
        _pan = {
            id: ev.pointerId,
            x: ev.clientX, y: ev.clientY,
            sl: elViewport.scrollLeft, st: elViewport.scrollTop,
        };
        elViewport.setPointerCapture && elViewport.setPointerCapture(ev.pointerId);
        elStage.style.cursor = 'grabbing';
    }

    function movePan(ev) {
        if (!_pan) return false;
        elViewport.scrollLeft = _pan.sl - (ev.clientX - _pan.x);
        elViewport.scrollTop = _pan.st - (ev.clientY - _pan.y);
        return true;
    }

    function endPan() {
        if (!_pan) return;
        _pan = null;
        elStage.style.cursor = '';
    }

    function isPanning() { return _pan !== null; }
