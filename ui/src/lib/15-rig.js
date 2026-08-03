            /* ===================== RIGGING ENGINE =====================
               Skinning a VOXEL model, tre modalita' (rig.binding):

                 'smooth' (DEFAULT) - skinning a 4 ossa come Blender dopo "Automatic
                    Weights": il corpo di ogni osso resta a peso ~1 (i cubi non si
                    sciolgono) e la miscela compare SOLO vicino alle articolazioni, dove
                    serve per non strappare la mesh. Il limite di 4 ossa non e' una scelta
                    di stile: in THREE r128 skinIndex/skinWeight sono vec4.
                 'parts' - le parti gia' definite sul modello (v.part) sono COMPONENTI, non
                    ammassi di cubetti: ogni parte usa solo le ossa che le appartengono,
                    quindi un braccio non puo' piu' ricevere peso da un osso della testa.
                    Peso 1 su un osso solo, cosi' il pezzo si muove tutto insieme e si piega
                    dove ha davvero un'articolazione. Senza parti sul modello si comporta
                    come 'rigid'.
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
            const bindPartsHint = document.getElementById('bindPartsHint');
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
            // Cursori di TRASLAZIONE della posa (canale Location dei keyframe). Il
            // gizmo in modalita' "Sposta" modifica il RIPOSO dello scheletro, non la
            // posa: senza questi cursori il canale Location non avrebbe alcun modo di
            // essere impostato a mano.
            const posePosSl = {
                x: document.getElementById('posePosX'),
                y: document.getElementById('posePosY'),
                z: document.getElementById('posePosZ')
            };
            const posValEls = {
                x: document.getElementById('posXVal'),
                y: document.getElementById('posYVal'),
                z: document.getElementById('posZVal')
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
                // Il confronto va fatto sul CENTRO DEL PIEDE, non sul cz di tutto il corpo:
                // capelli lunghi, zaini e visori spostano cz indietro e falsano il verso.
                const footZmid = (footZmin + footZmax) / 2;
                const distMin = Math.abs(footZmid - footZmin);
                const distMax = Math.abs(footZmax - footZmid);
                let facesNegZ = (distMin > distMax + 0.5);
                if (Math.abs(distMin - distMax) <= 0.5) {
                    // Piede simmetrico (scarponi a scatola): il piede non dice nulla, allora
                    // lo chiediamo alla TESTA. Il viso e' piatto e la nuca/i capelli sporgono,
                    // quindi la massa della testa sta dietro: se il baricentro in Z della
                    // testa e' oltre la sua meta', la faccia guarda verso Z BASSO.
                    // Misurato sul Tecnico_del_Video: testa z 25..38, mid 31.5, com 32.0.
                    let hzMin = Infinity, hzMax = -Infinity, hzSum = 0, hzN = 0;
                    const headBandLo = minY + 0.85 * H;
                    voxels.forEach(v => {
                        if (v.y < headBandLo) return;
                        if (v.z < hzMin) hzMin = v.z;
                        if (v.z > hzMax) hzMax = v.z;
                        hzSum += v.z; hzN++;
                    });
                    if (hzN) {
                        const hzMid = (hzMin + hzMax) / 2;
                        if (hzSum / hzN > hzMid + 0.15) facesNegZ = true;
                    }
                }
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
                // ATTENZIONE: in T-pose le braccia stanno DENTRO questa fascia verticale,
                // quindi il massimo/minimo X grezzo qui e' la PUNTA DEL DITO, non il
                // costato: lo shoulder finiva sul polso e upperArm/forearm/hand cadevano
                // FUORI dal modello (misurato sul Tecnico_del_Video: torsoMaxR=105 su un
                // modello che arriva a x=108). Le braccia sono righe strette e larghissime,
                // il torso righe larghe e continue: prendiamo quindi la larghezza MEDIANA
                // delle righe della fascia e scartiamo le righe che la sfondano (le
                // braccia), cosi' il bordo misurato e' davvero quello del busto.
                const torsoBandLo = minY + 0.55 * H, torsoBandHi = minY + 0.68 * H;
                const rowSpan = new Map();   // y -> [minX, maxX]
                voxels.forEach(v => {
                    if (v.y < torsoBandLo || v.y > torsoBandHi) return;
                    const r = rowSpan.get(v.y);
                    if (!r) rowSpan.set(v.y, [v.x, v.x]);
                    else { if (v.x < r[0]) r[0] = v.x; if (v.x > r[1]) r[1] = v.x; }
                });
                const spans = [...rowSpan.values()];
                const widths = spans.map(r => r[1] - r[0]).sort((a, b) => a - b);
                const medW = widths.length ? widths[Math.floor(widths.length / 2)] : 0;
                let torsoMaxR = cx, torsoMinL = cx;
                spans.forEach(r => {
                    // Riga "con le braccia": molto piu' larga della mediana → non e' torso.
                    if (medW > 0 && (r[1] - r[0]) > medW * 1.6) return;
                    if (r[1] > torsoMaxR) torsoMaxR = r[1];
                    if (r[0] < torsoMinL) torsoMinL = r[0];
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

                return { bones, pose: {}, posePos: {}, binding: defaultBindingFor(voxels), type: 'humanoid' };
            }

            // Modalita' di legatura predefinita per un rig appena creato.
            // Se il modello ha gia' delle PARTI, l'utente le ha definite apposta: sono
            // componenti, non ammassi di cubetti, e vanno trattate come tali senza che
            // debba scoprire un'opzione. Senza parti resta 'smooth', che sui modelli
            // organici e' l'unica che piega bene le articolazioni.
            function defaultBindingFor(voxels) {
                const list = voxels || [];
                for (let i = 0; i < list.length; i++) if (list[i].part) return 'parts';
                return 'smooth';
            }
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
                return { bones, pose: {}, posePos: {}, binding: defaultBindingFor(voxels), type: 'generic' };
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
            // L'asse SINISTRA/DESTRA e' MISURATO sullo scheletro (vedi bindContext), non
            // assunto lungo la X del mondo. Con la X fissa, ruotando il rig di 180 gradi le
            // ossa _R finivano fisicamente a sinistra: la penalita' le allontanava proprio
            // dai voxel che avevano addosso, le gambe si legavano incrociate e la clip di
            // camminata (che muove _L e _R in controfase) le scomponeva.
            function boneCost(v, bone, ctx) {
                let d = distSqToSegment([v.x, v.y, v.z], bone.head, bone.tail);
                const lat = ctx.lat;
                if (lat) {
                    const side = (v.x - lat.mx) * lat.ax + (v.y - lat.my) * lat.ay + (v.z - lat.mz) * lat.az;
                    if (bone.name.endsWith('_R') && side < -lat.dead) d *= 10.0;
                    else if (bone.name.endsWith('_L') && side > lat.dead) d *= 10.0;
                }
                if (v.y < ctx.hipsY && (bone.name === 'hips' || bone.name === 'spine' || bone.name === 'chest')) d *= 4.0;
                return d;
            }

            // Contesto di binding: tutto cio' che serve a boneCost per giudicare un voxel.
            //   cand  - ossa che possono ricevere voxel;
            //   hipsY - quota sotto la quale il busto non deve rubare voxel alle cosce;
            //   lat   - asse laterale misurato: (media ossa _R) meno (media ossa _L),
            //           normalizzato, col punto medio e una zona morta centrale.
            // `lat` e' null quando i due lati non risultano separati: succede su rig non
            // umanoidi e sul rig girato di 90 gradi, dove la separazione L/R cade lungo un
            // asse su cui il modello e' sottile. Meglio nessun vincolo di lato che un
            // vincolo invertito: senza penalita' decide la sola distanza, che e' corretta.
            function bindContext(voxels, bones) {
                const b = voxelBounds(voxels);
                const scale = Math.max(b.w, b.h, b.d) || 1;
                let lat = null;
                let rx = 0, ry = 0, rz = 0, nR = 0;
                let lx = 0, ly = 0, lz = 0, nL = 0;
                bones.forEach(bd => {
                    const mx = (bd.head[0] + bd.tail[0]) / 2;
                    const my = (bd.head[1] + bd.tail[1]) / 2;
                    const mz = (bd.head[2] + bd.tail[2]) / 2;
                    if (bd.name.endsWith('_R')) { rx += mx; ry += my; rz += mz; nR++; }
                    else if (bd.name.endsWith('_L')) { lx += mx; ly += my; lz += mz; nL++; }
                });
                if (nR && nL) {
                    rx /= nR; ry /= nR; rz /= nR;
                    lx /= nL; ly /= nL; lz /= nL;
                    let ax = rx - lx, ay = ry - ly, az = rz - lz;
                    const len = Math.sqrt(ax * ax + ay * ay + az * az);
                    if (len > 0.08 * scale) {
                        ax /= len; ay /= len; az /= len;
                        lat = {
                            ax, ay, az,
                            mx: (rx + lx) / 2, my: (ry + ly) / 2, mz: (rz + lz) / 2,
                            dead: 0.15 * (len / 2)
                        };
                    }
                }
                return { hipsY: b.minY + 0.44 * (b.h || 1), lat, cand: bindableBones(bones) };
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
                const partsMode = o.binding === 'parts';
                const rigidMode = o.binding === 'rigid' || partsMode;
                const hardness = Math.max(1, Math.min(16, Number(o.hardness) || bindHardness || 6));
                const n = voxels.length;
                const ctx = bindContext(voxels, bones);
                const cand = ctx.cand;

                // Passi 1-2: osso dominante rigido, con coerenza spaziale.
                const primary = new Int32Array(n);
                const bestDist = new Float64Array(n);
                const costs = new Float64Array(cand.length);
                for (let i = 0; i < n; i++) {
                    const v = voxels[i];
                    let best = cand[0], bestD = Infinity;
                    for (let c = 0; c < cand.length; c++) {
                        const d = boneCost(v, bones[cand[c]], ctx);
                        if (d < bestD) { bestD = d; best = cand[c]; }
                    }
                    primary[i] = best;
                    bestDist[i] = bestD;
                }
                // Modalita' 'parts': le parti gia' definite dal modello (v.part) sono
                // COMPONENTI, non ammassi di cubetti. Ogni parte puo' usare solo le ossa
                // che le appartengono, quindi un braccio non riceve mai peso da un osso
                // della testa: si piega alle sue articolazioni e si muove tutto insieme.
                const partKeys = partsMode ? restrictToParts(voxels, bones, primary, bestDist, ctx) : null;
                smoothAssignments(voxels, bones, primary, bestDist, ctx, partKeys);

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
                        const d = boneCost(v, bones[cand[c]], ctx);
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
            // Modalita' "Pezzi": ogni parte gia' definita sul modello (v.part) diventa un
            // COMPONENTE. Le ossa non se la contendono piu' voxel per voxel — il problema
            // vero delle immagini "braccio spalmato": due voxel adiacenti su ossa diverse
            // si separano fisicamente, perche' la mesh non e' saldata fra un cubetto e
            // l'altro.
            //
            // Non basta pero' tenere le ossa "piu' votate" dalla parte: la testa votava
            // head MA ANCHE shoulder_L e shoulder_R, che sono FRATELLI e in camminata
            // ruotano in CONTROFASE. Una parte spalmata su due rami che divergono si
            // strappa comunque — e' la testa staccata dell'immagine. Quindi una parte puo'
            // deformarsi solo lungo UNA CATENA di ossa (antenati/discendenti del suo osso
            // dominante): un braccio resta upperArm→forearm→hand e si piega ai gomiti, la
            // testa resta sulla testa. Niente biforcazioni, niente strappi.
            // Restituisce l'array delle parti per voxel (o null se il modello non ne ha),
            // che serve anche alla coerenza per non far dilagare la maggioranza fra parti.
            const PART_BONE_SHARE = 0.08;
            // Quanto devono essere vicini i voti di due ossa SPECULARI perche' la parte sia
            // considerata "centrale" e la discesa si fermi. 0.5 = il fratello ha almeno
            // meta' dei voti del vincitore: un bacino (50/50) si ferma, un braccio che vota
            // 594 a 0 sul lato opposto scende tranquillo.
            const MIRROR_TIE = 0.5;
            function restrictToParts(voxels, bones, primary, bestDist, ctx) {
                const n = voxels.length;
                let any = false;
                const parts = new Array(n);
                for (let i = 0; i < n; i++) {
                    const p = voxels[i].part;
                    if (p) any = true;
                    parts[i] = p || '';
                }
                if (!any) return null;               // nessuna parte: resta il rigido classico

                const childrenOf = new Map();        // osso -> figli
                bones.forEach((bd, j) => {
                    if (bd.parent < 0) return;
                    if (!childrenOf.has(bd.parent)) childrenOf.set(bd.parent, []);
                    childrenOf.get(bd.parent).push(j);
                });

                const tally = new Map();             // parte -> Map(osso -> voxel)
                const total = new Map();             // parte -> voxel totali
                for (let i = 0; i < n; i++) {
                    const p = parts[i];
                    if (!p) continue;
                    let t = tally.get(p);
                    if (!t) { t = new Map(); tally.set(p, t); }
                    t.set(primary[i], (t.get(primary[i]) || 0) + 1);
                    total.set(p, (total.get(p) || 0) + 1);
                }

                const allowed = new Map();           // parte -> Set(ossa ammesse)
                tally.forEach((t, p) => {
                    const min = Math.max(1, Math.floor(total.get(p) * PART_BONE_SHARE));
                    const votes = j => t.get(j) || 0;
                    // Osso speculare (upperLeg_R <-> upperLeg_L). Serve a riconoscere le
                    // parti CENTRALI, che votano quasi alla pari due ossa simmetriche.
                    const mirrorOf = j => {
                        const nm = bones[j] && bones[j].name || '';
                        const m = /^(.*)_([RL])$/.exec(nm);
                        if (!m) return -1;
                        const twin = m[1] + '_' + (m[2] === 'R' ? 'L' : 'R');
                        for (let k = 0; k < bones.length; k++) if (bones[k].name === twin) return k;
                        return -1;
                    };
                    // Osso dominante della parte: la catena parte da lui.
                    let root = -1, topN = -1;
                    t.forEach((c, bi) => { if (c > topN) { topN = c; root = bi; } });
                    const set = new Set();
                    if (root < 0) { allowed.set(p, set); return; }
                    // Se il dominante ha un gemello speculare quasi alla pari, la parte NON
                    // appartiene a quel lato: sta in mezzo. Misurato su `bacino`, che vota
                    // upperLeg_R=505 contro upperLeg_L=467 — di fatto un lancio di dado, e
                    // mezzo bacino finiva saldato alla gamba destra. In quel caso la radice
                    // risale all'antenato COMUNE (hips), che e' l'osso che la parte segue
                    // davvero.
                    for (;;) {
                        const twin = mirrorOf(root);
                        if (twin < 0 || votes(twin) < topN * MIRROR_TIE) break;
                        const up = bones[root].parent;
                        if (up < 0) break;
                        root = up;
                        topN = votes(root);
                    }
                    set.add(root);
                    // Verso l'alto: antenati CONTIGUI che la parte ha davvero conquistato.
                    // Ci si ferma al primo che non la interessa, per non saltare un osso
                    // in mezzo e ritrovarsi due tronconi che ruotano separati.
                    for (let j = bones[root].parent; j >= 0; j = bones[j].parent) {
                        if (votes(j) < min) break;
                        set.add(j);
                    }
                    // Verso il basso: UN SOLO ramo, il piu' votato. Se scendessimo su due
                    // figli la parte si spaccherebbe in due appena si animano in controfase.
                    //
                    // Eccezione: le parti CENTRALI (bacino, torso) votano quasi alla pari
                    // due figli SPECULARI (upperLeg_R/upperLeg_L, shoulder_R/shoulder_L).
                    // Scegliere "il piu' votato" fra due pari e' un lancio di dado, e il
                    // risultato e' mezzo bacino saldato alla gamba destra (misurato: 545
                    // voxel di `bacino` su upperLeg_R, 1284 di `torso` su shoulder_R).
                    // Se il fratello speculare ha voti comparabili la parte sta in mezzo a
                    // entrambi: la discesa si ferma e la parte resta sull'osso centrale.
                    for (let j = root; ;) {
                        const kids = childrenOf.get(j);
                        if (!kids) break;
                        let best = -1, bestV = min - 1;
                        for (const k of kids) { if (votes(k) > bestV) { bestV = votes(k); best = k; } }
                        if (best < 0) break;
                        const twin = mirrorOf(best);
                        if (twin >= 0 && votes(twin) >= bestV * MIRROR_TIE) break;
                        set.add(best);
                        j = best;
                    }
                    allowed.set(p, set);
                });

                for (let i = 0; i < n; i++) {
                    const p = parts[i];
                    if (!p) continue;
                    const set = allowed.get(p);
                    if (!set || !set.size || set.has(primary[i])) continue;
                    let best = -1, bestD = Infinity;
                    set.forEach(bi => {
                        const d = boneCost(voxels[i], bones[bi], ctx);
                        if (d < bestD) { bestD = d; best = bi; }
                    });
                    if (best >= 0) { primary[i] = best; bestDist[i] = bestD; }
                }
                return parts;
            }

            function smoothAssignments(voxels, bones, assign, bestDist, ctx, parts, iterations) {
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
                            // In modalita' "Pezzi" i vicini di un'ALTRA parte non votano: la
                            // maggioranza non deve poter travasare voxel da un componente
                            // all'altro (e' cosi' che la spalla si portava via la testa).
                            if (parts && parts[k] !== parts[i]) continue;
                            neigh++;
                            tally.set(assign[k], (tally.get(assign[k]) || 0) + 1);
                        }
                        if (neigh < 3) continue;               // spigolo/dettaglio sottile: non toccare
                        let topBone = assign[i], topN = tally.get(assign[i]) || 0;
                        tally.forEach((n, bi) => { if (n > topN) { topN = n; topBone = bi; } });
                        if (topBone === assign[i]) continue;
                        if (topN * 2 <= neigh) continue;       // serve una maggioranza vera
                        if (boneCost(v, bones[topBone], ctx) > bestDist[i] * 2.25 + 1e-6) continue;
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
            // `opts.allFaces` costruisce anche le facce interne fra voxel adiacenti: serve
            // all'export "modello pieno", dove chi importa vuole i cubi interni e non il
            // solo guscio esterno. L'anteprima usa sempre il default (solo guscio).
            function buildSkinnedMesh(voxels, bones, assignments, skin, opts) {
                const allFaces = !!(opts && opts.allFaces);
                // `forExport`: la mesh e' usa e getta, NON e' quella a schermo. Le mappe di
                // anteprima (weight paint) devono restare quelle della mesh visibile,
                // altrimenti il pennello riscrive vertici che non esistono piu'.
                const forExport = !!(opts && opts.forExport);
                // `bake`: origine + scala cotte DENTRO vertici e ossa, invece che messe
                // sul nodo della mesh. Un importatore glTF ignora per specifica la
                // trasformazione del nodo di una skinned mesh (la posa arriva tutta da
                // joint + inverse bind matrices): metterla li' significava consegnare a
                // Blender un'armatura a -63,31,0.5 scalata 0.01 con la mesh addosso.
                // Cotta qui, invece, l'armatura esce a 0,0,0 con scala 1.
                const bake = (opts && opts.bake) || null;
                const O = bake ? bake.origin : { x: 0, y: 0, z: 0 };
                const K = bake ? (Number(bake.scale) || 1) : 1;
                const voxelAssign = new Map();
                const voxelIndexAt = new Map();
                for (let i = 0; i < voxels.length; i++) {
                    voxelAssign.set(`${voxels[i].x},${voxels[i].y},${voxels[i].z}`, assignments[i]);
                    voxelIndexAt.set(`${voxels[i].x},${voxels[i].y},${voxels[i].z}`, i);
                }

                // Due voxel si deformano IDENTICI solo se hanno gli stessi 4 pesi sulle
                // stesse ossa. In quel caso la faccia che condividono resta interna in
                // OGNI posa e si puo' togliere per sempre; altrimenti quella faccia e' una
                // giunzione che si APRE, e va tenuta (vedi il commento sul culling sotto).
                // I pesi si confrontano quantizzati: senza `skin` (legacy/rigido) l'unico
                // peso e' 1 sull'osso dominante, quindi il confronto ricade sull'osso.
                const WQ = 65536;   // errore per slot < 1.6e-5 -> fessura < 0.03 mm: invisibile
                function deformsAlike(a, b) {
                    if (!skin) return assignments[a] === assignments[b];
                    const ba = a * MAX_BONE_INFLUENCES, bb = b * MAX_BONE_INFLUENCES;
                    for (let s = 0; s < MAX_BONE_INFLUENCES; s++) {
                        const wa = skin.weights[ba + s], wb = skin.weights[bb + s];
                        const za = !(wa > WEIGHT_EPS), zb = !(wb > WEIGHT_EPS);
                        if (za !== zb) return false;
                        if (za) continue;
                        if (skin.indices[ba + s] !== skin.indices[bb + s]) return false;
                        if (Math.round(wa * WQ) !== Math.round(wb * WQ)) return false;
                    }
                    return true;
                }

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
                            const nkey = `${nx},${ny},${nz}`;
                            if (!allFaces && voxelAssign.has(nkey)) {
                                if (forExport) {
                                    // IN EXPORT la faccia fra due voxel si toglie SOLO se i
                                    // due si deformano IDENTICI: allora resta interna in
                                    // ogni posa e non la vedra' mai nessuno.
                                    //
                                    // Se si deformano diversamente quella faccia e' una
                                    // GIUNZIONE. A riposo i due quad (il +X di uno, il -X
                                    // dell'altro) sono coincidenti e sepolti nel guscio;
                                    // appena la posa muove le ossa i due voxel si separano
                                    // e quei quad diventano le PARETI della fessura.
                                    // Toglierli lascia il guscio APERTO: con i materiali
                                    // FrontSide (= backface culling in Blender) si guarda
                                    // dentro il modello vuoto e si vedono buchi passanti.
                                    // Misurato sul modello dell'utente (24 ossa, binding
                                    // 'parts'): 1268 giunzioni, che nella posa salvata si
                                    // aprono in media 5.3 mm e fino a 55 mm (5.5 voxel);
                                    // Blender contava 0 spigoli di bordo a riposo e 936
                                    // sulla mesh POSATA. Tenendole, ogni gruppo di voxel
                                    // che si deforma allo stesso modo e' un solido CHIUSO
                                    // in qualunque posa e la fessura si legge come un
                                    // giunto, non come un buco — cioe' cio' che mostra
                                    // l'anteprima.
                                    // Lo z-fighting per cui erano state tolte lo risolve
                                    // FrontSide, non la cull: di due quad coplanari a
                                    // orientamento OPPOSTO il backface culling ne disegna
                                    // sempre e solo uno.
                                    if (deformsAlike(i, voxelIndexAt.get(nkey))) continue;
                                } else {
                                    // A SCHERMO la faccia fra due ossa DIVERSE si tiene:
                                    // e' il bordo che fa vedere dove finisce un osso e
                                    // comincia l'altro mentre si dipingono i pesi. Il
                                    // resto si toglie: l'anteprima e' DoubleSide, quindi
                                    // le fessure mostrano comunque la parete di fondo e
                                    // non serve pagare le facce interne.
                                    if (voxelAssign.get(nkey) === assignments[i]) continue;
                                }
                            }

                            for (const off of f.c) {
                                positions.push((v.x + off[0] - O.x) * K,
                                    (v.y + off[1] - O.y) * K,
                                    (v.z + off[2] - O.z) * K);
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
                    // Gruppo (e materiale) SOLO se quel colore ha prodotto facce.
                    // Un colore usato esclusivamente da voxel sepolti (tutti e 6 i
                    // vicini occupati) non ne emette nessuna nel guscio, e un gruppo
                    // con count 0 e' veleno per il GLTFExporter r128: processAccessor
                    // restituisce null sul range vuoto ("Skip creating an accessor if
                    // the attribute doesn't have data") e l'exporter risponde con
                    // `delete primitive.indices`. Per la specifica glTF una primitiva
                    // senza indices si disegna prendendo i vertici IN SEQUENZA: non i
                    // suoi, tutti quelli della mesh. Misurato sul modello dell'utente
                    // (un solo colore su 31): 12098 triangoli fantasma, 3265 piu'
                    // larghi di due voxel e 51 con un lato fino a 0.90 m, cioe'
                    // l'altezza intera del personaggio. Da qui sia le linee che
                    // attraversano il modello sia le "macchie" che sporcano i colori:
                    // sono schegge sottili in un materiale scuro spalmate su tutto il
                    // corpo. Il materiale si crea qui accanto al gruppo perche' i due
                    // devono restare allineati: `matIndex` e' un indice in `materials`.
                    const count = indices.length - groupStart;
                    if (count === 0) continue;
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
                    groups.push({ start: groupStart, count, matIndex: materials.length - 1 });
                }
                // Le mappe di anteprima descrivono la mesh SUL SCHERMO. Una mesh costruita
                // per l'export (allFaces, oppure forExport) ha un'altra geometria:
                // sovrascriverle qui manderebbe fuori sincrono il weight paint, che
                // riscrive i vertici per indice. Quindi si aggiornano solo per l'anteprima.
                const isPreview = !allFaces && !forExport;
                if (isPreview) previewVertexRanges = vertexRanges;

                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
                geo.setAttribute('color', new THREE.Float32BufferAttribute(vColors, 3));
                geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
                geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
                geo.setIndex(indices);
                groups.forEach(g => geo.addGroup(g.start, g.count, g.matIndex));

                if (isPreview) {
                    previewVoxelColors = new Float32Array(vColors);
                    previewBoneColors = new Float32Array(bColors);
                    previewWeightColors = new Float32Array(wColors);
                }


                // Build the THREE bones with correct parenting and rest positions.
                // In export si applica lo stesso `bake` della geometria: le ossa vivono
                // nello spazio voxel, quindi l'offset va tolto SOLO alle radici (le figlie
                // sono gia' relative al padre) mentre la scala vale per tutte.
                const threeBones = bones.map(() => new THREE.Bone());
                bones.forEach((bd, i) => {
                    const bone = threeBones[i];
                    bone.name = bd.name;
                    const ph = bd.parent >= 0 ? bones[bd.parent].head : [O.x, O.y, O.z];
                    bone.position.set((bd.head[0] - ph[0]) * K,
                        (bd.head[1] - ph[1]) * K,
                        (bd.head[2] - ph[2]) * K);
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

            // --- Mesh riggata dedicata all'export ------------------------------------
            // L'anteprima e' costruita per lo SCHERMO: guscio esterno, vertici in
            // coordinate voxel, posizione/scala sul nodo. Per l'export serve altro, e
            // riciclare la mesh a schermo obbligava a mutarla e poi rimetterla a posto —
            // un ripristino che, se l'export falliva a meta', lasciava l'editor rotto.
            // Qui se ne costruisce sempre una gemella usa e getta:
            //   - `allFaces` per il modello PIENO (facce anche fra cubi adiacenti);
            //   - `bake` per cuocere origine e scala in vertici e ossa.
            // Stesse ossa e stessi nomi, quindi le clip si agganciano identiche.
            function buildFullSkinnedMesh(opts) {
                if (!rig || !rig.bones || !rig.bones.length) return null;
                const voxels = currentModelData.voxels || [];
                if (!voxels.length || !boneAssignments) return null;
                const skin = {
                    primary: boneAssignments,
                    indices: boneWeightIndices,
                    weights: boneWeightValues
                };
                return buildSkinnedMesh(voxels, rig.bones, boneAssignments, skin, {
                    allFaces: !!(opts && opts.allFaces),
                    forExport: true,
                    bake: (opts && opts.bake) || null
                });
            }

            // Le clip nascono dallo scheletro a schermo, quindi le tracce `.position`
            // sono POSIZIONI ASSOLUTE in unita' voxel: riposo-a-schermo + offset (vedi
            // `bob()` e le clip AI, che fanno entrambe rest + delta). Le ossa della mesh
            // d'export hanno un altro riposo — le radici sono state traslate sull'origine
            // e tutto e' scalato di K — quindi non basta moltiplicare: va tolto il riposo
            // vecchio e rimesso quello nuovo, altrimenti la clip riporta l'osso radice
            // alla sua coordinata voxel di partenza e il modello salta a 0.62 m su X
            // (misurato: bbox X[0.174,1.085] invece di [-0.264,0.285]).
            // Le rotazioni non si toccano: una scala uniforme non le cambia.
            function scaleClipsForExport(clips, K, exportBones) {
                if (!Array.isArray(clips) || !clips.length) return [];
                const k = (Number(K) > 0) ? Number(K) : 1;
                // Riposo a schermo (spazio voxel) e riposo cotto, per nome osso.
                const oldRest = {}, newRest = {};
                if (skeleton) skeleton.bones.forEach(b => {
                    if (b.userData && b.userData.restPos) oldRest[b.name] = b.userData.restPos;
                });
                (exportBones || []).forEach(b => {
                    if (b.userData && b.userData.restPos) newRest[b.name] = b.userData.restPos;
                });
                let touched = false;
                const out = clips.map(c => {
                    const tracks = c.tracks.map(t => {
                        if (!/\.position$/.test(t.name)) return t;
                        const bn = t.name.replace(/\.position$/, '');
                        const o = oldRest[bn], n = newRest[bn];
                        // Senza i due riposi non si sa ribasare: si riscala e basta,
                        // che e' il comportamento di prima (meglio di niente).
                        if (!o || !n) {
                            if (k === 1) return t;
                            touched = true;
                            return new THREE.VectorKeyframeTrack(t.name, Array.from(t.times),
                                Array.from(Float32Array.from(t.values, v => v * k)));
                        }
                        const values = new Float32Array(t.values.length);
                        for (let i = 0; i < t.values.length; i += 3) {
                            values[i] = (t.values[i] - o.x) * k + n.x;
                            values[i + 1] = (t.values[i + 1] - o.y) * k + n.y;
                            values[i + 2] = (t.values[i + 2] - o.z) * k + n.z;
                        }
                        touched = true;
                        return new THREE.VectorKeyframeTrack(t.name, Array.from(t.times), Array.from(values));
                    });
                    return new THREE.AnimationClip(c.name, c.duration, tracks);
                });
                return touched ? out : clips;
            }

            // Clip di UNA sola posa, costruita dalle ossa gia' posate. Serve perche'
            // l'importatore glTF di Blender assegna da solo la prima action del file e
            // le sue tracce coprono la posa sui nodi: senza una clip che dica "resta
            // com'eri", il personaggio si apre nella prima animazione invece che nella
            // posa dell'editor. Due keyframe identici a t=0 e t=1/24 cosi' e' una clip
            // valida (durata > 0) e resta ferma qualunque frame si guardi.
            function buildPoseClip(boneList, name) {
                if (!Array.isArray(boneList) || !boneList.length) return null;
                const tracks = [];
                const times = [0, 1 / 24];
                boneList.forEach(bone => {
                    const q = bone.quaternion;
                    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`,
                        times, [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w]));
                    const p = bone.position;
                    tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`,
                        times, [p.x, p.y, p.z, p.x, p.y, p.z]));
                });
                if (!tracks.length) return null;
                return new THREE.AnimationClip(name || 'Pose', 1 / 24, tracks);
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
                rigHint.textContent = `Rig "${rig.type}" pronto: ${nSel} ossa. Clic sul PALLINO di un giunto per selezionarlo, poi R per ruotare (posa) o G per spostare il giunto. Ctrl+Z annulla.`;
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
            // Canale posizione parcheggiato in parallelo a poseBeforePaint. Resta una
            // variabile SEPARATA di proposito: `poseBeforePaint` e' letto come mappa
            // "osso -> [rx,ry,rz]" anche da clearRigPreview() e da rigEffectivePose()
            // in 32-rig-tools.js, quindi cambiargli forma li romperebbe in silenzio.
            let posePosBeforePaint = null;

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

            // Il modello ha parti definite? Serve alla UI per dire chiaramente che
            // "Pezzi" senza parti si comporta come "Rigida", invece di far credere che
            // la modalita' non funzioni.
            function modelHasParts() {
                const voxels = (currentModelData && currentModelData.voxels) || [];
                for (let i = 0; i < voxels.length; i++) if (voxels[i].part) return true;
                return false;
            }

            function updateWeightPaintUI() {
                if (!weightPaintToggle) return;
                const usable = !!(rig && rig.bones && rig.bones.length && rigPreviewActive);
                weightPaintToggle.disabled = !usable;
                weightPaintToggle.classList.toggle('btn-primary', weightPaintActive);
                weightPaintToggle.classList.toggle('btn-secondary', !weightPaintActive);
                weightPaintToggle.textContent = weightPaintActive ? t('rig.wp.exit') : t('rig.wp.enter');
                if (bindPartsHint) {
                    bindPartsHint.style.display = (rig && rig.binding === 'parts' && !modelHasParts()) ? '' : 'none';
                }
                // Il controllo segmentato deve dire la verita' su rig.binding: il default
                // e' adattivo (parts se il modello ha parti), e su un rig caricato dal
                // progetto la modalita' arriva dal file. Senza questa riga il pulsante
                // acceso resterebbe quello scritto nel template.
                if (bindModeControl && rig && rig.binding) {
                    bindModeControl.querySelectorAll('.seg-btn').forEach(b => {
                        b.classList.toggle('active', b.dataset.bind === rig.binding);
                    });
                }
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
                    // In pittura la posa e' azzerata di proposito: si dipinge sul
                    // modello a riposo. Vale per ENTRAMBI i canali, altrimenti un osso
                    // traslato resterebbe fuori posto sotto il pennello. I due canali
                    // stanno in variabili SEPARATE perche' `poseBeforePaint` e' letta
                    // come mappa di rotazioni anche da 32-rig-tools.js e da
                    // clearRigPreview(): incapsularla cambierebbe forma sotto di loro.
                    poseBeforePaint = JSON.parse(JSON.stringify(rig.pose || {}));
                    posePosBeforePaint = JSON.parse(JSON.stringify(rig.posePos || {}));
                    rig.pose = {};
                    rig.posePos = {};
                    applyPoseToBones();
                    refreshWeightColors();
                    if (rigHint) rigHint.textContent = t('rig.wp.hintOn');
                } else {
                    if (poseBeforePaint) { rig.pose = poseBeforePaint; poseBeforePaint = null; }
                    if (posePosBeforePaint) { rig.posePos = posePosBeforePaint; posePosBeforePaint = null; }
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
                    const d = boneCost(v, rig.bones[ctx.cand[c]], ctx);
                    if (d < bestD) { bestD = d; best = ctx.cand[c]; }
                }
                return best === undefined ? -1 : best;
            }

            // Stesso contesto del binding (asse laterale misurato incluso): prima questa
            // funzione ricalcolava a mano un contesto diverso, e il pennello poteva quindi
            // proporre un osso che il binding non avrebbe mai scelto.
            function autoBindContext() {
                return bindContext(currentModelData.voxels || [], (rig && rig.bones) || []);
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
                if (!rig || !rig.bones.length) { alert('Prima crea uno scheletro con Auto-Rig.'); return; }
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
                // La durezza e' l'esponente del falloff: esiste solo per lo smooth. Le altre
                // due modalita' danno peso 1 a un osso solo, quindi non cambierebbe nulla.
                if (!rig || rig.binding === 'rigid' || rig.binding === 'parts') return;
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
                    // Traslazione di posa per osso (vedi applyPoseToBones). Assente nei
                    // progetti salvati prima del canale Location: si parte da vuoto.
                    posePos: (saved.posePos && typeof saved.posePos === 'object') ? saved.posePos : {},
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
                // Traslazione di posa: se non c'e' nulla da salvare si omette, cosi' un
                // progetto senza keyframe Location non contiene campi vuoti.
                if (r.posePos && Object.keys(r.posePos).length) out.posePos = r.posePos;
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
                if (posePosBeforePaint && rig) { rig.posePos = posePosBeforePaint; }
                poseBeforePaint = null;
                posePosBeforePaint = null;
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
                posePosBeforePaint = null;
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
                    row.title = 'Doppio clic per rinominare';
                    row.addEventListener('dblclick', () => {
                        if (typeof rigRenameBonePrompt === 'function') rigRenameBonePrompt(i);
                    });
                    boneListEl.appendChild(row);
                });
            }

            function selectBone(i) {
                if (i < 0) {
                    selectedBoneIndex = -1;
                    renderBoneList();
                    refreshWeightColors();
                    if (rigPreviewActive) updateRigVisibility();
                    updateBoneMarker();
                    updateJointHandles();
                    updateWeightPaintUI();
                    if (typeof updateGizmo === 'function') updateGizmo();
                    return;
                }
                if (!rig || !rig.bones[i]) return;
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
                syncPosSliders();      // e anche la traslazione di posa dell'osso
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
            /* La posa ha DUE canali, come in Blender:
             *   rig.pose[nome]    -> rotazione [rx,ry,rz] in RADIANTI;
             *   rig.posePos[nome] -> traslazione [dx,dy,dz] in unita' voxel, RELATIVA
             *                        alla posizione di riposo dell'osso.
             * Il canale di traslazione esiste perche' i keyframe hanno sempre avuto un
             * campo `pos` (il "bob" delle anche, le clip AI, l'export GLB) ma non c'era
             * modo di IMPOSTARLO: "Inserisci Location" avrebbe scritto solo zeri. */
            function posePosOf(name) {
                const p = rig && rig.posePos && rig.posePos[name];
                return Array.isArray(p) ? p : null;
            }

            // Applica la posa dell'editor a una lista di ossa QUALSIASI, non solo a
            // quelle a schermo. Serve all'export: la mesh d'export ha ossa gemelle,
            // cotte a scala K, quindi le TRASLAZIONI di posa (unita' voxel) vanno
            // riscalate; le rotazioni no, una scala uniforme non le tocca.
            function applyPoseToBoneList(boneList, K) {
                if (!rig || !boneList) return;
                const k = (Number(K) > 0) ? Number(K) : 1;
                boneList.forEach((bone, i) => {
                    const name = (rig.bones[i] && rig.bones[i].name) || bone.name;
                    const p = (rig.pose && rig.pose[name]) || [0, 0, 0];
                    bone.rotation.set(p[0], p[1], p[2]);
                    // Le clip animano bone.position (il "bob" delle anche): si riparte
                    // SEMPRE dal riposo e si applica l'offset di posa, altrimenti una
                    // posa statica resterebbe con la radice spostata dall'ultima clip.
                    const rest = bone.userData.restPos;
                    if (!rest) return;
                    const d = posePosOf(name);
                    if (d) bone.position.set(rest.x + (Number(d[0]) || 0) * k,
                        rest.y + (Number(d[1]) || 0) * k,
                        rest.z + (Number(d[2]) || 0) * k);
                    else bone.position.copy(rest);
                });
            }

            function applyPoseToBones() {
                if (!skeleton) return;
                applyPoseToBoneList(skeleton.bones, 1);
                updateBoneMarker();
            }

            function updateRotLabels() {
                rotValEls.x.textContent = `${poseRot.x.value}°`;
                rotValEls.y.textContent = `${poseRot.y.value}°`;
                rotValEls.z.textContent = `${poseRot.z.value}°`;
                updatePosLabels();
            }

            // I cursori Pos possono mancare in un DOM ridotto (test): mai dare per
            // scontato che esistano, altrimenti il bootstrap si ferma qui.
            function hasPosSliders() { return !!(posePosSl.x && posePosSl.y && posePosSl.z); }

            function updatePosLabels() {
                if (!hasPosSliders() || !posValEls.x) return;
                const f = v => String(Math.round(Number(v) * 100) / 100);
                posValEls.x.textContent = f(posePosSl.x.value);
                posValEls.y.textContent = f(posePosSl.y.value);
                posValEls.z.textContent = f(posePosSl.z.value);
            }

            // Carica nei cursori Pos la traslazione dell'osso selezionato.
            function syncPosSliders() {
                if (!hasPosSliders()) return;
                let d = [0, 0, 0];
                if (rig && selectedBoneIndex >= 0 && rig.bones[selectedBoneIndex]) {
                    d = posePosOf(rig.bones[selectedBoneIndex].name) || [0, 0, 0];
                }
                posePosSl.x.value = Number(d[0]) || 0;
                posePosSl.y.value = Number(d[1]) || 0;
                posePosSl.z.value = Number(d[2]) || 0;
                updatePosLabels();
            }

            function onPosSlider() {
                if (selectedBoneIndex < 0 || !rig || !hasPosSliders()) return;
                const name = rig.bones[selectedBoneIndex].name;
                rig.posePos = rig.posePos || {};
                const v = [Number(posePosSl.x.value) || 0, Number(posePosSl.y.value) || 0,
                    Number(posePosSl.z.value) || 0];
                // Zero non si memorizza: tenere la mappa pulita fa sì che un progetto
                // senza traslazioni non porti in giro chiavi inutili nel salvataggio.
                if (!v[0] && !v[1] && !v[2]) delete rig.posePos[name];
                else rig.posePos[name] = v;
                updatePosLabels();
                // Come per la rotazione: un cursore descrive una posa STATICA, quindi
                // una clip in riproduzione la sovrascriverebbe al frame dopo.
                if (currentAction) { currentAction.stop(); currentAction = null; animSelect.value = 'none'; }
                applyPoseToBones();
                if (typeof syncGizmoToBone === 'function') syncGizmoToBone();
                if (typeof requestRender === 'function') requestRender();
            }

            if (hasPosSliders()) {
                Object.values(posePosSl).forEach(sl => {
                    sl.addEventListener('input', onPosSlider);
                    sl.addEventListener('mousedown', pushHistory);
                    sl.addEventListener('touchstart', pushHistory);
                });
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
                rig.posePos = {};       // anche la traslazione di posa torna a riposo
                if (currentAction) { currentAction.stop(); currentAction = null; }
                animSelect.value = 'none';
                poseRot.x.value = poseRot.y.value = poseRot.z.value = 0;
                updateRotLabels();
                syncPosSliders();
                applyPoseToBones();
                if (typeof updateGizmo === 'function') updateGizmo();
            });

            function rigFacingYaw(bones) {
                const list = Array.isArray(bones) ? bones : [];
                const vec = b => (b && Array.isArray(b.head) && Array.isArray(b.tail));
                let fx = 0, fz = 0;
                list.forEach(b => {
                    if (!vec(b) || !/^(foot|toeTip)_[LR]$/.test(b.name || '')) return;
                    fx += b.tail[0] - b.head[0];
                    fz += b.tail[2] - b.head[2];
                });
                if (Math.hypot(fx, fz) < 1e-3) {
                    let rx = 0, rz = 0, n = 0;
                    list.forEach(b => {
                        const m = /^(.*)_R$/.exec((b && b.name) || '');
                        if (!m || !vec(b)) return;
                        const twin = list.find(o => o && o.name === m[1] + '_L');
                        if (!vec(twin)) return;
                        rx += b.head[0] - twin.head[0];
                        rz += b.head[2] - twin.head[2];
                        n++;
                    });
                    if (n && Math.hypot(rx, rz) > 1e-3) { fx = -rz; fz = rx; }
                }
                if (Math.hypot(fx, fz) < 1e-3) return 0;
                // yaw = angolo attorno a Y che porta il davanti canonico (+Z) sul davanti
                // reale: R_y(yaw) * (0,0,1) = (sin yaw, 0, cos yaw).
                const steps = ((Math.round(Math.atan2(fx, fz) / (Math.PI / 2)) % 4) + 4) % 4;
                return steps * 90;
            }

            // Porta una rotazione scritta nel frame canonico in quello del personaggio:
            // q' = qFace * q * qFace^-1 (coniugazione). Essendo un omomorfismo, coniugare
            // ogni rotazione LOCALE equivale a coniugare l'intera posa mondo, quindi il
            // movimento resta lo stesso "visto dal personaggio". qFace null = identita'
            // (nessun calcolo: cosi' il caso canonico resta bit-identico a prima).
            function faceRotate(q, qFace) {
                if (!qFace) return q;
                return qFace.clone().multiply(q).multiply(qFace.clone().invert());
            }

            // --- Preset animations --------------------------------------------------
            // Build a few clips procedurally from the bone names present. These are for
            // preview and are embedded into the exported GLB.
            function buildAnimationClips() {
                rigClips = [];
                if (!skeleton) return;

                // CONVENZIONE DEI PRESET (misurata, non dedotta: tests/.diag_signs.mjs
                // ruota un osso e stampa dove finisce la punta in coordinate mondo).
                //
                // 1) La Z delle braccia e' obbligatoria. Nello scheletro a riposo il
                //    braccio e' in T-pose, cioe' ALLINEATO ALL'ASSE X: `rot(30,0,0)` su
                //    upperArm_R sposta la punta di (0,0,0) -- una rotazione attorno al
                //    proprio asse non muove niente. Le clip vecchie ruotavano le braccia
                //    solo su X: da qui le braccia rimaste in T-pose in quasi ogni clip.
                //    Solo Z le fa scendere: -78 sul destro / +78 sul sinistro le porta
                //    lungo il corpo (misurato: dX -10.0 dY -12.5, cioe' giu' e verso il
                //    centro). Ogni preset parte da quella posa, mai dalla T-pose.
                //    La Z NON dipende dall'imbardata: "verso il corpo" per l'osso _R (che
                //    sta sempre a X maggiore) e' sempre -X.
                //
                // 2) La X e' l'oscillazione avanti/indietro e DIPENDE dall'imbardata.
                //    Per un osso che a riposo punta in giu', X>0 muove la punta verso -Z
                //    (proprieta' della matrice, non dello scheletro). Quindi X>0 e' avanti
                //    se il personaggio guarda -Z (faceYaw 180), indietro se guarda +Z.
                //    I valori qui sotto sono scritti nel frame della walk di riferimento,
                //    validata a mano su uno scheletro con faceYaw 180, dove X>0 = avanti;
                //    `S` li riporta sull'imbardata reale. Il vecchio `legSign` aveva il
                //    segno OPPOSTO (assumeva il frame +Z) e su quello scheletro produceva
                //    la camminata specchiata, con le gambe che spingevano all'indietro.
                //
                // Le braccia contro-oscillano rispetto alle gambe: con upperLeg_R avanti
                // (+30) upperArm_R va indietro (-30).
                const faceYaw = rigFacingYaw(rig.bones);
                const S = (faceYaw === 180) ? 1 : -1;
                // A 90/270 i segni non bastano (le gambe oscillerebbero DI FIANCO): li'
                // si coniuga la rotazione. Caso limite e per definizione approssimato --
                // un umanoide con le ossa _R a X maggiore che guarda lungo X avrebbe le
                // braccia davanti, quindi una posa "lungo il corpo" non esiste.
                const yawRad = (faceYaw === 90 || faceYaw === 270) ? faceYaw * Math.PI / 180 : 0;
                const qFace = yawRad
                    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRad)
                    : null;

                // Respiro + micro-oscillazioni. Le braccia NON sono a riposo: stanno lungo
                // il corpo (Z -78/+78) come nella walk, altrimenti l'idle e' una T-pose.
                const newIdle = {
                    name: 'idle', duration: 3, loop: true,
                    tracks: [
                        { bone: 'hips', keys: [{ t: 0, pos: [0, 0, 0], rot: [0, 0, 0] }, { t: 0.75, pos: [0, -0.03, 0], rot: [0, 1, 0] }, { t: 1.5, pos: [0, -0.05, 0], rot: [0, 0, 0] }, { t: 2.25, pos: [0, -0.03, 0], rot: [0, -1, 0] }, { t: 3, pos: [0, 0, 0], rot: [0, 0, 0] }] },
                        { bone: 'spine', keys: [{ t: 0, rot: [1 * S, 0, 0] }, { t: 1.5, rot: [-1.5 * S, 0, 0] }, { t: 3, rot: [1 * S, 0, 0] }] },
                        { bone: 'chest', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1.5, rot: [-2.5 * S, 0, 0] }, { t: 3, rot: [0, 0, 0] }] },
                        { bone: 'neck', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1.5, rot: [1 * S, 0, 0] }, { t: 3, rot: [0, 0, 0] }] },
                        { bone: 'head', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [-1 * S, 3, 0] }, { t: 2, rot: [1 * S, -3, 0] }, { t: 3, rot: [0, 0, 0] }] },
                        { bone: 'upperLeg_R', keys: [{ t: 0, rot: [2 * S, 0, 0] }, { t: 3, rot: [2 * S, 0, 0] }] },
                        { bone: 'lowerLeg_R', keys: [{ t: 0, rot: [-4 * S, 0, 0] }, { t: 1.5, rot: [-3 * S, 0, 0] }, { t: 3, rot: [-4 * S, 0, 0] }] },
                        { bone: 'foot_R', keys: [{ t: 0, rot: [2 * S, 0, 0] }, { t: 3, rot: [2 * S, 0, 0] }] },
                        { bone: 'upperLeg_L', keys: [{ t: 0, rot: [2 * S, 0, 0] }, { t: 3, rot: [2 * S, 0, 0] }] },
                        { bone: 'lowerLeg_L', keys: [{ t: 0, rot: [-3 * S, 0, 0] }, { t: 1.5, rot: [-4 * S, 0, 0] }, { t: 3, rot: [-3 * S, 0, 0] }] },
                        { bone: 'foot_L', keys: [{ t: 0, rot: [2 * S, 0, 0] }, { t: 3, rot: [2 * S, 0, 0] }] },
                        { bone: 'shoulder_R', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1.5, rot: [0, 0, -1.5] }, { t: 3, rot: [0, 0, 0] }] },
                        { bone: 'upperArm_R', keys: [{ t: 0, rot: [2 * S, 0, -78] }, { t: 1.5, rot: [-2 * S, 0, -76] }, { t: 3, rot: [2 * S, 0, -78] }] },
                        { bone: 'forearm_R', keys: [{ t: 0, rot: [10 * S, 0, 0] }, { t: 1.5, rot: [14 * S, 0, 0] }, { t: 3, rot: [10 * S, 0, 0] }] },
                        { bone: 'hand_R', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1.5, rot: [4 * S, 0, 0] }, { t: 3, rot: [0, 0, 0] }] },
                        { bone: 'shoulder_L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1.5, rot: [0, 0, 1.5] }, { t: 3, rot: [0, 0, 0] }] },
                        { bone: 'upperArm_L', keys: [{ t: 0, rot: [2 * S, 0, 78] }, { t: 1.5, rot: [-2 * S, 0, 76] }, { t: 3, rot: [2 * S, 0, 78] }] },
                        { bone: 'forearm_L', keys: [{ t: 0, rot: [12 * S, 0, 0] }, { t: 1.5, rot: [16 * S, 0, 0] }, { t: 3, rot: [12 * S, 0, 0] }] },
                        { bone: 'hand_L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1.5, rot: [4 * S, 0, 0] }, { t: 3, rot: [0, 0, 0] }] }
                    ]
                };
                // Camminata di riferimento: la clip "NaturalWalk" validata a mano, con i
                // suoi numeri esatti (su uno scheletro faceYaw 180, dove S vale 1, questa
                // ricostruisce quella clip identica -- lo verifica test_anim_presets.mjs).
                // Le altre tre sono derivate da qui: cambiando una convenzione si parte da
                // questa e poi si riallineano le altre.
                const newWalk = {
                    name: 'walk', duration: 1, loop: true,
                    tracks: [
                        { bone: 'hips', keys: [{ t: 0, pos: [0, -0.04, 0], rot: [0, 5, 2] }, { t: 0.25, pos: [0, 0.08, 0], rot: [0, 0, 0] }, { t: 0.5, pos: [0, -0.04, 0], rot: [0, -5, -2] }, { t: 0.75, pos: [0, 0.08, 0], rot: [0, 0, 0] }, { t: 1, pos: [0, -0.04, 0], rot: [0, 5, 2] }] },
                        { bone: 'spine', keys: [{ t: 0, rot: [2 * S, -4, 0] }, { t: 0.25, rot: [2 * S, 0, 0] }, { t: 0.5, rot: [2 * S, 4, 0] }, { t: 0.75, rot: [2 * S, 0, 0] }, { t: 1, rot: [2 * S, -4, 0] }] },
                        { bone: 'chest', keys: [{ t: 0, rot: [0, -3, -1] }, { t: 0.25, rot: [0, 0, 0] }, { t: 0.5, rot: [0, 3, 1] }, { t: 0.75, rot: [0, 0, 0] }, { t: 1, rot: [0, -3, -1] }] },
                        { bone: 'head', keys: [{ t: 0, rot: [-2 * S, 0, 0] }, { t: 0.25, rot: [1 * S, 0, 0] }, { t: 0.5, rot: [-2 * S, 0, 0] }, { t: 0.75, rot: [1 * S, 0, 0] }, { t: 1, rot: [-2 * S, 0, 0] }] },
                        { bone: 'neck', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 0, 0] }] },
                        { bone: 'upperLeg_R', keys: [{ t: 0, rot: [30 * S, 0, 0] }, { t: 0.25, rot: [0, 0, 0] }, { t: 0.5, rot: [-30 * S, 0, 0] }, { t: 0.75, rot: [10 * S, 0, 0] }, { t: 1, rot: [30 * S, 0, 0] }] },
                        { bone: 'lowerLeg_R', keys: [{ t: 0, rot: [-5 * S, 0, 0] }, { t: 0.25, rot: [-15 * S, 0, 0] }, { t: 0.5, rot: [-10 * S, 0, 0] }, { t: 0.75, rot: [-60 * S, 0, 0] }, { t: 1, rot: [-5 * S, 0, 0] }] },
                        { bone: 'foot_R', keys: [{ t: 0, rot: [-15 * S, 0, 0] }, { t: 0.25, rot: [0, 0, 0] }, { t: 0.5, rot: [25 * S, 0, 0] }, { t: 0.75, rot: [-5 * S, 0, 0] }, { t: 1, rot: [-15 * S, 0, 0] }] },
                        { bone: 'upperLeg_L', keys: [{ t: 0, rot: [-30 * S, 0, 0] }, { t: 0.25, rot: [10 * S, 0, 0] }, { t: 0.5, rot: [30 * S, 0, 0] }, { t: 0.75, rot: [0, 0, 0] }, { t: 1, rot: [-30 * S, 0, 0] }] },
                        { bone: 'lowerLeg_L', keys: [{ t: 0, rot: [-10 * S, 0, 0] }, { t: 0.25, rot: [-60 * S, 0, 0] }, { t: 0.5, rot: [-5 * S, 0, 0] }, { t: 0.75, rot: [-15 * S, 0, 0] }, { t: 1, rot: [-10 * S, 0, 0] }] },
                        { bone: 'foot_L', keys: [{ t: 0, rot: [25 * S, 0, 0] }, { t: 0.25, rot: [-5 * S, 0, 0] }, { t: 0.5, rot: [-15 * S, 0, 0] }, { t: 0.75, rot: [0, 0, 0] }, { t: 1, rot: [25 * S, 0, 0] }] },
                        { bone: 'shoulder_R', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 0, 0] }] },
                        { bone: 'upperArm_R', keys: [{ t: 0, rot: [-30 * S, 0, -78] }, { t: 0.25, rot: [0, 0, -78] }, { t: 0.5, rot: [30 * S, 0, -78] }, { t: 0.75, rot: [0, 0, -78] }, { t: 1, rot: [-30 * S, 0, -78] }] },
                        { bone: 'forearm_R', keys: [{ t: 0, rot: [15 * S, 0, 0] }, { t: 0.25, rot: [25 * S, 0, 0] }, { t: 0.5, rot: [45 * S, 0, 0] }, { t: 0.75, rot: [25 * S, 0, 0] }, { t: 1, rot: [15 * S, 0, 0] }] },
                        { bone: 'hand_R', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 0, 0] }] },
                        { bone: 'shoulder_L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 0, 0] }] },
                        { bone: 'upperArm_L', keys: [{ t: 0, rot: [30 * S, 0, 78] }, { t: 0.25, rot: [0, 0, 78] }, { t: 0.5, rot: [-30 * S, 0, 78] }, { t: 0.75, rot: [0, 0, 78] }, { t: 1, rot: [30 * S, 0, 78] }] },
                        { bone: 'forearm_L', keys: [{ t: 0, rot: [45 * S, 0, 0] }, { t: 0.25, rot: [25 * S, 0, 0] }, { t: 0.5, rot: [15 * S, 0, 0] }, { t: 0.75, rot: [25 * S, 0, 0] }, { t: 1, rot: [45 * S, 0, 0] }] },
                        { bone: 'hand_L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 0, 0] }] }
                    ]
                };
                // La walk accelerata: stesse fasi e stessi segni, ampiezze quasi doppie,
                // busto inclinato in avanti, gomiti piegati ~75 gradi (e' quello che
                // distingue una corsa da una camminata veloce) e una fase di volo, cioe'
                // il bacino sale invece di scendere a meta' appoggio.
                const newRun = {
                    name: 'run', duration: 0.6, loop: true,
                    tracks: [
                        { bone: 'hips', keys: [{ t: 0, pos: [0, -0.06, 0], rot: [0, 7, 4] }, { t: 0.15, pos: [0, 0.22, 0], rot: [0, 0, 0] }, { t: 0.3, pos: [0, -0.06, 0], rot: [0, -7, -4] }, { t: 0.45, pos: [0, 0.22, 0], rot: [0, 0, 0] }, { t: 0.6, pos: [0, -0.06, 0], rot: [0, 7, 4] }] },
                        { bone: 'spine', keys: [{ t: 0, rot: [8 * S, -5, 0] }, { t: 0.15, rot: [8 * S, 0, 0] }, { t: 0.3, rot: [8 * S, 5, 0] }, { t: 0.45, rot: [8 * S, 0, 0] }, { t: 0.6, rot: [8 * S, -5, 0] }] },
                        { bone: 'chest', keys: [{ t: 0, rot: [7 * S, -6, -2] }, { t: 0.15, rot: [7 * S, 0, 0] }, { t: 0.3, rot: [7 * S, 6, 2] }, { t: 0.45, rot: [7 * S, 0, 0] }, { t: 0.6, rot: [7 * S, -6, -2] }] },
                        { bone: 'neck', keys: [{ t: 0, rot: [-6 * S, 0, 0] }, { t: 0.6, rot: [-6 * S, 0, 0] }] },
                        { bone: 'head', keys: [{ t: 0, rot: [-9 * S, 0, 0] }, { t: 0.15, rot: [-7 * S, 0, 0] }, { t: 0.3, rot: [-9 * S, 0, 0] }, { t: 0.45, rot: [-7 * S, 0, 0] }, { t: 0.6, rot: [-9 * S, 0, 0] }] },
                        { bone: 'upperLeg_R', keys: [{ t: 0, rot: [52 * S, 0, 0] }, { t: 0.15, rot: [5 * S, 0, 0] }, { t: 0.3, rot: [-38 * S, 0, 0] }, { t: 0.45, rot: [15 * S, 0, 0] }, { t: 0.6, rot: [52 * S, 0, 0] }] },
                        { bone: 'lowerLeg_R', keys: [{ t: 0, rot: [-22 * S, 0, 0] }, { t: 0.15, rot: [-28 * S, 0, 0] }, { t: 0.3, rot: [-20 * S, 0, 0] }, { t: 0.45, rot: [-105 * S, 0, 0] }, { t: 0.6, rot: [-22 * S, 0, 0] }] },
                        { bone: 'foot_R', keys: [{ t: 0, rot: [-18 * S, 0, 0] }, { t: 0.15, rot: [5 * S, 0, 0] }, { t: 0.3, rot: [35 * S, 0, 0] }, { t: 0.45, rot: [-12 * S, 0, 0] }, { t: 0.6, rot: [-18 * S, 0, 0] }] },
                        { bone: 'upperLeg_L', keys: [{ t: 0, rot: [-38 * S, 0, 0] }, { t: 0.15, rot: [15 * S, 0, 0] }, { t: 0.3, rot: [52 * S, 0, 0] }, { t: 0.45, rot: [5 * S, 0, 0] }, { t: 0.6, rot: [-38 * S, 0, 0] }] },
                        { bone: 'lowerLeg_L', keys: [{ t: 0, rot: [-20 * S, 0, 0] }, { t: 0.15, rot: [-105 * S, 0, 0] }, { t: 0.3, rot: [-22 * S, 0, 0] }, { t: 0.45, rot: [-28 * S, 0, 0] }, { t: 0.6, rot: [-20 * S, 0, 0] }] },
                        { bone: 'foot_L', keys: [{ t: 0, rot: [35 * S, 0, 0] }, { t: 0.15, rot: [-12 * S, 0, 0] }, { t: 0.3, rot: [-18 * S, 0, 0] }, { t: 0.45, rot: [5 * S, 0, 0] }, { t: 0.6, rot: [35 * S, 0, 0] }] },
                        { bone: 'shoulder_R', keys: [{ t: 0, rot: [-4 * S, 0, 0] }, { t: 0.3, rot: [4 * S, 0, 0] }, { t: 0.6, rot: [-4 * S, 0, 0] }] },
                        { bone: 'upperArm_R', keys: [{ t: 0, rot: [-48 * S, 0, -74] }, { t: 0.15, rot: [-5 * S, 0, -72] }, { t: 0.3, rot: [42 * S, 0, -74] }, { t: 0.45, rot: [-5 * S, 0, -72] }, { t: 0.6, rot: [-48 * S, 0, -74] }] },
                        { bone: 'forearm_R', keys: [{ t: 0, rot: [62 * S, 0, 0] }, { t: 0.15, rot: [78 * S, 0, 0] }, { t: 0.3, rot: [88 * S, 0, 0] }, { t: 0.45, rot: [78 * S, 0, 0] }, { t: 0.6, rot: [62 * S, 0, 0] }] },
                        { bone: 'hand_R', keys: [{ t: 0, rot: [10 * S, 0, 0] }, { t: 0.6, rot: [10 * S, 0, 0] }] },
                        { bone: 'shoulder_L', keys: [{ t: 0, rot: [4 * S, 0, 0] }, { t: 0.3, rot: [-4 * S, 0, 0] }, { t: 0.6, rot: [4 * S, 0, 0] }] },
                        { bone: 'upperArm_L', keys: [{ t: 0, rot: [42 * S, 0, 74] }, { t: 0.15, rot: [-5 * S, 0, 72] }, { t: 0.3, rot: [-48 * S, 0, 74] }, { t: 0.45, rot: [-5 * S, 0, 72] }, { t: 0.6, rot: [42 * S, 0, 74] }] },
                        { bone: 'forearm_L', keys: [{ t: 0, rot: [88 * S, 0, 0] }, { t: 0.15, rot: [78 * S, 0, 0] }, { t: 0.3, rot: [62 * S, 0, 0] }, { t: 0.45, rot: [78 * S, 0, 0] }, { t: 0.6, rot: [88 * S, 0, 0] }] },
                        { bone: 'hand_L', keys: [{ t: 0, rot: [10 * S, 0, 0] }, { t: 0.6, rot: [10 * S, 0, 0] }] }
                    ]
                };
                // Salto in cinque pose: 0 in piedi, 0.22 caricamento (bacino giu', braccia
                // indietro), 0.38 stacco (gambe distese, braccia in alto), 0.62 apice
                // (gambe raccolte), 0.85 atterraggio (ammortizza), 1.2 ritorno in piedi.
                // Il bacino e' l'osso radice, quindi `pos` in voxel sposta tutto il corpo:
                // -1.6 in caricamento e +3.2 all'apice su un personaggio da ~40 voxel.
                const newJump = {
                    name: 'jump', duration: 1.2, loop: false,
                    tracks: [
                        { bone: 'hips', keys: [{ t: 0, pos: [0, 0, 0], rot: [0, 0, 0] }, { t: 0.22, pos: [0, -1.6, 0], rot: [16 * S, 0, 0] }, { t: 0.38, pos: [0, 0.6, 0], rot: [-6 * S, 0, 0] }, { t: 0.62, pos: [0, 3.2, 0], rot: [10 * S, 0, 0] }, { t: 0.85, pos: [0, -1.3, 0], rot: [20 * S, 0, 0] }, { t: 1.2, pos: [0, 0, 0], rot: [0, 0, 0] }] },
                        { bone: 'spine', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.22, rot: [12 * S, 0, 0] }, { t: 0.38, rot: [-8 * S, 0, 0] }, { t: 0.62, rot: [6 * S, 0, 0] }, { t: 0.85, rot: [14 * S, 0, 0] }, { t: 1.2, rot: [0, 0, 0] }] },
                        { bone: 'chest', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.22, rot: [14 * S, 0, 0] }, { t: 0.38, rot: [-10 * S, 0, 0] }, { t: 0.62, rot: [4 * S, 0, 0] }, { t: 0.85, rot: [16 * S, 0, 0] }, { t: 1.2, rot: [0, 0, 0] }] },
                        { bone: 'neck', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.22, rot: [-6 * S, 0, 0] }, { t: 0.62, rot: [-3 * S, 0, 0] }, { t: 0.85, rot: [-8 * S, 0, 0] }, { t: 1.2, rot: [0, 0, 0] }] },
                        { bone: 'head', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.22, rot: [-9 * S, 0, 0] }, { t: 0.38, rot: [6 * S, 0, 0] }, { t: 0.62, rot: [-4 * S, 0, 0] }, { t: 0.85, rot: [-11 * S, 0, 0] }, { t: 1.2, rot: [0, 0, 0] }] },
                        { bone: 'upperLeg_R', keys: [{ t: 0, rot: [3 * S, 0, 0] }, { t: 0.22, rot: [58 * S, 0, 0] }, { t: 0.38, rot: [-8 * S, 0, 0] }, { t: 0.62, rot: [42 * S, 0, 0] }, { t: 0.85, rot: [50 * S, 0, 0] }, { t: 1.2, rot: [3 * S, 0, 0] }] },
                        { bone: 'lowerLeg_R', keys: [{ t: 0, rot: [-4 * S, 0, 0] }, { t: 0.22, rot: [-88 * S, 0, 0] }, { t: 0.38, rot: [-3 * S, 0, 0] }, { t: 0.62, rot: [-75 * S, 0, 0] }, { t: 0.85, rot: [-70 * S, 0, 0] }, { t: 1.2, rot: [-4 * S, 0, 0] }] },
                        { bone: 'foot_R', keys: [{ t: 0, rot: [2 * S, 0, 0] }, { t: 0.22, rot: [-26 * S, 0, 0] }, { t: 0.38, rot: [42 * S, 0, 0] }, { t: 0.62, rot: [24 * S, 0, 0] }, { t: 0.85, rot: [-14 * S, 0, 0] }, { t: 1.2, rot: [2 * S, 0, 0] }] },
                        { bone: 'upperLeg_L', keys: [{ t: 0, rot: [3 * S, 0, 0] }, { t: 0.22, rot: [58 * S, 0, 0] }, { t: 0.38, rot: [-8 * S, 0, 0] }, { t: 0.62, rot: [44 * S, 0, 0] }, { t: 0.85, rot: [50 * S, 0, 0] }, { t: 1.2, rot: [3 * S, 0, 0] }] },
                        { bone: 'lowerLeg_L', keys: [{ t: 0, rot: [-4 * S, 0, 0] }, { t: 0.22, rot: [-88 * S, 0, 0] }, { t: 0.38, rot: [-3 * S, 0, 0] }, { t: 0.62, rot: [-80 * S, 0, 0] }, { t: 0.85, rot: [-70 * S, 0, 0] }, { t: 1.2, rot: [-4 * S, 0, 0] }] },
                        { bone: 'foot_L', keys: [{ t: 0, rot: [2 * S, 0, 0] }, { t: 0.22, rot: [-26 * S, 0, 0] }, { t: 0.38, rot: [42 * S, 0, 0] }, { t: 0.62, rot: [24 * S, 0, 0] }, { t: 0.85, rot: [-14 * S, 0, 0] }, { t: 1.2, rot: [2 * S, 0, 0] }] },
                        { bone: 'shoulder_R', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.38, rot: [0, 0, -6] }, { t: 0.62, rot: [0, 0, -6] }, { t: 1.2, rot: [0, 0, 0] }] },
                        { bone: 'upperArm_R', keys: [{ t: 0, rot: [0, 0, -78] }, { t: 0.22, rot: [45 * S, 0, -85] }, { t: 0.38, rot: [-40 * S, 0, 40] }, { t: 0.62, rot: [15 * S, 0, 110] }, { t: 0.85, rot: [12 * S, 0, -95] }, { t: 1.2, rot: [0, 0, -78] }] },
                        { bone: 'forearm_R', keys: [{ t: 0, rot: [10 * S, 0, 0] }, { t: 0.22, rot: [48 * S, 0, 0] }, { t: 0.38, rot: [8 * S, 0, 0] }, { t: 0.62, rot: [22 * S, 0, 0] }, { t: 0.85, rot: [58 * S, 0, 0] }, { t: 1.2, rot: [10 * S, 0, 0] }] },
                        { bone: 'hand_R', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.38, rot: [-10 * S, 0, 0] }, { t: 1.2, rot: [0, 0, 0] }] },
                        { bone: 'shoulder_L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.38, rot: [0, 0, 6] }, { t: 0.62, rot: [0, 0, 6] }, { t: 1.2, rot: [0, 0, 0] }] },
                        { bone: 'upperArm_L', keys: [{ t: 0, rot: [0, 0, 78] }, { t: 0.22, rot: [45 * S, 0, 85] }, { t: 0.38, rot: [-40 * S, 0, -40] }, { t: 0.62, rot: [15 * S, 0, -110] }, { t: 0.85, rot: [12 * S, 0, 95] }, { t: 1.2, rot: [0, 0, 78] }] },
                        { bone: 'forearm_L', keys: [{ t: 0, rot: [10 * S, 0, 0] }, { t: 0.22, rot: [48 * S, 0, 0] }, { t: 0.38, rot: [8 * S, 0, 0] }, { t: 0.62, rot: [22 * S, 0, 0] }, { t: 0.85, rot: [58 * S, 0, 0] }, { t: 1.2, rot: [10 * S, 0, 0] }] },
                        { bone: 'hand_L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.38, rot: [-10 * S, 0, 0] }, { t: 1.2, rot: [0, 0, 0] }] }
                    ]
                };
                // Saluto: il braccio destro sale, il SINISTRO resta lungo il corpo. Prima
                // il sinistro non era animato affatto e restava dov'era, cioe' in T-pose.
                const newWave = {
                    name: 'wave', duration: 1.6, loop: true,
                    tracks: [
                        { bone: 'hips', keys: [{ t: 0, pos: [0, 0, 0], rot: [0, 0, 0] }, { t: 0.8, pos: [0, -0.03, 0], rot: [0, -2, 0] }, { t: 1.6, pos: [0, 0, 0], rot: [0, 0, 0] }] },
                        { bone: 'spine', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.8, rot: [0, -3, 1] }, { t: 1.6, rot: [0, 0, 0] }] },
                        { bone: 'chest', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.4, rot: [0, -4, 2] }, { t: 1.6, rot: [0, -4, 2] }] },
                        { bone: 'head', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.4, rot: [-3 * S, -6, 0] }, { t: 1.6, rot: [-3 * S, -6, 0] }] },
                        { bone: 'upperLeg_R', keys: [{ t: 0, rot: [2 * S, 0, 0] }, { t: 1.6, rot: [2 * S, 0, 0] }] },
                        { bone: 'lowerLeg_R', keys: [{ t: 0, rot: [-4 * S, 0, 0] }, { t: 1.6, rot: [-4 * S, 0, 0] }] },
                        { bone: 'upperLeg_L', keys: [{ t: 0, rot: [2 * S, 0, 0] }, { t: 1.6, rot: [2 * S, 0, 0] }] },
                        { bone: 'lowerLeg_L', keys: [{ t: 0, rot: [-4 * S, 0, 0] }, { t: 1.6, rot: [-4 * S, 0, 0] }] },
                        { bone: 'shoulder_R', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.4, rot: [0, 0, -12] }, { t: 1.6, rot: [0, 0, -12] }] },
                        { bone: 'upperArm_R', keys: [{ t: 0, rot: [0, 0, -78] }, { t: 0.4, rot: [-10 * S, 0, 148] }, { t: 1.6, rot: [-10 * S, 0, 148] }] },
                        { bone: 'forearm_R', keys: [{ t: 0, rot: [10 * S, 0, 0] }, { t: 0.4, rot: [0, 0, -14] }, { t: 0.7, rot: [0, 0, 20] }, { t: 1, rot: [0, 0, -14] }, { t: 1.3, rot: [0, 0, 20] }, { t: 1.6, rot: [0, 0, -14] }] },
                        { bone: 'hand_R', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.4, rot: [0, 0, -8] }, { t: 0.7, rot: [0, 0, 12] }, { t: 1, rot: [0, 0, -8] }, { t: 1.3, rot: [0, 0, 12] }, { t: 1.6, rot: [0, 0, -8] }] },
                        { bone: 'shoulder_L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1.6, rot: [0, 0, 0] }] },
                        { bone: 'upperArm_L', keys: [{ t: 0, rot: [0, 0, 78] }, { t: 0.8, rot: [3 * S, 0, 76] }, { t: 1.6, rot: [0, 0, 78] }] },
                        { bone: 'forearm_L', keys: [{ t: 0, rot: [12 * S, 0, 0] }, { t: 0.8, rot: [18 * S, 0, 0] }, { t: 1.6, rot: [12 * S, 0, 0] }] },
                        { bone: 'hand_L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1.6, rot: [0, 0, 0] }] }
                    ]
                };

                const animsToAdd = [newIdle, newWalk, newRun, newJump, newWave];
                for (const anim of animsToAdd) {
                    // I preset sono scritti nel frame canonico -> vanno coniugati (qFace).
                    const c = buildClipFromAnimData(anim, qFace);
                    if (c) { c.name = anim.name; rigClips.push(c); }
                }

                // Clip AI personalizzate salvate nel rig (Animation Director): le
                // ricostruiamo qui cosi' sopravvivono a save/load e a ogni applyRig.
                // NIENTE qFace: l'AI vede le ossa vere, scrive gia' nel frame giusto.
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
            //
            // `qFace` (opzionale) porta una clip scritta nel frame CANONICO (personaggio
            // rivolto a +Z) su uno scheletro girato di 90 o 270 gradi: le rotazioni si
            // coniugano, gli spostamenti si ruotano. Lo passano solo i preset, che sono
            // scritti nel frame canonico; le clip dell'AI arrivano gia' nel frame dello
            // scheletro reale (l'AI vede i nomi e le posizioni delle ossa vere) e quindi
            // non vanno toccate, altrimenti si ruoterebbero due volte.
            function buildClipFromAnimData(anim, qFace) {
                if (!skeleton || !anim || !Array.isArray(anim.tracks)) return null;
                const byName = {};
                rig.bones.forEach((bd, i) => byName[bd.name] = skeleton.bones[i]);
                const rad = d => (Number(d) || 0) * Math.PI / 180;
                const dur = Math.max(0.1, Number(anim.duration) || 1);
                const clampT = t => Math.min(dur, Math.max(0, Number(t) || 0));
                // Le traslazioni sono vettori, non rotazioni: si ruotano, non si coniugano.
                const yaw = qFace ? 2 * Math.atan2(qFace.y, qFace.w) : 0;
                const fCos = Math.cos(yaw), fSin = Math.sin(yaw);
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
                            const qq = faceRotate(
                                new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(k.rot[0]), rad(k.rot[1]), rad(k.rot[2]))),
                                qFace);
                            values.push(qq.x, qq.y, qq.z, qq.w);
                        });
                        tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
                    }
                    if (posKeys.length) {
                        const rest = bone.position.clone();
                        const times = [], values = [];
                        posKeys.forEach(k => {
                            times.push(clampT(k.t));
                            const dx = Number(k.pos[0]) || 0, dy = Number(k.pos[1]) || 0, dz = Number(k.pos[2]) || 0;
                            values.push(rest.x + dx * fCos + dz * fSin, rest.y + dy, rest.z + (-dx * fSin + dz * fCos));
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

            // --- Spazio = pausa/riprendi l'animazione DOV'E' -------------------------
            // `currentAction.stop()` riavvolge: ripartire vorrebbe dire rivedere la clip
            // da zero. `action.paused` invece congela il tempo interno dell'action, quindi
            // riprendendo si riparte esattamente dal fotogramma in cui si era.
            //
            // La timeline ha gia' il suo Spazio, ma solo quando il suo pannello e' aperto
            // (33-timeline.js, listener in CAPTURE). Chi anima dalla tab Rig senza aprire
            // la timeline non aveva nessun modo di fermare la clip: questo e' il ripiego
            // globale, e si tira indietro appena la timeline e' a schermo per non
            // toggleare due volte lo stesso stato.
            function toggleClipPlayback() {
                if (!currentAction) return false;
                currentAction.paused = !currentAction.paused;
                if (typeof requestRender === 'function') requestRender();
                return true;
            }
            window.addEventListener('keydown', (ev) => {
                // Stesso tasto della timeline: arriva da KEYMAP.togglePlay, che e'
                // rimappabile dal pannello Scorciatoie. Se qui restasse fisso lo spazio,
                // rimappando il tasto la timeline ubbidirebbe e la tab Rig no.
                const bound = (typeof KEYMAP !== 'undefined' && KEYMAP && KEYMAP.togglePlay) || ' ';
                const isBound = ev.key === bound
                    || (bound === ' ' && ev.key === 'Spacebar');
                if (!isBound) return;
                if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
                if (typeof tlIsVisible === 'function' && tlIsVisible()) return;  // ci pensa la timeline
                // Lo spazio e' un carattere: dentro un campo di testo deve restare tale.
                // Anche su un bottone va lasciato passare, perche' li' lo spazio e' il
                // "clic" da tastiera e ce ne serve uno per aprire le sezioni richiudibili.
                if (isTypingTarget(ev)) return;
                const el = ev.target;
                if (el && (el.tagName === 'BUTTON' || el.tagName === 'SELECT'
                    || el.getAttribute('role') === 'button')) return;
                if (toggleClipPlayback()) ev.preventDefault();
            });

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
                    playBtn.addEventListener('click', () => {
                        animSelect.value = a.name;
                        animSelect.dispatchEvent(new Event('change'));
                        if (typeof window.tlForcePlay === 'function') window.tlForcePlay();
                    });
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
                animSelect.dispatchEvent(new Event('change'));
                if (typeof window.tlForcePlay === 'function') window.tlForcePlay();
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
                if (!rig || !rig.bones || !rig.bones.length) { alert("Prima crea uno scheletro (Rig) per l'oggetto."); return; }
                const show = animForm.style.display === 'none' || !animForm.style.display;
                animForm.style.display = show ? 'flex' : 'none';
                if (show) animPromptInput.focus();
            });
            if (animCancelBtn) animCancelBtn.addEventListener('click', () => {
                animForm.style.display = 'none';
                animNameInput.value = ''; animPromptInput.value = '';
            });

            if (animGenerateBtn) animGenerateBtn.addEventListener('click', () => {
                if (!rig || !skeleton) { alert("Scheletro non pronto."); return; }
                const desc = animPromptInput.value.trim();
                if (!desc) { alert("Descrivi l'animazione da generare."); return; }
                const boneNames = rig.bones.map(b => b.name);
                const origHtml = animGenerateBtn.innerHTML;
                animGenerateBtn.disabled = true;
                animGenerateBtn.innerHTML = '<span class="spinner"></span> Genero...';
                fetch(animApiUrl(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: desc, bones: boneNames, model: (typeof modelSelect !== 'undefined' && modelSelect ? modelSelect.value : undefined) })
                })
                    .then(res => res.ok ? res.json() : res.json().then(e => {
                        // /api/animate risponde con diagnostica ricca (ossa inventate
                        // dall'AI, ossa realmente disponibili, avvisi): la portiamo
                        // sull'Error cosi' il catch la puo' mostrare all'utente.
                        const ex = new Error(e.error || t('rig.anim.errGeneric'));
                        ex.unknownBones   = Array.isArray(e.unknownBones) ? e.unknownBones : [];
                        ex.availableBones = Array.isArray(e.availableBones) ? e.availableBones : [];
                        ex.warnings       = Array.isArray(e.warnings) ? e.warnings : [];
                        throw ex;
                    }))
                    .then(anim => {
                        if (!anim || !Array.isArray(anim.tracks) || !anim.tracks.length) throw new Error("L'AI non ha restituito track validi.");
                        if (animNameInput.value.trim()) anim.name = animNameInput.value.trim();
                        const test = buildClipFromAnimData(anim);
                        if (!test) throw new Error("Nessun osso valido nei track generati.");
                        const finalName = addCustomAnim(anim);
                        animForm.style.display = 'none';
                        animNameInput.value = ''; animPromptInput.value = '';
                        rigHint.textContent = `Animazione "${finalName}" creata e in riproduzione.`;
                    })
                    .catch(err => alert('Errore animazione: ' + err.message))
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
                if (!voxels.length) { rigHint.textContent = 'Nessun voxel da riggare. Genera o carica un modello prima.'; return; }
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
            // PRIMO DRAG: il proxy va riallineato PRIMA che TransformControls lo guardi.
            // In r128 pointerDown fotografa _quaternionStart dal proxy (tc r128 :245) e
            // solo DOPO mette dragging = true (:254), che e' cio' che emette
            // 'dragging-changed' -> onGizmoDragStart. Quindi onGizmoDragStart arriva
            // sempre troppo tardi per correggere un proxy stantio, e onGizmoChange
            // scrive la posa in ASSOLUTO: il primo movimento del mouse portava la posa
            // all'orientamento del PROXY invece che a quello dell'osso (posa "che non
            // c'entra nulla", poi Ctrl+Z, poi tutto bene perche' onGizmoDragEnd
            // risincronizza). Ascoltando in CAPTURE su window arriviamo prima del
            // listener di TC, che e' registrato sul canvas: la fotografia trova un
            // proxy corretto.
            //
            // Non serve sapere QUALE percorso lascia il proxy stantio (selezione osso,
            // scrub della timeline, mixer di una clip...): qui si risincronizza a ogni
            // pressione, quindi vanno tutti bene.
            window.addEventListener('pointerdown', () => {
                // A trascinamento in corso NON si tocca: risincronizzare a meta' gesto
                // butterebbe via la rotazione appena fatta.
                if (transformControls.dragging) return;
                if (!transformControls.enabled || !transformControls.object) return;
                syncGizmoToBone();
            }, true);
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
                selectBone(bi);
                if (typeof updateGizmo === 'function') updateGizmo();
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

            // Toast di conferma. Prima ogni scorciatoia si ricostruiva il proprio div con
            // 200 caratteri di style inline: una copia per messaggio, e nessuna traducibile.
            function rigToast(msg) {
                const el = document.createElement('div');
                el.className = 'rig-toast';
                el.textContent = msg;
                document.body.appendChild(el);
                setTimeout(() => {
                    el.style.opacity = '0';
                    setTimeout(() => el.remove(), 300);
                }, 1500);
            }

            // --- QOL Shortcuts ---
            window.poseClipboard = null;
            window.addEventListener('keydown', (ev) => {
                if (!rigPreviewActive) return;
                if (isTypingTarget(ev)) return;
                
                // Ctrl+SHIFT+A: ambito "inserisci chiave su tutte le ossa".
                // Ctrl+A liscio e' della timeline (seleziona i keyframe): erano due
                // funzioni diverse sulla stessa scorciatoia, e vinceva chi capitava.
                if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === 'a' || ev.key === 'A')) {
                    ev.preventDefault();
                    if (typeof window.tlSetKeyAllBones === 'function') {
                        window.tlSetKeyAllBones(true);
                        rigToast(t('rig.allBonesKeyed'));
                    }
                }
                
                // I: Inserisci chiave (Forza anche se la timeline è chiusa)
                if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === 'i' || ev.key === 'I')) {
                    if (typeof window.tlForceInsertKey === 'function') {
                        ev.preventDefault();
                        window.tlForceInsertKey();
                    }
                }

                // Ctrl+C: Copia posa
                if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'c' || ev.key === 'C')) {
                    ev.preventDefault();
                    if (rig && rig.pose) {
                        window.poseClipboard = JSON.parse(JSON.stringify(rig.pose));
                        rigToast(t('rig.poseCopied'));
                    }
                }

                // Ctrl+V: Incolla posa (mostrando modale per il mirror)
                if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'v' || ev.key === 'V')) {
                    ev.preventDefault();
                    if (window.poseClipboard && rig) {
                        showPasteMirrorModal(window.poseClipboard);
                    }
                }

                // Alt+R: Reset posa osso selezionato
                if (ev.altKey && (ev.key === 'r' || ev.key === 'R')) {
                    ev.preventDefault();
                    if (selectedBoneIndex >= 0 && rig.bones[selectedBoneIndex] && rig.pose) {
                        const boneName = rig.bones[selectedBoneIndex].name;
                        delete rig.pose[boneName]; // Rimuove le rotazioni/posizioni di questo osso per farlo tornare a T-Pose
                        applyPoseToBones();
                        if (typeof tlSyncPoseSliders === 'function') tlSyncPoseSliders();
                        if (typeof syncGizmoToBone === 'function') syncGizmoToBone();
                        if (typeof requestRender === 'function') requestRender();
                        // Ultima copia scritta a mano del toast: usava
                        // background:var(--primary), una variabile che in questo
                        // progetto non esiste (i token sono --accent-*), quindi lo
                        // sfondo era trasparente e il testo bianco si leggeva a
                        // fatica sopra la viewport. E il messaggio era italiano
                        // hardcoded. rigToast + la classe .rig-toast risolvono
                        // entrambe le cose.
                        rigToast(t('rig.bonePoseReset'));
                    }
                }
            });

            function showPasteMirrorModal(clip) {
                const toast = document.createElement('div');
                toast.style.cssText = "position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--inset-bg); border:1px solid var(--glass-border); color:var(--text); padding:12px 20px; border-radius:8px; z-index:9999; display:flex; gap:12px; align-items:center; box-shadow:0 4px 12px rgba(0,0,0,0.5);";
                const label = document.createElement('label');
                label.style.cssText = "display:flex; gap:6px; align-items:center; cursor:pointer; font-size:13px; margin:0;";
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                label.appendChild(cb);
                label.appendChild(document.createTextNode('Specchia Posa (Mirror)'));
                
                const btnOk = document.createElement('button');
                btnOk.className = 'btn btn-primary';
                btnOk.textContent = 'Applica';
                btnOk.style.padding = '4px 12px';
                
                const btnCancel = document.createElement('button');
                btnCancel.className = 'btn btn-secondary';
                btnCancel.textContent = 'Annulla';
                btnCancel.style.padding = '4px 12px';

                toast.appendChild(label);
                toast.appendChild(btnOk);
                toast.appendChild(btnCancel);
                document.body.appendChild(toast);

                function doPaste() {
                    const mirror = cb.checked;
                    applyClipboardPose(clip, mirror);
                    toast.remove();
                    if (typeof window.tlInsertKeyDirect === 'function') {
                        window.tlInsertKeyDirect('locrot');
                    }
                }

                cb.addEventListener('change', () => {
                    applyClipboardPose(clip, cb.checked);
                });

                btnOk.addEventListener('click', doPaste);
                btnCancel.addEventListener('click', () => {
                    toast.remove();
                    // Volendo potremmo annullare, ma per farlo dovremmo salvare la vecchia posa. 
                    // Essendo live preview, applichiamo quella corrente
                    applyPoseToBones();
                });

                // Live preview iniziale (non specchiata)
                applyClipboardPose(clip, false);
            }

            function applyClipboardPose(clip, mirror) {
                if (!rig.pose) rig.pose = {};
                for (const boneName in clip) {
                    let targetName = boneName;
                    let p = clip[boneName];
                    if (mirror) {
                        if (boneName.endsWith('_L')) targetName = boneName.replace('_L', '_R');
                        else if (boneName.endsWith('_R')) targetName = boneName.replace('_R', '_L');
                        else if (boneName.endsWith('.L')) targetName = boneName.replace('.L', '.R');
                        else if (boneName.endsWith('.R')) targetName = boneName.replace('.R', '.L');
                        
                        // Specchia Euler Y e Z. La X rimane identica? 
                        // In uno scheletro simmetrico solitamente l'asse Y e Z sono invertiti
                        // Questo dipende da come sono orientate le ossa. Assumiamo Y e Z negati.
                        p = [p[0], -p[1], -p[2]];
                    }
                    rig.pose[targetName] = p;
                }
                applyPoseToBones();
                if (typeof tlSyncPoseSliders === 'function') tlSyncPoseSliders();
                if (typeof syncGizmoToBone === 'function') syncGizmoToBone();
                if (typeof requestRender === 'function') requestRender();
            }

            // --- CUBE_FACES: shared cube face table (used by GLB static export) -----
