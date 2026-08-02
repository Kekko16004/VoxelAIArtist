            /* ===== Modale Aiuto: guide all'uso dell'app ==========================
             * Il testo vive QUI (un solo posto) e viene tradotto con le chiavi
             * help.s.<id>.t / help.s.<id>.b: se la lingua attiva non ha la chiave,
             * t() ricade su it.json e, se manca anche quello, sul testo italiano
             * scritto in questo file (quindi la guida non è mai vuota).
             *
             * Micro-markup del corpo: una riga per voce di elenco;
             *   *grassetto*   -> <b>
             *   [Ctrl+Z]      -> <kbd>
             * Nessun HTML nelle stringhe: i nodi sono costruiti a mano, così una
             * traduzione non può iniettare markup. */

            const HELP_SECTIONS = [
                {
                    id: 'start', icon: '\u{1F680}', title: 'Primi passi',
                    body: [
                        'La sidebar a sinistra ha quattro schede: *Genera* (AI), *Vista* (aspetto), *Disegna* (strumenti), *Rig* (scheletro e animazioni).',
                        'Il pannello a destra elenca gli *oggetti* della scena e ne mostra le *proprietà*.',
                        'La barra in alto raccoglie *File* (progetti .voxai), *Importa*, *Esporta*, *Aiuto* e *Impostazioni*.',
                        'Per partire da zero: *Genera > Nuovo progetto*, dai un nome e una griglia (es. 32,32,32).',
                        'Il salvataggio automatico è attivo: *File > Cronologia salvataggi* recupera le versioni recenti.'
                    ].join('\n')
                },
                {
                    id: 'nav', icon: '\u{1F9ED}', title: 'Muoversi nella vista',
                    body: [
                        '*Rotella premuta* ruota la vista attorno al modello (come in Blender).',
                        '*Shift + rotella premuta* sposta la vista (pan); la *rotella* fa zoom.',
                        'Il tasto sinistro resta libero per gli strumenti: per disegnare non devi tenere premuto altro.',
                        'In *Vista* accendi griglia, wireframe, spazio fra i voxel e la rotazione automatica (oggetto o camera).',
                        'La scena viene ridisegnata solo quando cambia qualcosa: è normale che il contatore di frame resti fermo.'
                    ].join('\n')
                },
                {
                    id: 'draw', icon: '\u{270F}', title: 'Disegnare voxel',
                    body: [
                        'Strumenti: [1] Vista, [2] Piazza, [3] Rompi, [4] Disegna (traccia continua), [5] Preleva colore.',
                        'Il colore attivo si sceglie dalla palette o dal selettore; *Preleva* copia il colore di un voxel esistente.',
                        'Il pennello va da 1 a 6 voxel: [ e ] lo rimpiccioliscono o lo ingrandiscono.',
                        'Anteprima verde = dove nascerà il voxel; contorno rosso = cosa verrà rimosso.',
                        '[Ctrl+Z] annulla, [Ctrl+Y] (oppure [Ctrl+Shift+Z]) ripristina.',
                        '*Svuota tutto* azzera i voxel dell\'oggetto attivo (e il suo scheletro), chiedendo conferma.'
                    ].join('\n')
                },
                {
                    id: 'sym', icon: '\u{1FA9E}', title: 'Simmetria, aree, estrusione',
                    body: [
                        'La *simmetria* X/Y/Z specchia ogni modifica rispetto al centro della griglia; il piano translucido mostra dove.',
                        'Trascinando col tasto sinistro selezioni un *rettangolo* di voxel: al rilascio l\'operazione si applica a tutta l\'area.',
                        '[Q] cambia l\'asse di vincolo del trascinamento: auto (normale alla faccia), X, Y, Z.',
                        '[E] arma l\'*estrusione* della faccia sotto il cursore: muovi il mouse per lo spessore, [E] di nuovo cicla l\'asse, [Esc] annulla.',
                        'Durante un trascinamento rettangolare, [E] dà profondità alla selezione: da rettangolo a blocco.'
                    ].join('\n')
                },
                {
                    id: 'objects', icon: '\u{1F9E9}', title: 'Oggetti, scena e proprietà',
                    body: [
                        '[Tab] alterna *Modalità Oggetto* (sposti e selezioni interi oggetti) e *Modalità Modifica* (lavori sui voxel).',
                        'Nel pannello Oggetti: *Nuovo*, *Duplica*, *Elimina*, *Unisci*; l\'occhio nasconde, il doppio clic rinomina.',
                        '*Proprietà* applica posizione, rotazione (a passi di 90°) e scala dal vivo: il valore viene cotto nei voxel quando lasci il campo.',
                        'Ogni oggetto porta il *proprio* rig: importare un file in una scena non vuota aggiunge un oggetto invece di sostituire la scena.',
                        'Attenzione: Nuovo / Duplica / Elimina / Unisci non si annullano con [Ctrl+Z].'
                    ].join('\n')
                },
                {
                    id: 'ai', icon: '\u{1F916}', title: 'Generazione con l\'AI',
                    body: [
                        'In *Genera* descrivi il modello ("un drago rosso in una griglia 32") e premi Genera.',
                        'In modalità *Modifica* viene inviato il modello corrente insieme alla richiesta ("aggiungi le ali") e torna la versione modificata.',
                        'La griglia arriva a 512 per lato; l\'opzione *struttura grande* spinge l\'AI a usare tutto lo spazio con facciate, interni, tetti e scale.',
                        'L\'opzione *Personaggio umanoide* impone T-pose, gambe staccate e una parte per arto, così il modello è animabile appena generato (vedi la sezione dedicata).',
                        'Serve un accesso valido a Gemini: i cookie si incollano in *Impostazioni* e restano solo sul tuo computer.',
                        'Se la risposta è malformata viene riparata automaticamente; se resta invalida riprova o riformula la richiesta.',
                        'Un tetto automatico sui voxel evita che una singola istruzione sbagliata riempia milioni di celle e blocchi l\'app.'
                    ].join('\n')
                },
                {
                    id: 'humanoid', icon: '\u{1F9CD}', title: 'Personaggi umanoidi (rig-ready)',
                    body: [
                        'In *Genera* c\'è l\'opzione *Personaggio umanoide*: accendila quando il soggetto è una persona, un robot antropomorfo o una creatura bipede.',
                        'Con l\'opzione accesa l\'AI riceve regole aggiuntive: *T-pose*, braccia orizzontali, gambe dritte e parallele, piedi a terra e modello centrato sull\'asse X.',
                        'Fra le due gambe viene lasciato un *vuoto di almeno 2 voxel* fino a terra, e almeno 1 voxel sotto l\'ascella: senza stacco il rig non distingue gli arti.',
                        'La regola più importante è la *suddivisione per arto*: il modello arriva diviso in testa, collo, torso, bacino, braccio_R, mano_R, braccio_L, mano_L, gamba_R, piede_R, gamba_L, piede_L.',
                        'Il suffisso *_R* indica il lato a X maggiore, *_L* quello a X minore: è la stessa convenzione dello scheletro generato dall\'app.',
                        'Vestiti e accessori seguono l\'arto che coprono: i pantaloni della gamba destra stanno dentro *gamba_R*, lo stivale destro dentro *piede_R*, capelli e caschi dentro *testa*.',
                        'Sono vietate parti come *pantaloni*, *stivali*, *guanti* o *vestito*: coprono due arti, e il rig assegna ogni parte a una sola catena di ossa. Il risultato sarebbe una gamba sola con l\'altra saldata addosso.',
                        'Accessori che non seguono un arto (mantello, zaino, coda, ali) restano in parti a sé.',
                        'Nessuna parte del corpo è spessa 1 voxel: braccia e gambe almeno 3x3 di sezione, collo almeno 2x2, così il rig ha volume da deformare.',
                        'L\'opzione *accende da sola* la suddivisione in parti (spegne "oggetto unico"): senza il formato a parti i nomi degli arti non avrebbero dove stare.',
                        'Nella scheda *Pack* esiste la stessa opzione, per generare un\'intera serie di personaggi coerenti e già pronti per il rig.',
                        'Vale anche per i modelli che importi: se dividi tu le parti con questi nomi, *Genera scheletro* aggancia ogni arto alla catena giusta.'
                    ].join('\n')
                },
                {
                    id: 'pack', icon: '\u{1F4E6}', title: 'Pack di asset',
                    body: [
                        'Un *pack* genera più oggetti (con varianti) in un\'unica sessione, tenendo lo stesso stile.',
                        'La coda vive nel processo Python: puoi ricaricare la finestra senza perdere una generazione lunga.',
                        'Lo stile è *imposto*, non chiesto: la palette dei riferimenti (o del primo asset riuscito) viene riapplicata a tutti gli altri.',
                        'Una richiesta per volta, di proposito: il client Gemini usa i cookie del browser e in parallelo verrebbe limitato.',
                        'I pack completati restano su disco e si esportano in un unico file ZIP.'
                    ].join('\n')
                },
                {
                    id: 'rig', icon: '\u{1F9B4}', title: 'Rig: scheletro e posa',
                    body: [
                        '*Genera scheletro* costruisce le ossa in proporzione al modello e assegna ogni voxel a un osso.',
                        'Se il modello è diviso in parti, ogni parte finisce su *una sola catena di ossa*: una parte che copre due arti (tipo "pantaloni") li fonde insieme. Genera i personaggi con l\'opzione *Personaggio umanoide* o dividi le parti per arto.',
                        'Per selezionare un\'articolazione clicca il suo *pallino chiaro*: la ricerca avviene in pixel sullo schermo, quindi non serve mirare preciso.',
                        'Gizmo: [R] ruota l\'osso (posa), [G] sposta l\'articolazione (per correggere lo scheletro).',
                        'Le ossa-punta di mani, piedi e testa sono nascoste: danno solo l\'orientamento in Blender e non prendono voxel.',
                        '*Mostra rig* rientra nell\'anteprima del rig già salvato sull\'oggetto, senza rigenerarlo (rigenerare perderebbe posa e pesi).',
                        'Il rig sopravvive a rebuild, cambio oggetto e salvataggio: non serve tenere aperta la scheda Rig per esportarlo.',
                        'Ossa: *+ Osso* aggiunge un figlio a quello selezionato, *doppio clic sul nome* lo rinomina, *Elimina* riattacca i figli al genitore. Il nome è l\'identità: posa, pesi dipinti e clip lo seguono.',
                        '*Simmetria X* specchia la posa con un click (L>R, R>L o scambio dei due lati) e, se hai dipinto i pesi, anche le correzioni: il voxel gemello è minX+maxX-x.',
                        '*Simmetrizza scheletro* rimette L e R a combaciare dopo le correzioni con [G]: copia un lato sull\'altro (o fa la media) e riaggancia le ossa centrali all\'asse.',
                        '*Punta arto (IK)*: attivalo e trascina una mano o un piede; le due ossa a monte (spalla+gomito, anca+ginocchio) si orientano da sole e un trascinamento intero si annulla con un solo [Ctrl+Z].',
                        '*Libreria pose*: salva la posa corrente e riapplicala anche su un altro oggetto; entra sulle ossa con lo stesso nome, le altre vengono ignorate.'
                    ].join('\n')
                },
                {
                    id: 'weights', icon: '\u{1F3A8}', title: 'Pittura pesi',
                    body: [
                        'Il legame è *rigido*: ogni voxel appartiene a un osso solo. Se un pezzo si muove con l\'osso sbagliato, ridipingilo.',
                        'Attivando *Pittura pesi* la posa viene azzerata (serve la posa di riposo) e il gizmo si disattiva.',
                        'Scegli l\'osso di destinazione, poi trascina sul modello col tasto sinistro: i colori mostrano l\'osso di ogni voxel.',
                        'Modalità: *Pennello* (sfera di raggio regolabile), *Riempi* (tutti i voxel collegati che appartengono allo stesso osso), *Cancella* (torna all\'automatico).',
                        '*Azzera correzioni* rifà il binding automatico; ogni pennellata si annulla con [Ctrl+Z].',
                        'Le correzioni sono salvate nel progetto e finiscono nell\'export GLB.'
                    ].join('\n')
                },
                {
                    id: 'anim', icon: '\u{1F3AC}', title: 'Animazioni',
                    body: [
                        'Le clip pronte (idle, camminata, saluto...) si scelgono dal menu e partono subito nell\'anteprima.',
                        'Puoi chiedere un\'animazione all\'AI: le clip generate restano nel rig e vengono salvate col progetto.',
                        'I cursori di posa muovono l\'osso selezionato; la posa corrente entra nell\'export GLB.',
                        'L\'animazione si ferma da sola quando entri in pittura pesi, perché serve la posa di riposo.'
                    ].join('\n')
                },
                {
                    id: 'export', icon: '\u{1F4BE}', title: 'Salvare ed esportare',
                    body: [
                        '*GLB* è il formato per Blender / Unity / Godot: porta scheletro, pesi rigidi e clip. L\'autoscale 1/100 evita modelli giganteschi.',
                        '*OBJ + MTL*: le facce complanari vengono unite in quadrilateri grandi; tieni i due file nella stessa cartella o i materiali risultano bianchi.',
                        '*.vox* per MagicaVoxel, *.schem* per Minecraft (WorldEdit / Litematica).',
                        '*.voxelai* (offuscato) e *.json* (in chiaro) conservano tutto: voxel, oggetti, trasformazioni e un rig per oggetto.',
                        'Il rig salvato contiene tipo, ossa, posa, pesi dipinti e animazioni AI: riaprendo il file ritrovi lo stesso stato.',
                        '*File > Salva progetto* (.voxai) è la via più comoda per riprendere il lavoro più tardi.'
                    ].join('\n')
                },
                {
                    id: 'keys', icon: '\u{2328}', title: 'Scorciatoie',
                    body: [
                        '[1] [2] [3] [4] [5] strumenti — [ e ] dimensione del pennello.',
                        '[Tab] Modalità Oggetto / Modifica — [Q] asse di vincolo — [E] estrusione — [Esc] annulla il gesto in corso.',
                        '[Ctrl+Z] annulla — [Ctrl+Y] ripristina — [Canc] elimina l\'oggetto selezionato.',
                        '[R] e [G] cambiano il gizmo del rig: ruota la posa / sposta l\'articolazione.',
                        '[F1] apre questa guida. I tasti si possono riassegnare in *Impostazioni > Scorciatoie*.'
                    ].join('\n')
                }
            ];

            // Testo di una sezione: traduzione se disponibile, altrimenti l'italiano
            // scritto sopra. t() restituisce la CHIAVE quando manca, ed è il segnale
            // che usiamo per ricadere sul fallback.
            function helpText(id, field, fallback) {
                if (typeof t !== 'function') return fallback;
                const key = 'help.s.' + id + '.' + field;
                const v = t(key);
                return (v === key || v === undefined) ? fallback : v;
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
                    const title = helpText(sec.id, 't', sec.title);
                    const body = helpText(sec.id, 'b', sec.body);
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
                    empty.textContent = (typeof t === 'function' && t('help.noResults') !== 'help.noResults')
                        ? t('help.noResults')
                        : 'Nessun risultato nella guida.';
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
                    // Ricostruita a ogni apertura: così prende la lingua attiva senza
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
                    if (e.key === 'F1') { e.preventDefault(); if (isOpen()) close(); else open(); return; }
                    if (e.key === 'Escape' && isOpen()) close();
                });
            })();
