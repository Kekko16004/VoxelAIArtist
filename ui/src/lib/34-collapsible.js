            // --- Pannelli di sinistra richiudibili -----------------------------------
            // Il pannello DESTRO ha le sue sezioni scritte a mano come <details
            // class="rp-section">. A sinistra le sezioni sono decine e crescono a ogni
            // funzione nuova, quindi invece di riscriverle una per una (e rischiare di
            // rompere un id o l'annotatore i18n) si arricchisce il markup esistente:
            //
            //   <div class="section-title">Titolo</div>   <- diventa cliccabile
            //   <div class="controls-group glass"> ... </div>   <- e' il corpo
            //
            // Il DOM non viene spostato: si aggiungono solo classi e un handler. Cosi'
            // ogni getElementById continua a trovare quello che cercava, applyI18n
            // continua a tradurre gli stessi nodi e nessuna sezione perde contenuti.
            //
            // Stato salvato in localStorage per titolo+indice: non ci sono id sulle
            // sezioni e aggiungerne 17 a mano si sarebbe scollato dal template alla
            // prima modifica.
            const COLLAPSE_LS_KEY = 'voxelai.collapsedSections';

            function loadCollapsedSet() {
                try {
                    const raw = localStorage.getItem(COLLAPSE_LS_KEY);
                    if (!raw) return new Set();
                    const arr = JSON.parse(raw);
                    return new Set(Array.isArray(arr) ? arr : []);
                } catch (e) { return new Set(); }
            }

            let collapsedSections = null;

            function saveCollapsedSet() {
                if (!collapsedSections) return;
                try {
                    localStorage.setItem(COLLAPSE_LS_KEY, JSON.stringify([...collapsedSections]));
                } catch (e) { /* storage non disponibile: si perde solo la preferenza */ }
            }

            // Chiave stabile di una sezione. Il testo del titolo cambia con la lingua,
            // quindi si usa la chiave i18n quando c'e'; l'indice fa da spareggio fra
            // sezioni omonime (i titoli scritti a mano non sono unici).
            function sectionKey(title, index) {
                const k = title.getAttribute('data-i18n')
                    || (title.querySelector('[data-i18n]') && title.querySelector('[data-i18n]').getAttribute('data-i18n'));
                if (k) return k;
                return 'idx:' + index + ':' + (title.textContent || '').trim().slice(0, 24);
            }

            function setSectionCollapsed(title, body, collapsed) {
                title.classList.toggle('is-collapsed', collapsed);
                title.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                body.classList.toggle('sec-collapsed', collapsed);
            }

            function initCollapsibleSections(root) {
                root = root || document;
                if (!collapsedSections) collapsedSections = loadCollapsedSet();
                const titles = root.querySelectorAll('.section-title');
                titles.forEach((title, index) => {
                    if (title.dataset.collapsible === '1') return;   // idempotente
                    // Il corpo e' il fratello successivo. Se non c'e' (titolo in coda a
                    // un blocco) la sezione resta semplicemente non richiudibile invece
                    // di agganciarsi a un nodo sbagliato.
                    const body = title.nextElementSibling;
                    if (!body) return;
                    title.dataset.collapsible = '1';
                    title.classList.add('sec-toggle');
                    title.setAttribute('role', 'button');
                    title.setAttribute('tabindex', '0');

                    const key = sectionKey(title, index);
                    setSectionCollapsed(title, body, collapsedSections.has(key));

                    const toggle = (ev) => {
                        // Il titolo "Animazioni AI" contiene un bottone +: un clic la'
                        // deve creare l'animazione, non chiudere la sezione sotto le dita.
                        if (ev.target.closest('button, input, select, a, [contenteditable="true"]')) return;
                        const nowCollapsed = !title.classList.contains('is-collapsed');
                        setSectionCollapsed(title, body, nowCollapsed);
                        if (nowCollapsed) collapsedSections.add(key);
                        else collapsedSections.delete(key);
                        saveCollapsedSet();
                    };
                    title.addEventListener('click', toggle);
                    title.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(ev); }
                    });
                });
            }

            // --- Pannello destro: le sezioni ricordano aperto/chiuso -----------------
            // A destra le sezioni sono gia' dei <details class="rp-section"> con id
            // stabili scritti nel template, quindi non serve arricchire il markup:
            // basta salvare quali id sono CHIUSI e ripristinarli al bootstrap.
            //
            // Si salva la lista dei chiusi, non quella degli aperti: cosi' una sezione
            // nuova aggiunta al template in futuro nasce con il default del template
            // invece di apparire chiusa perche' mancava dalla lista salvata.
            function initRightPanelPersist() {
                const RP_LS_KEY = 'voxelai.rpSections';
                const panels = document.querySelectorAll('.rp-section[id]');
                if (!panels.length || panels[0].dataset.rpPersist === '1') return;
                // Carica la lista degli id CHIUSI salvati. Se non c'e' nulla, lo stato
                // del template e' quello giusto (tre aperti, uno chiuso): non toccare.
                let closed;
                try {
                    const raw = localStorage.getItem(RP_LS_KEY);
                    closed = raw ? new Set(JSON.parse(raw)) : null;
                } catch (e) { closed = null; }
                panels.forEach(panel => {
                    panel.dataset.rpPersist = '1';
                    if (closed !== null) panel.open = !closed.has(panel.id);
                    // 'toggle', non 'click': <details> emette toggle QUANDO `open` e'
                    // gia' cambiato, sia da click che da codice. Con 'click' si
                    // leggerebbe lo stato vecchio (il click precede il cambio).
                    panel.addEventListener('toggle', () => {
                        let cur;
                        try {
                            const raw = localStorage.getItem(RP_LS_KEY);
                            cur = new Set(raw ? JSON.parse(raw) : []);
                        } catch (e) { cur = new Set(); }
                        if (panel.open) cur.delete(panel.id);
                        else cur.add(panel.id);
                        try {
                            localStorage.setItem(RP_LS_KEY, JSON.stringify([...cur]));
                        } catch (e) { /* storage non disponibile */ }
                    });
                });
            }
