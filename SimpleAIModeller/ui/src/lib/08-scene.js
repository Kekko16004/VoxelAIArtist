// =======================================================================
//  08 - Scena Three.js: viewport, griglia, silhouette umana, luci
// =======================================================================

let renderer, scene, camera, controls, assetRoot, humanRef, gridHelper;
let _needsRender = true;
let currentBuilt = null;
let currentSpec = null;

function initScene() {
    const canvas = $('viewport');
    if (!canvas) return;
    const wrap = canvas.parentElement || document.body;

    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x0c0a14, 1);
    renderer.shadowMap.enabled = true;
    if (THREE.PCFSoftShadowMap !== undefined) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Tone mapping: senza, i metalli e le luci speculari si bruciano a bianco e
    // il modello sembra sovraesposto. ACES e' quello che usano i motori di
    // gioco, quindi cio' che si vede qui somiglia a cio' che si vedra' la'.
    if (THREE.ACESFilmicToneMapping !== undefined) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
    }
    if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    else if (renderer.outputEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
    camera.position.set(2.2, 1.6, 3.2);

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.8, 0);
    controls.addEventListener('change', () => { _needsRender = true; });

    // Luci: tre punti + rimbalzo da terra. Il rimbalzo non e' un vezzo — senza,
    // il sotto degli oggetti e' nero e la forma non si legge.
    const hemi = new THREE.HemisphereLight(0xc2d4ee, 0x3a3040, 0.55);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff4e6, 2.1);
    key.position.set(3, 6, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.55);
    fill.position.set(-4, 2, -2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffccaa, 0.7);
    rim.position.set(-1, 2.5, -5);
    scene.add(rim);
    const bounce = new THREE.DirectionalLight(0x6a7a90, 0.25);
    bounce.position.set(0, -3, 1);
    scene.add(bounce);

    // Piano che riceve l'ombra: da' appoggio visivo senza chiudere la scena.
    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), shadowMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = 0;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    // Griglia
    gridHelper = new THREE.GridHelper(10, 20, 0x445566, 0x2a3040);
    gridHelper.position.y = 0;
    scene.add(gridHelper);

    // Asse Y leggero
    const axis = new THREE.AxesHelper(0.5);
    axis.position.y = 0.001;
    scene.add(axis);

    // Silhouette umana di riferimento (1.70 m)
    humanRef = buildHumanSilhouette();
    humanRef.visible = loadPref('showHuman', true);
    scene.add(humanRef);

    assetRoot = new THREE.Group();
    assetRoot.name = 'asset';
    scene.add(assetRoot);

    function resize() {
        const w = wrap.clientWidth || 800;
        const h = wrap.clientHeight || 600;
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
        _needsRender = true;
    }
    window.addEventListener('resize', resize);
    resize();

    function loop() {
        requestAnimationFrame(loop);
        const damping = controls.enableDamping;
        if (damping) controls.update();
        if (_needsRender || damping) {
            renderer.render(scene, camera);
            _needsRender = false;
        }
    }
    loop();
}

function buildHumanSilhouette() {
    // Sagoma stilizzata alta 1.70 m: capsule per corpo e arti.
    const g = new THREE.Group();
    g.name = 'humanRef';
    const mat = new THREE.MeshStandardMaterial({
        color: 0x6a7a90, transparent: true, opacity: 0.35,
        flatShading: true, depthWrite: false,
    });
    function add(mesh, x, y, z) {
        mesh.position.set(x, y, z);
        mesh.material = mat;
        g.add(mesh);
    }
    // torso
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.45, 4, 8), mat);
    add(torso, 0, 1.15, 0);
    // head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), mat);
    add(head, 0, 1.58, 0);
    // legs
    const leg = () => new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.55, 4, 8), mat);
    add(leg(), 0.09, 0.45, 0);
    add(leg(), -0.09, 0.45, 0);
    // arms (abbassate)
    const arm = () => new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.45, 4, 8), mat);
    const aR = arm(); aR.rotation.z = 0.15; add(aR, 0.28, 1.05, 0);
    const aL = arm(); aL.rotation.z = -0.15; add(aL, -0.28, 1.05, 0);
    // posiziona a lato: x positivo rispetto all'asset
    g.position.set(1.2, 0, 0);
    return g;
}

function clearAsset() {
    if (!assetRoot) return;
    while (assetRoot.children.length) {
        const c = assetRoot.children.pop();
        if (c.geometry) c.geometry.dispose();
        // materiali shared: non dispose qui
    }
}

function showSpec(spec) {
    currentSpec = spec;
    clearAsset();
    clearMaterialCache();
    if (!spec) {
        currentBuilt = null;
        _needsRender = true;
        return null;
    }
    const built = buildSpec(spec);
    currentBuilt = built;
    const style = spec.style || 'lowpoly';
    const mats = spec.mats || {};

    // Outline toon: guscio invertito leggero.
    for (const part of built.parts) {
        const mesh = meshToThree(part, mats, style, spec.smooth);
        if (!mesh) continue;
        assetRoot.add(mesh);
        if (style === 'toon') {
            const outlineMat = new THREE.MeshBasicMaterial({
                color: 0x0a0a12, side: THREE.BackSide,
            });
            const outline = new THREE.Mesh(mesh.geometry, outlineMat);
            outline.scale.multiplyScalar(1.03);
            outline.name = mesh.name + '_outline';
            assetRoot.add(outline);
        }
    }

    // Adatta camera all'ingombro.
    fitCameraToAsset(built.bounds);
    // Sposta la silhouette accanto all'asset.
    if (humanRef) {
        const b = built.bounds;
        humanRef.position.x = b.max[0] + 0.6;
        humanRef.position.z = b.center[2];
    }
    _needsRender = true;
    return built;
}

function fitCameraToAsset(bounds) {
    if (!bounds || !camera) return;
    const size = bounds.size;
    const maxDim = Math.max(size[0], size[1], size[2], 0.5);
    const dist = maxDim * 2.4;
    const cx = bounds.center[0], cy = Math.max(bounds.center[1], size[1] * 0.4), cz = bounds.center[2];
    camera.position.set(cx + dist * 0.7, cy + dist * 0.45, cz + dist * 0.9);
    controls.target.set(cx, cy, cz);
    controls.update();
    camera.near = Math.max(0.01, maxDim / 100);
    camera.far = Math.max(100, maxDim * 50);
    camera.updateProjectionMatrix();
}

function setView(name) {
    if (!currentBuilt || !camera) return;
    const b = currentBuilt.bounds;
    const c = b.center;
    const d = Math.max(b.size[0], b.size[1], b.size[2], 0.5) * 2.2;
    const pos = {
        front:  [c[0], c[1], c[2] + d],
        back:   [c[0], c[1], c[2] - d],
        left:   [c[0] - d, c[1], c[2]],
        right:  [c[0] + d, c[1], c[2]],
        top:    [c[0], c[1] + d, c[2] + 0.01],
        persp:  [c[0] + d * 0.7, c[1] + d * 0.5, c[2] + d * 0.8],
    }[name] || [c[0] + d * 0.7, c[1] + d * 0.5, c[2] + d * 0.8];
    camera.position.set(pos[0], pos[1], pos[2]);
    controls.target.set(c[0], c[1], c[2]);
    controls.update();
    _needsRender = true;
}

/** Contact sheet: 6 viste in un unico canvas 2D, con silhouette umana. */
function renderContactSheet(opts) {
    opts = opts || {};
    const tileW = opts.tileW || 320;
    const tileH = opts.tileH || 240;
    const labels = ['front', 'back', 'left', 'right', 'top', 'persp'];
    const cols = 3, rows = 2;
    const sheet = document.createElement('canvas');
    sheet.width = tileW * cols;
    sheet.height = tileH * rows;
    const ctx = sheet.getContext('2d');
    ctx.fillStyle = '#0c0a14';
    ctx.fillRect(0, 0, sheet.width, sheet.height);

    // Salva stato camera.
    const savedPos = camera.position.clone();
    const savedTarget = controls.target.clone();
    const savedHuman = humanRef ? humanRef.visible : false;
    if (humanRef) humanRef.visible = true;

    const tmp = document.createElement('canvas');
    tmp.width = tileW; tmp.height = tileH;

    for (let i = 0; i < labels.length; i++) {
        setView(labels[i]);
        // Render offscreen: ridimensiona il renderer temporaneamente.
        const prevSize = new THREE.Vector2();
        renderer.getSize(prevSize);
        const prevPr = renderer.getPixelRatio();
        renderer.setPixelRatio(1);
        renderer.setSize(tileW, tileH, false);
        camera.aspect = tileW / tileH;
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
        // Copia i pixel.
        ctx.drawImage(renderer.domElement, 0, 0, tileW, tileH,
            (i % cols) * tileW, Math.floor(i / cols) * tileH, tileW, tileH);
        // Etichetta.
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect((i % cols) * tileW, Math.floor(i / cols) * tileH, 70, 18);
        ctx.fillStyle = '#cde';
        ctx.font = '12px sans-serif';
        ctx.fillText(labels[i], (i % cols) * tileW + 6, Math.floor(i / cols) * tileH + 13);
        // Ripristina size.
        renderer.setPixelRatio(prevPr);
        renderer.setSize(prevSize.x, prevSize.y, false);
        camera.aspect = prevSize.x / Math.max(1, prevSize.y);
        camera.updateProjectionMatrix();
    }

    // Scala metrica.
    if (currentBuilt) {
        const s = currentBuilt.bounds.size;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(8, sheet.height - 28, 220, 20);
        ctx.fillStyle = '#9cf';
        ctx.font = '11px monospace';
        ctx.fillText(
            'size ' + s[0].toFixed(2) + ' x ' + s[1].toFixed(2) + ' x ' + s[2].toFixed(2) + ' m  |  human 1.70 m',
            14, sheet.height - 14);
    }

    // Ripristina camera.
    camera.position.copy(savedPos);
    controls.target.copy(savedTarget);
    controls.update();
    if (humanRef) humanRef.visible = savedHuman;
    _needsRender = true;

    return sheet;
}

function contactSheetDataURL(opts) {
    const sheet = renderContactSheet(opts);
    return sheet.toDataURL('image/png');
}
