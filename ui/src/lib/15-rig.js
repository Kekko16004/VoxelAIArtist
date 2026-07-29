            /* ===================== RIGGING ENGINE =====================
               Skinning a VOXEL model, due modalita' (rig.binding):

                 'smooth' (DEFAULT) - skinning a 4 ossa come Blender dopo "Automatic
                    Weights": il corpo di ogni osso resta a peso ~1 (i cubi non si
                    sciolgono) e la miscela compare SOLO vicino alle articolazioni, dove
                    serve per non strappare la mesh. Il limite di 4 ossa non e' una scelta
                    di stile: in THREE r128 skinIndex/skinWeight sono vec4.
                 'rigid' - il vecchio binding binario (1 osso per voxel, peso 1.0).
                    Resta selezionabile e i file salvati con binding:'rigid' continuano a
                    comportarsi ESATTAMENTE come prima.

               Il formato dei pesi dipinti a mano (rig.weights) accetta sia la vecchia
               stringa "hand_L" (= {hand_L: 1}) sia l'oggetto {"hand_L":0.7,"forearm_L":0.3}.
               In memoria la forma canonica e' SEMPRE l'oggetto normalizzato (somma 1, max 4
               ossa): la conversione passa da normalizeWeightEntry(), unico punto di verita'. */

            // Rig state. `rig.bones`: [{name, parent, head:[x,y,z], tail:[x,y,z]}].
            // rig.pose: {boneName: [rx,ry,rz]} in radians. Persists into saved JSON.
            let rig = null;
            let rigType = 'humanoid';
            let selectedBoneIndex = -1;
            let rigPreviewActive = false;

            // Three.js objects for the live rig preview / export.
            const rigGroup = new THREE.Group();
            // NIENTE rotazione qui: l'anteprima del rig deve avere ESATTAMENTE lo stesso
            // orientamento del modello normale (voxel a coordinate positive). Ruotare il
            // gruppo faceva apparire il modello "di spalle"/spostato. Il senso della
            // CAMMINATA (che sembrava al contrario) e' gestito invertendo le clip walk/run,
            // non girando la mesh.
            scene.add(rigGroup);
            let skinnedMesh = null;
            let skeleton = null;
            let skeletonHelper = null;
            let boneMarker = null;          // sphere marking the selected joint
            let mixer = null;               // AnimationMixer for preset clips
            let rigClips = [];              // generated AnimationClips
            let currentAction = null;
            // Ultimo binding voxel→osso PRINCIPALE (Int32Array parallelo a
            // currentModelData.voxels): l'osso di peso maggiore su quel voxel. Serve al
            // weight paint, al riempimento e alla vista "colore per osso".
            let boneAssignments = null;
            // Skinning completo a 4 ossa, parallelo ai voxel: slot s del voxel i sta in
            // [i*4+s]. Le due array sono SEMPRE allineate (indice, peso) e i pesi di ogni
            // voxel sommano a 1. boneAssignments[i] = indice dello slot di peso massimo.
            const MAX_BONE_INFLUENCES = 4;   // limite HARD di THREE r128 (skinIndex e' vec4)
            let boneWeightIndices = null;    // Int32Array(voxels*4)
            let boneWeightValues = null;     // Float32Array(voxels*4)
            let previewVertexRanges = null;  // [start, count] per voxel nella geometria
            let rigVoxelIndex = null;        // "x,y,z" -> indice in currentModelData.voxels
            // Pallini cliccabili sui giunti. Prima l'unico bersaglio era la linea
            // dell'osso, colpita con una soglia in unita' mondo: su un modello grande o
            // con la camera lontana era praticamente impossibile prenderla.
            let jointHandleGroup = null;
            let jointHandles = [];          // [{mesh, boneIndex}]
            let hoveredBoneIndex = -1;
            // Raggio a schermo dei pallini, costante allo zoom. Ridotto da 9 a 7: con i
            // pallini grandi il gizmo di rotazione era quasi sepolto e su scheletri fitti
            // (mani, dita) due giunti vicini si sovrapponevano.
            const HANDLE_PIXELS = 7;
            const HANDLE_COL_IDLE = 0x93c5fd;
            const HANDLE_COL_HOVER = 0xffffff;
            const HANDLE_COL_SEL = 0xfbbf24;

            // --- Weight paint -------------------------------------------------------
            // Si dipinge il PESO dell'osso selezionato (0..1) come in Blender: forza,
            // falloff e modalita' (mix/aggiungi/sottrai/sfuma). Gli altri pesi del voxel
            // vengono rinormalizzati per fare somma 1. Le pennellate finiscono in
            // rig.weights (sparse) come oggetti {osso: peso}.
            let weightPaintActive = false;
            let weightPaintRadius = 2;      // in voxel; 0 = un solo voxel
            let weightPaintErase = false;   // true = rimuove la sovrascrittura (torna all'automatico)
            let weightPaintStroking = false;
            let weightPaintDirty = false;   // una pennellata in corso ha cambiato qualcosa
            let wpStrength = 1;             // forza del pennello 0..1
            let wpFalloff = 'smooth';       // 'smooth' | 'constant' | 'sharp'
            let wpColorMode = 'weight';     // 'weight' (peso osso selezionato) | 'bone'
            // "Durezza" del binding automatico: esponente del falloff fra ossa vicine.
            // Alto = quasi rigido (transizione strettissima), basso = molto morbido.
            let bindHardness = 6;
            // Parallel arrays describing the preview geometry so we can recolor by bone.
            let previewVoxelColors = null;  // Float32Array of per-vertex voxel colors
            let previewBoneColors = null;   // Float32Array of per-vertex bone colors
            let previewWeightColors = null; // Float32Array: rampa peso dell'osso selezionato

            const rigTypeControl = document.getElementById('rigType');
            const autoRigBtn = document.getElementById('autoRigBtn');
            const showRigBtn = document.getElementById('showRigBtn');
            const toggleSkeleton = document.getElementById('toggleSkeleton');
            const toggleWeightColors = document.getElementById('toggleWeightColors');
            const bindModeControl = document.getElementById('bindMode');
            const bindHardnessInput = document.getElementById('bindHardness');
            const bindHardnessVal = document.getElementById('bindHardnessVal');
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

                // Feet point forward: measure whether feet stick out more towards minZ or maxZ relative to cz.
                const footBandTop = minY + 0.12 * H;
                let footZmin = cz, footZmax = cz;
                voxels.forEach(v => {
                    if (v.y <= footBandTop) {
                        if (v.z < footZmin) footZmin = v.z;
                        if (v.z > footZmax) footZmax = v.z;
                    }
                });
                const distMin = Math.abs(cz - footZmin);
                const distMax = Math.abs(footZmax - cz);
                const facesNegZ = (distMin > distMax + 0.5);
                const ankleZ = cz;
                const toeZ = facesNegZ ? footZmin : ((footZmax > cz) ? footZmax : cz + 0.15 * (b.d || 1));
                const toeTipZ = facesNegZ ? (toeZ - 0.4) : (toeZ + 0.4);

                // Vertical stations (fractions of height). Arm/leg joints line up on a single
                // vertical so every limb is dead straight in the rest pose (no bent elbows).
                const hipsY = minY + 0.44 * H;
                const spineY = minY + 0.57 * H;
                const chestY = minY + 0.66 * H;
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
                // `helper: true` marca le ossa-punta (headTip / handTip / toeTip): esistono
                // SOLO perche' Blender orienti correttamente le foglie della catena. Non sono
                // selezionabili nella UI e NON ricevono voxel in bindVoxels: prima un
                // handTip_R poteva rubarsi le dita, producendo un osso che deforma la mesh
                // ma che nessuna clip anima (mano che resta indietro nell'export).
                const add = (name, parent, head, tail, helper) => {
                    const bd = { name, parent, head, tail };
                    if (helper) bd.helper = true;
                    bones.push(bd);
                    return bones.length - 1;
                };

                // Spine chain: hips → spine → chest → neck → head → headTip.
                // Each bone's head is the next one's tail, and every leaf ends in a small tip
                // bone so Blender orients them correctly (no "bones pointing up").
                // `upperChest` e' stato fuso in `chest`: nessuna clip lo animava e in pratica
                // era solo una riga in piu' nella lista ossa.
                const hips = add('hips', -1, [cx, hipsY, cz], [cx, spineY, cz]);
                const spine = add('spine', hips, [cx, spineY, cz], [cx, chestY, cz]);
                const chest = add('chest', spine, [cx, chestY, cz], [cx, neckY, cz]);
                const neck = add('neck', chest, [cx, neckY, cz], [cx, headY, cz]);
                const head = add('head', neck, [cx, headY, cz], [cx, headTopY, cz]);
                add('headTip', head, [cx, headTopY, cz], [cx, maxY, cz], true);

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
                const shoR = add('shoulder_R', chest, [cx, shldY, cz], [shRX, armY, cz]);
                const uaR = add('upperArm_R', shoR, [shRX, armY, cz], [rE, armY, cz]);
                const faR = add('forearm_R', uaR, [rE, armY, cz], [rW, armY, cz]);
                const haR = add('hand_R', faR, [rW, armY, cz], [rH, armY, cz]);
                add('handTip_R', haR, [rH, armY, cz], [rT, armY, cz], true);

                const shoL = add('shoulder_L', chest, [cx, shldY, cz], [shLX, armY, cz]);
                const uaL = add('upperArm_L', shoL, [shLX, armY, cz], [lE, armY, cz]);
                const faL = add('forearm_L', uaL, [lE, armY, cz], [lW, armY, cz]);
                const haL = add('hand_L', faL, [lW, armY, cz], [lH, armY, cz]);
                add('handTip_L', haL, [lH, armY, cz], [lT, armY, cz], true);

                // Legs: upperLeg → lowerLeg → foot → toeTip, attaccate DIRETTAMENTE a hips.
                // Le vecchie `pelvis_L/R` erano stub laterali di lunghezza quasi nulla
                // all'altezza dell'inguine: impossibili da cliccare, non animate da nessuna
                // clip, e in bindVoxels si rubavano i voxel del cavallo (da cui lo strappo
                // in quella zona). SkeletonHelper disegna comunque la linea hips→coscia,
                // quindi il bacino resta visibile senza essere un osso selezionabile.
                const ulR = add('upperLeg_R', hips, [legXR, hipsY, cz], [legXR, kneeY, cz]);
                const llR = add('lowerLeg_R', ulR, [legXR, kneeY, cz], [legXR, ankleY, ankleZ]);
                const ftR = add('foot_R', llR, [legXR, ankleY, ankleZ], [legXR, minY, toeZ]);
                add('toeTip_R', ftR, [legXR, minY, toeZ], [legXR, minY, toeTipZ], true);

                const ulL = add('upperLeg_L', hips, [legXL, hipsY, cz], [legXL, kneeY, cz]);
                const llL = add('lowerLeg_L', ulL, [legXL, kneeY, cz], [legXL, ankleY, ankleZ]);
                const ftL = add('foot_L', llL, [legXL, ankleY, ankleZ], [legXL, minY, toeZ]);
                add('toeTip_L', ftL, [legXL, minY, toeZ], [legXL, minY, toeTipZ], true);

                return { bones, pose: {}, binding: 'smooth', type: 'humanoid' };
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
                return { bones, pose: {}, binding: 'smooth', type: 'generic' };
            }

            // --- Pesi: formato canonico e normalizzazione ---------------------------
            // UNICO punto di verita' per il formato dei pesi. Accetta:
            //   "hand_L"                         (vecchio formato, retrocompatibile)
            //   {hand_L: 0.7, forearm_L: 0.3}    (nuovo)
            //   {hand_L: 3, forearm_L: 1}        (non normalizzato: diventa 0.75/0.25)
            // Restituisce un oggetto {nome: peso} con somma 1 e AL MASSIMO 4 ossa (in
            // THREE r128 skinIndex/skinWeight sono vec4: la quinta influenza verrebbe
            // silenziosamente buttata dalla GPU, quindi la buttiamo noi in modo esplicito
            // e ridistribuiamo il suo peso sulle altre). `null` se non resta nulla.
            const WEIGHT_EPS = 1e-4;
            function normalizeWeightEntry(entry, maxBones) {
                const limit = maxBones || MAX_BONE_INFLUENCES;
                if (entry === null || entry === undefined) return null;
                if (typeof entry === 'string') {
                    return entry ? { [entry]: 1 } : null;
                }
                if (typeof entry !== 'object') return null;
                const pairs = [];
                Object.keys(entry).forEach(name => {
                    const w = Number(entry[name]);
                    if (!isFinite(w) || w <= WEIGHT_EPS) return;   // pesi nulli/negativi: fuori
                    pairs.push([name, w]);
                });
                if (!pairs.length) return null;
                pairs.sort((a, b) => b[1] - a[1]);                 // le piu' influenti prima
                const keep = pairs.slice(0, limit);
                let sum = 0;
                keep.forEach(p => { sum += p[1]; });
                if (sum <= 0) return null;
                const out = {};
                keep.forEach(p => { out[p[0]] = p[1] / sum; });
                return out;
            }

            // Nome dell'osso dominante di una voce di pesi (o null).
            function dominantWeightBone(entry) {
                const n = normalizeWeightEntry(entry);
                if (!n) return null;
                let best = null, bw = -1;
                Object.keys(n).forEach(k => { if (n[k] > bw) { bw = n[k]; best = k; } });
                return best;
            }

            // --- Rampa colore dei pesi (identica a Blender) -------------------------
            // 0.00 blu (0,0,1) -> 0.25 ciano (0,1,1) -> 0.50 verde (0,1,0)
            // -> 0.75 giallo (1,1,0) -> 1.00 rosso (1,0,0), lineare nei quattro segmenti.
            // Funzione PURA (nessun THREE, nessuno stato): testabile in Node.
            function weightColor(w) {
                let x = Number(w);
                if (!isFinite(x)) x = 0;
                if (x < 0) x = 0; else if (x > 1) x = 1;
                if (x <= 0.25) { const t = x / 0.25; return { r: 0, g: t, b: 1 }; }
                if (x <= 0.5) { const t = (x - 0.25) / 0.25; return { r: 0, g: 1, b: 1 - t }; }
                if (x <= 0.75) { const t = (x - 0.5) / 0.25; return { r: t, g: 1, b: 0 }; }
                const t = (x - 0.75) / 0.25;
                return { r: 1, g: 1 - t, b: 0 };
            }

            // --- Binding ------------------------------------------------------------
            // Costo di assegnazione voxel→osso: distanza quadratica dal segmento piu' le
            // penalita' che tengono gli arti sul lato giusto e il busto fuori dalle cosce.
            // Estratta in una funzione perche' la usano DUE passi (scelta iniziale e
            // controllo del passo di coerenza): tenerle allineate a mano era un invito a
            // farle divergere. Vale sia per il binding rigido sia per quello smooth (la
            // penalita' di lato serve ANCHE ai pesi smooth: senza di essa la mano destra
            // riceverebbe un pezzo di peso dal braccio sinistro attraverso il busto).
            function boneCost(v, bone, cx, hipsY) {
                let d = distSqToSegment([v.x, v.y, v.z], bone.head, bone.tail);
                if (bone.name.endsWith('_R') && v.x < cx) d *= 10.0;
                if (bone.name.endsWith('_L') && v.x > cx) d *= 10.0;
                if (v.y < hipsY && (bone.name === 'hips' || bone.name === 'spine' || bone.name === 'chest')) d *= 4.0;
                return d;
            }

            // Ossa che possono ricevere voxel: le punte (helper) servono solo a Blender per
            // orientare le foglie. Se un rig fosse fatto tutto di helper si ricade su tutte
            // le ossa, per non restituire un binding vuoto.
            function bindableBones(bones) {
                const cand = [];
                for (let j = 0; j < bones.length; j++) if (!bones[j].helper) cand.push(j);
                if (!cand.length) for (let j = 0; j < bones.length; j++) cand.push(j);
                return cand;
            }

            // Binding COMPLETO: restituisce lo skinning a 4 ossa piu' l'osso dominante.
            //   { indices: Int32Array(n*4), weights: Float32Array(n*4), primary: Int32Array(n) }
            // I pesi di ogni voxel sommano a 1 e primary[i] e' SEMPRE lo slot di peso
            // massimo (garantito per costruzione, vedi il passo 4).
            //
            // Quattro passi:
            //   1. costo rigido -> osso migliore per voxel (invariante storica);
            //   2. coerenza a maggioranza sui 6 vicini (uccide i voxel-schizzo isolati che
            //      in Blender si vedono come strappi quando l'osso ruota);
            //   3. pesi smooth per falloff sulla distanza dal segmento, con l'osso del
            //      passo 2 come riferimento -> corpo dell'osso a peso ~1 e miscela SOLO
            //      dove due ossa sono equidistanti, cioe' vicino all'articolazione;
            //   4. laplaciano dei pesi sui 6 vicini (rifinitura), troncatura a 4 ossa,
            //      rinormalizzazione e riallineamento del dominante.
            // In modalita' 'rigid' i passi 3-4 sono saltati: peso 1 sull'osso del passo 2.
            function bindSkin(voxels, bones, overrides, opts) {
                const o = opts || {};
                const rigidMode = o.binding === 'rigid';
                const hardness = Math.max(1, Math.min(16, Number(o.hardness) || bindHardness || 6));
                const n = voxels.length;
                const b = voxelBounds(voxels);
                const cx = b.cx;
                const H = b.h || 1;
                const hipsY = b.minY + 0.44 * H;
                const cand = bindableBones(bones);

                // Passi 1-2: osso dominante rigido, con coerenza spaziale.
                const primary = new Int32Array(n);
                const bestDist = new Float64Array(n);
                const costs = new Float64Array(cand.length);
                for (let i = 0; i < n; i++) {
                    const v = voxels[i];
                    let best = cand[0], bestD = Infinity;
                    for (let c = 0; c < cand.length; c++) {
                        const d = boneCost(v, bones[cand[c]], cx, hipsY);
                        if (d < bestD) { bestD = d; best = cand[c]; }
                    }
                    primary[i] = best;
                    bestDist[i] = bestD;
                }
                smoothAssignments(voxels, bones, primary, bestDist, cx, hipsY);

                const indices = new Int32Array(n * MAX_BONE_INFLUENCES);
                const weights = new Float32Array(n * MAX_BONE_INFLUENCES);

                if (rigidMode) {
                    for (let i = 0; i < n; i++) {
                        indices[i * MAX_BONE_INFLUENCES] = primary[i];
                        weights[i * MAX_BONE_INFLUENCES] = 1;
                    }
                    applyWeightOverridesSkin(voxels, bones, indices, weights, primary, overrides, true);
                    return { indices, weights, primary };
                }

                // Passo 3: falloff sulla distanza. Il riferimento e' l'osso DOMINANTE del
                // passo 2 (non il minimo assoluto): cosi' la coerenza spaziale non viene
                // buttata via dal calcolo dei pesi, e il dominante ha sempre peso 1 prima
                // della normalizzazione.
                const slot = [0, 0, 0, 0], sw = [0, 0, 0, 0];
                for (let i = 0; i < n; i++) {
                    const v = voxels[i];
                    const pj = primary[i];
                    let dPrim = Infinity;
                    for (let c = 0; c < cand.length; c++) {
                        const d = boneCost(v, bones[cand[c]], cx, hipsY);
                        costs[c] = d;
                        if (cand[c] === pj) dPrim = d;
                    }
                    if (!isFinite(dPrim)) dPrim = bestDist[i];
                    // Distanze lineari: il falloff e' (dPrim/d)^hardness, cioe' 1 sul corpo
                    // dell'osso e 0.5/0.5 esattamente dove due ossa sono equidistanti.
                    const rPrim = Math.sqrt(Math.max(dPrim, 1e-9));
                    let used = 0;
                    for (let c = 0; c < cand.length; c++) {
                        const j = cand[c];
                        let w;
                        if (j === pj) w = 1;
                        else {
                            const r = Math.sqrt(Math.max(costs[c], 1e-9));
                            if (r > rPrim * 3) continue;              // troppo lontano: zero
                            w = Math.pow(rPrim / r, hardness);
                            if (w > 1) w = 1;                          // il dominante resta il massimo
                            if (w <= 0.02) continue;                   // briciole: fuori
                        }
                        // Inserimento ordinato nei 4 slot (piu' pesante per primo).
                        let p = used < MAX_BONE_INFLUENCES ? used : MAX_BONE_INFLUENCES;
                        if (p === MAX_BONE_INFLUENCES) {
                            if (w <= sw[MAX_BONE_INFLUENCES - 1]) continue;
                            p = MAX_BONE_INFLUENCES - 1;
                        } else used++;
                        while (p > 0 && sw[p - 1] < w) { sw[p] = sw[p - 1]; slot[p] = slot[p - 1]; p--; }
                        sw[p] = w; slot[p] = j;
                    }
                    let sum = 0;
                    for (let s = 0; s < used; s++) sum += sw[s];
                    if (sum <= 0) { used = 1; slot[0] = pj; sw[0] = 1; sum = 1; }
                    const base = i * MAX_BONE_INFLUENCES;
                    for (let s = 0; s < MAX_BONE_INFLUENCES; s++) {
                        indices[base + s] = s < used ? slot[s] : 0;
                        weights[base + s] = s < used ? sw[s] / sum : 0;
                    }
                }

                // Passo 4: rifinitura laplaciana sui 6 vicini.
                smoothSkinWeights(voxels, indices, weights, primary);
                applyWeightOverridesSkin(voxels, bones, indices, weights, primary, overrides, false);
                return { indices, weights, primary };
            }

            // Compatibilita': molte parti (riempimento, colore per osso, test) vogliono solo
            // l'osso dominante per voxel. Resta una Int32Array parallela ai voxel.
            function bindVoxels(voxels, bones, overrides, opts) {
                return bindSkin(voxels, bones, overrides, opts).primary;
            }

            // Passo di coerenza. La sola distanza dal segmento produce voxel isolati
            // assegnati a un osso diverso da tutti i loro vicini (macchioline sparse nella
            // vista "colora pesi"). Su una mesh rigida quel singolo voxel schizza via appena
            // l'osso ruota: e' lo strappo che si vede in Blender. Qui ogni voxel adotta
            // l'osso di MAGGIORANZA fra i suoi 6 vicini, ma solo se quell'osso resta
            // plausibile per lui (costo entro 2.25x = 1.5x in distanza lineare). Senza quel
            // limite la maggioranza dilagherebbe e cancellerebbe le ossa piccole (mani, piedi).
            function smoothAssignments(voxels, bones, assign, bestDist, cx, hipsY, iterations) {
                const index = new Map();
                for (let i = 0; i < voxels.length; i++) {
                    index.set(voxels[i].x + ',' + voxels[i].y + ',' + voxels[i].z, i);
                }
                const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
                const passes = iterations || 2;
                const tally = new Map();
                for (let it = 0; it < passes; it++) {
                    const next = assign.slice();
                    let changed = 0;
                    for (let i = 0; i < voxels.length; i++) {
                        const v = voxels[i];
                        tally.clear();
                        let neigh = 0;
                        for (let n = 0; n < 6; n++) {
                            const k = index.get((v.x + N[n][0]) + ',' + (v.y + N[n][1]) + ',' + (v.z + N[n][2]));
                            if (k === undefined) continue;
                            neigh++;
                            tally.set(assign[k], (tally.get(assign[k]) || 0) + 1);
                        }
                        if (neigh < 3) continue;               // spigolo/dettaglio sottile: non toccare
                        let topBone = assign[i], topN = tally.get(assign[i]) || 0;
                        tally.forEach((n, bi) => { if (n > topN) { topN = n; topBone = bi; } });
                        if (topBone === assign[i]) continue;
                        if (topN * 2 <= neigh) continue;       // serve una maggioranza vera
                        if (boneCost(v, bones[topBone], cx, hipsY) > bestDist[i] * 2.25 + 1e-6) continue;
                        next[i] = topBone; changed++;
                    }
                    assign.set(next);
                    if (!changed) break;
                }
            }

            // Laplaciano dei PESI sui 6 vicini: e' l'equivalente smooth del passo di
            // coerenza qui sopra (che ragiona su un osso solo). Ammorbidisce ulteriormente
            // le articolazioni e cancella le discontinuita' di un voxel, senza spostare il
            // dominante: al termine il peso del dominante viene riportato al massimo, cosi'
            // `primary` e lo skinning non possono divergere.
            function smoothSkinWeights(voxels, indices, weights, primary, lambda, iterations) {
                const n = voxels.length;
                if (!n) return;
                const lam = (lambda === undefined) ? 0.3 : lambda;
                const passes = iterations || 2;
                const index = new Map();
                for (let i = 0; i < n; i++) index.set(voxels[i].x + ',' + voxels[i].y + ',' + voxels[i].z, i);
                const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
                const acc = new Map();
                const M = MAX_BONE_INFLUENCES;
                for (let it = 0; it < passes; it++) {
                    const src = weights.slice();
                    const sidx = indices.slice();
                    for (let i = 0; i < n; i++) {
                        const v = voxels[i];
                        acc.clear();
                        let neigh = 0;
                        for (let k = 0; k < 6; k++) {
                            const j = index.get((v.x + N[k][0]) + ',' + (v.y + N[k][1]) + ',' + (v.z + N[k][2]));
                            if (j === undefined) continue;
                            neigh++;
                            for (let s = 0; s < M; s++) {
                                const w = src[j * M + s];
                                if (w <= 0) continue;
                                const bi = sidx[j * M + s];
                                acc.set(bi, (acc.get(bi) || 0) + w);
                            }
                        }
                        if (!neigh) continue;
                        // Mescola: (1-lam) * proprio + lam * media dei vicini.
                        const mix = new Map();
                        for (let s = 0; s < M; s++) {
                            const w = src[i * M + s];
                            if (w > 0) mix.set(sidx[i * M + s], w * (1 - lam));
                        }
                        acc.forEach((w, bi) => { mix.set(bi, (mix.get(bi) || 0) + (w / neigh) * lam); });
                        // Ordina, tieni 4, normalizza, forza il dominante al massimo.
                        const pairs = [];
                        mix.forEach((w, bi) => { if (w > WEIGHT_EPS) pairs.push([bi, w]); });
                        if (!pairs.length) continue;
                        pairs.sort((a, b) => b[1] - a[1]);
                        const pj = primary[i];
                        let keep = pairs.slice(0, M);
                        if (!keep.some(p => p[0] === pj)) {
                            keep[keep.length - 1] = [pj, keep[0][1]];      // il dominante non si perde
                        }
                        const top = keep.reduce((m, p) => Math.max(m, p[1]), 0);
                        keep = keep.map(p => (p[0] === pj ? [pj, top] : p));
                        keep.sort((a, b) => b[1] - a[1]);
                        let sum = 0; keep.forEach(p => { sum += p[1]; });
                        if (sum <= 0) continue;
                        for (let s = 0; s < M; s++) {
                            indices[i * M + s] = s < keep.length ? keep[s][0] : 0;
                            weights[i * M + s] = s < keep.length ? keep[s][1] / sum : 0;
                        }
                    }
                }
            }

            // Sovrascritture manuali del weight paint: rig.weights = { "x,y,z": voce }, dove
            // la voce e' una stringa (vecchio formato) o {osso: peso}. Sono SPARSE (solo i
            // voxel dipinti a mano) cosi' il file salvato resta piccolo, e si applicano DOPO
            // il binding automatico: ridipingere non richiede di rifare il rig, e cancellare
            // una sovrascrittura fa tornare l'automatico.
            function applyWeightOverridesSkin(voxels, bones, indices, weights, primary, overrides, rigidMode) {
                if (!overrides) return 0;
                const byName = new Map();
                bones.forEach((bd, j) => byName.set(bd.name, j));
                const M = MAX_BONE_INFLUENCES;
                let hits = 0;
                for (let i = 0; i < voxels.length; i++) {
                    const v = voxels[i];
                    const raw = overrides[v.x + ',' + v.y + ',' + v.z];
                    if (raw === undefined) continue;
                    const entry = normalizeWeightEntry(raw);
                    if (!entry) continue;
                    // Ossa rinominate o rimosse: si scartano e si rinormalizza il resto.
                    const pairs = [];
                    Object.keys(entry).forEach(name => {
                        const j = byName.get(name);
                        if (j === undefined) return;
                        pairs.push([j, entry[name]]);
                    });
                    if (!pairs.length) continue;
                    pairs.sort((a, b) => b[1] - a[1]);
                    if (rigidMode) {
                        primary[i] = pairs[0][0];
                        indices[i * M] = pairs[0][0]; weights[i * M] = 1;
                        for (let s = 1; s < M; s++) { indices[i * M + s] = 0; weights[i * M + s] = 0; }
                        hits++;
                        continue;
                    }
                    let sum = 0; pairs.forEach(p => { sum += p[1]; });
                    for (let s = 0; s < M; s++) {
                        indices[i * M + s] = s < pairs.length ? pairs[s][0] : 0;
                        weights[i * M + s] = s < pairs.length ? pairs[s][1] / sum : 0;
                    }
                    primary[i] = pairs[0][0];
                    hits++;
                }
                return hits;
            }

            // Variante che scrive SOLO l'osso dominante (usata dove interessa la sola
            // assegnazione, es. il ricalcolo automatico dopo una cancellazione).
            function applyWeightOverrides(voxels, bones, assign, overrides) {
                if (!overrides) return 0;
                const byName = new Map();
                bones.forEach((bd, j) => byName.set(bd.name, j));
                let hits = 0;
                for (let i = 0; i < voxels.length; i++) {
                    const v = voxels[i];
                    const raw = overrides[v.x + ',' + v.y + ',' + v.z];
                    if (raw === undefined) continue;
                    const name = dominantWeightBone(raw);
                    if (name === null) continue;
                    const j = byName.get(name);
                    if (j === undefined) continue;   // osso rinominato o rimosso: ignora
                    assign[i] = j; hits++;
                }
                return hits;
            }

            // Peso dell'osso `boneIndex` sul voxel `i` secondo lo skinning corrente.
            function voxelWeightFor(i, boneIndex) {
                if (!boneWeightIndices || !boneWeightValues) {
                    return (boneAssignments && boneAssignments[i] === boneIndex) ? 1 : 0;
                }
                const base = i * MAX_BONE_INFLUENCES;
                for (let s = 0; s < MAX_BONE_INFLUENCES; s++) {
                    if (boneWeightValues[base + s] <= 0) break;
                    if (boneWeightIndices[base + s] === boneIndex) return boneWeightValues[base + s];
                }
                return 0;
            }

            // Voce di pesi (oggetto {nome: peso}) del voxel `i`, per salvarla in rig.weights.
            function voxelWeightEntry(i, bones) {
                const out = {};
                const base = i * MAX_BONE_INFLUENCES;
                for (let s = 0; s < MAX_BONE_INFLUENCES; s++) {
                    const w = boneWeightValues ? boneWeightValues[base + s] : (s === 0 ? 1 : 0);
                    if (w <= WEIGHT_EPS) continue;
                    const bi = boneWeightIndices ? boneWeightIndices[base + s] : boneAssignments[i];
                    const bd = bones[bi];
                    if (bd) out[bd.name] = (out[bd.name] || 0) + w;
                }
                return normalizeWeightEntry(out);
            }

            // Distinct-ish color per bone index for the "colore per osso" view.
            function boneColor(i, total) {
                const hue = (i * 0.61803398875) % 1;      // golden-ratio hue spacing
                const c = new THREE.Color();
                c.setHSL(hue, 0.65, 0.55);
                return c;
            }

            // --- SkinnedMesh construction ------------------------------------------
            // One cube per voxel; i 4 skinIndex/skinWeight di ogni vertice sono quelli
            // REALI del voxel (in 'rigid' si riducono a 1/0/0/0). Vertices are authored in
            // world/voxel space; THREE.Skeleton's inverse bind matrices (from bone world
            // transforms at bind time) make the skinning line up. Teniamo TRE attributi di
            // colore pronti (colore voxel, colore per osso, rampa del peso dell'osso
            // selezionato) e scambiamo il buffer al volo, senza ricostruire la mesh.
            function buildSkinnedMesh(voxels, bones, assignments, skin) {
                const voxelSet = new Set();
                voxels.forEach(vox => voxelSet.add(`${vox.x},${vox.y},${vox.z}`));

                const positions = [];
                const normals = [];
                const vColors = [];   // real voxel colors
                const bColors = [];   // per-bone debug colors
                const wColors = [];   // rampa peso dell'osso selezionato (stile Blender)
                const skinIndices = [];
                const skinWeights = [];
                const M = MAX_BONE_INFLUENCES;
                const refBone = (selectedBoneIndex >= 0) ? selectedBoneIndex : -1;
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
                // Per ogni voxel, [primo vertice, numero di vertici] nella geometria. Serve al
                // weight paint per riassegnare un voxel senza ricostruire tutta la mesh:
                // basta riscrivere skinIndex e il colore di quei vertici. Senza questa mappa
                // ogni pennellata costerebbe un rebuild completo (secondi su modelli grandi).
                const vertexRanges = new Int32Array(voxels.length * 2);

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
                        // 4 influenze reali del voxel; senza `skin` (chiamate legacy) si
                        // ricade sul rigido 1/0/0/0 sull'osso dominante.
                        const base = i * M;
                        const si0 = skin ? skin.indices[base] : bi;
                        const si1 = skin ? skin.indices[base + 1] : 0;
                        const si2 = skin ? skin.indices[base + 2] : 0;
                        const si3 = skin ? skin.indices[base + 3] : 0;
                        const sw0 = skin ? skin.weights[base] : 1;
                        const sw1 = skin ? skin.weights[base + 1] : 0;
                        const sw2 = skin ? skin.weights[base + 2] : 0;
                        const sw3 = skin ? skin.weights[base + 3] : 0;
                        // Rampa Blender del peso dell'osso selezionato (0 = blu).
                        let wSel = 0;
                        if (refBone >= 0) {
                            if (si0 === refBone) wSel = sw0;
                            else if (si1 === refBone && sw1 > 0) wSel = sw1;
                            else if (si2 === refBone && sw2 > 0) wSel = sw2;
                            else if (si3 === refBone && sw3 > 0) wSel = sw3;
                        }
                        const wc = weightColor(wSel);
                        const vStart = vbase;
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
                                wColors.push(wc.r, wc.g, wc.b);
                                skinIndices.push(si0, si1, si2, si3);
                                skinWeights.push(sw0, sw1, sw2, sw3);
                            }
                            indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
                            vbase += 4;
                        }
                        vertexRanges[i * 2] = vStart;
                        vertexRanges[i * 2 + 1] = vbase - vStart;
                    }
                    groups.push({ start: groupStart, count: indices.length - groupStart, matIndex: materials.length - 1 });
                }
                previewVertexRanges = vertexRanges;

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
                previewWeightColors = new Float32Array(wColors);

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

            // --- Il rig e' visibile solo sulla sua tab -------------------------------
            // switchTab() vive in un altro modulo: qui leggiamo lo stato dal DOM cosi'
            // applyRig() (chiamato anche da undo/redo, import, cambio oggetto) non fa
            // comparire scheletro, pallini e gizmo mentre si sta disegnando.
            function rigTabActive() {
                const p = document.querySelector('.tab-panel[data-panel="rig"]');
                return !!(p && p.classList && p.classList.contains('active'));
            }

            // --- Apply the whole rig: build preview mesh, skeleton helper, UI ---------
            function applyRig() {
                clearRigPreview();
                if (!rig || !rig.bones.length) return;
                const voxels = currentModelData.voxels || [];
                if (!voxels.length) return;

                pruneWeightOverrides(voxels);
                const skin = bindSkin(voxels, rig.bones, rig.weights, {
                    binding: rig.binding, hardness: bindHardness
                });
                const assignments = skin.primary;
                boneAssignments = assignments;
                boneWeightIndices = skin.indices;
                boneWeightValues = skin.weights;
                rigVoxelIndex = new Map();
                for (let i = 0; i < voxels.length; i++) {
                    rigVoxelIndex.set(voxels[i].x + ',' + voxels[i].y + ',' + voxels[i].z, i);
                }
                const built = buildSkinnedMesh(voxels, rig.bones, assignments, skin);
                skinnedMesh = built.mesh;
                skeleton = built.skeleton;

                rigGroup.position.set(0, 0, 0);
                rigGroup.rotation.y = 0;
                skinnedMesh.position.set(0, 0, 0);

                rigGroup.add(skinnedMesh);

                skeletonHelper = new THREE.SkeletonHelper(skinnedMesh);
                skeletonHelper.material.linewidth = 2;
                scene.add(skeletonHelper);

                // Joint marker for the selected bone. Raggio ridotto (0.42 -> 0.30) in
                // coerenza con HANDLE_PIXELS e con il gizmo: prima nascondeva il giunto.
                boneMarker = new THREE.Mesh(
                    new THREE.SphereGeometry(0.30, 12, 12),
                    new THREE.MeshBasicMaterial({ color: 0xfbbf24, depthTest: false, transparent: true })
                );
                boneMarker.renderOrder = 999;
                boneMarker.visible = false;
                scene.add(boneMarker);

                buildJointHandles();
                buildAnimationClips();
                applyPoseToBones();
                // Fuori dalla tab Rig il rig resta DATO: nessuna anteprima, nessun gizmo.
                const onRigTab = rigTabActive();
                rigPreviewActive = onRigTab;
                gizmoEnabled = onRigTab;
                updateRigVisibility();
                renderBoneList();
                if (onRigTab) {
                    rigDetails.style.display = 'block';
                    if (showRigBtn) showRigBtn.style.display = 'none';
                }
                if (typeof updateGizmo === 'function') updateGizmo();
                const nSel = rig.bones.filter(bd => !bd.helper).length;
                rigHint.textContent = t('rig.ready', { type: rig.type, count: nSel });
                updateWeightPaintUI();
            }

            // Le sovrascritture del weight paint sono indicizzate per coordinata voxel.
            // Se il modello viene modificato (voxel cancellati, oggetto diverso) le chiavi
            // rimaste puntano al vuoto: vanno buttate, altrimenti il file cresce per sempre
            // con dati morti e riappaiono se in futuro qualcuno ridisegna in quel punto.
            function pruneWeightOverrides(voxels) {
                if (!rig || !rig.weights) return;
                const keys = Object.keys(rig.weights);
                if (!keys.length) { rig.weights = null; return; }
                const live = new Set();
                for (let i = 0; i < voxels.length; i++) {
                    live.add(voxels[i].x + ',' + voxels[i].y + ',' + voxels[i].z);
                }
                let removed = 0;
                keys.forEach(k => { if (!live.has(k)) { delete rig.weights[k]; removed++; } });
                if (removed && !Object.keys(rig.weights).length) rig.weights = null;
            }

            // --- Pallini sui giunti (bersagli di selezione) --------------------------
            // Un pallino per ogni osso NON helper, posizionato sulla testa dell'osso. Le
            // foglie (hand_*, foot_*, head) ricevono anche un pallino sulla CODA, altrimenti
            // l'ultimo giunto della catena non avrebbe alcun bersaglio.
            // `depthTest: false` li rende sempre visibili anche dentro il modello: se li
            // nascondesse la mesh, cliccare un ginocchio da davanti sarebbe di nuovo un
            // indovinello.
            function buildJointHandles() {
                clearJointHandles();
                if (!rig || !skeleton) return;
                jointHandleGroup = new THREE.Group();
                jointHandleGroup.renderOrder = 997;
                const geo = new THREE.SphereGeometry(1, 10, 10);
                const isLeaf = (i) => !rig.bones.some(bd => bd.parent === i && !bd.helper);
                rig.bones.forEach((bd, i) => {
                    if (bd.helper) return;
                    const mk = (atTail) => {
                        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                            color: HANDLE_COL_IDLE, depthTest: false, transparent: true, opacity: 0.95
                        }));
                        m.renderOrder = 997;
                        m.userData.boneIndex = i;
                        m.userData.atTail = !!atTail;
                        jointHandleGroup.add(m);
                        jointHandles.push({ mesh: m, boneIndex: i, atTail: !!atTail });
                    };
                    mk(false);
                    if (isLeaf(i)) mk(true);
                });
                scene.add(jointHandleGroup);
                updateJointHandles();
            }

            function clearJointHandles() {
                if (jointHandleGroup) {
                    jointHandleGroup.children.forEach(m => { if (m.material) m.material.dispose(); });
                    if (jointHandleGroup.children[0] && jointHandleGroup.children[0].geometry) {
                        jointHandleGroup.children[0].geometry.dispose();
                    }
                    scene.remove(jointHandleGroup);
                }
                jointHandleGroup = null;
                jointHandles = [];
                hoveredBoneIndex = -1;
            }

            // Raggio in unita' mondo che corrisponde a HANDLE_PIXELS pixel a schermo alla
            // distanza data: i pallini restano della stessa dimensione apparente sia su un
            // modello 16^3 sia su uno 256^3, e non diventano puntini invisibili se ti allontani.
            const _hv = new THREE.Vector3();
            function worldRadiusForPixels(pos, px) {
                const dist = camera.position.distanceTo(pos) || 1;
                const h = renderer.domElement.clientHeight || 600;
                const worldPerPixel = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * dist / h;
                return Math.max(1e-3, worldPerPixel * px);
            }

            function updateJointHandles() {
                if (!jointHandleGroup || !skeleton) return;
                const show = rigPreviewActive && (!toggleSkeleton || toggleSkeleton.checked);
                jointHandleGroup.visible = show;
                if (!show) return;
                jointHandles.forEach(h => {
                    const bone = skeleton.bones[h.boneIndex];
                    if (!bone) return;
                    bone.updateWorldMatrix(true, false);
                    if (h.atTail) {
                        const bd = rig.bones[h.boneIndex];
                        const q = new THREE.Quaternion(); bone.getWorldQuaternion(q);
                        _hv.set(bd.tail[0] - bd.head[0], bd.tail[1] - bd.head[1], bd.tail[2] - bd.head[2])
                            .applyQuaternion(q);
                        h.mesh.position.setFromMatrixPosition(bone.matrixWorld).add(_hv);
                    } else {
                        h.mesh.position.setFromMatrixPosition(bone.matrixWorld);
                    }
                    const sel = h.boneIndex === selectedBoneIndex;
                    const hov = h.boneIndex === hoveredBoneIndex;
                    const r = worldRadiusForPixels(h.mesh.position, HANDLE_PIXELS * (sel ? 1.35 : hov ? 1.2 : 1));
                    h.mesh.scale.setScalar(r);
                    h.mesh.material.color.setHex(sel ? HANDLE_COL_SEL : hov ? HANDLE_COL_HOVER : HANDLE_COL_IDLE);
                    h.mesh.material.opacity = sel || hov ? 1 : 0.85;
                });
            }

            function setHoveredBone(i) {
                if (i === hoveredBoneIndex) return;
                hoveredBoneIndex = i;
                updateJointHandles();
                if (typeof requestRender === 'function') requestRender();
            }

            /* ===================== WEIGHT PAINT =====================
               Blender dipinge pesi float e mescola piu' ossa per vertice; sui voxel questo
               scioglie i cubi (vedi il commento in cima a questo file). Qui il binding e'
               RIGIDO, quindi "dipingere i pesi" significa RIASSEGNARE voxel a un osso: piu'
               prevedibile, e nel file finiscono solo i voxel corretti a mano.

               Vincolo tecnico da conoscere: THREE r128 NON deforma la geometria quando fa il
               raycast di una SkinnedMesh. Con una posa attiva il click cadrebbe dove il
               modello NON e' disegnato. Per questo entrando in pittura si torna alla posa di
               riposo: la posa viene messa da parte e ripristinata all'uscita. */

            const WP_MAX_FILL = 60000;      // tetto del riempimento, per non bloccare la tab
            let wpMode = 'mix';             // 'mix' | 'add' | 'subtract' | 'blur' | 'fill' | 'erase'
            let poseBeforePaint = null;

            const weightPaintToggle = document.getElementById('weightPaintToggle');
            const wpModeControl = document.getElementById('wpMode');
            const wpRadius = document.getElementById('wpRadius');
            const wpRadiusVal = document.getElementById('wpRadiusVal');
            const wpTargetBone = document.getElementById('wpTargetBone');
            const wpResetBtn = document.getElementById('wpResetBtn');
            const wpStats = document.getElementById('wpStats');
            const wpBody = document.getElementById('wpBody');
            const wpStrengthInput = document.getElementById('wpStrength');
            const wpStrengthVal = document.getElementById('wpStrengthVal');
            const wpFalloffControl = document.getElementById('wpFalloff');
            const wpWeightReadout = document.getElementById('wpWeightReadout');

            function weightOverrideCount() {
                return (rig && rig.weights) ? Object.keys(rig.weights).length : 0;
            }

            function updateWeightPaintUI() {
                if (!weightPaintToggle) return;
                const usable = !!(rig && rig.bones && rig.bones.length && rigPreviewActive);
                weightPaintToggle.disabled = !usable;
                weightPaintToggle.classList.toggle('btn-primary', weightPaintActive);
                weightPaintToggle.classList.toggle('btn-secondary', !weightPaintActive);
                weightPaintToggle.textContent = weightPaintActive ? t('rig.wp.exit') : t('rig.wp.enter');
                if (wpBody) wpBody.style.display = weightPaintActive ? '' : 'none';
                if (wpTargetBone) {
                    wpTargetBone.textContent = (rig && selectedBoneIndex >= 0 && rig.bones[selectedBoneIndex])
                        ? rig.bones[selectedBoneIndex].name : '-';
                }
                if (wpStats) {
                    const n = weightOverrideCount();
                    wpStats.textContent = n ? t('rig.wp.statsN', { n }) : t('rig.wp.statsNone');
                }
                // Forza e falloff non hanno senso in 'fill' (colpo secco su tutto il pezzo)
                // ne' in 'erase' (torna all'automatico): si spengono per non mentire.
                const graded = wpMode !== 'fill' && wpMode !== 'erase';
                if (wpStrengthInput) wpStrengthInput.disabled = !graded;
                if (wpFalloffControl) wpFalloffControl.style.opacity = graded ? '' : '0.45';
                if (wpResetBtn) wpResetBtn.disabled = !weightOverrideCount();
            }

            // Peso dell'osso selezionato sul voxel sotto il cursore, mostrato come in Blender
            // (numero + pastiglia colorata con la stessa rampa della mesh).
            function updateWeightReadout(voxelIndex) {
                if (!wpWeightReadout) return;
                if (!weightPaintActive || voxelIndex < 0 || selectedBoneIndex < 0) {
                    wpWeightReadout.textContent = '-';
                    wpWeightReadout.style.background = 'transparent';
                    wpWeightReadout.style.color = '';
                    return;
                }
                const w = voxelWeightFor(voxelIndex, selectedBoneIndex);
                const c = weightColor(w);
                wpWeightReadout.textContent = w.toFixed(3);
                wpWeightReadout.style.background = 'rgb(' + Math.round(c.r * 255) + ','
                    + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ')';
                // Il verde/giallo centrale della rampa e' chiaro: testo scuro per leggerlo.
                wpWeightReadout.style.color = (w > 0.28 && w < 0.85) ? '#111827' : '#ffffff';
            }

            function setWeightPaint(on) {
                if (!rig || !skeleton) on = false;
                if (on === weightPaintActive) { updateWeightPaintUI(); return; }
                weightPaintActive = on;
                if (on) {
                    if (typeof rigDisableIk === 'function') rigDisableIk();   // IK e pittura si escludono
                    if (currentAction) { currentAction.stop(); currentAction = null; animSelect.value = 'none'; }
                    poseBeforePaint = JSON.parse(JSON.stringify(rig.pose || {}));
                    rig.pose = {};
                    applyPoseToBones();
                    refreshWeightColors();
                    if (rigHint) rigHint.textContent = t('rig.wp.hintOn');
                } else {
                    if (poseBeforePaint) { rig.pose = poseBeforePaint; poseBeforePaint = null; }
                    applyPoseToBones();
                    hideBrushPreview();
                }
                updateRigVisibility();
                if (typeof updateGizmo === 'function') updateGizmo();
                updateWeightPaintUI();
                if (typeof requestRender === 'function') requestRender();
            }

            // Voxel sotto il cursore, dedotto dal punto colpito e dalla normale della faccia:
            // il centro del cubo sta mezzo voxel DIETRO la faccia toccata.
            function pickPaintVoxel(clientX, clientY) {
                if (!skinnedMesh || !rigVoxelIndex) return -1;
                const rect = renderer.domElement.getBoundingClientRect();
                pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
                pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(pointer, camera);
                const hits = raycaster.intersectObject(skinnedMesh, false);
                if (!hits.length || !hits[0].face) return -1;
                const p = hits[0].point, n = hits[0].face.normal;
                const key = Math.round(p.x - n.x * 0.5) + ',' + Math.round(p.y - n.y * 0.5) + ',' + Math.round(p.z - n.z * 0.5);
                const i = rigVoxelIndex.get(key);
                return i === undefined ? -1 : i;
            }

            // Riscrive UN voxel in modo RIGIDO (peso 1 su un osso): skinIndex/skinWeight dei
            // suoi vertici piu' i colori. Nessun rebuild. Usata dal binding 'rigid' e dalla
            // gomma, che riporta il voxel all'assegnazione automatica.
            function setVoxelBone(i, boneIndex) {
                const e = {};
                if (!rig || !rig.bones[boneIndex]) return false;
                e[rig.bones[boneIndex].name] = 1;
                return setVoxelWeights(i, e);
            }

            // Riscrive UN voxel con una voce di pesi {osso: peso} (normalizzata qui dentro):
            // skinIndex/skinWeight vec4 dei suoi vertici, colore-osso e colore-peso. E' il
            // cuore della pittura smooth: costa O(vertici del voxel), non un rebuild.
            // Restituisce false se nulla e' cambiato.
            function setVoxelWeights(i, entry) {
                if (!previewVertexRanges || !skinnedMesh || !rig) return false;
                if (!boneWeightIndices || !boneWeightValues) return false;
                const norm = normalizeWeightEntry(entry);
                if (!norm) return false;
                const byName = new Map();
                rig.bones.forEach((bd, j) => byName.set(bd.name, j));
                const pairs = [];
                Object.keys(norm).forEach(name => {
                    const j = byName.get(name);
                    if (j !== undefined) pairs.push([j, norm[name]]);
                });
                if (!pairs.length) return false;
                pairs.sort((a, b) => b[1] - a[1]);
                let sum = 0; pairs.forEach(p => { sum += p[1]; });
                if (sum <= 0) return false;

                const M = MAX_BONE_INFLUENCES;
                const base = i * M;
                let changed = false;
                const idx = [0, 0, 0, 0], wgt = [0, 0, 0, 0];
                for (let s = 0; s < M; s++) {
                    idx[s] = s < pairs.length ? pairs[s][0] : 0;
                    wgt[s] = s < pairs.length ? pairs[s][1] / sum : 0;
                    if (boneWeightIndices[base + s] !== idx[s] || Math.abs(boneWeightValues[base + s] - wgt[s]) > WEIGHT_EPS) {
                        changed = true;
                    }
                    boneWeightIndices[base + s] = idx[s];
                    boneWeightValues[base + s] = wgt[s];
                }
                if (!changed) return false;
                boneAssignments[i] = idx[0];

                const start = previewVertexRanges[i * 2], count = previewVertexRanges[i * 2 + 1];
                if (count <= 0) return true;                 // voxel interno: nessun vertice
                const bc = boneColor(idx[0], rig.bones.length);
                const wc = weightColor(voxelWeightFor(i, selectedBoneIndex));
                const geo = skinnedMesh.geometry;
                const si = geo.getAttribute('skinIndex');
                const sw = geo.getAttribute('skinWeight');
                const col = geo.getAttribute('color');
                for (let v = start; v < start + count; v++) {
                    si.setXYZW(v, idx[0], idx[1], idx[2], idx[3]);
                    sw.setXYZW(v, wgt[0], wgt[1], wgt[2], wgt[3]);
                    previewBoneColors[v * 3] = bc.r;
                    previewBoneColors[v * 3 + 1] = bc.g;
                    previewBoneColors[v * 3 + 2] = bc.b;
                    if (previewWeightColors) {
                        previewWeightColors[v * 3] = wc.r;
                        previewWeightColors[v * 3 + 1] = wc.g;
                        previewWeightColors[v * 3 + 2] = wc.b;
                    }
                }
                si.needsUpdate = true;
                sw.needsUpdate = true;
                const src = activePreviewColors();
                if (src) {
                    for (let v = start; v < start + count; v++) {
                        col.setXYZ(v, src[v * 3], src[v * 3 + 1], src[v * 3 + 2]);
                    }
                    col.needsUpdate = true;
                }
                return true;
            }

            // Quale array di colori sta guardando l'utente in questo momento.
            // In pittura si vede SEMPRE la rampa dei pesi (come Blender): e' l'unico modo
            // di vedere l'effetto del pennello mentre lo si usa.
            function activePreviewColors() {
                if (weightPaintActive) return previewWeightColors || previewBoneColors;
                if (toggleWeightColors && toggleWeightColors.checked) {
                    return (wpColorMode === 'weight' ? (previewWeightColors || previewBoneColors) : previewBoneColors);
                }
                return previewVoxelColors;
            }

            // Ricalcola la rampa colore dei pesi per l'osso selezionato. Si chiama quando
            // cambia la selezione: la vista "peso" e' sempre relativa a UN osso, come il
            // Weight Paint di Blender.
            function refreshWeightColors() {
                if (!skinnedMesh || !previewWeightColors || !previewVertexRanges) return;
                const voxels = currentModelData.voxels || [];
                for (let i = 0; i < voxels.length; i++) {
                    const start = previewVertexRanges[i * 2], count = previewVertexRanges[i * 2 + 1];
                    if (count <= 0) continue;
                    const wc = weightColor(selectedBoneIndex >= 0 ? voxelWeightFor(i, selectedBoneIndex) : 0);
                    for (let v = start; v < start + count; v++) {
                        previewWeightColors[v * 3] = wc.r;
                        previewWeightColors[v * 3 + 1] = wc.g;
                        previewWeightColors[v * 3 + 2] = wc.b;
                    }
                }
            }

            // Fattore di falloff del pennello a distanza normalizzata d01 (0 = centro,
            // 1 = bordo). Le tre curve sono quelle di Blender:
            //   smooth   -> smoothstep inverso (morbido, il default)
            //   constant -> 1 dentro, 0 fuori (bordo netto)
            //   sharp    -> quadratico (punta stretta)
            // Funzione PURA: testabile in Node.
            function brushFalloff(d01, mode) {
                let t = Number(d01);
                if (!isFinite(t) || t <= 0) t = 0;
                if (t >= 1) return mode === 'constant' ? (t > 1 ? 0 : 0) : 0;
                if (mode === 'constant') return 1;
                const u = 1 - t;
                if (mode === 'sharp') return u * u;
                return u * u * (3 - 2 * u);          // smoothstep
            }

            // Voxel entro `radius` (distanza euclidea, in voxel) dal voxel `center`, ognuno
            // con il proprio fattore di pennello 0..1. Restituisce [{i, f}]: il chiamante
            // moltiplica f per la forza. Con radius 0 il pennello e' un voxel a f=1.
            function voxelsInBrushWeighted(centerIndex, radius, falloff) {
                const voxels = currentModelData.voxels || [];
                const c = voxels[centerIndex];
                if (!c || !rigVoxelIndex) return [];
                if (radius <= 0) return [{ i: centerIndex, f: 1 }];
                const out = [];
                const r = Math.ceil(radius), r2 = radius * radius;
                for (let dx = -r; dx <= r; dx++) {
                    for (let dy = -r; dy <= r; dy++) {
                        for (let dz = -r; dz <= r; dz++) {
                            const d2 = dx * dx + dy * dy + dz * dz;
                            if (d2 > r2) continue;
                            const k = rigVoxelIndex.get((c.x + dx) + ',' + (c.y + dy) + ',' + (c.z + dz));
                            if (k === undefined) continue;
                            const f = brushFalloff(Math.sqrt(d2) / radius, falloff);
                            if (f <= 0 && d2 > 0) continue;
                            out.push({ i: k, f: d2 === 0 ? 1 : f });
                        }
                    }
                }
                return out;
            }

            // Compatibilita': la sola lista di indici (usata dal riempimento e dai test).
            function voxelsInBrush(centerIndex, radius) {
                return voxelsInBrushWeighted(centerIndex, radius, 'constant').map(e => e.i);
            }

            // Riempimento: dal voxel cliccato si espande sui vicini 6-connessi che hanno lo
            // STESSO osso attuale. In pratica seleziona l'intero pezzo mal assegnato (il
            // braccio che era finito sul busto) in un clic, invece di ripassarlo a pennello.
            function voxelsInFlood(centerIndex) {
                const voxels = currentModelData.voxels || [];
                const target = boneAssignments[centerIndex];
                const seen = new Set([centerIndex]);
                const stack = [centerIndex];
                const out = [];
                const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
                while (stack.length && out.length < WP_MAX_FILL) {
                    const i = stack.pop();
                    out.push(i);
                    const v = voxels[i];
                    for (let n = 0; n < 6; n++) {
                        const k = rigVoxelIndex.get((v.x + N[n][0]) + ',' + (v.y + N[n][1]) + ',' + (v.z + N[n][2]));
                        if (k === undefined || seen.has(k)) continue;
                        if (boneAssignments[k] !== target) continue;
                        seen.add(k); stack.push(k);
                    }
                }
                return out;
            }

            // Nuovo peso dell'osso bersaglio dato quello attuale, la modalita' del pennello e
            // l'intensita' effettiva (forza * falloff). Funzione PURA: e' la regola di Blender.
            //   mix      -> tira il peso verso il valore obiettivo (di solito 1)
            //   add      -> aumenta
            //   subtract -> diminuisce
            // `blur` non passa da qui: media i vicini, serve il contesto spaziale.
            function blendedWeight(current, mode, amount, target) {
                let w = Number(current); if (!isFinite(w)) w = 0;
                let a = Number(amount); if (!isFinite(a) || a <= 0) return clamp01(w);
                if (a > 1) a = 1;
                const tgt = (target === undefined) ? 1 : clamp01(target);
                if (mode === 'add') return clamp01(w + a);
                if (mode === 'subtract') return clamp01(w - a);
                return clamp01(w + (tgt - w) * a);          // mix
            }

            function clamp01(x) {
                const v = Number(x);
                if (!isFinite(v)) return 0;
                return v < 0 ? 0 : v > 1 ? 1 : v;
            }

            // Rimpiazza il peso dell'osso `boneName` in una voce, ridistribuendo il resto
            // sugli ALTRI ossa in proporzione a quanto pesavano prima (e' cosi' che Blender
            // mantiene la somma a 1 senza far collassare le altre influenze).
            // Se il voxel non aveva altre influenze e il nuovo peso e' < 1, il residuo va
            // all'osso automatico piu' plausibile passato in `fallbackName`.
            function withBoneWeight(entry, boneName, newW, fallbackName) {
                const cur = normalizeWeightEntry(entry) || {};
                const w = clamp01(newW);
                const others = {};
                let othersSum = 0;
                Object.keys(cur).forEach(k => {
                    if (k === boneName) return;
                    others[k] = cur[k]; othersSum += cur[k];
                });
                const out = {};
                if (w >= 1 - WEIGHT_EPS) { out[boneName] = 1; return out; }
                if (w > WEIGHT_EPS) out[boneName] = w;
                const rest = 1 - w;
                if (othersSum > WEIGHT_EPS) {
                    Object.keys(others).forEach(k => { out[k] = others[k] / othersSum * rest; });
                } else if (fallbackName && fallbackName !== boneName) {
                    out[fallbackName] = rest;
                } else if (!Object.keys(out).length) {
                    return null;                            // nulla da scrivere
                } else {
                    return normalizeWeightEntry(out);       // rinormalizza il solo bersaglio
                }
                return normalizeWeightEntry(out);
            }

            // Osso automatico piu' plausibile per un voxel (ignorando le sovrascritture):
            // serve come destinatario del peso che il pennello toglie all'osso bersaglio.
            function autoBoneFor(i, ctx) {
                const voxels = currentModelData.voxels || [];
                const v = voxels[i];
                if (!v) return -1;
                let best = ctx.cand[0], bestD = Infinity;
                for (let c = 0; c < ctx.cand.length; c++) {
                    const d = boneCost(v, rig.bones[ctx.cand[c]], ctx.cx, ctx.hipsY);
                    if (d < bestD) { bestD = d; best = ctx.cand[c]; }
                }
                return best === undefined ? -1 : best;
            }

            function autoBindContext() {
                const voxels = currentModelData.voxels || [];
                const b = voxelBounds(voxels);
                const cand = [];
                for (let j = 0; j < rig.bones.length; j++) if (!rig.bones[j].helper) cand.push(j);
                return { cx: b.cx, hipsY: b.minY + 0.44 * (b.h || 1), cand };
            }

            // --- Anteprima del pennello (come lo strumento Disegna) -------------------
            // Una sfera wireframe centrata sul voxel sotto il cursore, del RAGGIO reale del
            // pennello, piu' un cubetto pieno sul voxel centrale. Il colore e' quello che i
            // voxel assumeranno secondo la rampa Blender: rosso quando si dipinge verso 1,
            // blu quando si sottrae, ciano per la sfumatura. Cosi' si vede DOVE e QUANTO il
            // pennello influira' prima di premere.
            let brushPreviewGroup = null;
            let brushPreviewSphere = null;
            let brushPreviewCore = null;
            let brushPreviewVoxel = -1;

            function ensureBrushPreview() {
                if (brushPreviewGroup) return;
                brushPreviewGroup = new THREE.Group();
                brushPreviewGroup.renderOrder = 998;
                brushPreviewSphere = new THREE.Mesh(
                    new THREE.SphereGeometry(1, 20, 14),
                    new THREE.MeshBasicMaterial({
                        color: 0xff3b30, wireframe: true, transparent: true,
                        opacity: 0.55, depthTest: false
                    })
                );
                brushPreviewSphere.renderOrder = 998;
                brushPreviewCore = new THREE.Mesh(
                    new THREE.BoxGeometry(1.06, 1.06, 1.06),
                    new THREE.MeshBasicMaterial({
                        color: 0xff3b30, transparent: true, opacity: 0.35, depthTest: false
                    })
                );
                brushPreviewCore.renderOrder = 998;
                brushPreviewGroup.add(brushPreviewSphere);
                brushPreviewGroup.add(brushPreviewCore);
                brushPreviewGroup.visible = false;
                scene.add(brushPreviewGroup);
            }

            // Colore dell'anteprima secondo la modalita': e' il colore che la rampa dei pesi
            // assumera' dopo la pennellata, cosi' l'anteprima e la mesh parlano la stessa lingua.
            function brushPreviewColor() {
                if (wpMode === 'erase') return 0x9ca3af;                 // grigio: torna all'automatico
                if (wpMode === 'blur') return 0x22d3ee;                  // ciano
                if (wpMode === 'subtract') {
                    const c = weightColor(0); return rgbToHex(c);        // blu (peso -> 0)
                }
                const c = weightColor(clamp01(wpStrength));              // rampa alla forza scelta
                return rgbToHex(c);
            }

            function rgbToHex(c) {
                const q = v => Math.max(0, Math.min(255, Math.round(v * 255)));
                return (q(c.r) << 16) | (q(c.g) << 8) | q(c.b);
            }

            // Posiziona l'anteprima sul voxel `i` (o la nasconde con i < 0).
            function setBrushPreviewAt(i) {
                if (!weightPaintActive || !rigPreviewActive) { hideBrushPreview(); return; }
                const voxels = currentModelData.voxels || [];
                const v = voxels[i];
                if (i < 0 || !v) { hideBrushPreview(); return; }
                ensureBrushPreview();
                brushPreviewVoxel = i;
                const r = Number(wpRadius ? wpRadius.value : weightPaintRadius);
                const col = brushPreviewColor();
                brushPreviewGroup.position.set(v.x, v.y, v.z);
                // In 'fill' il raggio non conta (si propaga sull'intero pezzo): si mostra il
                // solo cubetto, altrimenti la sfera mentirebbe sull'area toccata.
                const showSphere = wpMode !== 'fill' && r > 0;
                brushPreviewSphere.visible = showSphere;
                if (showSphere) brushPreviewSphere.scale.setScalar(r + 0.5);
                brushPreviewSphere.material.color.setHex(col);
                brushPreviewCore.material.color.setHex(col);
                brushPreviewGroup.visible = true;
                updateWeightReadout(i);
                if (typeof requestRender === 'function') requestRender();
            }

            function hideBrushPreview() {
                brushPreviewVoxel = -1;
                updateWeightReadout(-1);
                if (!brushPreviewGroup || !brushPreviewGroup.visible) return;
                brushPreviewGroup.visible = false;
                if (typeof requestRender === 'function') requestRender();
            }

            // Chiamata da updateRigVisibility(): fuori dalla pittura l'anteprima sparisce.
            function updateBrushPreview() {
                if (!weightPaintActive || !rigPreviewActive) hideBrushPreview();
            }

            // Applica una pennellata di PESI. `list` e' [{i, f}] (f = falloff 0..1) oppure una
            // lista di soli indici (che vale f=1: usata dal riempimento e dai test).
            //   mode 'erase' -> butta la sovrascrittura e torna all'automatico
            //   mode 'blur'  -> media i pesi del voxel con quelli dei 6 vicini
            //   altrimenti   -> mix/add/subtract sull'osso selezionato
            function paintVoxels(list, mode) {
                if (!rig || !list || !list.length) return 0;
                // Compat: il vecchio secondo argomento era il booleano `erase`.
                if (mode === true) mode = 'erase'; else if (mode === false || mode === undefined) mode = 'mix';
                const entries = (typeof list[0] === 'object') ? list : list.map(i => ({ i, f: 1 }));
                const voxels = currentModelData.voxels || [];
                let changed = 0;

                if (mode === 'erase') {
                    if (!rig.weights) return 0;
                    const ctx = autoBindContext();
                    entries.forEach(e => {
                        const v = voxels[e.i];
                        if (!v) return;
                        const key = v.x + ',' + v.y + ',' + v.z;
                        if (rig.weights[key] === undefined) return;
                        delete rig.weights[key];
                        const auto = autoBoneFor(e.i, ctx);
                        if (auto >= 0 && setVoxelBone(e.i, auto)) changed++;
                    });
                    if (!Object.keys(rig.weights).length) rig.weights = null;
                } else if (mode === 'blur') {
                    if (!rig.weights) rig.weights = {};
                    const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
                    // Si legge dallo stato PRIMA della sfumatura (come un laplaciano), cosi'
                    // il risultato non dipende dall'ordine in cui si visitano i voxel.
                    const snap = entries.map(e => {
                        const acc = new Map();
                        let neigh = 0;
                        const v = voxels[e.i];
                        if (!v) return null;
                        for (let n = 0; n < 6; n++) {
                            const k = rigVoxelIndex.get((v.x + N[n][0]) + ',' + (v.y + N[n][1]) + ',' + (v.z + N[n][2]));
                            if (k === undefined) continue;
                            neigh++;
                            const en = voxelWeightEntry(k, rig.bones) || {};
                            Object.keys(en).forEach(nm => acc.set(nm, (acc.get(nm) || 0) + en[nm]));
                        }
                        return { e, acc, neigh, own: voxelWeightEntry(e.i, rig.bones) || {} };
                    });
                    snap.forEach(s => {
                        if (!s || !s.neigh) return;
                        const amount = clamp01(wpStrength * s.e.f);
                        if (amount <= 0) return;
                        const mix = {};
                        Object.keys(s.own).forEach(nm => { mix[nm] = s.own[nm] * (1 - amount); });
                        s.acc.forEach((w, nm) => { mix[nm] = (mix[nm] || 0) + (w / s.neigh) * amount; });
                        const norm = normalizeWeightEntry(mix);
                        if (!norm) return;
                        const v = voxels[s.e.i];
                        rig.weights[v.x + ',' + v.y + ',' + v.z] = norm;
                        if (setVoxelWeights(s.e.i, norm)) changed++;
                    });
                    if (!Object.keys(rig.weights).length) rig.weights = null;
                } else {
                    if (selectedBoneIndex < 0 || !rig.bones[selectedBoneIndex]) return 0;
                    if (rig.bones[selectedBoneIndex].helper) return 0;
                    const name = rig.bones[selectedBoneIndex].name;
                    const ctx = autoBindContext();
                    if (!rig.weights) rig.weights = {};
                    entries.forEach(e => {
                        const v = voxels[e.i];
                        if (!v) return;
                        const amount = clamp01(wpStrength * e.f);
                        if (amount <= 0) return;
                        const cur = voxelWeightEntry(e.i, rig.bones) || {};
                        const nw = blendedWeight(cur[name] || 0, mode, amount, 1);
                        const auto = autoBoneFor(e.i, ctx);
                        const fb = (auto >= 0 && rig.bones[auto]) ? rig.bones[auto].name : null;
                        const next = withBoneWeight(cur, name, nw, fb);
                        if (!next) return;
                        rig.weights[v.x + ',' + v.y + ',' + v.z] = next;
                        if (setVoxelWeights(e.i, next)) changed++;
                    });
                    if (!Object.keys(rig.weights).length) rig.weights = null;
                }

                if (changed) {
                    updateWeightPaintUI();
                    if (typeof requestRender === 'function') requestRender();
                }
                return changed;
            }

            function paintAt(clientX, clientY) {
                const i = pickPaintVoxel(clientX, clientY);
                if (i < 0) return 0;
                if (wpMode === 'fill') return paintVoxels(voxelsInFlood(i), 'mix');
                const r = Number(wpRadius ? wpRadius.value : weightPaintRadius);
                // In 'fill' il pennello e' piatto; negli altri modi il falloff conta.
                const list = voxelsInBrushWeighted(i, r, wpFalloff);
                return paintVoxels(list, wpMode);
            }

            renderer.domElement.addEventListener('pointerdown', e => {
                if (!weightPaintActive || e.button !== 0) return;
                // Il tasto sinistro non muove la camera (mouseButtons.LEFT = null), quindi si
                // puo' trascinare per dipingere senza combattere con OrbitControls.
                pushHistory();
                weightPaintStroking = true;
                weightPaintDirty = paintAt(e.clientX, e.clientY) > 0;
            });
            renderer.domElement.addEventListener('pointermove', e => {
                if (!weightPaintActive) return;
                if (weightPaintStroking) {
                    if (wpMode === 'fill') return;         // il riempimento e' un colpo solo
                    if (paintAt(e.clientX, e.clientY) > 0) weightPaintDirty = true;
                    setBrushPreviewAt(pickPaintVoxel(e.clientX, e.clientY));
                    return;
                }
                // Fuori dalla pennellata: solo anteprima, come il ghost verde del Disegna.
                const i = pickPaintVoxel(e.clientX, e.clientY);
                if (i !== brushPreviewVoxel) setBrushPreviewAt(i);
            }, { passive: true });
            renderer.domElement.addEventListener('pointerleave', () => hideBrushPreview());
            window.addEventListener('pointerup', () => {
                if (!weightPaintStroking) return;
                weightPaintStroking = false;
                // Nessuna pennellata efficace: la snapshot spinta al pointerdown sarebbe un
                // Ctrl+Z che non fa nulla. Si scarta.
                if (!weightPaintDirty && undoStack.length) { undoStack.pop(); updateHistoryButtons(); }
                weightPaintDirty = false;
            });

            if (weightPaintToggle) weightPaintToggle.addEventListener('click', () => {
                if (!rig || !rig.bones.length) { alert(t('rig.needAutoRig')); return; }
                setWeightPaint(!weightPaintActive);
            });
            // Le modalita' del pennello stanno su DUE barre segmentate (mix/add/sub e
            // blur/fill/erase) perche' sei bottoni su una riga non ci stanno nella sidebar.
            // Logicamente sono UN gruppo: cliccarne uno spegne tutti gli altri, anche
            // quelli dell'altra barra.
            const wpModeControls = [wpModeControl, document.getElementById('wpMode2')].filter(Boolean);
            wpModeControls.forEach(ctl => ctl.querySelectorAll('.seg-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    wpMode = btn.dataset.wpmode;
                    wpModeControls.forEach(c => c.querySelectorAll('.seg-btn')
                        .forEach(b => b.classList.toggle('active', b === btn)));
                    if (brushPreviewVoxel >= 0) setBrushPreviewAt(brushPreviewVoxel);
                    updateWeightPaintUI();
                });
            }));
            if (wpRadius) wpRadius.addEventListener('input', () => {
                weightPaintRadius = Number(wpRadius.value);
                if (wpRadiusVal) {
                    wpRadiusVal.textContent = weightPaintRadius === 0
                        ? t('rig.wp.radiusOne')
                        : t('rig.wp.radiusN', { n: weightPaintRadius });
                }
                if (brushPreviewVoxel >= 0) setBrushPreviewAt(brushPreviewVoxel);
            });
            if (wpStrengthInput) wpStrengthInput.addEventListener('input', () => {
                wpStrength = clamp01(Number(wpStrengthInput.value) / 100);
                if (wpStrengthVal) wpStrengthVal.textContent = Math.round(wpStrength * 100) + '%';
                if (brushPreviewVoxel >= 0) setBrushPreviewAt(brushPreviewVoxel);
            });
            if (wpFalloffControl) wpFalloffControl.querySelectorAll('.seg-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    wpFalloff = btn.dataset.falloff;
                    wpFalloffControl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                });
            });
            if (bindModeControl) bindModeControl.querySelectorAll('.seg-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (!rig) return;
                    const mode = btn.dataset.bind;
                    if (rig.binding === mode) return;
                    pushHistory();
                    rig.binding = mode;
                    bindModeControl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                    rebuildRigKeepingPaintState();
                });
            });
            if (bindHardnessInput) bindHardnessInput.addEventListener('input', () => {
                bindHardness = Number(bindHardnessInput.value);
                if (bindHardnessVal) bindHardnessVal.textContent = String(bindHardness);
            });
            if (bindHardnessInput) bindHardnessInput.addEventListener('change', () => {
                if (!rig || rig.binding === 'rigid') return;
                pushHistory();
                rebuildRigKeepingPaintState();
            });

            // applyRig() passa da clearRigPreview(), che esce dalla pittura e rimette la posa.
            // Qui si esce e si rientra a mano per non perdere ne' la posa ne' la modalita'
            // in cui stava lavorando l'utente.
            function rebuildRigKeepingPaintState() {
                const wasPainting = weightPaintActive;
                if (wasPainting) setWeightPaint(false);
                const sel = selectedBoneIndex;
                applyRig();
                if (sel >= 0) selectBone(sel);
                if (wasPainting) setWeightPaint(true);
                updateWeightPaintUI();
            }

            if (wpResetBtn) wpResetBtn.addEventListener('click', () => {
                if (!rig || !weightOverrideCount()) return;
                pushHistory();
                rig.weights = null;
                rebuildRigKeepingPaintState();
            });

            // Restore a rig loaded from a saved JSON file, then rebuild the preview.
            function restoreRig(saved) {
                rig = normalizeRig(saved);
                if (!rig) return;
                rigType = rig.type;
                rigTypeControl.querySelectorAll('.seg-btn').forEach(b =>
                    b.classList.toggle('active', b.dataset.rig === rigType));
                selectedBoneIndex = -1;
                stashRigToActiveObject();
                applyRig();
                if (rig.bones.length) selectBone(firstSelectableBone());
            }

            // ===== IL RIG APPARTIENE ALL'OGGETTO =====================================
            // Prima esisteva UN solo rig globale: cambiare oggetto (o anche solo un
            // buildModel, che faceva `rig = null`) cancellava scheletro, posa e pesi
            // dipinti, e in una scena con corpo + armatura solo uno dei due poteva
            // essere riggato. Ora il rig vive su `obj.rig` e la variabile `rig` e' la
            // vista LIVE del rig dell'oggetto ATTIVO, esattamente come currentModelData
            // lo e' per i suoi voxel.

            // Normalizza un rig letto da file/snapshot: campi mancanti, tipi sbagliati.
            function normalizeRig(saved) {
                if (!saved || !Array.isArray(saved.bones) || !saved.bones.length) return null;
                return {
                    type: saved.type || 'humanoid',
                    binding: saved.binding || 'rigid',
                    bones: saved.bones,
                    pose: saved.pose || {},
                    // Sovrascritture del weight paint, mappa "x,y,z" -> nome osso.
                    weights: (saved.weights && typeof saved.weights === 'object') ? saved.weights : null,
                    customAnims: Array.isArray(saved.customAnims) ? saved.customAnims : []
                };
            }

            // Forma serializzabile: e' cio' che finisce nel .json/.voxelai e nello snapshot
            // di undo. `null` se non c'e' nulla da salvare.
            function serializeRig(r) {
                if (!r || !r.bones || !r.bones.length) return null;
                const out = {
                    type: r.type, binding: r.binding, bones: r.bones,
                    pose: r.pose || {}, customAnims: r.customAnims || []
                };
                if (r.weights && Object.keys(r.weights).length) out.weights = r.weights;
                return out;
            }

            // Parcheggia il rig corrente sull'oggetto attivo. Va chiamata PRIMA di
            // cambiare oggetto attivo, altrimenti il rig finirebbe su quello nuovo.
            function stashRigToActiveObject() {
                const o = (typeof getActiveObject === 'function') ? getActiveObject() : null;
                if (!o) return;
                if (rig && rig.bones && rig.bones.length) o.rig = rig;
                else delete o.rig;
            }

            // Rende `rig` la vista del rig dell'oggetto attivo (o null se non ne ha).
            function adoptRigFromActiveObject() {
                const o = (typeof getActiveObject === 'function') ? getActiveObject() : null;
                rig = (o && o.rig && o.rig.bones && o.rig.bones.length) ? o.rig : null;
                if (rig) {
                    rigType = rig.type || rigType;
                    if (rigTypeControl) rigTypeControl.querySelectorAll('.seg-btn').forEach(b =>
                        b.classList.toggle('active', b.dataset.rig === rigType));
                }
            }

            // Riporta in anteprima il rig salvato sull'oggetto attivo (se c'e').
            function restoreRigForActiveObject() {
                const o = (typeof getActiveObject === 'function') ? getActiveObject() : null;
                if (o && o.rig) { restoreRig(o.rig); return true; }
                return false;
            }

            // Stato della tab Rig quando l'anteprima non e' attiva ma i dati esistono:
            // l'utente deve sapere che il suo scheletro NON e' andato perso.
            function updateRigUI() {
                const has = !!(rig && rig.bones && rig.bones.length);
                if (rigDetails) rigDetails.style.display = (has && rigPreviewActive) ? 'block' : 'none';
                if (showRigBtn) showRigBtn.style.display = (has && !rigPreviewActive) ? 'block' : 'none';
                if (rigHint && !rigPreviewActive) {
                    rigHint.textContent = has
                        ? `Rig salvato su questo oggetto: ${rig.bones.filter(b => !b.helper).length} ossa, posa e pesi inclusi. `
                          + 'Viene esportato in JSON e GLB. Premi "Mostra rig" per rientrare in anteprima, '
                          + 'oppure Auto-Rig per rigenerarlo da zero (perdi posa e correzioni dei pesi).'
                        : 'Nessun rig. Premi Auto-Rig per generare uno scheletro con pesi rigidi (ogni voxel segue un solo osso, cosi\' i cubi non si deformano).';
                }
                updateWeightPaintUI();
            }


            // Primo osso selezionabile (gli helper *Tip non lo sono).
            function firstSelectableBone() {
                if (!rig || !rig.bones) return -1;
                for (let i = 0; i < rig.bones.length; i++) if (!rig.bones[i].helper) return i;
                return 0;
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
                updateJointHandles();
                updateBrushPreview();
                if (skinnedMesh) {
                    const src = activePreviewColors();
                    if (src) {
                        const attr = skinnedMesh.geometry.getAttribute('color');
                        attr.copyArray(src);
                        attr.needsUpdate = true;
                    }
                }
                // Unico gate della timeline: questa funzione e' attraversata sia da
                // applyRig() sia da switchTab(), quindi il dock in basso compare/spar-
                // isce esattamente quando si entra/esce dalla sezione rigging.
                if (typeof timelineSync === 'function') timelineSync();
            }

            function clearRigPreview() {
                // Se si stava dipingendo, la posa era stata azzerata di proposito: va rimessa
                // prima di smontare tutto, altrimenti chiudere il rig la perderebbe.
                if (poseBeforePaint && rig) { rig.pose = poseBeforePaint; }
                poseBeforePaint = null;
                if (typeof transformControls !== 'undefined') { transformControls.detach(); transformControls.visible = false; }
                if (skinnedMesh) { rigGroup.remove(skinnedMesh); skinnedMesh.geometry.dispose(); skinnedMesh = null; }
                if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper = null; }
                if (boneMarker) { scene.remove(boneMarker); boneMarker = null; }
                clearJointHandles();
                if (mixer) { mixer.stopAllAction(); mixer = null; }
                skeleton = null; rigClips = []; currentAction = null;
                boneAssignments = null;
                // Indici della mesh appena distrutta: lasciarli vivi farebbe dipingere su
                // vertici che non esistono piu' (skinIndex di una geometry disposed).
                previewVertexRanges = null;
                rigVoxelIndex = null;
                previewBoneColors = null;
                hoveredBoneIndex = -1;
                weightPaintActive = false;
                weightPaintStroking = false;
                weightPaintDirty = false;
                poseBeforePaint = null;
                rigPreviewActive = false;
                if (typeof rigDisableIk === 'function') rigDisableIk();   // niente IK senza anteprima
                modelPivot.visible = true;
                rigGroup.visible = false;
                updateWeightPaintUI();
                // Questo percorso di smontaggio NON passa da updateRigVisibility()
                // (setta visible a mano), quindi il gate della timeline va richiamato
                // qui o il dock resterebbe aperto su un rig che non esiste piu'.
                if (typeof timelineSync === 'function') timelineSync();
            }

            // --- Bone list UI -------------------------------------------------------
            // Mostra solo le ossa selezionabili: le *Tip (helper) esistono per l'export e
            // in lista erano cinque righe che non facevano nulla se cliccate.
            function renderBoneList() {
                boneListEl.innerHTML = '';
                const selectable = rig.bones.filter(bd => !bd.helper).length;
                boneCountEl.textContent = `(${selectable})`;
                const depthOf = (i) => {
                    let d = 0, p = rig.bones[i].parent;
                    while (p >= 0) { d++; p = rig.bones[p].parent; }
                    return d;
                };
                rig.bones.forEach((bd, i) => {
                    if (bd.helper) return;
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
                    // Doppio clic = rinomina (32-rig-tools.js). Il nome dell'osso e' la sua
                    // identita': la rinomina migra posa, pesi e track delle animazioni.
                    row.title = t('rig.dblClickRename');
                    row.addEventListener('dblclick', () => {
                        if (typeof rigRenameBonePrompt === 'function') rigRenameBonePrompt(i);
                    });
                    boneListEl.appendChild(row);
                });
            }

            function selectBone(i) {
                if (i < 0 || !rig || !rig.bones[i]) return;
                if (rig.bones[i].helper) return;   // le *Tip non sono selezionabili
                selectedBoneIndex = i;
                renderBoneList();
                // La rampa dei pesi e' SEMPRE relativa all'osso selezionato (come Blender):
                // cambiando osso va ricalcolata, altrimenti si guarderebbe il peso di un altro.
                refreshWeightColors();
                if (rigPreviewActive) updateRigVisibility();
                // Load this bone's current pose into the sliders.
                const bd = rig.bones[i];
                const pose = (rig.pose && rig.pose[bd.name]) || [0, 0, 0];
                poseRot.x.value = Math.round(pose[0] * 180 / Math.PI);
                poseRot.y.value = Math.round(pose[1] * 180 / Math.PI);
                poseRot.z.value = Math.round(pose[2] * 180 / Math.PI);
                updateRotLabels();
                updateBoneMarker();
                updateJointHandles();
                updateWeightPaintUI();
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

                // Detect foot facing direction from the foot bone orientation in rest space.
                const ftBone = rig.bones.find(b => b.name === 'foot_R' || b.name === 'foot_L');
                const isFacingNegZ = ftBone ? (ftBone.tail[2] < ftBone.head[2]) : false;
                const legSign = isFacingNegZ ? -1 : 1;
                const kneeSign = isFacingNegZ ? 1 : -1;

                // Idle: gentle chest/arm breathing.
                rigClips.push(clip('idle', 2.4, [
                    track('chest', [{ t: 0, e: [0, 0, 0] }, { t: 1.2, e: [rad(3), 0, 0] }, { t: 2.4, e: [0, 0, 0] }]),
                    track('upperArm_L', [{ t: 0, e: [0, 0, 0] }, { t: 1.2, e: [0, 0, rad(4)] }, { t: 2.4, e: [0, 0, 0] }]),
                    track('upperArm_R', [{ t: 0, e: [0, 0, 0] }, { t: 1.2, e: [0, 0, rad(-4)] }, { t: 2.4, e: [0, 0, 0] }]),
                    bob([{ t: 0, dy: 0 }, { t: 1.2, dy: 0.12 }, { t: 2.4, dy: 0 }])
                ]));

                // Walk: opposing legs/arms with knee bend, plus subtle torso counter-sway
                // and a two-per-cycle vertical bob so it reads as real weight shifting.
                // In Three.js (+Y up, +Z forward), negative X rotation bends knees backward.
                const wLeg = rad(28), wKnee = rad(34), wArm = rad(26), wElb = rad(20);
                rigClips.push(clip('walk', 1, [
                    track('upperLeg_L', [{ t: 0, e: [wLeg * legSign, 0, 0] }, { t: 0.5, e: [-wLeg * legSign, 0, 0] }, { t: 1, e: [wLeg * legSign, 0, 0] }]),
                    track('lowerLeg_L', [{ t: 0, e: [0, 0, 0] }, { t: 0.25, e: [wKnee * kneeSign, 0, 0] }, { t: 0.5, e: [wKnee * 0.3 * kneeSign, 0, 0] }, { t: 0.75, e: [0, 0, 0] }, { t: 1, e: [0, 0, 0] }]),
                    track('upperLeg_R', [{ t: 0, e: [-wLeg * legSign, 0, 0] }, { t: 0.5, e: [wLeg * legSign, 0, 0] }, { t: 1, e: [-wLeg * legSign, 0, 0] }]),
                    track('lowerLeg_R', [{ t: 0, e: [0, 0, 0] }, { t: 0.25, e: [0, 0, 0] }, { t: 0.5, e: [0, 0, 0] }, { t: 0.75, e: [wKnee * kneeSign, 0, 0] }, { t: 1, e: [0, 0, 0] }]),
                    track('upperArm_L', [{ t: 0, e: [-wArm * legSign, 0, 0] }, { t: 0.5, e: [wArm * legSign, 0, 0] }, { t: 1, e: [-wArm * legSign, 0, 0] }]),
                    track('forearm_L', [{ t: 0, e: [wElb, 0, 0] }, { t: 0.5, e: [wElb * 0.4, 0, 0] }, { t: 1, e: [wElb, 0, 0] }]),
                    track('upperArm_R', [{ t: 0, e: [wArm * legSign, 0, 0] }, { t: 0.5, e: [-wArm * legSign, 0, 0] }, { t: 1, e: [wArm * legSign, 0, 0] }]),
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
                    track('upperLeg_L', [{ t: 0, e: [rLeg * legSign, 0, 0] }, { t: 0.33, e: [-rLeg * legSign, 0, 0] }, { t: 0.66, e: [rLeg * legSign, 0, 0] }]),
                    track('lowerLeg_L', [{ t: 0, e: [rKnee * 0.4 * kneeSign, 0, 0] }, { t: 0.16, e: [rKnee * kneeSign, 0, 0] }, { t: 0.33, e: [rKnee * 0.5 * kneeSign, 0, 0] }, { t: 0.66, e: [rKnee * 0.4 * kneeSign, 0, 0] }]),
                    track('upperLeg_R', [{ t: 0, e: [-rLeg * legSign, 0, 0] }, { t: 0.33, e: [rLeg * legSign, 0, 0] }, { t: 0.66, e: [-rLeg * legSign, 0, 0] }]),
                    track('lowerLeg_R', [{ t: 0, e: [rKnee * 0.5 * kneeSign, 0, 0] }, { t: 0.33, e: [rKnee * 0.4 * kneeSign, 0, 0] }, { t: 0.5, e: [rKnee * kneeSign, 0, 0] }, { t: 0.66, e: [rKnee * 0.5 * kneeSign, 0, 0] }]),
                    track('upperArm_L', [{ t: 0, e: [-rArm * legSign, 0, 0] }, { t: 0.33, e: [rArm * legSign, 0, 0] }, { t: 0.66, e: [-rArm * legSign, 0, 0] }]),
                    track('forearm_L', [{ t: 0, e: [rElb, 0, 0] }, { t: 0.33, e: [rElb * 0.6, 0, 0] }, { t: 0.66, e: [rElb, 0, 0] }]),
                    track('upperArm_R', [{ t: 0, e: [rArm * legSign, 0, 0] }, { t: 0.33, e: [-rArm * legSign, 0, 0] }, { t: 0.66, e: [rArm * legSign, 0, 0] }]),
                    track('forearm_R', [{ t: 0, e: [rElb * 0.6, 0, 0] }, { t: 0.33, e: [rElb, 0, 0] }, { t: 0.66, e: [rElb * 0.6, 0, 0] }]),
                    track('hips', [{ t: 0, e: [rad(-10), 0, 0] }]),
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

                // Clip AI personalizzate salvate nel rig (Animation Director): le
                // ricostruiamo qui cosi' sopravvivono a save/load e a ogni applyRig.
                (rig.customAnims || []).forEach(a => {
                    const c = buildClipFromAnimData(a);
                    if (c) { c.name = a.name; rigClips.push(c); }
                });
                syncAnimSelectOptions();
                renderCustomAnimList();
            }

            // Converte i dati di animazione dell'AI (o salvati) in un AnimationClip.
            // Formato: { name, duration, loop, tracks:[{ bone, keys:[{t, rot:[gx,gy,gz]?, pos:[dx,dy,dz]?}] }] }
            // rot = Euler in GRADI (XYZ), pos = offset in voxel dalla posizione di riposo.
            function buildClipFromAnimData(anim) {
                if (!skeleton || !anim || !Array.isArray(anim.tracks)) return null;
                const byName = {};
                rig.bones.forEach((bd, i) => byName[bd.name] = skeleton.bones[i]);
                const rad = d => (Number(d) || 0) * Math.PI / 180;
                const dur = Math.max(0.1, Number(anim.duration) || 1);
                const clampT = t => Math.min(dur, Math.max(0, Number(t) || 0));
                const tracks = [];
                anim.tracks.forEach(tr => {
                    const bone = byName[tr && tr.bone];
                    if (!bone || !tr || !Array.isArray(tr.keys) || !tr.keys.length) return;
                    const rotKeys = tr.keys.filter(k => k && Array.isArray(k.rot)).slice().sort((a, b) => clampT(a.t) - clampT(b.t));
                    const posKeys = tr.keys.filter(k => k && Array.isArray(k.pos)).slice().sort((a, b) => clampT(a.t) - clampT(b.t));
                    if (rotKeys.length) {
                        const times = [], values = [];
                        rotKeys.forEach(k => {
                            times.push(clampT(k.t));
                            const qq = new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(k.rot[0]), rad(k.rot[1]), rad(k.rot[2])));
                            values.push(qq.x, qq.y, qq.z, qq.w);
                        });
                        tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
                    }
                    if (posKeys.length) {
                        const rest = bone.position.clone();
                        const times = [], values = [];
                        posKeys.forEach(k => {
                            times.push(clampT(k.t));
                            values.push(rest.x + (Number(k.pos[0]) || 0), rest.y + (Number(k.pos[1]) || 0), rest.z + (Number(k.pos[2]) || 0));
                        });
                        tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, values));
                    }
                });
                if (!tracks.length) return null;
                return new THREE.AnimationClip(anim.name || 'ai_anim', dur, tracks);
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

            // --- AI Animation Director ---------------------------------------------
            // Animazioni create da un prompt: l'AI restituisce keyframe per le ossa
            // dello scheletro attuale. Vengono salvate in rig.customAnims (persistite
            // col progetto ed esportate nel GLB) e gestite dinamicamente dalla UI.
            const addAnimBtn = document.getElementById('addAnimBtn');
            const animForm = document.getElementById('animForm');
            const animNameInput = document.getElementById('animNameInput');
            const animPromptInput = document.getElementById('animPromptInput');
            const animGenerateBtn = document.getElementById('animGenerateBtn');
            const animCancelBtn = document.getElementById('animCancelBtn');
            const customAnimList = document.getElementById('customAnimList');
            const customAnimEmpty = document.getElementById('customAnimEmpty');

            function animApiUrl() { return (window.__API_BASE__ ? window.__API_BASE__ : '') + '/api/animate'; }
            const PRESET_ANIM_NAMES = ['none', 'idle', 'walk', 'run', 'jump', 'wave'];

            function uniqueAnimName(base) {
                base = (base || 'Animazione').trim() || 'Animazione';
                const taken = new Set(PRESET_ANIM_NAMES.map(n => n.toLowerCase()));
                (rig && rig.customAnims ? rig.customAnims : []).forEach(a => taken.add(String(a.name).toLowerCase()));
                if (!taken.has(base.toLowerCase())) return base;
                let i = 2;
                while (taken.has((base + ' ' + i).toLowerCase())) i++;
                return base + ' ' + i;
            }

            // Rimuove le option AI dal menu e le riallinea a rig.customAnims.
            function syncAnimSelectOptions() {
                animSelect.querySelectorAll('option.ai-anim-opt').forEach(o => o.remove());
                (rig && rig.customAnims ? rig.customAnims : []).forEach(a => {
                    const opt = document.createElement('option');
                    opt.value = a.name; opt.textContent = a.name; opt.className = 'ai-anim-opt';
                    animSelect.appendChild(opt);
                });
            }

            function renderCustomAnimList() {
                if (!customAnimList) return;
                const list = (rig && rig.customAnims) ? rig.customAnims : [];
                customAnimList.innerHTML = '';
                if (customAnimEmpty) customAnimEmpty.style.display = list.length ? 'none' : '';
                list.forEach(a => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:6px; background:var(--inset-bg); border:1px solid var(--glass-border);';
                    const label = document.createElement('span');
                    label.textContent = a.name;
                    label.style.cssText = 'flex:1; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                    const playBtn = document.createElement('button');
                    playBtn.className = 'btn btn-secondary';
                    playBtn.textContent = 'Play';
                    playBtn.style.cssText = 'padding:4px 10px; font-size:11px;';
                    playBtn.addEventListener('click', () => { animSelect.value = a.name; playClip(a.name); });
                    const delBtn = document.createElement('button');
                    delBtn.className = 'btn btn-secondary';
                    delBtn.textContent = 'X';
                    delBtn.title = 'Elimina animazione';
                    delBtn.style.cssText = 'padding:4px 9px; font-size:11px;';
                    delBtn.addEventListener('click', () => removeCustomAnim(a.name));
                    row.appendChild(label); row.appendChild(playBtn); row.appendChild(delBtn);
                    customAnimList.appendChild(row);
                });
            }

            function addCustomAnim(anim) {
                if (!rig) return null;
                if (!Array.isArray(rig.customAnims)) rig.customAnims = [];
                anim.name = uniqueAnimName(anim.name);
                rig.customAnims.push(anim);
                buildAnimationClips();            // ricostruisce rigClips + option + lista
                animSelect.value = anim.name;
                playClip(anim.name);
                return anim.name;
            }

            function removeCustomAnim(name) {
                if (!rig || !Array.isArray(rig.customAnims)) return;
                rig.customAnims = rig.customAnims.filter(a => a.name !== name);
                if (currentAction && animSelect.value === name) {
                    currentAction.stop(); currentAction = null;
                    animSelect.value = 'none';
                    applyPoseToBones();
                }
                buildAnimationClips();
            }

            if (addAnimBtn) addAnimBtn.addEventListener('click', () => {
                if (!rig || !rig.bones || !rig.bones.length) { alert(t('rig.needRigForObject')); return; }
                const show = animForm.style.display === 'none' || !animForm.style.display;
                animForm.style.display = show ? 'flex' : 'none';
                if (show) animPromptInput.focus();
            });
            if (animCancelBtn) animCancelBtn.addEventListener('click', () => {
                animForm.style.display = 'none';
                animNameInput.value = ''; animPromptInput.value = '';
            });

            // /api/animate risponde con `code` (causa leggibile a macchina), `error`
            // (frase italiana, utile solo come fallback) e tre array di diagnostica.
            // Qui la frase viene ricostruita nella lingua attiva: il testo del
            // backend si usa solo per i codici che non conosciamo.
            const ANIM_ERR_KEYS = {
                noUsableTracks: 'rig.animNoUsableTracks',
                badJson: 'rig.animBadJson'
            };

            function animErrorMessage(err) {
                const raw = String((err && err.message) || '') || t('rig.animErrGeneric');
                const key = (err && err.code) ? ANIM_ERR_KEYS[err.code] : null;
                const lines = [t('rig.animError', { error: key ? t(key) : raw })];
                // `detail` esiste solo per i codici noti (es. il messaggio del parser
                // JSON): senza traduzione possibile, ma va mostrato comunque.
                if (key && err.detail) lines.push(String(err.detail));
                const listLine = (dictKey, varName, arr, limit) => {
                    const list = (Array.isArray(arr) ? arr : [])
                        .filter(v => v !== null && v !== undefined && v !== '')
                        .map(String);
                    if (!list.length) return;
                    const vars = {};
                    vars[varName] = list.slice(0, limit).join(', ');
                    lines.push(t(dictKey, vars));
                };
                listLine('rig.animUnknownBones', 'bones', err && err.unknownBones, 12);
                listLine('rig.animAvailableBones', 'bones', err && err.availableBones, 20);
                listLine('rig.animWarnings', 'warnings', err && err.warnings, 5);
                return lines.join('\n');
            }

            if (animGenerateBtn) animGenerateBtn.addEventListener('click', () => {
                if (!rig || !skeleton) { alert(t('rig.skeletonNotReady')); return; }
                const desc = animPromptInput.value.trim();
                if (!desc) { alert(t('rig.describeAnim')); return; }
                const boneNames = rig.bones.map(b => b.name);
                const origHtml = animGenerateBtn.innerHTML;
                animGenerateBtn.disabled = true;
                animGenerateBtn.innerHTML = '<span class="spinner"></span> ' + t('rig.animGenerating');
                fetch(animApiUrl(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: desc, bones: boneNames, model: (typeof modelSelect !== 'undefined' && modelSelect ? modelSelect.value : undefined) })
                })
                    .then(res => res.ok ? res.json() : res.json().then(e => {
                        // /api/animate risponde con diagnostica ricca (ossa inventate
                        // dall'AI, ossa realmente disponibili, avvisi): la portiamo
                        // sull'Error cosi' il catch la puo' mostrare all'utente.
                        const ex = new Error(e.error || t('rig.animErrGeneric'));
                        ex.code           = e.code || '';
                        ex.detail         = e.detail || '';
                        ex.unknownBones   = Array.isArray(e.unknownBones) ? e.unknownBones : [];
                        ex.availableBones = Array.isArray(e.availableBones) ? e.availableBones : [];
                        ex.warnings       = Array.isArray(e.warnings) ? e.warnings : [];
                        throw ex;
                    }))
                    .then(anim => {
                        if (!anim || !Array.isArray(anim.tracks) || !anim.tracks.length) throw new Error(t('rig.aiNoTracks'));
                        if (animNameInput.value.trim()) anim.name = animNameInput.value.trim();
                        const test = buildClipFromAnimData(anim);
                        if (!test) throw new Error(t('rig.aiNoValidBones'));
                        const finalName = addCustomAnim(anim);
                        animForm.style.display = 'none';
                        animNameInput.value = ''; animPromptInput.value = '';
                        rigHint.textContent = t('rig.animCreated', { name: finalName });
                    })
                    .catch(err => alert(animErrorMessage(err)))
                    .finally(() => { animGenerateBtn.disabled = false; animGenerateBtn.innerHTML = origHtml; });
            });


            // --- Rig tab controls ---------------------------------------------------
            rigTypeControl.querySelectorAll('.seg-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    rigType = btn.dataset.rig;
                    rigTypeControl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                });
            });

            autoRigBtn.addEventListener('click', () => {
                const voxels = currentModelData.voxels || [];
                if (!voxels.length) { rigHint.textContent = t('rig.hintNoVoxels'); return; }
                pushHistory();
                rig = rigType === 'generic' ? buildGenericSkeleton(voxels) : buildHumanoidSkeleton(voxels);
                selectedBoneIndex = -1;
                stashRigToActiveObject();
                applyRig();
                if (rig.bones.length) selectBone(firstSelectableBone());
            });

            // "Mostra rig": ricostruisce l'anteprima dal rig gia' salvato sull'oggetto,
            // senza rigenerarlo (quindi posa e pesi dipinti restano).
            if (showRigBtn) showRigBtn.addEventListener('click', () => {
                if (!restoreRigForActiveObject()) updateRigUI();
            });

            function rotateSkeletonY(deg) {
                if (!rig || !rig.bones || !rig.bones.length) return;
                pushHistory();
                const rad = deg * Math.PI / 180;
                const voxels = currentModelData.voxels || [];
                const b = voxelBounds(voxels);
                const cx = b.cx, cz = b.cz;
                const cos = Math.cos(rad), sin = Math.sin(rad);

                rig.bones.forEach(bone => {
                    const hx = bone.head[0] - cx, hz = bone.head[2] - cz;
                    bone.head[0] = cx + (hx * cos - hz * sin);
                    bone.head[2] = cz + (hx * sin + hz * cos);

                    const tx = bone.tail[0] - cx, tz = bone.tail[2] - cz;
                    bone.tail[0] = cx + (tx * cos - tz * sin);
                    bone.tail[2] = cz + (tx * sin + tz * cos);
                });

                applyRig();
            }

            const rotateRig90Btn = document.getElementById('rotateRig90Btn');
            const rotateRig180Btn = document.getElementById('rotateRig180Btn');
            if (rotateRig90Btn) rotateRig90Btn.addEventListener('click', () => rotateSkeletonY(90));
            if (rotateRig180Btn) rotateRig180Btn.addEventListener('click', () => rotateSkeletonY(180));

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
            // Gizmo piu' compatto (0.9 -> 0.65): su un voxel model le maniglie a 0.9
            // coprivano mezzo arto e rubavano i click destinati ai pallini dei giunti.
            transformControls.setSize(0.65);
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
                // Con l'IK armata il click sinistro trascina l'arto: il gizmo si spegne per
                // non rubare il puntatore con le sue maniglie (vedi 32-rig-tools.js).
                const ikOn = typeof rigIkCapturesPointer === 'function' && rigIkCapturesPointer();
                // The mode-switch bar shows whenever the rig is active on the rig tab.
                gizmoBar.classList.toggle('visible', !!(gizmoEnabled && rigPreviewActive && skeleton && !weightPaintActive && !ikOn));
                // Durante il weight paint il gizmo va spento: le sue maniglie sono grandi e
                // intercetterebbero le pennellate.
                const active = gizmoEnabled && rigPreviewActive && skeleton && selectedBoneIndex >= 0 && !weightPaintActive && !ikOn;
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
                    // Il gizmo si muove in spazio-mondo e il rigGroup non ha rotazione,
                    // quindi il delta e' gia' nello spazio corretto delle ossa.
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



            // Selezione ossa nella viewport (solo nel tab Rig).
            //
            // Prima: distanza del raggio dal PUNTO MEDIO dell'osso, accettata sotto 2.5
            // unita' MONDO. Due difetti che rendevano la selezione un indovinello:
            //   1) il punto medio ignora dove hai davvero cliccato lungo l'osso, quindi
            //      cliccare su un ginocchio poteva selezionare il femore o la tibia a caso;
            //   2) una soglia in unita' mondo non tiene conto ne' dello zoom ne' della scala
            //      del modello: su un personaggio 128^3 sono briciole, con la camera lontana
            //      non prendi niente, da vicino prendi sempre lo stesso osso.
            //
            // Ora, in ordine: (1) raycast sui PALLINI dei giunti - bersagli visibili e di
            // dimensione costante a schermo, e' il percorso normale; (2) fallback sulla
            // distanza dal SEGMENTO dell'osso misurata in PIXEL, cosi' cliccare sul corpo
            // dell'osso funziona a ogni zoom.
            const PICK_BONE_PIXELS = 18;    // tolleranza del fallback, in pixel

            function projectToPixels(v3, rect, out) {
                const p = _pickV.copy(v3).project(camera);
                out.x = (p.x * 0.5 + 0.5) * rect.width;
                out.y = (-p.y * 0.5 + 0.5) * rect.height;
                out.behind = p.z > 1;
                return out;
            }

            // Distanza in pixel dal punto p al segmento a-b (tutti in coordinate schermo).
            function distToSegment2D(px, py, ax, ay, bx, by) {
                const abx = bx - ax, aby = by - ay;
                const len2 = abx * abx + aby * aby;
                let t = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
                t = Math.max(0, Math.min(1, t));
                const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
                return Math.sqrt(dx * dx + dy * dy);
            }

            const _pickV = new THREE.Vector3();
            const _pickHead = new THREE.Vector3();
            const _pickTail = new THREE.Vector3();
            const _pickA = { x: 0, y: 0, behind: false };
            const _pickB = { x: 0, y: 0, behind: false };

            function pickBone(clientX, clientY) {
                if (!skeleton || !rig) return -1;
                const rect = renderer.domElement.getBoundingClientRect();
                pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
                pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(pointer, camera);

                // 1) I pallini. depthTest e' off in fase di disegno ma il raycast li vede
                //    comunque tutti: prendiamo il piu' vicino alla camera fra quelli colpiti.
                if (jointHandleGroup && jointHandleGroup.visible && jointHandles.length) {
                    const hits = raycaster.intersectObjects(jointHandleGroup.children, false);
                    if (hits.length) {
                        const bi = hits[0].object.userData.boneIndex;
                        if (typeof bi === 'number') return bi;
                    }
                }

                // 2) Fallback: l'osso il cui segmento passa piu' vicino al cursore, in pixel.
                const mx = clientX - rect.left, my = clientY - rect.top;
                let best = -1, bestPx = Infinity;
                for (let i = 0; i < rig.bones.length; i++) {
                    const bd = rig.bones[i];
                    if (bd.helper) continue;          // le *Tip non sono selezionabili
                    const bone = skeleton.bones[i];
                    bone.updateWorldMatrix(true, false);
                    _pickHead.setFromMatrixPosition(bone.matrixWorld);
                    const q = new THREE.Quaternion(); bone.getWorldQuaternion(q);
                    _pickTail.set(bd.tail[0] - bd.head[0], bd.tail[1] - bd.head[1], bd.tail[2] - bd.head[2])
                        .applyQuaternion(q).add(_pickHead);
                    projectToPixels(_pickHead, rect, _pickA);
                    if (_pickA.behind) continue;
                    projectToPixels(_pickTail, rect, _pickB);
                    if (_pickB.behind) continue;
                    const d = distToSegment2D(mx, my, _pickA.x, _pickA.y, _pickB.x, _pickB.y);
                    if (d < bestPx) { bestPx = d; best = i; }
                }
                return bestPx <= PICK_BONE_PIXELS ? best : -1;
            }

            renderer.domElement.addEventListener('pointerdown', e => {
                if (!gizmoEnabled || e.button !== 0) return;
                // Con l'IK armata il click e' suo: seleziona l'osso e trascina la catena.
                if (typeof rigIkCapturesPointer === 'function' && rigIkCapturesPointer()) return;
                // If the pointer is over a gizmo handle (TC sets .axis on hover) or already
                // dragging, let TransformControls own this click.
                if (transformControls.dragging || transformControls.axis) return;
                if (weightPaintActive) return;   // in modalita' pittura il click dipinge
                const bi = pickBone(e.clientX, e.clientY);
                if (bi >= 0) { selectBone(bi); updateGizmo(); }
            });

            // Hover: evidenzia il pallino sotto il cursore e mostra il cursore "mano", cosi'
            // si capisce COSA si sta per selezionare prima di cliccare.
            renderer.domElement.addEventListener('pointermove', e => {
                if (!gizmoEnabled || !rigPreviewActive || weightPaintActive) {
                    if (hoveredBoneIndex !== -1) setHoveredBone(-1);
                    return;
                }
                if (transformControls.dragging || transformControls.axis) { setHoveredBone(-1); return; }
                setHoveredBone(pickBone(e.clientX, e.clientY));
            }, { passive: true });

            // --- CUBE_FACES: shared cube face table (used by GLB static export) -----