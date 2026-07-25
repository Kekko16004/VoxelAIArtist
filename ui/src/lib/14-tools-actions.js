            const gizmoBar = document.getElementById('gizmoBar');
            const gizmoRotateBtn = document.getElementById('gizmoRotateBtn');
            const gizmoTranslateBtn = document.getElementById('gizmoTranslateBtn');
            function setGizmoMode(mode) {
                gizmoMode = mode;
                gizmoRotateBtn.classList.toggle('active', mode === 'rotate');
                gizmoTranslateBtn.classList.toggle('active', mode === 'translate');
                if (typeof updateGizmo === 'function') updateGizmo();
                if (rig) rigHint.textContent = mode === 'translate'
                    ? 'Modalità SPOSTA (G): trascina per muovere il giunto e adattare lo scheletro. Premi R per tornare a ruotare.'
                    : 'Modalità RUOTA (R): trascina gli anelli per posare l\'osso. Premi G per spostare il giunto.';
            }
            gizmoRotateBtn.addEventListener('click', () => setGizmoMode('rotate'));
            gizmoTranslateBtn.addEventListener('click', () => setGizmoMode('translate'));

            function pickVoxel(clientX, clientY) {
                const rect = renderer.domElement.getBoundingClientRect();
                pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
                pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(pointer, camera);
                const hits = raycaster.intersectObjects(meshes, false);
                if (hits.length > 0) {
                    const hit = hits[0];
                    const list = hit.object.userData.voxels || [];
                    const voxel = list[hit.instanceId];
                    if (voxel) {
                        const n = hit.face ? hit.face.normal : new THREE.Vector3(0, 1, 0);
                        return { voxel, normal: { x: Math.round(n.x), y: Math.round(n.y), z: Math.round(n.z) } };
                    }
                }
                if (currentTool === 'place') {
                    const gSize = (currentModelData.metadata && currentModelData.metadata.grid_size) || [16, 16, 16];
                    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.5);
                    const targetPoint = new THREE.Vector3();
                    if (raycaster.ray.intersectPlane(plane, targetPoint)) {
                        const vx = Math.round(targetPoint.x);
                        const vz = Math.round(targetPoint.z);
                        if (vx >= 0 && vx < gSize[0] && vz >= 0 && vz < gSize[2]) {
                            return {
                                voxel: { x: vx, y: -1, z: vz, color: activeColorHex },
                                normal: { x: 0, y: 1, z: 0 }
                            };
                        }
                    }
                }
                return null;
            }

            function updatePreview(clientX, clientY) {
                if (currentTool === 'view') { clearPreview(); return; }
                const pick = pickVoxel(clientX, clientY);
                if (!pick) { clearPreview(); return; }

                if (currentTool === 'place') {
                    const t = pick.voxel, n = pick.normal;
                    const cell = { x: t.x + n.x, y: t.y + n.y, z: t.z + n.z };
                    hoverCell = cell;
                    previewAddMesh.position.set(cell.x, cell.y, cell.z);
                    previewAddMesh.visible = true;
                    previewRemoveMesh.visible = false;
                } else if (currentTool === 'remove') {
                    hoverCell = { x: pick.voxel.x, y: pick.voxel.y, z: pick.voxel.z };
                    previewRemoveMesh.material.color.set(0xff3b3b); // red for removal
                    previewRemoveMesh.position.set(hoverCell.x, hoverCell.y, hoverCell.z);
                    previewRemoveMesh.visible = true;
                    previewAddMesh.visible = false;
                } else if (currentTool === 'draw') {
                    hoverCell = { x: pick.voxel.x, y: pick.voxel.y, z: pick.voxel.z };
                    previewRemoveMesh.material.color.set(0xfbbf24); // amber hint for recolor
                    previewRemoveMesh.position.set(hoverCell.x, hoverCell.y, hoverCell.z);
                    previewRemoveMesh.visible = true;
                    previewAddMesh.visible = false;
                } else if (currentTool === 'pick') {
                    hoverCell = { x: pick.voxel.x, y: pick.voxel.y, z: pick.voxel.z };
                    previewRemoveMesh.material.color.set(0x38bdf8); // cyan hint for eyedropper
                    previewRemoveMesh.position.set(hoverCell.x, hoverCell.y, hoverCell.z);
                    previewRemoveMesh.visible = true;
                    previewAddMesh.visible = false;
                }
                // Scale the highlight cube to reflect the brush size (for draw/remove).
                if ((currentTool === 'remove' || currentTool === 'draw') && brushSize > 1) {
                    const d = brushSize * 2 - 1;
                    previewRemoveMesh.scale.set(d, d, d);
                } else {
                    previewRemoveMesh.scale.set(1, 1, 1);
                }
            }

            // Mirror a cell across the grid center on the active symmetry axis.
            // Returns null when symmetry is off or the mirror lands on the same cell.
            function mirrorCell(cell) {
                if (symmetryAxis === 'none') return null;
                const g = (currentModelData.metadata && currentModelData.metadata.grid_size) || [0, 0, 0];
                const m = { x: cell.x, y: cell.y, z: cell.z };
                if (symmetryAxis === 'x') m.x = (g[0] - 1) - cell.x;
                else if (symmetryAxis === 'y') m.y = (g[1] - 1) - cell.y;
                else if (symmetryAxis === 'z') m.z = (g[2] - 1) - cell.z;
                if (m.x === cell.x && m.y === cell.y && m.z === cell.z) return null; // on the plane
                return m;
            }

            function inBounds(cell) {
                const g = currentModelData.metadata && currentModelData.metadata.grid_size;
                if (!g) return true;
                return cell.x >= 0 && cell.y >= 0 && cell.z >= 0 &&
                    cell.x < g[0] && cell.y < g[1] && cell.z < g[2];
            }

            // Expand a center cell into a spherical brush of the current radius. r=1 is
            // just the center; larger radii include every cell within (r-1) of center.
            function brushCells(center) {
                if (brushSize <= 1) return [center];
                const r = brushSize - 1;
                const out = [];
                for (let dx = -r; dx <= r; dx++)
                    for (let dy = -r; dy <= r; dy++)
                        for (let dz = -r; dz <= r; dz++) {
                            out.push({ x: center.x + dx, y: center.y + dy, z: center.z + dz });
                        }
                return out;
            }

            // Add the mirror of every cell (when symmetry is on) to the working set.
            function withMirrors(cells) {
                if (symmetryAxis === 'none') return cells;
                const all = cells.slice();
                const seen = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));
                cells.forEach(c => {
                    const m = mirrorCell(c);
                    if (m && !seen.has(`${m.x},${m.y},${m.z}`)) { seen.add(`${m.x},${m.y},${m.z}`); all.push(m); }
                });
                return all;
            }

            // Perform the current tool at the pointer. `isStroke` is true for the moves
            // during a held drag; history is pushed once per stroke (in pointerdown/click),
            // not per move, so an entire drag is a single undo step.
            function performAction(clientX, clientY, isStroke) {
                const pick = pickVoxel(clientX, clientY);
                if (!pick) return false;

                if (currentTool === 'place') {
                    const t = pick.voxel, n = pick.normal;
                    const base = { x: t.x + n.x, y: t.y + n.y, z: t.z + n.z };
                    const cells = withMirrors(brushCells(base))
                        .filter(c => inBounds(c) && !voxelMap.has(`${c.x},${c.y},${c.z}`));
                    if (cells.length === 0) return false;
                    cells.forEach(c => voxelMap.set(`${c.x},${c.y},${c.z}`, activeColorHex));
                    // Percorso rapido (28-incremental.js): aggiorna solo le celle toccate
                    // e i mesh dei colori coinvolti. Se non e' disponibile si ricade sul
                    // rebuild completo, che resta la strada sicura.
                    if (!applyVoxelEdits(cells.map(c => ({ x: c.x, y: c.y, z: c.z, color: activeColorHex })))) {
                        syncVoxelsFromMap();
                        buildModel(false, true);
                    }
                    return true;
                } else if (currentTool === 'remove') {
                    const base = { x: pick.voxel.x, y: pick.voxel.y, z: pick.voxel.z };
                    const cells = withMirrors(brushCells(base))
                        .filter(c => voxelMap.has(`${c.x},${c.y},${c.z}`));
                    if (cells.length === 0) return false;
                    cells.forEach(c => voxelMap.delete(`${c.x},${c.y},${c.z}`));
                    if (!applyVoxelEdits(cells.map(c => ({ x: c.x, y: c.y, z: c.z, removed: true })))) {
                        syncVoxelsFromMap();
                        buildModel(false, true);
                    }
                    return true;
                } else if (currentTool === 'draw') {
                    const base = { x: pick.voxel.x, y: pick.voxel.y, z: pick.voxel.z };
                    // Only recolor existing voxels, and skip ones already the active color.
                    const cells = withMirrors(brushCells(base))
                        .filter(c => {
                            const k = `${c.x},${c.y},${c.z}`;
                            return voxelMap.has(k) && voxelMap.get(k) !== activeColorHex;
                        });
                    if (cells.length === 0) return false;
                    cells.forEach(c => voxelMap.set(`${c.x},${c.y},${c.z}`, activeColorHex));
                    if (!applyVoxelEdits(cells.map(c => ({ x: c.x, y: c.y, z: c.z, color: activeColorHex })))) {
                        syncVoxelsFromMap();
                        buildModel(false, true);
                    }
                    return true;
                } else if (currentTool === 'pick') {
                    setActiveColor(pick.voxel.color);
                    setTool('draw'); // natural flow: pick a color, then recolor with it
                    return false;
                }
                return false;
            }

            // Continuous painting: hold the left button and drag to keep applying the
            // tool. The whole stroke is a single undo step (history pushed lazily on the
            // first cell that actually changes). 'pick' is a one-shot click.
            let painting = false;
            let strokeHistoryPushed = false;
            let lastPaintCellKey = null;
            let activeActionTool = null;

            function strokeApply(clientX, clientY) {
                // Peek at what the action would touch so we only snapshot history when a
                // real change happens (avoids empty undo steps on misses).
                const originalTool = currentTool;
                if (activeActionTool) currentTool = activeActionTool;

                if (!strokeHistoryPushed) {
                    pushHistory();
                    strokeHistoryPushed = true;
                    const changed = performAction(clientX, clientY, true);
                    if (!changed) {
                        // Nothing changed — roll back the snapshot we just pushed.
                        undoStack.pop();
                        strokeHistoryPushed = false;
                        updateHistoryButtons();
                    }
                } else {
                    performAction(clientX, clientY, true);
                }
                currentTool = originalTool;
            }

            renderer.domElement.addEventListener('pointermove', e => {
                lastPointerEvent = e;
                if (editorMode === 'object') { clearPreview(); return; } // T1 Fase B
                // T2: durante l'estrusione il movimento del mouse regola i passi lungo l'asse.
                if (extrudeActive) {
                    const s = extrudeStepsFromPointer(e);
                    if (s !== extrudeSteps) { extrudeSteps = s; updateExtrudePreview(); }
                    e.preventDefault();
                    return;
                }
                if (currentTool === 'view') return;

                if (isDraggingArea) {
                    // T2b: se il gesto profondità è attivo (E premuto durante il drag),
                    // il mouse regola lo spessore lungo l'asse bloccato invece del piano.
                    if (boxDepthMode) {
                        updateBoxDepthFromPointer(e);
                        updateBoxDepthHUD();
                    } else {
                        projectPointerToPlane(e);
                    }
                    updateDragPreview();
                    e.preventDefault();
                } else {
                    const originalTool = currentTool;
                    if (e.buttons & 2) {
                        currentTool = 'remove';
                    } else if (e.buttons & 1) {
                        if (currentTool === 'remove') currentTool = 'place';
                    }
                    updatePreview(e.clientX, e.clientY);
                    currentTool = originalTool;
                }
            });
            renderer.domElement.addEventListener('pointerleave', () => {
                clearPreview();
                isDraggingArea = false;
                boxDepthMode = false; boxDepthAxis = null; boxDepthAnchor = null; // T2b
                previewBoxMesh.visible = false;
                previewBoxEdges.visible = false;
                if (dragConstraintHUD) dragConstraintHUD.style.display = 'none';
            });

            renderer.domElement.addEventListener('pointerdown', e => {
                if (editorMode === 'object') return; // T1 Fase B: nessun editing in Modalità Oggetto
                // T2: durante l'estrusione, click sx conferma, click dx annulla. Niente editing normale.
                if (extrudeActive) {
                    if (e.button === 0) { e.preventDefault(); commitExtrude(); }
                    else if (e.button === 2) { e.preventDefault(); cancelExtrude(); }
                    return;
                }
                if (currentTool === 'view') return;
                if (e.button !== 0 && e.button !== 2) return;
                pointerDownPos = { x: e.clientX, y: e.clientY };
                lastPointerEvent = e;

                const pick = pickVoxel(e.clientX, e.clientY);
                if (!pick) return;

                activeActionTool = currentTool;
                if (e.button === 0) {
                    if (currentTool === 'remove') activeActionTool = 'place';
                } else if (e.button === 2) {
                    activeActionTool = 'remove';
                }

                if (activeActionTool === 'pick') {
                    setActiveColor(pick.voxel.color);
                    setTool('draw');
                    return;
                }

                isDraggingArea = true;
                dragNormal = pick.normal;

                if (activeActionTool === 'place') {
                    boxStartCell = {
                        x: pick.voxel.x + pick.normal.x,
                        y: pick.voxel.y + pick.normal.y,
                        z: pick.voxel.z + pick.normal.z
                    };
                } else {
                    boxStartCell = { x: pick.voxel.x, y: pick.voxel.y, z: pick.voxel.z };
                }
                boxEndCell = { ...boxStartCell };

                recomputeActivePlane();
                updateDragPreview();
                renderer.domElement.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            renderer.domElement.addEventListener('pointerup', e => {
                if (e.button !== 0 && e.button !== 2) return;
                lastPointerEvent = null;

                if (isDraggingArea) {
                    isDraggingArea = false;
                    boxDepthMode = false; boxDepthAxis = null; boxDepthAnchor = null; // T2b
                    previewBoxMesh.visible = false;
                    previewBoxEdges.visible = false;
                    if (dragConstraintHUD) dragConstraintHUD.style.display = 'none';

                    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) { }

                    if (boxStartCell && boxEndCell) {
                        const minX = Math.min(boxStartCell.x, boxEndCell.x);
                        const maxX = Math.max(boxStartCell.x, boxEndCell.x);
                        const minY = Math.min(boxStartCell.y, boxEndCell.y);
                        const maxY = Math.max(boxStartCell.y, boxEndCell.y);
                        const minZ = Math.min(boxStartCell.z, boxEndCell.z);
                        const maxZ = Math.max(boxStartCell.z, boxEndCell.z);

                        const cellsToApply = [];
                        for (let x = minX; x <= maxX; x++) {
                            for (let y = minY; y <= maxY; y++) {
                                for (let z = minZ; z <= maxZ; z++) {
                                    cellsToApply.push({ x, y, z });
                                }
                            }
                        }

                        const finalCells = withMirrors(cellsToApply).filter(inBounds);
                        if (finalCells.length > 0) {
                            let changed = false;

                            if (activeActionTool === 'place') {
                                const emptyCells = finalCells.filter(c => !voxelMap.has(`${c.x},${c.y},${c.z}`));
                                if (emptyCells.length > 0) {
                                    pushHistory();
                                    emptyCells.forEach(c => voxelMap.set(`${c.x},${c.y},${c.z}`, activeColorHex));
                                    changed = true;
                                }
                            } else if (activeActionTool === 'remove') {
                                const existingCells = finalCells.filter(c => voxelMap.has(`${c.x},${c.y},${c.z}`));
                                if (existingCells.length > 0) {
                                    pushHistory();
                                    existingCells.forEach(c => voxelMap.delete(`${c.x},${c.y},${c.z}`));
                                    changed = true;
                                }
                            } else if (activeActionTool === 'draw') {
                                const colorCells = finalCells.filter(c => {
                                    const k = `${c.x},${c.y},${c.z}`;
                                    return voxelMap.has(k) && voxelMap.get(k) !== activeColorHex;
                                });
                                if (colorCells.length > 0) {
                                    pushHistory();
                                    colorCells.forEach(c => voxelMap.set(`${c.x},${c.y},${c.z}`, activeColorHex));
                                    changed = true;
                                }
                            }

                            if (changed) {
                                syncVoxelsFromMap();
                                buildModel(false, true); // edit oggetto attivo: non ricostruire gli inattivi
                            }
                        }
                    }

                    boxStartCell = null;
                    boxEndCell = null;
                    dragNormal = null;
                    activePlane = null;
                    pointerDownPos = null;
                } else {
                    if (pointerDownPos) {
                        const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
                        pointerDownPos = null;
                        if (moved < 6) performAction(e.clientX, e.clientY, false);
                    }
                }
            });
            // Suppress the browser context menu so right-drag can orbit while editing.
            renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

            // T1 Fase B: in Modalità Oggetto un click seleziona l'oggetto sotto il cursore.
            // Non interferisce con l'editing (attivo solo quando editorMode === 'object').
            let objModeDownPos = null;
            renderer.domElement.addEventListener('pointerdown', e => {
                if (editorMode !== 'object' || e.button !== 0) return;
                objModeDownPos = { x: e.clientX, y: e.clientY };
            });
            renderer.domElement.addEventListener('pointerup', e => {
                if (editorMode !== 'object' || e.button !== 0 || !objModeDownPos) return;
                const moved = Math.hypot(e.clientX - objModeDownPos.x, e.clientY - objModeDownPos.y);
                objModeDownPos = null;
                if (moved >= 6) return; // era un'orbita, non un click di selezione
                const rect = renderer.domElement.getBoundingClientRect();
                pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(pointer, camera);
                // Raccoglie i mesh dell'attivo (meshes) e degli oggetti non attivi.
                const targets = meshes.slice();
                objectGroups.forEach(g => g.children.forEach(ch => targets.push(ch)));
                const hits = raycaster.intersectObjects(targets, false);
                if (!hits.length) return;
                const hitObj = hits[0].object;
                const id = (hitObj.userData && hitObj.userData.objectId != null) ? hitObj.userData.objectId : activeObjectId;
                if (id !== activeObjectId) selectActiveObjectAndRefresh(id);
                else updateSelectionHighlight();
            });

            // Bind the drag axis select buttons
            const dragAxisSelect = document.getElementById('dragAxisSelect');
            if (dragAxisSelect) {
                dragAxisSelect.querySelectorAll('.seg-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        dragConstraintMode = btn.dataset.axis;
                        dragAxisSelect.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                        if (isDraggingArea) {
                            recomputeActivePlane();
                            if (lastPointerEvent) {
                                projectPointerToPlane(lastPointerEvent);
                            }
                            updateDragPreview();
                        }
                    });
                });
            }

            // Clicking a palette swatch loads it as the active paint color.
            paletteEl.addEventListener('click', e => {
                const sw = e.target.closest('.swatch');
                if (sw && sw.title) setActiveColor(sw.title);
            });

            setTool('view');
            updateHistoryButtons();
