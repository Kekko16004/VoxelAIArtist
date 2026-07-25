            // ===== T2: logica di estrusione =====
            function updateExtrudeHUD() {
                if (!extrudeHUD) return;
                if (!extrudeActive) { extrudeHUD.style.display = 'none'; return; }
                const nCells = extrudeFaceCells.length;
                const passi = Math.abs(extrudeSteps);
                const verso = extrudeSteps === 0 ? '' : (extrudeSteps > 0 ? '+' : '−');
                extrudeHUD.innerHTML = `
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span>🧱 <b>Estrusione:</b> asse ${extrudeAxis.toUpperCase()} ${verso}</span>
                        <span style="color:var(--text-secondary); font-size:11px;">${nCells} facce · ${passi} passi</span>
                        <span style="background:var(--hover-bg-strong); padding:2px 6px; border-radius:var(--radius-sm); font-size:10px;">Trascina · E cambia asse · click conferma · Esc annulla</span>
                    </div>`;
                extrudeHUD.style.display = 'block';
            }

            // Celle generate dall'estrusione corrente (vuote e in bounds), per preview/commit.
            function extrudeTargetCells() {
                if (!extrudeActive || extrudeSteps === 0) return [];
                const av = extrudeAxisVec(extrudeAxis);
                const sign = extrudeSteps > 0 ? 1 : -1;
                const n = Math.min(Math.abs(extrudeSteps), MAX_EXTRUDE_STEPS);
                const out = [];
                const seen = new Set();
                for (let k = 1; k <= n; k++) {
                    for (const c of extrudeFaceCells) {
                        const nc = { x: c.x + av.x * sign * k, y: c.y + av.y * sign * k, z: c.z + av.z * sign * k };
                        const key = `${nc.x},${nc.y},${nc.z}`;
                        if (seen.has(key)) continue;
                        if (!inBounds(nc) || voxelMap.has(key)) continue;
                        seen.add(key);
                        out.push(nc);
                        if (out.length >= MAX_EXTRUDE_PREVIEW) return out;
                    }
                }
                return out;
            }

            function clearExtrudePreview() {
                for (let i = extrudePreviewGroup.children.length - 1; i >= 0; i--) {
                    extrudePreviewGroup.remove(extrudePreviewGroup.children[i]);
                }
            }

            function updateExtrudePreview() {
                clearExtrudePreview();
                if (!extrudeActive) return;
                const cells = extrudeTargetCells();
                cells.forEach(c => {
                    const m = new THREE.Mesh(extrudeGhostGeo, extrudeGhostMat);
                    m.position.set(c.x, c.y, c.z);
                    extrudePreviewGroup.add(m);
                });
                updateExtrudeHUD();
            }

            // Calcola i passi (interi, con segno) dal puntatore proiettato sull'asse di estrusione.
            function extrudeStepsFromPointer(e) {
                if (!extrudeAnchor) return 0;
                const rect = renderer.domElement.getBoundingClientRect();
                pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(pointer, camera);
                const av = extrudeAxisVec(extrudeAxis);
                // Punto/direzione della retta-asse e del raggio del puntatore: closest point.
                const u = new THREE.Vector3(av.x, av.y, av.z); // unit
                const P0 = new THREE.Vector3(extrudeAnchor.x, extrudeAnchor.y, extrudeAnchor.z);
                const O = raycaster.ray.origin.clone();
                const v = raycaster.ray.direction.clone();
                const w0 = new THREE.Vector3().subVectors(O, P0);
                const b = u.dot(v), c = v.dot(v), dd = u.dot(w0), ee = v.dot(w0);
                const denom = c - b * b; // a = u·u = 1
                if (Math.abs(denom) < 1e-6) return extrudeSteps; // sguardo parallelo all'asse
                const sc = (b * ee - c * dd) / denom;
                let steps = Math.round(sc);
                if (steps > MAX_EXTRUDE_STEPS) steps = MAX_EXTRUDE_STEPS;
                if (steps < -MAX_EXTRUDE_STEPS) steps = -MAX_EXTRUDE_STEPS;
                return steps;
            }

            // Arma l'estrusione dalla faccia sotto il cursore (nessuna modifica finché non si conferma).
            function armExtrude(clientX, clientY) {
                const pick = pickVoxel(clientX, clientY);
                if (!pick || pick.voxel.y < 0) return false; // niente voxel reale sotto il cursore
                const start = { x: pick.voxel.x, y: pick.voxel.y, z: pick.voxel.z };
                const n = pick.normal;
                extrudeFaceCells = collectExposedFace(start, n);
                // Asse iniziale = asse della normale della faccia puntata.
                extrudeAxis = Math.abs(n.x) > 0.5 ? 'x' : Math.abs(n.z) > 0.5 ? 'z' : 'y';
                // Ancora = centroide della faccia (coord mondo = coord voxel).
                let cx = 0, cy = 0, cz = 0;
                extrudeFaceCells.forEach(c => { cx += c.x; cy += c.y; cz += c.z; });
                const nC = extrudeFaceCells.length;
                extrudeAnchor = { x: cx / nC, y: cy / nC, z: cz / nC };
                extrudeSteps = 0;
                extrudeActive = true;
                clearPreview();
                controls.enabled = false; // blocca l'orbita durante il gesto
                updateExtrudePreview();
                updateExtrudeHUD();
                return true;
            }

            // Cambia l'asse di estrusione (X -> Y -> Z) e ricalcola i passi sul nuovo asse.
            function cycleExtrudeAxis() {
                const order = ['x', 'y', 'z'];
                extrudeAxis = order[(order.indexOf(extrudeAxis) + 1) % order.length];
                extrudeSteps = 0; // il verso/passi vanno ridefiniti sul nuovo asse col drag
                if (lastPointerEvent) extrudeSteps = extrudeStepsFromPointer(lastPointerEvent);
                updateExtrudePreview();
                updateExtrudeHUD();
            }

            // Annulla il gesto senza modificare nulla.
            function cancelExtrude() {
                if (!extrudeActive) return;
                extrudeActive = false;
                extrudeFaceCells = [];
                extrudeSteps = 0;
                extrudeAnchor = null;
                clearExtrudePreview();
                if (extrudeHUD) extrudeHUD.style.display = 'none';
                controls.enabled = true;
            }

            // Conferma: applica i voxel come UNA sola azione undo (pushHistory prima).
            function commitExtrude() {
                if (!extrudeActive) return;
                const cells = extrudeTargetCells();
                if (cells.length > 0) {
                    pushHistory();
                    cells.forEach(c => voxelMap.set(`${c.x},${c.y},${c.z}`, activeColorHex));
                    syncVoxelsFromMap();
                    buildModel(false);
                }
                cancelExtrude();
            }
