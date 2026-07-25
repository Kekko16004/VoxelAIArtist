            // resetCamera: ricentra la camera sul modello (solo su load/generate).
            // skipInactive: salta il rebuild degli oggetti INATTIVI (T1). Durante un edit
            //   dell'oggetto attivo (place/remove/draw) gli altri oggetti non cambiano,
            //   quindi ricostruirli a ogni pennellata è spreco. Default false = comportamento
            //   invariato (rebuild completo per load/generate/import/switch oggetto).
            function buildModel(resetCamera = true, skipInactive = false) {
                if (typeof clearRigPreview === 'function') {
                    clearRigPreview();
                    rig = null;
                    selectedBoneIndex = -1;
                    if (rigDetails) rigDetails.style.display = 'none';
                    if (rigHint) rigHint.textContent = 'Genera o carica un modello, poi premi "Crea Rig Automatico".';
                }

                // Perf: libera geometrie/materiali GPU dei mesh precedenti PRIMA di
                // scartarli. Senza questo, ogni edit (place/remove/draw chiama
                // buildModel(false)) lasciava orfani geometry+material sulla GPU, con
                // accumulo progressivo di memoria e rallentamento nelle sessioni lunghe.
                meshes.forEach(m => { disposeMesh(m); modelPivot.remove(m); });
                meshes = [];
                if (gridHelper) { scene.remove(gridHelper); disposeMesh(gridHelper); gridHelper = null; }
                if (boxHelper) { modelPivot.remove(boxHelper); disposeMesh(boxHelper); boxHelper = null; }

                const meta = currentModelData.metadata || {};
                const voxels = currentModelData.voxels || [];
                const builtMeshByColor = new Map();

                rebuildVoxelMap();

                visibleVoxels = computeVisibility(voxels);

                modelNameEl.textContent = meta.name || "Senza Nome";
                const gSize = meta.grid_size || [16, 16, 16];
                gridSizeEdit.value = `${gSize[0]},${gSize[1]},${gSize[2]}`;
                voxelCountEl.textContent = voxels.length;
                visibleCountEl.textContent = visibleVoxels.length;

                // Palette: usa la funzione condivisa con il renderer incrementale
                // (28-incremental.js) invece di duplicarne il codice, cosi' le due
                // strade non possono divergere e le swatch non lampeggiano.
                const uniqueColors = [...new Set(voxels.map(v => v.color.toUpperCase()))];
                renderPaletteSwatches(uniqueColors);

                let minX, maxX, minY, maxY, minZ, maxZ;
                if (voxels.length === 0) {
                    minX = 0; maxX = gSize[0] - 1;
                    minY = 0; maxY = gSize[1] - 1;
                    minZ = 0; maxZ = gSize[2] - 1;
                } else {
                    minX = Infinity; maxX = -Infinity;
                    minY = Infinity; maxY = -Infinity;
                    minZ = Infinity; maxZ = -Infinity;
                    voxels.forEach(v => {
                        if (v.x < minX) minX = v.x;
                        if (v.x > maxX) maxX = v.x;
                        if (v.y < minY) minY = v.y;
                        if (v.y > maxY) maxY = v.y;
                        if (v.z < minZ) minZ = v.z;
                        if (v.z > maxZ) maxZ = v.z;
                    });
                }

                const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
                modelPivot.position.copy(center);
                modelPivot.rotation.set(0, 0, 0);
                // T-props: memorizza il centro "base" del modello. L'anteprima live del
                // pannello Proprietà sposta/ruota/scala il modelPivot rispetto a questo
                // centro senza toccare i voxel (bake solo al commit). Vedi applyLiveTransform().
                modelPivotBaseCenter.copy(center);

                if (voxels.length > 0) {
                    const colorGroups = {};
                    visibleVoxels.forEach(v => {
                        const c = v.color.toUpperCase();
                        if (!colorGroups[c]) colorGroups[c] = [];
                        colorGroups[c].push(v);
                    });

                    const gap = parseFloat(voxelGap.value);
                    const boxSize = 1.0 - gap;
                    const geometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);

                    Object.keys(colorGroups).forEach(colorHex => {
                        const groupList = colorGroups[colorHex];
                        const count = groupList.length;

                        const material = new THREE.MeshStandardMaterial({
                            color: new THREE.Color(colorHex),
                            roughness: 0.2,
                            metalness: 0.1,
                            wireframe: toggleWireframe.checked
                        });

                        const instMesh = new THREE.InstancedMesh(geometry, material, count);
                        const dummy = new THREE.Object3D();

                        groupList.forEach((v, index) => {
                            dummy.position.set(v.x, v.y, v.z);
                            dummy.updateMatrix();
                            instMesh.setMatrixAt(index, dummy.matrix);
                        });

                        instMesh.instanceMatrix.needsUpdate = true;
                        instMesh.position.set(-center.x, -center.y, -center.z);
                        instMesh.userData.voxels = groupList;
                        modelPivot.add(instMesh);
                        meshes.push(instMesh);
                        builtMeshByColor.set(colorHex, instMesh);
                    });
                }

                if (toggleGrid.checked) {
                    const maxDim = Math.max(gSize[0], gSize[2]);
                    gridHelper = new THREE.GridHelper(maxDim, maxDim, 0x64748b, 0x2e2b42);
                    gridHelper.position.set(gSize[0] / 2 - 0.5, 0, gSize[2] / 2 - 0.5);
                    scene.add(gridHelper);

                    const boxGeometry = new THREE.BoxGeometry(
                        maxX - minX + 1,
                        maxY - minY + 1,
                        maxZ - minZ + 1
                    );
                    const edges = new THREE.EdgesGeometry(boxGeometry);
                    boxHelper = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
                        color: 0x94a3b8,
                        linewidth: voxels.length === 0 ? 1 : 2,
                        transparent: voxels.length === 0,
                        opacity: voxels.length === 0 ? 0.35 : 1
                    }));
                    boxHelper.position.set(center.x - modelPivot.position.x, center.y - modelPivot.position.y, center.z - modelPivot.position.z);
                    modelPivot.add(boxHelper);
                }

                if (resetCamera) {
                    const sizeX = maxX - minX + 1;
                    const sizeY = maxY - minY + 1;
                    const sizeZ = maxZ - minZ + 1;
                    const maxBoundingSize = Math.max(sizeX, sizeY, sizeZ);
                    controls.target.copy(center);
                    camera.position.set(center.x + maxBoundingSize, center.y + maxBoundingSize, center.z + maxBoundingSize);
                    camera.lookAt(center);
                }

                // Da qui in poi gli edit possono usare il percorso incrementale:
                // registriamo indici, visibilita' e mesh appena costruiti.
                if (typeof primeIncrementalState === 'function') {
                    primeIncrementalState(voxels, visibleVoxels, builtMeshByColor);
                }

                if (typeof updateMirrorPlane === 'function') updateMirrorPlane();

                // T-props: se c'è un'anteprima transform live in corso, riapplicala dopo il
                // rebuild (buildModel ha appena resettato pivot a position=center, rotation=0).
                if (typeof reapplyLiveTransform === 'function') reapplyLiveTransform();

                // T1 Fase B: renderizza gli altri oggetti della scena e aggiorna outliner/selezione.
                if (!skipInactive && typeof renderInactiveObjects === 'function') renderInactiveObjects();
                if (typeof renderObjectsList === 'function') renderObjectsList();
                if (typeof updateSelectionHighlight === 'function') updateSelectionHighlight();
            }

            // Perf: libera le risorse GPU (geometry + material) di un mesh/linesegments.
            // In r128 gli InstancedMesh raggruppati per colore condividono una geometry:
            // il doppio dispose è innocuo, ma libera comunque ogni material distinto.
            function disposeMesh(m) {
                if (!m) return;
                if (m.geometry && typeof m.geometry.dispose === 'function') m.geometry.dispose();
                const mat = m.material;
                if (Array.isArray(mat)) mat.forEach(x => x && x.dispose && x.dispose());
                else if (mat && typeof mat.dispose === 'function') mat.dispose();
            }

            // Export Functionality
            // Greedy meshing: merge adjacent, coplanar, same-color voxel faces into the
            // largest possible rectangles. Turns thousands of little cube faces into a
            // handful of big quads, so exported OBJ files are dramatically smaller and
            // clean to work with in Blender/etc. Returns quads: {verts:[[x,y,z]*4], color, normal}.