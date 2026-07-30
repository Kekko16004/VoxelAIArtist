            // ===== T2: Estrusione facce (tasto E) =====
            // Gesto: in Modalità Modifica, punta la faccia di un voxel esistente e premi E.
            // Si "arma" l'estrusione: la faccia esposta contigua e complanare viene raccolta
            // (flood-fill 4-vicini) e trascinando il mouse si generano N passi di voxel lungo
            // l'asse. Ri-premere E cicla l'asse (X->Y->Z). Click sx conferma (1 sola voce undo),
            // Esc o click dx annulla senza modificare nulla. Nessun trascinamento => 0 passi => niente voxel.
            let extrudeActive = false;
            let extrudeFaceCells = [];   // celle-sorgente (faccia complanare contigua)
            let extrudeAxis = 'y';       // 'x' | 'y' | 'z'
            let extrudeSteps = 0;        // numero di passi con segno (direzione dal drag)
            let extrudeColor = null;     // colore catturato all'armamento
            let extrudeAnchor = null;    // cella rappresentativa per la proiezione del puntatore
            const MAX_EXTRUDE_STEPS = 64;
            const MAX_EXTRUDE_PREVIEW = 6000;
            const extrudeHUD = document.getElementById('extrudeHUD');
            const extrudePreviewGroup = new THREE.Group();
            scene.add(extrudePreviewGroup);
            const extrudeGhostGeo = new THREE.BoxGeometry(1, 1, 1);
            const extrudeGhostMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.4, depthWrite: false });

            function extrudeAxisVec(axis) {
                return axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'z' ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
            }

            // Raccoglie la faccia esposta: voxel complanari contigui (4-vicini nel piano) che
            // condividono la stessa faccia libera lungo la normale. Fallback: singolo voxel.
            function collectExposedFace(start, normal) {
                const key = c => `${c.x},${c.y},${c.z}`;
                const nAxis = Math.abs(normal.x) > 0.5 ? 'x' : Math.abs(normal.z) > 0.5 ? 'z' : 'y';
                const exposed = c => voxelMap.has(key(c)) &&
                    !voxelMap.has(`${c.x + normal.x},${c.y + normal.y},${c.z + normal.z}`);
                if (!exposed(start)) return [start];
                const level = start[nAxis];
                const inPlane = ['x', 'y', 'z'].filter(a => a !== nAxis);
                const result = [];
                const seen = new Set([key(start)]);
                const stack = [start];
                while (stack.length) {
                    const c = stack.pop();
                    result.push(c);
                    if (result.length > 4096) break; // limite di sicurezza per facce enormi
                    inPlane.forEach(a => {
                        [-1, 1].forEach(d => {
                            const nc = { x: c.x, y: c.y, z: c.z };
                            nc[a] += d;
                            const k = key(nc);
                            if (!seen.has(k) && nc[nAxis] === level && exposed(nc)) { seen.add(k); stack.push(nc); }
                        });
                    });
                }
                return result;
            }

            function updateConstraintHUD(axis) {
                if (!dragConstraintHUD) return;
                const axisNameKeys = {
                    x: 'dragPlane.xTitle',
                    y: 'dragPlane.yTitle',
                    z: 'dragPlane.zTitle'
                };
                // Struttura in innerHTML, testi tradotti con textContent: le traduzioni
                // contengono apostrofi e virgolette e non vanno interpolate in HTML.
                dragConstraintHUD.innerHTML = `
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span>🔧 <b class="hud-drag-label"></b> ${axis.toUpperCase()}</span>
                        <span class="hud-drag-plane" style="color:var(--text-secondary); font-size:11px;"></span>
                        <span class="hud-drag-hint" style="background:var(--hover-bg-strong); padding:2px 6px; border-radius:var(--radius-sm); font-size:10px;"></span>
                    </div>
                `;
                dragConstraintHUD.querySelector('.hud-drag-label').textContent = t('hud.dragAxis');
                dragConstraintHUD.querySelector('.hud-drag-plane').textContent = '(' + t(axisNameKeys[axis]) + ')';
                dragConstraintHUD.querySelector('.hud-drag-hint').textContent = t('hud.dragAxisChange');
                dragConstraintHUD.style.display = 'block';
            }

            function recomputeActivePlane() {
                if (!boxStartCell) return;
                let lockedAxis = 'y';
                if (dragConstraintMode === 'auto') {
                    if (dragNormal) {
                        if (Math.abs(dragNormal.x) > 0.5) lockedAxis = 'x';
                        else if (Math.abs(dragNormal.z) > 0.5) lockedAxis = 'z';
                        else lockedAxis = 'y';
                    }
                } else {
                    lockedAxis = dragConstraintMode;
                }

                let normalVec = new THREE.Vector3(0, 1, 0);
                let constant = -boxStartCell.y;
                if (lockedAxis === 'x') {
                    normalVec.set(1, 0, 0);
                    constant = -boxStartCell.x;
                } else if (lockedAxis === 'z') {
                    normalVec.set(0, 0, 1);
                    constant = -boxStartCell.z;
                }
                activePlane = new THREE.Plane(normalVec, constant);
                lockedDragAxis = lockedAxis; // T2b: asse di profondità per il gesto E
                updateConstraintHUD(lockedAxis);

                const btnGroup = document.getElementById('dragAxisSelect');
                if (btnGroup) {
                    btnGroup.querySelectorAll('.seg-btn').forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.axis === dragConstraintMode);
                    });
                }
            }

            // T2b: attiva il "gesto profondità" sul box di selezione in corso. Blocca
            // le due dimensioni nel piano e prepara la proiezione lungo l'asse normale
            // (lockedDragAxis). Da qui il movimento su/giù del mouse dà spessore.
            function startBoxDepth() {
                if (!isDraggingArea || !boxStartCell || !boxEndCell) return false;
                boxDepthAxis = lockedDragAxis;
                // Ancora = centro del rettangolo, al livello del piano (base della profondità).
                const midA = (boxStartCell.x + boxEndCell.x) / 2;
                const midB = (boxStartCell.y + boxEndCell.y) / 2;
                const midC = (boxStartCell.z + boxEndCell.z) / 2;
                boxDepthAnchor = { x: midA, y: midB, z: midC };
                boxDepthAnchor[boxDepthAxis] = boxStartCell[boxDepthAxis];
                boxDepthMode = true;
                updateBoxDepthHUD();
                return true;
            }

            // T2b: HUD del gesto profondità (riusa il riquadro del drag-constraint).
            function updateBoxDepthHUD() {
                if (!dragConstraintHUD || !boxDepthMode || !boxDepthAxis) return;
                dragConstraintHUD.innerHTML = `
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span>📦 <b>Profondità:</b> asse ${boxDepthAxis.toUpperCase()}</span>
                        <span style="color:var(--text-secondary); font-size:11px;">Muovi il mouse su/giù per lo spessore</span>
                        <span style="background:var(--hover-bg-strong); padding:2px 6px; border-radius:var(--radius-sm); font-size:10px;">Rilascia per confermare</span>
                    </div>`;
                dragConstraintHUD.style.display = 'block';
            }

            // T2b: dal puntatore, calcola la coordinata bersaglio lungo l'asse di
            // profondità (closest point retta-asse / raggio) e la scrive su boxEndCell.
            // boxStartCell resta al livello del piano: min..max nel commit dà il verso.
            function updateBoxDepthFromPointer(e) {
                if (!boxDepthMode || !boxDepthAnchor || !boxStartCell) return;
                const rect = renderer.domElement.getBoundingClientRect();
                pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(pointer, camera);
                const av = extrudeAxisVec(boxDepthAxis);
                const u = new THREE.Vector3(av.x, av.y, av.z);
                const P0 = new THREE.Vector3(boxDepthAnchor.x, boxDepthAnchor.y, boxDepthAnchor.z);
                const O = raycaster.ray.origin.clone();
                const v = raycaster.ray.direction.clone();
                const w0 = new THREE.Vector3().subVectors(O, P0);
                const b = u.dot(v), c = v.dot(v), dd = u.dot(w0), ee = v.dot(w0);
                const denom = c - b * b; // a = u·u = 1
                if (Math.abs(denom) < 1e-6) return; // sguardo parallelo all'asse
                const sc = (b * ee - c * dd) / denom;
                const gSize = (currentModelData.metadata && currentModelData.metadata.grid_size) || [16, 16, 16];
                const dimIdx = boxDepthAxis === 'x' ? 0 : boxDepthAxis === 'y' ? 1 : 2;
                let target = Math.round(boxStartCell[boxDepthAxis] + sc);
                target = Math.max(0, Math.min(gSize[dimIdx] - 1, target));
                boxEndCell[boxDepthAxis] = target;
            }

            function projectPointerToPlane(e) {
                if (!activePlane) return;
                const rect = renderer.domElement.getBoundingClientRect();
                pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(pointer, camera);

                const targetPoint = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(activePlane, targetPoint)) {
                    const gSize = (currentModelData.metadata && currentModelData.metadata.grid_size) || [16, 16, 16];
                    const cx = Math.max(0, Math.min(gSize[0] - 1, Math.round(targetPoint.x)));
                    const cy = Math.max(0, Math.min(gSize[1] - 1, Math.round(targetPoint.y)));
                    const cz = Math.max(0, Math.min(gSize[2] - 1, Math.round(targetPoint.z)));
                    boxEndCell = { x: cx, y: cy, z: cz };
                }
            }

            function updateDragPreview() {
                if (!boxStartCell || !boxEndCell) return;

                const minX = Math.min(boxStartCell.x, boxEndCell.x);
                const maxX = Math.max(boxStartCell.x, boxEndCell.x);
                const minY = Math.min(boxStartCell.y, boxEndCell.y);
                const maxY = Math.max(boxStartCell.y, boxEndCell.y);
                const minZ = Math.min(boxStartCell.z, boxEndCell.z);
                const maxZ = Math.max(boxStartCell.z, boxEndCell.z);

                const sizeX = maxX - minX + 1;
                const sizeY = maxY - minY + 1;
                const sizeZ = maxZ - minZ + 1;

                previewBoxMesh.scale.set(sizeX, sizeY, sizeZ);
                previewBoxMesh.position.set(
                    minX + (sizeX - 1) / 2,
                    minY + (sizeY - 1) / 2,
                    minZ + (sizeZ - 1) / 2
                );

                previewBoxEdges.scale.copy(previewBoxMesh.scale);
                previewBoxEdges.position.copy(previewBoxMesh.position);

                let color = 0x22c55e;
                if (activeActionTool === 'remove') color = 0xff3b3b;
                else if (activeActionTool === 'draw') color = 0xfbbf24;

                previewBoxMesh.material.color.setHex(color);
                previewBoxEdges.material.color.setHex(color);

                previewBoxMesh.visible = true;
                previewBoxEdges.visible = true;
            }

            // --- Mirror plane preview ---
            // A translucent plane showing exactly where the symmetry axis splits the
            // model, so you can see which half you're mirroring across. Sits on the
            // scene (like the grid), spans the whole grid on the two free axes.