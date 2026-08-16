// =======================================================================
//  10 - i18n (stesso schema del padre: t() + data-i18n)
// =======================================================================

var i18nDict = {};
var i18nCache = {};
var i18nLang = 'it';
var i18nApplied = false;
var i18nLocales = [{ code: 'it', name: 'Italiano' }, { code: 'en', name: 'English' }];

function i18nInterpolate(str, vars) {
    if (!vars || typeof str !== 'string') return str;
    return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function t(key, vars) {
    let s = (i18nDict && key in i18nDict) ? i18nDict[key] : undefined;
    if (s === undefined && i18nCache && i18nCache.it && key in i18nCache.it) s = i18nCache.it[key];
    if (s === undefined) s = key;
    return i18nInterpolate(s, vars);
}

function i18nValue(key) {
    if (i18nDict && key in i18nDict) return i18nDict[key];
    if (i18nCache && i18nCache.it && key in i18nCache.it) return i18nCache.it[key];
    return undefined;
}

function applyI18n(root) {
    root = root || document;
    $$('[data-i18n]', root).forEach((el) => {
        const v = i18nValue(el.getAttribute('data-i18n'));
        if (v !== undefined) el.textContent = v;
    });
    $$('[data-i18n-title]', root).forEach((el) => {
        const v = i18nValue(el.getAttribute('data-i18n-title'));
        if (v !== undefined) el.setAttribute('title', v);
    });
    $$('[data-i18n-placeholder]', root).forEach((el) => {
        const v = i18nValue(el.getAttribute('data-i18n-placeholder'));
        if (v !== undefined) el.setAttribute('placeholder', v);
    });
    const title = i18nValue('app.title');
    if (title !== undefined) document.title = title;
    document.documentElement.setAttribute('lang', i18nLang);
}

async function setLang(code, opts) {
    opts = opts || {};
    try {
        if (!i18nCache.it) {
            try {
                const r = await fetch('locales/it.json');
                if (r.ok) i18nCache.it = await r.json();
            } catch (e) { /* offline */ }
        }
        let dict;
        if (code === 'it' && i18nCache.it) dict = i18nCache.it;
        else {
            const r = await fetch('locales/' + code + '.json');
            if (!r.ok) throw new Error('locale ' + code);
            dict = await r.json();
            i18nCache[code] = dict;
        }
        i18nDict = dict;
        i18nLang = code;
        applyI18n(document);
        i18nApplied = true;
        if (!opts.silent) savePref('lang', code);
        const sel = $('languageSelect');
        if (sel && sel.value !== code) sel.value = code;
    } catch (e) {
        console.warn('[i18n]', code, e);
    }
}

async function bootI18n() {
    try {
        const r = await fetch('locales/index.json');
        if (r.ok) {
            const idx = await r.json();
            if (idx && Array.isArray(idx.locales)) i18nLocales = idx.locales;
        }
    } catch (e) { /* offline */ }
    const sel = $('languageSelect');
    if (sel) {
        sel.innerHTML = '';
        for (const l of i18nLocales) {
            const o = document.createElement('option');
            o.value = l.code; o.textContent = l.name;
            sel.appendChild(o);
        }
        sel.onchange = () => setLang(sel.value);
    }
    let start = 'it';
    const saved = loadPref('lang', null);
    if (saved && i18nLocales.some(l => l.code === saved)) start = saved;
    else {
        const nav = String((navigator && navigator.language) || 'it').slice(0, 2).toLowerCase();
        if (i18nLocales.some(l => l.code === nav)) start = nav;
    }
    await setLang(start, { silent: true });
}
