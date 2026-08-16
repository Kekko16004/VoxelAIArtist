// =======================================================================
//  00 - Bootstrap: carica THREE via importmap e apre la closure
//
//  I moduli di lib/ sono frammenti di UNA sola closure (niente import/
//  export fra di loro). THREE arriva da import() dinamico e viene
//  catturato come `const THREE` nello scope condiviso.
// =======================================================================

(async function SimpleAIModellerMain() {
    'use strict';

    let THREE, OrbitControls, GLTFExporter, TransformControls;
    try {
        const threeMod = await import('three');
        THREE = threeMod;
        const oc = await import('three/addons/controls/OrbitControls.js');
        OrbitControls = oc.OrbitControls;
        const ge = await import('three/addons/exporters/GLTFExporter.js');
        GLTFExporter = ge.GLTFExporter;
        try {
            const tc = await import('three/addons/controls/TransformControls.js');
            TransformControls = tc.TransformControls;
        } catch (e) { /* opzionale in fase 1 */ }
    } catch (e) {
        console.error('[sam] impossibile caricare Three.js:', e);
        document.body.innerHTML = '<div style="padding:2rem;font-family:sans-serif;color:#fff;background:#111">'
            + '<h1>Three.js non caricato</h1><p>Serve rete al primo avvio (CDN). '
            + 'Dettaglio: ' + String(e.message || e) + '</p></div>';
        return;
    }

    // Helpers DOM usati da tutti i moduli.
    function $(id) { return document.getElementById(id); }
    function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

    // Preferenze minime (localStorage).
    function loadPref(k, d) {
        try {
            const v = localStorage.getItem('sam-' + k);
            return v == null ? d : JSON.parse(v);
        } catch (e) { return d; }
    }
    function savePref(k, v) {
        try { localStorage.setItem('sam-' + k, JSON.stringify(v)); } catch (e) { /* quota */ }
    }

    function requestRender() {
        if (typeof _needsRender !== 'undefined') _needsRender = true;
    }
