            /* ===== Tema chiaro/scuro =====
             * applyTheme() imposta l'attributo data-theme sull'<html>, che
             * fa da switch per tutti i design token in :root. La preferenza
             * viene salvata in localStorage. Il viewport 3D usa un renderer
             * con alpha:true, quindi lo sfondo segue il gradiente CSS del tema. */
            const THEME_KEY = 'voxelai-theme';
            // Anti-flicker: il canvas 3D usa uno sfondo di scena OPACO (vedi
            // 01-scene-setup.js) invece del compositing alpha per-frame. Qui lo
            // teniamo in tinta col tema: scuro segue il fondo del gradiente, chiaro
            // usa una tinta chiara. Best-effort: se `scene` non è pronta si ignora.
            function applySceneBackground(t) {
                try {
                    if (typeof scene === 'undefined' || !scene) return;
                    const hex = (t === 'light') ? 0xe8ecf5 : 0x0b0913;
                    if (scene.background && scene.background.isColor) {
                        scene.background.setHex(hex);
                    } else {
                        scene.background = new THREE.Color(hex);
                    }
                } catch (e) { /* scena non ancora pronta */ }
            }
            function applyTheme(theme) {
                const t = (theme === 'light') ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', t);
                applySceneBackground(t);
                try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* storage non disponibile */ }
            }
            (function initTheme() {
                let saved = null;
                try { saved = localStorage.getItem(THEME_KEY); } catch (e) { }
                if (!saved) {
                    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
                    saved = prefersLight ? 'light' : 'dark';
                }
                applyTheme(saved);
            })();
            document.getElementById('themeToggleBtn').addEventListener('click', () => {
                const current = document.documentElement.getAttribute('data-theme');
                const next = current === 'light' ? 'dark' : 'light';
                applyTheme(next);
                // T6: persisti la scelta via layer prefs (backend + fallback localStorage).
                // applyTheme() ha già scritto localStorage per il ripristino sincrono.
                if (typeof savePref === 'function') savePref('theme', next);
            });

            /* ===== Accent color personalizzabile =====
             * L'utente sceglie UN colore base; da quello deriviamo tutti i token
             * accent (primary/secondary/deep/soft/glow + glass-border-focus) così
             * l'intera UI resta coerente. I derivati sono schiariti/scuriti dal base
             * e le versioni "soft/glow/focus" sono lo stesso colore con alpha.
             * Persistenza come il tema: localStorage (ripristino sincrono, no flash)
             * + savePref (backend). Default = grafite #475569. */
            const ACCENT_KEY = 'voxelai-accent';
            const ACCENT_DEFAULT = '#475569';

            function _hexToRgb(hex) {
                let h = String(hex).trim().replace('#', '');
                if (h.length === 3) h = h.split('').map(c => c + c).join('');
                if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
                return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
            }
            function _clamp(n) { return Math.max(0, Math.min(255, Math.round(n))); }
            function _mix(rgb, target, t) {
                return { r: _clamp(rgb.r + (target - rgb.r) * t), g: _clamp(rgb.g + (target - rgb.g) * t), b: _clamp(rgb.b + (target - rgb.b) * t) };
            }
            function _rgbToHex(c) {
                const h = n => n.toString(16).padStart(2, '0');
                return '#' + h(c.r) + h(c.g) + h(c.b);
            }
            function _rgba(c, a) { return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`; }

            // Applica il colore accent derivando tutti i token da un singolo hex base.
            function applyAccent(hex, opts) {
                const base = _hexToRgb(hex);
                if (!base) return false;
                const norm = _rgbToHex(base);
                const deep = _mix(base, 0, 0.22);       // ~22% più scuro
                const secondary = _mix(base, 255, 0.20); // ~20% più chiaro
                const root = document.documentElement.style;
                root.setProperty('--accent-primary', norm);
                root.setProperty('--accent-secondary', _rgbToHex(secondary));
                root.setProperty('--accent-deep', _rgbToHex(deep));
                root.setProperty('--accent-soft', _rgba(base, 0.25));
                root.setProperty('--accent-glow', _rgba(base, 0.35));
                root.setProperty('--glass-border-focus', _rgba(base, 0.45));
                if (!opts || opts.persist !== false) {
                    try { localStorage.setItem(ACCENT_KEY, norm); } catch (e) { /* storage n/d */ }
                }
                return true;
            }
            // Ripristino sincrono all'avvio (prima del paint -> nessun flash del vecchio colore).
            (function initAccent() {
                let saved = null;
                try { saved = localStorage.getItem(ACCENT_KEY); } catch (e) { }
                applyAccent(saved || ACCENT_DEFAULT, { persist: false });
            })();

            // Animation loop