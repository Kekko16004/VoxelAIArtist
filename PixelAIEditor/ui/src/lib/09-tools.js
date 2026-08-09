    // =======================================================================
    //  09 - Strumenti e puntatore
    //
    //  Un solo gestore di eventi per tutti gli strumenti. La differenza fra
    //  matita, linea e selezione non sta in tre catene di listener diverse ma in
    //  tre rami di `strokeBegin`/`strokeMove`/`strokeEnd`: cosi' le regole che
    //  valgono per tutti - Alt e' sempre il contagocce, il tasto destro usa il
    //  colore secondario, lo spazio sposta la tela, uno snapshot per tratto -
    //  sono scritte una volta e non possono valere per due strumenti su tre.
    //
    //  Gli eventi stanno sul VIEWPORT, non sullo stage: un trascinamento che
    //  esce dalla tela deve continuare a funzionare (un rettangolo puo'
    //  cominciare fuori), e lo spostamento con la barra spaziatrice deve
    //  partire anche dall'area grigia attorno al disegno.
    // =======================================================================

    let currentTool = 'pencil';
    let hoverPix = null;

    const toolOpts = {
        size: 1,
        tolerance: 0,
        contiguous: true,
        fillShape: false,
        mirror: 'none',
    };

    let colorPrimary = '#e8e8ec';
    let colorSecondary = '#16161a';
    let colorAlpha = 255;

    // Quali opzioni ha senso mostrare per ogni strumento. Una barra che mostra
    // sempre tutto costringe a chiedersi ogni volta quali servano davvero;
    // peggio, invita a regolare la tolleranza mentre si usa la matita e a
    // credere che non funzioni.
    const TOOL_OPTIONS = {
        pencil: ['size', 'mirror'],
        eraser: ['size', 'mirror'],
        fill: ['tolerance', 'contiguous', 'mirror'],
        picker: [],
        line: ['size', 'mirror'],
        rect: ['size', 'fillShape', 'mirror'],
        ellipse: ['size', 'fillShape', 'mirror'],
        select: [],
        lasso: [],
        wand: ['tolerance', 'contiguous'],
        move: [],
    };

    // Uno strumento che modifica i pixel prende uno snapshot; uno che cambia
    // solo la selezione o il colore no. Elencare quali invece di prendere
    // sempre lo snapshot evita che Ctrl+Z debba essere premuto tre volte perche'
    // nel mezzo si e' usato il contagocce.
    // `move` non e' nell'elenco perche' non e' piu' un tratto: e' una sessione
    // (09b-transform.js) che prende uno snapshot per proprio conto, uno per
    // gesto, e non passa mai di qui.
    const TOOLS_THAT_PAINT = ['pencil', 'eraser', 'fill', 'line', 'rect', 'ellipse'];

    let stroke = null;

    function setTool(name) {
        if (!TOOL_OPTIONS[name]) return;
        // Cambiare strumento a tratto aperto lascerebbe un'anteprima orfana
        // sull'overlay.
        if (stroke) strokeCancel();
        // La sessione di trasformazione si chiude sempre, anche riscegliendo
        // "Sposta": le sue maniglie non hanno senso mentre e' in mano un altro
        // strumento, e il documento e' gia' consistente, quindi non c'e' niente
        // da confermare.
        xformEnd();
        currentTool = name;
        $$('#pixToolbar .tool-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-tool') === name);
        });
        refreshToolOptions();
        requestOverlay();
    }

    function refreshToolOptions() {
        const want = TOOL_OPTIONS[currentTool] || [];
        $$('#pixOptionsBar .opt').forEach((el) => {
            el.classList.toggle('hidden', want.indexOf(el.getAttribute('data-opt')) < 0);
        });
    }

    // --- Colori ---------------------------------------------------------------

    function setPrimary(hex) { colorPrimary = hex; refreshColorUI(); }
    function setSecondary(hex) { colorSecondary = hex; refreshColorUI(); }

    function swapColors() {
        const tmp = colorPrimary; colorPrimary = colorSecondary; colorSecondary = tmp;
        refreshColorUI();
    }

    function refreshColorUI() {
        const p = $('pixColorPrimary'), s = $('pixColorSecondary');
        if (p) p.querySelector('.fillbox').style.background = cssRgba(colorPrimary, colorAlpha);
        if (s) s.querySelector('.fillbox').style.background = cssRgba(colorSecondary, 255);
        const inp = $('pixColorInput');
        if (inp && inp.value.toLowerCase() !== colorPrimary.toLowerCase()) inp.value = colorPrimary;
        const av = $('pixAlphaVal');
        if (av) av.textContent = String(colorAlpha);
        refreshSwatchActive();
    }

    /** Lo stile di disegno per un tasto del mouse: destro = colore secondario. */
    function styleForButton(button) {
        if (currentTool === 'eraser') return null;
        const hex = (button === 2) ? colorSecondary : colorPrimary;
        return cssRgba(hex, currentTool === 'eraser' ? 0 : colorAlpha);
    }

    // --- Tratto ---------------------------------------------------------------

    function toolPaints(tool) { return TOOLS_THAT_PAINT.indexOf(tool) >= 0; }

    function strokeBegin(ev, px) {
        // Alt e' SEMPRE il contagocce, qualunque strumento sia attivo: e' la
        // convenzione di ogni editor e vale piu' di un tasto dedicato, perche'
        // si prende un colore senza perdere lo strumento in mano.
        const tool = ev.altKey ? 'picker' : currentTool;
        const mode = ev.shiftKey ? 'add' : (ev.altKey ? 'sub' : 'replace');

        if (tool === 'picker') {
            const c = samplePixel(px.x, px.y, true);
            if (c) {
                if (ev.button === 2) setSecondary(c.hex); else { setPrimary(c.hex); setAlpha(c.alpha); }
            }
            return;
        }

        if (tool === 'wand') {
            selectWand(px.x, px.y, toolOpts.tolerance, toolOpts.contiguous, true, mode);
            return;
        }

        if (!inDoc(px.x, px.y) && (tool === 'fill')) return;

        // UNO snapshot per tratto, PRIMA della modifica.
        if (toolPaints(tool)) pushHistory();

        stroke = {
            tool: tool,
            button: ev.button,
            style: styleForButton(ev.button),
            mode: mode,
            sx: px.x, sy: px.y,
            lx: px.x, ly: px.y,
            points: [{ x: px.x, y: px.y }],
            lift: null, dx: 0, dy: 0,
            dirty: false,
        };

        if (tool === 'pencil' || tool === 'eraser') {
            paintDab(px.x, px.y);
        } else if (tool === 'fill') {
            doFill(px.x, px.y, stroke.style);
            strokeEnd(ev, px);
        }
        requestOverlay();
    }

    function strokeMove(ev, px) {
        if (!stroke) return;
        const t0 = stroke.tool;
        if (t0 === 'pencil' || t0 === 'eraser') {
            // Si interpola dall'ULTIMO punto: gli eventi del puntatore non
            // arrivano per ogni pixel attraversato e senza l'interpolazione un
            // tratto veloce esce come una fila di puntini.
            rasterLine(stroke.lx, stroke.ly, px.x, px.y, (x, y) => paintDab(x, y));
        } else if (t0 === 'lasso') {
            stroke.points.push({ x: px.x, y: px.y });
        }
        stroke.lx = px.x; stroke.ly = px.y;
        requestOverlay();
    }

    function strokeEnd(ev, px) {
        if (!stroke) return;
        const s = stroke;
        stroke = null;

        if (s.tool === 'line' || s.tool === 'rect' || s.tool === 'ellipse') {
            const g = activeLayer().ctx;
            shapePixels(s, px, (x, y) => stampAt(g, x, y, s.style, toolOpts.size, toolOpts.mirror));
            s.dirty = true;
        } else if (s.tool === 'select') {
            selectRect(s.sx, s.sy, px.x, px.y, s.mode);
        } else if (s.tool === 'lasso') {
            if (s.points.length >= 3) selectPolygon(s.points, s.mode); else selectNone();
        }

        if (s.dirty) { renderNow(); markDirty(); }
        requestOverlay();
    }

    /** Abbandona il tratto in corso senza applicarlo (cambio strumento, Esc). */
    function strokeCancel() {
        const s = stroke;
        stroke = null;
        if (!s) return;
        if (s.dirty || (s.tool === 'pencil' || s.tool === 'eraser')) renderNow();
        requestOverlay();
    }

    function paintDab(x, y) {
        stampAt(activeLayer().ctx, x, y, stroke.style, toolOpts.size, toolOpts.mirror);
        stroke.dirty = true;
        requestRender();
    }

    function doFill(x, y, style) {
        if (!inDoc(x, y)) return;
        const src = flattenToCanvas();
        const data = ctx2d(src).getImageData(0, 0, doc.w, doc.h).data;
        const g = activeLayer().ctx;
        const mode = toolOpts.mirror;
        floodRegion(data, doc.w, doc.h, x, y, toolOpts.tolerance, toolOpts.contiguous, (px, py) => {
            // Il riempimento NON usa lo spessore del pennello (sarebbe una
            // dilatazione della regione, non un riempimento) ma rispetta la
            // simmetria, che e' cio' che serve per colorare due meta' speculari
            // in un colpo solo.
            const pts = mirrorPoints(px, py, mode);
            for (let i = 0; i < pts.length; i++) putPixel(g, pts[i].x, pts[i].y, style);
        });
        stroke.dirty = true;
    }

    /** Le coordinate della forma in corso, condivise da anteprima e commit. */
    function shapePixels(s, px, cb) {
        // Shift vincola: linea a 45 gradi, rettangolo quadrato, ellisse cerchio.
        let ex = px.x, ey = px.y;
        if (s.constrain) {
            const dx = ex - s.sx, dy = ey - s.sy;
            if (s.tool === 'line') {
                if (Math.abs(dx) > Math.abs(dy) * 2) ey = s.sy;
                else if (Math.abs(dy) > Math.abs(dx) * 2) ex = s.sx;
                else { const n = Math.min(Math.abs(dx), Math.abs(dy)); ex = s.sx + Math.sign(dx) * n; ey = s.sy + Math.sign(dy) * n; }
            } else {
                const n = Math.min(Math.abs(dx), Math.abs(dy));
                ex = s.sx + Math.sign(dx) * n; ey = s.sy + Math.sign(dy) * n;
            }
        }
        if (s.tool === 'line') rasterLine(s.sx, s.sy, ex, ey, cb);
        else if (s.tool === 'rect') rasterRect(s.sx, s.sy, ex, ey, toolOpts.fillShape, cb);
        else if (s.tool === 'ellipse') rasterEllipse(s.sx, s.sy, ex, ey, toolOpts.fillShape, cb);
    }

    // --- Anteprime sull'overlay ------------------------------------------------

    function drawToolOverlay(g) {
        // "Sposta" e' una sessione, non un tratto: se ne sta aperta una, e' lei
        // a possedere l'overlay (scatola e maniglie) e nessun'altra anteprima ha
        // senso, perche' non c'e' nessun tratto in corso.
        if (xformDrawOverlay(g)) return;
        if (stroke && (stroke.tool === 'line' || stroke.tool === 'rect' || stroke.tool === 'ellipse')) {
            const px = { x: stroke.lx, y: stroke.ly };
            shapePixels(stroke, px, (x, y) => stampAt(g, x, y, stroke.style, toolOpts.size, toolOpts.mirror));
            return;
        }
        if (stroke && stroke.tool === 'select') {
            drawMarquee(g, stroke.sx, stroke.sy, stroke.lx, stroke.ly);
            return;
        }
        if (stroke && stroke.tool === 'lasso') {
            g.fillStyle = '#ffffff';
            for (let i = 1; i < stroke.points.length; i++) {
                const a = stroke.points[i - 1], b = stroke.points[i];
                rasterLine(a.x, a.y, b.x, b.y, (x, y) => { if (inDoc(x, y)) g.fillRect(x, y, 1, 1); });
            }
            return;
        }
        drawBrushCursor(g);
    }

    function drawMarquee(g, x0, y0, x1, y1) {
        g.save();
        rasterRect(clamp(Math.min(x0, x1), 0, doc.w - 1), clamp(Math.min(y0, y1), 0, doc.h - 1),
            clamp(Math.max(x0, x1), 0, doc.w - 1), clamp(Math.max(y0, y1), 0, doc.h - 1),
            false, (x, y) => {
                g.fillStyle = (((x + y) >> 1) & 1) ? '#000000' : '#ffffff';
                g.fillRect(x, y, 1, 1);
            });
        g.restore();
    }

    /**
     * L'impronta del pennello sotto il puntatore. Si mostra solo da 3x in su:
     * a zoom basso un pixel di schermo e' un pixel di tela e il "cursore"
     * coprirebbe esattamente il pixel che si vuole vedere.
     */
    function drawBrushCursor(g) {
        if (!hoverPix || zoom < 3) return;
        if (['pencil', 'eraser', 'line', 'rect', 'ellipse'].indexOf(currentTool) < 0) return;
        const s = Math.max(1, toolOpts.size | 0), off = (s - 1) >> 1;
        g.save();
        g.globalAlpha = 0.45;
        g.fillStyle = currentTool === 'eraser' ? '#ff5555' : colorPrimary;
        for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
                const x = hoverPix.x - off + dx, y = hoverPix.y - off + dy;
                if (inDoc(x, y)) g.fillRect(x, y, 1, 1);
            }
        }
        g.restore();
    }

    // --- Collegamento degli eventi ---------------------------------------------

    function initPointer() {
        const vp = elViewport;

        vp.addEventListener('pointerdown', (ev) => {
            vp.focus && vp.focus();
            const px = screenToPixel(ev.clientX, ev.clientY);
            if (ev.button === 1 || spaceDown) { ev.preventDefault(); beginPan(ev); return; }
            if (ev.button !== 0 && ev.button !== 2) return;
            ev.preventDefault();
            vp.setPointerCapture(ev.pointerId);
            // "Sposta" con il tasto sinistro e senza Alt non e' un tratto ma una
            // sessione di trasformazione. Alt resta il contagocce anche qui, e
            // il tasto destro non ha un senso proprio in questo strumento:
            // entrambi ricadono sulla via normale.
            if (currentTool === 'move' && ev.button === 0 && !ev.altKey) {
                if (xformPointerDown(ev)) return;
                return;
            }
            strokeBegin(ev, px);
            if (stroke) stroke.constrain = ev.shiftKey;
        });

        vp.addEventListener('pointermove', (ev) => {
            if (movePan(ev)) return;
            const px = screenToPixel(ev.clientX, ev.clientY);
            hoverPix = inDoc(px.x, px.y) ? px : null;
            setStatusPos(hoverPix ? px.x : null, hoverPix ? px.y : null);
            if (xformPointerMove(ev)) return;
            if (stroke) { stroke.constrain = ev.shiftKey; strokeMove(ev, px); }
            else requestOverlay();
        });

        const finish = (ev) => {
            if (isPanning()) { endPan(); return; }
            if (xformPointerUp()) return;
            if (!stroke) return;
            strokeEnd(ev, screenToPixel(ev.clientX, ev.clientY));
        };
        vp.addEventListener('pointerup', finish);
        vp.addEventListener('pointercancel', finish);

        vp.addEventListener('pointerleave', () => {
            if (!stroke) { hoverPix = null; setStatusPos(null); requestOverlay(); }
        });

        // Senza questo, il tasto destro apre il menu del browser a meta' tratto
        // e il pointerup non arriva mai: il disegno resta "incollato" al mouse.
        vp.addEventListener('contextmenu', (ev) => ev.preventDefault());

        vp.addEventListener('wheel', (ev) => {
            ev.preventDefault();
            zoomStep(ev.deltaY < 0 ? 1 : -1, ev.clientX, ev.clientY);
        }, { passive: false });
    }

    function initToolbar() {
        $$('#pixToolbar .tool-btn').forEach((b) => {
            b.addEventListener('click', () => setTool(b.getAttribute('data-tool')));
        });

        bindRange('pixOptSize', 'pixOptSizeVal', (v) => { toolOpts.size = v; requestOverlay(); });
        bindRange('pixOptTolerance', 'pixOptToleranceVal', (v) => { toolOpts.tolerance = v; });
        bindCheck('pixOptContiguous', (v) => { toolOpts.contiguous = v; });
        bindCheck('pixOptFillShape', (v) => { toolOpts.fillShape = v; });
        const mir = $('pixOptMirror');
        if (mir) mir.addEventListener('change', () => { toolOpts.mirror = mir.value; requestOverlay(); });

        const ci = $('pixColorInput');
        if (ci) ci.addEventListener('input', () => setPrimary(ci.value));
        const sw = $('pixColorSwapBtn');
        if (sw) sw.addEventListener('click', swapColors);
        bindRange('pixAlphaInput', 'pixAlphaVal', (v) => { colorAlpha = v; refreshColorUI(); });

        $('pixColorPrimary').addEventListener('click', () => { const i = $('pixColorInput'); i.value = colorPrimary; i.click(); });
        $('pixColorSecondary').addEventListener('click', () => {
            // Il selettore di sistema e' uno solo: si dirotta temporaneamente
            // sul colore secondario invece di duplicare l'<input>, che
            // raddoppierebbe anche gli handler.
            const i = $('pixColorInput');
            const back = (e) => { setSecondary(e.target.value); i.removeEventListener('input', back); i.addEventListener('input', onPrimaryInput); };
            i.removeEventListener('input', onPrimaryInput);
            i.addEventListener('input', back);
            i.value = colorSecondary;
            i.click();
        });

        refreshToolOptions();
        refreshColorUI();
    }

    function onPrimaryInput(ev) { setPrimary(ev.target.value); }

    function setAlpha(a) {
        colorAlpha = clampInt(a, 0, 255);
        const el = $('pixAlphaInput');
        if (el) el.value = String(colorAlpha);
        refreshColorUI();
    }

    function bindRange(id, valId, cb) {
        const el = $(id);
        if (!el) return;
        const out = valId ? $(valId) : null;
        const apply = () => {
            const v = parseInt(el.value, 10);
            if (out) out.textContent = String(v);
            cb(v);
        };
        el.addEventListener('input', apply);
        apply();
    }

    function bindCheck(id, cb) {
        const el = $(id);
        if (!el) return;
        el.addEventListener('change', () => cb(el.checked));
        cb(el.checked);
    }
