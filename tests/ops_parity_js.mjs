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
