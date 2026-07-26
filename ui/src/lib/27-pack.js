            // ===== MULTIGENERAZIONE / ASSET PACK (frontend) =====
            // Frammento dello scope condiviso (vedi ui/build.mjs): nessun import/export.
            //
            // Ruolo: pilotare la coda server-side (/api/pack/*) e mostrare la lista
            // degli asset a lato della griglia. La coda vive nel processo Python, non
            // qui: cosi' un reload della webview NON perde un pack da 40 minuti. Al
            // reload questo modulo si ricollega al pack in corso (vedi packResume()).

            const packRefInput = document.getElementById('packRefInput');
            const packAddRefBtn = document.getElementById('packAddRefBtn');
            const packRefList = document.getElementById('packRefList');
            const packRefHint = document.getElementById('packRefHint');
            const packObjectList = document.getElementById('packObjectList');
            const packAddObjBtn = document.getElementById('packAddObjBtn');
            const packVariants = document.getElementById('packVariants');
            const packModelSelect = document.getElementById('packModelSelect');
            const packGridSelect = document.getElementById('packGridSelect');
            const packEnforcePalette = document.getElementById('packEnforcePalette');
            const packModular = document.getElementById('packModular');
            const packModularHint = document.getElementById('packModularHint');
            const packEstimate = document.getElementById('packEstimate');
            const packStartBtn = document.getElementById('packStartBtn');
            const packCancelBtn = document.getElementById('packCancelBtn');
            const packResultsPanel = document.getElementById('packResultsPanel');
            const packResultsList = document.getElementById('packResultsList');
            const packProgressText = document.getElementById('packProgressText');
            const packProgressBar = document.getElementById('packProgressBar');
            const packPanelClose = document.getElementById('packPanelClose');
            const packCoherence = document.getElementById('packCoherence');
            const packLoadAllBtn = document.getElementById('packLoadAllBtn');
            const packExportAllBtn = document.getElementById('packExportAllBtn');
            const genModeSwitch = document.getElementById('genModeSwitch');
            const genModeSingle = document.getElementById('genModeSingle');
            const genModePack = document.getElementById('genModePack');

            // Stato locale del modulo.
            let packReferences = [];      // [{name, data}] JSON di riferimento
            let packRunId = null;         // pack attualmente monitorato
            let packPollTimer = null;
            let packActiveJobId = null;   // asset mostrato ora nella griglia
            let packLastJobs = [];        // ultimo stato noto (per il click)
            const packModelCache = {};    // jobId -> modello, evita rifetch
            const packItemState = {};     // jobId -> firma dello stato gia' disegnato
            let packStructureKey = '';    // insieme dei job attualmente in lista

            // Firma di cio' che si VEDE di un job: se non cambia, il suo elemento
            // nella lista non va ridisegnato (vedi F5 in packRenderStatus).
            function packJobStateKey(job) {
                return [job.status, job.duration || '', job.error || '',
                        (job.modular ? (job.modular.ok ? 'M1' : 'M0') : ''),
                        job.id === packActiveJobId ? 'A' : ''].join('~');
            }

            function packApi(route) {
                return (window.__API_BASE__ ? window.__API_BASE__ : '') + route;
            }

            // --- Sotto-navigazione Singolo / Pack --------------------------------
            if (genModeSwitch) {
                genModeSwitch.querySelectorAll('.seg-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const mode = btn.dataset.genmode;
                        genModeSwitch.querySelectorAll('.seg-btn')
                            .forEach(b => b.classList.toggle('active', b === btn));
                        if (genModeSingle) genModeSingle.style.display = (mode === 'pack') ? 'none' : '';
                        if (genModePack) genModePack.style.display = (mode === 'pack') ? '' : 'none';
                        // Se ci sono risultati, il pannello riappare tornando su Pack.
                        if (mode === 'pack' && packLastJobs.length) packOpenPanel();
                    });
                });
            }

            // --- Righe oggetto (input + / -) -------------------------------------
            // Il primo campo non ha il bottone rimuovi: serve almeno un oggetto.
            function packAddObjectRow(value) {
                if (!packObjectList) return;
                const row = document.createElement('div');
                row.className = 'pack-obj-row';

                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'field';
                input.style.cssText = 'padding: 8px; font-size: 12px;';
                input.placeholder = (typeof t === 'function')
                    ? t('pack.objPlaceholder') : 'Es. Vaso fiori';
                if (value) input.value = value;
                input.addEventListener('input', packUpdateEstimate);
                // Invio = aggiungi un'altra riga: si compila la lista senza mouse.
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        const rows = packObjectList.querySelectorAll('.pack-obj-row');
                        const isLast = rows[rows.length - 1] === row;
                        if (isLast && input.value.trim()) packAddObjectRow();
                        else {
                            const next = row.nextElementSibling;
                            if (next) { const n = next.querySelector('input'); if (n) n.focus(); }
                        }
                    }
                });

                const del = document.createElement('button');
                del.className = 'pack-row-btn danger';
                del.type = 'button';
                del.textContent = '−';
                del.title = (typeof t === 'function') ? t('pack.removeObjTitle') : 'Rimuovi questo oggetto';
                del.addEventListener('click', () => {
                    row.remove();
                    packSyncRemoveButtons();
                    packUpdateEstimate();
                });

                row.appendChild(input);
                row.appendChild(del);
                packObjectList.appendChild(row);
                packSyncRemoveButtons();
                packUpdateEstimate();
                input.focus();
            }

            // Il bottone rimuovi si disabilita quando resta una sola riga.
            function packSyncRemoveButtons() {
                if (!packObjectList) return;
                const rows = packObjectList.querySelectorAll('.pack-obj-row');
                rows.forEach(r => {
                    const b = r.querySelector('.pack-row-btn');
                    if (b) b.disabled = (rows.length <= 1);
                });
            }

            function packGetObjects() {
                if (!packObjectList) return [];
                return Array.from(packObjectList.querySelectorAll('input'))
                    .map(i => i.value.trim())
                    .filter(Boolean);
            }

            if (packAddObjBtn) packAddObjBtn.addEventListener('click', () => packAddObjectRow());

            // Blocchi modulari: mostra la spiegazione e propone una griglia da tile.
            // Griglie enormi per un blocco che si ripete sono sprecate: 32 e' il
            // classico formato dei tileset voxel.
            if (packModular) {
                packModular.addEventListener('change', () => {
                    const on = packModular.checked;
                    if (packModularHint) packModularHint.style.display = on ? '' : 'none';
                    if (on && packGridSelect) {
                        const cur = packGridSelect.value;
                        if (cur === 'auto' || parseInt(cur, 10) > 64) packGridSelect.value = '32x32x32';
                    }
                });
            }

            // --- Riferimenti di stile -------------------------------------------
            if (packAddRefBtn && packRefInput) {
                packAddRefBtn.addEventListener('click', () => packRefInput.click());
                packRefInput.addEventListener('change', (e) => {
                    const files = Array.from(e.target.files || []);
                    files.forEach(file => {
                        const reader = new FileReader();
                        reader.onload = (evt) => {
                            try {
                                let raw = String(evt.target.result || '');
                                // I .voxelai sono JSON offuscati in base64 (vedi 07-save-payload).
                                if (file.name.toLowerCase().endsWith('.voxelai')) {
                                    try { raw = decodeURIComponent(escape(atob(raw))); } catch (_) { /* forse e' JSON puro */ }
                                }
                                const data = JSON.parse(raw);
                                packReferences.push({ name: file.name, data: data });
                                packRenderRefs();
                            } catch (err) {
                                alert(((typeof t === 'function') ? t('pack.refError') : 'Riferimento non valido: ') + file.name);
                            }
                        };
                        reader.readAsText(file);
                    });
                    packRefInput.value = '';
                });
            }

            function packRenderRefs() {
                if (!packRefList) return;
                packRefList.innerHTML = '';
                packReferences.forEach((ref, idx) => {
                    const chip = document.createElement('div');
                    chip.className = 'pack-ref-chip';
                    const label = document.createElement('span');
                    label.textContent = ref.name;
                    label.title = ref.name;
                    const rm = document.createElement('button');
                    rm.type = 'button';
                    rm.textContent = '×';
                    rm.addEventListener('click', () => {
                        packReferences.splice(idx, 1);
                        packRenderRefs();
                    });
                    chip.appendChild(label);
                    chip.appendChild(rm);
                    packRefList.appendChild(chip);
                });
                if (packRefHint) {
                    packRefHint.textContent = packReferences.length
                        ? ((typeof t === 'function') ? t('pack.refsHintLoaded', { n: packReferences.length })
                            : `${packReferences.length} riferimento(i): palette e stile verranno estratti da questi file.`)
                        : ((typeof t === 'function') ? t('pack.refsHint')
                            : 'Nessun riferimento: lo stile del primo asset generato guiderà tutti gli altri.');
                }
            }

            // --- Stima del lavoro ------------------------------------------------
            // Un pack e' lungo: dirlo PRIMA evita che l'utente lanci 60 job per sbaglio.
            function packUpdateEstimate() {
                if (!packEstimate) return;
                const n = packGetObjects().length;
                const v = parseInt(packVariants ? packVariants.value : '1', 10) || 1;
                const total = n * v;
                if (!total) { packEstimate.textContent = ''; return; }
                // ~45 s per asset e' l'ordine di grandezza osservato con Gemini.
                const mins = Math.max(1, Math.round(total * 45 / 60));
                packEstimate.textContent = (typeof t === 'function')
                    ? t('pack.estimate', { total: total, mins: mins })
                    : `${total} asset da generare — circa ${mins} minuti (uno alla volta, per non farsi limitare dall'API).`;
            }
            if (packVariants) packVariants.addEventListener('change', packUpdateEstimate);

            // I modelli AI disponibili sono gli stessi della generazione singola:
            // riuso la lista di 08-generate-ai.js invece di duplicarla.
            function packFillModels() {
                if (!packModelSelect || typeof geminiModels === 'undefined') return;
                packModelSelect.innerHTML = '';
                geminiModels.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.val;
                    opt.textContent = m.label;
                    packModelSelect.appendChild(opt);
                });
            }

            // --- Avvio del pack ---------------------------------------------------
            if (packStartBtn) {
                packStartBtn.addEventListener('click', async () => {
                    const objects = packGetObjects();
                    if (!objects.length) {
                        alert((typeof t === 'function') ? t('pack.noObjects')
                            : 'Scrivi almeno un oggetto da generare!');
                        return;
                    }
                    const variants = parseInt(packVariants.value, 10) || 1;
                    const total = objects.length * variants;
                    // Conferma sopra i 12 job: e' oltre i ~10 minuti di attesa.
                    if (total > 12) {
                        const msg = (typeof t === 'function')
                            ? t('pack.confirmBig', { total: total })
                            : `Stai per generare ${total} asset. Può richiedere molto tempo. Procedere?`;
                        if (!confirm(msg)) return;
                    }

                    packStartBtn.disabled = true;
                    packStartBtn.innerHTML = '<span class="spinner"></span> ' +
                        ((typeof t === 'function') ? t('pack.starting') : 'Avvio...');

                    try {
                        const res = await fetch(packApi('/api/pack/start'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                objects: objects,
                                variants: variants,
                                references: packReferences.map(r => r.data),
                                model: packModelSelect ? packModelSelect.value : null,
                                gridSize: packGridSelect ? packGridSelect.value : 'auto',
                                enforcePalette: packEnforcePalette ? packEnforcePalette.checked : false,
                                modular: packModular ? packModular.checked : false
                            })
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Errore sconosciuto');
                        packRunId = data.id;
                        packActiveJobId = null;
                        Object.keys(packModelCache).forEach(k => delete packModelCache[k]);
                        packRenderStatus(data);
                        packOpenPanel();
                        packStartPolling();
                        if (packCancelBtn) packCancelBtn.style.display = '';
                    } catch (err) {
                        alert(((typeof t === 'function') ? t('pack.startError') : 'Errore avvio pack: ') + err.message);
                    } finally {
                        packStartBtn.disabled = false;
                        packStartBtn.textContent = (typeof t === 'function') ? t('pack.startBtn') : 'Genera Pack';
                    }
                });
            }

            if (packCancelBtn) {
                packCancelBtn.addEventListener('click', async () => {
                    if (!packRunId) return;
                    if (!confirm((typeof t === 'function') ? t('pack.confirmCancel')
                        : 'Annullare il pack? Gli asset già pronti restano disponibili.')) return;
                    try {
                        const res = await fetch(packApi('/api/pack/cancel'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ runId: packRunId })
                        });
                        const data = await res.json();
                        if (res.ok) packRenderStatus(data);
                    } catch (err) { /* il polling riallineera' lo stato */ }
                });
            }

            // --- Polling dello stato ----------------------------------------------
            function packStartPolling() {
                packStopPolling();
                // 2,5 s: abbastanza reattivo, e lo status e' una risposta leggera
                // (i modelli non viaggiano mai nel payload di stato).
                packPollTimer = setInterval(packPoll, 2500);
                packPoll();
            }

            function packStopPolling() {
                if (packPollTimer) { clearInterval(packPollTimer); packPollTimer = null; }
            }

            async function packPoll() {
                try {
                    const url = packApi('/api/pack/status' + (packRunId ? ('?runId=' + encodeURIComponent(packRunId)) : ''));
                    const res = await fetch(url);
                    if (!res.ok) return;
                    const data = await res.json();
                    if (data.empty) { packStopPolling(); return; }
                    packRunId = data.id;
                    packRenderStatus(data);
                    if (data.status === 'done' || data.status === 'cancelled') {
                        packStopPolling();
                        if (packCancelBtn) packCancelBtn.style.display = 'none';
                        packShowCoherence();   // #4: segnala gli asset fuori scala
                    }
                } catch (err) { /* rete momentaneamente giu': si ritenta al tick dopo */ }
            }

            // --- Report di coerenza dimensionale (#4) ------------------------------
            // Un pack serve a mettere gli asset NELLA STESSA scena: se uno e' 5 volte
            // piu' grande degli altri va saputo prima di importarlo in Unity, non dopo.
            async function packShowCoherence() {
                if (!packCoherence || !packRunId) return;
                try {
                    const res = await fetch(packApi('/api/pack/report?runId=' + encodeURIComponent(packRunId)));
                    if (!res.ok) return;
                    const rep = await res.json();
                    if (!rep || !rep.assets || rep.assets.length < 2) {
                        packCoherence.style.display = 'none';
                        return;
                    }
                    const clean = !rep.outliers || !rep.outliers.length;
                    packCoherence.innerHTML = '';
                    const head = document.createElement('div');
                    head.style.cssText = 'font-weight:700; margin-bottom:2px;'
                        + (clean ? '' : ' color:var(--danger);');
                    head.textContent = (typeof t === 'function') ? t('pack.coherenceTitle') : 'Coerenza del pack';
                    packCoherence.appendChild(head);
                    const body = document.createElement('div');
                    body.textContent = clean
                        ? ((typeof t === 'function') ? t('pack.coherenceOk')
                            : 'Tutti gli asset hanno dimensioni coerenti.')
                        : ((typeof t === 'function') ? t('pack.coherenceOutliers')
                            : 'Alcuni asset sono fuori scala rispetto al resto del pack.');
                    packCoherence.appendChild(body);
                    if (!clean) {
                        rep.outliers.slice(0, 5).forEach(o => {
                            const li = document.createElement('div');
                            li.style.cssText = 'margin-top:2px; opacity:0.9;';
                            li.textContent = '- ' + o.label + ' (' + o.ratio + 'x)';
                            packCoherence.appendChild(li);
                        });
                    }
                    packCoherence.style.display = '';
                } catch (e) { /* il report e' un extra: mai bloccare il pack */ }
            }

            // --- Rendering della lista --------------------------------------------
            function packRenderStatus(run) {
                packLastJobs = run.jobs || [];
                const c = run.counts || {};
                const done = c.done || 0;
                const total = run.total || packLastJobs.length || 0;
                const errs = c.error || 0;

                if (packProgressBar) {
                    packProgressBar.style.width = total ? ((done / total) * 100).toFixed(1) + '%' : '0%';
                }
                if (packProgressText) {
                    let txt = `${done}/${total}`;
                    if (c.running) txt += ' · ' + ((typeof t === 'function') ? t('pack.inProgress') : 'in corso');
                    if (errs) txt += ` · ${errs} ` + ((typeof t === 'function') ? t('pack.errors') : 'errori');
                    if (run.etaSeconds != null && run.etaSeconds > 0 && run.status === 'running') {
                        const m = Math.ceil(run.etaSeconds / 60);
                        txt += ' · ~' + m + ((typeof t === 'function') ? t('pack.minShort') : ' min');
                    }
                    if (run.status === 'cancelled') {
                        txt += ' · ' + ((typeof t === 'function') ? t('pack.cancelled') : 'annullato');
                    }
                    packProgressText.textContent = txt;
                }

                if (!packResultsList) return;

                // ANTI-FLICKER (F5). Prima si faceva `innerHTML = ''` e si ricostruiva
                // l'intera lista a OGNI poll (ogni 2,5 s): gli spinner ripartivano da
                // zero, l'hover si perdeva e la lista sfarfallava di continuo. Ora
                // l'aggiornamento e' DIFFERENZIALE: la struttura si crea una volta sola
                // e ai poll successivi cambiano solo gli elementi davvero cambiati.
                const groups = [];
                const byName = {};
                packLastJobs.forEach(j => {
                    if (!byName[j.objectName]) { byName[j.objectName] = []; groups.push(j.objectName); }
                    byName[j.objectName].push(j);
                });

                const structureKey = packLastJobs.map(j => j.id).join('|');
                if (structureKey !== packStructureKey) {
                    packStructureKey = structureKey;
                    packResultsList.innerHTML = '';
                    Object.keys(packItemEls).forEach(k => delete packItemEls[k]);
                    Object.keys(packItemState).forEach(k => delete packItemState[k]);
                    groups.forEach(name => {
                        if (groups.length > 1) {
                            const lbl = document.createElement('div');
                            lbl.className = 'pack-group-label';
                            lbl.textContent = name;
                            packResultsList.appendChild(lbl);
                        }
                        byName[name].forEach(job => {
                            const el = packBuildItem(job);
                            packItemEls[job.id] = el;
                            packItemState[job.id] = packJobStateKey(job);
                            packResultsList.appendChild(el);
                        });
                    });
                } else {
                    packLastJobs.forEach(job => {
                        const key = packJobStateKey(job);
                        if (packItemState[job.id] === key) return;   // invariato
                        packItemState[job.id] = key;
                        const oldEl = packItemEls[job.id];
                        const newEl = packBuildItem(job);
                        packItemEls[job.id] = newEl;
                        if (oldEl && oldEl.parentNode) oldEl.parentNode.replaceChild(newEl, oldEl);
                        else packResultsList.appendChild(newEl);
                    });
                }
            }

            function packBuildItem(job) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'pack-item';
                btn.dataset.jobId = job.id;

                if (job.status === 'done') btn.classList.add('is-done');
                else if (job.status === 'error') btn.classList.add('is-error');
                else if (job.status === 'cancelled') btn.classList.add('is-cancelled');
                if (job.id === packActiveJobId) btn.classList.add('is-active');

                // Indicatore: spinner se in corso, puntino altrimenti.
                if (job.status === 'running') {
                    const sp = document.createElement('span');
                    sp.className = 'pack-spin';
                    btn.appendChild(sp);
                } else {
                    const dot = document.createElement('span');
                    dot.className = 'pack-dot';
                    btn.appendChild(dot);
                }

                const label = document.createElement('span');
                label.className = 'pack-item-label';
                label.textContent = job.label;
                btn.appendChild(label);

                const meta = document.createElement('span');
                meta.className = 'pack-item-meta';
                if (job.status === 'done') meta.textContent = job.duration ? Math.round(job.duration) + 's' : '✓';
                else if (job.status === 'error') meta.textContent = '!';
                else if (job.status === 'running') meta.textContent = '…';
                else if (job.status === 'cancelled') meta.textContent = '–';
                else meta.textContent = '·';
                btn.appendChild(meta);

                // Blocchi modulari: se la verifica ha trovato problemi, segnalalo
                // sull'elemento stesso. Scoprire nel level builder che un tile non
                // combacia e' molto peggio che leggerlo qui.
                if (job.modular && !job.modular.ok && job.status === 'done') {
                    btn.classList.add('is-warn');
                    meta.textContent = '!';
                    meta.style.color = 'var(--danger)';
                }

                if (job.status === 'done') {
                    const warn = (job.modular && !job.modular.ok)
                        ? ('\n\nATTENZIONE modularita:\n- ' + (job.modular.issues || []).join('\n- '))
                        : '';
                    btn.title = ((typeof t === 'function') ? t('pack.clickToView')
                        : 'Clicca per vedere questo modello nella griglia') + warn;
                    btn.addEventListener('click', () => packLoadJob(job.id));
                } else if (job.status === 'error') {
                    btn.title = (job.error || '') + ' — ' + ((typeof t === 'function') ? t('pack.clickToRetry') : 'clicca per riprovare');
                    btn.addEventListener('click', () => packRetryJob(job.id));
                } else {
                    btn.title = job.label + ' — ' + job.status;
                }
                return btn;
            }

            // Evidenzia l'asset attualmente mostrato nella griglia. Tenuta separata
            // e basata sulla mappa jobId -> elemento costruita durante il rendering:
            // non dipende da un riquery del DOM, quindi resta corretta anche se la
            // lista viene ricostruita dal polling mentre l'utente clicca.
            const packItemEls = {};
            function packHighlightActive() {
                Object.keys(packItemEls).forEach(id => {
                    const el = packItemEls[id];
                    if (el && el.classList) el.classList.toggle('is-active', id === packActiveJobId);
                    // Allinea la firma: l'evidenziazione fa parte dello stato visibile,
                    // altrimenti il poll successivo la considera "cambiata" e ridisegna
                    // l'elemento perdendo la selezione.
                    const job = packLastJobs.find(j => j.id === id);
                    if (job) packItemState[id] = packJobStateKey(job);
                });
            }

            function packOpenPanel() {
                if (packResultsPanel) packResultsPanel.classList.add('open');
            }
            if (packPanelClose) {
                packPanelClose.addEventListener('click', () => {
                    if (packResultsPanel) packResultsPanel.classList.remove('open');
                });
            }

            // --- Caricare un asset nella griglia ----------------------------------
            // Requisito: cliccando un asset pronto la griglia viene PULITA e mostra
            // solo quel modello.
            async function packLoadJob(jobId) {
                try {
                    let model = packModelCache[jobId];
                    if (!model) {
                        const res = await fetch(packApi('/api/pack/result?runId=' +
                            encodeURIComponent(packRunId) + '&jobId=' + encodeURIComponent(jobId)));
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Asset non disponibile');
                        model = data.model;
                        packModelCache[jobId] = model;
                    }
                    // loadSceneFromParsed azzera sceneObjects: la griglia resta con
                    // il solo asset scelto, come richiesto.
                    loadSceneFromParsed(JSON.parse(JSON.stringify(model)));
                    buildModel();
                    packActiveJobId = jobId;
                    packHighlightActive();
                } catch (err) {
                    alert(((typeof t === 'function') ? t('pack.loadError') : 'Errore caricamento asset: ') + err.message);
                }
            }

            async function packRetryJob(jobId) {
                if (!packRunId) return;
                try {
                    const res = await fetch(packApi('/api/pack/retry'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ runId: packRunId, jobId: jobId })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        packRenderStatus(data);
                        packStartPolling();
                        if (packCancelBtn) packCancelBtn.style.display = '';
                    }
                } catch (err) { /* il polling riallineera' */ }
            }

            // --- Carica tutti gli asset come oggetti separati ----------------------
            // Utile per vedere il pack intero insieme e valutarne la coerenza.
            if (packLoadAllBtn) {
                packLoadAllBtn.addEventListener('click', async () => {
                    try {
                        const res = await fetch(packApi('/api/pack/all?runId=' + encodeURIComponent(packRunId || '')));
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Errore');
                        if (!data.count) {
                            alert((typeof t === 'function') ? t('pack.noneReady') : 'Nessun asset pronto.');
                            return;
                        }
                        // Affianco gli asset sull'asse X per non sovrapporli: un pack
                        // caricato "tutto in 0,0,0" sarebbe un grumo illeggibile.
                        const objects = data.assets.map((a, i) => {
                            const m = a.model || {};
                            const g = (m.metadata && m.metadata.grid_size) || [32, 32, 32];
                            const step = (g[0] || 32) + 4;
                            return {
                                name: a.label,
                                metadata: m.metadata,
                                palette: m.palette,
                                ops: m.ops,
                                voxels: m.voxels,
                                transform: {
                                    position: { x: i * step, y: 0, z: 0 },
                                    rotationY: 0, scale: 1
                                },
                                visible: true
                            };
                        });
                        loadSceneFromParsed({ objects: objects });
                        buildModel();
                        packActiveJobId = null;
                    } catch (err) {
                        alert(((typeof t === 'function') ? t('pack.loadError') : 'Errore: ') + err.message);
                    }
                });
            }

            // --- Esporta tutto il pack in un unico ZIP (idea #5) -------------------
            // Un pack da 15 asset come 15 download separati e' inutilizzabile: il
            // browser li blocca, i nomi si mescolano e l'utente deve riordinarli a
            // mano. Uno ZIP con una cartella per asset si trascina in Unity/Godot
            // cosi' com'e'. I formati riusano gli encoder gia' presenti in
            // 20-formats.js e 06-export-obj.js: nessuna logica di export duplicata.
            if (packExportAllBtn) {
                packExportAllBtn.addEventListener('click', async () => {
                    const origLabel = packExportAllBtn.textContent;
                    try {
                        packExportAllBtn.disabled = true;
                        packExportAllBtn.textContent = (typeof t === 'function')
                            ? t('pack.exporting') : 'Preparazione ZIP...';

                        const res = await fetch(packApi('/api/pack/all?runId=' + encodeURIComponent(packRunId || '')));
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Errore');
                        if (!data.count) {
                            alert((typeof t === 'function') ? t('pack.noneReady') : 'Nessun asset pronto.');
                            return;
                        }

                        // Il report di coerenza finisce nel manifest: chi apre lo ZIP
                        // sa subito se un asset e' fuori scala rispetto agli altri.
                        let report = null;
                        try {
                            const rr = await fetch(packApi('/api/pack/report?runId=' + encodeURIComponent(packRunId || '')));
                            if (rr.ok) report = await rr.json();
                        } catch (e) { /* il report e' un extra */ }

                        const files = [];
                        const manifest = {
                            format: 'voxelai-pack',
                            version: 1,
                            generatedAt: new Date().toISOString(),
                            assetCount: data.count,
                            assets: [],
                            coherence: report || undefined
                        };

                        data.assets.forEach(a => {
                            const model = a.model || {};
                            const voxels = (typeof expandOps === 'function')
                                ? (expandOps(JSON.parse(JSON.stringify(model))).voxels || [])
                                : (model.voxels || []);
                            const dir = a.label + '/';

                            files.push({ name: dir + a.label + '.json', data: JSON.stringify(model, null, 2) });

                            // .vox per MagicaVoxel: lo standard de-facto del mondo voxel
                            try {
                                if (typeof encodeVox === 'function' && voxels.length) {
                                    files.push({ name: dir + a.label + '.vox', data: encodeVox(voxels) });
                                }
                            } catch (e) { /* un formato in meno, non un export fallito */ }

                            // OBJ + MTL (Blender e qualunque altro DCC)
                            try {
                                if (typeof buildObjText === 'function' && voxels.length) {
                                    files.push({ name: dir + a.label + '.obj', data: buildObjText(a.label + '.mtl', voxels) });
                                    files.push({ name: dir + a.label + '.mtl', data: buildMtlText(voxels) });
                                }
                            } catch (e) { /* idem */ }

                            manifest.assets.push({
                                label: a.label, object: a.objectName, variant: a.variant,
                                voxels: voxels.length,
                                gridSize: (model.metadata && model.metadata.grid_size) || null
                            });
                        });

                        files.push({ name: 'pack.json', data: JSON.stringify(manifest, null, 2) });

                        const stamp = new Date().toISOString().slice(0, 10);
                        downloadBlob(createZipBlob(files), 'VoxelAI_Pack_' + stamp + '.zip');
                    } catch (err) {
                        alert(((typeof t === 'function') ? t('pack.loadError') : 'Errore: ') + err.message);
                    } finally {
                        packExportAllBtn.disabled = false;
                        packExportAllBtn.textContent = origLabel;
                    }
                });
            }

            // --- Ripresa dopo un reload della webview ------------------------------
            // La coda vive lato server: se c'e' un pack in corso lo si ritrova.
            async function packResume() {
                try {
                    const res = await fetch(packApi('/api/pack/status'));
                    if (!res.ok) return;
                    const data = await res.json();
                    if (data.empty || !data.jobs || !data.jobs.length) return;
                    packRunId = data.id;
                    packRenderStatus(data);
                    packOpenPanel();
                    if (data.status === 'running') {
                        packStartPolling();
                        if (packCancelBtn) packCancelBtn.style.display = '';
                    }
                } catch (err) { /* nessun server (uso web): la modalita' pack resta inerte */ }
            }

            // Inizializzazione: una riga oggetto vuota, i modelli AI, la stima, e il
            // tentativo di riagganciare un pack in corso.
            packAddObjectRow();
            packFillModels();
            packUpdateEstimate();
            packResume();
