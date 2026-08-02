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

            // `cullInternal` false = modello PIENO: si tengono anche i cubi che stanno
            // dentro e le facce fra un cubo e l'altro. Serve a chi importa il modello per
            // tagliarlo, fonderlo o simularlo, dove un guscio vuoto non va bene.
            function exportCullInternal() {
                const cb = document.getElementById('glbCullInternalCheckbox');
                return cb ? cb.checked : true;
            }

            function buildStaticExportMesh(scale) {
                const gap = parseFloat(voxelGap.value) || 0; const s = 1.0 - gap;
                const K = (Number(scale) > 0) ? Number(scale) : 1;
                const o = exportOrigin(currentModelData.voxels || []);
                const allVoxels = currentModelData.voxels || [];
                const cull = exportCullInternal();

                if (typeof syncVisibleVoxels === 'function') syncVisibleVoxels();

                const existingParts = [...new Set(allVoxels.filter(v => v.part).map(v => v.part))];
                const fallbackPart = existingParts.length > 0 ? existingParts[0] : ((currentModelData.metadata && currentModelData.metadata.name) || 'Object');

                const partsMap = {};
                // Raggruppiamo i voxel per parte. Col culling bastano quelli visibili;
                // senza culling servono TUTTI, interni compresi, altrimenti il "modello
                // pieno" resterebbe cavo esattamente come quello leggero.
                (cull ? visibleVoxels : allVoxels).forEach(v => {
                    const partName = v.part || fallbackPart;
                    if (!partsMap[partName]) partsMap[partName] = { voxels: [], voxelSet: new Set() };
                    partsMap[partName].voxels.push(v);
                });

                // Per il culling delle facce, usiamo tutti i voxel di quella specifica parte
                // cosi' le facce interne tra due parti diverse vengono generate (utile per separarle!)
                if (cull) allVoxels.forEach(vox => {
                    const partName = vox.part || fallbackPart;
                    if (partsMap[partName]) {
                        partsMap[partName].voxelSet.add(`${vox.x},${vox.y},${vox.z}`);
                    }
                });

                const group = new THREE.Group();

                Object.keys(partsMap).forEach(partName => {
                    const partData = partsMap[partName];
                    const byColor = {};
                    partData.voxels.forEach(v => {
                        if (!byColor[v.color]) byColor[v.color] = [];
                        byColor[v.color].push(v);
                    });

                    const materials = [];
                    const positions = [], normals = [], indices = []; let vbase = 0;
                    const geom = new THREE.BufferGeometry();

                    Object.keys(byColor).forEach((hexColor) => {
                        const groupStart = indices.length;
                        const col = new THREE.Color(hexColor).convertSRGBToLinear();
                        byColor[hexColor].forEach(v => {
                            CUBE_FACES.forEach(f => {
                                const nx = v.x + f.n[0];
                                const ny = v.y + f.n[1];
                                const nz = v.z + f.n[2];
                                if (partData.voxelSet.has(`${nx},${ny},${nz}`)) return;

                                for (let k = 0; k < 4; k++) {
                                    const vt = f.v[k];
                                    positions.push((v.x + vt[0] * s - o.x) * K,
                                        (v.y + vt[1] * s - o.y) * K,
                                        (v.z + vt[2] * s - o.z) * K);
                                    normals.push(f.n[0], f.n[1], f.n[2]);
                                }
                                indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3); vbase += 4;
                            });
                        });
                        // Niente gruppo (ne' materiale) per un colore che non ha
                        // prodotto facce: qui capita a chi sta tutto dentro un'altra
                        // parte. Un gruppo con count 0 fa scrivere al GLTFExporter r128
                        // una primitiva SENZA `indices`, che per la specifica glTF si
                        // disegna prendendo i vertici in sequenza — cioe' l'intera mesh
                        // letta a triple arbitrarie, un groviglio di triangoli che
                        // attraversano il modello. Stessa trappola di buildSkinnedMesh
                        // in 15-rig.js, dove il commento la racconta per esteso.
                        const count = indices.length - groupStart;
                        if (count === 0) return;
                        // FrontSide, non DoubleSide: il culling per-parte (voxelSet qui
                        // sopra e' costruito PER PARTE, apposta) lascia le facce sul
                        // confine fra due parti, e le due parti ne emettono una ciascuna
                        // nello stesso piano. Con DoubleSide sono z-fighting; col
                        // backface culling ognuna si vede solo dal suo lato.
                        const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.25, side: THREE.FrontSide });
                        mat.name = hexColor;
                        materials.push(mat);
                        geom.addGroup(groupStart, count, materials.length - 1);
                    });

                    if (indices.length === 0) return;

                    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
                    geom.setIndex(indices);
                    
                    const mesh = new THREE.Mesh(geom, materials);
                    mesh.name = partName;
                    group.add(mesh);
                });

                return group;
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
                    // La MESH si esporta a riposo, la POSA viaggia sui nodi delle ossa.
                    // Prima si azzerava la posa e il personaggio usciva in T-pose anche
                    // se nell'editor era in piedi con le braccia lungo i fianchi: la
                    // posa salvata (upperArm_R a -64 gradi, gambe in appoggio) veniva
                    // buttata via. Non si puo' pero' cuocere la posa nei vertici: le
                    // inverse bind matrices sono calcolate a riposo da bind(), e una
                    // geometria gia' posata contro quelle uscirebbe deformata due volte.
                    // Quindi: costruisci a riposo -> bind -> applica la posa ai nodi.
                    // E' anche cio' che si aspetta Blender, che la mostra come Pose.
                    const o = exportOrigin(currentModelData.voxels || []);
                    const K = doScale ? 0.01 : 1;
                    const temp = buildFullSkinnedMesh({
                        allFaces: !exportCullInternal(),
                        bake: { origin: o, scale: K }
                    });
                    if (!temp) { alert(t('export.glb.rigFailed')); return; }

                    const outMesh = temp.mesh;
                    outMesh.name = name;
                    // Le traslazioni di posa sono in unita' voxel: qui le ossa sono
                    // cotte a scala K, quindi vanno riscalate (le rotazioni no).
                    applyPoseToBoneList(temp.bones, K);
                    temp.skeleton.update();
                    outMesh.updateMatrixWorld(true);

                    // Colori: il colore deve viaggiare SOLO sul materiale.
                    // La geometria riggata porta sempre un attributo `color` (serve
                    // all'anteprima per weight paint e colori per osso), e il
                    // GLTFExporter r128 lo scrive in COLOR_0 GUARDANDO LA GEOMETRIA,
                    // non `material.vertexColors` (nel sorgente c'e' ancora il TODO
                    // upstream "@QUESTION Detect if .vertexColors = true?"). In glTF il
                    // colore finale e' baseColorFactor * COLOR_0: con lo stesso valore
                    // su entrambi si ottiene il colore lineare AL QUADRATO, cioe' il
                    // modello quasi nero. Verificato sul file esportato: l'unico
                    // materiale corretto era #FFFFFF, perche' per il bianco l'exporter
                    // omette baseColorFactor. Quindi COLOR_0 va tolto, non convertito.
                    outMesh.geometry.deleteAttribute('color');

                    (Array.isArray(outMesh.material) ? outMesh.material : [outMesh.material])
                        .forEach(m => {
                            m.metalness = 0.25;
                            if (m.userData && m.userData.hexColor) {
                                m.color.set(m.userData.hexColor).convertSRGBToLinear();
                                m.name = m.userData.hexColor;
                            }
                            m.vertexColors = false;
                            // Guscio chiuso con normali verso l'esterno: il backface
                            // culling e' corretto e fa da seconda difesa: se una faccia
                            // interna resta (modello PIENO, dove le facce fra cubi
                            // adiacenti sono volute), la sua gemella rivolta dall'altra
                            // parte non viene disegnata e non c'e' z-fighting.
                            m.side = THREE.FrontSide;
                        });

                    // Le rotazioni sui nodi da sole NON bastano: all'import Blender
                    // assegna d'ufficio la PRIMA action del file, e le sue tracce
                    // sovrascrivono la posa su ogni osso che animano. Misurato: con
                    // 'idle' per prima le braccia tornavano in T-pose (upperArm_R da
                    // -62.6 gradi a 0) mentre le gambe, che idle non tocca, restavano
                    // posate. Per questo la posa dell'editor esce come prima clip:
                    // e' quella che Blender applica all'apertura, e resta comunque
                    // selezionabile e cancellabile come tutte le altre.
                    const clips = scaleClipsForExport(rigClips, K, temp.bones);
                    const poseClip = buildPoseClip(temp.bones, t('export.glb.poseClip'));
                    animations = poseClip ? [poseClip].concat(clips) : clips;
                    exportRoot = outMesh;
                    restore = () => {
                        // La mesh d'export e' usa e getta: la posa dell'editor non e'
                        // mai stata toccata, quindi qui si libera solo la temporanea.
                        outMesh.geometry.dispose();
                        (Array.isArray(outMesh.material) ? outMesh.material : [outMesh.material])
                            .forEach(m => m.dispose());
                    };
                } else {
                    // Statico: la scala e' cotta nei vertici (vedi buildStaticExportMesh),
                    // non messa sul Group. Un Group scalato diventa un Empty in Blender e
                    // le mesh figlie ereditano scala 0.01: "applica trasformazioni" a mano
                    // a ogni import. Cotta, ogni parte esce a 0,0,0 con scala 1.
                    exportRoot = buildStaticExportMesh(doScale ? 0.01 : 1);
                    exportRoot.name = name;
                    exportRoot.updateMatrixWorld(true);
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
