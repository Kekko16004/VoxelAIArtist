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
                        h: Number(def.texture.h) || 0,
                        // `alpha` dice se l'immagine ha pixel non completamente opachi.
                        // Si misura all'import (l'unico punto che ha i pixel in mano) e
                        // si porta appresso, perche' il rendering deve saperlo senza
                        // ridecodificare il PNG a ogni costruzione del materiale.
                        alpha: !!(def.texture.alpha)
                    } : null,
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
                applyTransparency(mat, def);
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
                    applyUvToTexture(tex, def.uv);
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
            function materialCardBtn(cls, glyph, title, onClick) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'material-card-btn ' + cls;
                b.textContent = glyph;
                b.title = title;
                b.addEventListener('click', ev => { ev.stopPropagation(); onClick(); });
                return b;
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
                _preview = { renderer, scene, camera, mesh, mat, spinning: false, angle: 0 };
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
                startPreviewSpin();
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
            function applyPreviewState(state) {
                const p = ensurePreview();
                if (!p) return;
                const m = p.mat;
                const hex = (state && MATERIAL_HEX_RE.test(state.color || '')) ? state.color : MATERIAL_FALLBACK_COLOR;
                const texData = (state && state.texture && state.texture.data) ? state.texture.data : null;
                m.roughness = state ? state.roughness : 0.6;
                m.metalness = state ? state.metalness : 0;
                const emi = state ? state.emissive : 0;
                m.emissive = new THREE.Color(emi > 0 ? hex : 0x000000);
                m.emissiveIntensity = emi;
                if (texData !== p.texData) {
                    if (m.map && m.map.dispose) m.map.dispose();
                    p.texData = texData;
                    if (texData) {
                        const tex = new THREE.TextureLoader().load(texData, () => { p.dirty = true; });
                        tex.magFilter = THREE.NearestFilter;
                        tex.minFilter = THREE.NearestFilter;
                        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                        m.map = tex;
                    } else {
                        m.map = null;
                    }
                }
                if (m.map) applyUvToTexture(m.map, state && state.uv);
                // La trasparenza si RIAZZERA prima: applyTransparency accende i flag
                // ma non li spegne, e su un materiale riusato fra due aperture del
                // form l'alphaTest di prima resterebbe attivo e mangerebbe i bordi.
                m.transparent = false;
                m.opacity = 1;
                m.alphaTest = 0;
                applyTransparency(m, state);
                // Col map, `color` moltiplica la texture: bianco = texture pura.
                m.color = new THREE.Color(texData ? 0xffffff : hex);
                m.needsUpdate = true;
                startPreviewSpin();
            }

            // La forma gira SOLO finche' il form e' aperto: un loop perenne terrebbe
            // sveglia la GPU per un pannello chiuso (e questa app rende on-demand di
            // proposito, vedi requestRender).
            function startPreviewSpin() {
                const p = ensurePreview();
                if (!p || p.spinning) return;
                p.spinning = true;
                const step = () => {
                    if (!materialFormIsOpen()) { p.spinning = false; return; }
                    p.angle += 0.012;
                    p.mesh.rotation.y = p.angle;
                    p.renderer.render(p.scene, p.camera);
                    requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
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
                    el.appendChild(materialCardBtn('material-card-edit', '✎',
                        t('materials.editTitle'), () => openMaterialForm(def.id)));
                    el.appendChild(materialCardBtn('material-card-del', '×',
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
                    del.textContent = '×';
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
                source: 'flat'
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

            // Senza texture il materiale e' una tinta unita col colore attivo: e'
            // comunque utile per ruvidita'/metallicita'/emissivo.
            function currentFormColor() {
                if (_formState.pendingTexture) return _formState.pendingTexture.color;
                return (typeof activeColorHex === 'string' && MATERIAL_HEX_RE.test(activeColorHex))
                    ? activeColorHex.toUpperCase() : MATERIAL_FALLBACK_COLOR;
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
                const tex = (_formState.source === 'flat') ? null : _formState.pendingTexture;
                return {
                    name: nameEl ? nameEl.value.trim() : '',
                    texture: tex ? { data: tex.data, w: tex.w, h: tex.h, alpha: !!tex.alpha } : null,
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
                _formState = { editingId: null, pendingTexture: null, crop: null, source: 'flat' };
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
                // Mentre la tela e' nella finestra grande la scelta della dimensione
                // sta LI' DENTRO: nasconderla perche' la sorgente e' cambiata la
                // farebbe sparire da un pannello in cui e' l'unico modo di
                // ridimensionare il disegno.
                show('materialCanvasSetup', src !== 'flat' || artEditorIsOpen());
                show('materialDrawSection', src !== 'flat');
                show('materialUvSection', src !== 'flat' && !!_formState.pendingTexture);
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
                    source: 'flat'
                };

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
                if (_formState.pendingTexture) loadArtFromTexture(_formState.pendingTexture);
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
                panning: null
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

            function newArtCanvas(size, bgHex) {
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
            }

            // Riversa una texture esistente nella tela (modifica di un materiale). La
            // dimensione della tela diventa quella della texture, e il select si
            // allinea al preset piu' vicino: mostrare 16 mentre la tela e' 128
            // farebbe credere di star disegnando su una griglia grossa.
            function loadArtFromTexture(tex) {
                if (!tex || !tex.data) return;
                const img = new Image();
                img.onload = () => {
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
                    // NON si richiama commitArtToTexture: la texture e' gia' quella,
                    // e ricalcolarla la ricomprimerebbe in PNG senza guadagno.
                    refreshSourceUI();
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
            function artInlineZoom(w, h) {
                return Math.max(1, Math.floor(ART_INLINE_MAX / Math.max(w, h)));
            }

            function layoutArtStage() {
                const stage = document.getElementById('materialArtStage');
                if (!stage || !_art.canvas) return;
                const w = _art.canvas.width, h = _art.canvas.height;
                const z = artEditorIsOpen() ? _art.zoom : artInlineZoom(w, h);
                stage.style.width = (w * z) + 'px';
                stage.style.height = (h * z) + 'px';
                const grid = document.getElementById('materialArtGrid');
                if (grid) {
                    grid.style.setProperty('--cell', z + 'px');
                    // Sotto i 5 px per cella le linee sarebbero fitte quanto i pixel e
                    // la tela diventerebbe un reticolo grigio in cui non si vede piu'
                    // il disegno.
                    grid.classList.toggle('hidden', z < 5);
                }
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
                    const over = _art.canvas.width * _art.zoom > vp.clientWidth
                        || _art.canvas.height * _art.zoom > vp.clientHeight;
                    vp.classList.toggle('pannable', over || _art.spaceHeld);
                }
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
                // Il texel sotto l'ancora, PRIMA di cambiare zoom.
                const stBox = stage.getBoundingClientRect();
                const tx = (ax - stBox.left) / _art.zoom;
                const ty = (ay - stBox.top) / _art.zoom;

                _art.zoom = next;
                layoutArtStage();

                // Rimettere quel texel sotto l'ancora. Lo stage e' centrato da
                // `margin: auto` finche' ci sta, quindi l'offset dentro il contenuto
                // scorrevole non e' zero e va rimesso nel conto.
                const w = _art.canvas.width * next, h = _art.canvas.height * next;
                const offX = Math.max(0, (vp.clientWidth - w) / 2);
                const offY = Math.max(0, (vp.clientHeight - h) / 2);
                vp.scrollLeft = offX + tx * next - (ax - vpBox.left);
                vp.scrollTop = offY + ty * next - (ay - vpBox.top);
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
            function setArtTool(tool) {
                _art.tool = ['pencil', 'eraser', 'fill', 'pick'].indexOf(tool) >= 0 ? tool : 'pencil';
                const row = document.getElementById('materialDrawSection');
                if (row && row.querySelectorAll) {
                    row.querySelectorAll('.pixel-tool-btn').forEach(b => {
                        b.classList.toggle('active', b.dataset.pixeltool === _art.tool);
                    });
                }
            }

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
                    renderPenSwatches();
                }
                renderPenSwatches();
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
                // Sorgente e destinazione identiche: il riempimento non finirebbe mai
                // di trovare celle "da cambiare" se non si uscisse subito.
                if (t0[0] === n0 && t0[1] === n1 && t0[2] === n2 && t0[3] === n3) return;
                const stack = [sx, sy];
                while (stack.length) {
                    const y = stack.pop(), x = stack.pop();
                    if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    const i = at(x, y);
                    if (d[i] !== t0[0] || d[i + 1] !== t0[1] || d[i + 2] !== t0[2] || d[i + 3] !== t0[3]) continue;
                    d[i] = n0; d[i + 1] = n1; d[i + 2] = n2; d[i + 3] = n3;
                    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
                }
                ctx.putImageData(img, 0, 0);
            }

            // La tela diventa la texture del form. Si chiama alla FINE di un tratto,
            // non a ogni cella: toDataURL comprime un PNG, che a ogni movimento del
            // puntatore bloccherebbe il thread.
            function commitArtToTexture() {
                const cv = _art.canvas, ctx = _art.ctx;
                if (!cv || !ctx) return;
                try {
                    _formState.pendingTexture = textureFromCanvasCtx(cv, ctx);
                } catch (e) { return; }
                refreshSourceUI();
                refreshFormPreview();
            }

            // --- salvataggio --------------------------------------------------------
            // In modifica SOSTITUISCE: updateMaterial muta la voce esistente, quindi la
            // lista non cresce e i voxel che citavano l'id continuano a citarlo. Il
            // ramo addMaterial vale solo per la creazione (o per un id svanito sotto i
            // piedi), non e' una via che una modifica normale possa prendere.
            function saveMaterialFromForm() {
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

                // Forma dell'anteprima.
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
                    newArtCanvas(artSelectedSize(), artBackgroundColor());
                });

                on('materialArtUndoBtn', 'click', artUndo);
                on('materialArtRedoBtn', 'click', artRedo);
                on('materialArtClearBtn', 'click', () => {
                    if (!_art.canvas) return;
                    pushArtUndo();
                    _art.ctx.clearRect(0, 0, _art.canvas.width, _art.canvas.height);
                    commitArtToTexture();
                });

                const drawSec = document.getElementById('materialDrawSection');
                if (drawSec) {
                    drawSec.addEventListener('click', ev => {
                        const b = ev.target.closest ? ev.target.closest('.pixel-tool-btn') : null;
                        if (b && b.dataset.pixeltool) setArtTool(b.dataset.pixeltool);
                    });
                }

                on('materialPenColor', 'input', ev => setPenColor(ev.target.value, false));

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
                        if (!_art.drawing) return;
                        const cell = artCellFromEvent(ev);
                        if (!cell) return;
                        const key = cell.x + ',' + cell.y;
                        // Ridipingere la stessa cella a ogni pixel di movimento non
                        // cambia nulla e costa una fillRect per evento.
                        if (key === _art.lastCell) return;
                        _art.lastCell = key;
                        artPaintCell(cell.x, cell.y);
                    });
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

                // Ridimensionando la finestra del browser cambia quanto ci sta nel
                // viewport, quindi il cursore "si puo' spostare" va rideciso.
                window.addEventListener('resize', () => {
                    if (artEditorIsOpen()) updateZoomUI();
                });

                setArtTool('pencil');
                setPenColor(_art.pen, false);
                renderMaterialsPanel();
            })();
