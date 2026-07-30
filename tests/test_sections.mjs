/* Smoke test di ui/src/lib/34-sections.js con un DOM finto minimale.
 * Verifica: upgrade delle sezioni iniettate, creazione/etichetta del comando
 * "apri/chiudi tutto", persistenza in localStorage, ripristino al riavvio,
 * guardia sui controlli dentro <summary>, JSON corrotto ignorato. */
import fs from 'node:fs';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const MOD = process.argv[2] || new URL('../ui/src/lib/34-sections.js', import.meta.url);
const SRC = fs.readFileSync(MOD, 'utf8');

// ---------------- DOM finto ----------------
// I nodi di testo esistono davvero: sbWrapFlatSection sposta i figli del titolo
// nel <summary> con "while (titleEl.firstChild)", quindi un textContent finto
// come semplice stringa non verificherebbe nulla.
class Txt {
    constructor(d) { this.data = String(d); this.parentNode = null; }
    get textContent() { return this.data; }
}
class El {
    constructor(tag) {
        this.tagName = (tag || 'div').toUpperCase();
        this.children = []; this.parentNode = null;
        this._cls = new Set(); this.dataset = {}; this.attrs = {};
        this._text = ''; this.listeners = {}; this.style = {}; this.id = '';        this._open = false;
    }
    get parentElement() { return this.parentNode; }
    get classList() {
        const s = this._cls;
        return {
            add: (...c) => c.forEach(x => s.add(x)),
            remove: (...c) => c.forEach(x => s.delete(x)),
            contains: c => s.has(c),
            toggle: (c, f) => { const on = (f === undefined) ? !s.has(c) : !!f; on ? s.add(c) : s.delete(c); return on; }
        };
    }
    get className() { return [...this._cls].join(' '); }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get open() { return this._open; }
    set open(v) {
        const nv = !!v;
        if (nv === this._open) return;
        this._open = nv;
        this.dispatch('toggle');
    }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return (k in this.attrs) ? this.attrs[k] : null; }
    set textContent(v) {
        this.children.forEach(c => { c.parentNode = null; });
        this.children = [];
        if (v !== '' && v !== null && v !== undefined) this.appendChild(new Txt(v));
    }
    get textContent() { return this.children.map(c => c.textContent).join(''); }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; }
    insertBefore(c, ref) {
        if (c.parentNode) c.parentNode.removeChild(c);
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        c.parentNode = this; return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
    dispatch(e, ev) { (this.listeners[e] || []).slice().forEach(f => f(ev || { target: this, preventDefault() { } })); }
    click() { this.dispatch('click', { target: this, preventDefault() { } }); }
    get nextElementSibling() {
        if (!this.parentNode) return null;
        const i = this.parentNode.children.indexOf(this);
        return this.parentNode.children[i + 1] || null;
    }
    _desc(out) { this.children.forEach(c => { if (c._desc) { out.push(c); c._desc(out); } }); return out; }
    closest(sel) { let n = this; while (n) { if (matchAny(n, sel, null)) return n; n = n.parentNode; } return null; }
    querySelectorAll(sel) { return this._desc([]).filter(e => matchAny(e, sel, this)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// --- mini motore di selettori: ',' union, ' ' discendente, '>' figlio, ':scope' ---
function compound(txt) {
    const m = { tag: null, id: null, cls: [], scope: false };
    txt.replace(/:scope|#[\w-]+|\.[\w-]+|[A-Za-z][\w-]*/g, tok => {
        if (tok === ':scope') m.scope = true;
        else if (tok[0] === '#') m.id = tok.slice(1);
        else if (tok[0] === '.') m.cls.push(tok.slice(1));
        else m.tag = tok.toUpperCase();
        return '';
    });
    return m;
}
function matchCompound(el, c, scopeEl) {
    if (c.scope) return el === scopeEl;
    if (!el || el.tagName === undefined) return false;
    if (c.tag && el.tagName !== c.tag) return false;
    if (c.id && el.id !== c.id) return false;
    return c.cls.every(x => el._cls.has(x));
}
function matchOne(el, sel, scopeEl) {
    const parts = sel.trim().split(/\s*(>)\s*|\s+/).filter(x => x !== undefined && x !== '');
    // parts: [comp, ('>'), comp, ...] valutato da destra a sinistra
    let i = parts.length - 1;
    if (!matchCompound(el, compound(parts[i]), scopeEl)) return false;
    let node = el; i--;
    while (i >= 0) {
        let comb = ' ';
        if (parts[i] === '>') { comb = '>'; i--; }
        const c = compound(parts[i]); i--;
        if (comb === '>') {
            node = node.parentNode;
            if (!matchCompound(node, c, scopeEl)) return false;
        } else {
            let n = node.parentNode, found = null;
            while (n) { if (matchCompound(n, c, scopeEl)) { found = n; break; } n = n.parentNode; }
            if (!found) return false;
            node = found;
        }
    }
    return true;
}
function matchAny(el, sel, scopeEl) {
    return sel.split(',').some(s => s.trim() && matchOne(el, s, scopeEl));
}

// ---------------- ambiente ----------------
function makeEnv(storage) {
    const root = new El('body');
    const doc = {
        body: root,
        createElement: t => new El(t),
        getElementById: id => root._desc([]).find(e => e.id === id) || null,
        querySelectorAll: sel => root._desc([]).filter(e => matchAny(e, sel, root)),
        querySelector: sel => (root._desc([]).filter(e => matchAny(e, sel, root))[0] || null),
        head: new El('head')
    };
    const ls = {
        _m: storage || {},
        getItem(k) { return (k in this._m) ? this._m[k] : null; },
        setItem(k, v) { this._m[k] = String(v); },
        removeItem(k) { delete this._m[k]; }
    };
    return { root, doc, ls, win: {} };
}

function details(id, open) {
    const d = new El('details'); d.className = 'sb-section'; d.id = id; d._open = !!open;
    const s = new El('summary'); s.className = 'section-title'; s.textContent = id;
    const b = new El('div'); b.className = 'sb-body';
    d.appendChild(s); d.appendChild(b);
    return d;
}

function buildDom(env) {
    const tc = new El('div'); tc.className = 'tab-content';
    const p1 = new El('div'); p1.className = 'tab-panel active';
    p1.appendChild(details('sbSecGenerate', true));
    p1.appendChild(details('sbSecModelInfo', true));
    const p2 = new El('div'); p2.className = 'tab-panel';
    p2.appendChild(details('sbSecTools', true));
    const pl = details('sbSecPlugins', true);
    // controllo interattivo dentro il summary (come il "+" di Animazioni AI)
    const btn = new El('button'); btn.id = 'addAnimBtn';
    pl.children[0].appendChild(btn);
    p2.appendChild(pl);
    tc.appendChild(p1); tc.appendChild(p2);
    env.root.appendChild(tc);

    const sb = new El('div'); sb.id = 'settingsBody';
    sb.appendChild(details('sbSecAppearance', true));
    sb.appendChild(details('sbSecShortcuts', true));
    const extra = new El('div'); extra.id = 'settingsExtraSections';
    const startup = new El('div'); startup.id = 'startupSettingsSection';
    ['Avvio', 'Salvataggio'].forEach(txt => {
        const t = new El('div'); t.className = 'section-title'; t.textContent = txt;
        const g = new El('div'); g.className = 'controls-group glass'; g.id = 'grp' + txt;
        startup.appendChild(t); startup.appendChild(g);
    });
    extra.appendChild(startup); sb.appendChild(extra);
    env.root.appendChild(sb);
    return { p1, p2, sb, startup };
}

function run(env) {
    global.document = env.doc; global.window = env.win; global.localStorage = env.ls;
    // eslint-disable-next-line no-new-func
    new Function(SRC)();
}

// ---------------- 1. avvio pulito ----------------
let env = makeEnv({});
let dom = buildDom(env);
run(env);

ok(!!env.doc.getElementById('sbSecStartup'), 'sezione iniettata "Avvio" avvolta in sbSecStartup');
ok(!!env.doc.getElementById('sbSecSaving'), 'sezione iniettata "Salvataggio" avvolta in sbSecSaving');
ok(env.doc.getElementById('grpAvvio').parentNode._cls.has('sb-body'), 'il .controls-group finisce dentro .sb-body');
ok(env.doc.getElementById('sbSecStartup').children[0].tagName === 'SUMMARY', 'il titolo iniettato diventa <summary>');
ok(env.doc.getElementById('sbSecStartup').children[0].textContent === 'Avvio', 'il testo del titolo e\' preservato');

const btns = env.doc.querySelectorAll('.sb-toggle-all');
ok(btns.length === 3, 'un comando apri/chiudi per pannello + modale (atteso 3, trovati ' + btns.length + ')');
ok(dom.p1.children[0]._cls.has('sb-toggle-all'), 'il comando e\' il primo figlio del pannello');
ok(btns.every(b => b.textContent === 'Chiudi tutto'), 'tutte aperte -> il comando propone "Chiudi tutto"');
ok(btns.every(b => b.getAttribute('data-i18n') === 'sections.collapseAll'), 'data-i18n coerente con lo stato');

// ---------------- 2. chiudi tutto nel primo pannello ----------------
dom.p1.children[0].click();
ok(!env.doc.getElementById('sbSecGenerate').open && !env.doc.getElementById('sbSecModelInfo').open,
    'click -> tutte le sezioni del pannello chiuse');
ok(dom.p1.children[0].textContent === 'Apri tutto', 'ora il comando propone "Apri tutto"');
ok(dom.p1.children[0]._cls.has('sb-collapsed'), 'classe sb-collapsed applicata');
ok(dom.p2.children[0].textContent === 'Chiudi tutto', 'il comando dell\'altro pannello non cambia');

let saved = JSON.parse(env.ls.getItem('voxelai-sections'));
ok(saved.sbSecGenerate === false && saved.sbSecTools === true, 'stato persistito in voxelai-sections');
ok(Object.keys(saved).length === 8, 'salvate tutte le 8 sezioni (trovate ' + Object.keys(saved).length + ')');

// riapri tutto
dom.p1.children[0].click();
ok(env.doc.getElementById('sbSecGenerate').open, 'secondo click -> riapre');
ok(dom.p1.children[0].textContent === 'Chiudi tutto', 'etichetta di nuovo "Chiudi tutto"');

// ---------------- 3. singolo toggle + ripristino al riavvio ----------------
env.doc.getElementById('sbSecTools').open = false;
saved = JSON.parse(env.ls.getItem('voxelai-sections'));
ok(saved.sbSecTools === false, 'il toggle di una singola sezione salva');
ok(dom.p2.children[0].textContent === 'Apri tutto', 'il comando riflette il toggle manuale');

const carry = Object.assign({}, env.ls._m);
let env2 = makeEnv(carry);
buildDom(env2);
run(env2);
ok(env2.doc.getElementById('sbSecTools').open === false, 'al riavvio la sezione chiusa resta chiusa');
ok(env2.doc.getElementById('sbSecGenerate').open === true, 'al riavvio le altre restano aperte');

// ---------------- 4. guardia sui controlli dentro <summary> ----------------
const pluginsSummary = env2.doc.getElementById('sbSecPlugins').children[0];
let prevented = false;
pluginsSummary.dispatch('click', { target: env2.doc.getElementById('addAnimBtn'), preventDefault() { prevented = true; } });
ok(prevented, 'click su un pulsante dentro il summary NON apre/chiude la sezione');
prevented = false;
pluginsSummary.dispatch('click', { target: pluginsSummary, preventDefault() { prevented = true; } });
ok(!prevented, 'click sul summary stesso resta un toggle normale');

// ---------------- 5. storage corrotto / id sconosciuti ----------------
let env3 = makeEnv({ 'voxelai-sections': '{nonJson' });
buildDom(env3);
let threw = null;
try { run(env3); } catch (e) { threw = e; }
ok(!threw, 'JSON corrotto non fa esplodere il modulo' + (threw ? ' (' + threw.message + ')' : ''));
ok(env3.doc.getElementById('sbSecGenerate').open === true, 'JSON corrotto -> si resta sul markup (tutto aperto)');

let env4 = makeEnv({ 'voxelai-sections': JSON.stringify({ sbSecInesistente: false, sbSecTools: false }) });
buildDom(env4);
run(env4);
ok(env4.doc.getElementById('sbSecTools').open === false, 'id noto applicato');
ok(!env4.doc.getElementById('sbSecInesistente'), 'id sconosciuto ignorato senza errori');

// ---------------- 6. openSettingsModal apre la sezione bersaglio ----------------
let env5 = makeEnv({ 'voxelai-sections': JSON.stringify({ sbSecAppearance: false }) });
buildDom(env5);
let called = null;
env5.win.openSettingsModal = function (opts) { called = opts; return 'orig'; };
run(env5);
const ret = env5.win.openSettingsModal({ section: 'sbSecAppearance' });
ok(ret === 'orig' && called && called.section === 'sbSecAppearance', 'la openSettingsModal originale viene chiamata');
ok(env5.doc.getElementById('sbSecAppearance').open === true, 'la sezione bersaglio viene aperta');

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
