            const generateBtn = document.getElementById('generateBtn');
            const promptInput = document.getElementById('promptInput');
            const toggleThinking = document.getElementById('toggleThinking');
            const modelSelect = document.getElementById('modelSelect');
            const gridSelect = document.getElementById('gridSelect');
            const loaderOverlay = document.getElementById('loaderOverlay');

            const geminiModels = [
                // { val: "gemini-3.5-flash", label: "Gemini 2.0 Flash (Consigliato)" },
                { val: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
                { val: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }
            ];

            function updateModelOptions() {
                modelSelect.innerHTML = '';
                geminiModels.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.val;
                    opt.textContent = m.label;
                    modelSelect.appendChild(opt);
                });
            }

            updateModelOptions();

            const modeSelect = document.getElementById('modeSelect');
            const uploadImageBtn = document.getElementById('uploadImageBtn');
            const imageInput = document.getElementById('imageInput');
            const imagePreviewContainer = document.getElementById('imagePreviewContainer');
            const imagePreview = document.getElementById('imagePreview');
            const imageName = document.getElementById('imageName');
            const removeImageBtn = document.getElementById('removeImageBtn');
            let selectedImageBase64 = null;

            uploadImageBtn.addEventListener('click', () => imageInput.click());

            imageInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (evt) => {
                        selectedImageBase64 = evt.target.result;
                        imagePreview.src = selectedImageBase64;
                        imageName.textContent = file.name;
                        imagePreviewContainer.style.display = 'flex';
                    };
                    reader.readAsDataURL(file);
                }
            });

            removeImageBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                selectedImageBase64 = null;
                imageInput.value = '';
                imagePreview.src = '';
                imageName.textContent = '';
                imagePreviewContainer.style.display = 'none';
            });

            modeSelect.addEventListener('change', () => {
                if (modeSelect.value === 'modify') {
                    promptInput.placeholder = t('generate.promptModify');
                    generateBtn.textContent = t('generate.btnModify');
                } else {
                    promptInput.placeholder = t('generate.promptCreate');
                    generateBtn.textContent = t('generate.btnCreate');
                }
            });

            // ===== MODALITA' STRUTTURA GRANDE =====
            // Alza la griglia a un valore adeguato (se l'utente e' su una piccola) e
            // mostra l'avviso sul costo. Il flag viaggia poi nel POST: il backend lo
            // traduce in istruzioni esplicite per l'AI (vedi main.py).
            const toggleBigStructure = document.getElementById('toggleBigStructure');
            const bigStructureHint = document.getElementById('bigStructureHint');
            if (toggleBigStructure) {
                toggleBigStructure.addEventListener('change', () => {
                    const on = toggleBigStructure.checked;
                    if (bigStructureHint) bigStructureHint.style.display = on ? '' : 'none';
                    if (on) {
                        // Sotto 128 una "struttura grande" non ha spazio per esistere.
                        const cur = gridSelect.value;
                        const small = (cur === 'auto' || cur === '32x32x32'
                            || cur === '48x48x48' || cur === '64x64x64');
                        if (small) gridSelect.value = '192x192x192';
                    }
                });
            }

            const toggleModular = document.getElementById('toggleModular');
            const modularHint = document.getElementById('modularHint');
            if (toggleModular) {
                toggleModular.addEventListener('change', () => {
                    const on = toggleModular.checked;
                    if (modularHint) modularHint.style.display = on ? '' : 'none';
                });
            }

            // Soggetto umanoide: il backend aggiunge HUMANOID_RULE (T-pose, gambe
            // staccate, una parte per arto). La regola PRETENDE il formato
            // multi-parte, quindi qui si spegne "oggetto unico": lasciarlo acceso
            // mostrerebbe all'utente uno stato che il backend ignora comunque.
            const toggleHumanoid = document.getElementById('toggleHumanoid');
            const humanoidHint = document.getElementById('humanoidHint');
            if (toggleHumanoid) {
                toggleHumanoid.addEventListener('change', () => {
                    const on = toggleHumanoid.checked;
                    if (humanoidHint) humanoidHint.style.display = on ? '' : 'none';
                    const single = document.getElementById('toggleSingleObject');
                    if (on && single && single.checked) single.checked = false;
                });
            }

            // Applica una PATCH di modifica (diff) restituita dall'AI sopra
            // all'oggetto attivo. La modalita' "modifica" ora chiede all'AI SOLO le
            // aggiunte/rimozioni (vedi prompt-edit.txt): molto piu' veloce e non
            // rovina il resto del modello, che resta identico per costruzione. Se
            // per qualche motivo l'AI rispondesse con un modello intero (vecchio
            // formato, senza 'del' e con conteggio voxel simile all'attuale), si
            // ripiega sulla sostituzione completa per non lasciare voxel fantasma.
            function applyModifyResult(data, sentPayload) {
                const obj = getActiveObject();
                if (!obj) { loadSceneFromParsed(data); return; }
                const diffOps = Array.isArray(data && data.ops) ? data.ops : [];
                const palette = Object.assign({}, (sentPayload && sentPayload.palette) || {}, (data && data.palette) || {});

                // Euristica anti-"modello intero": se la risposta NON contiene 'del'
                // e le sue ops rigenerano da zero un numero di voxel paragonabile
                // all'attuale, e' un rewrite completo -> sostituisci tutto.
                const hasDel = diffOps.some(o => Array.isArray(o) && String(o[0]).toLowerCase() === 'del');
                const curCount = (currentModelData.voxels || []).length;
                if (!hasDel && diffOps.length) {
                    let produced = 0;
                    try { produced = (expandOps({ palette: palette, ops: diffOps, metadata: data.metadata || {} }).voxels || []).length; } catch (e) { produced = 0; }
                    if (curCount > 0 && produced >= curCount * 0.8) {
                        // pushHistory PRIMA di sostituire: questo ramo butta via il
                        // modello intero, cioe' e' la cosa piu' distruttiva che l'AI
                        // possa fare, ed era l'unica non annullabile (il `return` qui
                        // sotto saltava il pushHistory del percorso normale).
                        pushHistory();
                        // Il payload spedito all'AI omette i materiali di proposito
                        // (getSavePayload con {materials:false}: una texture base64
                        // costerebbe piu' del modello e all'AI non serve), quindi la
                        // risposta non li riporta indietro. Si conservano quelli che
                        // c'erano: senza, ogni riscrittura totale cancellerebbe le
                        // definizioni del progetto e slegherebbe tutti i voxel.
                        const matPrima = (currentModelData.metadata || {}).materials;
                        obj.data = expandOps(data);
                        currentModelData = obj.data;
                        if (Array.isArray(matPrima) && matPrima.length) {
                            if (!currentModelData.metadata) currentModelData.metadata = {};
                            currentModelData.metadata.materials = matPrima;
                        }
                        if (typeof invalidateIncremental === 'function') invalidateIncremental();
                        return;
                    }
                }

                // Percorso normale: applica il diff sopra allo stato corrente.
                pushHistory();                     // annullabile con Ctrl+Z
                rebuildVoxelMap();                 // voxelMap = celle visibili correnti
                applyOpsToVoxelMap(voxelMap, diffOps, palette);
                syncVoxelsFromMap();               // riscrive currentModelData.voxels (preserva part/nascosti)
                if (data && data.metadata && data.metadata.grid_size) {
                    currentModelData.metadata = currentModelData.metadata || {};
                    currentModelData.metadata.grid_size = data.metadata.grid_size;
                }
                obj.data = currentModelData;
            }

            generateBtn.addEventListener('click', () => {
                const promptVal = promptInput.value.trim();
                if (!promptVal) {
                    alert(t('generate.needPrompt'));
                    return;
                }

                generateBtn.disabled = true;
                promptInput.disabled = true;
                toggleThinking.disabled = true;
                modelSelect.disabled = true;
                gridSelect.disabled = true;
                modeSelect.disabled = true;
                uploadImageBtn.disabled = true;
                generateBtn.innerHTML = '<span class="spinner"></span> Elaborazione...';
                loaderOverlay.style.display = 'flex';

                // Cattura cio' che inviamo: in "modifica" la palette inviata serve a
                // risolvere le chiavi colore del diff di risposta.
                // NIENTE materiali: le loro texture sono base64 fino a 128x128 l'una
                // (decine di KB) e all'AI non servono, risponde con un diff di ops.
                const sentPayload = getSavePayload({ materials: false });

                fetch('/api/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: promptVal,
                        thinking: true,
                        model: modelSelect.value,
                        gridSize: gridSelect.value,
                        mode: modeSelect.value,
                        bigStructure: toggleBigStructure ? toggleBigStructure.checked : false,
                        modular: toggleModular ? toggleModular.checked : false,
                        single_object: toggleSingleObject ? toggleSingleObject.checked : true,
                        humanoid: toggleHumanoid ? toggleHumanoid.checked : false,
                        currentModel: sentPayload,
                        image: selectedImageBase64
                    })
                })
                    .then(res => {
                        if (!res.ok) {
                            return res.json().then(err => { throw new Error(err.error || t('generate.errUnknown')); });
                        }
                        return res.json();
                    })
                    .then(data => {
                        // 'modify' applica una patch (diff) sull'oggetto attivo;
                        // 'generate' rimpiazza la scena.
                        if (modeSelect.value === 'modify' && getActiveObject()) {
                            applyModifyResult(data, sentPayload);
                        } else {
                            loadSceneFromParsed(data);
                        }
                        buildModel();
                    })
                    .catch(err => {
                        alert(t('generate.errFailed', { msg: err.message }));
                    })
                    .finally(() => {
                        generateBtn.disabled = false;
                        promptInput.disabled = false;
                        toggleThinking.disabled = false;
                        modelSelect.disabled = false;
                        gridSelect.disabled = false;
                        modeSelect.disabled = false;
                        uploadImageBtn.disabled = false;
                        if (modeSelect.value === 'modify') {
                            generateBtn.innerHTML = t('generate.btnModify');
                        } else {
                            generateBtn.innerHTML = t('generate.btnCreate');
                        }
                        loaderOverlay.style.display = 'none';
                    });
            });

            // Control Inputs Events. Pass resetCamera=false so toggling view options
            // (grid, wireframe, gap) rebuilds the meshes without snapping the camera.
            toggleGrid.addEventListener('change', () => buildModel(false));
            toggleWireframe.addEventListener('change', () => buildModel(false));
            voxelGap.addEventListener('input', () => buildModel(false));

            // Rotation mode segmented control. 'none' | 'object' | 'orbit'.
            rotationModes.querySelectorAll('.seg-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    rotationMode = btn.dataset.rot;
                    rotationModes.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                    // Reset the pivot spin when leaving object mode so the model
                    // doesn't stay frozen at an angle when switching to none/orbit.
                    if (rotationMode !== 'object') modelPivot.rotation.y = 0;
                });
            });
            rotationSpeedInput.addEventListener('input', () => { rotationSpeed = parseFloat(rotationSpeedInput.value); });
            rotationSpeed = parseFloat(rotationSpeedInput.value);
