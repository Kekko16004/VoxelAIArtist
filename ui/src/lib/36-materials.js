            // ===== MATERIALI CON TEXTURE =====
            // Frammento dello scope condiviso (vedi ui/build.mjs): nessun import/export.
            //
            // MODELLO DEI DATI. Un voxel ha SEMPRE `color` e FACOLTATIVAMENTE `material`
            // (l'id di una voce di metadata.materials). Il colore di un voxel texturizzato
            // e' la tinta media della sua texture: cosi' ogni percorso che pretende un hex
            // (.vox, .schem, le swatch, l'OBJ senza texture) continua a funzionare senza
            // sapere che i materiali esistono, e un id ORFANO ricade sul colore del voxel.
            // E' il "materiale neutro" richiesto, ottenuto senza un ramo dedicato.
            //
            // TOKEN. Dentro voxelMap si usa una stringa sola: '#RRGGBB' per un colore,
            // '@m1' per un materiale. Serve a tenere invariati i confronti sparsi per
            // l'editor che trattano quel valore come stringa opaca.
            //
            // ORFANI: `decodeToken(tok, fallbackColor)` vuole il colore del voxel come
            // secondo argomento, e su un id che non esiste ricade su QUELLO, non su un
            // grigio fisso. Il token collassa il voxel a '@m1' e butta via il suo hex,
            // quindi e' il chiamante il solo a poterlo ancora fornire. L'id NON viene
            // azzerato: syncVoxelsFromMap (03-voxel-map.js) ricostruisce
            // currentModelData.voxels DAI valori della voxelMap, quindi azzerarlo
            // trasformerebbe un problema d'ordine transitorio (materiali caricati dopo i
            // voxel) in una perdita di dati definitiva su disco. Tenendolo, tokenOf e
            // decodeToken restano inverse anche sugli orfani, e appena le definizioni
            // arrivano il voxel si ricollega da se'.
            //
            // ID ESPLICITO: `addMaterial({id: 'm1', ...})` conserva l'id se e' libero
            // (serve al giro di ricarica del progetto: cambiarlo renderebbe orfani tutti
            // i voxel che lo citano). Se e' GIA' preso viene rimappato, e allora sta al
            // chiamante confrontare `mat.id !== def.id` e rimappare i suoi voxel: non
            // farlo li lega in silenzio al materiale preesistente, che e' peggio di un
            // orfano perche' non si vede.

            const MATERIAL_LIB_KEY = 'voxelai-material-library';
            const MATERIAL_LIB_MAX = 40;
            const MATERIAL_TEXTURE_MAX = 128;
            const MATERIAL_FALLBACK_COLOR = '#CCCCCC';
            // Un hex VERO, non "una stringa che inizia con #". Questo modulo e' il
            // punto di conversione unico di cui si fidano le swatch, .vox, .schem, l'MTL
            // e THREE.Color: '#', '#zz' o '#12345678' passati per buoni diventerebbero
            // un colore nero o un'eccezione lontana da qui. L'output di un LLM e'
            // esattamente il posto da cui aspettarsi un hex malformato.
            const MATERIAL_HEX_RE = /^#[0-9A-Fa-f]{6}$/;

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
                // null e '' vanno trattati come ASSENTI, non come zero: Number(null) e'
                // 0 e isFinite lo accetta, quindi senza questa riga un roughness
                // mancante in un JSON (dove l'assenza si scrive `null`) diventerebbe 0,
                // cioe' una superficie a specchio dove il contratto promette 0.6. Si
                // vedeva solo su roughness perche' e' l'unico default diverso da zero.
                const clamp01 = (v, dflt) => {
                    if (v === null || v === undefined || v === '') return dflt;
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
                    color: (def && typeof def.color === 'string' && MATERIAL_HEX_RE.test(def.color))
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

            // Ritorna SEMPRE un hex valido. `fallbackColor` e' il colore proprio del
            // voxel: su un token materiale il cui id non esiste piu' (file importato
            // senza le sue definizioni) si ricade su quello e il modello resta se
            // stesso a tinte piatte, invece di diventare grigio uniforme. L'id resta
            // nel risultato: vedi il commento in testa al modulo.
            function decodeToken(tok, fallbackColor) {
                const dflt = (typeof fallbackColor === 'string' && MATERIAL_HEX_RE.test(fallbackColor))
                    ? fallbackColor.toUpperCase() : MATERIAL_FALLBACK_COLOR;
                if (isMaterialToken(tok)) {
                    const id = tok.slice(1);
                    const mat = materialById(id);
                    if (!mat) return { color: dflt, material: id };
                    return { color: mat.color, material: id };
                }
                const c = (typeof tok === 'string' && MATERIAL_HEX_RE.test(tok))
                    ? tok.toUpperCase() : dflt;
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

            // Cosa si sta posando adesso. Unico punto da cui l'editing lo legge:
            // finche' passa da qui, la mutua esclusione non puo' essere aggirata.
            //
            // `materialById` e non il solo id: se la definizione e' stata cancellata
            // sotto i piedi, posare '@m9' creerebbe voxel orfani a tavolino invece
            // che per un incidente di caricamento.
            function activeToken() {
                if (activeMaterialId && materialById(activeMaterialId)) return '@' + activeMaterialId;
                return (typeof activeColorHex === 'string' && activeColorHex)
                    ? activeColorHex.toUpperCase() : MATERIAL_FALLBACK_COLOR;
            }

            // Evidenza sulla scheda del materiale attivo e colore "smorzato" quando un
            // materiale ha la precedenza. Smorzato con una classe, NON disabled: l'input
            // deve restare cliccabile, perche' cliccarlo e' proprio il modo per tornare
            // al colore.
            function refreshMaterialSelectionUI() {
                const panel = document.getElementById('materialsPanel');
                if (panel) {
                    panel.querySelectorAll('.material-card').forEach(el => {
                        el.classList.toggle('active', el.dataset.materialId === activeMaterialId);
                    });
                }
                const swatchRow = document.getElementById('activeColorRow');
                if (swatchRow) swatchRow.classList.toggle('muted-by-material', !!activeMaterialId);
                const label = document.getElementById('activeMaterialName');
                if (label) {
                    const def = activeMaterialId ? materialById(activeMaterialId) : null;
                    label.textContent = def ? def.name : '';
                }
            }

            // Contraltare della mutua esclusione che setActiveColor (11-symmetry-tools.js)
            // applica dall'altro lato: seleziona il materiale e riallinea l'interfaccia.
            // `activeColorHex` NON viene toccato di proposito -- il colore resta quello
            // che era, solo scavalcato da activeToken(). E' questo che rende il clic
            // sulla swatch del colore una via di ritorno funzionante invece di un valore
            // da reinventare.
            function setActiveMaterialAndSync(id) {
                setActiveMaterial(id);
                if (typeof refreshMaterialSelectionUI === 'function') refreshMaterialSelectionUI();
            }

            // --- import della texture --------------------------------------------

            // Il lato lungo comanda, l'altro segue in proporzione, minimo 1 pixel.
            // Una texture gia' piccola NON viene ingrandita: ingrandirla non aggiunge
            // dettaglio e gonfia il base64 dentro il .voxai.
            //
            // Il tetto MATERIAL_TEXTURE_MAX si applica QUI e non in normalizeMaterial:
            // lo store non puo' ridimensionare niente, potrebbe solo rifiutare o
            // troncare una definizione gia' scritta (cioe' buttare via dati
            // dell'utente). L'import e' il solo punto che ha i pixel in mano.
            function fitTextureSize(w, h, max) {
                const M = max || MATERIAL_TEXTURE_MAX;
                if (w <= M && h <= M) return { w: w, h: h };
                const k = M / Math.max(w, h);
                return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
            }

            // Legge un File immagine, lo ridimensiona su canvas e ne ricava la tinta
            // media dallo STESSO canvas (un secondo passaggio sull'originale non
            // aggiungerebbe precisione e costerebbe un'altra decodifica).
            //
            // Il messaggio dell'errore e' tecnico e NON va mostrato cosi' com'e':
            // chi chiama presenta la sua stringa da t(). Vedi il pannello materiali.
            function importTextureFile(file) {
                return new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(file);
                    const img = new Image();
                    img.onload = () => {
                        try {
                            const size = fitTextureSize(img.width, img.height, MATERIAL_TEXTURE_MAX);
                            const cv = document.createElement('canvas');
                            cv.width = size.w; cv.height = size.h;
                            const ctx = cv.getContext('2d');
                            // NearestFilter a valle: qui teniamo il ridimensionamento
                            // netto, altrimenti la voxel art esce sfocata gia' in origine.
                            ctx.imageSmoothingEnabled = false;
                            ctx.drawImage(img, 0, 0, size.w, size.h);
                            const px = ctx.getImageData(0, 0, size.w, size.h).data;
                            resolve({
                                data: cv.toDataURL('image/png'),
                                w: size.w, h: size.h,
                                color: averageColorFromPixels(px)
                            });
                        } catch (e) { reject(e); }
                        finally { URL.revokeObjectURL(url); }
                    };
                    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
                    img.src = url;
                });
            }

            // --- cache dei materiali THREE ---------------------------------------
            // Un MeshStandardMaterial per token, riusato da entrambi i percorsi di
            // rendering. Senza cache ogni pennellata ricreerebbe la texture (upload
            // sulla GPU a ogni tratto) invece di riusarla.
            let _materialCache = new Map();

            // QUANDO va chiamata (il contratto, altrimenti si vede una texture
            // vecchia): dopo aver modificato o eliminato un materiale, e a ogni
            // cambio di oggetto/progetto. La chiave contiene il token, non
            // l'identita' dell'oggetto: due oggetti diversi che usano '@m1' con
            // definizioni diverse si spartirebbero la prima istanza costruita.
            function clearMaterialCache() {
                _materialCache.forEach(m => {
                    if (m.map && m.map.dispose) m.map.dispose();
                    if (m.dispose) m.dispose();
                });
                _materialCache = new Map();
            }

            // `opts.color` e' il colore PROPRIO del voxel, usato solo quando il token
            // e' un materiale che non esiste (piu'). Serve perche' decodeToken senza
            // secondo argomento degrada al grigio neutro: un .voxai aperto senza le
            // sue definizioni uscirebbe tutto grigio invece che a tinte piatte.
            //
            // La CHIAVE di cache si costruisce sul colore RISOLTO (dec.color), non su
            // opts.color grezzo. Tre ragioni, tutte misurate:
            //   - opts.color e' arbitrario e non validato, quindi puo' contenere il
            //     separatore: threeMaterialFor('#AABBCC', {color: '#AABBCC|w'})
            //     produceva la stessa chiave della variante wireframe e restituiva un
            //     materiale WIREFRAME a chi ne chiedeva uno pieno;
            //   - su un materiale che esiste il fallback e' irrilevante per l'aspetto,
            //     quindi tenerlo nella chiave moltiplicava le istanze (una per tinta
            //     dei voxel) di un materiale visivamente identico;
            //   - dec.color e' gia' hex maiuscolo validato, quindi '#aabbcc' e
            //     '#AABBCC' non spaccano piu' la cache in due.
            // Sull'ORFANO dec.color vale il fallback, quindi resta la distinzione che
            // serve davvero: due orfani di colore diverso NON si spartiscono un
            // materiale (il primo vincerebbe per sempre).
            function threeMaterialFor(token, opts) {
                const wire = !!(opts && opts.wireframe);
                const dec = decodeToken(token, (opts && opts.color) || '');
                const key = token + '|' + dec.color + (wire ? '|w' : '');
                const hit = _materialCache.get(key);
                if (hit) return hit;

                // materialById, non `dec.material` : su un orfano l'id resta valorizzato
                // (e' voluto, vedi decodeToken) ma la definizione non c'e'.
                const def = materialById(dec.material);
                const mat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(dec.color),
                    roughness: def ? def.roughness : 0.2,
                    metalness: def ? def.metalness : 0.1,
                    wireframe: wire
                });
                if (def && def.emissive > 0) {
                    mat.emissive = new THREE.Color(dec.color);
                    mat.emissiveIntensity = def.emissive;
                }
                if (def && def.texture && def.texture.data) {
                    const tex = new THREE.TextureLoader().load(def.texture.data, () => {
                        if (typeof requestRender === 'function') requestRender();
                    });
                    // Voxel art: nessuna interpolazione, e una ripetizione per voxel
                    // (l'UV oltre 1 serve al greedy mesh dell'export).
                    tex.magFilter = THREE.NearestFilter;
                    tex.minFilter = THREE.NearestFilter;
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                    mat.map = tex;
                    // Col map, `color` moltiplica la texture: bianco = texture pura.
                    mat.color = new THREE.Color(0xffffff);
                }
                // `shared`: questo materiale e' CACHATO e vive in piu' mesh. Chi
                // distrugge un mesh (disposeMesh) deve saltarlo, altrimenti il primo
                // colore ripulito porta con se' la texture di tutti gli altri.
                // Liberarli e' compito di clearMaterialCache, l'unico proprietario.
                mat.userData.shared = true;
                _materialCache.set(key, mat);
                return mat;
            }
