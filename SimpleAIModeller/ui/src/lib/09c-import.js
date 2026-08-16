// =======================================================================
//  09c - Import: spec .sam.json, GLB/OBJ come RIFERIMENTO
//
//  Due cose diverse e non vanno confuse:
//   - una spec si RIAPRE (torna modificabile, parametri compresi);
//   - una mesh esterna non e' convertibile in spec parametrica, quindi
//     entra come RIFERIMENTO: si vede accanto/sovrapposta e serve a
//     confrontare proporzioni. Fingere di importarla come nodi darebbe un
//     asset non piu' modificabile che sembra modificabile.
// =======================================================================

let referenceObj = null;

async function importSpecFile(file) {
    const text = await file.text();
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(t('err.badJson'));
    }
    // Passa dal server: normalizza, avvisa, e riempie i default. Farlo qui
    // duplicherebbe `normalize_spec`.
    const data = await apiPost('/api/asset/normalize', { spec: raw });
    return data;
}

async function importReferenceFile(file) {
    const name = (file.name || '').toLowerCase();
    const buf = await file.arrayBuffer();
    clearReference();
    if (name.endsWith('.glb') || name.endsWith('.gltf')) {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const loader = new GLTFLoader();
        return new Promise((resolve, reject) => {
            loader.parse(buf, '', (gltf) => {
                referenceObj = gltf.scene;
                prepareReference(referenceObj);
                resolve(referenceInfo());
            }, reject);
        });
    }
    if (name.endsWith('.obj')) {
        const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
        const loader = new OBJLoader();
        const txt = new TextDecoder().decode(buf);
        referenceObj = loader.parse(txt);
        prepareReference(referenceObj);
        return referenceInfo();
    }
    throw new Error(t('err.unsupportedFile', { name: file.name }));
}

function prepareReference(obj) {
    const mat = new THREE.MeshStandardMaterial({
        color: 0x4f8cff, transparent: true, opacity: 0.28,
        roughness: 0.8, depthWrite: false, side: THREE.DoubleSide,
    });
    obj.traverse((c) => {
        if (c.isMesh) {
            c.material = mat;
            c.castShadow = false;
            c.receiveShadow = false;
        }
    });
    obj.name = 'reference';
    scene.add(obj);
    _needsRender = true;
}

function referenceInfo() {
    if (!referenceObj) return null;
    const box = new THREE.Box3().setFromObject(referenceObj);
    const size = new THREE.Vector3();
    box.getSize(size);
    return { size: [size.x, size.y, size.z], min: box.min.toArray() };
}

function clearReference() {
    if (!referenceObj) return;
    scene.remove(referenceObj);
    referenceObj.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material && c.material.dispose) c.material.dispose();
    });
    referenceObj = null;
    _needsRender = true;
}

/** Trascinamento su tutta la finestra: la via piu' rapida per aprire un file. */
function wireDragDrop() {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('dragover', (e) => {
        stop(e);
        document.body.classList.add('dragging');
    });
    window.addEventListener('dragleave', (e) => {
        stop(e);
        document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', async (e) => {
        stop(e);
        document.body.classList.remove('dragging');
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        await openAnyFile(file);
    });
}

async function openAnyFile(file) {
    const name = (file.name || '').toLowerCase();
    try {
        if (name.endsWith('.json')) {
            const data = await importSpecFile(file);
            appState.plan = null;
            renderPlan(null);
            pushHistory();
            const built = showSpec(data.spec);
            appState.spec = data.spec;
            appState.built = built;
            const defects = validateAll(data.spec, built, { hasPlan: false });
            showSpecInUi(data.spec, built, defects);
            setStatus(t('status.imported', { name: file.name }), 'ok');
        } else {
            const info = await importReferenceFile(file);
            setStatus(t('status.reference', {
                name: file.name,
                size: info ? info.size.map(v => v.toFixed(2)).join(' x ') : '?',
            }), 'ok');
        }
    } catch (e) {
        setStatus(t('err.generic', { msg: e.message || e }), 'error');
    }
}
