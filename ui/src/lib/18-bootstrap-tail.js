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
            let needsRender = true;
            function requestRender() { needsRender = true; }

            // OrbitControls emette 'change' a ogni movimento di camera (drag, zoom,
            // damping): e' il segnale piu' affidabile per sapere che va ridisegnato.
            if (controls && typeof controls.addEventListener === 'function') {
                controls.addEventListener('change', requestRender);
            }
            // Un resize cambia la viewport: serve un frame nuovo.
            window.addEventListener('resize', requestRender);

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
                if (rigPreviewActive) { updateBoneMarker(); }

                // T1 Fase B: mantieni il box di selezione allineato all'oggetto attivo.
                if (selectionBoxHelper) selectionBoxHelper.update();

                controls.update();

                // Disegna solo quando serve: qualcosa e' cambiato (needsRender), oppure
                // c'e' un movimento in corso (rotazione, animazione rig, damping camera).
                const animating = rotating
                    || (mixer && rigPreviewActive)
                    || (controls && controls.enableDamping && controls.autoRotate);
                if (needsRender || animating) {
                    renderer.render(scene, camera);
                    needsRender = false;
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
            animate();
        });