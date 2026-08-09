    // =======================================================================
    //  15 - Generazione AI
    //
    //  Il pannello chiede a `POST /api/texture` un disegno espresso in COMANDI
    //  COMPATTI 2D (vedi assets/prompts/prompt-pixel2d.txt), non un PNG: una
    //  tela 64x64 sono 4096 pixel e elencarli uno a uno esaurisce lo spazio
    //  della risposta a meta' disegno. Chi espande i comandi sui pixel e'
    //  `expandPixelOps` (14-pixel-ops.js); qui si decide COSA chiedere e DOVE
    //  scrivere il risultato.
    //
    //  Le due regole che governano tutto il file:
    //
    //  1. IL RISULTATO NON DISTRUGGE NIENTE. In "crea da zero" finisce in un
    //     livello nuovo; in "modifica" su una COPIA del livello attivo, con
    //     l'originale che resta sotto, nascosto. Cosi' un risultato brutto si
    //     butta cancellando un livello, senza annullare e senza aver perso il
    //     disegno di prima. E' anche cio' che promette `pix.ai.hint` nel
    //     pannello: se il codice facesse altro, il pannello mentirebbe.
    //
    //  2. IL RICAMPIONAMENTO E' NETTO. L'AI genera a una risoluzione sua
    //     (`AI_SIDES`, "Dettaglio") che quasi mai coincide con l'area di
    //     destinazione. Il passaggio fra le due avviene sempre con
    //     `imageSmoothingEnabled = false`: l'interpolazione su pixel art e'
    //     esattamente cio' che si legge come "il programma ha rovinato il
    //     disegno".
    // =======================================================================

    const AI_MODES = ['create', 'edit'];
    const AI_SCOPES = ['all', 'sel'];

    // Gli stessi limiti del server (`PIXEL_MIN_SIDE`/`PIXEL_MAX_SIDE` in
    // src/pixelprompt.py) e dell'espansore. Chiedere fuori da questa forbice non
    // e' un errore: viene riportato dentro in silenzio dall'altra parte, e la
    // tela tornerebbe di una misura diversa da quella su cui abbiamo calcolato
    // la proporzione.
    const AI_MIN_SIDE = 4;
    const AI_MAX_SIDE = 128;

    // Alfabeto per DESCRIVERE il disegno attuale all'AI (il contesto). '.' e'
    // riservato al pixel trasparente, come dice il prompt.
    const AI_RLE_ALPHABET =
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+*';
    const AI_RLE_TRANSPARENT = '.';

    // Un disegno importato da una foto ha centinaia di tinte e l'alfabeto ne
    // regge poche decine. Approssimare al colore piu' vicino e' giusto perche'
    // questo testo e' CONTESTO, non la texture: serve a far capire com'e' fatto
    // il disegno, non a ricostruirlo.
    const AI_CONTEXT_MAX_COLORS = 40;

    // Quante voci della palette dell'AI si offrono alle swatch. Il prompt chiede
    // gia' meno di 24 colori; il tetto serve solo contro una risposta fuori
    // formato che allagherebbe la tavolozza dell'utente.
    const AI_PALETTE_MAX = 24;

    // `busy` non e' ridondante con il bottone disabilitato: la scorciatoia
    // Ctrl+Invio non passa dal bottone.
    const _ai = { busy: false, abort: null };

    // --- rotta ---------------------------------------------------------------

    /**
     * La rotta e' ancorata alla RADICE, non relativa al documento: la pagina e'
     * servita da `/ui/index.html`, quindi un `api/texture` relativo diventerebbe
     * `/ui/api/texture`, che non esiste. `__API_BASE__` viene onorato se chi ci
     * ospita lo inietta (il desktop di VoxelAIArtist lo fa); qui non c'e' e la
     * stringa vuota lascia la rotta assoluta di prima.
     *
     * Il nome e' `texture2d` SEMPRE, ponte o no. Dentro VoxelAIArtist questa
     * pagina e' servita dal server del PADRE, dove `/api/texture` esiste gia' ed
     * e' la generazione delle facce di un MATERIALE: un altro prompt e un altro
     * contratto. Chiedere li' `/api/texture` non darebbe un errore - darebbe una
     * risposta plausibile e sbagliata, che e' il modo peggiore di fallire.
     * Scegliere il nome in base allo stato del ponte sarebbe peggio ancora: la
     * stretta di mano e' un messaggio asincrono, quindi una generazione lanciata
     * subito la troverebbe ancora spenta. Il server autonomo accetta entrambi i
     * nomi (vedi `do_POST` in main.py), cosi' il client non deve decidere niente.
     */
    function aiUrl() {
        return (window.__API_BASE__ ? window.__API_BASE__ : '') + '/api/texture2d';
    }

    // --- lettura dei controlli ------------------------------------------------

    /** Il valore di una select, ma solo se e' uno di quelli previsti. */
    function aiChoice(id, allowed, dflt) {
        const el = $(id);
        const v = el ? String(el.value) : '';
        return allowed.indexOf(v) >= 0 ? v : dflt;
    }

    /**
     * Ripristina una scelta salvata e la risalva a ogni cambio.
     *
     * Il valore letto viene VALIDATO contro l'elenco: una preferenza vecchia (o
     * una promessa, se `loadPref` fosse asincrona) non deve poter mettere la
     * select su un valore che non esiste, perche' da li' in poi ogni
     * generazione userebbe il ramo predefinito senza che si veda perche'.
     */
    function aiRestore(id, key, allowed, dflt) {
        const el = $(id);
        if (!el) return;
        let v = dflt;
        try {
            const saved = loadPref(key);
            if (saved !== null && saved !== undefined
                && allowed.indexOf(String(saved)) >= 0) v = String(saved);
        } catch (e) { /* preferenza illeggibile: si resta sul predefinito */ }
        el.value = v;
        el.addEventListener('change', () => {
            savePref(key, aiChoice(id, allowed, dflt));
            aiRefreshHint();
        });
    }

    /**
     * Il suggerimento parla solo della modalita' "modifica" (copia del livello,
     * originale nascosto sotto): mostrarlo in "crea da zero" descriverebbe una
     * cosa che li' non succede.
     */
    function aiRefreshHint() {
        const el = $('pixAiHint');
        if (!el) return;
        el.style.display = (aiChoice('pixAiMode', AI_MODES, 'create') === 'edit') ? '' : 'none';
    }

    // --- stato del pannello ---------------------------------------------------

    /**
     * Scrive nella riga di stato del pannello. Con `cancellable` aggiunge il
     * bottone per annullare: il bottone "Genera" resta disabilitato per tutta la
     * generazione, quindi non puo' essere lui a offrire l'uscita, e senza uscita
     * l'unico modo di fermare un'attesa di minuti sarebbe ricaricare la pagina,
     * cioe' perdere il disegno.
     *
     * `textContent` azzera i figli, quindi il bottone della generazione
     * precedente sparisce da se': non se ne accumulano.
     */
    function aiStatus(msg, kind, cancellable) {
        const el = $('pixAiStatus');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'hint' + (kind ? ' ' + kind : '');
        if (!cancellable) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = t('pix.ai.cancel');
        b.addEventListener('click', aiCancel);
        el.appendChild(document.createTextNode(' '));
        el.appendChild(b);
    }

    function aiSetBusy(on) {
        const btn = $('pixAiGoBtn');
        if (btn) btn.disabled = !!on;
    }

    function aiCancel() {
        // `abort()` fa rifiutare la fetch con AbortError, che il .catch riconosce
        // e traduce in "annullata": annullare non e' un errore.
        if (_ai.busy && _ai.abort) _ai.abort.abort();
    }

    // --- dimensioni -----------------------------------------------------------

    /**
     * La tela da chiedere all'AI, a partire dall'area di destinazione.
     *
     * Il lato lungo prende il valore di "Dettaglio", il corto segue la
     * PROPORZIONE dell'area: chiedere sempre un quadrato e poi stirarlo su un
     * banner 64x16 lo schiaccerebbe di quattro volte, ed e' uno dei modi in cui
     * un disegno "sembra sbagliato" pur essendo stato generato bene.
     *
     * Il dettaglio e' anche limitato ai pixel che l'area ha davvero: generare
     * 128x128 per poi ridurlo a 16x16 con il vicino piu' prossimo butta via
     * quindici pixel su sedici e restituisce una poltiglia, non piu' dettaglio.
     */
    function aiRequestSize(dw, dh, side) {
        const eff = Math.max(AI_MIN_SIDE, Math.min(side, Math.max(dw, dh)));
        const long = Math.max(1, Math.max(dw, dh));
        return {
            w: clampInt(eff * dw / long, AI_MIN_SIDE, AI_MAX_SIDE),
            h: clampInt(eff * dh / long, AI_MIN_SIDE, AI_MAX_SIDE),
        };
    }

    /**
     * Su che tela espandere i comandi ricevuti.
     *
     * Il server restituisce UNA misura sola (`size`), anche quando la richiesta
     * era rettangolare: una tela non quadrata non torna indietro tale e quale.
     * Quindi si tiene la PROPORZIONE richiesta e la si scala sulla misura
     * dichiarata dall'AI. Se l'AI ha rispettato la richiesta il fattore e' 1 e
     * non succede niente; se ha lavorato piu' in grande, le coordinate dei suoi
     * comandi restano dentro la tela invece di essere tagliate a destra.
     */
    function aiExpandSize(data, req) {
        const raw = data && (data.w || data.width || data.size);
        const n = Number(raw);
        if (!raw || !isFinite(n)) return { w: req.w, h: req.h };
        const declared = clampInt(n, AI_MIN_SIDE, AI_MAX_SIDE);
        const reqLong = Math.max(req.w, req.h);
        if (declared === reqLong) return { w: req.w, h: req.h };
        const k = declared / reqLong;
        return {
            w: clampInt(req.w * k, AI_MIN_SIDE, AI_MAX_SIDE),
            h: clampInt(req.h * k, AI_MIN_SIDE, AI_MAX_SIDE),
        };
    }

    // --- contesto (i pixel attuali, descritti a parole) -----------------------

    /**
     * I pixel di una regione in RLE per righe: `12a4b` sono 12 pixel del colore
     * `a` seguiti da 4 di `b`. E' il formato che il prompt dichiara di leggere.
     * Su una riga uniforme costa 3 caratteri invece di 32; su una riga
     * irregolare degrada esattamente nella griglia di caratteri, che e' la
     * rappresentazione che un modello legge meglio.
     */
    function aiRleRows(px, w, h) {
        const byHex = {};
        const palette = {};
        let used = 0;

        const nearest = (r, g, b) => {
            let best = null, bestD = Infinity;
            Object.keys(byHex).forEach(hex => {
                const c = hexToRgb(hex);
                if (!c) return;
                const d = (c.r - r) * (c.r - r) + (c.g - g) * (c.g - g) + (c.b - b) * (c.b - b);
                if (d < bestD) { bestD = d; best = byHex[hex]; }
            });
            return best;
        };

        const keyFor = (r, g, b, a) => {
            // Sotto 8 di alpha il pixel e' trasparente a tutti gli effetti: dargli
            // una lettera sprecherebbe una voce dell'alfabeto per un colore che
            // non si vede.
            if (a < 8) return AI_RLE_TRANSPARENT;
            const hex = rgbToHex(r, g, b);
            if (byHex[hex]) return byHex[hex];
            if (used >= Math.min(AI_CONTEXT_MAX_COLORS, AI_RLE_ALPHABET.length)) {
                return nearest(r, g, b) || AI_RLE_TRANSPARENT;
            }
            const ch = AI_RLE_ALPHABET.charAt(used++);
            byHex[hex] = ch;
            palette[ch] = hex;
            return ch;
        };

        const rows = [];
        for (let y = 0; y < h; y++) {
            let out = '', runCh = null, runN = 0;
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const ch = keyFor(px[i], px[i + 1], px[i + 2], px[i + 3]);
                if (ch === runCh) { runN++; continue; }
                if (runCh !== null) out += (runN > 1 ? String(runN) : '') + runCh;
                runCh = ch; runN = 1;
            }
            if (runCh !== null) out += (runN > 1 ? String(runN) : '') + runCh;
            rows.push(out);
        }
        return { palette: palette, rows: rows };
    }

    /**
     * Il testo del contesto per il prompt. Non e' testo per l'utente: lo legge
     * l'AI, e la lingua e' quella del template del prompt.
     *
     * Ritorna la stringa vuota se non c'e' NIENTE di disegnato: una tela di sole
     * righe di punti non dice nulla al modello e si paga a token. Con contesto
     * vuoto il server mette da se' la frase "nessun disegno", quindi "modifica"
     * su una tela vuota si comporta come "crea da zero" invece di fallire.
     */
    function aiContextText(px, w, h) {
        let any = false;
        for (let i = 3; i < px.length; i += 4) { if (px[i] >= 8) { any = true; break; } }
        if (!any) return '';
        const grid = aiRleRows(px, w, h);
        const pal = Object.keys(grid.palette)
            .map(k => k + '=' + grid.palette[k]).join(' ');
        const lines = [];
        lines.push('TELA ' + w + 'x' + h + ':');
        lines.push('colori: ' + pal + '  ' + AI_RLE_TRANSPARENT + '=trasparente');
        for (let i = 0; i < grid.rows.length; i++) lines.push(grid.rows[i]);
        return lines.join('\n');
    }

    /**
     * Il contesto di un'area, gia' alla risoluzione a cui l'AI dovra' disegnare.
     *
     * Si parte dal COMPOSITO e non dal livello attivo: "modifica il disegno"
     * vuol dire il disegno che si VEDE, e mandare il solo livello attivo
     * descriverebbe qualcosa che l'utente non ha davanti agli occhi.
     *
     * La riduzione a `req` non e' un dettaglio: descrivere l'area a 64x64 e poi
     * chiedere un disegno 32x32 costringerebbe il modello a convertire ogni
     * coordinata, che e' il modo piu' facile per ottenere un risultato sfasato.
     */
    function aiContextFor(area, req) {
        const dw = area.x1 - area.x0 + 1, dh = area.y1 - area.y0 + 1;
        const flat = flattenToCanvas();
        const c = makeCanvas(req.w, req.h);
        const g = ctx2d(c);
        g.imageSmoothingEnabled = false;
        g.drawImage(flat, area.x0, area.y0, dw, dh, 0, 0, req.w, req.h);
        return aiContextText(g.getImageData(0, 0, req.w, req.h).data, req.w, req.h);
    }

    // --- avvisi ---------------------------------------------------------------

    /**
     * Gli avvisi dell'espansore sono CODICI, non frasi ('badCoords fill 1 2'):
     * quel modulo non ha DOM e non sa che lingua parla l'utente. La traduzione
     * e' compito di chi ha il DOM, cioe' di qui.
     *
     * Si tiene solo la prima parola (il codice) e si deduplica: venti comandi
     * con le coordinate sbagliate sono un problema solo, e venti righe uguali
     * nascondono gli altri avvisi invece di aggiungere informazione. Un codice
     * senza traduzione si mostra nudo: meglio una parola oscura che il nome di
     * una chiave.
     */
    function aiWarnText(list) {
        const seen = {}, out = [];
        (list || []).forEach(w => {
            const code = String(w || '').split(' ')[0];
            if (!code || seen[code]) return;
            seen[code] = 1;
            const key = 'pix.ai.warn.' + code;
            const s = t(key);
            out.push(s === key ? code : s);
        });
        return out.join(', ');
    }

    // --- errori ---------------------------------------------------------------

    /** Errore con un messaggio gia' pronto per l'utente (vedi il .catch). */
    function aiFail(msg) {
        const e = new Error(msg);
        e.uiMessage = msg;
        return e;
    }

    /**
     * Il messaggio di un errore HTTP.
     *
     * 401 e' l'unico caso in cui si IGNORA il testo del server: il rimedio non
     * e' capire cosa e' successo ma riaprire le Impostazioni, e ce lo dice il
     * codice, non la frase. 503 (e chiunque marchi `retryable`) deve dire che si
     * puo' riprovare, o l'utente ricomincia da capo credendo di aver sbagliato
     * la richiesta. Su 400 la ragione del server e' l'unica informazione utile
     * che esista - "il modello non ha restituito JSON", "nessun comando
     * utilizzabile" - e sostituirla con un generico la butterebbe via.
     *
     * Il corpo dell'errore non finisce MAI in console cosi' com'e': lo `status`
     * e' un numero e basta a orientarsi.
     */
    function aiErrorMessage(status, body) {
        const raw = (body && typeof body.error === 'string') ? body.error.trim() : '';
        const reason = raw || t('pix.ai.err.status', { status: status });
        if (status === 401 || (body && body.needsCookies === true)) return t('pix.ai.err.auth');
        if (status === 503 || (body && body.retryable === true)) {
            return t('pix.ai.err.retry', { error: reason });
        }
        return t('pix.ai.err.prefix', { error: reason });
    }

    // --- palette --------------------------------------------------------------

    /** '#RGB', 'RRGGBB', '#RRGGBBAA' -> '#RRGGBB'; null se non e' un colore. */
    function aiHex(v) {
        let s = String(v === null || v === undefined ? '' : v).trim();
        if (!s || s === '-' || s === AI_RLE_TRANSPARENT) return null;
        if (s.charAt(0) !== '#') s = '#' + s;
        if (s.length === 9) s = s.slice(0, 7);      // l'alpha vive nelle ops, non qui
        const c = hexToRgb(s);
        return c ? rgbToHex(c.r, c.g, c.b) : null;
    }

    /**
     * I colori dell'AI diventano swatch. Si AGGIUNGONO, non sostituiscono: la
     * tavolozza e' dell'utente, e rifarla a ogni generazione gli toglierebbe i
     * colori con cui stava lavorando. Continuare a disegnare in coerenza con
     * cio' che l'AI ha appena prodotto e' il gesto naturale subito dopo.
     */
    function aiOfferPalette(data) {
        const pal = data && data.palette;
        if (!pal || typeof pal !== 'object') return;
        const seen = {};
        let n = 0;
        Object.keys(pal).forEach(k => {
            if (n >= AI_PALETTE_MAX) return;
            const hex = aiHex(pal[k]);
            if (!hex || seen[hex]) return;
            seen[hex] = 1;
            n++;
            addSwatch(hex);
        });
    }

    // --- scrittura del risultato ----------------------------------------------

    /**
     * Il buffer RGBA espanso -> i pixel dell'area di destinazione.
     *
     * Passa da un canvas alla risoluzione dell'AI e da uno alla risoluzione
     * dell'area, con `imageSmoothingEnabled = false` su entrambi: e' il punto in
     * cui il disegno cambia scala, ed e' l'unico che decide se i bordi restano
     * netti o diventano una sfocatura.
     */
    function aiResample(buf, aw, ah, dw, dh) {
        const src = makeCanvas(aw, ah);
        const sg = ctx2d(src);
        const img = sg.createImageData(aw, ah);
        img.data.set(buf);
        // `putImageData` SOSTITUISCE i pixel invece di fonderli: un disegno con
        // parti trasparenti deve lasciare il buco, non far trasparire altro.
        sg.putImageData(img, 0, 0);
        if (aw === dw && ah === dh) return img;
        const dst = makeCanvas(dw, dh);
        const dg = ctx2d(dst);
        dg.imageSmoothingEnabled = false;
        dg.drawImage(src, 0, 0, aw, ah, 0, 0, dw, dh);
        return dg.getImageData(0, 0, dw, dh);
    }

    /**
     * Mette il risultato nel documento. E' l'UNICO punto che lo modifica, ed e'
     * per questo che `pushHistory()` sta qui e una volta sola: chiamata prima di
     * ogni ramo, e mai su una generazione che non ha dipinto niente (quella non
     * arriva fin qui), quindi un annullamento riporta esattamente allo stato
     * precedente la generazione, non a meta' strada.
     */
    function aiApply(out, key, mode, area, maskOnly) {
        const dw = area.x1 - area.x0 + 1, dh = area.y1 - area.y0 + 1;
        const px = aiResample(out.faces[key], out.w, out.h, dw, dh);

        pushHistory();

        let layer;
        if (mode === 'edit') {
            const original = activeLayer();
            layer = duplicateLayer();
            // L'originale resta nel documento ma NASCOSTO: e' cio' che promette
            // il suggerimento del pannello, e rende un risultato brutto una
            // cancellazione di livello invece di un annullamento.
            if (layer && original) original.visible = false;
            // La copia eredita la visibilita' dell'originale: generando su un
            // livello gia' nascosto, il risultato non si vedrebbe e sembrerebbe
            // che non sia successo niente.
            if (layer) layer.visible = true;
        }
        if (!layer) layer = addLayer(true);

        // Si parte dai pixel ATTUALI e si sovrascrivono solo quelli dentro la
        // maschera, poi si riscrive tutto in un colpo. Due conseguenze, entrambe
        // volute: dove l'AI ha lasciato trasparente il pixel diventa trasparente
        // davvero (senza, "togli lo sfondo" non funzionerebbe, perche' il vecchio
        // resterebbe sotto), e una selezione a lazo non si riempie come un
        // rettangolo, che e' il difetto che rende inutile lo strumento.
        const g = layer.ctx;
        const cur = g.getImageData(area.x0, area.y0, dw, dh);
        const cd = cur.data, nd = px.data;
        for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
                if (maskOnly && !selHas(area.x0 + x, area.y0 + y)) continue;
                const i = (y * dw + x) * 4;
                cd[i] = nd[i];
                cd[i + 1] = nd[i + 1];
                cd[i + 2] = nd[i + 2];
                cd[i + 3] = nd[i + 3];
            }
        }
        g.putImageData(cur, area.x0, area.y0);

        renderNow();
        refreshLayerList();
        markDirty();
        return layer;
    }

    // --- generazione ----------------------------------------------------------

    function aiGenerate() {
        if (_ai.busy) return;

        const promptEl = $('pixAiPrompt');
        const desc = promptEl ? String(promptEl.value || '').trim() : '';
        if (!desc) {
            aiStatus(t('pix.ai.err.noPrompt'), 'warn');
            if (promptEl) promptEl.focus();
            return;
        }

        const mode = aiChoice('pixAiMode', AI_MODES, 'create');
        const side = clampInt(aiChoice('pixAiDetail', AI_SIDES.map(String),
            String(AI_DEFAULT_SIDE)), AI_MIN_SIDE, AI_MAX_SIDE);

        // "Solo la selezione" senza selezione non e' un errore da fermare: e'
        // tutta la tela. Lo si dice, pero', o il risultato sembra ignorare
        // l'ambito scelto.
        let scope = aiChoice('pixAiScope', AI_SCOPES, 'all');
        if (scope === 'sel' && !selActive()) {
            scope = 'all';
            setStatus(t('pix.ai.warn.noSelection'), 'warn');
        }
        const area = (scope === 'sel')
            ? selBounds()
            : { x0: 0, y0: 0, x1: doc.w - 1, y1: doc.h - 1 };
        const req = aiRequestSize(area.x1 - area.x0 + 1, area.y1 - area.y0 + 1, side);

        const body = {
            prompt: desc,
            // La tela e' una sola: il server la chiama 'all' e riconduce li'
            // qualunque nome usi l'AI.
            faces: ['all'],
            width: req.w,
            height: req.h,
            // `size` accanto a `width`: e' il nome che legge la rotta gemella di
            // VoxelAIArtist, dove la tela e' quadrata. Qui `width` ha comunque la
            // precedenza, quindi mandarli entrambi non cambia questa richiesta e
            // fa funzionare la stessa UI ospitata dall'altra app.
            size: req.w,
        };
        // In "crea da zero" il contesto NON si manda: sarebbe descrivere all'AI
        // il disegno che le si sta chiedendo di rifare da capo, a pagamento.
        const parts = [];
        if (mode === 'edit') {
            const ctx = aiContextFor(area, req);
            if (ctx) parts.push(ctx);
        }
        // Le ALTRE facce del cubo, se l'editor gira dentro VoxelAIArtist e ne
        // sono state scelte col pallino. Questo si manda in ENTRAMBI i modi: in
        // "crea da zero" e' proprio la richiesta piu' comune ("fammi il lato
        // sinistro in tinta con quello destro"), e togliere il contesto li'
        // renderebbe il ponte inutile, perche' e' l'unica cosa che fa somigliare
        // fra loro le sei facce.
        if (typeof bridgeAiContext === 'function') {
            const bctx = bridgeAiContext();
            if (bctx) parts.push(bctx);
        }
        if (parts.length) body.context = parts.join('\n\n');

        _ai.busy = true;
        _ai.abort = new AbortController();
        aiSetBusy(true);
        aiStatus(t('pix.ai.status.working'), '', true);

        fetch(aiUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: _ai.abort.signal,
        })
            .then(res => res.json().catch(() => ({})).then(b => {
                if (res.ok) return b;
                const ex = aiFail(aiErrorMessage(res.status, b));
                ex.needsCookies = (res.status === 401) || (b && b.needsCookies === true);
                throw ex;
            }))
            .then(data => {
                const exp = aiExpandSize(data, req);
                // Si impone la tela calcolata qui e non si lascia dedurre: la
                // risposta porta una misura sola e da quella l'espansore
                // ricaverebbe un quadrato, perdendo la proporzione richiesta.
                const shaped = Object.assign({}, data, { w: exp.w, h: exp.h });
                const out = expandPixelOps(shaped, { size: exp.w });

                const keys = Object.keys(out.faces || {});
                const key = (keys.indexOf('all') >= 0) ? 'all' : keys[0];
                const warn = aiWarnText(out.warnings);

                // Un risultato vuoto NON deve arrivare al documento: scriverci
                // sopra una tela vuota cancellerebbe cio' che c'era, e si legge
                // come "l'AI ha rotto il disegno" invece che come "non ha
                // disegnato niente".
                if (!key || !out.faces[key] || !(out.painted && out.painted[key] > 0)) {
                    throw aiFail([t('pix.ai.err.empty')]
                        .concat(warn ? [t('pix.ai.status.warn', { list: warn })] : [])
                        .join(' - '));
                }

                const layer = aiApply(out, key, mode, area, scope === 'sel');
                aiOfferPalette(data);

                const name = layer ? layer.name : '';
                const msg = [mode === 'edit'
                    ? t('pix.ai.status.doneEdit', { name: name })
                    : t('pix.ai.status.doneCreate', { name: name })]
                    .concat(warn ? [t('pix.ai.status.warn', { list: warn })] : [])
                    .join(' - ');
                aiStatus(msg, 'ok');
                setStatus(msg, 'ok');
            })
            .catch(err => {
                // Annullare e' una scelta dell'utente, non un guasto: dirlo con
                // un errore rosso farebbe cercare un problema che non c'e'.
                if (err && err.name === 'AbortError') {
                    aiStatus(t('pix.ai.status.cancelled'), 'warn');
                    return;
                }
                // `uiMessage` c'e' solo sugli errori che abbiamo composto noi. Se
                // manca, e' la fetch ad aver fallito (server spento, rete): il
                // suo messaggio e' del browser, non tradotto e non utile.
                const msg = (err && err.uiMessage) || t('pix.ai.err.network');
                aiStatus(msg, 'err');
                setStatus(msg, 'err');
                // La sessione scaduta si rimedia nelle Impostazioni, e l'utente
                // non ha modo di indovinarlo da un messaggio.
                if (err && err.needsCookies) openSettings(true);
            })
            // `finally` e non un `then` in coda: se il ramo qui sopra sollevasse
            // a sua volta, un `then` non verrebbe eseguito e il pannello
            // resterebbe occupato per sempre, senza piu' modo di generare.
            .finally(() => {
                _ai.busy = false;
                _ai.abort = null;
                aiSetBusy(false);
            });
    }

    // --- avvio ----------------------------------------------------------------

    function initAiPanel() {
        const detail = $('pixAiDetail');
        if (detail && !detail.options.length) {
            // L'etichetta e' il NUMERO e basta: e' la stessa in tutte le lingue,
            // quindi non ha bisogno di traduzione e non resta indietro quando la
            // lingua cambia (una option costruita a runtime non e' annotata e
            // `applyI18n` non la rivede). Che sia una risoluzione lo dicono
            // l'etichetta e il title della select, che sono annotati nel
            // template. "32x32" sarebbe anche sbagliato: su un'area non quadrata
            // la tela chiesta all'AI non e' un quadrato.
            AI_SIDES.forEach(n => {
                const o = document.createElement('option');
                o.value = String(n);
                o.textContent = String(n);
                detail.appendChild(o);
            });
        }

        // Le opzioni prima del ripristino: assegnare `value` a una select vuota
        // non attacca, e la scelta salvata verrebbe persa in silenzio.
        aiRestore('pixAiMode', 'aiMode', AI_MODES, 'create');
        aiRestore('pixAiScope', 'aiScope', AI_SCOPES, 'all');
        aiRestore('pixAiDetail', 'aiDetail', AI_SIDES.map(String), String(AI_DEFAULT_SIDE));
        aiRefreshHint();

        const btn = $('pixAiGoBtn');
        if (btn) btn.addEventListener('click', aiGenerate);

        const promptEl = $('pixAiPrompt');
        if (promptEl) {
            // Ctrl+Invio genera. Invio da solo no: e' una textarea, e l'a capo
            // serve a descrivere un disegno in piu' righe.
            promptEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    aiGenerate();
                }
            });
        }
    }
