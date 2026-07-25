            function greedyMesh(voxels) {
                if (!voxels.length) return [];
                const map = new Map();
                const min = [Infinity, Infinity, Infinity];
                const max = [-Infinity, -Infinity, -Infinity];
                for (const vx of voxels) {
                    map.set(`${vx.x},${vx.y},${vx.z}`, vx.color.toUpperCase());
                    const p = [vx.x, vx.y, vx.z];
                    for (let i = 0; i < 3; i++) { if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i]; }
                }
                const dims = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
                // voxel color at LOCAL coords (offset by min), or undefined if empty.
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
                                if (cur && !prev) entry = { color: cur, back: false };
                                else if (!cur && prev) entry = { color: prev, back: true };
                                mask[x[v] * w + x[u]] = entry;
                            }
                        }
                        // Merge the 2D mask into maximal same-color rectangles.
                        for (let j = 0; j < h; j++) {
                            for (let i = 0; i < w;) {
                                const start = mask[j * w + i];
                                if (!start) { i++; continue; }
                                let wq = 1;
                                while (i + wq < w) {
                                    const m = mask[j * w + i + wq];
                                    if (m && m.color === start.color && m.back === start.back) wq++; else break;
                                }
                                let hq = 1;
                                let grow = true;
                                while (j + hq < h && grow) {
                                    for (let k = 0; k < wq; k++) {
                                        const m = mask[(j + hq) * w + i + k];
                                        if (!(m && m.color === start.color && m.back === start.back)) { grow = false; break; }
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
                                quads.push({ verts, color: start.color, normal });
                                for (let jj = 0; jj < hq; jj++)
                                    for (let ii = 0; ii < wq; ii++) mask[(j + jj) * w + i + ii] = null;
                                i += wq;
                            }
                        }
                    }
                }
                return quads;
            }

            // Material name for a color, sanitized so it's a valid OBJ/MTL token
            // (Blender is picky: no '#', no stray chars).
            function matNameFor(colorHex) {
                return `mat_${colorHex.replace('#', '').toUpperCase()}`;
            }

            // Build the .mtl text for every color used in the model.
            function buildMtlText() {
                let mtlText = `# Voxel Materials File\n# Exported from VoxelAIArtist\n\n`;
                const allVoxels = currentModelData.voxels || [];
                const uniqueColors = [...new Set(allVoxels.map(v => v.color.toUpperCase()))];
                uniqueColors.forEach(color => {
                    const hex = color.replace('#', '');
                    const r = parseInt(hex.substring(0, 2), 16) / 255.0;
                    const g = parseInt(hex.substring(2, 4), 16) / 255.0;
                    const b = parseInt(hex.substring(4, 6), 16) / 255.0;
                    mtlText += `newmtl ${matNameFor(color)}\n`;
                    mtlText += `Kd ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}\n`;
                    mtlText += `Ka ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}\n`;
                    mtlText += `Ks 0.0000 0.0000 0.0000\n`;
                    mtlText += `Ns 1.0000\n`;
                    mtlText += `d 1.0000\n`;
                    mtlText += `illum 1\n\n`;
                });
                return mtlText;
            }

            // Build the greedy-meshed .obj text, referencing the given mtl file name.
            function buildObjText(mtlFileName) {
                const voxels = currentModelData.voxels || [];
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

                // Group quad face lines by material.
                const facesByMat = {};
                quads.forEach(q => {
                    const mat = matNameFor(q.color);
                    const ni = nId(q.normal);
                    const ids = q.verts.map(p => vId(p));
                    const line = `f ${ids.map(id => `${id}//${ni}`).join(' ')}`;
                    (facesByMat[mat] = facesByMat[mat] || []).push(line);
                });

                objText += vLines.join('\n') + '\n' + nLines.join('\n') + '\n\n';
                Object.keys(facesByMat).forEach(mat => {
                    objText += `usemtl ${mat}\n` + facesByMat[mat].join('\n') + '\n\n';
                });
                return objText;
            }

            // Exporting OBJ downloads the MTL too — Blender needs the .mtl next to the
            // .obj (with the exact name in `mtllib`) or every material imports white.
            document.getElementById('exportObjBtn').addEventListener('click', () => {
                const meta = currentModelData.metadata || {};
                const name = (meta.name || "voxel_model").replace(/\s+/g, '_');
                downloadFile(buildMtlText(), `${name}.mtl`, 'text/plain');
                // Small delay so browsers don't collapse the two downloads into one.
                setTimeout(() => downloadFile(buildObjText(`${name}.mtl`), `${name}.obj`, 'text/plain'), 150);
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