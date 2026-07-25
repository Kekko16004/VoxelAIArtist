            const clock = new THREE.Clock();
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
                renderer.render(scene, camera);
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