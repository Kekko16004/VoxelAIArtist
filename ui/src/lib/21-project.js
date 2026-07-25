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
             * Il contenuto del progetto = getSceneSavePayload() (l'INTERA scena T1).
             * Tutte le fetch sono in try/catch: senza backend l'app non si rompe. */

            // --- stato progetto -------------------------------------------------
            let currentProjectPath = null;   // path del .voxai correntemente aperto/salvato
            let projectDirty = false;        // true dopo una modifica non ancora salvata
            const AUTOSAVE_SESSION_ID = 'unsaved-' + Date.now(); // id stabile finché non si salva

            function projectApi(route) {
                return (window.__API_BASE__ ? window.__API_BASE__ : '') + route;
            }
            function isDesktopApp() { return !!window.__IS_DESKTOP__; }

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
                if (!data || typeof data !== 'object') { alert('Dati progetto non validi.'); return false; }
                if (!Array.isArray(data.objects) && !Array.isArray(data.ops) && !Array.isArray(data.voxels)) {
                    alert('Formato progetto non valido: manca "objects", "ops" o "voxels".');
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
                setAutosaveStatus('Salvato automaticamente ' + hh + ':' + mm);
            }

            // --- aggiornamento progetti recenti (best-effort) -------------------
            async function pushRecent(path, name) {
                if (!isDesktopApp() || !path) return;
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
            //  - DESKTOP: POST /api/project/save { data, path? }. Senza path il backend
            //    apre il dialog e ritorna il path (o { cancelled:true }).
            //  - WEB: scarica il wrapper voxai come file .voxai.
            async function saveProject(forceDialog) {
                const data = getSceneSavePayload();
                if (!isDesktopApp()) {
                    // WEB: nessun backend, ricrea il wrapper lato client e scarica.
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
                    if (j && j.error) { alert('Errore salvataggio progetto: ' + j.error); return; }
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
            //  - DESKTOP: GET /api/project/open (dialog nativo). Gestisce encoding json
            //    (voxai/json) e base64 (vox/schem: decodifica coi decoder di 20-formats).
            //  - WEB: riusa l'input file esistente (handleFile via #fileInput).
            async function openProject() {
                if (!isDesktopApp()) {
                    const fi = document.getElementById('fileInput');
                    if (fi) fi.click();
                    return;
                }
                try {
                    const res = await fetch(projectApi('/api/project/open'));
                    if (!res || !res.ok) { alert('Apertura progetto non disponibile.'); return; }
                    const j = await res.json();
                    if (!j || j.cancelled) return;
                    if (j.error) { alert('Errore apertura progetto: ' + j.error); return; }

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
                            if (!parsed || !Array.isArray(parsed.voxels)) { alert('Il file non contiene voxel validi.'); return; }
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
                            alert('Formato binario non riconosciuto: ' + ext);
                        }
                    } else {
                        alert('Risposta apertura progetto non riconosciuta.');
                    }
                } catch (e) {
                    alert('Errore apertura progetto: ' + e.message);
                }
            }

            /* =========================================================================
             * 2. AUTOSAVE (periodico ~90s + debounce dopo modifica), solo se dirty.
             *    DESKTOP: POST /api/autosave. WEB: ultimo autosave in localStorage.
             * =======================================================================*/
            const AUTOSAVE_LS_KEY = 'voxelai-autosave';
            const AUTOSAVE_INTERVAL_MS = 90000;
            const AUTOSAVE_DEBOUNCE_MS = 8000;
            let autosaveDebounceTimer = null;
            let autosaveInFlight = false;

            async function runAutosave() {
                if (!projectDirty || !sceneHasVoxels() || autosaveInFlight) return;
                autosaveInFlight = true;
                const data = getSceneSavePayload();
                const projectId = deriveProjectId();
                try {
                    if (isDesktopApp()) {
                        const res = await fetch(projectApi('/api/autosave'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ data: data, projectId: projectId })
                        });
                        if (res && res.ok) markProjectSaved();
                    } else {
                        // WEB: conserva SOLO l'ultimo autosave in localStorage.
                        const wrapper = { format: 'voxai', version: 1, savedAt: new Date().toISOString(), projectId: projectId, data: data };
                        try { localStorage.setItem(AUTOSAVE_LS_KEY, JSON.stringify(wrapper)); markProjectSaved(); } catch (e) { }
                    }
                } catch (e) { /* autosave best-effort: riproverà al prossimo tick */ }
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
                try { const d = new Date(iso); if (!isNaN(d.getTime())) return d.toLocaleString('it-IT'); } catch (e) { }
                return iso || '';
            }

            async function refreshAutosaveList() {
                const listEl = document.getElementById('autosaveList');
                if (!listEl) return;
                if (!isDesktopApp()) {
                    listEl.innerHTML = '<div style="opacity:0.7; font-size:12px; padding:8px;">La cronologia salvataggi è disponibile solo nell\'app desktop.</div>';
                    return;
                }
                listEl.innerHTML = '<div style="opacity:0.7; font-size:12px; padding:8px;">Caricamento…</div>';
                try {
                    const res = await fetch(projectApi('/api/autosave/list'));
                    if (!res || !res.ok) { listEl.innerHTML = '<div style="opacity:0.7; font-size:12px; padding:8px;">Impossibile caricare la cronologia.</div>'; return; }
                    const j = await res.json();
                    const items = (j && Array.isArray(j.autosaves)) ? j.autosaves : [];
                    if (!items.length) { listEl.innerHTML = '<div style="opacity:0.7; font-size:12px; padding:8px;">Nessun salvataggio automatico presente.</div>'; return; }
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
                    listEl.innerHTML = '<div style="opacity:0.7; font-size:12px; padding:8px;">Errore nel caricamento della cronologia.</div>';
                }
            }

            async function restoreAutosave(name) {
                if (!name) return;
                if (!confirm('Ripristinare questo salvataggio automatico? La scena corrente verrà sostituita.')) return;
                try {
                    const res = await fetch(projectApi('/api/autosave/get?name=' + encodeURIComponent(name)));
                    if (!res || !res.ok) { alert('Impossibile caricare il salvataggio selezionato.'); return; }
                    const j = await res.json();
                    const wrapper = j && j.content;
                    const data = (wrapper && wrapper.format === 'voxai' && wrapper.data) ? wrapper.data : wrapper;
                    if (loadProjectData(data)) {
                        markProjectSaved();
                        closeAutosaveHistory();
                    }
                } catch (e) {
                    alert('Errore nel ripristino: ' + e.message);
                }
            }

            async function openAutosaveFolder() {
                if (!isDesktopApp()) { alert('Disponibile solo nell\'app desktop.'); return; }
                try { await fetch(projectApi('/api/autosave/open-folder')); }
                catch (e) { alert('Impossibile aprire la cartella: ' + e.message); }
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
