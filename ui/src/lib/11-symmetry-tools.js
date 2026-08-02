            const mirrorPlaneMat = new THREE.MeshBasicMaterial({
                color: 0x38bdf8, transparent: true, opacity: 0.16,
                side: THREE.DoubleSide, depthWrite: false
            });
            const mirrorPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mirrorPlaneMat);
            mirrorPlane.visible = false;
            scene.add(mirrorPlane);
            // A bright outline of the plane so it reads clearly against the model.
            const mirrorPlaneEdge = new THREE.LineSegments(
                new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
                new THREE.LineBasicMaterial({ color: 0x38bdf8 })
            );
            mirrorPlaneEdge.visible = false;
            scene.add(mirrorPlaneEdge);

            // Reposition/resize the mirror plane for the current axis and grid.
            function updateMirrorPlane() {
                const on = symmetryAxis !== 'none';
                mirrorPlane.visible = on;
                mirrorPlaneEdge.visible = on;
                if (!on) return;
                const g = (currentModelData.metadata && currentModelData.metadata.grid_size) || [16, 16, 16];
                // Voxel index i lives at world coord i, so the split is at (dim-1)/2.
                // Pad the plane a little beyond the grid so it's easy to see.
                const pad = 1.0;
                const w0 = g[0] - 1, w1 = g[1] - 1, w2 = g[2] - 1;
                mirrorPlane.rotation.set(0, 0, 0);
                if (symmetryAxis === 'x') {
                    mirrorPlane.scale.set(g[2] + pad * 2, g[1] + pad * 2, 1);
                    mirrorPlane.rotation.y = Math.PI / 2;   // face along X
                    mirrorPlane.position.set(w0 / 2, w1 / 2, w2 / 2);
                } else if (symmetryAxis === 'y') {
                    mirrorPlane.scale.set(g[0] + pad * 2, g[2] + pad * 2, 1);
                    mirrorPlane.rotation.x = Math.PI / 2;   // face along Y (horizontal)
                    mirrorPlane.position.set(w0 / 2, w1 / 2, w2 / 2);
                } else if (symmetryAxis === 'z') {
                    mirrorPlane.scale.set(g[0] + pad * 2, g[1] + pad * 2, 1);
                    mirrorPlane.position.set(w0 / 2, w1 / 2, w2 / 2);  // face along Z (default)
                }
                mirrorPlaneEdge.position.copy(mirrorPlane.position);
                mirrorPlaneEdge.rotation.copy(mirrorPlane.rotation);
                mirrorPlaneEdge.scale.copy(mirrorPlane.scale);
            }

            function setTool(tool) {
                currentTool = tool;
                Object.entries(toolButtons).forEach(([name, btn]) => {
                    btn.classList.toggle('active', name === tool);
                });
                // In view mode OrbitControls owns the left mouse button; while editing we
                // free the left button for actions and keep rotate on the right/middle.
                if (tool === 'view') {
                    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
                } else {
                    controls.mouseButtons.LEFT = null;
                }
                editHint.textContent = HINTS[tool];
                clearPreview();
                renderer.domElement.style.cursor = tool === 'view' ? 'grab' : 'crosshair';
            }

            Object.entries(toolButtons).forEach(([name, btn]) => {
                btn.addEventListener('click', () => setTool(name));
            });

            // Tab switching: show one panel at a time. Leaving the Disegna tab drops
            // back to view mode so you don't keep editing with the panel hidden.
            const tabBar = document.getElementById('tabBar');
            const tabPanels = document.querySelectorAll('.tab-panel');
            function switchTab(name) {
                tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
                tabPanels.forEach(p => p.classList.toggle('active', p.dataset.panel === name));
                if (name !== 'draw' && currentTool !== 'view') setTool('view');
                // The rig preview replaces the normal voxel view; only show it on the Rig
                // tab. Leaving the tab restores the standard InstancedMesh rendering (the
                // rig data stays in memory, so returning re-shows it).
                if (typeof rig !== 'undefined') {
                    if (name === 'rig' && rig && rig.bones.length) {
                        if (typeof skinnedMesh === 'undefined' || !skinnedMesh) {
                            if (typeof applyRig === 'function') applyRig();
                        } else {
                            rigPreviewActive = true;
                            gizmoEnabled = true;
                            updateRigVisibility();
                            if (typeof updateGizmo === 'function') updateGizmo();
                        }
                        if (typeof updateRigUI === 'function') updateRigUI();
                    } else if (rigPreviewActive) {
                        // Uscendo dall'anteprima l'IK va disarmata: se si lascia la scheda
                        // durante un trascinamento il pointerup non riguarda piu' il rig e
                        // l'orbita resterebbe spenta (rigDisableIk ripristina controls).
                        if (typeof rigDisableIk === 'function') rigDisableIk();
                        rigPreviewActive = false;
                        gizmoEnabled = false;
                        updateRigVisibility();
                        if (typeof updateGizmo === 'function') updateGizmo();
                        if (typeof updateRigUI === 'function') updateRigUI();
                    }
                }
            }
            tabBar.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', () => switchTab(btn.dataset.tab));
            });

            // T1 Fase B: wiring pulsanti outliner + shortcut Tab (Modalità Oggetto/Modifica).
            (function bindOutliner() {
                const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
                bind('objNewBtn', objNew);
                bind('objDuplicateBtn', objDuplicate);
                bind('objRenameBtn', objRename);
                bind('objDeleteBtn', objDelete);
                bind('objMergeBtn', objMerge);
            })();
            window.addEventListener('keydown', (e) => {
                // isTypingTarget (01-scene-setup.js) e' la fonte unica: blocca solo
                // se si sta digitando o se il controllo consuma quel tasto. Tab non
                // e' consumato da un <select>, quindi ora funziona anche subito
                // dopo averne usato uno.
                if (isTypingTarget(e)) return;
                if (e.key === KEYMAP.toggleMode) {
                    e.preventDefault();
                    toggleEditorMode();
                }
                if (e.key === 'Delete' && !globalTransformControls.object) {
                    e.preventDefault();
                    if (editorMode === 'object') {
                        objDelete();
                    } else if (activePartName) {
                        const active = getActiveObject();
                        if (active && confirm('Eliminare la parte "' + activePartName + '"?')) {
                            active.data.voxels = active.data.voxels.filter(v => v.part !== activePartName);
                            activePartName = null;
                            buildModel(false);
                        }
                    }
                }
            });

            // Symmetry axis segmented control: mirror edits across the model center.
            const symmetryControl = document.getElementById('symmetryAxis');
            symmetryControl.querySelectorAll('.seg-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    symmetryAxis = btn.dataset.sym;
                    symmetryControl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                    updateMirrorPlane();
                });
            });

            function setActiveColor(hex) {
                activeColorHex = hex.toUpperCase();
                activeColorInput.value = hex.toLowerCase();
                activeColorHexEl.textContent = activeColorHex;
            }
            activeColorInput.addEventListener('input', e => setActiveColor(e.target.value));

            function clearPreview() {
                hoverCell = null;
                previewAddMesh.visible = false;
                previewRemoveMesh.visible = false;
            }
