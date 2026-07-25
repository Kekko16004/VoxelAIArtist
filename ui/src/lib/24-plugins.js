            // ===== Plugin / Script utente — API SANDBOXATA (W2-C punto 7) =====
            //
            // Decisione utente (vedi board): gli script utente girano in una sandbox
            // SENZA accesso a rete / filesystem / DOM, con hook documentati.
            //
            // Isolamento: lo script gira in un **Web Worker** dedicato. Un worker non ha
            // accesso al DOM (niente `document`, `window`), non condivide scope con la app
            // e viene TERMINATO se supera il timeout. In più il bootstrap del worker
            // azzera esplicitamente le API di rete/persistenza (fetch, XMLHttpRequest,
            // WebSocket, importScripts, indexedDB, ...), così anche un plugin ostile non
            // può esfiltrare dati o "phone home". Il worker comunica SOLO via postMessage:
            // riceve i voxel dell'oggetto attivo, restituisce i nuovi voxel.
            //
            // Fallback: se la creazione del Worker fallisce (ambienti che bloccano i
            // blob-URL worker), si usa un sandbox in-thread basato su `Function` con lo
            // scope oscurato (globals pericolosi ombreggiati). Meno robusto del worker —
            // segnalato all'utente — ma senza rete/DOM raggiungibili per nome.
            //
            // CONTRATTO PLUGIN (documentato, stabile):
            //   Lo script definisce una funzione `transform(voxels, api)`.
            //     - voxels: Array di {x,y,z,color} (copia dei voxel dell'oggetto ATTIVO).
            //     - api: oggetto di sole utility PURE (nessun side effect, nessun I/O):
            //         api.metadata      -> {name, grid_size:[x,y,z]} (sola lettura, copia)
            //         api.gridSize      -> [x,y,z]
            //         api.log(msg)      -> messaggio mostrato nello stato UI (stringa)
            //         api.hexToRgb(hex) -> {r,g,b}   api.rgbToHex(r,g,b) -> "#rrggbb"
            //         api.key(x,y,z)    -> "x,y,z" (chiave voxel)
            //     - Ritorno: Array di voxel {x,y,z,color}. Coordinate intere; color = "#rrggbb".
            //   Voxel non validi vengono scartati con conteggio; se il ritorno non è un
            //   array valido, l'operazione è annullata (nessuna modifica alla scena).
            //
            // HOOK/ciclo: Esegui -> valida -> pushHistory() -> sostituisci voxels ->
            //   buildModel(false, true). Quindi è ANNULLABILE con Ctrl+Z come ogni edit.

            const PLUGIN_TIMEOUT_MS = 4000;   // oltre questo, il worker viene terminato
            const PLUGIN_MAX_VOXELS = 400000; // guardia anti-OOM sul risultato

            // Plugin di esempio (didattici). L'utente può modificarne il codice nel
            // textarea; "Ripristina" ricarica questi sorgenti. Sono anche la doc viva
            // del contratto `transform(voxels, api)`.
            const BUILTIN_PLUGINS = [
                {
                    id: 'mirror-x',
                    name: 'Specchia su X',
                    desc: 'Duplica i voxel riflettendoli sull\'asse X (crea simmetria).',
                    code:
"// Specchia il modello sull'asse X.\n" +
"function transform(voxels, api) {\n" +
"  const g = api.gridSize[0] || 32;\n" +
"  const out = voxels.slice();\n" +
"  const seen = new Set(voxels.map(v => api.key(v.x, v.y, v.z)));\n" +
"  for (const v of voxels) {\n" +
"    const mx = (g - 1) - v.x;\n" +
"    const k = api.key(mx, v.y, v.z);\n" +
"    if (!seen.has(k)) { out.push({ x: mx, y: v.y, z: v.z, color: v.color }); seen.add(k); }\n" +
"  }\n" +
"  api.log('Voxel dopo lo specchio: ' + out.length);\n" +
"  return out;\n" +
"}\n"
                },
                {
                    id: 'grayscale',
                    name: 'Scala di grigi',
                    desc: 'Converte i colori di tutti i voxel in scala di grigi (luminanza).',
                    code:
"// Converte ogni voxel in grigio secondo la luminanza percepita.\n" +
"function transform(voxels, api) {\n" +
"  return voxels.map(v => {\n" +
"    const c = api.hexToRgb(v.color);\n" +
"    const y = Math.round(0.299*c.r + 0.587*c.g + 0.114*c.b);\n" +
"    return { x: v.x, y: v.y, z: v.z, color: api.rgbToHex(y, y, y) };\n" +
"  });\n" +
"}\n"
                },
                {
                    id: 'hollow',
                    name: 'Svuota interno',
                    desc: 'Rimuove i voxel completamente circondati (mantiene solo il guscio).',
                    code:
"// Mantiene solo i voxel esposti: rimuove quelli con tutti e 6 i vicini pieni.\n" +
"function transform(voxels, api) {\n" +
"  const set = new Set(voxels.map(v => api.key(v.x, v.y, v.z)));\n" +
"  const N = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];\n" +
"  return voxels.filter(v =>\n" +
"    N.some(d => !set.has(api.key(v.x+d[0], v.y+d[1], v.z+d[2]))));\n" +
"}\n"
                }
            ];

            // --- Sorgente del bootstrap del Worker (stringa: gira in un contesto isolato) ---
            // Riceve {code, voxels, metadata}; azzera le API pericolose; definisce l'api
            // pura; esegue transform(); risponde con {ok, voxels|error, logs}.
            const PLUGIN_WORKER_SRC =
"self.onmessage = function(ev) {\n" +
"  var logs = [];\n" +
"  try {\n" +
"    var d = ev.data || {};\n" +
"    // Azzera rete / persistenza / caricamento codice esterno.\n" +
"    var kill = ['fetch','XMLHttpRequest','WebSocket','importScripts','indexedDB',\n" +
"                'caches','navigator','Notification','SharedWorker','Worker'];\n" +
"    for (var i=0;i<kill.length;i++){ try { self[kill[i]] = undefined; } catch(e){} }\n" +
"    var api = {\n" +
"      metadata: d.metadata || {},\n" +
"      gridSize: (d.metadata && d.metadata.grid_size) || [32,32,32],\n" +
"      log: function(m){ logs.push(String(m)); },\n" +
"      key: function(x,y,z){ return x+','+y+','+z; },\n" +
"      hexToRgb: function(hex){ hex=String(hex||'#000').replace('#',''); if(hex.length===3){hex=hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];} var n=parseInt(hex,16)||0; return {r:(n>>16)&255,g:(n>>8)&255,b:n&255}; },\n" +
"      rgbToHex: function(r,g,b){ function h(v){v=Math.max(0,Math.min(255,v|0));return ('0'+v.toString(16)).slice(-2);} return '#'+h(r)+h(g)+h(b); }\n" +
"    };\n" +
"    // Definisce transform nello scope locale (nessun accesso a self oltre l'api).\n" +
"    var factory = new Function('api','voxels', d.code + '\\n; return typeof transform===\"function\" ? transform(voxels, api) : (function(){ throw new Error(\"manca function transform(voxels, api)\"); })();');\n" +
"    var result = factory(api, d.voxels);\n" +
"    self.postMessage({ ok: true, voxels: result, logs: logs });\n" +
"  } catch (e) {\n" +
"    self.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e), logs: logs });\n" +
"  }\n" +
"};\n";

            (function initPlugins() {
                const sel = document.getElementById('pluginSelect');
                const codeEl = document.getElementById('pluginCode');
                const descEl = document.getElementById('pluginDesc');
                const runBtn = document.getElementById('pluginRunBtn');
                const resetBtn = document.getElementById('pluginResetBtn');
                const statusEl = document.getElementById('pluginStatus');
                if (!sel || !codeEl || !runBtn) return; // pannello assente: no-op

                function setStatus(msg, kind) {
                    if (!statusEl) return;
                    statusEl.style.display = msg ? 'block' : 'none';
                    statusEl.textContent = msg || '';
                    const c = kind === 'error' ? 'var(--danger,#ef4444)'
                            : kind === 'ok' ? 'var(--success,#22c55e)'
                            : 'var(--text-secondary,#9ca3af)';
                    statusEl.style.color = c;
                    statusEl.style.background = 'color-mix(in srgb, ' + c + ' 12%, transparent)';
                }

                function currentPlugin() {
                    return BUILTIN_PLUGINS.find(p => p.id === sel.value) || BUILTIN_PLUGINS[0];
                }
                function loadIntoEditor(p) {
                    codeEl.value = p.code;
                    if (descEl) descEl.textContent = p.desc || '';
                    setStatus('', null);
                }

                // Popola la tendina.
                BUILTIN_PLUGINS.forEach(p => {
                    const o = document.createElement('option');
                    o.value = p.id; o.textContent = p.name;
                    sel.appendChild(o);
                });
                sel.value = BUILTIN_PLUGINS[0].id;
                loadIntoEditor(BUILTIN_PLUGINS[0]);
                sel.addEventListener('change', () => loadIntoEditor(currentPlugin()));
                resetBtn && resetBtn.addEventListener('click', () => loadIntoEditor(currentPlugin()));

                // Valida e normalizza i voxel restituiti dal plugin.
                function sanitize(list) {
                    if (!Array.isArray(list)) throw new Error('lo script deve restituire un array di voxel');
                    if (list.length > PLUGIN_MAX_VOXELS)
                        throw new Error('troppi voxel restituiti (' + list.length + ' > ' + PLUGIN_MAX_VOXELS + ')');
                    const out = [];
                    let dropped = 0;
                    const hex = /^#[0-9a-fA-F]{6}$/;
                    for (const v of list) {
                        if (!v || typeof v !== 'object') { dropped++; continue; }
                        const x = Math.round(v.x), y = Math.round(v.y), z = Math.round(v.z);
                        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { dropped++; continue; }
                        let color = typeof v.color === 'string' ? v.color : '#cccccc';
                        if (color.length === 4 && color[0] === '#') // #rgb -> #rrggbb
                            color = '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
                        if (!hex.test(color)) color = '#cccccc';
                        out.push({ x, y, z, color });
                    }
                    return { out, dropped };
                }

                // Applica il risultato riusando il flusso di editing esistente
                // (annullabile con Ctrl+Z). Non tocca gli oggetti inattivi.
                function applyResult(voxels, logs) {
                    const { out, dropped } = sanitize(voxels);
                    if (typeof pushHistory === 'function') pushHistory();
                    currentModelData.voxels = out;
                    if (typeof buildModel === 'function') buildModel(false, true);
                    let msg = (typeof t === 'function' ? t('plugins.done') : 'Fatto') + ': ' + out.length + ' voxel';
                    if (dropped) msg += ' (' + dropped + ' scartati non validi)';
                    if (logs && logs.length) msg += ' — ' + logs.join(' | ');
                    setStatus(msg, 'ok');
                }

                // Esecuzione in-thread (fallback) con scope oscurato.
                function runInline(code, payload) {
                    const logs = [];
                    const api = {
                        metadata: payload.metadata, gridSize: payload.metadata.grid_size || [32, 32, 32],
                        log: m => logs.push(String(m)),
                        key: (x, y, z) => x + ',' + y + ',' + z,
                        hexToRgb: hex => { hex = String(hex || '#000').replace('#', ''); if (hex.length === 3) hex = hex.replace(/(.)/g, '$1$1'); const n = parseInt(hex, 16) || 0; return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; },
                        rgbToHex: (r, g, b) => { const h = v => ('0' + Math.max(0, Math.min(255, v | 0)).toString(16)).slice(-2); return '#' + h(r) + h(g) + h(b); }
                    };
                    // Ombreggia i globals pericolosi come parametri = undefined.
                    const shadow = ['window', 'document', 'globalThis', 'self', 'fetch', 'XMLHttpRequest',
                        'WebSocket', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator',
                        'importScripts', 'eval', 'Function', 'postMessage', 'location'];
                    const factory = new Function(...shadow, 'api', 'voxels',
                        code + '\n; return typeof transform==="function" ? transform(voxels, api) : (function(){ throw new Error("manca function transform(voxels, api)"); })();');
                    const result = factory(...shadow.map(() => undefined), api, payload.voxels);
                    return { result, logs };
                }

                function run() {
                    const code = codeEl.value || '';
                    const active = (typeof getActiveObject === 'function') ? getActiveObject() : null;
                    const src = (active && active.data) ? active.data : currentModelData;
                    const payload = {
                        code,
                        voxels: JSON.parse(JSON.stringify(src.voxels || [])),
                        metadata: JSON.parse(JSON.stringify(src.metadata || {}))
                    };
                    setStatus(typeof t === 'function' ? t('plugins.running') : 'Esecuzione…', null);
                    runBtn.disabled = true;
                    const done = () => { runBtn.disabled = false; };

                    // 1) Prova col Worker (isolamento reale).
                    let worker = null, url = null, finished = false;
                    try {
                        const blob = new Blob([PLUGIN_WORKER_SRC], { type: 'application/javascript' });
                        url = URL.createObjectURL(blob);
                        worker = new Worker(url);
                    } catch (e) { worker = null; }

                    if (worker) {
                        const cleanup = () => { try { worker.terminate(); } catch (e) {} if (url) URL.revokeObjectURL(url); };
                        const timer = setTimeout(() => {
                            if (finished) return; finished = true;
                            cleanup(); done();
                            setStatus((typeof t === 'function' ? t('plugins.timeout') : 'Tempo scaduto: script terminato') , 'error');
                        }, PLUGIN_TIMEOUT_MS);
                        worker.onmessage = (ev) => {
                            if (finished) return; finished = true;
                            clearTimeout(timer); cleanup(); done();
                            const d = ev.data || {};
                            if (!d.ok) { setStatus('Errore plugin: ' + (d.error || '?'), 'error'); return; }
                            try { applyResult(d.voxels, d.logs); }
                            catch (e) { setStatus('Errore: ' + e.message, 'error'); }
                        };
                        worker.onerror = (e) => {
                            if (finished) return; finished = true;
                            clearTimeout(timer); cleanup(); done();
                            setStatus('Errore plugin: ' + (e.message || 'esecuzione fallita'), 'error');
                        };
                        worker.postMessage(payload);
                        return;
                    }

                    // 2) Fallback in-thread (nessun worker disponibile).
                    setTimeout(() => {
                        try {
                            const { result, logs } = runInline(code, payload);
                            applyResult(result, logs);
                            if (statusEl && statusEl.textContent) statusEl.textContent += ' [fallback senza worker]';
                        } catch (e) {
                            setStatus('Errore plugin: ' + e.message, 'error');
                        } finally { done(); }
                    }, 0);
                }

                runBtn.addEventListener('click', run);
            })();
