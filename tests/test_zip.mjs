import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const REPO_ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Blob/URL esistono in Node 18+; simulo solo document per downloadBlob (non usato qui)
global.document={createElement:()=>({click(){},style:{}}),body:{appendChild(){},removeChild(){}}};
global.URL.createObjectURL=()=>'blob:x'; global.URL.revokeObjectURL=()=>{};
const src=fs.readFileSync(path.join(REPO_ROOT,'ui/src/lib/29-zip.js'),'latin1');
const {createZipBlob}=new Function(src+';return {createZipBlob};')();

const files=[
  {name:'pack/manifest.json', data:JSON.stringify({pack:'test',assets:2},null,2)},
  {name:'pack/Vaso_Fiori_1/model.json', data:'{"voxels":[]}'},
  {name:'pack/Vaso_Fiori_1/model.vox', data:new Uint8Array([0x56,0x4F,0x58,0x20,1,2,3])},
  {name:'pack/Televisore_1/model.obj', data:'# OBJ\nv 0 0 0\nv 1 0 0\n'},
  {name:'pack/accenti_àèìòù.txt', data:'nomi con accenti e UTF-8 ✓'},
];
const blob=createZipBlob(files);
const buf=Buffer.from(await blob.arrayBuffer());
fs.writeFileSync(path.join(REPO_ROOT,'tests/.test_out.zip'), buf);
console.log('ZIP scritto:', buf.length, 'byte per', files.length, 'file');
// Verifica strutturale: firme PKWARE presenti e coerenti
const sig = buf.readUInt32LE(0);
if (sig !== 0x04034b50) { console.error('FAIL: firma local header errata'); process.exit(1); }
const eocdIdx = buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
if (eocdIdx < 0) { console.error('FAIL: end of central directory assente'); process.exit(1); }
const count = buf.readUInt16LE(eocdIdx + 10);
if (count !== files.length) { console.error('FAIL: voci ' + count + ' != ' + files.length); process.exit(1); }
console.log('struttura ZIP valida:', count, 'voci, firme PKWARE corrette');
