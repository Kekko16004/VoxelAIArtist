            const dropzone = document.getElementById('dropzone');
            const fileInput = document.getElementById('fileInput');
            const toggleGrid = document.getElementById('toggleGrid');
            const toggleWireframe = document.getElementById('toggleWireframe');
            const voxelGap = document.getElementById('voxelGap');
            const rotationModes = document.getElementById('rotationModes');
            const rotationSpeedInput = document.getElementById('rotationSpeed');

            const modelNameEl = document.getElementById('modelName');
            const gridSizeEdit = document.getElementById('gridSizeEdit');
            const applyGridBtn = document.getElementById('applyGridBtn');
            const voxelCountEl = document.getElementById('voxelCount');
            const visibleCountEl = document.getElementById('visibleCount');
            const paletteEl = document.getElementById('palette');

            applyGridBtn.addEventListener('click', () => {
                if (!currentModelData) return;
                const parts = gridSizeEdit.value.split(',').map(n => parseInt(n.trim()));
                if (parts.length === 3 && parts.every(n => !isNaN(n) && n > 0)) {
                    if (!currentModelData.metadata) currentModelData.metadata = {};
                    currentModelData.metadata.grid_size = parts;
                    buildModel(false);
                } else {
                    alert(t('alert.invalidGridFormat'));
                }
            });

            modelNameEl.addEventListener('blur', () => {
                if (!currentModelData) return;
                const newName = modelNameEl.textContent.trim().replace(/\s+/g, '_') || "Senza_Nome";
                if (!currentModelData.metadata) currentModelData.metadata = {};
                currentModelData.metadata.name = newName;
                modelNameEl.textContent = newName;
            });
            modelNameEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    modelNameEl.blur();
                }
            });

            dropzone.addEventListener('click', () => {
                fileInput.value = '';
                fileInput.click();
            });
            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropzone.classList.add('dragover');
            });
            dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.classList.remove('dragover');
                if (e.dataTransfer.files.length > 0) {
                    handleFile(e.dataTransfer.files[0]);
                }
            });

            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    handleFile(e.target.files[0]);
                }
                e.target.value = '';
            });

            function handleFile(file) {
                // Formati BINARI (.vox / .schem): letti come ArrayBuffer e instradati ai decoder.
                const nameLc = (file.name || '').toLowerCase();
                if (nameLc.endsWith('.vox') || nameLc.endsWith('.schem') || nameLc.endsWith('.schematic')) {
                    const breader = new FileReader();
                    breader.onload = (e) => {
                        importBinaryFormat(file, e.target.result).then(parsed => {
                            if (!parsed || !Array.isArray(parsed.voxels)) {
                                alert(t('alert.fileNoValidVoxels'));
                                return;
                            }
                            if (!parsed.metadata) parsed.metadata = {};
                            if (!parsed.metadata.name) parsed.metadata.name = file.name.replace(/\.[^/.]+$/, "");
                            const hasContent = sceneObjects.some(o => (o.data.voxels || []).length > 0);
                            if (hasContent) appendSceneFromParsed(parsed);
                            else loadSceneFromParsed(parsed);
                            buildModel();
                        }).catch(err => {
                            alert(t('alert.binaryLoadError', { error: err.message }));
                        });
                    };
                    breader.readAsArrayBuffer(file);
                    return;
                }
                
                // Formati poligonali (GLB/GLTF): inviamo al voxelizer
                if (nameLc.endsWith('.glb') || nameLc.endsWith('.gltf')) {
                    if (typeof importGlbFormat !== 'function') {
                        alert(t('alert.glbModuleMissing'));
                        return;
                    }
                    // Opzioni lette dalla UI (con default sensati se i campi non
                    // esistono ancora): risoluzione, riempimento e colori palette.
                    const _gEl = document.getElementById('glbGridSize');
                    const _fEl = document.getElementById('glbFillInterior');
                    const _cEl = document.getElementById('glbMaxColors');
                    importGlbFormat(file, {
                        maxGridSize: _gEl ? parseInt(_gEl.value, 10) : 64,
                        fillInterior: _fEl ? _fEl.checked : true,
                        maxColors: _cEl ? parseInt(_cEl.value, 10) : 64
                    }).then(parsed => {
                        // Il voxelizzatore restituisce il formato COMPATTO
                        // (palette + ops), come i modelli generati: accettiamo sia
                        // quello sia il vecchio formato con `voxels` gia' espansi.
                        // Senza questo controllo l'import falliva in SILENZIO,
                        // perche' il ramo `voxels` non c'era piu'.
                        if (!parsed) return;
                        const hasOps = Array.isArray(parsed.ops) && parsed.ops.length;
                        const hasVox = Array.isArray(parsed.voxels) && parsed.voxels.length;
                        if (!hasOps && !hasVox) {
                            alert(t('alert.importedNoVoxels'));
                            return;
                        }
                        if (!parsed.metadata) parsed.metadata = {};
                        if (!parsed.metadata.name) parsed.metadata.name = file.name.replace(/\.[^/.]+$/, "");
                        const hasContent = sceneObjects.some(o => (o.data.voxels || []).length > 0);
                        if (hasContent) appendSceneFromParsed(parsed);
                        else loadSceneFromParsed(parsed);
                        buildModel();
                    }).catch(err => {
                        alert(t('alert.glbImportError', { error: err.message }));
                    });
                    return;
                }

                const reader = new FileReader();
                reader.onload = (e) => {
                    try {
                        let content = e.target.result;
                        let parsed = null;
                        try {
                            parsed = JSON.parse(content);
                        } catch (_) {
                            try {
                                const decoded = decodeURIComponent(escape(atob(content.trim())));
                                parsed = JSON.parse(decoded);
                            } catch (e2) {
                                throw new Error("Il file non è in formato JSON in chiaro né in formato crittografato .voxelai valido.");
                            }
                        }
                        if (parsed && (Array.isArray(parsed.objects) || Array.isArray(parsed.ops) || Array.isArray(parsed.voxels) || (parsed.parts && typeof parsed.parts === 'object'))) {
                            if (!parsed.metadata) parsed.metadata = {};
                            if (!parsed.metadata.name) {
                                parsed.metadata.name = file.name.replace(/\.[^/.]+$/, "");
                            }
                            // T1 Fase B: se la scena ha già contenuto, AGGIUNGE l'import
                            // (senza cancellare gli altri oggetti); altrimenti sostituisce.
                            const hasContent = sceneObjects.some(o => (o.data.voxels || []).length > 0);
                            if (hasContent) appendSceneFromParsed(parsed);
                            else loadSceneFromParsed(parsed);
                            buildModel();
                            // Il rig e' stato attaccato all'oggetto giusto da
                            // load/appendSceneFromParsed: qui si limita a riportarlo in
                            // anteprima. Prima c'era `if (!hasContent && parsed.rig)`, cioe'
                            // importare in una scena NON vuota buttava via lo scheletro.
                            if (typeof restoreRigForActiveObject === 'function') {
                                restoreRigForActiveObject();
                            }
                        } else {
                            alert(t('alert.fileNoVoxels'));
                        }
                    } catch (err) {
                        alert(t('alert.fileLoadError', { error: err.message }));
                    }
                };
                reader.readAsText(file);
            }

            const togglePasteBtn = document.getElementById('togglePasteBtn');
            const pasteContainer = document.getElementById('pasteContainer');
            const pasteTextarea = document.getElementById('pasteTextarea');
            const cancelPasteBtn = document.getElementById('cancelPasteBtn');
            const submitPasteBtn = document.getElementById('submitPasteBtn');

            const newProjectBtn = document.getElementById('newProjectBtn');
            const newProjectContainer = document.getElementById('newProjectContainer');
            const newProjectName = document.getElementById('newProjectName');
            const newProjectGrid = document.getElementById('newProjectGrid');
            const cancelNewProjectBtn = document.getElementById('cancelNewProjectBtn');
            const submitNewProjectBtn = document.getElementById('submitNewProjectBtn');

            togglePasteBtn.addEventListener('click', () => {
                newProjectContainer.style.display = 'none';
                if (pasteContainer.style.display === 'none' || pasteContainer.style.display === '') {
                    pasteContainer.style.display = 'flex';
                    pasteTextarea.focus();
                } else {
                    pasteContainer.style.display = 'none';
                }
            });

            cancelPasteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                pasteContainer.style.display = 'none';
                pasteTextarea.value = '';
            });

            submitPasteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const jsonText = pasteTextarea.value.trim();
                if (!jsonText) {
                    alert(t('alert.pasteEmpty'));
                    return;
                }
                if (loadJSONString(jsonText)) {
                    pasteContainer.style.display = 'none';
                    pasteTextarea.value = '';
                }
            });

            newProjectBtn.addEventListener('click', () => {
                pasteContainer.style.display = 'none';
                if (newProjectContainer.style.display === 'none' || newProjectContainer.style.display === '') {
                    newProjectContainer.style.display = 'flex';
                    newProjectName.focus();
                } else {
                    newProjectContainer.style.display = 'none';
                }
            });

            cancelNewProjectBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                newProjectContainer.style.display = 'none';
            });

            submitNewProjectBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const name = newProjectName.value.trim().replace(/\s+/g, '_') || "Nuovo_Modello";
                const gridParts = newProjectGrid.value.split(',').map(Number);
                loadSceneFromParsed({
                    metadata: {
                        name: name,
                        grid_size: gridParts
                    },
                    voxels: []
                });
                buildModel();
                newProjectContainer.style.display = 'none';
            });

            function loadJSONString(jsonStr) {
                try {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(jsonStr);
                    } catch (_) {
                        try {
                            const decoded = decodeURIComponent(escape(atob(jsonStr.trim())));
                            parsed = JSON.parse(decoded);
                        } catch (e2) {
                            throw new Error("Il testo inserito non è JSON valido né un codice .voxelai valido.");
                        }
                    }
                    if (parsed && (Array.isArray(parsed.objects) || Array.isArray(parsed.ops) || Array.isArray(parsed.voxels) || (parsed.parts && typeof parsed.parts === 'object'))) {
                        if (!parsed.metadata) parsed.metadata = {};
                        if (!parsed.metadata.name) {
                            parsed.metadata.name = "Modello Caricato";
                        }
                        // T1 Fase B: append se la scena ha già contenuto, altrimenti sostituisce.
                        const hasContent = sceneObjects.some(o => (o.data.voxels || []).length > 0);
                        if (hasContent) appendSceneFromParsed(parsed);
                        else loadSceneFromParsed(parsed);
                        buildModel();
                        // Vedi il commento nell'import da file: il rig e' gia' sull'oggetto
                        // corretto, anche quando si incolla in una scena non vuota.
                        if (typeof restoreRigForActiveObject === 'function') {
                            restoreRigForActiveObject();
                        }
                        return true;
                    } else {
                        alert(t('alert.parseNoVoxels'));
                        return false;
                    }
                } catch (err) {
                    alert(t('alert.parseError', { error: err.message }));
                    return false;
                }
            }

            const resizer = document.getElementById('sidebarResizer');
            let isResizing = false;

            resizer.addEventListener('mousedown', (e) => {
                isResizing = true;
                resizer.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                const newWidth = Math.max(280, Math.min(window.innerWidth - 50, e.clientX));
                document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
                resizeCanvas();
            });

            window.addEventListener('mouseup', () => {
                if (isResizing) {
                    isResizing = false;
                    resizer.classList.remove('dragging');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                }
            });

            // Expand the compact palette+ops format into a flat voxels list.
            // Mirrors expand_ops() in parser.py so drag-dropped compact JSON works too.