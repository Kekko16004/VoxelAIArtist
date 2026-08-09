    // =======================================================================
    //  01 - Utilita' di base
    //  Niente qui dentro conosce il documento o gli strumenti: sono i mattoni
    //  che tutti gli altri moduli usano. Se una funzione di questo file inizia
    //  a leggere `doc`, e' finita nel file sbagliato.
    // =======================================================================

    const $ = (id) => document.getElementById(id);
    const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /** Intero dentro [lo,hi]; un valore non numerico diventa `lo`. */
    function clampInt(v, lo, hi) {
        const n = Math.round(Number(v));
        if (!isFinite(n)) return lo;
        return clamp(n, lo, hi);
    }

    /** "#RRGGBB" o "#RGB" -> {r,g,b}; null se non e' un colore. */
    function hexToRgb(hex) {
        if (typeof hex !== 'string') return null;
        let h = hex.trim().replace(/^#/, '');
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
        };
    }

    function hex2(n) {
        const s = clampInt(n, 0, 255).toString(16);
        return s.length === 1 ? '0' + s : s;
    }

    function rgbToHex(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }

    /** Colore CSS opaco a partire da un hex, per le anteprime. */
    function cssRgba(hex, alpha) {
        const c = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
        return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (alpha / 255) + ')';
    }

    // --- Canvas -------------------------------------------------------------
    // Ogni contesto 2D dell'app nasce da qui con `imageSmoothingEnabled=false`.
    // Il valore di default e' `true`, e con l'interpolazione attiva qualunque
    // ridimensionamento (ingrandire un livello, incollare una selezione,
    // ricampionare la tela) sfoca i bordi netti: e' esattamente cio' che in
    // pixel art si legge come "il programma ha rovinato il disegno".

    function makeCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, w | 0);
        c.height = Math.max(1, h | 0);
        return c;
    }

    function ctx2d(canvas) {
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingEnabled = false;
        return g;
    }

    /** Copia indipendente di un canvas (stesso contenuto, nessun legame). */
    function cloneCanvas(src) {
        const c = makeCanvas(src.width, src.height);
        ctx2d(c).drawImage(src, 0, 0);
        return c;
    }

    /** Svuota un canvas SENZA riassegnare width/height (che ne perde le UV). */
    function clearCanvas(canvas) {
        ctx2d(canvas).clearRect(0, 0, canvas.width, canvas.height);
    }

    // --- File ---------------------------------------------------------------

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // La revoca immediata annullerebbe il download in Firefox: il click e'
        // asincrono e il blob deve sopravvivergli.
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    /** Canvas -> Blob PNG (Promise). `toBlob` puo' dare null: si solleva. */
    function canvasToBlob(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((b) => {
                if (b) resolve(b); else reject(new Error('toBlob'));
            }, 'image/png');
        });
    }

    /** File/Blob -> HTMLImageElement gia' decodificata. */
    function loadImageFromBlob(blob) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
            img.src = url;
        });
    }

    // --- Tastiera -----------------------------------------------------------

    /**
     * True se il bersaglio dell'evento e' un campo di testo.
     *
     * Ogni scorciatoia a lettera singola deve passare di qui: senza, scrivere
     * "b" nel prompt dell'AI cambierebbe lo strumento in matita, e Ctrl+Z in un
     * campo annullerebbe il disegno invece del testo appena scritto.
     */
    function isTypingTarget(el) {
        if (!el) return false;
        const tag = (el.tagName || '').toUpperCase();
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
    }

    // --- Varie --------------------------------------------------------------

    /** Nome file senza estensione, ripulito da cio' che i filesystem odiano. */
    function safeName(name, fallback) {
        const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
        return base || fallback;
    }

    function fmtBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' kB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
