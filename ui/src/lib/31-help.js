            /* ===== Modale Aiuto: guide all'uso dell'app ==========================
             * Il testo NON vive qui: sta in ui/locales/*.json sotto le chiavi
             * help.s.<id>.t (titolo) e help.s.<id>.b (corpo). Qui restano solo
             * l'ordine delle sezioni, il loro id e l'icona, cioe' le uniche cose
             * che non sono testo per l'utente.
             *
             * Prima le stringhe italiane erano duplicate anche qui come
             * "fallback": 85 stringhe morte, perche' le chiavi esistono in tutte
             * e 6 le lingue e quel ramo non e' mai scattato. Una copia che non
             * viene mai letta puo' solo divergere in silenzio da quella vera, e
             * infatti divergeva gia': il titolo di `objects` si portava dietro
             * uno spazio unificatore che la traduzione non ha. Vedi la regola
             * "nessun testo per l'utente hardcoded" nel CLAUDE.md.
             *
             * Micro-markup del corpo: una riga per voce di elenco;
             *   *grassetto*   -> <b>
             *   [Ctrl+Z]      -> <kbd>
             * Nessun HTML nelle stringhe: i nodi sono costruiti a mano, cosi' una
             * traduzione non puo' iniettare markup. */

            const HELP_SECTIONS = [
                { id: 'start', icon: '\u{1F680}' },
                { id: 'nav', icon: '\u{1F9ED}' },
                { id: 'draw', icon: '\u{270F}' },
                { id: 'sym', icon: '\u{1FA9E}' },
                { id: 'objects', icon: '\u{1F9E9}' },
                { id: 'ai', icon: '\u{1F916}' },
                { id: 'humanoid', icon: '\u{1F9CD}' },
                { id: 'pack', icon: '\u{1F4E6}' },
                { id: 'rig', icon: '\u{1F9B4}' },
                { id: 'weights', icon: '\u{1F3A8}' },
                { id: 'anim', icon: '\u{1F3AC}' },
                { id: 'export', icon: '\u{1F4BE}' },
                { id: 'keys', icon: '\u{2328}' }
            ];

            // Testo di una sezione, sempre dal dizionario. t() torna la CHIAVE
            // quando il dizionario non e' ancora carico (vedi 23-i18n.js): in quel
            // caso si mostra il vuoto invece della chiave nuda. Non e' un caso che
            // si veda, perche' la guida si ricostruisce a ogni apertura e li' i
            // dizionari ci sono sempre.
            function helpText(id, field) {
                if (typeof t !== 'function') return '';
                const key = 'help.s.' + id + '.' + field;
                const v = t(key);
                return (v === key || v === undefined) ? '' : v;
            }

            // Micro-markup -> nodi DOM (niente innerHTML: le stringhe arrivano dai
            // file di traduzione e non devono poter iniettare markup).
            function appendHelpMarkup(host, line) {
                const re = /\*([^*]+)\*|\[([^\]]+)\]/g;
                let last = 0, m;
                while ((m = re.exec(line)) !== null) {
                    if (m.index > last) host.appendChild(document.createTextNode(line.slice(last, m.index)));
                    if (m[1] !== undefined) {
                        const b = document.createElement('b');
                        b.textContent = m[1];
                        host.appendChild(b);
                    } else {
                        const k = document.createElement('kbd');
                        k.textContent = m[2];
                        host.appendChild(k);
                    }
                    last = re.lastIndex;
                }
                if (last < line.length) host.appendChild(document.createTextNode(line.slice(last)));
            }

            // Ricostruisce indice + corpo. `filter` (opzionale) mostra solo le sezioni
            // che contengono il testo cercato.
            function renderHelp(filter) {
                const idxHost = document.getElementById('helpIndex');
                const bodyHost = document.getElementById('helpBody');
                if (!idxHost || !bodyHost) return;
                const q = (filter || '').trim().toLowerCase();
                idxHost.innerHTML = '';
                bodyHost.innerHTML = '';
                let shown = 0;

                HELP_SECTIONS.forEach(sec => {
                    const title = helpText(sec.id, 't');
                    const body = helpText(sec.id, 'b');
                    const lines = String(body).split('\n').filter(l => l.trim());
                    if (q && (title + ' ' + body).toLowerCase().indexOf(q) === -1) return;
                    shown++;

                    const nav = document.createElement('button');
                    nav.type = 'button';
                    nav.className = 'help-nav-item';
                    nav.dataset.helpTarget = sec.id;
                    nav.appendChild(document.createTextNode(sec.icon + '  ' + title));
                    nav.addEventListener('click', () => {
                        const target = document.getElementById('helpSec-' + sec.id);
                        if (target && typeof target.scrollIntoView === 'function') {
                            target.scrollIntoView({ block: 'start', behavior: 'smooth' });
                        }
                        idxHost.querySelectorAll('.help-nav-item').forEach(b =>
                            b.classList.toggle('active', b === nav));
                    });
                    idxHost.appendChild(nav);

                    const section = document.createElement('div');
                    section.className = 'help-section';
                    section.id = 'helpSec-' + sec.id;
                    const h = document.createElement('h3');
                    h.appendChild(document.createTextNode(sec.icon + ' ' + title));
                    section.appendChild(h);
                    const ul = document.createElement('ul');
                    lines.forEach(line => {
                        const li = document.createElement('li');
                        appendHelpMarkup(li, line);
                        ul.appendChild(li);
                    });
                    section.appendChild(ul);
                    bodyHost.appendChild(section);
                });

                if (!shown) {
                    const empty = document.createElement('div');
                    empty.className = 'help-empty';
                    empty.textContent = (typeof t === 'function') ? t('help.noResults') : '';
                    bodyHost.appendChild(empty);
                }
                const first = idxHost.querySelector('.help-nav-item');
                if (first) first.classList.add('active');
            }

            /* ---------- Apri / chiudi la modale ---------- */
            (function initHelpModal() {
                const overlay = document.getElementById('helpOverlay');
                const openBtn = document.getElementById('openHelpBtn');
                const closeBtn = document.getElementById('helpCloseBtn');
                const search = document.getElementById('helpSearch');
                if (!overlay) return;

                function isOpen() { return overlay.style.display === 'flex'; }
                function open() {
                    // Ricostruita a ogni apertura: cosi' prende la lingua attiva senza
                    // dover ri-agganciare le traduzioni a mano.
                    renderHelp(search ? search.value : '');
                    overlay.style.display = 'flex';
                    if (search && typeof search.focus === 'function') search.focus();
                }
                function close() { overlay.style.display = 'none'; }

                if (openBtn) openBtn.addEventListener('click', open);
                if (closeBtn) closeBtn.addEventListener('click', close);
                overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
                if (search) search.addEventListener('input', () => renderHelp(search.value));

                document.addEventListener('keydown', (e) => {
                    if (e.key === 'F1') {
                        e.preventDefault();
                        if (isOpen()) { close(); return; }
                        // Non aprire l'Aiuto SOTTO un'altra modale. helpOverlay ha
                        // z-index 70, mentre primOverlay ne ha 95 e importOverlay 90:
                        // F1 a dialogo aperto costruiva l'Aiuto invisibile dietro, e
                        // quello ricompariva dal nulla appena si chiudeva il dialogo.
                        // La chiusura resta sempre permessa (il ramo qui sopra), cosi'
                        // F1 non puo' intrappolare l'Aiuto gia' aperto.
                        if (typeof tlModalOpen === 'function' && tlModalOpen()) return;
                        open();
                        return;
                    }
                    if (e.key === 'Escape' && isOpen()) close();
                });
            })();
