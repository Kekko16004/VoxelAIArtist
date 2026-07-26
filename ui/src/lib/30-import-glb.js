/**
 * VoxelAIArtist - Importazione e Voxelizzazione GLB/GLTF
 * Utilizza THREE.Raycaster per scansionare il modello su 3 assi ortogonali,
 * ricavando il guscio esterno (shell) e campionando i colori dalle texture.
 */

window.importGlbFormat = function (file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function (e) {
            const buffer = e.target.result;
            const loader = new THREE.GLTFLoader();
            loader.parse(buffer, '', async (gltf) => {
                try {
                    const result = await voxelizeScene(gltf.scene);
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            }, (err) => {
                reject(new Error("Errore nel parsing del GLB: " + err.message));
            });
        };
        reader.onerror = () => reject(new Error("Impossibile leggere il file"));
        reader.readAsArrayBuffer(file);
    });
};

async function voxelizeScene(gltfScene, maxGridSize = 64) {
    const overlay = document.getElementById('importOverlay');
    const progBar = document.getElementById('importProgressBar');
    const progText = document.getElementById('importProgressText');
    
    if (overlay) overlay.style.display = 'flex';
    if (progBar) progBar.style.width = '0%';
    if (progText) progText.textContent = 'Calcolo dimensioni...';

    try {
        // Permette alla UI di aggiornarsi
        await new Promise(r => setTimeout(r, 10));

        // Forziamo DoubleSide su tutti i materiali e aggiorniamo la matrice PRIMA di calcolare la Bounding Box
        gltfScene.traverse(child => {
            if (child.isMesh && child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => { if (m) m.side = THREE.DoubleSide; });
                } else {
                    child.material.side = THREE.DoubleSide;
                }
            }
        });
        gltfScene.updateMatrixWorld(true);

        // 1. Calcola la Bounding Box totale
        const box = new THREE.Box3().setFromObject(gltfScene);
        if (box.isEmpty()) {
            throw new Error("Il modello GLB è vuoto");
        }

        const size = new THREE.Vector3();
        box.getSize(size);

        // 2. Determina la scala per far stare il modello nella griglia massima
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim === 0) {
            throw new Error("Il modello ha dimensione 0");
        }

        const scale = (maxGridSize - 2) / maxDim; // Margine di 1 voxel per lato
        const W = Math.ceil(size.x * scale) + 2;
        const H = Math.ceil(size.y * scale) + 2;
        const D = Math.ceil(size.z * scale) + 2;

        function worldToVoxel(pt) {
            const vx = Math.round((pt.x - box.min.x) * scale) + 1;
            const vy = Math.round((pt.y - box.min.y) * scale) + 1;
            const vz = Math.round((pt.z - box.min.z) * scale) + 1;
            return { x: vx, y: vy, z: vz };
        }

        // 3. Sistema di caching per il campionamento Texture
        const textureCanvasCache = new Map();

        function getTexturePixel(map, u, v) {
            if (!map || !map.image) return null;
            if (!textureCanvasCache.has(map.uuid)) {
                const img = map.image;
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                    if (map.flipY) {
                        ctx.translate(0, img.height);
                        ctx.scale(1, -1);
                    }
                    ctx.drawImage(img, 0, 0);
                    textureCanvasCache.set(map.uuid, { ctx, w: img.width, h: img.height });
                } else {
                    textureCanvasCache.set(map.uuid, null);
                }
            }
            const cache = textureCanvasCache.get(map.uuid);
            if (!cache) return null;
            let tx = u;
            let ty = map.flipY ? v : (1.0 - v);
            tx = tx - Math.floor(tx);
            ty = ty - Math.floor(ty);
            if (tx < 0) tx += 1;
            if (ty < 0) ty += 1;
            const px = Math.floor(tx * cache.w);
            const py = Math.floor(ty * cache.h);
            try {
                const pixel = cache.ctx.getImageData(px, py, 1, 1).data;
                if (pixel[3] < 10) return null;
                return new THREE.Color(pixel[0]/255, pixel[1]/255, pixel[2]/255);
            } catch(e) {
                return null;
            }
        }

        function sampleColor(intersect) {
            let color = new THREE.Color(0x888888);
            const mat = intersect.object.material;
            if (mat) {
                const m = Array.isArray(mat) ? mat[intersect.face?.materialIndex || 0] : mat;
                if (m) {
                    if (m.color) color.copy(m.color);
                    if (m.map && intersect.uv) {
                        const texColor = getTexturePixel(m.map, intersect.uv.x, intersect.uv.y);
                        if (texColor) color.copy(texColor);
                    }
                }
            }
            return '#' + color.getHexString();
        }

        const voxelSet = new Map();
        const raycaster = new THREE.Raycaster();

        // 4. Raycasting lungo i 3 assi ortogonali (async chunks)
        const step = 1.0 / scale;
        
        // Calcoliamo i passi totali stimati per la progress bar
        const stepsX = Math.ceil((box.max.x - box.min.x) / step);
        const stepsY = Math.ceil((box.max.y - box.min.y) / step);
        const stepsZ = Math.ceil((box.max.z - box.min.z) / step);
        const totalRays = (stepsX * stepsZ) * 2 + (stepsX * stepsY) * 2 + (stepsY * stepsZ) * 2;
        let raysProcessed = 0;

        async function castRaysAsync(axis1, axis2, rayDir, min1, max1, min2, max2, rayOriginBase, name) {
            if (progText) progText.textContent = `Scansione ${name}...`;
            let countSinceYield = 0;
            for (let a = min1; a <= max1; a += step) {
                for (let b = min2; b <= max2; b += step) {
                    const origin = new THREE.Vector3();
                    origin[axis1] = a;
                    origin[axis2] = b;
                    origin[rayDir.axis] = rayOriginBase;
                    
                    raycaster.set(origin, rayDir.vec);
                    const hits = raycaster.intersectObject(gltfScene, true);
                    
                    for (let hit of hits) {
                        const v = worldToVoxel(hit.point);
                        const key = `${v.x},${v.y},${v.z}`;
                        if (!voxelSet.has(key)) {
                            voxelSet.set(key, sampleColor(hit));
                        }
                    }
                    raysProcessed++;
                    countSinceYield++;
                    if (countSinceYield > 100) { // Yield ogni 100 raggi (bilanciamento UI / velocità)
                        countSinceYield = 0;
                        if (progBar) progBar.style.width = Math.min(100, Math.round((raysProcessed / totalRays) * 100)) + '%';
                        await new Promise(r => setTimeout(r, 0));
                    }
                }
            }
        }

        await castRaysAsync('x', 'z', { axis: 'y', vec: new THREE.Vector3(0, -1, 0) }, box.min.x, box.max.x, box.min.z, box.max.z, box.max.y + step, 'Dall\'alto');
        await castRaysAsync('x', 'y', { axis: 'z', vec: new THREE.Vector3(0, 0, -1) }, box.min.x, box.max.x, box.min.y, box.max.y, box.max.z + step, 'Di fronte');
        await castRaysAsync('y', 'z', { axis: 'x', vec: new THREE.Vector3(-1, 0, 0) }, box.min.y, box.max.y, box.min.z, box.max.z, box.max.x + step, 'Da destra');
        await castRaysAsync('x', 'z', { axis: 'y', vec: new THREE.Vector3(0, 1, 0) }, box.min.x, box.max.x, box.min.z, box.max.z, box.min.y - step, 'Dal basso');
        await castRaysAsync('x', 'y', { axis: 'z', vec: new THREE.Vector3(0, 0, 1) }, box.min.x, box.max.x, box.min.y, box.max.y, box.min.z - step, 'Da dietro');
        await castRaysAsync('y', 'z', { axis: 'x', vec: new THREE.Vector3(1, 0, 0) }, box.min.y, box.max.y, box.min.z, box.max.z, box.min.x - step, 'Da sinistra');

        if (progText) progText.textContent = 'Rendering e culling scena 3D...';
        if (progBar) progBar.style.width = '100%';
        await new Promise(r => setTimeout(r, 20));

        // 5. Costruzione del payload (utilizziamo i colori HEX direttamente)
        const voxels = [];
        const palette = {};

        voxelSet.forEach((hex, key) => {
            const [x, y, z] = key.split(',').map(Number);
            const uppercaseHex = hex.toUpperCase();
            palette[uppercaseHex] = uppercaseHex;
            voxels.push({ x, y, z, color: uppercaseHex });
        });

        console.log(`[import-glb] Voxelizzazione completata: ${voxels.length} voxel generati.`);

        return {
            metadata: {
                name: "Imported_GLB",
                grid_size: [W, H, D]
            },
            palette: palette,
            voxels: voxels
        };
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
}
