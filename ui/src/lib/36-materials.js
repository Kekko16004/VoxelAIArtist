            // ===== MATERIALI CON TEXTURE =====
            // Frammento dello scope condiviso (vedi ui/build.mjs): nessun import/export.
            //
            // MODELLO DEI DATI. Un voxel ha SEMPRE `color` e FACOLTATIVAMENTE `material`
            // (l'id di una voce di metadata.materials). Il colore di un voxel texturizzato
            // e' la tinta media della sua texture: cosi' ogni percorso che pretende un hex
            // (.vox, .schem, le swatch, l'OBJ senza texture) continua a funzionare senza
            // sapere che i materiali esistono, e un id ORFANO degrada da solo a tinta
            // unita. E' il "materiale neutro" richiesto, ottenuto senza un ramo dedicato.
            //
            // TOKEN. Dentro voxelMap si usa una stringa sola: '#RRGGBB' per un colore,
            // '@m1' per un materiale. Serve a tenere invariati i confronti sparsi per
            // l'editor che trattano quel valore come stringa opaca.

            const MATERIAL_LIB_KEY = 'voxelai-material-library';
            const MATERIAL_LIB_MAX = 40;
            const MATERIAL_TEXTURE_MAX = 128;
            const MATERIAL_FALLBACK_COLOR = '#CCCCCC';

            let activeMaterialId = null;

            function materialsOfProject() {
                if (!currentModelData) return [];
                if (!currentModelData.metadata) currentModelData.metadata = {};
                if (!Array.isArray(currentModelData.metadata.materials)) {
                    currentModelData.metadata.materials = [];
                }
                return currentModelData.metadata.materials;
            }

            function materialById(id) {
                if (!id) return null;
                const list = materialsOfProject();
                for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
                return null;
            }

            // Primo intero LIBERO, non ultimo+1: dopo aver cancellato m2 il prossimo
            // materiale riempie il buco invece di far crescere i numeri all'infinito.
            function nextMaterialId(existingIds) {
                const taken = new Set(existingIds || []);
                let n = 1;
                while (taken.has('m' + n)) n++;
                return 'm' + n;
            }

            function normalizeMaterial(def, id) {
                const clamp01 = (v, dflt) => {
                    const n = Number(v);
                    if (!isFinite(n)) return dflt;
                    return Math.min(1, Math.max(0, n));
                };
                return {
                    id: id,
                    name: (def && def.name) ? String(def.name) : id,
                    texture: (def && def.texture && def.texture.data) ? {
                        data: def.texture.data,
                        w: Number(def.texture.w) || 0,
                        h: Number(def.texture.h) || 0
                    } : null,
                    color: (def && typeof def.color === 'string' && def.color[0] === '#')
                        ? def.color.toUpperCase() : MATERIAL_FALLBACK_COLOR,
                    roughness: clamp01(def && def.roughness, 0.6),
                    metalness: clamp01(def && def.metalness, 0),
                    emissive: clamp01(def && def.emissive, 0)
                };
            }

            function addMaterial(def) {
                const list = materialsOfProject();
                const id = (def && def.id && !materialById(def.id))
                    ? def.id
                    : nextMaterialId(list.map(m => m.id));
                const mat = normalizeMaterial(def, id);
                list.push(mat);
                return mat;
            }

            function removeMaterial(id) {
                const list = materialsOfProject();
                for (let i = 0; i < list.length; i++) {
                    if (list[i].id === id) {
                        list.splice(i, 1);
                        if (activeMaterialId === id) activeMaterialId = null;
                        return true;
                    }
                }
                return false;
            }

            function isMaterialToken(tok) {
                return typeof tok === 'string' && tok.charAt(0) === '@';
            }

            function tokenOf(v) {
                if (!v) return MATERIAL_FALLBACK_COLOR;
                if (v.material) return '@' + v.material;
                return (v.color || MATERIAL_FALLBACK_COLOR).toUpperCase();
            }

            // Ritorna SEMPRE un colore valido. Un token materiale il cui id non esiste
            // piu' (file importato senza le sue definizioni) diventa tinta unita neutra.
            function decodeToken(tok) {
                if (isMaterialToken(tok)) {
                    const id = tok.slice(1);
                    const mat = materialById(id);
                    if (!mat) return { color: MATERIAL_FALLBACK_COLOR, material: null };
                    return { color: mat.color, material: id };
                }
                const c = (typeof tok === 'string' && tok.charAt(0) === '#')
                    ? tok.toUpperCase() : MATERIAL_FALLBACK_COLOR;
                return { color: c, material: null };
            }

            // Tinta media di una texture, da usare come `color` del materiale.
            // I pixel trasparenti sono SALTATI: sono assenza di colore, non nero, e
            // includerli scurirebbe ogni texture con bordo o buco trasparente.
            function averageColorFromPixels(data) {
                let r = 0, g = 0, b = 0, n = 0;
                for (let i = 0; i + 3 < data.length; i += 4) {
                    const a = data[i + 3];
                    if (a === 0) continue;
                    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
                }
                if (n === 0) return MATERIAL_FALLBACK_COLOR;
                const hx = v => Math.round(v / n).toString(16).toUpperCase().padStart(2, '0');
                return '#' + hx(r) + hx(g) + hx(b);
            }

            function getActiveMaterialId() { return activeMaterialId; }

            function setActiveMaterial(id) {
                activeMaterialId = id || null;
            }
