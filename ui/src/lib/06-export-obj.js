            function greedyMesh(voxels) {
                if (!voxels.length) return [];
                const map = new Map();
                const min = [Infinity, Infinity, Infinity];
                const max = [-Infinity, -Infinity, -Infinity];
                for (const vx of voxels) {
                    // Si unisce per TOKEN, non per colore: due voxel dello stesso
                    // colore con materiali diversi vogliono due `usemtl` distinti,
                    // altrimenti la texture del primo si spalma anche sul secondo.
                    map.set(`${vx.x},${vx.y},${vx.z}`, tokenOf(vx));
                    const p = [vx.x, vx.y, vx.z];
                    for (let i = 0; i < 3; i++) { if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i]; }
                }
                const dims = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
                // voxel TOKEN at LOCAL coords (offset by min), or undefined if empty.
                const voxel = (i, j, k) => map.get(`${i + min[0]},${j + min[1]},${k + min[2]}`);
                const quads = [];

                for (let d = 0; d < 3; d++) {
                    const u = (d + 1) % 3, v = (d + 2) % 3;
                    const w = dims[u], h = dims[v];
                    const x = [0, 0, 0];
                    // Sweep every plane perpendicular to axis d, including the two outer boundaries.
                    for (x[d] = 0; x[d] <= dims[d]; x[d]++) {
                        const mask = new Array(w * h).fill(null);
                        for (x[v] = 0; x[v] < h; x[v]++) {
                            for (x[u] = 0; x[u] < w; x[u]++) {
                                const cur = (x[d] < dims[d]) ? voxel(x[0], x[1], x[2]) : undefined;
                                const pc = [x[0], x[1], x[2]]; pc[d] -= 1;
                                const prev = (x[d] > 0) ? voxel(pc[0], pc[1], pc[2]) : undefined;
                                // A face exists only where exactly one side is filled.
                                let entry = null;
                                if (cur && !prev) entry = { token: cur, back: false };
                                else if (!cur && prev) entry = { token: prev, back: true };
                                mask[x[v] * w + x[u]] = entry;
                            }
                        }
                        // Merge the 2D mask into maximal same-token rectangles.
                        for (let j = 0; j < h; j++) {
                            for (let i = 0; i < w;) {
                                const start = mask[j * w + i];
                                if (!start) { i++; continue; }
                                let wq = 1;
                                while (i + wq < w) {
                                    const m = mask[j * w + i + wq];
                                    if (m && m.token === start.token && m.back === start.back) wq++; else break;
                                }
                                let hq = 1;
                                let grow = true;
                                while (j + hq < h && grow) {
                                    for (let k = 0; k < wq; k++) {
                                        const m = mask[(j + hq) * w + i + k];
                                        if (!(m && m.token === start.token && m.back === start.back)) { grow = false; break; }
                                    }
                                    if (grow) hq++;
                                }
                                // Build the quad corners (world coords; face plane sits at integer-0.5).
                                const base = [0, 0, 0]; base[d] = x[d]; base[u] = i; base[v] = j;
                                const du = [0, 0, 0]; du[u] = wq;
                                const dv = [0, 0, 0]; dv[v] = hq;
                                const off = a => [a[0] + min[0] - 0.5, a[1] + min[1] - 0.5, a[2] + min[2] - 0.5];
                                const p0 = off(base);
                                const p1 = off([base[0] + du[0], base[1] + du[1], base[2] + du[2]]);
                                const p2 = off([base[0] + du[0] + dv[0], base[1] + du[1] + dv[1], base[2] + du[2] + dv[2]]);
                                const p3 = off([base[0] + dv[0], base[1] + dv[1], base[2] + dv[2]]);
                                const normal = [0, 0, 0]; normal[d] = start.back ? 1 : -1;
                                const verts = start.back ? [p0, p3, p2, p1] : [p0, p1, p2, p3];
                                // `token` e' cio' su cui il mesher ha unito ('#RRGGBB' o
                                // '@m1'); `uw`/`uh` sono l'estensione del quad in VOXEL e
                                // servono agli UV: la texture si ripete una volta per
                                // voxel invece di stirarsi su tutto il quad.
                                //
                                // `uvs` esce GIA' ordinato come `verts`, non come lista
                                // fissa: `verts` si inverte quando la faccia e' `back`, e
                                // una lista fissa risulterebbe TRASPOSTA sull'altro verso
                                // (su un quad 3x1 la texture si ripeterebbe 3 volte
                                // nella direzione da 1 voxel). Su un quad quadrato la
                                // svista e' invisibile, per questo va tenuta qui, dove i
                                // due ordinamenti sono uno accanto all'altro.
                                //
                                // `color` e' un alias storico di `token` e ne condivide
                                // il valore: NON e' piu' garantito che sia un hex, quindi
                                // non ci si passi sopra un .replace('#','') o un parseInt.
                                const uvs = start.back
                                    ? [[0, 0], [0, hq], [wq, hq], [wq, 0]]
                                    : [[0, 0], [wq, 0], [wq, hq], [0, hq]];
                                quads.push({ verts, color: start.token, token: start.token, normal, uw: wq, uh: hq, uvs });
                                for (let jj = 0; jj < hq; jj++)
                                    for (let ii = 0; ii < wq; ii++) mask[(j + jj) * w + i + ii] = null;
                                i += wq;
                            }
                        }
                    }
                }
                return quads;
            }

            // Material name for a TOKEN, sanitized so it's a valid OBJ/MTL token
            // (Blender is picky: no '#', no '@', no stray chars).
            function matNameFor(token) {
                if (isMaterialToken(token)) return `mat_${token.slice(1)}`;
                return `mat_${String(token).replace('#', '').toUpperCase()}`;
            }

            function textureFileName(id) { return `tex_${id}.png`; }

            // Build the .mtl text for every TOKEN used in the model.
            // `voxelsOverride` permette di esportare un modello DIVERSO da quello
            // attivo (serve all'export del pack, che scrive N asset in uno ZIP).
            // Omesso = comportamento originale sull'oggetto attivo.
            function buildMtlText(voxelsOverride) {
                let mtlText = `# Voxel Materials File\n# Exported from VoxelAIArtist\n\n`;
                const allVoxels = voxelsOverride || currentModelData.voxels || [];
                // Ogni token si porta dietro il colore di UN voxel che lo usa: su
                // un id orfano e' l'unico modo di risalire alla tinta vera, perche'
                // il token '@m1' l'ha gia' buttata via (vedi decodeToken).
                const seen = new Map();
                allVoxels.forEach(v => {
                    const tok = tokenOf(v);
                    if (!seen.has(tok)) seen.set(tok, v.color);
                });
                seen.forEach((voxelColor, token) => {
                    const dec = decodeToken(token, voxelColor);
                    // materialById, non `dec.material`: su un orfano l'id resta
                    // valorizzato ma la definizione non c'e'.
                    const def = materialById(dec.material);
                    const hex = dec.color.replace('#', '');
                    const r = parseInt(hex.substring(0, 2), 16) / 255.0;
                    const g = parseInt(hex.substring(2, 4), 16) / 255.0;
                    const b = parseInt(hex.substring(4, 6), 16) / 255.0;
                    mtlText += `newmtl ${matNameFor(token)}\n`;
                    // Kd resta anche con la texture: un .mtl aperto SENZA i PNG accanto
                    // mostra allora la tinta media invece del bianco.
                    mtlText += `Kd ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}\n`;
                    mtlText += `Ka ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}\n`;
                    mtlText += `Ks 0.0000 0.0000 0.0000\n`;
                    mtlText += `Ns 1.0000\n`;
                    // `d` e' la DISSOLVENZA del formato MTL: 1 = opaco. Va scritta
                    // dall'opacita' del materiale, altrimenti un vetro esportato
                    // arriverebbe pieno in Blender. `Tr` e' la stessa cosa invertita
                    // e non si emette: i due si contraddicono e i loader la
                    // risolvono in modo diverso (l'ultimo letto vince, e quale sia
                    // dipende dal loader).
                    //
                    // Il default e' 1 e non `def.opacity` nudo: normalizeMaterial lo
                    // riempie sempre, ma una definizione arrivata da un plugin (o da
                    // un percorso che salta la normalizzazione) lo avrebbe undefined,
                    // e un toFixed su undefined farebbe fallire l'INTERO export
                    // invece di sbagliare una riga.
                    const alpha = (def && typeof def.opacity === 'number') ? def.opacity : 1;
                    mtlText += `d ${alpha.toFixed(4)}\n`;
                    // illum 1 e' diffuso senza speculare; con la trasparenza serve
                    // il 2, che e' il modello che i loader collegano alla
                    // dissolvenza.
                    mtlText += `illum ${alpha < 1 ? 2 : 1}\n`;
                    if (def && def.texture && def.texture.data) {
                        mtlText += `map_Kd ${textureFileName(def.id)}\n`;
                    }
                    mtlText += `\n`;
                });
                return mtlText;
            }

            // Build the greedy-meshed .obj text, referencing the given mtl file name.
            function buildObjText(mtlFileName, voxelsOverride) {
                const voxels = voxelsOverride || currentModelData.voxels || [];
                const quads = greedyMesh(voxels);

                let objText = `# Voxel 3D Model\n# Exported from VoxelAIArtist (greedy meshed)\n`;
                objText += `mtllib ${mtlFileName}\n\no VoxelModel\n`;

                // Dedupe vertices and normals so the file stays compact.
                const vIndex = new Map(); const vLines = [];
                const nIndex = new Map(); const nLines = [];
                const vId = p => {
                    const key = `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
                    let id = vIndex.get(key);
                    if (id === undefined) { vLines.push(`v ${p[0].toFixed(3)} ${p[1].toFixed(3)} ${p[2].toFixed(3)}`); id = vLines.length; vIndex.set(key, id); }
                    return id;
                };
                const nId = n => {
                    const key = n.join(',');
                    let id = nIndex.get(key);
                    if (id === undefined) { nLines.push(`vn ${n[0]} ${n[1]} ${n[2]}`); id = nLines.length; nIndex.set(key, id); }
                    return id;
                };
                const tIndex = new Map(); const tLines = [];
                const tId = (u, v) => {
                    const key = `${u},${v}`;
                    let id = tIndex.get(key);
                    if (id === undefined) { tLines.push(`vt ${u} ${v}`); id = tLines.length; tIndex.set(key, id); }
                    return id;
                };

                // Group quad face lines by material.
                const facesByMat = {};
                quads.forEach(q => {
                    const mat = matNameFor(q.token);
                    const ni = nId(q.normal);
                    const ids = q.verts.map(p => vId(p));
                    // UV 0..uw / 0..uh con wrap `repeat`: un quad che copre 3x2 voxel
                    // ripete la texture 3x2 volte. Con 0..1 la texture si stirerebbe
                    // sul quad intero e i voxel uniti dal greedy mesh sembrerebbero
                    // un blocco solo. L'ordine lo decide il mesher insieme ai verts.
                    const uvs = q.uvs.map(uv => tId(uv[0], uv[1]));
                    const line = `f ${ids.map((id, i) => `${id}/${uvs[i]}/${ni}`).join(' ')}`;
                    (facesByMat[mat] = facesByMat[mat] || []).push(line);
                });

                objText += vLines.join('\n') + '\n' + tLines.join('\n') + '\n' + nLines.join('\n') + '\n\n';
                Object.keys(facesByMat).forEach(mat => {
                    objText += `usemtl ${mat}\n` + facesByMat[mat].join('\n') + '\n\n';
                });
                return objText;
            }

            // Con le texture i file diventano N+2 e scaricarli uno a uno e' scomodo
            // (e i browser bloccano i download multipli). Senza texture resta il doppio
            // download di prima: nessuna regressione per chi non usa i materiali.
            function texturedMaterialsInUse(voxels) {
                const ids = new Set(voxels.filter(v => v.material).map(v => v.material));
                const out = [];
                ids.forEach(id => {
                    // materialById, non l'id nudo: un id ORFANO non ha PNG da
                    // impacchettare e non deve far scattare lo ZIP da solo.
                    const def = materialById(id);
                    if (def && def.texture && def.texture.data) out.push(def);
                });
                return out;
            }

            // La data URL torna in BYTE: createZipBlob scrive tale e quale solo un
            // Uint8Array, mentre una stringa la ricodifica in UTF-8 e il PNG
            // uscirebbe corrotto (i byte oltre 0x7F diventano due byte).
            function dataUrlToBytes(dataUrl) {
                const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
                const bin = atob(b64);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                return out;
            }

            // Exporting OBJ downloads the MTL too — Blender needs the .mtl next to the
            // .obj (with the exact name in `mtllib`) or every material imports white.
            document.getElementById('exportObjBtn').addEventListener('click', () => {
                const meta = currentModelData.metadata || {};
                const name = (meta.name || "voxel_model").replace(/\s+/g, '_');
                const voxels = currentModelData.voxels || [];
                const textured = texturedMaterialsInUse(voxels);
                if (textured.length === 0) {
                    downloadFile(buildMtlText(), `${name}.mtl`, 'text/plain');
                    // Small delay so browsers don't collapse the two downloads into one.
                    setTimeout(() => downloadFile(buildObjText(`${name}.mtl`), `${name}.obj`, 'text/plain'), 150);
                    return;
                }
                const files = [
                    { name: `${name}.obj`, data: buildObjText(`${name}.mtl`) },
                    { name: `${name}.mtl`, data: buildMtlText() }
                ];
                textured.forEach(def => files.push({ name: textureFileName(def.id), data: dataUrlToBytes(def.texture.data) }));
                downloadBlob(createZipBlob(files), `${name}.zip`);
            });

            document.getElementById('exportMtlBtn').addEventListener('click', () => {
                const meta = currentModelData.metadata || {};
                const name = (meta.name || "voxel_model").replace(/\s+/g, '_');
                downloadFile(buildMtlText(), `${name}.mtl`, 'text/plain');
            });

            function downloadFile(content, fileName, contentType) {
                const a = document.createElement("a");
                const file = new Blob([content], { type: contentType });
                a.href = URL.createObjectURL(file);
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(a.href);
            }

            // Save the current model (including any edits) as a flat-voxels JSON.
            // This round-trips perfectly: drop the file back on the dropzone to keep editing.
            // Compress one model-data payload into the compact palette + "set" ops format.