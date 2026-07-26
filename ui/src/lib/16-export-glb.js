            const CUBE_FACES = [
                { n: [1, 0, 0], v: [[.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5], [.5, -.5, .5]] },
                { n: [-1, 0, 0], v: [[-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5], [-.5, -.5, -.5]] },
                { n: [0, 1, 0], v: [[-.5, .5, -.5], [-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5]] },
                { n: [0, -1, 0], v: [[-.5, -.5, .5], [-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5]] },
                { n: [0, 0, 1], v: [[.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5], [-.5, -.5, .5]] },
                { n: [0, 0, -1], v: [[-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5], [.5, -.5, -.5]] }
            ];

            // --- GLB export ---------------------------------------------------------
            // Rigged path: export the live SkinnedMesh + Skeleton + preset clips.
            // Static path (no rig): merge visible voxels into one vertex-colored mesh.
            // Compute the export offset so the model's feet-center lands on world origin:
            // X/Z centered on the model, Y at the lowest voxel (feet on the floor at y=0).
            function exportOrigin(voxels) {
                let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
                voxels.forEach(v => {
                    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
                    if (v.y < minY) minY = v.y;
                    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
                });
                return { x: (minX + maxX) / 2, y: minY - 0.5, z: (minZ + maxZ) / 2 };
            }

            // `voxelsOverride` permette di costruire il mesh di un modello DIVERSO
            // da quello in scena: serve all'export del pack, che deve produrre il
            // GLB di N asset senza caricarli uno a uno nel viewer.
            // Omesso = comportamento originale sull'oggetto attivo.
            function buildStaticExportMesh(voxelsOverride) {
                const gap = parseFloat(voxelGap.value) || 0; const s = 1.0 - gap;
                const allVoxels = voxelsOverride || currentModelData.voxels || [];
                const o = exportOrigin(allVoxels);
                const voxelSet = new Set();
                allVoxels.forEach(vox => voxelSet.add(`${vox.x},${vox.y},${vox.z}`));

                const byColor = {};
                // Quali voxel disegnare: quelli VISIBILI (le facce interne non
                // servono). Per un modello esterno la visibilita' va calcolata qui,
                // perche' `visibleVoxels` riguarda solo l'oggetto in scena.
                let sourceVisible;
                if (voxelsOverride) {
                    sourceVisible = (typeof computeVisibility === 'function')
                        ? computeVisibility(allVoxels) : allVoxels;
                } else {
                    // Il renderer incrementale aggiorna visibleVoxels in modo pigro:
                    // sincronizziamo qui, prima di leggerlo, cosi' l'export non usa
                    // mai uno stato vecchio.
                    if (typeof syncVisibleVoxels === 'function') syncVisibleVoxels();
                    sourceVisible = visibleVoxels;
                }
                sourceVisible.forEach(v => {
                    if (!byColor[v.color]) byColor[v.color] = [];
                    byColor[v.color].push(v);
                });
                const materials = [];
                const positions = [], normals = [], indices = []; let vbase = 0;
                const geom = new THREE.BufferGeometry();
                Object.keys(byColor).forEach((hexColor, matIdx) => {
                    const groupStart = indices.length;
                    const col = new THREE.Color(hexColor).convertSRGBToLinear();
                    materials.push(new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.25, side: THREE.DoubleSide }));
                    byColor[hexColor].forEach(v => {
                        CUBE_FACES.forEach(f => {
                            const nx = v.x + f.n[0];
                            const ny = v.y + f.n[1];
                            const nz = v.z + f.n[2];
                            if (voxelSet.has(`${nx},${ny},${nz}`)) return;

                            for (let k = 0; k < 4; k++) {
                                const vt = f.v[k];
                                positions.push(v.x + vt[0] * s - o.x, v.y + vt[1] * s - o.y, v.z + vt[2] * s - o.z);
                                normals.push(f.n[0], f.n[1], f.n[2]);
                            }
                            indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3); vbase += 4;
                        });
                    });
                    geom.addGroup(groupStart, indices.length - groupStart, matIdx);
                });
                geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
                geom.setIndex(indices);
                return new THREE.Mesh(geom, materials);
            }

            /**
             * Produce il GLB di un modello arbitrario come Uint8Array (Promise).
             * GLTFExporter.parse e' ASINCRONO e basato su callback: qui lo avvolgo
             * in una Promise cosi' l'export del pack puo' attendere N asset in
             * sequenza. Il mesh temporaneo viene distrutto subito dopo: senza
             * dispose, esportare 15 asset lascerebbe 15 geometrie sulla GPU.
             */
            function buildGlbForModel(model) {
                return new Promise((resolve, reject) => {
                    let mesh = null;
                    try {
                        const voxels = (model && model.voxels) || [];
                        if (!voxels.length) { resolve(null); return; }
                        mesh = buildStaticExportMesh(voxels);
                        const exporter = new THREE.GLTFExporter();
                        exporter.parse(mesh, (result) => {
                            try {
                                resolve(new Uint8Array(result));
                            } catch (e) {
                                reject(e);
                            } finally {
                                if (mesh) disposeExportMesh(mesh);
                            }
                        }, { binary: true, onlyVisible: false });
                    } catch (e) {
                        if (mesh) disposeExportMesh(mesh);
                        reject(e);
                    }
                });
            }

            // Libera geometria e materiali di un mesh temporaneo da export.
            function disposeExportMesh(mesh) {
                try {
                    if (mesh.geometry && mesh.geometry.dispose) mesh.geometry.dispose();
                    const m = mesh.material;
                    if (Array.isArray(m)) m.forEach(x => x && x.dispose && x.dispose());
                    else if (m && m.dispose) m.dispose();
                } catch (e) { /* best effort */ }
            }

            function exportGLB() {
                const meta = currentModelData.metadata || {};
                const name = (meta.name || 'voxel_model').replace(/\s+/g, '_');
                let exportRoot, animations = [];
                let restore = null;

                const haveRig = rig && rig.bones && rig.bones.length;
                if (haveRig && !skinnedMesh) { applyRig(); }

                const doScale = document.getElementById('glbScaleCheckbox').checked;

                if (haveRig && skinnedMesh) {
                    const savedPose = rig.pose;
                    rig.pose = {};
                    applyPoseToBones();
                    skeleton.update();

                    const o = exportOrigin(currentModelData.voxels || []);
                    const attr = skinnedMesh.geometry.getAttribute('color');
                    const savedColors = attr.array.slice();
                    const lin = new THREE.Color();
                    for (let i = 0; i < attr.array.length; i += 3) {
                        lin.setRGB(savedColors[i], savedColors[i + 1], savedColors[i + 2]).convertSRGBToLinear();
                        attr.array[i] = lin.r; attr.array[i + 1] = lin.g; attr.array[i + 2] = lin.b;
                    }
                    attr.needsUpdate = true;
                    const savedMeshPos = skinnedMesh.position.clone();
                    skinnedMesh.position.set(-o.x, -o.y, -o.z);
                    skinnedMesh.updateMatrixWorld(true);

                    let savedMetal = [];
                    if (Array.isArray(skinnedMesh.material)) {
                        skinnedMesh.material.forEach((m, i) => {
                            savedMetal[i] = m.metalness;
                            m.metalness = 0.25;
                            m.color.set(m.userData.hexColor).convertSRGBToLinear();
                            m.vertexColors = false;
                        });
                    } else {
                        savedMetal = skinnedMesh.material.metalness;
                        skinnedMesh.material.metalness = 0.25;
                    }

                    const savedScale = skinnedMesh.scale.clone();
                    if (doScale) {
                        skinnedMesh.scale.set(0.01, 0.01, 0.01);
                        skinnedMesh.updateMatrixWorld(true);
                    }

                    animations = rigClips;
                    exportRoot = skinnedMesh;
                    restore = () => {
                        rig.pose = savedPose; applyPoseToBones();
                        attr.array.set(savedColors); attr.needsUpdate = true;
                        skinnedMesh.position.copy(savedMeshPos);
                        skinnedMesh.scale.copy(savedScale);
                        skinnedMesh.updateMatrixWorld(true);
                        if (Array.isArray(skinnedMesh.material)) {
                            skinnedMesh.material.forEach((m, i) => {
                                m.metalness = savedMetal[i];
                                m.color.set(0xffffff);
                                m.vertexColors = true;
                            });
                        } else {
                            skinnedMesh.material.metalness = savedMetal;
                        }
                    };
                } else {
                    exportRoot = buildStaticExportMesh();
                    if (doScale) {
                        exportRoot.scale.set(0.01, 0.01, 0.01);
                        exportRoot.updateMatrixWorld(true);
                    }
                }

                const exporter = new THREE.GLTFExporter();
                exporter.parse(exportRoot, (result) => {
                    const blob = new Blob([result], { type: 'model/gltf-binary' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${name}.glb`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                    if (restore) restore();
                }, { binary: true, animations, onlyVisible: false });
            }
            document.getElementById('exportGlbBtn').addEventListener('click', exportGLB);
