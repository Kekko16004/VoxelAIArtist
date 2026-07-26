            const canvas = document.getElementById('canvas3d');
            // alpha:false -> il canvas e' OPACO. Con alpha:true Chromium/QtWebEngine
            // deve fondere il layer WebGL con la pagina sottostante a OGNI frame, e
            // gli overlay sopra il canvas (pannelli, HUD) vengono ricomposti insieme:
            // e' una delle cause del lampeggio della UI. La scena disegna gia' il
            // proprio sfondo opaco (scene.background, allineato al tema), quindi la
            // trasparenza del canvas non serviva a nulla.
            // powerPreference: su portatili con doppia GPU evita che il compositor
            // rimbalzi fra integrata e discreta, altro classico innesco di flicker.
            const renderer = new THREE.WebGLRenderer({
                canvas, antialias: true, alpha: false,
                powerPreference: 'high-performance', stencil: false
            });
            // Il devicePixelRatio grezzo su schermi 4K quadruplica i pixel da
            // disegnare: cap a 2 come fanno tutti gli editor 3D web.
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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

            // Global Gizmo (Ctrl+A)
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
                        let moved = false;
                        currentModelData.voxels.forEach(v => {
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
                    globalGizmoProxy.position.copy(modelPivot.position);
                }
            });
            globalTransformControls.addEventListener('objectChange', () => {
                if (!globalTransformControls.dragging) return;
                const delta = new THREE.Vector3().copy(globalGizmoProxy.position).sub(globalGizmoProxy.userData.startPos);
                modelPivot.position.copy(originalModelPivotPos).add(delta);
            });
            scene.add(globalTransformControls);

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
            };
            const KEYMAP = JSON.parse(JSON.stringify(DEFAULT_KEYMAP));
            function loadKeymap() {
                try {
                    const saved = localStorage.getItem('voxelai-keymap');
                    if (saved) Object.assign(KEYMAP, JSON.parse(saved));
                } catch (e) { /* storage non disponibile: si usano i default */ }
            }
            loadKeymap();

            window.addEventListener('keydown', (e) => {
                const t = e.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

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
                    pushHistory();
                    currentModelData.voxels = [];
                    rig = null;
                    globalTransformControls.detach();
                    if (typeof updateRigUI === 'function') updateRigUI();
                    buildModel();
                }
            });

            // Add tool logic for Clear All and Fill Floor
            document.getElementById('clearAllBtn').addEventListener('click', () => {
                if (!confirm('Sei sicuro di voler rimuovere tutti i voxel e azzerare il modello?')) return;
                pushHistory();
                currentModelData.voxels = [];
                rig = null;
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
                    const width = container.clientWidth;
                    const height = container.clientHeight;
                    camera.aspect = width / height;
                    camera.updateProjectionMatrix();
                    renderer.setSize(width, height);
                }
            }
            const resizeObserver = new ResizeObserver(() => {
                requestAnimationFrame(() => {
                    resizeCanvas();
                });
            });
            resizeObserver.observe(document.querySelector('.canvas-container'));
            window.addEventListener('resize', resizeCanvas);

            // Initialize UI Elements