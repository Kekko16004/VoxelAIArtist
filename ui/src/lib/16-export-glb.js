            const CUBE_FACES = [
                { n: [1, 0, 0], v: [[.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5], [.5, -.5, .5]] },
                { n: [-1, 0, 0], v: [[-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5], [-.5, -.5, -.5]] },
                { n: [0, 1, 0], v: [[-.5, .5, -.5], [-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5]] },
                { n: [0, -1, 0], v: [[-.5, -.5, .5], [-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5]] },
                { n: [0, 0, 1], v: [[.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5], [-.5, -.5, .5]] },
                { n: [0, 0, -1], v: [[-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5], [.5, -.5, -.5]] }
            ];
            // Il quadrato UV di UNA faccia. CUBE_FACES elenca i 4 angoli con winding
            // coerente su tutte e 6 le facce, quindi lo stesso quadrato vale per
            // ognuna: e' esattamente "la stessa texture su tutte e 6 le facce", senza
            // bisogno di una geometria diversa. (buildSkinnedMesh in 15-rig.js ha la
            // sua copia locale, UV_QUAD, per lo stesso motivo per cui ha una copia
            // locale di CUBE_FACES: quel modulo si carica anche da solo nei test.)
            const UV_UNIT = [[0, 0], [0, 1], [1, 1], [1, 0]];

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

            // --- materiali d'export ---------------------------------------------------
            // NON si riusa `threeMaterialFor` (36-materials.js): quella e' la fabbrica
            // del VISORE e tiene una cache condivisa con la scena viva, mentre questi
            // materiali sono usa e getta e vengono distrutti da `restore()` a fine
            // export -- disporre un materiale della cache (o la sua texture) spegnerebbe
            // il modello a schermo. E i valori sono comunque altri: colore convertito in
            // lineare, `side: THREE.FrontSide` (vedi i commenti sul culling) e i default
            // 0.35/0.25 dell'export invece di quelli dell'anteprima.
            //
            // Le texture nascono da una data URL, quindi si decodificano in modo
            // ASINCRONO. Il GLTFExporter r128 incorpora l'immagine disegnandola su un
            // canvas dimensionato su image.width: chiamato prima del decode scrive un
            // canvas 0x0, cioe' una texture VUOTA. Ogni texture registra qui la sua
            // promessa e `exportGLB` aspetta prima di chiamare l'exporter.
            let exportTexturePending = [];
            // I materiali d'export a cui e' stata attaccata una texture. Si tiene la
            // lista invece di ri-attraversare la scena: il root dell'export riggato e'
            // una SkinnedMesh e quello statico un Group, quindi un traverse dovrebbe
            // sapere di che forma e' l'albero. Qui i materiali sono nostri per
            // costruzione, li abbiamo appena creati.
            let exportTexturedMaterials = [];

            // Carica una texture d'export da una ref {data,w,h,alpha}. `name` finisce
            // nel GLB per ritrovarla. Stessa pipeline asincrona di prima.
            function exportTextureFromRef(texRef, name) {
                if (!texRef || !texRef.data) return null;
                let settle;
                exportTexturePending.push(new Promise(res => { settle = res; }));
                // Anche l'errore risolve: un'immagine illeggibile non deve appendere
                // l'export per sempre, il GLB esce senza quella texture. Ma va anche
                // MARCATA: risolvere e basta lascia `tex.image` undefined, e a quel
                // punto il GLTFExporter r128 solleva mentre disegna sul canvas, dentro
                // un .then() senza .catch(). Misurato: zero download, zero dispose,
                // `restore()` mai eseguito e nessun errore all'utente - l'export
                // spariva in silenzio. Vedi dropFailedExportTextures.
                const tex = new THREE.TextureLoader().load(texRef.data, settle, undefined, () => {
                    tex.userData.exportFailed = true;
                    settle();
                });
                // Voxel art: nessuna interpolazione fra i pixel.
                tex.magFilter = THREE.NearestFilter;
                tex.minFilter = THREE.NearestFilter;
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.name = name || 'tex';
                return tex;
            }

            function exportTextureFor(def, faceKey) {
                if (!def) return null;
                const texRef = (faceKey && typeof textureForFace === 'function')
                    ? textureForFace(def, faceKey)
                    : (def.texture || null);
                if (!texRef || !texRef.data) return null;
                const name = faceKey ? ('tex_' + def.id + '_' + faceKey) : ('tex_' + def.id);
                return exportTextureFromRef(texRef, name);
            }

            // Decora un materiale (statico o riggato) col contenuto del token.
            // `fallbackColor` e' il colore PROPRIO del voxel: senza di lui un id
            // materiale orfano (file aperto senza le sue definizioni) uscirebbe grigio
            // neutro invece che nella sua tinta piatta.
            // `faceKey` (px/nx/...) seleziona la texture di una faccia su un
            // materiale a 6 facce; assente, usa la texture unica.
            function applyExportMaterial(m, token, fallbackColor, faceKey) {
                const dec = decodeToken(token, fallbackColor);
                // materialById, non `dec.material`: su un id orfano l'id resta
                // valorizzato di proposito ma la definizione non esiste.
                const def = materialById(dec.material);
                m.color = new THREE.Color(dec.color).convertSRGBToLinear();
                m.roughness = def ? def.roughness : 0.35;
                m.metalness = def ? def.metalness : 0.25;
                // FrontSide, non DoubleSide: il culling per-parte (statico) e la regola
                // di `deformsAlike` (riggato) lasciano di proposito due facce coplanari
                // sul confine, una per lato. Col backface culling ognuna si vede solo
                // dal suo lato; con DoubleSide sono z-fighting. Vale anche coi materiali
                // texturizzati: la texture non cambia da che parte guarda una faccia.
                m.side = THREE.FrontSide;
                if (def && def.emissive > 0) {
                    // In glTF emissiveFactor = colore x intensita'.
                    m.emissive = new THREE.Color(dec.color).convertSRGBToLinear();
                    m.emissiveIntensity = def.emissive;
                }
                // Trasparenza. In glTF si traduce in alphaMode: BLEND per l'opacita'
                // (il GLTFExporter la scrive da `transparent` + il quarto canale di
                // baseColorFactor) e MASK per il taglio secco (da `alphaTest`, che
                // diventa alphaCutoff).
                //
                // I due non si sommano, ed e' la stessa trappola del visore:
                // alphaTest confronta l'alpha FINALE, cioe' opacity per l'alpha del
                // texel, quindi con opacity 0.4 e soglia 0.5 spariscono anche i pixel
                // pieni. A opacita' piena si usa il taglio, sotto la fusione.
                const faceTex = (faceKey && def && typeof textureForFace === 'function')
                    ? textureForFace(def, faceKey)
                    : (def && def.texture);
                if (def && def.opacity < 1) {
                    m.transparent = true;
                    m.opacity = def.opacity;
                } else if (faceTex && faceTex.alpha) {
                    m.transparent = true;
                    m.alphaTest = 0.5;
                }
                const tex = exportTextureFor(def, faceKey || null);
                if (tex) {
                    m.map = tex;
                    // Le UV del materiale valgono anche in export: il greedy mesher
                    // emette UV 0..N (una ripetizione per voxel), e repeat le
                    // moltiplica esattamente come a schermo. Senza, la stessa texture
                    // uscirebbe mappata in modo diverso da come si vede nel visore --
                    // che e' il difetto per cui non si capisce se il problema e' la
                    // mappatura o l'immagine.
                    if (typeof applyUvToTexture === 'function') applyUvToTexture(tex, def.uv);
                    // In glTF il colore finale e' baseColorFactor * texture: il fattore
                    // deve restare BIANCO, altrimenti la tinta si moltiplica due volte
                    // (stessa trappola dell'invariante 6 sul COLOR_0, vedi CLAUDE.md).
                    m.color = new THREE.Color(0xffffff);
                    // Se la texture non si decodifica il bianco va disfatto, o il
                    // modello esce slavato: qui teniamo la tinta vera da rimettere.
                    m.userData.exportBaseColor = dec.color;
                    exportTexturedMaterials.push(m);
                }
                m.name = faceKey ? (token + '_' + faceKey) : token;
                return m;
            }

            // Stacca le texture che non si sono decodificate. Senza `image` il
            // GLTFExporter r128 le disegna su un canvas dimensionato su `image.width`
            // e SOLLEVA, dentro una catena di promise senza .catch: l'export moriva
            // muto. Meglio un GLB a tinte piatte che nessun GLB.
            // Ritorna quante ne ha scartate, cosi' il chiamante puo' avvisare.
            function dropFailedExportTextures(mats) {
                let dropped = 0;
                (mats || []).forEach(m => {
                    if (!m || !m.map || !m.map.userData || !m.map.userData.exportFailed) return;
                    if (m.map.dispose) m.map.dispose();
                    m.map = null;
                    if (m.userData && m.userData.exportBaseColor) {
                        m.color = new THREE.Color(m.userData.exportBaseColor).convertSRGBToLinear();
                    }
                    dropped++;
                });
                return dropped;
            }

            function disposeExportMaterial(m) {
                if (!m) return;
                // La texture e' stata creata QUI (mai presa dalla cache del visore),
                // quindi si puo' disporre senza spegnere niente a schermo.
                if (m.map && m.map.dispose) m.map.dispose();
                if (m.dispose) m.dispose();
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
                    // Per TOKEN, non per colore: due voxel dello stesso colore con
                    // materiali diversi vogliono due materiali glTF distinti (uno con
                    // la texture, uno senza). Raggruppando per colore il secondo
                    // erediterebbe il materiale del primo.
                    const byColor = {};
                    // Il colore PROPRIO del primo voxel di ogni gruppo: e' il solo
                    // fallback disponibile per un token materiale orfano, perche' il
                    // token ha gia' buttato via l'hex del voxel.
                    const fallbackOf = {};
                    partData.voxels.forEach(v => {
                        const tok = tokenOf(v);
                        if (!byColor[tok]) { byColor[tok] = []; fallbackOf[tok] = v.color; }
                        byColor[tok].push(v);
                    });

                    const materials = [];
                    const positions = [], normals = [], uvs = [], indices = []; let vbase = 0;
                    const geom = new THREE.BufferGeometry();

                    Object.keys(byColor).forEach((token) => {
                        // Materiale a 6 facce: un gruppo (e un materiale) PER
                        // direzione, altrimenti le 6 texture non si possono
                        // assegnare. Ordine = CUBE_FACES = MATERIAL_FACE_KEYS.
                        const def = isMaterialToken(token)
                            ? materialById(token.slice(1)) : null;
                        const multi = def && typeof materialHasFaceTextures === 'function'
                            && materialHasFaceTextures(def);
                        const faceKeys = (typeof MATERIAL_FACE_KEYS !== 'undefined')
                            ? MATERIAL_FACE_KEYS
                            : ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

                        if (multi) {
                            CUBE_FACES.forEach((f, fi) => {
                                const groupStart = indices.length;
                                byColor[token].forEach(v => {
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
                                        uvs.push(UV_UNIT[k][0], UV_UNIT[k][1]);
                                    }
                                    indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3); vbase += 4;
                                });
                                const count = indices.length - groupStart;
                                if (count === 0) return;
                                const mat = applyExportMaterial(new THREE.MeshStandardMaterial({}),
                                    token, fallbackOf[token], faceKeys[fi]);
                                materials.push(mat);
                                geom.addGroup(groupStart, count, materials.length - 1);
                            });
                            return;
                        }

                        const groupStart = indices.length;
                        byColor[token].forEach(v => {
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
                                    uvs.push(UV_UNIT[k][0], UV_UNIT[k][1]);
                                }
                                indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3); vbase += 4;
                            });
                        });
                        // Niente gruppo (ne' materiale) per un token che non ha
                        // prodotto facce: qui capita a chi sta tutto dentro un'altra
                        // parte. Un gruppo con count 0 fa scrivere al GLTFExporter r128
                        // una primitiva SENZA `indices`, che per la specifica glTF si
                        // disegna prendendo i vertici in sequenza — cioe' l'intera mesh
                        // letta a triple arbitrarie, un groviglio di triangoli che
                        // attraversano il modello. Stessa trappola di buildSkinnedMesh
                        // in 15-rig.js, dove il commento la racconta per esteso.
                        const count = indices.length - groupStart;
                        if (count === 0) return;
                        const mat = applyExportMaterial(new THREE.MeshStandardMaterial({}),
                            token, fallbackOf[token]);
                        materials.push(mat);
                        geom.addGroup(groupStart, count, materials.length - 1);
                    });

                    if (indices.length === 0) return;

                    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
                    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
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
                // Un export interrotto a meta' potrebbe aver lasciato promesse appese:
                // ogni giro riparte da zero.
                exportTexturePending.length = 0;

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
                            // Il token e' stato messo in userData da buildSkinnedMesh
                            // (il gruppo e' per token, non per colore) e `hexColor` e'
                            // il colore VERO del gruppo: serve da fallback se il token
                            // e' un materiale orfano. Da qui arrivano anche texture,
                            // ruvidita', metallicita', emissione e FrontSide.
                            // `userData.face` (px/nx/...) c'e' solo sui gruppi multi-face
                            // (faceMode:'six'): senza, applyExportMaterial usa la texture
                            // unica come prima.
                            applyExportMaterial(m, (m.userData && m.userData.token) || (m.userData && m.userData.hexColor),
                                m.userData && m.userData.hexColor,
                                m.userData && m.userData.face);
                            // L'anteprima disegna i colori dai vertici; in export il
                            // colore viaggia solo sul materiale (vedi il commento sul
                            // COLOR_0 qui sopra).
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
                            .forEach(disposeExportMaterial);
                    };
                } else {
                    // Statico: la scala e' cotta nei vertici (vedi buildStaticExportMesh),
                    // non messa sul Group. Un Group scalato diventa un Empty in Blender e
                    // le mesh figlie ereditano scala 0.01: "applica trasformazioni" a mano
                    // a ogni import. Cotta, ogni parte esce a 0,0,0 con scala 1.
                    exportRoot = buildStaticExportMesh(doScale ? 0.01 : 1);
                    exportRoot.name = name;
                    exportRoot.updateMatrixWorld(true);
                    restore = () => {
                        // Anche qui i materiali (e le loro texture) sono nati per
                        // l'export e non li usa nessun altro: si liberano.
                        exportRoot.children.forEach(mesh => {
                            if (mesh.geometry) mesh.geometry.dispose();
                            (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
                                .forEach(disposeExportMaterial);
                        });
                    };
                }

                // Le texture arrivano da una data URL e si decodificano in modo
                // asincrono: il GLTFExporter r128 incorpora l'immagine disegnandola su
                // un canvas dimensionato su image.width, quindi chiamato prima del
                // decode scriverebbe un canvas 0x0 (texture vuota nel GLB). Si aspetta.
                // Senza texture la lista e' vuota e Promise.all risolve subito, ma
                // resta comunque un tick asincrono: nessun percorso dell'export dipende
                // dal fatto che parse() sia sincrono.
                //
                // La lista si azzera QUI e non a fine export: e' `applyExportMaterial`
                // a riempirla mentre si costruisce il modello, quindi svuotarla dopo
                // butterebbe via le promesse dell'export in corso. Cosi' un export non
                // eredita le texture del precedente, ne' aspetta le sue.
                const pending = exportTexturePending;
                const textured = exportTexturedMaterials;
                exportTexturePending = [];
                exportTexturedMaterials = [];
                // Qualunque cosa vada storta da qui in poi deve comunque rimettere in
                // piedi la scena e liberare i materiali usa e getta: senza questo
                // `restore()` il modello resta invisibile a schermo dopo un export
                // riggato fallito, e le texture d'export non vengono mai disposte.
                const finish = (err) => {
                    if (restore) restore();
                    if (err) {
                        console.error('[export GLB]', err);
                        alert(t('export.glb.failed'));
                    }
                };
                Promise.all(pending).then(() => {
                    const dropped = dropFailedExportTextures(textured);
                    const exporter = new THREE.GLTFExporter();
                    exporter.parse(exportRoot, (result) => {
                        const blob = new Blob([result], { type: 'model/gltf-binary' });
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = `${name}.glb`;
                        a.click();
                        URL.revokeObjectURL(a.href);
                        finish();
                        // Dopo il download: il file c'e', l'avviso spiega solo perche'
                        // e' a tinte piatte.
                        if (dropped) alert(t('export.glb.texturesDropped', { n: dropped }));
                    }, { binary: true, animations, onlyVisible: false });
                }).catch(finish);
            }
            document.getElementById('exportGlbBtn').addEventListener('click', exportGLB);
