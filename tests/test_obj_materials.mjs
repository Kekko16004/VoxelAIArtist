#!/usr/bin/env node
/*
 * Export OBJ/MTL con i MATERIALI TEXTURIZZATI.
 *
 * Il greedy mesher univa le facce per COLORE. Con i materiali quel criterio e'
 * sbagliato in due modi opposti, e ognuno e' un bug diverso:
 *
 *  1) UNIRE TROPPO. Due voxel dello stesso colore ma con materiali diversi
 *     finivano nello stesso quad, quindi nello stesso `usemtl`: la texture del
 *     primo si spalmava anche sul secondo. Il criterio giusto e' `tokenOf(v)`.
 *
 *  2) GLI UV. Un quad merged copre N voxel. Con UV 0..1 la texture si STIRA su
 *     tutto il quad e una fila di 3 voxel sembra un blocco solo; con UV 0..uw /
 *     0..uh e wrap `repeat` (vedi threeMaterialFor in 36-materials.js) si ripete
 *     una volta per voxel. Il controllo qui non guarda "ci sono dei vt": misura
 *     che la mappatura sia un'ISOMETRIA in unita' voxel, cioe' che la distanza
 *     UV fra due angoli sia uguale alla loro distanza in 3D. Serve perche' una
 *     lista UV fissa (0,0)(0,uh)(uw,uh)(uw,0) e' giusta solo per le facce
 *     `back` -- sulle altre i vertici escono nell'ordine trasposto e la texture
 *     si ripeterebbe 3 volte in larghezza su un voxel solo. L'insieme dei `vt`
 *     emessi e' identico nei due casi: solo l'isometria vede la differenza.
 *
 *  3) L'ORFANO. `decodeToken(tok, fallbackColor)` vuole il colore VERO del voxel
 *     come secondo argomento: su un id che non esiste piu' (file importato senza
 *     le sue definizioni) ricade su quello. Chi lo omette scrive nel .mtl un Kd
 *     grigio #CCCCCC al posto della tinta del modello.
 *
 *  4) LO ZIP. Con le texture i file diventano N+2 e i browser bloccano i
 *     download multipli, quindi si passa a un archivio unico. I PNG entrano come
 *     Uint8Array: se finissero nello ZIP passati per String() uscirebbero
 *     corrotti senza che nessun controllo sui nomi dei file se ne accorga, per
 *     cui qui si rilegge l'archivio VERO scritto da 29-zip.js.
 *
 * I moduli sono frammenti di UNO scope condiviso: si caricano con new Function e
 * stub minimi del DOM, come tests/test_materials.mjs. L'ordine di
 * concatenazione e' quello del manifest (06 PRIMA di 36): cosi' il test si
 * accorgerebbe anche di un riferimento a una `const` di 36-materials.js fatto
 * durante la valutazione di 06 (sarebbe in temporal dead zone nel bundle vero).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = [];
function check(name, cond, detail) {
    if (cond) console.log(`  ok - ${name}`);
    else { console.log(`  FAIL - ${name}: ${detail === undefined ? '' : detail}`); failures.push(name); }
}

const read = p => fs.readFileSync(path.join(ROOT, p), 'latin1');
const objSrc = read('ui/src/lib/06-export-obj.js');
const matSrc = read('ui/src/lib/36-materials.js');
const zipSrc = read('ui/src/lib/29-zip.js');

// 1x1 PNG vero: contiene byte alti (0x89, 0xFF...) che un passaggio per String()
// distruggerebbe. Serve al controllo dello ZIP.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_URL = 'data:image/png;base64,' + PNG_B64;

// ===== caricamento ========================================================
// `createZipBlob` / `downloadBlob` arrivano come PARAMETRI: nel bundle sono
// funzioni di 29-zip.js, qui sono spie che catturano la lista dei file. Lo zip
// vero viene esercitato piu' sotto, sui file catturati.
function load(model) {
    const handlers = {};
    const downloads = [];
    const zipCalls = [];
    let lastParts = null;
    class BlobStub {
        constructor(parts) { this.parts = parts; lastParts = parts; }
    }
    const doc = {
        getElementById: (id) => ({
            addEventListener: (ev, fn) => { handlers[id + ':' + ev] = fn; }
        }),
        createElement: () => ({
            style: {}, href: '', download: '',
            click() { downloads.push({ name: this.download, parts: lastParts }); }
        }),
        body: { appendChild() { }, removeChild() { } }
    };
    const url = { createObjectURL: () => 'blob:x', revokeObjectURL: () => { } };
    const api = new Function(
        'currentModelData', 'document', 'URL', 'Blob', 'atob',
        'createZipBlob', 'downloadBlob',
        objSrc + '\n' + matSrc + `
        ;return { greedyMesh, matNameFor, textureFileName, buildMtlText,
                  buildObjText, addMaterial, materialById, tokenOf };`
    )(model, doc, url, BlobStub, atob,
        (files) => { const b = { files: files }; zipCalls.push(b); return b; },
        (blob, filename) => { blob.filename = filename; });
    return { api, handlers, downloads, zipCalls };
}

const TEX_MAT = {
    id: 'm1', name: 'Legno', color: '#8B5A2B',
    texture: { data: PNG_URL, w: 8, h: 8 },
    roughness: 0.5, metalness: 0, emissive: 0
};
const freshModel = (voxels, name) => ({
    metadata: { name: name || 'Prova', materials: [{ ...TEX_MAT }] },
    voxels: voxels || []
});

console.log('test_obj_materials');

// ===== A. il mesher unisce per TOKEN ======================================
console.log('\n-- greedy mesh sul token --');
{
    const { api } = load(freshModel());

    // Due voxel affiancati, stesso token: il mesher li unisce in un quad 2x1.
    const uniti = api.greedyMesh([
        { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1' },
        { x: 1, y: 0, z: 0, color: '#8B5A2B', material: 'm1' }
    ]);
    const sopra = uniti.filter(q => q.normal[1] === 1);
    check('il mesher unisce due voxel dello stesso token', sopra.length === 1,
        JSON.stringify(sopra.map(q => q.token)));
    check('il quad porta il token su cui ha unito',
        sopra.length === 1 && sopra[0].token === '@m1',
        sopra.length ? String(sopra[0].token) : 'nessun quad');
    check('il quad unito porta l\'estensione in voxel per gli UV',
        sopra.length === 1 && sopra[0].uw * sopra[0].uh === 2,
        sopra.length ? JSON.stringify({ uw: sopra[0].uw, uh: sopra[0].uh }) : 'nessun quad');

    // Stesso colore, materiali diversi: NON si uniscono, altrimenti l'export
    // applicherebbe una sola texture a entrambi.
    const divisi = api.greedyMesh([
        { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1' },
        { x: 1, y: 0, z: 0, color: '#8B5A2B' }
    ]);
    check('il mesher NON unisce token diversi',
        divisi.filter(q => q.normal[1] === 1).length === 2,
        String(divisi.filter(q => q.normal[1] === 1).length));

    // Senza materiali il mesher deve unire esattamente come prima.
    const soloColore = api.greedyMesh([
        { x: 0, y: 0, z: 0, color: '#8b5a2b' },
        { x: 1, y: 0, z: 0, color: '#8B5A2B' }
    ]);
    const s2 = soloColore.filter(q => q.normal[1] === 1);
    check('senza materiali il token e\' l\'hex MAIUSCOLO (case-insensitive come prima)',
        s2.length === 1 && s2[0].token === '#8B5A2B',
        JSON.stringify(soloColore.map(q => q.token)));
}

// ===== B. nomi ============================================================
console.log('\n-- nomi di materiale e di file --');
{
    const { api } = load(freshModel());
    check('matNameFor di un token materiale e\' un nome OBJ valido',
        api.matNameFor('@m1') === 'mat_m1' && !/[#@]/.test(api.matNameFor('@m1')),
        api.matNameFor('@m1'));
    check('matNameFor di un colore e\' invariato',
        api.matNameFor('#AABBCC') === 'mat_AABBCC', api.matNameFor('#AABBCC'));
    check('textureFileName e\' stabile',
        api.textureFileName('m1') === 'tex_m1.png', String(api.textureFileName('m1')));
}

// ===== C. il .mtl =========================================================
console.log('\n-- .mtl con map_Kd e con gli orfani --');
{
    const { api } = load(freshModel());
    const mtl = api.buildMtlText([{ x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1' }]);
    check('il .mtl referenzia il PNG', mtl.indexOf('map_Kd tex_m1.png') !== -1, mtl);
    check('il .mtl tiene anche Kd, cosi\' resta sensato senza i PNG',
        /newmtl mat_m1[\s\S]*?Kd 0\.5451 0\.3529 0\.1686/.test(mtl), mtl);

    // ORFANO: id che non esiste piu'. Kd deve essere la tinta del VOXEL.
    const orf = api.buildMtlText([{ x: 0, y: 0, z: 0, color: '#112233', material: 'm9' }]);
    check('id orfano: Kd e\' il colore vero del voxel (decodeToken col 2o argomento)',
        /newmtl mat_m9[\s\S]*?Kd 0\.0667 0\.1333 0\.2000/.test(orf), orf);
    check('id orfano: Kd non e\' il grigio neutro #CCCCCC',
        orf.indexOf('Kd 0.8000 0.8000 0.8000') === -1, orf);
    check('id orfano: nessuna texture inventata',
        orf.indexOf('map_Kd') === -1, orf);

    // Un materiale SENZA texture non deve produrre map_Kd.
    const { api: api2 } = load({
        metadata: { materials: [{ id: 'm1', name: 'Tinta', color: '#204060', texture: null }] },
        voxels: []
    });
    const piatto = api2.buildMtlText([{ x: 0, y: 0, z: 0, color: '#204060', material: 'm1' }]);
    check('materiale senza texture: niente map_Kd',
        piatto.indexOf('map_Kd') === -1 && piatto.indexOf('newmtl mat_m1') !== -1, piatto);

    // Nessun materiale: il .mtl e' quello di prima, nome compreso.
    const legacy = api.buildMtlText([
        { x: 0, y: 0, z: 0, color: '#8B5A2B' }, { x: 1, y: 0, z: 0, color: '#8b5a2b' }
    ]);
    check('senza materiali il .mtl resta quello storico (un newmtl per colore, niente map_Kd)',
        (legacy.match(/newmtl /g) || []).length === 1
        && legacy.indexOf('newmtl mat_8B5A2B') !== -1
        && legacy.indexOf('map_Kd') === -1, legacy);
}

// ===== D. gli UV nell'OBJ =================================================
console.log('\n-- UV: una ripetizione per voxel, non una per quad --');

function parseObj(text) {
    const vs = [], vts = [], faces = [];
    let cur = null;
    text.split('\n').forEach(line => {
        const p = line.trim().split(/\s+/);
        if (p[0] === 'v') vs.push([+p[1], +p[2], +p[3]]);
        else if (p[0] === 'vt') vts.push([+p[1], +p[2]]);
        else if (p[0] === 'usemtl') cur = p[1];
        else if (p[0] === 'f') faces.push({ mat: cur, refs: p.slice(1).map(s => s.split('/')) });
    });
    return { vs, vts, faces };
}

{
    // Fila di 3 voxel lungo X: i quad merged sono 3x1 su quattro lati e 1x1 sui
    // due tappi, cioe' proprio il caso in cui stiramento e trasposizione si
    // vedono. Sono NON quadrati: su un quad quadrato la trasposizione e'
    // invisibile.
    const vox = [0, 1, 2].map(x => ({ x: x, y: 0, z: 0, color: '#8B5A2B', material: 'm1' }));
    const { api } = load(freshModel(vox));
    const obj = api.buildObjText('prova.mtl');
    const { vs, vts, faces } = parseObj(obj);

    check('l\'OBJ emette dei vt', vts.length > 0, String(vts.length));
    check('ogni faccia cita vertice/uv/normale',
        faces.length > 0 && faces.every(f => f.refs.every(r => r.length === 3 && r[1] !== '')),
        faces.length ? faces[0].refs.map(r => r.join('/')).join(' ') : 'nessuna faccia');
    check('le facce del voxel texturizzato stanno sotto usemtl mat_m1',
        faces.length > 0 && faces.every(f => f.mat === 'mat_m1'),
        JSON.stringify([...new Set(faces.map(f => f.mat))]));

    // Valori esatti: su una fila di 3 voxel gli UV arrivano a 3, non a 1.
    // (Questo controllo prova il NON-stiramento; la trasposizione la vede solo
    // l'isometria qui sotto, perche' l'INSIEME dei vt e' lo stesso.)
    const setVt = [...new Set(vts.map(t => t.join(',')))].sort();
    const atteso = ['0,0', '0,1', '0,3', '1,0', '1,1', '1,3', '3,0', '3,1'].sort();
    check('i vt emessi sono esattamente quelli attesi per una fila di 3 voxel',
        setVt.length === atteso.length && setVt.every((s, i) => s === atteso[i]),
        JSON.stringify(setVt));
    check('gli UV NON stanno nel quadrato unitario: la texture si ripete 3 volte sul quad da 3 voxel',
        vts.some(t => t[0] === 3 || t[1] === 3), JSON.stringify(setVt));

    // ISOMETRIA: |UV(a)-UV(b)| == |P(a)-P(b)| per ogni lato di ogni faccia.
    // E' la definizione di "una ripetizione per voxel" indipendente da come i
    // vertici sono ordinati, ed e' l'unico controllo che vede la trasposizione
    // sulle facce non-`back`.
    const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let lati = 0, storti = 0, peggio = 0;
    faces.forEach(f => {
        for (let i = 0; i < f.refs.length; i++) {
            const A = f.refs[i], B = f.refs[(i + 1) % f.refs.length];
            const pA = vs[+A[0] - 1], pB = vs[+B[0] - 1];
            const tA = vts[+A[1] - 1], tB = vts[+B[1] - 1];
            if (!pA || !pB || !tA || !tB) { storti++; continue; }
            lati++;
            const err = Math.abs(d3(pA, pB) - d2(tA, tB));
            if (err > 1e-6) { storti++; if (err > peggio) peggio = err; }
        }
    });
    check('gli UV sono un\'isometria in unita\' voxel su ogni lato di ogni faccia',
        lati > 0 && storti === 0,
        `${storti} lati storti su ${lati}, errore massimo ${peggio}`);

    // Un modello 3x1x1 ha 4 quad merged 3x1 + 2 tappi 1x1: se il mesher non
    // unisse piu' nulla l'isometria passerebbe comunque (quad 1x1 quadrati).
    check('il mesher sta davvero unendo (6 quad, non 18 facce sciolte)',
        faces.length === 6, String(faces.length));
}

// ===== E. export senza texture: nessuna regressione =======================
console.log('\n-- bottone export: senza texture restano i due download --');
{
    const vox = [{ x: 0, y: 0, z: 0, color: '#8B5A2B' }];
    const { handlers, downloads, zipCalls } = load({
        metadata: { name: 'Senza Texture' }, voxels: vox
    });
    check('il bottone export OBJ registra il suo listener',
        typeof handlers['exportObjBtn:click'] === 'function');
    if (typeof handlers['exportObjBtn:click'] === 'function') {
        handlers['exportObjBtn:click']();
        await new Promise(r => setTimeout(r, 250));
        check('senza texture non si produce nessuno ZIP', zipCalls.length === 0, String(zipCalls.length));
        check('senza texture si scaricano .mtl e .obj come prima',
            downloads.length === 2
            && downloads.some(d => d.name === 'Senza_Texture.mtl')
            && downloads.some(d => d.name === 'Senza_Texture.obj'),
            JSON.stringify(downloads.map(d => d.name)));
    }
}

// ===== F. export con texture: uno ZIP solo ================================
console.log('\n-- bottone export: con texture si passa allo ZIP --');
let zippedFiles = null;
{
    const vox = [
        { x: 0, y: 0, z: 0, color: '#8B5A2B', material: 'm1' },
        { x: 2, y: 0, z: 0, color: '#204060' }
    ];
    const { handlers, downloads, zipCalls } = load(freshModel(vox, 'Con Texture'));
    handlers['exportObjBtn:click']();
    await new Promise(r => setTimeout(r, 250));
    check('con le texture si produce UNO ZIP', zipCalls.length === 1, String(zipCalls.length));
    check('con le texture non parte nessun download sciolto',
        downloads.length === 0, JSON.stringify(downloads.map(d => d.name)));
    if (zipCalls.length === 1) {
        zippedFiles = zipCalls[0].files;
        const nomi = zippedFiles.map(f => f.name);
        check('lo ZIP contiene .obj, .mtl e il PNG della texture',
            nomi.length === 3
            && nomi.indexOf('Con_Texture.obj') !== -1
            && nomi.indexOf('Con_Texture.mtl') !== -1
            && nomi.indexOf('tex_m1.png') !== -1,
            JSON.stringify(nomi));
        check('lo ZIP si chiama come il modello',
            zipCalls[0].filename === 'Con_Texture.zip', String(zipCalls[0].filename));
        const png = zippedFiles.filter(f => f.name === 'tex_m1.png')[0];
        // 29-zip.js accetta `{name, data}` con data string | Uint8Array (riga
        // `f.data instanceof Uint8Array`). Un PNG passato come stringa verrebbe
        // riscritto in UTF-8 e uscirebbe corrotto.
        check('il PNG entra nello ZIP come Uint8Array, non come stringa',
            !!png && png.data instanceof Uint8Array, png ? typeof png.data : 'assente');
        check('i byte del PNG sono quelli decodificati dalla data URL',
            !!png && png.data.length === Buffer.from(PNG_B64, 'base64').length
            && Buffer.from(png.data).equals(Buffer.from(PNG_B64, 'base64')),
            png ? String(png.data.length) : 'assente');
        const objFile = zippedFiles.filter(f => f.name === 'Con_Texture.obj')[0];
        check('l\'.obj nello ZIP punta al .mtl con il nome giusto',
            !!objFile && String(objFile.data).indexOf('mtllib Con_Texture.mtl') !== -1);
        const mtlFile = zippedFiles.filter(f => f.name === 'Con_Texture.mtl')[0];
        check('il .mtl nello ZIP referenzia il PNG che c\'e\' nello ZIP',
            !!mtlFile && String(mtlFile.data).indexOf('map_Kd tex_m1.png') !== -1);
    }
}

// ===== G. lo ZIP VERO regge i byte del PNG ================================
console.log('\n-- l\'archivio scritto da 29-zip.js non corrompe il PNG --');
if (zippedFiles) {
    const zipApi = new Function('document', 'URL', zipSrc + ';return { createZipBlob };')(
        { createElement: () => ({ style: {}, click() { } }), body: { appendChild() { }, removeChild() { } } },
        { createObjectURL: () => 'blob:x', revokeObjectURL: () => { } });
    const buf = Buffer.from(await zipApi.createZipBlob(zippedFiles).arrayBuffer());
    const raw = Buffer.from(PNG_B64, 'base64');
    check('i byte del PNG compaiono intatti nell\'archivio',
        buf.indexOf(raw) >= 0, `archivio di ${buf.length} byte`);
    check('l\'archivio non contiene il PNG serializzato come testo',
        buf.indexOf(Buffer.from(String(new Uint8Array(raw.subarray(0, 8))))) < 0);
    check('l\'archivio dichiara 3 voci',
        buf.readUInt16LE(buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 10) === 3);
}

console.log(`\n${failures.length ? 'FALLITI' : 'OK'}: ${failures.length} controlli falliti`);
if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
