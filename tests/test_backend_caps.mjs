/*
 * Verifica le CAPACITA' del backend (ui/src/lib/19-prefs.js).
 *
 * Con APP_MODE="web" (default di main.py) la UI gira in un tab del browser ma il
 * server Python locale c'e' comunque: autosave, cronologia e progetti recenti
 * DEVONO andare su disco. Solo i dialog nativi (Qt) mancano. Prima era un unico
 * flag window.__IS_DESKTOP__ e la modalita' predefinita perdeva quelle funzioni.
 *
 * Qui si isola il blocco delle capacita' e si provano i tre casi reali:
 *   webview Qt / pagina servita dal server locale / file:// senza backend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/lib/19-prefs.js'), 'latin1');
const START = 'let backendProbe = null;';
const END = 'detectBackend();';
const i = src.indexOf(START);
const j = src.indexOf(END, i);
if (i < 0 || j < 0) {
    console.log('  FAIL blocco delle capacita\' non trovato in 19-prefs.js (rinominato?)');
    process.exit(1);
}
const block = src.slice(i, j + END.length);

// Una istanza fresca per caso di prova: lo stato (backendProbe) e' per-modulo.
function mk(win, loc, fetchImpl) {
    return new Function('window', 'location', 'fetch',
        block + ';return {hasLocalBackend, hasNativeDialogs, detectBackend};')(win, loc, fetchImpl);
}
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });
const never = async () => { throw new Error('fetch non previsto'); };

// --- 1. webview Qt: entrambe le capacita' sono garantite ----------------------
{
    const api = mk({ __IS_DESKTOP__: true }, { protocol: 'http:' },
        async () => jsonRes({ app_mode: 'py', is_desktop: true }));
    ok(api.hasLocalBackend() === true, 'webview: backend presente');
    ok(api.hasNativeDialogs() === true, 'webview: dialog nativi disponibili');
    await api.detectBackend();
    ok(api.hasLocalBackend() && api.hasNativeDialogs(), 'webview: la sonda conferma');
}

// --- 2. modalita' web servita dal server locale --------------------------------
{
    let calls = 0;
    const win = {};
    const api = mk(win, { protocol: 'http:' },
        async () => { calls++; return jsonRes({ app_mode: 'web', is_desktop: false }); });
    ok(api.hasLocalBackend() === true, 'web: ottimista finche\' la sonda non risponde (pagina su http)');
    ok(api.hasNativeDialogs() === false, 'web: nessun dialog nativo senza Qt');
    await api.detectBackend();
    ok(api.hasLocalBackend() === true, 'web: il backend c\'e\' -> autosave e cronologia su disco');
    ok(api.hasNativeDialogs() === false, 'web: Apri/Salva con nome restano download del browser');
    ok(win.__BACKEND_OK__ === true && win.__NATIVE_DIALOGS__ === false, 'le capacita\' finiscono su window');
    ok(calls >= 1, 'la sonda interroga /api/settings');
}

// --- 3. file:// (index.html aperto a mano): nessun backend --------------------
{
    const api = mk({}, { protocol: 'file:' }, never);
    ok(api.hasLocalBackend() === false, 'file://: nessun backend, si usano i fallback locali');
    ok(api.hasNativeDialogs() === false, 'file://: nessun dialog nativo');
}

// --- 4. http ma il backend non risponde: la sonda declassa --------------------
{
    const api = mk({}, { protocol: 'http:' }, async () => { throw new Error('ECONNREFUSED'); });
    ok(api.hasLocalBackend() === true, 'prima della sonda: ottimista');
    await api.detectBackend();
    ok(api.hasLocalBackend() === false, 'sonda fallita: si passa ai fallback (localStorage)');
    ok(api.hasNativeDialogs() === false, 'sonda fallita: niente dialog nativi');
}

// --- 5. risposta HTTP non ok (es. 500) --------------------------------------
{
    const api = mk({}, { protocol: 'http:' }, async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await api.detectBackend();
    ok(api.hasLocalBackend() === false, 'HTTP 500 vale come "nessun backend"');
}

// --- 6. il resto della UI non deve piu' leggere il flag unico -----------------
{
    const files = ['ui/src/lib/21-project.js', 'ui/src/lib/22-screens.js', 'ui/src/lib/26-settings-modal.js'];
    // I commenti che spiegano perche' il flag e' sparito non contano: si toglie
    // il testo dopo // prima di cercare le chiamate vere.
    const codeOnly = (f) => fs.readFileSync(path.join(REPO_ROOT, f), 'latin1')
        .split('\n').map(l => l.replace(/\/\/[^\r\n]*/, '')).join('\n');
    const bad = files.filter(f => /(isDesktopApp|screensIsDesktop)\s*\(/.test(codeOnly(f)));
    ok(bad.length === 0, 'nessun modulo usa piu\' il vecchio flag unico "desktop"' + (bad.length ? ': ' + bad.join(', ') : ''));
}

console.log(fail ? `\nFALLITI: ${fail} (pass=${pass})` : `\nTUTTI I TEST PASSATI  (pass=${pass})`);
process.exit(fail ? 1 : 0);
