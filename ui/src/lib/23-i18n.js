            // ===== i18n runtime (W2-C punto 2) =====
            // Motore di localizzazione. I testi del template sono annotati con
            // data-i18n / data-i18n-title / data-i18n-placeholder (vedi ui/annotate-i18n.mjs).
            // I dizionari vivono in ui/locales/*.json; index.json elenca le lingue.
            //
            // Sorgente + fallback = "it" (i valori it.json SONO i testi gia' nel DOM, quindi
            // se il fetch dei locali fallisce l'app resta perfettamente in italiano).
            //
            // API esposte globalmente:
            //   t(key, vars)      -> stringa tradotta con {placeholder} sostituiti (per stringhe JS runtime)
            //   applyI18n(root)   -> traduce gli elementi annotati sotto root (default document)
            //   setLanguage(code) -> carica e applica una lingua, la persiste via prefs
            //   currentLanguage() -> codice lingua attivo

            const I18N_FALLBACK = 'it';
            let i18nLang = I18N_FALLBACK;
            let i18nApplied = false;           // true dopo la prima applicazione reale
            // ATTENZIONE, `var` NON e' una svista: tutti i moduli finiscono in UN SOLO
            // scope condiviso e t() e' una dichiarazione di funzione, quindi e' hoistata
            // e CHIAMABILE gia' prima che questo file venga eseguito (19-prefs.js lo fa,
            // sta prima nel manifest). Con `let`/`const` queste due variabili sarebbero
            // in temporal dead zone e leggerle non darebbe `undefined`: lancerebbe
            // ReferenceError, uccidendo tutto il bootstrap da li' in poi — schermo nero
            // e interfaccia morta. Con `var` sono hoistate a `undefined` e le guardie
            // in t() fanno il loro lavoro: si ottiene la chiave nuda, che e' il ripiego
            // documentato. Non sostituirle con let/const.
            var i18nDict = {};                 // dizionario lingua attiva
            var i18nCache = { it: null };      // code -> dict (evita rifetch)
            let i18nLocales = [{ code: 'it', name: 'Italiano' }]; // popolato da index.json

            // Base URL per i locali: nel desktop il server serve la app; i JSON stanno in
            // ./locales relativi alla pagina. __API_BASE__ (se definito da main.py) copre il
            // caso in cui la app sia servita da origine diversa.
            function i18nUrl(file) {
                const base = (typeof __API_BASE__ !== 'undefined' && __API_BASE__) ? __API_BASE__ : '';
                const slash = (base && !base.endsWith('/')) ? '/' : '';
                const uiPrefix = (base && !base.endsWith('/ui')) ? 'ui/' : '';
                return `${base}${slash}${uiPrefix}locales/${file}`;
            }

            function interpolate(str, vars) {
                if (!vars || typeof str !== 'string') return str;
                return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
            }

            // t(): traduzione di stringhe usate nel codice JS (alert/confirm/hint dinamici).
            // Cerca nella lingua attiva, poi nel fallback it (i18nCache.it), infine ritorna
            // la chiave stessa (utile a scoprire chiavi mancanti in dev).
            function t(key, vars) {
                let s = (i18nDict && key in i18nDict) ? i18nDict[key] : undefined;
                if (s === undefined && i18nCache && i18nCache.it && key in i18nCache.it) s = i18nCache.it[key];
                if (s === undefined) s = key;
                return interpolate(s, vars);
            }

            // Applica le traduzioni agli elementi annotati sotto `root`.
            function applyI18n(root) {
                root = root || document;
                root.querySelectorAll('[data-i18n]').forEach(el => {
                    // Nome modello / status bar: testo VIVO. Riscriverli qui
                    // azzera "Spada Pixel Art" in "Nessuno" al cambio lingua.
                    if (el.id === 'modelName' || el.id === 'statusName') return;
                    const k = el.getAttribute('data-i18n');
                    if (k in i18nDict) el.textContent = i18nDict[k];
                    else if (i18nCache.it && k in i18nCache.it) el.textContent = i18nCache.it[k];
                });
                root.querySelectorAll('[data-i18n-title]').forEach(el => {
                    const k = el.getAttribute('data-i18n-title');
                    const v = (k in i18nDict) ? i18nDict[k] : (i18nCache.it && i18nCache.it[k]);
                    if (v !== undefined) el.setAttribute('title', v);
                });
                root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
                    const k = el.getAttribute('data-i18n-placeholder');
                    const v = (k in i18nDict) ? i18nDict[k] : (i18nCache.it && i18nCache.it[k]);
                    if (v !== undefined) el.setAttribute('placeholder', v);
                });
                // Titolo documento + attributo lang.
                if ('app.title' in i18nDict) document.title = i18nDict['app.title'];
                document.documentElement.setAttribute('lang', i18nLang);
            }

            async function fetchDict(code) {
                if (i18nCache[code]) return i18nCache[code];
                const res = await fetch(i18nUrl(code + '.json'));
                if (!res.ok) throw new Error('locale fetch failed: ' + code);
                const dict = await res.json();
                i18nCache[code] = dict;
                return dict;
            }

            async function setLanguage(code, opts) {
                opts = opts || {};
                try {
                    // Assicura sempre il fallback it in cache (per t() e applyI18n).
                    if (!i18nCache.it) { try { i18nCache.it = await fetchDict('it'); } catch (e) {} }
                    const dict = (code === 'it' && i18nCache.it) ? i18nCache.it : await fetchDict(code);
                    const sameAsDom = (code === I18N_FALLBACK && i18nLang === I18N_FALLBACK && !i18nApplied);
                    i18nDict = dict;
                    i18nLang = code;
                    // ANTI-FLICKER (F3). I testi italiani sono GIA' nel DOM (it.json e' la
                    // fonte da cui il template e' annotato). Alla prima applicazione in
                    // italiano, applyI18n() riscriverebbe centinaia di nodi con stringhe
                    // identiche: lavoro inutile subito dopo il primo paint. Lo saltiamo.
                    // Per le altre lingue il testo deve davvero cambiare, quindi si
                    // applica normalmente.
                    if (!sameAsDom) applyI18n(document);
                    i18nApplied = true;
                    // applyI18n riscrive solo i nodi ANNOTATI (data-i18n*). I title
                    // messi da JS su elementi costruiti a runtime non sono annotati -
                    // e uno di loro ha un segnaposto ({color}), che un attributo non
                    // saprebbe esprimere - quindi restano com'erano al momento in cui
                    // sono stati creati. Quelle liste nascono PRIMA che i dizionari
                    // siano caricati, quando t() ritorna la chiave nuda: senza questo
                    // ridisegno si vedono per sempre 'objects.hide' e simili, e
                    // cambiare lingua non li tocca. Misurato in GUI su tutte e 6 le
                    // lingue.
                    if (typeof renderObjectsList === 'function') { try { renderObjectsList(); } catch (e) {} }
                    if (typeof renderPaletteSwatches === 'function') { try { renderPaletteSwatches(); } catch (e) {} }
                    if (typeof renderMaterialsPanel === 'function') { try { renderMaterialsPanel(); } catch (e) {} }
                    // Stesso motivo per l'elenco dei provider AI (26-settings-modal.js):
                    // righe costruite da JS, nate prima dei dizionari.
                    if (typeof window.renderProviderList === 'function') { try { window.renderProviderList(); } catch (e) {} }
                    if (typeof updateStatusBar === 'function') { try { updateStatusBar(); } catch (e) {} }
                    if (!opts.silent && typeof savePref === 'function') savePref('language', code);
                    const sel = document.getElementById('languageSelect');
                    if (sel && sel.value !== code) sel.value = code;
                } catch (e) {
                    console.warn('[i18n] impossibile caricare la lingua', code, e);
                    // Resta sulla lingua corrente (o it di default): nessuna regressione visiva.
                }
            }

            function currentLanguage() { return i18nLang; }

            // Popola il <select id="languageSelect"> (creato da 22-screens nel tab Vista, o
            // qui se assente) leggendo locales/index.json. Nessun hardcode delle lingue.
            async function initI18n() {
                let startLang = I18N_FALLBACK;
                try {
                    const res = await fetch(i18nUrl('index.json'));
                    if (res.ok) {
                        const idx = await res.json();
                        if (Array.isArray(idx.locales) && idx.locales.length) i18nLocales = idx.locales;
                    }
                } catch (e) { /* offline / file:// -> resta solo it, app gia' in italiano */ }

                // Lingua preferita: prefs salvate > lingua browser (se supportata) > it.
                try {
                    const prefs = (typeof loadPrefs === 'function') ? await loadPrefs() : null;
                    if (prefs && prefs.language) startLang = prefs.language;
                    else {
                        const nav = (navigator.language || 'it').slice(0, 2).toLowerCase();
                        if (i18nLocales.some(l => l.code === nav)) startLang = nav;
                    }
                } catch (e) {}

                buildLanguageSelector();
                await setLanguage(startLang, { silent: true });
            }

            function buildLanguageSelector() {
                let sel = document.getElementById('languageSelect');
                if (!sel) {
                    // Fallback: se 22-screens non ha creato il selettore, lo agganciamo al
                    // tab Vista (o al body come ultima spiaggia) senza rompere il layout.
                    const host = document.querySelector('[data-panel="view"]') || document.body;
                    const wrap = document.createElement('div');
                    wrap.className = 'control-row';
                    wrap.style.cssText = 'margin-top:10px;';
                    const label = document.createElement('label');
                    label.setAttribute('data-i18n', 'settings.language');
                    label.textContent = 'Lingua';
                    sel = document.createElement('select');
                    sel.id = 'languageSelect';
                    sel.className = 'lang-select';
                    wrap.appendChild(label);
                    wrap.appendChild(sel);
                    host.appendChild(wrap);
                }
                sel.innerHTML = '';
                i18nLocales.forEach(l => {
                    const o = document.createElement('option');
                    o.value = l.code; o.textContent = l.name;
                    sel.appendChild(o);
                });
                sel.value = i18nLang;
                sel.onchange = () => setLanguage(sel.value);
            }

            // Avvio: carica index + lingua preferita e applica. Non blocca il resto
            // dell'init (async). Se fallisce, l'app resta in italiano (testi del template).
            (function bootI18n() { initI18n(); })();
