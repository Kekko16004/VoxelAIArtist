            function updateHistoryButtons() {
                undoBtn.disabled = undoStack.length === 0;
                redoBtn.disabled = redoStack.length === 0;
            }

            // T1 Fase B: cattura voxel dell'ATTIVO + rig + struttura scena (nomi, transform,
            // visibilità, quale è attivo). LIMITE noto: NON cattura i voxel degli oggetti
            // non attivi, quindi una pennellata annullata torna indietro solo sull'oggetto
            // su cui è stata data.
            // Corollario da NON dimenticare: uno scatto vale per l'oggetto che era attivo
            // quando è stato preso. Chi lo ripristina deve prima tornare su quell'oggetto,
            // altrimenti ne svuota un altro — vedi applySnapshot e
            // tests/test_undo_object_switch.mjs.
            //
            // La ROSA degli oggetti (`sceneMeta`, in ordine di scena) invece è completa, e
            // da lì viene l'annullamento di Nuovo/Duplica/Primitiva/Elimina/Unisci:
            //  - un oggetto che esiste ORA ma non è nella rosa è nato dopo lo scatto -> via;
            //  - un oggetto della rosa che non esiste più torna, ma solo se lo scatto ne
            //    porta il contenuto in `payloads`.
            // I payload costano, quindi NON sono in ogni scatto: li allega chi sta per far
            // sparire qualcosa (objDelete, objMerge, Ctrl+X) e undo/redo, che calcolano da
            // sé chi sparirà applicando lo scatto opposto. Uno scatto di pennellata resta
            // leggero come prima.
            function snapshotObjectPayload(o) {
                return {
                    id: o.id, name: o.name, visible: o.visible,
                    transform: JSON.parse(JSON.stringify(o.transform || makeDefaultTransform())),
                    data: JSON.parse(JSON.stringify(o.data || { metadata: {}, voxels: [] })),
                    rig: o.rig ? JSON.parse(JSON.stringify(o.rig)) : null
                };
            }

            function captureSnapshot(carry) {
                // pushHistory è agganciato direttamente come listener (15-rig.js:2560),
                // quindi qui può arrivare un Event al posto della lista: filtrarlo.
                const portati = Array.isArray(carry) ? carry.filter(Boolean) : [];
                return {
                    voxels: JSON.parse(JSON.stringify(currentModelData.voxels || [])),
                    payloads: portati.map(snapshotObjectPayload),
                    // Copia PROFONDA e completa del rig: prima mancavano `customAnims` (un
                    // Ctrl+Z dopo aver generato un'animazione AI la cancellava) e `weights`
                    // (annullava le correzioni del weight paint senza poterle ripristinare).
                    rig: rig ? {
                        bones: JSON.parse(JSON.stringify(rig.bones)),
                        pose: JSON.parse(JSON.stringify(rig.pose || {})),
                        // Canale di traslazione della posa: senza questa riga un
                        // keyframe "Location" non sopravviveva a un Ctrl+Z.
                        posePos: JSON.parse(JSON.stringify(rig.posePos || {})),
                        weights: rig.weights ? JSON.parse(JSON.stringify(rig.weights)) : null,
                        customAnims: JSON.parse(JSON.stringify(rig.customAnims || [])),
                        type: rig.type, binding: rig.binding
                    } : null,
                    selectedBoneIndex: selectedBoneIndex,
                    activeObjectId: activeObjectId,
                    sceneMeta: sceneObjects.map(o => ({
                        id: o.id, name: o.name, visible: o.visible,
                        transform: JSON.parse(JSON.stringify(o.transform || makeDefaultTransform()))
                    }))
                };
            }

            function pushHistory(carry) {
                undoStack.push(JSON.stringify(captureSnapshot(carry)));
                if (undoStack.length > MAX_HISTORY) undoStack.shift();
                redoStack.length = 0;
                updateHistoryButtons();
            }

            // Gli oggetti che spariranno applicando `target`: sono quelli il cui contenuto
            // va allegato allo scatto INVERSO, altrimenti il movimento opposto non ha più i
            // loro voxel per farli tornare.
            function objectsMissingFrom(target) {
                if (!target || !Array.isArray(target.sceneMeta)) return [];
                const ids = new Set(target.sceneMeta.map(m => m.id));
                return sceneObjects.filter(o => !ids.has(o.id));
            }

            function restoreSceneMeta(snap) {
                if (Array.isArray(snap.sceneMeta)) {
                    const rosa = snap.sceneMeta;
                    const idsRosa = new Set(rosa.map(m => m.id));
                    // 1. Via chi è nato DOPO lo scatto (Nuovo / Duplica / Shift+A / Unisci).
                    if (sceneObjects.some(o => !idsRosa.has(o.id))) {
                        sceneObjects = sceneObjects.filter(o => idsRosa.has(o.id));
                        if (typeof selectedObjectIds !== 'undefined') {
                            selectedObjectIds = selectedObjectIds.filter(id => idsRosa.has(id));
                        }
                    }
                    // 2. Torna chi era stato eliminato, se lo scatto ne porta il contenuto.
                    //    createObject accetta un id esplicito e tiene nextObjectId davanti,
                    //    così l'oggetto risorge con la propria identità e non con una nuova.
                    (Array.isArray(snap.payloads) ? snap.payloads : []).forEach(p => {
                        if (!p || sceneObjects.some(o => o.id === p.id)) return;
                        const obj = createObject(JSON.parse(JSON.stringify(p.data)), {
                            id: p.id, visible: p.visible,
                            transform: JSON.parse(JSON.stringify(p.transform || makeDefaultTransform()))
                        });
                        if (p.name) obj.name = p.name;
                        if (p.rig) obj.rig = JSON.parse(JSON.stringify(p.rig));
                    });
                    // 3. createObject accoda in fondo: rimette l'ordine di scena dello scatto.
                    const posto = new Map(rosa.map((m, k) => [m.id, k]));
                    sceneObjects.sort((a, b) =>
                        (posto.has(a.id) ? posto.get(a.id) : Infinity)
                        - (posto.has(b.id) ? posto.get(b.id) : Infinity));
                    // 4. Attributi (nome, visibilità, transform) di tutti quelli in rosa.
                    rosa.forEach(m => {
                        const obj = sceneObjects.find(o => o.id === m.id);
                        if (obj) { obj.name = m.name; obj.visible = m.visible; obj.transform = m.transform; }
                    });
                }
                if (snap.activeObjectId != null && sceneObjects.some(o => o.id === snap.activeObjectId)) {
                    setActiveObject(snap.activeObjectId);
                } else if (!sceneObjects.some(o => o.id === activeObjectId) && sceneObjects.length) {
                    // L'attivo è stato appena tolto di scena e lo scatto non ne indica un
                    // altro: senza questa riga currentModelData resterebbe puntato su un
                    // oggetto che non c'è più e il buildModel disegnerebbe un fantasma.
                    setActiveObject(sceneObjects[0].id);
                }
            }

            // I voxel di uno scatto appartengono all'oggetto che era attivo QUANDO lo
            // scatto e' stato preso. Scriverli mentre e' attivo un altro oggetto lo
            // sovrascrive in silenzio: e' il difetto che ha svuotato le primitive appena
            // create (Shift+A poi Ctrl+Z) e regalato alla Casa i 50 voxel dell'Albero
            // eliminato. Se quell'oggetto non esiste piu' (eliminato dopo lo scatto) i
            // voxel non hanno piu' una casa: si lasciano cadere, non si appoggiano al
            // primo che capita. Coperto da tests/test_undo_object_switch.mjs.
            function snapshotTargetIsActive(snap) {
                return snap.activeObjectId == null || snap.activeObjectId === activeObjectId;
            }

            // Seconda meta' del ripristino: SOLO il rig. Gira dopo buildModel, che
            // azzera anteprima e osso selezionato — vedi la nota su applySnapshot.
            function restoreRigFromSnapshot(snap) {
                if (snap.rig) {
                    // normalizeRig() ricostruisce l'oggetto COMPLETO (pesi dipinti +
                    // animazioni AI incluse): prima qui si copiavano solo bones/pose e
                    // ogni undo azzerava silenziosamente weight paint e clip generate.
                    const restored = (typeof normalizeRig === 'function')
                        ? normalizeRig(snap.rig)
                        : {
                            type: snap.rig.type || 'humanoid',
                            binding: snap.rig.binding || 'rigid',
                            bones: snap.rig.bones,
                            pose: snap.rig.pose || {},
                            posePos: snap.rig.posePos || {},
                            weights: snap.rig.weights || null,
                            customAnims: snap.rig.customAnims || []
                        };
                    rig = restored;
                }
                if (rig) {
                    rigType = rig.type;
                    rigTypeControl.querySelectorAll('.seg-btn').forEach(b =>
                        b.classList.toggle('active', b.dataset.rig === rigType));
                    // Il rig vive sull'oggetto: parcheggiarlo subito evita che il primo
                    // rebuild/cambio oggetto riadotti la versione pre-undo.
                    if (typeof stashRigToActiveObject === 'function') stashRigToActiveObject();
                    applyRig();
                    if (snap.selectedBoneIndex >= 0 && snap.selectedBoneIndex < rig.bones.length) {
                        selectBone(snap.selectedBoneIndex);
                    } else if (rig.bones.length) {
                        selectBone(typeof firstSelectableBone === 'function' ? firstSelectableBone() : 0);
                    }
                } else {
                    clearRigPreview();
                    rig = null;
                    selectedBoneIndex = -1;
                    const _o = (typeof getActiveObject === 'function') ? getActiveObject() : null;
                    if (_o) delete _o.rig;
                    if (typeof updateRigUI === 'function') updateRigUI();
                }
            }

            // undo/redo in tre tempi, e due cose vanno lasciate dove sono.
            // (1) La GUARDIA e' cio' che impedisce il danno: senza, i voxel dello scatto
            //     atterrano sull'oggetto attivo in quel momento e lo svuotano. La
            //     scrittura va DOPO restoreSceneMeta, che riporta attivo l'oggetto dello
            //     scatto: spostarla prima non sporca nulla (ci pensa la guardia) ma la
            //     rende un buco nell'acqua ogni volta che l'oggetto e' cambiato, e
            //     l'annullamento non ripristina piu' niente.
            // (2) buildModel() sta in mezzo, non in fondo: chiama clearRigPreview() e
            //     azzera selectedBoneIndex (05-build-model.js:7-19), mentre il ripristino
            //     del rig ricostruisce l'anteprima con applyRig() e riseleziona l'osso.
            //     Metterlo dopo spegnerebbe il rig a ogni Ctrl+Z.
            // Entrambe fissate da tests/test_undo_object_switch.mjs (gruppi [3] e [5]).
            function applySnapshot(snap) {
                restoreSceneMeta(snap);
                // Undo/redo rimpiazza l'intero array dei voxel: gli indici del renderer
                // incrementale non valgono piu'. (Il buildModel() che segue lo
                // rigenerera' comunque, ma invalidare qui evita ogni finestra di stato
                // incoerente se in futuro qualcuno cambiasse quell'ordine.)
                if (typeof invalidateIncremental === 'function') invalidateIncremental();
                if (snapshotTargetIsActive(snap)) currentModelData.voxels = snap.voxels;
                buildModel(false);
                restoreRigFromSnapshot(snap);
            }

            // Lo scatto opposto si prende PRIMA di applicare, e deve portarsi dietro il
            // contenuto degli oggetti che l'applicazione sta per far sparire: è ciò che
            // rende reversibile anche il ritorno. Senza, Ctrl+Z toglie la primitiva appena
            // creata e Ctrl+Y non ha più i suoi voxel per rimetterla.
            function undo() {
                if (!undoStack.length) return;
                const snap = JSON.parse(undoStack.pop());
                redoStack.push(JSON.stringify(captureSnapshot(objectsMissingFrom(snap))));

                applySnapshot(snap);
                updateHistoryButtons();
            }

            function redo() {
                if (!redoStack.length) return;
                const snap = JSON.parse(redoStack.pop());
                undoStack.push(JSON.stringify(captureSnapshot(objectsMissingFrom(snap))));

                applySnapshot(snap);
                updateHistoryButtons();
            }

            undoBtn.addEventListener('click', undo);
            redoBtn.addEventListener('click', redo);
            window.addEventListener('keydown', e => {
                const t = e.target;
                // I cursori di posa del rig sono <input type="range">: non hanno un "undo"
                // di testo nativo, quindi Ctrl+Z / Ctrl+Y deve restare GLOBALE anche quando
                // uno di essi ha il focus (altrimenti annullare una posa nel Rig non fa
                // nulla). I veri campi di testo, invece, tengono il loro undo nativo.
                const isRange = !!(t && t.tagName === 'INPUT' && t.type === 'range');
                // isTextEntry/isTypingTarget stanno in 01-scene-setup.js: unica fonte.
                // Un <select> NON e' piu' un "campo di testo" per Ctrl+Z: non ha undo
                // nativo, quindi bloccarlo lasciava l'undo morto dopo aver scelto una
                // voce in un menu a tendina del pannello sinistro.
                const isTextField = isTextEntry(t);

                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y') {
                        if (isTextField) return;               // lascia l'undo nativo del campo
                        e.preventDefault();
                        if ((e.key === 'y' || e.key === 'Y') || e.shiftKey) redo(); else undo();
                        // Togli il focus dal controllo cosi' etichette/gizmo riflettono lo
                        // stato ripristinato (e la prossima scorciatoia non trova ostacoli).
                        if (t && typeof t.blur === 'function' && !isTextField) t.blur();
                    }
                    // Ctrl+X = taglia l'OGGETTO attivo (la X di Blender), senza chiedere
                    // conferma: è un PASSO di cronologia come gli altri, quindi Ctrl+Z lo
                    // riporta indietro e una conferma sarebbe solo attrito. Sta qui dentro
                    // e non più in basso perché questo blocco esce su OGNI combinazione con
                    // Ctrl: un ramo dopo il `return` non verrebbe mai raggiunto.
                    if ((e.key === 'x' || e.key === 'X') && !e.shiftKey && !e.altKey) {
                        if (isTextField) return;               // lascia il taglio nativo
                        // Con una modale aperta la tastiera è sua, e sopra la timeline la X
                        // è già "elimina i keyframe selezionati": in nessuno dei due casi
                        // l'utente si aspetta di perdere un oggetto della scena.
                        if (typeof tlModalOpen === 'function' && tlModalOpen()) return;
                        if (typeof tlAreaActive === 'function' && tlAreaActive()) return;
                        if (typeof objDelete !== 'function') return;
                        e.preventDefault();
                        objDelete({ conferma: false });
                        if (t && typeof t.blur === 'function') t.blur();
                    }
                    return;
                }

                // Per le altre scorciatoie (Q/E/strumenti) non interferire mentre si
                // digita in un campo, si trascina un cursore, o quando il controllo
                // focalizzato usa davvero quel tasto (frecce/spazio su un <select>).
                if (isTypingTarget(e) || isRange) return;

                if (e.key === 'q' || e.key === 'Q') {
                    if (currentTool !== 'view') {
                        e.preventDefault();
                        const modes = ['auto', 'x', 'y', 'z'];
                        const idx = modes.indexOf(dragConstraintMode);
                        dragConstraintMode = modes[(idx + 1) % modes.length];
                        
                        if (isDraggingArea) {
                            recomputeActivePlane();
                            if (lastPointerEvent) {
                                projectPointerToPlane(lastPointerEvent);
                            }
                            updateDragPreview();
                        } else {
                            let lockedAxis = 'y';
                            if (dragConstraintMode === 'auto') {
                                lockedAxis = t('hud.dragAxisAuto');
                            } else {
                                lockedAxis = dragConstraintMode.toUpperCase();
                            }
                            if (dragConstraintHUD) {
                                // La chiave inglese (U+1F527) e' scritta come
                                // escape perche' le sorgenti restano ASCII: accenti e
                                // simboli stanno in ui/locales/*.json, non qui.
                                dragConstraintHUD.innerHTML = `<span>🔧 <b>${t('hud.dragAxisSet')}</b> ${lockedAxis}</span>`;
                                dragConstraintHUD.style.display = 'block';
                                if (window.hudTimeout) clearTimeout(window.hudTimeout);
                                window.hudTimeout = setTimeout(() => {
                                    if (!isDraggingArea) dragConstraintHUD.style.display = 'none';
                                }, 1500);
                            }
                        }
                        const dragAxisSelect = document.getElementById('dragAxisSelect');
                        if (dragAxisSelect) {
                            dragAxisSelect.querySelectorAll('.seg-btn').forEach(btn => {
                                btn.classList.toggle('active', btn.dataset.axis === dragConstraintMode);
                            });
                        }
                    }
                }

                // T2: Esc annulla il gesto di estrusione in corso (senza modifiche).
                if (e.key === 'Escape' && extrudeActive) {
                    e.preventDefault();
                    cancelExtrude();
                    return;
                }

                // T2: E arma l'estrusione dalla faccia sotto il cursore; se è già attiva, cicla l'asse.
                // Solo in Modalità Modifica e non su gizmo del rig. Non interferisce con Q (drag-constraint).
                if (KEYMAP.extrude && e.key.toLowerCase() === KEYMAP.extrude.toLowerCase() && !gizmoEnabled) {
                    if (editorMode !== 'object') {
                        e.preventDefault();
                        // T2b: se stai trascinando un rettangolo di selezione, E lo blocca
                        // e passa al gesto "profondità" (rettangolo -> cubo) lungo l'asse
                        // normale al piano; poi muovi il mouse su/giù per lo spessore.
                        if (isDraggingArea && !extrudeActive) {
                            if (startBoxDepth()) {
                                if (lastPointerEvent) updateBoxDepthFromPointer(lastPointerEvent);
                                updateDragPreview();
                                updateBoxDepthHUD();
                            }
                        } else if (extrudeActive) {
                            cycleExtrudeAxis();
                        } else if (lastPointerEvent) {
                            armExtrude(lastPointerEvent.clientX, lastPointerEvent.clientY);
                        }
                        return;
                    }
                }

                // Rig gizmo mode hotkeys (only when a rig is active on the rig tab).
                if (gizmoEnabled) {
                    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); setGizmoMode('rotate'); return; }
                    if (e.key === 'g' || e.key === 'G') { e.preventDefault(); setGizmoMode('translate'); return; }
                }

                // Draw-tool hotkeys (only meaningful on the draw tab, but harmless elsewhere).
                if (e.key === KEYMAP.brushDown) { e.preventDefault(); brushSizeInput.value = Math.max(1, brushSize - 1); brushSizeInput.dispatchEvent(new Event('input')); return; }
                if (e.key === KEYMAP.brushUp) { e.preventDefault(); brushSizeInput.value = Math.min(6, brushSize + 1); brushSizeInput.dispatchEvent(new Event('input')); return; }
                // Tool hotkeys risolti tramite KEYMAP.tools (rimappabile — vedi definizione in cima).
                const tool = KEYMAP.tools[e.key];
                if (tool && document.querySelector('.tab-panel[data-panel="draw"]').classList.contains('active')) {
                    e.preventDefault(); setTool(tool);
                }
            });

            // Switch the bone gizmo between rotate (pose) and translate (edit skeleton).