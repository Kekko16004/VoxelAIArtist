            /* ============== RIG TOOLS: simmetria, IK, editing ossa, pose =============
               Cinque strumenti costruiti SOPRA il rig automatico di 15-rig.js, non in
               sostituzione: si parte sempre dallo scheletro generato e lo si corregge.

                 1. Specchia posa / pesi su X  - dimezza il lavoro sui personaggi simmetrici
                 2. Simmetrizza scheletro      - dopo le correzioni con G, L e R ricombaciano
                 3. Punta arto (IK a due ossa) - invece di ruotare tre ossa a mano
                 4. Aggiungi / rinomina / elimina ossa
                 5. Libreria di pose riusabili fra oggetti

               DUE INVARIANTI SU CUI POGGIA TUTTO IL FILE:

               a) Nella posa di riposo le ossa NON hanno rotazione (buildSkinnedMesh imposta
                  solo bone.position), quindi il frame locale di ogni osso e' allineato agli
                  assi del mondo. Uno specchio su X diventa percio' la regola semplice
                  (rx, ry, rz) -> (rx, -ry, -rz), e le direzioni mondo si convertono in
                  rotazioni locali con un solo setFromUnitVectors contro il quaternione
                  del genitore.
               b) Il NOME e' l'identita' dell'osso: rig.pose, rig.weights e i track delle
                  animazioni AI lo citano per nome. Ogni rinomina o eliminazione deve
                  migrarli tutti e tre, altrimenti una posa resta appesa a un osso che non
                  esiste piu' (e riappare se qualcuno ricrea quel nome). */

            // --- Nomi e lati ---------------------------------------------------------
            function mirrorBoneName(name) {
                if (typeof name !== 'string') return null;
                if (name.endsWith('_L')) return name.slice(0, -2) + '_R';
                if (name.endsWith('_R')) return name.slice(0, -2) + '_L';
                return null;                     // osso centrale: non ha gemello
            }
            function boneSideOf(name) {
                if (typeof name !== 'string') return '';
                return name.endsWith('_L') ? 'L' : name.endsWith('_R') ? 'R' : '';
            }
            function uniqueBoneName(bones, base) {
                let name = String(base || 'osso').trim().replace(/\s+/g, '_') || 'osso';
                const taken = new Set(bones.map(b => b.name));
                if (!taken.has(name)) return name;
                let i = 2;
                while (taken.has(name + '_' + i)) i++;
                return name + '_' + i;
            }

            // --- Vettori (array [x,y,z], zero dipendenze da THREE: cosi' la matematica
            //     dell'IK e' testabile in Node senza browser) --------------------------
            function rtSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
            function rtAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
            function rtMul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
            function rtDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
            function rtLen(a) { return Math.hypot(a[0], a[1], a[2]); }
            function rtNorm(a) { const l = rtLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

            // === 1. SPECCHIO SU X ====================================================
            // `dir`:  'LtoR' copia il lato L sul lato R, 'RtoL' il contrario,
            //         'both' scambia i due lati (specchio vero di TUTTA la posa: solo qui
            //         hanno senso anche le ossa centrali, che si specchiano su se stesse).
            // Ritorna una posa NUOVA: chi chiama decide se assegnarla (cosi' il conteggio
            // permette di scartare uno snapshot di undo inutile).
            function mirrorPoseData(bones, pose, dir) {
                const src = pose || {};
                const out = {};
                Object.keys(src).forEach(k => { out[k] = Array.isArray(src[k]) ? src[k].slice() : [0, 0, 0]; });
                const names = new Set(bones.map(b => b.name));
                const flip = (r) => [r[0], -r[1], -r[2]];
                const want = dir === 'RtoL' ? 'L' : 'R';    // lato che riceve
                let changed = 0;
                bones.forEach(bd => {
                    const side = boneSideOf(bd.name);
                    if (!side) {
                        if (dir !== 'both') return;         // copia L->R: il centro non si tocca
                        const cur = src[bd.name];
                        if (!cur) return;
                        const f = flip(cur);
                        if (f[1] !== cur[1] || f[2] !== cur[2]) changed++;
                        out[bd.name] = f;
                        return;
                    }
                    if (dir !== 'both' && side !== want) return;
                    const twin = mirrorBoneName(bd.name);
                    if (!names.has(twin)) return;           // arto senza gemello: niente da copiare
                    const from = src[twin];
                    if (!from) {
                        if (out[bd.name]) { delete out[bd.name]; changed++; }
                        return;
                    }
                    out[bd.name] = flip(from);
                    changed++;
                });
                return { pose: out, changed };
            }

            // Una voce di rig.weights puo' essere:
            //   - una STRINGA  "forearm_L"          (forma storica, peso rigido 1.0)
            //   - un OGGETTO   {forearm_L: 0.7, upperArm_L: 0.3}  (weight paint graduale)
            // Tutto cio' che tocca i NOMI delle ossa deve reggere entrambe le forme, o il
            // rinomina/elimina/specchia si mangia i pesi dipinti. Qui la mappatura del
            // nome e' un parametro (fn), cosi' un'unica funzione serve i tre casi.
            // Ritorna null quando la voce si svuota (nessun osso sopravvissuto).
            function remapWeightEntry(entry, fn) {
                if (typeof entry === 'string') {
                    const n = fn(entry);
                    return n || null;
                }
                if (!entry || typeof entry !== 'object') return null;
                const out = {};
                let any = false;
                Object.keys(entry).forEach(name => {
                    const n = fn(name);
                    if (!n) return;                          // osso sparito: il suo peso cade
                    const w = Number(entry[name]);
                    if (!isFinite(w) || w <= 0) return;
                    out[n] = (out[n] || 0) + w;              // due ossa fuse nello stesso nome
                    any = true;
                });
                if (!any) return null;
                // Il peso residuo va rinormalizzato: se un osso e' stato eliminato la somma
                // scende sotto 1 e la mesh si "sgonfia" verso l'origine dello scheletro.
                let sum = 0;
                Object.keys(out).forEach(n => { sum += out[n]; });
                if (sum > 0) Object.keys(out).forEach(n => { out[n] = out[n] / sum; });
                return out;
            }

            // Specchio delle CORREZIONI dei pesi (rig.weights: "x,y,z" -> osso o {osso:peso}).
            // Il voxel gemello e' x' = minX + maxX - x; se in quel punto il modello non ha
            // un voxel la correzione si scarta (modello non simmetrico li'), altrimenti
            // scriveremmo dati morti che pruneWeightOverrides butterebbe comunque.
            // Ogni osso bersaglio passa al suo gemello (hand_L -> hand_R) quando esiste.
            function mirrorWeightsData(voxels, bones, weights, dir) {
                if (!weights) return { weights: null, copied: 0, skipped: 0 };
                const keys = Object.keys(weights);
                if (!keys.length) return { weights: null, copied: 0, skipped: 0 };
                const b = voxelBounds(voxels);
                const mx = b.minX + b.maxX, cx = b.cx;
                const live = new Set();
                voxels.forEach(v => live.add(v.x + ',' + v.y + ',' + v.z));
                const names = new Set(bones.map(bd => bd.name));
                const out = {};
                keys.forEach(k => { out[k] = weights[k]; });
                let copied = 0, skipped = 0;
                keys.forEach(k => {
                    const p = k.split(',');
                    const x = Number(p[0]);
                    if (!isFinite(x)) return;
                    const side = x < cx ? 'L' : x > cx ? 'R' : '';
                    if (!side) return;                       // voxel sull'asse: e' il suo gemello
                    if (dir === 'LtoR' && side !== 'L') return;
                    if (dir === 'RtoL' && side !== 'R') return;
                    const key2 = (mx - x) + ',' + p[1] + ',' + p[2];
                    if (!live.has(key2)) { skipped++; return; }
                    const mapped = remapWeightEntry(weights[k], name => {
                        const twin = mirrorBoneName(name);
                        return (twin && names.has(twin)) ? twin : name;
                    });
                    if (!mapped) { skipped++; return; }
                    out[key2] = mapped;
                    copied++;
                });
                return { weights: Object.keys(out).length ? out : null, copied, skipped };
            }

            // === 2. SIMMETRIZZA LO SCHELETRO =========================================
            // Dopo qualche correzione con G (sposta giunto) il braccio destro non e' piu'
            // il gemello del sinistro: le clip lo mostrano subito come una camminata
            // sbilenca. Qui si riporta la simmetria sui VOXEL (asse mx/2), non sulla media
            // delle ossa:
            //   - 'LtoR' / 'RtoL' copiano un lato sull'altro (una sorgente, decisa da te);
            //   - 'both' fa la MEDIA dei due lati, utile quando entrambi sono stati toccati;
            //   - le ossa centrali (senza suffisso) vengono agganciate esattamente all'asse,
            //     altrimenti la colonna resta di sbieco e nessuno dei due lati combacia.
            function symmetrizeBonesData(bones, voxels, dir) {
                const b = voxelBounds(voxels);
                const mx = b.minX + b.maxX, cx = b.cx;
                const idx = new Map();
                bones.forEach((bd, i) => idx.set(bd.name, i));
                const out = bones.map(bd => Object.assign({}, bd, { head: bd.head.slice(), tail: bd.tail.slice() }));
                const moved2 = (a, c) => (Math.abs(a[0] - c[0]) > 1e-6 || Math.abs(a[1] - c[1]) > 1e-6 || Math.abs(a[2] - c[2]) > 1e-6);
                const want = dir === 'RtoL' ? 'L' : 'R';
                let moved = 0, pairs = 0, centred = 0;
                out.forEach((bd, i) => {
                    const side = boneSideOf(bd.name);
                    if (!side) {
                        if (Math.abs(bd.head[0] - cx) > 1e-6 || Math.abs(bd.tail[0] - cx) > 1e-6) centred++;
                        bd.head[0] = cx; bd.tail[0] = cx;
                        return;
                    }
                    const j = idx.get(mirrorBoneName(bd.name));
                    if (j === undefined) return;              // arto spaiato: lasciato com'e'
                    const src = bones[j];                     // sempre dall'array ORIGINALE
                    const self = bones[i];
                    const mir = { head: [mx - src.head[0], src.head[1], src.head[2]], tail: [mx - src.tail[0], src.tail[1], src.tail[2]] };
                    let head, tail;
                    if (dir === 'both') {
                        // La media di un punto col gemello riflesso e' simmetrica per
                        // costruzione: calcolarla su ciascun osso separatamente da' lo
                        // stesso risultato, quindi non serve trattare la coppia insieme.
                        head = [(self.head[0] + mir.head[0]) / 2, (self.head[1] + mir.head[1]) / 2, (self.head[2] + mir.head[2]) / 2];
                        tail = [(self.tail[0] + mir.tail[0]) / 2, (self.tail[1] + mir.tail[1]) / 2, (self.tail[2] + mir.tail[2]) / 2];
                        pairs++;
                    } else {
                        if (side !== want) return;             // questo e' il lato sorgente
                        head = mir.head; tail = mir.tail;
                        pairs++;
                    }
                    if (moved2(head, self.head) || moved2(tail, self.tail)) moved++;
                    bd.head = head; bd.tail = tail;
                });
                return { bones: out, moved, pairs, centred };
            }

            // === 4. EDITING DELLE OSSA (aggiungi / rinomina / elimina) ================
            // Si parte SEMPRE dallo scheletro automatico: queste tre operazioni lo
            // correggono (una coda in piu', un nome parlante, un osso di troppo via) senza
            // costringere a costruire un rig da zero.

            // Nuovo osso figlio: nasce sulla CODA del genitore e prosegue nella sua stessa
            // direzione, lungo il 60%. Viene aggiunto in fondo all'array, quindi nessun
            // indice `parent` esistente cambia.
            function rigAddChildBone(rigData, parentIndex, name) {
                if (!rigData || !Array.isArray(rigData.bones)) return -1;
                const p = rigData.bones[parentIndex];
                if (!p) return -1;
                const d = rtSub(p.tail, p.head);
                const len = rtLen(d) || 1;
                const u = len > 1e-6 ? rtNorm(d) : [0, 1, 0];
                const L = Math.max(1, len * 0.6);
                const head = p.tail.slice();
                const nm = uniqueBoneName(rigData.bones, name || (p.name + '_new'));
                rigData.bones.push({ name: nm, parent: parentIndex, head, tail: rtAdd(head, rtMul(u, L)) });
                return rigData.bones.length - 1;
            }

            // Rinomina migrando TUTTO cio' che cita il nome (vedi invariante (b) in testa
            // al file): posa, correzioni dei pesi e track delle animazioni AI.
            function rigRenameBone(rigData, index, newName) {
                if (!rigData || !rigData.bones || !rigData.bones[index]) return t('rigTools.boneMissing');
                const bd = rigData.bones[index];
                const name = String(newName == null ? '' : newName).trim().replace(/\s+/g, '_');
                if (!name) return t('rigTools.nameEmpty');
                if (!/^[A-Za-z0-9_.\-]+$/.test(name)) return t('rigTools.nameCharset');
                if (name === bd.name) return null;
                if (rigData.bones.some((o, i) => i !== index && o.name === name)) return t('rigTools.nameTaken');
                const old = bd.name;
                bd.name = name;
                if (rigData.pose && rigData.pose[old] !== undefined) {
                    rigData.pose[name] = rigData.pose[old];
                    delete rigData.pose[old];
                }
                if (rigData.weights) {
                    // Vale sia per le voci-stringa che per i pesi graduali {osso: peso}.
                    Object.keys(rigData.weights).forEach(k => {
                        const m = remapWeightEntry(rigData.weights[k], n => (n === old ? name : n));
                        if (m) rigData.weights[k] = m; else delete rigData.weights[k];
                    });
                    if (!Object.keys(rigData.weights).length) rigData.weights = null;
                }
                (rigData.customAnims || []).forEach(a => {
                    (a && Array.isArray(a.tracks) ? a.tracks : []).forEach(tr => {
                        if (tr && tr.bone === old) tr.bone = name;
                    });
                });
                return null;
            }

            // Elimina un osso. Tre cose vanno fatte insieme, o il rig resta incoerente:
            //   1) le punte helper attaccate all'osso muoiono con lui (esistono solo per
            //      dargli orientamento in Blender, da sole non significano niente);
            //   2) i figli VERI passano al genitore dell'osso rimosso, cosi' l'arto non si
            //      stacca dalla catena;
            //   3) `parent` e' un INDICE: rimuovendo una riga tutti gli indici successivi
            //      slittano e vanno rimappati. Senza questo passaggio il rig si riattacca
            //      a ossa casuali (era il bug classico degli editor di scheletri).
            // Ritorna {error, select}: l'indice su cui riportare la selezione.
            function rigDeleteBone(rigData, index) {
                if (!rigData || !rigData.bones || !rigData.bones[index]) return { error: t('rigTools.boneMissing'), select: -1 };
                const bones = rigData.bones;
                if (bones.filter(b => !b.helper).length <= 1) {
                    return { error: t('rigTools.lastBone'), select: index };
                }
                const remove = new Set([index]);
                bones.forEach((o, i) => { if (o.helper && o.parent === index) remove.add(i); });
                const goneNames = new Set([...remove].map(i => bones[i].name));
                const parentOf = bones[index].parent;

                const remap = new Array(bones.length).fill(-1);
                const keep = [];
                bones.forEach((o, i) => { if (!remove.has(i)) { remap[i] = keep.length; keep.push(o); } });
                keep.forEach(o => {
                    let p = o.parent;
                    while (p >= 0 && remove.has(p)) p = bones[p].parent;   // salta gli antenati rimossi
                    o.parent = p >= 0 ? remap[p] : -1;
                });
                rigData.bones = keep;

                if (rigData.pose) goneNames.forEach(n => { delete rigData.pose[n]; });
                if (rigData.weights) {
                    // Con i pesi graduali il voxel non muore per forza: perde solo la quota
                    // dell'osso eliminato e il resto viene rinormalizzato.
                    Object.keys(rigData.weights).forEach(k => {
                        const m = remapWeightEntry(rigData.weights[k], n => (goneNames.has(n) ? null : n));
                        if (m) rigData.weights[k] = m; else delete rigData.weights[k];
                    });
                    if (!Object.keys(rigData.weights).length) rigData.weights = null;
                }
                (rigData.customAnims || []).forEach(a => {
                    if (a && Array.isArray(a.tracks)) a.tracks = a.tracks.filter(tr => tr && !goneNames.has(tr.bone));
                });
                let select = parentOf >= 0 ? remap[parentOf] : -1;
                if (select < 0) select = keep.findIndex(b => !b.helper);
                return { error: null, select, removed: goneNames.size };
            }

            // === 3. IK RAPIDA A DUE OSSA =============================================
            // Legge dei coseni: dato il punto di attacco (spalla/anca), il bersaglio e le
            // due lunghezze, esiste una sola circonferenza di posizioni possibili per il
            // gomito; `bendHint` sceglie da che parte piegarlo (gomito indietro, ginocchio
            // avanti). Se il bersaglio e' fuori portata la distanza viene CLAMPATA: l'arto
            // si stende verso il punto invece di produrre un NaN e sparire.
            function solveTwoBoneIK(root, target, l1, l2, bendHint) {
                const toT = rtSub(target, root);
                const dist = rtLen(toT);
                const minD = Math.abs(l1 - l2) + 1e-4;
                const maxD = l1 + l2 - 1e-4;
                const d = Math.max(minD, Math.min(maxD, dist || minD));
                const dir = dist > 1e-6 ? rtNorm(toT) : [0, -1, 0];
                const a = (d * d + l1 * l1 - l2 * l2) / (2 * d);
                const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
                // Componente del suggerimento ortogonale alla direzione del bersaglio.
                let side = rtSub(bendHint, rtMul(dir, rtDot(bendHint, dir)));
                if (rtLen(side) < 1e-6) {
                    const alt = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
                    side = rtSub(alt, rtMul(dir, rtDot(alt, dir)));
                }
                side = rtNorm(side);
                return {
                    elbow: rtAdd(root, rtAdd(rtMul(dir, a), rtMul(side, h))),
                    effector: rtAdd(root, rtMul(dir, d)),
                    reachable: dist <= maxD + 1e-4 && dist >= minD - 1e-4,
                    dist
                };
            }

            // Quale catena muovere partendo dall'osso selezionato. Per gli arti umanoidi la
            // coppia giusta e' nota dai nomi (upperArm+forearm, upperLeg+lowerLeg) anche se
            // hai cliccato la mano o il piede: e' quello che uno si aspetta trascinando la
            // mano. Altrimenti si usa osso selezionato + suo genitore; se non c'e' genitore
            // utile, si punta il singolo osso.
            function ikChainForBone(bones, index) {
                const bd = bones && bones[index];
                if (!bd) return null;
                const pair = (aName, bName) => {
                    const i = bones.findIndex(b => b.name === aName);
                    const j = bones.findIndex(b => b.name === bName);
                    return (i >= 0 && j >= 0 && bones[j].parent === i) ? [i, j] : null;
                };
                const arm = bd.name.match(/^(?:upperArm|forearm|hand|handTip)(_[LR])$/);
                if (arm) { const c = pair('upperArm' + arm[1], 'forearm' + arm[1]); if (c) return c; }
                const leg = bd.name.match(/^(?:upperLeg|lowerLeg|foot|toeTip)(_[LR])$/);
                if (leg) { const c = pair('upperLeg' + leg[1], 'lowerLeg' + leg[1]); if (c) return c; }
                if (bd.parent >= 0 && bones[bd.parent] && !bones[bd.parent].helper) return [bd.parent, index];
                return [index];
            }

            // === 5. LIBRERIA DI POSE =================================================
            // Una posa e' solo {nomeOsso: [rx,ry,rz]}: se due oggetti condividono i nomi
            // delle ossa (tutti gli umanoidi generati da Auto-Rig lo fanno) la stessa posa
            // vale per entrambi. Si applica solo alle ossa PRESENTI e si dice quante hanno
            // fatto match, cosi' se salvi una posa da un umanoide e la applichi a una spada
            // te ne accorgi subito invece di vedere "niente".
            const POSE_LIB_KEY = 'voxelai-pose-library';
            const POSE_LIB_MAX = 60;

            function poseLibLoad() {
                try {
                    const raw = localStorage.getItem(POSE_LIB_KEY);
                    const arr = raw ? JSON.parse(raw) : [];
                    return Array.isArray(arr) ? arr.filter(e => e && e.name && e.pose) : [];
                } catch (e) { return []; }
            }
            function poseLibSave(list) {
                try { localStorage.setItem(POSE_LIB_KEY, JSON.stringify(list.slice(0, POSE_LIB_MAX))); }
                catch (e) { console.warn('[pose] salvataggio libreria fallito:', e); }
            }

            // Filtra una posa salvata sulle ossa dello scheletro corrente.
            function poseForBones(savedPose, bones) {
                const names = new Set((bones || []).map(b => b.name));
                const pose = {};
                let applied = 0;
                const missing = [];
                Object.keys(savedPose || {}).forEach(n => {
                    const r = savedPose[n];
                    if (!Array.isArray(r) || r.length < 3) return;
                    if (!names.has(n)) { missing.push(n); return; }
                    pose[n] = [Number(r[0]) || 0, Number(r[1]) || 0, Number(r[2]) || 0];
                    applied++;
                });
                return { pose, applied, missing };
            }

            // === COMANDI DELLA UI ====================================================
            const rigMirrorDirControl = document.getElementById('mirrorDir');
            const mirrorPoseBtn = document.getElementById('mirrorPoseBtn');
            const mirrorWeightsBtn = document.getElementById('mirrorWeightsBtn');
            const symSkeletonBtn = document.getElementById('symSkeletonBtn');
            const boneAddBtn = document.getElementById('boneAddBtn');
            const boneRenameBtn = document.getElementById('boneRenameBtn');
            const boneDelBtn = document.getElementById('boneDelBtn');
            const ikToggleBtn = document.getElementById('ikToggleBtn');
            const ikHintEl = document.getElementById('ikHint');
            const poseSaveBtn = document.getElementById('poseSaveBtn');
            const poseLibListEl = document.getElementById('poseLibList');
            const poseLibEmptyEl = document.getElementById('poseLibEmpty');

            // Le ossa _L stanno a x BASSA e le _R a x alta (vedi buildHumanoidSkeleton).
            let mirrorDir = 'LtoR';          // 'LtoR' | 'RtoL' | 'both'
            function mirrorDirLabel() {
                return mirrorDir === 'RtoL' ? t('rigTools.dirRtoL')
                    : mirrorDir === 'both' ? t('rigTools.dirSwap') : t('rigTools.dirLtoR');
            }

            function rigToolsReady() {
                if (!rig || !rig.bones || !rig.bones.length) {
                    alert(t('rig.needAutoRig'));
                    return false;
                }
                return true;
            }

            // Scarta la snapshot appena spinta quando l'operazione non ha cambiato niente:
            // un Ctrl+Z che non fa nulla e' peggio che non avere l'undo.
            function dropLastHistory() {
                if (typeof undoStack !== 'undefined' && undoStack && undoStack.length) {
                    undoStack.pop();
                    if (typeof updateHistoryButtons === 'function') updateHistoryButtons();
                }
            }

            // Ricostruisce l'anteprima dopo una modifica STRUTTURALE (ossa o pesi)
            // preservando selezione e modalita' pittura: applyRig passa da clearRigPreview,
            // che uscirebbe dalla pittura perdendo la posa parcheggiata in poseBeforePaint.
            function rebuildRigPreserving(selectIndex) {
                const wasPainting = weightPaintActive;
                if (wasPainting) setWeightPaint(false);
                stashRigToActiveObject();
                applyRig();
                const bones = (rig && rig.bones) ? rig.bones : [];
                let sel = (selectIndex >= 0 && bones[selectIndex] && !bones[selectIndex].helper)
                    ? selectIndex : firstSelectableBone();
                if (sel >= 0) selectBone(sel);
                if (wasPainting) setWeightPaint(true);
                if (typeof requestRender === 'function') requestRender();
            }

            // Aggiorna l'anteprima dopo un cambio di sola POSA (nessun rebind).
            function refreshPoseUI() {
                if (currentAction) { currentAction.stop(); currentAction = null; if (animSelect) animSelect.value = 'none'; }
                applyPoseToBones();
                if (selectedBoneIndex >= 0) selectBone(selectedBoneIndex);
                if (typeof syncGizmoToBone === 'function') syncGizmoToBone();
                if (typeof requestRender === 'function') requestRender();
            }

            // In pittura pesi la posa vera e' parcheggiata in poseBeforePaint (rig.pose e'
            // azzerata per poter cliccare nel punto giusto): lavoriamo su quella.
            function rigEffectivePose() {
                return (weightPaintActive && poseBeforePaint) ? poseBeforePaint : (rig.pose || {});
            }
            function rigSetEffectivePose(p) {
                if (weightPaintActive && poseBeforePaint) poseBeforePaint = p; else rig.pose = p;
            }

            if (rigMirrorDirControl) {
                rigMirrorDirControl.querySelectorAll('.seg-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        mirrorDir = btn.dataset.dir || 'LtoR';
                        rigMirrorDirControl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                    });
                });
            }

            // --- Idea 1: specchia posa ---
            if (mirrorPoseBtn) mirrorPoseBtn.addEventListener('click', () => {
                if (!rigToolsReady()) return;
                pushHistory();
                const res = mirrorPoseData(rig.bones, rigEffectivePose(), mirrorDir);
                if (!res.changed) {
                    dropLastHistory();
                    if (rigHint) rigHint.textContent = t('rigTools.mirrorPoseNone', { dir: mirrorDirLabel() });
                    return;
                }
                rigSetEffectivePose(res.pose);
                stashRigToActiveObject();
                refreshPoseUI();
                if (rigHint) rigHint.textContent = t('rigTools.mirrorPoseOk', { dir: mirrorDirLabel(), n: res.changed });
            });

            // --- Idea 1: specchia pesi dipinti ---
            if (mirrorWeightsBtn) mirrorWeightsBtn.addEventListener('click', () => {
                if (!rigToolsReady()) return;
                const voxels = (currentModelData && currentModelData.voxels) || [];
                pushHistory();
                const res = mirrorWeightsData(voxels, rig.bones, rig.weights, mirrorDir);
                if (!res.copied) {
                    dropLastHistory();
                    if (rigHint) rigHint.textContent = t('rigTools.mirrorWeightsNone', { dir: mirrorDirLabel() });
                    return;
                }
                rig.weights = res.weights;
                rebuildRigPreserving(selectedBoneIndex);
                if (rigHint) rigHint.textContent = t('rigTools.mirrorWeightsOk', { dir: mirrorDirLabel(), n: res.copied })
                    + (res.skipped ? t('rigTools.mirrorWeightsSkipped', { n: res.skipped }) : '') + '.';
            });

            // --- Idea 2: simmetrizza lo scheletro ---
            if (symSkeletonBtn) symSkeletonBtn.addEventListener('click', () => {
                if (!rigToolsReady()) return;
                const voxels = (currentModelData && currentModelData.voxels) || [];
                pushHistory();
                const res = symmetrizeBonesData(rig.bones, voxels, mirrorDir);
                if (!res.moved && !res.centred) {
                    dropLastHistory();
                    if (rigHint) rigHint.textContent = t('rigTools.symAlready');
                    return;
                }
                rig.bones = res.bones;
                rebuildRigPreserving(selectedBoneIndex);
                if (rigHint) rigHint.textContent = t('rigTools.symOk', {
                    dir: mirrorDirLabel(), moved: res.moved, pairs: res.pairs
                }) + (res.centred ? t('rigTools.symCentred', { n: res.centred }) : '') + '.';
            });

            // --- Idea 4: aggiungi / rinomina / elimina ossa (sopra lo scheletro automatico) ---
            function rigSelectedIndex() {
                if (selectedBoneIndex >= 0 && rig.bones[selectedBoneIndex]) return selectedBoneIndex;
                return firstSelectableBone();
            }

            function rigAddBonePrompt() {
                if (!rigToolsReady()) return;
                const pi = rigSelectedIndex();
                if (pi < 0) { alert(t('rigTools.selectParentFirst')); return; }
                const parentName = rig.bones[pi].name;
                const suggested = uniqueBoneName(rig.bones, parentName + '_extra');
                const answer = prompt(t('rigTools.newBonePrompt', { parent: parentName }), suggested);
                if (answer === null) return;
                const name = String(answer).trim().replace(/\s+/g, '_');
                if (!name) return;
                if (!/^[A-Za-z0-9_.\-]+$/.test(name)) { alert(t('rigTools.nameCharset')); return; }
                if (rig.bones.some(o => o.name === name)) { alert(t('rigTools.nameTaken')); return; }
                pushHistory();
                const idx = rigAddChildBone(rig, pi, name);
                if (idx < 0) { dropLastHistory(); return; }
                rebuildRigPreserving(idx);
                if (rigHint) rigHint.textContent = t('rigTools.boneAdded', { name: name, parent: parentName });
            }

            function rigRenameBonePrompt(index) {
                if (!rigToolsReady()) return;
                const i = (index === undefined || index < 0) ? rigSelectedIndex() : index;
                const bd = rig.bones[i];
                if (!bd) return;
                const answer = prompt(t('rigTools.renamePrompt', { name: bd.name }), bd.name);
                if (answer === null) return;
                const before = bd.name;
                pushHistory();
                const err = rigRenameBone(rig, i, answer);
                if (err) { dropLastHistory(); alert(err); return; }
                if (rig.bones[i].name === before) { dropLastHistory(); return; }
                rebuildRigPreserving(i);
                if (rigHint) rigHint.textContent = t('rigTools.boneRenamed', {
                    before: before, after: rig.bones[i].name
                });
            }

            function rigDeleteBonePrompt() {
                if (!rigToolsReady()) return;
                const i = rigSelectedIndex();
                const bd = rig.bones[i];
                if (!bd) return;
                const children = rig.bones.filter(o => o.parent === i && !o.helper).length;
                let msg = t('rigTools.confirmDeleteBone', { name: bd.name });
                if (children) msg += '\n' + t('rigTools.deleteBoneChildren', { n: children });
                msg += '\n' + t('rigTools.deleteBoneVoxels');
                if (!confirm(msg)) return;
                pushHistory();
                const res = rigDeleteBone(rig, i);
                if (res.error) { dropLastHistory(); alert(res.error); return; }
                const name = bd.name;
                rebuildRigPreserving(res.select);
                if (rigHint) rigHint.textContent = t('rigTools.boneDeleted', { name: name })
                    + (res.removed > 1 ? t('rigTools.boneDeletedHelpers', { n: res.removed - 1 }) : '') + '.';
            }

            if (boneAddBtn) boneAddBtn.addEventListener('click', rigAddBonePrompt);
            if (boneRenameBtn) boneRenameBtn.addEventListener('click', () => rigRenameBonePrompt(-1));
            if (boneDelBtn) boneDelBtn.addEventListener('click', rigDeleteBonePrompt);

            // --- Idea 3: IK, "punta l'arto qui" --------------------------------------
            let ikActive = false;
            let ikDragging = false;
            let ikChain = null;               // [radice, figlio] oppure [osso singolo]
            let ikDirty = false;
            let ikRay = null, ikPointer = null, ikPlane = null;   // creati alla prima IK

            // Usata da 15-rig.js: mentre l'IK e' armata il click sinistro trascina l'arto,
            // quindi la selezione-osso e il gizmo si fanno da parte.
            function rigIkCapturesPointer() { return ikActive; }
            function rigDisableIk() {
                if (!ikActive) return;
                ikActive = false; ikDragging = false;
                if (ikToggleBtn) ikToggleBtn.classList.remove('active');
                if (ikHintEl) ikHintEl.textContent = '';
                if (typeof updateGizmo === 'function') updateGizmo();
            }

            // Verso "avanti" del modello, dedotto dai piedi: le punte guardano avanti.
            function rigForwardZ(bones) {
                const foot = (bones || []).find(b => /^foot_[LR]$/.test(b.name));
                const toe = (bones || []).find(b => /^toeTip_[LR]$/.test(b.name));
                if (foot && toe) {
                    const dz = toe.tail[2] - foot.head[2];
                    if (Math.abs(dz) > 1e-3) return dz > 0 ? 1 : -1;
                }
                return 1;
            }

            // Da che parte piegare l'articolazione di mezzo: il ginocchio va avanti, il
            // gomito indietro. Sbagliare verso da' l'arto rotto all'indietro.
            function ikBendHint(bones, rootIndex) {
                const fz = rigForwardZ(bones);
                const nm = (bones[rootIndex] && bones[rootIndex].name) || '';
                if (/^upperLeg_/.test(nm)) return [0, 0, fz];
                return [0, 0, -fz];
            }

            function boneWorldHead(i) {
                const bone = skeleton.bones[i];
                bone.updateWorldMatrix(true, false);
                return new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
            }
            function boneWorldTail(i) {
                const bd = rig.bones[i], bone = skeleton.bones[i];
                bone.updateWorldMatrix(true, false);
                const head = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
                const q = new THREE.Quaternion(); bone.getWorldQuaternion(q);
                return new THREE.Vector3(bd.tail[0] - bd.head[0], bd.tail[1] - bd.head[1], bd.tail[2] - bd.head[2])
                    .applyQuaternion(q).add(head);
            }

            // A riposo la rotazione dell'osso e' identita' (invariante (a) in testa al file),
            // quindi la direzione locale coincide con quella in spazio modello: serve solo la
            // rotazione minima da quella direzione a quella voluta, riportata nello spazio
            // del genitore. Scrive rig.pose e la applica subito all'osso.
            function ikAimBone(i, dirWorld) {
                const bd = rig.bones[i];
                const rest = new THREE.Vector3(bd.tail[0] - bd.head[0], bd.tail[1] - bd.head[1], bd.tail[2] - bd.head[2]);
                if (rest.lengthSq() < 1e-9 || dirWorld.lengthSq() < 1e-9) return false;
                const qWorld = new THREE.Quaternion().setFromUnitVectors(rest.normalize(), dirWorld.clone().normalize());
                const bone = skeleton.bones[i];
                const pq = new THREE.Quaternion();
                if (bone.parent && bone.parent.isBone) bone.parent.getWorldQuaternion(pq);
                const e = new THREE.Euler().setFromQuaternion(pq.invert().multiply(qWorld), 'XYZ');
                rig.pose = rig.pose || {};
                rig.pose[bd.name] = [e.x, e.y, e.z];
                bone.rotation.copy(e);
                bone.updateMatrixWorld(true);
                return true;
            }

            function ikSolveTo(target) {
                if (!ikChain || !skeleton || !rig) return;
                const rootI = ikChain[0];
                const root = boneWorldHead(rootI);
                if (ikChain.length < 2) {
                    ikAimBone(rootI, target.clone().sub(root));
                } else {
                    const childI = ikChain[1];
                    const bA = rig.bones[rootI], bB = rig.bones[childI];
                    const l1 = rtLen(rtSub(bA.tail, bA.head));
                    const l2 = rtLen(rtSub(bB.tail, bB.head));
                    const sol = solveTwoBoneIK([root.x, root.y, root.z], [target.x, target.y, target.z],
                        l1, l2, ikBendHint(rig.bones, rootI));
                    ikAimBone(rootI, new THREE.Vector3(sol.elbow[0], sol.elbow[1], sol.elbow[2]).sub(root));
                    // Ruotando la radice l'articolazione di mezzo si e' spostata: rileggerla.
                    const mid = boneWorldHead(childI);
                    ikAimBone(childI, new THREE.Vector3(sol.effector[0], sol.effector[1], sol.effector[2]).sub(mid));
                    if (ikHintEl) ikHintEl.textContent = sol.reachable
                        ? t('rigTools.ikReached') : t('rigTools.ikUnreachable');
                }
                ikDirty = true;
                applyPoseToBones();
                if (typeof requestRender === 'function') requestRender();
            }

            function ikSolveAtPointer(clientX, clientY) {
                const rect = renderer.domElement.getBoundingClientRect();
                ikPointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
                ikPointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
                ikRay.setFromCamera(ikPointer, camera);
                const hit = new THREE.Vector3();
                if (!ikRay.ray.intersectPlane(ikPlane, hit)) return;
                ikSolveTo(hit);
            }

            if (ikToggleBtn) ikToggleBtn.addEventListener('click', () => {
                if (!ikActive) {
                    if (!rigToolsReady()) return;
                    if (!skeleton || !rigPreviewActive) { alert(t('rigTools.needPreview')); return; }
                    if (weightPaintActive) setWeightPaint(false);
                    if (selectedBoneIndex < 0) {
                        const f = firstSelectableBone();
                        if (f >= 0) selectBone(f);
                    }
                    ikActive = true;
                    ikToggleBtn.classList.add('active');
                    if (ikHintEl) ikHintEl.textContent = t('rigTools.ikHint');
                    if (rigHint) rigHint.textContent = t('rigTools.ikOn');
                    if (typeof updateGizmo === 'function') updateGizmo();
                } else {
                    rigDisableIk();
                    if (rigHint) rigHint.textContent = t('rigTools.ikOff');
                }
                if (typeof requestRender === 'function') requestRender();
            });

            renderer.domElement.addEventListener('pointerdown', e => {
                if (!ikActive || e.button !== 0) return;
                if (!rig || !skeleton || !rigPreviewActive || weightPaintActive) return;
                let i = selectedBoneIndex;
                const hit = pickBone(e.clientX, e.clientY);
                if (hit >= 0) { i = hit; selectBone(hit); }
                if (i < 0) return;
                ikChain = ikChainForBone(rig.bones, i);
                if (!ikChain || !ikChain.length) return;
                ikRay = ikRay || new THREE.Raycaster();
                ikPointer = ikPointer || new THREE.Vector2();
                ikPlane = ikPlane || new THREE.Plane();
                // Piano di trascinamento parallelo allo schermo passante per la punta
                // dell'arto: il bersaglio segue il cursore senza sprofondare nella scena.
                const tip = boneWorldTail(ikChain.length > 1 ? ikChain[1] : ikChain[0]);
                const n = new THREE.Vector3();
                camera.getWorldDirection(n);
                ikPlane.setFromNormalAndCoplanarPoint(n, tip);
                pushHistory();
                if (currentAction) { currentAction.stop(); currentAction = null; if (animSelect) animSelect.value = 'none'; }
                ikDragging = true;
                ikDirty = false;
                ikSolveAtPointer(e.clientX, e.clientY);
            });

            renderer.domElement.addEventListener('pointermove', e => {
                if (!ikDragging) return;
                ikSolveAtPointer(e.clientX, e.clientY);
            }, { passive: true });

            window.addEventListener('pointerup', () => {
                if (!ikDragging) return;
                ikDragging = false;
                if (!ikDirty) { dropLastHistory(); return; }
                ikDirty = false;
                stashRigToActiveObject();
                if (selectedBoneIndex >= 0) selectBone(selectedBoneIndex);
                if (typeof syncGizmoToBone === 'function') syncGizmoToBone();
                if (typeof requestRender === 'function') requestRender();
            });

            // --- Idea 5: libreria di pose -------------------------------------------
            function applyPoseFromLib(idx) {
                if (!rigToolsReady()) return;
                const entry = poseLibLoad()[idx];
                if (!entry) return;
                pushHistory();
                const res = poseForBones(entry.pose, rig.bones);
                if (!res.applied) {
                    dropLastHistory();
                    alert(t('rigTools.poseNoCommonBones', { name: entry.name }));
                    return;
                }
                rigSetEffectivePose(res.pose);
                stashRigToActiveObject();
                refreshPoseUI();
                if (rigHint) rigHint.textContent = t('rigTools.poseApplied', { name: entry.name, n: res.applied })
                    + (res.missing.length ? t('rigTools.poseMissingBones', {
                        n: res.missing.length, names: res.missing.slice(0, 4).join(', ')
                    }) : '') + '.';
            }

            function deletePoseFromLib(idx) {
                const list = poseLibLoad();
                const entry = list[idx];
                if (!entry) return;
                if (!confirm(t('rigTools.poseConfirmDelete', { name: entry.name }))) return;
                list.splice(idx, 1);
                poseLibSave(list);
                renderPoseLib();
            }

            function renderPoseLib() {
                if (!poseLibListEl) return;
                const list = poseLibLoad();
                poseLibListEl.innerHTML = '';
                if (poseLibEmptyEl) poseLibEmptyEl.style.display = list.length ? 'none' : '';
                list.forEach((entry, idx) => {
                    const row = document.createElement('div');
                    row.className = 'pose-lib-row';
                    row.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:6px;';
                    const label = document.createElement('span');
                    label.className = 'pose-lib-name';
                    label.style.cssText = 'flex:1; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                    label.textContent = entry.name;
                    label.title = t('rigTools.poseBoneCount', { n: Object.keys(entry.pose || {}).length });
                    const use = document.createElement('button');
                    use.className = 'btn btn-secondary';
                    use.style.cssText = 'padding:5px 10px; font-size:11px;';
                    use.textContent = t('info.apply');
                    use.addEventListener('click', () => applyPoseFromLib(idx));
                    const del = document.createElement('button');
                    del.className = 'btn btn-secondary';
                    del.style.cssText = 'padding:5px 9px; font-size:12px; line-height:1;';
                    del.textContent = '×';
                    del.title = t('rigTools.poseDeleteTitle');
                    del.addEventListener('click', () => deletePoseFromLib(idx));
                    row.appendChild(label);
                    row.appendChild(use);
                    row.appendChild(del);
                    poseLibListEl.appendChild(row);
                });
            }

            if (poseSaveBtn) poseSaveBtn.addEventListener('click', () => {
                if (!rigToolsReady()) return;
                const pose = rigEffectivePose();
                const names = Object.keys(pose || {}).filter(k => Array.isArray(pose[k])
                    && pose[k].some(v => Math.abs(Number(v) || 0) > 1e-4));
                if (!names.length) { alert(t('rigTools.poseZero')); return; }
                const answer = prompt(t('rigTools.poseSavePrompt'), t('rigTools.poseDefaultName', { n: poseLibLoad().length + 1 }));
                if (answer === null) return;
                const name = String(answer).trim();
                if (!name) return;
                const clean = {};
                names.forEach(k => { clean[k] = [Number(pose[k][0]) || 0, Number(pose[k][1]) || 0, Number(pose[k][2]) || 0]; });
                const list = poseLibLoad().filter(e => e.name !== name);
                list.unshift({ name, pose: clean, ts: Date.now() });
                poseLibSave(list);
                renderPoseLib();
                if (rigHint) rigHint.textContent = t('rigTools.poseSaved', { name: name, n: names.length });
            });

            renderPoseLib();
