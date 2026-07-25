            /* ===== T-screens: Launcher progetti recenti + Impostazioni + Toolbar ====
             * Questo modulo aggiunge tre migliorie di interfaccia SENZA toccare la
             * navigazione 3D, l'editing o la logica dei pulsanti esistenti:
             *
             *   1. Un launcher a tutto schermo mostrato all'avvio con i progetti
             *      recenti (GET /api/recent), "Nuovo progetto" e "Apri progetto…".
             *   2. Sezioni chiare nel pannello impostazioni (tab "Vista"): Aspetto,
             *      Salvataggio, Avvio (le Scorciatoie restano dove sono, intatte).
             *   3. Raggruppamento + tooltip italiani sulla toolbar/footer.
             *
             * RIUSO (niente reimplementazioni): openProject(), loadProjectData(),
             * pushRecent(), savePref()/loadPrefs(), applyTheme(), openAutosaveFolder(),
             * openAutosaveHistory(), loadSceneFromParsed(), buildModel().
             *
             * LIMITE NOTO (desktop): il backend NON espone una route "leggi file da
             * percorso"; /api/project/open apre solo il QFileDialog. Quindi il clic su
             * un recente NON può caricare direttamente quel path: ripiega su
             * openProject() (dialog nativo) segnalandolo all'utente.
             *
             * Tutto è avvolto in try/catch: se qualcosa fallisce, il bootstrap (18)
             * che gira DOPO questo modulo non deve mai rompersi. */

            (function initScreens() {
                function screensApi(route) {
                    return (window.__API_BASE__ ? window.__API_BASE__ : '') + route;
                }
                function screensIsDesktop() { return !!window.__IS_DESKTOP__; }
                const LAUNCHER_PREF_KEY = 'showLauncherOnStart';

                /* ---------- 0. Stili (hover/anim) iniettati una volta ---------- */
                function injectStyles() {
                    if (document.getElementById('screensStyles')) return;
                    const st = document.createElement('style');
                    st.id = 'screensStyles';
                    st.textContent = [
                        '#launcherOverlay{position:absolute;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:var(--overlay-scrim);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}',
                        '#launcherOverlay.visible{display:flex;}',
                        '.launcher-card{width:min(560px,92%);max-height:86%;display:flex;flex-direction:column;padding:26px;border-radius:var(--radius-lg);border:1px solid var(--glass-border);box-shadow:0 18px 60px rgba(0,0,0,0.5);}',
                        '.launcher-logo{display:flex;align-items:center;gap:12px;margin-bottom:6px;}',
                        '.launcher-logo .lg-icon{width:40px;height:40px;border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;color:var(--text-on-accent);background:linear-gradient(135deg,var(--accent-primary),var(--accent-secondary));}',
                        '.launcher-recent-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--glass-border);border-radius:var(--radius-md);margin-bottom:8px;cursor:pointer;transition:background .15s,border-color .15s;background:var(--input-bg);}',
                        '.launcher-recent-item:hover{background:var(--hover-bg-strong);border-color:var(--glass-border-focus);}',
                        '.launcher-recent-del{flex-shrink:0;border:none;background:transparent;color:var(--text-muted);cursor:pointer;font-size:16px;line-height:1;padding:4px 6px;border-radius:var(--radius-sm);}',
                        '.launcher-recent-del:hover{color:var(--danger);background:var(--hover-bg);}',
                        '.screens-section-note{font-size:11px;color:var(--text-muted);line-height:1.4;}'
                    ].join('\n');
                    document.head.appendChild(st);
                }

                /* ---------- 1. Launcher "Progetti recenti" ---------- */
                function buildLauncherDom() {
                    if (document.getElementById('launcherOverlay')) return;
                    const ov = document.createElement('div');
                    ov.id = 'launcherOverlay';
                    ov.setAttribute('role', 'dialog');
                    ov.setAttribute('aria-label', 'Apri o crea un progetto');
                    ov.innerHTML =
                        '<div class="launcher-card glass">' +
                          '<div class="launcher-logo">' +
                            '<div class="lg-icon">V</div>' +
                            '<div><div style="font-size:18px;font-weight:700;color:var(--text-primary);">Voxel AI Artist</div>' +
                            '<div style="font-size:11px;color:var(--accent-primary);">by KFDev</div></div>' +
                          '</div>' +
                          '<div style="font-size:13px;color:var(--text-secondary);margin:4px 0 16px;">Riprendi un progetto recente o creane uno nuovo.</div>' +
                          '<div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Progetti recenti</div>' +
                          '<div id="launcherRecentList" style="overflow-y:auto;flex:1;min-height:60px;max-height:320px;margin-bottom:14px;"></div>' +
                          '<div style="display:flex;gap:10px;margin-bottom:14px;">' +
                            '<button class="btn btn-primary" id="launcherNewBtn" style="flex:1;font-size:12px;padding:11px 6px;" title="Crea un nuovo progetto vuoto ed entra nella scena">＋ Nuovo progetto</button>' +
                            '<button class="btn btn-secondary" id="launcherOpenBtn" style="flex:1;font-size:12px;padding:11px 6px;" title="Apri un progetto esistente (.voxai / .json / .vox / .schem)">📂 Apri progetto…</button>' +
                          '</div>' +
                          '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--glass-border);padding-top:12px;">' +
                            '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);cursor:pointer;">' +
                              '<input type="checkbox" id="launcherShowOnStart" checked style="cursor:pointer;accent-color:var(--accent-primary);">' +
                              'Mostra questa schermata all\'avvio</label>' +
                            '<button class="btn btn-secondary" id="launcherSkipBtn" style="font-size:12px;padding:8px 16px;" title="Chiudi e vai alla scena corrente">Salta</button>' +
                          '</div>' +
                        '</div>';
                    document.body.appendChild(ov);

                    // Chiude cliccando fuori dalla card.
                    ov.addEventListener('click', (e) => { if (e.target === ov) hideLauncher(); });
                    const newBtn = document.getElementById('launcherNewBtn');
                    if (newBtn) newBtn.addEventListener('click', () => { launcherNewProject(); hideLauncher(); });
                    const openBtn = document.getElementById('launcherOpenBtn');
                    if (openBtn) openBtn.addEventListener('click', async () => {
                        hideLauncher();
                        if (typeof openProject === 'function') { try { await openProject(); } catch (e) { } }
                    });
                    const skipBtn = document.getElementById('launcherSkipBtn');
                    if (skipBtn) skipBtn.addEventListener('click', () => hideLauncher());
                    const showChk = document.getElementById('launcherShowOnStart');
                    if (showChk) showChk.addEventListener('change', () => {
                        const val = !!showChk.checked;
                        if (typeof savePref === 'function') { try { savePref(LAUNCHER_PREF_KEY, val); } catch (e) { } }
                        syncLauncherPrefControls(val);
                    });
                }

                function showLauncher() {
                    const ov = document.getElementById('launcherOverlay');
                    if (!ov) return;
                    ov.classList.add('visible');
                    refreshLauncherRecent();
                }
                function hideLauncher() {
                    const ov = document.getElementById('launcherOverlay');
                    if (ov) ov.classList.remove('visible');
                }

                // Nuovo progetto: scena vuota. Riusa loadSceneFromParsed+buildModel come
                // il pulsante "Nuovo" esistente, senza duplicarne il markup.
                function launcherNewProject() {
                    try {
                        if (typeof loadSceneFromParsed === 'function') {
                            loadSceneFromParsed({ metadata: { name: 'Nuovo_Modello', grid_size: [16, 16, 16] }, voxels: [] });
                            if (typeof buildModel === 'function') buildModel();
                        }
                    } catch (e) { /* se fallisce restiamo sulla scena corrente */ }
                }

                // Clic su un recente. LIMITE: nessun endpoint "leggi da path", quindi in
                // desktop ripieghiamo sul dialog nativo (openProject) informando l'utente.
                async function openRecent(entry) {
                    hideLauncher();
                    if (!entry) return;
                    if (screensIsDesktop()) {
                        if (typeof openProject === 'function') {
                            alert('Seleziona "' + (entry.name || entry.path || 'il progetto') + '" nella finestra che sta per aprirsi.\n\n(Percorso: ' + (entry.path || '') + ')');
                            try { await openProject(); } catch (e) { }
                        }
                        return;
                    }
                    // WEB: nessun accesso al filesystem, si usa comunque l'input file.
                    if (typeof openProject === 'function') { try { await openProject(); } catch (e) { } }
                }

                async function fetchRecent() {
                    if (!screensIsDesktop()) return [];
                    try {
                        const res = await fetch(screensApi('/api/recent'));
                        if (!res || !res.ok) return [];
                        const j = await res.json();
                        return (j && Array.isArray(j.recent)) ? j.recent : [];
                    } catch (e) { return []; }
                }

                async function deleteRecent(path) {
                    if (!screensIsDesktop() || !path) return;
                    try { await fetch(screensApi('/api/recent?path=' + encodeURIComponent(path)), { method: 'DELETE' }); }
                    catch (e) { /* best-effort */ }
                }

                function fmtRecentDate(iso) {
                    try { const d = new Date(iso); if (!isNaN(d.getTime())) return d.toLocaleString('it-IT'); } catch (e) { }
                    return '';
                }

                async function refreshLauncherRecent() {
                    const listEl = document.getElementById('launcherRecentList');
                    if (!listEl) return;
                    if (!screensIsDesktop()) {
                        listEl.innerHTML = '<div class="screens-section-note" style="padding:8px;">In modalità web i progetti recenti non sono disponibili. Usa "Apri progetto…".</div>';
                        return;
                    }
                    listEl.innerHTML = '<div class="screens-section-note" style="padding:8px;">Caricamento…</div>';
                    const items = await fetchRecent();
                    if (!items.length) {
                        listEl.innerHTML = '<div class="screens-section-note" style="padding:8px;">Nessun progetto recente. Creane uno nuovo o aprine uno esistente.</div>';
                        return;
                    }
                    listEl.innerHTML = '';
                    items.forEach(it => {
                        const row = document.createElement('div');
                        row.className = 'launcher-recent-item';
                        row.title = it.path || '';
                        const info = document.createElement('div');
                        info.style.cssText = 'overflow:hidden;';
                        const nm = it.name || (String(it.path || '').split(/[\\/]/).pop()) || 'Progetto';
                        info.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(nm) + '</div>' +
                            '<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(it.path || '') + (it.lastOpened ? ' · ' + fmtRecentDate(it.lastOpened) : '') + '</div>';
                        info.style.cursor = 'pointer';
                        info.addEventListener('click', () => openRecent(it));
                        const del = document.createElement('button');
                        del.className = 'launcher-recent-del';
                        del.textContent = '✕';
                        del.title = 'Rimuovi dai recenti';
                        del.addEventListener('click', async (e) => { e.stopPropagation(); await deleteRecent(it.path); refreshLauncherRecent(); });
                        row.appendChild(info);
                        row.appendChild(del);
                        listEl.appendChild(row);
                    });
                }

                function escapeHtml(s) {
                    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
                }

                function syncLauncherPrefControls(val) {
                    const chk = document.getElementById('launcherShowOnStart');
                    if (chk) chk.checked = !!val;
                    const settingsChk = document.getElementById('settingsShowLauncher');
                    if (settingsChk) settingsChk.checked = !!val;
                }

                /* ---------- 2. Impostazioni: sezioni + Avvio ----------
                 * NON rinominiamo/spostiamo id esistenti. Aggiungiamo solo una nuova
                 * sezione "Avvio" (checkbox launcher) e una scorciatoia "Apri cartella
                 * autosave" in fondo al tab Vista, riusando i comportamenti esistenti.
                 * Il toggle tema e il pannello Scorciatoie (T6) NON vengono toccati. */
                function buildSettingsSections() {
                    // WAVE3: le sezioni Avvio/Salvataggio ora vivono nella modale Impostazioni
                    // (#settingsExtraSections). Fallback al vecchio tab Vista se assente.
                    const viewPanel = document.getElementById('settingsExtraSections')
                        || document.querySelector('.tab-panel[data-panel="view"]');
                    if (!viewPanel || document.getElementById('startupSettingsSection')) return;

                    const wrap = document.createElement('div');
                    wrap.id = 'startupSettingsSection';
                    wrap.innerHTML =
                        '<div class="section-title">Avvio</div>' +
                        '<div class="controls-group glass" style="padding:14px;display:flex;flex-direction:column;gap:10px;">' +
                          '<label class="control-row" style="cursor:pointer;">' +
                            '<span>Mostra la schermata iniziale all\'avvio</span>' +
                            '<label class="switch"><input type="checkbox" id="settingsShowLauncher" checked><span class="slider"></span></label>' +
                          '</label>' +
                          '<button class="btn btn-secondary" id="openLauncherBtn" style="font-size:12px;padding:9px;" title="Apri la schermata dei progetti recenti">🗂 Apri schermata iniziale</button>' +
                        '</div>' +
                        '<div class="section-title">Salvataggio</div>' +
                        '<div class="controls-group glass" style="padding:14px;display:flex;flex-direction:column;gap:10px;">' +
                          '<div class="screens-section-note">I salvataggi automatici vengono conservati in una cartella dedicata (solo desktop).</div>' +
                          '<button class="btn btn-secondary" id="settingsOpenAutosaveFolderBtn" style="font-size:12px;padding:9px;" title="Apri la cartella dei salvataggi automatici">📁 Apri cartella autosave</button>' +
                        '</div>';
                    viewPanel.appendChild(wrap);

                    const settingsChk = document.getElementById('settingsShowLauncher');
                    if (settingsChk) settingsChk.addEventListener('change', () => {
                        const val = !!settingsChk.checked;
                        if (typeof savePref === 'function') { try { savePref(LAUNCHER_PREF_KEY, val); } catch (e) { } }
                        syncLauncherPrefControls(val);
                    });
                    const openLauncherBtn = document.getElementById('openLauncherBtn');
                    if (openLauncherBtn) openLauncherBtn.addEventListener('click', () => showLauncher());
                    // Riusa openAutosaveFolder() di 21-project.js se disponibile, altrimenti la route diretta.
                    const folderBtn = document.getElementById('settingsOpenAutosaveFolderBtn');
                    if (folderBtn) folderBtn.addEventListener('click', async () => {
                        if (typeof openAutosaveFolder === 'function') { try { await openAutosaveFolder(); } catch (e) { } return; }
                        if (!screensIsDesktop()) { alert('Disponibile solo nell\'app desktop.'); return; }
                        try { await fetch(screensApi('/api/autosave/open-folder')); } catch (e) { }
                    });

                    // Raggruppamento visivo (non funzionale) del pannello Scorciatoie T6:
                    // gli anteponiamo un titolo di sezione senza spostarlo né toccarne gli id.
                    try {
                        const sc = document.getElementById('shortcutsPanel');
                        if (sc && sc.parentElement && !sc.parentElement.dataset.scGrouped) {
                            const prev = sc.parentElement.previousElementSibling;
                            // Il titolo "Scorciatoie da tastiera" esiste già nel template; niente da fare.
                            sc.parentElement.dataset.scGrouped = '1';
                        }
                    } catch (e) { }
                }

                /* ---------- 3. Toolbar/footer: raggruppamento + tooltip ----------
                 * Riusa gli id e i listener esistenti: NON ricabliamo la logica dei
                 * pulsanti. Aggiungiamo solo etichette di gruppo e tooltip (title) dove
                 * mancano. Lo stato attivo degli strumenti è già gestito da setTool(). */
                function enhanceToolbar() {
                    const footer = document.querySelector('.sidebar-footer');
                    if (!footer || footer.dataset.grouped) return;
                    footer.dataset.grouped = '1';

                    function groupLabel(text) {
                        const d = document.createElement('div');
                        d.className = 'screens-toolbar-group';
                        d.textContent = text;
                        d.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-muted);margin:6px 0 2px;';
                        return d;
                    }
                    // Etichetta "Progetto" davanti al blocco salva/apri (primo figlio).
                    const first = footer.firstElementChild;
                    if (first) footer.insertBefore(groupLabel('Progetto'), first);
                    // Etichetta "File / Export" prima del primo btn-group (export OBJ/MTL).
                    const firstBtnGroup = footer.querySelector('.btn-group');
                    if (firstBtnGroup) footer.insertBefore(groupLabel('File / Export'), firstBtnGroup);

                    // Tooltip di rinforzo (solo se assenti) sui pulsanti principali.
                    const tips = {
                        savePlainJsonBtn: 'Salva la scena come file JSON in chiaro (.json)',
                        exportMtlBtn: 'Esporta il file materiali (.mtl) da affiancare all\'OBJ',
                        exportObjBtn: 'Esporta la mesh in Wavefront OBJ (con MTL)',
                        exportGlbBtn: 'Esporta GLB con scheletro e animazioni (Blender/Unity/Godot)'
                    };
                    Object.keys(tips).forEach(id => {
                        const el = document.getElementById(id);
                        if (el && !el.getAttribute('title')) el.setAttribute('title', tips[id]);
                    });
                }

                /* ---------- Init: applica prefs e mostra il launcher all'avvio ---------- */
                injectStyles();
                buildLauncherDom();
                buildSettingsSections();
                enhanceToolbar();

                (async function initLauncherPref() {
                    let show = true; // default: mostra
                    try {
                        if (typeof loadPrefs === 'function') {
                            const prefs = await loadPrefs();
                            if (prefs && Object.prototype.hasOwnProperty.call(prefs, LAUNCHER_PREF_KEY)) {
                                show = !!prefs[LAUNCHER_PREF_KEY];
                            }
                        }
                    } catch (e) { /* fallback: mostra */ }
                    syncLauncherPrefControls(show);
                    if (show) showLauncher();
                })();

                // Esponi un minimo di API per riapertura da altri punti (es. menu).
                window.openProjectLauncher = showLauncher;
            })();
