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
                Object.keys(s.rot).forEach(name => { rig.pose[name] = s.rot[name]; });
                applyPoseToBones();
                Object.keys(s.pos).forEach(name => {
                    const b = skeleton.bones.find(x => x.name === name);
                    if (!b) return;
                    const rest = (b.userData && b.userData.restPos) ? b.userData.restPos : null;
                    if (!rest) return;
                    b.position.set(rest.x + s.pos[name][0], rest.y + s.pos[name][1], rest.z + s.pos[name][2]);
                });
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
                keyTimes.forEach(t => {
                    const k = document.createElement('div');
                    k.className = 'tl-key' + (isSummary ? ' tl-key-sum' : '');
                    if (!isSummary && tlIsSelectedKey(boneName, t)) k.classList.add('tl-key-sel');
                    if (readOnly) k.classList.add('tl-key-ro');
                    k.style.left = tlXOfFrame(tlFrameOfTime(t)) + 'px';
                    k.dataset.t = String(t);
                    k.dataset.bone = boneName || '';
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
                    tlPlayBtn.disabled = !hasClip;
                    tlPlayBtn.textContent = tlPlaying ? t('timeline.pause') : t('timeline.play');
                    tlPlayBtn.title = tlPlaying ? t('timeline.pauseTitle') : t('timeline.playTitle');
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

            function tlStopPlayback() {
                tlPlaying = false;
                if (tlPlayBtn) {
                    tlPlayBtn.textContent = t('timeline.play');
                    tlPlayBtn.title = t('timeline.playTitle');
                }
            }

            function tlTogglePlay() {
                if (!tlClipName || tlClipName === 'none') return;
                const anim = tlActiveAnim();
                if (!anim) {
                    // Preset: delega al mixer (play/stop dell'action corrente).
                    if (typeof currentAction !== 'undefined' && currentAction) {
                        currentAction.paused = !currentAction.paused;
                        tlPlaying = !currentAction.paused;
                    } else if (typeof playClip === 'function') {
                        playClip(tlClipName);
                        tlPlaying = true;
                    }
                } else {
                    tlPlaying = !tlPlaying;
                    if (tlPlaying) tlTakeOver();
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
            function tlInsertKey() {
                const anim = tlActiveAnim();
                if (!anim || !rig) return;
                const t0 = tlSnapTime(tlTimeOfFrame(Math.round(tlFrame)));
                const deg = r => Math.round((r * 180 / Math.PI) * 100) / 100;
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
                    const existing = tr.keys.find(k => k && Math.abs((Number(k.t) || 0) - t0) < 1e-6);
                    if (existing) existing.rot = rot;
                    else tr.keys.push({ t: t0, rot: rot });
                    tr.keys.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
                });
                tlSelected = names.map(n => ({ bone: n, t: t0 }));
                tlCommit();
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
                if (tlPlayBtn) tlPlayBtn.addEventListener('click', tlTogglePlay);
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

                if (tlInsertBtn) tlInsertBtn.addEventListener('click', tlInsertKey);
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
                    tlScopeControl.querySelectorAll('.seg-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            tlKeyAllBones = btn.dataset.scope === 'all';
                            tlScopeControl.querySelectorAll('.seg-btn').forEach(b =>
                                b.classList.toggle('active', b === btn));
                        });
                    });
                }

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

                // Scorciatoie: valgono solo con la timeline a schermo e fuori dai campi di
                // testo. Si registrano in CAPTURE perche' 'Delete' e' gia' preso da
                // "elimina oggetto": qui va fermato prima che ci arrivi.
                window.addEventListener('keydown', ev => {
                    if (!tlVisible) return;
                    const el = ev.target;
                    const typing = !!(el && ((el.tagName === 'INPUT' && el.type !== 'range')
                        || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
                    if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
                    if (ev.key === ' ' || ev.key === 'Spacebar') {
                        ev.preventDefault(); ev.stopImmediatePropagation();
                        tlTogglePlay();
                    } else if ((ev.key === 'Delete' || ev.key === 'x' || ev.key === 'X') && tlSelected.length) {
                        ev.preventDefault(); ev.stopImmediatePropagation();
                        tlDeleteSelectedKeys();
                    } else if (ev.key === 'i' || ev.key === 'I') {
                        if (!tlActiveAnim()) return;
                        ev.preventDefault(); ev.stopImmediatePropagation();
                        tlInsertKey();
                    } else if (ev.key === 'ArrowLeft') {
                        ev.preventDefault(); tlStopPlayback(); tlSetFrame(Math.round(tlFrame) - 1); tlUpdateToolbar();
                    } else if (ev.key === 'ArrowRight') {
                        ev.preventDefault(); tlStopPlayback(); tlSetFrame(Math.round(tlFrame) + 1); tlUpdateToolbar();
                    }
                }, true);

                // La larghezza della pista dipende dalla viewport: ridisegna al resize.
                if (typeof ResizeObserver !== 'undefined') {
                    const ro = new ResizeObserver(() => { if (tlVisible) tlRedraw(); });
                    ro.observe(tlDock);
                }
            }
