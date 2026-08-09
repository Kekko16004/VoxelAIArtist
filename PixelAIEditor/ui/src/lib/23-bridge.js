    // =======================================================================
    //  23 - Ponte con VoxelAIArtist
    //
    //  Quando l'editor viene aperto dal creatore di materiali di VoxelAIArtist,
    //  la pagina NON e' un secondo programma avviato a parte: e' un <iframe>
    //  servito dal server dell'altra app, con `?bridge=voxelai` nell'indirizzo.
    //  Stessa origine, quindi `postMessage` funziona senza CORS, senza un
    //  deposito condiviso sul server e senza dover indovinare una porta. Un
    //  secondo processo Python avrebbe dovuto pubblicare la sua porta da qualche
    //  parte e le due pagine sarebbero finite su origini diverse; `window.open`
    //  invece, dentro la webview Qt, puo' non aprire nulla senza dirlo.
    //
    //  QUI SI RAGIONA A CUBI. Il padre manda una texture sola oppure le SEI
    //  facce (px, nx, py, ny, pz, nz); ognuna diventa un documento a se', e la
    //  barra in cima permette di passare dall'una all'altra e di scegliere
    //  QUALI dare all'AI come contesto - che e' il punto: le facce di uno
    //  stesso cubo devono somigliarsi, e l'unico modo di ottenerlo e' far
    //  vedere al modello quelle gia' disegnate.
    //
    //  I documenti per faccia NON sono un secondo motore di documenti: sono
    //  snapshot della cronologia (`takeSnapshot`/`applySnapshot`) con le pile di
    //  annulla/ripeti scambiate insieme a loro. Cosi' ogni faccia si porta
    //  dietro i suoi livelli, la sua selezione e i suoi annullamenti, e non
    //  esiste una seconda idea di "documento" che possa divergere dalla prima.
    //
    //  Senza padre (avvio autonomo) tutto questo file e' inerte: `bridge.on`
    //  resta falso, la barra resta nascosta e `bridgeAiContext()` ritorna la
    //  stringa vuota. Non c'e' un secondo percorso di codice da mantenere.
    // =======================================================================

    const BRIDGE_SELF_APP = 'pixelai';
    const BRIDGE_HOST_APP = 'voxelai';

    // L'ordine dei gruppi del cubo di three.js r128, lo stesso di
    // MATERIAL_FACE_KEYS nell'altra app. Le facce arrivano gia' ordinate dal
    // padre: questo elenco serve solo a scartare una sigla inventata.
    const BRIDGE_FACE_KEYS = ['px', 'nx', 'py', 'ny', 'pz', 'nz', 'all'];

    // Le etichette che finiscono NEL PROMPT sono fisse e italiane, come il
    // template del prompt: non sono testo per l'utente, le legge il modello.
    // Quelle che si vedono nella barra passano invece da `t()`. Sono due tabelle
    // perche' sono due destinatari diversi, e usarne una sola vorrebbe dire o
    // mandare all'AI un contesto in tedesco o mostrare all'utente sigle nude.
    const BRIDGE_FACE_PROMPT = {
        px: 'laterale destra (+X)',
        nx: 'laterale sinistra (-X)',
        py: 'vista dall\'alto (+Y)',
        ny: 'vista da sotto (-Y)',
        pz: 'laterale davanti (+Z)',
        nz: 'laterale dietro (-Z)',
        all: 'texture unica, usata su tutte le facce',
    };

    const bridge = {
        on: false,          // vero solo dopo che il padre ha risposto
        material: null,     // {id, name}
        faceMode: 'single',
        faces: [],          // [{key, w, h, src, state, hist, ctx, dirty}]
        activeKey: null,
        applying: false,
    };

    function bridgeIsActive() { return bridge.on; }

    /** Vero se la pagina e' stata aperta come iframe dell'altra app. Non basta
     *  il parametro: aperto a mano in una scheda, `window.parent` e' se stesso
     *  e non c'e' nessuno a cui parlare. */
    function bridgeRequested() {
        if (window.parent === window) return false;
        try {
            return /(^|[?&])bridge=/.test(String(window.location.search || ''));
        } catch (e) { return false; }
    }

    function bridgeFace(key) {
        for (let i = 0; i < bridge.faces.length; i++) {
            if (bridge.faces[i].key === key) return bridge.faces[i];
        }
        return null;
    }

    function bridgeFaceLabel(key) { return t('pix.bridge.face.' + key); }

    // --- Avvio e messaggi -----------------------------------------------------

    /**
     * Si mette in ascolto PRIMA di salutare: il padre puo' rispondere nello
     * stesso turno, e un listener installato dopo perderebbe il messaggio -
     * l'editor resterebbe aperto e vuoto senza spiegazione.
     *
     * Se nessuno risponde non succede nulla: l'editor resta quello autonomo.
     */
    function initBridge() {
        if (!bridgeRequested()) return;
        window.addEventListener('message', onBridgeMessage);
        bridgePost({ type: 'hello' });

        const ap = $('pixBridgeApplyBtn');
        if (ap) ap.addEventListener('click', bridgeApply);
        const cl = $('pixBridgeCloseBtn');
        if (cl) cl.addEventListener('click', () => bridgePost({ type: 'close' }));
    }

    function bridgePost(msg) {
        if (window.parent === window) return;
        msg.app = BRIDGE_SELF_APP;
        // targetOrigin esplicito e non '*': con '*' il messaggio verrebbe
        // consegnato anche se qualcuno ci incorporasse da un altro dominio, e
        // le facce di un materiale finirebbero a chi non le ha chieste.
        window.parent.postMessage(msg, window.location.origin);
    }

    /**
     * Un messaggio si accetta solo se viene DAVVERO dal genitore e dalla stessa
     * origine. Senza i due controlli, qualunque iframe annidato o qualunque
     * pagina che ci incorpori potrebbe farci sovrascrivere il disegno.
     */
    function onBridgeMessage(ev) {
        if (ev.origin !== window.location.origin) return;
        if (ev.source !== window.parent) return;
        const msg = ev.data;
        if (!msg || typeof msg !== 'object' || msg.app !== BRIDGE_HOST_APP) return;

        if (msg.type === 'load') bridgeLoad(msg);
        else if (msg.type === 'applied') bridgeApplied(msg);
    }

    // --- Caricamento del materiale --------------------------------------------

    /**
     * Le facce arrivano come PNG in `data:`, che e' esattamente la forma in cui
     * l'altra app gia' tiene le sue texture: nessuna conversione da inventare,
     * e nessun formato intermedio che possa perdere l'alpha per strada.
     *
     * La decodifica e' asincrona e si fa TUTTA QUI, una volta sola: cosi' il
     * cambio di faccia resta sincrono. Se decodificasse al volo, passare da una
     * faccia all'altra mostrerebbe per un istante la tela di prima, che si legge
     * come "ha caricato la faccia sbagliata".
     */
    async function bridgeLoad(msg) {
        const list = Array.isArray(msg.faces) ? msg.faces : [];
        const faces = [];
        for (let i = 0; i < list.length; i++) {
            const f = list[i] || {};
            const key = String(f.key || '');
            if (BRIDGE_FACE_KEYS.indexOf(key) < 0 || bridgeHas(faces, key)) continue;
            const src = await bridgeDecode(f.dataUrl);
            faces.push({
                key: key,
                w: clampInt(f.w || (src ? src.width : 0) || DOC_DEFAULT_W, DOC_MIN_SIDE, DOC_MAX_SIDE),
                h: clampInt(f.h || (src ? src.height : 0) || DOC_DEFAULT_H, DOC_MIN_SIDE, DOC_MAX_SIDE),
                src: src,
                state: null,
                hist: null,
                // Il contesto parte SPENTO: acceso di suo, ogni generazione
                // pagherebbe cinque facce di token anche a chi sta disegnando
                // una texture sola e non ha mai guardato la barra.
                ctx: false,
                dirty: false,
            });
        }
        if (!faces.length) return;

        bridge.on = true;
        bridge.material = msg.material || null;
        bridge.faceMode = (msg.faceMode === 'six') ? 'six' : 'single';
        bridge.faces = faces;
        bridge.activeKey = null;

        const bar = $('pixBridgeBar');
        if (bar) bar.classList.add('on');
        refreshBridgeFaces();

        const want = bridgeFace(String(msg.active || '')) ? String(msg.active) : faces[0].key;
        bridgeSwitchFace(want, true);
        // `setStatusKey` e non `setStatus`: qui siamo prima di `bootI18n` (il
        // padre risponde all'`hello` in un giro di eventi, i dizionari sono due
        // fetch), quindi `t()` ritornerebbe la chiave nuda e in barra si
        // leggerebbe `pix.bridge.msg.loaded`.
        setStatusKey('pix.bridge.msg.loaded', { n: faces.length }, 'ok');
    }

    function bridgeHas(list, key) {
        for (let i = 0; i < list.length; i++) if (list[i].key === key) return true;
        return false;
    }

    /** Una `data:` -> immagine decodificata, oppure null. Un PNG illeggibile non
     *  e' un motivo per rifiutare l'intero materiale: quella faccia parte vuota
     *  e le altre si aprono lo stesso. */
    function bridgeDecode(dataUrl) {
        return new Promise((resolve) => {
            if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) { resolve(null); return; }
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = dataUrl;
        });
    }

    // --- Cambio di faccia ------------------------------------------------------

    /**
     * Mette da parte il documento della faccia attiva INSIEME alle sue pile di
     * annulla/ripeti. Tenere una cronologia sola per tutte le facce farebbe
     * annullare, dalla faccia B, una pennellata data sulla faccia A: il
     * documento cambierebbe sotto gli occhi senza che si veda dove.
     */
    function bridgeStashActive() {
        const cur = bridgeFace(bridge.activeKey);
        if (!cur) return;
        cur.state = takeSnapshot();
        // Le pile si COPIANO: la riserva di una faccia non deve poter essere
        // toccata da chi disegna su un'altra. La causa vera era `resetHistory`,
        // che svuotava in place l'array gia' finito qui dentro (ora riassegna),
        // ma altrove nel modulo della cronologia si tronca ancora in place
        // (`pushHistory` sul redo): con la copia questa riserva resta corretta
        // comunque, senza dipendere da come e' scritto un altro file.
        cur.hist = { past: history.past.slice(), future: history.future.slice(), bytes: history.bytes };
        // "Modificata" resta vero anche se si annulla tutto: la faccia e' stata
        // aperta e potrebbe essere diversa dall'originale in modi che il conto
        // dei passi non vede (un annulla parziale, un ripeti). Riportare una
        // faccia identica al suo originale non fa danno; NON riportarne una
        // modificata sarebbe una perdita silenziosa.
        if (history.past.length || history.future.length) cur.dirty = true;
    }

    function bridgeSwitchFace(key, force) {
        if (!bridge.on) return;
        const next = bridgeFace(key);
        if (!next) return;
        if (!force && key === bridge.activeKey) return;

        bridgeStashActive();
        bridge.activeKey = key;

        if (next.state) {
            applySnapshot(next.state);
            // Copia anche al ritorno, per la ragione simmetrica: disegnare sulla
            // faccia riaperta non deve modificare la riserva da cui e' uscita.
            history.past = next.hist.past.slice();
            history.future = next.hist.future.slice();
            history.bytes = next.hist.bytes;
        } else {
            newDoc(next.w, next.h, true);
            doc.name = safeName(bridgeDocName(next));
            if (next.src) activeLayer().ctx.drawImage(next.src, 0, 0);
            // Una faccia appena aperta non eredita la selezione di quella di
            // prima: le due tele possono avere misure diverse, e una maschera
            // della stessa misura ma di un altro disegno protegge pixel a caso.
            selSetMask(null);
            resetHistory();
        }

        afterHistoryChange();
        layoutStage();
        zoomToFit();
        refreshBridgeFaces();
    }

    function bridgeDocName(face) {
        const base = (bridge.material && bridge.material.name) ? bridge.material.name : 'texture';
        return (face.key === 'all') ? base : (base + '-' + face.key);
    }

    // --- La barra --------------------------------------------------------------

    /**
     * Ricostruisce le voci delle facce. E' anche il punto che l'i18n richiama
     * dopo un cambio lingua (I18N_REDRAW): le etichette qui sono costruite dal
     * JS e `applyI18n` non le vedrebbe, restando nella lingua di prima.
     */
    function refreshBridgeFaces() {
        const box = $('pixBridgeFaces');
        if (!box) return;
        box.innerHTML = '';

        const title = $('pixBridgeTitle');
        if (title) {
            title.textContent = bridge.material && bridge.material.name
                ? t('pix.bridge.title', { name: bridge.material.name })
                : t('pix.bridge.titleNoName');
        }

        // Con una texture sola la barra non mostra la voce: sarebbe una scheda
        // unica sempre selezionata, e il pallino del contesto non avrebbe
        // nessun'altra faccia da descrivere.
        const single = bridge.faces.length <= 1;
        const hint = $('pixBridgeHint');
        if (hint) hint.classList.toggle('hidden', single);
        if (single) return;

        for (let i = 0; i < bridge.faces.length; i++) {
            const f = bridge.faces[i];
            const item = document.createElement('div');
            item.className = 'face-item'
                + (f.key === bridge.activeKey ? ' active' : '')
                + (f.dirty ? ' dirty' : '');

            const tab = document.createElement('button');
            tab.className = 'face-tab';
            tab.title = t('pix.bridge.faceTitle', { label: bridgeFaceLabel(f.key) });
            const mark = document.createElement('span');
            mark.className = 'mark';
            const lab = document.createElement('span');
            lab.textContent = bridgeFaceLabel(f.key);
            tab.appendChild(mark);
            tab.appendChild(lab);
            tab.addEventListener('click', () => bridgeSwitchFace(f.key));

            const dot = document.createElement('button');
            dot.className = 'face-dot' + (f.ctx ? ' on' : '');
            dot.title = f.ctx ? t('pix.bridge.ctxOn') : t('pix.bridge.ctxOff');
            dot.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"></circle></svg>';
            dot.addEventListener('click', () => { f.ctx = !f.ctx; refreshBridgeFaces(); });

            item.appendChild(tab);
            item.appendChild(dot);
            box.appendChild(item);
        }
    }

    // --- Contesto per l'AI ------------------------------------------------------

    /**
     * Le ALTRE facce scelte col pallino, rese in testo per il prompt.
     *
     * La faccia attiva e' esclusa sempre, anche se ha il pallino acceso: in
     * "modifica" il pannello AI manda gia' la tela corrente come contesto, e in
     * "crea" descrivere il disegno che si sta chiedendo di rifare e' token
     * spesi per confondere il modello.
     *
     * Ritorna '' fuori dal ponte, cosi' chi chiama non deve sapere che il ponte
     * esiste.
     */
    function bridgeAiContext() {
        if (!bridge.on) return '';
        const blocks = [];
        for (let i = 0; i < bridge.faces.length; i++) {
            const f = bridge.faces[i];
            if (!f.ctx || f.key === bridge.activeKey) continue;
            const cv = bridgeFaceCanvas(f);
            if (!cv) continue;
            const g = ctx2d(cv);
            const body = aiContextText(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
            if (!body) continue;
            blocks.push('FACCIA ' + f.key + ' - ' + (BRIDGE_FACE_PROMPT[f.key] || f.key) + '\n' + body);
        }
        return blocks.join('\n\n');
    }

    /**
     * Il composito di una faccia, senza passare per il cambio di faccia.
     *
     * Si applica il suo snapshot, si legge il composito e si rimette quello di
     * prima. E' un giro strano solo in apparenza: l'alternativa e' riscrivere
     * `compositeTo` in una versione che legge da uno snapshot invece che dal
     * documento, cioe' avere DUE compositori che devono restare d'accordo su
     * ordine, visibilita' e opacita' dei livelli. Qui il compositore resta uno.
     */
    function bridgeFaceCanvas(face) {
        if (!face) return null;
        if (!face.state) {
            if (!face.src) return null;
            const c = makeCanvas(face.w, face.h);
            ctx2d(c).drawImage(face.src, 0, 0);
            return c;
        }
        const keep = takeSnapshot();
        applySnapshot(face.state);
        const cv = flattenToCanvas();
        applySnapshot(keep);
        return cv;
    }

    // --- Ritorno al materiale ---------------------------------------------------

    /**
     * Rimanda al padre SOLO le facce toccate. Rimandarle tutte sembrerebbe piu'
     * semplice e non lo e': l'altra app tiene per ogni faccia una texture con la
     * sua storia di annullamenti, e riscriverle tutte butterebbe via il lavoro
     * fatto li' sulle facce che qui non si sono nemmeno aperte.
     */
    function bridgeApply() {
        if (!bridge.on || bridge.applying) return;
        bridgeStashActive();

        const out = [];
        for (let i = 0; i < bridge.faces.length; i++) {
            const f = bridge.faces[i];
            if (!f.dirty) continue;
            const cv = bridgeFaceCanvas(f);
            if (!cv) continue;
            out.push({ key: f.key, dataUrl: cv.toDataURL('image/png'), w: cv.width, h: cv.height });
        }

        if (!out.length) { setStatus(t('pix.bridge.msg.nothing'), 'warn'); return; }

        bridge.applying = true;
        bridgeSetBusy(true);
        setStatus(t('pix.bridge.msg.sending', { n: out.length }), '');
        bridgePost({ type: 'apply', faceMode: bridge.faceMode, faces: out });
    }

    /**
     * La risposta del padre. Serve perche' `postMessage` non ha esito: senza
     * conferma, un errore nell'altra app lascerebbe qui un messaggio di
     * successo e l'utente chiuderebbe l'editor credendo di aver salvato.
     */
    function bridgeApplied(msg) {
        bridge.applying = false;
        bridgeSetBusy(false);
        if (msg && msg.ok === false) {
            setStatus(t('pix.bridge.msg.failed'), 'err');
            return;
        }
        let n = 0;
        for (let i = 0; i < bridge.faces.length; i++) {
            if (bridge.faces[i].dirty) { bridge.faces[i].dirty = false; n++; }
        }
        refreshBridgeFaces();
        setStatus(t('pix.bridge.msg.applied', { n: n }), 'ok');
    }

    function bridgeSetBusy(busy) {
        const ap = $('pixBridgeApplyBtn');
        if (ap) ap.disabled = !!busy;
    }
