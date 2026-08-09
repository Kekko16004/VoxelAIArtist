    // =======================================================================
    //  09b - Trasformazione della selezione (sposta, ruota, ridimensiona)
    //
    //  Lo strumento "Sposta" non e' un tratto: e' una SESSIONE che sopravvive a
    //  piu' trascinamenti. Si afferra l'interno per spostare, una maniglia per
    //  ridimensionare, appena fuori da un angolo per ruotare, e le tre cose si
    //  compongono senza che il disegno si sgretoli: ogni trascinamento
    //  ricampiona la sorgente ORIGINALE (`src`), mai il risultato del
    //  trascinamento precedente. Trasformare il gia' trasformato e' cio' che
    //  riduce una pixel art a poltiglia dopo tre rotazioni - ogni passaggio
    //  arrotonda, e gli arrotondamenti si sommano.
    //
    //  Fra un trascinamento e l'altro il DOCUMENTO resta valido: il livello
    //  contiene `base` piu' il contenuto trasformato, e `selMask` e' la
    //  maschera trasformata. Non esiste uno stato "in ballo" da confermare,
    //  quindi salvare, esportare, generare con l'AI o mandare la faccia al
    //  padre nel mezzo di una sessione vedono sempre i pixel giusti, e chiudere
    //  la sessione non deve fare niente. E' cio' che rende sicuro chiuderla di
    //  soppiatto (vedi `xformBeforeExternalEdit`) invece di andare a cercare
    //  tutti i punti che potrebbero invalidarla.
    //
    //  I MODIFICATORI. Alt e' gia' il contagocce OVUNQUE (`strokeBegin`),
    //  quindi l'unico tasto disponibile e' Shift, e ha un solo significato:
    //  LIBERA. Senza premere niente il gesto e' ordinato - il ridimensionamento
    //  mantiene le proporzioni e la rotazione scatta di 15 gradi; con Shift i
    //  due lati si muovono indipendenti e l'angolo e' continuo. Un tasto che
    //  vincola in un gesto e libera nell'altro sarebbe da ricordare a memoria.
    // =======================================================================

    // Le maniglie si MISURANO in pixel di schermo (divisi per lo zoom danno
    // pixel di documento): una soglia in pixel di documento sarebbe enorme su
    // una tela 16x16 a 32x e introvabile su una 512x512 a 1x.
    const XF_HANDLE_PX = 9;
    const XF_ROT_RING = 3;          // l'anello di rotazione, in multipli della soglia
    const XF_MIN_SIZE = 1;          // in pixel di documento
    const XF_SNAP_DEG = 15;

    // Segni (su, sv) delle otto maniglie: prima i quattro angoli, poi i lati.
    // (0 su un asse = quel lato non si muove.)
    const XF_SIGNS = [
        [-1, -1], [1, -1], [1, 1], [-1, 1],
        [1, 0], [0, 1], [-1, 0], [0, -1],
    ];

    let _xf = null;
    let _xfInternal = false;

    function xformActive() { return _xf !== null; }

    /**
     * La sessione e' ancora appoggiata al documento che l'ha generata?
     *
     * Si controlla PIGRAMENTE, al primo uso, invece di farsi avvisare da chi
     * cambia le carte in tavola: i modi di invalidarla sono tanti (cambio
     * livello, ritaglio, ridimensiona, annulla, il ponte che cambia faccia) e
     * uno dimenticato sarebbe un `base` vecchio ristampato sopra pixel nuovi.
     */
    function xformValid() {
        if (!_xf) return false;
        if (doc.w !== _xf.docW || doc.h !== _xf.docH) return false;
        if (doc.active !== _xf.layerIdx) return false;
        if (doc.layers[_xf.layerIdx] !== _xf.layerRef) return false;
        if (_selVersion !== _xf.selVersion) return false;
        return true;
    }

    /** Chiude la sessione. Non tocca il documento: e' gia' consistente. */
    function xformEnd() {
        if (!_xf) return;
        _xf = null;
        if (elViewport) elViewport.style.cursor = '';
        requestOverlay();
    }

    /**
     * Rete di sicurezza chiamata da `pushHistory`: chiunque stia per modificare
     * il documento chiude la sessione. `base` e `src` sono la fotografia del
     * livello di quando e' nata, e ristamparli sopra pixel nuovi li
     * cancellerebbe senza un errore e senza un modo di accorgersene.
     */
    function xformBeforeExternalEdit() {
        if (_xfInternal) return;
        xformEnd();
    }

    function xformPushHistory() {
        _xfInternal = true;
        try { pushHistory(); } finally { _xfInternal = false; }
    }

    // --- Apertura della sessione ----------------------------------------------

    /**
     * I limiti del contenuto di UN livello.
     *
     * Non si riusa `opaqueBounds()`: quella misura il COMPOSITO, e qui si
     * solleva un livello solo. I limiti del composito darebbero una scatola
     * piu' grande del contenuto che si sta trasformando, con le maniglie
     * appoggiate sui pixel di qualcun altro.
     */
    function xformLayerBounds(layer) {
        const d = ctx2d(layer.canvas).getImageData(0, 0, doc.w, doc.h).data;
        let x0 = doc.w, y0 = doc.h, x1 = -1, y1 = -1;
        for (let y = 0; y < doc.h; y++) {
            for (let x = 0; x < doc.w; x++) {
                if (d[(y * doc.w + x) * 4 + 3] === 0) continue;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
        return x1 < 0 ? null : { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    /**
     * Solleva il contenuto e apre la sessione. Senza selezione si prende tutto
     * il livello, ma ritagliato ai suoi pixel opachi: cosi' la scatola stringe
     * il disegno invece della tela, e la rotazione gira attorno al centro del
     * soggetto - che e' cio' che si intende quando si dice "ruotalo".
     */
    function xformBegin() {
        const layer = activeLayer();
        if (!layer) return false;
        const hadMask = selActive() && selBox !== null;
        const box = hadMask ? selBox : xformLayerBounds(layer);
        if (!box) { setStatusKey('pix.msg.xformEmpty', null, 'warn'); return false; }

        const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;

        const src = makeCanvas(bw, bh);
        const sg = ctx2d(src);
        sg.drawImage(layer.canvas, -box.x0, -box.y0);

        const base = makeCanvas(doc.w, doc.h);
        let maskImg = null;

        if (hadMask) {
            // La maschera diventa un'IMMAGINE perche' deve passare per lo
            // stesso `drawImage` dei pixel: trasformandola con una formula
            // propria, dopo una rotazione il bordo protetto e il bordo
            // disegnato non coinciderebbero e resterebbero pixel spenti dentro
            // la selezione (o pixel disegnati fuori, che il gesto dopo non si
            // riesce piu' a toccare).
            maskImg = makeCanvas(bw, bh);
            const mg = ctx2d(maskImg);
            const mimg = mg.createImageData(bw, bh);
            const simg = sg.getImageData(0, 0, bw, bh);
            for (let y = 0; y < bh; y++) {
                for (let x = 0; x < bw; x++) {
                    const on = selMask[(y + box.y0) * doc.w + (x + box.x0)];
                    const i = (y * bw + x) * 4;
                    if (!on) simg.data[i + 3] = 0;
                    mimg.data[i] = 255; mimg.data[i + 1] = 255; mimg.data[i + 2] = 255;
                    mimg.data[i + 3] = on ? 255 : 0;
                }
            }
            sg.putImageData(simg, 0, 0);
            mg.putImageData(mimg, 0, 0);

            const bg = ctx2d(base);
            bg.drawImage(layer.canvas, 0, 0);
            const bimg = bg.getImageData(0, 0, doc.w, doc.h);
            for (let i = 0; i < selMask.length; i++) if (selMask[i]) bimg.data[i * 4 + 3] = 0;
            bg.putImageData(bimg, 0, 0);
        }
        // Senza maschera il livello si solleva TUTTO e `base` resta vuoto: ogni
        // pixel opaco sta dentro `box` per costruzione.

        _xf = {
            layerRef: layer, layerIdx: doc.active,
            base: base, src: src, maskImg: maskImg, hadMask: hadMask,
            w0: bw, h0: bh,
            cx: box.x0 + bw / 2, cy: box.y0 + bh / 2,
            w: bw, h: bh, angle: 0,
            docW: doc.w, docH: doc.h,
            selVersion: _selVersion,
            drag: null,
        };
        return true;
    }

    // --- Geometria della scatola ----------------------------------------------

    /** Assi della scatola: `u` lungo la larghezza, `v` lungo l'altezza. */
    function xformAxes(angle) {
        const a = (angle === undefined) ? _xf.angle : angle;
        const ca = Math.cos(a), sa = Math.sin(a);
        return { ux: ca, uy: sa, vx: -sa, vy: ca };
    }

    function xformHandles() {
        const a = xformAxes(), hw = _xf.w / 2, hh = _xf.h / 2;
        const out = [];
        for (let i = 0; i < XF_SIGNS.length; i++) {
            const su = XF_SIGNS[i][0], sv = XF_SIGNS[i][1];
            out.push({
                su: su, sv: sv, corner: i < 4,
                x: _xf.cx + a.ux * su * hw + a.vx * sv * hh,
                y: _xf.cy + a.uy * su * hw + a.vy * sv * hh,
            });
        }
        return out;
    }

    /** Il lato del quadratino, in pixel di DOCUMENTO (mai sotto 1: l'overlay
     *  e' grande quanto il documento e sotto il pixel non rasterizza niente). */
    function xformHandleSize() { return Math.max(1, Math.round(XF_HANDLE_PX / zoom)); }

    /** Raggio di presa. Copre almeno il quadratino disegnato, o si vedrebbe una
     *  maniglia piu' grande di quanto sia afferrabile. */
    function xformHitTol() { return Math.max(XF_HANDLE_PX / zoom, xformHandleSize() * 0.7); }

    /** Coordinate di un punto nel riferimento (ruotato) della scatola. */
    function xformLocal(px, py) {
        const a = xformAxes(), dx = px - _xf.cx, dy = py - _xf.cy;
        return { u: dx * a.ux + dy * a.uy, v: dx * a.vx + dy * a.vy };
    }

    function xformHitTest(p) {
        const tol = xformHitTol();
        const hs = xformHandles();
        let best = null, bestD = Infinity;
        for (let i = 0; i < hs.length; i++) {
            const d = Math.hypot(hs[i].x - p.x, hs[i].y - p.y);
            if (d <= tol && d < bestD) { bestD = d; best = hs[i]; }
        }
        if (best) return { kind: 'scale', su: best.su, sv: best.sv };

        // La rotazione vive in un anello appena FUORI dagli angoli: dentro, la
        // stessa area e' gia' la maniglia di scala. E' cio' che tiene distinti
        // i due gesti senza chiedere un tasto in piu'.
        const l = xformLocal(p.x, p.y);
        if (Math.abs(l.u) > _xf.w / 2 || Math.abs(l.v) > _xf.h / 2) {
            for (let i = 0; i < 4; i++) {
                if (Math.hypot(hs[i].x - p.x, hs[i].y - p.y) <= tol * XF_ROT_RING) return { kind: 'rotate' };
            }
        }
        // Fuori da tutto si sposta lo stesso: e' cio' che faceva lo strumento
        // prima che avesse le maniglie, e toglierlo sarebbe una regressione per
        // chi non le ha ancora scoperte.
        return { kind: 'move' };
    }

    // --- Trascinamento --------------------------------------------------------

    function xformPointerDown(ev) {
        if (!xformValid()) {
            _xf = null;
            if (!xformBegin()) return false;
            setStatusKey('pix.msg.xformHint', null, '', 8000);
        }
        const p = screenToPixelF(ev.clientX, ev.clientY);
        const hit = xformHitTest(p);
        const su = hit.su || 0, sv = hit.sv || 0;
        const a = xformAxes();

        // Uno snapshot per GESTO, come ogni altro strumento: il
        // ridimensionamento e la rotazione che segue sono due annullamenti, non
        // uno solo che riporta indietro tutta la sessione.
        xformPushHistory();

        _xf.drag = {
            kind: hit.kind, su: su, sv: sv,
            px: p.x, py: p.y,
            cx0: _xf.cx, cy0: _xf.cy, w0: _xf.w, h0: _xf.h, angle0: _xf.angle,
            ang0: Math.atan2(p.y - _xf.cy, p.x - _xf.cx),
            // L'ancora e' la maniglia OPPOSTA, fissata all'inizio: ricalcolarla
            // a ogni movimento la farebbe scivolare dietro alla scatola che sta
            // ridimensionando, e il lato fermo non starebbe fermo.
            ax: _xf.cx - a.ux * su * _xf.w / 2 - a.vx * sv * _xf.h / 2,
            ay: _xf.cy - a.uy * su * _xf.w / 2 - a.vy * sv * _xf.h / 2,
        };
        requestOverlay();
        return true;
    }

    function xformApplyScale(d, p, free) {
        const a = xformAxes(d.angle0);
        const dx = p.x - d.ax, dy = p.y - d.ay;
        const pu = dx * a.ux + dy * a.uy;       // puntatore, misurato dall'ancora
        const pv = dx * a.vx + dy * a.vy;
        const hu = d.su * d.w0, hv = d.sv * d.h0;   // maniglia meno ancora, a inizio gesto

        let nw = d.w0, nh = d.h0;
        if (free) {
            if (d.su) nw = pu * d.su;
            if (d.sv) nh = pv * d.sv;
            nw = Math.max(XF_MIN_SIZE, nw);
            nh = Math.max(XF_MIN_SIZE, nh);
        } else {
            // Proporzioni bloccate: il fattore e' la PROIEZIONE del puntatore
            // sulla diagonale di partenza. Prendere il maggiore fra i due
            // rapporti farebbe scattare la scatola quando si trascina di
            // traverso; la proiezione la fa seguire il dito senza strappi.
            const dd = hu * hu + hv * hv;
            let k = dd > 0 ? (pu * hu + pv * hv) / dd : 1;
            k = Math.max(k, XF_MIN_SIZE / Math.min(d.w0, d.h0));
            nw = d.w0 * k; nh = d.h0 * k;
        }

        _xf.w = nw; _xf.h = nh;
        // Il centro si ricostruisce DALL'ANCORA: e' l'ancora a stare ferma.
        _xf.cx = d.ax + a.ux * d.su * nw / 2 + a.vx * d.sv * nh / 2;
        _xf.cy = d.ay + a.uy * d.su * nw / 2 + a.vy * d.sv * nh / 2;
    }

    function xformApplyRotate(d, p, free) {
        const now = Math.atan2(p.y - d.cy0, p.x - d.cx0);
        let ang = d.angle0 + (now - d.ang0);
        if (!free) {
            const step = XF_SNAP_DEG * Math.PI / 180;
            ang = Math.round(ang / step) * step;
        }
        _xf.angle = ang;
    }

    function xformApplyMove(d, p) {
        // Traslazione INTERA: mezzo pixel ricampionerebbe l'intero disegno per
        // non spostarlo, e in pixel art si legge come una sfocatura arrivata
        // dal nulla. Sommando interi la parte frazionaria del centro non cambia,
        // quindi la griglia di campionamento resta quella di prima.
        _xf.cx = d.cx0 + Math.round(p.x - d.px);
        _xf.cy = d.cy0 + Math.round(p.y - d.py);
    }

    function xformPointerMove(ev) {
        if (!_xf) return false;
        if (!xformValid()) { xformEnd(); return false; }
        const p = screenToPixelF(ev.clientX, ev.clientY);
        if (!_xf.drag) {
            if (!spaceDown && elViewport) elViewport.style.cursor = xformCursorFor(xformHitTest(p));
            return false;
        }
        const d = _xf.drag;
        if (d.kind === 'scale') xformApplyScale(d, p, ev.shiftKey);
        else if (d.kind === 'rotate') xformApplyRotate(d, p, ev.shiftKey);
        else xformApplyMove(d, p);
        xformStamp(false);
        requestRender();
        return true;
    }

    function xformPointerUp() {
        if (!_xf || !_xf.drag) return false;
        _xf.drag = null;
        // La maschera si ricalcola SOLO qui: e' una scansione dell'intera tela,
        // e farla a ogni movimento del puntatore trasformerebbe un
        // trascinamento fluido in una sequenza di scatti.
        xformStamp(true);
        renderNow();
        markDirty();
        return true;
    }

    function xformCursorFor(hit) {
        if (hit.kind === 'rotate') return 'crosshair';
        if (hit.kind !== 'scale') return 'move';
        const a = xformAxes();
        const dx = a.ux * hit.su * _xf.w + a.vx * hit.sv * _xf.h;
        const dy = a.uy * hit.su * _xf.w + a.vy * hit.sv * _xf.h;
        const k = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 4) + 4) % 4;
        return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][k];
    }

    // --- Stampa sul livello ---------------------------------------------------

    function xformPaint(g) {
        g.save();
        g.imageSmoothingEnabled = false;
        g.translate(_xf.cx, _xf.cy);
        g.rotate(_xf.angle);
        g.scale(_xf.w / _xf.w0, _xf.h / _xf.h0);
        g.drawImage(_xf.src, -_xf.w0 / 2, -_xf.h0 / 2);
        g.restore();
    }

    function xformStamp(withMask) {
        const layer = _xf.layerRef;
        clearCanvas(layer.canvas);
        layer.ctx.drawImage(_xf.base, 0, 0);
        xformPaint(layer.ctx);
        if (!withMask || !_xf.hadMask) return;
        selSetMask(xformMask());
        // La maschera l'ha cambiata la sessione stessa: senza risincronizzare
        // il contatore, `xformValid` la vedrebbe come una modifica altrui e si
        // chiuderebbe da sola al primo movimento successivo.
        _xf.selVersion = _selVersion;
    }

    function xformMask() {
        const c = makeCanvas(doc.w, doc.h);
        const g = ctx2d(c);
        g.imageSmoothingEnabled = false;
        g.translate(_xf.cx, _xf.cy);
        g.rotate(_xf.angle);
        g.scale(_xf.w / _xf.w0, _xf.h / _xf.h0);
        g.drawImage(_xf.maskImg, -_xf.w0 / 2, -_xf.h0 / 2);
        const d = g.getImageData(0, 0, doc.w, doc.h).data;
        const m = new Uint8Array(doc.w * doc.h);
        for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
        return m;
    }

    // --- Disegno sull'overlay -------------------------------------------------

    /**
     * Durante un trascinamento le formiche mostrerebbero la maschera VECCHIA
     * (si ricalcola solo al rilascio): un contorno fermo accanto a un disegno
     * che si muove si legge come un difetto, non come un'ottimizzazione.
     */
    function xformSuppressAnts() { return _xf !== null && _xf.drag !== null; }

    function xformDrawOverlay(g) {
        if (!_xf) return false;
        if (!xformValid()) { _xf = null; return false; }

        // Contorno e maniglie si disegnano NEI PIXEL del documento, come le
        // formiche: l'overlay e' grande quanto il documento ed e' il CSS a
        // ingrandirlo, quindi un tratto di 1 pixel di schermo qui sarebbe
        // 1/zoom di pixel e a 32x non lo rasterizzerebbe nessuno.
        const hs = xformHandles();
        let n = 0;
        for (let i = 0; i < 4; i++) {
            const a = hs[i], b = hs[(i + 1) % 4];
            rasterLine(Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y), (x, y) => {
                const on = ((n++ >> 1) & 1);
                if (!inDoc(x, y)) return;
                g.fillStyle = on ? '#000000' : '#ffffff';
                g.fillRect(x, y, 1, 1);
            });
        }

        const s = xformHandleSize();
        for (let i = 0; i < hs.length; i++) {
            const x = Math.round(hs[i].x - s / 2), y = Math.round(hs[i].y - s / 2);
            g.fillStyle = '#000000';
            g.fillRect(x - 1, y - 1, s + 2, s + 2);
            // Gli angoli sono di un altro colore perche' sanno fare una cosa in
            // piu' dei lati: da li' (appena fuori) si ruota.
            g.fillStyle = hs[i].corner ? '#ffcc44' : '#ffffff';
            g.fillRect(x, y, s, s);
        }
        return true;
    }
