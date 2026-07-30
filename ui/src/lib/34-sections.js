            /* ===== Sezioni richiudibili della sidebar (disclosure + persistenza) =====
             * Ogni blocco della sidebar (e della modale Impostazioni) e' un
             * <details class="sb-section" id="sbSec..."> con <summary class="section-title">
             * e <div class="sb-body">: stessa convenzione del pannello destro
             * (.rp-section / .rp-body), ma piu' sezioni possono restare aperte
             * insieme e lo stato aperto/chiuso sopravvive al riavvio.
             *
             * Persistenza: un unico blob JSON in localStorage sotto 'voxelai-sections'
             * ({ id: true|false }), coerente con le altre chiavi 'voxelai-*' di
             * 17-theme.js / 19-prefs.js. Non passa da savePref() di proposito: lo
             * stato serve SINCRONO all'avvio (lo script anti-flash nell'<head> legge
             * la stessa chiave per non far comparire aperte le sezioni chiuse).
             *
             * Difensivo: JSON corrotto -> si butta, id sconosciuti -> ignorati,
             * localStorage non disponibile -> tutto resta aperto come nel markup. */
            const SECTIONS_LS_KEY = 'voxelai-sections';
            const SB_SECTION_SEL = 'details.sb-section';

            // Le sezioni iniettate da 22-screens.js in #settingsExtraSections nascono
            // "piatte" (titolo + gruppo): le trasformiamo a runtime. L'id NON puo'
            // derivare dal testo del titolo (cambia con la lingua), quindi e' posizionale.
            const SB_INJECTED_IDS = { startupSettingsSection: ['sbSecStartup', 'sbSecSaving'] };

            // Etichette di fallback del comando "apri/chiudi tutto". Servono solo prima
            // che bootI18n() abbia caricato il dizionario: t() in quella finestra
            // restituisce la chiave. Stesso schema del template (testo italiano nel DOM
            // + data-i18n), cosi' applyI18n() traduce al cambio lingua senza altro codice.
            const SB_LABELS = {
                'sections.expandAll': 'Apri tutto',
                'sections.collapseAll': 'Chiudi tutto',
                'sections.expandAllTitle': 'Apre tutte le sezioni di questa scheda',
                'sections.collapseAllTitle': 'Chiude tutte le sezioni di questa scheda'
            };

            function sbLabel(key) {
                let s = key;
                try { if (typeof t === 'function') s = t(key); } catch (e) { }
                return (s === key) ? (SB_LABELS[key] || key) : s;
            }

            function sbAllSections() {
                return Array.prototype.slice.call(document.querySelectorAll(SB_SECTION_SEL));
            }

            function sbReadState() {
                try {
                    const raw = localStorage.getItem(SECTIONS_LS_KEY);
                    if (!raw) return {};
                    const o = JSON.parse(raw);
                    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
                } catch (e) { /* storage assente o JSON corrotto: si riparte da zero */ }
                return {};
            }

            function sbSaveState() {
                const blob = sbReadState();
                sbAllSections().forEach(d => { if (d.id) blob[d.id] = !!d.open; });
                try { localStorage.setItem(SECTIONS_LS_KEY, JSON.stringify(blob)); } catch (e) { }
            }

            /* Trasforma una coppia piatta (.section-title + elemento successivo) nel
             * <details class="sb-section"> equivalente, senza toccare il nodo del corpo
             * (id, classi e figli restano identici: molto JS li interroga). */
            function sbWrapFlatSection(titleEl, sid) {
                const body = titleEl.nextElementSibling;
                if (!body || !titleEl.parentNode) return null;
                const det = document.createElement('details');
                det.className = 'sb-section';
                det.id = sid;
                det.open = true;
                const sum = document.createElement('summary');
                sum.className = titleEl.className || 'section-title';
                if (titleEl.getAttribute('style')) sum.setAttribute('style', titleEl.getAttribute('style'));
                const k = titleEl.getAttribute('data-i18n');
                if (k) sum.setAttribute('data-i18n', k);
                while (titleEl.firstChild) sum.appendChild(titleEl.firstChild);
                const wrap = document.createElement('div');
                wrap.className = 'sb-body';
                titleEl.parentNode.insertBefore(det, titleEl);
                det.appendChild(sum);
                det.appendChild(wrap);
                wrap.appendChild(body);
                titleEl.parentNode.removeChild(titleEl);
                return det;
            }

            function sbUpgradeInjected() {
                Object.keys(SB_INJECTED_IDS).forEach(hostId => {
                    const host = document.getElementById(hostId);
                    if (!host) return;
                    const ids = SB_INJECTED_IDS[hostId];
                    const titles = Array.prototype.slice.call(host.children)
                        .filter(el => el.classList && el.classList.contains('section-title'));
                    titles.forEach((titleEl, i) => {
                        const sid = ids[i] || (hostId + 'Sec' + (i + 1));
                        if (document.getElementById(sid)) return;
                        try { sbWrapFlatSection(titleEl, sid); } catch (e) { }
                    });
                });
            }

            /* Un <summary> puo' contenere controlli veri (es. il "+" di Animazioni AI):
             * il click li attiverebbe E aprirebbe/chiuderebbe la sezione. preventDefault()
             * annulla solo l'azione predefinita del summary, il listener del pulsante
             * (che gira prima, in bubbling dal target) resta valido. */
            function sbGuardSummary(sum) {
                sum.addEventListener('click', (e) => {
                    if (e.target === sum) return;
                    if (e.target.closest && e.target.closest('button, a, input, select, textarea')) {
                        e.preventDefault();
                    }
                });
            }

            function sbInitSections() {
                const state = sbReadState();
                sbAllSections().forEach(det => {
                    if (det.dataset.sbInit) return;
                    det.dataset.sbInit = '1';
                    if (det.id && typeof state[det.id] === 'boolean') det.open = state[det.id];
                    const sum = det.querySelector(':scope > summary');
                    if (sum) sbGuardSummary(sum);
                    det.addEventListener('toggle', () => { sbSaveState(); sbSyncToggleAll(); });
                });
                // Lo stato vero e' applicato: le regole di pre-paint dell'<head> non
                // servono piu' (e riaprendo una sezione ne nasconderebbero il corpo).
                const pre = document.getElementById('sbSectionsPrepaint');
                if (pre && pre.parentNode) pre.parentNode.removeChild(pre);
            }

            /* ---------- Comando "Apri tutto / Chiudi tutto" per ogni scheda ---------- */
            const sbToggleAllBtns = [];

            function sbScopeSections(scope) {
                return Array.prototype.slice.call(scope.querySelectorAll(SB_SECTION_SEL));
            }

            function sbSyncToggleAll() {
                sbToggleAllBtns.forEach(btn => {
                    const scope = btn.parentElement;
                    if (!scope) return;
                    const secs = sbScopeSections(scope);
                    if (!secs.length) return;
                    const allOpen = secs.every(d => d.open);
                    const key = allOpen ? 'sections.collapseAll' : 'sections.expandAll';
                    btn.dataset.sbAction = allOpen ? 'collapse' : 'expand';
                    btn.classList.toggle('sb-collapsed', !allOpen);
                    btn.setAttribute('data-i18n', key);
                    btn.setAttribute('data-i18n-title', key + 'Title');
                    btn.textContent = sbLabel(key);
                    btn.setAttribute('title', sbLabel(key + 'Title'));
                });
            }

            function sbBuildToggleAll(scope) {
                if (!scope || scope.querySelector(':scope > .sb-toggle-all')) return;
                if (sbScopeSections(scope).length < 2) return;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'sb-toggle-all';
                btn.addEventListener('click', () => {
                    const want = btn.dataset.sbAction !== 'collapse';
                    sbScopeSections(scope).forEach(d => { d.open = want; });
                    sbSaveState();
                    sbSyncToggleAll();
                });
                scope.insertBefore(btn, scope.firstChild);
                sbToggleAllBtns.push(btn);
            }

            function sbBuildAllToggles() {
                document.querySelectorAll('.tab-content .tab-panel').forEach(sbBuildToggleAll);
                sbBuildToggleAll(document.getElementById('settingsBody'));
                sbSyncToggleAll();
            }

            function sbRefresh() {
                sbUpgradeInjected();
                sbInitSections();
                sbBuildAllToggles();
            }

            sbRefresh();

            /* La modale Impostazioni puo' essere aperta puntando a una sezione precisa
             * (es. i cookie al primo avvio, da 26-settings-modal.js): se quella sezione
             * e' chiusa l'utente vedrebbe solo il titolo. La apriamo prima dello
             * scrollIntoView. Ne approfittiamo per agganciare eventuali sezioni
             * iniettate dopo il boot. */
            if (typeof window.openSettingsModal === 'function') {
                const sbOpenSettings = window.openSettingsModal;
                window.openSettingsModal = function (opts) {
                    const res = sbOpenSettings.apply(this, arguments);
                    try {
                        sbRefresh();
                        const id = opts && opts.section;
                        const el = id ? document.getElementById(id) : null;
                        if (el) {
                            const det = el.closest(SB_SECTION_SEL) || el.querySelector(SB_SECTION_SEL);
                            if (det && !det.open) det.open = true;   // 'toggle' salva e risincronizza
                        }
                    } catch (e) { }
                    return res;
                };
            }
