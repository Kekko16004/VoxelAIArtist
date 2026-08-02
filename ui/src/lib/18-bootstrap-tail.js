            const clock = new THREE.Clock();

            // ===== RENDER ON-DEMAND (F7) =====
            // Prima si rinderizzava a 60 fps anche con la scena ferma: GPU e batteria
            // consumate per ridisegnare pixel identici. Ora il frame si disegna solo se
            // qualcosa e' cambiato davvero. Chi modifica la scena chiama requestRender().
            //
            // Le sorgenti di movimento continuo (rotazione automatica, clip di
            // animazione del rig, damping di OrbitControls) tengono vivo il loop da
            // sole: la condizione `needsRender` sotto le riconosce, quindi la rotazione
            // resta fluida come prima.
            // `renderBudget` = quanti frame disegnare ancora. requestRender() lo
            // ricarica. Non e' un semplice flag booleano di proposito: molte modifiche
            // alla scena avvengono in piu' passaggi (anteprima -> commit -> rebuild) e
            // un solo frame catturerebbe uno stato intermedio.
            let renderBudget = 3;
            function requestRender(frames) {
                const n = frames || 3;
                if (n > renderBudget) renderBudget = n;
            }

            // OrbitControls emette 'change' a ogni movimento di camera (drag, zoom,
            // damping): e' il segnale piu' affidabile per sapere che va ridisegnato.
            if (controls && typeof controls.addEventListener === 'function') {
                controls.addEventListener('change', requestRender);
            }
            // Un resize cambia la viewport: serve un frame nuovo.
            window.addEventListener('resize', () => requestRender(3));

            // ===== RETE DI SICUREZZA CONTRO LO SCHERMO CONGELATO =====
            // Decine di percorsi modificano la scena senza passare da buildModel():
            // il ghost del pennello, il piano di simmetria, il gizmo del rig, le
            // anteprime di estrusione, la visibilita' degli oggetti. Pretendere che
            // ognuno ricordi di chiamare requestRender() e' fragile: UNO dimenticato
            // significa interfaccia bloccata.
            // Quindi: qualunque input dell'utente ricarica il budget per un po' di
            // frame. Il risparmio resta dove serve davvero (scena ferma, nessun
            // input), ma l'app non puo' piu' apparire congelata mentre ci si lavora.
            const KEEP_ALIVE_FRAMES = 30;   // ~0,5 s a 60fps dopo l'ultimo input
            ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup',
             'touchstart', 'touchmove', 'touchend', 'mousedown', 'mouseup', 'click'
            ].forEach(evt => {
                window.addEventListener(evt, () => requestRender(KEEP_ALIVE_FRAMES),
                    { passive: true, capture: true });
            });
            // Cambi di stato dell'interfaccia (input, select, checkbox) idem.
            ['change', 'input'].forEach(evt => {
                window.addEventListener(evt, () => requestRender(KEEP_ALIVE_FRAMES),
                    { passive: true, capture: true });
            });

            function animate() {
                requestAnimationFrame(animate);
                const dt = clock.getDelta();

                // Auto rotation is only active in view mode so it never fights editing.
                const rotating = currentTool === 'view' && rotationMode !== 'none';

                if (rotating && rotationMode === 'object') {
                    // Turntable: spin the model around its own vertical axis. The pivot
                    // sits at the model center, so this is a clean in-place rotation.
                    modelPivot.rotation.y += rotationSpeed * dt;
                    controls.autoRotate = false;
                } else if (rotating && rotationMode === 'orbit') {
                    // The Finals style: the camera orbits smoothly around the target.
                    // OrbitControls handles this with frame-rate-independent damping.
                    controls.autoRotate = true;
                    controls.autoRotateSpeed = rotationSpeed * 2.0;
                } else {
                    controls.autoRotate = false;
                }

                // Drive rig animation clips and keep the joint marker on the bone.
                if (mixer) { mixer.update(dt); }
                if (rigPreviewActive) {
                    updateBoneMarker();
                    // I pallini dei giunti hanno dimensione costante a SCHERMO: il raggio in
                    // unita' mondo dipende dalla distanza dalla camera, quindi va ricalcolato
                    // a ogni frame (qui e' gratis: con il rig attivo si renderizza comunque).
                    updateJointHandles();
                }

                // Timeline: avanza il playhead con lo stesso dt del mixer, cosi' il
                // cursore non deriva rispetto ai fotogrammi realmente mostrati.
                if (typeof tlTick === 'function') tlTick(dt);

                // T1 Fase B: mantieni il box di selezione allineato all'oggetto attivo.
                if (selectionBoxHelper) selectionBoxHelper.update();

                controls.update();

                // Disegna se c'e' budget residuo o se qualcosa e' in movimento
                // (rotazione automatica, clip del rig, damping della camera).
                const animating = rotating
                    || mixer
                    || rigPreviewActive
                    || (typeof tlIsPlaying === 'function' && tlIsPlaying())
                    || (controls && controls.autoRotate);
                if (renderBudget > 0 || animating) {
                    renderer.render(scene, camera);
                    if (renderBudget > 0) renderBudget--;
                }
            }

            // T1 Fase A: wrap the initial model as the first (active) scene object so
            // currentModelData is always a live view of an object in sceneObjects.
            (function initScene() {
                const first = createObject(currentModelData);
                setActiveObject(first.id);
            })();

            // Build Initial Model & start animate
            buildModel();
            applyEditorMode(); // T1 Fase B: imposta badge/stato iniziale
            // Sezioni di sinistra richiudibili. Va fatto qui, a DOM completo e dopo che
            // i moduli hanno agganciato i loro listener: la funzione arricchisce il
            // markup esistente e non sposta nodi, quindi non puo' rubare handler.
            if (typeof initCollapsibleSections === 'function') initCollapsibleSections(document);
            animate();
        });