            /* ===================== RIGGING ENGINE =====================
               Voxel rigs must deform RIGIDLY: every voxel is bound 100% to a single
               bone (weight 1.0). That's the opposite of Blender's smooth auto-weights,
               which blend several bones per vertex and melt the cubes. Rigid binding
               keeps the pixel-art cubes crisp and rotating cleanly around each joint. */

            // Rig state. `rig.bones`: [{name, parent, head:[x,y,z], tail:[x,y,z]}].
            // rig.pose: {boneName: [rx,ry,rz]} in radians. Persists into saved JSON.
            let rig = null;
            let rigType = 'humanoid';
            let selectedBoneIndex = -1;
            let rigPreviewActive = false;

            // Three.js objects for the live rig preview / export.
            const rigGroup = new THREE.Group();
            scene.add(rigGroup);
            let skinnedMesh = null;
            let skeleton = null;
            let skeletonHelper = null;
            let boneMarker = null;          // sphere marking the selected joint
            let mixer = null;               // AnimationMixer for preset clips
            let rigClips = [];              // generated AnimationClips
            let currentAction = null;
            // Parallel arrays describing the preview geometry so we can recolor by bone.
            let previewVoxelColors = null;  // Float32Array of per-vertex voxel colors
            let previewBoneColors = null;   // Float32Array of per-vertex bone colors

            const rigTypeControl = document.getElementById('rigType');
            const autoRigBtn = document.getElementById('autoRigBtn');
            const toggleSkeleton = document.getElementById('toggleSkeleton');
            const toggleWeightColors = document.getElementById('toggleWeightColors');
            const rigHint = document.getElementById('rigHint');
            const rigDetails = document.getElementById('rigDetails');
            const boneListEl = document.getElementById('boneList');
            const boneCountEl = document.getElementById('boneCount');
            const animSelect = document.getElementById('animSelect');
            const resetPoseBtn = document.getElementById('resetPoseBtn');
            const poseRot = {
                x: document.getElementById('poseRotX'),
                y: document.getElementById('poseRotY'),
                z: document.getElementById('poseRotZ')
            };
            const rotValEls = {
                x: document.getElementById('rotXVal'),
                y: document.getElementById('rotYVal'),
                z: document.getElementById('rotZVal')
            };

            // --- Geometry helpers ---------------------------------------------------
            function voxelBounds(voxels) {
                let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                voxels.forEach(v => {
                    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
                    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
                    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
                });
                return {
                    minX, minY, minZ, maxX, maxY, maxZ,
                    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2,
                    w: maxX - minX, h: maxY - minY, d: maxZ - minZ
                };
            }

            // Distance^2 from point p to segment a-b (arrays [x,y,z]).
            function distSqToSegment(p, a, b) {
                const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
                const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
                const len2 = abx * abx + aby * aby + abz * abz || 1e-6;
                let t = (apx * abx + apy * aby + apz * abz) / len2;
                t = Math.max(0, Math.min(1, t));
                const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
                return dx * dx + dy * dy + dz * dz;
            }

            // --- Auto-skeleton ------------------------------------------------------
            // Build a humanoid skeleton fitted to the voxel bounds, with a few measured
            // refinements (leg split, arm reach). Falls back to a generic chain when the
            // shape doesn't look humanoid enough.
            function buildHumanoidSkeleton(voxels) {
                const b = voxelBounds(voxels);
                const H = b.h || 1, W = b.w || 1;
                const cx = b.cx, cz = b.cz, minY = b.minY, maxY = b.maxY;

                // Measure leg centers from the bottom 20% of layers (two X clusters).
                const legBandTop = minY + 0.20 * H;
                let lSum = 0, lN = 0, rSum = 0, rN = 0;
                voxels.forEach(v => {
                    if (v.y <= legBandTop) {
                        if (v.x < cx) { lSum += v.x; lN++; }
                        else if (v.x > cx) { rSum += v.x; rN++; }
                    }
                });
                const legXL = lN ? lSum / lN : cx - 0.20 * W;
                const legXR = rN ? rSum / rN : cx + 0.20 * W;

                // Arm column X: the CENTER of the arm voxel mass on each side (not the
                // widest extent, which catches shoulders/jacket and pushes the bone off the
                // arm). We take the arms' vertical band and average X of the voxels that sit
                // clearly out to each side of the torso, so the arm bone runs dead-straight
                // down through the middle of the arm. Both upper- and lower-arm share this X,
                // so the whole arm is one perfectly vertical line.
                const armBandLo = minY + 0.45 * H, armBandHi = minY + 0.82 * H;
                const sideGap = 0.18 * W;   // how far from center a voxel must be to count as "arm"
                let lxSum = 0, lxN = 0, rxSum = 0, rxN = 0;
                voxels.forEach(v => {
                    if (v.y >= armBandLo && v.y <= armBandHi) {
                        if (v.x <= cx - sideGap) { lxSum += v.x; lxN++; }
                        else if (v.x >= cx + sideGap) { rxSum += v.x; rxN++; }
                    }
                });
                const armXL = lxN ? Math.round(lxSum / lxN) : Math.round(cx - 0.32 * W);
                const armXR = rxN ? Math.round(rxSum / rxN) : Math.round(cx + 0.32 * W);

                // Feet point forward: measure the Z span of the bottom band so the foot bone
                // runs from the ankle to the toe tip (instead of straight down).
                const footBandTop = minY + 0.12 * H;
                let footZmin = cz, footZmax = cz;
                voxels.forEach(v => {
                    if (v.y <= footBandTop) {
                        if (v.z < footZmin) footZmin = v.z;
                        if (v.z > footZmax) footZmax = v.z;
                    }
                });
                const ankleZ = cz, toeZ = (footZmax > cz) ? footZmax : cz + 0.15 * (b.d || 1);

                // Vertical stations (fractions of height). Arm/leg joints line up on a single
                // vertical so every limb is dead straight in the rest pose (no bent elbows).
                const hipsY = minY + 0.44 * H;
                const spineY = minY + 0.57 * H;
                const chestY = minY + 0.66 * H;
                const uchestY = minY + 0.75 * H;
                const shldY = minY + 0.80 * H;
                const neckY = minY + 0.84 * H;
                const headY = minY + 0.88 * H;
                const headTopY = minY + 0.97 * H;
                const elbowY = minY + 0.66 * H;
                const wristY = minY + 0.52 * H;
                const handY = minY + 0.45 * H;
                const kneeY = minY + 0.28 * H;
                const ankleY = minY + 0.09 * H;

                const bones = [];
                const add = (name, parent, head, tail) => { bones.push({ name, parent, head, tail }); return bones.length - 1; };

                // Spine chain: hips → spine → chest → upperChest → neck → head → headTip.
                // Each bone's head is the next one's tail, and every leaf ends in a small tip
                // bone so Blender orients them correctly (no "bones pointing up").
                const hips = add('hips', -1, [cx, hipsY, cz], [cx, spineY, cz]);
                const spine = add('spine', hips, [cx, spineY, cz], [cx, chestY, cz]);
                const chest = add('chest', spine, [cx, chestY, cz], [cx, uchestY, cz]);
                const uchest = add('upperChest', chest, [cx, uchestY, cz], [cx, neckY, cz]);
                const neck = add('neck', uchest, [cx, neckY, cz], [cx, headY, cz]);
                const head = add('head', neck, [cx, headY, cz], [cx, headTopY, cz]);
                add('headTip', head, [cx, headTopY, cz], [cx, maxY, cz]);

                // Arms in T-pose (horizontal). The whole arm is measured from the REAL
                // geometry so every bone stays inside the voxels: the shoulder sits at the
                // torso edge (so it's a proper pivot, not buried mid-arm), and the chain
                // reaches out to the actual fingertip instead of guessing from body height.

                // Torso edge just below the arms → where the shoulder attaches to the body.
                const torsoBandLo = minY + 0.55 * H, torsoBandHi = minY + 0.68 * H;
                let torsoMaxR = cx, torsoMinL = cx;
                voxels.forEach(v => {
                    if (v.y >= torsoBandLo && v.y <= torsoBandHi) {
                        if (v.x > torsoMaxR) torsoMaxR = v.x;
                        if (v.x < torsoMinL) torsoMinL = v.x;
                    }
                });

                // Outermost arm voxel (fingertip) + the arm's real vertical center, from the
                // side voxels in the arm band.
                let armOuterR = torsoMaxR, armOuterL = torsoMinL, armYsum = 0, armYn = 0;
                voxels.forEach(v => {
                    if (v.y >= armBandLo && v.y <= armBandHi) {
                        if (v.x >= cx + sideGap) { if (v.x > armOuterR) armOuterR = v.x; armYsum += v.y; armYn++; }
                        else if (v.x <= cx - sideGap) { if (v.x < armOuterL) armOuterL = v.x; armYsum += v.y; armYn++; }
                    }
                });
                const armY = armYn ? armYsum / armYn : (shldY - 0.08 * H);

                // Shoulder roots at the torso edge; the arm proper spans root → fingertip,
                // split upperArm / forearm / hand, with the leaf tip landing on the fingertip.
                const shRX = torsoMaxR, shLX = torsoMinL;
                const reachR = Math.max(armOuterR - shRX, 0.18 * W);
                const reachL = Math.max(shLX - armOuterL, 0.18 * W);
                const fU = 0.42, fF = 0.34, fH = 0.18;   // upperArm / forearm / hand fractions
                const rE = shRX + reachR * fU, rW = rE + reachR * fF, rH = rW + reachR * fH, rT = armOuterR;
                const lE = shLX - reachL * fU, lW = lE - reachL * fF, lH = lW - reachL * fH, lT = armOuterL;

                // Collarbone (shoulder) slants from chest center down to the arm root.
                const shoR = add('shoulder_R', uchest, [cx, shldY, cz], [shRX, armY, cz]);
                const uaR = add('upperArm_R', shoR, [shRX, armY, cz], [rE, armY, cz]);
                const faR = add('forearm_R', uaR, [rE, armY, cz], [rW, armY, cz]);
                const haR = add('hand_R', faR, [rW, armY, cz], [rH, armY, cz]);
                add('handTip_R', haR, [rH, armY, cz], [rT, armY, cz]);

                const shoL = add('shoulder_L', uchest, [cx, shldY, cz], [shLX, armY, cz]);
                const uaL = add('upperArm_L', shoL, [shLX, armY, cz], [lE, armY, cz]);
                const faL = add('forearm_L', uaL, [lE, armY, cz], [lW, armY, cz]);
                const haL = add('hand_L', faL, [lW, armY, cz], [lH, armY, cz]);
                add('handTip_L', haL, [lH, armY, cz], [lT, armY, cz]);

                // Legs: pelvis branches out from hips, then upperLeg → lowerLeg → foot → toeTip.
                const pelR = add('pelvis_R', hips, [cx, hipsY, cz], [legXR, hipsY, cz]);
                const ulR = add('upperLeg_R', pelR, [legXR, hipsY, cz], [legXR, kneeY, cz]);
                const llR = add('lowerLeg_R', ulR, [legXR, kneeY, cz], [legXR, ankleY, ankleZ]);
                const ftR = add('foot_R', llR, [legXR, ankleY, ankleZ], [legXR, minY, toeZ]);
                add('toeTip_R', ftR, [legXR, minY, toeZ], [legXR, minY, toeZ + 0.4]);

                const pelL = add('pelvis_L', hips, [cx, hipsY, cz], [legXL, hipsY, cz]);
                const ulL = add('upperLeg_L', pelL, [legXL, hipsY, cz], [legXL, kneeY, cz]);
                const llL = add('lowerLeg_L', ulL, [legXL, kneeY, cz], [legXL, ankleY, ankleZ]);
                const ftL = add('foot_L', llL, [legXL, ankleY, ankleZ], [legXL, minY, toeZ]);
                add('toeTip_L', ftL, [legXL, minY, toeZ], [legXL, minY, toeZ + 0.4]);

                return { bones, pose: {}, binding: 'rigid', type: 'humanoid' };
            }

            // Generic: a chain of N bones along the model's longest axis.
            function buildGenericSkeleton(voxels, segments = 5) {
                const b = voxelBounds(voxels);
                const axes = [
                    { k: 'x', len: b.w, min: b.minX, max: b.maxX },
                    { k: 'y', len: b.h, min: b.minY, max: b.maxY },
                    { k: 'z', len: b.d, min: b.minZ, max: b.maxZ }
                ];
                axes.sort((p, q) => q.len - p.len);
                const main = axes[0];
                const bones = [];
                const at = (t) => {
                    const p = [b.cx, b.cy, b.cz];
                    if (main.k === 'x') p[0] = main.min + t * main.len;
                    else if (main.k === 'y') p[1] = main.min + t * main.len;
                    else p[2] = main.min + t * main.len;
                    return p;
                };
                for (let i = 0; i < segments; i++) {
                    bones.push({
                        name: `bone_${i}`,
                        parent: i === 0 ? -1 : i - 1,
                        head: at(i / segments),
                        tail: at((i + 1) / segments)
                    });
                }
                return { bones, pose: {}, binding: 'rigid', type: 'generic' };
            }

            // --- Rigid binding ------------------------------------------------------
            // Assign each voxel to exactly one bone: the bone whose segment (head->tail)
            // is closest. Limb bones get a same-side bonus on X so the left hand doesn't
            // steal voxels from the right arm. Returns Int32Array parallel to `voxels`.
            function bindVoxels(voxels, bones) {
                const b = voxelBounds(voxels);
                const cx = b.cx;
                const out = new Int32Array(voxels.length);
                for (let i = 0; i < voxels.length; i++) {
                    const v = voxels[i];
                    const p = [v.x, v.y, v.z];
                    let best = 0, bestD = Infinity;
                    for (let j = 0; j < bones.length; j++) {
                        const bone = bones[j];
                        let d = distSqToSegment(p, bone.head, bone.tail);
                        // Same-side bias for lateralized limbs.
                        if (bone.name.endsWith('_R') && v.x < cx) d *= 3.0;
                        if (bone.name.endsWith('_L') && v.x > cx) d *= 3.0;
                        if (d < bestD) { bestD = d; best = j; }
                    }
                    out[i] = best;
                }
                return out;
            }

            // Distinct-ish color per bone index for the "colora pesi" view.
            function boneColor(i, total) {
                const hue = (i * 0.61803398875) % 1;      // golden-ratio hue spacing
                const c = new THREE.Color();
                c.setHSL(hue, 0.65, 0.55);
                return c;
            }

            // --- SkinnedMesh construction ------------------------------------------
            // One cube per voxel, every vertex of that cube rigidly weighted (1.0) to the
            // voxel's bone. Vertices are authored in world/voxel space; THREE.Skeleton's
            // inverse bind matrices (from bone world transforms at bind time) make the
            // skinning line up. We keep both a voxel-color and a bone-color attribute and
            // swap between them for the weight-visualization toggle.
            function buildSkinnedMesh(voxels, bones, assignments) {
                const voxelSet = new Set();
                voxels.forEach(vox => voxelSet.add(`${vox.x},${vox.y},${vox.z}`));

                const positions = [];
                const normals = [];
                const vColors = [];   // real voxel colors
                const bColors = [];   // per-bone debug colors
                const skinIndices = [];
                const skinWeights = [];
                const indices = [];

                const s = 0.5; // half cube
                // 6 faces: [normal, 4 corner offsets]
                const faces = [
                    { n: [1, 0, 0], c: [[s, -s, -s], [s, s, -s], [s, s, s], [s, -s, s]] },
                    { n: [-1, 0, 0], c: [[-s, -s, s], [-s, s, s], [-s, s, -s], [-s, -s, -s]] },
                    { n: [0, 1, 0], c: [[-s, s, -s], [-s, s, s], [s, s, s], [s, s, -s]] },
                    { n: [0, -1, 0], c: [[-s, -s, s], [-s, -s, -s], [s, -s, -s], [s, -s, s]] },
                    { n: [0, 0, 1], c: [[s, -s, s], [s, s, s], [-s, s, s], [-s, -s, s]] },
                    { n: [0, 0, -1], c: [[-s, -s, -s], [-s, s, -s], [s, s, -s], [s, -s, -s]] }
                ];

                const byColor = {};
                for (let i = 0; i < voxels.length; i++) {
                    const c = voxels[i].color;
                    if (!byColor[c]) byColor[c] = [];
                    byColor[c].push(i);
                }

                const materials = [];
                const groups = [];
                let vbase = 0;

                for (const hexColor in byColor) {
                    const groupStart = indices.length;
                    const mat = new THREE.MeshStandardMaterial({
                        color: 0xffffff,
                        vertexColors: true,
                        roughness: 0.35,
                        metalness: 0.0,
                        skinning: true,
                        side: THREE.DoubleSide
                    });
                    mat.userData.hexColor = hexColor;
                    materials.push(mat);

                    const col = new THREE.Color(hexColor);
                    for (const i of byColor[hexColor]) {
                        const v = voxels[i];
                        const bi = assignments[i];
                        const bc = boneColor(bi, bones.length);
                        for (const f of faces) {
                            const nx = v.x + f.n[0];
                            const ny = v.y + f.n[1];
                            const nz = v.z + f.n[2];
                            if (voxelSet.has(`${nx},${ny},${nz}`)) continue;

                            for (const off of f.c) {
                                positions.push(v.x + off[0], v.y + off[1], v.z + off[2]);
                                normals.push(f.n[0], f.n[1], f.n[2]);
                                vColors.push(col.r, col.g, col.b);
                                bColors.push(bc.r, bc.g, bc.b);
                                skinIndices.push(bi, 0, 0, 0);
                                skinWeights.push(1, 0, 0, 0);
                            }
                            indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
                            vbase += 4;
                        }
                    }
                    groups.push({ start: groupStart, count: indices.length - groupStart, matIndex: materials.length - 1 });
                }

                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
                geo.setAttribute('color', new THREE.Float32BufferAttribute(vColors, 3));
                geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
                geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
                geo.setIndex(indices);
                groups.forEach(g => geo.addGroup(g.start, g.count, g.matIndex));

                previewVoxelColors = new Float32Array(vColors);
                previewBoneColors = new Float32Array(bColors);

                // Build the THREE bones with correct parenting and rest positions.
                const threeBones = bones.map(() => new THREE.Bone());
                bones.forEach((bd, i) => {
                    const bone = threeBones[i];
                    bone.name = bd.name;
                    const ph = bd.parent >= 0 ? bones[bd.parent].head : [0, 0, 0];
                    bone.position.set(bd.head[0] - ph[0], bd.head[1] - ph[1], bd.head[2] - ph[2]);
                    bone.userData.restPos = bone.position.clone(); // for clips that move the hips
                    if (bd.parent >= 0) threeBones[bd.parent].add(bone);
                });
                const rootBones = threeBones.filter((_, i) => bones[i].parent < 0);

                const skel = new THREE.Skeleton(threeBones);
                const mesh = new THREE.SkinnedMesh(geo, materials);
                mesh.add(rootBones[0]);
                for (let i = 1; i < rootBones.length; i++) mesh.add(rootBones[i]);
                mesh.bind(skel);
                return { mesh, skeleton: skel, bones: threeBones };
            }

            // --- Apply the whole rig: build preview mesh, skeleton helper, UI ---------
            function applyRig() {
                clearRigPreview();
                if (!rig || !rig.bones.length) return;
                const voxels = currentModelData.voxels || [];
                if (!voxels.length) return;

                const assignments = bindVoxels(voxels, rig.bones);
                const built = buildSkinnedMesh(voxels, rig.bones, assignments);
                skinnedMesh = built.mesh;
                skeleton = built.skeleton;
                rigGroup.add(skinnedMesh);

                skeletonHelper = new THREE.SkeletonHelper(skinnedMesh);
                skeletonHelper.material.linewidth = 2;
                scene.add(skeletonHelper);

                // Joint marker for the selected bone.
                boneMarker = new THREE.Mesh(
                    new THREE.SphereGeometry(0.6, 12, 12),
                    new THREE.MeshBasicMaterial({ color: 0xfbbf24, depthTest: false, transparent: true })
                );
                boneMarker.renderOrder = 999;
                boneMarker.visible = false;
                scene.add(boneMarker);

                buildAnimationClips();
                applyPoseToBones();
                rigPreviewActive = true;
                gizmoEnabled = true;
                updateRigVisibility();
                renderBoneList();
                rigDetails.style.display = 'block';
                if (typeof updateGizmo === 'function') updateGizmo();
                rigHint.textContent = `Rig "${rig.type}" pronto: ${rig.bones.length} ossa. Clic su un osso per selezionarlo, poi R per ruotare (posa) o G per spostare il giunto. Ctrl+Z annulla.`;
            }

            // Restore a rig loaded from a saved JSON file, then rebuild the preview.
            function restoreRig(saved) {
                rig = {
                    type: saved.type || 'humanoid',
                    binding: saved.binding || 'rigid',
                    bones: saved.bones,
                    pose: saved.pose || {}
                };
                rigType = rig.type;
                rigTypeControl.querySelectorAll('.seg-btn').forEach(b =>
                    b.classList.toggle('active', b.dataset.rig === rigType));
                selectedBoneIndex = -1;
                applyRig();
                if (rig.bones.length) selectBone(0);
            }

            // Show the skinned preview (and hide the instanced voxels) only while a rig
            // exists; otherwise the normal InstancedMesh rendering is used.
            function updateRigVisibility() {
                const showRig = rigPreviewActive;
                modelPivot.visible = !showRig;
                rigGroup.visible = showRig;
                // T1 Fase B: nascondi gli altri oggetti e il box selezione durante il rig.
                if (typeof inactiveGroup !== 'undefined') inactiveGroup.visible = !showRig;
                if (showRig && selectionBoxHelper) { scene.remove(selectionBoxHelper); selectionBoxHelper = null; }
                if (skeletonHelper) skeletonHelper.visible = showRig && toggleSkeleton.checked;
                if (skinnedMesh) {
                    const useBone = toggleWeightColors.checked;
                    const attr = skinnedMesh.geometry.getAttribute('color');
                    attr.copyArray(useBone ? previewBoneColors : previewVoxelColors);
                    attr.needsUpdate = true;
                }
            }

            function clearRigPreview() {
                if (typeof transformControls !== 'undefined') { transformControls.detach(); transformControls.visible = false; }
                if (skinnedMesh) { rigGroup.remove(skinnedMesh); skinnedMesh.geometry.dispose(); skinnedMesh = null; }
                if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper = null; }
                if (boneMarker) { scene.remove(boneMarker); boneMarker = null; }
                if (mixer) { mixer.stopAllAction(); mixer = null; }
                skeleton = null; rigClips = []; currentAction = null;
                rigPreviewActive = false;
                modelPivot.visible = true;
                rigGroup.visible = false;
            }

            // --- Bone list UI -------------------------------------------------------
            function renderBoneList() {
                boneListEl.innerHTML = '';
                boneCountEl.textContent = `(${rig.bones.length})`;
                const depthOf = (i) => {
                    let d = 0, p = rig.bones[i].parent;
                    while (p >= 0) { d++; p = rig.bones[p].parent; }
                    return d;
                };
                rig.bones.forEach((bd, i) => {
                    const row = document.createElement('div');
                    const d = depthOf(i);
                    row.className = 'bone-item' + (i === selectedBoneIndex ? ' selected' : '') + (d === 1 ? ' child' : d >= 2 ? ' grandchild' : '');
                    const sw = document.createElement('span');
                    sw.className = 'bone-swatch';
                    const bc = boneColor(i, rig.bones.length);
                    sw.style.background = `#${bc.getHexString()}`;
                    const label = document.createElement('span');
                    label.textContent = bd.name;
                    row.appendChild(sw); row.appendChild(label);
                    row.addEventListener('click', () => selectBone(i));
                    boneListEl.appendChild(row);
                });
            }

            function selectBone(i) {
                selectedBoneIndex = i;
                renderBoneList();
                // Load this bone's current pose into the sliders.
                const bd = rig.bones[i];
                const pose = (rig.pose && rig.pose[bd.name]) || [0, 0, 0];
                poseRot.x.value = Math.round(pose[0] * 180 / Math.PI);
                poseRot.y.value = Math.round(pose[1] * 180 / Math.PI);
                poseRot.z.value = Math.round(pose[2] * 180 / Math.PI);
                updateRotLabels();
                updateBoneMarker();
                if (typeof updateGizmo === 'function') updateGizmo();
            }

            function updateBoneMarker() {
                if (!boneMarker || !skeleton || selectedBoneIndex < 0) { if (boneMarker) boneMarker.visible = false; return; }
                const bone = skeleton.bones[selectedBoneIndex];
                bone.updateWorldMatrix(true, false);
                boneMarker.position.setFromMatrixPosition(bone.matrixWorld);
                boneMarker.visible = rigPreviewActive;
            }

            // --- Posing -------------------------------------------------------------
            function applyPoseToBones() {
                if (!skeleton) return;
                skeleton.bones.forEach((bone, i) => {
                    const name = rig.bones[i].name;
                    const p = (rig.pose && rig.pose[name]) || [0, 0, 0];
                    bone.rotation.set(p[0], p[1], p[2]);
                    // Clips can animate bone.position (hips bob); restore the rest position
                    // so a static pose isn't left with a displaced root.
                    if (bone.userData.restPos) bone.position.copy(bone.userData.restPos);
                });
                updateBoneMarker();
            }

            function updateRotLabels() {
                rotValEls.x.textContent = `${poseRot.x.value}°`;
                rotValEls.y.textContent = `${poseRot.y.value}°`;
                rotValEls.z.textContent = `${poseRot.z.value}°`;
            }

            function onPoseSlider() {
                if (selectedBoneIndex < 0 || !rig) return;
                const name = rig.bones[selectedBoneIndex].name;
                rig.pose = rig.pose || {};
                rig.pose[name] = [
                    poseRot.x.value * Math.PI / 180,
                    poseRot.y.value * Math.PI / 180,
                    poseRot.z.value * Math.PI / 180
                ];
                updateRotLabels();
                // Sliders drive a static pose, so stop any playing clip.
                if (currentAction) { currentAction.stop(); currentAction = null; animSelect.value = 'none'; }
                applyPoseToBones();
                if (typeof syncGizmoToBone === 'function') syncGizmoToBone();
            }
            Object.values(poseRot).forEach(sl => {
                sl.addEventListener('input', onPoseSlider);
                sl.addEventListener('mousedown', pushHistory);
                sl.addEventListener('touchstart', pushHistory);
            });

            resetPoseBtn.addEventListener('click', () => {
                if (!rig) return;
                pushHistory();
                rig.pose = {};
                if (currentAction) { currentAction.stop(); currentAction = null; }
                animSelect.value = 'none';
                poseRot.x.value = poseRot.y.value = poseRot.z.value = 0;
                updateRotLabels();
                applyPoseToBones();
                if (typeof updateGizmo === 'function') updateGizmo();
            });

            // --- Preset animations --------------------------------------------------
            // Build a few clips procedurally from the bone names present. These are for
            // preview and are embedded into the exported GLB.
            function buildAnimationClips() {
                rigClips = [];
                if (!skeleton) return;
                const byName = {};
                rig.bones.forEach((bd, i) => byName[bd.name] = skeleton.bones[i]);
                const q = (rx, ry, rz) => new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));

                // Helper: quaternion track for a bone from keyframes [{t, e:[x,y,z]}].
                const track = (boneName, keys) => {
                    const bone = byName[boneName];
                    if (!bone) return null;
                    const times = [], values = [];
                    keys.forEach(k => {
                        times.push(k.t);
                        const qq = q(k.e[0], k.e[1], k.e[2]);
                        values.push(qq.x, qq.y, qq.z, qq.w);
                    });
                    return new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values);
                };
                const clip = (name, dur, tracks) => new THREE.AnimationClip(name, dur,
                    tracks.filter(Boolean));

                // Vertical bob: offset the hips bone up/down from its rest position. Keys
                // are relative dy (in voxel units), added to the bone's rest y.
                const hipsBone = byName['hips'];
                const hipsRest = hipsBone ? hipsBone.position.clone() : null;
                const bob = (keys) => {
                    if (!hipsBone) return null;
                    const times = [], values = [];
                    keys.forEach(k => {
                        times.push(k.t);
                        values.push(hipsRest.x, hipsRest.y + k.dy, hipsRest.z);
                    });
                    return new THREE.VectorKeyframeTrack(`${hipsBone.name}.position`, times, values);
                };

                const rad = d => d * Math.PI / 180;

                // Idle: gentle chest/arm breathing.
                rigClips.push(clip('idle', 2.4, [
                    track('chest', [{ t: 0, e: [0, 0, 0] }, { t: 1.2, e: [rad(3), 0, 0] }, { t: 2.4, e: [0, 0, 0] }]),
                    track('upperArm_L', [{ t: 0, e: [0, 0, 0] }, { t: 1.2, e: [0, 0, rad(4)] }, { t: 2.4, e: [0, 0, 0] }]),
                    track('upperArm_R', [{ t: 0, e: [0, 0, 0] }, { t: 1.2, e: [0, 0, rad(-4)] }, { t: 2.4, e: [0, 0, 0] }]),
                    bob([{ t: 0, dy: 0 }, { t: 1.2, dy: 0.12 }, { t: 2.4, dy: 0 }])
                ]));

                // Walk: opposing legs/arms with knee bend, plus subtle torso counter-sway
                // and a two-per-cycle vertical bob so it reads as real weight shifting.
                const wLeg = rad(28), wKnee = rad(34), wArm = rad(26), wElb = rad(20);
                rigClips.push(clip('walk', 1, [
                    track('upperLeg_L', [{ t: 0, e: [wLeg, 0, 0] }, { t: 0.5, e: [-wLeg, 0, 0] }, { t: 1, e: [wLeg, 0, 0] }]),
                    track('lowerLeg_L', [{ t: 0, e: [0, 0, 0] }, { t: 0.25, e: [wKnee, 0, 0] }, { t: 0.5, e: [wKnee * 0.3, 0, 0] }, { t: 0.75, e: [0, 0, 0] }, { t: 1, e: [0, 0, 0] }]),
                    track('upperLeg_R', [{ t: 0, e: [-wLeg, 0, 0] }, { t: 0.5, e: [wLeg, 0, 0] }, { t: 1, e: [-wLeg, 0, 0] }]),
                    track('lowerLeg_R', [{ t: 0, e: [0, 0, 0] }, { t: 0.25, e: [0, 0, 0] }, { t: 0.5, e: [0, 0, 0] }, { t: 0.75, e: [wKnee, 0, 0] }, { t: 1, e: [0, 0, 0] }]),
                    track('upperArm_L', [{ t: 0, e: [-wArm, 0, 0] }, { t: 0.5, e: [wArm, 0, 0] }, { t: 1, e: [-wArm, 0, 0] }]),
                    track('forearm_L', [{ t: 0, e: [wElb, 0, 0] }, { t: 0.5, e: [wElb * 0.4, 0, 0] }, { t: 1, e: [wElb, 0, 0] }]),
                    track('upperArm_R', [{ t: 0, e: [wArm, 0, 0] }, { t: 0.5, e: [-wArm, 0, 0] }, { t: 1, e: [wArm, 0, 0] }]),
                    track('forearm_R', [{ t: 0, e: [wElb * 0.4, 0, 0] }, { t: 0.5, e: [wElb, 0, 0] }, { t: 1, e: [wElb * 0.4, 0, 0] }]),
                    // Torso: tiny forward lean + side-to-side counter rotation.
                    track('hips', [{ t: 0, e: [rad(2), 0, rad(2)] }, { t: 0.5, e: [rad(2), 0, rad(-2)] }, { t: 1, e: [rad(2), 0, rad(2)] }]),
                    track('spine', [{ t: 0, e: [0, rad(-3), 0] }, { t: 0.5, e: [0, rad(3), 0] }, { t: 1, e: [0, rad(-3), 0] }]),
                    track('chest', [{ t: 0, e: [0, rad(3), 0] }, { t: 0.5, e: [0, rad(-3), 0] }, { t: 1, e: [0, rad(3), 0] }]),
                    bob([{ t: 0, dy: 0 }, { t: 0.25, dy: 0.18 }, { t: 0.5, dy: 0 }, { t: 0.75, dy: 0.18 }, { t: 1, dy: 0 }])
                ]));

                // Run: bigger, faster swing, strong knee bend, pronounced forward lean and
                // a higher bob (both feet leave the ground at the extremes).
                const rLeg = rad(45), rKnee = rad(70), rArm = rad(55), rElb = rad(75);
                rigClips.push(clip('run', 0.66, [
                    track('upperLeg_L', [{ t: 0, e: [rLeg, 0, 0] }, { t: 0.33, e: [-rLeg, 0, 0] }, { t: 0.66, e: [rLeg, 0, 0] }]),
                    track('lowerLeg_L', [{ t: 0, e: [rKnee * 0.4, 0, 0] }, { t: 0.16, e: [rKnee, 0, 0] }, { t: 0.33, e: [rKnee * 0.5, 0, 0] }, { t: 0.66, e: [rKnee * 0.4, 0, 0] }]),
                    track('upperLeg_R', [{ t: 0, e: [-rLeg, 0, 0] }, { t: 0.33, e: [rLeg, 0, 0] }, { t: 0.66, e: [-rLeg, 0, 0] }]),
                    track('lowerLeg_R', [{ t: 0, e: [rKnee * 0.5, 0, 0] }, { t: 0.33, e: [rKnee * 0.4, 0, 0] }, { t: 0.5, e: [rKnee, 0, 0] }, { t: 0.66, e: [rKnee * 0.5, 0, 0] }]),
                    track('upperArm_L', [{ t: 0, e: [-rArm, 0, 0] }, { t: 0.33, e: [rArm, 0, 0] }, { t: 0.66, e: [-rArm, 0, 0] }]),
                    track('forearm_L', [{ t: 0, e: [rElb, 0, 0] }, { t: 0.33, e: [rElb * 0.6, 0, 0] }, { t: 0.66, e: [rElb, 0, 0] }]),
                    track('upperArm_R', [{ t: 0, e: [rArm, 0, 0] }, { t: 0.33, e: [-rArm, 0, 0] }, { t: 0.66, e: [rArm, 0, 0] }]),
                    track('forearm_R', [{ t: 0, e: [rElb * 0.6, 0, 0] }, { t: 0.33, e: [rElb, 0, 0] }, { t: 0.66, e: [rElb * 0.6, 0, 0] }]),
                    track('hips', [{ t: 0, e: [rad(10), 0, 0] }]),
                    track('spine', [{ t: 0, e: [rad(6), rad(-5), 0] }, { t: 0.33, e: [rad(6), rad(5), 0] }, { t: 0.66, e: [rad(6), rad(-5), 0] }]),
                    bob([{ t: 0, dy: 0.1 }, { t: 0.16, dy: 0.5 }, { t: 0.33, dy: 0.1 }, { t: 0.5, dy: 0.5 }, { t: 0.66, dy: 0.1 }])
                ]));

                // Jump: crouch (bend knees), explode up + extend, airborne tuck, land soft.
                const jK = rad(75), jH = rad(45);
                rigClips.push(clip('jump', 1.4, [
                    track('upperLeg_L', [{ t: 0, e: [0, 0, 0] }, { t: 0.3, e: [jH, 0, 0] }, { t: 0.5, e: [-rad(10), 0, 0] }, { t: 0.9, e: [rad(20), 0, 0] }, { t: 1.1, e: [jH, 0, 0] }, { t: 1.4, e: [0, 0, 0] }]),
                    track('upperLeg_R', [{ t: 0, e: [0, 0, 0] }, { t: 0.3, e: [jH, 0, 0] }, { t: 0.5, e: [-rad(10), 0, 0] }, { t: 0.9, e: [rad(20), 0, 0] }, { t: 1.1, e: [jH, 0, 0] }, { t: 1.4, e: [0, 0, 0] }]),
                    track('lowerLeg_L', [{ t: 0, e: [0, 0, 0] }, { t: 0.3, e: [jK, 0, 0] }, { t: 0.5, e: [rad(10), 0, 0] }, { t: 0.9, e: [jK * 0.8, 0, 0] }, { t: 1.1, e: [jK, 0, 0] }, { t: 1.4, e: [0, 0, 0] }]),
                    track('lowerLeg_R', [{ t: 0, e: [0, 0, 0] }, { t: 0.3, e: [jK, 0, 0] }, { t: 0.5, e: [rad(10), 0, 0] }, { t: 0.9, e: [jK * 0.8, 0, 0] }, { t: 1.1, e: [jK, 0, 0] }, { t: 1.4, e: [0, 0, 0] }]),
                    track('upperArm_L', [{ t: 0, e: [0, 0, 0] }, { t: 0.3, e: [rad(40), 0, 0] }, { t: 0.5, e: [rad(-120), 0, 0] }, { t: 0.9, e: [rad(-90), 0, 0] }, { t: 1.4, e: [0, 0, 0] }]),
                    track('upperArm_R', [{ t: 0, e: [0, 0, 0] }, { t: 0.3, e: [rad(40), 0, 0] }, { t: 0.5, e: [rad(-120), 0, 0] }, { t: 0.9, e: [rad(-90), 0, 0] }, { t: 1.4, e: [0, 0, 0] }]),
                    track('spine', [{ t: 0, e: [0, 0, 0] }, { t: 0.3, e: [rad(15), 0, 0] }, { t: 0.5, e: [rad(-5), 0, 0] }, { t: 1.4, e: [0, 0, 0] }]),
                    bob([{ t: 0, dy: 0 }, { t: 0.3, dy: -0.9 }, { t: 0.5, dy: 0.3 }, { t: 0.75, dy: 1.6 }, { t: 0.9, dy: 0.3 }, { t: 1.1, dy: -0.9 }, { t: 1.4, dy: 0 }])
                ]));

                // Wave: right arm up and waving.
                rigClips.push(clip('wave', 1.2, [
                    track('upperArm_R', [{ t: 0, e: [0, 0, 0] }, { t: 0.3, e: [0, 0, -2.4] }, { t: 1.2, e: [0, 0, -2.4] }]),
                    track('forearm_R', [{ t: 0.3, e: [0, 0, 0] }, { t: 0.6, e: [0, 0.5, 0] }, { t: 0.9, e: [0, -0.5, 0] }, { t: 1.2, e: [0, 0.5, 0] }])
                ]));
            }

            function playClip(name) {
                if (!skeleton) return;
                if (!mixer) mixer = new THREE.AnimationMixer(skinnedMesh);
                if (currentAction) { currentAction.stop(); currentAction = null; }
                if (name === 'none') { applyPoseToBones(); return; }
                const clip = rigClips.find(c => c.name === name);
                if (!clip) return;
                currentAction = mixer.clipAction(clip);
                currentAction.reset();
                currentAction.play();
            }
            animSelect.addEventListener('change', () => playClip(animSelect.value));

            // --- Rig tab controls ---------------------------------------------------
            rigTypeControl.querySelectorAll('.seg-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    rigType = btn.dataset.rig;
                    rigTypeControl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                });
            });

            autoRigBtn.addEventListener('click', () => {
                const voxels = currentModelData.voxels || [];
                if (!voxels.length) { rigHint.textContent = 'Nessun voxel da riggare. Genera o carica un modello prima.'; return; }
                pushHistory();
                rig = rigType === 'generic' ? buildGenericSkeleton(voxels) : buildHumanoidSkeleton(voxels);
                selectedBoneIndex = -1;
                applyRig();
                if (rig.bones.length) selectBone(0);
            });

            toggleSkeleton.addEventListener('change', updateRigVisibility);
            toggleWeightColors.addEventListener('change', updateRigVisibility);

            /* ===================== BONE EDITING GIZMO =====================
               A Blender-style gizmo for the rig. Click a bone in the viewport to select
               it, then:
                 R  -> rotate mode: poses the bone (writes rig.pose[name], live preview).
                 G  -> translate mode: edits the SKELETON itself in rest space, moving the
                       joint (and its subtree) then rebinding the voxels.
               OrbitControls is disabled while dragging the gizmo so they don't fight. */
            let gizmoMode = 'rotate';       // 'rotate' | 'translate'
            let gizmoEnabled = false;       // only true on the rig tab with a selection
            const gizmoProxy = new THREE.Object3D();  // the object the gizmo drives
            scene.add(gizmoProxy);

            const transformControls = new THREE.TransformControls(camera, renderer.domElement);
            transformControls.setSize(0.9);
            transformControls.addEventListener('dragging-changed', e => {
                // Free/lock the orbit camera around a gizmo drag.
                controls.enabled = !e.value;
                if (e.value) onGizmoDragStart();
                else onGizmoDragEnd();
            });
            transformControls.addEventListener('objectChange', onGizmoChange);
            transformControls.enabled = false;   // off until the rig tab activates it
            transformControls.visible = false;
            scene.add(transformControls);

            // Reflect the current gizmo state (mode, visibility) into the controls.
            function updateGizmo() {
                // The mode-switch bar shows whenever the rig is active on the rig tab.
                gizmoBar.classList.toggle('visible', !!(gizmoEnabled && rigPreviewActive && skeleton));
                const active = gizmoEnabled && rigPreviewActive && skeleton && selectedBoneIndex >= 0;
                if (!active) {
                    transformControls.detach();
                    transformControls.visible = false;
                    transformControls.enabled = false;  // ignore pointer events off the rig tab
                    return;
                }
                transformControls.enabled = true;
                transformControls.visible = true;
                transformControls.setMode(gizmoMode === 'translate' ? 'translate' : 'rotate');
                // In rotate mode the gizmo works in the bone's local frame; in translate
                // mode we use world space (moving a joint in the model's coordinates).
                transformControls.setSpace(gizmoMode === 'translate' ? 'world' : 'local');
                syncGizmoToBone();
                transformControls.attach(gizmoProxy);
            }

            // Place the proxy at the selected bone so the gizmo appears on the joint.
            function syncGizmoToBone() {
                if (!skeleton || selectedBoneIndex < 0) return;
                const bone = skeleton.bones[selectedBoneIndex];
                bone.updateWorldMatrix(true, false);
                gizmoProxy.position.setFromMatrixPosition(bone.matrixWorld);
                if (gizmoMode === 'rotate') {
                    // Start the rotate proxy from the bone's current world orientation so
                    // dragging feels anchored to how the limb currently sits.
                    const q = new THREE.Quaternion();
                    bone.getWorldQuaternion(q);
                    gizmoProxy.quaternion.copy(q);
                } else {
                    gizmoProxy.quaternion.identity();
                }
                gizmoProxy.updateMatrixWorld(true);
            }

            // Rotate mode needs the parent's world rotation to convert the gizmo's world
            // orientation back into a local bone rotation. Captured at drag start.
            let dragParentQuatInv = new THREE.Quaternion();
            let dragStartProxyPos = new THREE.Vector3();

            function onGizmoDragStart() {
                if (selectedBoneIndex < 0 || !skeleton) return;
                const bone = skeleton.bones[selectedBoneIndex];
                // Snapshot before the edit so the whole drag is a single Ctrl+Z step
                // (works for both posing and joint moves).
                pushHistory();
                if (gizmoMode === 'rotate') {
                    const pq = new THREE.Quaternion();
                    if (bone.parent && bone.parent.isBone) bone.parent.getWorldQuaternion(pq);
                    dragParentQuatInv.copy(pq).invert();
                    // A pose edit is a fresh state; stop any playing clip.
                    if (currentAction) { currentAction.stop(); currentAction = null; animSelect.value = 'none'; }
                } else {
                    dragStartProxyPos.copy(gizmoProxy.position);
                }
            }

            function onGizmoChange() {
                if (selectedBoneIndex < 0 || !skeleton || !transformControls.dragging) return;
                const bd = rig.bones[selectedBoneIndex];
                if (gizmoMode === 'rotate') {
                    // World orientation of the proxy -> local bone rotation.
                    const localQ = dragParentQuatInv.clone().multiply(gizmoProxy.quaternion);
                    const e = new THREE.Euler().setFromQuaternion(localQ, 'XYZ');
                    rig.pose = rig.pose || {};
                    rig.pose[bd.name] = [e.x, e.y, e.z];
                    skeleton.bones[selectedBoneIndex].rotation.copy(e);
                    // Keep the slider panel in sync with the gizmo.
                    poseRot.x.value = Math.round(e.x * 180 / Math.PI);
                    poseRot.y.value = Math.round(e.y * 180 / Math.PI);
                    poseRot.z.value = Math.round(e.z * 180 / Math.PI);
                    updateRotLabels();
                } else {
                    // Translate mode: move the joint (rest-space edit). We only track the
                    // final position; the actual rebuild happens on drag end.
                }
                updateBoneMarker();
            }

            function onGizmoDragEnd() {
                if (selectedBoneIndex < 0 || !rig) return;
                if (gizmoMode === 'translate') {
                    const delta = gizmoProxy.position.clone().sub(dragStartProxyPos);
                    if (delta.lengthSq() > 1e-9) {
                        moveJointRest(selectedBoneIndex, [delta.x, delta.y, delta.z]);
                        // Rebuild the skinned mesh against the edited skeleton, keeping pose.
                        const savedSel = selectedBoneIndex;
                        applyRig();
                        selectBone(savedSel);
                    }
                }
                syncGizmoToBone();
            }

            // Move a joint in rest space by `delta`: shift this bone's head and the head of
            // every descendant by the same amount (rigid limb move), and stretch the parent
            // bone's tail to follow. Tails that coincide with a moved head move too.
            function moveJointRest(index, delta) {
                const bones = rig.bones;
                // Which bones are in the moved subtree (this bone + all descendants)?
                const inSubtree = new Array(bones.length).fill(false);
                inSubtree[index] = true;
                for (let i = 0; i < bones.length; i++) {
                    // Walk ancestors; if we hit `index`, we're inside the subtree.
                    let p = bones[i].parent;
                    while (p >= 0) { if (p === index) { inSubtree[i] = true; break; } p = bones[p].parent; }
                }
                const moved = bones[index];
                const oldHead = moved.head.slice();
                bones.forEach((bd, i) => {
                    if (inSubtree[i]) {
                        bd.head = [bd.head[0] + delta[0], bd.head[1] + delta[1], bd.head[2] + delta[2]];
                        bd.tail = [bd.tail[0] + delta[0], bd.tail[1] + delta[1], bd.tail[2] + delta[2]];
                    }
                });
                // The parent bone's tail should follow the moved joint so the bone doesn't
                // detach visually (only if it was pointing at this head).
                if (moved.parent >= 0) {
                    const par = bones[moved.parent];
                    if (Math.abs(par.tail[0] - oldHead[0]) < 1e-6 && Math.abs(par.tail[1] - oldHead[1]) < 1e-6 && Math.abs(par.tail[2] - oldHead[2]) < 1e-6) {
                        par.tail = moved.head.slice();
                    }
                }
            }



            // Click a bone in the viewport to select it (only on the rig tab). We pick the
            // bone whose head->tail segment is closest to the click ray.
            function pickBone(clientX, clientY) {
                if (!skeleton || !rig) return -1;
                const rect = renderer.domElement.getBoundingClientRect();
                pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
                pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(pointer, camera);
                const ray = raycaster.ray;
                let best = -1, bestD = Infinity;
                const head = new THREE.Vector3(), tail = new THREE.Vector3(), mid = new THREE.Vector3();
                rig.bones.forEach((bd, i) => {
                    const bone = skeleton.bones[i];
                    bone.updateWorldMatrix(true, false);
                    head.setFromMatrixPosition(bone.matrixWorld);
                    // World tail = head + (tail-head) rotated by bone world quat.
                    const local = new THREE.Vector3(bd.tail[0] - bd.head[0], bd.tail[1] - bd.head[1], bd.tail[2] - bd.head[2]);
                    const q = new THREE.Quaternion(); bone.getWorldQuaternion(q);
                    tail.copy(local).applyQuaternion(q).add(head);
                    mid.addVectors(head, tail).multiplyScalar(0.5);
                    // Distance from the ray to the bone midpoint (cheap, works well enough).
                    const d = ray.distanceToPoint(mid);
                    if (d < bestD) { bestD = d; best = i; }
                });
                // Only accept reasonably close clicks so empty space deselects nothing weird.
                return bestD < 2.5 ? best : -1;
            }

            renderer.domElement.addEventListener('pointerdown', e => {
                if (!gizmoEnabled || e.button !== 0) return;
                // If the pointer is over a gizmo handle (TC sets .axis on hover) or already
                // dragging, let TransformControls own this click.
                if (transformControls.dragging || transformControls.axis) return;
                const bi = pickBone(e.clientX, e.clientY);
                if (bi >= 0) { selectBone(bi); updateGizmo(); }
            });

            // --- CUBE_FACES: shared cube face table (used by GLB static export) -----