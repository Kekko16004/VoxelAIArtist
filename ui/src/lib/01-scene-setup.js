            const canvas = document.getElementById('canvas3d');
            const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
            renderer.setPixelRatio(window.devicePixelRatio);
            renderer.setSize(canvas.clientWidth, canvas.clientHeight);

            const scene = new THREE.Scene();
            // Anti-flicker: dipingiamo uno sfondo OPACO dentro la scena invece di
            // lasciare il canvas trasparente (alpha:true). Con canvas trasparente,
            // Chromium ricompone il layer GL in alpha con la pagina ad OGNI frame:
            // durante rotazione/disegno questo lampeggia. Uno sfondo di scena opaco
            // elimina la ricomposizione per-frame. Il colore viene poi allineato al
            // tema chiaro/scuro da applySceneBackground() (vedi 17-theme.js).
            scene.background = new THREE.Color(0x0b0913);
            const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
            camera.position.set(20, 20, 20);

            const controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            controls.autoRotateSpeed = 2.0;

            // Blender-style navigation
            controls.mouseButtons = {
                LEFT: null,
                MIDDLE: THREE.MOUSE.ROTATE,
                RIGHT: null
            };
            renderer.domElement.addEventListener('pointerdown', (e) => {
                if (e.button === 1) { // Middle
                    controls.mouseButtons.MIDDLE = e.shiftKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
                }
            }, true);

            // Rotation modes:
            //  'none'   -> no auto rotation
            //  'object' -> the model spins around its own vertical axis (turntable); camera fixed
            //  'orbit'  -> the camera smoothly orbits around the model (The Finals style)
            let rotationMode = 'none';
            let modelCenter = new THREE.Vector3();
            // Meshes live under this pivot so 'object' mode can rotate them around the
            // model center cleanly, without the world-origin wobble of scene.rotation.
            const modelPivot = new THREE.Group();
            scene.add(modelPivot);

            // ===== T-props: anteprima transform LIVE (pannello Proprietà) =====
            // Il pannello Proprietà applica posizione/rotazione/scala dell'oggetto attivo
            // DAL VIVO, senza cuocere subito nei voxel: muove/ruota/scala visivamente il
            // modelPivot rispetto al centro "base" del modello. È fluido (float, non intero)
            // e non distruttivo; il bake nei voxel avviene solo al commit (blur/invio del
            // campo). buildModel() resetta il pivot a ogni rebuild, quindi dopo il rebuild
            // richiama reapplyLiveTransform() per non perdere l'anteprima in corso.
            const modelPivotBaseCenter = new THREE.Vector3();
            let liveTransform = null; // { position:{x,y,z}, rotationY:rad, scale } oppure null

            // Applica l'anteprima corrente al modelPivot combinando il centro base con la
            // trasformazione dei campi. La rotazione è attorno al centro del modello (il
            // pivot È già al centro), la scala è uniforme, la posizione è un offset.
            function reapplyLiveTransform() {
                if (!liveTransform) return;
                const t = liveTransform;
                const s = (t.scale === undefined || !(t.scale > 0)) ? 1 : t.scale;
                modelPivot.position.set(
                    modelPivotBaseCenter.x + (t.position ? t.position.x : 0),
                    modelPivotBaseCenter.y + (t.position ? t.position.y : 0),
                    modelPivotBaseCenter.z + (t.position ? t.position.z : 0)
                );
                // rotationY libera (radianti), non snappata: l'anteprima è fluida; lo snap a
                // 90° avviene solo al bake (bakeTransform).
                modelPivot.rotation.set(0, t.rotationY || 0, 0);
                modelPivot.scale.setScalar(s);
            }

            // Imposta/aggiorna l'anteprima live (chiamata dal pannello a ogni 'input').
            function setLiveTransform(t) {
                liveTransform = t;
                reapplyLiveTransform();
            }

            // Rimuove l'anteprima e riporta il pivot allo stato neutro (scala 1, rot 0).
            // Il prossimo buildModel riposiziona comunque position/rotation dal centro.
            function clearLiveTransform() {
                liveTransform = null;
                modelPivot.scale.setScalar(1);
                modelPivot.rotation.set(0, 0, 0);
            }

            // Global Gizmo (Ctrl+A o auto in Modalita' Oggetto)
            // In Modalita' Oggetto si attacca automaticamente alla selezione corrente:
            //   - se e' attiva una PARTE (activePartName), sposta solo i voxel di quella parte;
            //   - altrimenti sposta tutti i voxel dell'oggetto attivo.
            // Ctrl+A lo toglie/attacca manualmente anche in Modalita' Modifica.
            const globalGizmoProxy = new THREE.Object3D();
            globalGizmoProxy.userData = { startPos: new THREE.Vector3() };
            scene.add(globalGizmoProxy);

            let originalModelPivotPos = new THREE.Vector3();
            const globalTransformControls = new THREE.TransformControls(camera, renderer.domElement);
            globalTransformControls.setSize(1.2);
            globalTransformControls.setMode('translate');
            globalTransformControls.addEventListener('dragging-changed', e => {
                controls.enabled = !e.value;
                if (e.value) {
                    globalGizmoProxy.userData.startPos.copy(globalGizmoProxy.position);
                    originalModelPivotPos.copy(modelPivot.position);
                } else {
                    const delta = new THREE.Vector3().copy(globalGizmoProxy.position).sub(globalGizmoProxy.userData.startPos);
                    const dx = Math.round(delta.x);
                    const dy = Math.round(delta.y);
                    const dz = Math.round(delta.z);
                    if (dx !== 0 || dy !== 0 || dz !== 0) {
                        pushHistory();
                        // Se c'e' una parte attiva, sposta solo i voxel di quella parte;
                        // altrimenti sposta tutti i voxel dell'oggetto attivo.
                        const part = (typeof activePartName !== 'undefined') ? activePartName : null;
                        let moved = false;
                        currentModelData.voxels.forEach(v => {
                            if (part && v.part !== part) return;
                            v.x += dx; v.y += dy; v.z += dz;
                            moved = true;
                        });
                        if (moved) {
                            rebuildVoxelMap();
                            buildModel(false);
                        }
                    } else {
                        modelPivot.position.copy(originalModelPivotPos);
                    }
                    // Riposiziona il proxy sul nuovo centro (o lo stacca se in Object Mode
                    // per lasciare che attachSelectionGizmo lo riposizioni correttamente).
                    if (typeof editorMode !== 'undefined' && editorMode === 'object') {
                        attachSelectionGizmo();
                    } else {
                        globalGizmoProxy.position.copy(modelPivot.position);
                    }
                }
            });
            globalTransformControls.addEventListener('objectChange', () => {
                if (!globalTransformControls.dragging) return;
                // Anteprima live solo quando si sposta l'INTERO oggetto: muovere il
                // modelPivot con una parte selezionata farebbe scivolare tutto il modello
                // (anteprima fuorviante), quindi la parte si aggiorna solo al rilascio.
                if (typeof editorMode !== 'undefined' && editorMode === 'object'
                    && typeof activePartName !== 'undefined' && activePartName) return;
                const delta = new THREE.Vector3().copy(globalGizmoProxy.position).sub(globalGizmoProxy.userData.startPos);
                modelPivot.position.copy(originalModelPivotPos).add(delta);
            });
            scene.add(globalTransformControls);

            // Calcola il centro dei voxel da spostare (parte attiva o tutti).
            function selectionGizmoCenter() {
                const part = (typeof activePartName !== 'undefined') ? activePartName : null;
                const voxels = (currentModelData && currentModelData.voxels) || [];
                let minX = Infinity, minY = Infinity, minZ = Infinity;
                let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                let count = 0;
                voxels.forEach(v => {
                    if (part && v.part !== part) return;
                    if (v._hidden) return;
                    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
                    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
                    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
                    count++;
                });
                if (!count) return null;
                return new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
            }

            // Attacca il gizmo globale al centro della selezione corrente.
            // Chiamata da applyEditorMode, selectActiveObjectAndRefresh e click parte.
            function attachSelectionGizmo() {
                const center = selectionGizmoCenter();
                if (!center) { globalTransformControls.detach(); return; }
                globalGizmoProxy.position.copy(center);
                globalTransformControls.attach(globalGizmoProxy);
            }

            /* --- KEYMAP: mappa centrale degli shortcut (T6) --------------------
             * Fondamenta per il rebinding configurabile: tutti gli shortcut degli
             * strumenti passano da qui invece di essere hardcoded. L'editor di
             * rebinding (task futuro) dovrà solo scrivere in questo oggetto e
             * persisterlo in localStorage/settings, poi richiamare loadKeymap().
             * TODO(T6): pannello Impostazioni per riassegnare questi tasti. */
            const DEFAULT_KEYMAP = {
                tools: { '1': 'view', '2': 'place', '3': 'remove', '4': 'draw', '5': 'pick' },
                brushDown: '[',
                brushUp: ']',
                toggleMode: 'Tab', // T1 Fase B: alterna Modalità Oggetto / Modifica
                extrude: 'e',      // T2: attiva/cicla la modalità Estrusione facce
                togglePlay: ' ',   // Spazio: play/pausa dell'animazione al frame corrente
            };
            const KEYMAP = JSON.parse(JSON.stringify(DEFAULT_KEYMAP));
            function loadKeymap() {
                try {
                    const saved = localStorage.getItem('voxelai-keymap');
                    if (saved) Object.assign(KEYMAP, JSON.parse(saved));
                } catch (e) { /* storage non disponibile: si usano i default */ }
            }
            loadKeymap();

            /* --- Focus e scorciatoie -----------------------------------------
             * Dopo un click su un <select>/<input>/<button> del pannello sinistro
             * l'elemento CONSERVA il focus (bordo attorno). Le scorciatoie globali
             * si disattivavano per qualunque elemento focalizzato, quindi Ctrl+Z,
             * Ctrl+A, Tab... restavano morte finche' l'utente non cliccava altrove.
             *
             * Due livelli indipendenti, cosi' che nessuno dei due sia un punto
             * unico di rottura:
             *   1. isTypingTarget(): blocca la scorciatoia SOLO se l'elemento sta
             *      davvero ricevendo testo, oppure se il tasto premuto e' uno che
             *      quel controllo consuma nativamente (le frecce in un <select>).
             *      Ctrl+Z su un <select> non e' piu' bloccato: il select non ne fa
             *      nulla.
             *   2. releaseFocusAfterPointer(): dopo un'interazione col MOUSE i
             *      controlli non testuali lasciano il focus, quindi il caso non si
             *      presenta nemmeno.
             * Prima questa condizione era copiaincollata in 5 handler con 3
             * varianti diverse; ora la fonte e' una sola. */
            const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'tel', 'email', 'password',
                'number', 'date', 'time', 'datetime-local', 'month', 'week'];

            // Campo in cui l'utente sta DIGITANDO: qui le scorciatoie non devono
            // mai arrivare, altrimenti si mangiano i caratteri.
            function isTextEntry(el) {
                if (!el) return false;
                if (el.isContentEditable) return true;
                const tag = el.tagName;
                if (tag === 'TEXTAREA') return true;
                if (tag !== 'INPUT') return false;
                return TEXT_INPUT_TYPES.indexOf(String(el.type || 'text').toLowerCase()) !== -1;
            }

            const NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                'Home', 'End', 'PageUp', 'PageDown'];

            // Tasti che il controllo focalizzato usa DAVVERO. Un <select> consuma
            // frecce, invio, spazio e le lettere singole (type-ahead); uno slider
            // solo le frecce; un bottone solo spazio/invio. Tutto il resto (Ctrl+Z,
            // Ctrl+A, Tab...) puo' passare senza rubare niente a nessuno.
            function keyConsumedByControl(el, e) {
                if (!el || !e) return false;
                if (e.ctrlKey || e.metaKey || e.altKey) return false;
                const key = e.key;
                const tag = el.tagName;
                const type = String(el.type || '').toLowerCase();
                const isNav = NAV_KEYS.indexOf(key) !== -1;
                if (tag === 'SELECT') {
                    return isNav || key === 'Enter' || key === 'Escape' || key === ' '
                        || (typeof key === 'string' && key.length === 1);
                }
                if (tag === 'INPUT' && type === 'range') return isNav;
                if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) return key === ' ';
                if (tag === 'INPUT' && (type === 'color' || type === 'file')) return key === ' ' || key === 'Enter';
                if (tag === 'BUTTON' || tag === 'A'
                    || (el.getAttribute && el.getAttribute('role') === 'button')
                    || (tag === 'INPUT' && (type === 'button' || type === 'submit' || type === 'reset'))) {
                    return key === ' ' || key === 'Enter';
                }
                return false;
            }

            /* True se la scorciatoia globale NON deve scattare per questo evento.
             * Accetta l'evento (non solo l'elemento) perche' la risposta dipende
             * anche dal tasto: lo stesso <select> blocca ArrowDown e lascia
             * passare Ctrl+Z. */
            function isTypingTarget(e) {
                const el = (e && e.target) || null;
                if (isTextEntry(el)) return true;
                return keyConsumedByControl(el, e);
            }

            // Toglie il focus al prossimo giro di eventloop, se nel frattempo non
            // e' finito su un campo di testo (dove va lasciato stare).
            function blurSoon(el) {
                if (!el || typeof el.blur !== 'function') return;
                if (isTextEntry(el)) return;
                setTimeout(() => {
                    try {
                        if (document.activeElement === el && !isTextEntry(el)) el.blur();
                    } catch (err) { /* elemento rimosso dal DOM nel frattempo */ }
                }, 0);
            }

            function releaseFocusAfterPointer() {
                if (!document.addEventListener) return;
                // Scelta completata su select/checkbox/radio/slider: il controllo
                // ha finito il suo lavoro, non gli serve piu' il focus.
                document.addEventListener('change', (e) => {
                    const el = e && e.target;
                    if (!el || isTextEntry(el)) return;
                    if (el.tagName === 'SELECT' || el.tagName === 'INPUT') blurSoon(el);
                });
                // Click col MOUSE: `e.detail > 0` distingue il click vero da quello
                // sintetico generato da Invio/Spazio su un elemento focalizzato via
                // Tab. Su quello sintetico il focus va CONSERVATO, altrimenti si
                // spezza la navigazione da tastiera.
                document.addEventListener('click', (e) => {
                    if (!e || !e.detail) return;
                    const el = e.target;
                    if (!el || !el.closest) return;
                    if (!el.closest('button, [role="button"], select, label, input')) return;
                    const active = document.activeElement;
                    if (!active || isTextEntry(active)) return;
                    if (active.tagName === 'SELECT' || active.tagName === 'INPUT') return;
                    blurSoon(active);
                });
            }
            releaseFocusAfterPointer();

            window.addEventListener('keydown', (e) => {
                if (isTypingTarget(e)) return;

                if (e.ctrlKey && e.key.toLowerCase() === 'a') {
                    e.preventDefault();
                    if (globalTransformControls.object) {
                        globalTransformControls.detach();
                    } else {
                        globalGizmoProxy.position.copy(modelPivot.position);
                        globalTransformControls.attach(globalGizmoProxy);
                    }
                }

                if ((e.key === 'Delete' || e.key === 'Backspace') && globalTransformControls.object) {
                    e.preventDefault();
                    // In Modalita' Oggetto il gizmo e' agganciato alla selezione: Delete
                    // elimina l'oggetto (o la PARTE) attiva rispettando la selezione,
                    // invece di azzerare tutti i voxel.
                    if (typeof editorMode !== 'undefined' && editorMode === 'object'
                        && typeof objDelete === 'function') {
                        objDelete();
                        return;
                    }
                    pushHistory();
                    currentModelData.voxels = [];
                    // Il rig vive sull'oggetto: azzerare solo la variabile non bastava,
                    // il buildModel() qui sotto lo riadotterebbe da obj.rig (scheletro
                    // di un modello che non esiste piu').
                    discardRigOfActiveObject();
                    globalTransformControls.detach();
                    if (typeof updateRigUI === 'function') updateRigUI();
                    buildModel();
                }
            });

            // Butta via il rig dell'oggetto attivo (dati inclusi). Usato quando i voxel
            // vengono azzerati: lo scheletro non ha piu' nulla da deformare.
            function discardRigOfActiveObject() {
                rig = null;
                selectedBoneIndex = -1;
                if (typeof clearRigPreview === 'function') clearRigPreview();
                const o = (typeof getActiveObject === 'function') ? getActiveObject() : null;
                if (o) delete o.rig;
            }

            // Add tool logic for Clear All and Fill Floor
            document.getElementById('clearAllBtn').addEventListener('click', () => {
                if (!confirm('Sei sicuro di voler rimuovere tutti i voxel e azzerare il modello?')) return;
                pushHistory();
                currentModelData.voxels = [];
                discardRigOfActiveObject();
                globalTransformControls.detach();
                if (typeof updateRigUI === 'function') updateRigUI();
                buildModel();
            });
            document.getElementById('fillFloorBtn').addEventListener('click', () => {
                pushHistory();
                const g = currentModelData.metadata.grid_size || [16, 16, 16];
                for (let x = 0; x < g[0]; x++) {
                    for (let z = 0; z < g[2]; z++) {
                        const key = `${x},0,${z}`;
                        voxelMap.set(key, activeColorHex);
                    }
                }
                syncVoxelsFromMap();
                buildModel(false);
            });

            // Lighting
            const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
            scene.add(ambientLight);

            const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.6);
            dirLight1.position.set(100, 120, 50);
            scene.add(dirLight1);

            const dirLight2 = new THREE.DirectionalLight(0xa5b4fc, 0.3);
            dirLight2.position.set(-100, -50, -50);
            scene.add(dirLight2);

            function resizeCanvas() {
                const container = document.querySelector('.canvas-container');
                if (container) {
                    // La timeline (33-timeline.js) e' un dock in position:absolute DENTRO
                    // .canvas-container: il container non si stringe da solo, quindi la sua
                    // altezza va scalata a mano o il renderer finirebbe sotto al dock.
                    // timelineHeight() torna 0 quando la timeline e' nascosta.
                    const dock = (typeof timelineHeight === 'function') ? (timelineHeight() || 0) : 0;
                    const width = container.clientWidth;
                    const height = container.clientHeight - dock;
                    if (width <= 0 || height <= 0 || isNaN(width) || isNaN(height)) return;
                    camera.aspect = width / height;
                    camera.updateProjectionMatrix();
                    renderer.setSize(width, height);
                    if (typeof renderOnDemand === 'function') renderOnDemand();
                }
            }
            let resizeScheduled = false;
            function scheduleResize() {
                if (resizeScheduled) return;
                resizeScheduled = true;
                requestAnimationFrame(() => {
                    resizeScheduled = false;
                    resizeCanvas();
                });
            }
            const resizeObserver = new ResizeObserver(() => {
                scheduleResize();
            });
            const canvasContainerEl = document.querySelector('.canvas-container');
            if (canvasContainerEl) {
                resizeObserver.observe(canvasContainerEl);
            }
            window.addEventListener('resize', scheduleResize);

            // Initialize UI Elements