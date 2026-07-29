            // ===== T1 Multi-object helpers (Fase A) =====
            // An "object" wraps a full model-data payload ({metadata, voxels, palette?, rig?}).
            // The `voxels`/`name` accessors expose the shape { id, name, voxels, transform,
            // visible } required by the object model while `data` stays the live reference
            // that currentModelData points at for the active object (zero-copy view).
            function makeDefaultTransform() {
                return { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 };
            }

            // createObject(data, opts) — wraps model data into a scene object and appends it.
            // Does NOT change the active object; call setActiveObject() for that.
            function createObject(data, opts) {
                opts = opts || {};
                const d = (data && typeof data === 'object') ? data : { metadata: {}, voxels: [] };
                if (!d.metadata) d.metadata = {};
                if (!Array.isArray(d.voxels)) d.voxels = [];
                const id = (opts.id != null) ? opts.id : nextObjectId++;
                if (opts.id != null && opts.id >= nextObjectId) nextObjectId = opts.id + 1;
                const obj = {
                    id: id,
                    data: d, // live model-data reference (currentModelData for the active object)
                    get name() { return this.data.metadata.name || this._name || ('Oggetto ' + this.id); },
                    set name(v) { this._name = v; this.data.metadata.name = v; },
                    get voxels() { return this.data.voxels; },
                    set voxels(v) { this.data.voxels = v; },
                    transform: opts.transform || makeDefaultTransform(),
                    visible: (opts.visible !== undefined) ? opts.visible : true
                };
                if (opts.name && !d.metadata.name) obj.name = opts.name;
                sceneObjects.push(obj);
                return obj;
            }

            function getActiveObject() {
                return sceneObjects.find(o => o.id === activeObjectId) || null;
            }

            // setActiveObject(id) — makes an object active and points currentModelData at it.
            // currentModelData stays a live view of the active object's data, so all the
            // existing single-object editing code keeps working unchanged.
            function setActiveObject(id) {
                const obj = sceneObjects.find(o => o.id === id);
                if (!obj) return null;
                // Il rig appartiene all'OGGETTO (obj.rig). Va parcheggiato su quello che
                // stiamo lasciando PRIMA di cambiare attivo, altrimenti finirebbe addosso
                // al nuovo: e' l'unico punto in cui il passaggio avviene, cosi' nessun
                // chiamante deve ricordarsene.
                if (obj.id !== activeObjectId && typeof stashRigToActiveObject === 'function') {
                    stashRigToActiveObject();
                }
                activeObjectId = id;
                currentModelData = obj.data;
                if (typeof adoptRigFromActiveObject === 'function') adoptRigFromActiveObject();
                // Il renderer incrementale indicizza l'oggetto ATTIVO: cambiando oggetto
                // gli indici puntano ai voxel sbagliati. Invalidiamo, cosi' il prossimo
                // edit passa dal rebuild completo che riallinea tutto.
                if (typeof invalidateIncremental === 'function') invalidateIncremental();
                // T1 Fase B: refresh outliner selection / bounding-box highlight here.
                return obj;
            }

            // Attacca a un oggetto il rig letto dal payload. `fallback` e' il rig a livello
            // di radice: nei file di una sola figura (e in TUTTI i file salvati dalle
            // versioni precedenti) il rig sta la', non dentro objects[i].
            function attachRigFromPayload(obj, saved, fallback) {
                const src = saved || fallback;
                if (!src || typeof normalizeRig !== 'function') return;
                const r = normalizeRig(src);
                if (r) obj.rig = r;
            }

            // loadSceneFromParsed(parsed) — replaces the whole scene from a parsed payload.
            // Retro-compatibility: legacy single-object ({voxels}/{ops}) becomes ONE object;
            // extended multi-object ({objects:[...]}) loads them all.
            function loadSceneFromParsed(parsed) {
                activePartName = null;
                if (typeof invalidateIncremental === 'function') invalidateIncremental();
                sceneObjects = [];
                activeObjectId = null;
                rig = null;
                if (parsed && Array.isArray(parsed.objects)) {
                    parsed.objects.forEach((o, i) => {
                        const data = expandOps({
                            metadata: o.metadata || (o.name ? { name: o.name } : {}),
                            palette: o.palette,
                            ops: o.ops,
                            voxels: o.voxels
                        });
                        const obj = createObject(data, {
                            name: o.name,
                            transform: o.transform,
                            visible: o.visible
                        });
                        // Il rig di radice vale solo per il PRIMO oggetto: nelle versioni
                        // vecchie apparteneva comunque all'oggetto attivo, che era il primo.
                        attachRigFromPayload(obj, o.rig, i === 0 ? parsed.rig : null);
                    });
                    if (!sceneObjects.length) createObject({ metadata: {}, voxels: [] });
                    setActiveObject(sceneObjects[0].id);
                } else {
                    const data = expandOps(parsed);
                    const obj = createObject(data);
                    attachRigFromPayload(obj, parsed && parsed.rig, null);
                    setActiveObject(obj.id);
                }
                if (typeof invalidateIncremental === 'function') invalidateIncremental();
            }

            // ===== T1 Fase B: modalità editor, rendering multi-oggetto, selezione =====
            // editorMode: 'edit' (default, comportamento storico: gli strumenti agiscono
            // sull'oggetto attivo) | 'object' (selezione/spostamento oggetti, nessun edit voxel).
            let editorMode = 'edit';
            let selectedObjectIds = []; // per il merge multiplo (checkbox nell'outliner)

            // Gli oggetti NON attivi vengono renderizzati qui, ciascuno nel proprio Group
            // con il proprio transform. L'oggetto attivo resta sotto modelPivot (editabile).
            const inactiveGroup = new THREE.Group();
            scene.add(inactiveGroup);
            const objectGroups = new Map(); // id -> THREE.Group (solo oggetti non attivi)

            // BoxHelper verde attorno all'oggetto attivo (mostrato in Modalità Oggetto).
            let selectionBoxHelper = null;

            // Centro (in coord. voxel) di un elenco di voxel; [0,0,0] se vuoto.
            function voxelsCenter(voxels) {
                if (!voxels || !voxels.length) return { x: 0, y: 0, z: 0 };
                let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                voxels.forEach(v => {
                    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
                    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
                    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
                });
                return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
            }

            function isIdentityTransform(t) {
                return t && t.position && t.position.x === 0 && t.position.y === 0 && t.position.z === 0 &&
                    (t.rotationY || 0) === 0 && (t.scale === undefined || t.scale === 1);
            }

            // Applica il transform di un oggetto direttamente ai suoi voxel (coordinate),
            // poi lo resetta a identità. Necessario perché l'oggetto ATTIVO è sempre a
            // transform identità (così editing/raycasting/gizmo/rig funzionano come prima).
            // LIMITE noto: le coordinate voxel sono intere, quindi rotationY viene snappata
            // al multiplo di 90° più vicino e position/scale vengono arrotondate.
            function bakeTransform(obj) {
                const t = obj.transform || makeDefaultTransform();
                if (isIdentityTransform(t)) { obj.transform = makeDefaultTransform(); return; }
                const c = voxelsCenter(obj.data.voxels);
                const scale = (t.scale === undefined) ? 1 : t.scale;
                // rotationY snappata a step di 90° (PI/2)
                const steps = Math.round((t.rotationY || 0) / (Math.PI / 2)) & 3;
                const cos = [1, 0, -1, 0][steps];
                const sin = [0, 1, 0, -1][steps];
                (obj.data.voxels || []).forEach(v => {
                    let dx = (v.x - c.x) * scale;
                    let dz = (v.z - c.z) * scale;
                    const rx = dx * cos - dz * sin;
                    const rz = dx * sin + dz * cos;
                    v.x = Math.round(c.x + rx + t.position.x);
                    v.y = Math.round(c.y + (v.y - c.y) * scale + t.position.y);
                    v.z = Math.round(c.z + rz + t.position.z);
                });
                obj.transform = makeDefaultTransform();
            }

            // Costruisce (o ricostruisce) i Group di TUTTI gli oggetti non attivi visibili.
            // Non tocca l'oggetto attivo (gestito da buildModel) né lo stack di editing.
            function renderInactiveObjects() {
                // Svuota e libera i group precedenti.
                objectGroups.forEach(g => {
                    g.children.slice().forEach(ch => {
                        if (ch.geometry) ch.geometry.dispose();
                        if (ch.material) ch.material.dispose();
                        g.remove(ch);
                    });
                    inactiveGroup.remove(g);
                });
                objectGroups.clear();

                const gap = parseFloat(voxelGap.value) || 0;
                const boxSize = 1.0 - gap;

                sceneObjects.forEach(obj => {
                    if (obj.id === activeObjectId) return;
                    if (!obj.visible) return;
                    const voxels = obj.data.voxels || [];
                    if (!voxels.length) return;

                    const c = voxelsCenter(voxels);
                    const t = obj.transform || makeDefaultTransform();
                    const g = new THREE.Group();
                    g.position.set(c.x + t.position.x, c.y + t.position.y, c.z + t.position.z);
                    g.rotation.set(0, t.rotationY || 0, 0);
                    const s = (t.scale === undefined) ? 1 : t.scale;
                    g.scale.set(s, s, s);

                    const visible = computeVisibility(voxels);
                    const colorGroups = {};
                    visible.forEach(v => {
                        const col = v.color.toUpperCase();
                        (colorGroups[col] = colorGroups[col] || []).push(v);
                    });
                    const geometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
                    Object.keys(colorGroups).forEach(colorHex => {
                        const list = colorGroups[colorHex];
                        const material = new THREE.MeshStandardMaterial({
                            color: new THREE.Color(colorHex), roughness: 0.2, metalness: 0.1,
                            wireframe: toggleWireframe.checked,
                            transparent: true, opacity: 0.9
                        });
                        const instMesh = new THREE.InstancedMesh(geometry, material, list.length);
                        const dummy = new THREE.Object3D();
                        list.forEach((v, i) => {
                            dummy.position.set(v.x - c.x, v.y - c.y, v.z - c.z);
                            dummy.updateMatrix();
                            instMesh.setMatrixAt(i, dummy.matrix);
                        });
                        instMesh.instanceMatrix.needsUpdate = true;
                        instMesh.userData.objectId = obj.id;
                        g.add(instMesh);
                    });
                    objectGroups.set(obj.id, g);
                    inactiveGroup.add(g);
                });
                // La visibilità dell'inactiveGroup segue la vista voxel (nascosto in rig).
                inactiveGroup.visible = !rigPreviewActive;
            }

            // Aggiorna il BoxHelper di selezione attorno all'oggetto attivo.
            function updateSelectionHighlight() {
                if (selectionBoxHelper) { scene.remove(selectionBoxHelper); selectionBoxHelper = null; }
                if (editorMode !== 'object') return;
                if (rigPreviewActive) return;
                const active = getActiveObject();
                if (!active || !(active.data.voxels || []).length) return;
                selectionBoxHelper = new THREE.BoxHelper(modelPivot, 0x22c55e);
                selectionBoxHelper.update();
                scene.add(selectionBoxHelper);
            }

            // Ridisegna l'intera scena: attivo (buildModel) + non attivi + evidenziazione.
            function refreshScene(resetCamera) {
                buildModel(resetCamera === true);
            }

            // Applica alla UI l'attuale editorMode (badge, cursore, tool).
            function applyEditorMode() {
                const badge = document.getElementById('editorModeBadge');
                if (badge) badge.textContent = editorMode === 'object' ? 'Modalità Oggetto' : 'Modalità Modifica';
                if (editorMode === 'object') {
                    // In Modalità Oggetto niente editing: torna alla vista/orbita.
                    if (currentTool !== 'view') setTool('view');
                    renderer.domElement.style.cursor = 'pointer';
                    // Mostra il gizmo di spostamento sulla selezione corrente.
                    if (typeof attachSelectionGizmo === 'function') attachSelectionGizmo();
                } else {
                    // Uscendo dalla Modalità Oggetto si toglie il gizmo automatico.
                    if (typeof globalTransformControls !== 'undefined') globalTransformControls.detach();
                }
                updateSelectionHighlight();
            }

            function toggleEditorMode() {
                editorMode = (editorMode === 'edit') ? 'object' : 'edit';
                // T2: uscire dalla Modalità Modifica annulla un eventuale gesto di estrusione.
                if (editorMode === 'object' && typeof cancelExtrude === 'function') cancelExtrude();
                applyEditorMode();
            }

            // ===== T1 Fase B: Outliner (pannello Oggetti) =====
            let activePartName = null;

            function getObjectParts(obj) {
                const voxels = obj.data.voxels || [];
                const parts = {};
                voxels.forEach(v => {
                    if (v.part) {
                        if (!parts[v.part]) parts[v.part] = 0;
                        parts[v.part]++;
                    }
                });
                return Object.keys(parts).length > 1 ? parts : {};
            }

            function renderObjectsList() {
                const listEl = document.getElementById('objectsList');
                if (!listEl) return;
                listEl.innerHTML = '';
                sceneObjects.forEach(obj => {
                    const isActive = obj.id === activeObjectId;
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:8px; cursor:pointer; font-size:12px;' +
                        (isActive ? 'background:rgba(71,85,105,0.28); border:1px solid var(--accent-primary, #475569);'
                                  : 'background:rgba(255,255,255,0.04); border:1px solid transparent;');

                    const chk = document.createElement('input');
                    chk.type = 'checkbox';
                    chk.checked = selectedObjectIds.indexOf(obj.id) !== -1;
                    chk.title = t('objects.selectForMerge');
                    chk.style.cssText = 'cursor:pointer; accent-color:var(--accent-primary,#475569);';
                    chk.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        const i = selectedObjectIds.indexOf(obj.id);
                        if (chk.checked && i === -1) selectedObjectIds.push(obj.id);
                        else if (!chk.checked && i !== -1) selectedObjectIds.splice(i, 1);
                    });

                    const eye = document.createElement('span');
                    eye.textContent = obj.visible ? '👁' : '🚫';
                    eye.title = obj.visible ? 'Nascondi oggetto' : 'Mostra oggetto';
                    eye.style.cssText = 'cursor:pointer; user-select:none; opacity:' + (obj.visible ? '1' : '0.5') + ';';
                    eye.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        obj.visible = !obj.visible;
                        buildModel(false);
                    });

                    const label = document.createElement('span');
                    label.textContent = obj.name;
                    label.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' +
                        (obj.visible ? '' : 'opacity:0.5;');

                    const count = document.createElement('span');
                    count.textContent = (obj.data.voxels || []).length;
                    count.style.cssText = 'font-size:10px; color:var(--text-muted,#9ca3af);';

                    row.appendChild(chk);
                    row.appendChild(eye);
                    row.appendChild(label);
                    row.appendChild(count);
                    row.addEventListener('click', () => {
                        activePartName = null;
                        if (obj.id !== activeObjectId) selectActiveObjectAndRefresh(obj.id);
                        else renderObjectsList();
                        // Selezione dell'intero oggetto: il gizmo torna a spostare tutto.
                        if (editorMode === 'object' && typeof attachSelectionGizmo === 'function') {
                            attachSelectionGizmo();
                        }
                    });
                    listEl.appendChild(row);

                    const parts = getObjectParts(obj);
                    const partNames = Object.keys(parts);
                    if (partNames.length > 0) {
                        partNames.forEach(partName => {
                            const partRow = document.createElement('div');
                            const isPartSel = isActive && activePartName === partName;
                            const hiddenParts = obj._hiddenParts || {};
                            const partHidden = !!hiddenParts[partName];
                            partRow.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 8px 4px 28px; cursor:pointer; font-size:11px; border-radius:6px;' +
                                (isPartSel ? 'background:rgba(71,85,105,0.4); border:1px solid var(--accent-primary,#475569);'
                                           : 'background:transparent; border:1px solid transparent;');

                            const partEye = document.createElement('span');
                            partEye.textContent = partHidden ? '🚫' : '👁';
                            partEye.style.cssText = 'cursor:pointer; user-select:none; font-size:10px; opacity:' + (partHidden ? '0.4' : '0.7') + ';';
                            partEye.addEventListener('click', (ev) => {
                                ev.stopPropagation();
                                if (!obj._hiddenParts) obj._hiddenParts = {};
                                obj._hiddenParts[partName] = !obj._hiddenParts[partName];
                                obj.data.voxels.forEach(v => {
                                    if (v.part === partName) v._hidden = !!obj._hiddenParts[partName];
                                });
                                buildModel(false);
                            });

                            const partLabel = document.createElement('span');
                            partLabel.textContent = '⤷ ' + partName;
                            partLabel.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-secondary,#94a3b8);' +
                                (partHidden ? 'opacity:0.4;' : '');

                            const partCount = document.createElement('span');
                            partCount.textContent = parts[partName];
                            partCount.style.cssText = 'font-size:10px; color:var(--text-muted,#9ca3af);';

                            const partDup = document.createElement('span');
                            partDup.textContent = '📋';
                            partDup.title = 'Duplica come oggetto separato';
                            partDup.style.cssText = 'cursor:pointer; font-size:10px; opacity:0.6;';
                            partDup.addEventListener('click', (ev) => {
                                ev.stopPropagation();
                                const partVoxels = obj.data.voxels.filter(v => v.part === partName).map(v => {
                                    const nv = Object.assign({}, v);
                                    delete nv.part;
                                    delete nv._hidden;
                                    return nv;
                                });
                                const newData = {
                                    metadata: Object.assign({}, obj.data.metadata, { name: partName }),
                                    voxels: partVoxels,
                                    palette: obj.data.palette ? JSON.parse(JSON.stringify(obj.data.palette)) : undefined
                                };
                                createObject(newData);
                                buildModel(false);
                            });

                            const partDel = document.createElement('span');
                            partDel.textContent = '🗑';
                            partDel.title = 'Elimina parte/figlio';
                            partDel.style.cssText = 'cursor:pointer; font-size:10px; opacity:0.6;';
                            partDel.addEventListener('click', (ev) => {
                                ev.stopPropagation();
                                if (!confirm(t('objects.confirmDeletePart', { name: partName }))) return;
                                if (typeof pushHistory === 'function') pushHistory();
                                obj.data.voxels = obj.data.voxels.filter(v => v.part !== partName);
                                if (activePartName === partName) activePartName = null;
                                if (typeof rebuildVoxelMap === 'function') rebuildVoxelMap();
                                buildModel(false);
                                renderObjectsList();
                            });

                            partRow.appendChild(partEye);
                            partRow.appendChild(partLabel);
                            partRow.appendChild(partCount);
                            partRow.appendChild(partDup);
                            partRow.appendChild(partDel);
                            partRow.addEventListener('click', () => {
                                if (obj.id !== activeObjectId) selectActiveObjectAndRefresh(obj.id);
                                activePartName = isPartSel ? null : partName;
                                renderObjectsList();
                                // In Modalità Oggetto il gizmo segue la parte selezionata:
                                // agganciandosi alla parte, il drag sposta solo quella.
                                if (editorMode === 'object' && typeof attachSelectionGizmo === 'function') {
                                    attachSelectionGizmo();
                                }
                            });
                            listEl.appendChild(partRow);
                        });
                    }
                });
                const delBtn = document.getElementById('objDeleteBtn');
                if (delBtn) {
                    if (activePartName) {
                        delBtn.textContent = '🗑 Elimina figlio: ' + activePartName;
                    } else {
                        delBtn.textContent = '🗑 Elimina attivo';
                    }
                }
            }

            // Rende attivo un oggetto e ridisegna scena/outliner (senza reset camera).
            // L'oggetto attivo è sempre a transform identità (editing/gizmo/rig lavorano in
            // coordinate voxel dirette), quindi eventuale transform pendente viene "baked".
            function selectActiveObjectAndRefresh(id) {
                const obj = sceneObjects.find(o => o.id === id);
                if (obj && !isIdentityTransform(obj.transform)) bakeTransform(obj);
                setActiveObject(id);
                // Nessun `rig = null` qui: setActiveObject ha gia' parcheggiato il rig
                // sull'oggetto lasciato e adottato quello del nuovo.
                rebuildVoxelMap();
                buildModel(false);
                // In Modalità Oggetto riposiziona il gizmo sul nuovo oggetto selezionato.
                if (editorMode === 'object' && typeof attachSelectionGizmo === 'function') {
                    attachSelectionGizmo();
                }
            }

            // ===== T1 Fase B: operazioni oggetto =====
            function objNew() {
                const hasContent = sceneObjects.some(o => (o.data.voxels || []).length > 0);
                if (hasContent) {
                    if (!confirm(t('objects.confirmNew'))) return;
                }
                const gSize = (currentModelData.metadata && currentModelData.metadata.grid_size) || [16, 16, 16];
                const obj = createObject({ metadata: { name: 'Oggetto ' + nextObjectId, grid_size: gSize.slice() }, voxels: [] });
                selectActiveObjectAndRefresh(obj.id);
            }

            function objDuplicate() {
                const active = getActiveObject();
                if (!active) return;
                const clone = JSON.parse(JSON.stringify(active.data));
                clone.metadata = clone.metadata || {};
                clone.metadata.name = (active.name || 'Oggetto') + ' (copia)';
                const t = active.transform || makeDefaultTransform();
                const obj = createObject(clone, {
                    transform: {
                        position: { x: (t.position.x || 0) + 1, y: t.position.y || 0, z: (t.position.z || 0) + 1 },
                        rotationY: t.rotationY || 0,
                        scale: (t.scale === undefined) ? 1 : t.scale
                    }
                });
                selectActiveObjectAndRefresh(obj.id);
            }

            function objRename() {
                const active = getActiveObject();
                if (!active) return;
                const name = prompt(t('objects.promptRename'), active.name);
                if (name === null) return;
                const trimmed = name.trim();
                if (trimmed) { active.name = trimmed; buildModel(false); }
            }

            function objDelete() {
                const active = getActiveObject();
                if (!active) return;
                if (activePartName) {
                    if (!confirm(t('objects.confirmDeleteChild', { name: activePartName }))) return;
                    if (typeof pushHistory === 'function') pushHistory();
                    active.data.voxels = active.data.voxels.filter(v => v.part !== activePartName);
                    activePartName = null;
                    if (typeof rebuildVoxelMap === 'function') rebuildVoxelMap();
                    buildModel(false);
                    renderObjectsList();
                    return;
                }
                if (!confirm(t('objects.confirmDelete', { name: active.name }))) return;
                if (typeof pushHistory === 'function') pushHistory();
                const idx = sceneObjects.findIndex(o => o.id === active.id);
                if (idx === -1) return;
                sceneObjects.splice(idx, 1);
                selectedObjectIds = selectedObjectIds.filter(id => id !== active.id);
                if (!sceneObjects.length) {
                    const empty = createObject({ metadata: { name: 'Oggetto 1', grid_size: [16, 16, 16] }, voxels: [] });
                    setActiveObject(empty.id);
                } else {
                    setActiveObject(sceneObjects[Math.max(0, idx - 1)].id);
                }
                activePartName = null;
                // Il rig dell'oggetto eliminato spariva con lui; quello del nuovo attivo
                // e' gia' stato adottato da setActiveObject, quindi qui NON si azzera.
                if (typeof invalidateIncremental === 'function') invalidateIncremental();
                rebuildVoxelMap();
                buildModel(false);
            }

            // Unisce gli oggetti spuntati (o attivo + un altro) in uno solo, portando i
            // voxel nello spazio mondo (bake dei rispettivi transform), poi resetta il
            // transform del risultato. Collisioni: l'ULTIMO oggetto nell'ordine di scena
            // vince sulla stessa coordinata (documentato).
            function objMerge() {
                let ids = selectedObjectIds.slice();
                if (ids.length < 2) {
                    // fallback: attivo + primo altro visibile
                    const others = sceneObjects.filter(o => o.id !== activeObjectId);
                    if (!getActiveObject() || !others.length) {
                        alert(t('objects.mergeNeedTwo'));
                        return;
                    }
                    ids = [activeObjectId, others[0].id];
                }
                // Ordina secondo l'ordine di scena per un merge deterministico.
                const toMerge = sceneObjects.filter(o => ids.indexOf(o.id) !== -1);
                if (toMerge.length < 2) { alert(t('objects.mergeInvalid')); return; }

                const map = new Map(); // "x,y,z" -> color (ultimo vince)
                toMerge.forEach(o => {
                    const tmp = { data: JSON.parse(JSON.stringify(o.data)), transform: o.transform };
                    bakeTransform(tmp);
                    (tmp.data.voxels || []).forEach(v => {
                        map.set(v.x + ',' + v.y + ',' + v.z, v.color);
                    });
                });
                const mergedVoxels = [...map.entries()].map(([k, color]) => {
                    const [x, y, z] = k.split(',').map(Number);
                    return { x, y, z, color };
                });
                const baseMeta = toMerge[0].data.metadata || {};
                const merged = createObject({
                    metadata: { name: 'Unione', grid_size: (baseMeta.grid_size || [16, 16, 16]).slice() },
                    voxels: mergedVoxels
                });
                // Rimuove gli originali fusi.
                const mergeIdSet = new Set(toMerge.map(o => o.id));
                sceneObjects = sceneObjects.filter(o => !mergeIdSet.has(o.id) || o.id === merged.id);
                selectedObjectIds = [];
                setActiveObject(merged.id);
                // L'unione produce un oggetto NUOVO senza rig: setActiveObject ha gia'
                // messo `rig` a null adottando il rig (assente) del merge.
                rebuildVoxelMap();
                buildModel(false);
            }

            // Import: AGGIUNGE gli oggetti di un payload senza sostituire la scena.
            function appendSceneFromParsed(parsed) {
                let firstNew = null;
                if (parsed && Array.isArray(parsed.objects)) {
                    parsed.objects.forEach((o, i) => {
                        const data = expandOps({
                            metadata: o.metadata || (o.name ? { name: o.name } : {}),
                            palette: o.palette, ops: o.ops, voxels: o.voxels
                        });
                        const obj = createObject(data, { name: o.name, transform: o.transform, visible: o.visible });
                        attachRigFromPayload(obj, o.rig, i === 0 ? parsed.rig : null);
                        if (!firstNew) firstNew = obj;
                    });
                } else {
                    const data = expandOps(parsed);
                    firstNew = createObject(data);
                    attachRigFromPayload(firstNew, parsed && parsed.rig, null);
                }
                if (firstNew) setActiveObject(firstNew.id);
                rebuildVoxelMap();
            }
