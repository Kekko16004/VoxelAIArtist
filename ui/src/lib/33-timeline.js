            /* =====================================================================
             * TIMELINE DELLE ANIMAZIONI (stile Blender)
             * ---------------------------------------------------------------------
             * Barra ancorata in BASSO alla viewport, visibile SOLO nella scheda Rig e
             * solo quando esiste uno scheletro: fuori di li' e' spazio rubato al
             * modello. La visibilita' e' pilotata da updateRigVisibility() (15-rig.js),
             * che e' l'unico punto attraversato sia da applyRig() sia da switchTab().
             *
             * PERCHE' NON USA L'AnimationMixer PER LO SCRUB
             * Il mixer scrive direttamente su bone.quaternion, mentre la posa "vera"
             * dell'utente vive in rig.pose (gradi -> radianti) ed e' cio' che leggono
             * cursori, gizmo, salvataggio ed export. Se lo scrub passasse dal mixer, le
             * due sorgenti divergerebbero e il primo tocco al gizmo farebbe saltare il
             * modello alla posa vecchia. Qui invece si CAMPIONA il dato dell'animazione
             * (formato {tracks:[{bone,keys:[{t,rot,pos}]}]}) e si scrive in rig.pose:
             * una sola sorgente di verita', quindi posare a un frame e premere "Inserisci
             * chiave" fa esattamente quello che ci si aspetta.
             *
             * Il campionamento usa gli STESSI quaternioni di buildClipFromAnimData()
             * (Euler XYZ in gradi -> quaternion -> slerp), cosi' l'anteprima nella
             * timeline e la clip esportata nel GLB coincidono frame per frame.
             *
             * SOLO LE CLIP PERSONALIZZATE SONO MODIFICABILI. Le preset (idle/walk/run/
             * jump/wave) sono generate proceduralmente da buildAnimationClips(): non
             * hanno un dato sorgente da editare. Il pulsante "Rendi modificabile" le
             * converte in una clip personalizzata leggendo i keyframe reali dalle
             * tracce THREE (non ricampionandole), cosi' non si perde nulla.
             * ===================================================================== */

            const TL_DEFAULT_FPS = 24;
            const TL_MIN_FPS = 1;
            const TL_MAX_FPS = 120;
            const TL_ROW_H = 20;            // altezza di una riga osso, in px
            const TL_PAD = 10;              // margine orizzontale della pista, in px
            const TL_MIN_H = 130;
            const TL_MAX_H = 460;

            let tlVisible = false;
            let tlPlaying = false;
            let tlLoop = true;
            let tlFrame = 0;                // frame corrente (puo' essere frazionario in play)
            let tlClipName = 'none';        // nome della clip mostrata ('none' = nessuna)
            let tlSelected = [];            // [{bone, t}] chiavi selezionate
            let tlKeyAllBones = false;      // "Inserisci chiave" su tutte le ossa posate
            let tlPoseBackup = null;        // posa dell'utente prima di prendere il controllo
            let tlScrubbing = false;
            let tlKeyDrag = null;           // {startX, moved, orig:[{bone,t}]}
            let tlDockHeight = 190;
            let tlRowsBuilt = '';           // firma dell'ultimo render (evita rebuild inutili)
            let tlAreaHover = false;        // puntatore sopra il dock
            let tlHoverLeavePending = false;// uscita avvenuta a meta' gesto, da applicare alla fine
            let tlAreaFocus = false;        // focus dentro il dock

            const tlDock = document.getElementById('timelineDock');
            const tlClipSel = document.getElementById('tlClip');
            const tlPlayBtn = document.getElementById('tlPlayBtn');
            const tlStopBtn = document.getElementById('tlStopBtn');
            const tlLoopBtn = document.getElementById('tlLoopBtn');
            const tlPrevKeyBtn = document.getElementById('tlPrevKeyBtn');
            const tlNextKeyBtn = document.getElementById('tlNextKeyBtn');
            const tlFirstBtn = document.getElementById('tlFirstBtn');
            const tlLastBtn = document.getElementById('tlLastBtn');
            const tlInsertBtn = document.getElementById('tlInsertKeyBtn');
            const tlDeleteBtn = document.getElementById('tlDeleteKeyBtn');
            const tlNewBtn = document.getElementById('tlNewAnimBtn');
            const tlEditableBtn = document.getElementById('tlMakeEditableBtn');
            const tlFpsInput = document.getElementById('tlFps');
            const tlDurInput = document.getElementById('tlDuration');
            const tlFrameLabel = document.getElementById('tlFrameLabel');
            const tlScopeControl = document.getElementById('tlKeyScope');
            const tlRulerEl = document.getElementById('tlRuler');
            const tlRowsEl = document.getElementById('tlRows');
            const tlLabelsEl = document.getElementById('tlLabels');
            const tlPlayheadEl = document.getElementById('tlPlayhead');
            const tlStatusEl = document.getElementById('tlStatus');
            const tlResizeEl = document.getElementById('tlResizer');
            const tlBodyEl = document.getElementById('tlBody');

            function tlHasDom() { return !!(tlDock && tlRulerEl && tlRowsEl); }

            // --- helpers sul dato -----------------------------------------------------

            function tlCustomAnims() {
                return (typeof rig !== 'undefined' && rig && Array.isArray(rig.customAnims)) ? rig.customAnims : [];
            }

            function tlFindAnim(name) {
                return tlCustomAnims().find(a => a && a.name === name) || null;
            }

            // La clip mostrata, se e' una personalizzata (quindi modificabile).
            function tlActiveAnim() {
                if (!tlClipName || tlClipName === 'none') return null;
                return tlFindAnim(tlClipName);
            }

            function tlFps() {
                const a = tlActiveAnim();
                const f = a && Number(a.fps);
                if (isFinite(f) && f >= TL_MIN_FPS && f <= TL_MAX_FPS) return Math.round(f);
                return TL_DEFAULT_FPS;
            }

            function tlDuration() {
                const a = tlActiveAnim();
                if (a) return Math.max(0.1, Number(a.duration) || 1);
                const clip = (typeof rigClips !== 'undefined' ? rigClips : []).find(c => c.name === tlClipName);
                return clip ? Math.max(0.1, clip.duration) : 1;
            }

            function tlFrameCount() {
                return Math.max(1, Math.round(tlDuration() * tlFps()));
            }

            function tlTimeOfFrame(f) { return f / tlFps(); }
            function tlFrameOfTime(t) { return t * tlFps(); }

            // Arrotondamento a frame INTERO: i keyframe vivono sulla griglia dei frame,
            // altrimenti trascinandone uno si ottengono tempi tipo 0.4166666 che poi non
            // si riescono piu' a selezionare cliccando il diamante.
            function tlSnapTime(t) {
                const fps = tlFps();
                return Math.round(t * fps) / fps;
            }

            // --- campionamento (funzioni PURE, testabili) -----------------------------

            // Interpolazione di una traccia di rotazione: Euler XYZ in GRADI -> quaternion
            // -> slerp -> Euler XYZ in RADIANTI. Stessa catena di buildClipFromAnimData().
            function tlSampleRot(keys, t) {
                if (!keys || !keys.length) return null;
                const rad = d => (Number(d) || 0) * Math.PI / 180;
                const eul = k => new THREE.Euler(rad(k.rot[0]), rad(k.rot[1]), rad(k.rot[2]), 'XYZ');
                if (keys.length === 1 || t <= keys[0].t) {
                    const e = eul(keys[0]);
                    return [e.x, e.y, e.z];
                }
                const last = keys[keys.length - 1];
                if (t >= last.t) {
                    const e = eul(last);
                    return [e.x, e.y, e.z];
                }
                let i = 0;
                while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
                const a = keys[i], b = keys[i + 1];
                const span = b.t - a.t;
                const u = span > 1e-9 ? (t - a.t) / span : 0;
                const qa = new THREE.Quaternion().setFromEuler(eul(a));
                const qb = new THREE.Quaternion().setFromEuler(eul(b));
                const q = qa.clone().slerp(qb, u);
                const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
                return [e.x, e.y, e.z];
            }

            // Le tracce di posizione sono offset lineari (il "bob" delle anche): lerp.
            function tlSamplePos(keys, t) {
                if (!keys || !keys.length) return null;
                const at = k => [Number(k.pos[0]) || 0, Number(k.pos[1]) || 0, Number(k.pos[2]) || 0];
                if (keys.length === 1 || t <= keys[0].t) return at(keys[0]);
                const last = keys[keys.length - 1];
                if (t >= last.t) return at(last);
                let i = 0;
                while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
                const a = at(keys[i]), b = at(keys[i + 1]);
                const span = keys[i + 1].t - keys[i].t;
                const u = span > 1e-9 ? (t - keys[i].t) / span : 0;
                return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
            }

            function tlSortedKeys(track, kind) {
                if (!track || !Array.isArray(track.keys)) return [];
                return track.keys
                    .filter(k => k && Array.isArray(k[kind]))
                    .map(k => ({ t: Number(k.t) || 0, rot: k.rot, pos: k.pos }))
                    .sort((a, b) => a.t - b.t);
            }

            // Campiona TUTTA l'animazione al tempo t. Ritorna {rot:{osso:[rx,ry,rz]},
            // pos:{osso:[dx,dy,dz]}} in radianti / unita' voxel.
            function tlSampleAnim(anim, t) {
                const out = { rot: {}, pos: {} };
                if (!anim || !Array.isArray(anim.tracks)) return out;
                anim.tracks.forEach(tr => {
                    if (!tr || !tr.bone) return;
                    const r = tlSampleRot(tlSortedKeys(tr, 'rot'), t);
                    if (r) out.rot[tr.bone] = r;
                    const p = tlSamplePos(tlSortedKeys(tr, 'pos'), t);
                    if (p) out.pos[tr.bone] = p;
                });
                return out;
            }

            // Tutti gli istanti in cui esiste almeno una chiave, per osso.
            function tlKeyTimesByBone(anim) {
                const map = {};
                if (!anim || !Array.isArray(anim.tracks)) return map;
                anim.tracks.forEach(tr => {
                    if (!tr || !tr.bone || !Array.isArray(tr.keys)) return;
                    const set = map[tr.bone] || (map[tr.bone] = []);
                    tr.keys.forEach(k => {
                        if (!k) return;
                        const t = Number(k.t) || 0;
                        if (!set.some(x => Math.abs(x - t) < 1e-6)) set.push(t);
                    });
                    set.sort((a, b) => a - b);
                });
                return map;
            }

            // --- conversione preset -> dato modificabile -------------------------------

            // Legge i keyframe REALI di un THREE.AnimationClip (non ricampiona: le preset
            // hanno pochi keyframe netti e ricampionarle a 24 fps ne farebbe centinaia).
            function tlAnimDataFromClip(clip, name) {
                if (!clip || !Array.isArray(clip.tracks)) return null;
                const byBone = {};
                const deg = r => r * 180 / Math.PI;
                const restOf = boneName => {
                    if (typeof skeleton === 'undefined' || !skeleton) return null;
                    const b = skeleton.bones.find(x => x.name === boneName);
                    return (b && b.userData && b.userData.restPos) ? b.userData.restPos : null;
                };
                clip.tracks.forEach(tr => {
                    const dot = tr.name.lastIndexOf('.');
                    if (dot < 0) return;
                    const boneName = tr.name.slice(0, dot);
                    const prop = tr.name.slice(dot + 1);
                    const bucket = byBone[boneName] || (byBone[boneName] = {});
                    for (let i = 0; i < tr.times.length; i++) {
                        const t = tr.times[i];
                        const key = bucket[t] || (bucket[t] = { t: t });
                        if (prop === 'quaternion') {
                            const q = new THREE.Quaternion(
                                tr.values[i * 4], tr.values[i * 4 + 1], tr.values[i * 4 + 2], tr.values[i * 4 + 3]);
                            const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
                            key.rot = [
                                Math.round(deg(e.x) * 100) / 100,
                                Math.round(deg(e.y) * 100) / 100,
                                Math.round(deg(e.z) * 100) / 100
                            ];
                        } else if (prop === 'position') {
                            const rest = restOf(boneName);
                            const rx = rest ? rest.x : 0, ry = rest ? rest.y : 0, rz = rest ? rest.z : 0;
                            key.pos = [
                                Math.round((tr.values[i * 3] - rx) * 1000) / 1000,
                                Math.round((tr.values[i * 3 + 1] - ry) * 1000) / 1000,
                                Math.round((tr.values[i * 3 + 2] - rz) * 1000) / 1000
                            ];
                        }
                    }
                });
                const tracks = Object.keys(byBone).map(bone => ({
                    bone: bone,
                    keys: Object.keys(byBone[bone])
                        .map(k => byBone[bone][k])
                        .sort((a, b) => a.t - b.t)
                }));
                if (!tracks.length) return null;
                return {
                    name: name, duration: Math.max(0.1, clip.duration),
                    fps: TL_DEFAULT_FPS, loop: true, tracks: tracks
                };
            }

            // --- applicazione della posa ----------------------------------------------

            // Scrive nel rig la posa dell'animazione al frame corrente. Le ossa senza
            // traccia restano dove sono: cosi' una clip che anima solo un braccio non
            // azzera il resto della posa (in Blender e' lo stesso).
            function tlApplyAt(t) {
                if (typeof rig === 'undefined' || !rig || typeof skeleton === 'undefined' || !skeleton) return;
                const anim = tlActiveAnim();
                if (!anim) return;
                const s = tlSampleAnim(anim, t);
                rig.pose = rig.pose || {};
                rig.posePos = rig.posePos || {};
                Object.keys(s.rot).forEach(name => { rig.pose[name] = s.rot[name]; });
                // La traslazione passa dal CANALE di posa, non dritta sull'osso: cosi'
                // "Inserisci Location" durante lo scrub rilegge esattamente il valore
                // che sta vedendo. Prima qui si scriveva bone.position e rig.posePos
                // restava vuoto, quindi il keyframe usciva a zero.
                Object.keys(s.pos).forEach(name => {
                    const p = s.pos[name];
                    rig.posePos[name] = [p[0], p[1], p[2]];
                });
                applyPoseToBones();
                if (typeof syncGizmoToBone === 'function') syncGizmoToBone();
                tlSyncPoseSliders();
                if (typeof requestRender === 'function') requestRender();
            }

            // I cursori X/Y/Z del pannello devono seguire lo scrub, o mostrerebbero la
            // posa di un frame che non e' piu' quello visibile.
            function tlSyncPoseSliders() {
                if (typeof selectedBoneIndex === 'undefined' || selectedBoneIndex < 0) return;
                if (!rig || !rig.bones[selectedBoneIndex]) return;
                const p = (rig.pose && rig.pose[rig.bones[selectedBoneIndex].name]) || [0, 0, 0];
                const d = r => Math.round(r * 180 / Math.PI);
                if (typeof poseRot !== 'undefined' && poseRot && poseRot.x) {
                    poseRot.x.value = d(p[0]);
                    poseRot.y.value = d(p[1]);
                    poseRot.z.value = d(p[2]);
                    if (typeof updateRotLabels === 'function') updateRotLabels();
                }
                // Anche i cursori Pos: durante lo scrub devono mostrare la traslazione
                // del frame visibile, altrimenti "Inserisci Location" sembrerebbe
                // salvare un valore diverso da quello sotto gli occhi.
                if (typeof syncPosSliders === 'function') syncPosSliders();
            }

            // --- geometria della pista -------------------------------------------------

            function tlTrackWidth() {
                if (!tlRulerEl) return 0;
                const w = tlRulerEl.clientWidth;
                return Math.max(1, w - TL_PAD * 2);
            }

            function tlXOfFrame(f) {
                const n = tlFrameCount();
                return TL_PAD + (tlTrackWidth() * (n > 0 ? f / n : 0));
            }

            function tlFrameOfX(x) {
                const n = tlFrameCount();
                const u = (x - TL_PAD) / tlTrackWidth();
                return Math.max(0, Math.min(n, Math.round(u * n)));
            }

            // --- render ----------------------------------------------------------------

            function tlSetFrame(f, apply) {
                const n = tlFrameCount();
                tlFrame = Math.max(0, Math.min(n, f));
                tlUpdatePlayhead();
                if (apply !== false) tlApplyAt(tlTimeOfFrame(tlFrame));
            }

            function tlUpdatePlayhead() {
                if (!tlPlayheadEl) return;
                const x = tlXOfFrame(tlFrame);
                tlPlayheadEl.style.left = (tlLabelsWidth() + x) + 'px';
                if (tlFrameLabel) {
                    tlFrameLabel.textContent = Math.round(tlFrame) + ' / ' + tlFrameCount();
                }
            }

            function tlLabelsWidth() {
                return tlLabelsEl ? tlLabelsEl.offsetWidth : 130;
            }

            function tlRenderRuler() {
                if (!tlRulerEl) return;
                tlRulerEl.textContent = '';
                const n = tlFrameCount();
                const w = tlTrackWidth();
                // Un'etichetta ogni ~55px: piu' fitte diventano illeggibili.
                const maxLabels = Math.max(2, Math.floor(w / 55));
                let step = Math.ceil(n / maxLabels);
                // Passi "tondi" (1,2,5,10,25,50,...) come fa Blender.
                const nice = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
                for (let i = 0; i < nice.length; i++) { if (nice[i] >= step) { step = nice[i]; break; } }
                for (let f = 0; f <= n; f += step) {
                    const tick = document.createElement('div');
                    tick.className = 'tl-tick';
                    tick.style.left = tlXOfFrame(f) + 'px';
                    const lab = document.createElement('span');
                    lab.textContent = String(f);
                    tick.appendChild(lab);
                    tlRulerEl.appendChild(tick);
                }
            }

            // Ossa da mostrare: quelle con almeno una chiave, piu' quella selezionata
            // (cosi' si vede subito dove si andrebbe a inserire una chiave nuova).
            function tlRowBones(anim) {
                const times = tlKeyTimesByBone(anim);
                const names = Object.keys(times);
                if (rig && selectedBoneIndex >= 0 && rig.bones[selectedBoneIndex]) {
                    const sel = rig.bones[selectedBoneIndex].name;
                    if (names.indexOf(sel) < 0) names.push(sel);
                }
                // Ordine dello scheletro, non alfabetico: rispecchia la lista ossa.
                if (rig && Array.isArray(rig.bones)) {
                    const order = {};
                    rig.bones.forEach((b, i) => { order[b.name] = i; });
                    names.sort((a, b) => (order[a] === undefined ? 1e9 : order[a]) - (order[b] === undefined ? 1e9 : order[b]));
                }
                return names;
            }

            function tlIsSelectedKey(bone, t) {
                return tlSelected.some(s => s.bone === bone && Math.abs(s.t - t) < 1e-6);
            }

            // L'area e' "attiva" col puntatore sopra il dock OPPURE col focus dentro:
            // dopo aver cliccato una chiave il mouse spesso si sposta, e pretendere che
            // resti fermo renderebbe la scorciatoia inaffidabile. Un solo booleano per
            // ciascuna condizione, nessun hit-testing.
            function tlAreaActive() {
                return tlVisible && (tlAreaHover || tlAreaFocus);
            }

            // Ctrl+A: seleziona tutti i keyframe dell'animazione attiva.
            // Riporta false se non c'era nulla da fare (nessuna clip modificabile, o
            // clip senza chiavi), cosi' il chiamante sa se ha senso consumare l'evento.
            //
            // Toggle deliberato: ripremendo con tutto selezionato la selezione si svuota.
            // Blender separa A (seleziona) da Alt+A (deseleziona), ma qui Ctrl+A e' la
            // SOLA scorciatoia di selezione, e senza il toggle non ci sarebbe modo di
            // deselezionare da tastiera.
            function tlSelectAllKeys() {
                // Il menu dei canali si prende i tasti quando e' aperto: va chiuso prima,
                // altrimenti resta a schermo sopra una selezione che e' cambiata sotto.
                if (tlChanMenuOpen()) tlCloseChanMenu();
                const anim = tlActiveAnim();
                const times = tlKeyTimesByBone(anim);
                const all = [];
                Object.keys(times).forEach(bone => {
                    times[bone].forEach(t0 => all.push({ bone: bone, t: t0 }));
                });
                if (!all.length) return false;
                const allAlready = all.every(k => tlIsSelectedKey(k.bone, k.t))
                    && tlSelected.length === all.length;
                tlSelected = allAlready ? [] : all;
                // La selezione NON e' stato del documento: nessun pushHistory().
                tlRedraw();
                tlUpdateToolbar();
                return true;
            }

            // Quali canali contiene la chiave di quell'osso a quel tempo. Serve al
            // tooltip del rombo: senza, una chiave di sola Location e una completa
            // sono indistinguibili a schermo.
            // Il tempo si chiama `time` e non `t`: `t` e' la funzione di traduzione
            // (23-i18n.js) e un parametro con quel nome la coprirebbe qui dentro.
            function tlChansAt(anim, bone, time) {
                const tr = (anim && Array.isArray(anim.tracks))
                    ? anim.tracks.find(x => x && x.bone === bone) : null;
                if (!tr || !Array.isArray(tr.keys)) return '';
                const k = tr.keys.find(x => x && Math.abs((Number(x.t) || 0) - time) < 1e-6);
                if (!k) return '';
                const parts = [];
                if (Array.isArray(k.pos)) parts.push(t('timeline.chanLoc'));
                if (Array.isArray(k.rot)) parts.push(t('timeline.chanRot'));
                return parts.join(' + ');
            }

            function tlRenderRows() {
                if (!tlRowsEl || !tlLabelsEl) return;
                tlRowsEl.textContent = '';
                tlLabelsEl.textContent = '';
                const anim = tlActiveAnim();
                const readOnly = !anim;

                if (!rig || !rig.bones || !rig.bones.length) return;

                const times = tlKeyTimesByBone(anim);
                const bones = anim ? tlRowBones(anim) : tlPresetRowBones();

                // Riga di riepilogo: l'unione di tutte le chiavi, come il "Summary" di Blender.
                const allT = [];
                Object.keys(times).forEach(b => times[b].forEach(t => {
                    if (!allT.some(x => Math.abs(x - t) < 1e-6)) allT.push(t);
                }));
                allT.sort((a, b) => a - b);
                tlAppendRow(t('timeline.summary'), allT, null, true, readOnly);

                bones.forEach(name => {
                    tlAppendRow(name, times[name] || [], name, false, readOnly);
                });
            }

            // Per una clip preset mostriamo comunque le ossa animate, in sola lettura.
            function tlPresetRowBones() {
                const clip = (typeof rigClips !== 'undefined' ? rigClips : []).find(c => c.name === tlClipName);
                if (!clip) return [];
                const out = [];
                clip.tracks.forEach(tr => {
                    const dot = tr.name.lastIndexOf('.');
                    const b = dot > 0 ? tr.name.slice(0, dot) : tr.name;
                    if (out.indexOf(b) < 0) out.push(b);
                });
                return out;
            }

            function tlAppendRow(label, keyTimes, boneName, isSummary, readOnly) {
                const lab = document.createElement('div');
                lab.className = 'tl-rowlabel' + (isSummary ? ' tl-summary' : '');
                lab.textContent = label;
                lab.title = label;
                if (boneName && rig && !isSummary) {
                    lab.addEventListener('click', () => {
                        const i = rig.bones.findIndex(b => b.name === boneName);
                        if (i >= 0 && typeof selectBone === 'function') selectBone(i);
                    });
                }
                if (boneName && rig && selectedBoneIndex >= 0 && rig.bones[selectedBoneIndex]
                    && rig.bones[selectedBoneIndex].name === boneName) {
                    lab.classList.add('tl-rowlabel-sel');
                }
                tlLabelsEl.appendChild(lab);

                const row = document.createElement('div');
                row.className = 'tl-rowtrack' + (isSummary ? ' tl-summary' : '');
                row.dataset.bone = boneName || '';
                const animForTip = tlActiveAnim();
                keyTimes.forEach(t => {
                    const k = document.createElement('div');
                    k.className = 'tl-key' + (isSummary ? ' tl-key-sum' : '');
                    if (!isSummary && tlIsSelectedKey(boneName, t)) k.classList.add('tl-key-sel');
                    if (readOnly) k.classList.add('tl-key-ro');
                    k.style.left = tlXOfFrame(tlFrameOfTime(t)) + 'px';
                    k.dataset.t = String(t);
                    k.dataset.bone = boneName || '';
                    if (!isSummary && boneName) {
                        const ch = tlChansAt(animForTip, boneName, t);
                        if (ch) k.title = ch;
                    }
                    row.appendChild(k);
                });
                tlRowsEl.appendChild(row);
            }

            // Ricostruisce tutto (righe + righello + playhead). Chiamata a ogni cambio di
            // clip, di scheletro, di selezione o di larghezza della viewport.
            function tlRedraw() {
                if (!tlHasDom() || !tlVisible) return;
                tlRenderRuler();
                tlRenderRows();
                tlUpdatePlayhead();
                tlUpdateToolbar();
            }

            function tlUpdateToolbar() {
                const anim = tlActiveAnim();
                const hasClip = tlClipName && tlClipName !== 'none';
                const editable = !!anim;
                if (tlPlayBtn) {
                    // Lo stato del pulsante si DEDUCE (tlEffectivePlaying) invece di
                    // fidarsi del solo flag: una clip preset puo' essere stata messa in
                    // pausa dallo Spazio globale di 15-rig.js mentre la barra era
                    // nascosta, e riaprendola l'etichetta mentirebbe.
                    const playing = tlEffectivePlaying();
                    tlPlayBtn.disabled = !tlCanPlay();
                    tlPlayBtn.textContent = playing ? t('timeline.pause') : t('timeline.play');
                    tlPlayBtn.title = playing ? t('timeline.pauseTitle') : t('timeline.playTitle');
                }
                [tlStopBtn, tlFirstBtn, tlLastBtn, tlPrevKeyBtn, tlNextKeyBtn].forEach(b => {
                    if (b) b.disabled = !hasClip;
                });
                if (tlInsertBtn) tlInsertBtn.disabled = !editable;
                if (tlDeleteBtn) tlDeleteBtn.disabled = !editable || !tlSelected.length;
                if (tlFpsInput) { tlFpsInput.disabled = !editable; tlFpsInput.value = String(tlFps()); }
                if (tlDurInput) { tlDurInput.disabled = !editable; tlDurInput.value = String(Math.round(tlDuration() * 100) / 100); }
                if (tlLoopBtn) tlLoopBtn.classList.toggle('active', tlLoop);
                if (tlEditableBtn) tlEditableBtn.style.display = (hasClip && !editable) ? '' : 'none';
                if (tlStatusEl) {
                    if (!hasClip) tlStatusEl.textContent = t('timeline.statusNone');
                    else if (!editable) tlStatusEl.textContent = t('timeline.statusPreset');
                    else tlStatusEl.textContent = t('timeline.statusKeys', { n: tlCountKeys(anim) });
                }
            }

            function tlCountKeys(anim) {
                let n = 0;
                (anim && anim.tracks ? anim.tracks : []).forEach(tr => {
                    n += (tr && Array.isArray(tr.keys)) ? tr.keys.length : 0;
                });
                return n;
            }

            // --- elenco clip ------------------------------------------------------------

            function tlSyncClipList() {
                if (!tlClipSel) return;
                const prev = tlClipName;
                tlClipSel.textContent = '';
                const mk = (val, label) => {
                    const o = document.createElement('option');
                    o.value = val; o.textContent = label;
                    tlClipSel.appendChild(o);
                };
                mk('none', t('timeline.clipNone'));
                const presets = ['idle', 'walk', 'run', 'jump', 'wave'];
                presets.forEach(p => {
                    if ((typeof rigClips !== 'undefined' ? rigClips : []).some(c => c.name === p)) {
                        mk(p, t('rig.clip' + p.charAt(0).toUpperCase() + p.slice(1)));
                    }
                });
                tlCustomAnims().forEach(a => { if (a && a.name) mk(a.name, a.name); });
                const known = Array.prototype.map.call(tlClipSel.options, o => o.value);
                tlClipName = known.indexOf(prev) >= 0 ? prev : 'none';
                tlClipSel.value = tlClipName;
            }

            // --- prendere/lasciare il controllo della posa ------------------------------

            function tlTakeOver() {
                if (tlPoseBackup === null && rig) {
                    tlPoseBackup = JSON.parse(JSON.stringify(rig.pose || {}));
                }
            }

            function tlRelease() {
                if (tlPoseBackup !== null && rig) {
                    rig.pose = tlPoseBackup;
                    if (typeof applyPoseToBones === 'function') applyPoseToBones();
                    tlSyncPoseSliders();
                    if (typeof syncGizmoToBone === 'function') syncGizmoToBone();
                    if (typeof requestRender === 'function') requestRender();
                }
                tlPoseBackup = null;
            }

            function tlSelectClip(name) {
                tlStopPlayback();
                if (name === 'none') {
                    tlClipName = 'none';
                    tlRelease();
                    tlSelected = [];
                    tlFrame = 0;
                    tlRedraw();
                    return;
                }
                const anim = tlFindAnim(name);
                tlClipName = name;
                tlSelected = [];
                tlFrame = 0;
                if (anim) {
                    tlTakeOver();
                    tlApplyAt(0);
                } else {
                    // Preset: nessun dato da editare, si usa il mixer come sempre.
                    tlRelease();
                    if (typeof animSelect !== 'undefined' && animSelect) animSelect.value = name;
                    if (typeof playClip === 'function') playClip(name);
                }
                tlRedraw();
            }

            // --- riproduzione ------------------------------------------------------------

            // Il tasto di play/pausa arriva da KEYMAP.togglePlay (rimappabile dal pannello
            // Scorciatoie); il default ' ' resta valido se la preferenza non c'e' ancora.
            // 'Spacebar' e' il nome legacy dello spazio su alcuni browser.
            function tlTogglePlayKey() {
                const k = (typeof KEYMAP !== 'undefined' && KEYMAP) ? KEYMAP.togglePlay : null;
                return (typeof k === 'string' && k.length) ? k : ' ';
            }

            function tlIsTogglePlayKey(key) {
                const want = tlTogglePlayKey();
                if (key === want) return true;
                return (want === ' ') && (key === 'Spacebar');
            }

            // Con una modale aperta la tastiera e' sua: le overlay del progetto si
            // riconoscono dal display 'flex' (e' cosi' che le aprono/chiudono i loro
            // moduli, vedi 26-settings-modal.js e 31-help.js).
            function tlModalOpen() {
                const ids = ['settingsOverlay', 'helpOverlay', 'importOverlay',
                    'autosaveHistoryOverlay', 'loaderOverlay', 'primOverlay'];
                return ids.some(id => {
                    const el = document.getElementById(id);
                    return !!(el && el.style && el.style.display === 'flex');
                });
            }

            // Elementi per cui lo Spazio e' gia' un'attivazione da tastiera.
            function tlIsActivatable(el) {
                if (!el) return false;
                return el.tagName === 'BUTTON' || el.tagName === 'A'
                    || el.getAttribute('role') === 'button'
                    || (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio'));
            }

            // L'AnimationAction caricata nel mixer. E' "l'animazione attuale" anche
            // quando e' stata avviata dal menu del pannello Rig invece che da qui: se la
            // ignorassimo, Spazio non farebbe nulla proprio nel caso piu' comune.
            function tlMixerAction() {
                return (typeof currentAction !== 'undefined' && currentAction) ? currentAction : null;
            }

            // Sta davvero scorrendo? Un'action fermata con .stop() resta assegnata a
            // currentAction ma e' stata staccata dal mixer: isRunning() e' l'unico modo
            // per distinguerla da una in pausa (che invece riparte con paused = false).
            function tlActionPlaying(a) {
                if (!a || a.paused) return false;
                return (typeof a.isRunning === 'function') ? a.isRunning() : !!a.enabled;
            }

            // C'e' qualcosa da riprodurre? Una clip scelta nella barra, oppure un'action
            // gia' caricata nel mixer dal menu del pannello Rig.
            function tlCanPlay() {
                if (tlClipName && tlClipName !== 'none') return true;
                return !!tlMixerAction();
            }

            // Verita' unica sullo stato "sta scorrendo", condivisa da pulsante e Spazio.
            // Per le clip personalizzate il tempo lo muove tlTick() (flag tlPlaying); per
            // le preset lo muove il mixer, quindi si guarda l'action.
            function tlEffectivePlaying() {
                if (tlActiveAnim()) return tlPlaying;
                return tlActionPlaying(tlMixerAction());
            }

            // Ferma la riproduzione SENZA riavvolgere: usata da scrub, frecce e cambio
            // clip. Per le preset serve toccare anche il mixer, altrimenti il modello
            // continuerebbe a muoversi mentre la barra si dichiara ferma.
            // NB: paused, mai stop(): stop() riporterebbe action.time a 0.
            function tlStopPlayback() {
                tlPlaying = false;
                const a = tlMixerAction();
                if (a && !tlActiveAnim()) a.paused = true;
                if (tlPlayBtn) {
                    tlPlayBtn.textContent = t('timeline.play');
                    tlPlayBtn.title = t('timeline.playTitle');
                }
            }

            // UNICO percorso di play/pausa: ci passano sia il click sul pulsante della
            // barra sia la scorciatoia da tastiera, cosi' etichetta e stato reale non
            // possono divergere.
            //
            // Semantica: si riprende SEMPRE dall'istante in cui ci si e' fermati.
            //  - clip personalizzata: il tempo lo avanza tlTick(), quindi basta smettere
            //    di incrementare tlFrame (che non viene toccato);
            //  - clip preset: si usa action.paused, che CONSERVA action.time. action.stop()
            //    e' evitato di proposito perche' azzera il tempo (THREE r128).
            // Senza nulla da riprodurre non fa e non sporca niente.
            window.tlTogglePlay = function() { tlTogglePlayInternal(); };
            window.tlForcePlay = function() {
                if (!tlEffectivePlaying()) tlTogglePlayInternal();
            };

            function tlTogglePlayInternal() {
                const anim = tlActiveAnim();
                if (anim) {
                    tlPlaying = !tlPlaying;
                    if (tlPlaying) tlTakeOver();
                } else {
                    const a = tlMixerAction();
                    if (tlActionPlaying(a)) {
                        a.paused = true;                       // congela, non riavvolge
                        tlPlaying = false;
                    } else if (a) {
                        a.paused = false;
                        a.enabled = true;
                        // Se era stata fermata col pulsante Stop non e' piu' attiva nel
                        // mixer: play() la riattiva e NON tocca action.time (a differenza
                        // di reset()), quindi riparte da dove si trova.
                        if (typeof a.isRunning !== 'function' || !a.isRunning()) a.play();
                        tlPlaying = true;
                    } else {
                        // Nessuna action viva: si avvia la clip scelta nella timeline o,
                        // in mancanza, quella del menu del pannello Rig.
                        const name = (tlClipName && tlClipName !== 'none')
                            ? tlClipName
                            : ((typeof animSelect !== 'undefined' && animSelect) ? animSelect.value : 'none');
                        if (!name || name === 'none' || typeof playClip !== 'function') return;
                        playClip(name);
                        tlPlaying = !!tlMixerAction();
                    }
                }
                tlUpdateToolbar();
                if (typeof requestRender === 'function') requestRender();
            }

            // Chiamata dal loop di render (18-bootstrap-tail.js). dt in secondi.
            function tlTick(dt) {
                if (!tlVisible || !tlPlaying) return;
                const anim = tlActiveAnim();
                if (!anim) return;                       // le preset le muove il mixer
                const n = tlFrameCount();
                let f = tlFrame + dt * tlFps();
                if (f > n) {
                    if (tlLoop) { f = f % n; }
                    else { f = n; tlStopPlayback(); tlUpdateToolbar(); }
                }
                tlFrame = f;
                tlUpdatePlayhead();
                tlApplyAt(tlTimeOfFrame(tlFrame));
            }

            function tlIsPlaying() { return tlVisible && tlPlaying; }
            // Serve a 15-rig.js: il suo Spazio globale (pausa/riprendi la clip) si tira
            // indietro quando la timeline e' a schermo, perche' li' lo Spazio e' gia' suo.
            function tlIsVisible() { return tlVisible; }

            // --- editing dei keyframe ----------------------------------------------------

            function tlEnsureTrack(anim, boneName) {
                if (!Array.isArray(anim.tracks)) anim.tracks = [];
                let tr = anim.tracks.find(x => x && x.bone === boneName);
                if (!tr) { tr = { bone: boneName, keys: [] }; anim.tracks.push(tr); }
                if (!Array.isArray(tr.keys)) tr.keys = [];
                return tr;
            }

            // Inserisce (o sostituisce) la chiave al frame corrente leggendo la posa VIVA
            // del rig: e' il flusso di Blender (posa -> I). Le ossa scelte dipendono dal
            // selettore "osso selezionato / tutte".
            //
            // `channels` dice QUALI canali salvare, come in Unity/Blender:
            //   'rot'    -> solo rotazione;
            //   'loc'    -> solo posizione;
            //   'locrot' -> tutti e due.
            // Il default resta 'rot' per non cambiare il comportamento di chi chiama
            // senza argomenti. Un canale non richiesto NON viene toccato: reinserire
            // una Rotation su una chiave che aveva anche Location conserva la Location.
            function tlInsertKey(channels) {
                const anim = tlActiveAnim();
                if (!anim || !rig) return;
                const ch = (channels === 'loc' || channels === 'locrot') ? channels : 'rot';
                const wantRot = (ch === 'rot' || ch === 'locrot');
                const wantLoc = (ch === 'loc' || ch === 'locrot');
                const t0 = tlSnapTime(tlTimeOfFrame(Math.round(tlFrame)));
                const deg = r => Math.round((r * 180 / Math.PI) * 100) / 100;
                const r2 = v => Math.round((Number(v) || 0) * 1000) / 1000;
                let names = [];
                if (tlKeyAllBones) {
                    names = rig.bones.filter(b => !b.helper).map(b => b.name);
                } else if (selectedBoneIndex >= 0 && rig.bones[selectedBoneIndex]) {
                    names = [rig.bones[selectedBoneIndex].name];
                }
                if (!names.length) return;
                if (typeof pushHistory === 'function') pushHistory();
                names.forEach(name => {
                    const p = (rig.pose && rig.pose[name]) || [0, 0, 0];
                    const tr = tlEnsureTrack(anim, name);
                    const rot = [deg(p[0]), deg(p[1]), deg(p[2])];
                    const pos = tlLivePosOf(name);
                    let k = tr.keys.find(x => x && Math.abs((Number(x.t) || 0) - t0) < 1e-6);
                    if (!k) { k = { t: t0 }; tr.keys.push(k); }
                    if (wantRot) k.rot = rot;
                    if (wantLoc) k.pos = [r2(pos[0]), r2(pos[1]), r2(pos[2])];
                    // Una chiave senza nessun canale non ha senso: se si inserisce una
                    // Location su una traccia nuova, la rotazione resta implicita
                    // (sample cade sull'ultima nota) e la chiave e' comunque valida.
                    tr.keys.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
                });
                tlSelected = names.map(n => ({ bone: n, t: t0 }));
                tlCommit();
            }

            // Traslazione viva dell'osso, in unita' voxel e RELATIVA al riposo.
            // Fonte primaria: rig.posePos (il canale di posa). Se manca si legge
            // direttamente l'osso, cosi' anche una posizione arrivata da altrove
            // (una clip applicata prima di questa modifica) viene catturata.
            function tlLivePosOf(name) {
                const d = rig && rig.posePos && rig.posePos[name];
                if (Array.isArray(d)) return [Number(d[0]) || 0, Number(d[1]) || 0, Number(d[2]) || 0];
                if (typeof skeleton !== 'undefined' && skeleton) {
                    const b = skeleton.bones.find(x => x.name === name);
                    const rest = (b && b.userData && b.userData.restPos) ? b.userData.restPos : null;
                    if (b && rest) return [b.position.x - rest.x, b.position.y - rest.y, b.position.z - rest.z];
                }
                return [0, 0, 0];
            }

            // --- menu "quali canali" (stile Unity/Blender) -------------------------------
            /* Premendo I (o il pulsante Chiave) non si inserisce subito: si sceglie
             * PRIMA cosa salvare, come fa Unity. Il menu e' costruito in JS perche'
             * nell'app non esiste un componente popup riutilizzabile; usa pero' le
             * classi .menu-dropdown/.menu-item gia' definite nel template, cosi'
             * eredita tema, bordi e sfocatura senza CSS nuovo. */
            let tlChanMenu = null;         // elemento aperto, o null
            let tlChanIndex = 0;           // voce evidenziata (frecce su/giu')

            const TL_CHANNELS = [
                { id: 'loc', icon: '✚', key: 'timeline.chanLoc', hint: 'L' },
                { id: 'rot', icon: '↻', key: 'timeline.chanRot', hint: 'R' },
                { id: 'locrot', icon: '✦', key: 'timeline.chanLocRot', hint: 'B' }
            ];

            function tlChanMenuOpen() { return !!tlChanMenu; }

            function tlCloseChanMenu() {
                if (!tlChanMenu) return;
                if (tlChanMenu.parentNode) tlChanMenu.parentNode.removeChild(tlChanMenu);
                tlChanMenu = null;
                document.removeEventListener('pointerdown', tlChanMenuOutside, true);
            }

            function tlChanMenuOutside(ev) {
                if (tlChanMenu && !tlChanMenu.contains(ev.target)) tlCloseChanMenu();
            }

            function tlChanHighlight() {
                if (!tlChanMenu) return;
                const items = tlChanMenu.querySelectorAll('.menu-item');
                items.forEach((b, i) => {
                    // Non c'e' una classe "selected" nel tema: si usa lo stesso
                    // colore dell'hover, cosi' mouse e tastiera si assomigliano.
                    b.style.background = (i === tlChanIndex) ? 'var(--hover-bg-strong)' : 'transparent';
                });
            }

            function tlChanPick(id) {
                tlCloseChanMenu();
                tlInsertKey(id);
            }

            // `anchor` e' l'elemento sotto cui aprire (il pulsante Chiave). Con la
            // scorciatoia da tastiera si usa comunque quel pulsante come riferimento:
            // e' sempre a schermo quando la timeline e' visibile.
            function tlOpenChanMenu(anchor) {
                if (!tlActiveAnim()) return;
                tlCloseChanMenu();
                const box = document.createElement('div');
                box.className = 'menu-dropdown';
                box.id = 'tlChannelMenu';
                box.style.display = 'flex';
                box.style.position = 'fixed';
                box.style.minWidth = '220px';
                TL_CHANNELS.forEach((c, i) => {
                    const b = document.createElement('button');
                    b.className = 'menu-item';
                    b.type = 'button';
                    b.dataset.chan = c.id;
                    // Costruito con createElement e non con innerHTML: il testo tradotto
                    // arriva da t() e non va mai concatenato dentro dell'HTML.
                    const ic = document.createElement('span');
                    ic.className = 'mi-icon';
                    ic.textContent = c.icon;
                    const lb = document.createElement('span');
                    lb.className = 'mi-label';
                    lb.textContent = t(c.key);
                    const hn = document.createElement('span');
                    hn.className = 'mi-hint';
                    hn.textContent = c.hint;
                    b.appendChild(ic); b.appendChild(lb); b.appendChild(hn);
                    b.addEventListener('click', () => tlChanPick(c.id));
                    b.addEventListener('mousemove', () => { tlChanIndex = i; tlChanHighlight(); });
                    box.appendChild(b);
                });
                document.body.appendChild(box);
                // Posizionamento: sopra il pulsante, perche' la timeline sta in fondo
                // alla finestra e un menu "sotto" finirebbe fuori schermo.
                const r = anchor ? anchor.getBoundingClientRect() : null;
                const h = box.offsetHeight || 120;
                const w = box.offsetWidth || 220;
                let left = r ? r.left : 20;
                let top = r ? (r.top - h - 6) : 80;
                if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
                if (left < 8) left = 8;
                if (top < 8) top = r ? (r.bottom + 6) : 8;
                box.style.left = Math.round(left) + 'px';
                box.style.top = Math.round(top) + 'px';
                tlChanMenu = box;
                tlChanIndex = 1;                 // Rotation: e' il caso piu' frequente
                tlChanHighlight();
                document.addEventListener('pointerdown', tlChanMenuOutside, true);
            }

            // Tastiera del menu. Registrata in CAPTURE e prima di tutto il resto:
            // mentre il menu e' aperto i tasti sono suoi, altrimenti una freccia
            // sposterebbe anche il frame corrente sotto al menu.
            function tlChanMenuKey(ev) {
                if (!tlChanMenu) return false;
                const k = ev.key;
                if (k === 'Escape') { tlCloseChanMenu(); return true; }
                if (k === 'ArrowDown' || k === 'ArrowUp') {
                    const n = TL_CHANNELS.length;
                    tlChanIndex = (tlChanIndex + (k === 'ArrowDown' ? 1 : n - 1)) % n;
                    tlChanHighlight();
                    return true;
                }
                if (k === 'Enter' || k === ' ') { tlChanPick(TL_CHANNELS[tlChanIndex].id); return true; }
                // Iniziali dirette: L / R / B, come le scorciatoie mostrate a destra.
                const direct = { l: 'loc', r: 'rot', b: 'locrot' }[String(k).toLowerCase()];
                if (direct) { tlChanPick(direct); return true; }
                // Un tasto qualunque (anche una seconda I) chiude senza inserire: meglio
                // di lasciarlo aperto a intercettare le scorciatoie.
                tlCloseChanMenu();
                return true;
            }

            function tlDeleteSelectedKeys() {
                const anim = tlActiveAnim();
                if (!anim || !tlSelected.length) return;
                if (typeof pushHistory === 'function') pushHistory();
                tlSelected.forEach(sel => {
                    const tr = (anim.tracks || []).find(x => x && x.bone === sel.bone);
                    if (!tr || !Array.isArray(tr.keys)) return;
                    tr.keys = tr.keys.filter(k => !k || Math.abs((Number(k.t) || 0) - sel.t) >= 1e-6);
                });
                // Le tracce rimaste senza chiavi sparirebbero comunque da
                // buildClipFromAnimData: toglierle qui tiene pulito il salvataggio.
                anim.tracks = (anim.tracks || []).filter(tr => tr && Array.isArray(tr.keys) && tr.keys.length);
                tlSelected = [];
                tlCommit();
            }

            // Dopo ogni modifica al dato: ricostruisci la clip THREE (cosi' l'export e il
            // menu animazioni restano allineati) e ridisegna.
            function tlCommit() {
                if (typeof buildAnimationClips === 'function') buildAnimationClips();
                tlSyncClipList();
                if (tlClipSel) tlClipSel.value = tlClipName;
                tlApplyAt(tlTimeOfFrame(tlFrame));
                tlRedraw();
            }

            function tlNewAnim() {
                if (!rig || !rig.bones || !rig.bones.length) {
                    alert(t('rig.skeletonNotReady'));
                    return;
                }
                const base = t('timeline.newAnimName');
                const name = (typeof uniqueAnimName === 'function') ? uniqueAnimName(base) : base;
                if (typeof pushHistory === 'function') pushHistory();
                if (!Array.isArray(rig.customAnims)) rig.customAnims = [];
                // Una traccia con una chiave sulla posa attuale: una clip senza tracce
                // non produce alcun AnimationClip e sparirebbe dal menu.
                const boneName = (selectedBoneIndex >= 0 && rig.bones[selectedBoneIndex])
                    ? rig.bones[selectedBoneIndex].name
                    : rig.bones.find(b => !b.helper).name;
                const p = (rig.pose && rig.pose[boneName]) || [0, 0, 0];
                const deg = r => Math.round((r * 180 / Math.PI) * 100) / 100;
                rig.customAnims.push({
                    name: name, duration: 2, fps: TL_DEFAULT_FPS, loop: true,
                    tracks: [{ bone: boneName, keys: [{ t: 0, rot: [deg(p[0]), deg(p[1]), deg(p[2])] }] }]
                });
                if (typeof buildAnimationClips === 'function') buildAnimationClips();
                tlSyncClipList();
                tlSelectClip(name);
            }

            function tlMakeEditable() {
                const clip = (typeof rigClips !== 'undefined' ? rigClips : []).find(c => c.name === tlClipName);
                if (!clip) return;
                const name = (typeof uniqueAnimName === 'function')
                    ? uniqueAnimName(tlClipName) : (tlClipName + '_edit');
                const data = tlAnimDataFromClip(clip, name);
                if (!data) { alert(t('timeline.notConvertible')); return; }
                if (typeof pushHistory === 'function') pushHistory();
                if (!Array.isArray(rig.customAnims)) rig.customAnims = [];
                rig.customAnims.push(data);
                if (typeof buildAnimationClips === 'function') buildAnimationClips();
                tlSyncClipList();
                tlSelectClip(name);
            }

            // --- interazione col mouse ----------------------------------------------------

            function tlLocalX(ev) {
                if (!tlRulerEl) return 0;
                const r = tlRulerEl.getBoundingClientRect();
                return ev.clientX - r.left;
            }

            function tlBeginScrub(ev) {
                tlStopPlayback();
                tlScrubbing = true;
                tlSetFrame(tlFrameOfX(tlLocalX(ev)));
                tlUpdateToolbar();
            }

            function tlOnPointerMove(ev) {
                if (tlScrubbing) {
                    tlSetFrame(tlFrameOfX(tlLocalX(ev)));
                    return;
                }
                if (tlKeyDrag) {
                    const anim = tlActiveAnim();
                    if (!anim) return;
                    const f = tlFrameOfX(tlLocalX(ev));
                    const delta = f - tlKeyDrag.startFrame;
                    if (delta === tlKeyDrag.lastDelta) return;
                    if (!tlKeyDrag.moved) {
                        if (typeof pushHistory === 'function') pushHistory();
                        tlKeyDrag.moved = true;
                    }
                    tlKeyDrag.lastDelta = delta;
                    tlApplyKeyDelta(anim, delta);
                    tlRedraw();
                }
            }

            // Sposta le chiavi selezionate di `delta` frame rispetto alla posizione
            // ORIGINALE (memorizzata all'inizio del trascinamento): applicare l'offset in
            // modo incrementale accumulerebbe errori e farebbe scavalcare le chiavi.
            function tlApplyKeyDelta(anim, delta) {
                const n = tlFrameCount();
                const newSel = [];
                tlKeyDrag.orig.forEach(o => {
                    const tr = (anim.tracks || []).find(x => x && x.bone === o.bone);
                    if (!tr) return;
                    const f0 = Math.round(tlFrameOfTime(o.t));
                    const f1 = Math.max(0, Math.min(n, f0 + delta));
                    const t1 = tlTimeOfFrame(f1);
                    const k = tr.keys.find(k => k && Math.abs((Number(k.t) || 0) - o.cur) < 1e-6);
                    if (!k) return;
                    // Se ci fosse gia' una chiave nella destinazione, quella viene assorbita
                    // (una sola chiave per frame per osso, come in Blender).
                    tr.keys = tr.keys.filter(x => x === k || Math.abs((Number(x.t) || 0) - t1) >= 1e-6);
                    k.t = t1;
                    o.cur = t1;
                    tr.keys.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
                    newSel.push({ bone: o.bone, t: t1 });
                });
                tlSelected = newSel;
            }

            function tlEndPointer() {
                if (tlKeyDrag && tlKeyDrag.moved) tlCommit();
                tlScrubbing = false;
                tlKeyDrag = null;
                // Il gesto e' finito: se nel frattempo il puntatore era uscito dal
                // dock, l'uscita rinviata da 'pointerleave' si applica adesso.
                if (tlHoverLeavePending) {
                    tlHoverLeavePending = false;
                    tlAreaHover = false;
                }
            }

            function tlOnRowsPointerDown(ev) {
                const el = ev.target;
                if (el && el.classList && el.classList.contains('tl-key') && !el.classList.contains('tl-key-ro')
                    && el.dataset.bone) {
                    ev.preventDefault();
                    const bone = el.dataset.bone;
                    const t0 = Number(el.dataset.t);
                    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
                    if (additive) {
                        if (tlIsSelectedKey(bone, t0)) {
                            tlSelected = tlSelected.filter(s => !(s.bone === bone && Math.abs(s.t - t0) < 1e-6));
                        } else {
                            tlSelected.push({ bone: bone, t: t0 });
                        }
                    } else if (!tlIsSelectedKey(bone, t0)) {
                        tlSelected = [{ bone: bone, t: t0 }];
                    }
                    tlKeyDrag = {
                        startFrame: tlFrameOfX(tlLocalX(ev)),
                        lastDelta: 0, moved: false,
                        orig: tlSelected.map(s => ({ bone: s.bone, t: s.t, cur: s.t }))
                    };
                    tlSetFrame(Math.round(tlFrameOfTime(t0)));
                    tlRedraw();
                    return;
                }
                // Click nel vuoto: deseleziona e scrubba.
                tlSelected = [];
                tlBeginScrub(ev);
                tlRedraw();
            }

            // --- visibilita' -------------------------------------------------------------

            // Chiamata da updateRigVisibility(): un solo punto di verita' per "sono nel Rig".
            function timelineSync() {
                if (!tlHasDom()) return;
                const on = (typeof rigPreviewActive !== 'undefined' && rigPreviewActive)
                    && !!(typeof rig !== 'undefined' && rig && rig.bones && rig.bones.length);
                if (on !== tlVisible) {
                    tlVisible = on;
                    tlDock.style.display = on ? '' : 'none';
                    if (!on) {
                        tlStopPlayback();
                        tlRelease();
                        tlSelected = [];
                        // Il menu dei canali vive in document.body: se la timeline
                        // sparisce mentre e' aperto resterebbe a mezz'aria.
                        tlCloseChanMenu();
                    }
                    // La viewport cambia altezza: il renderer va riadattato.
                    if (typeof scheduleResize === 'function') scheduleResize();
                }
                if (!tlVisible) return;
                tlSyncClipList();
                // Se la clip scelta e' sparita (undo, cambio oggetto) si torna a "nessuna".
                if (tlClipName !== 'none' && !tlFindAnim(tlClipName)
                    && !(typeof rigClips !== 'undefined' ? rigClips : []).some(c => c.name === tlClipName)) {
                    tlClipName = 'none';
                    if (tlClipSel) tlClipSel.value = 'none';
                    tlSelected = [];
                }
                // Firma: se cambia lo scheletro, la clip o la selezione, ridisegna.
                const sig = [tlClipName, rig ? rig.bones.length : 0, selectedBoneIndex,
                tlCountKeys(tlActiveAnim())].join('|');
                if (sig !== tlRowsBuilt) { tlRowsBuilt = sig; tlRedraw(); }
                else tlUpdateToolbar();
            }

            function timelineHeight() {
                return (tlVisible && tlDock) ? tlDock.offsetHeight : 0;
            }

            // --- wiring --------------------------------------------------------------------

            if (tlHasDom()) {
                tlDock.style.display = 'none';
                tlDock.style.height = tlDockHeight + 'px';

                if (tlClipSel) tlClipSel.addEventListener('change', () => tlSelectClip(tlClipSel.value));
                // tlTogglePlayInternal, non window.tlTogglePlay: il bundle e' UNO scope
                // condiviso, e il nome nudo si risolve solo passando dall'oggetto globale.
                if (tlPlayBtn) tlPlayBtn.addEventListener('click', tlTogglePlayInternal);
                if (tlStopBtn) tlStopBtn.addEventListener('click', () => {
                    tlStopPlayback();
                    if (typeof currentAction !== 'undefined' && currentAction) currentAction.stop();
                    tlSetFrame(0);
                    tlUpdateToolbar();
                });
                if (tlLoopBtn) tlLoopBtn.addEventListener('click', () => {
                    tlLoop = !tlLoop;
                    const anim = tlActiveAnim();
                    if (anim) anim.loop = tlLoop;
                    tlUpdateToolbar();
                });
                if (tlFirstBtn) tlFirstBtn.addEventListener('click', () => { tlStopPlayback(); tlSetFrame(0); tlUpdateToolbar(); });
                if (tlLastBtn) tlLastBtn.addEventListener('click', () => { tlStopPlayback(); tlSetFrame(tlFrameCount()); tlUpdateToolbar(); });

                const jumpKey = dir => {
                    const anim = tlActiveAnim();
                    const times = [];
                    if (anim) {
                        const m = tlKeyTimesByBone(anim);
                        Object.keys(m).forEach(b => m[b].forEach(t => {
                            if (!times.some(x => Math.abs(x - t) < 1e-6)) times.push(t);
                        }));
                    }
                    times.sort((a, b) => a - b);
                    const cur = tlTimeOfFrame(Math.round(tlFrame));
                    let target = null;
                    if (dir > 0) target = times.find(t => t > cur + 1e-6);
                    else { const before = times.filter(t => t < cur - 1e-6); target = before.length ? before[before.length - 1] : null; }
                    if (target === null) return;
                    tlStopPlayback();
                    tlSetFrame(Math.round(tlFrameOfTime(target)));
                    tlUpdateToolbar();
                };
                if (tlPrevKeyBtn) tlPrevKeyBtn.addEventListener('click', () => jumpKey(-1));
                if (tlNextKeyBtn) tlNextKeyBtn.addEventListener('click', () => jumpKey(1));

                // Il pulsante apre il menu dei canali invece di inserire subito: e' lo
                // stesso gesto della scorciatoia I, cosi' non ci sono due comportamenti.
                if (tlInsertBtn) tlInsertBtn.addEventListener('click', () => {
                    if (tlChanMenuOpen()) { tlCloseChanMenu(); return; }
                    tlOpenChanMenu(tlInsertBtn);
                });
                if (tlDeleteBtn) tlDeleteBtn.addEventListener('click', tlDeleteSelectedKeys);
                if (tlNewBtn) tlNewBtn.addEventListener('click', tlNewAnim);
                if (tlEditableBtn) tlEditableBtn.addEventListener('click', tlMakeEditable);

                if (tlFpsInput) tlFpsInput.addEventListener('change', () => {
                    const anim = tlActiveAnim();
                    if (!anim) return;
                    const v = Math.max(TL_MIN_FPS, Math.min(TL_MAX_FPS, Math.round(Number(tlFpsInput.value) || TL_DEFAULT_FPS)));
                    anim.fps = v;
                    tlFpsInput.value = String(v);
                    tlRedraw();
                });
                if (tlDurInput) tlDurInput.addEventListener('change', () => {
                    const anim = tlActiveAnim();
                    if (!anim) return;
                    const v = Math.max(0.1, Math.min(600, Number(tlDurInput.value) || 1));
                    if (typeof pushHistory === 'function') pushHistory();
                    anim.duration = v;
                    tlDurInput.value = String(Math.round(v * 100) / 100);
                    if (tlFrame > tlFrameCount()) tlFrame = tlFrameCount();
                    tlCommit();
                });

                if (tlScopeControl) {
                    window.tlSetKeyAllBones = function(val) {
                        tlKeyAllBones = !!val;
                        tlScopeControl.querySelectorAll('.seg-btn').forEach(btn => {
                            btn.classList.toggle('active', (btn.dataset.scope === 'all') === tlKeyAllBones);
                        });
                    };
                    tlScopeControl.querySelectorAll('.seg-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            window.tlSetKeyAllBones(btn.dataset.scope === 'all');
                        });
                    });
                }
                window.tlForceInsertKey = function() {
                    if (!tlVisible && tlActiveAnim()) tlOpenChanMenu(tlInsertBtn || document.body);
                    else if (tlActiveAnim()) tlOpenChanMenu(tlInsertBtn);
                };
                window.tlInsertKeyDirect = function(ch) {
                    tlInsertKey(ch);
                };

                if (tlRulerEl) tlRulerEl.addEventListener('pointerdown', ev => { ev.preventDefault(); tlBeginScrub(ev); });
                if (tlRowsEl) tlRowsEl.addEventListener('pointerdown', tlOnRowsPointerDown);
                window.addEventListener('pointermove', tlOnPointerMove);
                window.addEventListener('pointerup', tlEndPointer);

                // Trascinare il bordo superiore cambia l'altezza della barra (come i
                // pannelli di Blender). Il renderer si riadatta a fine trascinamento
                // tramite lo stesso scheduleResize() del resizer laterale.
                if (tlResizeEl) {
                    let rz = null;
                    tlResizeEl.addEventListener('pointerdown', ev => {
                        ev.preventDefault();
                        rz = { y: ev.clientY, h: tlDock.offsetHeight };
                        tlResizeEl.setPointerCapture(ev.pointerId);
                    });
                    tlResizeEl.addEventListener('pointermove', ev => {
                        if (!rz) return;
                        const h = Math.max(TL_MIN_H, Math.min(TL_MAX_H, rz.h + (rz.y - ev.clientY)));
                        tlDockHeight = h;
                        tlDock.style.height = h + 'px';
                        if (typeof scheduleResize === 'function') scheduleResize();
                    });
                    const endRz = ev => {
                        if (!rz) return;
                        rz = null;
                        try { tlResizeEl.releasePointerCapture(ev.pointerId); } catch (e) { }
                        tlRedraw();
                    };
                    tlResizeEl.addEventListener('pointerup', endRz);
                    tlResizeEl.addEventListener('pointercancel', endRz);
                }

                if (tlDock) {
                    tlDock.addEventListener('pointerenter', () => {
                        tlAreaHover = true;
                        tlHoverLeavePending = false;
                    });
                    tlDock.addEventListener('pointerleave', () => {
                        // Durante un trascinamento di chiavi il puntatore esce spesso dal
                        // dock: azzerare qui spegnerebbe la scorciatoia a meta' gesto.
                        // Ma l'uscita non va DIMENTICATA: se il gesto finisce col mouse
                        // ancora fuori, 'pointerleave' non si ripete piu' (si e' gia'
                        // usciti) e senza questo promemoria tlAreaHover restava true per
                        // sempre. La timeline rubava Ctrl+A al gizmo da tutto lo schermo,
                        // fino al successivo giro dentro e fuori dal dock.
                        if (tlKeyDrag || tlScrubbing) tlHoverLeavePending = true;
                        else tlAreaHover = false;
                    });
                    tlDock.addEventListener('focusin', () => { tlAreaFocus = true; });
                    tlDock.addEventListener('focusout', () => { tlAreaFocus = false; });
                }

                // Scorciatoie: valgono solo con la timeline a schermo e fuori dai campi di
                // testo. Si registrano in CAPTURE perche' 'Delete' e' gia' preso da
                // "elimina oggetto": qui va fermato prima che ci arrivi.
                window.addEventListener('keydown', ev => {
                    if (!tlVisible) return;
                    // Il menu dei canali, quando e' aperto, ha la priorita' su tutto:
                    // frecce ed Invio servono a scegliere la voce, non a muovere il frame.
                    if (tlChanMenuOpen()) {
                        if (tlChanMenuKey(ev)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
                        return;
                    }
                    const el = ev.target;
                    // isTypingTarget (01-scene-setup.js) e' la fonte unica. Il range
                    // resta escluso come prima: le frecce sullo slider muovono lo
                    // slider, non il frame corrente.
                    const isRange = !!(el && el.tagName === 'INPUT' && el.type === 'range');
                    if (isTypingTarget(ev) || isRange) return;
                    // Ctrl+A appartiene alla timeline solo quando si e' DENTRO la sua
                    // area: fuori resta del gizmo globale (01-scene-setup.js). Shift e Alt
                    // esclusi: Ctrl+Shift+A e' del rig (15-rig.js).
                    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey
                        && (ev.key === 'a' || ev.key === 'A')) {
                        if (!tlAreaActive() || tlModalOpen()) return;
                        if (tlSelectAllKeys()) {
                            ev.preventDefault();
                            ev.stopImmediatePropagation();
                        }
                        return;
                    }
                    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
                    if (tlModalOpen()) return;               // una modale aperta ha la priorita'
                    if (tlIsTogglePlayKey(ev.key)) {
                        // Su un elemento attivabile lo Spazio E' il clic da tastiera: se lo
                        // rubassimo, non si potrebbero piu' premere i pulsanti col tab.
                        // L'unica eccezione e' il pulsante Play della barra, che fa
                        // comunque questa stessa cosa (e senza uscire qui lo farebbe due
                        // volte: una dal keydown, una dal click sintetico).
                        if (tlIsActivatable(el) && el !== tlPlayBtn) return;
                        // preventDefault: senza, lo Spazio scrolla la pagina.
                        ev.preventDefault(); ev.stopImmediatePropagation();
                        tlTogglePlayInternal();
                    } else if ((ev.key === 'Delete' || ev.key === 'x' || ev.key === 'X') && tlSelected.length) {
                        ev.preventDefault(); ev.stopImmediatePropagation();
                        tlDeleteSelectedKeys();
                    } else if (ev.key === 'i' || ev.key === 'I') {
                        if (!tlActiveAnim()) return;
                        ev.preventDefault(); ev.stopImmediatePropagation();
                        // Come in Unity: I non inserisce, apre la scelta del canale.
                        tlOpenChanMenu(tlInsertBtn);
                    } else if (ev.key === 'ArrowLeft') {
                        ev.preventDefault(); tlStopPlayback(); tlSetFrame(Math.round(tlFrame) - 1); tlUpdateToolbar();
                    } else if (ev.key === 'ArrowRight') {
                        ev.preventDefault(); tlStopPlayback(); tlSetFrame(Math.round(tlFrame) + 1); tlUpdateToolbar();
                    }
                }, true);

                // Lo Spazio su un pulsante che ha il focus genera ANCHE un click
                // sintetico al keyup. Sul pulsante Play quel click ri-toggla e annulla
                // l'effetto della scorciatoia: qui gli si toglie il focus al primo uso da
                // tastiera, cosi' resta un solo toggle per pressione.
                if (tlPlayBtn) {
                    tlPlayBtn.addEventListener('keydown', ev => {
                        if (tlIsTogglePlayKey(ev.key)) tlPlayBtn.blur();
                    });
                }

                // La larghezza della pista dipende dalla viewport: ridisegna al resize.
                if (typeof ResizeObserver !== 'undefined') {
                    const ro = new ResizeObserver(() => { if (tlVisible) tlRedraw(); });
                    ro.observe(tlDock);
                }
            }
