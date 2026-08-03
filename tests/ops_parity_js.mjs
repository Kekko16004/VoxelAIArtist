import path from 'node:path';
import {fileURLToPath} from 'node:url';
const REPO_ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
import fs from 'node:fs';
// Estrae expandOps dal modulo JS reale del repo e lo rende chiamabile.
let src = fs.readFileSync(path.join(REPO_ROOT,'ui/src/utils/expand-ops.js'),'latin1');
// il file e' un frammento di scope condiviso: lo avvolgo in una funzione
const fn = new Function('data', src.replace(/^\s*function expandOps/m,'const __e = function expandOps') + '\n; return __e(data);');
const cases = JSON.parse(fs.readFileSync(path.join(REPO_ROOT,'tests/ops_parity_cases.json'),'utf8'));
const out = {};
for (const [name, data] of Object.entries(cases)) {
  try {
    const r = fn(JSON.parse(JSON.stringify(data)));
    out[name] = (r.voxels||[]).map(v=>`${v.x},${v.y},${v.z},${(v.color||'').toUpperCase()}`).sort();
  } catch(e) { out[name] = {error: String(e.message)}; }
}
fs.writeFileSync(path.join(REPO_ROOT,'tests/.js_out.json'), JSON.stringify(out));
console.log('js ok, casi:', Object.keys(out).length);

// --- tetto dei voxel: la stessa regola vive in due lingue -------------------
// CLAUDE.md impone che voxelBudgetFor (JS) e voxel_budget_for (Python) restino
// identici, ed e' un tetto MISURATO: ~98 byte per cella di Map, quindi 24M celle
// = ~2,2 GB e la scheda muore. Finora nulla lo ancorava: alzare
// MAX_VOXELS_ABSOLUTE da 8M a 80M nel SOLO lato JS passava tutta la suite
// (test_pack_extras.py prova solo Python; test_primitives.mjs chiede che 134M
// sfondi il tetto, cosa vera anche a tetto decuplicato). Il progetto ha gia'
// pagato una divergenza di questa specie con expand_ops/expandOps.
const budgetFn = new Function('g', src.replace(/^\s*function voxelBudgetFor/m, 'const __b = function voxelBudgetFor') + '\n; return __b(g);');
const GRIGLIE = [
    // assente/invalido -> il default
    null, [], [16, 16], 'no', [0, 16, 16], [-8, 16, 16], [16, 0, 16],
    // piccole: meta' del volume sta sotto il minimo, quindi vince il minimo
    [16, 16, 16], [32, 32, 32], [64, 64, 64],
    // la soglia esatta in cui meta' del volume raggiunge i 4M
    [200, 200, 200], [201, 201, 201],
    // grandi: meta' del volume, fino al tetto assoluto
    [256, 256, 256], [300, 300, 300],
    // oltre il tetto: deve saturare, non crescere
    [512, 512, 512], [1024, 1024, 1024],
    // non cubiche e asimmetriche
    [512, 64, 512], [64, 512, 64], [128, 256, 512], [7, 999, 13],
    // interi passati come stringhe (arrivano cosi' da certi JSON)
    ['128', '128', '128'], ['512', '512', '512']
];
// La LISTA viaggia nel file insieme ai risultati: Python legge le stesse
// griglie invece di riscriverle: due elenchi a mano divergerebbero come la
// regola che stiamo ancorando.
fs.writeFileSync(path.join(REPO_ROOT, 'tests/.js_budget.json'), JSON.stringify({
    grids: GRIGLIE,
    values: GRIGLIE.map(g => {
        try { return budgetFn(g); } catch (e) { return 'ERRORE: ' + e.message; }
    })
}));
console.log('js budget ok, griglie:', GRIGLIE.length);
