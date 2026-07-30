            /* ===== T-progetto: Formato nativo .voxai + autosave + versioning =========
             * Gestisce il formato progetto nativo `.voxai` (il wrapper vero e proprio lo
             * costruisce il backend: { format:"voxai", version:1, savedAt, data }), un
             * autosave periodico + con debounce, e un pannello "Cronologia salvataggi"
             * per ripristinare versioni precedenti.
             *
             * DESKTOP (window.__IS_DESKTOP__): usa il backend file I/O (/api/project/*,
             * /api/autosave/*, /api/recent). WEB (nessun backend): fallback download del
             * wrapper .voxai e ultimo autosave in localStorage.
             *
             * ATTENZIONE alla distinzione (vedi 19-prefs.js): hasLocalBackend() dice se
             * c'e' il server Python (vero anche in modalita' web, quindi autosave e
             * cronologia vanno su disco); hasNativeDialogs() dice se ci sono i dialog Qt
             * (solo modalita' "py"), che servono per Apri / Salva con nome.
             *
             * Il contenuto del progetto = getSceneSavePayload() (l'INTERA scena T1).
             * Tutte le fetch sono in try/catch: senza backend l'app non si rompe. */

            // --- stato progetto -------------------------------------------------
            let currentProjectPath = null;   // path del .voxai correntemente aperto/salvato
            let projectDirty = false;        // true dopo una modifica non ancora salvata
            const AUTOSAVE_SESSION_ID = 'unsaved-' + Date.now(); // id stabile finché non si salva

            function projectApi(route) {
                return (window.__API_BASE__ ? window.__API_BASE__ : '') + route;
            }
            // NIENTE isDesktopApp() qui: le due capacita' che contano sono
            // hasLocalBackend() e hasNativeDialogs() (19-prefs.js). Un unico flag
            // "desktop" faceva degradare la modalita' web senza motivo.

            function sceneHasVoxels() {
                try { return sceneObjects.some(o => ((o.data && o.data.voxels) || []).length > 0); }
                catch (e) { return (((currentModelData && currentModelData.voxels) || []).length > 0); }
            }

            function currentProjectName() {
                const meta = (currentModelData && currentModelData.metadata) || {};
                return (meta.name || 'voxel_model').replace(/\s+/g, '_');
            }

            // projectId per l'autosave: derivato dal nome file corrente (sanificato) o
            // id di sessione stabile finché il progetto non è mai stato salvato.
            function deriveProjectId() {
                if (currentProjectPath) {
                    const base = String(currentProjectPath).split(/[\\/]/).pop() || 'progetto';
                    return base.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'progetto';
                }
                return AUTOSAVE_SESSION_ID;
            }

            function base64ToArrayBuffer(b64) {
                const bin = atob(String(b64 || '').trim());
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return bytes.buffer;
            }

            // Carica (SOSTITUISCE la scena) un oggetto-dati progetto già deserializzato.
            // Accetta scena multi-oggetto ({objects:[...]}) o modello singolo (flat/compact).
            function loadProjectData(data) {
                if (!data || typeof data !== 'object') { alert(t('project.invalidData')); return false; }
                if (!Array.isArray(data.objects) && !Array.isArray(data.ops) && !Array.isArray(data.voxels)) {
                    alert(t('project.invalidFormat'));
                    return false;
                }
                if (!data.metadata) data.metadata = {};
                loadSceneFromParsed(data);   // reset + ricrea gli oggetti scena
                buildModel();
                if (data.rig && Array.isArray(data.rig.bones) && data.rig.bones.length && typeof restoreRig === 'function') {
                    restoreRig(data.rig);
                }
                return true;
            }

            // --- indicatore UI "Salvato automaticamente HH:MM" ------------------
            function setAutosaveStatus(text) {
                const el = document.getElementById('autosaveStatus');
                if (el) el.textContent = text || '';
            }
            function markProjectSaved() {
                projectDirty = false;
                const now = new Date();
                const hh = String(now.getHours()).padStart(2, '0');
                const mm = String(now.getMinutes()).padStart(2, '0');
                setAutosaveStatus(t('project.autosavedAt', { time: hh + ':' + mm }));
            }

            // --- aggiornamento progetti recenti (best-effort) -------------------
            async function pushRecent(path, name) {
                if (!hasLocalBackend() || !path) return;
                try {
                    await fetch(projectApi('/api/recent'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entry: { path: path, name: name || currentProjectName() } })
                    });
                } catch (e) { /* recenti best-effort: se fallisce, ignora */ }
            }

            /* =========================================================================
             * 1. SALVA / APRI progetto .voxai
             * =======================================================================*/

            // saveProject(forceDialog): salva la scena come .voxai.
            //  - DIALOG NATIVI (modalita' "py"): POST /api/project/save { data, path? }.
            //    Senza path il backend apre il dialog e ritorna il path (o { cancelled:true }).
            //  - ALTRIMENTI (browser): scarica il wrapper voxai come file .voxai. Senza Qt
            //    non esiste un "Salva con nome", e scrivere su un path arbitrario dal tab
            //    non e' possibile: il download e' l'equivalente corretto.
            async function saveProject(forceDialog) {
                const data = getSceneSavePayload();
                if (!hasNativeDialogs()) {
                    // BROWSER: nessun dialog nativo, ricrea il wrapper lato client e scarica.
                    const wrapper = { format: 'voxai', version: 1, savedAt: new Date().toISOString(), data: data };
                    downloadFile(JSON.stringify(wrapper), currentProjectName() + '.voxai', 'application/json');
                    markProjectSaved();
                    return;
                }
                const body = { data: data };
                if (!forceDialog && currentProjectPath) body.path = currentProjectPath;
                try {
                    const res = await fetch(projectApi('/api/project/save'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    if (!res || !res.ok) {
                        // 501: GUI assente lato backend -> fallback download.
                        const wrapper = { format: 'voxai', version: 1, savedAt: new Date().toISOString(), data: data };
                        downloadFile(JSON.stringify(wrapper), currentProjectName() + '.voxai', 'application/json');
                        markProjectSaved();
                        return;
                    }
                    const j = await res.json();
                    if (j && j.cancelled) return;      // dialog annullato: nessun cambiamento
                    if (j && j.error) { alert(t('project.saveError', { error: j.error })); return; }
                    if (j && j.path) {
                        currentProjectPath = j.path;
                        markProjectSaved();
                        const nm = (String(j.path).split(/[\\/]/).pop() || currentProjectName());
                        pushRecent(j.path, nm);
                    }
                } catch (e) {
                    // Backend irraggiungibile: fallback download in chiaro.
                    const wrapper = { format: 'voxai', version: 1, savedAt: new Date().toISOString(), data: data };
                    downloadFile(JSON.stringify(wrapper), currentProjectName() + '.voxai', 'application/json');
                    markProjectSaved();
                }
            }

            function saveProjectAs() { return saveProject(true); }

            // openProject(): apre un .voxai / .json / .voxelai / .vox / .schem.
            //  - DIALOG NATIVI: GET /api/project/open (dialog Qt). Gestisce encoding json
            //    (voxai/json) e base64 (vox/schem: decodifica coi decoder di 20-formats).
            //  - ALTRIMENTI: riusa l'input file esistente (handleFile via #fileInput).
            async function openProject() {
                if (!hasNativeDialogs()) {
                    const fi = document.getElementById('fileInput');
                    if (fi) fi.click();
                    return;
                }
                try {
                    const res = await fetch(projectApi('/api/project/open'));
                    if (!res || !res.ok) { alert(t('project.openUnavailable')); return; }
                    const j = await res.json();
                    if (!j || j.cancelled) return;
                    if (j.error) { alert(t('project.openError', { error: j.error })); return; }

                    if (j.encoding === 'json') {
                        const content = j.content;
                        // Un .voxai ha wrapper {format:"voxai",...,data}; un .json/.voxelai è la scena diretta.
                        let data = content;
                        if (content && content.format === 'voxai' && content.data) data = content.data;
                        if (loadProjectData(data)) {
                            currentProjectPath = j.path || null;
                            markProjectSaved();
                            if (j.path) pushRecent(j.path, String(j.path).split(/[\\/]/).pop());
                        }
                    } else if (j.encoding === 'base64') {
                        // .vox/.schem: decodifica binaria lato frontend.
                        const buf = base64ToArrayBuffer(j.content);
                        const ext = (j.ext || '').toLowerCase();
                        const done = (parsed) => {
                            if (!parsed || !Array.isArray(parsed.voxels)) { alert(t('alert.fileNoValidVoxels')); return; }
                            if (!parsed.metadata) parsed.metadata = {};
                            if (!parsed.metadata.name && j.path) parsed.metadata.name = String(j.path).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
                            loadSceneFromParsed(parsed);
                            buildModel();
                            currentProjectPath = null; // binario importato: non è un .voxai nativo
                            if (j.path) pushRecent(j.path, String(j.path).split(/[\\/]/).pop());
                        };
                        if (ext === '.vox' || ext === 'vox') {
                            done(decodeVox(buf));
                        } else if (ext === '.schem' || ext === 'schem' || ext === '.schematic' || ext === 'schematic') {
                            const parsed = await decodeSchem(buf);
                            done(parsed);
                        } else {
                            alert(t('project.unknownBinary', { ext: ext }));
                        }
                    } else {
                        alert(t('project.openBadResponse'));
                    }
                } catch (e) {
                    alert(t('project.openError', { error: e.message }));
                }
            }

            /* =========================================================================
             * 2. AUTOSAVE (periodico ~90s + debounce dopo modifica), solo se dirty.
             *    CON BACKEND (anche in modalita' web): POST /api/autosave, snapshot su
             *    disco con rotazione. SENZA BACKEND (file://): ultimo autosave in
             *    localStorage. Se la POST fallisce si ripiega comunque su localStorage,
             *    cosi' una modifica non resta senza rete di sicurezza.
             * =======================================================================*/
            const AUTOSAVE_LS_KEY = 'voxelai-autosave';
            const AUTOSAVE_INTERVAL_MS = 90000;
            const AUTOSAVE_DEBOUNCE_MS = 8000;
            let autosaveDebounceTimer = null;
            let autosaveInFlight = false;

            async function runAutosave() {
                if (!projectDirty || !sceneHasVoxels() || autosaveInFlight) return;
                autosaveInFlight = true;
                // F8: getSceneSavePayload() comprime tutti i voxel della scena e su un
                // modello grande costa parecchio. Girando dritto dentro il timer, quel
                // costo cadeva su un frame qualsiasi: micro-blocco visibile ogni 90 s,
                // magari nel mezzo di una pennellata. requestIdleCallback lo sposta in
                // un momento in cui il browser non ha nulla da disegnare.
                await new Promise(resolve => {
                    if (typeof requestIdleCallback === 'function') {
                        requestIdleCallback(() => resolve(), { timeout: 2000 });
                    } else {
                        setTimeout(resolve, 0);   // Safari e webview vecchie
                    }
                });
                const data = getSceneSavePayload();
                const projectId = deriveProjectId();
                const toLocalStorage = () => {
                    // Conserva SOLO l'ultimo autosave: e' una rete di sicurezza, non una
                    // cronologia (per quella serve il backend, che ruota i file).
                    const wrapper = { format: 'voxai', version: 1, savedAt: new Date().toISOString(), projectId: projectId, data: data };
                    try { localStorage.setItem(AUTOSAVE_LS_KEY, JSON.stringify(wrapper)); markProjectSaved(); } catch (e) { }
                };
                try {
                    if (hasLocalBackend()) {
                        const res = await fetch(projectApi('/api/autosave'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ data: data, projectId: projectId })
                        });
                        if (res && res.ok) markProjectSaved();
                        else toLocalStorage();       // backend raggiunto ma in errore
                    } else {
                        toLocalStorage();
                    }
                } catch (e) {
                    // Backend non raggiungibile: meglio localStorage che nessun autosave.
                    try { toLocalStorage(); } catch (e2) { }
                }
                finally { autosaveInFlight = false; }
            }

            // Segnala una modifica: arma il debounce dell'autosave.
            function markProjectDirty() {
                projectDirty = true;
                if (autosaveDebounceTimer) clearTimeout(autosaveDebounceTimer);
                autosaveDebounceTimer = setTimeout(runAutosave, AUTOSAVE_DEBOUNCE_MS);
            }

            // Aggancio NON invasivo al dirty flag: avvolge pushHistory() (chiamata a ogni
            // modifica registrata nello storico) così ogni edit marca il progetto "dirty".
            (function hookDirtyTracking() {
                if (typeof pushHistory === 'function') {
                    const _origPushHistory = pushHistory;
                    pushHistory = function () {
                        const r = _origPushHistory.apply(this, arguments);
                        try { markProjectDirty(); } catch (e) { }
                        return r;
                    };
                }
            })();

            setInterval(runAutosave, AUTOSAVE_INTERVAL_MS);

            /* =========================================================================
             * 3. VERSIONING / RIPRISTINO — pannello "Cronologia salvataggi"
             * =======================================================================*/
            function fmtBytes(n) {
                n = Number(n) || 0;
                if (n < 1024) return n + ' B';
                if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
                return (n / (1024 * 1024)).toFixed(1) + ' MB';
            }
            function fmtSavedAt(iso) {
                try { const d = new Date(iso); if (!isNaN(d.getTime())) return d.toLocaleString(uiLocale()); } catch (e) { }
                return iso || '';
            }

            // Le note della lista autosave sono testo tradotto: si costruiscono con
            // textContent perche' le traduzioni contengono apostrofi e virgolette.
            function autosaveListNote(listEl, msg) {
                listEl.innerHTML = '';
                const note = document.createElement('div');
                note.style.cssText = 'opacity:0.7; font-size:12px; padding:8px;';
                note.textContent = msg;
                listEl.appendChild(note);
            }

            async function refreshAutosaveList() {
                const listEl = document.getElementById('autosaveList');
                if (!listEl) return;
                if (!hasLocalBackend()) {
                    autosaveListNote(listEl, t('autosave.needsApp'));
                    return;
                }
                autosaveListNote(listEl, t('common.loading'));
                try {
                    const res = await fetch(projectApi('/api/autosave/list'));
                    if (!res || !res.ok) { autosaveListNote(listEl, t('autosave.loadFailed')); return; }
                    const j = await res.json();
                    const items = (j && Array.isArray(j.autosaves)) ? j.autosaves : [];
                    if (!items.length) { autosaveListNote(listEl, t('autosave.empty')); return; }
                    listEl.innerHTML = '';
                    items.forEach(it => {
                        const row = document.createElement('div');
                        row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; border:1px solid var(--glass-border); border-radius:8px; margin-bottom:6px;';
                        const info = document.createElement('div');
                        info.style.cssText = 'font-size:12px; line-height:1.4; overflow:hidden;';
                        info.innerHTML = '<div style="font-weight:600;">' + fmtSavedAt(it.savedAt) + '</div>' +
                            '<div style="opacity:0.7;">' + (it.projectId || '') + ' · ' + fmtBytes(it.size) + '</div>';
                        const btn = document.createElement('button');
                        btn.className = 'btn btn-secondary';
                        btn.textContent = 'Ripristina';
                        btn.style.cssText = 'font-size:11px; padding:6px 10px; flex-shrink:0;';
                        btn.addEventListener('click', () => restoreAutosave(it.name));
                        row.appendChild(info);
                        row.appendChild(btn);
                        listEl.appendChild(row);
                    });
                } catch (e) {
                    autosaveListNote(listEl, t('autosave.loadError'));
                }
            }

            async function restoreAutosave(name) {
                if (!name) return;
                if (!confirm(t('autosave.confirmRestore'))) return;
                try {
                    const res = await fetch(projectApi('/api/autosave/get?name=' + encodeURIComponent(name)));
                    if (!res || !res.ok) { alert(t('autosave.restoreLoadFailed')); return; }
                    const j = await res.json();
                    const wrapper = j && j.content;
                    const data = (wrapper && wrapper.format === 'voxai' && wrapper.data) ? wrapper.data : wrapper;
                    if (loadProjectData(data)) {
                        markProjectSaved();
                        closeAutosaveHistory();
                    }
                } catch (e) {
                    alert(t('autosave.restoreError', { error: e.message }));
                }
            }

            async function openAutosaveFolder() {
                if (!hasLocalBackend()) { alert(t('autosave.needsAppFolder')); return; }
                try { await fetch(projectApi('/api/autosave/open-folder')); }
                catch (e) { alert(t('autosave.folderError', { error: e.message })); }
            }

            function openAutosaveHistory() {
                const ov = document.getElementById('autosaveHistoryOverlay');
                if (ov) { ov.style.display = 'flex'; refreshAutosaveList(); }
            }
            function closeAutosaveHistory() {
                const ov = document.getElementById('autosaveHistoryOverlay');
                if (ov) ov.style.display = 'none';
            }

            /* =========================================================================
             * 4. Wiring pulsanti UI
             * =======================================================================*/
            (function wireProjectButtons() {
                const saveBtn = document.getElementById('saveProjectBtn');
                if (saveBtn) saveBtn.addEventListener('click', () => saveProject(false));
                const saveAsBtn = document.getElementById('saveProjectAsBtn');
                if (saveAsBtn) saveAsBtn.addEventListener('click', () => saveProjectAs());
                const openBtn = document.getElementById('openProjectBtn');
                if (openBtn) openBtn.addEventListener('click', () => openProject());
                const histBtn = document.getElementById('autosaveHistoryBtn');
                if (histBtn) histBtn.addEventListener('click', () => openAutosaveHistory());
                const closeBtn = document.getElementById('autosaveHistoryClose');
                if (closeBtn) closeBtn.addEventListener('click', () => closeAutosaveHistory());
                const folderBtn = document.getElementById('autosaveOpenFolderBtn');
                if (folderBtn) folderBtn.addEventListener('click', () => openAutosaveFolder());
                const ov = document.getElementById('autosaveHistoryOverlay');
                if (ov) ov.addEventListener('click', (e) => { if (e.target === ov) closeAutosaveHistory(); });
            })();
