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
                // Capacita' (19-prefs.js): hasLocalBackend() = c'e' il server Python
                // (anche in modalita' web), hasNativeDialogs() = ci sono i dialog Qt.
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
                // I18N. Il markup nasce a load, cioe' PRIMA che bootI18n abbia il
                // dizionario: usare t() qui stamperebbe le chiavi. Si segue quindi la
                // stessa strada del template (data-i18n + testo italiano come
                // segnaposto) e si chiama applyI18n() sul nodo appena creato: pre-boot
                // e' un no-op (applyI18n scrive solo le chiavi che trova nel dizionario),
                // quindi l'italiano resta corretto anche se i locali non arrivano, e al
                // cambio lingua ci pensa applyI18n(document) di setLanguage().
                function buildLauncherDom() {
                    if (document.getElementById('launcherOverlay')) return;
                    const ov = document.createElement('div');
                    ov.id = 'launcherOverlay';
                    ov.setAttribute('role', 'dialog');
                    ov.innerHTML =
                        '<div class="launcher-card glass">' +
                          '<div class="launcher-logo">' +
                            '<div class="lg-icon">V</div>' +
                            '<div><div style="font-size:18px;font-weight:700;color:var(--text-primary);">Voxel AI Artist</div>' +
                            '<div style="font-size:11px;color:var(--accent-primary);">by KFDev</div></div>' +
                          '</div>' +
                          '<div style="font-size:13px;color:var(--text-secondary);margin:4px 0 16px;" data-i18n="launcher.subtitle">Riprendi un progetto recente o creane uno nuovo.</div>' +
                          '<div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:8px;" data-i18n="launcher.recentTitle">Progetti recenti</div>' +
                          '<div id="launcherRecentList" style="overflow-y:auto;flex:1;min-height:60px;max-height:320px;margin-bottom:14px;"></div>' +
                          '<div style="display:flex;gap:10px;margin-bottom:14px;">' +
                            '<button class="btn btn-primary" id="launcherNewBtn" style="flex:1;font-size:12px;padding:11px 6px;" title="Crea un nuovo progetto vuoto ed entra nella scena" data-i18n-title="launcher.newBtnTitle" data-i18n="launcher.newBtn">＋ Nuovo progetto</button>' +
                            '<button class="btn btn-secondary" id="launcherOpenBtn" style="flex:1;font-size:12px;padding:11px 6px;" title="Apri un progetto esistente (.voxai / .json / .vox / .schem)" data-i18n-title="launcher.openBtnTitle" data-i18n="launcher.openBtn">📂 Apri progetto…</button>' +
                          '</div>' +
                          '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--glass-border);padding-top:12px;">' +
                            '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);cursor:pointer;">' +
                              '<input type="checkbox" id="launcherShowOnStart" checked style="cursor:pointer;accent-color:var(--accent-primary);">' +
                              '<span data-i18n="launcher.showOnStart">Mostra questa schermata all\'avvio</span></label>' +
                            '<button class="btn btn-secondary" id="launcherSkipBtn" style="font-size:12px;padding:8px 16px;" title="Chiudi e vai alla scena corrente" data-i18n-title="launcher.skipTitle" data-i18n="launcher.skip">Salta</button>' +
                          '</div>' +
                        '</div>';
                    document.body.appendChild(ov);
                    if (typeof applyI18n === 'function') applyI18n(ov);

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
                    // aria-label: applyI18n non gestisce gli attributi ARIA, e qui siamo
                    // sicuramente dopo il boot i18n (il launcher si apre su interazione
                    // o dopo la lettura delle prefs).
                    ov.setAttribute('aria-label', t('launcher.dialogLabel'));
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
                            loadSceneFromParsed({ metadata: { name: t('newProject.defaultName'), grid_size: [16, 16, 16] }, voxels: [] });
                            if (typeof buildModel === 'function') buildModel();
                        }
                    } catch (e) { /* se fallisce restiamo sulla scena corrente */ }
                }

                // Clic su un recente. LIMITE: nessun endpoint "leggi da path", quindi con
                // i dialog nativi ripieghiamo su openProject() informando l'utente.
                async function openRecent(entry) {
                    hideLauncher();
                    if (!entry) return;
                    if (hasNativeDialogs()) {
                        if (typeof openProject === 'function') {
                            alert(t('launcher.selectInDialog', {
                                name: entry.name || entry.path || t('launcher.theProject'),
                                path: entry.path || ''
                            }));
                            try { await openProject(); } catch (e) { }
                        }
                        return;
                    }
                    // BROWSER: nessun dialog nativo, si usa comunque l'input file.
                    if (typeof openProject === 'function') { try { await openProject(); } catch (e) { } }
                }

                async function fetchRecent() {
                    if (!hasLocalBackend()) return [];
                    try {
                        const res = await fetch(screensApi('/api/recent'));
                        if (!res || !res.ok) return [];
                        const j = await res.json();
                        return (j && Array.isArray(j.recent)) ? j.recent : [];
                    } catch (e) { return []; }
                }

                async function deleteRecent(path) {
                    if (!hasLocalBackend() || !path) return;
                    try { await fetch(screensApi('/api/recent?path=' + encodeURIComponent(path)), { method: 'DELETE' }); }
                    catch (e) { /* best-effort */ }
                }

                function fmtRecentDate(iso) {
                    try { const d = new Date(iso); if (!isNaN(d.getTime())) return d.toLocaleString(uiLocale()); } catch (e) { }
                    return '';
                }

                // Nota tradotta: si scrive con textContent, non con innerHTML, perche'
                // le traduzioni contengono apostrofi e virgolette.
                function screensListNote(listEl, msg) {
                    listEl.innerHTML = '';
                    const note = document.createElement('div');
                    note.className = 'screens-section-note';
                    note.style.padding = '8px';
                    note.textContent = msg;
                    listEl.appendChild(note);
                }

                async function refreshLauncherRecent() {
                    const listEl = document.getElementById('launcherRecentList');
                    if (!listEl) return;
                    if (!hasLocalBackend()) {
                        screensListNote(listEl, t('launcher.recentNeedsApp'));
                        return;
                    }
                    screensListNote(listEl, t('common.loading'));
                    const items = await fetchRecent();
                    if (!items.length) {
                        screensListNote(listEl, t('launcher.recentEmpty'));
                        return;
                    }
                    listEl.innerHTML = '';
                    items.forEach(it => {
                        const row = document.createElement('div');
                        row.className = 'launcher-recent-item';
                        row.title = it.path || '';
                        const info = document.createElement('div');
                        info.style.cssText = 'overflow:hidden;';
                        const nm = it.name || (String(it.path || '').split(/[\\/]/).pop()) || t('launcher.projectFallback');
                        info.innerHTML = '<div style="font-size:13px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(nm) + '</div>' +
                            '<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(it.path || '') + (it.lastOpened ? ' · ' + fmtRecentDate(it.lastOpened) : '') + '</div>';
                        info.style.cursor = 'pointer';
                        info.addEventListener('click', () => openRecent(it));
                        const del = document.createElement('button');
                        del.className = 'launcher-recent-del';
                        del.textContent = '✕';
                        del.title = t('launcher.removeRecent');
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
                    // I18N: come il launcher, data-i18n + italiano come segnaposto
                    // (questa funzione gira a load, prima del dizionario).
                    wrap.innerHTML =
                        '<div class="section-title" data-i18n="screens.startup">Avvio</div>' +
                        '<div class="controls-group glass" style="padding:14px;display:flex;flex-direction:column;gap:10px;">' +
                          '<label class="control-row" style="cursor:pointer;">' +
                            '<span data-i18n="screens.showLauncher">Mostra la schermata iniziale all\'avvio</span>' +
                            '<label class="switch"><input type="checkbox" id="settingsShowLauncher" checked><span class="slider"></span></label>' +
                          '</label>' +
                          '<button class="btn btn-secondary" id="openLauncherBtn" style="font-size:12px;padding:9px;" title="Apri la schermata dei progetti recenti" data-i18n-title="screens.openLauncherTitle" data-i18n="screens.openLauncher">🗂 Apri schermata iniziale</button>' +
                        '</div>' +
                        '<div class="section-title" data-i18n="screens.saving">Salvataggio</div>' +
                        '<div class="controls-group glass" style="padding:14px;display:flex;flex-direction:column;gap:10px;">' +
                          '<div class="control-row">' +
                            '<label data-i18n="screens.defaultDir">Cartella di default (Salvataggio/Esportazione)</label>' +
                            '<div style="display:flex; gap:6px; flex:1;">' +
                               '<input type="text" id="settingsDefaultSaveDir" class="field-strong" style="flex:1; padding:6px; font-size:12px;" readonly placeholder="Predefinita (Appdata)" data-i18n-placeholder="screens.defaultDirPlaceholder">' +
                               '<button class="btn btn-primary" id="settingsChooseDirBtn" style="font-size:12px; padding:6px 12px;" data-i18n="common.browse">Sfoglia...</button>' +
                            '</div>' +
                          '</div>' +
                          '<div class="screens-section-note" data-i18n="screens.autosaveNote">I salvataggi automatici vengono conservati in una cartella dedicata dal backend Python (funziona sia in modalità web sia desktop).</div>' +
                          '<button class="btn btn-secondary" id="settingsOpenAutosaveFolderBtn" style="font-size:12px;padding:9px;" title="Apri la cartella dei salvataggi automatici" data-i18n-title="screens.openAutosaveFolderTitle" data-i18n="screens.openAutosaveFolder">📁 Apri cartella autosave</button>' +
                        '</div>';
                    viewPanel.appendChild(wrap);
                    if (typeof applyI18n === 'function') applyI18n(wrap);

                    const defaultSaveInput = document.getElementById('settingsDefaultSaveDir');
                    if (defaultSaveInput && typeof window.getPref === 'function') {
                        defaultSaveInput.value = window.getPref('default_save_dir', '');
                    }
                    const chooseDirBtn = document.getElementById('settingsChooseDirBtn');
                    if (chooseDirBtn) chooseDirBtn.addEventListener('click', async () => {
                        if (!hasNativeDialogs()) { alert(t('screens.chooseDirNeedsDesktop')); return; }
                        try {
                            const res = await fetch(screensApi('/api/settings/choose-dir'));
                            const data = await res.json().catch(() => ({}));
                            if (!res.ok || data.error) {
                                alert(t('screens.chooseDirError', { error: data.error || ('HTTP ' + res.status) }));
                                return;
                            }
                            if (data.folder) {
                                defaultSaveInput.value = data.folder;
                                if (typeof window.savePref === 'function') window.savePref('default_save_dir', data.folder);
                            }
                        } catch(e) {
                            console.error('Errore scelta cartella', e);
                            alert(t('screens.chooseDirFailed'));
                        }
                    });

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
                        if (!hasLocalBackend()) { alert(t('autosave.needsAppFolder')); return; }
                        try { await fetch(screensApi('/api/autosave/open-folder')); } catch (e) { }
                    });
                }

                /* ---------- 3. Toolbar/footer ----------
                 * RIMOSSA (2026-07-30): enhanceToolbar() cercava `.sidebar-footer`,
                 * eliminata quando export/salvataggio sono passati nei menu della barra
                 * in alto (WAVE3). Usciva sempre alla prima riga, quindi i tooltip che
                 * doveva aggiungere non sono mai comparsi: ora stanno nel template
                 * (data-i18n-title su #exportObjBtn / #exportMtlBtn). */

                /* ---------- Init: applica prefs e mostra il launcher all'avvio ---------- */
                injectStyles();
                buildLauncherDom();
                buildSettingsSections();

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
