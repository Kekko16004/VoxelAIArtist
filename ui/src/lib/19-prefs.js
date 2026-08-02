            /* ===== T6: Layer preferenze (backend + fallback localStorage) =========
             * savePref/loadPrefs persistono le preferenze dell'app (tema, keymap) via
             * il backend `POST/GET /api/prefs` (merge lato server). Se il backend non
             * risponde o non c'è (`__API_BASE__` assente, uso web/offline) si ripiega
             * su localStorage, così l'app funziona comunque. Manteniamo anche le chiavi
             * localStorage "legacy" (THEME_KEY, voxelai-keymap) perché gli inizializzatori
             * sincroni initTheme()/loadKeymap() le leggono all'avvio senza attese async. */
            const PREFS_LS_KEY = 'voxelai-prefs';
            const KEYMAP_LS_KEY = 'voxelai-keymap';
            function prefsEndpoint() {
                return (window.__API_BASE__ ? window.__API_BASE__ : '') + '/api/prefs';
            }
            function readPrefsBlob() {
                try {
                    const raw = localStorage.getItem(PREFS_LS_KEY);
                    if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object') return o; }
                } catch (e) { /* storage non disponibile o JSON invalido */ }
                return {};
            }
            async function savePref(key, value) {
                // Mirror sulle chiavi legacy, così i loader sincroni all'avvio le vedono
                // anche senza backend.
                try {
                    if (key === 'theme') localStorage.setItem(THEME_KEY, value);
                    else if (key === 'keymap') localStorage.setItem(KEYMAP_LS_KEY, JSON.stringify(value));
                } catch (e) { }
                // Blob generico di fallback.
                try {
                    const blob = readPrefsBlob();
                    blob[key] = value;
                    localStorage.setItem(PREFS_LS_KEY, JSON.stringify(blob));
                } catch (e) { }
                // Backend (best-effort): se fallisce restiamo con la copia localStorage.
                try {
                    await fetch(prefsEndpoint(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ settings: { [key]: value } })
                    });
                } catch (e) { /* offline / backend assente: già salvato localmente */ }
            }
            async function loadPrefs() {
                // Prima il backend (fonte autorevole quando c'è).
                try {
                    const res = await fetch(prefsEndpoint());
                    if (res && res.ok) {
                        const j = await res.json();
                        if (j && j.settings && typeof j.settings === 'object') return j.settings;
                    }
                } catch (e) { /* si passa al fallback locale */ }
                // Fallback: blob generico + chiavi legacy.
                const out = readPrefsBlob();
                try { const t = localStorage.getItem(THEME_KEY); if (t && out.theme === undefined) out.theme = t; } catch (e) { }
                try { const k = localStorage.getItem(KEYMAP_LS_KEY); if (k && out.keymap === undefined) out.keymap = JSON.parse(k); } catch (e) { }
                return out;
            }

            /* ===== Capacita' del backend: "desktop" NON vuol dire "c'e' un backend" ===
             * Con APP_MODE="web" (ora il default in main.py) la UI gira in un tab del
             * browser MA il server Python locale c'e' comunque: autosave, cronologia
             * salvataggi, progetti recenti e "apri cartella" sono semplice I/O su disco
             * e funzionano identici. Solo i DIALOG NATIVI (Apri, Salva con nome, scegli
             * cartella) richiedono Qt, che esiste soltanto in modalita' "py".
             *
             * Prima le due cose erano un unico flag `window.__IS_DESKTOP__` (iniettato
             * solo dalla webview): in modalita' web l'autosave ripiegava su localStorage
             * e la cronologia restava vuota. Cioe' la modalita' PREDEFINITA perdeva
             * funzioni che il backend offriva gia'.
             *
             * hasLocalBackend() e' SINCRONA di proposito (i chiamanti sono handler di
             * click): parte ottimista quando la pagina arriva da http(s) - servita dal
             * server locale - e diventa definitiva appena detectBackend() ha risposto.
             * Aperta da file:// (nessun server) resta negativa e si usano i fallback. */
            let backendProbe = null;           // null = mai sondato; true/false = risposta
            let backendNativeDialogs = null;   // Qt disponibile lato server (dialog nativi)

            function hasLocalBackend() {
                if (window.__IS_DESKTOP__) return true;      // webview: backend garantito
                if (backendProbe !== null) return backendProbe;
                const p = (typeof location !== 'undefined' && location.protocol) || '';
                return p === 'http:' || p === 'https:';
            }
            function hasNativeDialogs() {
                if (backendNativeDialogs !== null) return backendNativeDialogs;
                return !!window.__IS_DESKTOP__;
            }
            async function detectBackend() {
                try {
                    const res = await fetch((window.__API_BASE__ ? window.__API_BASE__ : '') + '/api/settings');
                    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
                    const j = await res.json();
                    backendProbe = true;
                    backendNativeDialogs = !!(j && (j.is_desktop || j.isDesktop));
                } catch (e) {
                    backendProbe = false;
                    backendNativeDialogs = false;
                }
                window.__BACKEND_OK__ = backendProbe;
                window.__NATIVE_DIALOGS__ = backendNativeDialogs;
                return backendProbe;
            }
            detectBackend();

            /* ===== T6: Pannello rimappatura scorciatoie ============================
             * Elenca ogni azione di KEYMAP con il suo tasto e permette di rimapparla:
             * clic sul tasto -> "premi un tasto" -> nuova assegnazione. Rileva i
             * conflitti (tasto già usato) e li segnala in italiano senza applicare.
             * Dopo un rebind valido aggiorna KEYMAP in memoria (applicazione immediata)
             * e persiste via savePref('keymap', ...). */
            const SHORTCUT_TOOL_LABELS = {
                view: 'Strumento: Vista',
                place: 'Strumento: Aggiungi',
                remove: 'Strumento: Rimuovi',
                draw: 'Strumento: Disegna',
                pick: 'Strumento: Contagocce'
            };
            const SHORTCUT_SINGLE_LABELS = {
                toggleMode: 'Modalità Oggetto/Modifica',
                extrude: 'Estrusione',
                brushDown: 'Pennello −',
                brushUp: 'Pennello +',
                togglePlay: 'Play/Pausa animazione'
            };
            const SHORTCUT_SINGLE_ORDER = ['toggleMode', 'extrude', 'brushDown', 'brushUp', 'togglePlay'];

            // Etichetta tradotta con ripiego italiano. Serve il ripiego perche'
            // renderShortcutsPanel() gira anche PRIMA che i dizionari siano stati
            // caricati (19-prefs viene prima di 23-i18n nel manifest) e li' t()
            // restituirebbe la chiave nuda.
            function shortcutLabel(key, fallback) {
                const s = (typeof t === 'function') ? t(key) : key;
                return (!s || s === key) ? fallback : s;
            }

            function keyDisplay(k) {
                if (k === ' ' || k === 'Spacebar' || k === 'Space') return 'Spazio';
                if (k === 'ArrowUp') return '↑';
                if (k === 'ArrowDown') return '↓';
                if (k === 'ArrowLeft') return '←';
                if (k === 'ArrowRight') return '→';
                if (k === 'Escape') return 'Esc';
                if (typeof k !== 'string' || k.length === 0) return '—';
                return k.length === 1 ? k.toUpperCase() : k;
            }

            // Costruisce la lista piatta dei binding attuali a partire da KEYMAP.
            function collectShortcutBindings() {
                const list = [];
                const tools = KEYMAP.tools || {};
                // Ordine stabile per strumento (non per tasto), così l'elenco non salta
                // quando si rimappa.
                const toolOrder = Object.keys(SHORTCUT_TOOL_LABELS);
                const keyByTool = {};
                Object.keys(tools).forEach(k => { keyByTool[tools[k]] = k; });
                toolOrder.forEach(tool => {
                    if (keyByTool[tool] !== undefined) {
                        const tk = 'shortcut.tool' + tool.charAt(0).toUpperCase() + tool.slice(1);
                        list.push({
                            id: 'tool:' + tool, type: 'tool', tool, key: keyByTool[tool],
                            label: shortcutLabel(tk, SHORTCUT_TOOL_LABELS[tool])
                        });
                    }
                });
                SHORTCUT_SINGLE_ORDER.forEach(prop => {
                    if (KEYMAP[prop] !== undefined) {
                        list.push({
                            id: 'single:' + prop, type: 'single', prop, key: KEYMAP[prop],
                            label: shortcutLabel('shortcut.' + prop, SHORTCUT_SINGLE_LABELS[prop])
                        });
                    }
                });
                return list;
            }

            let shortcutListeningId = null;
            let shortcutListenHandler = null;

            function showShortcutConflict(msg) {
                const el = document.getElementById('shortcutConflict');
                if (!el) return;
                if (msg) { el.textContent = msg; el.style.display = 'block'; }
                else { el.textContent = ''; el.style.display = 'none'; }
            }

            function stopShortcutListening() {
                if (shortcutListenHandler) {
                    window.removeEventListener('keydown', shortcutListenHandler, true);
                    shortcutListenHandler = null;
                }
                shortcutListeningId = null;
                renderShortcutsPanel();
            }

            // Applica un nuovo tasto a un binding, gestendo i conflitti.
            function assignShortcut(binding, newKey) {
                const conflict = collectShortcutBindings().find(b => b.id !== binding.id && b.key === newKey);
                if (conflict) {
                    showShortcutConflict('Il tasto "' + keyDisplay(newKey) + '" è già usato da "' + conflict.label + '". Scegli un altro tasto.');
                    return false;
                }
                showShortcutConflict('');
                if (binding.type === 'tool') {
                    // Rimuovi la vecchia chiave che puntava a questo strumento, poi assegna.
                    if (!KEYMAP.tools) KEYMAP.tools = {};
                    Object.keys(KEYMAP.tools).forEach(k => { if (KEYMAP.tools[k] === binding.tool) delete KEYMAP.tools[k]; });
                    KEYMAP.tools[newKey] = binding.tool;
                } else {
                    KEYMAP[binding.prop] = newKey;
                }
                // Applicazione immediata: KEYMAP è già la fonte usata dai gestori tastiera.
                savePref('keymap', KEYMAP);
                return true;
            }

            function startShortcutListening(binding, btnEl) {
                // Se stavamo già ascoltando un'altra azione, annulla quella.
                if (shortcutListenHandler) window.removeEventListener('keydown', shortcutListenHandler, true);
                shortcutListeningId = binding.id;
                showShortcutConflict('');
                btnEl.classList.add('listening');
                btnEl.textContent = 'premi un tasto…';
                shortcutListenHandler = function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    // Ignora i tasti modificatori puri: si aspetta il tasto "principale".
                    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
                    if (e.key === 'Escape') { stopShortcutListening(); return; } // annulla
                    assignShortcut(binding, e.key);
                    stopShortcutListening();
                };
                window.addEventListener('keydown', shortcutListenHandler, true);
            }

            function renderShortcutsPanel() {
                const listEl = document.getElementById('shortcutsList');
                if (!listEl) return;
                listEl.innerHTML = '';
                collectShortcutBindings().forEach(binding => {
                    const row = document.createElement('div');
                    row.className = 'shortcut-row';
                    const label = document.createElement('div');
                    label.className = 'shortcut-label';
                    label.textContent = binding.label;
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'shortcut-key' + (shortcutListeningId === binding.id ? ' listening' : '');
                    btn.textContent = shortcutListeningId === binding.id ? 'premi un tasto…' : keyDisplay(binding.key);
                    btn.title = 'Clicca e premi la nuova combinazione (Esc per annullare)';
                    btn.addEventListener('click', () => {
                        if (shortcutListeningId === binding.id) { stopShortcutListening(); return; }
                        startShortcutListening(binding, btn);
                    });
                    row.appendChild(label);
                    row.appendChild(btn);
                    listEl.appendChild(row);
                });
            }

            (function bindShortcutsPanel() {
                const resetBtn = document.getElementById('shortcutsResetBtn');
                if (resetBtn) {
                    resetBtn.addEventListener('click', () => {
                        if (shortcutListenHandler) stopShortcutListening();
                        // Ripristina i predefiniti in KEYMAP (mutazione in-place per non
                        // perdere il riferimento condiviso usato dai gestori tastiera).
                        Object.keys(KEYMAP).forEach(k => delete KEYMAP[k]);
                        Object.assign(KEYMAP, JSON.parse(JSON.stringify(DEFAULT_KEYMAP)));
                        showShortcutConflict('');
                        savePref('keymap', KEYMAP);
                        renderShortcutsPanel();
                    });
                }
                renderShortcutsPanel();
            })();

            /* ===== T6: caricamento preferenze all'avvio + migrazione =============== */
            (async function initPrefs() {
                let prefs = {};
                try { prefs = await loadPrefs(); } catch (e) { prefs = {}; }
                if (!prefs || typeof prefs !== 'object') prefs = {};

                // ANTI-FLICKER (F2). Tema e accent sono GIA' stati applicati prima di
                // arrivare qui: dallo script anti-flash nell'<head> e dagli
                // inizializzatori sincroni initTheme()/initAccent(). Questo blocco gira
                // DOPO il round-trip di rete, quindi riapplicarli a occhi chiusi
                // produce un ulteriore cambio d'aspetto visibile.
                // Regola: tocca il DOM solo se il backend dice qualcosa di DIVERSO da
                // cio' che si vede gia'. Nel caso normale (prefs allineate) non accade
                // nulla e l'utente non vede alcuno sfarfallio.
                if (prefs.theme === 'light' || prefs.theme === 'dark') {
                    const currentTheme = document.documentElement.getAttribute('data-theme');
                    if (prefs.theme !== currentTheme && typeof applyTheme === 'function') {
                        applyTheme(prefs.theme);
                    }
                }
                if (prefs.accent && typeof applyAccent === 'function') {
                    const currentAccent = (document.documentElement.style
                        .getPropertyValue('--accent-primary') || '').trim().toLowerCase();
                    if (String(prefs.accent).trim().toLowerCase() !== currentAccent) {
                        applyAccent(prefs.accent, { persist: false });
                    }
                    const ai = document.getElementById('accentColorInput');
                    if (ai) ai.value = prefs.accent;
                }
                // Keymap: fondi sopra i default e riflette nel pannello.
                if (prefs.keymap && typeof prefs.keymap === 'object') {
                    if (prefs.keymap.tools && typeof prefs.keymap.tools === 'object') {
                        KEYMAP.tools = Object.assign({}, prefs.keymap.tools);
                    }
                    Object.keys(prefs.keymap).forEach(k => { if (k !== 'tools') KEYMAP[k] = prefs.keymap[k]; });
                    renderShortcutsPanel();
                }

                // Migrazione: se il backend non aveva ancora queste prefs ma esistono in
                // localStorage (o in memoria dai default caricati), spingile su /api/prefs.
                try {
                    if (prefs.theme === undefined) {
                        const t = document.documentElement.getAttribute('data-theme');
                        if (t) savePref('theme', t);
                    }
                    if (prefs.keymap === undefined) {
                        savePref('keymap', KEYMAP);
                    }
                    if (prefs.accent === undefined) {
                        let a = null;
                        try { a = localStorage.getItem('voxelai-accent'); } catch (e) { }
                        if (a) savePref('accent', a);
                    }
                } catch (e) { /* migrazione best-effort */ }
            })();
