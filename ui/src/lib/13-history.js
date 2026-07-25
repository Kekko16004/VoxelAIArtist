            function updateHistoryButtons() {
                undoBtn.disabled = undoStack.length === 0;
                redoBtn.disabled = redoStack.length === 0;
            }

            // T1 Fase B: cattura voxel dell'ATTIVO + rig + struttura scena (nomi, transform,
            // visibilità, quale è attivo). LIMITE noto: NON cattura i voxel degli oggetti
            // non attivi, e non ripristina aggiunte/eliminazioni di oggetti (solo attributi
            // di quelli tuttora esistenti). Le operazioni Nuovo/Duplica/Elimina/Unisci non
            // sono quindi annullabili con Ctrl+Z (per scelta: evitare snapshot pesanti).
            function captureSnapshot() {
                return {
                    voxels: JSON.parse(JSON.stringify(currentModelData.voxels || [])),
                    rig: rig ? { bones: JSON.parse(JSON.stringify(rig.bones)), pose: JSON.parse(JSON.stringify(rig.pose || {})), type: rig.type, binding: rig.binding } : null,
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

            function restoreSnapshot(snap) {
                restoreSceneMeta(snap);
                // Undo/redo rimpiazza l'intero array dei voxel: gli indici del renderer
                // incrementale non valgono piu'. (Il buildModel() che segue lo
                // rigenerera' comunque, ma invalidare qui evita ogni finestra di stato
                // incoerente se in futuro qualcuno cambiasse quell'ordine.)
                if (typeof invalidateIncremental === 'function') invalidateIncremental();
                currentModelData.voxels = snap.voxels;
                if (snap.rig) {
                    rig = {
                        type: snap.rig.type || 'humanoid',
                        binding: snap.rig.binding || 'rigid',
                        bones: snap.rig.bones,
                        pose: snap.rig.pose || {}
                    };
                    rigType = rig.type;
                    rigTypeControl.querySelectorAll('.seg-btn').forEach(b =>
                        b.classList.toggle('active', b.dataset.rig === rigType));
                    applyRig();
                    if (snap.selectedBoneIndex >= 0 && snap.selectedBoneIndex < rig.bones.length) {
                        selectBone(snap.selectedBoneIndex);
                    } else if (rig.bones.length) {
                        selectBone(0);
                    }
                } else {
                    clearRigPreview();
                    rig = null;
                    selectedBoneIndex = -1;
                }
            }

            function undo() {
                if (!undoStack.length) return;
                redoStack.push(JSON.stringify(captureSnapshot()));

                const prev = JSON.parse(undoStack.pop());
                restoreSnapshot(prev);
                buildModel(false);
                updateHistoryButtons();
            }

            function redo() {
                if (!redoStack.length) return;
                undoStack.push(JSON.stringify(captureSnapshot()));

                const next = JSON.parse(redoStack.pop());
                restoreSnapshot(next);
                buildModel(false);
                updateHistoryButtons();
            }

            undoBtn.addEventListener('click', undo);
            redoBtn.addEventListener('click', redo);
            window.addEventListener('keydown', e => {
                // Never hijack typing in a field.
                const t = e.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 'z' || e.key === 'Z') {
                        e.preventDefault();
                        if (e.shiftKey) redo(); else undo();
                    } else if (e.key === 'y' || e.key === 'Y') {
                        e.preventDefault();
                        redo();
                    }
                    return;
                }

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