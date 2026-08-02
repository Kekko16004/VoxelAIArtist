// Esegue il bundle generato contro un DOM/THREE finti e PERMISSIVI.
// Scopo: far emergere il PRIMO errore a runtime del bootstrap (TDZ, funzione
// inesistente, null deref), non validare il rendering.
import fs from 'fs';

const html = fs.readFileSync('ui/index.html', 'latin1');
const i = html.indexOf('// GENERATO da ui/build.mjs');
const j = html.indexOf('</script>', i);
const bundle = html.slice(i, j);

const noop = () => {};
// I proxy "tutto e' truthy" fanno girare all'infinito i risalimenti del DOM
// (`while (el.parentElement)`, closest, ecc.): queste proprieta' devono essere
// terminali, cioe' null.
const NULL_PROPS = new Set(['parentElement', 'parentNode', 'nextElementSibling',
  'previousElementSibling', 'firstElementChild', 'lastElementChild', 'firstChild',
  'lastChild', 'nextSibling', 'previousSibling', 'offsetParent', 'closest']);
const anyProxy = (name) => new Proxy(function () {}, {
  get(t, k) {
    if (NULL_PROPS.has(k)) return k === 'closest' ? () => null : null;
    if (k === Symbol.toPrimitive) return () => 1;
    if (k === Symbol.iterator) return function* () {};
    if (k === 'then') return undefined;
    if (k === 'length') return 0;
    if (k === 'nodeType') return 1;
    if (k === 'tagName') return 'DIV';
    if (k === 'style' || k === 'dataset' || k === 'classList') return anyProxy(name + '.' + String(k));
    if (k === 'textContent' || k === 'value' || k === 'innerHTML') return '';
    if (k === 'checked') return true;
    return anyProxy(name + '.' + String(k));
  },
  set() { return true; },
  apply() { return anyProxy(name + '()'); },
  construct() { return anyProxy('new ' + name); },
  has() { return true; },
});

const el = () => anyProxy('el');
const listeners = {};
const doc = {
  readyState: 'complete',
  documentElement: el(), body: el(), head: el(),
  getElementById: () => el(),
  querySelector: () => el(),
  querySelectorAll: () => [],
  createElement: () => el(),
  createElementNS: () => el(),
  addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
  removeEventListener: noop,
  createTextNode: () => el(),
  execCommand: noop,
  fonts: { ready: Promise.resolve() },
};

const win = {
  addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
  removeEventListener: noop,
  innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
  location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', search: '', protocol: 'http:' },
  matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
  requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
  requestIdleCallback: () => 1,
  localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })(),
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
  navigator: { userAgent: 'node', language: 'it', clipboard: { writeText: () => Promise.resolve() } },
  getComputedStyle: () => anyProxy('style'),
  alert: noop, confirm: () => true, prompt: () => '',
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
  performance: { now: () => 0 },
  setTimeout: (f) => 1, setInterval: () => 1, clearTimeout: noop, clearInterval: noop,
};

const THREE = anyProxy('THREE');

const g = globalThis;
g.window = win; g.document = doc; g.THREE = THREE;
try { Object.defineProperty(g, 'navigator', { value: win.navigator, configurable: true }); } catch (e) {}
g.localStorage = win.localStorage;
g.location = win.location; g.fetch = win.fetch;
g.requestAnimationFrame = win.requestAnimationFrame;
g.requestIdleCallback = win.requestIdleCallback;
g.matchMedia = win.matchMedia; g.getComputedStyle = win.getComputedStyle;
g.alert = noop; g.confirm = () => true; g.prompt = () => '';
g.HTMLElement = function () {}; g.Node = function () {}; g.Element = function () {};
g.CustomEvent = function () {}; g.Event = function () {};
g.FileReader = function () { this.readAsText = noop; };
g.Blob = function () {}; g.File = function () {};
g.XMLHttpRequest = function () { this.open = noop; this.send = noop; };
g.ResizeObserver = function () { this.observe = noop; this.disconnect = noop; };
g.MutationObserver = function () { this.observe = noop; this.disconnect = noop; };
g.Image = function () {};

try {
  new Function(bundle)();
} catch (e) {
  console.log('ERRORE durante la registrazione del bundle:');
  console.log(e.stack);
  process.exit(1);
}

const loadFns = listeners['load'] || [];
if (!loadFns.length) {
  console.log('FAIL: nessun handler "load" registrato — il bundle non ha agganciato il bootstrap.');
  process.exit(1);
}
console.log('handler load registrati:', loadFns.length);
let failed = 0;
for (const f of loadFns) {
  try { f(); } catch (e) {
    failed++;
    console.log('\n>>> ECCEZIONE nel bootstrap (load):');
    console.log(e && e.stack ? e.stack.split('\n').slice(0, 12).join('\n') : e);
  }
}
if (failed) {
  console.log('\nFAIL: il bootstrap si e\' interrotto. Tutto cio\' che viene dopo il');
  console.log('punto dell\'eccezione non gira: nel browser si vede il markup statico');
  console.log('ma la scena e i controlli sono morti.');
  process.exit(1);
}
console.log('bootstrap completato senza eccezioni (con DOM finto)');
process.exit(0);
