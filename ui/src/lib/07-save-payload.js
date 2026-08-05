            // ===== I MATERIALI NEL FORMATO COMPATTO =====
            // Le ops sanno esprimere SOLO colori (palette -> hex): in una op non c'e'
            // nessun posto dove mettere un materiale. Allargare la loro semantica
            // vorrebbe dire una modifica ACCOPPIATA a expand_ops (src/parser.py) e a
            // expandOps (ui/src/utils/expand-ops.js), cioe' il punto piu' sorvegliato
            // del repo (tests/ops_parity_cases.json), e romperebbe il generatore AI, che
            // di materiali non sa nulla. Scrivere palette['a'] = '@m1' non e' una via
            // d'uscita: entrambi gli espansori risolverebbero quella chiave a #CCCCCC.
            //
            // Quindi i materiali viaggiano a parte, dentro il metadata, nella STESSA
            // forma di una op `set` (id + triplette), e si riversano sui voxel DOPO
            // l'espansione (applyMaterialMap). Il contratto ops resta intatto byte per
            // byte, e un file di materiali aperto da una versione che non li conosce
            // resta un modello valido a tinte piatte.
            function buildMaterialMap(voxels) {
                // Prima per CELLA, non direttamente per id: sulla stessa cella un voxel
                // visibile deve vincere su uno nascosto, in qualunque ordine arrivino.
                const byKey = new Map();
                const solid = new Set();
                (voxels || []).forEach(v => {
                    if (!v || !v.material) return;
                    const k = v.x + ',' + v.y + ',' + v.z;
                    // Un voxel NASCOSTO conserva il suo materiale: nel ramo piatto di
                    // buildObjectPayload finisce comunque nelle ops, quindi scartarlo qui
                    // gli farebbe perdere la texture al primo salvataggio. Nel ramo con
                    // le parti il nascosto non viene salvato e la sua tripletta resta
                    // senza destinatario: applyMaterialMap assegna solo ai voxel che
                    // esistono davvero, quindi e' innocua.
                    if (v._hidden) {
                        if (!solid.has(k)) byKey.set(k, v.material);
                        return;
                    }
                    solid.add(k);
                    byKey.set(k, v.material);
                });
                const byId = new Map();
                byKey.forEach((id, k) => {
                    let arr = byId.get(id);
                    if (!arr) { arr = []; byId.set(id, arr); }
                    const p = k.split(',');
                    arr.push(Number(p[0]), Number(p[1]), Number(p[2]));
                });
                const out = [];
                byId.forEach((coords, id) => out.push([id].concat(coords)));
                return out;
            }

            // Ripassa le definizioni ARRIVATE da un file. Un .voxelai salvato da qui le
            // ha gia' normalizzate, ma un JSON scritto a mano (o prodotto da un altro
            // strumento) puo' portare un hex storto o un roughness null: decodeToken
            // restituisce `mat.color` cosi' com'e', quindi il valore finirebbe dentro
            // THREE.Color lontanissimo da qui. Gli id DUPLICATI vengono scartati (vince
            // il primo), o materialById risolverebbe l'uno mentre il pannello mostra
            // l'altro; quelli senza id sono irraggiungibili e se ne vanno.
            function normalizeProjectMaterials(meta) {
                if (!meta || !Array.isArray(meta.materials)) return;
                if (typeof normalizeMaterial !== 'function') return;
                const seen = new Set();
                const clean = [];
                meta.materials.forEach(def => {
                    const id = (def && typeof def.id === 'string') ? def.id : '';
                    if (!id || seen.has(id)) return;
                    seen.add(id);
                    clean.push(normalizeMaterial(def, id));
                });
                meta.materials = clean;
            }

            // Riversa metadata.material_map sui voxel GIA' espansi, in loco. Va chiamata
            // su OGNI via d'ingresso (vedi 04-objects.js): expandOps non sa nulla di
            // materiali e non deve impararlo.
            //
            // Un id privo di definizione NON viene applicato: il voxel resta a tinta
            // unita, che e' il comportamento richiesto per i file importati senza
            // texture. Non c'e' nessun ramo "se non ci sono texture": e' l'ASSENZA della
            // definizione a produrlo. Qui e' diverso da decodeToken, che sull'orfano
            // CONSERVA l'id: la' l'orfano e' un problema d'ordine transitorio (materiali
            // caricati dopo i voxel), qui il file e' completo per definizione, quindi un
            // id sconosciuto e' spazzatura che sporcherebbe il prossimo salvataggio.
            //
            // NIENTE materialById in questa funzione: quando gira, currentModelData
            // punta ancora al progetto PRECEDENTE (loadSceneFromParsed espande prima di
            // creare gli oggetti), quindi le sole definizioni valide sono quelle di
            // `data`. Per lo stesso motivo non si passa da addMaterial: le definizioni
            // sono gia' un elenco completo con i propri id, e addMaterial rimapperebbe
            // in silenzio un id gia' preso legando i voxel al materiale sbagliato.
            function applyMaterialMap(data) {
                if (!data || !data.metadata) return data;
                normalizeProjectMaterials(data.metadata);
                const map = data.metadata.material_map;
                if (!Array.isArray(map) || !Array.isArray(data.voxels)) return data;
                const known = new Set((data.metadata.materials || []).map(m => m && m.id));
                const byKey = new Map();
                map.forEach(entry => {
                    if (!Array.isArray(entry) || entry.length < 4) return;
                    const id = entry[0];
                    if (!known.has(id)) return;
                    for (let i = 1; i + 2 < entry.length; i += 3) {
                        byKey.set(entry[i] + ',' + entry[i + 1] + ',' + entry[i + 2], id);
                    }
                });
                if (byKey.size === 0) return data;
                data.voxels.forEach(v => {
                    const id = byKey.get(v.x + ',' + v.y + ',' + v.z);
                    if (id) v.material = id;
                });
                return data;
            }

            // Aggiunge definizioni e mappa al metadata SOLO se ce ne sono: un progetto
            // senza materiali continua a produrre file identici a prima.
            //
            // `opts.materials === false` le OMETTE. Serve alla richiesta di MODIFICA
            // all'AI, che spedisce il modello corrente dentro il prompt: una texture e'
            // base64 fino a 128x128, cioe' decine di KB, e all'AI non serve (risponde
            // con un diff di ops). Infilarcele costerebbe piu' del modello intero.
            function withMaterials(out, meta, voxels, opts) {
                if (opts && opts.materials === false) return out;
                const defs = (meta && Array.isArray(meta.materials)) ? meta.materials : [];
                const map = buildMaterialMap(voxels);
                if (defs.length) out.materials = defs;
                if (map.length) out.material_map = map;
                return out;
            }

            function buildObjectPayload(data, opts) {
                const meta = (data && data.metadata) || {};
                const voxels = (data && data.voxels) || [];

                const hasParts = voxels.some(v => v.part);

                if (hasParts) {
                    const existingParts = [...new Set(voxels.filter(v => v.part).map(v => v.part))];
                    const fallbackPartName = existingParts.length > 0 ? existingParts[0] : (meta.name || 'main');
                    const partGroups = {};
                    voxels.forEach(v => {
                        if (v._hidden) return;
                        const pName = v.part || fallbackPartName;
                        if (!partGroups[pName]) partGroups[pName] = {};
                        const c = v.color.toUpperCase();
                        if (!partGroups[pName][c]) partGroups[pName][c] = [];
                        partGroups[pName][c].push(v.x, v.y, v.z);
                    });

                    const palette = {};
                    let paletteIndex = 0;
                    const allColors = new Set();
                    for (const pName in partGroups) {
                        for (const c in partGroups[pName]) allColors.add(c);
                    }
                    const colorToKey = {};
                    allColors.forEach(c => {
                        let key;
                        if (paletteIndex < 26) key = String.fromCharCode(97 + paletteIndex);
                        else if (paletteIndex < 52) key = String.fromCharCode(65 + (paletteIndex - 26));
                        else key = 'c' + (paletteIndex - 52);
                        paletteIndex++;
                        palette[key] = c;
                        colorToKey[c] = key;
                    });

                    const parts = {};
                    for (const pName in partGroups) {
                        const ops = [];
                        for (const c in partGroups[pName]) {
                            ops.push(["set", colorToKey[c], ...partGroups[pName][c]]);
                        }
                        parts[pName] = ops;
                    }

                    return {
                        metadata: withMaterials({
                            name: meta.name || "voxel_model",
                            grid_size: meta.grid_size || [16, 16, 16]
                        }, meta, voxels, opts),
                        palette: palette,
                        parts: parts
                    };
                }

                const palette = {};
                const ops = [];
                const colorGroups = {};
                voxels.forEach(v => {
                    const c = v.color.toUpperCase();
                    if (!colorGroups[c]) colorGroups[c] = [];
                    colorGroups[c].push(v.x, v.y, v.z);
                });

                let paletteIndex = 0;
                for (const c in colorGroups) {
                    let key;
                    if (paletteIndex < 26) key = String.fromCharCode(97 + paletteIndex);
                    else if (paletteIndex < 52) key = String.fromCharCode(65 + (paletteIndex - 26));
                    else key = 'c' + (paletteIndex - 52);
                    paletteIndex++;
                    palette[key] = c;
                    ops.push(["set", key, ...colorGroups[c]]);
                }

                return {
                    metadata: withMaterials({
                        name: meta.name || "voxel_model",
                        grid_size: meta.grid_size || [16, 16, 16]
                    }, meta, voxels, opts),
                    palette: palette,
                    ops: ops
                };
            }

            // Legacy single-object payload for the ACTIVE object. Kept for the AI
            // 'modify' request (which expects a single model) and as the save base.
            // `opts` arriva fino a withMaterials: la richiesta all'AI passa
            // { materials: false } perche' le texture base64 non stanno in un prompt.
            function getSavePayload(opts) {
                if (typeof stashRigToActiveObject === 'function') stashRigToActiveObject();
                const out = buildObjectPayload(currentModelData, opts);
                const r = (typeof serializeRig === 'function') ? serializeRig(rig) : null;
                if (r) out.rig = r;
                return out;
            }

            // Scene-aware save payload. One object -> legacy flat/compact format
            // (fully backward compatible). Multiple objects -> extended { objects:[...] }.
            function getSceneSavePayload() {
                // Il rig vive su obj.rig: quello dell'oggetto attivo va parcheggiato prima
                // di leggerlo, altrimenti si salverebbe la versione precedente alle
                // ultime modifiche (posa, pesi dipinti).
                if (typeof stashRigToActiveObject === 'function') stashRigToActiveObject();
                if (sceneObjects.length <= 1) {
                    return getSavePayload();
                }
                const out = { objects: [] };
                const rigs = [];
                sceneObjects.forEach(o => {
                    const p = buildObjectPayload(o.data);
                    const objPayload = {
                        name: o.name,
                        transform: o.transform,
                        visible: o.visible,
                        metadata: p.metadata,
                        palette: p.palette
                    };
                    if (p.parts) objPayload.parts = p.parts;
                    if (p.ops) objPayload.ops = p.ops;
                    // Ogni oggetto porta il PROPRIO rig (scheletro, posa, pesi dipinti,
                    // animazioni AI). Prima esisteva un solo rig per file, quindi in una
                    // scena corpo + armatura uno dei due lo perdeva al salvataggio.
                    const r = (typeof serializeRig === 'function') ? serializeRig(o.rig) : null;
                    if (r) { objPayload.rig = r; rigs.push(r); }
                    out.objects.push(objPayload);
                });
                // Compatibilita': le versioni precedenti leggono solo `rig` di radice. Lo
                // duplichiamo SOLO se un unico oggetto e' riggato (caso normale): con due o
                // piu' rig non c'e' un "il" rig e duplicare raddoppierebbe i pesi salvati.
                if (rigs.length === 1) out.rig = rigs[0];
                return out;
            }

            document.getElementById('saveJsonBtn').addEventListener('click', () => {
                const name = ((currentModelData.metadata && currentModelData.metadata.name) || "voxel_model").replace(/\s+/g, '_');
                const out = getSceneSavePayload();
                const jsonStr = JSON.stringify(out);
                const obfuscated = btoa(unescape(encodeURIComponent(jsonStr)));
                downloadFile(obfuscated, `${name}.voxelai`, 'application/octet-stream');
            });

            document.getElementById('savePlainJsonBtn').addEventListener('click', () => {
                const name = ((currentModelData.metadata && currentModelData.metadata.name) || "voxel_model").replace(/\s+/g, '_');
                const out = getSceneSavePayload();
                const jsonStr = JSON.stringify(out, null, 2);
                downloadFile(jsonStr, `${name}.json`, 'application/json');
            });
