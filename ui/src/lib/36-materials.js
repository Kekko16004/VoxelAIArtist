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

            // I materiali sono di PROGETTO, non del singolo oggetto. `currentModelData`
            // pero' e' l'oggetto ATTIVO (04-objects.js: `currentModelData = obj.data`),
            // quindi tenerli solo li' dentro li faceva sparire appena si creava o si
            // sceglieva un altro oggetto: misurato in GUI: crea materiale -> Shift+A ->
            // il pannello torna "Nessun materiale" e la primitiva nasce a tinta unita.
            // Qui la lista vive a livello di scena e ogni oggetto ci fa da ALIAS, cosi'
            // il salvataggio per-oggetto la scrive senza sapere che e' condivisa e il
            // caricamento la fonde invece di sostituirla.
            let sceneMaterials = [];

            // Da chiamare quando si azzera la scena (nuovo progetto / apertura file):
            // senza, i materiali del progetto precedente sopravvivono al successivo.
            function resetSceneMaterials() {
                sceneMaterials = [];
                activeMaterialId = null;
            }

            function materialsOfProject() {
                if (!currentModelData) return sceneMaterials;
                if (!currentModelData.metadata) currentModelData.metadata = {};
                const own = currentModelData.metadata.materials;
                if (Array.isArray(own) && own !== sceneMaterials) {
                    // Un oggetto appena caricato porta la SUA lista: si fonde per id.
                    // Non si sovrascrive l'id in collisione, perche' i voxel di questo
                    // oggetto lo citano gia': rimapparli qui e' fuori portata, e due
                    // definizioni con lo stesso id in uno stesso progetto vengono
                    // comunque dallo stesso salvataggio.
                    own.forEach(m => {
                        if (m && m.id && !sceneMaterials.some(x => x.id === m.id)) sceneMaterials.push(m);
                    });
                }
                currentModelData.metadata.materials = sceneMaterials;
                return sceneMaterials;
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

            // Mappatura UV: quante volte la texture si ripete su una faccia, da dove
            // comincia e di quanto e' ruotata. Sono i tre controlli che rispondono a
            // "la texture non e' mappata come voglio" senza rifare l'immagine.
            //
            // `repeat` non puo' essere 0: azzererebbe la matrice UV e la faccia
            // mostrerebbe un solo texel stirato (uno schermo di tinta piatta che
            // sembra una texture non caricata). Il minimo tiene una ripetizione
            // parziale, che e' l'effetto "zoom" che si vuole davvero.
            //
            // La rotazione e' quantizzata a 90 gradi: su una texture ai pixel netti
            // un angolo qualunque la interpola e la voxel art esce sfocata, e il
            // filtro NEAREST non basta a evitarlo (e' il campionamento ruotato a
            // cadere fra i texel).
            const MATERIAL_UV_DEFAULT = { repeat: 1, offsetU: 0, offsetV: 0, rotation: 0 };

            function normalizeUv(uv) {
                const num = (v, dflt, min, max) => {
                    if (v === null || v === undefined || v === '') return dflt;
                    const n = Number(v);
                    if (!isFinite(n)) return dflt;
                    return Math.min(max, Math.max(min, n));
                };
                const rot = num(uv && uv.rotation, 0, -3600, 3600);
                return {
                    repeat: num(uv && uv.repeat, 1, 0.05, 64),
                    offsetU: num(uv && uv.offsetU, 0, -16, 16),
                    offsetV: num(uv && uv.offsetV, 0, -16, 16),
                    // Il doppio modulo porta anche i negativi in 0..359.
                    rotation: ((Math.round(rot / 90) * 90) % 360 + 360) % 360
                };
            }

            // Ordine delle 6 facce = gruppi di BoxGeometry in Three.js r128
            // (+X, -X, +Y, -Y, +Z, -Z) e di CUBE_FACES in 16-export-glb.js.
            // I nomi brevi restano stabili nel JSON salvato.
            const MATERIAL_FACE_KEYS = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

            function normalizeTextureRef(tex) {
                if (!tex || !tex.data) return null;
                return {
                    data: tex.data,
                    w: Number(tex.w) || 0,
                    h: Number(tex.h) || 0,
                    // `alpha` dice se l'immagine ha pixel non completamente opachi.
                    // Si misura all'import (l'unico punto che ha i pixel in mano) e
                    // si porta appresso, perche' il rendering deve saperlo senza
                    // ridecodificare il PNG a ogni costruzione del materiale.
                    alpha: !!(tex.alpha)
                };
            }

            function normalizeFaces(faces) {
                if (!faces || typeof faces !== 'object') return null;
                const out = {};
                let any = false;
                MATERIAL_FACE_KEYS.forEach(k => {
                    const t = normalizeTextureRef(faces[k]);
                    if (t) { out[k] = t; any = true; }
                });
                return any ? out : null;
            }

            function materialHasFaceTextures(def) {
                return !!(def && def.faceMode === 'six' && def.faces);
            }

            // Texture di una faccia, con ricaduta sulla texture unica. Serve al
            // rendering e all'export: una faccia senza disegno proprio non deve
            // restare nera, ma riusare la rappresentativa.
            function textureForFace(def, faceKey) {
                if (!def) return null;
                if (materialHasFaceTextures(def) && def.faces[faceKey]) return def.faces[faceKey];
                return def.texture || null;
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
                const faces = normalizeFaces(def && def.faces);
                // faceMode 'six' solo se c'e' almeno una faccia con texture: altrimenti
                // un JSON corrotto o un salvataggio a meta' lascerebbe un materiale
                // "a 6 facce" senza immagini, e il rendering lo tratterebbe come
                // multi-materiale vuoto.
                const faceMode = (def && def.faceMode === 'six' && faces) ? 'six' : 'single';
                let texture = normalizeTextureRef(def && def.texture);
                // Senza texture rappresentativa ma con facce: la prima faccia dipinta
                // diventa la card, il colore medio e il fallback di export.
                if (!texture && faces) {
                    for (let i = 0; i < MATERIAL_FACE_KEYS.length; i++) {
                        if (faces[MATERIAL_FACE_KEYS[i]]) {
                            texture = faces[MATERIAL_FACE_KEYS[i]];
                            break;
                        }
                    }
                }
                return {
                    id: id,
                    name: (def && def.name) ? String(def.name) : id,
                    texture: texture,
                    faceMode: faceMode,
                    faces: faceMode === 'six' ? faces : null,
                    color: (def && typeof def.color === 'string' && MATERIAL_HEX_RE.test(def.color))
                        ? def.color.toUpperCase() : MATERIAL_FALLBACK_COLOR,
                    roughness: clamp01(def && def.roughness, 0.6),
                    metalness: clamp01(def && def.metalness, 0),
                    emissive: clamp01(def && def.emissive, 0),
                    // 1 = pieno. Sotto 1 il materiale e' traslucido (vetro, acqua,
                    // foglie): vedi threeMaterialFor per l'interazione con alphaTest.
                    opacity: clamp01(def && def.opacity, 1),
                    uv: normalizeUv(def && def.uv)
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

            // Modifica IN PLACE, non sostituzione dell'oggetto nell'array. Le liste
            // per-oggetto sono ALIAS della stessa lista di scena (vedi
            // materialsOfProject), quindi rimpiazzare la voce qui la lascerebbe
            // vecchia in ogni altro riferimento gia' preso. Mutando i campi tutti la
            // vedono aggiornata senza doverla ricercare.
            //
            // Il patch passa comunque da normalizeMaterial: e' l'unico punto che
            // valida l'hex e clampa 0..1, e una modifica puo' arrivare da un input
            // dell'utente tanto quanto una creazione. Una chiave ASSENTE nel patch
            // conserva il valore attuale (Object.assign), mentre `texture: null`
            // esplicito la rimuove: e' la differenza fra "non tocco la texture" e
            // "la tolgo", e senza di essa non si potrebbe piu' togliere.
            function updateMaterial(id, patch) {
                const mat = materialById(id);
                if (!mat) return null;
                const merged = normalizeMaterial(Object.assign({}, mat, patch || {}), id);
                Object.keys(merged).forEach(k => { mat[k] = merged[k]; });
                return mat;
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

            // C'e' almeno un pixel non completamente opaco? Serve a decidere se il
            // materiale va reso in trasparenza: farlo per OGNI texture costerebbe
            // ordinamento e depth-write a immagini che non ne hanno bisogno, e la
            // voxel art ne ha molte piene.
            function pixelsHaveAlpha(data) {
                for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
                return false;
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
            // `crop` ({x,y,w,h} in pixel dell'immagine ORIGINALE) ritaglia prima di
            // ridimensionare: il tetto MATERIAL_TEXTURE_MAX si applica al ritaglio,
            // non all'intera foto, altrimenti un dettaglio preso da un'immagine
            // grande arriverebbe gia' sgranato dal downscale del tutto.
            // Il rettangolo viene intersecato con l'immagine perche' un trascinamento
            // puo' uscire dai bordi, e drawImage con una sorgente fuori area disegna
            // il nulla: si otterrebbe una texture trasparente senza un errore.
            //
            // Il messaggio dell'errore e' tecnico e NON va mostrato cosi' com'e':
            // chi chiama presenta la sua stringa da t(). Vedi il pannello materiali.
            function importTextureFile(file, crop) {
                return new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(file);
                    const img = new Image();
                    img.onload = () => {
                        try {
                            resolve(textureFromImage(img, crop));
                        } catch (e) { reject(e); }
                        finally { URL.revokeObjectURL(url); }
                    };
                    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
                    img.src = url;
                });
            }

            // Il ritaglio+ridimensionamento a partire da un'immagine GIA' decodificata.
            // Separato da importTextureFile perche' il pannello ricalcola la texture a
            // ogni trascinamento del rettangolo e ridecodificare il File ogni volta
            // costerebbe una decodifica per frame.
            function textureFromImage(img, crop) {
                const iw = img.width, ih = img.height;
                let sx = 0, sy = 0, sw = iw, sh = ih;
                if (crop) {
                    // Intersezione con l'immagine: un rettangolo fuori bordo
                    // disegnerebbe il vuoto invece di sollevare.
                    sx = Math.max(0, Math.min(iw - 1, Math.round(crop.x)));
                    sy = Math.max(0, Math.min(ih - 1, Math.round(crop.y)));
                    sw = Math.max(1, Math.min(iw - sx, Math.round(crop.w)));
                    sh = Math.max(1, Math.min(ih - sy, Math.round(crop.h)));
                }
                const size = fitTextureSize(sw, sh, MATERIAL_TEXTURE_MAX);
                const cv = document.createElement('canvas');
                cv.width = size.w; cv.height = size.h;
                const ctx = cv.getContext('2d');
                // NearestFilter a valle: qui teniamo il ridimensionamento
                // netto, altrimenti la voxel art esce sfocata gia' in origine.
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size.w, size.h);
                return textureFromCanvasCtx(cv, ctx);
            }

            // La descrizione di una texture a partire da un canvas GIA' disegnato, col
            // suo contesto passato dal chiamante invece di richiederlo di nuovo: due
            // getContext sullo stesso canvas tornano lo stesso oggetto, ma passarlo
            // rende esplicito che questa funzione non disegna niente -- si limita a
            // descrivere quello che c'e'.
            //
            // E' l'unico punto che produce la forma {data, w, h, color, alpha}, quindi
            // il colore medio e il flag di trasparenza non possono divergere fra
            // l'import di un'immagine e la tela del pixel editor.
            function textureFromCanvasCtx(cv, ctx) {
                const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
                return {
                    data: cv.toDataURL('image/png'),
                    w: cv.width, h: cv.height,
                    color: averageColorFromPixels(px),
                    alpha: pixelsHaveAlpha(px)
                };
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
                // Un materiale a 6 facce e' un ARRAY di 6 MeshStandardMaterial: va
                // smontato pezzo per pezzo, o resterebbero 5 texture sulla GPU a ogni
                // rebuild.
                _materialCache.forEach(m => {
                    const list = Array.isArray(m) ? m : [m];
                    list.forEach(x => {
                        if (!x) return;
                        if (x.map && x.map.dispose) x.map.dispose();
                        if (x.dispose) x.dispose();
                    });
                });
                _materialCache = new Map();
            }

            // Costruisce UN MeshStandardMaterial da una definizione + eventuale
            // texture di faccia. Condiviso fra threeMaterialFor (visore) e
            // l'anteprima multi-faccia: e' l'unico posto che sa come si monta.
            function buildStandardFromDef(def, decColor, texRef, wire) {
                const mat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(decColor),
                    roughness: def ? def.roughness : 0.2,
                    metalness: def ? def.metalness : 0.1,
                    wireframe: !!wire
                });
                if (def && def.emissive > 0) {
                    mat.emissive = new THREE.Color(decColor);
                    mat.emissiveIntensity = def.emissive;
                }
                // Per la trasparenza conta anche l'alpha DELLA FACCIA: un materiale
                // a 6 facce puo' avere buchi solo su una. Si passa un def "vista"
                // con texture = quella della faccia.
                const viewDef = def ? {
                    opacity: def.opacity,
                    texture: texRef || def.texture || null
                } : null;
                applyTransparency(mat, viewDef);
                if (texRef && texRef.data) {
                    const tex = new THREE.TextureLoader().load(texRef.data, () => {
                        if (typeof requestRender === 'function') requestRender();
                    });
                    tex.magFilter = THREE.NearestFilter;
                    tex.minFilter = THREE.NearestFilter;
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                    if (def) applyUvToTexture(tex, def.uv);
                    mat.map = tex;
                    // Col map, `color` moltiplica la texture: bianco = texture pura.
                    mat.color = new THREE.Color(0xffffff);
                }
                return mat;
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
            // Trasparenza. Due sorgenti indipendenti: l'`opacity` del materiale e i
            // pixel non opachi della texture.
            //
            // alphaTest e opacity NON si combinano, ed e' la trappola: alphaTest
            // scarta il frammento quando l'alpha finale sta sotto la soglia, e
            // l'alpha finale e' `opacity * alphaDelTexel`. Con opacity 0.4 e soglia
            // 0.5 sparisce TUTTO, anche i pixel pieni -- il materiale diventa
            // invisibile invece che semitrasparente. Quindi il taglio secco si usa
            // solo a opacita' piena, dove e' cio' che serve alla pixel art (bordi
            // netti, niente alone), e sotto 1 si passa alla fusione normale.
            //
            // depthWrite resta TRUE: la scena e' fatta di InstancedMesh per colore,
            // che non si possono ordinare per voxel. Spegnerlo farebbe vedere
            // attraverso il modello i voxel che stanno DIETRO quelli trasparenti in
            // ordine di disegno, che e' un artefatto peggiore del bordo duro.
            function applyTransparency(mat, def) {
                if (!def) return;
                const texAlpha = !!(def.texture && def.texture.alpha);
                const opacity = (typeof def.opacity === 'number') ? def.opacity : 1;
                if (opacity < 1) {
                    mat.transparent = true;
                    mat.opacity = opacity;
                } else if (texAlpha) {
                    mat.transparent = true;
                    mat.alphaTest = 0.5;
                }
            }

            // Ripetizioni, scorrimento e rotazione sulla texture. `center` va messo
            // al centro PRIMA di ruotare, altrimenti la rotazione avviene attorno
            // all'angolo (0,0) e l'immagine esce dal quadrato UV invece di girare
            // sul posto.
            function applyUvToTexture(tex, uv) {
                const u = normalizeUv(uv);
                tex.repeat.set(u.repeat, u.repeat);
                tex.offset.set(u.offsetU, u.offsetV);
                tex.center.set(0.5, 0.5);
                tex.rotation = u.rotation * Math.PI / 180;
            }

            function threeMaterialFor(token, opts) {
                const wire = !!(opts && opts.wireframe);
                const dec = decodeToken(token, (opts && opts.color) || '');
                // materialById, non `dec.material` : su un orfano l'id resta valorizzato
                // (e' voluto, vedi decodeToken) ma la definizione non c'e'.
                const def = materialById(dec.material);
                // La chiave include il faceMode: passare da single a six (o il
                // contrario) sullo stesso id deve invalidare la cache, non
                // restituire l'istanza monofaccia di prima.
                const faceTag = materialHasFaceTextures(def) ? '|6' : '';
                const key = token + '|' + dec.color + faceTag + (wire ? '|w' : '');
                const hit = _materialCache.get(key);
                if (hit) return hit;

                // 6 facce: un ARRAY di 6 materiali, nell'ordine dei gruppi di
                // BoxGeometry. InstancedMesh li assegna da solo per faccia.
                if (materialHasFaceTextures(def)) {
                    const mats = MATERIAL_FACE_KEYS.map(fk => {
                        const m = buildStandardFromDef(def, dec.color, textureForFace(def, fk), wire);
                        // `shared`: questo materiale e' CACHATO e vive in piu' mesh.
                        m.userData.shared = true;
                        m.userData.face = fk;
                        return m;
                    });
                    _materialCache.set(key, mats);
                    return mats;
                }

                const mat = buildStandardFromDef(def, dec.color, def && def.texture, wire);
                // `shared`: questo materiale e' CACHATO e vive in piu' mesh. Chi
                // distrugge un mesh (disposeMesh) deve saltarlo, altrimenti il primo
                // colore ripulito porta con se' la texture di tutti gli altri.
                // Liberarli e' compito di clearMaterialCache, l'unico proprietario.
                mat.userData.shared = true;
                _materialCache.set(key, mat);
                return mat;
            }

            // --- UI del pannello ---------------------------------------------------
            // Il modulo viene caricato anche FUORI da una pagina: i test lo eseguono
            // con new Function per provare lo store e i token, passando un `document`
            // ridotto o nessuno. Si controllano i METODI che servono davvero, non
            // l'esistenza dell'oggetto.
            function hasPanelDom() {
                return typeof document !== 'undefined' && !!document
                    && typeof document.getElementById === 'function'
                    && typeof document.createElement === 'function';
            }

            // La scheda mostra la texture (o la tinta piatta se non c'e'), il nome e,
            // sui materiali del progetto, una X per eliminarlo. Il click destro fa lo
            // stesso, ma da solo non basterebbe: su un pannello non si scopre.
            function materialCardEl(def, onClick) {
                const el = document.createElement('div');
                el.className = 'material-card';
                el.dataset.materialId = def.id;
                el.style.backgroundColor = def.color;
                if (def.texture && def.texture.data) el.style.backgroundImage = `url(${def.texture.data})`;
                const nm = document.createElement('div');
                nm.className = 'material-card-name';
                nm.textContent = def.name;
                el.appendChild(nm);
                el.addEventListener('click', onClick);
                return el;
            }

            // Bottoncino sovrapposto alla scheda. stopPropagation SEMPRE: il bottone
            // sta DENTRO la scheda, quindi senza di esso il click farebbe anche
            // l'azione della scheda (selezionare il materiale che si sta eliminando).
            //
            // innerHTML e non textContent perche' i glifi arrivano come entita' HTML:
            // stella e matita non stanno in latin1, e il build legge/scrive i sorgenti
            // come latin1. Il contenuto e' una COSTANTE nostra, mai testo dell'utente.
            function materialCardBtn(cls, glyph, title, onClick) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'material-card-btn ' + cls;
                b.innerHTML = glyph;
                b.title = title;
                b.addEventListener('click', ev => { ev.stopPropagation(); onClick(); });
                return b;
            }

            // Copia un materiale del progetto nella libreria personale. COPIA, non
            // sposta: il materiale resta nel progetto (i voxel lo citano per id), e in
            // libreria ne va una fotografia indipendente che sopravvive alla sua
            // modifica o eliminazione.
            //
            // L'id viene rinumerato nello spazio della LIBRERIA: due progetti possono
            // aver usato m1 per materiali diversi, e tenere quello d'origine
            // sovrapporrebbe due voci diverse.
            function copyMaterialToLibrary(def) {
                const lib = loadMaterialLibrary();
                if (lib.length >= MATERIAL_LIB_MAX) {
                    alert(t('materials.libraryFull', { max: MATERIAL_LIB_MAX }));
                    return;
                }
                lib.push(normalizeMaterial(def, nextMaterialId(lib.map(m => m && m.id))));
                saveMaterialLibrary(lib);
                renderMaterialLibrary();
            }

            // --- anteprima live -----------------------------------------------------
            // Il materiale in costruzione su una forma di prova, con un renderer
            // PROPRIO: quello della scena e' legato al canvas del viewport e non puo'
            // disegnare altrove.
            //
            // Costruito su richiesta e tenuto (non ricreato a ogni apertura del form):
            // un WebGLRenderer alloca un contesto GL, e i browser ne concedono una
            // manciata per pagina prima di buttare via i piu' vecchi -- cioe' quello
            // del viewport.
            //
            // La forma di DEFAULT e' il CUBO, non la sfera. Su una sfera la texture
            // si avvolge una volta sola e si stringe ai poli: sembra sbagliata anche
            // quando la mappatura e' giusta, ed e' proprio l'immagine che fa dubitare
            // che le UV non funzionino. Il voxel e' un cubo, quindi il cubo mostra la
            // texture come la si vedra' davvero. La sfera resta a scelta perche' su
            // di essa ruvidita' e metallicita' si leggono meglio (il riflesso scorre
            // su una curva continua invece di stare fermo su sei facce piatte).
            let _preview = null;
            let _previewShape = 'box';

            // La metallicita' senza riflessi non si vede: un metalness 1 senza envMap
            // rende NERO, che e' fisicamente giusto (niente da riflettere) ma inutile
            // come anteprima. Un gradiente sui 6 lati basta a dare un ambiente.
            // PMREMGenerator non serve: su r128 un CubeTexture va diretto in envMap.
            function previewEnvMap() {
                const faces = [];
                for (let i = 0; i < 6; i++) {
                    const cv = document.createElement('canvas');
                    cv.width = cv.height = 32;
                    const ctx = cv.getContext('2d');
                    const g = ctx.createLinearGradient(0, 0, 0, 32);
                    // Alto chiaro, basso scuro: la superficie prende un riflesso
                    // orientato invece di una tinta uniforme.
                    g.addColorStop(0, i === 2 ? '#ffffff' : '#8899aa');
                    g.addColorStop(1, i === 3 ? '#222228' : '#33333a');
                    ctx.fillStyle = g;
                    ctx.fillRect(0, 0, 32, 32);
                    faces.push(cv);
                }
                const tex = new THREE.CubeTexture(faces);
                tex.needsUpdate = true;
                return tex;
            }

            function previewGeometryFor(shape) {
                // Il cubo e' leggermente piu' piccolo della sfera perche' la diagonale
                // di un cubo di lato 1.55 riempie lo stesso cerchio del raggio 1.
                return (shape === 'sphere')
                    ? new THREE.SphereGeometry(1, 48, 32)
                    : new THREE.BoxGeometry(1.5, 1.5, 1.5);
            }

            function ensurePreview() {
                if (_preview) return _preview;
                const canvas = document.getElementById('materialPreviewCanvas');
                if (!canvas || typeof THREE === 'undefined' || !THREE.WebGLRenderer) return null;
                let renderer;
                try {
                    // alpha: il canvas resta trasparente dove il materiale lo e', e
                    // sotto si vede la scacchiera CSS (.alpha-checker). Senza, un
                    // materiale trasparente si confonderebbe con lo sfondo nero.
                    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
                } catch (e) {
                    // Nessun WebGL disponibile: l'anteprima e' un comfort, il resto
                    // del pannello deve continuare a funzionare.
                    return null;
                }
                renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
                renderer.setSize(canvas.width, canvas.height, false);
                renderer.setClearColor(0x000000, 0);
                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
                camera.position.set(0, 0, 4.6);
                scene.add(new THREE.AmbientLight(0xffffff, 0.55));
                const key = new THREE.DirectionalLight(0xffffff, 0.9);
                key.position.set(2, 3, 4);
                scene.add(key);
                const rim = new THREE.DirectionalLight(0x88aaff, 0.35);
                rim.position.set(-3, -1, -2);
                scene.add(rim);
                const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, metalness: 0 });
                mat.envMap = previewEnvMap();
                // DoubleSide: con un materiale trasparente si vede anche la parete di
                // fondo, che e' cio' che rende leggibile "quanto" e' trasparente.
                mat.side = THREE.DoubleSide;
                const mesh = new THREE.Mesh(previewGeometryFor(_previewShape), mat);
                // Un filo di inclinazione: a rotazione nulla il cubo mostrerebbe una
                // sola faccia frontale e sembrerebbe un quadrato piatto.
                mesh.rotation.x = 0.42;
                scene.add(mesh);
                // autoSpin: gira da sola finche' il form e' aperto. Si spegne
                // durante un drag del mouse e riparte al rilascio. drag: stato
                // del trascinamento (pointer capture sul canvas).
                _preview = {
                    renderer, scene, camera, mesh, mat,
                    spinning: false, autoSpin: true, angle: 0,
                    drag: null, tiltX: 0.42
                };
                return _preview;
            }

            function setPreviewShape(shape) {
                _previewShape = (shape === 'sphere') ? 'sphere' : 'box';
                const p = ensurePreview();
                if (!p) return;
                // La geometria vecchia va liberata: e' PROPRIA dell'anteprima (non
                // condivisa come i materiali cachati), quindi nessuno la disporrebbe
                // per noi e ogni cambio di forma lascerebbe un buffer sulla GPU.
                if (p.mesh.geometry && p.mesh.geometry.dispose) p.mesh.geometry.dispose();
                p.mesh.geometry = previewGeometryFor(_previewShape);
                p.dirty = true;
                // Cambiando forma (cubo <-> sfera) va riassegnato il materiale:
                // le 6 facce hanno senso solo sul cubo, sulla sfera si ricade
                // sulla texture unica. applyPreviewState lo decide da solo.
                if (materialFormIsOpen()) refreshFormPreview();
                else startPreviewSpin();
            }

            // Applica al materiale d'anteprima i valori CORRENTI del form. `state` ha
            // la stessa forma di una voce dello store, cosi' funziona sia sul form sia
            // su un def esistente.
            //
            // La texture viene ricaricata solo quando il suo data URL CAMBIA: senza
            // questo controllo ogni movimento di slider rifarebbe un upload GPU della
            // stessa immagine (l'anteprima si aggiorna a ogni `input`). Le UV invece
            // si riapplicano sempre: sono proprieta' dell'oggetto texture, cambiarle
            // non ricarica niente.
            // Applica texture + UV + trasparenza a UN materiale d'anteprima. Usata sia
            // sul materiale singolo sia su ciascuna delle 6 facce.
            function applyPreviewMatSide(m, state, texRef, hex) {
                const texData = (texRef && texRef.data) ? texRef.data : null;
                m.roughness = state ? state.roughness : 0.6;
                m.metalness = state ? state.metalness : 0;
                const emi = state ? state.emissive : 0;
                m.emissive = new THREE.Color(emi > 0 ? hex : 0x000000);
                m.emissiveIntensity = emi;
                // La texture si ricarica solo se il data URL cambia: ogni slider
                // rifarebbe altrimenti un upload GPU della stessa immagine.
                if (texData !== m.userData.texData) {
                    if (m.map && m.map.dispose) m.map.dispose();
                    m.userData.texData = texData;
                    if (texData) {
                        const tex = new THREE.TextureLoader().load(texData, () => {
                            const p = _preview; if (p) p.dirty = true;
                        });
                        tex.magFilter = THREE.NearestFilter;
                        tex.minFilter = THREE.NearestFilter;
                        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                        m.map = tex;
                    } else {
                        m.map = null;
                    }
                }
                if (m.map) applyUvToTexture(m.map, state && state.uv);
                m.transparent = false;
                m.opacity = 1;
                m.alphaTest = 0;
                applyTransparency(m, {
                    opacity: state ? state.opacity : 1,
                    texture: texRef || null
                });
                m.color = new THREE.Color(texData ? 0xffffff : hex);
                m.needsUpdate = true;
            }

            function applyPreviewState(state) {
                const p = ensurePreview();
                if (!p) return;
                const hex = (state && MATERIAL_HEX_RE.test(state.color || ''))
                    ? state.color : MATERIAL_FALLBACK_COLOR;
                const multi = !!(state && state.faceMode === 'six' && state.faces
                    && _previewShape === 'box');

                if (multi) {
                    // 6 materiali, uno per faccia del cubo. Sulla sfera non ha senso
                    // (una sola mappatura UV avvolta): si ricade sul materiale unico.
                    if (!Array.isArray(p.mesh.material) || p.mesh.material.length !== 6) {
                        // Il materiale singolo resta vivo in p.mat per quando si
                        // torna a single/sfera: non si dispose.
                        const mats = MATERIAL_FACE_KEYS.map(() => {
                            const m = new THREE.MeshStandardMaterial({
                                color: 0xcccccc, roughness: 0.6, metalness: 0
                            });
                            m.envMap = previewEnvMap();
                            m.side = THREE.DoubleSide;
                            m.userData.texData = null;
                            return m;
                        });
                        p.mesh.material = mats;
                        p.faceMats = mats;
                    }
                    MATERIAL_FACE_KEYS.forEach((fk, i) => {
                        applyPreviewMatSide(p.faceMats[i], state, textureForFace(state, fk), hex);
                    });
                } else {
                    // Torna al materiale singolo se eravamo in multi.
                    if (p.mesh.material !== p.mat) p.mesh.material = p.mat;
                    applyPreviewMatSide(p.mat, state, state && state.texture, hex);
                    // Compat: p.texData era il vecchio checkpoint; resta allineato
                    // cosi' un lettore esterno non vede un valore stantio.
                    p.texData = p.mat.userData.texData || null;
                }
                startPreviewSpin();
            }

            // La forma gira SOLO finche' il form e' aperto: un loop perenne terrebbe
            // sveglia la GPU per un pannello chiuso (e questa app rende on-demand di
            // proposito, vedi requestRender).
            // autoSpin spegne l'incremento di angle durante un drag del mouse
            // (l'utente ruota a mano); il loop resta vivo per ridisegnare i
            // frame del trascinamento. Al rilascio autoSpin torna true e la
            // rotazione continua da dove l'ha lasciata.
            function startPreviewSpin() {
                const p = ensurePreview();
                if (!p || p.spinning) return;
                p.spinning = true;
                const step = () => {
                    if (!materialFormIsOpen()) { p.spinning = false; return; }
                    if (p.autoSpin) p.angle += 0.012;
                    p.mesh.rotation.y = p.angle;
                    p.mesh.rotation.x = p.tiltX;
                    p.renderer.render(p.scene, p.camera);
                    requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
            }

            // Timer del leave: senza, al bordo del wrap l'ingrandimento sposta
            // il hit-box e mouseleave/enter oscillano grande↔piccola.
            // ~140 ms assorbe un graffio sul bordo senza far sentire la
            // preview pigra a uscire davvero.
            let _previewLeaveTimer = null;
            const PREVIEW_LEAVE_MS = 140;

            // Ingrandisce l'anteprima (CSS .is-enlarged) e avvia la rotazione
            // se non stava gia' girando. on=true e' immediato; on=false e'
            // ritardato (hysteresis sul leave) a meno che immediate=true
            // (chiusura form, dove non serve grazia).
            function setPreviewEnlarged(on, immediate) {
                const wrap = document.getElementById('materialPreviewWrap');
                if (_previewLeaveTimer) {
                    clearTimeout(_previewLeaveTimer);
                    _previewLeaveTimer = null;
                }
                if (on) {
                    if (wrap) wrap.classList.add('is-enlarged');
                    startPreviewSpin();
                    return;
                }
                const shrink = () => {
                    _previewLeaveTimer = null;
                    const w = document.getElementById('materialPreviewWrap');
                    if (w) w.classList.remove('is-enlarged');
                };
                if (immediate) {
                    shrink();
                } else {
                    _previewLeaveTimer = setTimeout(shrink, PREVIEW_LEAVE_MS);
                }
            }

            // Drag sul canvas: ruota Y (orizzontale) e un po' di tilt X
            // (verticale, clampato). pointer capture cosi' il drag non si
            // interrompe uscendo dal canvas. Al pointerup riparte autoSpin.
            function initPreviewInteraction() {
                const canvas = document.getElementById('materialPreviewCanvas');
                const wrap = document.getElementById('materialPreviewWrap');
                if (!canvas || canvas.dataset.previewUiBound) return;
                canvas.dataset.previewUiBound = '1';

                if (wrap) {
                    wrap.addEventListener('mouseenter', () => setPreviewEnlarged(true));
                    wrap.addEventListener('mouseleave', () => {
                        // Non rimpicciolire a meta' di un drag (il cursore
                        // puo' uscire dal wrap con il tasto premuto).
                        const p = _preview;
                        if (p && p.drag) return;
                        // Ritardato: se il cursore rientra dal bordo entro
                        // PREVIEW_LEAVE_MS, mouseenter cancella il timer e
                        // resta ingrandita — niente thrash.
                        setPreviewEnlarged(false);
                    });
                }

                const onMove = (ev) => {
                    const p = _preview;
                    if (!p || !p.drag) return;
                    const dx = ev.clientX - p.drag.x;
                    const dy = ev.clientY - p.drag.y;
                    p.drag.x = ev.clientX;
                    p.drag.y = ev.clientY;
                    // Sensibilita' in radianti per pixel di schermo.
                    p.angle += dx * 0.01;
                    p.tiltX = Math.max(-0.9, Math.min(1.2, p.tiltX + dy * 0.008));
                    // Il loop di spin ridisegna; se e' spento (form chiuso,
                    // non dovrebbe succedere) si forza un frame.
                    if (!p.spinning) {
                        p.mesh.rotation.y = p.angle;
                        p.mesh.rotation.x = p.tiltX;
                        p.renderer.render(p.scene, p.camera);
                    }
                };
                const onUp = (ev) => {
                    const p = _preview;
                    if (!p || !p.drag) return;
                    p.drag = null;
                    p.autoSpin = true;
                    try {
                        if (canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) {
                            canvas.releasePointerCapture(ev.pointerId);
                        }
                    } catch (e) { /* ignore */ }
                    canvas.removeEventListener('pointermove', onMove);
                    canvas.removeEventListener('pointerup', onUp);
                    canvas.removeEventListener('pointercancel', onUp);
                    // Se il cursore e' gia' fuori dal wrap, rimpicciolisci
                    // (con lo stesso delay chill del mouseleave).
                    if (wrap && !wrap.matches(':hover')) setPreviewEnlarged(false);
                    startPreviewSpin();
                };
                canvas.addEventListener('pointerdown', (ev) => {
                    // Solo tasto sinistro / tocco primario.
                    if (ev.button != null && ev.button !== 0) return;
                    const p = ensurePreview();
                    if (!p) return;
                    ev.preventDefault();
                    p.autoSpin = false;
                    p.drag = { x: ev.clientX, y: ev.clientY };
                    setPreviewEnlarged(true);
                    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
                    canvas.addEventListener('pointermove', onMove);
                    canvas.addEventListener('pointerup', onUp);
                    canvas.addEventListener('pointercancel', onUp);
                    startPreviewSpin();
                });
            }

            // L'anteprima vive dentro #materialFaceModeRow (sotto le facce)
            // quando si disegna, e in #materialPreviewHomeFlat in tinta unita
            // (materialDrawSection e' display:none). Un solo nodo, spostato:
            // un secondo canvas aprirebbe un secondo WebGL context e a lungo
            // andare il browser spegne quello del viewport.
            function placePreviewWrap(src) {
                const wrap = document.getElementById('materialPreviewWrap');
                if (!wrap) return;
                const faceRow = document.getElementById('materialFaceModeRow');
                const flatHome = document.getElementById('materialPreviewHomeFlat');
                if (src === 'flat') {
                    if (flatHome && wrap.parentElement !== flatHome) flatHome.appendChild(wrap);
                    if (flatHome) flatHome.style.display = '';
                } else {
                    if (faceRow && wrap.parentElement !== faceRow) faceRow.appendChild(wrap);
                    if (flatHome) flatHome.style.display = 'none';
                }
            }

            // Elimina chiedendo conferma, poi svuota la cache e ridisegna: i voxel che
            // citavano l'id restano, diventano orfani e tornano da soli a tinta unita
            // (vedi decodeToken). Senza clearMaterialCache continuerebbero a mostrare
            // la texture del materiale appena eliminato.
            function deleteMaterialFromPanel(def) {
                if (!confirm(t('materials.confirmDelete', { name: def.name }))) return;
                removeMaterial(def.id);
                clearMaterialCache();
                renderMaterialsPanel();
                if (typeof buildModel === 'function') buildModel(false);
            }

            function renderMaterialsPanel() {
                if (!hasPanelDom()) return;
                const grid = document.getElementById('materialsGrid');
                if (!grid) return;
                const list = materialsOfProject();
                grid.innerHTML = '';
                list.forEach(def => {
                    const el = materialCardEl(def, () => setActiveMaterialAndSync(def.id));
                    el.title = def.name;
                    el.appendChild(materialCardBtn('material-card-edit', '&#9998;',
                        t('materials.editTitle'), () => openMaterialForm(def.id)));
                    el.appendChild(materialCardBtn('material-card-star', '&#9733;',
                        t('materials.saveToLibraryTitle'), () => copyMaterialToLibrary(def)));
                    el.appendChild(materialCardBtn('material-card-del', '&#215;',
                        t('materials.deleteTitle'), () => deleteMaterialFromPanel(def)));
                    el.addEventListener('contextmenu', ev => { ev.preventDefault(); deleteMaterialFromPanel(def); });
                    grid.appendChild(el);
                });
                const empty = document.getElementById('materialsEmpty');
                if (empty) empty.style.display = list.length ? 'none' : '';
                renderMaterialLibrary();
                refreshMaterialSelectionUI();
            }

            // --- libreria personale -------------------------------------------------
            // Vive in localStorage, non nel progetto: serve a riusare un materiale FRA
            // progetti diversi. E' un comfort, non un dato critico - se il browser la
            // rifiuta si va avanti in silenzio.
            function loadMaterialLibrary() {
                try {
                    const raw = localStorage.getItem(MATERIAL_LIB_KEY);
                    const arr = raw ? JSON.parse(raw) : [];
                    return Array.isArray(arr) ? arr : [];
                } catch (e) { return []; }
            }

            function saveMaterialLibrary(arr) {
                try { localStorage.setItem(MATERIAL_LIB_KEY, JSON.stringify(arr.slice(0, MATERIAL_LIB_MAX))); }
                catch (e) { /* quota piena: la libreria e' un comfort, non un dato critico */ }
            }

            function renderMaterialLibrary() {
                if (!hasPanelDom()) return;
                const grid = document.getElementById('materialLibraryGrid');
                if (!grid) return;
                const lib = loadMaterialLibrary();
                grid.innerHTML = '';
                lib.forEach((def, i) => {
                    const el = materialCardEl(def, () => {
                        // Importare RINUMERA: due progetti diversi possono aver usato m1
                        // per materiali diversi, e tenere l'id di origine legherebbe la
                        // copia al materiale gia' presente invece di aggiungerne uno.
                        const copia = addMaterial(Object.assign({}, def, { id: null }));
                        clearMaterialCache();
                        renderMaterialsPanel();
                        setActiveMaterialAndSync(copia.id);
                    });
                    el.title = t('materials.importFromLibrary') + ': ' + def.name;
                    const del = document.createElement('button');
                    del.type = 'button';
                    del.className = 'material-card-btn material-card-del';
                    del.innerHTML = '&#215;';
                    del.title = t('materials.deleteTitle');
                    del.addEventListener('click', ev => {
                        ev.stopPropagation();
                        const cur = loadMaterialLibrary();
                        cur.splice(i, 1);
                        saveMaterialLibrary(cur);
                        renderMaterialLibrary();
                    });
                    el.appendChild(del);
                    grid.appendChild(el);
                });
                const empty = document.getElementById('materialLibraryEmpty');
                if (empty) empty.style.display = lib.length ? 'none' : '';
            }

            // --- form di creazione/modifica -----------------------------------------
            // Lo stato del form vive a livello di MODULO e gli handler si agganciano
            // UNA VOLTA sola (initMaterialsPanel). Tenerlo dentro la funzione
            // d'apertura obbligava a riagganciare i listener a ogni apertura, e
            // addEventListener non sostituisce: alla terza apertura uno slider
            // aggiornava l'anteprima tre volte per movimento e "Salva" creava tre
            // materiali. Gli handler leggono _formState, che l'apertura riempie.
            //
            // `editingId` null = creazione, una stringa = modifica di quel materiale.
            // In modifica il salvataggio SOSTITUISCE (updateMaterial in place) e la
            // lista non cresce: e' il senso di tenere l'id nello stato invece di
            // dedurlo dal nome, che due materiali possono avere uguale.
            //
            // SORGENTE della texture (`source`):
            //   'flat'  - nessuna texture, tinta unita
            //   'draw'  - la tela del pixel editor
            //   'image' - un'immagine ritagliata, RIVERSATA nella stessa tela
            // La tela e' l'unica sorgente dei pixel in entrambi i casi non-flat: cosi'
            // un'immagine importata resta modificabile pixel per pixel invece di
            // essere un blocco intoccabile, che e' esattamente cio' che serviva.
            let _formState = {
                editingId: null,
                pendingTexture: null,
                crop: null,
                source: 'flat',
                // 'single' = una texture su tutte le facce; 'six' = una per faccia.
                faceMode: 'single',
                // Faccia attiva nell'editor (solo in faceMode 'six').
                activeFace: 'px'
            };

            function materialFormIsOpen() {
                const f = document.getElementById('materialForm');
                return !!f && f.style.display !== 'none';
            }

            function elVal(id, dflt) {
                const el = document.getElementById(id);
                const n = el ? parseFloat(el.value) : NaN;
                return isFinite(n) ? n : dflt;
            }

            function formSliderValues() {
                return {
                    roughness: elVal('materialRoughness', 0.6),
                    metalness: elVal('materialMetalness', 0),
                    emissive: elVal('materialEmissive', 0),
                    opacity: elVal('materialOpacity', 1)
                };
            }

            function formUvValues() {
                return {
                    repeat: elVal('materialUvRepeat', 1),
                    offsetU: elVal('materialUvOffsetU', 0),
                    offsetV: elVal('materialUvOffsetV', 0),
                    rotation: elVal('materialUvRotation', 0)
                };
            }

            function updateSliderLabels() {
                const v = formSliderValues();
                const uv = formUvValues();
                const put = (id, txt) => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = txt;
                };
                put('materialRoughnessValue', v.roughness.toFixed(2));
                put('materialMetalnessValue', v.metalness.toFixed(2));
                put('materialEmissiveValue', v.emissive.toFixed(2));
                put('materialOpacityValue', v.opacity.toFixed(2));
                put('materialUvRepeatValue', uv.repeat.toFixed(2));
                put('materialUvOffsetUValue', uv.offsetU.toFixed(2));
                put('materialUvOffsetVValue', uv.offsetV.toFixed(2));
                put('materialUvRotationValue', Math.round(uv.rotation) + '°');
            }

            // Colore del materiale che il form sta descrivendo.
            //
            // "Tinta unita": e' lo SFONDO della tela (materialSolidColor /
            // materialCanvasBg), NON il pennello. Il pennello serve solo a
            // disegnare; confonderli faceva cambiare la tinta del materiale
            // quando si sceglieva un colore da dipingere.
            //
            // Con una texture (draw/image) il colore e' la tinta media della
            // texture: e' quello che serve a .vox/.schem e alle swatch, e
            // l'anteprima lo moltiplica solo se manca la map.
            function currentFormColor() {
                if (_formState.source !== 'flat' && _formState.pendingTexture) {
                    return _formState.pendingTexture.color;
                }
                return solidFormColor();
            }

            // Valore grezzo del picker della tinta unita / sfondo. NON passa da
            // artBackgroundColor(): quella torna null col checkbox "trasparente"
            // spuntato, e un materiale flat non puo' avere colore null.
            function solidFormColor() {
                const solid = document.getElementById('materialSolidColor');
                if (solid && MATERIAL_HEX_RE.test(solid.value || '')) {
                    return solid.value.toUpperCase();
                }
                const bg = document.getElementById('materialCanvasBg');
                if (bg && MATERIAL_HEX_RE.test(bg.value || '')) {
                    return bg.value.toUpperCase();
                }
                return MATERIAL_FALLBACK_COLOR;
            }

            // Un solo valore, due picker: tinta unita e sfondo della tela. Non
            // tocca il pennello (che e' un'altra cosa).
            function setSolidColor(hex) {
                if (!MATERIAL_HEX_RE.test(hex || '')) return;
                const h = hex.toUpperCase();
                const solid = document.getElementById('materialSolidColor');
                if (solid) solid.value = h;
                const solidHex = document.getElementById('materialSolidHex');
                if (solidHex) solidHex.textContent = h;
                const bg = document.getElementById('materialCanvasBg');
                if (bg) bg.value = h;
                if (materialFormIsOpen() && _formState.source === 'flat') refreshFormPreview();
            }

            // La definizione che il form sta descrivendo ADESSO. Unico punto che la
            // compone, cosi' l'anteprima non puo' mostrare qualcosa di diverso da
            // quello che il salvataggio scrive.
            //
            // `alpha` viene riportato: dice al rendering se il materiale va disegnato
            // in trasparenza, e perderlo qui farebbe sparire i buchi di una texture
            // disegnata con la gomma appena la si risalva.
            function formDefinition() {
                const v = formSliderValues();
                const nameEl = document.getElementById('materialName');
                const flat = _formState.source === 'flat';
                const tex = flat ? null : _formState.pendingTexture;
                const faceMode = (!flat && _formState.faceMode === 'six') ? 'six' : 'single';
                let faces = null;
                if (faceMode === 'six') {
                    // Snapshot di ogni faccia: la faccia attiva e' gia' in
                    // pendingTexture (commitArtToTexture la tiene aggiornata), le
                    // altre stanno nei buffer offscreen.
                    faces = {};
                    MATERIAL_FACE_KEYS.forEach(fk => {
                        let t = null;
                        if (fk === _formState.activeFace && tex) {
                            t = { data: tex.data, w: tex.w, h: tex.h, alpha: !!tex.alpha };
                        } else if (_art.faceBuffers && _art.faceBuffers[fk]
                            && _art.faceBuffers[fk].tex) {
                            const ft = _art.faceBuffers[fk].tex;
                            t = { data: ft.data, w: ft.w, h: ft.h, alpha: !!ft.alpha };
                        }
                        if (t) faces[fk] = t;
                    });
                    if (!Object.keys(faces).length) faces = null;
                }
                return {
                    name: nameEl ? nameEl.value.trim() : '',
                    texture: tex ? { data: tex.data, w: tex.w, h: tex.h, alpha: !!tex.alpha } : null,
                    faceMode: faceMode,
                    faces: faces,
                    color: currentFormColor(),
                    roughness: v.roughness,
                    metalness: v.metalness,
                    emissive: v.emissive,
                    opacity: v.opacity,
                    uv: formUvValues()
                };
            }

            function refreshFormPreview() {
                applyPreviewState(formDefinition());
            }

            function closeMaterialForm() {
                // La finestra grande ospita nodi che APPARTENGONO al form: chiuderla
                // per prima li rimette al loro posto. Lasciarla aperta li terrebbe
                // agganciati all'overlay mentre il form e' chiuso, e riaprendo il form
                // la tela non ci sarebbe piu'.
                if (artEditorIsOpen()) closeArtEditor();
                const form = document.getElementById('materialForm');
                if (form) form.style.display = 'none';
                _formState = {
                    editingId: null, pendingTexture: null, crop: null, source: 'flat',
                    faceMode: 'single', activeFace: 'px'
                };
                // I buffer per-faccia sono dello stato del form: a form chiuso non
                // devono restare in memoria (e a riapertura ripartono da zero).
                _art.faceBuffers = null;
                // Invalida eventuali onload ancora in volo (loadArtFromTexture):
                // senza, un load ritardato ridipingerebbe la tela del form
                // successivo. Stesso contatore di switchActiveFace.
                _artLoadGen++;
                // Anteprima: rimpicciolisci subito (niente delay: il form non c'e'
                // piu') e ferma un eventuale drag rimasto appeso.
                if (_preview) {
                    _preview.drag = null;
                    _preview.autoSpin = true;
                }
                setPreviewEnlarged(false, true);
            }

            // Mostra/nasconde i blocchi in base alla sorgente scelta. La sezione UV
            // compare solo con una texture: senza mappa non c'e' niente da mappare, e
            // tre cursori inerti fanno sospettare che siano loro a non funzionare.
            function refreshSourceUI() {
                const src = _formState.source;
                const show = (id, on) => {
                    const el = document.getElementById(id);
                    if (el) el.style.display = on ? 'flex' : 'none';
                };
                show('materialImageSetup', src === 'image');
                show('materialSolidSetup', src === 'flat');
                // Mentre la tela e' nella finestra grande la scelta della dimensione
                // sta LI' DENTRO: nasconderla perche' la sorgente e' cambiata la
                // farebbe sparire da un pannello in cui e' l'unico modo di
                // ridimensionare il disegno.
                show('materialCanvasSetup', src !== 'flat' || artEditorIsOpen());
                show('materialDrawSection', src !== 'flat');
                show('materialUvSection', src !== 'flat' && !!_formState.pendingTexture);
                // Anteprima: sotto le facce in draw/image, host flat in tinta unita.
                placePreviewWrap(src);
                // Lo switcher delle facce vive dentro #materialArtTools (che viaggia
                // nella finestra grande): si mostra solo in draw/image + faceMode six.
                const faceRow = document.getElementById('materialFaceModeRow');
                if (faceRow) faceRow.style.display = (src !== 'flat') ? 'flex' : 'none';
                const switcher = document.getElementById('materialFaceSwitcher');
                if (switcher) {
                    switcher.style.display = (src !== 'flat' && _formState.faceMode === 'six')
                        ? 'flex' : 'none';
                }
                const faceSeg = document.getElementById('materialFaceModeSeg');
                if (faceSeg) {
                    faceSeg.querySelectorAll('.seg-btn').forEach(b => {
                        b.classList.toggle('active', b.dataset.facemode === _formState.faceMode);
                    });
                }
                if (switcher) {
                    switcher.querySelectorAll('[data-face]').forEach(b => {
                        b.classList.toggle('active', b.dataset.face === _formState.activeFace);
                    });
                }
                const seg = document.getElementById('materialSourceSeg');
                if (seg) {
                    seg.querySelectorAll('.seg-btn').forEach(b => {
                        b.classList.toggle('active', b.dataset.source === src);
                    });
                }
            }

            function setFormSource(src) {
                _formState.source = (src === 'draw' || src === 'image') ? src : 'flat';
                if (_formState.source === 'flat') {
                    // La tela NON viene distrutta: tornare su "Disegna" deve ritrovare
                    // il disegno, non una tela bianca. Si stacca solo la texture dal
                    // materiale, ed e' formDefinition a ignorarla finche' si sta su
                    // "Tinta unita".
                    hideCropUI();
                } else if (!_art.canvas) {
                    newArtCanvas(artSelectedSize(), artBackgroundColor());
                }
                refreshSourceUI();
                refreshFormPreview();
            }

            // Apre il form. In modifica precarica i valori del materiale e ne riversa
            // la texture nella tela, cosi' la si puo' ancora ridisegnare: e' l'unica
            // immagine ancora disponibile (il File originale non viene conservato).
            function openMaterialForm(editingId) {
                if (!hasPanelDom()) return;
                const form = document.getElementById('materialForm');
                const nameEl = document.getElementById('materialName');
                const fileEl = document.getElementById('materialTextureInput');
                if (!form || !nameEl) return;

                const def = editingId ? materialById(editingId) : null;
                if (editingId && !def) return;   // eliminato nel frattempo

                _formState = {
                    editingId: editingId || null,
                    pendingTexture: null,
                    crop: null,
                    source: 'flat',
                    faceMode: 'single',
                    activeFace: 'px'
                };
                _art.faceBuffers = null;

                const setSlider = (id, val) => {
                    const el = document.getElementById(id);
                    if (el) el.value = String(val);
                };
                if (def) {
                    nameEl.value = def.name;
                    setSlider('materialRoughness', def.roughness);
                    setSlider('materialMetalness', def.metalness);
                    setSlider('materialEmissive', def.emissive);
                    setSlider('materialOpacity', def.opacity);
                    setSlider('materialUvRepeat', def.uv.repeat);
                    setSlider('materialUvOffsetU', def.uv.offsetU);
                    setSlider('materialUvOffsetV', def.uv.offsetV);
                    setSlider('materialUvRotation', def.uv.rotation);
                    if (def.texture && def.texture.data) {
                        _formState.pendingTexture = {
                            data: def.texture.data, w: def.texture.w, h: def.texture.h,
                            color: def.color, alpha: !!def.texture.alpha
                        };
                        _formState.source = 'draw';
                    }
                    // 6 facce: ripristina i buffer e carica la faccia attiva.
                    if (def.faceMode === 'six' && def.faces) {
                        _formState.faceMode = 'six';
                        _formState.source = 'draw';
                        ensureFaceBuffers();
                        MATERIAL_FACE_KEYS.forEach(fk => {
                            // Faccia assente: ricade sulla texture rappresentativa
                            // (stesso contratto di textureForFace a runtime).
                            const t = def.faces[fk] || def.texture;
                            if (t && t.data) {
                                _art.faceBuffers[fk] = {
                                    undo: [], redo: [],
                                    tex: {
                                        data: t.data, w: t.w, h: t.h,
                                        color: def.color, alpha: !!t.alpha
                                    },
                                    // snap lazy: si ricostruisce al primo switch
                                    snap: null
                                };
                            }
                        });
                        // activeFace: 'px' se c'e', altrimenti la prima faccia
                        // con texture. Senza, un materiale salvato senza px
                        // aprirebbe una tela vuota lasciando i disegni altrove.
                        let startFace = 'px';
                        if (!(_art.faceBuffers.px && _art.faceBuffers.px.tex)) {
                            for (let i = 0; i < MATERIAL_FACE_KEYS.length; i++) {
                                const fk = MATERIAL_FACE_KEYS[i];
                                if (_art.faceBuffers[fk] && _art.faceBuffers[fk].tex) {
                                    startFace = fk;
                                    break;
                                }
                            }
                        }
                        _formState.activeFace = startFace;
                        const startBuf = _art.faceBuffers[startFace];
                        if (startBuf && startBuf.tex) {
                            _formState.pendingTexture = {
                                data: startBuf.tex.data,
                                w: startBuf.tex.w,
                                h: startBuf.tex.h,
                                color: def.color,
                                alpha: !!startBuf.tex.alpha
                            };
                        } else if (def.texture && def.texture.data) {
                            _formState.pendingTexture = {
                                data: def.texture.data,
                                w: def.texture.w,
                                h: def.texture.h,
                                color: def.color,
                                alpha: !!def.texture.alpha
                            };
                        }
                    }
                } else {
                    nameEl.value = '';
                    setSlider('materialRoughness', 0.6);
                    setSlider('materialMetalness', 0);
                    setSlider('materialEmissive', 0);
                    setSlider('materialOpacity', 1);
                    setSlider('materialUvRepeat', 1);
                    setSlider('materialUvOffsetU', 0);
                    setSlider('materialUvOffsetV', 0);
                    setSlider('materialUvRotation', 0);
                    resetArtCanvas();
                }
                // Tinta unita / sfondo: in modifica il colore del materiale (anche
                // con texture o faceMode six: e' lo sfondo delle facce ancora
                // vuote e la tinta media di fallback). In creazione il colore
                // attivo dell'editor. Il pennello resta a se'.
                if (def) {
                    setSolidColor(def.color);
                } else if (typeof activeColorHex === 'string'
                    && MATERIAL_HEX_RE.test(activeColorHex)) {
                    setSolidColor(activeColorHex);
                }
                // Il pennello: in creazione parte dal colore attivo, in modifica
                // resta quello che c'era (non e' una proprieta' del materiale).
                if (!def && typeof activeColorHex === 'string'
                    && MATERIAL_HEX_RE.test(activeColorHex)) {
                    setPenColor(activeColorHex, false);
                }
                // Il file input non si puo' precaricare (non esiste un File da
                // assegnare): si azzera, e la texture in modifica arriva da _formState.
                if (fileEl) fileEl.value = '';
                setFileNameLabel(null);

                // Etichetta del bottone: l'attributo data-i18n va aggiornato assieme al
                // testo, altrimenti un cambio di lingua a form aperto lo riporterebbe a
                // "Crea" mentre si sta modificando.
                const saveBtn = document.getElementById('materialSaveBtn');
                if (saveBtn) {
                    const key = editingId ? 'materials.saveChanges' : 'materials.create';
                    saveBtn.setAttribute('data-i18n', key);
                    saveBtn.textContent = t(key);
                }
                // "+ Libreria" solo in creazione: in modifica salverebbe una COPIA
                // della voce che si sta modificando, che non e' quello che chiede chi
                // ha aperto la scheda per correggere un materiale.
                const libBtn = document.getElementById('materialSaveToLibBtn');
                if (libBtn) libBtn.style.display = editingId ? 'none' : '';

                updateSliderLabels();
                hideCropUI();
                form.style.display = 'flex';

                // La texture in modifica finisce nella tela: da qui si puo' ridisegnare.
                // In faceMode six si carica la faccia attiva (con i suoi buffer).
                if (_formState.faceMode === 'six') {
                    const buf = _art.faceBuffers && _art.faceBuffers[_formState.activeFace];
                    const tex = (buf && buf.tex) || _formState.pendingTexture;
                    if (tex) loadArtFromTexture(tex);
                    else if (!_art.canvas) newArtCanvas(artSelectedSize(), artBackgroundColor());
                } else if (_formState.pendingTexture) {
                    loadArtFromTexture(_formState.pendingTexture);
                }
                refreshSourceUI();
                refreshFormPreview();
                renderPenSwatches();
            }

            function setFileNameLabel(name) {
                const el = document.getElementById('materialFileName');
                if (el) el.textContent = name || t('materials.noTexture');
            }

            // --- ritaglio della texture --------------------------------------------
            // Il canvas mostra l'immagine intera e un div assoluto ci fa da rettangolo
            // di selezione, con otto maniglie. Trascinare una maniglia RIDIMENSIONA
            // dal lato afferrato, dentro il rettangolo lo SPOSTA, fuori ne disegna uno
            // nuovo. L'immagine e' decodificata UNA volta e tenuta in `crop.img`:
            // ridecodificarla a ogni movimento costerebbe una decodifica per frame.
            const MATERIAL_CROP_DISPLAY_MAX = 256;
            // Raggio di presa di una maniglia, in pixel di SCHERMO: in pixel immagine
            // una soglia fissa sarebbe enorme su una foto piccola e invisibile su una
            // grande.
            const MATERIAL_CROP_GRAB_PX = 10;

            function hideCropUI() {
                const sec = document.getElementById('materialCropSection');
                if (sec) sec.style.display = 'none';
                _formState.crop = null;
            }

            function loadImageForCrop(src) {
                const img = new Image();
                img.onload = () => { if (materialFormIsOpen()) setupCropUI(img); };
                // Un fallimento qui non e' un errore da mostrare: la texture c'e' e
                // resta valida, e' solo il ritaglio che non si puo' offrire.
                img.onerror = () => hideCropUI();
                img.src = src;
            }

            function setupCropUI(img) {
                const sec = document.getElementById('materialCropSection');
                const canvas = document.getElementById('materialCropCanvas');
                if (!sec || !canvas || !img.width || !img.height) return;
                const iw = img.width, ih = img.height;
                const scale = Math.min(1, MATERIAL_CROP_DISPLAY_MAX / Math.max(iw, ih));
                const dw = Math.max(1, Math.round(iw * scale));
                const dh = Math.max(1, Math.round(ih * scale));
                canvas.width = dw;
                canvas.height = dh;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(img, 0, 0, dw, dh);
                // Parte a immagine INTERA: aprire il ritaglio non deve cambiare da solo
                // la texture di chi voleva solo rinominare un materiale.
                _formState.crop = {
                    img: img, iw: iw, ih: ih, scale: dw / iw,
                    x: 0, y: 0, w: iw, h: ih, drag: null
                };
                sec.style.display = 'flex';
                updateCropRectEl();
            }

            // Posiziona il rettangolo e le sue otto maniglie. Le maniglie sono figlie
            // del wrapper, non del rettangolo: il rettangolo ha un box-shadow enorme
            // che fa da maschera scura, e una maniglia dentro di lui ci finirebbe
            // sotto.
            function updateCropRectEl() {
                const rect = document.getElementById('materialCropRect');
                const c = _formState.crop;
                if (!rect || !c) return;
                const L = c.x * c.scale, T = c.y * c.scale;
                const W = c.w * c.scale, H = c.h * c.scale;
                rect.style.left = Math.round(L) + 'px';
                rect.style.top = Math.round(T) + 'px';
                rect.style.width = Math.round(W) + 'px';
                rect.style.height = Math.round(H) + 'px';
                const pos = {
                    nw: [L, T], n: [L + W / 2, T], ne: [L + W, T],
                    e: [L + W, T + H / 2], se: [L + W, T + H],
                    s: [L + W / 2, T + H], sw: [L, T + H], w: [L, T + H / 2]
                };
                const wrap = rect.parentNode;
                if (wrap && wrap.querySelectorAll) {
                    wrap.querySelectorAll('.material-crop-handle').forEach(h => {
                        const p = pos[h.dataset.handle];
                        if (!p) return;
                        h.style.left = Math.round(p[0]) + 'px';
                        h.style.top = Math.round(p[1]) + 'px';
                    });
                }
                const info = document.getElementById('materialCropInfo');
                if (info) {
                    info.textContent = t('matcreate.cropInfo', {
                        w: Math.round(c.w), h: Math.round(c.h)
                    });
                }
            }

            // Quale maniglia sta sotto il puntatore? Si decide dalla DISTANZA in pixel
            // di schermo, non da un hit test sui div: le maniglie hanno
            // pointer-events: none di proposito, perche' il canvas deve restare libero
            // di ricevere il trascinamento che disegna un rettangolo nuovo.
            function cropHandleAt(p, scaleScreen) {
                const c = _formState.crop;
                if (!c) return null;
                const tol = MATERIAL_CROP_GRAB_PX / (scaleScreen || 1);
                const nearX0 = Math.abs(p.x - c.x) <= tol;
                const nearX1 = Math.abs(p.x - (c.x + c.w)) <= tol;
                const nearY0 = Math.abs(p.y - c.y) <= tol;
                const nearY1 = Math.abs(p.y - (c.y + c.h)) <= tol;
                const inX = p.x >= c.x - tol && p.x <= c.x + c.w + tol;
                const inY = p.y >= c.y - tol && p.y <= c.y + c.h + tol;
                if (nearX0 && nearY0) return 'nw';
                if (nearX1 && nearY0) return 'ne';
                if (nearX0 && nearY1) return 'sw';
                if (nearX1 && nearY1) return 'se';
                if (nearY0 && inX) return 'n';
                if (nearY1 && inX) return 's';
                if (nearX0 && inY) return 'w';
                if (nearX1 && inY) return 'e';
                return null;
            }

            // Ridimensiona il rettangolo muovendo solo i bordi coinvolti, poi
            // NORMALIZZA: trascinando il bordo sinistro oltre il destro i due si
            // scambiano invece di produrre una larghezza negativa (che a valle
            // diventerebbe un ritaglio vuoto).
            function cropResize(handle, p) {
                const c = _formState.crop;
                if (!c) return;
                let x0 = c.x, y0 = c.y, x1 = c.x + c.w, y1 = c.y + c.h;
                if (handle.indexOf('w') >= 0) x0 = p.x;
                if (handle.indexOf('e') >= 0) x1 = p.x;
                if (handle.indexOf('n') >= 0) y0 = p.y;
                if (handle.indexOf('s') >= 0) y1 = p.y;
                c.x = Math.max(0, Math.min(x0, x1));
                c.y = Math.max(0, Math.min(y0, y1));
                c.w = Math.min(c.iw - c.x, Math.abs(x1 - x0));
                c.h = Math.min(c.ih - c.y, Math.abs(y1 - y0));
            }

            function cropPointFromEvent(ev, canvas) {
                const c = _formState.crop;
                const r = canvas.getBoundingClientRect();
                // getBoundingClientRect, non canvas.width: il CSS puo' rimpicciolire
                // il canvas (max-width:100%) e allora il fattore non e' c.scale.
                const kx = c.iw / (r.width || 1);
                const ky = c.ih / (r.height || 1);
                return {
                    x: Math.max(0, Math.min(c.iw, (ev.clientX - r.left) * kx)),
                    y: Math.max(0, Math.min(c.ih, (ev.clientY - r.top) * ky)),
                    // Quanti pixel di schermo vale un pixel immagine: serve alla
                    // tolleranza di presa delle maniglie.
                    screenScale: (r.width || 1) / c.iw
                };
            }

            // --- tela del pixel editor ----------------------------------------------
            // Il canvas VISIBILE e' anche il buffer: e' di w x h pixel veri (8..128) e
            // il CSS lo ingrandisce con image-rendering: pixelated. Cosi' un pixel
            // disegnato e' un pixel della texture, senza un secondo buffer da tenere
            // in sincronia -- che e' il posto dove questi editor divergono.
            //
            // La griglia e' un GRADIENTE CSS sopra la tela (.pixel-grid), non un
            // canvas: resta netta a ogni zoom senza ridisegnarsi, e non alloca un
            // buffer che a 64x sarebbe da decine di megabyte. Disegnarla invece
            // DENTRO il canvas dei pixel la farebbe finire nella texture.
            const ART_UNDO_MAX = 40;
            const ART_RECENT_MAX = 12;
            // Quanto e' grande la tela nel pannello laterale (lato lungo, in px).
            const ART_INLINE_MAX = 256;
            // I passi di zoom sono INTERI: un fattore frazionario spalmerebbe un
            // texel su un numero non intero di pixel dello schermo, e con
            // image-rendering: pixelated le colonne di pixel uscirebbero di larghezza
            // diversa (un reticolo irregolare che sembra un difetto del disegno).
            // Per lo stesso motivo la griglia in gradiente resta esatta: il passo e'
            // sempre un numero intero di px.
            const ART_ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

            let _art = {
                canvas: null,      // il canvas dei pixel (= #materialArtCanvas)
                ctx: null,
                undo: [],
                redo: [],
                tool: 'pencil',
                pen: '#E8C39E',
                recent: [],
                drawing: false,
                lastCell: null,
                zoom: 8,           // px di schermo per pixel della texture (finestra grande)
                spaceHeld: false,
                panning: null,
                // Griglia visibile: l'utente la spegne da checkbox. Sotto i 5 px
                // per cella resta comunque spenta (layoutArtStage), o le linee
                // coprirebbero il disegno.
                gridOn: true,
                // Buffer per-faccia (solo in faceMode 'six'): { px: {undo,redo,tex,snap}, ... }
                // La tela visibile e' SEMPRE una sola; allo switch si salva lo
                // snapshot della faccia uscente e si ripristina quella entrante.
                faceBuffers: null
            };

            function artSelectedSize() {
                const sel = document.getElementById('materialCanvasSize');
                const n = sel ? parseInt(sel.value, 10) : 16;
                return (isFinite(n) && n >= 4 && n <= 512) ? n : 16;
            }

            // Il colore di sfondo della tela nuova. Il trasparente NON e' un colore:
            // e' l'assenza di riempimento, quindi si ritorna null e chi disegna lascia
            // il canvas vuoto (che e' gia' trasparente).
            function artBackgroundColor() {
                const chk = document.getElementById('materialCanvasBgTransparent');
                if (chk && chk.checked) return null;
                const el = document.getElementById('materialCanvasBg');
                const v = el ? el.value : '';
                return MATERIAL_HEX_RE.test(v) ? v.toUpperCase() : '#8B5A2B';
            }

            function ensureArtCtx(w, h) {
                const cv = document.getElementById('materialArtCanvas');
                if (!cv) return null;
                if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
                _art.canvas = cv;
                _art.ctx = cv.getContext('2d');
                _art.ctx.imageSmoothingEnabled = false;
                return _art.ctx;
            }

            function resetArtCanvas() {
                _art.canvas = null;
                _art.ctx = null;
                _art.undo = [];
                _art.redo = [];
                _art.lastCell = null;
                updateArtHistoryBtns();
            }

            // `resetAllFaces` e' solo per "Nuova tela": le altre chiamate (setFormSource,
            // setFaceMode, resize senza canvas, openMaterialForm fallback) devono
            // creare/svuotare SOLO la faccia attiva. Senza il flag, un switch a six
            // con seed gia' copiato su tutte le facce le riazzererebbe al blank.
            function newArtCanvas(size, bgHex, resetAllFaces) {
                const ctx = ensureArtCtx(size, size);
                if (!ctx) return;
                ctx.clearRect(0, 0, size, size);
                if (bgHex) {
                    ctx.fillStyle = bgHex;
                    ctx.fillRect(0, 0, size, size);
                }
                _art.undo = [];
                _art.redo = [];
                updateArtHistoryBtns();
                layoutArtStage();
                commitArtToTexture();
                // In faceMode six "Nuova tela" riparte da zero su TUTTE le facce:
                // lasciare i buffer vecchi mescolerebbe un'attiva bianca con
                // disegni stantii sulle altre cinque.
                if (resetAllFaces && _formState.faceMode === 'six') {
                    ensureFaceBuffers();
                    const blank = _formState.pendingTexture
                        ? {
                            data: _formState.pendingTexture.data,
                            w: _formState.pendingTexture.w,
                            h: _formState.pendingTexture.h,
                            color: _formState.pendingTexture.color,
                            alpha: !!_formState.pendingTexture.alpha
                        }
                        : null;
                    const snap = artSnapshot();
                    MATERIAL_FACE_KEYS.forEach(fk => {
                        _art.faceBuffers[fk] = {
                            undo: [],
                            redo: [],
                            tex: blank ? {
                                data: blank.data, w: blank.w, h: blank.h,
                                color: blank.color, alpha: !!blank.alpha
                            } : null,
                            // snap solo sulla faccia attiva (e' la tela corrente);
                            // le altre lo ricostruiscono da tex al primo switch.
                            snap: (fk === _formState.activeFace) ? snap : null
                        };
                    });
                }
            }

            // Ricampiona la tela a una nuova dimensione tenendo il disegno. Passa da un
            // canvas d'appoggio perche' ridimensionare quello visibile lo AZZERA: in
            // canvas, assegnare width o height cancella il contenuto, quindi leggere i
            // pixel dopo il resize darebbe una tela vuota.
            function resizeArtCanvas(size) {
                if (!_art.canvas) { newArtCanvas(size, artBackgroundColor()); return; }
                const tmp = document.createElement('canvas');
                tmp.width = _art.canvas.width;
                tmp.height = _art.canvas.height;
                tmp.getContext('2d').drawImage(_art.canvas, 0, 0);
                pushArtUndo();
                const ctx = ensureArtCtx(size, size);
                if (!ctx) return;
                ctx.imageSmoothingEnabled = false;
                ctx.clearRect(0, 0, size, size);
                ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, size, size);
                layoutArtStage();
                commitArtToTexture();
                // In faceMode six le altre facce restano alla vecchia dimensione:
                // si ricampionano anche loro, o il cubo avrebbe lati a risoluzioni
                // diverse e in export le UV non tornerebbero.
                // Preferenza al percorso SINCRONO (snap ImageData): createImageBitmap
                // / Image.onload lascerebbero le facce a risoluzione vecchia se
                // l'utente salva a meta' del load. Con lo snap il resize e' immediato.
                if (_formState.faceMode === 'six' && _art.faceBuffers) {
                    MATERIAL_FACE_KEYS.forEach(fk => {
                        if (fk === _formState.activeFace) return;
                        const buf = _art.faceBuffers[fk];
                        if (!buf) return;
                        if (buf.snap && buf.snap.data) {
                            try {
                                const off = document.createElement('canvas');
                                off.width = size; off.height = size;
                                const octx = off.getContext('2d');
                                // Canvas d'appoggio alla vecchia dimensione: putImageData
                                // non ricampiona, drawImage si'.
                                const src = document.createElement('canvas');
                                src.width = buf.snap.w; src.height = buf.snap.h;
                                src.getContext('2d').putImageData(buf.snap.data, 0, 0);
                                octx.imageSmoothingEnabled = false;
                                octx.clearRect(0, 0, size, size);
                                octx.drawImage(src, 0, 0, size, size);
                                const t = textureFromCanvasCtx(off, octx);
                                buf.tex = {
                                    data: t.data, w: t.w, h: t.h,
                                    color: t.color, alpha: !!t.alpha
                                };
                                buf.snap = {
                                    w: size, h: size,
                                    data: octx.getImageData(0, 0, size, size)
                                };
                                buf.undo = [];
                                buf.redo = [];
                            } catch (e) { /* lascia com'e' */ }
                            return;
                        }
                        if (!buf.tex || !buf.tex.data) return;
                        // Nessuno snap: ricampiona da dataURL. Il gen del load
                        // principale non c'entra (non tocca la tela), ma se il
                        // form si chiude i buffer spariscono e l'onload no-op.
                        const img = new Image();
                        const faceKey = fk;
                        img.onload = () => {
                            if (!_art.faceBuffers || !_art.faceBuffers[faceKey]) return;
                            const b = _art.faceBuffers[faceKey];
                            const off = document.createElement('canvas');
                            off.width = size; off.height = size;
                            const octx = off.getContext('2d');
                            octx.imageSmoothingEnabled = false;
                            octx.clearRect(0, 0, size, size);
                            octx.drawImage(img, 0, 0, size, size);
                            try {
                                const t = textureFromCanvasCtx(off, octx);
                                b.tex = {
                                    data: t.data, w: t.w, h: t.h,
                                    color: t.color, alpha: !!t.alpha
                                };
                                b.snap = {
                                    w: size, h: size,
                                    data: octx.getImageData(0, 0, size, size)
                                };
                                b.undo = [];
                                b.redo = [];
                            } catch (e) { /* lascia com'e' */ }
                            refreshFormPreview();
                        };
                        img.src = buf.tex.data;
                    });
                    refreshFormPreview();
                }
            }

            // Riversa una texture esistente nella tela (modifica di un materiale). La
            // dimensione della tela diventa quella della texture, e il select si
            // allinea al preset piu' vicino: mostrare 16 mentre la tela e' 128
            // farebbe credere di star disegnando su una griglia grossa.
            //
            // `_artLoadGen` scarta i load superati: in faceMode six lo switch fra
            // facce lancia un Image() per ognuna, e senza il contatore un load
            // lento della faccia A finirebbe DOPO aver gia' mostrato B, coprendo
            // il disegno sbagliato (e un pennello nel frattempo dipingerebbe
            // sopra pixel che stanno per sparire). Stesso contatore in
            // closeMaterialForm / switchActiveFace.
            let _artLoadGen = 0;
            function loadArtFromTexture(tex) {
                if (!tex || !tex.data) return;
                const gen = ++_artLoadGen;
                // Faccia attesa al momento del load: se l'utente switcha prima
                // dell'onload, gen !== _artLoadGen (bump in switch) basta a
                // scartare. Qui si memorizza anche per aggiornare lo snap della
                // faccia giusta se nel frattempo faceMode e' six.
                const faceAtStart = _formState.activeFace;
                const img = new Image();
                img.onload = () => {
                    if (gen !== _artLoadGen) return;
                    const w = img.width || tex.w || 16;
                    const h = img.height || tex.h || 16;
                    const ctx = ensureArtCtx(w, h);
                    if (!ctx) return;
                    ctx.clearRect(0, 0, w, h);
                    ctx.drawImage(img, 0, 0);
                    _art.undo = [];
                    _art.redo = [];
                    updateArtHistoryBtns();
                    syncSizeSelectTo(Math.max(w, h));
                    layoutArtStage();
                    // pendingTexture allineato alla texture caricata: senza, un
                    // setFaceMode('six') subito dopo (commit non e' chiamato qui
                    // di proposito: ricomprimerebbe il PNG) seminerebbe da un
                    // pending stantio. Si riusa tex.data, non toDataURL.
                    _formState.pendingTexture = {
                        data: tex.data, w: w, h: h,
                        color: tex.color, alpha: !!tex.alpha
                    };
                    // In six: congela lo snap della faccia appena caricata, cosi'
                    // i prossimi switch usano artRestore sincrono invece di un
                    // altro Image.onload (e la race sparisce al secondo passaggio).
                    if (_formState.faceMode === 'six'
                        && faceAtStart === _formState.activeFace) {
                        ensureFaceBuffers();
                        const buf = _art.faceBuffers[faceAtStart] || {
                            undo: [], redo: [], tex: null, snap: null
                        };
                        buf.tex = {
                            data: tex.data, w: w, h: h,
                            color: tex.color, alpha: !!tex.alpha
                        };
                        buf.snap = artSnapshot();
                        buf.undo = [];
                        buf.redo = [];
                        _art.faceBuffers[faceAtStart] = buf;
                    }
                    refreshSourceUI();
                    refreshFormPreview();
                };
                img.onerror = () => { /* texture illeggibile: la tela resta com'e' */ };
                img.src = tex.data;
            }

            function syncSizeSelectTo(side) {
                const sel = document.getElementById('materialCanvasSize');
                if (!sel) return;
                let best = null, bestD = Infinity;
                for (let i = 0; i < sel.options.length; i++) {
                    const v = parseInt(sel.options[i].value, 10);
                    const d = Math.abs(v - side);
                    if (d < bestD) { bestD = d; best = sel.options[i].value; }
                }
                if (best !== null) sel.value = best;
            }

            // Ricampiona il ritaglio dentro la tela. Il lato lungo prende la dimensione
            // scelta e l'altro segue la PROPORZIONE del ritaglio: forzare il quadrato
            // schiaccerebbe una selezione larga, ed e' il difetto per cui una texture
            // sembra "sbagliata" pur essendo mappata bene.
            function artFromCrop() {
                const c = _formState.crop;
                if (!c || c.w < 1 || c.h < 1) return;
                const size = fitTextureSize(Math.round(c.w), Math.round(c.h), artSelectedSize());
                pushArtUndo();
                const ctx = ensureArtCtx(size.w, size.h);
                if (!ctx) return;
                ctx.imageSmoothingEnabled = false;
                ctx.clearRect(0, 0, size.w, size.h);
                ctx.drawImage(c.img, Math.round(c.x), Math.round(c.y),
                    Math.round(c.w), Math.round(c.h), 0, 0, size.w, size.h);
                layoutArtStage();
                commitArtToTexture();
            }

            // --- disposizione e zoom della tela --------------------------------------
            // UN SOLO punto decide quanto grande si vede il disegno: la dimensione in
            // px dello "stage". La tela e la griglia lo riempiono al 100%, quindi
            // restano allineate al pixel a qualunque zoom senza doversi accordare.
            //
            // Nel pannello laterale lo zoom e' calcolato (il lato lungo va a 256) e
            // arrotondato per DIFETTO a un intero: un fattore frazionario spalmerebbe
            // un texel su un numero non intero di pixel dello schermo, e con
            // image-rendering: pixelated si vedrebbero colonne di larghezza diversa.
            // Nella finestra grande lo zoom lo sceglie l'utente.
            //
            // C'e' un secondo livello di snap: il cell CSS deve coprire un numero
            // INTERO di device pixel. Con dpr frazionario (zoom del browser a 90%,
            // 110%...) un cell di 48 CSS px occupa 43.2 device px e le colonne
            // alternano 43/44 -- la griglia "buggata" del report. artCellCssSize
            // snappa il cell a interi device px e layoutArtStage lo usa ovunque.
            function artInlineZoom(w, h) {
                return Math.max(1, Math.floor(ART_INLINE_MAX / Math.max(w, h)));
            }

            // Cell size in CSS px, snappato a interi device pixel. `z` e' lo zoom
            // logico (passi ART_ZOOMS o artInlineZoom). Ritorna lo stesso valore
            // per stage, griglia e cursore: se divergessero le celle non
            // coinciderebbero piu' coi texel.
            function artCellCssSize(z) {
                const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
                const zDev = Math.max(1, Math.round(z * dpr));
                return zDev / dpr;
            }

            function layoutArtStage() {
                const stage = document.getElementById('materialArtStage');
                if (!stage || !_art.canvas) return;
                const w = _art.canvas.width, h = _art.canvas.height;
                const zLogic = artEditorIsOpen() ? _art.zoom : artInlineZoom(w, h);
                const cell = artCellCssSize(zLogic);
                stage.style.width = (w * cell) + 'px';
                stage.style.height = (h * cell) + 'px';
                const grid = document.getElementById('materialArtGrid');
                if (grid) {
                    grid.style.setProperty('--cell', cell + 'px');
                    // 1 device pixel di spessore, espresso in CSS: a dpr 2 la linea
                    // resta di 1 px fisico invece di 2 CSS (che a retina sembrerebbe
                    // grossa il doppio).
                    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
                    grid.style.setProperty('--line-w', (1 / dpr) + 'px');
                    // Sotto i 5 px per cella le linee sarebbero fitte quanto i pixel e
                    // la tela diventerebbe un reticolo grigio in cui non si vede piu'
                    // il disegno. Il toggle utente (_art.gridOn) ha la precedenza.
                    grid.classList.toggle('hidden', !_art.gridOn || cell < 5);
                }
                // Il riquadro dell'anteprima e' misurato in px: cambiando zoom va
                // rimesso in scala, o resterebbe grande quanto una cella di prima.
                updateArtCursorEl();
                updateZoomUI();
            }

            function updateZoomUI() {
                const lab = document.getElementById('materialZoomLabel');
                if (lab) lab.textContent = Math.round(_art.zoom * 100) + '%';
                const size = document.getElementById('materialEditorSize');
                if (size && _art.canvas) {
                    size.textContent = t('matcreate.editorSize', {
                        w: _art.canvas.width, h: _art.canvas.height
                    });
                }
                const vp = document.getElementById('materialArtViewport');
                if (vp && _art.canvas) {
                    // "Si puo' spostare" = la tela non ci sta tutta. Serve al cursore
                    // a manina: mostrarlo quando non c'e' niente da spostare
                    // prometterebbe un'azione che non fa nulla.
                    // Si usa la cella CSS snappata (non _art.zoom grezzo): e' la
                    // dimensione REALE dello stage, quella che decide se scorre.
                    const cell = artCellCssSize(_art.zoom);
                    const over = _art.canvas.width * cell > vp.clientWidth
                        || _art.canvas.height * cell > vp.clientHeight;
                    vp.classList.toggle('pannable', over || _art.spaceHeld);
                }
                // Allinea il checkbox della griglia allo stato (il nodo viaggia
                // fra pannello e finestra grande, ma e' sempre lo stesso).
                const gTog = document.getElementById('materialArtGridToggle');
                if (gTog) gTog.checked = !!_art.gridOn;
            }

            // Imposta lo zoom tenendo fermo un punto: senza ancora, ingrandire porta
            // via da sotto il puntatore la zona che si stava guardando, ed e' la
            // differenza fra uno zoom usabile e uno da rifare a mano ogni volta.
            // `anchor` e' {clientX, clientY}; assente, si ancora al centro.
            function setArtZoom(z, anchor) {
                const vp = document.getElementById('materialArtViewport');
                const stage = document.getElementById('materialArtStage');
                const next = Math.min(ART_ZOOMS[ART_ZOOMS.length - 1],
                    Math.max(ART_ZOOMS[0], z));
                if (!vp || !stage || !_art.canvas) { _art.zoom = next; return; }
                const vpBox = vp.getBoundingClientRect();
                const ax = anchor ? anchor.clientX : vpBox.left + vp.clientWidth / 2;
                const ay = anchor ? anchor.clientY : vpBox.top + vp.clientHeight / 2;
                // Il texel sotto l'ancora, PRIMA di cambiare zoom. Si usa la
                // cella CSS snappata (non _art.zoom grezzo): e' la dimensione
                // reale dello stage, e con dpr frazionario le due divergono.
                const cellBefore = artCellCssSize(_art.zoom);
                const stBox = stage.getBoundingClientRect();
                const tx = (ax - stBox.left) / cellBefore;
                const ty = (ay - stBox.top) / cellBefore;

                _art.zoom = next;
                layoutArtStage();

                // Rimettere quel texel sotto l'ancora. Lo stage e' centrato da
                // `margin: auto` finche' ci sta, quindi l'offset dentro il contenuto
                // scorrevole non e' zero e va rimesso nel conto.
                const cellAfter = artCellCssSize(next);
                const w = _art.canvas.width * cellAfter, h = _art.canvas.height * cellAfter;
                const offX = Math.max(0, (vp.clientWidth - w) / 2);
                const offY = Math.max(0, (vp.clientHeight - h) / 2);
                vp.scrollLeft = offX + tx * cellAfter - (ax - vpBox.left);
                vp.scrollTop = offY + ty * cellAfter - (ay - vpBox.top);
                updateZoomUI();
            }

            function stepArtZoom(dir, anchor) {
                let i = 0;
                while (i < ART_ZOOMS.length && ART_ZOOMS[i] <= _art.zoom) i++;
                // `i` e' il primo passo STRETTAMENTE maggiore dello zoom attuale.
                const idx = (dir > 0) ? Math.min(ART_ZOOMS.length - 1, i)
                    : Math.max(0, i - 2);
                setArtZoom(ART_ZOOMS[idx], anchor);
            }

            function artZoomToFit() {
                const vp = document.getElementById('materialArtViewport');
                if (!vp || !_art.canvas) return;
                // -24: un margine, o la tela tocca i bordi e non si capisce dove
                // finisce.
                const kx = (vp.clientWidth - 24) / _art.canvas.width;
                const ky = (vp.clientHeight - 24) / _art.canvas.height;
                const k = Math.max(1, Math.floor(Math.min(kx, ky)));
                setArtZoom(k, null);
            }


            // --- storia della tela ---------------------------------------------------
            // Snapshot di ImageData: per una tela di 128x128 sono 64 KB, quindi 40
            // passi stanno in 2.6 MB. Su tele piu' grandi il tetto e' comunque quello,
            // ed e' il motivo per cui la dimensione massima resta 128.
            function pushArtUndo() {
                if (!_art.ctx || !_art.canvas) return;
                try {
                    _art.undo.push({
                        w: _art.canvas.width, h: _art.canvas.height,
                        data: _art.ctx.getImageData(0, 0, _art.canvas.width, _art.canvas.height)
                    });
                } catch (e) { return; }
                if (_art.undo.length > ART_UNDO_MAX) _art.undo.shift();
                // Una modifica nuova invalida il futuro: tenere il redo dopo di essa
                // permetterebbe di "ripetere" un tratto costruito su pixel che non ci
                // sono piu'.
                _art.redo = [];
                updateArtHistoryBtns();
            }

            // --- finestra grande della tela ------------------------------------------
            // Non duplica niente: alla tela e ai suoi comandi si cambia GENITORE e alla
            // chiusura tornano dov'erano. Spostare un <canvas> nel DOM ne conserva il
            // contenuto, quindi il disegno non passa da un'immagine intermedia e non
            // esiste un secondo editor da tenere allineato al primo -- che sarebbe il
            // modo ovvio di farlo e anche quello che diverge alla prima modifica.
            //
            // La posizione di partenza si ricorda sul nodo stesso (parent + fratello
            // successivo), cosi' il ritorno e' esatto anche se in mezzo il form ha
            // mostrato o nascosto altre sezioni.
            function artHomeSave(node) {
                if (!node || node._artHome) return;
                node._artHome = { parent: node.parentNode, next: node.nextSibling };
            }

            function artHomeRestore(node) {
                const home = node && node._artHome;
                if (!home || !home.parent) return;
                // Il fratello ricordato puo' essere stato spostato a sua volta: in quel
                // caso insertBefore solleverebbe, quindi si ricade in fondo al genitore.
                const ref = (home.next && home.next.parentNode === home.parent) ? home.next : null;
                home.parent.insertBefore(node, ref);
                node._artHome = null;
            }

            function artEditorIsOpen() {
                const ov = document.getElementById('materialEditorOverlay');
                return !!ov && ov.style.display !== 'none';
            }

            function openArtEditor() {
                const ov = document.getElementById('materialEditorOverlay');
                const vp = document.getElementById('materialArtViewport');
                const side = document.getElementById('materialEditorSide');
                const wrap = document.getElementById('materialArtWrap');
                const tools = document.getElementById('materialArtTools');
                const setup = document.getElementById('materialCanvasSetup');
                if (!ov || !vp || !side || !wrap || !tools) return;
                if (!_art.canvas) newArtCanvas(artSelectedSize(), artBackgroundColor());

                [wrap, tools, setup].forEach(artHomeSave);
                vp.appendChild(wrap);
                // La scelta della dimensione viene portata dentro: da dietro la
                // finestra non sarebbe raggiungibile, e cambiare misura e' parte del
                // disegnare.
                if (setup) { side.appendChild(setup); setup.style.display = 'flex'; }
                side.appendChild(tools);

                const detached = document.getElementById('materialArtDetached');
                if (detached) detached.style.display = 'flex';
                const expand = document.getElementById('materialArtExpandBtn');
                if (expand) expand.style.display = 'none';

                ov.style.display = 'flex';
                // Lo zoom si calcola DOPO aver mostrato l'overlay: a display:none il
                // viewport misura 0 e "adatta" darebbe sempre il minimo.
                artZoomToFit();
                layoutArtStage();
            }

            function closeArtEditor() {
                const ov = document.getElementById('materialEditorOverlay');
                if (!ov) return;
                ov.style.display = 'none';
                ['materialArtWrap', 'materialArtTools', 'materialCanvasSetup'].forEach(id => {
                    artHomeRestore(document.getElementById(id));
                });
                // La sezione della dimensione torna visibile solo se la sorgente la
                // prevede: refreshSourceUI e' il solo punto che lo sa.
                const detached = document.getElementById('materialArtDetached');
                if (detached) detached.style.display = 'none';
                const expand = document.getElementById('materialArtExpandBtn');
                if (expand) expand.style.display = '';
                refreshSourceUI();
                layoutArtStage();
            }

            function artSnapshot() {
                if (!_art.ctx || !_art.canvas) return null;
                try {
                    return {
                        w: _art.canvas.width, h: _art.canvas.height,
                        data: _art.ctx.getImageData(0, 0, _art.canvas.width, _art.canvas.height)
                    };
                } catch (e) { return null; }
            }

            function artRestore(snap) {
                if (!snap) return;
                const ctx = ensureArtCtx(snap.w, snap.h);
                if (!ctx) return;
                ctx.putImageData(snap.data, 0, 0);
                layoutArtStage();
                commitArtToTexture();
            }

            function artUndo() {
                if (!_art.undo.length) return;
                const cur = artSnapshot();
                const prev = _art.undo.pop();
                if (cur) _art.redo.push(cur);
                artRestore(prev);
                updateArtHistoryBtns();
            }

            function artRedo() {
                if (!_art.redo.length) return;
                const cur = artSnapshot();
                const next = _art.redo.pop();
                if (cur) _art.undo.push(cur);
                artRestore(next);
                updateArtHistoryBtns();
            }

            function updateArtHistoryBtns() {
                const u = document.getElementById('materialArtUndoBtn');
                const r = document.getElementById('materialArtRedoBtn');
                if (u) u.disabled = !_art.undo.length;
                if (r) r.disabled = !_art.redo.length;
            }

            // --- strumenti -----------------------------------------------------------
            // La radice da cui si cercano i bottoni e' #materialArtTools, NON
            // #materialDrawSection: aprendo la finestra grande i comandi vengono
            // spostati fuori dalla sezione, quindi cercarli da li' non trovava piu'
            // nulla e i tasti Gomma/Riempi/Preleva restavano inerti (la Matita
            // sembrava funzionare solo perche' e' quella attiva per difetto).
            // Cercare dal nodo che VIAGGIA coi bottoni vale in tutte e due i posti.
            function setArtTool(tool) {
                _art.tool = ['pencil', 'eraser', 'fill', 'pick'].indexOf(tool) >= 0 ? tool : 'pencil';
                const row = document.getElementById('materialArtTools');
                if (row && row.querySelectorAll) {
                    // Solo i bottoni strumento (data-pixeltool): lo switcher delle
                    // facce riusa `.pixel-tool-btn` con data-face, e senza questo
                    // filtro un cambio matita/gomma spegneva l'highlight della
                    // faccia attiva fino al prossimo refreshSourceUI.
                    row.querySelectorAll('.pixel-tool-btn[data-pixeltool]').forEach(b => {
                        b.classList.toggle('active', b.dataset.pixeltool === _art.tool);
                    });
                }
                updateArtCursorEl();
            }

            // Colore del PENNELLO. Non tocca la tinta unita / lo sfondo della tela:
            // sono due valori distinti (il pennello dipinge, lo sfondo e' il
            // colore del materiale flat). Prima erano sincronizzati, e
            // scegliere un colore da disegnare cambiava la tinta del materiale.
            //
            // `remember` lo mette fra le tinte recenti (usato dopo una pennellata
            // o un prelievo, non a ogni movimento del picker: altrimenti la
            // tavolozza si riempirebbe di tinte intermedie del trascinamento).
            function setPenColor(hex, remember) {
                if (!MATERIAL_HEX_RE.test(hex || '')) return;
                _art.pen = hex.toUpperCase();
                const picker = document.getElementById('materialPenColor');
                if (picker) picker.value = _art.pen;
                const label = document.getElementById('materialPenHex');
                if (label) label.textContent = _art.pen;
                if (remember) {
                    // La tinta usata va in testa e le doppie si tolgono: una tavolozza
                    // che ripete lo stesso colore sei volte non aiuta a ritrovarlo.
                    _art.recent = [_art.pen].concat(_art.recent.filter(c => c !== _art.pen))
                        .slice(0, ART_RECENT_MAX);
                }
                renderPenSwatches();
                updateArtCursorEl();
            }

            function renderPenSwatches() {
                const box = document.getElementById('materialPenSwatches');
                if (!box) return;
                box.innerHTML = '';
                _art.recent.forEach(hex => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'pixel-swatch' + (hex === _art.pen ? ' active' : '');
                    b.style.background = hex;
                    b.title = hex;
                    b.addEventListener('click', () => setPenColor(hex, false));
                    box.appendChild(b);
                });
            }

            // --- anteprima della cella sotto il puntatore ---------------------------
            // Mostra DOVE si sta per dipingere e con quale colore. Su una tela
            // ingrandita il puntatore del sistema copre proprio il pixel che si mira,
            // e senza questo riquadro si scopre di aver sbagliato cella solo dopo
            // aver dipinto.
            //
            // E' un div dentro lo stage, non un disegno sul canvas: disegnarlo sulla
            // tela lo farebbe finire nella texture, e cancellarlo richiederebbe di
            // ridipingere la cella sotto ogni volta che il puntatore si muove.
            let _artHoverCell = null;

            function updateArtCursorEl() {
                const cur = document.getElementById('materialArtCursor');
                if (!cur) return;
                if (!_artHoverCell || !_art.canvas) {
                    cur.classList.remove('visible');
                    return;
                }
                // Stessa cella snappata di layoutArtStage: se divergesse, il
                // riquadro non coprirebbe piu' il texel sotto il puntatore.
                const zLogic = artEditorIsOpen()
                    ? _art.zoom
                    : artInlineZoom(_art.canvas.width, _art.canvas.height);
                const z = artCellCssSize(zLogic);
                cur.classList.add('visible');
                cur.style.left = (_artHoverCell.x * z) + 'px';
                cur.style.top = (_artHoverCell.y * z) + 'px';
                cur.style.width = z + 'px';
                cur.style.height = z + 'px';
                // La gomma e il contagocce non posano un colore: mostrarne uno
                // prometterebbe un'azione diversa da quella che fanno.
                const paints = (_art.tool === 'pencil' || _art.tool === 'fill');
                cur.style.background = paints ? _art.pen : 'transparent';
                cur.className = 'pixel-cursor visible tool-' + _art.tool;
            }

            function setArtHoverCell(cell) {
                const same = (!cell && !_artHoverCell)
                    || (cell && _artHoverCell && cell.x === _artHoverCell.x && cell.y === _artHoverCell.y);
                if (same) return;
                _artHoverCell = cell;
                updateArtCursorEl();
            }

            function artCellFromEvent(ev) {
                const cv = _art.canvas;
                if (!cv) return null;
                const r = cv.getBoundingClientRect();
                if (!r.width || !r.height) return null;
                const x = Math.floor(((ev.clientX - r.left) / r.width) * cv.width);
                const y = Math.floor(((ev.clientY - r.top) / r.height) * cv.height);
                if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return null;
                return { x: x, y: y };
            }

            function artPaintCell(x, y) {
                const ctx = _art.ctx;
                if (!ctx) return;
                if (_art.tool === 'eraser') {
                    ctx.clearRect(x, y, 1, 1);
                } else {
                    // clearRect prima di fillRect: fillRect FONDE col pixel esistente,
                    // quindi dipingere un colore opaco sopra un pixel semitrasparente
                    // darebbe una tinta mista invece del colore scelto.
                    ctx.clearRect(x, y, 1, 1);
                    ctx.fillStyle = _art.pen;
                    ctx.fillRect(x, y, 1, 1);
                }
            }

            function artPickCell(x, y) {
                const ctx = _art.ctx;
                if (!ctx) return;
                let px;
                try { px = ctx.getImageData(x, y, 1, 1).data; } catch (e) { return; }
                // Un pixel trasparente non ha un colore da prelevare: si passa alla
                // gomma, che e' l'azione che quel pixel rappresenta.
                if (px[3] === 0) { setArtTool('eraser'); return; }
                const hx = v => v.toString(16).toUpperCase().padStart(2, '0');
                setPenColor('#' + hx(px[0]) + hx(px[1]) + hx(px[2]), true);
                setArtTool('pencil');
            }

            // Riempimento dell'area contigua a 4 vicini. Lavora su un solo ImageData
            // (una lettura e una scrittura): una fillRect per cella farebbe migliaia di
            // chiamate di canvas per un riempimento grande.
            //
            // Il confronto include l'ALPHA, cosi' riempire una zona trasparente
            // funziona invece di essere un no-op -- ed e' il caso piu' comune, perche'
            // e' come si da' uno sfondo a un disegno cominciato su tela vuota.
            //
            // TOLLERANZA. Il confronto ESATTO funziona solo su una tela disegnata a
            // mano, dove le tinte sono poche e identiche. Su un'immagine importata
            // (che passa da un ricampionamento, quindi da un'interpolazione) due pixel
            // adiacenti dello stesso "colore" differiscono di qualche unita': il
            // riempimento si fermava dopo pochi pixel e lasciava un alone, che e' il
            // "non funziona al meglio". Si confronta quindi la distanza di Chebyshev
            // sui 4 canali contro una soglia regolabile.
            //
            // I pixel gia' riempiti vanno segnati a parte (`done`): con la tolleranza
            // il colore nuovo puo' rientrare nella soglia del vecchio, e senza un
            // segno esplicito la stessa cella verrebbe rimessa in pila all'infinito.
            // Col confronto esatto non serviva, perche' il colore scritto non poteva
            // piu' somigliare a quello cercato.
            function artFillTolerance() {
                const el = document.getElementById('materialFillTolerance');
                const n = el ? parseInt(el.value, 10) : 24;
                return isFinite(n) ? Math.max(0, Math.min(255, n)) : 24;
            }

            function artFloodFill(sx, sy) {
                const ctx = _art.ctx, cv = _art.canvas;
                if (!ctx || !cv) return;
                let img;
                try { img = ctx.getImageData(0, 0, cv.width, cv.height); } catch (e) { return; }
                const d = img.data, W = cv.width, H = cv.height;
                const at = (x, y) => (y * W + x) * 4;
                const s = at(sx, sy);
                const t0 = [d[s], d[s + 1], d[s + 2], d[s + 3]];
                let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
                if (_art.tool !== 'eraser') {
                    const hex = _art.pen;
                    n0 = parseInt(hex.substr(1, 2), 16);
                    n1 = parseInt(hex.substr(3, 2), 16);
                    n2 = parseInt(hex.substr(5, 2), 16);
                    n3 = 255;
                }
                // Sorgente e destinazione identiche: non ci sarebbe niente da fare, e
                // la pila girerebbe a vuoto sull'intera area.
                if (t0[0] === n0 && t0[1] === n1 && t0[2] === n2 && t0[3] === n3) return;
                const tol = artFillTolerance();
                // Un pixel completamente trasparente non ha colore: confrontarne RGB
                // e' senza senso (il canvas ci lascia dentro valori arbitrari), quindi
                // fra due trasparenti conta solo che lo siano entrambi.
                const alike = (i) => {
                    if (t0[3] === 0) return d[i + 3] === 0;
                    if (d[i + 3] === 0) return false;
                    return Math.abs(d[i] - t0[0]) <= tol
                        && Math.abs(d[i + 1] - t0[1]) <= tol
                        && Math.abs(d[i + 2] - t0[2]) <= tol
                        && Math.abs(d[i + 3] - t0[3]) <= tol;
                };
                const done = new Uint8Array(W * H);
                const stack = [sx, sy];
                while (stack.length) {
                    const y = stack.pop(), x = stack.pop();
                    if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    const p = y * W + x;
                    if (done[p]) continue;
                    const i = p * 4;
                    if (!alike(i)) continue;
                    done[p] = 1;
                    d[i] = n0; d[i + 1] = n1; d[i + 2] = n2; d[i + 3] = n3;
                    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
                }
                ctx.putImageData(img, 0, 0);
            }

            // La tela diventa la texture del form. Si chiama alla FINE di un tratto,
            // non a ogni cella: toDataURL comprime un PNG, che a ogni movimento del
            // puntatore bloccherebbe il thread.
            //
            // In faceMode 'six' aggiorna anche il buffer della faccia attiva: e'
            // l'unica sorgente da cui formDefinition legge le facce non attive.
            function commitArtToTexture() {
                const cv = _art.canvas, ctx = _art.ctx;
                if (!cv || !ctx) return;
                let tex;
                try {
                    tex = textureFromCanvasCtx(cv, ctx);
                } catch (e) { return; }
                _formState.pendingTexture = tex;
                if (_formState.faceMode === 'six') {
                    ensureFaceBuffers();
                    const buf = _art.faceBuffers[_formState.activeFace] || {
                        undo: [], redo: [], tex: null, snap: null
                    };
                    buf.tex = {
                        data: tex.data, w: tex.w, h: tex.h,
                        color: tex.color, alpha: !!tex.alpha
                    };
                    _art.faceBuffers[_formState.activeFace] = buf;
                }
                refreshSourceUI();
                refreshFormPreview();
            }

            // --- facce del cubo (single / six) --------------------------------------
            // La tela visibile e' SEMPRE una sola: allo switch si salva lo snapshot
            // (ImageData + texture) della faccia uscente e si ripristina quella
            // entrante. Cosi' non esistono 6 canvas da tenere allineati, che e' il
            // posto dove questi editor divergono.
            function ensureFaceBuffers() {
                if (_art.faceBuffers) return;
                _art.faceBuffers = {};
                MATERIAL_FACE_KEYS.forEach(fk => {
                    _art.faceBuffers[fk] = { undo: [], redo: [], tex: null, snap: null };
                });
            }

            // Salva lo stato corrente della tela nel buffer della faccia attiva
            // (ImageData per undo/redo per-faccia + texture per formDefinition).
            function stashActiveFace() {
                if (_formState.faceMode !== 'six') return;
                ensureFaceBuffers();
                const fk = _formState.activeFace;
                const buf = _art.faceBuffers[fk] || {
                    undo: [], redo: [], tex: null, snap: null
                };
                buf.snap = artSnapshot();
                buf.undo = _art.undo.slice();
                buf.redo = _art.redo.slice();
                if (_art.canvas && _art.ctx) {
                    try {
                        const tex = textureFromCanvasCtx(_art.canvas, _art.ctx);
                        buf.tex = {
                            data: tex.data, w: tex.w, h: tex.h,
                            color: tex.color, alpha: !!tex.alpha
                        };
                    } catch (e) { /* lascia tex com'e' */ }
                }
                _art.faceBuffers[fk] = buf;
            }

            function switchActiveFace(faceKey) {
                if (MATERIAL_FACE_KEYS.indexOf(faceKey) < 0) return;
                if (faceKey === _formState.activeFace && _formState.faceMode === 'six') {
                    refreshSourceUI();
                    return;
                }
                // Prima di lasciare la faccia attuale se ne salva lo stato, o
                // tornandoci si ritroverebbe il disegno di un'altra.
                if (_formState.faceMode === 'six') stashActiveFace();
                _formState.activeFace = faceKey;
                _formState.faceMode = 'six';
                ensureFaceBuffers();
                // Invalida qualunque loadArtFromTexture ancora in volo: se la
                // faccia entrante ha uno snap (sync) o e' vuota, un onload
                // tardivo della faccia uscente riscriverebbe la tela sbagliata.
                _artLoadGen++;
                const buf = _art.faceBuffers[faceKey];
                if (buf && buf.snap) {
                    // Ripristina ImageData + pile undo/redo di quella faccia.
                    // artRestore chiama commitArtToTexture, che aggiorna
                    // pendingTexture e faceBuffers[activeFace] dalla tela.
                    artRestore(buf.snap);
                    _art.undo = (buf.undo || []).slice();
                    _art.redo = (buf.redo || []).slice();
                    updateArtHistoryBtns();
                } else if (buf && buf.tex && buf.tex.data) {
                    // Prima visita di una faccia caricata da un materiale salvato:
                    // c'e' la texture ma non lo snapshot (lazy). loadArtFromTexture
                    // e' async: pendingTexture va impostato SUBITO, altrimenti
                    // l'anteprima e formDefinition resterebbero sulla faccia
                    // precedente finche' l'immagine non arriva.
                    _formState.pendingTexture = {
                        data: buf.tex.data, w: buf.tex.w, h: buf.tex.h,
                        color: buf.tex.color, alpha: !!buf.tex.alpha
                    };
                    loadArtFromTexture(buf.tex);
                    _art.undo = [];
                    _art.redo = [];
                    updateArtHistoryBtns();
                } else {
                    // Faccia ancora vuota: tela nuova con lo sfondo corrente.
                    // NON si chiama newArtCanvas(..., true) perche' quello azzera
                    // TUTTE le facce; qui serve solo la attiva.
                    const size = artSelectedSize();
                    const ctx = ensureArtCtx(size, size);
                    if (ctx) {
                        ctx.clearRect(0, 0, size, size);
                        const bg = artBackgroundColor();
                        if (bg) {
                            ctx.fillStyle = bg;
                            ctx.fillRect(0, 0, size, size);
                        }
                        _art.undo = [];
                        _art.redo = [];
                        updateArtHistoryBtns();
                        layoutArtStage();
                        commitArtToTexture();
                    }
                }
                // pendingTexture = faccia attiva (per UV section e formDefinition).
                // Si rilegge il buffer DOPO restore/commit: il `buf` preso sopra
                // puo' avere un tex stantio (o null su faccia vuota), mentre
                // commitArtToTexture ha appena scritto quello fresco.
                const fresh = _art.faceBuffers && _art.faceBuffers[faceKey];
                if (fresh && fresh.tex) _formState.pendingTexture = fresh.tex;
                refreshSourceUI();
                refreshFormPreview();
            }

            function setFaceMode(mode) {
                const next = (mode === 'six') ? 'six' : 'single';
                if (next === _formState.faceMode) {
                    refreshSourceUI();
                    return;
                }
                if (next === 'six') {
                    // Da single a six: la texture corrente diventa il punto di
                    // partenza di TUTTE le facce (l'utente le differenzia dopo).
                    // Senza, le 5 facce non attive resterebbero vuote e il cubo
                    // apparirebbe a pezzi.
                    //
                    // stashActiveFace e' un no-op finche' faceMode non e' 'six',
                    // quindi si forza un commit della tela ORA: altrimenti un
                    // disegno ancora solo sul canvas (es. loadArtFromTexture non
                    // richiama commit) non entrerebbe nel seed e le 5 facce
                    // copiate resterebbero vuote / sulla texture stantia.
                    // Poi si alza faceMode e si fa stash vero (snap+undo), cosi'
                    // la faccia attiva ha anche lo snapshot sincrono, non solo tex.
                    if (_art.canvas && _art.ctx) commitArtToTexture();
                    ensureFaceBuffers();
                    const seed = _formState.pendingTexture
                        || (_art.faceBuffers[_formState.activeFace]
                            && _art.faceBuffers[_formState.activeFace].tex)
                        || null;
                    _formState.faceMode = 'six';
                    if (_art.canvas && _art.ctx) stashActiveFace();
                    if (seed) {
                        MATERIAL_FACE_KEYS.forEach(fk => {
                            if (!_art.faceBuffers[fk].tex) {
                                _art.faceBuffers[fk].tex = {
                                    data: seed.data, w: seed.w, h: seed.h,
                                    color: seed.color, alpha: !!seed.alpha
                                };
                            }
                        });
                        _formState.pendingTexture = {
                            data: seed.data, w: seed.w, h: seed.h,
                            color: seed.color, alpha: !!seed.alpha
                        };
                    }
                    // Se non c'e' ancora una tela: con un seed si carica quello
                    // (newArtCanvas in six mode azzera TUTTE le facce, e qui
                    // le abbiamo appena seminate). Senza seed si parte bianchi.
                    if (!_art.canvas) {
                        if (seed) loadArtFromTexture(seed);
                        else newArtCanvas(artSelectedSize(), artBackgroundColor());
                    }
                } else {
                    // Da six a single: la faccia attiva diventa LA texture.
                    stashActiveFace();
                    _formState.faceMode = 'single';
                    // I buffer restano in memoria finche' il form e' aperto: tornare
                    // a six non deve perdere i disegni. Si liberano in closeMaterialForm.
                }
                refreshSourceUI();
                refreshFormPreview();
            }

            // --- salvataggio --------------------------------------------------------
            // In modifica SOSTITUISCE: updateMaterial muta la voce esistente, quindi la
            // lista non cresce e i voxel che citavano l'id continuano a citarlo. Il
            // ramo addMaterial vale solo per la creazione (o per un id svanito sotto i
            // piedi), non e' una via che una modifica normale possa prendere.
            function saveMaterialFromForm() {
                // In faceMode six la faccia attiva potrebbe non essere ancora
                // finita nei buffer (ultimo tratto gia' in pendingTexture, ma
                // snap/undo no): si fa stash prima di leggere formDefinition.
                if (_formState.faceMode === 'six') stashActiveFace();
                const def = formDefinition();
                if (!def.name) { alert(t('materials.nameRequired')); return; }
                let mat;
                if (_formState.editingId) {
                    mat = updateMaterial(_formState.editingId, def);
                    // Sparito sotto i piedi (eliminato da un'altra via): si aggiunge
                    // invece di perdere quello che l'utente ha appena scritto.
                    if (!mat) mat = addMaterial(def);
                } else {
                    mat = addMaterial(def);
                }
                // Dopo una modifica la cache tiene ancora la texture e i parametri
                // vecchi: senza svuotarla il modello non cambia aspetto.
                clearMaterialCache();
                closeMaterialForm();
                renderMaterialsPanel();
                setActiveMaterialAndSync(mat.id);
                if (typeof buildModel === 'function') buildModel(false);
            }

            // La libreria personale si riempie SOLO da qui: creare un materiale non ci
            // mette niente dentro. Prima ogni creazione la scriveva, e in una sessione
            // di prove la libreria si intasava di materiali usa-e-getta (e a 40 voci
            // cominciava a rifiutare quelli che si volevano tenere davvero).
            //
            // Si salva una COPIA normalizzata: il materiale del progetto puo' essere
            // modificato o eliminato, la voce in libreria no.
            function saveFormToLibrary() {
                // Stesso stash di saveMaterialFromForm: senza, la faccia attiva
                // resterebbe solo in pendingTexture e la copia in libreria
                // perderebbe l'ultimo tratto.
                if (_formState.faceMode === 'six') stashActiveFace();
                const def = formDefinition();
                if (!def.name) { alert(t('materials.nameRequired')); return; }
                const lib = loadMaterialLibrary();
                if (lib.length >= MATERIAL_LIB_MAX) {
                    alert(t('materials.libraryFull', { max: MATERIAL_LIB_MAX }));
                    return;
                }
                // L'id serve solo come chiave locale della libreria: all'import viene
                // rinumerato comunque (vedi renderMaterialLibrary).
                lib.push(normalizeMaterial(def, nextMaterialId(lib.map(m => m && m.id))));
                saveMaterialLibrary(lib);
                renderMaterialLibrary();
            }

            // Tutti gli handler si agganciano QUI, una volta sola, e leggono
            // _formState / _art: vedi il commento in testa al form. Riagganciarli a
            // ogni apertura li accumulava, perche' addEventListener aggiunge e non
            // sostituisce.
            (function initMaterialsPanel() {
                // Fuori da una pagina non c'e' niente da agganciare: vedi hasPanelDom.
                if (!hasPanelDom()) return;
                const newBtn = document.getElementById('newMaterialBtn');
                const cancelBtn = document.getElementById('materialCancelBtn');
                if (!newBtn || !cancelBtn) return;   // pagina senza il pannello (es. settings.html)

                const on = (id, ev, fn) => {
                    const el = document.getElementById(id);
                    if (el) el.addEventListener(ev, fn);
                };

                newBtn.addEventListener('click', () => {
                    // Ri-cliccarlo a form aperto in creazione lo chiude. In MODIFICA
                    // no: lo riapre pulito, perche' chi lo premette mentre corregge un
                    // materiale sta chiedendo di crearne un altro.
                    if (materialFormIsOpen() && !_formState.editingId) closeMaterialForm();
                    else openMaterialForm(null);
                });
                cancelBtn.addEventListener('click', closeMaterialForm);

                on('materialSaveBtn', 'click', saveMaterialFromForm);
                on('materialSaveToLibBtn', 'click', saveFormToLibrary);

                // Sorgente della texture.
                const seg = document.getElementById('materialSourceSeg');
                if (seg) {
                    seg.addEventListener('click', ev => {
                        const b = ev.target.closest ? ev.target.closest('.seg-btn') : null;
                        if (b && b.dataset.source) setFormSource(b.dataset.source);
                    });
                }

                // Forma dell'anteprima + drag/hover (una volta sola).
                initPreviewInteraction();
                const shapeSeg = document.getElementById('materialPreviewShape');
                if (shapeSeg) {
                    shapeSeg.addEventListener('click', ev => {
                        const b = ev.target.closest ? ev.target.closest('.seg-btn') : null;
                        if (!b || !b.dataset.shape) return;
                        shapeSeg.querySelectorAll('.seg-btn').forEach(x => {
                            x.classList.toggle('active', x === b);
                        });
                        setPreviewShape(b.dataset.shape);
                    });
                }

                // Cursori: l'anteprima segue il movimento, non il rilascio.
                ['materialRoughness', 'materialMetalness', 'materialEmissive',
                    'materialOpacity', 'materialUvRepeat', 'materialUvOffsetU',
                    'materialUvOffsetV', 'materialUvRotation'].forEach(id => {
                        on(id, 'input', () => {
                            updateSliderLabels();
                            if (materialFormIsOpen()) refreshFormPreview();
                        });
                    });

                on('materialTextureInput', 'change', async ev => {
                    const f = ev.target.files && ev.target.files[0];
                    if (!f) return;   // dialogo annullato: la texture attuale resta
                    setFileNameLabel(f.name);
                    let full;
                    try {
                        // Import a immagine intera per avere subito qualcosa da vedere;
                        // il ritaglio poi la riversa nella tela. Il messaggio di
                        // importTextureFile e' tecnico e in inglese: si mostra il
                        // nostro, tradotto.
                        full = await importTextureFile(f);
                    } catch (err) {
                        setFileNameLabel(null);
                        alert(t('materials.textureError'));
                        return;
                    }
                    _formState.pendingTexture = full;
                    refreshSourceUI();
                    refreshFormPreview();
                    // Il blob NON viene rilasciato qui: l'immagine del ritaglio lo usa
                    // ancora. Lo rilascia loadImageForCrop quando ha decodificato.
                    loadImageForCrop(URL.createObjectURL(f));
                });

                on('materialCropResetBtn', 'click', () => {
                    const c = _formState.crop;
                    if (!c) return;
                    c.x = 0; c.y = 0; c.w = c.iw; c.h = c.ih;
                    updateCropRectEl();
                    artFromCrop();
                });

                // Quadrato centrato: le texture dei voxel si usano quasi sempre
                // quadrate (una faccia e' un quadrato), e ritagliarlo a mano con
                // precisione al pixel e' una fatica inutile.
                on('materialCropSquareBtn', 'click', () => {
                    const c = _formState.crop;
                    if (!c) return;
                    const side = Math.min(c.iw, c.ih);
                    c.w = side; c.h = side;
                    c.x = Math.round((c.iw - side) / 2);
                    c.y = Math.round((c.ih - side) / 2);
                    updateCropRectEl();
                    artFromCrop();
                });

                // Il trascinamento usa i Pointer Events con capture: senza, uscendo dal
                // canvas col tasto premuto il rettangolo si bloccherebbe a meta'.
                const cropCanvas = document.getElementById('materialCropCanvas');
                if (cropCanvas) {
                    cropCanvas.addEventListener('pointerdown', ev => {
                        const c = _formState.crop;
                        if (!c) return;
                        const p = cropPointFromEvent(ev, cropCanvas);
                        const handle = cropHandleAt(p, p.screenScale);
                        const inside = p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
                        if (handle) {
                            c.drag = { mode: 'resize', handle: handle };
                        } else if (inside) {
                            c.drag = { mode: 'move', px: p.x, py: p.y, ox: c.x, oy: c.y };
                        } else {
                            c.drag = { mode: 'new', ax: p.x, ay: p.y };
                            c.x = p.x; c.y = p.y; c.w = 0; c.h = 0;
                            updateCropRectEl();
                        }
                        cropCanvas.setPointerCapture(ev.pointerId);
                        ev.preventDefault();
                    });
                    cropCanvas.addEventListener('pointermove', ev => {
                        const c = _formState.crop;
                        if (!c || !c.drag) return;
                        const p = cropPointFromEvent(ev, cropCanvas);
                        if (c.drag.mode === 'move') {
                            c.x = Math.max(0, Math.min(c.iw - c.w, c.drag.ox + (p.x - c.drag.px)));
                            c.y = Math.max(0, Math.min(c.ih - c.h, c.drag.oy + (p.y - c.drag.py)));
                        } else if (c.drag.mode === 'resize') {
                            cropResize(c.drag.handle, p);
                        } else {
                            // Trascinare in su/a sinistra deve funzionare: si normalizza
                            // invece di pretendere che il secondo punto sia il maggiore.
                            c.x = Math.min(c.drag.ax, p.x);
                            c.y = Math.min(c.drag.ay, p.y);
                            c.w = Math.abs(p.x - c.drag.ax);
                            c.h = Math.abs(p.y - c.drag.ay);
                        }
                        updateCropRectEl();
                    });
                    const endCrop = ev => {
                        const c = _formState.crop;
                        if (!c || !c.drag) return;
                        c.drag = null;
                        // Un ritaglio troppo piccolo e' un clic andato storto, non una
                        // scelta: si torna all'immagine intera invece di produrre una
                        // texture di 1 pixel.
                        if (c.w < 2 || c.h < 2) { c.x = 0; c.y = 0; c.w = c.iw; c.h = c.ih; }
                        updateCropRectEl();
                        // Il ricampionamento sta QUI e non in pointermove: passa da un
                        // toDataURL, che a ogni pixel di trascinamento ingolferebbe il
                        // thread.
                        artFromCrop();
                        if (cropCanvas.hasPointerCapture && cropCanvas.hasPointerCapture(ev.pointerId)) {
                            cropCanvas.releasePointerCapture(ev.pointerId);
                        }
                    };
                    cropCanvas.addEventListener('pointerup', endCrop);
                    cropCanvas.addEventListener('pointercancel', endCrop);
                }

                // --- tela: dimensione, sfondo, strumenti ---------------------------
                on('materialCanvasSize', 'change', () => {
                    // Cambiare dimensione RICAMPIONA il disegno invece di buttarlo:
                    // e' il "resize" che si aspetta chi arriva da un editor di
                    // immagini. Per ripartire da zero c'e' "Nuova tela".
                    resizeArtCanvas(artSelectedSize());
                });

                on('materialCanvasBgTransparent', 'change', () => {
                    const el = document.getElementById('materialCanvasBg');
                    // Il picker resta VISIBILE ma smorzato: nasconderlo farebbe
                    // saltare il pannello a ogni spunta.
                    if (el) el.classList.toggle('muted-by-material',
                        !!document.getElementById('materialCanvasBgTransparent').checked);
                });

                on('materialCanvasNewBtn', 'click', () => {
                    if (_art.canvas && !confirm(t('matcreate.confirmNewCanvas'))) return;
                    // true = azzera anche le altre 5 facce (vedi newArtCanvas).
                    newArtCanvas(artSelectedSize(), artBackgroundColor(), true);
                });

                on('materialArtUndoBtn', 'click', artUndo);
                on('materialArtRedoBtn', 'click', artRedo);
                on('materialArtClearBtn', 'click', () => {
                    if (!_art.canvas) return;
                    pushArtUndo();
                    _art.ctx.clearRect(0, 0, _art.canvas.width, _art.canvas.height);
                    commitArtToTexture();
                });

                // La delega sta su #materialArtTools e non sulla sezione che lo
                // contiene: la finestra grande sposta questo nodo, e un ascoltatore
                // sul contenitore non vedrebbe piu' i click (era il difetto per cui
                // Gomma/Riempi/Preleva non si potevano scegliere da ingrandito).
                const toolsBox = document.getElementById('materialArtTools');
                if (toolsBox) {
                    toolsBox.addEventListener('click', ev => {
                        const b = ev.target.closest ? ev.target.closest('.pixel-tool-btn') : null;
                        if (b && b.dataset.pixeltool) setArtTool(b.dataset.pixeltool);
                    });
                }

                on('materialPenColor', 'input', ev => setPenColor(ev.target.value, false));
                // A rilascio avvenuto la tinta entra fra le recenti: durante il
                // trascinamento del picker si passa per decine di colori intermedi
                // che non ha senso ricordare.
                on('materialPenColor', 'change', ev => setPenColor(ev.target.value, true));
                // Tinta unita = sfondo della tela, NON il pennello.
                on('materialSolidColor', 'input', ev => setSolidColor(ev.target.value));
                on('materialSolidColor', 'change', ev => setSolidColor(ev.target.value));
                on('materialCanvasBg', 'input', ev => setSolidColor(ev.target.value));
                on('materialCanvasBg', 'change', ev => setSolidColor(ev.target.value));

                // Griglia on/off: il checkbox vive in #materialArtTools, che viaggia
                // nella finestra grande. Sotto i 5 px/cella resta comunque spenta.
                on('materialArtGridToggle', 'change', ev => {
                    _art.gridOn = !!(ev.target && ev.target.checked);
                    layoutArtStage();
                });

                // Facce del cubo: single vs six, e switcher per-faccia.
                const faceSeg = document.getElementById('materialFaceModeSeg');
                if (faceSeg) {
                    faceSeg.addEventListener('click', ev => {
                        const b = ev.target.closest ? ev.target.closest('.seg-btn') : null;
                        if (b && b.dataset.facemode) setFaceMode(b.dataset.facemode);
                    });
                }
                const faceSwitch = document.getElementById('materialFaceSwitcher');
                if (faceSwitch) {
                    faceSwitch.addEventListener('click', ev => {
                        const b = ev.target.closest ? ev.target.closest('[data-face]') : null;
                        if (b && b.dataset.face) switchActiveFace(b.dataset.face);
                    });
                }

                on('materialFillTolerance', 'input', () => {
                    const el = document.getElementById('materialFillToleranceValue');
                    if (el) el.textContent = String(artFillTolerance());
                });

                // --- disegno sulla tela --------------------------------------------
                const artCanvas = document.getElementById('materialArtCanvas');
                if (artCanvas) {
                    artCanvas.addEventListener('pointerdown', ev => {
                        if (!_art.ctx) return;
                        // Solo il tasto sinistro disegna: il centrale serve a spostare
                        // la tela e il destro apre il menu contestuale. Senza questa
                        // riga un clic destro dipingeva.
                        if (ev.button !== 0) return;
                        // Con la barra spaziatrice premuta il puntatore sposta, non
                        // disegna: e' la convenzione degli editor di immagini, e senza
                        // di essa spostarsi a zoom alto significherebbe sporcare il
                        // disegno a ogni trascinamento.
                        if (_art.spaceHeld) return;
                        const cell = artCellFromEvent(ev);
                        if (!cell) return;
                        ev.preventDefault();
                        if (_art.tool === 'pick') { artPickCell(cell.x, cell.y); return; }
                        // Lo snapshot si prende UNA volta per tratto, non per cella:
                        // altrimenti annullare una pennellata di trenta celle
                        // richiederebbe trenta annullamenti.
                        pushArtUndo();
                        if (_art.tool === 'fill') {
                            artFloodFill(cell.x, cell.y);
                            commitArtToTexture();
                            return;
                        }
                        _art.drawing = true;
                        _art.lastCell = cell.x + ',' + cell.y;
                        artPaintCell(cell.x, cell.y);
                        if (_art.tool === 'pencil') setPenColor(_art.pen, true);
                        artCanvas.setPointerCapture(ev.pointerId);
                    });
                    artCanvas.addEventListener('pointermove', ev => {
                        const cell = artCellFromEvent(ev);
                        // L'anteprima segue il puntatore anche senza tasto premuto:
                        // e' proprio quando NON si sta dipingendo che serve sapere
                        // dove si finirebbe.
                        setArtHoverCell(cell);
                        if (!_art.drawing) return;
                        if (!cell) return;
                        const key = cell.x + ',' + cell.y;
                        // Ridipingere la stessa cella a ogni pixel di movimento non
                        // cambia nulla e costa una fillRect per evento.
                        if (key === _art.lastCell) return;
                        _art.lastCell = key;
                        artPaintCell(cell.x, cell.y);
                    });
                    // Uscendo dalla tela il riquadro va tolto, o resterebbe fermo
                    // sull'ultima cella come se il puntatore fosse ancora li'.
                    artCanvas.addEventListener('pointerleave', () => setArtHoverCell(null));
                    const endDraw = ev => {
                        if (!_art.drawing) return;
                        _art.drawing = false;
                        _art.lastCell = null;
                        commitArtToTexture();
                        if (artCanvas.hasPointerCapture && artCanvas.hasPointerCapture(ev.pointerId)) {
                            artCanvas.releasePointerCapture(ev.pointerId);
                        }
                    };
                    artCanvas.addEventListener('pointerup', endDraw);
                    artCanvas.addEventListener('pointercancel', endDraw);
                }

                // --- finestra grande: apertura, zoom, spostamento -------------------
                on('materialArtExpandBtn', 'click', openArtEditor);
                on('materialArtCollapseBtn', 'click', closeArtEditor);
                on('materialEditorCloseBtn', 'click', closeArtEditor);
                on('materialZoomInBtn', 'click', () => stepArtZoom(1, null));
                on('materialZoomOutBtn', 'click', () => stepArtZoom(-1, null));
                on('materialZoomFitBtn', 'click', artZoomToFit);
                on('materialZoomOneBtn', 'click', () => setArtZoom(1, null));

                // Clic sullo sfondo scuro = chiudi. Il confronto e' con currentTarget:
                // senza, un clic su un bottone DENTRO la finestra chiuderebbe tutto,
                // perche' l'evento risale fino all'overlay.
                const editorOverlay = document.getElementById('materialEditorOverlay');
                if (editorOverlay) {
                    editorOverlay.addEventListener('click', ev => {
                        if (ev.target === editorOverlay) closeArtEditor();
                    });
                }

                const viewport = document.getElementById('materialArtViewport');
                if (viewport) {
                    // Rotella = zoom, che e' la convenzione degli editor di pixel art
                    // (in un'area dedicata al disegno lo scorrimento e' l'eccezione,
                    // non la regola). passive: false perche' serve preventDefault, o la
                    // pagina scorrerebbe sotto la finestra.
                    viewport.addEventListener('wheel', ev => {
                        if (!artEditorIsOpen()) return;
                        ev.preventDefault();
                        stepArtZoom(ev.deltaY < 0 ? 1 : -1, ev);
                    }, { passive: false });

                    // Spostamento col tasto CENTRALE o con la barra spaziatrice. Si
                    // muove scrollLeft/scrollTop invece di una trasformazione: il
                    // viewport e' gia' un contenitore scorrevole, quindi le due strade
                    // si contraddirebbero.
                    viewport.addEventListener('pointerdown', ev => {
                        if (ev.button !== 1 && !(ev.button === 0 && _art.spaceHeld)) return;
                        ev.preventDefault();
                        _art.panning = {
                            id: ev.pointerId,
                            x: ev.clientX, y: ev.clientY,
                            left: viewport.scrollLeft, top: viewport.scrollTop
                        };
                        viewport.classList.add('panning');
                        viewport.setPointerCapture(ev.pointerId);
                    });
                    viewport.addEventListener('pointermove', ev => {
                        const p = _art.panning;
                        if (!p || p.id !== ev.pointerId) return;
                        viewport.scrollLeft = p.left - (ev.clientX - p.x);
                        viewport.scrollTop = p.top - (ev.clientY - p.y);
                    });
                    const endPan = ev => {
                        if (!_art.panning || _art.panning.id !== ev.pointerId) return;
                        _art.panning = null;
                        viewport.classList.remove('panning');
                        if (viewport.hasPointerCapture && viewport.hasPointerCapture(ev.pointerId)) {
                            viewport.releasePointerCapture(ev.pointerId);
                        }
                    };
                    viewport.addEventListener('pointerup', endPan);
                    viewport.addEventListener('pointercancel', endPan);
                    // Il tasto centrale apre l'autoscroll di Windows se non lo si ferma.
                    viewport.addEventListener('auxclick', ev => {
                        if (ev.button === 1) ev.preventDefault();
                    });
                }

                // Tastiera. In CATTURA e con stopPropagation, perche' l'editor si
                // sovrappone a scorciatoie globali dell'app: Ctrl+Z qui deve annullare
                // la PENNELLATA, non l'ultima modifica ai voxel, ed Esc non deve
                // chiudere anche altro. Attivo solo a finestra aperta.
                document.addEventListener('keydown', ev => {
                    if (!artEditorIsOpen()) return;
                    const tag = (ev.target && ev.target.tagName || '').toLowerCase();
                    // Un campo di testo o un colore ha la precedenza: dentro un input
                    // Ctrl+Z e' l'annulla del CAMPO, e rubarglielo sarebbe peggio.
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                    const k = ev.key;
                    const ctrl = ev.ctrlKey || ev.metaKey;
                    let taken = true;
                    if (k === 'Escape') closeArtEditor();
                    else if (ctrl && (k === 'z' || k === 'Z')) { ev.shiftKey ? artRedo() : artUndo(); }
                    else if (ctrl && (k === 'y' || k === 'Y')) artRedo();
                    else if (k === '+' || k === '=') stepArtZoom(1, null);
                    else if (k === '-' || k === '_') stepArtZoom(-1, null);
                    else if (k === '0') artZoomToFit();
                    else if (k === ' ') {
                        // repeat: tenendo premuto lo spazio il browser ripete l'evento,
                        // e senza questo filtro si riscriverebbe la classe a ogni giro.
                        if (!ev.repeat) { _art.spaceHeld = true; updateZoomUI(); }
                    } else taken = false;
                    if (taken) { ev.preventDefault(); ev.stopPropagation(); }
                }, true);

                document.addEventListener('keyup', ev => {
                    if (ev.key !== ' ') return;
                    if (!_art.spaceHeld) return;
                    _art.spaceHeld = false;
                    updateZoomUI();
                }, true);

                // Ridimensionando la finestra del browser (o cambiando lo zoom del
                // browser, che sposta devicePixelRatio) va risnappata la cella
                // della griglia: senza, a dpr frazionario le colonne tornano
                // irregolari. Si richiama layoutArtStage, non solo updateZoomUI.
                window.addEventListener('resize', () => {
                    if (_art.canvas) layoutArtStage();
                    else if (artEditorIsOpen()) updateZoomUI();
                });

                setArtTool('pencil');
                setPenColor(_art.pen, false);
                // Allinea etichetta hex / picker tinta unita allo sfondo della
                // tela (o al default del solid picker) una sola volta all'avvio.
                (function syncSolidColorOnce() {
                    const bg = document.getElementById('materialCanvasBg');
                    const solid = document.getElementById('materialSolidColor');
                    const hex = (bg && MATERIAL_HEX_RE.test(bg.value || ''))
                        ? bg.value
                        : (solid && MATERIAL_HEX_RE.test(solid.value || ''))
                            ? solid.value
                            : MATERIAL_FALLBACK_COLOR;
                    setSolidColor(hex);
                })();
                renderMaterialsPanel();
            })();
