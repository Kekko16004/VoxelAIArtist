            function updateHistoryButtons() {
                undoBtn.disabled = undoStack.length === 0;
                redoBtn.disabled = redoStack.length === 0;
            }

            // T1 Fase B: cattura voxel dell'ATTIVO + rig + struttura scena (nomi, transform,
            // visibilità, quale è attivo). LIMITE noto: NON cattura i voxel degli oggetti
            // non attivi, e non ripristina aggiunte/eliminazioni di oggetti (solo attributi
            // di quelli tuttora esistenti). Le operazioni Nuovo/Duplica/Elimina/Unisci non
            // sono quindi annullabili con Ctrl+Z (per scelta: evitare snapshot pesanti).
            // Corollario da NON dimenticare: uno scatto vale per l'oggetto che era attivo
            // quando è stato preso. Chi lo ripristina deve prima tornare su quell'oggetto,
            // altrimenti ne svuota un altro — vedi applySnapshot e
            // tests/test_undo_object_switch.mjs.
            function captureSnapshot() {
                return {
                    voxels: JSON.parse(JSON.stringify(currentModelData.voxels || [])),
                    // Copia PROFONDA e completa del rig: prima mancavano `customAnims` (un
                    // Ctrl+Z dopo aver generato un'animazione AI la cancellava) e `weights`
                    // (annullava le correzioni del weight paint senza poterle ripristinare).
                    rig: rig ? {
                        bones: JSON.parse(JSON.stringify(rig.bones)),
                        pose: JSON.parse(JSON.stringify(rig.pose || {})),
                        // Canale di traslazione della posa: senza questa riga un
                        // keyframe "Location" non sopravviveva a un Ctrl+Z.
                        posePos: JSON.parse(JSON.stringify(rig.posePos || {})),
                        weights: rig.weights ? JSON.parse(JSON.stringify(rig.weights)) : null,
                        customAnims: JSON.parse(JSON.stringify(rig.customAnims || [])),
                        type: rig.type, binding: rig.binding
                    } : null,
                    selectedBoneIndex: selectedBoneIndex,
                    activeObjectId: activeObjectId,
                    sceneMeta: sceneObjects.map(o => ({
                        id: o.id, name: o.name, visible: o.visible,
                        transform: JSON.parse(JSON.stringify(o.transform || makeDefaultTransform()))
                    }))
                };
            }

            function pushHistory() {
                undoStack.push(JSON.stringify(captureSnapshot()));
                if (undoStack.length > MAX_HISTORY) undoStack.shift();
                redoStack.length = 0;
                updateHistoryButtons();
            }

            function restoreSceneMeta(snap) {
                if (Array.isArray(snap.sceneMeta)) {
                    snap.sceneMeta.forEach(m => {
                        const obj = sceneObjects.find(o => o.id === m.id);
                        if (obj) { obj.name = m.name; obj.visible = m.visible; obj.transform = m.transform; }
                    });
                }
                if (snap.activeObjectId != null && sceneObjects.some(o => o.id === snap.activeObjectId)) {
                    setActiveObject(snap.activeObjectId);
                }
            }

            // I voxel di uno scatto appartengono all'oggetto che era attivo QUANDO lo
            // scatto e' stato preso. Scriverli mentre e' attivo un altro oggetto lo
            // sovrascrive in silenzio: e' il difetto che ha svuotato le primitive appena
            // create (Shift+A poi Ctrl+Z) e regalato alla Casa i 50 voxel dell'Albero
            // eliminato. Se quell'oggetto non esiste piu' (eliminato dopo lo scatto) i
            // voxel non hanno piu' una casa: si lasciano cadere, non si appoggiano al
            // primo che capita. Coperto da tests/test_undo_object_switch.mjs.
            function snapshotTargetIsActive(snap) {
                return snap.activeObjectId == null || snap.activeObjectId === activeObjectId;
            }

            // Seconda meta' del ripristino: SOLO il rig. Gira dopo buildModel, che
            // azzera anteprima e osso selezionato — vedi la nota su applySnapshot.
            function restoreRigFromSnapshot(snap) {
                if (snap.rig) {
                    // normalizeRig() ricostruisce l'oggetto COMPLETO (pesi dipinti +
                    // animazioni AI incluse): prima qui si copiavano solo bones/pose e
                    // ogni undo azzerava silenziosamente weight paint e clip generate.
                    const restored = (typeof normalizeRig === 'function')
                        ? normalizeRig(snap.rig)
                        : {
                            type: snap.rig.type || 'humanoid',
                            binding: snap.rig.binding || 'rigid',
                            bones: snap.rig.bones,
                            pose: snap.rig.pose || {},
                            posePos: snap.rig.posePos || {},
                            weights: snap.rig.weights || null,
                            customAnims: snap.rig.customAnims || []
                        };
                    rig = restored;
                }
                if (rig) {
                    rigType = rig.type;
                    rigTypeControl.querySelectorAll('.seg-btn').forEach(b =>
                        b.classList.toggle('active', b.dataset.rig === rigType));
                    // Il rig vive sull'oggetto: parcheggiarlo subito evita che il primo
                    // rebuild/cambio oggetto riadotti la versione pre-undo.
                    if (typeof stashRigToActiveObject === 'function') stashRigToActiveObject();
                    applyRig();
                    if (snap.selectedBoneIndex >= 0 && snap.selectedBoneIndex < rig.bones.length) {
                        selectBone(snap.selectedBoneIndex);
                    } else if (rig.bones.length) {
                        selectBone(typeof firstSelectableBone === 'function' ? firstSelectableBone() : 0);
                    }
                } else {
                    clearRigPreview();
                    rig = null;
                    selectedBoneIndex = -1;
                    const _o = (typeof getActiveObject === 'function') ? getActiveObject() : null;
                    if (_o) delete _o.rig;
                    if (typeof updateRigUI === 'function') updateRigUI();
                }
            }

            // undo/redo in tre tempi, e due cose vanno lasciate dove sono.
            // (1) La GUARDIA e' cio' che impedisce il danno: senza, i voxel dello scatto
            //     atterrano sull'oggetto attivo in quel momento e lo svuotano. La
            //     scrittura va DOPO restoreSceneMeta, che riporta attivo l'oggetto dello
            //     scatto: spostarla prima non sporca nulla (ci pensa la guardia) ma la
            //     rende un buco nell'acqua ogni volta che l'oggetto e' cambiato, e
            //     l'annullamento non ripristina piu' niente.
            // (2) buildModel() sta in mezzo, non in fondo: chiama clearRigPreview() e
            //     azzera selectedBoneIndex (05-build-model.js:7-19), mentre il ripristino
            //     del rig ricostruisce l'anteprima con applyRig() e riseleziona l'osso.
            //     Metterlo dopo spegnerebbe il rig a ogni Ctrl+Z.
            // Entrambe fissate da tests/test_undo_object_switch.mjs (gruppi [3] e [5]).
            function applySnapshot(snap) {
                restoreSceneMeta(snap);
                // Undo/redo rimpiazza l'intero array dei voxel: gli indici del renderer
                // incrementale non valgono piu'. (Il buildModel() che segue lo
                // rigenerera' comunque, ma invalidare qui evita ogni finestra di stato
                // incoerente se in futuro qualcuno cambiasse quell'ordine.)
                if (typeof invalidateIncremental === 'function') invalidateIncremental();
                if (snapshotTargetIsActive(snap)) currentModelData.voxels = snap.voxels;
                buildModel(false);
                restoreRigFromSnapshot(snap);
            }

            function undo() {
                if (!undoStack.length) return;
                redoStack.push(JSON.stringify(captureSnapshot()));

                applySnapshot(JSON.parse(undoStack.pop()));
                updateHistoryButtons();
            }

            function redo() {
                if (!redoStack.length) return;
                undoStack.push(JSON.stringify(captureSnapshot()));

                applySnapshot(JSON.parse(redoStack.pop()));
                updateHistoryButtons();
            }

            undoBtn.addEventListener('click', undo);
            redoBtn.addEventListener('click', redo);
            window.addEventListener('keydown', e => {
                const t = e.target;
                // I cursori di posa del rig sono <input type="range">: non hanno un "undo"
                // di testo nativo, quindi Ctrl+Z / Ctrl+Y deve restare GLOBALE anche quando
                // uno di essi ha il focus (altrimenti annullare una posa nel Rig non fa
                // nulla). I veri campi di testo, invece, tengono il loro undo nativo.
                const isRange = !!(t && t.tagName === 'INPUT' && t.type === 'range');
                // isTextEntry/isTypingTarget stanno in 01-scene-setup.js: unica fonte.
                // Un <select> NON e' piu' un "campo di testo" per Ctrl+Z: non ha undo
                // nativo, quindi bloccarlo lasciava l'undo morto dopo aver scelto una
                // voce in un menu a tendina del pannello sinistro.
                const isTextField = isTextEntry(t);

                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y') {
                        if (isTextField) return;               // lascia l'undo nativo del campo
                        e.preventDefault();
                        if ((e.key === 'y' || e.key === 'Y') || e.shiftKey) redo(); else undo();
                        // Togli il focus dal controllo cosi' etichette/gizmo riflettono lo
                        // stato ripristinato (e la prossima scorciatoia non trova ostacoli).
                        if (t && typeof t.blur === 'function' && !isTextField) t.blur();
                    }
                    return;
                }

                // Per le altre scorciatoie (Q/E/strumenti) non interferire mentre si
                // digita in un campo, si trascina un cursore, o quando il controllo
                // focalizzato usa davvero quel tasto (frecce/spazio su un <select>).
                if (isTypingTarget(e) || isRange) return;

                if (e.key === 'q' || e.key === 'Q') {
                    if (currentTool !== 'view') {
                        e.preventDefault();
                        const modes = ['auto', 'x', 'y', 'z'];
                        const idx = modes.indexOf(dragConstraintMode);
                        dragConstraintMode = modes[(idx + 1) % modes.length];
                        
                        if (isDraggingArea) {
                            recomputeActivePlane();
                            if (lastPointerEvent) {
                                projectPointerToPlane(lastPointerEvent);
                            }
                            updateDragPreview();
                        } else {
                            let lockedAxis = 'y';
                            if (dragConstraintMode === 'auto') {
                                lockedAxis = 'auto (Normale)';
                            } else {
                                lockedAxis = dragConstraintMode.toUpperCase();
                            }
                            if (dragConstraintHUD) {
                                dragConstraintHUD.innerHTML = `<span>🔧 <b>Asse Drag impostato:</b> ${lockedAxis}</span>`;
                                dragConstraintHUD.style.display = 'block';
                                if (window.hudTimeout) clearTimeout(window.hudTimeout);
                                window.hudTimeout = setTimeout(() => {
                                    if (!isDraggingArea) dragConstraintHUD.style.display = 'none';
                                }, 1500);
                            }
                        }
                        const dragAxisSelect = document.getElementById('dragAxisSelect');
                        if (dragAxisSelect) {
                            dragAxisSelect.querySelectorAll('.seg-btn').forEach(btn => {
                                btn.classList.toggle('active', btn.dataset.axis === dragConstraintMode);
                            });
                        }
                    }
                }

                // T2: Esc annulla il gesto di estrusione in corso (senza modifiche).
                if (e.key === 'Escape' && extrudeActive) {
                    e.preventDefault();
                    cancelExtrude();
                    return;
                }

                // T2: E arma l'estrusione dalla faccia sotto il cursore; se è già attiva, cicla l'asse.
                // Solo in Modalità Modifica e non su gizmo del rig. Non interferisce con Q (drag-constraint).
                if (KEYMAP.extrude && e.key.toLowerCase() === KEYMAP.extrude.toLowerCase() && !gizmoEnabled) {
                    if (editorMode !== 'object') {
                        e.preventDefault();
                        // T2b: se stai trascinando un rettangolo di selezione, E lo blocca
                        // e passa al gesto "profondità" (rettangolo -> cubo) lungo l'asse
                        // normale al piano; poi muovi il mouse su/giù per lo spessore.
                        if (isDraggingArea && !extrudeActive) {
                            if (startBoxDepth()) {
                                if (lastPointerEvent) updateBoxDepthFromPointer(lastPointerEvent);
                                updateDragPreview();
                                updateBoxDepthHUD();
                            }
                        } else if (extrudeActive) {
                            cycleExtrudeAxis();
                        } else if (lastPointerEvent) {
                            armExtrude(lastPointerEvent.clientX, lastPointerEvent.clientY);
                        }
                        return;
                    }
                }

                // Rig gizmo mode hotkeys (only when a rig is active on the rig tab).
                if (gizmoEnabled) {
                    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); setGizmoMode('rotate'); return; }
                    if (e.key === 'g' || e.key === 'G') { e.preventDefault(); setGizmoMode('translate'); return; }
                }

                // Draw-tool hotkeys (only meaningful on the draw tab, but harmless elsewhere).
                if (e.key === KEYMAP.brushDown) { e.preventDefault(); brushSizeInput.value = Math.max(1, brushSize - 1); brushSizeInput.dispatchEvent(new Event('input')); return; }
                if (e.key === KEYMAP.brushUp) { e.preventDefault(); brushSizeInput.value = Math.min(6, brushSize + 1); brushSizeInput.dispatchEvent(new Event('input')); return; }
                // Tool hotkeys risolti tramite KEYMAP.tools (rimappabile — vedi definizione in cima).
                const tool = KEYMAP.tools[e.key];
                if (tool && document.querySelector('.tab-panel[data-panel="draw"]').classList.contains('active')) {
                    e.preventDefault(); setTool(tool);
                }
            });

            // Switch the bone gizmo between rotate (pose) and translate (edit skeleton).