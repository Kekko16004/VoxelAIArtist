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
                function open(opts) {
                    overlay.style.display = 'flex';
                    // Apertura mirata su una sezione (es. i cookie al primo avvio).
                    const id = opts && opts.section;
                    if (!id) return;
                    const target = document.getElementById(id);
                    if (!target) return;
                    // Il body della modale scrolla: portiamo la sezione in vista dopo
                    // che il layout e' stato calcolato.
                    requestAnimationFrame(() => {
                        try { target.scrollIntoView({ block: 'start' }); } catch (e) { }
                    });
                }
                function close() { overlay.style.display = 'none'; }
                // Esposta perche' altri moduli (gestione sessione Gemini) devono poter
                // aprire la modale su una sezione precisa.
                window.openSettingsModal = open;
                if (openBtn) openBtn.addEventListener('click', () => open());
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
                let cur = '#E8A317';
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

            /* ===== Sessione Gemini (cookie) ====================================
             * Porta nella modale Impostazioni tutto quello che prima viveva nella
             * pagina separata ui/settings.html: stato della sessione, incolla/salva,
             * rimozione, apertura della cartella impostazioni (solo desktop) e
             * apertura automatica al primo avvio se la sessione manca.
             *
             * REGOLA DI SICUREZZA: i valori dei cookie non vengono MAI loggati,
             * stampati in console o salvati altrove. Escono da qui solo dentro il
             * body della POST /api/settings/cookies; nella UI si mostra al massimo
             * una coda mascherata (ultimi 4 caratteri) tenuta solo in memoria. */
            (function initCookieSettings() {
                const section = document.getElementById('settingsCookiesSection');
                if (!section) return;

                const dot = document.getElementById('cookieStatusDot');
                const label = document.getElementById('cookieStatusLabel');
                const sub = document.getElementById('cookieStatusSub');
                const hint = document.getElementById('cookieFirstRunHint');
                const feedback = document.getElementById('cookieFeedback');
                const pathInfo = document.getElementById('cookiePathInfo');
                const psidInput = document.getElementById('cookiePsidInput');
                const psidTsInput = document.getElementById('cookiePsidTsInput');
                const rawInput = document.getElementById('cookieRawInput');
                const saveBtn = document.getElementById('cookieSaveBtn');
                const fileBtn = document.getElementById('cookieFileBtn');
                const fileInput = document.getElementById('cookieFileInput');
                const folderBtn = document.getElementById('cookieOpenFolderBtn');
                const deleteBtn = document.getElementById('cookieDeleteBtn');
                const refreshBtn = document.getElementById('cookieRefreshBtn');

                const OK_COLOR = '#22c55e';
                const KO_COLOR = 'var(--danger, #ef4444)';
                const UNKNOWN_COLOR = 'var(--text-muted, #9ca3af)';
                const PRIMARY_KEY = '__Secure-1PSID';
                const SECONDARY_KEY = '__Secure-1PSIDTS';

                let maskedTail = '';          // solo in memoria, mai persistita
                let promptedFirstRun = false;

                /* --- COOKIE_SECTION_PLACEHOLDER --- */

                function api(route) { return (window.__API_BASE__ ? window.__API_BASE__ : '') + route; }
                // Capacita' del backend: vedi hasLocalBackend()/hasNativeDialogs() in
                // 19-prefs.js. Qui serve solo sapere se c'e' un backend da interrogare.

                // Ogni testo passa da t(). Nessun ripiego italiano hardcoded qui: i
                // dizionari si caricano in async e finche' non ci sono t() rende la
                // CHIAVE nuda, che e' il comportamento documentato (vedi 23-i18n.js).
                // Duplicare it.json in questo file lo faceva anche divergere in
                // silenzio quando una traduzione veniva corretta da una parte sola.
                function tr(key, vars) {
                    return (typeof t === 'function') ? t(key, vars) : key;
                }

                // Mostra solo che il cookie c'e': gli ultimi 4 caratteri, nient'altro.
                function maskTail(value) {
                    const s = String(value == null ? '' : value);
                    if (!s) return '';
                    return '****' + (s.length > 4 ? s.slice(-4) : '');
                }

                // Normalizza le forme accettate da src/settings.py: dizionario
                // {nome: valore} oppure lista [{name, value}] (export Cookie-Editor).
                function normalizeCookies(data) {
                    const out = {};
                    if (Array.isArray(data)) {
                        data.forEach(c => {
                            if (c && typeof c === 'object' && c.name && typeof c.value === 'string') out[c.name] = c.value;
                        });
                    } else if (data && typeof data === 'object') {
                        const list = Array.isArray(data.cookies) ? data.cookies : null;
                        if (list) {
                            list.forEach(c => {
                                if (c && typeof c === 'object' && c.name && typeof c.value === 'string') out[c.name] = c.value;
                            });
                        } else {
                            Object.keys(data).forEach(k => {
                                const v = data[k];
                                if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
                            });
                        }
                    }
                    return Object.keys(out).length ? out : null;
                }

                // Accetta un JSON (oggetto/lista) oppure la stringa completa dell'header
                // Cookie ("nome=valore; nome2=valore2") copiata dal browser.
                function parseCookieBlob(text) {
                    const s = String(text || '').trim();
                    if (!s) return null;
                    if (s[0] === '{' || s[0] === '[') {
                        let data = null;
                        try { data = JSON.parse(s); } catch (e) { return null; }
                        return normalizeCookies(data);
                    }
                    const out = {};
                    s.split(/[;\n]+/).forEach(part => {
                        const i = part.indexOf('=');
                        if (i <= 0) return;
                        const name = part.slice(0, i).trim();
                        const value = part.slice(i + 1).trim();
                        if (name && value) out[name] = value;
                    });
                    return Object.keys(out).length ? out : null;
                }

                function showFeedback(msg, kind) {
                    if (!feedback) return;
                    feedback.textContent = msg;
                    feedback.style.display = 'block';
                    if (kind === 'ok') {
                        feedback.style.background = 'rgba(34,197,94,0.10)';
                        feedback.style.border = '1px solid rgba(34,197,94,0.30)';
                        feedback.style.color = OK_COLOR;
                    } else if (kind === 'error') {
                        feedback.style.background = 'rgba(239,68,68,0.10)';
                        feedback.style.border = '1px solid rgba(239,68,68,0.30)';
                        feedback.style.color = KO_COLOR;
                    } else {
                        feedback.style.background = 'var(--input-bg)';
                        feedback.style.border = '1px solid var(--glass-border)';
                        feedback.style.color = 'var(--text-secondary)';
                    }
                }
                function clearFeedback() { if (feedback) feedback.style.display = 'none'; }

                // /api/settings puo' non esporre la data di salvataggio: proviamo i nomi
                // noti e, se non c'e' nulla, lo diciamo invece di inventare una data.
                function savedAtText(data) {
                    if (!data) return '';
                    const raw = data.cookies_saved_at || data.cookiesSavedAt || data.cookies_mtime
                        || data.cookiesModified || data.saved_at || data.savedAt;
                    if (!raw) return '';
                    const d = (typeof raw === 'number')
                        ? new Date(raw > 1e12 ? raw : raw * 1000)
                        : new Date(String(raw));
                    if (isNaN(d.getTime())) return String(raw);
                    try { return d.toLocaleString(); } catch (e) { return d.toISOString(); }
                }

                function hasCookies(data) {
                    if (!data) return false;
                    if (typeof data.has_cookies === 'boolean') return data.has_cookies;
                    if (typeof data.hasCookies === 'boolean') return data.hasCookies;
                    if (typeof data.needsCookies === 'boolean') return !data.needsCookies;
                    return Number(data.cookie_count || 0) > 0;
                }

                // needsCookies e' il campo nuovo del backend; se manca ricadiamo su
                // quello che la risposta espone gia' sulla presenza dei cookie.
                function needsCookies(data) {
                    if (!data) return false;                    // backend assente: non insistiamo
                    // Chi ha configurato un provider a chiave API NON usa i cookie:
                    // aprirgli la modale a ogni avvio per una sessione Gemini che non
                    // gli serve sarebbe un promemoria di sistemare la cosa sbagliata.
                    if (data.provider && data.provider.usesCookies === false) return false;
                    if (typeof data.needsCookies === 'boolean') return data.needsCookies;
                    return !hasCookies(data);
                }

                function renderStatus(data) {
                    const ok = hasCookies(data);
                    if (dot) dot.style.background = ok ? OK_COLOR : KO_COLOR;
                    if (label) label.textContent = tr(ok ? 'settings.sessionOn' : 'settings.sessionOff');
                    const bits = [];
                    if (ok) {
                        const n = Number(data && data.cookie_count);
                        if (n > 0) bits.push(tr('settings.sessionCount', { count: n }));
                        const when = savedAtText(data);
                        bits.push(when ? tr('settings.sessionSavedAt', { date: when })
                            : tr('settings.sessionSavedUnknown'));
                        if (maskedTail) bits.push(tr('settings.sessionMasked', { mask: maskedTail }));
                    } else {
                        bits.push(tr('settings.sessionOffHint'));
                    }
                    if (sub) sub.textContent = bits.join(' - ');
                    const dir = (data && (data.appdata_dir || data.cookies_path)) || '';
                    if (pathInfo) pathInfo.textContent = dir ? tr('settings.sessionPathLabel', { path: dir }) : '';
                }

                function renderOffline() {
                    if (dot) dot.style.background = UNKNOWN_COLOR;
                    if (label) label.textContent = tr('settings.sessionUnknown');
                    if (sub) sub.textContent = tr('settings.sessionOffline');
                    if (pathInfo) pathInfo.textContent = '';
                }

                async function refresh() {
                    try {
                        const res = await fetch(api('/api/settings'), { cache: 'no-store' });
                        if (!res.ok) { renderOffline(); return null; }
                        const data = await res.json();
                        renderStatus(data);
                        return data;
                    } catch (e) {
                        renderOffline();     // offline / anteprima statica: nessun crash
                        return null;
                    }
                }

                function collect() {
                    const merged = parseCookieBlob(rawInput ? rawInput.value : '') || {};
                    const psid = psidInput ? psidInput.value.trim() : '';
                    const psidTs = psidTsInput ? psidTsInput.value.trim() : '';
                    if (psid) merged[PRIMARY_KEY] = psid;
                    if (psidTs) merged[SECONDARY_KEY] = psidTs;
                    return Object.keys(merged).length ? merged : null;
                }

                function clearInputs() {
                    if (psidInput) psidInput.value = '';
                    if (psidTsInput) psidTsInput.value = '';
                    if (rawInput) rawInput.value = '';
                }

                async function postCookies(payload) {
                    const keys = Object.keys(payload);
                    const tail = maskTail(payload[PRIMARY_KEY] || payload[keys[0]]);
                    if (saveBtn) saveBtn.disabled = true;
                    showFeedback(tr('settings.sessionSaving'), 'info');
                    try {
                        const res = await fetch(api('/api/settings/cookies'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const out = await res.json().catch(() => ({}));
                        if (!res.ok || out.error || out.ok === false) {
                            showFeedback(tr('settings.sessionSaveError',
                                { error: out.error || ('HTTP ' + res.status) }), 'error');
                            return false;
                        }
                        maskedTail = tail;
                        clearInputs();                    // i valori non restano nel DOM
                        if (hint) hint.style.display = 'none';
                        showFeedback(tr('settings.sessionSaveOk'), 'ok');
                        await refresh();
                        return true;
                    } catch (e) {
                        // Nessun console.log qui: la richiesta contiene i cookie.
                        showFeedback(tr('settings.sessionSaveNet'), 'error');
                        return false;
                    } finally {
                        if (saveBtn) saveBtn.disabled = false;
                    }
                }

                if (saveBtn) saveBtn.addEventListener('click', () => {
                    const payload = collect();
                    if (!payload) { showFeedback(tr('settings.sessionEmpty'), 'error'); return; }
                    postCookies(payload);
                });

                if (fileBtn && fileInput) fileBtn.addEventListener('click', () => fileInput.click());
                if (fileInput) fileInput.addEventListener('change', async (e) => {
                    const file = e.target.files && e.target.files[0];
                    e.target.value = '';
                    if (!file) return;
                    let payload = null;
                    try { payload = normalizeCookies(JSON.parse(await file.text())); } catch (err) { payload = null; }
                    if (!payload) { showFeedback(tr('settings.sessionBadFile'), 'error'); return; }
                    postCookies(payload);
                });

                if (deleteBtn) deleteBtn.addEventListener('click', async () => {
                    if (!confirm(tr('settings.sessionDeleteConfirm'))) return;
                    try {
                        const res = await fetch(api('/api/settings/cookies'), { method: 'DELETE' });
                        const out = await res.json().catch(() => ({}));
                        if (!res.ok || out.error) {
                            showFeedback(tr('settings.sessionDeleteError',
                                { error: out.error || ('HTTP ' + res.status) }), 'error');
                            return;
                        }
                        maskedTail = '';
                        showFeedback(tr('settings.sessionDeleteOk'), 'ok');
                        await refresh();
                    } catch (err) {
                        showFeedback(tr('settings.sessionDeleteError',
                            { error: tr('settings.sessionOffline') }), 'error');
                    }
                });

                // "Apri cartella impostazioni" chiede al BACKEND di aprire Explorer: il
                // server e' locale, quindi funziona anche in modalita' web. Serve solo
                // che il backend ci sia (aperta come file:// non c'e' nessuno da chiamare).
                if (folderBtn) {
                    if (typeof hasLocalBackend === 'function' && !hasLocalBackend()) {
                        folderBtn.style.display = 'none';
                    } else {
                        folderBtn.addEventListener('click', async () => {
                            try {
                                const res = await fetch(api('/api/settings/open-folder'));
                                if (!res.ok) showFeedback(tr('settings.sessionFolderError'), 'error');
                            } catch (e) { showFeedback(tr('settings.sessionFolderError'), 'error'); }
                        });
                    }
                }

                if (refreshBtn) refreshBtn.addEventListener('click', () => { clearFeedback(); refresh(); });

                // PRIMO AVVIO: il launcher Python non apre piu' nessuna pagina di
                // impostazioni. Se manca la sessione apriamo noi la modale, UNA volta,
                // direttamente sulla sezione dei cookie e con il suggerimento visibile.
                (async function bootCookieStatus() {
                    const data = await refresh();
                    if (!data || promptedFirstRun || !needsCookies(data)) return;
                    promptedFirstRun = true;
                    if (hint) hint.style.display = 'block';
                    if (typeof window.openSettingsModal === 'function') {
                        window.openSettingsModal({ section: 'settingsCookiesSection' });
                    }
                })();

            })();

            /* ============================================================
               PROVIDER AI — elenco, scelta dell'attivo, form, prova, elimina.
               Gemini a cookie e' la prima riga dell'elenco ed e' SINTETICA (la
               manda il server, non sta nel registro): non si puo' modificare
               ne' eliminare, cosi' la via a configurazione zero non si perde
               nemmeno per sbaglio.
               ============================================================ */
            (function initProviderSettings() {
                const section = document.getElementById('settingsProvidersSection');
                if (!section) return;

                const listEl = document.getElementById('providerList');
                const addBtn = document.getElementById('providerAddBtn');
                const form = document.getElementById('providerForm');
                const formTitle = document.getElementById('providerFormTitle');
                const typeSelect = document.getElementById('providerTypeSelect');
                const labelInput = document.getElementById('providerLabelInput');
                const baseUrlRow = document.getElementById('providerBaseUrlRow');
                const baseUrlInput = document.getElementById('providerBaseUrlInput');
                const modelInput = document.getElementById('providerModelInput');
                const modelSuggestions = document.getElementById('providerModelSuggestions');
                const keyInput = document.getElementById('providerKeyInput');
                const keyHint = document.getElementById('providerKeyHint');
                const maxTokensRow = document.getElementById('providerMaxTokensRow');
                const maxTokensInput = document.getElementById('providerMaxTokensInput');
                const customRows = document.getElementById('providerCustomRows');
                const promptPathInput = document.getElementById('providerPromptPathInput');
                const responsePathInput = document.getElementById('providerResponsePathInput');
                const authHeaderInput = document.getElementById('providerAuthHeaderInput');
                const authPrefixInput = document.getElementById('providerAuthPrefixInput');
                const bodyInput = document.getElementById('providerBodyInput');
                const headersInput = document.getElementById('providerHeadersInput');
                const saveBtn = document.getElementById('providerSaveBtn');
                const cancelBtn = document.getElementById('providerCancelBtn');
                const feedback = document.getElementById('providerFeedback');

                const OK_COLOR = '#22c55e';
                const KO_COLOR = 'var(--danger, #ef4444)';

                // Stato del pannello. `editing` e' l'id in modifica (null = nuovo).
                let state = { providers: [], active: 'gemini', anthropicModels: [] };
                let editing = null;

                function api(route) { return (window.__API_BASE__ ? window.__API_BASE__ : '') + route; }

                // Ogni testo passa da t(): vedi la nota nella sezione cookie. Nessun
                // ripiego italiano hardcoded, nemmeno per i messaggi d'errore.
                function tr(key, vars) {
                    return (typeof t === 'function') ? t(key, vars) : key;
                }

                function showFeedback(msg, kind) {
                    if (!feedback) return;
                    feedback.textContent = msg;
                    feedback.style.display = 'block';
                    if (kind === 'ok') {
                        feedback.style.background = 'rgba(34,197,94,0.10)';
                        feedback.style.border = '1px solid rgba(34,197,94,0.30)';
                        feedback.style.color = OK_COLOR;
                    } else if (kind === 'error') {
                        feedback.style.background = 'rgba(239,68,68,0.10)';
                        feedback.style.border = '1px solid rgba(239,68,68,0.30)';
                        feedback.style.color = KO_COLOR;
                    } else {
                        feedback.style.background = 'var(--input-bg)';
                        feedback.style.border = '1px solid var(--glass-border)';
                        feedback.style.color = 'var(--text-secondary)';
                    }
                }
                function clearFeedback() { if (feedback) feedback.style.display = 'none'; }

                function typeName(type) {
                    if (type === 'anthropic') return tr('settings.prov.typeAnthropic');
                    if (type === 'openai_compatible') return tr('settings.prov.typeOpenai');
                    if (type === 'custom') return tr('settings.prov.typeCustom');
                    return tr('settings.prov.typeGemini');
                }

                function byId(id) {
                    return state.providers.filter(p => p.id === id)[0] || null;
                }

                // --- Elenco ---------------------------------------------------
                function renderList() {
                    if (!listEl) return;
                    listEl.textContent = '';
                    state.providers.forEach(p => {
                        const isActive = (p.id === state.active);
                        const row = document.createElement('div');
                        row.className = 'provider-row';
                        row.dataset.providerId = p.id;
                        row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 10px;'
                            + ' border-radius:var(--radius-sm); border:1px solid '
                            + (isActive ? 'rgba(34,197,94,0.45)' : 'var(--glass-border, rgba(255,255,255,0.10))')
                            + '; background:var(--input-bg);';

                        const dot = document.createElement('span');
                        dot.style.cssText = 'width:8px; height:8px; border-radius:50%; flex-shrink:0; background:'
                            + (isActive ? OK_COLOR : 'var(--text-muted)') + ';';
                        row.appendChild(dot);

                        const info = document.createElement('div');
                        info.style.cssText = 'flex:1; min-width:0;';
                        const name = document.createElement('div');
                        name.style.cssText = 'font-size:12px; font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                        name.textContent = p.label || p.id;
                        info.appendChild(name);
                        const meta = document.createElement('div');
                        meta.style.cssText = 'font-size:10px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                        const bits = [typeName(p.type)];
                        if (p.model) bits.push(p.model);
                        if (p.needsKey) {
                            bits.push(p.hasKey
                                ? tr('settings.prov.keySaved', { mask: p.keyMask || '' })
                                : tr('settings.prov.noKey'));
                        }
                        meta.textContent = bits.join(' · ');
                        info.appendChild(meta);
                        row.appendChild(info);

                        const actions = document.createElement('div');
                        actions.style.cssText = 'display:flex; gap:4px; flex-shrink:0;';
                        const mkBtn = (cls, key, action, title) => {
                            const b = document.createElement('button');
                            b.className = 'btn ' + cls;
                            b.style.cssText = 'font-size:10px; padding:4px 8px;';
                            b.textContent = tr(key);
                            b.dataset.providerAction = action;
                            if (title) b.title = title;
                            return b;
                        };
                        if (isActive) {
                            const badge = document.createElement('span');
                            badge.style.cssText = 'font-size:10px; color:' + OK_COLOR + '; padding:4px 6px;';
                            badge.textContent = tr('settings.prov.inUse');
                            badge.dataset.providerAction = 'badge';
                            actions.appendChild(badge);
                        } else {
                            actions.appendChild(mkBtn('btn-secondary', 'settings.prov.useBtn', 'use'));
                        }
                        actions.appendChild(mkBtn('btn-secondary', 'settings.prov.testBtn', 'test'));
                        if (!p.builtin) {
                            actions.appendChild(mkBtn('btn-secondary', 'settings.prov.editBtn', 'edit'));
                            actions.appendChild(mkBtn('btn-secondary', 'settings.prov.deleteBtn', 'delete'));
                        }
                        row.appendChild(actions);
                        listEl.appendChild(row);
                    });
                }

                async function load() {
                    try {
                        const res = await fetch(api('/api/providers'));
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        const data = await res.json();
                        state.providers = Array.isArray(data.providers) ? data.providers : [];
                        state.active = data.active || 'gemini';
                        state.anthropicModels = data.anthropicModels || [];
                        renderList();
                        return data;
                    } catch (err) {
                        // Aperta come file:// o senza backend non c'e' nessun registro da
                        // mostrare: lo si dice, invece di lasciare un riquadro vuoto che
                        // sembra un guasto.
                        state.providers = [];
                        renderList();
                        if (section) section.style.display = 'none';
                        return null;
                    }
                }

                // --- Form -----------------------------------------------------
                function refreshFormUI() {
                    const type = typeSelect ? typeSelect.value : 'anthropic';
                    if (baseUrlRow) {
                        // Per Anthropic l'URL ha gia' un default valido: mostrarlo come
                        // campo obbligatorio farebbe credere che serva compilarlo.
                        baseUrlRow.style.display = (type === 'anthropic') ? 'none' : 'flex';
                    }
                    if (customRows) customRows.style.display = (type === 'custom') ? 'flex' : 'none';
                    if (maxTokensRow) maxTokensRow.style.display = (type === 'custom') ? 'none' : 'flex';
                    if (modelSuggestions) {
                        modelSuggestions.textContent = '';
                        if (type === 'anthropic') {
                            (state.anthropicModels || []).forEach(m => {
                                const o = document.createElement('option');
                                o.value = m;
                                modelSuggestions.appendChild(o);
                            });
                        }
                    }
                }

                function openForm(provider) {
                    editing = provider ? provider.id : null;
                    if (formTitle) {
                        formTitle.textContent = tr(provider
                            ? 'settings.prov.formTitleEdit' : 'settings.prov.formTitleNew');
                    }
                    if (typeSelect) typeSelect.value = (provider && provider.type) || 'anthropic';
                    if (labelInput) labelInput.value = (provider && provider.label) || '';
                    if (baseUrlInput) baseUrlInput.value = (provider && provider.base_url) || '';
                    if (modelInput) modelInput.value = (provider && provider.model) || '';
                    if (maxTokensInput) maxTokensInput.value = (provider && provider.max_tokens) || 16000;
                    if (promptPathInput) promptPathInput.value = (provider && provider.prompt_path) || '';
                    if (responsePathInput) responsePathInput.value = (provider && provider.response_path) || '';
                    if (authHeaderInput) authHeaderInput.value = (provider && provider.auth_header) || '';
                    // `auth_prefix` puo' essere la stringa VUOTA di proposito (chiave
                    // nuda): `|| ''` va bene qui, ma in salvataggio va distinto.
                    if (authPrefixInput) {
                        authPrefixInput.value = (provider && provider.auth_prefix != null)
                            ? provider.auth_prefix : '';
                    }
                    if (bodyInput) bodyInput.value = (provider && provider.body_template) || '';
                    if (headersInput) {
                        headersInput.value = (provider && provider.headers
                            && Object.keys(provider.headers).length)
                            ? JSON.stringify(provider.headers) : '';
                    }
                    // La chiave NON torna dal server: il form ne vede solo la maschera.
                    // Lasciarlo vuoto significa "non cambiarla", ed e' scritto nel campo
                    // sotto perche' altrimenti sembra che si sia persa.
                    if (keyInput) keyInput.value = '';
                    if (keyHint) {
                        keyHint.textContent = (provider && provider.hasKey)
                            ? tr('settings.prov.keyKeep', { mask: provider.keyMask || '' })
                            : '';
                    }
                    refreshFormUI();
                    if (form) form.style.display = 'flex';
                    clearFeedback();
                    if (labelInput) labelInput.focus();
                }

                function closeForm() {
                    editing = null;
                    if (form) form.style.display = 'none';
                    // La chiave in chiaro non deve restare nel campo dopo la
                    // chiusura: il form e' solo nascosto, non smontato, quindi il
                    // valore sopravviverebbe nel DOM per tutta la sessione (e
                    // finirebbe in un salvataggio password del browser o in una
                    // copia della pagina). openForm() la riazzera comunque, ma
                    // aspettare la prossima apertura la lascia li' nel frattempo.
                    if (keyInput) keyInput.value = '';
                }

                function collectForm() {
                    const payload = {
                        type: typeSelect ? typeSelect.value : 'anthropic',
                        label: labelInput ? labelInput.value.trim() : '',
                        model: modelInput ? modelInput.value.trim() : '',
                        base_url: baseUrlInput ? baseUrlInput.value.trim() : '',
                    };
                    if (editing) payload.id = editing;
                    if (keyInput && keyInput.value.trim()) payload.api_key = keyInput.value.trim();
                    if (maxTokensInput && maxTokensInput.value) {
                        payload.max_tokens = parseInt(maxTokensInput.value, 10) || undefined;
                    }
                    if (payload.type === 'custom') {
                        payload.prompt_path = promptPathInput ? promptPathInput.value.trim() : '';
                        payload.response_path = responsePathInput ? responsePathInput.value.trim() : '';
                        payload.auth_header = authHeaderInput ? authHeaderInput.value.trim() : '';
                        payload.auth_prefix = authPrefixInput ? authPrefixInput.value : '';
                        payload.body_template = bodyInput ? bodyInput.value.trim() : '';
                    }
                    if (headersInput && headersInput.value.trim()) {
                        // Header illeggibili: si ferma QUI invece di mandarli al server,
                        // che li scarterebbe in silenzio e lascerebbe l'utente a chiedersi
                        // perche' il suo header non arriva mai.
                        let parsed = null;
                        try { parsed = JSON.parse(headersInput.value.trim()); }
                        catch (e) { return { error: tr('settings.prov.headersInvalid') }; }
                        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                            return { error: tr('settings.prov.headersInvalid') };
                        }
                        payload.headers = parsed;
                    } else {
                        payload.headers = {};
                    }
                    return { payload: payload };
                }

                async function post(route, body) {
                    const res = await fetch(api(route), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                    let out = {};
                    try { out = await res.json(); } catch (e) { out = {}; }
                    if (!res.ok || out.error) {
                        throw new Error(out.error || ('HTTP ' + res.status));
                    }
                    return out;
                }

                // --- Azioni ---------------------------------------------------
                if (addBtn) addBtn.addEventListener('click', () => { openForm(null); });
                if (cancelBtn) cancelBtn.addEventListener('click', () => { closeForm(); clearFeedback(); });
                if (typeSelect) typeSelect.addEventListener('change', refreshFormUI);

                if (saveBtn) saveBtn.addEventListener('click', async () => {
                    const got = collectForm();
                    if (got.error) { showFeedback(got.error, 'error'); return; }
                    saveBtn.disabled = true;
                    try {
                        await post('/api/providers', got.payload);
                        closeForm();
                        await load();
                        showFeedback(tr('settings.prov.saved'), 'ok');
                    } catch (err) {
                        showFeedback(tr('settings.prov.error', { error: String(err.message || err) }), 'error');
                    } finally {
                        saveBtn.disabled = false;
                    }
                });

                // Un solo handler sull'elenco (delega): le righe si ridisegnano a ogni
                // caricamento, e agganciare i bottoni uno per uno li accumulerebbe.
                if (listEl) listEl.addEventListener('click', async (ev) => {
                    const btn = ev.target.closest('[data-provider-action]');
                    if (!btn) return;
                    const row = ev.target.closest('[data-provider-id]');
                    if (!row) return;
                    const id = row.dataset.providerId;
                    const action = btn.dataset.providerAction;
                    const provider = byId(id);
                    if (!provider || action === 'badge') return;

                    if (action === 'use') {
                        try {
                            const out = await post('/api/providers', { action: 'activate', id: id });
                            state.active = out.active || id;
                            state.providers = out.providers || state.providers;
                            renderList();
                            if (typeof window.refreshAiModels === 'function') window.refreshAiModels();
                            showFeedback(tr('settings.prov.activated', { label: provider.label || id }), 'ok');
                        } catch (err) {
                            showFeedback(tr('settings.prov.error', { error: String(err.message || err) }), 'error');
                        }
                        return;
                    }
                    if (action === 'edit') { openForm(provider); return; }
                    if (action === 'delete') {
                        if (!confirm(tr('settings.prov.deleteConfirm', { label: provider.label || id }))) return;
                        try {
                            const res = await fetch(api('/api/providers?id=' + encodeURIComponent(id)),
                                { method: 'DELETE' });
                            const out = await res.json();
                            if (!res.ok || out.error) throw new Error(out.error || ('HTTP ' + res.status));
                            if (editing === id) closeForm();
                            await load();
                            showFeedback(tr('settings.prov.deleted'), 'ok');
                        } catch (err) {
                            showFeedback(tr('settings.prov.error', { error: String(err.message || err) }), 'error');
                        }
                        return;
                    }
                    if (action === 'test') {
                        btn.disabled = true;
                        showFeedback(tr('settings.prov.testing'), 'info');
                        try {
                            // La prova risponde 200 anche quando fallisce: l'esito sta in
                            // `ok`/`kind`, cosi' un 401 del provider diventa un messaggio
                            // che dice cosa fare invece di un errore di rete generico.
                            const res = await fetch(api('/api/providers/test'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ id: id }),
                            });
                            const out = await res.json();
                            if (out.ok) {
                                showFeedback(tr('settings.prov.testOk', { sample: out.sample || '' }), 'ok');
                            } else {
                                const kindKey = out.kind === 'auth' ? 'settings.prov.testAuth'
                                    : (out.kind === 'transient' ? 'settings.prov.testTransient'
                                        : 'settings.prov.testFormat');
                                showFeedback(tr(kindKey, { error: out.message || out.error || '' }), 'error');
                            }
                        } catch (err) {
                            showFeedback(tr('settings.prov.testFormat',
                                { error: String(err.message || err) }), 'error');
                        } finally {
                            btn.disabled = false;
                        }
                        return;
                    }
                });

                // Le righe dell'elenco sono costruite da JS: non hanno data-i18n e
                // applyI18n non le tocca. Nascono anche PRIMA che i dizionari siano
                // caricati, quando t() ritorna la chiave nuda — quindi senza questo
                // ridisegno si leggerebbe per sempre 'settings.prov.useBtn'. Lo chiama
                // setLanguage (23-i18n.js) come per renderObjectsList e compagni.
                window.renderProviderList = function () { renderList(); refreshFormUI(); };

                load();
            })();
