/**
 * ZIP scritto a mano: la struttura deve essere leggibile da un unzip vero.
 * Si verifica la firma, il numero di voci, il CRC e che i nomi tornino —
 * un archivio "quasi" valido si apre in un tool e non in un altro.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB = path.join(ROOT, 'ui', 'src', 'lib');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(LIB, '09b-zip.js'), 'utf8');
// Solo la parte pura: si ferma prima di exportBundle, che tocca il DOM.
const cut = src.indexOf('/** Bundle completo');
const pure = cut < 0 ? src : src.slice(0, cut);
const sandbox = { console, Math, TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer };
vm.createContext(sandbox);
vm.runInContext(pure + '\n;this.__Z = { zipBuild, _crc32 };', sandbox);
const { zipBuild, _crc32 } = sandbox.__Z;

console.log('[1] CRC32 contro zlib (implementazione di riferimento)');
const enc = new TextEncoder();
for (const s of ['', 'a', 'hello world', 'SimpleAIModeller']) {
  const buf = enc.encode(s);
  const mine = _crc32(buf);
  const theirs = zlib.crc32 ? zlib.crc32(Buffer.from(buf)) : null;
  if (theirs === null) { ok(typeof mine === 'number', 'crc calcolato per ' + JSON.stringify(s)); }
  else ok(mine === theirs, 'crc di ' + JSON.stringify(s) + ' = ' + mine);
}

console.log('[2] struttura dell\'archivio');
const zip = zipBuild([
  { name: 'a.txt', data: 'contenuto A' },
  { name: 'dir/b.json', data: '{"x":1}' },
  { name: 'bin.dat', data: new Uint8Array([1, 2, 3, 4, 5]) },
]);
const buf = Buffer.from(zip);
ok(buf.readUInt32LE(0) === 0x04034b50, 'firma local header');
ok(buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) > 0, 'presente end-of-central-directory');
const eocd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
ok(buf.readUInt16LE(eocd + 8) === 3, 'tre voci nel central directory');
ok(buf.readUInt16LE(eocd + 10) === 3, 'tre voci totali');
const centralSize = buf.readUInt32LE(eocd + 12);
const centralOff = buf.readUInt32LE(eocd + 16);
ok(centralOff + centralSize === eocd, 'central directory contigua all\'EOCD (' + centralOff + '+' + centralSize + '=' + eocd + ')');
ok(buf.includes('a.txt') && buf.includes('dir/b.json') && buf.includes('bin.dat'), 'nomi presenti');
ok(buf.includes('contenuto A'), 'contenuto memorizzato in chiaro (store)');

console.log('[3] un archivio vuoto resta valido');
const empty = Buffer.from(zipBuild([]));
ok(empty.length === 22, 'solo EOCD (22 byte)');
ok(empty.readUInt32LE(0) === 0x06054b50, 'firma EOCD');

console.log();
console.log('PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
