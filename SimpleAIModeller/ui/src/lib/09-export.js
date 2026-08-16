// =======================================================================
//  09 - Export GLB / OBJ / JSON / collider sidecar
//
//  Invariante del padre: NESSUN attributo `color` nel GLB (COLOR_0 *
//  baseColorFactor = colore al quadrato). Rumore procedurale quantizzato
//  in sfumature piatte per materiale (un GLB non porta shader).
// =======================================================================

function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function downloadText(filename, text, mime) {
    downloadBlob(filename, new Blob([text], { type: mime || 'text/plain' }));
}

function quantizeColor(def, style) {
    // Per l'export: una sola tinta media (il rumore non si esporta come texture
    // in fase 1; si usa la base + un'eventuale col2 al 50%).
    if (!def) return { col: '#CCCCCC', rough: 0.7, metal: 0, emit: 0, opacity: 1 };
    let col = def.col || '#CCCCCC';
    if (def.noise && def.noise.col2) {
        const a = hexToRgb(col), b = hexToRgb(def.noise.col2);
        const t = (def.noise.amp != null ? def.noise.amp : 0.18);
        const mix = {
            r: a.r * (1 - t) + b.r * t,
            g: a.g * (1 - t) + b.g * t,
            b: a.b * (1 - t) + b.b * t,
        };
        const h = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0');
        col = '#' + h(mix.r) + h(mix.g) + h(mix.b);
    }
    return {
        col: col,
        rough: def.rough != null ? def.rough : 0.7,
        metal: def.metal || 0,
        emit: def.emit || 0,
        emitCol: def.emitCol,
        opacity: def.opacity != null ? def.opacity : 1,
    };
}

function exportGLB(spec, built, opts) {
    opts = opts || {};
    if (!built || !built.parts || !built.parts.length) {
        throw new Error('Niente da esportare.');
    }
    const root = new THREE.Group();
    root.name = (spec && spec.id) || 'asset';
    const style = (spec && spec.style) || 'lowpoly';
    const mats = (spec && spec.mats) || {};

    // Rig: gerarchia di parti rigide.
    const boneNodes = {};
    if (spec && spec.rig && spec.rig.length) {
        for (const b of spec.rig) {
            const g = new THREE.Group();
            g.name = b.b;
            const piv = b.piv || [0, 0, 0];
            // piv e' assoluto: come posizione del gruppo.
            g.position.set(
                typeof piv[0] === 'number' ? piv[0] : 0,
                typeof piv[1] === 'number' ? piv[1] : 0,
                typeof piv[2] === 'number' ? piv[2] : 0);
            boneNodes[b.b] = g;
        }
        // Parenting.
        for (const b of spec.rig) {
            const g = boneNodes[b.b];
            if (b.parent && boneNodes[b.parent]) {
                // Converti piv in locale del parent.
                const parent = boneNodes[b.parent];
                const pw = parent.position;
                g.position.sub(pw);
                parent.add(g);
            } else {
                root.add(g);
            }
        }
    }

    for (const part of built.parts) {
        const q = quantizeColor(mats[part.mat], style);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(
            part.pos instanceof Float32Array ? part.pos : new Float32Array(part.pos), 3));
        geo.setIndex(new THREE.BufferAttribute(
            part.idx instanceof Uint32Array ? part.idx : new Uint32Array(part.idx), 1));
        geo.setAttribute('normal', new THREE.BufferAttribute(meshNormals(part), 3));
        // NIENTE color attribute.
        const rgb = hexToRgb(q.col);
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(rgb.r, rgb.g, rgb.b),
            roughness: q.rough,
            metalness: q.metal,
            flatShading: style === 'lowpoly',
            transparent: q.opacity < 1,
            opacity: q.opacity,
            side: THREE.FrontSide,
        });
        if (q.emit > 0) {
            const ec = q.emitCol ? hexToRgb(q.emitCol) : rgb;
            mat.emissive = new THREE.Color(ec.r, ec.g, ec.b);
            mat.emissiveIntensity = q.emit;
        }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = part.name || 'part';

        // Se ha un bone, le posizioni sono world: le rendiamo locali al bone.
        if (part.bone && boneNodes[part.bone]) {
            const bone = boneNodes[part.bone];
            // Trasla i vertici di -pivot.
            const piv = bone.getWorldPosition(new THREE.Vector3());
            // bone.position e' gia' in root o parent; usiamo la sua pos locale
            // rispetto a root sommando la catena.
            let wx = 0, wy = 0, wz = 0;
            let n = bone;
            while (n && n !== root) {
                wx += n.position.x; wy += n.position.y; wz += n.position.z;
                n = n.parent;
            }
            const pos = geo.attributes.position;
            for (let i = 0; i < pos.count; i++) {
                pos.setXYZ(i, pos.getX(i) - wx, pos.getY(i) - wy, pos.getZ(i) - wz);
            }
            pos.needsUpdate = true;
            geo.computeBoundingSphere();
            bone.add(mesh);
        } else {
            root.add(mesh);
        }
    }

    // Animazioni semplici (clips su bone nodes).
    const animations = [];
    if (spec && spec.clips) {
        for (const [cname, clip] of Object.entries(spec.clips)) {
            const tracks = [];
            const keys = clip.keys || [];
            // Per ogni bone, raccogli i keyframe di rotazione.
            const byBone = {};
            for (const k of keys) {
                const t = k[0];
                const poses = k[1] || {};
                for (const [bname, val] of Object.entries(poses)) {
                    if (!byBone[bname]) byBone[bname] = [];
                    let rot = val;
                    if (val && val.rot) rot = val.rot;
                    if (!Array.isArray(rot)) rot = [0, 0, 0];
                    byBone[bname].push({ t: t, rot: rot });
                }
            }
            const toR = Math.PI / 180;
            for (const [bname, frames] of Object.entries(byBone)) {
                if (!boneNodes[bname]) continue;
                frames.sort((a, b) => a.t - b.t);
                const times = frames.map(f => f.t);
                // Quaternion da Euler XYZ gradi.
                const values = [];
                for (const f of frames) {
                    const e = new THREE.Euler(
                        (f.rot[0] || 0) * toR,
                        (f.rot[1] || 0) * toR,
                        (f.rot[2] || 0) * toR, 'XYZ');
                    const q = new THREE.Quaternion().setFromEuler(e);
                    values.push(q.x, q.y, q.z, q.w);
                }
                tracks.push(new THREE.QuaternionKeyframeTrack(
                    bname + '.quaternion', times, values));
            }
            if (tracks.length) {
                animations.push(new THREE.AnimationClip(cname, clip.dur || -1, tracks));
            }
        }
    }

    return new Promise((resolve, reject) => {
        const exporter = new GLTFExporter();
        exporter.parse(root, (result) => {
            // dispose geo/mat temporanei
            root.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                    if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
                    else o.material.dispose();
                }
            });
            if (result instanceof ArrayBuffer) {
                const blob = new Blob([result], { type: 'model/gltf-binary' });
                if (!opts.silent) downloadBlob(((spec && spec.id) || 'asset') + '.glb', blob);
                resolve(blob);
            } else {
                const text = JSON.stringify(result);
                if (!opts.silent) downloadText(((spec && spec.id) || 'asset') + '.gltf', text, 'model/gltf+json');
                resolve(text);
            }
        }, (err) => reject(err), {
            binary: opts.binary !== false,
            animations: animations,
            onlyVisible: true,
        });
    });
}

function exportOBJ(spec, built) {
    if (!built || !built.parts || !built.parts.length) throw new Error('Niente da esportare.');
    const mats = (spec && spec.mats) || {};
    let obj = '# SimpleAIModeller\n';
    let mtl = '# SimpleAIModeller MTL\n';
    const id = (spec && spec.id) || 'asset';
    obj += 'mtllib ' + id + '.mtl\n';
    const matNames = {};
    let vOff = 1;
    for (const part of built.parts) {
        const mkey = part.mat || 'default';
        if (!matNames[mkey]) {
            const q = quantizeColor(mats[mkey]);
            const rgb = hexToRgb(q.col);
            const safe = ('M_' + mkey).replace(/[^A-Za-z0-9_]/g, '_');
            matNames[mkey] = safe;
            mtl += 'newmtl ' + safe + '\n';
            mtl += 'Kd ' + rgb.r.toFixed(4) + ' ' + rgb.g.toFixed(4) + ' ' + rgb.b.toFixed(4) + '\n';
            mtl += 'Ns ' + Math.round((1 - q.rough) * 500) + '\n';
            if (q.opacity < 1) mtl += 'd ' + q.opacity.toFixed(3) + '\nillum 2\n';
            else mtl += 'illum 1\n';
            mtl += '\n';
        }
        obj += 'o ' + (part.name || 'part') + '\n';
        obj += 'usemtl ' + matNames[mkey] + '\n';
        const p = part.pos, idx = part.idx;
        const nrm = meshNormals(part);
        for (let i = 0; i < p.length; i += 3) {
            obj += 'v ' + p[i].toFixed(5) + ' ' + p[i + 1].toFixed(5) + ' ' + p[i + 2].toFixed(5) + '\n';
        }
        for (let i = 0; i < nrm.length; i += 3) {
            obj += 'vn ' + nrm[i].toFixed(5) + ' ' + nrm[i + 1].toFixed(5) + ' ' + nrm[i + 2].toFixed(5) + '\n';
        }
        for (let i = 0; i < idx.length; i += 3) {
            const a = idx[i] + vOff, b = idx[i + 1] + vOff, c = idx[i + 2] + vOff;
            obj += 'f ' + a + '//' + a + ' ' + b + '//' + b + ' ' + c + '//' + c + '\n';
        }
        vOff += (p.length / 3) | 0;
    }
    downloadText(id + '.obj', obj, 'text/plain');
    setTimeout(() => downloadText(id + '.mtl', mtl, 'text/plain'), 200);
}

function exportJSON(spec) {
    const id = (spec && spec.id) || 'asset';
    downloadText(id + '.sam.json', JSON.stringify(spec, null, 2), 'application/json');
}

function exportColliders(spec) {
    const id = (spec && spec.id) || 'asset';
    const data = {
        id: id,
        unit: 'm',
        up: 'y',
        colliders: (spec && spec.col) || [],
    };
    downloadText(id + '.colliders.json', JSON.stringify(data, null, 2), 'application/json');
}
