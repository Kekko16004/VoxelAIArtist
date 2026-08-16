// =======================================================================
//  09b - ZIP scritto a mano (store, nessuna dipendenza)
//
//  Serve perche' i browser BLOCCANO i download multipli: un bundle
//  GLB + spec + collider + README deve uscire come UN file. Store mode
//  (nessuna compressione) perche' un GLB e' gia' compresso e implementare
//  deflate a mano costerebbe piu' di quanto risparmierebbe.
//
//  La data e' FISSA di proposito: un timestamp reale renderebbe due export
//  dello stesso asset binariamente diversi, e si perderebbe la possibilita'
//  di dire "e' cambiato qualcosa?" confrontando i file.
// =======================================================================

function _crc32(buf) {
    let table = _crc32.table;
    if (!table) {
        table = _crc32.table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[i] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

const ZIP_TIME = 0;
const ZIP_DATE = 33;      // 1980-01-01

function zipBuild(entries) {
    const enc = new TextEncoder();
    const files = [];
    for (const e of entries) {
        const nameBytes = enc.encode(e.name);
        const data = (e.data instanceof Uint8Array) ? e.data
            : (e.data instanceof ArrayBuffer) ? new Uint8Array(e.data)
            : enc.encode(String(e.data));
        files.push({ nameBytes: nameBytes, data: data, crc: _crc32(data) });
    }
    let localSize = 0, centralSize = 0;
    for (const f of files) {
        localSize += 30 + f.nameBytes.length + f.data.length;
        centralSize += 46 + f.nameBytes.length;
    }
    const out = new Uint8Array(localSize + centralSize + 22);
    const dv = new DataView(out.buffer);
    let off = 0;
    const offsets = [];

    for (const f of files) {
        offsets.push(off);
        dv.setUint32(off, 0x04034b50, true); off += 4;
        dv.setUint16(off, 20, true); off += 2;              // versione minima
        dv.setUint16(off, 0, true); off += 2;               // flag
        dv.setUint16(off, 0, true); off += 2;               // metodo 0 = store
        dv.setUint16(off, ZIP_TIME, true); off += 2;
        dv.setUint16(off, ZIP_DATE, true); off += 2;
        dv.setUint32(off, f.crc, true); off += 4;
        dv.setUint32(off, f.data.length, true); off += 4;   // compressa
        dv.setUint32(off, f.data.length, true); off += 4;   // originale
        dv.setUint16(off, f.nameBytes.length, true); off += 2;
        dv.setUint16(off, 0, true); off += 2;               // extra
        out.set(f.nameBytes, off); off += f.nameBytes.length;
        out.set(f.data, off); off += f.data.length;
    }

    const centralStart = off;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        dv.setUint32(off, 0x02014b50, true); off += 4;
        dv.setUint16(off, 20, true); off += 2;              // versione creatore
        dv.setUint16(off, 20, true); off += 2;              // versione minima
        dv.setUint16(off, 0, true); off += 2;               // flag
        dv.setUint16(off, 0, true); off += 2;               // metodo
        dv.setUint16(off, ZIP_TIME, true); off += 2;
        dv.setUint16(off, ZIP_DATE, true); off += 2;
        dv.setUint32(off, f.crc, true); off += 4;
        dv.setUint32(off, f.data.length, true); off += 4;
        dv.setUint32(off, f.data.length, true); off += 4;
        dv.setUint16(off, f.nameBytes.length, true); off += 2;
        dv.setUint16(off, 0, true); off += 2;               // extra
        dv.setUint16(off, 0, true); off += 2;               // commento
        dv.setUint16(off, 0, true); off += 2;               // disco
        dv.setUint16(off, 0, true); off += 2;               // attributi interni
        dv.setUint32(off, 0, true); off += 4;               // attributi esterni
        dv.setUint32(off, offsets[i], true); off += 4;      // offset locale
        out.set(f.nameBytes, off); off += f.nameBytes.length;
    }
    const centralBytes = off - centralStart;

    dv.setUint32(off, 0x06054b50, true); off += 4;
    dv.setUint16(off, 0, true); off += 2;                   // disco
    dv.setUint16(off, 0, true); off += 2;                   // disco del central
    dv.setUint16(off, files.length, true); off += 2;
    dv.setUint16(off, files.length, true); off += 2;
    dv.setUint32(off, centralBytes, true); off += 4;
    dv.setUint32(off, centralStart, true); off += 4;
    dv.setUint16(off, 0, true); off += 2;                   // commento
    return out;
}

/** Bundle completo: GLB + spec + piano + collider + istruzioni. */
async function exportBundle(spec, built, plan) {
    const id = (spec && spec.id) || 'asset';
    const glb = await exportGLB(spec, built, { silent: true, binary: true });
    const glbBytes = new Uint8Array(await glb.arrayBuffer());
    const entries = [
        { name: id + '.glb', data: glbBytes },
        { name: id + '.sam.json', data: JSON.stringify(spec, null, 2) },
        { name: id + '.colliders.json', data: JSON.stringify({
            id: id, unit: 'm', up: 'y', colliders: (spec && spec.col) || [],
        }, null, 2) },
        { name: 'LEGGIMI.txt', data: bundleReadme(spec, built, plan) },
    ];
    if (plan) {
        entries.push({ name: id + '.plan.json', data: JSON.stringify(plan, null, 2) });
    }
    const zip = zipBuild(entries);
    downloadBlob(id + '.zip', new Blob([zip], { type: 'application/zip' }));
    return zip.length;
}

function bundleReadme(spec, built, plan) {
    const b = built ? built.bounds : null;
    const L = [];
    L.push('Asset generato con SimpleAIModeller');
    L.push('');
    L.push('id        : ' + ((spec && spec.id) || '?'));
    L.push('categoria : ' + ((spec && spec.cat) || '?'));
    L.push('stile     : ' + ((spec && spec.style) || '?'));
    if (b) {
        L.push('ingombro  : ' + b.size.map(v => v.toFixed(4)).join(' x ') + ' m');
    }
    L.push('nodi      : ' + ((spec && spec.nodes && spec.nodes.length) || 0));
    L.push('triangoli : ' + (built ? meshTriCount(built.merged) : 0));
    L.push('');
    L.push('CONVENZIONI');
    L.push('  unita = metri, Y in alto, fronte verso +Z');
    L.push('  pivot al centro della base (personaggi: ai piedi)');
    L.push('  ogni nodo e una mesh nominata: leve, coperchi e ruote si animano');
    L.push('');
    L.push('FILE');
    L.push('  .glb            modello (Unity/Godot/Blender)');
    L.push('  .sam.json       spec parametrica: riapribile e modificabile');
    L.push('  .plan.json      distinta di misure verificata');
    L.push('  .colliders.json forme di collisione (box/sfere/capsule)');
    if (plan) {
        L.push('');
        L.push('PIANO DELLE MISURE');
        L.push('  asse ' + plan.axis.toUpperCase() + ', lunghezza '
               + plan.axisLength.toFixed(4) + ' m');
        for (const s of plan.chain) {
            L.push('  ' + s.n.padEnd(18) + s.from.toFixed(4) + ' -> ' + s.to.toFixed(4));
        }
    }
    return L.join('\n');
}
