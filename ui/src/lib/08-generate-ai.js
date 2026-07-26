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
                    promptInput.placeholder = "Descrivi le modifiche (es. Aggiungi ali rosse)";
                    generateBtn.textContent = "Modifica Modello";
                } else {
                    promptInput.placeholder = "Cosa generiamo? (es. Dinosauro)";
                    generateBtn.textContent = "Genera Modello";
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

            generateBtn.addEventListener('click', () => {
                const promptVal = promptInput.value.trim();
                if (!promptVal) {
                    alert("Inserisci una descrizione prima di procedere!");
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
                        currentModel: getSavePayload(),
                        image: selectedImageBase64
                    })
                })
                    .then(res => {
                        if (!res.ok) {
                            return res.json().then(err => { throw new Error(err.error || "Errore sconosciuto"); });
                        }
                        return res.json();
                    })
                    .then(data => {
                        // 'modify' edits the active object in place; 'generate' replaces
                        // the scene. Both go through the single-object path in Fase A.
                        if (modeSelect.value === 'modify' && getActiveObject()) {
                            const obj = getActiveObject();
                            obj.data = expandOps(data);
                            currentModelData = obj.data;
                        } else {
                            loadSceneFromParsed(data);
                        }
                        buildModel();
                    })
                    .catch(err => {
                        alert("Errore nella generazione: " + err.message);
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
                            generateBtn.innerHTML = "Modifica Modello";
                        } else {
                            generateBtn.innerHTML = "Genera Modello";
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
