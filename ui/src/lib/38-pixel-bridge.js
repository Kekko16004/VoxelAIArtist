            // ===== PONTE CON PixelAIEditor =====
            // Frammento dello scope condiviso (vedi ui/build.mjs): nessun import/export.
            //
            // PixelAIEditor e' un editor di pixel art 2D completo che vive in
            // `PixelAIEditor/`. Da qui NON si avvia come secondo programma: la sua
            // pagina e' servita da QUESTO server (`translate_path` ribasa ogni
            // richiesta su BASE_DIR, quindi `GET /PixelAIEditor/ui/index.html`
            // funziona senza aggiungere rotte) e si mostra in un <iframe> a tutto
            // schermo. Le due cose che ne discendono sono il motivo della scelta:
            //  - STESSA ORIGINE: `postMessage` funziona senza CORS, senza un deposito
            //    condiviso sul server e senza dover indovinare la porta di un secondo
            //    processo Python.
            //  - Niente `window.open`: dentro la webview Qt puo' non aprire nulla e
            //    non dirlo, e un blocco popup del browser darebbe lo stesso sintomo
            //    ("premo il bottone e non succede niente").
            //
            // La finestra grande della tela (#materialEditorOverlay) resta dov'era e
            // NON viene sostituita: quella e' la via rapida per ritoccare due pixel,
            // questo e' l'editor completo. Sono due funzioni diverse, e questo overlay
            // sta a z-index 97 cioe' sopra quella (96), cosi' si puo' aprire anche da
            // dentro la finestra grande senza chiuderla prima.
            //
            // TORNA INDIETRO SOLO CIO' CHE E' STATO MODIFICATO. L'editor manda le sole
            // facce toccate: riscriverle tutte butterebbe via la storia di annullamenti
            // che le facce non aperte hanno QUI, e lo farebbe in silenzio.

            const PIX_BRIDGE_SELF_APP = 'voxelai';
            const PIX_BRIDGE_PEER_APP = 'pixelai';

            // `payload` si costruisce all'apertura e si conserva: il saluto del figlio
            // ('hello') arriva quando la sua pagina ha finito di caricare, cioe' dopo,
            // e ricostruirlo in quel momento vorrebbe dire rileggere la tela mentre
            // l'overlay la copre gia'. `bound` esiste perche' addEventListener AGGIUNGE
            // e non sostituisce: agganciare il listener a ogni apertura lo accumulerebbe
            // e alla terza apertura una sola 'apply' verrebbe applicata tre volte.
            let _pixBridge = { open: false, bound: false, payload: null, busy: false };

            /**
             * Indirizzo della pagina dell'editor, ricavato da quello della pagina
             * corrente invece che scritto fisso.
             *
             * NON basta un percorso relativo nudo: questa pagina e' servita sia come
             * `/index.html` sia come `/ui/index.html` (do_GET accetta entrambe, e la
             * modalita' web apre proprio la seconda). Da `/ui/index.html` un relativo
             * `PixelAIEditor/...` si risolve in `/ui/PixelAIEditor/...`, che non esiste
             * e da' 404 -- un iframe bianco senza spiegazione. Quindi si sale di un
             * livello quando la cartella e' `ui/`, restando comunque relativi
             * all'origine (funziona anche se un giorno l'app fosse servita sotto un
             * sottopercorso).
             */
            function pixelEditorUrl() {
                let dir = '/';
                try {
                    dir = String(location.pathname || '/').replace(/[^/]*$/, '');
                } catch (e) { dir = '/'; }
                if (!dir) dir = '/';
                dir = dir.replace(/(^|\/)ui\/$/, '$1');
                if (!dir) dir = '/';
                // `?bridge=voxelai` e' cio' che accende il ponte dal lato figlio: senza,
                // la stessa pagina resta l'editor autonomo e non saluta nessuno.
                return dir + 'PixelAIEditor/ui/index.html?bridge=voxelai';
            }

            function pixelEditorFrame() {
                return document.getElementById('pixelEditorFrame');
            }

            function pixelEditorIsOpen() {
                const ov = document.getElementById('pixelEditorOverlay');
                return !!ov && ov.style.display !== 'none';
            }

            /** Un lato del cubo, nella forma che si manda e si riceve. Il lato corto
             *  e' limitato a MATERIAL_TEXTURE_MAX perche' la storia della tela e' fatta
             *  di ImageData interi: una faccia da 512 riempirebbe 40 snapshot da 1 MB
             *  l'uno solo per poterla annullare. */
            function pixBridgeSide(n, dflt) {
                const v = Math.round(Number(n));
                if (!isFinite(v) || v < 1) return dflt;
                return Math.min(MATERIAL_TEXTURE_MAX, Math.max(4, v));
            }

            /**
             * Misura di una faccia, con la STESSA precedenza di materialPngFaceData
             * (tela per la faccia attiva, poi snapshot, poi texture del buffer, poi
             * texture rappresentativa). Due precedenze diverse manderebbero il disegno
             * di una faccia con le dimensioni di un'altra, e il ritaglio si vedrebbe
             * solo a lavoro finito.
             */
            function pixBridgeFaceSize(fk) {
                const isActive = (_formState.faceMode !== 'six') || (fk === _formState.activeFace);
                if (isActive && _art.canvas) {
                    return { w: _art.canvas.width, h: _art.canvas.height };
                }
                const buf = (!isActive && _art.faceBuffers) ? _art.faceBuffers[fk] : null;
                if (buf && buf.snap && buf.snap.data) return { w: buf.snap.w, h: buf.snap.h };
                if (buf && buf.tex && buf.tex.data) return { w: buf.tex.w, h: buf.tex.h };
                const pend = _formState.pendingTexture;
                if (pend && pend.data) return { w: pend.w, h: pend.h };
                const side = artSelectedSize();
                return { w: side, h: side };
            }

            /**
             * Il messaggio 'load'. Con una texture unica si manda UNA voce con chiave
             * 'all'; con sei facce si mandano tutte e sei nell'ordine dei gruppi del
             * cubo di three.js (px, nx, py, ny, pz, nz), che e' lo stesso di
             * MATERIAL_FACE_KEYS.
             *
             * Una faccia senza disegno proprio viaggia comunque, con la texture
             * rappresentativa (la ricaduta di textureForFace): all'utente il cubo
             * appare gia' cosi', e mandarla vuota gli farebbe credere di aver perso il
             * disegno. Se non c'e' proprio nulla il dataUrl e' vuoto e di la' quella
             * faccia parte da una tela bianca.
             */
            function buildBridgePayload() {
                if (!materialFormIsOpen()) return null;
                const six = (_formState.faceMode === 'six');
                const keys = six ? MATERIAL_FACE_KEYS.slice() : ['px'];
                const faces = [];
                keys.forEach(fk => {
                    const size = pixBridgeFaceSize(fk);
                    faces.push({
                        key: six ? fk : 'all',
                        dataUrl: materialPngFaceData(fk) || '',
                        w: pixBridgeSide(size.w, 16),
                        h: pixBridgeSide(size.h, 16)
                    });
                });
                const nameEl = document.getElementById('materialName');
                return {
                    type: 'load',
                    material: {
                        id: _formState.editingId || null,
                        name: nameEl ? nameEl.value.trim() : ''
                    },
                    faceMode: six ? 'six' : 'single',
                    active: six ? _formState.activeFace : 'all',
                    faces: faces
                };
            }

            /** targetOrigin esplicito e mai '*': con '*' il messaggio verrebbe
             *  consegnato anche a una pagina di un altro dominio che ci avesse
             *  incorporati, e le texture di un materiale finirebbero a chi non le ha
             *  chieste. */
            function postToPixelEditor(msg) {
                const frame = pixelEditorFrame();
                if (!frame || !frame.contentWindow || !msg) return;
                msg.app = PIX_BRIDGE_SELF_APP;
                try {
                    frame.contentWindow.postMessage(msg, location.origin);
                } catch (e) { /* iframe gia' scaricato: non c'e' niente da fare */ }
            }

            /**
             * Tre controlli, e servono tutti e tre:
             *  - `ev.origin`: un iframe di terzi non deve poter iniettare texture.
             *  - `ev.source`: la stessa origine ospita anche ALTRI iframe possibili
             *    (plugin, anteprime); solo quello dell'editor e' autorizzato.
             *  - `msg.app`: sulla stessa finestra viaggiano anche i messaggi di altre
             *    librerie, e trattarli come nostri farebbe cadere il resto.
             */
            function onPixelBridgeMessage(ev) {
                if (!_pixBridge.open) return;
                const frame = pixelEditorFrame();
                if (!frame) return;
                if (ev.origin !== location.origin) return;
                if (ev.source !== frame.contentWindow) return;
                const msg = ev.data;
                if (!msg || typeof msg !== 'object' || msg.app !== PIX_BRIDGE_PEER_APP) return;

                if (msg.type === 'hello') {
                    // Il figlio saluta appena e' pronto: e' l'unico momento in cui si
                    // sa che il suo listener esiste. Mandare 'load' prima (es. al
                    // caricamento dell'iframe) lo perderebbe in silenzio.
                    if (_pixBridge.payload) postToPixelEditor(_pixBridge.payload);
                    return;
                }
                if (msg.type === 'apply') {
                    if (_pixBridge.busy) return;
                    _pixBridge.busy = true;
                    applyBridgeFaces(msg).then(() => {
                        _pixBridge.busy = false;
                        postToPixelEditor({ type: 'applied', ok: true });
                    }).catch(err => {
                        _pixBridge.busy = false;
                        // Il testo non e' per l'utente di QUESTA pagina: e' il figlio a
                        // mostrarlo, con le sue stringhe. Qui va il codice, non la frase.
                        postToPixelEditor({
                            type: 'applied', ok: false,
                            error: (err && err.message) ? String(err.message) : 'apply'
                        });
                    });
                    return;
                }
                if (msg.type === 'close') closePixelEditor();
            }

            /** Un data-URL PNG -> Image decodificata. Rifiuta invece di ritornare null:
             *  qui una faccia illeggibile non e' un dettaglio da ignorare, e' il
             *  disegno che l'utente crede di aver salvato. */
            function pixBridgeDecode(dataUrl) {
                return new Promise((resolve, reject) => {
                    if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) {
                        reject(new Error('badDataUrl'));
                        return;
                    }
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = () => reject(new Error('decode'));
                    img.src = dataUrl;
                });
            }

            /**
             * Scrive nel buffer di una faccia NON attiva. La forma {data,w,h,color,alpha}
             * la produce sempre textureFromCanvasCtx: colore medio e flag di trasparenza
             * non si deducono dalla stringa del data-URL, e calcolarli a mano qui vorrebbe
             * dire avere due definizioni di "colore medio" che divergono.
             *
             * `snap` va azzerato insieme alla tex, o al prossimo cambio di faccia
             * verrebbe ripristinato il disegno vecchio: lo snapshot ha la precedenza
             * sulla texture (stessa regola di materialAiApplyFace).
             */
            function pixBridgeWriteBuffer(fk, img, w, h) {
                const cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                const g = cv.getContext('2d');
                if (!g) throw new Error('canvas');
                g.imageSmoothingEnabled = false;
                g.clearRect(0, 0, w, h);
                g.drawImage(img, 0, 0, w, h);
                const tex = textureFromCanvasCtx(cv, g);
                ensureFaceBuffers();
                const b = _art.faceBuffers[fk] || { undo: [], redo: [], tex: null, snap: null };
                b.tex = { data: tex.data, w: tex.w, h: tex.h, color: tex.color, alpha: !!tex.alpha };
                b.snap = null;
                b.undo = [];
                b.redo = [];
                _art.faceBuffers[fk] = b;
            }

            /**
             * Riversa le facce tornate dall'editor. Asincrona perche' decodificare un
             * data-URL lo e': l'immagine e' pronta solo dopo `onload`, e disegnarla
             * prima darebbe una tela vuota senza errore.
             *
             * Ordine deliberato:
             *  1. la sorgente sale da 'flat' a 'draw' se serve -- in tinta unita la
             *     texture verrebbe ignorata da formDefinition e il ritorno si
             *     perderebbe senza un messaggio;
             *  2. con piu' di una faccia si passa a faceMode 'six' PRIMA di scrivere:
             *     setFaceMode semina le facce non ancora disegnate con la texture
             *     corrente, e farlo dopo sovrascriverebbe cio' che si e' appena messo;
             *  3. la faccia ATTIVA si applica per ULTIMA, perche' e' l'unica che passa
             *     dalla tela visibile e chiude con commitArtToTexture (che aggiorna
             *     pendingTexture, il buffer e l'anteprima).
             */
            function applyBridgeFaces(msg) {
                return Promise.resolve().then(() => {
                    if (!materialFormIsOpen()) throw new Error('noForm');
                    const list = Array.isArray(msg && msg.faces) ? msg.faces : [];
                    if (!list.length) throw new Error('noFaces');

                    if (_formState.source === 'flat') setFormSource('draw');
                    if (list.length > 1 && _formState.faceMode !== 'six') setFaceMode('six');

                    const six = (_formState.faceMode === 'six');
                    const items = [];
                    list.forEach(f => {
                        if (!f || typeof f !== 'object') return;
                        const raw = String(f.key || '');
                        // 'all' vale la faccia attiva: e' la chiave della texture unica,
                        // e in six mode l'editor la usa solo se il padre l'ha mandata
                        // cosi'. Una sigla inventata si scarta invece di indovinare.
                        let fk = raw;
                        if (raw === 'all') fk = six ? _formState.activeFace : MATERIAL_FACE_KEYS[0];
                        if (MATERIAL_FACE_KEYS.indexOf(fk) < 0) return;
                        if (items.some(it => it.fk === fk)) return;
                        items.push({ fk: fk, f: f });
                    });
                    if (!items.length) throw new Error('noFaces');

                    // Attiva per ultima (vedi sopra). In single mode l'unica voce E' la
                    // faccia attiva, quindi l'ordinamento e' un no-op.
                    const activeFk = six ? _formState.activeFace : MATERIAL_FACE_KEYS[0];
                    items.sort((a, b) => (a.fk === activeFk ? 1 : 0) - (b.fk === activeFk ? 1 : 0));

                    // Le decodifiche partono tutte insieme: sono indipendenti, e farle
                    // in fila su sei facce raddoppierebbe l'attesa senza guadagno.
                    return Promise.all(items.map(it => pixBridgeDecode(it.f.dataUrl)))
                        .then(imgs => ({ items, imgs, activeFk }));
                }).then(({ items, imgs, activeFk }) => {
                    // Invalida i loadArtFromTexture ancora in volo: senza, un load
                    // ritardato ridipingerebbe la tela sopra cio' che stiamo scrivendo.
                    _artLoadGen++;
                    let applied = 0;
                    items.forEach((it, i) => {
                        const img = imgs[i];
                        if (!img) return;
                        const w = pixBridgeSide(it.f.w || img.width, img.width || 16);
                        const h = pixBridgeSide(it.f.h || img.height, img.height || 16);
                        if (it.fk === activeFk) {
                            // pushArtUndo PRIMA di ensureArtCtx: assegnare width/height
                            // AZZERA il canvas, quindi uno snapshot preso dopo sarebbe
                            // una tela vuota e l'annulla non riporterebbe niente.
                            // Stesso ordine dell'import PNG e della generazione AI.
                            pushArtUndo();
                            const ctx = ensureArtCtx(w, h);
                            if (!ctx) return;
                            ctx.imageSmoothingEnabled = false;
                            ctx.clearRect(0, 0, w, h);
                            ctx.drawImage(img, 0, 0, w, h);
                            syncSizeSelectTo(Math.max(w, h));
                            layoutArtStage();
                            commitArtToTexture();
                        } else {
                            pixBridgeWriteBuffer(it.fk, img, w, h);
                        }
                        applied++;
                    });
                    if (!applied) throw new Error('decode');
                    // clearMaterialCache() NON si chiama qui: la cache tiene istanze
                    // THREE CONDIVISE dalle mesh della scena e liberarle senza un
                    // rebuild subito dopo spegnerebbe la texture di tutto il resto.
                    // Il materiale non e' ancora stato salvato -- niente in scena lo
                    // usa ancora -- e ci pensa saveMaterialFromForm quando lo sara'.
                    refreshSourceUI();
                    refreshFormPreview();
                    return applied;
                });
            }

            /** Abilita i bottoni d'ingresso solo quando c'e' davvero un form da
             *  mandare di la'. Richiamata da refreshSourceUI, cioe' a ogni cambio di
             *  sorgente / apertura / chiusura del form. */
            function refreshPixelBridgeUI() {
                const on = materialFormIsOpen();
                ['materialPixelEditorBtn', 'materialEditorPixelBtn'].forEach(id => {
                    const b = document.getElementById(id);
                    if (b) b.disabled = !on;
                });
            }

            function updatePixelBridgeSubtitle() {
                const el = document.getElementById('pixelEditorSubtitle');
                if (!el) return;
                const nameEl = document.getElementById('materialName');
                const name = nameEl ? nameEl.value.trim() : '';
                el.textContent = name
                    ? t('pixedit.subtitle', { name: name })
                    : t('pixedit.subtitleNoName');
            }

            function openPixelEditor() {
                if (!materialFormIsOpen()) return;
                // La tela deve esistere prima di mandarla: e' lei a dettare la misura,
                // e senza si aprirebbe di la' un documento di dimensione inventata.
                if (_formState.source === 'flat') setFormSource('draw');
                if (!_art.canvas) newArtCanvas(artSelectedSize(), artBackgroundColor());
                const payload = buildBridgePayload();
                if (!payload) return;
                const ov = document.getElementById('pixelEditorOverlay');
                const frame = pixelEditorFrame();
                if (!ov || !frame) return;

                if (!_pixBridge.bound) {
                    window.addEventListener('message', onPixelBridgeMessage);
                    _pixBridge.bound = true;
                }
                _pixBridge.payload = payload;
                _pixBridge.busy = false;
                _pixBridge.open = true;

                updatePixelBridgeSubtitle();
                const link = document.getElementById('pixelEditorTabLink');
                if (link) link.href = pixelEditorUrl();
                ov.style.display = 'flex';
                // src si scrive QUI e non nel template: cosi' la pagina dell'editor
                // (e il suo bundle) non viene scaricata da chi non la apre mai, e
                // ogni apertura riparte pulita invece di riusare uno stato vecchio.
                frame.src = pixelEditorUrl();
            }

            function closePixelEditor() {
                const ov = document.getElementById('pixelEditorOverlay');
                if (ov) ov.style.display = 'none';
                const frame = pixelEditorFrame();
                // 'about:blank' e NON la stringa vuota: assegnare src='' da JS fa
                // risolvere l'URL sul documento corrente, cioe' caricherebbe QUESTA
                // app dentro il proprio iframe (una seconda scena WebGL, e i contesti
                // GL per pagina sono pochi). Vuotarlo davvero serve a fermare l'editor
                // e a garantire un 'hello' nuovo alla riapertura.
                if (frame) frame.src = 'about:blank';
                _pixBridge.open = false;
                _pixBridge.payload = null;
                _pixBridge.busy = false;
            }

            (function initPixelBridge() {
                // Gli handler si agganciano UNA VOLTA sola: addEventListener aggiunge e
                // non sostituisce, e legarli all'apertura del form li accumulerebbe
                // (alla terza apertura un clic aprirebbe tre volte l'editor).
                const on = (id, ev, fn) => {
                    const el = document.getElementById(id);
                    if (el) el.addEventListener(ev, fn);
                };
                on('materialPixelEditorBtn', 'click', openPixelEditor);
                on('materialEditorPixelBtn', 'click', openPixelEditor);
                on('pixelEditorCloseBtn', 'click', closePixelEditor);
                refreshPixelBridgeUI();
            })();
