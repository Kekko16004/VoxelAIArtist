            /* ===== WAVE3: Pannello Proprietà oggetto attivo (pannello destro) ======
             * Mostra e modifica le proprietà dell'oggetto ATTIVO: nome, visibilità e
             * transform (posizione X/Y/Z, rotazione Y a step di 90°, scala).
             *
             * Nota architetturale importante: l'oggetto attivo è SEMPRE a transform
             * identità (editing/raycast/gizmo/rig lavorano in coordinate voxel dirette).
             * Perciò i campi transform qui rappresentano una trasformazione da APPLICARE
             * (bake) all'oggetto: modificarli aggiorna obj.transform e su "Applica" viene
             * cotto nei voxel (riuso bakeTransform), poi resettato a identità.
             * Limite noto (già presente nel modello): coordinate intere → posizione/scala
             * arrotondate e rotazione snappata al multiplo di 90° più vicino. */
            function renderProperties() {
                const panel = document.getElementById('propertiesPanel');
                if (!panel) return;
                const obj = (typeof getActiveObject === 'function') ? getActiveObject() : null;

                if (!obj) {
                    panel.innerHTML = '<div class="screens-section-note" data-i18n="properties.empty">Nessun oggetto selezionato.</div>';
                    if (typeof applyI18n === 'function') applyI18n(panel);
                    return;
                }

                // NB: la variabile del transform si chiama `xf`, NON `t`: `t()` e' la
                // funzione di traduzione (23-i18n.js) e qui dentro serve.
                const xf = obj.transform || (typeof makeDefaultTransform === 'function' ? makeDefaultTransform() : { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 });
                const rotDeg = Math.round(((xf.rotationY || 0) * 180 / Math.PI));
                const voxCount = (obj.data && obj.data.voxels ? obj.data.voxels.length : 0);

                panel.innerHTML =
                    '<div class="control-row">' +
                        '<label data-i18n="properties.name">Nome</label>' +
                        '<input type="text" id="propName" class="field-strong" style="width:170px; padding:6px; font-size:12px;">' +
                    '</div>' +
                    '<div class="control-row">' +
                        '<label data-i18n="properties.visible">Visibile</label>' +
                        '<label class="switch"><input type="checkbox" id="propVisible"><span class="slider"></span></label>' +
                    '</div>' +
                    '<div class="menu-sep"></div>' +
                    '<div class="menu-label" data-i18n="properties.transform">Trasformazione</div>' +
                    '<div style="display:flex; gap:6px;">' +
                        '<label style="flex:1; font-size:11px; color:var(--text-muted);">X<input type="number" id="propPosX" class="field-strong" step="1" value="0" style="width:100%; padding:5px; font-size:12px; margin-top:2px;"></label>' +
                        '<label style="flex:1; font-size:11px; color:var(--text-muted);">Y<input type="number" id="propPosY" class="field-strong" step="1" value="0" style="width:100%; padding:5px; font-size:12px; margin-top:2px;"></label>' +
                        '<label style="flex:1; font-size:11px; color:var(--text-muted);">Z<input type="number" id="propPosZ" class="field-strong" step="1" value="0" style="width:100%; padding:5px; font-size:12px; margin-top:2px;"></label>' +
                    '</div>' +
                    '<div class="control-row" style="margin-top:6px;">' +
                        '<label data-i18n="properties.rotation">Rotazione Y (90°)</label>' +
                        '<input type="number" id="propRotY" class="field-strong" step="90" value="0" style="width:80px; padding:5px; font-size:12px;">' +
                    '</div>' +
                    '<div class="control-row">' +
                        '<label data-i18n="properties.scale">Scala</label>' +
                        '<input type="number" id="propScale" class="field-strong" step="1" min="1" value="1" style="width:80px; padding:5px; font-size:12px;">' +
                    '</div>' +
                    ((typeof rig !== 'undefined' && rig && rig.bones) ?
                        '<div class="menu-sep"></div>' +
                        '<div class="menu-label" data-i18n="rig.rotateModel">Ruota Modello</div>' +
                        '<div class="control-row">' +
                            '<label data-i18n="properties.orientation" data-i18n-title="rig.rotateModelTitle">Orientamento</label>' +
                            '<div style="display:flex; gap:4px;">' +
                                '<button class="btn btn-secondary" id="propRotRigM90Btn" style="padding:4px 8px; font-size:11px;">-90°</button>' +
                                '<button class="btn btn-secondary" id="propRotRig90Btn" style="padding:4px 8px; font-size:11px;">+90°</button>' +
                                '<button class="btn btn-secondary" id="propRotRig180Btn" style="padding:4px 8px; font-size:11px;">180°</button>' +
                            '</div>' +
                        '</div>' : '') +
                    '<div class="screens-section-note" data-i18n="properties.liveNote">Anteprima dal vivo mentre modifichi. Al rilascio del campo la trasformazione viene cotta nei voxel (coordinate intere, rotazione a 90°).</div>' +
                    '<div class="screens-section-note" style="text-align:center;" id="propVoxCount"></div>';

                // Conteggio voxel: testo tradotto scritto con textContent (le traduzioni
                // possono contenere apostrofi, quindi niente innerHTML).
                const voxCountEl = document.getElementById('propVoxCount');
                if (voxCountEl) voxCountEl.textContent = t('rig.voxelCount', { n: voxCount });

                // Popola i valori.
                const nameEl = document.getElementById('propName');
                const visEl = document.getElementById('propVisible');
                if (nameEl) nameEl.value = obj.name || '';
                if (visEl) visEl.checked = !!obj.visible;
                document.getElementById('propPosX').value = xf.position.x || 0;
                document.getElementById('propPosY').value = xf.position.y || 0;
                document.getElementById('propPosZ').value = xf.position.z || 0;
                document.getElementById('propRotY').value = rotDeg;
                document.getElementById('propScale').value = (xf.scale === undefined) ? 1 : xf.scale;

                // Nome → applicazione immediata (aggiorna anche l'outliner).
                if (nameEl) nameEl.addEventListener('change', () => {
                    const v = nameEl.value.trim();
                    if (v) { obj.name = v; if (typeof renderObjectsList === 'function') renderObjectsList(); }
                });
                // Visibilità → immediata.
                if (visEl) visEl.addEventListener('change', () => {
                    obj.visible = !!visEl.checked;
                    if (typeof buildModel === 'function') buildModel(false);
                    if (typeof renderObjectsList === 'function') renderObjectsList();
                });

                // Legge i valori correnti dei campi transform (grezzi, non arrotondati:
                // l'anteprima live è fluida; l'arrotondamento avviene solo al bake).
                function readFields() {
                    const px = parseFloat(document.getElementById('propPosX').value) || 0;
                    const py = parseFloat(document.getElementById('propPosY').value) || 0;
                    const pz = parseFloat(document.getElementById('propPosZ').value) || 0;
                    const rd = parseFloat(document.getElementById('propRotY').value) || 0;
                    let sc = parseFloat(document.getElementById('propScale').value);
                    if (!(sc > 0)) sc = 1;
                    return { position: { x: px, y: py, z: pz }, rotationY: (rd * Math.PI / 180), scale: sc };
                }

                const posIds = ['propPosX', 'propPosY', 'propPosZ', 'propRotY', 'propScale'];

                // input → anteprima LIVE (fluida, visiva, non distruttiva): la trasformazione
                // è mostrata su modelPivot senza toccare i voxel (vedi setLiveTransform).
                posIds.forEach(id => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    el.addEventListener('input', () => {
                        if (typeof setLiveTransform === 'function') setLiveTransform(readFields());
                    });
                    // change (blur/invio) → COMMIT: cuoce la trasformazione nei voxel una
                    // sola volta, azzera l'anteprima e ricostruisce. Una voce di undo.
                    el.addEventListener('change', () => {
                        const nxf = readFields();
                        if (typeof clearLiveTransform === 'function') clearLiveTransform();
                        // Niente da cuocere se è l'identità (evita voci di undo inutili).
                        if (typeof isIdentityTransform === 'function' && isIdentityTransform(
                            { position: { x: Math.round(nxf.position.x), y: Math.round(nxf.position.y), z: Math.round(nxf.position.z) },
                              rotationY: nxf.rotationY, scale: nxf.scale })) {
                            return;
                        }
                        if (typeof pushHistory === 'function') { try { pushHistory(); } catch (e) {} }
                        obj.transform = {
                            position: { x: Math.round(nxf.position.x), y: Math.round(nxf.position.y), z: Math.round(nxf.position.z) },
                            rotationY: nxf.rotationY,
                            scale: nxf.scale
                        };
                        if (typeof bakeTransform === 'function') bakeTransform(obj);
                        if (typeof rebuildVoxelMap === 'function') rebuildVoxelMap();
                        if (typeof buildModel === 'function') buildModel(false);
                        renderProperties();
                        if (typeof renderObjectsList === 'function') renderObjectsList();
                    });
                });

                // Ruota il MODELLO (non lo scheletro): i voxel girano davvero e il rig
                // viene ri-legato, cosi' le animazioni restano corrette. Vedi
                // rotateModelY() in 15-rig.js.
                const pRigM90 = document.getElementById('propRotRigM90Btn');
                const pRig90 = document.getElementById('propRotRig90Btn');
                const pRig180 = document.getElementById('propRotRig180Btn');
                const rotModel = deg => { if (typeof rotateModelY === 'function') rotateModelY(deg); };
                if (pRigM90) pRigM90.addEventListener('click', () => rotModel(-90));
                if (pRig90) pRig90.addEventListener('click', () => rotModel(90));
                if (pRig180) pRig180.addEventListener('click', () => rotModel(180));

                if (typeof applyI18n === 'function') applyI18n(panel);
            }

            // Aggancia il render delle proprietà a ogni cambio di oggetto attivo, avvolgendo
            // le funzioni esistenti senza toccarle (04-objects.js resta invariato).
            (function hookProperties() {
                if (typeof selectActiveObjectAndRefresh === 'function') {
                    const _origSelect = selectActiveObjectAndRefresh;
                    selectActiveObjectAndRefresh = function (id) {
                        const r = _origSelect.apply(this, arguments);
                        try { renderProperties(); } catch (e) {}
                        return r;
                    };
                }
                if (typeof renderObjectsList === 'function') {
                    const _origRender = renderObjectsList;
                    renderObjectsList = function () {
                        const r = _origRender.apply(this, arguments);
                        try { renderProperties(); } catch (e) {}
                        return r;
                    };
                }
                // Primo render dopo il boot.
                try { renderProperties(); } catch (e) {}
            })();
