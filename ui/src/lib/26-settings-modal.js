            /* ===== WAVE3: Barra superiore (menu) + Modale Impostazioni ============
             * - Gestisce i dropdown della top-bar (apri/chiudi, chiusura on outside-click).
             * - Cabla i pulsanti Import verso i controlli esistenti (#fileInput, incolla).
             * - Apre/chiude la modale Impostazioni e gestisce i controlli nuovi: tema
             *   (segmented, sincronizzato col toggle legacy), carattere e dimensione testo
             *   (variabili CSS --ui-font / --ui-font-size + persistenza via savePref).
             * NON tocca gli id/listener esistenti dei pulsanti export/save/progetto: sono
             * stati solo spostati nel DOM (dentro i dropdown) e continuano a funzionare. */

            /* ---------- Dropdown della top-bar ---------- */
            (function initTopbarMenus() {
                const menus = Array.prototype.slice.call(document.querySelectorAll('.topbar .menu'));
                function closeAll(except) {
                    menus.forEach(m => { if (m !== except) m.classList.remove('open'); });
                }
                menus.forEach(menu => {
                    const trigger = menu.querySelector('[data-menu-toggle]');
                    if (!trigger) return;
                    trigger.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const willOpen = !menu.classList.contains('open');
                        closeAll(menu);
                        menu.classList.toggle('open', willOpen);
                    });
                    // Un clic su una voce del menu lo richiude (i listener reali dei pulsanti
                    // partono comunque perché sono attaccati per id).
                    menu.querySelectorAll('.menu-item').forEach(item => {
                        item.addEventListener('click', () => menu.classList.remove('open'));
                    });
                });
                // Clic fuori o Esc chiudono tutti i menu.
                document.addEventListener('click', () => closeAll(null));
                document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(null); });
            })();

            /* ---------- Cablaggio pulsanti Import ---------- */
            (function wireImport() {
                const importFileBtn = document.getElementById('importFileBtn');
                if (importFileBtn) importFileBtn.addEventListener('click', () => {
                    const fi = document.getElementById('fileInput');
                    if (fi) fi.click();
                });
                const importPasteBtn = document.getElementById('importPasteBtn');
                if (importPasteBtn) importPasteBtn.addEventListener('click', () => {
                    // Porta l'utente nel tab Genera e apre l'area "Incolla JSON" esistente.
                    const genTab = document.querySelector('.tab-btn[data-tab="generate"]');
                    if (genTab) genTab.click();
                    const toggle = document.getElementById('togglePasteBtn');
                    if (toggle) toggle.click();
                });
            })();

            /* ---------- Modale Impostazioni: apri/chiudi ---------- */
            (function initSettingsModal() {
                const overlay = document.getElementById('settingsOverlay');
                const openBtn = document.getElementById('openSettingsBtn');
                const closeBtn = document.getElementById('settingsCloseBtn');
                if (!overlay) return;
                function open() { overlay.style.display = 'flex'; }
                function close() { overlay.style.display = 'none'; }
                if (openBtn) openBtn.addEventListener('click', open);
                if (closeBtn) closeBtn.addEventListener('click', close);
                overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && overlay.style.display === 'flex') close();
                });
            })();

            /* ---------- Tema: segmented sincronizzato col toggle legacy ---------- */
            (function initThemeSegmented() {
                const seg = document.getElementById('themeModes');
                if (!seg) return;
                function sync() {
                    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
                    seg.querySelectorAll('[data-theme-opt]').forEach(b =>
                        b.classList.toggle('active', b.dataset.themeOpt === cur));
                }
                seg.querySelectorAll('[data-theme-opt]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const next = btn.dataset.themeOpt === 'light' ? 'light' : 'dark';
                        if (typeof applyTheme === 'function') applyTheme(next);
                        if (typeof savePref === 'function') savePref('theme', next);
                        sync();
                    });
                });
                sync();
            })();

            /* ---------- Carattere e dimensione testo ---------- */
            (function initTypography() {
                const fontSel = document.getElementById('fontSelect');
                const sizeRange = document.getElementById('fontSizeRange');

                function applyFont(v) {
                    if (v) document.documentElement.style.setProperty('--ui-font', v);
                }
                function applyFontSize(px) {
                    const n = parseInt(px, 10);
                    if (n >= 10 && n <= 24) document.documentElement.style.setProperty('--ui-font-size', n + 'px');
                }

                if (fontSel) fontSel.addEventListener('change', () => {
                    applyFont(fontSel.value);
                    if (typeof savePref === 'function') savePref('font', fontSel.value);
                });
                if (sizeRange) sizeRange.addEventListener('input', () => {
                    applyFontSize(sizeRange.value);
                    if (typeof savePref === 'function') savePref('fontSize', parseInt(sizeRange.value, 10));
                });

                // Ripristina preferenze salvate all'avvio (best-effort, async).
                (async function restore() {
                    if (typeof loadPrefs !== 'function') return;
                    let prefs = {};
                    try { prefs = await loadPrefs(); } catch (e) { return; }
                    if (!prefs || typeof prefs !== 'object') return;
                    if (prefs.font) { applyFont(prefs.font); if (fontSel) fontSel.value = prefs.font; }
                    if (prefs.fontSize) { applyFontSize(prefs.fontSize); if (sizeRange) sizeRange.value = prefs.fontSize; }
                })();
            })();

            /* ---------- Colore accento ---------- */
            (function initAccentPicker() {
                const presets = document.getElementById('accentPresets');
                const colorInput = document.getElementById('accentColorInput');
                if (!presets && !colorInput) return;

                // Riflette il colore corrente su input + evidenzia il preset che combacia.
                function sync(hex) {
                    const norm = String(hex || '').toLowerCase();
                    if (colorInput && norm) colorInput.value = norm;
                    if (presets) {
                        presets.querySelectorAll('.accent-swatch').forEach(b =>
                            b.classList.toggle('active', (b.dataset.accent || '').toLowerCase() === norm));
                    }
                }
                function set(hex) {
                    if (typeof applyAccent !== 'function') return;
                    if (!applyAccent(hex)) return;            // ignora hex non validi
                    if (typeof savePref === 'function') savePref('accent', hex);
                    sync(hex);
                }

                if (presets) {
                    presets.querySelectorAll('.accent-swatch').forEach(btn => {
                        btn.addEventListener('click', () => set(btn.dataset.accent));
                    });
                }
                if (colorInput) {
                    colorInput.addEventListener('input', () => set(colorInput.value));
                }

                // Stato iniziale dal valore già applicato da initAccent() (17-theme.js).
                let cur = '#475569';
                try { cur = localStorage.getItem('voxelai-accent') || cur; } catch (e) { }
                sync(cur);

                // Ripristino async dal backend prefs (se presente, ha la precedenza).
                (async function restore() {
                    if (typeof loadPrefs !== 'function') return;
                    let prefs = {};
                    try { prefs = await loadPrefs(); } catch (e) { return; }
                    if (prefs && typeof prefs === 'object' && prefs.accent) {
                        if (typeof applyAccent === 'function' && applyAccent(prefs.accent)) sync(prefs.accent);
                    }
                })();
            })();

            /* ---------- Ridimensionamento pannello destro ---------- */
            (function initRightResizer() {
                const rr = document.getElementById('rightResizer');
                if (!rr) return;
                let dragging = false;
                rr.addEventListener('mousedown', (e) => {
                    dragging = true;
                    rr.classList.add('dragging');
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                    e.preventDefault();
                });
                window.addEventListener('mousemove', (e) => {
                    if (!dragging) return;
                    // Il pannello è ancorato a destra: la larghezza cresce verso sinistra.
                    const w = Math.max(260, Math.min(window.innerWidth - 50, window.innerWidth - e.clientX));
                    document.documentElement.style.setProperty('--rightpanel-width', w + 'px');
                    if (typeof resizeCanvas === 'function') resizeCanvas();
                });
                window.addEventListener('mouseup', () => {
                    if (!dragging) return;
                    dragging = false;
                    rr.classList.remove('dragging');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                });
            })();
